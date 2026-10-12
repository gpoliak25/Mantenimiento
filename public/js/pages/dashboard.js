import { api, esc, num, pct, usd, ago, sev, stageBadge, prio, syncBadge, typeBadge, unitLink } from '../ui.js';
import { lineChart } from '../charts.js';

export function delta(cur, prev, { higherIsBetter = true, fmt = (v) => v, unit = '' } = {}) {
  if (cur == null || prev == null || !prev) return '<span class="muted">sin período previo</span>';
  const d = (cur - prev) / Math.abs(prev);
  if (Math.abs(d) < 0.005) return '<span class="muted">= vs. período anterior</span>';
  const good = higherIsBetter ? d > 0 : d < 0;
  return `<span class="delta ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${num(Math.abs(d) * 100, 1)}%</span> <span class="muted">vs. ${fmt(prev)}${unit}</span>`;
}

export default {
  title: 'Tablero',
  crumb: 'Resumen operativo de la flota · últimos 30 días',
  async render(view, _, ctx) {
    ctx.actions('<a class="btn" href="#/inspeccion">✓ Inspección diaria</a><a class="btn primary" href="#/ordenes?nueva=1">+ Nueva OT</a>');
    const draw = async () => {
      const d = await api('/dashboard');
      if (!ctx.alive()) return;
      const k = d.kpi.current, p = d.kpi.previous;
      const st = d.kpi.statusNow;
      const stagesOrder = ['ORDEN', 'DIAGNOSTICO', 'REPUESTOS', 'REPARACION', 'CONTROL'];
      const openTotal = stagesOrder.reduce((s, x) => s + (d.stages[x] || 0), 0);
      const integ = d.integration;
      const pend = (integ.outbox.PENDIENTE || 0) + (integ.outbox.REINTENTO || 0);
      view.innerHTML = `
      <div class="tiles">
        <div class="tile link" onclick="location.hash='#/flota'">
          <div class="k">Disponibilidad de flota <span>ahora</span></div>
          <div class="v">${pct(d.kpi.availableNow, 0)}</div>
          <div class="d">${st.DISPONIBLE || 0} de ${k.units} unidades listas · ${st.EN_TALLER || 0} en taller · ${st.FUERA_SERVICIO || 0} fuera de servicio</div>
        </div>
        <div class="tile link" onclick="location.hash='#/kpis'">
          <div class="k">Distancia media entre fallas</div>
          <div class="v">${num(k.mdbf)}<small>km</small></div>
          <div class="d">${delta(k.mdbf, p.mdbf, { fmt: (v) => num(v) })}</div>
        </div>
        <div class="tile link" onclick="location.hash='#/kpis'">
          <div class="k">Tiempo medio de reparación</div>
          <div class="v">${num(k.mttr, 1)}<small>h</small></div>
          <div class="d">${delta(k.mttr, p.mttr, { higherIsBetter: false, fmt: (v) => num(v, 1), unit: ' h' })}</div>
        </div>
        <div class="tile link" onclick="location.hash='#/preventivo'">
          <div class="k">Cumplimiento del preventivo</div>
          <div class="v">${pct(k.pmCompliance, 0)}</div>
          <div class="d">${k.pmOnTime} de ${k.pmDone} dentro de ±10% · ${(d.pmCounts.VENCIDO || 0)} vencidos hoy</div>
        </div>
        <div class="tile link" onclick="location.hash='#/kpis'">
          <div class="k">Costo por kilómetro</div>
          <div class="v">${usd(k.costPerKm, 3)}</div>
          <div class="d">${delta(k.costPerKm, p.costPerKm, { higherIsBetter: false, fmt: (v) => num(v, 3) })}</div>
        </div>
      </div>

      <div class="grid g-2-1 mt">
        <div class="card">
          <header><h2>Disponibilidad diaria</h2><span class="sub">horas de unidad disponibles ÷ horas totales · meta 95%</span></header>
          <div id="chAvail"></div>
        </div>
        <div class="card">
          <header><h2>Taller ahora</h2><a href="#/ordenes" class="small">Ver tablero de OTs →</a></header>
          <div class="hbars">
            ${stagesOrder.map((s) => `<div class="hbar" style="grid-template-columns: 130px minmax(0,1fr) 40px"><span class="lab">${stageBadge(s)}</span><span class="track"><span class="fill" style="display:block;width:${openTotal ? ((d.stages[s] || 0) / openTotal) * 100 : 0}%"></span></span><span class="val">${d.stages[s] || 0}</span></div>`).join('')}
          </div>
          <div class="note mt">
            <b>${openTotal}</b> OTs abiertas · <b>${d.lowStock}</b> repuestos bajo stock de seguridad (${d.lowStockA} críticos) ·
            Preventivo: <b>${d.pmCounts.VENCIDO || 0}</b> vencidos, <b>${d.pmCounts.EN_TOLERANCIA || 0}</b> en tolerancia, <b>${d.pmCounts.PROXIMO || 0}</b> próximos
          </div>
        </div>
      </div>

      <div class="grid g2 mt">
        <div class="card">
          <header><h2>Alertas activas de sensores</h2><a href="#/telemetria" class="small">Telemetría →</a></header>
          ${d.alerts.length ? `<div class="tw"><table class="t"><tbody>
            ${d.alerts.map((a) => `<tr><td>${sev(a.severity)}</td><td>${unitLink(a.unit_id, a.unit_no)}</td><td class="small">${esc(a.message)}</td>
              <td class="small muted">${ago(a.ts)}</td><td>${a.wo_id ? `<a href="#/ordenes/${a.wo_id}">OT ${a.wo_id}</a>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Sin alertas activas</div>'}
        </div>
        <div class="card">
          <header><h2>Órdenes de trabajo abiertas</h2><span class="sub">sincronizadas con JDE (F4801)</span></header>
          <div class="tw"><table class="t"><tbody>
            ${d.openWo.map((w) => `<tr class="click" onclick="location.hash='#/ordenes/${w.id}'"><td><b>OT ${w.id}</b></td><td>Int. ${esc(w.unit_no)}</td>
              <td class="small">${esc(w.title)}<div>${typeBadge(w.type)} ${w.priority === 1 ? prio(1) : ''}</div></td><td>${stageBadge(w.stage)}</td><td>${syncBadge(w.sync_state, w.jde_doco)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
      </div>

      <div class="grid g-2-1 mt">
        <div class="card">
          <header><h2>Estado de las unidades</h2><span class="sub">${k.units} colectivos</span></header>
          <div class="row">${d.units.map((u) => `<a href="#/flota/${u.id}" class="b ${u.status === 'DISPONIBLE' ? 'good' : u.status === 'EN_TALLER' ? 'warn' : 'crit'}" data-tip="<b>Interno ${esc(u.unit_no)}</b><div>${esc(u.depot)} · línea ${esc(u.line)}</div>" style="text-decoration:none">${u.status === 'DISPONIBLE' ? '●' : u.status === 'EN_TALLER' ? '◐' : '■'} ${esc(u.unit_no)}</a>`).join('')}</div>
          <div class="legend"><span>● Disponible</span><span>◐ En taller</span><span>■ Fuera de servicio</span></div>
        </div>
        <div class="card">
          <header><h2>Integración JDE E1 9.2</h2><a href="#/integracion" class="small">Detalle →</a></header>
          <div class="row" style="margin-bottom:8px">${integ.health.ok ? '<span class="b good"><span class="sev-ico">●</span>AIS en línea</span>' : '<span class="b crit"><span class="sev-ico">▲</span>AIS sin conexión</span>'}
            <span class="b plain">${esc(integ.config.environment)}</span></div>
          <div class="small ink2">Cola saliente: <b>${pend}</b> pendientes · <b>${integ.outbox.ERROR || 0}</b> con error · <b>${num(integ.outbox.OK || 0)}</b> enviados</div>
          <div class="small ink2">Última sincronización: ${integ.lastSync ? ago(integ.lastSync.at) : '—'} · Llamadas 24 h: ${num(integ.calls24h.n || 0)} (${num(integ.calls24h.avg || 0)} ms prom.)</div>
        </div>
      </div>`;
      lineChart(view.querySelector('#chAvail'), {
        labels: d.kpi.daily.map((x) => x.day.slice(5).split('-').reverse().join('/')),
        series: [{ name: 'Disponibilidad', color: 'var(--s1)', values: d.kpi.daily.map((x) => x.availability * 100) }],
        yFmt: (v) => `${num(v, 0)}%`, yMax: 100, refs: [{ y: 95, label: 'Meta 95%' }], height: 210, area: true,
      });
    };
    await draw();
    ctx.every(10000, draw);
  },
};
