// Punto de entrada: CMMS de flota (http://localhost:3100) + JDE AIS simulado (http://localhost:8091)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ensureSeeded } = require('./seed');

ensureSeeded();

const api = require('./api');
const integration = require('./jde/integration');
const telemetry = require('./services/telemetry');

const PORT = Number(process.env.PORT || 3100);
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

if (process.env.JDE_MOCK !== '0') require('../jde-mock/server').start();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Torre de Control Logística (demo autónoma de un solo archivo)
  if (url.pathname === '/torre' || url.pathname === '/torre.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, '..', 'entregables', 'Torre-Control-Logistica.html')).pipe(res);
  }
  if (url.pathname.startsWith('/api/')) {
    if (await api.handle(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Recurso inexistente' }));
  }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[CMMS] Gestión de mantenimiento de flota en http://localhost:${PORT}`);
  integration.start();
  telemetry.start();
});
