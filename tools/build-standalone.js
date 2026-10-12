// Genera una demo autónoma (un solo .html, sin servidor) a partir del MVP en ejecución:
//  1. toma una instantánea de la API (http://localhost:3100)
//  2. empaqueta los módulos de /public en un único script
//  3. reemplaza fetch('/api/...') por respuestas de la instantánea
// Uso: npm start (en otra terminal) y luego  node tools/build-standalone.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.API || 'http://localhost:3100';
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'entregables');
const OUT = path.join(OUT_DIR, 'Demo-Mantenimiento-Flota.html');

async function snapshot() {
  const get = async (p) => {
    const r = await fetch(BASE + '/api' + p);
    if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
    return r.json();
  };
  const snap = {};
  const keys = [
    '/meta', '/dashboard', '/units', '/workorders?limit=400', '/pm', '/kits', '/parts', '/requisitions',
    '/telemetry', '/alerts?limit=40', '/alerts?status=open', '/predictive', '/inspections',
    '/kpis?days=30', '/kpis?days=90', '/kpis?days=180',
    '/integration/status', '/integration/outbox', '/integration/log?limit=150', '/integration/mapping', '/integration/outage',
  ];
  for (const k of keys) snap[k] = await get(k);
  for (const u of snap['/units']) {
    snap[`/units/${u.id}`] = await get(`/units/${u.id}`);
    snap[`/telemetry/${u.id}`] = await get(`/telemetry/${u.id}`);
  }
  for (const w of snap['/workorders?limit=400']) snap[`/workorders/${w.id}`] = await get(`/workorders/${w.id}`);
  return snap;
}

// Convierte módulos ES en bloques con alcance propio dentro de un único script
function bundle() {
  const order = [
    ['ui', 'js/ui.js'], ['charts', 'js/charts.js'], ['dashboard', 'js/pages/dashboard.js'], ['orders', 'js/pages/orders.js'],
    ['unit', 'js/pages/unit.js'], ['order', 'js/pages/order.js'], ['fleet', 'js/pages/fleet.js'], ['pm', 'js/pages/pm.js'],
    ['inspection', 'js/pages/inspection.js'], ['telemetry', 'js/pages/telemetry.js'], ['predictive', 'js/pages/predictive.js'],
    ['parts', 'js/pages/parts.js'], ['kpis', 'js/pages/kpis.js'], ['integration', 'js/pages/integration.js'], ['app', 'js/app.js'],
  ];
  const fileToMod = Object.fromEntries(order.map(([m, f]) => [path.basename(f), m]));
  let out = '';
  for (const [mod, file] of order) {
    let src = fs.readFileSync(path.join(PUB, file), 'utf8');
    const exportsList = [];
    // import { a, b } from './x.js'  →  const { a, b } = __m_x;   (import x from → const x = __m_x.default)
    src = src.replace(/^import\s+\{([^}]+)\}\s+from\s+'([^']+)';?$/gm, (_, names, from) => {
      const m = fileToMod[path.basename(from)];
      const list = names.split(',').map((s) => s.trim()).filter((s) => s && s !== 'META');
      return `const { ${list.join(', ')} } = __m_${m};`;
    });
    src = src.replace(/^import\s+(\w+)\s+from\s+'([^']+)';?$/gm, (_, name, from) => `const ${name} = __m_${fileToMod[path.basename(from)]}.default;`);
    // META es una exportación "viva" de ui.js: se accede por la propiedad
    if (mod !== 'ui') src = src.replace(/\bMETA\b/g, '__m_ui.META');
    src = src.replace(/^export\s+default\s+/m, 'const __default = ');
    src = src.replace(/^export\s+(async\s+function|function|const|let)\s+(\w+)/gm, (_, kw, name) => { exportsList.push(name); return `${kw} ${name}`; });
    const exp = exportsList.map((n) => (n === 'META' ? 'get META() { return META; }' : n));
    if (/const __default = /.test(src)) exp.push('default: __default');
    out += `\n// ---- ${file}\nconst __m_${mod} = (() => {\n${src}\nreturn { ${exp.join(', ')} };\n})();\n`;
  }
  return out;
}

const SHIM = `
// ---- API simulada desde la instantánea (demo sin servidor)
(function () {
  const SNAP = window.__SNAP__;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function resolve(p) {
    if (SNAP[p]) return SNAP[p];
    const [base, q] = p.split('?');
    const qs = new URLSearchParams(q || '');
    if (base === '/workorders') {
      let rows = SNAP['/workorders?limit=400'];
      if (qs.get('open') === '1') rows = rows.filter((w) => w.stage !== 'CERRADA');
      if (qs.get('type')) rows = rows.filter((w) => w.type === qs.get('type'));
      if (qs.get('unit_id')) rows = rows.filter((w) => String(w.unit_id) === qs.get('unit_id'));
      return rows;
    }
    if (base === '/kpis') return SNAP['/kpis?days=' + (qs.get('days') || 90)];
    if (base === '/alerts') return qs.get('status') === 'open' ? SNAP['/alerts?status=open'] : SNAP['/alerts?limit=40'];
    if (base === '/integration/log') return SNAP['/integration/log?limit=150'];
    if (base === '/integration/outbox') return SNAP['/integration/outbox'];
    return SNAP[base];
  }
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/api')) return json(404, { error: 'No disponible en la demo' });
    const method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET') return json(400, { error: 'Demo sin servidor: esta acción requiere ejecutar el MVP (npm start) para registrarla y enviarla a JDE.' });
    const r = resolve(u.slice(4));
    return r === undefined ? json(404, { error: 'Dato no incluido en la instantánea de la demo' }) : json(200, clone(r));
  };
})();
`;

(async () => {
  console.log('Tomando instantánea de la API…');
  const snap = await snapshot();
  const when = new Date().toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8') + `
.demo-banner { position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px; z-index: 30; background: var(--ink); color: var(--surface); font-size: 12px; padding: 7px 14px; border-radius: 999px; box-shadow: 0 6px 24px rgba(0,0,0,.25); max-width: calc(100vw - 32px); text-align: center; }`;
  let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  html = html.replace('<link rel="stylesheet" href="/styles.css">', () => `<style>\n${css}\n</style>`);
  html = html.replace('<title>Mantenimiento de Flota</title>', '<title>Mantenimiento de Flota · Demo</title>');
  html = html.replace('<script type="module" src="/js/app.js"></script>', () =>
    `<div class="demo-banner">Demo sin servidor · instantánea del ${when} · las acciones requieren ejecutar el MVP</div>\n` +
    `<script>window.__SNAP__ = ${JSON.stringify(snap).replace(/</g, '\\u003c')};</script>\n<script>${SHIM}</script>\n<script type="module">${bundle()}</script>`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`Demo generada: ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
})().catch((e) => { console.error('Error:', e.message, '\n¿Está el MVP en ejecución (npm start)?'); process.exit(1); });
