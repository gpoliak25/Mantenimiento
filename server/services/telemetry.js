// Telemetría IoT simulada (gateway a bordo → plataforma → análisis → acción).
// Escala de simulación: 1 lectura cada 5 s representa 1 minuto de operación
// (≈0,3 km a 18 km/h de velocidad comercial).
//
// Reglas:
//  - UMBRAL: advertencia / crítica según límites de cada variable (+ DTC J1939)
//  - PREDICTIVA: regresión lineal sobre las últimas lecturas; si la tendencia
//    proyecta cruzar el umbral de advertencia, se alerta antes de la falla.
// Cada alerta puede generar automáticamente la OT (y ésta, la OT en JDE).
const { db, all, get, run, nowIso, getSetting } = require('../db');
const C = require('../catalog');
const wo = require('./workorders');

const TICK_MS = Number(process.env.TELEMETRY_TICK_MS || 5000);
const KM_PER_TICK = C.AVG_SPEED_KMH / 60;
const BUF = 90;
const PRED_WINDOW = 20;
const PRED_HORIZON = 90; // minutos de operación
const SEV_RANK = { PREDICTIVA: 1, ADVERTENCIA: 2, CRITICA: 3 };

const state = new Map();
let tick = 0;

const metricsFor = (u) => C.METRICS.filter((m) => (u.powertrain === 'ELECTRICO' ? !m.ice : !m.ev));
const metricDef = Object.fromEntries(C.METRICS.map((m) => [m.key, m]));
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const localDay = () => new Date().toLocaleDateString('sv');

function ensure(u) {
  if (state.has(u.id)) return state.get(u.id);
  const s = { level: {}, value: {}, buf: {}, faults: {}, wear: 0.3 + ((u.id * 37) % 30) / 100, running: true };
  for (const m of metricsFor(u)) {
    let lv = m.base;
    if (m.key === 'brake_pad_mm') lv = 6.5 + ((u.id * 53) % 95) / 10;
    if (m.key === 'traction_soh') lv = 88 + (u.id % 6);
    s.level[m.key] = lv;
    s.value[m.key] = lv;
    // Historia breve para que los gráficos y el modelo arranquen con datos
    s.buf[m.key] = Array.from({ length: 40 }, () => +(lv + gauss() * m.noise).toFixed(3));
  }
  state.set(u.id, s);
  return s;
}

function severityOf(m, v) {
  const up = m.dir === 'up';
  if (up ? v >= m.crit : v <= m.crit) return 'CRITICA';
  if (up ? v >= m.warn : v <= m.warn) return 'ADVERTENCIA';
  return null;
}

