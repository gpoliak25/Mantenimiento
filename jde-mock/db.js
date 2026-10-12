// Base de datos del simulador de JD Edwards EnterpriseOne 9.2.
// Reproduce (simplificadas) las tablas estándar involucradas en Capital Asset
// Management / Equipment Maintenance, Inventario, Compras y Contabilidad.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'jde.db'));
db.exec('PRAGMA journal_mode=WAL;');

db.exec(`
-- Address Book Master (técnicos = E, proveedores = V)
CREATE TABLE IF NOT EXISTS F0101 (AN8 INTEGER PRIMARY KEY, ALPH TEXT, AT1 TEXT);

-- Asset Master (Equipment Master P1701)
CREATE TABLE IF NOT EXISTS F1201 (
  NUMB INTEGER PRIMARY KEY,   -- Asset Item Number (número corto)
  ASII TEXT UNIQUE,           -- Unit Number (número de interno)
  DL01 TEXT,                  -- Descripción
  MCU  TEXT,                  -- Business Unit / cochera
  EQST TEXT,                  -- Equipment Status (UDC 12/ES): AV, IR, DN
  ASID TEXT,                  -- Serial / dominio
  MANU TEXT, MODL TEXT, YEAR INTEGER,
  ACL1 TEXT,                  -- Categoría 1: DIESEL / ELECTRICO
  ACL2 TEXT,                  -- Categoría 2: línea
  DAJ  INTEGER,               -- Fecha de alta (juliana JDE)
  UPMJ INTEGER                -- Fecha de última actualización
);

-- Lecturas de medidor (P12120 Meter Readings)
CREATE TABLE IF NOT EXISTS F1201_MTR (NUMB INTEGER PRIMARY KEY, MTR1 REAL, DTE INTEGER);

-- Maintenance Schedule (P1207 PM Schedule)
CREATE TABLE IF NOT EXISTS F1207 (
  NUMB INTEGER, SRVT TEXT, DSC TEXT,
  IKM REAL,            -- Intervalo en km
  IDY INTEGER,         -- Intervalo en días
  LSTM REAL,           -- Medidor de la última ejecución
  LSTD INTEGER,        -- Fecha de la última ejecución
  PMST TEXT,           -- Estado PM (01 programado, 50 OT generada, 99 completo)
  PRIMARY KEY (NUMB, SRVT)
);

-- Work Order Master (P48201 / P13714)
CREATE TABLE IF NOT EXISTS F4801 (
  DOCO INTEGER PRIMARY KEY,
  DCTO TEXT DEFAULT 'WM',
  TYPS TEXT,           -- Tipo de OT (UDC 00/TY)
  NUMB INTEGER,        -- Equipo
  DL01 TEXT,
  SRST TEXT,           -- Estado (UDC 00/SS)
  PRTS TEXT,           -- Prioridad
  MCU  TEXT,
  SRVT TEXT,           -- Service type si proviene de PM
  TRDJ INTEGER,        -- Fecha de alta
  STRT INTEGER,        -- Fecha de inicio
  ADAT INTEGER,        -- Fecha de cierre
  MTR1 REAL,           -- Medidor al momento de la OT
  RCAU TEXT,           -- Causa raíz
  HRSA REAL DEFAULT 0, -- Horas reales
  AMTA REAL DEFAULT 0, -- Costo real
  EXTREF TEXT          -- ID de la OT en el sistema de mantenimiento
);

-- Work Order Parts List
CREATE TABLE IF NOT EXISTS F3111 (
  UKID INTEGER PRIMARY KEY, DOCO INTEGER, LITM TEXT, UORG REAL, TRQT REAL DEFAULT 0, UNCS REAL
);

-- Work Order Time Transactions (horas de mano de obra)
CREATE TABLE IF NOT EXISTS F31122 (
  UKID INTEGER PRIMARY KEY, DOCO INTEGER, AN8 INTEGER, HRSO REAL, RATE REAL, DGL INTEGER
);

-- Item Master / Item Location
CREATE TABLE IF NOT EXISTS F4101 (LITM TEXT PRIMARY KEY, DSC1 TEXT, SRP1 TEXT, STKT TEXT, PRP1 TEXT);
CREATE TABLE IF NOT EXISTS F41021 (
  LITM TEXT, MCU TEXT, PQOH REAL, SAFE REAL, ROQ REAL, UNCS REAL, LTLV INTEGER, VEND INTEGER,
  PRIMARY KEY (LITM, MCU)
);

-- Item Ledger (cardex)
CREATE TABLE IF NOT EXISTS F4111 (
  UKID INTEGER PRIMARY KEY, LITM TEXT, MCU TEXT, DCT TEXT, DOCO INTEGER, TRQT REAL, UNCS REAL, DGL INTEGER
);

-- Purchase Order Detail (requisiciones tipo OR)
CREATE TABLE IF NOT EXISTS F4311 (
  DOCO INTEGER, DCTO TEXT, LNID REAL, LITM TEXT, UORG REAL, AN8 INTEGER, PRRC REAL,
  LTTR TEXT, NXTR TEXT, DRQJ INTEGER, MCU TEXT, PRIMARY KEY (DOCO, DCTO, LNID)
);

-- Account Ledger (costeo de OT)
CREATE TABLE IF NOT EXISTS F0911 (
  UKID INTEGER PRIMARY KEY, DOC INTEGER, DCT TEXT, OBJ TEXT, SUB TEXT, AA REAL, DGL INTEGER, EXA TEXT, ICU INTEGER
);

-- Next Numbers (simplificado)
CREATE TABLE IF NOT EXISTS F0002 (SY TEXT PRIMARY KEY, NNXT INTEGER);
`);

// Fecha juliana JDE: CYYDDD (C = siglo desde 1900)
function toJulian(d = new Date()) {
  const dt = new Date(d);
  const start = new Date(dt.getFullYear(), 0, 0);
  const doy = Math.floor((dt - start) / 86400000);
  return (dt.getFullYear() - 1900) * 1000 + doy;
}
function fromJulian(j) {
  if (!j) return null;
  const y = Math.floor(j / 1000) + 1900;
  const d = new Date(y, 0, 1);
  d.setDate(j % 1000);
  return d.toISOString().slice(0, 10);
}
function nextNumber(sy, start) {
  const row = db.prepare('SELECT NNXT FROM F0002 WHERE SY=?').get(sy);
  if (!row) { db.prepare('INSERT INTO F0002 VALUES (?,?)').run(sy, start + 1); return start; }
  db.prepare('UPDATE F0002 SET NNXT=NNXT+1 WHERE SY=?').run(sy);
  return row.NNXT;
}

module.exports = { db, toJulian, fromJulian, nextNumber };
