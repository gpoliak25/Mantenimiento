import { api, esc, num, pct, usd, hrs, TYPE_LABEL } from '../ui.js';
import { lineChart, columnChart, hbars } from '../charts.js';
import { delta } from './dashboard.js';

export default {
  title: 'Indicadores clave',
  crumb: 'Sin línea de base no se puede comprobar la mejora: disponibilidad, MDBF, MTTR, cumplimiento y costo por km',
  async render(view, _, ctx) {
    let days = 90;
    const top = ctx.actions('<div class="seg" id="per"><button data-d="30">30 días</button><button data-d="90" class="on">90 días</button><button data-d="180">180 días</button></div>');
    top.querySelector('#per').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; days = Number(b.dataset.d); top.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
    const draw = async () => {
      const k = await api('/kpis?days=' + days);
      if (!ctx.alive()) return;
      const c = k.current, p = k.previous;
      const rows = [
        ['Disponibilidad de flota', 'Unidades listas para operar', 'Horas disponibles ÷ horas totales × 100 (hoy: unidades disponibles ÷ flota)', `${pct(c.availability)} <span class="muted small">· hoy ${pct(k.availableNow, 0)}</span>`, delta(c.availability, p.availability, { fmt: (v) => pct(v) })],
        ['Distancia media entre fallas (MDBF)', 'Confiabilidad en servicio', 'Km en servicio ÷ cantidad de fallas mayores (en ruta)', `${num(c.mdbf)} km <span class="muted small">· ${num(c.km)} km / ${c.failures} fallas</span>`, delta(c.mdbf, p.mdbf, { fmt: (v) => num(v) })],
        ['Tiempo medio de reparación (MTTR)', 'Rapidez para volver a servicio', 'Horas de reparación ÷ cantidad de reparaciones', `${hrs(c.mttr)} <span class="muted small">· ${c.repairs} correctivos</span>`, delta(c.mttr, p.mttr, { higherIsBetter: false, fmt: (v) => num(v, 1), unit: ' h' })],
        ['Cumplimiento del preventivo', 'Preventivos hechos a tiempo', 'Preventivos dentro de ±10% ÷ programados × 100', `${pct(c.pmCompliance)} <span class="muted small">· ${c.pmOnTime}/${c.pmDone}</span>`, delta(c.pmCompliance, p.pmCompliance, { fmt: (v) => pct(v) })],
        ['Mantenimiento planificado', 'Peso del trabajo programado', 'Horas planificadas ÷ horas totales × 100', `${pct(c.plannedPct)} <span class="muted small">· ${num(c.laborHours)} h</span>`, delta(c.plannedPct, p.plannedPct, { fmt: (v) => pct(v) })],
        ['Costo por kilómetro', 'Eficiencia económica', 'Costo de mantenimiento ÷ km recorridos', `${usd(c.costPerKm, 3)} <span class="muted small">· ${usd(c.cost)}</span>`, delta(c.costPerKm, p.costPerKm, { higherIsBetter: false, fmt: (v) => num(v, 3) })],
        ['Disponibilidad esperada', 'Confiabilidad y rapidez combinadas', 'MTBF ÷ (MTBF + MTTR) × 100', `${pct(c.expectedAvailability)} <span class="muted small">· MTBF ${num(c.mtbf)} h</span>`, delta(c.expectedAvailability, p.expectedAvailability, { fmt: (v) => pct(v) })],
      ];
      const typeColors = { PREVENTIVO: 'var(--s1)', CORRECTIVO: 'var(--s2)', PREDICTIVO: 'var(--s3)', DETECTIVO: 'var(--s4)', CONDICION: 'var(--s5)', PROACTIVO: 'var(--s7)', AUTONOMO: 'var(--s6)' };
      view.innerHTML = `
        <div class="card">
          <header><h2>Tablero de indicadores · últimos ${days} días</h2><span class="sub">comparado con los ${days} días anteriores</span></header>
          <div class="tw"><table class="t"><thead><tr><th>Indicador</th><th>Qué mide</th><th>Cómo se calcula</th><th>Valor</th><th>Variación</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td><b>${r[0]}</b></td><td class="small ink2">${r[1]}</td><td class="small ink2">${r[2]}</td><td class="num" style="text-align:left">${r[3]}</td><td class="small">${r[4]}</td></tr>`).join('')}</tbody></table></div>
        </div>
        <div class="grid g2 mt">
          <div class="card"><header><h2>MDBF mensual</h2><span class="sub">km entre fallas en ruta · barra atenuada = mes en curso</span></header><div id="c1"></div></div>
          <div class="card"><header><h2>Meta de distancia entre fallas</h2><span class="sub">referencias de agencias (cada una define «falla» a su manera)</span></header>
            ${hbars([...k.benchmarks.map((b) => ({ label: b.name, value: b.km, color: 'var(--axis)', cls: 'ref' })), { label: `Esta flota (${days} d)`, value: c.mdbf || 0, cls: 'me', color: 'var(--s1)' }].sort((a, b) => a.value - b.value), { fmt: (v) => `${num(v)} km` })}
            <div class="small muted mt">Conviene fijar una definición de falla y comparar contra la propia tendencia.</div></div>
          <div class="card"><header><h2>Costo por kilómetro mensual</h2><span class="sub">repuestos + mano de obra de OTs cerradas · meses completos</span></header><div id="c2"></div></div>
          <div class="card"><header><h2>Disponibilidad diaria</h2></header><div id="c3"></div></div>
          <div class="card"><header><h2>Correctivos por sistema</h2><span class="sub">${days} días</span></header>
            ${hbars(k.bySystem.map((s) => ({ label: s.system, value: s.n, tip: `<b>${esc(s.system)}</b><div>${s.n} correctivos · ${s.road} en ruta</div>` })), { fmt: (v) => num(v) })}</div>
          <div class="card"><header><h2>Costo por tipo de mantenimiento</h2><span class="sub">${days} días</span></header>
            ${hbars(k.byType.map((t) => ({ label: TYPE_LABEL[t.type], value: t.cost, color: typeColors[t.type], tip: `<b>${TYPE_LABEL[t.type]}</b><div>${t.n} OTs · ${usd(t.cost)}</div>` })), { fmt: (v) => usd(v) })}</div>
        </div>`;
      columnChart(view.querySelector('#c1'), { items: k.monthly.map((m) => ({ label: m.month, value: m.mdbf ? Math.round(m.mdbf) : null, faded: m.partial, tip: `<b>${m.month}${m.partial ? ' (en curso)' : ''}</b><div>${m.mdbf ? num(m.mdbf) + ' km' : 'sin fallas'} · ${m.failures} fallas</div>` })), yFmt: (v) => num(v), height: 210 });
      lineChart(view.querySelector('#c2'), { labels: k.monthly.map((m) => m.month), series: [{ name: 'Costo por km', color: 'var(--s2)', values: k.monthly.map((m) => (m.partial ? null : m.costPerKm)) }], yFmt: (v) => `US$ ${num(v, 2)}`, height: 210, yMin: 0 });
      lineChart(view.querySelector('#c3'), { labels: k.daily.map((x) => x.day.slice(5).split('-').reverse().join('/')), series: [{ name: 'Disponibilidad', color: 'var(--s1)', values: k.daily.map((x) => x.availability * 100) }], yFmt: (v) => `${num(v, 0)}%`, yMax: 100, refs: [{ y: 95, label: 'Meta 95%' }], height: 210, area: true });
    };
    await draw();
  },
};
