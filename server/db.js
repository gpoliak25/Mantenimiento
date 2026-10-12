// Base de datos local del sistema de gestión del mantenimiento (CMMS).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'flota.db'));
db.exec('PRAGMA journal_mode=WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY, unit_no TEXT UNIQUE, jde_asset INTEGER, plate TEXT, brand TEXT, model TEXT, year INTEGER,
  powertrain TEXT, depot TEXT, line TEXT, odometer_km REAL, meter_sent_km REAL DEFAULT 0, status TEXT DEFAULT 'DISPONIBLE',
  jde_status TEXT, in_service_date TEXT, last_sync TEXT
);
CREATE TABLE IF NOT EXISTS km_log (unit_id INTEGER, day TEXT, km REAL, PRIMARY KEY (unit_id, day));

CREATE TABLE IF NOT EXISTS pm_plans (
  id INTEGER PRIMARY KEY, level TEXT UNIQUE, name TEXT, interval_km REAL, interval_days INTEGER, std_hours REAL,
  jde_service_type TEXT, rank INTEGER, tasks TEXT, kit TEXT
);
CREATE TABLE IF NOT EXISTS pm_schedule (unit_id INTEGER, plan_id INTEGER, last_km REAL, last_date TEXT, PRIMARY KEY (unit_id, plan_id));

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY, unit_id INTEGER, type TEXT, origin TEXT, system TEXT, title TEXT, symptom TEXT,
  diagnosis TEXT, root_cause TEXT, priority INTEGER DEFAULT 3, stage TEXT, road_call INTEGER DEFAULT 0,
  immobilized INTEGER DEFAULT 1, km_at REAL, plan_id INTEGER, due_km REAL, alert_id INTEGER, inspection_id INTEGER,
  created_at TEXT, started_at TEXT, closed_at TEXT,
  jde_doco INTEGER, jde_status TEXT, jde_cost REAL, sync_state TEXT DEFAULT 'PENDIENTE'
);
CREATE INDEX IF NOT EXISTS ix_wo_unit ON work_orders(unit_id);
CREATE INDEX IF NOT EXISTS ix_wo_created ON work_orders(created_at);
CREATE TABLE IF NOT EXISTS wo_parts (id INTEGER PRIMARY KEY, wo_id INTEGER, item_no TEXT, qty REAL, unit_cost REAL, issued REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wo_labor (id INTEGER PRIMARY KEY, wo_id INTEGER, tech_an8 INTEGER, tech TEXT, hours REAL, rate REAL, day TEXT);
CREATE TABLE IF NOT EXISTS wo_events (id INTEGER PRIMARY KEY, wo_id INTEGER, ts TEXT, stage TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS technicians (an8 INTEGER PRIMARY KEY, name TEXT, specialty TEXT, rate REAL);

CREATE TABLE IF NOT EXISTS parts (
  item_no TEXT PRIMARY KEY, description TEXT, system TEXT, criticality TEXT, on_hand REAL, safety_stock REAL,
  reorder_qty REAL, unit_cost REAL, lead_days INTEGER, rotable INTEGER DEFAULT 0, supplier INTEGER, supplier_name TEXT, last_sync TEXT
);
CREATE TABLE IF NOT EXISTS requisitions (
  id INTEGER PRIMARY KEY, item_no TEXT, qty REAL, reason TEXT, wo_id INTEGER, created_at TEXT, jde_doco INTEGER, jde_status TEXT, sync_state TEXT DEFAULT 'PENDIENTE'
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, unit_id INTEGER, ts TEXT, metric TEXT, system TEXT, kind TEXT, severity TEXT,
  message TEXT, value REAL, status TEXT DEFAULT 'ABIERTA', wo_id INTEGER
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY, unit_id INTEGER, driver TEXT, ts TEXT, odometer_km REAL, items TEXT, defects INTEGER, wo_id INTEGER
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, orchestration TEXT, entity TEXT, entity_id INTEGER, payload TEXT, status TEXT DEFAULT 'PENDIENTE',
  attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT, sent_at TEXT, response TEXT
);
CREATE TABLE IF NOT EXISTS integration_log (
  id INTEGER PRIMARY KEY, ts TEXT, direction TEXT, orchestration TEXT, http_status INTEGER, ok INTEGER,
  duration_ms INTEGER, request TEXT, response TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const nowIso = () => new Date().toISOString();

function getSetting(key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? JSON.parse(r.value) : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// node:sqlite devuelve objetos con prototipo nulo; los normalizamos para JSON
const plain = (o) => (o ? { ...o } : o);
const all = (sql, ...a) => db.prepare(sql).all(...a).map(plain);
const get = (sql, ...a) => plain(db.prepare(sql).get(...a));
const run = (sql, ...a) => db.prepare(sql).run(...a);

module.exports = { db, all, get, run, tx, nowIso, getSetting, setSetting };
