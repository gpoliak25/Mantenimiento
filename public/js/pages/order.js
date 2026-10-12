import { api, esc, num, usd, dt, act, toast, META, TYPE_LABEL, STAGE_LABEL, ORIGIN_LABEL, prio, typeBadge, unitStatus, syncBadge, sev, critBadge } from '../ui.js';

const STAGES = ['ORDEN', 'DIAGNOSTICO', 'REPUESTOS', 'REPARACION', 'CONTROL', 'CERRADA'];
const JDE_SS = { 10: 'Creada', 20: 'Diagnóstico', 30: 'Esperando repuestos', 40: 'En proceso', 80: 'Control de calidad', 99: 'Cerrada' };

function jdeSection(w) {
  const st = { OK: 'good', PENDIENTE: 'warn', REINTENTO: 'warn', ERROR: 'crit' };
  return `
    <table class="t"><tbody>
      <tr><td class="muted">Orden JDE (DOCO · DCTO)</td><td><b class="mono">${w.jde_doco ? `${w.jde_doco} · WM` : 'pendiente'}</b></td></tr>
      <tr><td class="muted">Estado JDE (SRST)</td><td class="mono">${w.jde_status ? `${w.jde_status} · ${JDE_SS[w.jde_status] || ''}` : '—'}</td></tr>
      <tr><td class="muted">Tipo JDE (TYPS)</td><td class="mono">${META.woTypes[w.type].jde} · ${esc(TYPE_LABEL[w.type])}</td></tr>
      ${w.jde_cost != null ? `<tr><td class="muted">Costo real JDE (AMTA)</td><td><b>${usd(w.jde_cost, 2)}</b></td></tr>` : ''}
      <tr><td class="muted">Sincronización</td><td>${syncBadge(w.sync_state, null)}</td></tr>
    </tbody></table>
    <h3 class="mt">Mensajes enviados al ERP</h3>
    <ul class="tl mt">${w.outbox.map((o) => `<li class="jde"><span class="b ${st[o.status]}">${esc(o.status)}</span> <code>${esc(o.orchestration)}</code>
      <div class="ts">${dt(o.sent_at || o.created_at)}${o.attempts > 1 ? ` · ${o.attempts} intentos` : ''}</div>
      ${o.last_error ? `<div class="small delta bad">${esc(o.last_error)}</div>` : ''}
      <details class="small"><summary class="muted">payload / respuesta</summary><pre class="json">${esc(JSON.stringify(JSON.parse(o.payload), null, 1))}</pre>${o.response ? `<pre class="json">${esc(JSON.stringify(JSON.parse(o.response), null, 1))}</pre>` : ''}</details></li>`).join('') || '<li class="muted">Sin mensajes en esta sesión (OT sincronizada en la carga inicial)</li>'}</ul>`;
}

function eventsSection(w) {
  return `<ul class="tl">${w.events.map((e) => `<li class="${/JDE/.test(e.note) ? 'jde' : ''}"><div class="ts">${dt(e.ts)}${e.stage ? ' · ' + esc(STAGE_LABEL[e.stage] || e.stage) : ''}</div>${esc(e.note)}</li>`).join('')}</ul>`;
}

function costSection(w) {
  return `<div class="tiles" style="grid-template-columns:repeat(3,1fr)">
    <div><div class="sub">Repuestos</div><b>${usd(w.costs.parts, 2)}</b></div>
    <div><div class="sub">Mano de obra (${num(w.costs.hours, 1)} h)</div><b>${usd(w.costs.labor, 2)}</b></div>
    <div><div class="sub">Total</div><b>${usd(w.costs.total, 2)}</b></div></div>`;
}

