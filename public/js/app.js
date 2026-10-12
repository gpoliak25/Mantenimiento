// Enrutador de la SPA y elementos comunes del layout.
import { api, loadMeta } from './ui.js';
import dashboard from './pages/dashboard.js';
import fleet from './pages/fleet.js';
import unit from './pages/unit.js';
import orders from './pages/orders.js';
import order from './pages/order.js';
import pm from './pages/pm.js';
import inspection from './pages/inspection.js';
import telemetry from './pages/telemetry.js';
import predictive from './pages/predictive.js';
import parts from './pages/parts.js';
import kpis from './pages/kpis.js';
import integration from './pages/integration.js';

const ROUTES = {
  '': dashboard, flota: fleet, 'flota/:id': unit, ordenes: orders, 'ordenes/:id': order, preventivo: pm, inspeccion: inspection,
  telemetria: telemetry, predictivo: predictive, repuestos: parts, kpis, integracion: integration,
};

const view = document.getElementById('view');
let timers = [];
let seq = 0;

function resolve() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  if (parts.length === 2 && ROUTES[`${parts[0]}/:id`]) return { page: ROUTES[`${parts[0]}/:id`], key: parts[0], params: { id: parts[1] } };
  return { page: ROUTES[parts[0] || ''] || dashboard, key: parts[0] || '', params: {} };
}

async function render() {
  timers.forEach(clearInterval);
  timers = [];
  const my = ++seq;
  const { page, key, params } = resolve();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === key));
  document.getElementById('title').textContent = page.title;
  document.getElementById('crumb').textContent = page.crumb || '';
  document.getElementById('topActions').innerHTML = '';
  view.innerHTML = '<div class="empty">Cargando…</div>';
  const ctx = {
    alive: () => my === seq,
    every: (ms, fn) => timers.push(setInterval(() => { if (my === seq && !document.hidden) fn(); }, ms)),
    setTitle: (t, crumb) => { document.getElementById('title').textContent = t; if (crumb !== undefined) document.getElementById('crumb').innerHTML = crumb; },
    actions: (html) => { const el = document.getElementById('topActions'); el.innerHTML = html; return el; },
    rerender: render,
  };
  try {
    await loadMeta();
    await page.render(view, params, ctx);
  } catch (e) {
    console.error(e);
    if (my === seq) view.innerHTML = `<div class="card empty">No se pudo cargar la vista: ${e.message}</div>`;
  }
  window.scrollTo(0, 0);
}

// Estado de la conexión con JDE en la barra lateral
async function jdePill() {
  const el = document.getElementById('jdePill');
  try {
    const s = await api('/integration/status');
    const pend = (s.outbox.PENDIENTE || 0) + (s.outbox.REINTENTO || 0);
    const cls = !s.health.ok ? 'down' : pend || s.outbox.ERROR ? 'warn' : 'ok';
    el.className = 'jde-pill ' + cls;
    el.textContent = !s.health.ok ? 'JDE 9.2 · sin conexión' : pend ? `JDE 9.2 · ${pend} en cola` : s.outbox.ERROR ? `JDE 9.2 · ${s.outbox.ERROR} error(es)` : 'JDE 9.2 · conectado';
    el.title = `AIS ${s.config.baseUrl} · entorno ${s.config.environment}`;
  } catch { el.className = 'jde-pill down'; el.textContent = 'JDE 9.2 · sin conexión'; }
}

// Tema claro / oscuro (respeta el sistema operativo salvo elección explícita)
const themeBtn = document.getElementById('themeBtn');
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  themeBtn.textContent = dark ? '☀ Claro' : '☾ Oscuro';
}
let theme = null;
try { theme = localStorage.getItem('theme'); } catch { /* sin almacenamiento */ }
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', theme); } catch { /* noop */ }
  applyTheme(theme);
  render();
});

window.addEventListener('hashchange', render);
render();
jdePill();
setInterval(jdePill, 5000);
