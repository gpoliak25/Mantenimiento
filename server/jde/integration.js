// Integración con JDE E1 9.2.
//  - Saliente: patrón "outbox". Cada operación del CMMS que afecta al ERP se
//    registra en la tabla outbox dentro de la misma transacción y un worker la
//    envía en orden (FIFO) por AIS/Orchestrator, con reintentos ante caídas.
//  - Entrante: sincronización periódica de maestros y estados (equipos,
//    inventario, OTs y requisiciones), donde JDE es el sistema de registro.
const { all, get, run, nowIso, getSetting, setSetting } = require('../db');
const ais = require('./aisClient');
const C = require('../catalog');

const listeners = new Set();
const emit = (ev) => listeners.forEach((fn) => { try { fn(ev); } catch { /* noop */ } });

function enqueue(orchestration, entity, entityId, payload) {
  const r = run('INSERT INTO outbox (orchestration,entity,entity_id,payload,status,created_at) VALUES (?,?,?,?,?,?)',
    orchestration, entity, entityId, JSON.stringify(payload), 'PENDIENTE', nowIso());
  setImmediate(processOutbox);
  return Number(r.lastInsertRowid);
}

// Completa el payload con claves JDE que se conocen recién al momento del envío
// (p. ej. el número de OT JDE asignado por FLT_CreateWorkOrder).
function buildInput(msg) {
  const input = JSON.parse(msg.payload);
  if (msg.entity === 'WO' && msg.orchestration !== 'FLT_CreateWorkOrder') {
    const wo = get('SELECT jde_doco FROM work_orders WHERE id=?', msg.entity_id);
    if (!wo || !wo.jde_doco) {
      const pendingCreate = get("SELECT id FROM outbox WHERE entity='WO' AND entity_id=? AND orchestration='FLT_CreateWorkOrder' AND status IN ('PENDIENTE','REINTENTO')", msg.entity_id);
      return pendingCreate ? { wait: true } : { error: 'La OT no tiene número JDE (falló su creación)' };
    }
    input.WorkOrderNumber = wo.jde_doco;
  }
  return { input };
}

function onSuccess(msg, input, resp) {
  const id = msg.entity_id;
  switch (msg.orchestration) {
    case 'FLT_CreateWorkOrder':
      run("UPDATE work_orders SET jde_doco=?, jde_status=? WHERE id=?", resp.WorkOrderNumber, resp.Status || '10', id);
      run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', id, nowIso(), null, `Creada en JDE como OT ${resp.WorkOrderNumber} (WM)`);
      break;
    case 'FLT_UpdateWorkOrderStatus':
      run('UPDATE work_orders SET jde_status=? WHERE id=?', input.Status, id);
      break;
    case 'FLT_CompleteWorkOrder':
      run("UPDATE work_orders SET jde_status='99', jde_cost=? WHERE id=?", resp.ActualCost, id);
      run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', id, nowIso(), null, `Cerrada en JDE. Costo real ${Number(resp.ActualCost || 0).toFixed(2)} USD contabilizado (F0911, lote ${resp.GLBatch || '-'})`);
      break;
    case 'FLT_IssueParts':
      run('UPDATE parts SET on_hand=? WHERE item_no=?', resp.OnHand, input.ItemNumber);
      break;
    case 'FLT_CreateRequisition':
      run("UPDATE requisitions SET jde_doco=?, jde_status=? WHERE id=?", resp.OrderNumber, resp.Status, id);
      break;
    case 'FLT_UpdateEquipmentStatus':
      run('UPDATE units SET jde_status=? WHERE unit_no=?', input.Status, input.UnitNumber);
      break;
    case 'FLT_UpdateMeterReadings':
      for (const r of input.Readings) run('UPDATE units SET meter_sent_km=? WHERE unit_no=?', r.Meter, r.UnitNumber);
      break;
    default:
  }
}

function refreshEntityState(entity, id) {
  const table = { WO: 'work_orders', REQ: 'requisitions' }[entity];
  if (!table) return;
  const o = get("SELECT SUM(status IN ('PENDIENTE','REINTENTO')) p, SUM(status='ERROR') e FROM outbox WHERE entity=? AND entity_id=?", entity, id);
  run(`UPDATE ${table} SET sync_state=? WHERE id=?`, o.e ? 'ERROR' : o.p ? 'PENDIENTE' : 'OK', id);
}