// Regresión lineal por mínimos cuadrados sobre las últimas lecturas
function trend(buf, m) {
  const n = Math.min(buf.length, PRED_WINDOW);
  if (n < 12) return null;
  const ys = buf.slice(-n);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  ys.forEach((y, x) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const fit = sy / n + slope * ((n - 1) - sx / n);
  const toward = m.dir === 'up' ? slope > 0 : slope < 0;
  const significant = Math.abs(slope) * n > 3 * m.noise;
  let eta = null;
  if (toward && significant) {
    const t = (m.warn - fit) / slope;
    if (t > 0) eta = t;
  }
  return { slope, fit, eta, toward, significant };
}

function raise(u, m, severity, value, extra) {
  const existing = get("SELECT * FROM alerts WHERE unit_id=? AND metric=? AND status IN ('ABIERTA','OT_GENERADA') ORDER BY id DESC LIMIT 1", u.id, m.key);
  const kind = severity === 'PREDICTIVA' ? 'PREDICTIVA' : 'UMBRAL';
  const scen = C.FAULT_SCENARIOS[m.key];
  const dtc = m.spn && kind === 'UMBRAL' ? ` DTC J1939 SPN ${m.spn} FMI ${m.dir === 'up' ? 0 : 1}.` : '';
  const message = kind === 'PREDICTIVA'
    ? `${m.label} con tendencia ${m.dir === 'up' ? 'ascendente' : 'descendente'} (${value.toFixed(1)} ${m.unit}). Alcanzaría ${m.warn} ${m.unit} en ~${Math.round(extra.eta)} min de operación. Posible causa: ${scen.label.toLowerCase()}.`
    : `${m.label} ${severity === 'CRITICA' ? 'en nivel crítico' : 'fuera de rango'}: ${value.toFixed(1)} ${m.unit} (límite ${severity === 'CRITICA' ? m.crit : m.warn} ${m.unit}).${dtc}`;
  if (existing) {
    if (SEV_RANK[severity] <= SEV_RANK[existing.severity]) return;
    run('UPDATE alerts SET severity=?, kind=?, message=?, value=?, ts=? WHERE id=?', severity, kind, message, value, nowIso(), existing.id);
    if (severity === 'CRITICA') {
      if (existing.wo_id) escalateWo(existing.wo_id, message);
      else createWoFromAlert(existing.id); // crítica: la OT se genera siempre
    }
    return;
  }
  const r = run('INSERT INTO alerts (unit_id,ts,metric,system,kind,severity,message,value,status) VALUES (?,?,?,?,?,?,?,?,?)',
    u.id, nowIso(), m.key, m.system, kind, severity, message, value, 'ABIERTA');
  const alertId = Number(r.lastInsertRowid);
  // Las alertas críticas generan siempre la OT; el ajuste auto_wo rige para predictivas y advertencias
  if (severity === 'CRITICA' || getSetting('auto_wo', true)) createWoFromAlert(alertId);
}

// Lleva una OT existente a prioridad crítica y retira la unidad de servicio
function escalateWo(woId, message) {
  const w = get('SELECT * FROM work_orders WHERE id=?', woId);
  if (!w || w.stage === 'CERRADA' || (w.priority === 1 && w.immobilized)) return;
  run('UPDATE work_orders SET priority=1, immobilized=1 WHERE id=?', w.id);
  run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', w.id, nowIso(), null, `Escalada automáticamente a prioridad crítica: ${message}`);
  wo.recomputeUnitStatus(w.unit_id);
}

function createWoFromAlert(alertId) {
  const a = get('SELECT * FROM alerts WHERE id=?', alertId);
  if (!a || a.status !== 'ABIERTA') throw new wo.HttpError(400, 'La alerta no está abierta');
  const scen = C.FAULT_SCENARIOS[a.metric];
  const critical = a.severity === 'CRITICA';
  const same = get("SELECT id FROM work_orders WHERE unit_id=? AND system=? AND stage<>'CERRADA' ORDER BY id DESC LIMIT 1", a.unit_id, a.system);
  if (same) {
    run("UPDATE alerts SET status='OT_GENERADA', wo_id=? WHERE id=?", same.id, a.id);
    run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', same.id, nowIso(), null, `Alerta asociada: ${a.message}`);
    if (critical) escalateWo(same.id, a.message);
    return wo.detail(same.id);
  }
  const type = a.kind === 'PREDICTIVA' ? 'PREDICTIVO' : critical ? 'CORRECTIVO' : 'CONDICION';
  const w = wo.create({
    unit_id: a.unit_id, type, origin: 'SENSOR', system: a.system,
    title: `${a.kind === 'PREDICTIVA' ? 'Alerta predictiva' : critical ? 'Alerta crítica' : 'Alerta de sensor'}: ${scen.label}`.slice(0, 120),
    symptom: a.message, priority: critical ? 1 : 2,
    // Una alerta predictiva programa el ingreso al taller sin detener la unidad
    immobilized: critical ? 1 : 0, alert_id: a.id, parts: scen.parts,
  });
  if (critical) run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', w.id, nowIso(), null, 'OT generada automáticamente por alerta crítica: unidad retirada de servicio');
  run("UPDATE alerts SET status='OT_GENERADA', wo_id=? WHERE id=?", w.id, a.id);
  return w;
}

// Red de seguridad: ninguna alerta crítica queda abierta sin OT
function ensureCriticalWo() {
  for (const a of all("SELECT id FROM alerts WHERE severity='CRITICA' AND status='ABIERTA'")) {
    try { createWoFromAlert(a.id); } catch (e) { console.error('[telemetría] OT crítica', e.message); }
  }
}

function dismiss(alertId) {
  const a = get('SELECT severity FROM alerts WHERE id=?', alertId);
  if (a && a.severity === 'CRITICA') throw new wo.HttpError(400, 'Las alertas críticas no se pueden descartar: generan OT automáticamente');
  run("UPDATE alerts SET status='DESCARTADA' WHERE id=? AND status='ABIERTA'", alertId);
}

function step() {
  tick++;
  const units = all('SELECT id, unit_no, status, powertrain FROM units');
  for (const u of units) {
    const s = ensure(u);
    s.running = u.status === 'DISPONIBLE';
    if (!s.running) continue;
    for (const m of metricsFor(u)) {
      const f = s.faults[m.key];
      const active = f && tick >= f.startTick;
      if (m.key === 'brake_pad_mm') s.level[m.key] -= s.wear * KM_PER_TICK / 1000;
      if (m.key === 'traction_soh') s.level[m.key] -= 0.00002;
      if (active) s.level[m.key] += f.drift;
      let v = s.level[m.key] + gauss() * m.noise;
      if (v < 0) v = 0;
      v = +v.toFixed(3);
      s.value[m.key] = v;
      const buf = s.buf[m.key];
      buf.push(v);
      if (buf.length > BUF) buf.shift();
      try {
        const sev = severityOf(m, v);
        if (sev) raise(u, m, sev, v);
        else {
          const t = trend(buf, m);
          if (t && t.eta !== null && t.eta <= PRED_HORIZON) raise(u, m, 'PREDICTIVA', v, t);
        }
      } catch (e) { console.error('[telemetría]', e.message); }
    }
  }
  ensureCriticalWo();
  // Odómetro y km diarios de las unidades en servicio
  db.exec('BEGIN');
  try {
    run("UPDATE units SET odometer_km=odometer_km+? WHERE status='DISPONIBLE'", KM_PER_TICK);
    run("INSERT INTO km_log (unit_id,day,km) SELECT id, ?, ? FROM units WHERE status='DISPONIBLE' ON CONFLICT(unit_id,day) DO UPDATE SET km=km+excluded.km", localDay(), KM_PER_TICK);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); }
}

