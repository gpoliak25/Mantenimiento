import { api, esc, num, usd, ago, act, modal, critBadge, META, toast } from '../ui.js';

const REQ_STATUS = { 220: 'Requisición ingresada', 230: 'En aprobación', 400: 'Recibida' };

export default {
  title: 'Repuestos',
  crumb: 'Stock e ítems maestros desde JDE (F4101/F41021) · requisiciones de compra (F4311 OR)',
  async render(view, _, ctx) {
    let filter = 'all';
    const top = ctx.actions(`<label class="row small" style="gap:6px"><input type="checkbox" id="ar" ${META.settings.auto_reorder ? 'checked' : ''}> Reposición automática del stock de seguridad</label>`);
    top.querySelector('#ar').onchange = async (e) => {
      META.settings = await api('/settings', { method: 'PUT', body: { auto_reorder: e.target.checked } });
      toast(META.settings.auto_reorder ? 'Se generarán requisiciones al quedar bajo el stock de seguridad' : 'Reposición automática desactivada');
    };
    const draw = async () => {
      const [parts, reqs] = await Promise.all([api('/parts'), api('/requisitions')]);
      if (!ctx.alive()) return;
      const below = parts.filter((p) => p.on_hand < p.safety_stock);
      const belowA = below.filter((p) => p.criticality === 'A');
      const waiting = parts.filter((p) => p.waitingWo);
      const value = parts.reduce((s, p) => s + p.on_hand * p.unit_cost, 0);
      const rows = parts.filter((p) => filter === 'all' || (filter === 'below' && p.on_hand < p.safety_stock) || (filter === 'rot' && p.rotable) || (filter === 'A' && p.criticality === 'A'));
      view.innerHTML = `
        <div class="tiles">
          <div class="tile"><div class="k">Indicador adelantado</div><div class="v">${num(((parts.length - below.length) / parts.length) * 100, 0)}%</div><div class="d">artículos sobre el stock de seguridad</div></div>
          <div class="tile"><div class="k">Bajo stock de seguridad</div><div class="v">${below.length}</div><div class="d">${belowA.length} de criticidad A</div></div>
          <div class="tile"><div class="k">OTs esperando repuestos</div><div class="v">${waiting.reduce((s, p) => s + p.waitingWo, 0)}</div><div class="d">impactan el MTTR y el ciclo de la OT</div></div>
          <div class="tile"><div class="k">Valor del inventario</div><div class="v">${usd(value)}</div><div class="d">${parts.length} artículos · sucursal M30</div></div>
        </div>
        <div class="grid g-2-1 mt" style="align-items:start">
          <div class="card">
            <header><h2>Inventario</h2>
              <div class="seg" id="f">${[['all', 'Todos'], ['below', 'Bajo seguridad'], ['A', 'Criticidad A'], ['rot', 'Rotables']].map(([k, l]) => `<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}</div></header>
            <div class="tw"><table class="t">
              <thead><tr><th>Artículo</th><th>Sistema</th><th>Criticidad</th><th class="num">Stock</th><th class="num">Seguridad</th><th class="num">Uso 90 d</th><th class="num">Costo</th><th class="num">Plazo</th><th>Compra</th><th></th></tr></thead>
              <tbody>${rows.map((p) => `<tr>
                <td><span class="mono">${esc(p.item_no)}</span>${p.rotable ? ' <span class="b info">rotable</span>' : ''}<div class="small">${esc(p.description)}</div></td>
                <td class="small">${esc(p.system)}</td><td>${critBadge(p.criticality)}</td>
                <td class="num">${p.on_hand < p.safety_stock ? `<span class="b crit">▲ ${num(p.on_hand)}</span>` : num(p.on_hand)}</td><td class="num">${num(p.safety_stock)}</td>
                <td class="num">${num(p.usage90)}</td><td class="num">${usd(p.unit_cost)}</td><td class="num small">${p.lead_days} d</td>
                <td class="small">${p.requisition ? `<span class="b warn">${p.requisition.jde_doco ? 'OR ' + p.requisition.jde_doco : 'pendiente'}</span>` : ''}${p.waitingWo ? ` <span class="b crit">${p.waitingWo} OT</span>` : ''}</td>
                <td>${p.requisition ? '' : `<button class="small" data-req="${esc(p.item_no)}">Solicitar</button>`}</td></tr>`).join('')}</tbody>
            </table></div>
            <div class="small muted mt">Proveedores y precios: contratos marco en JDE. Rotables (motores, cajas, compresores reacondicionados) reducen la inmovilización.</div>
          </div>
          <div class="card">
            <header><h2>Requisiciones de compra</h2><span class="sub">F4311 · OR → OP</span></header>
            ${reqs.length ? `<ul class="tl">${reqs.map((r) => `<li class="jde"><b class="mono">${esc(r.item_no)}</b> × ${num(r.qty)} <span class="ts">${ago(r.created_at)}</span>
              <div class="small">${esc(r.description || '')}</div>
              <div class="small">${r.jde_doco ? `OR <b class="mono">${r.jde_doco}</b> · ${esc(REQ_STATUS[r.jde_status] || r.jde_status)}` : '<span class="b warn">Pendiente de envío a JDE</span>'} ${r.jde_status === '400' ? '<span class="b good">✓ stock repuesto</span>' : ''}</div>
              <div class="small muted">${esc(r.reason || '')}${r.wo_id ? ` · <a href="#/ordenes/${r.wo_id}">OT ${r.wo_id}</a>` : ''}</div></li>`).join('')}</ul>` : '<div class="empty">Sin requisiciones</div>'}
            <div class="note mt">El circuito de compras (aprobación, OC y recepción) ocurre en JDE. El sistema de mantenimiento consulta su estado y el stock cada 60 s.</div>
          </div>
        </div>`;
      view.querySelector('#f').onclick = (e) => { const b = e.target.closest('button'); if (b) { filter = b.dataset.f; draw(); } };
      view.querySelectorAll('[data-req]').forEach((b) => b.onclick = () => {
        const p = parts.find((x) => x.item_no === b.dataset.req);
        modal(`<h2>Requisición de compra</h2><p class="small ink2">${esc(p.item_no)} · ${esc(p.description)} — proveedor ${esc(p.supplier_name || '')}</p>
          <div class="form"><label class="f">Cantidad<input id="q" type="number" min="1" value="${p.reorder_qty}"></label><label class="f">Motivo<input id="r" value="Reposición de stock"></label></div>
          <footer><button data-close>Cancelar</button><button class="primary" id="go">Enviar a JDE</button></footer>`, (el, close) => {
          el.querySelector('#go').onclick = async (e) => {
            const r = await act(e.target, () => api('/requisitions', { body: { item_no: p.item_no, qty: Number(el.querySelector('#q').value), reason: el.querySelector('#r').value } }), 'Requisición enviada a JDE (FLT_CreateRequisition)');
            if (r) { close(); draw(); }
          };
        });
      });
    };
    await draw();
    ctx.every(10000, () => { if (!document.querySelector('.modal-bg')) draw(); });
  },
};
