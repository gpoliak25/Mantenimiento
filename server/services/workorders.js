// Órdenes de trabajo: flujo del taller (detección → OT → diagnóstico →
// repuestos → reparación → control y cierre) sincronizado con JDE.
const { all, get, run, tx, nowIso, getSetting } = require('../db');
const C = require('../catalog');
const jde = require('../jde/integration');

const STAGE_KEYS = C.STAGES.map((s) => s.key);
const STAGE_JDE = Object.fromEntries(C.STAGES.map((s) => [s.key, s.jde]));
const hooks = { onClose: [] }; // p. ej. telemetría: reponer el sistema reparado

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function event(woId, stage, note) {
  run('INSERT INTO wo_events (wo_id,ts,stage,note) VALUES (?,?,?,?)', woId, nowIso(), stage, note);
}

function recomputeUnitStatus(unitId) {
  const u = get('SELECT * FROM units WHERE id=?', unitId);
  if (!u) return;
  const open = all("SELECT priority FROM work_orders WHERE unit_id=? AND stage<>'CERRADA' AND immobilized=1", unitId);
  const status = open.some((w) => w.priority === 1) ? 'FUERA_SERVICIO' : open.length ? 'EN_TALLER' : 'DISPONIBLE';
  if (status !== u.status) {
    run('UPDATE units SET status=? WHERE id=?', status, unitId);
    jde.enqueue('FLT_UpdateEquipmentStatus', 'UNIT', unitId, { UnitNumber: u.unit_no, Status: C.UNIT_STATUS[status].jde });
  }
}

function create(o) {
  const u = get('SELECT * FROM units WHERE id=?', o.unit_id);
  if (!u) throw new HttpError(400, 'Unidad inexistente');
  if (!C.WO_TYPES[o.type]) throw new HttpError(400, 'Tipo de mantenimiento inválido');
  if (!o.title) throw new HttpError(400, 'Falta el título de la OT');
  const plan = o.plan_id ? get('SELECT * FROM pm_plans WHERE id=?', o.plan_id) : null;
  const id = tx(() => {
    const r = run(`INSERT INTO work_orders (unit_id,type,origin,system,title,symptom,priority,stage,road_call,immobilized,km_at,plan_id,due_km,alert_id,inspection_id,created_at,sync_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDIENTE')`,
      u.id, o.type, o.origin || 'INSPECCION', o.system || null, o.title, o.symptom || null, Number(o.priority || 3), 'ORDEN', o.road_call ? 1 : 0,
      o.immobilized === false || o.immobilized === 0 ? 0 : 1, Math.round(u.odometer_km), o.plan_id || null, o.due_km || null, o.alert_id || null, o.inspection_id || null, nowIso());
    const woId = Number(r.lastInsertRowid);
    event(woId, 'ORDEN', `OT creada (origen: ${(o.origin || 'INSPECCION').toLowerCase()})${o.symptom ? '. ' + o.symptom : ''}`);
    jde.enqueue('FLT_CreateWorkOrder', 'WO', woId, {
      UnitNumber: u.unit_no, Type: C.WO_TYPES[o.type].jde, Description: o.title.slice(0, 60), Priority: String(o.priority || 3),
      ServiceType: plan ? plan.jde_service_type : undefined, Meter: Math.round(u.odometer_km), ExternalId: String(woId), Date: nowIso().slice(0, 10),
    });
    if (o.parts && o.parts.length) addPartsInternal(woId, o.parts);
    return woId;
  });
  recomputeUnitStatus(u.id);
  return detail(id);
}

function addPartsInternal(woId, parts) {
  const lines = [];
  for (const [item, qty] of parts) {
    const p = get('SELECT * FROM parts WHERE item_no=?', item);
    if (!p) throw new HttpError(400, `Repuesto ${item} inexistente`);
    run('INSERT INTO wo_parts (wo_id,item_no,qty,unit_cost,issued) VALUES (?,?,?,?,0)', woId, item, Number(qty), p.unit_cost);
    lines.push({ ItemNumber: item, Quantity: Number(qty) });
  }
  jde.enqueue('FLT_AddWorkOrderParts', 'WO', woId, { Parts: lines });
}