export default {
  title: 'Orden de trabajo',
  async render(view, { id }, ctx) {
    let w = await api('/workorders/' + id);

    const draw = () => {
      const open = w.stage !== 'CERRADA';
      const idx = STAGES.indexOf(w.stage);
      const next = STAGES[idx + 1];
      ctx.setTitle(`OT ${w.id} · ${w.title}`, `<a href="#/ordenes">Órdenes de trabajo</a> · <a href="#/flota/${w.unit_id}">Interno ${esc(w.unit_no)}</a> · ${esc(w.brand)} ${esc(w.model)}`);
      const top = ctx.actions(open ? (w.stage === 'CONTROL'
        ? '<button class="primary" id="bClose">✓ Cerrar OT y liberar unidad</button>'
        : `<button class="primary" id="bAdv">Avanzar a ${esc(STAGE_LABEL[next])} →</button>`) : `<span class="b good">Cerrada ${dt(w.closed_at)}</span>`);
      const editDiag = open && ['ORDEN', 'DIAGNOSTICO'].includes(w.stage);
      const needRoot = open && ['REPARACION', 'CONTROL'].includes(w.stage);
      view.innerHTML = `
        <div class="card">
          <div class="stepper">${STAGES.map((s, i) => `<div class="step ${i < idx || w.stage === 'CERRADA' ? 'done' : i === idx ? 'cur' : ''}"><i></i>${esc(STAGE_LABEL[s])}</div>`).join('')}</div>
        </div>
        <div class="grid g-2-1 mt">
          <div class="grid" style="align-content:start">
            <div class="card">
              <header><h2>Detalle</h2><div class="row">${typeBadge(w.type)}${prio(w.priority)}${w.road_call ? '<span class="b crit">Falla en ruta</span>' : ''}</div></header>
              <div class="grid g2" style="gap:8px 16px">
                <div><div class="sub">Unidad</div><a href="#/flota/${w.unit_id}"><b>Interno ${esc(w.unit_no)}</b></a> · ${esc(w.plate)} ${unitStatus(w.unit_status)}</div>
                <div><div class="sub">Sistema</div>${esc(w.system || '—')}</div>
                <div><div class="sub">Detección</div>${esc(ORIGIN_LABEL[w.origin] || w.origin)} · ${dt(w.created_at)}</div>
                <div><div class="sub">Odómetro al abrir</div>${num(w.km_at)} km</div>
                ${w.plan_level ? `<div><div class="sub">Preventivo</div>Nivel ${esc(w.plan_level)} · vencía a ${num(w.due_km)} km (±${num(w.plan_interval * 0.1)} km)</div>` : ''}
                <div><div class="sub">Inmovilización</div>${w.immobilized ? 'La unidad queda en taller' : 'Programada (la unidad sigue en servicio hasta el ingreso)'}</div>
              </div>
              ${w.symptom ? `<div class="note mt"><b>Síntoma:</b> ${esc(w.symptom)}</div>` : ''}
              ${w.alert ? `<div class="note mt">${sev(w.alert.severity)} <b>Alerta de sensor:</b> ${esc(w.alert.message)}</div>` : ''}
              <div class="form mt">
                <label class="f full">Diagnóstico (causa y alcance de la reparación)
                  ${editDiag ? `<textarea id="diag" placeholder="Obligatorio para pasar a repuestos">${esc(w.diagnosis || '')}</textarea>` : `<div class="ink2" style="font-size:13px">${esc(w.diagnosis || '—')}</div>`}</label>
                <label class="f full">Causa raíz ${w.type === 'CORRECTIVO' ? '(obligatoria al cerrar: alimenta el plan preventivo)' : ''}
                  ${needRoot ? `<textarea id="root" placeholder="¿Por qué falló? Ej.: termostato trabado, secador saturado…">${esc(w.root_cause || '')}</textarea>` : `<div class="ink2" style="font-size:13px">${esc(w.root_cause || '—')}</div>`}</label>
              </div>
              ${w.plan_tasks ? `<h3 class="mt">Tareas del nivel ${esc(w.plan_level)}</h3><div class="grid g2 mt" style="gap:4px 16px">${w.plan_tasks.map((t) => `<label class="row small"><input type="checkbox" ${w.stage === 'CERRADA' || ['CONTROL'].includes(w.stage) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</div>` : ''}
            </div>

            <div class="card">
              <header><h2>Repuestos</h2><span class="sub">stock en JDE · sucursal M30</span></header>
              ${w.parts.length ? `<div class="tw"><table class="t"><thead><tr><th>Artículo</th><th>Criticidad</th><th class="num">Cant.</th><th class="num">Entregado</th><th class="num">Stock</th><th class="num">Costo</th><th></th></tr></thead><tbody>
                ${w.parts.map((p) => `<tr><td><span class="mono">${esc(p.item_no)}</span><div class="small">${esc(p.description)}</div></td><td>${critBadge(p.criticality)}</td><td class="num">${num(p.qty)}</td><td class="num">${num(p.issued)}</td>
                  <td class="num">${p.issued < p.qty && p.on_hand < p.qty - p.issued ? `<span class="b crit">${num(p.on_hand)}</span>` : num(p.on_hand)}</td><td class="num">${usd(p.qty * p.unit_cost, 2)}</td>
                  <td>${open && p.issued < p.qty ? `<button class="small" data-issue="${p.id}">Entregar</button>` : p.issued >= p.qty ? '<span class="b good">✓</span>' : ''}</td></tr>`).join('')}
              </tbody></table></div>` : '<div class="muted small">Sin repuestos asignados</div>'}
              ${w.requisitions.length ? `<div class="note mt">Requisiciones de compra: ${w.requisitions.map((r) => `${esc(r.item_no)} × ${num(r.qty)} → ${r.jde_doco ? `OR ${r.jde_doco} (estado ${esc(r.jde_status)})` : 'pendiente de envío'}`).join(' · ')}</div>` : ''}
              ${open ? `<div class="row mt"><select id="pAdd" style="flex:1;min-width:200px">${META.parts.map((p) => `<option value="${p.item_no}" ${p.item_no === (META.parts.find((x) => x.system === w.system) || {}).item_no ? 'selected' : ''}>${esc(p.item_no)} · ${esc(p.description)}</option>`).join('')}</select>
                <input id="pQty" type="number" min="1" value="1" style="width:80px"><button id="bAddP">Agregar</button>${w.parts.some((p) => p.issued < p.qty) ? '<button id="bIssueAll">Entregar todo</button>' : ''}</div>` : ''}
            </div>

            <div class="card">
              <header><h2>Mano de obra</h2><span class="sub">F31122</span></header>
              ${w.labor.length ? `<table class="t"><tbody>${w.labor.map((l) => `<tr><td>${esc(l.tech)}</td><td class="small muted">${esc(l.day)}</td><td class="num">${num(l.hours, 1)} h</td><td class="num">${usd(l.hours * l.rate, 2)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">Sin horas registradas</div>'}
              ${open ? `<div class="row mt"><select id="tech">${META.technicians.map((t) => `<option value="${t.an8}">${esc(t.name)} — ${esc(t.specialty)}</option>`).join('')}</select>
                <input id="hrs" type="number" min="0.25" step="0.25" value="1" style="width:80px"><button id="bLab">Registrar horas</button></div>` : ''}
            </div>
          </div>

          <div class="grid" style="align-content:start">
            <div class="card"><header><h2>Costos</h2></header><div id="costs">${costSection(w)}</div></div>
            <div class="card"><header><h2>Integración JDE</h2><span class="sub">AIS · Orchestrator</span></header><div id="jde">${jdeSection(w)}</div></div>
            <div class="card"><header><h2>Historial</h2></header><div id="ev">${eventsSection(w)}</div></div>
          </div>
        </div>`;

      const run = async (btn, fn, msg) => { const r = await act(btn, fn, msg); if (r) { w = r.id ? r : await api('/workorders/' + id); draw(); } return r; };
      top.querySelector('#bAdv')?.addEventListener('click', (e) => run(e.target, () => api(`/workorders/${id}/advance`, { body: { diagnosis: view.querySelector('#diag')?.value.trim() || undefined } }), `OT ${id}: ${STAGE_LABEL[next]} · estado ${META.stages.find((s) => s.key === next).jde} enviado a JDE`));
      top.querySelector('#bClose')?.addEventListener('click', (e) => run(e.target, () => api(`/workorders/${id}/close`, { body: { root_cause: view.querySelector('#root')?.value.trim() || undefined } }), 'OT cerrada: costeo y cierre enviados a JDE'));
      view.querySelectorAll('[data-issue]').forEach((b) => b.addEventListener('click', () => run(b, () => api(`/workorders/${id}/parts/${b.dataset.issue}/issue`, { body: {} }), 'Entrega registrada · movimiento IM enviado a JDE')));
      view.querySelector('#bIssueAll')?.addEventListener('click', async (e) => {
        const r = await run(e.target, () => api(`/workorders/${id}/issue-all`, { body: {} }));
        if (r?.errors?.length) r.errors.forEach((m) => toast(m, 'err'));
      });
      view.querySelector('#bAddP')?.addEventListener('click', (e) => run(e.target, () => api(`/workorders/${id}/parts`, { body: { item_no: view.querySelector('#pAdd').value, qty: Number(view.querySelector('#pQty').value) } }), 'Repuesto agregado a la lista de la OT (F3111)'));
      view.querySelector('#bLab')?.addEventListener('click', (e) => run(e.target, () => api(`/workorders/${id}/labor`, { body: { an8: Number(view.querySelector('#tech').value), hours: Number(view.querySelector('#hrs').value) } }), 'Horas registradas (F31122)'));
      const diag = view.querySelector('#diag');
      if (diag) diag.addEventListener('change', () => api(`/workorders/${id}`, { method: 'PATCH', body: { diagnosis: diag.value.trim() } }).then((r) => { w.diagnosis = r.diagnosis; }));
      const root = view.querySelector('#root');
      if (root) root.addEventListener('change', () => api(`/workorders/${id}`, { method: 'PATCH', body: { root_cause: root.value.trim() } }).then((r) => { w.root_cause = r.root_cause; }));
    };
    draw();

    // Refresco parcial: estado de sincronización con JDE, costos e historial
    ctx.every(3000, async () => {
      const n = await api('/workorders/' + id);
      if (!ctx.alive()) return;
      const changed = n.stage !== w.stage || n.unit_status !== w.unit_status || n.parts.length !== w.parts.length || n.requisitions.length !== w.requisitions.length;
      w = { ...n, diagnosis: w.diagnosis ?? n.diagnosis, root_cause: w.root_cause ?? n.root_cause };
      if (changed && !document.activeElement?.matches('textarea,input,select')) { draw(); return; }
      if (!view.querySelector('#jde details[open]')) view.querySelector('#jde').innerHTML = jdeSection(n);
      view.querySelector('#ev').innerHTML = eventsSection(n);
      view.querySelector('#costs').innerHTML = costSection(n);
    });
  },
};
