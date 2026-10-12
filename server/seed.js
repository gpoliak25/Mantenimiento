// Datos iniciales de demostración: flota de 24 colectivos con 180 días de
// historia, cargados de forma consistente en el CMMS y en el JDE simulado
// (como si la integración hubiera estado funcionando desde el inicio).
const { db, run, get, tx } = require('./db');
const J = require('../jde-mock/db');
const C = require('./catalog');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMPTOMS = {
  'Frenos': ['Ruido metálico al frenar', 'Baja presión de aire en tablero', 'Frenado desparejo, tira hacia un lado', 'Pérdida de aire audible en pulmón de freno'],
  'Dirección y suspensión': ['Unidad inclinada, bolsa de aire desinflada', 'Golpeteo en tren delantero', 'Juego excesivo en la dirección'],
  'Motor y refrigeración': ['Temperatura de motor alta en tablero', 'Pérdida de refrigerante', 'Falta de potencia y humo negro', 'No arranca'],
  'Ejes y transmisión': ['La caja no pasa cambios', 'Ruido en diferencial', 'Vibración en cardán a velocidad'],
  'Puertas': ['Puerta trasera no cierra', 'Puerta delantera se reabre sola', 'Sensor de borde no detecta obstáculos'],
  'Neumáticos': ['Neumático pinchado', 'Desgaste irregular en eje delantero', 'Corte en flanco de neumático'],
  'Sistema eléctrico': ['Baterías descargadas, no arranca', 'Luces de giro intermitentes', 'Alternador no carga'],
  'Climatización': ['El aire acondicionado no enfría', 'Ventilación con ruido'],
  'Rampa o elevador': ['La rampa no despliega', 'La rampa no retrae completamente'],
  'Batería de tracción': ['Alarma de temperatura del BMS', 'Autonomía reducida'],
};
const ROOT_CAUSES = {
  'Frenos': ['Desgaste normal', 'Válvula relé con pérdida', 'Contaminación del circuito de aire (secador saturado)'],
  'Dirección y suspensión': ['Fuelle fisurado por envejecimiento', 'Rótula sin lubricación'],
  'Motor y refrigeración': ['Termostato trabado', 'Bomba de agua con pérdida', 'Correa poly-V cortada'],
  'Ejes y transmisión': ['Nivel bajo de aceite de caja', 'Cruceta desgastada', 'Rodamiento sin lubricación'],
  'Puertas': ['Electroválvula obstruida', 'Cilindro de puerta desgastado', 'Ajuste de finales de carrera'],
  'Neumáticos': ['Objeto en calzada', 'Presión baja sostenida', 'Desalineación'],
  'Sistema eléctrico': ['Batería al final de su vida útil', 'Conector sulfatado', 'Regulador de alternador'],
  'Climatización': ['Falta de gas refrigerante', 'Compresor de A/C'],
  'Rampa o elevador': ['Sensor de final de carrera', 'Actuador con desgaste'],
  'Batería de tracción': ['Ventilador del BMS', 'Desbalance de celdas'],
};
const SYS_WEIGHTS = [['Frenos', 18], ['Puertas', 16], ['Motor y refrigeración', 14], ['Dirección y suspensión', 12], ['Sistema eléctrico', 12], ['Neumáticos', 10], ['Ejes y transmisión', 8], ['Climatización', 6], ['Rampa o elevador', 4]];

function wipe() {
  for (const t of ['units', 'km_log', 'pm_plans', 'pm_schedule', 'work_orders', 'wo_parts', 'wo_labor', 'wo_events', 'technicians', 'parts', 'requisitions', 'alerts', 'inspections', 'outbox', 'integration_log', 'settings']) run(`DELETE FROM ${t}`);
  for (const t of ['F0101', 'F1201', 'F1201_MTR', 'F1207', 'F4801', 'F3111', 'F31122', 'F4101', 'F41021', 'F4111', 'F4311', 'F0911', 'F0002']) J.db.exec(`DELETE FROM ${t}`);
}

