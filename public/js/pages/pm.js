import { api, esc, num, usd, act, pmStatus, unitStatus } from '../ui.js';

export default {
  title: 'Plan preventivo',
  crumb: 'Plan por niveles con vencimiento por km o tiempo · tolerancia ±10% · sincronizado con JDE P1207 (F1207)',
  async render(view, _, ctx) {
    let filter = 'due';
    const top = ctx.actions('<button class="primary" id="gen">Generar OTs de vencidos y próximos</button>');
    top.querySelector('#gen').onclick = async (e) => {
      const r = await act(e.target, () => api('/pm/generate-due', { body: {} }), (x) => `${x.created.length} OTs preventivas generadas con su kit y enviadas a JDE`);
      if (r) draw();
    };
    const draw = async () => {
      const [d, kits] = await Promise.all([api('/pm'), api('/kits')]);
      if (!ctx.alive()) return;
      const counts = d.units.reduce((a, r) => { a[r.nextStatus] = (a[r.nextStatus] || 0) + 1; return a; }, {});
      const rows = d.units.filter((r) => filter === 'all' || r.nextStatus !== 'OK').sort((a, b) => ({ VENCIDO: 0, EN_TOLERANCIA: 1, PROXIMO: 2, OK: 3 }[a.nextStatus] - { VENCIDO: 0, EN_TOLERANCIA: 1, PROXIMO: 2, OK: 3 }[b.nextStatus]));
      const lv = (l) => {
        const cls = l.status === 'VENCIDO' ? 'crit' : l.status === 'EN_TOLERANCIA' ? 'warn' : l.status === 'PROXIMO' ? '' : 'good';
        return `<div data-tip="<b>Nivel ${esc(l.level)}</b><div>Último: ${num(l.last_km)} km</div><div>Vence: ${num(l.due_km)} km${l.due_date ? ' o ' + esc(l.due_date) : ''}</div><div>Restan: ${num(l.remaining_km)} km</div>">
          <div class="bar ${cls}" style="margin-bottom:3px"><span style="width:${Math.min(100, (l.progress * 100) / 1.1)}%"></span><i class="tick" style="left:${100 / 1.1}%"></i></div>
          <div class="small ${l.status === 'VENCIDO' ? 'delta bad' : 'muted'}">${num(l.remaining_km)} km</div></div>`;
      };
      view.innerHTML = `
        <div class="flow">
          <div><b>Continuo</b>Sensores IoT: temperatura, presión, vibración y fallas.<div class="sub mt">Tiempo real · <a href="#/telemetria">ver</a></div></div>
          <div><b>Diaria</b>Conductor: neumáticos, luces, fluidos y pérdidas visibles.<div class="sub mt">A diario · <a href="#/inspeccion">registrar</a></div></div>
          ${d.plans.filter((p) => p.level !== 'MAYOR').map((p) => `<div><b>Nivel ${esc(p.level)}</b>${esc(p.name.split('— ')[1])}<div class="sub mt">Cada ${num(p.interval_km)} km o ${p.interval_days} días · ${p.std_hours} h · <span class="mono">${esc(p.jde_service_type)}</span></div></div>`).join('')}
        </div>
        <div class="note mt">Nivel <b>Mayor</b> (motor, caja y ejes) cada ${num(d.plans.find((p) => p.level === 'MAYOR').interval_km)} km según manual y datos de falla. Un nivel superior incluye los inferiores: al cerrar un C se reinician B y A. Intervalos basados en TRB/TCRP (2010): el 92% de las agencias inspecciona cada 3.200–9.700 km.</div>

        <div class="tiles mt">
          <div class="tile"><div class="k">Vencidos <span>${pmStatus('VENCIDO')}</span></div><div class="v">${counts.VENCIDO || 0}</div><div class="d">fuera de la tolerancia de +10%</div></div>
          <div class="tile"><div class="k">En tolerancia <span>${pmStatus('EN_TOLERANCIA')}</span></div><div class="v">${counts.EN_TOLERANCIA || 0}</div><div class="d">pasado el vencimiento, dentro de +10%</div></div>
          <div class="tile"><div class="k">Próximos <span>${pmStatus('PROXIMO')}</span></div><div class="v">${counts.PROXIMO || 0}</div><div class="d">dentro del −10% previo al vencimiento</div></div>
          <div class="tile"><div class="k">Al día <span>${pmStatus('OK')}</span></div><div class="v">${counts.OK || 0}</div><div class="d">unidades sin servicio pendiente</div></div>
        </div>

        <div class="card mt">
          <header><h2>Vencimientos por unidad</h2>
            <div class="seg" id="f"><button data-f="due" class="${filter === 'due' ? 'on' : ''}">Con servicio pendiente</button><button data-f="all" class="${filter === 'all' ? 'on' : ''}">Todas</button></div></header>
          <div class="tw"><table class="t">
            <thead><tr><th>Interno</th><th>Estado</th><th class="num">Odómetro</th><th>Nivel A</th><th>Nivel B</th><th>Nivel C</th><th>Mayor</th><th>A ejecutar</th><th></th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td><a href="#/flota/${r.unit.id}"><b>${esc(r.unit.unit_no)}</b></a><div class="small muted">${esc(r.unit.model)}</div></td>
              <td>${unitStatus(r.unit.status)}</td><td class="num">${num(r.unit.odometer_km)}</td>
              ${r.levels.map((l) => `<td style="min-width:110px">${lv(l)}</td>`).join('')}
              <td>${r.next ? `<b>${esc(r.next)}</b> ${pmStatus(r.nextStatus)}` : pmStatus('OK')}</td>
              <td>${r.openWo ? `<a href="#/ordenes/${r.openWo.id}">OT ${r.openWo.id}</a>` : r.next ? `<button class="small" data-u="${r.unit.id}" data-p="${d.plans.find((p) => p.level === r.next).id}">Generar OT</button>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="9" class="empty">Todas las unidades al día</td></tr>'}</tbody>
          </table></div>
        </div>

        <div class="card mt">
          <header><h2>Kits de repuestos por nivel</h2><span class="sub">se cargan automáticamente en la OT (F3111) · las unidades eléctricas omiten los ítems del motor diésel</span></header>
          <div class="grid g4">${kits.map((k) => `<div><h3>Nivel ${esc(k.level)}</h3><table class="t"><tbody>${k.items.map((i) => `<tr><td class="small"><span class="mono">${esc(i.item)}</span><div>${esc(i.description)}</div></td><td class="num small">× ${num(i.qty)}</td>
            <td class="num small">${i.on_hand < i.qty * 3 ? `<span class="b warn">${num(i.on_hand)}</span>` : num(i.on_hand)}</td></tr>`).join('')}</tbody></table>
            <div class="small muted mt">Costo del kit: ${usd(k.items.reduce((s, i) => s + i.qty * i.unit_cost, 0))}</div></div>`).join('')}</div>
        </div>`;
      view.querySelector('#f').onclick = (e) => { const b = e.target.closest('button'); if (b) { filter = b.dataset.f; draw(); } };
      view.querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', async () => {
        const w = await act(b, () => api('/pm/generate', { body: { unit_id: Number(b.dataset.u), plan_id: Number(b.dataset.p) } }), (x) => `OT ${x.id} generada y enviada a JDE`);
        if (w) draw();
      }));
    };
    await draw();
    ctx.every(20000, draw);
  },
};
