// API REST del CMMS (consumida por la interfaz web en /public)
const { all, get, run, nowIso, getSetting, setSetting } = require('./db');
const C = require('./catalog');
const wo = require('./services/workorders');
const pm = require('./services/pm');
const kpi = require('./services/kpi');
const tel = require('./services/telemetry');
const jde = require('./jde/integration');
const ais = require('./jde/aisClient');

const routes = [];
const on = (method, path, fn) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
};

// ------------------------------------------------------------- catálogo
on('GET', '/api/meta', () => ({
  systems: C.SYSTEMS, majorSystems: C.MAJOR_SYSTEMS, woTypes: C.WO_TYPES, stages: C.STAGES, unitStatus: C.UNIT_STATUS,
  metrics: C.METRICS, scenarios: Object.fromEntries(Object.entries(C.FAULT_SCENARIOS).map(([k, v]) => [k, v.label])),
  inspectionItems: C.INSPECTION_ITEMS, technicians: all('SELECT * FROM technicians'), plans: all('SELECT id, level, name FROM pm_plans ORDER BY rank'),
  parts: all('SELECT item_no, description, system, on_hand, unit_cost FROM parts ORDER BY item_no'),
  units: all('SELECT id, unit_no, plate, powertrain, status FROM units ORDER BY unit_no'),
  settings: { auto_wo: getSetting('auto_wo', true), auto_reorder: getSetting('auto_reorder', true) },
}));

// ------------------------------------------------------------- tablero
on('GET', '/api/dashboard', async () => {
  const k = kpi.compute(30);
  const stages = Object.fromEntries(all("SELECT stage, COUNT(*) n FROM work_orders WHERE stage<>'CERRADA' GROUP BY stage").map((r) => [r.stage, r.n]));
  const alerts = all(`SELECT a.*, u.unit_no FROM alerts a JOIN units u ON u.id=a.unit_id WHERE a.status IN ('ABIERTA','OT_GENERADA') ORDER BY
      CASE a.severity WHEN 'CRITICA' THEN 0 WHEN 'ADVERTENCIA' THEN 1 ELSE 2 END, a.ts DESC LIMIT 8`);
  const sched = pm.schedule().units;
  const pmCounts = sched.reduce((acc, r) => { acc[r.nextStatus] = (acc[r.nextStatus] || 0) + 1; return acc; }, {});
  const lowStock = get('SELECT COUNT(*) n FROM parts WHERE on_hand < safety_stock').n;
  const lowStockA = get("SELECT COUNT(*) n FROM parts WHERE on_hand < safety_stock AND criticality='A'").n;
  const integ = await jde.status();
  const units = all('SELECT id, unit_no, status, line, depot FROM units ORDER BY unit_no');
  const openWo = wo.list({ open: '1', limit: 12 });
  return { kpi: k, stages, alerts, pmCounts, lowStock, lowStockA, integration: integ, units, openWo };
});

// ------------------------------------------------------------- unidades
on('GET', '/api/units', () => {
  const units = all('SELECT * FROM units ORDER BY unit_no');
  const open = all("SELECT unit_id, COUNT(*) n FROM work_orders WHERE stage<>'CERRADA' GROUP BY unit_id");
  const alerts = all("SELECT unit_id, COUNT(*) n FROM alerts WHERE status IN ('ABIERTA','OT_GENERADA') GROUP BY unit_id");
  const sched = pm.schedule().units;
  return units.map((u) => ({
    ...u, odometer_km: Math.round(u.odometer_km), openWo: open.find((o) => o.unit_id === u.id)?.n || 0, alerts: alerts.find((a) => a.unit_id === u.id)?.n || 0,
    pmNext: sched.find((s) => s.unit.id === u.id)?.next, pmStatus: sched.find((s) => s.unit.id === u.id)?.nextStatus,
  }));
});

on('GET', '/api/units/:id', ({ id }) => {
  const u = get('SELECT * FROM units WHERE id=?', Number(id));
  if (!u) throw new wo.HttpError(404, 'Unidad inexistente');
  u.odometer_km = Math.round(u.odometer_km);
  const pmRow = pm.schedule().units.find((r) => r.unit.id === u.id);
  const since180 = new Date(Date.now() - 180 * 86400000).toISOString();
  const costs = all(`SELECT type, COUNT(*) n, SUM((SELECT COALESCE(SUM(issued*unit_cost),0) FROM wo_parts WHERE wo_id=w.id) + (SELECT COALESCE(SUM(hours*rate),0) FROM wo_labor WHERE wo_id=w.id)) cost
                     FROM work_orders w WHERE unit_id=? AND created_at>=? GROUP BY type`, u.id, since180);
  const km180 = get('SELECT COALESCE(SUM(km),0) k FROM km_log WHERE unit_id=? AND day>=?', u.id, since180.slice(0, 10)).k;
  const road180 = get('SELECT COUNT(*) n FROM work_orders WHERE unit_id=? AND road_call=1 AND created_at>=?', u.id, since180).n;
  return {
    unit: u, pm: pmRow, workOrders: wo.list({ unit_id: u.id, limit: 60 }), telemetry: tel.series(u.id),
    alerts: all("SELECT * FROM alerts WHERE unit_id=? ORDER BY ts DESC LIMIT 15", u.id),
    inspections: all('SELECT * FROM inspections WHERE unit_id=? ORDER BY ts DESC LIMIT 5', u.id),
    km: all('SELECT day, km FROM km_log WHERE unit_id=? ORDER BY day DESC LIMIT 30', u.id).reverse(),
    costs, km180, road180, mdbf: road180 ? km180 / road180 : null,
  };
});

