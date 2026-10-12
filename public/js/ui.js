// Utilidades de interfaz: API, formato, badges, modales, avisos, tooltip.
export const api = async (path, opts = {}) => {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = (d) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : nf(d).format(n));
export const km = (n) => (n === null || n === undefined ? '—' : `${num(n)} km`);
export const pct = (x, d = 1) => (x === null || x === undefined ? '—' : `${num(x * 100, d)}%`);
export const usd = (n, d = 0) => (n === null || n === undefined ? '—' : `US$ ${num(n, d)}`);
export const hrs = (n, d = 1) => (n === null || n === undefined ? '—' : `${num(n, d)} h`);
export const date = (s) => (s ? new Date(s).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
export const dt = (s) => (s ? new Date(s).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const ago = (s) => {
  if (!s) return '—';
  const m = Math.round((Date.now() - new Date(s)) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
};

export let META = null;
export async function loadMeta(force) { if (!META || force) META = await api('/meta'); return META; }

export const TYPE_LABEL = { PREVENTIVO: 'Preventivo', CORRECTIVO: 'Correctivo', PREDICTIVO: 'Predictivo', PROACTIVO: 'Proactivo', CONDICION: 'Basado en condición', DETECTIVO: 'Detectivo', AUTONOMO: 'Autónomo' };
export const STAGE_LABEL = { ORDEN: 'Orden de trabajo', DIAGNOSTICO: 'Diagnóstico', REPUESTOS: 'Repuestos', REPARACION: 'Reparación', CONTROL: 'Control y cierre', CERRADA: 'Cerrada' };
export const ORIGIN_LABEL = { CONDUCTOR: 'Conductor', INSPECCION: 'Inspección', SENSOR: 'Sensor IoT', PLAN: 'Plan preventivo' };

// Estados: color + ícono + texto (nunca sólo color)
export function unitStatus(s) {
  const m = { DISPONIBLE: ['good', '●', 'Disponible'], EN_TALLER: ['warn', '◐', 'En taller'], FUERA_SERVICIO: ['crit', '■', 'Fuera de servicio'] }[s] || ['plain', '○', s];
  return `<span class="b ${m[0]}"><span class="sev-ico">${m[1]}</span>${m[2]}</span>`;
}
export function sev(s) {
  const m = { CRITICA: ['crit', '▲', 'Crítica'], ADVERTENCIA: ['warn', '◆', 'Advertencia'], PREDICTIVA: ['info', '◭', 'Predictiva'] }[s] || ['plain', '○', s];
  return `<span class="b ${m[0]}"><span class="sev-ico">${m[1]}</span>${m[2]}</span>`;
}
export function pmStatus(s) {
  const m = { OK: ['good', '●', 'Al día'], PROXIMO: ['info', '◷', 'Próximo'], EN_TOLERANCIA: ['warn', '◆', 'En tolerancia'], VENCIDO: ['crit', '▲', 'Vencido'] }[s] || ['plain', '○', s || '—'];
  return `<span class="b ${m[0]}"><span class="sev-ico">${m[1]}</span>${m[2]}</span>`;
}
export function prio(p) {
  return p === 1 ? '<span class="b crit"><span class="sev-ico">▲</span>P1 crítica</span>' : p === 2 ? '<span class="b warn"><span class="sev-ico">◆</span>P2 alta</span>' : '<span class="b plain">P3 normal</span>';
}
export function typeBadge(t) {
  return `<span class="b plain">${esc(TYPE_LABEL[t] || t)}</span>`;
}
export function stageBadge(s) {
  return `<span class="b ${s === 'CERRADA' ? 'good' : 'plain'}">${esc(STAGE_LABEL[s] || s)}</span>`;
}
export function syncBadge(state, doco) {
  if (state === 'OK') return `<span class="b good" title="Sincronizada con JDE"><span class="sev-ico">⇄</span>${doco ? 'JDE ' + doco : 'JDE OK'}</span>`;
  if (state === 'ERROR') return '<span class="b crit"><span class="sev-ico">▲</span>Error JDE</span>';
  return '<span class="b warn"><span class="sev-ico">◷</span>Pendiente JDE</span>';
}
export function critBadge(c) {
  return c === 'A' ? '<span class="b crit">A · crítico</span>' : c === 'B' ? '<span class="b warn">B · importante</span>' : '<span class="b plain">C · general</span>';
}

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4000);
}

export function modal(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(bg);
  onMount && onMount(bg.querySelector('.modal'), close);
  bg.querySelector('input,select,textarea')?.focus();
  return close;
}

// Ejecuta una acción con feedback y manejo de errores
export async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Tooltip global
const tt = () => document.getElementById('tt');
export function showTip(html, x, y) {
  const el = tt();
  el.innerHTML = html;
  el.classList.add('on');
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
export function hideTip() { tt().classList.remove('on'); }
// Tooltips declarativos: data-tip="html"
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t) showTip(t.getAttribute('data-tip'), e.clientX, e.clientY);
  else if (!e.target.closest?.('.chart svg')) hideTip();
});

export const unitLink = (id, no) => `<a href="#/flota/${id}">Int. ${esc(no)}</a>`;
export const woLink = (id) => `<a href="#/ordenes/${id}">OT ${id}</a>`;
