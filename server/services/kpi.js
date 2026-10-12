// Indicadores clave (diapositiva 15), calculados sobre el historial de OTs y km.
const { all, get } = require('../db');
const C = require('../catalog');

const DAY = 86400000;
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const localDay = (t) => new Date(t).toLocaleDateString('sv');

function period(startMs, endMs) {
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const N = get('SELECT COUNT(*) n FROM units').n;
  const km = get('SELECT COALESCE(SUM(km),0) k FROM km_log WHERE day>=? AND day<=?', localDay(startMs), localDay(endMs)).k;
  const failures = get('SELECT COUNT(*) n FROM work_orders WHERE road_call=1 AND created_at>=? AND created_at<?', startIso, endIso).n;
  const corr = all("SELECT created_at, closed_at FROM work_orders WHERE type='CORRECTIVO' AND closed_at>=? AND closed_at<?", startIso, endIso);
  const mttr = corr.length ? corr.reduce((s, w) => s + hoursBetween(w.created_at, w.closed_at), 0) / corr.length : null;

  // Disponibilidad: 1 − horas de inmovilización ÷ (unidades × horas del período)
  const down = all('SELECT created_at, closed_at FROM work_orders WHERE immobilized=1 AND created_at<? AND (closed_at IS NULL OR closed_at>?)', endIso, startIso);
  let downH = 0;
  for (const w of down) {
    const a = Math.max(new Date(w.created_at).getTime(), startMs);
    const b = Math.min(w.closed_at ? new Date(w.closed_at).getTime() : endMs, endMs);
    if (b > a) downH += (b - a) / 3600000;
  }
  const availability = 1 - downH / (N * ((endMs - startMs) / 3600000));

  // Cumplimiento del preventivo: ejecutados dentro de ±10% del intervalo
  const pmDone = all(`SELECT w.km_at, w.due_km, p.interval_km FROM work_orders w JOIN pm_plans p ON p.id=w.plan_id
                      WHERE w.type='PREVENTIVO' AND w.closed_at>=? AND w.closed_at<? AND w.due_km IS NOT NULL`, startIso, endIso);
  const onTime = pmDone.filter((w) => Math.abs(w.km_at - w.due_km) <= 0.1 * w.interval_km).length;
  const pmCompliance = pmDone.length ? onTime / pmDone.length : null;

  // Mantenimiento planificado: horas de trabajo programado ÷ horas totales
  const lab = all('SELECT w.type, SUM(l.hours) h FROM wo_labor l JOIN work_orders w ON w.id=l.wo_id WHERE l.day>=? AND l.day<=? GROUP BY w.type', localDay(startMs), localDay(endMs));
  const totalH = lab.reduce((s, r) => s + r.h, 0);
  const plannedH = lab.filter((r) => C.WO_TYPES[r.type]?.planned).reduce((s, r) => s + r.h, 0);

  // Costo de mantenimiento (repuestos entregados + mano de obra) de OTs cerradas
  const cost = get(`SELECT COALESCE(SUM((SELECT COALESCE(SUM(issued*unit_cost),0) FROM wo_parts WHERE wo_id=w.id) + (SELECT COALESCE(SUM(hours*rate),0) FROM wo_labor WHERE wo_id=w.id)),0) c
                    FROM work_orders w WHERE w.closed_at>=? AND w.closed_at<?`, startIso, endIso).c;

  const opHours = km / C.AVG_SPEED_KMH;
  const mtbf = failures ? opHours / failures : null;
  const expected = mtbf && mttr ? mtbf / (mtbf + mttr) : null;
  return {
    units: N, km, failures, mdbf: failures ? km / failures : null, mttr, repairs: corr.length, availability, pmCompliance, pmDone: pmDone.length, pmOnTime: onTime,
    plannedPct: totalH ? plannedH / totalH : null, laborHours: totalH, cost, costPerKm: km ? cost / km : null, mtbf, expectedAvailability: expected,
  };
}

function compute(days = 90) {
  const end = Date.now();
  const start = end - days * DAY;
  const cur = period(start, end);
  const prev = period(start - days * DAY, start);
  const N = cur.units;
  const statusNow = Object.fromEntries(all('SELECT status, COUNT(*) n FROM units GROUP BY status').map((r) => [r.status, r.n]));
  const availableNow = (statusNow.DISPONIBLE || 0) / N;

  // Serie diaria de disponibilidad
  const daily = [];
  const down = all('SELECT created_at, closed_at FROM work_orders WHERE immobilized=1 AND created_at<? AND (closed_at IS NULL OR closed_at>?)', new Date(end).toISOString(), new Date(start).toISOString());
  const d0 = new Date(start); d0.setHours(0, 0, 0, 0);
  for (let t = d0.getTime() + DAY; t <= end; t += DAY) {
    const tEnd = Math.min(t + DAY, end);
    let h = 0;
    for (const w of down) {
      const a = Math.max(new Date(w.created_at).getTime(), t);
      const b = Math.min(w.closed_at ? new Date(w.closed_at).getTime() : end, tEnd);
      if (b > a) h += (b - a) / 3600000;
    }
    daily.push({ day: localDay(t), availability: 1 - h / (N * ((tEnd - t) / 3600000)) });
  }

  // Tendencia mensual (6 meses)
  const monthly = [];
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  for (let i = 5; i >= 0; i--) {
    const a = new Date(m0); a.setMonth(a.getMonth() - i);
    const b = new Date(a); b.setMonth(b.getMonth() + 1);
    const p = period(a.getTime(), Math.min(b.getTime(), end));
    monthly.push({ month: a.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' }), partial: b.getTime() > end, mdbf: p.mdbf, costPerKm: p.costPerKm, mttr: p.mttr, availability: p.availability, failures: p.failures, km: p.km });
  }

  const sinceIso = new Date(start).toISOString();
  const bySystem = all(`SELECT system, COUNT(*) n, SUM(road_call) road FROM work_orders WHERE type='CORRECTIVO' AND created_at>=? GROUP BY system ORDER BY n DESC`, sinceIso);
  const byType = all(`SELECT type, COUNT(*) n,
      SUM((SELECT COALESCE(SUM(issued*unit_cost),0) FROM wo_parts WHERE wo_id=w.id) + (SELECT COALESCE(SUM(hours*rate),0) FROM wo_labor WHERE wo_id=w.id)) cost
      FROM work_orders w WHERE created_at>=? GROUP BY type ORDER BY n DESC`, sinceIso);
  const byOrigin = all('SELECT origin, COUNT(*) n FROM work_orders WHERE created_at>=? GROUP BY origin ORDER BY n DESC', sinceIso);

  return { days, current: cur, previous: prev, availableNow, statusNow, daily, monthly, bySystem, byType, byOrigin, benchmarks: C.MDBF_BENCHMARKS };
}

module.exports = { compute, period };