// ------------------------------------------------------------- órdenes de trabajo
on('GET', '/api/workorders', (_, q) => wo.list(q));
on('POST', '/api/workorders', (_, __, b) => wo.create(b));
on('GET', '/api/workorders/:id', ({ id }) => wo.detail(Number(id)));
on('PATCH', '/api/workorders/:id', ({ id }, _, b) => wo.update(Number(id), b));
on('POST', '/api/workorders/:id/advance', ({ id }, _, b) => wo.advance(Number(id), b));
on('POST', '/api/workorders/:id/close', ({ id }, _, b) => wo.close(Number(id), b));
on('POST', '/api/workorders/:id/parts', ({ id }, _, b) => wo.addParts(Number(id), b.parts || [[b.item_no, b.qty]]));
on('POST', '/api/workorders/:id/parts/:line/issue', ({ id, line }) => wo.issuePart(Number(id), Number(line)));
on('POST', '/api/workorders/:id/issue-all', ({ id }) => wo.issueAll(Number(id)));
on('POST', '/api/workorders/:id/labor', ({ id }, _, b) => wo.addLabor(Number(id), b.an8, b.hours));

// ------------------------------------------------------------- preventivo
on('GET', '/api/pm', () => pm.schedule());
on('POST', '/api/pm/generate', (_, __, b) => pm.generate(Number(b.unit_id), Number(b.plan_id)));
on('POST', '/api/pm/generate-due', (_, __, b) => ({ created: pm.generateDue({ includeUpcoming: b.includeUpcoming !== false }) }));

// ------------------------------------------------------------- repuestos
on('GET', '/api/parts', () => {
  const parts = all('SELECT * FROM parts ORDER BY criticality, item_no');
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const usage = all('SELECT wp.item_no, SUM(wp.issued) q FROM wo_parts wp JOIN work_orders w ON w.id=wp.wo_id WHERE w.created_at>=? GROUP BY wp.item_no', since);
  const reqs = all("SELECT item_no, jde_doco, jde_status, sync_state, qty FROM requisitions WHERE (jde_status IS NULL OR jde_status<'400') AND sync_state<>'ERROR'");
  const waiting = all("SELECT wp.item_no, COUNT(DISTINCT wp.wo_id) n FROM wo_parts wp JOIN work_orders w ON w.id=wp.wo_id WHERE w.stage<>'CERRADA' AND wp.issued<wp.qty GROUP BY wp.item_no");
  return parts.map((p) => ({
    ...p, usage90: usage.find((u) => u.item_no === p.item_no)?.q || 0, requisition: reqs.find((r) => r.item_no === p.item_no) || null,
    waitingWo: waiting.find((w) => w.item_no === p.item_no)?.n || 0,
  }));
});
on('GET', '/api/requisitions', () => all('SELECT r.*, p.description FROM requisitions r LEFT JOIN parts p ON p.item_no=r.item_no ORDER BY r.id DESC LIMIT 100'));
on('POST', '/api/requisitions', (_, __, b) => wo.requisition(b.item_no, Number(b.qty), b.reason || 'Solicitud manual'));
on('GET', '/api/kits', () => all('SELECT * FROM pm_plans ORDER BY rank').map((p) => ({
  level: p.level, name: p.name, items: JSON.parse(p.kit).map((k) => ({ ...k, ...get('SELECT description, on_hand, unit_cost FROM parts WHERE item_no=?', k.item) })),
})));

// ------------------------------------------------------------- IoT / predictivo
on('GET', '/api/telemetry', () => tel.snapshot());
on('GET', '/api/telemetry/:id', ({ id }) => tel.series(Number(id)));
on('POST', '/api/telemetry/inject', (_, __, b) => tel.inject(Number(b.unit_id), b.metric));
on('GET', '/api/alerts', (_, q) => all(`SELECT a.*, u.unit_no, u.plate FROM alerts a JOIN units u ON u.id=a.unit_id
   ${q.status === 'open' ? "WHERE a.status IN ('ABIERTA','OT_GENERADA')" : ''} ORDER BY a.ts DESC LIMIT ${Math.min(Number(q.limit) || 100, 500)}`));