let processing = false;
let retryAt = 0;
async function processOutbox(force = false) {
  if (processing) return;
  if (!force && Date.now() < retryAt) return;
  if (getSetting('integration_paused', false)) return;
  processing = true;
  try {
    for (;;) {
      const msg = get("SELECT * FROM outbox WHERE status IN ('PENDIENTE','REINTENTO') ORDER BY id LIMIT 1");
      if (!msg) break;
      const b = buildInput(msg);
      if (b.wait) break;
      if (b.error) {
        run("UPDATE outbox SET status='ERROR', last_error=?, attempts=attempts+1, sent_at=? WHERE id=?", b.error, nowIso(), msg.id);
        refreshEntityState(msg.entity, msg.entity_id);
        continue;
      }
      try {
        const resp = await ais.orchestrate(msg.orchestration, b.input);
        run("UPDATE outbox SET status='OK', attempts=attempts+1, sent_at=?, last_error=NULL, response=? WHERE id=?", nowIso(), JSON.stringify(resp), msg.id);
        onSuccess(msg, b.input, resp);
        refreshEntityState(msg.entity, msg.entity_id);
        retryAt = 0;
        emit({ type: 'outbox', ok: true });
      } catch (e) {
        if (e.retryable) {
          // Caída o timeout del ERP: se conserva el orden y se reintenta con espera exponencial
          run("UPDATE outbox SET status='REINTENTO', attempts=attempts+1, last_error=?, sent_at=? WHERE id=?", e.message, nowIso(), msg.id);
          const n = msg.attempts + 1;
          retryAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(n, 5));
          refreshEntityState(msg.entity, msg.entity_id);
          emit({ type: 'outbox', ok: false });
          break;
        }
        // Error de negocio (validación JDE): no se reintenta automáticamente
        run("UPDATE outbox SET status='ERROR', attempts=attempts+1, last_error=?, sent_at=? WHERE id=?", e.message, nowIso(), msg.id);
        refreshEntityState(msg.entity, msg.entity_id);
        emit({ type: 'outbox', ok: false });
      }
    }
  } finally {
    processing = false;
  }
}

function retry(id) {
  if (id) run("UPDATE outbox SET status='PENDIENTE' WHERE id=? AND status IN ('ERROR','REINTENTO')", id);
  else run("UPDATE outbox SET status='PENDIENTE' WHERE status IN ('ERROR','REINTENTO')");
  retryAt = 0;
  return processOutbox(true);
}

// ------------------------------------------------------------- entrante
const DEPOT_BY_MCU = { '30N': 'Cochera Norte', '30S': 'Cochera Sur' };

