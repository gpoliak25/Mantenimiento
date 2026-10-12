import { api, esc, num, km, usd, date, ago, act, toast, modal, unitStatus, pmStatus, sev, stageBadge, typeBadge, syncBadge, META, TYPE_LABEL } from '../ui.js';
import { lineChart, columnChart, hbars } from '../charts.js';
import { newWoModal } from './orders.js';

export function telemetryCharts(el, series) {
  el.innerHTML = `<div class="grid g3">${series.map((m, i) => `
    <div><div class="spread small"><span class="ink2">${esc(m.label)}</span>
      <span class="${m.level === 'crit' ? 'delta bad' : ''}"><b class="num">${num(m.v, m.unit === 'g' ? 2 : 1)} ${esc(m.unit)}</b> ${m.level === 'crit' ? '▲' : m.level === 'warn' ? '◆' : ''}</span></div>
      <div id="tm${i}"></div>
      <div class="small muted">${m.eta !== null && m.eta <= 180 ? `<span class="b info">◭ umbral en ~${m.eta} min</span>` : `límite ${m.dir === 'up' ? '≥' : '≤'} ${m.warn} ${esc(m.unit)}`}${m.fault ? ' · <span class="b warn">falla simulada</span>' : ''}</div>
    </div>`).join('')}</div>`;
  series.forEach((m, i) => {
    lineChart(el.querySelector('#tm' + i), {
      labels: m.values.map((_, k) => `t−${m.values.length - 1 - k} min`),
      series: [{ name: m.label, color: m.level === 'crit' ? 'var(--critical)' : m.level === 'warn' ? 'var(--s4)' : 'var(--s1)', values: m.values }],
      yFmt: (v) => num(v, m.unit === 'g' ? 2 : m.unit === 'mm' || m.unit === 'bar' || m.unit === 'V' ? 1 : 0), height: 120, refs: [{ y: m.warn, label: 'advertencia' }], legend: false,
    });
  });
}