on('POST', '/api/alerts/:id/wo', ({ id }) => tel.createWoFromAlert(Number(id)));
on('POST', '/api/alerts/:id/dismiss', ({ id }) => { tel.dismiss(Number(id)); return { ok: true }; });
on('GET', '/api/predictive', () => {
  const a = tel.analysis();
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const km = get('SELECT COALESCE(SUM(km),0) k FROM km_log WHERE day>=?', since.slice(0, 10)).k;
  a.systems = all(`SELECT system, COUNT(*) n, SUM(road_call) road, AVG((julianday(closed_at)-julianday(created_at))*24) mttr
                   FROM work_orders WHERE type='CORRECTIVO' AND created_at>=? GROUP BY system ORDER BY n DESC`, since)
    .map((s) => ({ ...s, mdbf: s.road ? km / s.road : null }));
  a.predictiveWo = get("SELECT COUNT(*) n FROM work_orders WHERE type IN ('PREDICTIVO','CONDICION') AND created_at>=?", since).n;
  return a;
});

// ------------------------------------------------------------- inspección diaria
on('GET', '/api/inspections', () => all('SELECT i.*, u.unit_no FROM inspections i JOIN units u ON u.id=i.unit_id ORDER BY i.ts DESC LIMIT 50'));
on('POST', '/api/inspections', (_, __, b) => {
  const u = get('SELECT * FROM units WHERE id=?', Number(b.unit_id));
  if (!u) throw new wo.HttpError(400, 'Seleccione la unidad');
  if (!b.driver) throw new wo.HttpError(400, 'Indique el conductor');
  const items = b.items || {};
  const defects = C.INSPECTION_ITEMS.filter((it) => items[it.key] === 'FALLA');
  const odo = Number(b.odometer_km);
  if (odo && odo > u.odometer_km) run('UPDATE units SET odometer_km=? WHERE id=?', odo, u.id);
  const r = run('INSERT INTO inspections (unit_id,driver,ts,odometer_km,items,defects) VALUES (?,?,?,?,?,?)', u.id, b.driver, nowIso(), odo || Math.round(u.odometer_km), JSON.stringify({ items, notes: b.notes || {} }), defects.length);
  const inspId = Number(r.lastInsertRowid);
  const created = [];
  for (const d of defects) {
    const note = (b.notes || {})[d.key];
    const w = wo.create({
      unit_id: u.id, type: d.detective ? 'DETECTIVO' : 'CORRECTIVO', origin: 'CONDUCTOR', system: d.system,
      title: `Inspección diaria: ${d.label.split(':')[0].split('(')[0].trim()}${note ? ' — ' + note : ''}`.slice(0, 120),
      symptom: `Defecto informado por ${b.driver} en la inspección diaria${note ? ': ' + note : ''}`,
      priority: d.safety ? 1 : 2, immobilized: d.safety ? 1 : 0, inspection_id: inspId,
    });
    created.push({ id: w.id, title: w.title, priority: w.priority });
  }
  if (created.length) run('UPDATE inspections SET wo_id=? WHERE id=?', created[0].id, inspId);
  return { id: inspId, defects: defects.length, workOrders: created, unitApt: !defects.some((d) => d.safety) };
});

// ------------------------------------------------------------- KPIs
on('GET', '/api/kpis', (_, q) => kpi.compute(Math.min(Math.max(Number(q.days) || 90, 7), 180)));