function seed() {
  const R = mulberry32(20261012);
  const rnd = (a, b) => a + R() * (b - a);
  const ri = (a, b) => Math.floor(rnd(a, b + 1));
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const weighted = (pairs) => { const tot = pairs.reduce((s, p) => s + p[1], 0); let x = R() * tot; for (const p of pairs) { x -= p[1]; if (x <= 0) return p[0]; } return pairs[0][0]; };
  const HOUR = 3600000, DAY = 24 * HOUR, DAYS = 180;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const jul = (t) => J.toJulian(new Date(t));
  const plans = C.PM_PLANS;
  const planByLevel = Object.fromEntries(plans.map((p, i) => [p.level, { ...p, id: i + 1 }]));
  const partCost = Object.fromEntries(C.PARTS.map((p) => [p.item_no, p.unit_cost]));
  const techs = C.TECHNICIANS;

  // ------------------------------------------------------------- flota
  const spec = [['Mercedes-Benz', 'OH 1621 L', 'DIESEL', 8], ['Volkswagen', '17.280 OD', 'DIESEL', 6], ['Agrale', 'MT 17.0 LE', 'DIESEL', 5], ['Scania', 'K 310 IB', 'DIESEL', 3], ['BYD', 'D9W', 'ELECTRICO', 2]];
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const units = [];
  let k = 0;
  for (const [brand, model, pt, n] of spec) {
    for (let i = 0; i < n; i++) {
      k++;
      const year = pt === 'ELECTRICO' ? 2023 : ri(2013, 2024);
      const plate = year >= 2017 ? `${pick(L)}${pick(L)} ${ri(100, 999)} ${pick(L)}${pick(L)}` : `${pick(L)}${pick(L)}${pick(L)} ${ri(100, 999)}`;
      const ageYears = Math.max(0.3, 2026 - year - 0.5);
      const odo = Math.round(ageYears * (pt === 'ELECTRICO' ? 60000 : 72000) * rnd(0.85, 1.15));
      const last = {};
      last.MAYOR = odo < 360000 ? 0 : odo - rnd(0, 0.95) * 360000;
      last.C = Math.max(last.MAYOR, odo - rnd(0, 0.95) * 90000);
      last.B = Math.max(last.C, odo - rnd(0, 0.95) * 30000);
      last.A = Math.max(last.B, odo - rnd(0, 0.95) * 10000);
      const lastDate = {};
      for (const lv of Object.keys(last)) lastDate[lv] = today0.getTime() - DAYS * DAY - Math.round((odo - last[lv]) / 240) * DAY;
      units.push({
        idx: k - 1, id: k, unit_no: String(100 + k), numb: 1000 + k, plate, brand, model, year, pt,
        depot: k % 2 ? 'Cochera Norte' : 'Cochera Sur', mcu: k % 2 ? '30N' : '30S', line: pick(['12', '45', '101', '152']),
        odo, last, lastDate, thr: rnd(0.92, 1.1), downUntil: 0, inService: `${year}-0${ri(1, 9)}-15`,
      });
    }
  }

  // ------------------------------------------------------------- OTs
  const wos = [];
  const alerts = [];
  let doco = 20000;
  const pmWO = (u, level, t) => {
    const p = planByLevel[level];
    const started = t + 0.5 * HOUR;
    const dur = p.std_hours * rnd(1.0, 1.6) * HOUR;
    const due = u.last[level] + p.interval_km;
    const parts = p.kit.filter((x) => !(x.ice && u.pt === 'ELECTRICO')).map((x) => [x.item, x.qty]);
    wos.push({
      unit: u, type: 'PREVENTIVO', origin: 'PLAN', system: 'Plan preventivo', title: p.name, symptom: 'Servicio programado por kilometraje',
      priority: 3, road_call: 0, immobilized: 1, km_at: Math.round(u.odo), plan_id: p.id, due_km: Math.round(due), srvt: p.jde_service_type,
      created: t, started, closed: started + dur, labor: p.std_hours * rnd(0.9, 1.2), parts, diagnosis: 'Tareas del nivel ejecutadas', root_cause: null,
    });
    for (const lv of plans.filter((x) => x.rank <= p.rank)) { u.last[lv.level] = u.odo; u.lastDate[lv.level] = t; }
    u.downUntil = started + dur;
  };

  const kmRows = [];
  for (let d = DAYS; d >= 1; d--) {
    const day0 = today0.getTime() - d * DAY;
    const progress = (DAYS - d) / DAYS;
    const dayStr = iso(day0).slice(0, 10);
    for (const u of units) {
      const down = u.downUntil > day0 + 12 * HOUR;
      const km = down || R() < 0.04 ? 0 : Math.round(rnd(200, 285) * (u.pt === 'ELECTRICO' ? 0.85 : 1));
      u.odo += km;
      kmRows.push([u.id, dayStr, km]);

      // Preventivo por kilometraje (con algunos atrasos fuera de la tolerancia de ±10%)
      if (u.odo - u.last.A >= planByLevel.A.interval_km * u.thr && u.downUntil < day0) {
        let level = 'A';
        for (const lv of ['MAYOR', 'C', 'B']) if (u.odo - u.last[lv] >= planByLevel[lv].interval_km * 0.9) { level = lv; break; }
        pmWO(u, level, day0 + ri(19, 21) * HOUR);
        u.thr = R() < 0.12 ? rnd(1.12, 1.3) : rnd(0.92, 1.08);
        continue;
      }
      if (u.downUntil > day0) continue;

      // Correctivo (frecuencia decreciente a medida que madura el plan)
      const p = 0.045 * (1.2 - 0.4 * progress) * (u.year < 2017 ? 1.3 : 1);
      if (R() < p) {
        let system = weighted(SYS_WEIGHTS);
        if (u.pt === 'ELECTRICO' && system === 'Motor y refrigeración') system = 'Batería de tracción';
        const major = C.MAJOR_SYSTEMS.includes(system);
        const road = R() < (major ? 0.5 : 0.15) ? 1 : 0;
        const created = day0 + ri(6, 20) * HOUR + ri(0, 59) * 60000;
        const started = created + rnd(0.3, 4) * HOUR;
        const elapsed = (rnd(1.5, 8) + (R() < 0.25 ? rnd(10, 48) : 0)) * HOUR;
        const rp = C.REPAIR_PARTS[system];
        const parts = [rp[Math.floor(Math.pow(R(), 1.6) * rp.length)]];
        if (R() < 0.3) parts.push(pick(rp));
        const symptom = pick(SYMPTOMS[system]);
        wos.push({
          unit: u, type: 'CORRECTIVO', origin: road ? 'CONDUCTOR' : pick(['CONDUCTOR', 'INSPECCION', 'INSPECCION']), system,
          title: (road ? 'Falla en ruta: ' : '') + symptom, symptom, priority: road ? 1 : 2, road_call: road,
          immobilized: system === 'Climatización' && R() < 0.5 ? 0 : 1, km_at: Math.round(u.odo), created, started, closed: started + elapsed,
          labor: Math.min(elapsed / HOUR * 0.7, rnd(1, 7)), parts, diagnosis: 'Diagnóstico confirmado en taller', root_cause: pick(ROOT_CAUSES[system]),
        });
        u.downUntil = started + elapsed;
        continue;
      }

      // Predictivo: piloto de sensores en los últimos 75 días
      if (d <= 75 && R() < 0.014) {
        const ms = C.METRICS.filter((m) => (u.pt === 'ELECTRICO' ? !m.ice : !m.ev));
        const m = pick(ms);
        const sc = C.FAULT_SCENARIOS[m.key];
        const created = day0 + ri(8, 18) * HOUR;
        const started = created + rnd(2, 10) * HOUR;
        const elapsed = rnd(1.5, 4) * HOUR;
        const alertIdx = alerts.push({ unit: u, ts: created, metric: m.key, system: m.system, kind: 'PREDICTIVA', severity: 'PREDICTIVA', message: `Tendencia anómala: ${m.label}. ${sc.label}`, value: m.dir === 'up' ? m.warn - 2 : m.warn + 0.5 }) - 1;
        wos.push({
          unit: u, type: 'PREDICTIVO', origin: 'SENSOR', system: m.system, title: `Alerta predictiva: ${sc.label}`, symptom: `Tendencia anómala de ${m.label.toLowerCase()} detectada por el modelo`,
          priority: 2, road_call: 0, immobilized: 1, km_at: Math.round(u.odo), created, started, closed: started + elapsed,
          labor: elapsed / HOUR * 0.8, parts: sc.parts, diagnosis: 'Anomalía confirmada en taller', root_cause: sc.label, alertIdx,
        });
        u.downUntil = started + elapsed;
        continue;
      }

      // Detectivo: verificación trimestral de sistemas de seguridad
      if ((d + u.idx * 4) % 90 === 0) {
        const created = day0 + 21 * HOUR;
        wos.push({
          unit: u, type: 'DETECTIVO', origin: 'PLAN', system: 'Sistema eléctrico', title: 'Verificación de alarmas, salidas de emergencia y matafuegos', symptom: 'Inspección de fallas ocultas',
          priority: 3, road_call: 0, immobilized: 1, km_at: Math.round(u.odo), created, started: created + 0.2 * HOUR, closed: created + rnd(0.8, 1.5) * HOUR,
          labor: rnd(0.5, 1), parts: [], diagnosis: 'Sin hallazgos', root_cause: null,
        });
      }
    }
  }

  // Dos OTs proactivas: análisis de causa raíz de fallas recurrentes
  const proUnits = [units[3], units[12]];
  proUnits.forEach((u, i) => {
    const created = today0.getTime() - (40 - i * 15) * DAY + 9 * HOUR;
    wos.push({
      unit: u, type: 'PROACTIVO', origin: 'INSPECCION', system: i ? 'Puertas' : 'Frenos',
      title: i ? 'Causa raíz: fallas recurrentes de puertas — reemplazo de electroválvulas por versión mejorada' : 'Causa raíz: secador de aire saturado — cambio a cartucho coalescente',
      symptom: 'Fallas repetidas del mismo sistema en 90 días', priority: 3, road_call: 0, immobilized: 1, km_at: Math.round(u.odo - 240 * (40 - i * 15)),
      created, started: created + HOUR, closed: created + 5 * HOUR, labor: 3.5, parts: i ? [['PU-5003', 2]] : [['FR-1005', 1]],
      diagnosis: 'Análisis de causa raíz completado', root_cause: i ? 'Electroválvula de diseño anterior' : 'Secador sin mantenimiento',
    });
  });

  // OTs abiertas al día de hoy, en distintas etapas del flujo del taller
  const open = [
    { u: 2, type: 'CORRECTIVO', origin: 'CONDUCTOR', system: 'Frenos', title: 'Falla en ruta: baja presión de aire en tablero', symptom: 'Baja presión de aire en tablero; la unidad fue remolcada', priority: 1, road_call: 1, stage: 'REPARACION', hoursAgo: 5, parts: [['FR-1004', 1]], issued: true, labor: 2, diagnosis: 'Válvula relé con pérdida en eje trasero' },
    { u: 5, type: 'CORRECTIVO', origin: 'CONDUCTOR', system: 'Puertas', title: 'Puerta trasera no cierra', symptom: 'Reportado por el conductor al cierre del servicio', priority: 2, road_call: 0, stage: 'ORDEN', hoursAgo: 0.7, parts: [] },
    { u: 9, type: 'PREVENTIVO', origin: 'PLAN', system: 'Plan preventivo', level: 'B', stage: 'REPUESTOS', hoursAgo: 3, priority: 3 },
    { u: 14, type: 'CORRECTIVO', origin: 'CONDUCTOR', system: 'Ejes y transmisión', title: 'Falla en ruta: la caja no pasa cambios', symptom: 'Caja bloqueada en 2.ª; unidad remolcada a cochera', priority: 1, road_call: 1, stage: 'REPUESTOS', hoursAgo: 26, parts: [['TR-3005', 1]], labor: 3, diagnosis: 'Daño interno de caja: reemplazo por rotable reacondicionado', requisition: true },
    { u: 18, type: 'PREDICTIVO', origin: 'SENSOR', system: 'Sistema eléctrico', title: 'Alerta predictiva: baterías por agotarse', symptom: 'Tensión de baterías en descenso sostenido', priority: 2, road_call: 0, stage: 'CONTROL', hoursAgo: 7, parts: [['EL-7001', 2]], issued: true, labor: 1.5, diagnosis: 'Baterías con capacidad < 60%' },
    { u: 20, type: 'CORRECTIVO', origin: 'INSPECCION', system: 'Neumáticos', title: 'Corte en flanco de neumático delantero izquierdo', symptom: 'Detectado en la inspección diaria', priority: 2, road_call: 0, stage: 'DIAGNOSTICO', hoursAgo: 2, parts: [] },
  ];
  for (const o of open) {
    const u = units[o.u];
    const created = now - o.hoursAgo * HOUR;
    if (o.level) {
      const p = planByLevel[o.level];
      wos.push({
        unit: u, type: 'PREVENTIVO', origin: 'PLAN', system: 'Plan preventivo', title: p.name, symptom: 'Servicio programado por kilometraje', priority: 3, road_call: 0, immobilized: 1,
        km_at: Math.round(u.odo), plan_id: p.id, due_km: Math.round(u.last[o.level] + p.interval_km), srvt: p.jde_service_type, created, started: created + 0.5 * HOUR, closed: null,
        stage: o.stage, labor: 0, parts: p.kit.filter((x) => !(x.ice && u.pt === 'ELECTRICO')).map((x) => [x.item, x.qty]), diagnosis: null,
      });
    } else {
      wos.push({ unit: u, ...o, immobilized: 1, km_at: Math.round(u.odo), created, started: o.stage === 'ORDEN' ? null : created + 0.4 * HOUR, closed: null, labor: o.labor || 0, root_cause: null, issued: o.issued });
    }
  }

  // ------------------------------------------------------------- inventario
  const below = { 'FR-1001': 8, 'SU-4002': 2, 'NE-6001': 9, 'TR-3005': 0 };
  const stock = Object.fromEntries(C.PARTS.map((p) => [p.item_no, below[p.item_no] ?? Math.round(p.safety_stock * rnd(1.1, 2.6))]));

  // ------------------------------------------------------------- escritura
  const nowJ = J.toJulian();
  J.db.exec('BEGIN');
  try {
    const ab = J.db.prepare('INSERT INTO F0101 VALUES (?,?,?)');
    techs.forEach(([an8, name]) => ab.run(an8, name, 'E'));
    C.SUPPLIERS.forEach(([an8, name]) => ab.run(an8, name, 'V'));
    ab.run(9001, 'Integración Flota (usuario AIS)', 'E');
    const eq = J.db.prepare('INSERT INTO F1201 (NUMB,ASII,DL01,MCU,EQST,ASID,MANU,MODL,YEAR,ACL1,ACL2,DAJ,UPMJ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const mtr = J.db.prepare('INSERT INTO F1201_MTR VALUES (?,?,?)');
    const sch = J.db.prepare('INSERT INTO F1207 VALUES (?,?,?,?,?,?,?,?)');
    for (const u of units) {
      eq.run(u.numb, u.unit_no, `Colectivo ${u.brand} ${u.model}`, u.mcu, 'AV', u.plate, u.brand, u.model, u.year, u.pt, u.line, J.toJulian(u.inService), nowJ);
      mtr.run(u.numb, Math.round(u.odo), jul(now - DAY));
      for (const p of plans) sch.run(u.numb, p.jde_service_type, p.name, p.interval_km, p.interval_days, Math.round(u.last[p.level]), jul(u.lastDate[p.level]), '01');
    }
    const im = J.db.prepare('INSERT INTO F4101 VALUES (?,?,?,?,?)');
    const il = J.db.prepare('INSERT INTO F41021 VALUES (?,?,?,?,?,?,?,?)');
    for (const p of C.PARTS) {
      im.run(p.item_no, p.description, p.system, p.rotable ? 'R' : 'S', p.criticality);
      il.run(p.item_no, C.BRANCH, stock[p.item_no], p.safety_stock, p.reorder_qty, p.unit_cost, p.lead_days, p.supplier);
    }
    J.db.exec('COMMIT');
  } catch (e) { J.db.exec('ROLLBACK'); throw e; }

  wos.sort((a, b) => a.created - b.created);
  tx(() => {
    J.db.exec('BEGIN');
    try {
      plans.forEach((p, i) => run('INSERT INTO pm_plans (id,level,name,interval_km,interval_days,std_hours,jde_service_type,rank,tasks,kit) VALUES (?,?,?,?,?,?,?,?,?,?)',
        i + 1, p.level, p.name, p.interval_km, p.interval_days, p.std_hours, p.jde_service_type, p.rank, JSON.stringify(p.tasks), JSON.stringify(p.kit)));
      techs.forEach(([an8, name, spec2, rate]) => run('INSERT INTO technicians VALUES (?,?,?,?)', an8, name, spec2, rate));
      for (const p of C.PARTS) {
        const sup = C.SUPPLIERS.find((s) => s[0] === p.supplier);
        run('INSERT INTO parts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', p.item_no, p.description, p.system, p.criticality, stock[p.item_no], p.safety_stock, p.reorder_qty, p.unit_cost, p.lead_days, p.rotable, p.supplier, sup[1], iso(now));
      }
      const km = db.prepare('INSERT INTO km_log VALUES (?,?,?)');
      for (const r of kmRows) km.run(...r);

      const alertIds = [];
      for (const a of alerts) {
        const r = run('INSERT INTO alerts (unit_id,ts,metric,system,kind,severity,message,value,status) VALUES (?,?,?,?,?,?,?,?,?)', a.unit.id, iso(a.ts), a.metric, a.system, a.kind, a.severity, a.message, a.value, 'RESUELTA');
        alertIds.push(Number(r.lastInsertRowid));
      }

      const stageJde = Object.fromEntries(C.STAGES.map((s) => [s.key, s.jde]));
      const jWo = J.db.prepare('INSERT INTO F4801 (DOCO,DCTO,TYPS,NUMB,DL01,SRST,PRTS,MCU,SRVT,TRDJ,STRT,ADAT,MTR1,RCAU,HRSA,AMTA,EXTREF) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const jPart = J.db.prepare('INSERT INTO F3111 (DOCO,LITM,UORG,TRQT,UNCS) VALUES (?,?,?,?,?)');
      const jLab = J.db.prepare('INSERT INTO F31122 (DOCO,AN8,HRSO,RATE,DGL) VALUES (?,?,?,?,?)');
      const jLed = J.db.prepare("INSERT INTO F4111 (LITM,MCU,DCT,DOCO,TRQT,UNCS,DGL) VALUES (?,?,'IM',?,?,?,?)");
      const jGl = J.db.prepare('INSERT INTO F0911 (DOC,DCT,OBJ,SUB,AA,DGL,EXA,ICU) VALUES (?,?,?,?,?,?,?,?)');
      let icu = 80000;
      for (const w of wos) {
        doco++;
        const stage = w.closed ? 'CERRADA' : w.stage;
        const tech = w.type === 'PREVENTIVO' ? techs[0] : pick(techs);
        const issuedAll = !!w.closed || w.issued;
        const partsCost = issuedAll ? w.parts.reduce((s, [it, q]) => s + partCost[it] * q, 0) : 0;
        const laborCost = w.labor * tech[3];
        const total = Math.round((partsCost + laborCost) * 100) / 100;
        const r = run(`INSERT INTO work_orders (unit_id,type,origin,system,title,symptom,diagnosis,root_cause,priority,stage,road_call,immobilized,km_at,plan_id,due_km,alert_id,created_at,started_at,closed_at,jde_doco,jde_status,jde_cost,sync_state)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          w.unit.id, w.type, w.origin, w.system, w.title, w.symptom, w.diagnosis || null, w.root_cause || null, w.priority, stage, w.road_call, w.immobilized, w.km_at,
          w.plan_id || null, w.due_km || null, w.alertIdx !== undefined ? alertIds[w.alertIdx] : null, iso(w.created), w.started ? iso(w.started) : null, w.closed ? iso(w.closed) : null,
          doco, stageJde[stage], w.closed ? total : null, 'OK');
        const woId = Number(r.lastInsertRowid);
        if (w.alertIdx !== undefined) run('UPDATE alerts SET wo_id=? WHERE id=?', woId, alertIds[w.alertIdx]);
        jWo.run(doco, 'WM', C.WO_TYPES[w.type].jde, w.unit.numb, w.title.slice(0, 60), stageJde[stage], String(w.priority), w.unit.mcu, w.srvt || null,
          jul(w.created), w.started ? jul(w.started) : null, w.closed ? jul(w.closed) : null, w.km_at, w.root_cause || null, Math.round(w.labor * 100) / 100, w.closed ? total : 0, String(woId));
        for (const [it, q] of w.parts) {
          run('INSERT INTO wo_parts (wo_id,item_no,qty,unit_cost,issued) VALUES (?,?,?,?,?)', woId, it, q, partCost[it], issuedAll ? q : 0);
          jPart.run(doco, it, q, issuedAll ? q : 0, partCost[it]);
          if (issuedAll) jLed.run(it, C.BRANCH, doco, -q, partCost[it], jul(w.closed || w.started));
        }
        if (w.labor > 0) {
          const day = iso(w.closed || w.started || w.created).slice(0, 10);
          run('INSERT INTO wo_labor (wo_id,tech_an8,tech,hours,rate,day) VALUES (?,?,?,?,?,?)', woId, tech[0], tech[1], Math.round(w.labor * 100) / 100, tech[3], day);
          jLab.run(doco, tech[0], Math.round(w.labor * 100) / 100, tech[3], J.toJulian(day));
        }
        run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', woId, iso(w.created), 'ORDEN', `OT creada (origen: ${w.origin.toLowerCase()})`);
        if (w.started) run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', woId, iso(w.started), w.closed ? 'DIAGNOSTICO' : stage, w.diagnosis || 'Ingreso a taller');
        if (w.closed) {
          run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', woId, iso(w.closed), 'CERRADA', `OT cerrada. Costo ${total.toFixed(2)} USD contabilizado en JDE`);
          icu++;
          if (partsCost) jGl.run(doco, 'WO', '6410', w.unit.unit_no, partsCost, jul(w.closed), 'Repuestos mantenimiento flota', icu);
          if (laborCost) jGl.run(doco, 'WO', '6420', w.unit.unit_no, Math.round(laborCost * 100) / 100, jul(w.closed), 'Mano de obra taller', icu);
        }
        if (w.requisition) {
          run("INSERT INTO requisitions (item_no,qty,reason,wo_id,created_at,jde_doco,jde_status,sync_state) VALUES (?,?,?,?,?,?,?,'OK')", 'TR-3005', 1, `Faltante para OT ${woId}`, woId, iso(w.created + HOUR), 7000, '220');
          J.db.prepare("INSERT INTO F4311 (DOCO,DCTO,LNID,LITM,UORG,AN8,PRRC,LTTR,NXTR,DRQJ,MCU) VALUES (7000,'OR',1,'TR-3005',1,5004,6500,'220','230',?,?)").run(nowJ, C.BRANCH);
        }
      }
      J.db.prepare('INSERT INTO F0002 VALUES (?,?)').run('48', doco + 1);
      J.db.prepare('INSERT INTO F0002 VALUES (?,?)').run('43', 7001);
      J.db.prepare('INSERT INTO F0002 VALUES (?,?)').run('09', icu + 1);

      // Unidades, programación PM y estado (derivado de las OTs abiertas)
      const jStat = J.db.prepare('UPDATE F1201 SET EQST=? WHERE NUMB=?');
      for (const u of units) {
        const openW = wos.filter((w) => w.unit === u && !w.closed && w.immobilized);
        const status = openW.some((w) => w.priority === 1) ? 'FUERA_SERVICIO' : openW.length ? 'EN_TALLER' : 'DISPONIBLE';
        jStat.run(C.UNIT_STATUS[status].jde, u.numb);
        run(`INSERT INTO units (id,unit_no,jde_asset,plate,brand,model,year,powertrain,depot,line,odometer_km,meter_sent_km,status,jde_status,in_service_date,last_sync)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, u.id, u.unit_no, u.numb, u.plate, u.brand, u.model, u.year, u.pt, u.depot, u.line, Math.round(u.odo), Math.round(u.odo), status, C.UNIT_STATUS[status].jde, u.inService, iso(now));
        for (const p of plans) {
          let lastKm = u.last[p.level];
          // Tres unidades con el preventivo A atrasado (riesgo señalado en la diapositiva 19)
          if (p.level === 'A' && [7, 13, 22].includes(u.idx)) lastKm = Math.min(lastKm, u.odo - 11600 - u.idx * 20);
          run('INSERT INTO pm_schedule VALUES (?,?,?,?)', u.id, planByLevel[p.level].id, Math.round(lastKm), iso(u.lastDate[p.level]).slice(0, 10));
          J.db.prepare('UPDATE F1207 SET LSTM=? WHERE NUMB=? AND SRVT=?').run(Math.round(lastKm), u.numb, p.jde_service_type);
        }
      }

      // Inspecciones diarias de los últimos 3 días (sin defectos)
      for (let d = 3; d >= 1; d--) {
        for (const u of units.filter((x) => (x.idx + d) % 2 === 0)) {
          const items = Object.fromEntries(C.INSPECTION_ITEMS.map((it) => [it.key, 'OK']));
          run('INSERT INTO inspections (unit_id,driver,ts,odometer_km,items,defects) VALUES (?,?,?,?,?,0)', u.id, pick(['J. Gómez', 'M. Ríos', 'A. Sosa', 'P. Luna', 'C. Vera', 'R. Ponce']), iso(today0.getTime() - d * DAY + 5.5 * HOUR), Math.round(u.odo - d * 240), JSON.stringify(items));
        }
      }
      J.db.exec('COMMIT');
    } catch (e) { J.db.exec('ROLLBACK'); throw e; }
  });
  console.log(`[seed] ${units.length} unidades, ${wos.length} órdenes de trabajo, ${kmRows.length} registros de km`);
}

function ensureSeeded() {
  if (get('SELECT COUNT(*) n FROM units').n > 0 && J.db.prepare('SELECT COUNT(*) n FROM F1201').get().n > 0) return false;
  wipe();
  seed();
  return true;
}

module.exports = { ensureSeeded, wipe, seed };
