import { api, esc, num, ago, act, toast, modal, sev, unitStatus, META } from '../ui.js';
import { sparkline } from '../charts.js';

export default {
  title: 'Telemetría IoT',
  crumb: 'Sensar → conectar → almacenar → analizar → actuar · ECU por bus CAN (SAE J1939) · simulación: 1 lectura = 1 min de operación',
  async render(view, _, ctx) {
    let onlyAnom = false;
    let settings = META.settings;
    const top = ctx.actions(`<label class="row small" style="gap:6px"><input type="checkbox" id="auto" ${settings.auto_wo ? 'checked' : ''}> OT automática para alertas predictivas y de advertencia</label><span class="b crit" data-tip="<b>Regla fija</b><div>Toda alerta crítica genera una OT correctiva P1, retira la unidad de servicio y la registra en JDE (F4801, EQST DN).</div>"><span class="sev-ico">▲</span>Críticas: OT P1 siempre automática</span>`);
    top.querySelector('#auto').onchange = async (e) => {
      settings = await api('/settings', { method: 'PUT', body: { auto_wo: e.target.checked } });
      META.settings = settings;
      toast(settings.auto_wo ? 'Las alertas predictivas y de advertencia generarán la OT y su alta en JDE automáticamente' : 'Las alertas predictivas y de advertencia quedarán abiertas para revisión manual. Las críticas siguen generando OT automáticamente.');
    };

    view.innerHTML = `
      <div class="flow">
        <div><b>1 · Sensar</b>Sensores y ECU miden temperaturas, presiones, vibración y desgaste.</div>
        <div><b>2 · Conectar</b>Gateway a bordo: red celular en ruta o Wi-Fi en la cochera.</div>
        <div><b>3 · Almacenar</b>Series de tiempo por unidad en la plataforma IoT.</div>
        <div><b>4 · Analizar</b>Umbrales + tendencia lineal: detecta la anomalía antes de la falla.</div>
        <div><b>5 · Actuar</b>Alerta → OT → OT en JDE (F4801). Las críticas generan siempre una OT P1 y retiran la unidad.</div>
      </div>
      <div id="tiles" class="tiles mt"></div>
      <div class="grid g-2-1 mt" style="align-items:start">
        <div>
          <div class="spread" style="margin-bottom:10px"><h2>Unidades</h2>
            <label class="row small"><input type="checkbox" id="anom"> Sólo con anomalías o tendencia</label></div>
          <div id="grid" class="tgrid"></div>
        </div>
        <div class="card"><header><h2>Alertas</h2><span class="sub">más recientes</span></header><div id="alerts"></div></div>
      </div>`;
    view.querySelector('#anom').onchange = (e) => { onlyAnom = e.target.checked; draw(); };

    const draw = async () => {
      const [t, alerts] = await Promise.all([api('/telemetry'), api('/alerts?limit=40')]);
      if (!ctx.alive()) return;
      const mdef = Object.fromEntries(t.metrics.map((m) => [m.key, m]));
      const running = t.units.filter((u) => u.running).length;
      const open = alerts.filter((a) => ['ABIERTA', 'OT_GENERADA'].includes(a.status));
      const bySev = open.reduce((a, x) => { a[x.severity] = (a[x.severity] || 0) + 1; return a; }, {});
      view.querySelector('#tiles').innerHTML = `
        <div class="tile"><div class="k">Unidades transmitiendo</div><div class="v">${running}<small>de ${t.units.length}</small></div><div class="d">las unidades en taller no envían lecturas</div></div>
        <div class="tile"><div class="k">Alertas predictivas activas ${sev('PREDICTIVA')}</div><div class="v">${bySev.PREDICTIVA || 0}</div><div class="d">tendencia hacia el umbral</div></div>
        <div class="tile"><div class="k">Fuera de rango ${sev('ADVERTENCIA')}</div><div class="v">${bySev.ADVERTENCIA || 0}</div><div class="d">superaron el límite de advertencia</div></div>
        <div class="tile"><div class="k">Críticas ${sev('CRITICA')}</div><div class="v">${bySev.CRITICA || 0}</div><div class="d">OT P1 automática · unidad fuera de servicio</div></div>`;
      const units = t.units.filter((u) => !onlyAnom || u.faults.length || Object.values(u.metrics).some((m) => m.level !== 'ok' || m.eta !== null));
      view.querySelector('#grid').innerHTML = units.map((u) => `
        <div class="tcard ${u.running ? '' : 'off'}">
          <div class="hd"><a href="#/flota/${u.id}"><b>Int. ${esc(u.unit_no)}</b></a>
            <div class="row" style="gap:4px">${u.powertrain === 'ELECTRICO' ? '<span class="b info">⚡</span>' : ''}${u.running ? '<span class="b good"><span class="sev-ico">●</span>en línea</span>' : unitStatus(u.status)}
              <button class="small ghost" data-inj="${u.id}" title="Simular una degradación">⚡</button></div></div>
          ${Object.entries(u.metrics).map(([k, m]) => {
            const d = mdef[k];
            return `<div class="mrow ${m.level}" data-tip="<b>${esc(d.label)}</b><div>${num(m.v, d.unit === 'g' ? 2 : 1)} ${esc(d.unit)} · advertencia ${d.dir === 'up' ? '≥' : '≤'} ${d.warn}, crítico ${d.dir === 'up' ? '≥' : '≤'} ${d.crit}</div>${m.eta !== null ? `<div>Tendencia: umbral en ~${m.eta} min</div>` : ''}">
              <span class="ml">${m.level === 'crit' ? '▲ ' : m.level === 'warn' ? '◆ ' : m.eta !== null ? '◭ ' : ''}${esc(d.label)}</span>${sparkline(m.h, { warn: d.warn, crit: d.crit, dir: d.dir, level: m.level })}
              <span class="mv">${num(m.v, d.unit === 'g' ? 2 : 1)} <span class="muted">${esc(d.unit)}</span></span></div>`;
          }).join('')}
        </div>`).join('') || '<div class="card empty">Sin anomalías en este momento</div>';
      view.querySelector('#alerts').innerHTML = alerts.length ? `<ul class="tl">${alerts.map((a) => `<li>${sev(a.severity)} <b>Int. ${esc(a.unit_no)}</b> <span class="ts">${ago(a.ts)}</span>
          <div class="small">${esc(a.message)}</div>
          <div class="row small" style="margin-top:3px">${a.wo_id ? `<a href="#/ordenes/${a.wo_id}">OT ${a.wo_id}</a>` : ''}
            ${a.status === 'ABIERTA' ? (a.severity === 'CRITICA' ? '<span class="muted">generando OT automática…</span>' : `<button class="small" data-wo="${a.id}">Crear OT</button><button class="small ghost" data-dis="${a.id}">Descartar</button>`) : a.status === 'OT_GENERADA' && a.severity === 'CRITICA' ? '<span class="b crit">OT P1 automática</span>' : `<span class="muted">${esc(a.status.toLowerCase().replace('_', ' '))}</span>`}</div></li>`).join('')}</ul>` : '<div class="empty">Sin alertas</div>';
      view.querySelectorAll('[data-wo]').forEach((b) => b.onclick = async () => { const w = await act(b, () => api(`/alerts/${b.dataset.wo}/wo`, { body: {} }), (x) => `OT ${x.id} creada y enviada a JDE`); if (w) draw(); });
      view.querySelectorAll('[data-dis]').forEach((b) => b.onclick = async () => { await act(b, () => api(`/alerts/${b.dataset.dis}/dismiss`, { body: {} })); draw(); });
      view.querySelectorAll('[data-inj]').forEach((b) => b.onclick = () => {
        const u = t.units.find((x) => x.id === Number(b.dataset.inj));
        modal(`<h2>Simular degradación · Interno ${esc(u.unit_no)}</h2>
          <p class="small ink2">Se inicia una deriva progresiva. El modelo debería detectar la tendencia antes del umbral (alerta predictiva) y generar la OT, que se crea en JDE.</p>
          <label class="f">Variable<select id="m">${Object.keys(u.metrics).map((k) => `<option value="${k}">${esc(mdef[k].label)} — ${esc(META.scenarios[k])}</option>`).join('')}</select></label>
          <footer><button data-close>Cancelar</button><button class="primary" id="go">Iniciar</button></footer>`, (el, close) => {
          el.querySelector('#go').onclick = async (e) => {
            const r = await act(e.target, () => api('/telemetry/inject', { body: { unit_id: u.id, metric: el.querySelector('#m').value } }));
            if (r) { toast(`Falla simulada en Int. ${r.unit}: ${r.scenario}`, 'ok'); close(); }
          };
        });
      });
    };
    await draw();
    ctx.every(5000, () => { if (!document.querySelector('.modal-bg')) draw(); });
  },
};
