// Simulador de JD Edwards EnterpriseOne 9.2 — AIS Server (REST)
// Expone los mismos endpoints que un AIS Server real:
//   POST /jderest/v2/tokenrequest               -> autenticación (token jde-AIS-Auth)
//   GET  /jderest/v2/defaultconfig               -> información del servidor
//   POST /jderest/v3/orchestrator/{orquestación} -> ejecución de orquestaciones
// Las orquestaciones FLT_* son las que habría que construir en Orchestrator Studio
// en el JDE real (ver README). Aquí se ejecutan contra tablas F simuladas.
const http = require('http');
const crypto = require('crypto');
const { db, toJulian, fromJulian, nextNumber } = require('./db');

const USER = process.env.JDE_USER || 'JDE';
const PASS = process.env.JDE_PASSWORD || 'JDE';
const BRANCH = 'M30';
const tokens = new Map(); // token -> expiración
let outage = false;

class BizError extends Error { constructor(msg) { super(msg); this.status = 400; } }
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function woOrThrow(doco) {
  const wo = db.prepare('SELECT * FROM F4801 WHERE DOCO=?').get(num(doco));
  if (!wo) throw new BizError(`Orden de trabajo ${doco} inexistente en F4801`);
  return wo;
}
function equipOrThrow(unit) {
  const eq = db.prepare('SELECT * FROM F1201 WHERE ASII=?').get(String(unit));
  if (!eq) throw new BizError(`Unidad ${unit} inexistente en F1201`);
  return eq;
}
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const orchestrations = {
  FLT_GetEquipmentList() {
    const rows = db.prepare(`SELECT e.*, m.MTR1, m.DTE FROM F1201 e LEFT JOIN F1201_MTR m ON m.NUMB=e.NUMB ORDER BY e.ASII`).all();
    return {
      Equipment: rows.map((r) => ({
        AssetNumber: r.NUMB, UnitNumber: r.ASII, Description: r.DL01, BusinessUnit: r.MCU,
        Status: r.EQST, Serial: r.ASID, Manufacturer: r.MANU, Model: r.MODL, Year: r.YEAR,
        Category: r.ACL1, Line: r.ACL2, InServiceDate: fromJulian(r.DAJ),
        Meter: r.MTR1, MeterDate: fromJulian(r.DTE),
      })),
    };
  },

  FLT_UpdateMeterReadings({ Readings = [] }) {
    const up = db.prepare('INSERT INTO F1201_MTR (NUMB,MTR1,DTE) VALUES (?,?,?) ON CONFLICT(NUMB) DO UPDATE SET MTR1=excluded.MTR1, DTE=excluded.DTE WHERE excluded.MTR1>=F1201_MTR.MTR1');
    let n = 0;
    tx(() => {
      for (const r of Readings) {
        const eq = equipOrThrow(r.UnitNumber);
        up.run(eq.NUMB, Number(r.Meter), toJulian(r.Date || new Date()));
        n++;
      }
    });
    return { Updated: n };
  },

  FLT_UpdateEquipmentStatus({ UnitNumber, Status }) {
    if (!['AV', 'IR', 'DN'].includes(Status)) throw new BizError(`Estado de equipo ${Status} no válido (UDC 12/ES)`);
    const eq = equipOrThrow(UnitNumber);
    db.prepare('UPDATE F1201 SET EQST=?, UPMJ=? WHERE NUMB=?').run(Status, toJulian(), eq.NUMB);
    return { UnitNumber, Status };
  },

  FLT_CreateWorkOrder(i) {
    const eq = equipOrThrow(i.UnitNumber);
    if (!i.Description) throw new BizError('Descripción obligatoria');
    return tx(() => {
      const doco = nextNumber('48', 26000);
      db.prepare(`INSERT INTO F4801 (DOCO,DCTO,TYPS,NUMB,DL01,SRST,PRTS,MCU,SRVT,TRDJ,MTR1,EXTREF)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(doco, 'WM', String(i.Type || '2'), eq.NUMB, String(i.Description).slice(0, 60), '10',
          String(i.Priority || '3'), eq.MCU, i.ServiceType || null, toJulian(i.Date || new Date()), num(i.Meter), i.ExternalId || null);
      if (i.ServiceType) db.prepare("UPDATE F1207 SET PMST='50' WHERE NUMB=? AND SRVT=?").run(eq.NUMB, i.ServiceType);
      return { WorkOrderNumber: doco, OrderType: 'WM', Status: '10' };
    });
  },

  FLT_UpdateWorkOrderStatus({ WorkOrderNumber, Status }) {
    const wo = woOrThrow(WorkOrderNumber);
    if (wo.SRST === '99') throw new BizError(`La OT ${wo.DOCO} está cerrada`);
    const strt = !wo.STRT && Number(Status) >= 20 ? toJulian() : wo.STRT;
    db.prepare('UPDATE F4801 SET SRST=?, STRT=? WHERE DOCO=?').run(String(Status), strt, wo.DOCO);
    return { WorkOrderNumber: wo.DOCO, Status: String(Status) };
  },

  FLT_AddWorkOrderParts({ WorkOrderNumber, Parts = [] }) {
    const wo = woOrThrow(WorkOrderNumber);
    const lines = [];
    tx(() => {
      for (const p of Parts) {
        const loc = db.prepare('SELECT * FROM F41021 WHERE LITM=? AND MCU=?').get(p.ItemNumber, BRANCH);
        if (!loc) throw new BizError(`Artículo ${p.ItemNumber} inexistente en F41021/${BRANCH}`);
        const r = db.prepare('INSERT INTO F3111 (DOCO,LITM,UORG,TRQT,UNCS) VALUES (?,?,?,0,?)').run(wo.DOCO, p.ItemNumber, Number(p.Quantity), loc.UNCS);
        lines.push({ LineId: Number(r.lastInsertRowid), ItemNumber: p.ItemNumber, UnitCost: loc.UNCS, OnHand: loc.PQOH });
      }
    });
    return { WorkOrderNumber: wo.DOCO, Lines: lines };
  },

  FLT_IssueParts({ WorkOrderNumber, ItemNumber, Quantity }) {
    const wo = woOrThrow(WorkOrderNumber);
    const qty = Number(Quantity);
    return tx(() => {
      const loc = db.prepare('SELECT * FROM F41021 WHERE LITM=? AND MCU=?').get(ItemNumber, BRANCH);
      if (!loc) throw new BizError(`Artículo ${ItemNumber} inexistente`);
      if (loc.PQOH < qty) throw new BizError(`Stock insuficiente de ${ItemNumber}: disponible ${loc.PQOH}, solicitado ${qty}`);
      db.prepare('UPDATE F41021 SET PQOH=PQOH-? WHERE LITM=? AND MCU=?').run(qty, ItemNumber, BRANCH);
      db.prepare("INSERT INTO F4111 (LITM,MCU,DCT,DOCO,TRQT,UNCS,DGL) VALUES (?,?,'IM',?,?,?,?)").run(ItemNumber, BRANCH, wo.DOCO, -qty, loc.UNCS, toJulian());
      const line = db.prepare('SELECT UKID FROM F3111 WHERE DOCO=? AND LITM=? AND TRQT<UORG ORDER BY UKID LIMIT 1').get(wo.DOCO, ItemNumber);
      if (line) db.prepare('UPDATE F3111 SET TRQT=TRQT+? WHERE UKID=?').run(qty, line.UKID);
      else db.prepare('INSERT INTO F3111 (DOCO,LITM,UORG,TRQT,UNCS) VALUES (?,?,?,?,?)').run(wo.DOCO, ItemNumber, qty, qty, loc.UNCS);
      return { WorkOrderNumber: wo.DOCO, ItemNumber, Issued: qty, OnHand: loc.PQOH - qty, UnitCost: loc.UNCS };
    });
  },

  FLT_AddLaborHours({ WorkOrderNumber, AddressNumber, Hours, Rate, Date }) {
    const wo = woOrThrow(WorkOrderNumber);
    const ab = db.prepare('SELECT * FROM F0101 WHERE AN8=?').get(num(AddressNumber));
    if (!ab) throw new BizError(`Número de libreta ${AddressNumber} inexistente en F0101`);
    db.prepare('INSERT INTO F31122 (DOCO,AN8,HRSO,RATE,DGL) VALUES (?,?,?,?,?)').run(wo.DOCO, ab.AN8, Number(Hours), Number(Rate || 25), toJulian(Date || new Date()));
    db.prepare('UPDATE F4801 SET HRSA=HRSA+? WHERE DOCO=?').run(Number(Hours), wo.DOCO);
    return { WorkOrderNumber: wo.DOCO, Hours: Number(Hours) };
  },

  FLT_CompleteWorkOrder({ WorkOrderNumber, Meter, RootCause, Date }) {
    const wo = woOrThrow(WorkOrderNumber);
    if (wo.SRST === '99') return { WorkOrderNumber: wo.DOCO, Status: '99', ActualCost: wo.AMTA, AlreadyClosed: true };
    return tx(() => {
      const parts = db.prepare('SELECT COALESCE(SUM(TRQT*UNCS),0) c FROM F3111 WHERE DOCO=?').get(wo.DOCO).c;
      const lab = db.prepare('SELECT COALESCE(SUM(HRSO*RATE),0) c, COALESCE(SUM(HRSO),0) h FROM F31122 WHERE DOCO=?').get(wo.DOCO);
      const total = Math.round((parts + lab.c) * 100) / 100;
      const dgl = toJulian(Date || new Date());
      db.prepare("UPDATE F4801 SET SRST='99', ADAT=?, AMTA=?, HRSA=?, RCAU=?, MTR1=COALESCE(?,MTR1) WHERE DOCO=?")
        .run(dgl, total, lab.h, RootCause || null, num(Meter), wo.DOCO);
      const eq = db.prepare('SELECT ASII FROM F1201 WHERE NUMB=?').get(wo.NUMB);
      const gl = db.prepare('INSERT INTO F0911 (DOC,DCT,OBJ,SUB,AA,DGL,EXA,ICU) VALUES (?,?,?,?,?,?,?,?)');
      const icu = nextNumber('09', 90000);
      if (parts) gl.run(wo.DOCO, 'WO', '6410', eq.ASII, parts, dgl, 'Repuestos mantenimiento flota', icu);
      if (lab.c) gl.run(wo.DOCO, 'WO', '6420', eq.ASII, lab.c, dgl, 'Mano de obra taller', icu);
      if (total) gl.run(wo.DOCO, 'WO', '1490', '', -total, dgl, 'Contrapartida costeo OT', icu);
      if (wo.SRVT) db.prepare("UPDATE F1207 SET PMST='99', LSTM=COALESCE(?,LSTM), LSTD=? WHERE NUMB=? AND SRVT=?").run(num(Meter), dgl, wo.NUMB, wo.SRVT);
      return { WorkOrderNumber: wo.DOCO, Status: '99', ActualHours: lab.h, ActualCost: total, GLBatch: icu };
    });
  },

  FLT_UpdatePMSchedule({ UnitNumber, ServiceType, LastMeter, LastDate }) {
    const eq = equipOrThrow(UnitNumber);
    const r = db.prepare("UPDATE F1207 SET LSTM=?, LSTD=?, PMST='01' WHERE NUMB=? AND SRVT=?").run(Number(LastMeter), toJulian(LastDate || new Date()), eq.NUMB, ServiceType);
    if (!r.changes) throw new BizError(`No existe programación ${ServiceType} para la unidad ${UnitNumber} en F1207`);
    return { UnitNumber, ServiceType };
  },

  FLT_GetPMSchedule({ UnitNumber } = {}) {
    const rows = db.prepare(`SELECT s.*, e.ASII FROM F1207 s JOIN F1201 e ON e.NUMB=s.NUMB ${UnitNumber ? 'WHERE e.ASII=?' : ''}`).all(...(UnitNumber ? [String(UnitNumber)] : []));
    return { Schedule: rows.map((r) => ({ UnitNumber: r.ASII, ServiceType: r.SRVT, Description: r.DSC, IntervalKm: r.IKM, IntervalDays: r.IDY, LastMeter: r.LSTM, LastDate: fromJulian(r.LSTD), Status: r.PMST })) };
  },

  FLT_GetInventory({ BranchPlant = BRANCH } = {}) {
    const rows = db.prepare(`SELECT i.*, l.PQOH, l.SAFE, l.ROQ, l.UNCS, l.LTLV, l.VEND, a.ALPH
      FROM F4101 i JOIN F41021 l ON l.LITM=i.LITM LEFT JOIN F0101 a ON a.AN8=l.VEND WHERE l.MCU=? ORDER BY i.LITM`).all(BranchPlant);
    return {
      Items: rows.map((r) => ({
        ItemNumber: r.LITM, Description: r.DSC1, System: r.SRP1, StockingType: r.STKT, Criticality: r.PRP1,
        OnHand: r.PQOH, SafetyStock: r.SAFE, ReorderQty: r.ROQ, UnitCost: r.UNCS, LeadTimeDays: r.LTLV,
        Supplier: r.VEND, SupplierName: r.ALPH,
      })),
    };
  },

  FLT_CreateRequisition({ ItemNumber, Quantity, Supplier, BranchPlant = BRANCH }) {
    const loc = db.prepare('SELECT * FROM F41021 WHERE LITM=? AND MCU=?').get(ItemNumber, BranchPlant);
    if (!loc) throw new BizError(`Artículo ${ItemNumber} inexistente`);
    const doco = nextNumber('43', 7000);
    db.prepare("INSERT INTO F4311 (DOCO,DCTO,LNID,LITM,UORG,AN8,PRRC,LTTR,NXTR,DRQJ,MCU) VALUES (?,?,1,?,?,?,?,'220','230',?,?)")
      .run(doco, 'OR', ItemNumber, Number(Quantity), num(Supplier) || loc.VEND, loc.UNCS, toJulian(), BranchPlant);
    return { OrderNumber: doco, OrderType: 'OR', Status: '220' };
  },

  FLT_GetRequisitions() {
    const rows = db.prepare("SELECT * FROM F4311 WHERE DCTO IN ('OR','OP') ORDER BY DOCO DESC LIMIT 200").all();
    return { Requisitions: rows.map((r) => ({ OrderNumber: r.DOCO, OrderType: r.DCTO, ItemNumber: r.LITM, Quantity: r.UORG, LastStatus: r.LTTR, NextStatus: r.NXTR })) };
  },

  FLT_GetWorkOrders({ Since } = {}) {
    const rows = db.prepare(`SELECT w.*, e.ASII FROM F4801 w JOIN F1201 e ON e.NUMB=w.NUMB ${Since ? 'WHERE w.TRDJ>=?' : ''} ORDER BY DOCO DESC LIMIT 500`).all(...(Since ? [toJulian(Since)] : []));
    return { WorkOrders: rows.map((r) => ({ WorkOrderNumber: r.DOCO, UnitNumber: r.ASII, Type: r.TYPS, Status: r.SRST, ActualHours: r.HRSA, ActualCost: r.AMTA, ExternalId: r.EXTREF })) };
  },
};

// Proceso batch del JDE simulado: las requisiciones (OR) se convierten en OC (OP)
// y se reciben al cabo de ~45 s, incrementando el stock. Representa el circuito
// de compras que ocurre del lado del ERP.
function procurementBatch() {
  const pend = db.prepare("SELECT * FROM F4311 WHERE DCTO='OR' AND LTTR='220'").all();
  for (const r of pend) {
    const t = reqSeen.get(r.DOCO) || Date.now();
    reqSeen.set(r.DOCO, t);
    if (Date.now() - t < 45000) continue;
    tx(() => {
      db.prepare("UPDATE F4311 SET DCTO='OP', LTTR='400', NXTR='999' WHERE DOCO=? AND DCTO='OR'").run(r.DOCO);
      db.prepare('UPDATE F41021 SET PQOH=PQOH+? WHERE LITM=? AND MCU=?').run(r.UORG, r.LITM, r.MCU);
      db.prepare("INSERT INTO F4111 (LITM,MCU,DCT,DOCO,TRQT,UNCS,DGL) VALUES (?,?,'OV',?,?,?,?)").run(r.LITM, r.MCU, r.DOCO, r.UORG, r.PRRC, toJulian());
    });
    reqSeen.delete(r.DOCO);
  }
}
const reqSeen = new Map(); // DOCO -> primera vez vista (sin timestamp en la tabla)

// ------------------------------------------------------------ HTTP
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TABLES = {
  F1201: 'Asset Master (equipos)', F1201_MTR: 'Lecturas de medidor (P12120)', F1207: 'Maintenance Schedule (PM)',
  F4801: 'Work Order Master', F3111: 'Work Order Parts List', F31122: 'WO Time Transactions',
  F4101: 'Item Master', F41021: 'Item Location (stock)', F4111: 'Item Ledger (cardex)',
  F4311: 'Purchase Order Detail (OR/OP)', F0911: 'Account Ledger', F0101: 'Address Book',
};

function viewer(name) {
  const nav = Object.entries(TABLES).map(([t, d]) => `<a href="/table/${t}" class="${t === name ? 'on' : ''}"><b>${t}</b><span>${d}</span></a>`).join('');
  let content = `<h2>JD Edwards EnterpriseOne 9.2 — AIS Server (simulado)</h2>
    <p>Este servidor emula el AIS Server de JDE. Endpoints: <code>POST /jderest/v2/tokenrequest</code>, <code>POST /jderest/v3/orchestrator/{nombre}</code>.</p>
    <p>Orquestaciones disponibles:</p><ul>${Object.keys(orchestrations).map((o) => `<li><code>${o}</code></li>`).join('')}</ul>
    <p>Estado: <b>${outage ? 'FUERA DE SERVICIO (simulado)' : 'EN LÍNEA'}</b></p>`;
  if (name && TABLES[name]) {
    const order = { F4801: 'DOCO DESC', F3111: 'UKID DESC', F31122: 'UKID DESC', F4111: 'UKID DESC', F0911: 'UKID DESC', F4311: 'DOCO DESC' }[name];
    const rows = db.prepare(`SELECT * FROM ${name} ${order ? 'ORDER BY ' + order : ''} LIMIT 300`).all();
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    content = `<h2>${name} <small>${TABLES[name]}</small></h2><p>${rows.length} filas (máx. 300, más recientes primero)</p>
      <div class="tw"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>JDE 9.2 simulado</title>
  <meta http-equiv="refresh" content="15">
  <style>body{margin:0;font:13px system-ui,Segoe UI,sans-serif;display:flex;min-height:100vh;color:#1b1b1b;background:#f4f5f7}
  nav{width:250px;background:#3b3f45;color:#fff;padding:12px 0;flex-shrink:0}nav h1{font-size:14px;margin:0 16px 12px;color:#f0b323}
  nav a{display:block;color:#ddd;text-decoration:none;padding:6px 16px}nav a span{display:block;font-size:11px;color:#aaa}nav a.on,nav a:hover{background:#52575e}
  main{flex:1;padding:20px;overflow:auto}h2 small{font-weight:400;color:#666;font-size:14px}.tw{overflow:auto;background:#fff;border:1px solid #ddd}
  table{border-collapse:collapse;font-size:12px}th,td{padding:4px 8px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}th{background:#e9ecef;position:sticky;top:0}
  code{background:#e9ecef;padding:1px 4px;border-radius:3px}</style></head>
  <body><nav><h1><a href="/" style="color:#f0b323;padding:0">JDE E1 9.2 · AIS</a></h1>${nav}</nav><main>${content}</main></body></html>`;
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/' || p.startsWith('/table/')) return send(res, 200, viewer(p.split('/')[2]), 'text/html');

  // Endpoint auxiliar del simulador para provocar una caída del ERP (prueba de reintentos)
  if (p === '/mock/outage' && req.method === 'POST') {
    return readBody(req).then((b) => { outage = !!b.on; send(res, 200, { outage }); });
  }
  if (p === '/mock/outage') return send(res, 200, { outage });

  if (p.startsWith('/jderest')) {
    if (outage) return send(res, 503, { message: 'AIS Server no disponible (caída simulada)' });
    if (p === '/jderest/v2/defaultconfig' || p === '/jderest/defaultconfig') {
      return send(res, 200, { aisVersion: '9.2.8.3 (simulado)', jasHost: 'localhost', toolsRelease: '9.2.8.3', capabilityList: ['orchestrator', 'tokenrequest'] });
    }
    return readBody(req).then((body) => {
      const delay = 60 + Math.random() * 160; // latencia típica de AIS
      setTimeout(() => {
        if (p === '/jderest/v2/tokenrequest' && req.method === 'POST') {
          if (body.username !== USER || body.password !== PASS) return send(res, 403, { message: 'Usuario o contraseña inválidos' });
          const token = crypto.randomBytes(24).toString('hex');
          tokens.set(token, Date.now() + 30 * 60 * 1000);
          return send(res, 200, { username: USER, environment: body.environment || 'JDV920', role: body.role || '*ALL', userInfo: { token, addressNumber: 9001, alphaName: 'Integración Flota' } });
        }
        const token = req.headers['jde-ais-auth'] || body.token;
        if (!token || !tokens.has(token) || tokens.get(token) < Date.now()) return send(res, 401, { message: 'Token AIS inválido o vencido' });
        const m = p.match(/^\/jderest\/v3\/orchestrator\/([A-Za-z0-9_]+)$/);
        if (!m || req.method !== 'POST') return send(res, 404, { message: 'Recurso inexistente' });
        const orch = orchestrations[m[1]];
        if (!orch) return send(res, 404, { message: `Orquestación ${m[1]} no encontrada` });
        try {
          send(res, 200, orch(body) || {});
        } catch (e) {
          send(res, e.status || 500, { message: e.message, exception: e.status ? 'BusinessRuleException' : 'Exception' });
        }
      }, delay);
    });
  }
  send(res, 404, { message: 'No encontrado' });
}

function start(port = Number(process.env.JDE_PORT || 8091)) {
  const srv = http.createServer(handler);
  srv.listen(port, () => console.log(`[JDE] AIS Server simulado en http://localhost:${port}`));
  setInterval(procurementBatch, 10000);
  return srv;
}

if (require.main === module) {
  require('../server/seed').ensureSeeded();
  start();
}
module.exports = { start };