function getOpen(id) {
  const wo = get('SELECT * FROM work_orders WHERE id=?', id);
  if (!wo) throw new HttpError(404, 'OT inexistente');
  if (wo.stage === 'CERRADA') throw new HttpError(400, 'La OT está cerrada');
  return wo;
}

function addParts(id, parts) {
  getOpen(id);
  tx(() => addPartsInternal(id, parts));
  event(id, null, `Repuestos agregados: ${parts.map(([i, q]) => `${i} × ${q}`).join(', ')}`);
  return detail(id);
}

// Requisición de compra (OR) en JDE; evita duplicar una pendiente del mismo artículo
function requisition(itemNo, qty, reason, woId = null) {
  const p = get('SELECT * FROM parts WHERE item_no=?', itemNo);
  if (!p) throw new HttpError(400, 'Repuesto inexistente');
  const pend = get("SELECT * FROM requisitions WHERE item_no=? AND (jde_status IS NULL OR jde_status<'400') AND sync_state<>'ERROR'", itemNo);
  if (pend) return { duplicate: true, requisition: pend };
  const q = Math.max(Number(qty) || 0, p.reorder_qty || 1);
  const r = run('INSERT INTO requisitions (item_no,qty,reason,wo_id,created_at,sync_state) VALUES (?,?,?,?,?,?)', itemNo, q, reason, woId, nowIso(), 'PENDIENTE');
  const reqId = Number(r.lastInsertRowid);
  jde.enqueue('FLT_CreateRequisition', 'REQ', reqId, { ItemNumber: itemNo, Quantity: q, Supplier: p.supplier, BranchPlant: C.BRANCH, Reason: reason });
  return { requisition: get('SELECT * FROM requisitions WHERE id=?', reqId) };
}

function issuePart(id, lineId) {
  const wo = getOpen(id);
  const line = get('SELECT * FROM wo_parts WHERE id=? AND wo_id=?', lineId, id);
  if (!line) throw new HttpError(404, 'Línea de repuesto inexistente');
  const pending = line.qty - line.issued;
  if (pending <= 0) throw new HttpError(400, 'La línea ya fue entregada');
  const p = get('SELECT * FROM parts WHERE item_no=?', line.item_no);
  if (p.on_hand < pending) {
    const rq = requisition(line.item_no, pending - p.on_hand, `Faltante para OT ${wo.id}`, wo.id);
    event(id, null, `Sin stock de ${line.item_no} (disponible ${p.on_hand}). Requisición de compra ${rq.duplicate ? 'ya existente' : 'generada'} en JDE.`);
    throw new HttpError(409, `Stock insuficiente de ${line.item_no}: disponible ${p.on_hand}, requerido ${pending}. Se ${rq.duplicate ? 'encuentra pendiente' : 'generó'} una requisición de compra en JDE.`);
  }
  tx(() => {
    run('UPDATE wo_parts SET issued=qty WHERE id=?', lineId);
    run('UPDATE parts SET on_hand=on_hand-? WHERE item_no=?', pending, line.item_no);
    jde.enqueue('FLT_IssueParts', 'WO', id, { ItemNumber: line.item_no, Quantity: pending });
  });
  event(id, null, `Entrega de ${pending} × ${line.item_no} (${p.description})`);
  // Reposición automática del stock de seguridad
  const after = get('SELECT * FROM parts WHERE item_no=?', line.item_no);
  if (getSetting('auto_reorder', true) && after.on_hand < after.safety_stock) requisition(after.item_no, after.reorder_qty, 'Reposición de stock de seguridad');
  return detail(id);
}

function issueAll(id) {
  const lines = all('SELECT id FROM wo_parts WHERE wo_id=? AND issued<qty', id);
  const errors = [];
  for (const l of lines) { try { issuePart(id, l.id); } catch (e) { errors.push(e.message); } }
  return { ...detail(id), errors };
}

