import { api, esc, num, unitStatus, pmStatus } from '../ui.js';

export default {
  title: 'Flota',
  crumb: 'Ficha de cada unidad · maestro de equipos sincronizado con JDE (F1201)',
  async render(view, _, ctx) {
    let filter = '';
    let status = '';
    const draw = async () => {
      const units = await api('/units');
      if (!ctx.alive()) return;
      const rows = units.filter((u) => (!status || u.status === status) && (!filter || `${u.unit_no} ${u.plate} ${u.brand} ${u.model} ${u.line} ${u.depot}`.toLowerCase().includes(filter.toLowerCase())));
      const counts = units.reduce((a, u) => { a[u.status] = (a[u.status] || 0) + 1; return a; }, {});
      view.innerHTML = `
        <div class="card">
          <div class="spread" style="margin-bottom:12px">
            <div class="seg" id="seg">
              ${[['', `Todas (${units.length})`], ['DISPONIBLE', `Disponibles (${counts.DISPONIBLE || 0})`], ['EN_TALLER', `En taller (${counts.EN_TALLER || 0})`], ['FUERA_SERVICIO', `Fuera de servicio (${counts.FUERA_SERVICIO || 0})`]]
                .map(([k, l]) => `<button data-s="${k}" class="${status === k ? 'on' : ''}">${l}</button>`).join('')}
            </div>
            <input id="q" placeholder="Buscar interno, dominio, modelo, línea…" value="${esc(filter)}" style="width:280px">
          </div>
          <div class="tw"><table class="t">
            <thead><tr><th>Interno</th><th>Dominio</th><th>Modelo</th><th class="num">Año</th><th>Tracción</th><th>Cochera · línea</th><th class="num">Odómetro</th>
              <th>Estado</th><th>Estado JDE</th><th>Preventivo</th><th class="num">OTs abiertas</th><th class="num">Alertas</th></tr></thead>
            <tbody>${rows.map((u) => `<tr class="click" onclick="location.hash='#/flota/${u.id}'">
              <td><b>${esc(u.unit_no)}</b></td><td class="mono">${esc(u.plate)}</td><td>${esc(u.brand)} ${esc(u.model)}</td><td class="num">${u.year}</td>
              <td>${u.powertrain === 'ELECTRICO' ? '<span class="b info">⚡ Eléctrico</span>' : '<span class="b plain">Diésel</span>'}</td>
              <td>${esc(u.depot)} · ${esc(u.line)}</td><td class="num">${num(u.odometer_km)} km</td><td>${unitStatus(u.status)}</td>
              <td class="mono" data-tip="Equipment Status (UDC 12/ES) en F1201">${esc(u.jde_status || '—')}</td>
              <td>${u.pmNext ? `Nivel ${esc(u.pmNext)} ${pmStatus(u.pmStatus)}` : pmStatus('OK')}</td>
              <td class="num">${u.openWo || ''}</td><td class="num">${u.alerts ? `<span class="b warn">${u.alerts}</span>` : ''}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>`;
      view.querySelector('#seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { status = b.dataset.s; draw(); } });
      const q = view.querySelector('#q');
      q.addEventListener('input', () => { filter = q.value; clearTimeout(q._t); q._t = setTimeout(async () => { await draw(); const n = view.querySelector('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); });
    };
    await draw();
    ctx.every(15000, () => { if (document.activeElement?.id !== 'q') draw(); });
  },
};
