import { api, esc, ago, act, toast, META } from '../ui.js';

export default {
  title: 'Inspección diaria',
  crumb: 'Mantenimiento autónomo: control del conductor antes de salir a servicio · los defectos generan OT automáticamente',
  async render(view, _, ctx) {
    const items = META.inspectionItems;
    const state = {};
    const draw = async () => {
      const recent = await api('/inspections');
      if (!ctx.alive()) return;
      view.innerHTML = `
        <div class="grid g-2-1">
          <div class="card">
            <header><h2>Control previo a la salida</h2><span class="sub">ítems de seguridad marcados con ▲ dejan la unidad no apta</span></header>
            <div class="form">
              <label class="f">Unidad<select id="u">${META.units.map((u) => `<option value="${u.id}">Interno ${esc(u.unit_no)} · ${esc(u.plate)}${u.status !== 'DISPONIBLE' ? ' (en taller)' : ''}</option>`).join('')}</select></label>
              <label class="f">Conductor<input id="drv" placeholder="Nombre y legajo"></label>
              <label class="f">Odómetro (km)<input id="odo" type="number" placeholder="Opcional"></label>
            </div>
            <div class="mt">${items.map((it) => `
              <div class="check-row" data-k="${it.key}">
                <div>${it.safety ? '<span class="b crit" title="Ítem de seguridad">▲</span> ' : ''}${esc(it.label)}<div class="small muted">${esc(it.system)}${it.detective ? ' · mantenimiento detectivo' : ''}</div></div>
                <div class="seg"><button data-v="OK" class="on">✓ OK</button><button data-v="FALLA">✕ Falla</button></div>
                <input type="text" class="hidden nt" placeholder="Describa la falla observada">
              </div>`).join('')}</div>
            <div class="row mt" style="justify-content:flex-end"><button class="primary" id="send">Registrar inspección</button></div>
            <div id="res"></div>
          </div>
          <div class="card">
            <header><h2>Últimas inspecciones</h2><span class="sub">${recent.length}</span></header>
            <ul class="tl">${recent.slice(0, 25).map((i) => `<li><b>Int. ${esc(i.unit_no)}</b> · ${esc(i.driver)} <span class="ts">${ago(i.ts)}</span>
              <div class="small">${i.defects ? `<span class="b crit">${i.defects} defecto(s)</span> ${i.wo_id ? `<a href="#/ordenes/${i.wo_id}">OT ${i.wo_id}</a>` : ''}` : '<span class="b good">Sin novedades</span>'}</div></li>`).join('')}</ul>
          </div>
        </div>`;
      view.querySelectorAll('.check-row').forEach((row) => {
        state[row.dataset.k] = 'OK';
        row.querySelector('.seg').onclick = (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          row.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
          state[row.dataset.k] = b.dataset.v;
          row.querySelector('.nt').classList.toggle('hidden', b.dataset.v !== 'FALLA');
        };
      });
      view.querySelector('#send').onclick = async (e) => {
        const notes = {};
        view.querySelectorAll('.check-row').forEach((r) => { const v = r.querySelector('.nt').value.trim(); if (v) notes[r.dataset.k] = v; });
        const r = await act(e.target, () => api('/inspections', { body: { unit_id: Number(view.querySelector('#u').value), driver: view.querySelector('#drv').value.trim(), odometer_km: Number(view.querySelector('#odo').value) || undefined, items: state, notes } }));
        if (!r) return;
        if (!r.defects) { toast('Inspección registrada: unidad apta para salir', 'ok'); draw(); return; }
        toast(`${r.defects} defecto(s): ${r.workOrders.length} OT generada(s) y enviada(s) a JDE`, r.unitApt ? 'ok' : 'err');
        await draw();
        view.querySelector('#res').innerHTML = `<div class="note mt">${r.unitApt ? 'La unidad puede salir; los defectos menores quedan programados.' : '<b>Unidad NO apta</b>: defecto en un ítem de seguridad. Quedó fuera de servicio.'}
          <div class="mt">${r.workOrders.map((w) => `<a href="#/ordenes/${w.id}">OT ${w.id}</a> — ${esc(w.title)}`).join('<br>')}</div></div>`;
      };
    };
    await draw();
  },
};