export default {
  title: 'Unidad',
  async render(view, { id }, ctx) {
    const d = await api('/units/' + id);
    const u = d.unit;
    ctx.setTitle(`Interno ${u.unit_no}`, `<a href="#/flota">Flota</a> · ${esc(u.brand)} ${esc(u.model)} · ${esc(u.plate)}`);
    const top = ctx.actions(`<button id="bInj">⚡ Simular falla</button><button class="primary" id="bWo">+ Nueva OT</button>`);
    top.querySelector('#bWo').onclick = () => newWoModal({ unit_id: u.id }, ctx);
    top.querySelector('#bInj').onclick = () => injectModal(u, d.telemetry);
    const cost180 = d.costs.reduce((s, c) => s + (c.cost || 0), 0);
    const pmRow = d.pm;
    const costColors = { PREVENTIVO: 'var(--s1)', CORRECTIVO: 'var(--s2)', PREDICTIVO: 'var(--s3)', DETECTIVO: 'var(--s4)', PROACTIVO: 'var(--s7)', CONDICION: 'var(--s5)', AUTONOMO: 'var(--s6)' };
    view.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="k">Estado</div><div class="v" style="font-size:18px;margin:8px 0">${unitStatus(u.status)}</div><div class="d">JDE: <span class="mono">${esc(u.jde_status || '—')}</span> · ${ago(u.last_sync)}</div></div>
        <div class="tile"><div class="k">Odómetro</div><div class="v">${num(u.odometer_km)}<small>km</small></div><div class="d">Enviado a JDE: ${num(u.meter_sent_km)} km</div></div>
        <div class="tile"><div class="k">Distancia entre fallas · 180 d</div><div class="v">${d.mdbf ? num(d.mdbf) : '—'}<small>${d.mdbf ? 'km' : 'sin fallas'}</small></div><div class="d">${d.road180} fallas en ruta · ${num(d.km180)} km</div></div>
        <div class="tile"><div class="k">Costo de mantenimiento · 180 d</div><div class="v">${usd(cost180)}</div><div class="d">${d.km180 ? usd(cost180 / d.km180, 3) + ' por km' : ''}</div></div>
      </div>

      <div class="grid g-1-2 mt">
        <div class="card">
          <header><h2>Ficha de la unidad</h2><span class="sub">F1201 · Asset ${u.jde_asset}</span></header>
          <table class="t"><tbody>
            <tr><td class="muted">Número de unidad (ASII)</td><td><b>${esc(u.unit_no)}</b></td></tr>
            <tr><td class="muted">Dominio</td><td class="mono">${esc(u.plate)}</td></tr>
            <tr><td class="muted">Marca y modelo</td><td>${esc(u.brand)} ${esc(u.model)} (${u.year})</td></tr>
            <tr><td class="muted">Tracción</td><td>${u.powertrain === 'ELECTRICO' ? 'Eléctrica (batería de tracción)' : 'Diésel'}</td></tr>
            <tr><td class="muted">Cochera · línea</td><td>${esc(u.depot)} · ${esc(u.line)}</td></tr>
            <tr><td class="muted">Alta</td><td>${date(u.in_service_date)}</td></tr>
          </tbody></table>
          <h3 class="mt">Costo por tipo de mantenimiento · 180 días</h3>
          <div class="mt">${hbars(d.costs.sort((a, b) => b.cost - a.cost).map((c) => ({ label: TYPE_LABEL[c.type], value: c.cost, color: costColors[c.type], tip: `<b>${TYPE_LABEL[c.type]}</b><div>${c.n} OTs · ${usd(c.cost)}</div>` })), { fmt: (v) => usd(v) })}</div>
        </div>
        <div class="card">
          <header><h2>Plan preventivo por niveles</h2><span class="sub">tolerancia ±10% del intervalo</span></header>
          ${pmRow.openWo ? `<div class="note" style="margin-bottom:10px">Preventivo en curso: <a href="#/ordenes/${pmRow.openWo.id}">OT ${pmRow.openWo.id}</a></div>` : ''}
          <table class="t"><thead><tr><th>Nivel</th><th>Último</th><th>Avance</th><th class="num">Vence</th><th class="num">Restan</th><th>Estado</th><th></th></tr></thead><tbody>
          ${pmRow.levels.map((l) => {
            const plan = META.plans.find((p) => p.id === l.plan_id);
            const cls = l.status === 'VENCIDO' ? 'crit' : l.status === 'EN_TOLERANCIA' ? 'warn' : l.status === 'PROXIMO' ? '' : 'good';
            return `<tr><td><b>${esc(l.level)}</b></td><td class="small">${num(l.last_km)} km<div class="muted">${date(l.last_date)}</div></td>
              <td style="min-width:120px"><div class="bar ${cls}"><span style="width:${Math.min(100, l.progress * 100 / 1.1)}%"></span><i class="tick" style="left:${100 / 1.1}%"></i></div></td>
              <td class="num">${num(l.due_km)} km${l.due_date ? `<div class="small muted">${date(l.due_date)}</div>` : ''}</td>
              <td class="num">${num(l.remaining_km)} km</td><td>${pmStatus(l.status)}</td>
              <td>${pmRow.openWo ? '' : `<button class="small" data-gen="${plan.id}">Generar OT</button>`}</td></tr>`;
          }).join('')}</tbody></table>
          <h3 class="mt">Kilómetros por día · últimos 30 días</h3>
          <div id="chKm"></div>
        </div>
      </div>

      <div class="card mt">
        <header><h2>Telemetría en vivo</h2><span class="sub">1 lectura = 1 min de operación · ${u.status === 'DISPONIBLE' ? 'en servicio' : 'unidad detenida (sin lecturas nuevas)'}</span></header>
        <div id="tel"></div>
      </div>

      <div class="grid g-2-1 mt">
        <div class="card">
          <header><h2>Historial de órdenes de trabajo</h2><span class="sub">${d.workOrders.length} OTs</span></header>
          <div class="tw" style="max-height:420px;overflow:auto"><table class="t"><thead><tr><th>OT</th><th>Fecha</th><th>Tipo</th><th>Título</th><th>Etapa</th><th class="num">Costo</th><th>JDE</th></tr></thead><tbody>
          ${d.workOrders.map((w) => `<tr class="click" onclick="location.hash='#/ordenes/${w.id}'"><td><b>${w.id}</b></td><td class="small">${date(w.created_at)}</td><td>${typeBadge(w.type)}${w.road_call ? ' <span class="b crit">En ruta</span>' : ''}</td>
            <td class="small">${esc(w.title)}</td><td>${stageBadge(w.stage)}</td><td class="num">${usd(w.cost)}</td><td>${syncBadge(w.sync_state, w.jde_doco)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <header><h2>Alertas recientes</h2></header>
          ${d.alerts.length ? `<ul class="tl">${d.alerts.map((a) => `<li>${sev(a.severity)} <span class="ts">${ago(a.ts)} · ${esc(a.status.toLowerCase().replace('_', ' '))}</span><div class="small">${esc(a.message)}</div>${a.wo_id ? `<a class="small" href="#/ordenes/${a.wo_id}">OT ${a.wo_id}</a>` : ''}</li>`).join('')}</ul>` : '<div class="empty">Sin alertas</div>'}
          <h3 class="mt">Inspecciones diarias</h3>
          ${d.inspections.length ? `<ul class="tl mt">${d.inspections.map((i) => `<li><b>${esc(i.driver)}</b> <span class="ts">${ago(i.ts)}</span><div class="small">${i.defects ? `<span class="b crit">${i.defects} defecto(s)</span>` : '<span class="b good">Sin novedades</span>'}</div></li>`).join('')}</ul>` : '<div class="empty">Sin inspecciones</div>'}
        </div>
      </div>`;
    view.querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', async () => {
      const w = await act(b, () => api('/pm/generate', { body: { unit_id: u.id, plan_id: Number(b.dataset.gen) } }), (r) => `OT ${r.id} generada con el kit del nivel y enviada a JDE`);
      if (w) location.hash = '#/ordenes/' + w.id;
    }));
    columnChart(view.querySelector('#chKm'), {
      items: d.km.map((k) => ({ label: k.day.slice(8), value: Math.round(k.km), tip: `<b>${date(k.day + 'T12:00')}</b><div>${km(Math.round(k.km))}</div>` })), yFmt: (v) => num(v), height: 150,
    });
    const tel = view.querySelector('#tel');
    telemetryCharts(tel, d.telemetry);
    ctx.every(5000, async () => {
      const s = await api('/telemetry/' + u.id);
      if (ctx.alive() && s) telemetryCharts(tel, s);
    });

    function injectModal(unit, series) {
        modal(`<h2>Simular degradación en el interno ${esc(unit.unit_no)}</h2>
          <p class="small ink2">Inicia una deriva progresiva en la variable elegida. El modelo detectará la tendencia antes de que se alcance el umbral, generará la alerta predictiva y la OT (que se crea en JDE).</p>
          <label class="f">Variable<select id="m">${series.map((m) => `<option value="${m.key}">${esc(m.label)} — ${esc(META.scenarios[m.key])}</option>`).join('')}</select></label>
          <footer><button data-close>Cancelar</button><button class="primary" id="go">Iniciar</button></footer>`, (el, close) => {
          el.querySelector('#go').onclick = async (e) => {
            const r = await act(e.target, () => api('/telemetry/inject', { body: { unit_id: unit.id, metric: el.querySelector('#m').value } }));
            if (r) { toast(`Falla simulada: ${r.scenario}`, 'ok'); close(); }
          };
        });
    }
  },
};