async function syncEquipment() {
  const r = await ais.orchestrate('FLT_GetEquipmentList', {}, { direction: 'IN' });
  let created = 0, updated = 0;
  for (const e of r.Equipment || []) {
    const u = get('SELECT * FROM units WHERE unit_no=?', e.UnitNumber);
    if (!u) {
      const ins = run(`INSERT INTO units (unit_no,jde_asset,plate,brand,model,year,powertrain,depot,line,odometer_km,meter_sent_km,status,jde_status,in_service_date,last_sync)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, e.UnitNumber, e.AssetNumber, e.Serial, e.Manufacturer, e.Model, e.Year, e.Category || 'DIESEL',
        DEPOT_BY_MCU[e.BusinessUnit] || e.BusinessUnit, e.Line, e.Meter || 0, e.Meter || 0, C.JDE_TO_UNIT_STATUS[e.Status] || 'DISPONIBLE', e.Status, e.InServiceDate, nowIso());
      const plans = all('SELECT id FROM pm_plans');
      for (const p of plans) run('INSERT OR IGNORE INTO pm_schedule VALUES (?,?,?,?)', Number(ins.lastInsertRowid), p.id, e.Meter || 0, e.InServiceDate || nowIso().slice(0, 10));
      created++;
    } else {
      run(`UPDATE units SET jde_asset=?, plate=?, brand=?, model=?, year=?, powertrain=?, depot=?, line=?, jde_status=?, last_sync=?,
           odometer_km=MAX(odometer_km, COALESCE(?,0)) WHERE id=?`,
        e.AssetNumber, e.Serial, e.Manufacturer, e.Model, e.Year, e.Category || u.powertrain, DEPOT_BY_MCU[e.BusinessUnit] || e.BusinessUnit, e.Line, e.Status, nowIso(), e.Meter, u.id);
      updated++;
    }
  }
  return { created, updated };
}

async function syncInventory() {
  const r = await ais.orchestrate('FLT_GetInventory', { BranchPlant: C.BRANCH }, { direction: 'IN' });
  let n = 0;
  for (const i of r.Items || []) {
    run(`INSERT INTO parts (item_no,description,system,criticality,on_hand,safety_stock,reorder_qty,unit_cost,lead_days,rotable,supplier,supplier_name,last_sync)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(item_no) DO UPDATE SET description=excluded.description, system=excluded.system, criticality=excluded.criticality, on_hand=excluded.on_hand,
           safety_stock=excluded.safety_stock, reorder_qty=excluded.reorder_qty, unit_cost=excluded.unit_cost, lead_days=excluded.lead_days,
           rotable=excluded.rotable, supplier=excluded.supplier, supplier_name=excluded.supplier_name, last_sync=excluded.last_sync`,
      i.ItemNumber, i.Description, i.System, i.Criticality, i.OnHand, i.SafetyStock, i.ReorderQty, i.UnitCost, i.LeadTimeDays, i.StockingType === 'R' ? 1 : 0, i.Supplier, i.SupplierName, nowIso());
    n++;
  }
  return { items: n };
}

async function syncWorkOrders() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const r = await ais.orchestrate('FLT_GetWorkOrders', { Since: since }, { direction: 'IN' });
  let n = 0;
  for (const w of r.WorkOrders || []) {
    const res = run('UPDATE work_orders SET jde_status=?, jde_cost=CASE WHEN ?>0 THEN ? ELSE jde_cost END WHERE jde_doco=?', w.Status, w.ActualCost, w.ActualCost, w.WorkOrderNumber);
    n += Number(res.changes);
  }
  return { workOrders: n };
}

async function syncRequisitions() {
  const r = await ais.orchestrate('FLT_GetRequisitions', {}, { direction: 'IN' });
  let n = 0;
  for (const q of r.Requisitions || []) {
    const res = run("UPDATE requisitions SET jde_status=? WHERE jde_doco=? AND COALESCE(jde_status,'')<>?", q.LastStatus, q.OrderNumber, q.LastStatus);
    n += Number(res.changes);
  }
  return { requisitions: n };
}

let syncing = false;
async function syncAll() {
  if (syncing) return { skipped: true };
  syncing = true;
  const out = { at: nowIso() };
  try {
    for (const [k, fn] of [['equipos', syncEquipment], ['inventario', syncInventory], ['ordenes', syncWorkOrders], ['requisiciones', syncRequisitions]]) {
      try { out[k] = await fn(); } catch (e) { out[k] = { error: e.message }; }
    }
    out.ok = !Object.values(out).some((v) => v && v.error);
    setSetting('last_sync', out);
    emit({ type: 'sync', ok: out.ok });
    return out;
  } finally {
    syncing = false;
  }
}

// Lecturas de medidor: se envían en lote (P12120) las unidades con km nuevos
function pushMeterReadings() {
  const rows = all('SELECT unit_no, odometer_km FROM units WHERE odometer_km - meter_sent_km >= 1');
  if (!rows.length) return 0;
  const pending = get("SELECT id FROM outbox WHERE orchestration='FLT_UpdateMeterReadings' AND status IN ('PENDIENTE','REINTENTO')");
  if (pending) return 0;
  enqueue('FLT_UpdateMeterReadings', 'UNIT', null, { Readings: rows.map((r) => ({ UnitNumber: r.unit_no, Meter: Math.round(r.odometer_km), Date: nowIso().slice(0, 10) })) });
  return rows.length;
}

async function status() {
  const h = await ais.health();
  const cfg = ais.config();
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM outbox GROUP BY status').map((r) => [r.status, r.n]));
  const last24 = get("SELECT COUNT(*) n, SUM(ok) ok, AVG(duration_ms) avg FROM integration_log WHERE ts >= ?", new Date(Date.now() - 86400000).toISOString());
  return {
    health: h, config: { ...cfg, password: cfg.password ? '••••' : '' }, outbox: counts, lastSync: getSetting('last_sync', null),
    paused: getSetting('integration_paused', false), calls24h: last24, retryAt: retryAt > Date.now() ? new Date(retryAt).toISOString() : null,
  };
}

function start() {
  setInterval(() => processOutbox(), 3000);
  setInterval(() => syncAll(), Number(process.env.JDE_SYNC_MS || 60000));
  setInterval(pushMeterReadings, Number(process.env.JDE_METER_MS || 5 * 60000));
  setTimeout(() => syncAll(), 1500);
}

module.exports = { enqueue, processOutbox, retry, syncAll, syncEquipment, syncInventory, syncWorkOrders, syncRequisitions, pushMeterReadings, status, start, listeners };