// Al cerrar una OT se normalizan las variables del sistema reparado
function repair(w) {
  const s = state.get(w.unit_id);
  if (!s) return;
  for (const m of C.METRICS.filter((x) => x.system === w.system && s.level[x.key] !== undefined)) {
    const hadFault = !!s.faults[m.key];
    delete s.faults[m.key];
    if (m.key === 'brake_pad_mm') { if (s.level[m.key] < 8 || hadFault) s.level[m.key] = 16; }
    else if (m.key === 'traction_soh') { if (hadFault) s.level[m.key] = 95; }
    else s.level[m.key] = m.base;
    s.buf[m.key] = Array.from({ length: 15 }, () => +(s.level[m.key] + gauss() * m.noise).toFixed(3));
  }
}

function inject(unitId, metric) {
  const u = get('SELECT * FROM units WHERE id=?', unitId);
  if (!u) throw new wo.HttpError(404, 'Unidad inexistente');
  const m = metricDef[metric];
  if (!m || !metricsFor(u).includes(m)) throw new wo.HttpError(400, 'Variable no aplicable a la unidad');
  const s = ensure(u);
  s.faults[metric] = { drift: C.FAULT_SCENARIOS[metric].drift, startTick: tick + 1, since: nowIso() };
  return { unit: u.unit_no, metric, scenario: C.FAULT_SCENARIOS[metric].label };
}

function levelOf(m, v) { const s = severityOf(m, v); return s === 'CRITICA' ? 'crit' : s ? 'warn' : 'ok'; }

function snapshot() {
  const units = all('SELECT id, unit_no, plate, status, powertrain, brand, model FROM units ORDER BY unit_no');
  return {
    tick, tickMs: TICK_MS,
    metrics: C.METRICS.map(({ key, label, unit, warn, crit, dir, system, ice, ev }) => ({ key, label, unit, warn, crit, dir, system, ice: !!ice, ev: !!ev })),
    units: units.map((u) => {
      const s = ensure(u);
      const metrics = {};
      for (const m of metricsFor(u)) {
        const t = trend(s.buf[m.key], m);
        metrics[m.key] = { v: s.value[m.key], h: s.buf[m.key].slice(-30), level: levelOf(m, s.value[m.key]), eta: t && t.eta !== null && t.eta <= PRED_HORIZON * 2 ? Math.round(t.eta) : null, slope: t ? t.slope : 0 };
      }
      return { ...u, running: u.status === 'DISPONIBLE', metrics, faults: Object.keys(s.faults) };
    }),
  };
}

function series(unitId) {
  const u = get('SELECT * FROM units WHERE id=?', unitId);
  if (!u) return null;
  const s = ensure(u);
  return metricsFor(u).map((m) => {
    const t = trend(s.buf[m.key], m);
    return { key: m.key, label: m.label, unit: m.unit, warn: m.warn, crit: m.crit, dir: m.dir, system: m.system, values: s.buf[m.key], v: s.value[m.key], level: levelOf(m, s.value[m.key]), eta: t && t.eta !== null ? Math.round(t.eta) : null, fault: !!s.faults[m.key] };
  });
}