function addLabor(id, an8, hours) {
  getOpen(id);
  const t = get('SELECT * FROM technicians WHERE an8=?', Number(an8));
  if (!t) throw new HttpError(400, 'Técnico inexistente');
  const h = Number(hours);
  if (!(h > 0 && h <= 24)) throw new HttpError(400, 'Horas inválidas');
  run('INSERT INTO wo_labor (wo_id,tech_an8,tech,hours,rate,day) VALUES (?,?,?,?,?,?)', id, t.an8, t.name, h, t.rate, nowIso().slice(0, 10));
  jde.enqueue('FLT_AddLaborHours', 'WO', id, { AddressNumber: t.an8, Hours: h, Rate: t.rate, Date: nowIso().slice(0, 10) });
  event(id, null, `${h} h de mano de obra — ${t.name}`);
  return detail(id);
}

function update(id, fields) {
  const wo = getOpen(id);
  const allowed = ['diagnosis', 'root_cause', 'system', 'priority', 'road_call', 'immobilized', 'symptom'];
  for (const k of allowed) if (fields[k] !== undefined) run(`UPDATE work_orders SET ${k}=? WHERE id=?`, fields[k], id);
  if (fields.priority !== undefined || fields.immobilized !== undefined) recomputeUnitStatus(wo.unit_id);
  return detail(id);
}

function advance(id, { note, diagnosis } = {}) {
  const wo = getOpen(id);
  const idx = STAGE_KEYS.indexOf(wo.stage);
  const next = STAGE_KEYS[idx + 1];
  if (next === 'CERRADA') throw new HttpError(400, 'Use "Cerrar OT" para completar el control y cierre');
  if (next === 'REPUESTOS' && !(diagnosis || wo.diagnosis)) throw new HttpError(400, 'Registre el diagnóstico (causa y alcance) antes de avanzar');
  if (next === 'REPARACION') {
    const pend = get('SELECT COUNT(*) n FROM wo_parts WHERE wo_id=? AND issued<qty', id).n;
    if (pend) throw new HttpError(400, `Hay ${pend} línea(s) de repuestos sin entregar`);
  }
  tx(() => {
    if (diagnosis) run('UPDATE work_orders SET diagnosis=? WHERE id=?', diagnosis, id);
    run('UPDATE work_orders SET stage=?, started_at=COALESCE(started_at, ?) WHERE id=?', next, nowIso(), id);
    // Al pasar a diagnóstico la unidad ingresa al taller (también las OTs programadas)
    if (next === 'DIAGNOSTICO' && !wo.immobilized && wo.system !== 'Climatización') run('UPDATE work_orders SET immobilized=1 WHERE id=?', id);
    jde.enqueue('FLT_UpdateWorkOrderStatus', 'WO', id, { Status: STAGE_JDE[next] });
  });
  event(id, next, note || `Pasa a ${C.STAGES.find((s) => s.key === next).label.toLowerCase()}`);
  recomputeUnitStatus(wo.unit_id);
  return detail(id);
}

function close(id, { root_cause, note } = {}) {
  const wo = getOpen(id);
  if (wo.stage !== 'CONTROL') throw new HttpError(400, 'La OT debe estar en "Control y cierre" para cerrarse');
  if (wo.type === 'CORRECTIVO' && !(root_cause || wo.root_cause)) throw new HttpError(400, 'Registre la causa raíz: las fallas no planificadas alimentan el plan preventivo');
  const u = get('SELECT * FROM units WHERE id=?', wo.unit_id);
  const ts = nowIso();
  tx(() => {
    run("UPDATE work_orders SET stage='CERRADA', closed_at=?, root_cause=COALESCE(?,root_cause), km_at=? WHERE id=?", ts, root_cause || null, Math.round(u.odometer_km), id);
    jde.enqueue('FLT_CompleteWorkOrder', 'WO', id, { Meter: Math.round(u.odometer_km), RootCause: root_cause || wo.root_cause || null, Date: ts.slice(0, 10) });
    if (wo.plan_id) {
      // El preventivo de un nivel reinicia también los niveles inferiores (C incluye B y A)
      const plan = get('SELECT * FROM pm_plans WHERE id=?', wo.plan_id);
      for (const p of all('SELECT * FROM pm_plans WHERE rank<=?', plan.rank)) {
        run('INSERT INTO pm_schedule VALUES (?,?,?,?) ON CONFLICT(unit_id,plan_id) DO UPDATE SET last_km=excluded.last_km, last_date=excluded.last_date', u.id, p.id, Math.round(u.odometer_km), ts.slice(0, 10));
        if (p.id !== plan.id) jde.enqueue('FLT_UpdatePMSchedule', 'UNIT', u.id, { UnitNumber: u.unit_no, ServiceType: p.jde_service_type, LastMeter: Math.round(u.odometer_km), LastDate: ts.slice(0, 10) });
      }
    }
    if (wo.alert_id) run("UPDATE alerts SET status='RESUELTA' WHERE id=?", wo.alert_id);
    run("UPDATE alerts SET status='RESUELTA' WHERE wo_id=? AND status<>'RESUELTA'", id);
  });
  event(id, 'CERRADA', note || 'Unidad probada y liberada');
  hooks.onClose.forEach((fn) => fn(wo));
  recomputeUnitStatus(wo.unit_id);
  return detail(id);
}

