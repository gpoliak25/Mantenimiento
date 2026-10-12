import { api, esc, num, dt, ago, act, toast } from '../ui.js';

export default {
  title: 'Integración JDE E1 9.2',
  crumb: 'AIS Server (REST) + Orchestrator · cola saliente con reintentos · sincronización entrante de maestros y estados',
  async render(view, _, ctx) {
    let tab = 'outbox';
    let st = await api('/integration/status');
    const top = ctx.actions(`<button id="sync">⇄ Sincronizar ahora</button><button id="meter">Enviar lecturas de odómetro</button><a class="btn" href="${esc(st.config.baseUrl)}" target="_blank" rel="noopener" style="text-decoration:none">Ver tablas JDE ↗</a>`);
    top.querySelector('#sync').onclick = (e) => act(e.target, () => api('/integration/sync', { body: {} }), (r) => (r.ok ? `Sincronizado: ${r.equipos.updated + r.equipos.created} equipos, ${r.inventario.items} artículos, ${r.ordenes.workOrders} OTs` : 'Sincronización con errores')).then(draw);
    top.querySelector('#meter').onclick = (e) => act(e.target, () => api('/integration/meter', { body: {} }), (r) => (r.units ? `Lote de ${r.units} lecturas encolado (P12120)` : 'Sin lecturas nuevas')).then(draw);

    const mapping = await api('/integration/mapping');
    view.innerHTML = `
      <div id="tiles" class="tiles"></div>
      <div class="grid g-2-1 mt" style="align-items:start">
        <div class="card">
          <header><h2>Arquitectura de integración</h2><span class="sub">integración total: cada evento de mantenimiento con impacto en el ERP</span></header>
          <svg viewBox="0 0 760 210" style="width:100%;height:auto" role="img" aria-label="Diagrama de integración">
            <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--ink-2)"/></marker></defs>
            <g font-size="12" fill="var(--ink)">
              <rect x="10" y="20" width="170" height="170" rx="10" fill="var(--surface-2)" stroke="var(--border)"/>
              <text x="95" y="44" text-anchor="middle" font-weight="650">Sistema de mantenimiento</text>
              <text x="95" y="66" text-anchor="middle" fill="var(--ink-2)">OTs · plan preventivo</text>
              <text x="95" y="84" text-anchor="middle" fill="var(--ink-2)">telemetría IoT · KPIs</text>
              <rect x="30" y="104" width="130" height="34" rx="6" fill="var(--surface)" stroke="var(--border)"/><text x="95" y="125" text-anchor="middle">Outbox (FIFO)</text>
              <rect x="30" y="146" width="130" height="34" rx="6" fill="var(--surface)" stroke="var(--border)"/><text x="95" y="167" text-anchor="middle">Sync entrante 60 s</text>
              <rect x="290" y="45" width="170" height="120" rx="10" fill="var(--info-bg)" stroke="var(--border)"/>
              <text x="375" y="72" text-anchor="middle" font-weight="650">AIS Server</text>
              <text x="375" y="92" text-anchor="middle" fill="var(--ink-2)">REST · token jde-AIS-Auth</text>
              <text x="375" y="116" text-anchor="middle" font-weight="650">Orchestrator</text>
              <text x="375" y="136" text-anchor="middle" fill="var(--ink-2)">orquestaciones FLT_*</text>
              <rect x="570" y="20" width="180" height="170" rx="10" fill="var(--surface-2)" stroke="var(--border)"/>
              <text x="660" y="44" text-anchor="middle" font-weight="650">JDE E1 9.2</text>
              <text x="660" y="68" text-anchor="middle" fill="var(--ink-2)">Equipos F1201 · PM F1207</text>
              <text x="660" y="88" text-anchor="middle" fill="var(--ink-2)">OTs F4801 · F3111 · F31122</text>
              <text x="660" y="108" text-anchor="middle" fill="var(--ink-2)">Inventario F4101 · F41021</text>
              <text x="660" y="128" text-anchor="middle" fill="var(--ink-2)">Cardex F4111</text>
              <text x="660" y="148" text-anchor="middle" fill="var(--ink-2)">Compras F4311</text>
              <text x="660" y="168" text-anchor="middle" fill="var(--ink-2)">Contabilidad F0911</text>
            </g>
            <g stroke="var(--ink-2)" stroke-width="1.5" fill="none">
              <path d="M160,121 L288,95" marker-end="url(#ar)"/><path d="M460,95 L568,80" marker-end="url(#ar)"/>
              <path d="M568,140 L460,130" marker-end="url(#ar)"/><path d="M288,135 L162,163" marker-end="url(#ar)"/>
            </g>
            <g font-size="11" fill="var(--muted)"><text x="222" y="98" text-anchor="middle">POST orquestación</text><text x="514" y="78" text-anchor="middle">BSFN</text><text x="222" y="166" text-anchor="middle">consulta maestros</text></g>
          </svg>
          <div class="note mt">Cada operación se graba en la cola de salida en la misma transacción que el cambio local; un proceso la envía en orden. Ante caídas del ERP o timeouts se reintenta con espera exponencial sin perder ni desordenar mensajes. Los errores de validación de JDE quedan marcados para revisión.</div>
        </div>
        <div class="card">
          <header><h2>Conexión AIS</h2><span id="health"></span></header>
          <div class="form" id="cfg">
            <label class="f full">URL del AIS Server<input name="baseUrl" value="${esc(st.config.baseUrl)}"></label>
            <label class="f">Usuario<input name="username" value="${esc(st.config.username)}"></label>
            <label class="f">Contraseña<input name="password" type="password" value="${esc(st.config.password)}"></label>
            <label class="f">Entorno<input name="environment" value="${esc(st.config.environment)}"></label>
            <label class="f">Rol<input name="role" value="${esc(st.config.role)}"></label>
          </div>
          <div class="row mt"><button class="primary" id="save">Guardar y probar</button></div>
          <h3 class="mt">Pruebas de resiliencia</h3>
          <div class="row mt">
            <button id="outage">Simular caída de JDE</button>
            <button id="pause">Pausar envíos</button>
            <button id="retry">Reintentar errores</button>
          </div>
          <div class="small muted mt">«Simular caída» hace que el AIS simulado responda 503: las operaciones del taller siguen funcionando y se encolan hasta que JDE vuelve.</div>
        </div>
      </div>
      <div class="card mt">
        <header><div class="seg" id="tabs"><button data-t="outbox" class="on">Cola saliente</button><button data-t="log">Registro de llamadas</button><button data-t="map">Mapa de integración</button></div><span class="sub" id="tabsub"></span></header>
        <div id="tab"></div>
      </div>`;

    const outageState = { on: false };
    view.querySelector('#save').onclick = async (e) => {
      const body = Object.fromEntries([...view.querySelectorAll('#cfg input')].map((i) => [i.name, i.value]));
      st = await act(e.target, () => api('/integration/config', { method: 'PUT', body }), (r) => (r.health.ok ? 'Conexión AIS verificada' : 'No se pudo conectar con el AIS Server')) || st;
      draw();
    };
    view.querySelector('#outage').onclick = async (e) => {
      const r = await act(e.target, () => api('/integration/outage', { body: { on: !outageState.on } }));
      if (r) { outageState.on = r.outage; toast(r.outage ? 'JDE no disponible (simulado). Opere el taller y observe la cola.' : 'JDE restablecido: la cola se vacía automáticamente', r.outage ? 'err' : 'ok'); draw(); }
    };
    view.querySelector('#pause').onclick = async (e) => {
      const r = await act(e.target, () => api('/integration/pause', { body: { paused: !st.paused } }));
      if (r) { st.paused = r.paused; draw(); }
    };
    view.querySelector('#retry').onclick = (e) => act(e.target, () => api('/integration/retry', { body: {} }), 'Mensajes reencolados').then(draw);
    view.querySelector('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.t; view.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); drawTab(); };

    const stB = { OK: 'good', PENDIENTE: 'warn', REINTENTO: 'warn', ERROR: 'crit' };
    async function drawTab() {
      const el = view.querySelector('#tab');
      if (el.querySelector('details[open]')) return;
      if (tab === 'map') {
        view.querySelector('#tabsub').textContent = `${mapping.length} procesos integrados`;
        el.innerHTML = `<div class="tw"><table class="t"><thead><tr><th>Proceso</th><th>Sentido</th><th>Orquestación AIS</th><th>Objetos JDE</th><th>Disparador</th></tr></thead><tbody>
          ${mapping.map((m) => `<tr><td><b>${esc(m.process)}</b></td><td><span class="b ${m.direction.startsWith('JDE') ? 'info' : 'plain'}">${esc(m.direction)}</span></td><td class="mono">${esc(m.orchestration)}</td><td class="small">${esc(m.jde)}</td><td class="small ink2">${esc(m.when)}</td></tr>`).join('')}</tbody></table></div>`;
      } else if (tab === 'outbox') {
        const rows = await api('/integration/outbox');
        if (!ctx.alive() || tab !== 'outbox') return;
        view.querySelector('#tabsub').textContent = 'últimos 200 mensajes';
        el.innerHTML = `<div class="tw" style="max-height:520px;overflow:auto"><table class="t"><thead><tr><th>#</th><th>Creado</th><th>Orquestación</th><th>Entidad</th><th>Estado</th><th class="num">Intentos</th><th>Detalle</th><th></th></tr></thead><tbody>
          ${rows.map((o) => `<tr><td class="num">${o.id}</td><td class="small">${dt(o.created_at)}</td><td class="mono">${esc(o.orchestration)}</td>
            <td class="small">${o.entity === 'WO' ? `<a href="#/ordenes/${o.entity_id}">OT ${o.entity_id}</a>` : esc(o.entity)}${o.entity === 'REQ' ? ' ' + o.entity_id : ''}</td>
            <td><span class="b ${stB[o.status]}">${esc(o.status)}</span></td><td class="num">${o.attempts}</td>
            <td class="small">${o.last_error ? `<span class="delta bad">${esc(o.last_error)}</span>` : ''}<details><summary class="muted">payload</summary><pre class="json">${esc(JSON.stringify(JSON.parse(o.payload), null, 1))}</pre>${o.response ? `<pre class="json">${esc(o.response)}</pre>` : ''}</details></td>
            <td>${['ERROR', 'REINTENTO'].includes(o.status) ? `<button class="small" data-r="${o.id}">Reintentar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Sin mensajes</td></tr>'}</tbody></table></div>`;
        el.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => act(b, () => api('/integration/retry', { body: { id: Number(b.dataset.r) } })).then(drawTab));
      } else {
        const rows = await api('/integration/log?limit=150');
        if (!ctx.alive() || tab !== 'log') return;
        view.querySelector('#tabsub').textContent = 'llamadas HTTP al AIS Server';
        el.innerHTML = `<div class="tw" style="max-height:520px;overflow:auto"><table class="t"><thead><tr><th>Hora</th><th>Sentido</th><th>Endpoint</th><th class="num">HTTP</th><th class="num">ms</th><th>Detalle</th></tr></thead><tbody>
          ${rows.map((l) => `<tr><td class="small">${dt(l.ts)}</td><td><span class="b ${l.direction === 'IN' ? 'info' : 'plain'}">${l.direction === 'IN' ? 'JDE → CMMS' : 'CMMS → JDE'}</span></td>
            <td class="mono">${l.orchestration === 'tokenrequest' ? 'POST /jderest/v2/tokenrequest' : 'POST /jderest/v3/orchestrator/' + esc(l.orchestration)}</td>
            <td class="num"><span class="b ${l.ok ? 'good' : 'crit'}">${l.http_status || 'red'}</span></td><td class="num">${l.duration_ms}</td>
            <td><details class="small"><summary class="muted">request / response</summary><pre class="json">${esc(l.request || '')}</pre><pre class="json">${esc(l.response || '')}</pre></details></td></tr>`).join('')}</tbody></table></div>`;
      }
    }

    async function draw() {
      st = await api('/integration/status');
      if (!ctx.alive()) return;
      outageState.on = !!(await api('/integration/outage')).outage;
      const o = st.outbox;
      view.querySelector('#tiles').innerHTML = `
        <div class="tile"><div class="k">AIS Server</div><div class="v" style="font-size:18px;margin:8px 0">${st.health.ok ? '<span class="b good"><span class="sev-ico">●</span>En línea</span>' : '<span class="b crit"><span class="sev-ico">▲</span>Sin conexión</span>'}</div>
          <div class="d">${st.health.ok ? `${esc(st.health.info?.aisVersion || '')} · ${st.health.latencyMs} ms` : esc(st.health.error || 'HTTP ' + st.health.status)}</div></div>
        <div class="tile"><div class="k">Pendientes de envío</div><div class="v">${(o.PENDIENTE || 0) + (o.REINTENTO || 0)}</div><div class="d">${o.REINTENTO ? `${o.REINTENTO} en reintento${st.retryAt ? ' · próximo ' + new Date(st.retryAt).toLocaleTimeString('es-AR') : ''}` : st.paused ? 'envíos pausados' : 'cola al día'}</div></div>
        <div class="tile"><div class="k">Con error de validación</div><div class="v">${o.ERROR || 0}</div><div class="d">requieren revisión</div></div>
        <div class="tile"><div class="k">Mensajes enviados</div><div class="v">${num(o.OK || 0)}</div><div class="d">${num(st.calls24h.n || 0)} llamadas en 24 h · ${num(st.calls24h.avg || 0)} ms prom.</div></div>
        <div class="tile"><div class="k">Última sincronización</div><div class="v" style="font-size:18px;margin:8px 0">${st.lastSync ? ago(st.lastSync.at) : '—'}</div><div class="d">${st.lastSync ? (st.lastSync.ok ? 'equipos, inventario, OTs y compras' : 'con errores') : ''}</div></div>`;
      view.querySelector('#health').innerHTML = `<span class="b plain">${esc(st.config.environment)} · ${esc(st.config.role)}</span>`;
      view.querySelector('#outage').textContent = outageState.on ? '✓ Restablecer JDE' : 'Simular caída de JDE';
      view.querySelector('#outage').classList.toggle('danger', outageState.on);
      view.querySelector('#pause').textContent = st.paused ? '▶ Reanudar envíos' : 'Pausar envíos';
      drawTab();
    }
    await draw();
    ctx.every(4000, draw);
  },
};