// ------------------------------------------------------------- integración JDE
on('GET', '/api/integration/status', () => jde.status());
on('GET', '/api/integration/log', (_, q) => all(`SELECT * FROM integration_log ${q.orch ? 'WHERE orchestration=?' : ''} ORDER BY id DESC LIMIT ?`, ...(q.orch ? [q.orch] : []), Math.min(Number(q.limit) || 100, 500)));
on('GET', '/api/integration/outbox', (_, q) => all(`SELECT * FROM outbox ${q.status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 200`, ...(q.status ? [q.status] : [])));
on('POST', '/api/integration/sync', () => jde.syncAll());
on('POST', '/api/integration/meter', () => ({ units: jde.pushMeterReadings() }));
on('POST', '/api/integration/retry', async (_, __, b) => { await jde.retry(b.id ? Number(b.id) : null); return { ok: true }; });
on('POST', '/api/integration/pause', (_, __, b) => { setSetting('integration_paused', !!b.paused); if (!b.paused) jde.processOutbox(true); return { paused: !!b.paused }; });
on('PUT', '/api/integration/config', (_, __, b) => {
  const cur = getSetting('jde', {});
  const next = { ...cur };
  for (const k of ['baseUrl', 'username', 'environment', 'role']) if (b[k]) next[k] = String(b[k]).trim();
  if (b.password && b.password !== '••••') next.password = b.password;
  setSetting('jde', next);
  ais.resetSession();
  return jde.status();
});
// Sólo para el simulador: provoca una caída del AIS para probar reintentos
on('POST', '/api/integration/outage', async (_, __, b) => {
  const r = await fetch(ais.config().baseUrl.replace(/\/$/, '') + '/mock/outage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !!b.on }) });
  return r.json();
});
on('GET', '/api/integration/outage', async () => { try { return await (await fetch(ais.config().baseUrl.replace(/\/$/, '') + '/mock/outage')).json(); } catch { return { outage: null }; } });
on('GET', '/api/integration/mapping', () => MAPPING);

// ------------------------------------------------------------- ajustes
on('PUT', '/api/settings', (_, __, b) => {
  for (const k of ['auto_wo', 'auto_reorder']) if (b[k] !== undefined) setSetting(k, !!b[k]);
  return { auto_wo: getSetting('auto_wo', true), auto_reorder: getSetting('auto_reorder', true) };
});

const MAPPING = [
  { process: 'Ficha de cada unidad', direction: 'JDE → CMMS', orchestration: 'FLT_GetEquipmentList', jde: 'P1701 Equipment Master · F1201, F1201 medidores', when: 'Cada 60 s y a demanda' },
  { process: 'Lecturas de odómetro', direction: 'CMMS → JDE', orchestration: 'FLT_UpdateMeterReadings', jde: 'P12120 Meter Readings', when: 'Lote cada 5 min' },
  { process: 'Estado de la unidad', direction: 'CMMS → JDE', orchestration: 'FLT_UpdateEquipmentStatus', jde: 'F1201.EQST (UDC 12/ES: AV, IR, DN)', when: 'Al cambiar el estado' },
  { process: 'Alta de orden de trabajo', direction: 'CMMS → JDE', orchestration: 'FLT_CreateWorkOrder', jde: 'P13714/P48201 · F4801 (WM)', when: 'Al crear la OT (manual, plan, sensor o inspección)' },
  { process: 'Avance del flujo del taller', direction: 'CMMS → JDE', orchestration: 'FLT_UpdateWorkOrderStatus', jde: 'F4801.SRST (UDC 00/SS: 10, 20, 30, 40, 80, 99)', when: 'En cada cambio de etapa' },
  { process: 'Lista de repuestos de la OT', direction: 'CMMS → JDE', orchestration: 'FLT_AddWorkOrderParts', jde: 'P3111 · F3111', when: 'Al planificar repuestos o kits A/B/C' },
  { process: 'Entrega de repuestos', direction: 'CMMS → JDE', orchestration: 'FLT_IssueParts', jde: 'P31113 Inventory Issues · F41021, F4111 (IM)', when: 'Al entregar en pañol' },
  { process: 'Mano de obra', direction: 'CMMS → JDE', orchestration: 'FLT_AddLaborHours', jde: 'P311221 · F31122', when: 'Al registrar horas' },
  { process: 'Cierre y costeo', direction: 'CMMS → JDE', orchestration: 'FLT_CompleteWorkOrder', jde: 'F4801 (99) · F0911 (cuentas 6410/6420)', when: 'Al cerrar la OT' },
  { process: 'Programación preventiva', direction: 'CMMS → JDE', orchestration: 'FLT_UpdatePMSchedule', jde: 'P1207 · F1207 (PMA, PMB, PMC, PMM)', when: 'Al cerrar un preventivo' },
  { process: 'Stock y maestro de repuestos', direction: 'JDE → CMMS', orchestration: 'FLT_GetInventory', jde: 'F4101, F41021 (sucursal M30)', when: 'Cada 60 s y a demanda' },
  { process: 'Requisición de compra', direction: 'CMMS → JDE', orchestration: 'FLT_CreateRequisition', jde: 'P4310 · F4311 (OR)', when: 'Faltante en OT o stock bajo el de seguridad' },
  { process: 'Seguimiento de compras', direction: 'JDE → CMMS', orchestration: 'FLT_GetRequisitions', jde: 'F4311 (OR → OP, estado 400 recibido)', when: 'Cada 60 s' },
  { process: 'Estado y costo real de OTs', direction: 'JDE → CMMS', orchestration: 'FLT_GetWorkOrders', jde: 'F4801 (SRST, HRSA, AMTA)', when: 'Cada 60 s' },
];

async function handle(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route) return false;
  const m = url.pathname.match(route.re);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const query = Object.fromEntries(url.searchParams);
  let body = {};
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    body = await new Promise((resolve) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    });
  }
  try {
    const out = await route.fn(params, query, body);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out ?? {}));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
  return true;
}

module.exports = { handle };