function costs(woId) {
  const p = get('SELECT COALESCE(SUM(issued*unit_cost),0) c FROM wo_parts WHERE wo_id=?', woId).c;
  const l = get('SELECT COALESCE(SUM(hours*rate),0) c, COALESCE(SUM(hours),0) h FROM wo_labor WHERE wo_id=?', woId);
  return { parts: p, labor: l.c, hours: l.h, total: p + l.c };
}

function detail(id) {
  const wo = get(`SELECT w.*, u.unit_no, u.plate, u.brand, u.model, u.odometer_km, u.status unit_status, p.level plan_level, p.interval_km plan_interval
                  FROM work_orders w JOIN units u ON u.id=w.unit_id LEFT JOIN pm_plans p ON p.id=w.plan_id WHERE w.id=?`, id);
  if (!wo) throw new HttpError(404, 'OT inexistente');
  wo.parts = all('SELECT wp.*, p.description, p.on_hand, p.criticality FROM wo_parts wp LEFT JOIN parts p ON p.item_no=wp.item_no WHERE wo_id=?', id);
  wo.labor = all('SELECT * FROM wo_labor WHERE wo_id=? ORDER BY id', id);
  wo.events = all('SELECT * FROM wo_events WHERE wo_id=? ORDER BY ts, id', id);
  wo.outbox = all("SELECT id, orchestration, status, attempts, last_error, created_at, sent_at, payload, response FROM outbox WHERE entity='WO' AND entity_id=? ORDER BY id", id);
  wo.requisitions = all('SELECT * FROM requisitions WHERE wo_id=?', id);
  wo.costs = costs(id);
  if (wo.alert_id) wo.alert = get('SELECT * FROM alerts WHERE id=?', wo.alert_id);
  if (wo.plan_id) wo.plan_tasks = JSON.parse(get('SELECT tasks FROM pm_plans WHERE id=?', wo.plan_id).tasks);
  return wo;
}

function list({ stage, unit_id, type, open, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (stage) { where.push('w.stage=?'); args.push(stage); }
  if (unit_id) { where.push('w.unit_id=?'); args.push(Number(unit_id)); }
  if (type) { where.push('w.type=?'); args.push(type); }
  if (open === '1') where.push("w.stage<>'CERRADA'");
  const rows = all(`SELECT w.id, w.unit_id, w.type, w.origin, w.system, w.title, w.priority, w.stage, w.road_call, w.immobilized, w.created_at, w.started_at, w.closed_at,
      w.jde_doco, w.jde_status, w.jde_cost, w.sync_state, u.unit_no, u.plate,
      (SELECT COALESCE(SUM(issued*unit_cost),0) FROM wo_parts WHERE wo_id=w.id) + (SELECT COALESCE(SUM(hours*rate),0) FROM wo_labor WHERE wo_id=w.id) cost,
      (SELECT COUNT(*) FROM wo_parts WHERE wo_id=w.id AND issued<qty) parts_pending
    FROM work_orders w JOIN units u ON u.id=w.unit_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN w.stage='CERRADA' THEN 1 ELSE 0 END, w.created_at DESC LIMIT ?`, ...args, Number(limit));
  return rows;
}

module.exports = { create, addParts, issuePart, issueAll, addLabor, update, advance, close, detail, list, requisition, recomputeUnitStatus, hooks, HttpError };
