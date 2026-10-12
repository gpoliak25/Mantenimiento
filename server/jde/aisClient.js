// Cliente REST del AIS Server de JD Edwards EnterpriseOne 9.2.
// Funciona igual contra el simulador local o contra un AIS Server real:
// sólo cambian la URL, las credenciales y el entorno (pantalla Integración JDE).
const { run, nowIso, getSetting } = require('../db');

const DEFAULTS = {
  baseUrl: process.env.JDE_AIS_URL || 'http://localhost:8091',
  username: process.env.JDE_USER || 'JDE',
  password: process.env.JDE_PASSWORD || 'JDE',
  environment: process.env.JDE_ENV || 'JDV920',
  role: process.env.JDE_ROLE || '*ALL',
  deviceName: 'FlotaCMMS',
  timeoutMs: 15000,
};

function config() {
  return { ...DEFAULTS, ...getSetting('jde', {}) };
}

class AisError extends Error {
  constructor(message, status, retryable) { super(message); this.status = status; this.retryable = retryable; }
}

let session = null; // { token, baseUrl, user, at }

function log(direction, orchestration, status, ok, ms, request, response) {
  const trim = (o) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s && s.length > 4000 ? s.slice(0, 4000) + '…' : s; };
  const safeReq = request && request.password ? { ...request, password: '••••' } : request;
  run('INSERT INTO integration_log (ts,direction,orchestration,http_status,ok,duration_ms,request,response) VALUES (?,?,?,?,?,?,?,?)',
    nowIso(), direction, orchestration, status, ok ? 1 : 0, ms, trim(safeReq), trim(response));
}

async function http(method, path, body, headers = {}) {
  const cfg = config();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + path, {
      method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, data };
  } catch (e) {
    throw new AisError(e.name === 'AbortError' ? 'Tiempo de espera agotado con AIS Server' : `AIS Server inaccesible: ${e.cause?.code || e.message}`, 0, true);
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const cfg = config();
  const body = { username: cfg.username, password: cfg.password, deviceName: cfg.deviceName, environment: cfg.environment, role: cfg.role };
  const t0 = Date.now();
  const r = await http('POST', '/jderest/v2/tokenrequest', body);
  log('OUT', 'tokenrequest', r.status, r.status === 200, Date.now() - t0, body, r.status === 200 ? { userInfo: { token: '••••' } } : r.data);
  if (r.status !== 200) throw new AisError(r.data?.message || `Autenticación AIS rechazada (${r.status})`, r.status, r.status >= 500);
  session = { token: r.data.userInfo.token, baseUrl: cfg.baseUrl, user: cfg.username, at: Date.now() };
  return session;
}

// Ejecuta una orquestación: POST /jderest/v3/orchestrator/{name}
async function orchestrate(name, input = {}, { direction = 'OUT' } = {}) {
  const cfg = config();
  if (!session || session.baseUrl !== cfg.baseUrl || session.user !== cfg.username) await login();
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    let r;
    try {
      r = await http('POST', `/jderest/v3/orchestrator/${name}`, input, { 'jde-AIS-Auth': session.token });
    } catch (e) {
      log(direction, name, 0, false, Date.now() - t0, input, { message: e.message });
      throw e;
    }
    if (r.status === 401 && attempt === 0) { log(direction, name, 401, false, Date.now() - t0, input, r.data); await login(); continue; }
    log(direction, name, r.status, r.status === 200, Date.now() - t0, input, r.data);
    if (r.status !== 200) throw new AisError(r.data?.message || `Error AIS ${r.status}`, r.status, r.status >= 500 || r.status === 429);
    return r.data;
  }
}

async function health() {
  const t0 = Date.now();
  try {
    const r = await http('GET', '/jderest/v2/defaultconfig');
    return { ok: r.status === 200, status: r.status, latencyMs: Date.now() - t0, info: r.data, session: !!session };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - t0, error: e.message, session: false };
  }
}

function resetSession() { session = null; }

module.exports = { orchestrate, health, config, resetSession, AisError, DEFAULTS };
