// Plan preventivo por niveles: vencimientos por km o tiempo con tolerancia ±10%.
const { all, get } = require('../db');
const wo = require('./workorders');

const TOL = 0.1;
const RANK_STATUS = { OK: 0, PROXIMO: 1, EN_TOLERANCIA: 2, VENCIDO: 3 };

function evaluate(unit, plan, sched, today = new Date()) {
  const lastKm = sched ? sched.last_km : 0;
  const dueKm = lastKm + plan.interval_km;
  const tolKm = plan.interval_km * TOL;
  const remainingKm = dueKm - unit.odometer_km;
  let status = remainingKm > tolKm ? 'OK' : remainingKm > 0 ? 'PROXIMO' : remainingKm >= -tolKm ? 'EN_TOLERANCIA' : 'VENCIDO';
  let dueDate = null, remainingDays = null;
  if (plan.interval_days && sched && sched.last_date) {
    const d = new Date(sched.last_date);
    d.setDate(d.getDate() + plan.interval_days);
    dueDate = d.toISOString().slice(0, 10);
    remainingDays = Math.round((d - today) / 86400000);
    const tolD = plan.interval_days * TOL;
    const sd = remainingDays > tolD ? 'OK' : remainingDays > 0 ? 'PROXIMO' : remainingDays >= -tolD ? 'EN_TOLERANCIA' : 'VENCIDO';
    if (RANK_STATUS[sd] > RANK_STATUS[status]) status = sd;
  }
  return {
    unit_id: unit.id, plan_id: plan.id, level: plan.level, last_km: lastKm, last_date: sched?.last_date, due_km: Math.round(dueKm),
    remaining_km: Math.round(remainingKm), progress: (unit.odometer_km - lastKm) / plan.interval_km, due_date: dueDate, remaining_days: remainingDays, status,
  };
}

function schedule() {
  const units = all('SELECT * FROM units ORDER BY unit_no');
  const plans = all('SELECT * FROM pm_plans ORDER BY rank');
  const scheds = all('SELECT * FROM pm_schedule');
  const openPm = all("SELECT id, unit_id, plan_id, stage FROM work_orders WHERE type='PREVENTIVO' AND stage<>'CERRADA'");
  const out = [];
  for (const u of units) {
    const rows = plans.map((p) => evaluate(u, p, scheds.find((s) => s.unit_id === u.id && s.plan_id === p.id)));
    // El nivel a ejecutar es el de mayor rango que esté por vencer (C incluye B y A)
    const due = [...rows].reverse().find((r) => r.status !== 'OK');
    const open = openPm.find((w) => w.unit_id === u.id);
    out.push({
      unit: { id: u.id, unit_no: u.unit_no, plate: u.plate, model: `${u.brand} ${u.model}`, odometer_km: Math.round(u.odometer_km), status: u.status, powertrain: u.powertrain },
      levels: rows, next: due ? due.level : null, nextStatus: due ? due.status : 'OK', openWo: open || null,
    });
  }
  return { plans: plans.map((p) => ({ ...p, tasks: JSON.parse(p.tasks), kit: JSON.parse(p.kit) })), units: out };
}

function generate(unitId, planId) {
  const u = get('SELECT * FROM units WHERE id=?', unitId);
  const p = get('SELECT * FROM pm_plans WHERE id=?', planId);
  if (!u || !p) throw new wo.HttpError(400, 'Unidad o plan inexistente');
  const open = get("SELECT id FROM work_orders WHERE unit_id=? AND type='PREVENTIVO' AND stage<>'CERRADA'", unitId);
  if (open) throw new wo.HttpError(409, `La unidad ya tiene el preventivo abierto en la OT ${open.id}`);
  const s = get('SELECT * FROM pm_schedule WHERE unit_id=? AND plan_id=?', unitId, planId);
  const kit = JSON.parse(p.kit).filter((k) => !(k.ice && u.powertrain === 'ELECTRICO')).map((k) => [k.item, k.qty]);
  return wo.create({
    unit_id: unitId, type: 'PREVENTIVO', origin: 'PLAN', system: 'Plan preventivo', title: p.name, symptom: 'Servicio programado por kilometraje/tiempo',
    priority: 3, plan_id: p.id, due_km: Math.round((s ? s.last_km : 0) + p.interval_km), parts: kit,
  });
}

function generateDue({ includeUpcoming = true } = {}) {
  const { units } = schedule();
  const created = [];
  for (const row of units) {
    if (!row.next || row.openWo) continue;
    if (!includeUpcoming && row.nextStatus === 'PROXIMO') continue;
    const plan = get('SELECT id FROM pm_plans WHERE level=?', row.next);
    created.push(generate(row.unit.id, plan.id));
  }
  return created.map((w) => ({ id: w.id, unit_no: w.unit_no, title: w.title }));
}

module.exports = { schedule, generate, generateDue, evaluate };
