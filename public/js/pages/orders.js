import { api, esc, num, usd, ago, date, act, modal, META, TYPE_LABEL, STAGE_LABEL, ORIGIN_LABEL, prio, typeBadge, stageBadge, syncBadge } from '../ui.js';

export function newWoModal(preset = {}, ctx) {
  const m = META;
  modal(`<h2>Nueva orden de trabajo</h2>
    <div class="form">
      <label class="f">Unidad<select id="u">${m.units.map((u) => `<option value="${u.id}" ${u.id === preset.unit_id ? 'selected' : ''}>Interno ${esc(u.unit_no)} · ${esc(u.plate)}</option>`).join('')}</select></label>
      <label class="f">Tipo de mantenimiento<select id="ty">${Object.entries(m.woTypes).map(([k, v]) => `<option value="${k}" ${k === (preset.type || 'CORRECTIVO') ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
      <label class="f">Origen (detección)<select id="or">${Object.entries(ORIGIN_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'CONDUCTOR' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="f">Sistema<select id="sy">${m.systems.map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label class="f full">Título<input id="ti" maxlength="120" placeholder="Ej.: Puerta trasera no cierra"></label>
      <label class="f full">Síntoma observado<textarea id="sm" placeholder="Qué se observó, cuándo y en qué condiciones"></textarea></label>
      <label class="f">Prioridad<select id="pr"><option value="1">P1 crítica — unidad no apta</option><option value="2" selected>P2 alta</option><option value="3">P3 normal</option></select></label>
      <div class="f" style="justify-content:flex-end;gap:6px">
        <label class="row small"><input type="checkbox" id="rc"> Falla en ruta (cuenta para MDBF)</label>
        <label class="row small"><input type="checkbox" id="im" checked> Inmoviliza la unidad</label>
      </div>
      <div class="full">
        <div class="spread"><h3>Repuestos previstos</h3><button class="small" id="addP" type="button">+ Agregar</button></div>
        <div id="pl"></div>
      </div>
    </div>
    <div class="note mt">Al guardar, la OT se registra en el sistema de mantenimiento y se crea en JDE (F4801, orquestación <code>FLT_CreateWorkOrder</code>).</div>
    <footer><button data-close>Cancelar</button><button class="primary" id="ok">Crear OT</button></footer>`, (el, close) => {
    const pl = el.querySelector('#pl');
    const addRow = () => {
      const sys = el.querySelector('#sy').value;
      const d = document.createElement('div');
      d.className = 'row';
      d.style.marginTop = '6px';
      d.innerHTML = `<select class="pi" style="flex:1">${m.parts.map((p) => `<option value="${p.item_no}">${esc(p.item_no)} · ${esc(p.description)} (stock ${num(p.on_hand)})</option>`).join('')}</select>
        <input class="pq" type="number" min="1" value="1" style="width:80px"><button class="small ghost" type="button">✕</button>`;
      d.querySelector('button').onclick = () => d.remove();
      const first = m.parts.find((p) => p.system === sys);
      if (first) d.querySelector('select').value = first.item_no;
      pl.appendChild(d);
    };
    el.querySelector('#addP').onclick = addRow;
    el.querySelector('#ty').onchange = (e) => { if (['PREVENTIVO', 'PREDICTIVO', 'CONDICION', 'PROACTIVO'].includes(e.target.value)) el.querySelector('#pr').value = '3'; };
    el.querySelector('#ok').onclick = async (e) => {
      const body = {
        unit_id: Number(el.querySelector('#u').value), type: el.querySelector('#ty').value, origin: el.querySelector('#or').value, system: el.querySelector('#sy').value,
        title: el.querySelector('#ti').value.trim(), symptom: el.querySelector('#sm').value.trim(), priority: Number(el.querySelector('#pr').value),
        road_call: el.querySelector('#rc').checked, immobilized: el.querySelector('#im').checked,
        parts: [...pl.querySelectorAll('.row')].map((r) => [r.querySelector('.pi').value, Number(r.querySelector('.pq').value)]).filter((p) => p[1] > 0),
      };
      const w = await act(e.target, () => api('/workorders', { body }), (r) => `OT ${r.id} creada · enviada a JDE`);
      if (w) { close(); location.hash = '#/ordenes/' + w.id; }
    };
  });
}

const STAGES = ['ORDEN', 'DIAGNOSTICO', 'REPUESTOS', 'REPARACION', 'CONTROL'];

export default {
  title: 'Órdenes de trabajo',
  crumb: 'Flujo del taller: detección → orden → diagnóstico → repuestos → reparación → control y cierre',
  async render(view, _, ctx) {
    let mode = 'board';
    let type = '';
    const top = ctx.actions('<div class="seg" id="mode"><button data-m="board" class="on">Tablero</button><button data-m="list">Historial</button></div><button class="primary" id="nw">+ Nueva OT</button>');
    top.querySelector('#nw').onclick = () => newWoModal({}, ctx);
    top.querySelector('#mode').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      mode = b.dataset.m;
      top.querySelectorAll('#mode button').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    };
    if (location.hash.includes('nueva=1')) { history.replaceState(null, '', '#/ordenes'); newWoModal({}, ctx); }

    const card = (w) => `<a class="wo-card" href="#/ordenes/${w.id}">
      <div class="spread"><b class="small">OT ${w.id} · Int. ${esc(w.unit_no)}</b>${syncBadge(w.sync_state, w.jde_doco)}</div>
      <div class="t1">${esc(w.title)}</div>
      <div class="row" style="gap:4px;margin-bottom:6px">${typeBadge(w.type)}${w.priority < 3 ? prio(w.priority) : ''}${w.road_call ? '<span class="b crit">En ruta</span>' : ''}${w.parts_pending ? `<span class="b warn">${w.parts_pending} rep. pend.</span>` : ''}</div>
      <div class="meta"><span>${esc(w.system || '')}</span><span>${ago(w.created_at)}</span></div></a>`;

    const draw = async () => {
      if (mode === 'board') {
        const rows = await api('/workorders?open=1&limit=300');
        if (!ctx.alive() || mode !== 'board') return;
        const f = rows.filter((w) => !type || w.type === type);
        view.innerHTML = `${filters(rows)}<div class="kanban">${STAGES.map((s) => {
          const col = f.filter((w) => w.stage === s);
          return `<div class="col"><header><span>${STAGE_LABEL[s]}</span><span class="n">${col.length}</span></header>${col.map(card).join('') || '<div class="small muted" style="padding:8px">Sin OTs</div>'}</div>`;
        }).join('')}</div>`;
      } else {
        const rows = await api('/workorders?limit=400' + (type ? '&type=' + type : ''));
        if (!ctx.alive() || mode !== 'list') return;
        view.innerHTML = `${filters(rows)}<div class="card"><div class="tw"><table class="t">
          <thead><tr><th>OT</th><th>JDE</th><th>Fecha</th><th>Unidad</th><th>Tipo</th><th>Origen</th><th>Título</th><th>Etapa</th><th class="num">Duración</th><th class="num">Costo</th></tr></thead>
          <tbody>${rows.map((w) => `<tr class="click" onclick="location.hash='#/ordenes/${w.id}'"><td><b>${w.id}</b></td><td>${syncBadge(w.sync_state, w.jde_doco)}</td>
            <td class="small">${date(w.created_at)}</td><td>Int. ${esc(w.unit_no)}</td><td>${typeBadge(w.type)}${w.road_call ? ' <span class="b crit">En ruta</span>' : ''}</td>
            <td class="small">${esc(ORIGIN_LABEL[w.origin] || w.origin)}</td><td class="small">${esc(w.title)}</td><td>${stageBadge(w.stage)}</td>
            <td class="num small">${w.closed_at ? num((new Date(w.closed_at) - new Date(w.created_at)) / 3600000, 1) + ' h' : '—'}</td><td class="num">${usd(w.cost)}</td></tr>`).join('')}</tbody>
        </table></div></div>`;
      }
      view.querySelector('#tf').onchange = (e) => { type = e.target.value; draw(); };
    };
    const filters = (rows) => `<div class="row" style="margin-bottom:12px"><select id="tf"><option value="">Todos los tipos</option>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="sub">${rows.length} órdenes${mode === 'board' ? ' abiertas' : ''}</span></div>`;
    await draw();
    ctx.every(8000, () => { if (!document.querySelector('.modal-bg')) draw(); });
  },
};