// Análisis predictivo por unidad: combina sensores, historial y plan
function analysis() {
  const pm = require('./pm');
  const units = all('SELECT * FROM units ORDER BY unit_no');
  const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
  const since180 = new Date(Date.now() - 180 * 86400000).toISOString();
  const hist = all(`SELECT unit_id, system, type, road_call, created_at FROM work_orders WHERE created_at>=?`, since180);
  const openAlerts = all("SELECT unit_id, severity, kind FROM alerts WHERE status IN ('ABIERTA','OT_GENERADA')");
  const sched = pm.schedule().units;
  const year = new Date().getFullYear();
  const rows = units.map((u) => {
    const s = ensure(u);
    const h = hist.filter((x) => x.unit_id === u.id);
    const corr90 = h.filter((x) => x.type === 'CORRECTIVO' && x.created_at >= since90).length;
    const road180 = h.filter((x) => x.road_call).length;
    const bySys = {};
    h.filter((x) => x.type === 'CORRECTIVO').forEach((x) => { bySys[x.system] = (bySys[x.system] || 0) + 1; });
    const recurrent = Object.entries(bySys).filter(([, n]) => n >= 3).map(([sys, n]) => ({ system: sys, count: n }));
    const al = openAlerts.filter((a) => a.unit_id === u.id);
    let warnM = 0, critM = 0;
    const trends = [];
    for (const m of metricsFor(u)) {
      const lv = levelOf(m, s.value[m.key]);
      if (lv === 'warn') warnM++;
      if (lv === 'crit') critM++;
      const t = trend(s.buf[m.key], m);
      if (t && t.eta !== null && t.eta <= PRED_HORIZON * 3) trends.push({ metric: m.key, label: m.label, eta: Math.round(t.eta), value: s.value[m.key], unit: m.unit });
    }
    const pad = s.level.brake_pad_mm;
    const wear = s.wear * (s.faults.brake_pad_mm ? 3 : 1);
    const brakeRul = pad !== undefined ? Math.max(0, Math.round(((pad - 4) / wear) * 1000)) : null;
    const pmRow = sched.find((x) => x.unit.id === u.id);
    const pmOverdue = pmRow && ['VENCIDO', 'EN_TOLERANCIA'].includes(pmRow.nextStatus);
    const age = year - u.year;
    const score = Math.min(100, Math.round(
      al.filter((a) => a.kind === 'PREDICTIVA').length * 15 + warnM * 12 + critM * 25 + trends.length * 8 + corr90 * 3 + road180 * 3 +
      (pmOverdue ? 12 : 0) + (age > 10 ? 8 : age > 6 ? 4 : 0) + (brakeRul !== null && brakeRul < 5000 ? 15 : brakeRul !== null && brakeRul < 10000 ? 6 : 0) + recurrent.length * 4,
    ));
    // Probabilidad de falla en ruta a 30 días: tasa histórica ajustada por riesgo actual
    const lambda = ((road180 + 1) / 180) * (0.6 + score / 100);
    const p30 = 1 - Math.exp(-lambda * 30);
    const recs = [];
    if (critM) recs.push('Retirar de servicio y diagnosticar: variables en nivel crítico');
    trends.forEach((t) => recs.push(`Programar revisión: ${t.label.toLowerCase()} alcanzaría el umbral en ~${t.eta} min de operación`));
    if (brakeRul !== null && brakeRul < 5000) recs.push(`Cambiar pastillas en el próximo ingreso (vida útil restante ~${brakeRul.toLocaleString('es-AR')} km)`);
    if (pmOverdue) recs.push(`Preventivo nivel ${pmRow.next} ${pmRow.nextStatus === 'VENCIDO' ? 'vencido' : 'en tolerancia'}`);
    recurrent.forEach((r) => recs.push(`Análisis de causa raíz (proactivo): ${r.count} correctivos de ${r.system.toLowerCase()} en 180 días`));
    return {
      unit: { id: u.id, unit_no: u.unit_no, plate: u.plate, model: `${u.brand} ${u.model}`, year: u.year, status: u.status, powertrain: u.powertrain },
      score, p30, corr90, road180, brakeRul, brakePad: pad, soh: s.level.traction_soh, trends, recurrent, pmStatus: pmRow?.nextStatus, pmNext: pmRow?.next, recommendations: recs,
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return { rows, horizonMin: PRED_HORIZON, model: 'Heurístico MVP: tendencia lineal + umbrales + historial. Reemplazable por un modelo de ML entrenado con el historial de OTs y telemetría.' };
}

function start() {
  const units = all('SELECT * FROM units ORDER BY id');
  units.forEach(ensure);
  // Escenarios de degradación activos al iniciar la demo, escalonados en el tiempo
  const avail = units.filter((u) => u.status === 'DISPONIBLE');
  const ice = avail.filter((u) => u.powertrain !== 'ELECTRICO');
  const plan = [[ice[5], 'coolant_temp', 2], [ice[10], 'air_pressure', 10], [ice[14], 'tire_pressure_min', 20], [avail[2], 'door_current', 35]];
  for (const [u, metric, delay] of plan) if (u) state.get(u.id).faults[metric] = { drift: C.FAULT_SCENARIOS[metric].drift, startTick: delay, since: nowIso() };
  wo.hooks.onClose.push(repair);
  setInterval(step, TICK_MS);
}

module.exports = { start, snapshot, series, inject, analysis, createWoFromAlert, dismiss, step, KM_PER_TICK };
