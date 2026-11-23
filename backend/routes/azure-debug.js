// backend/routes/azure-debug.js — Azure Debugger (/api/azure-debug)  AETHER_AZURE_DEBUG
//
//   POST /scan          multipart "bundle" (1..16 files): IC2 log bundle(s), IC2 syslog .txt
//   POST /scan-text     { name, text }: a pasted IC2 syslog ("OSDPDriver[n]: << 53 …")
//   GET  /reports       saved scans (newest first)      GET/DELETE /reports/:id
//   POST /probe         { host }: read-only reachability checks of an IC2 from this Pi
//   GET  /bus           live RS-485 summary from Aether's OSDP Trace (sniffer / emulator)
//
// Scans run in a worker (analytics/azure-worker.js): Log Analytics inspection + the Azure layer.
// Saved in backend/data/azure-debug (newest 40). Nothing is ever sent to the controller except
// the probe's TCP connects, one TLS handshake and one HTTPS GET of its login page.
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');

let multer;
try { multer = require('multer'); } catch { multer = null; }

const BASE = path.join(__dirname, '..', 'data', 'azure-debug');
const INCOMING = path.join(BASE, 'incoming');
const KEEP = 40;
const MAX_UPLOAD = 512 * 1024 * 1024;
const safeId = id => (/^az-[a-z0-9]{6,20}$/.test(id) ? id : null);

function runWorker(inputs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'analytics', 'azure-worker.js'), { workerData: { inputs }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('The scan took longer than 5 minutes and was stopped')); }, 5 * 60000);
    w.once('message', m => { clearTimeout(timer); m.ok ? resolve(m) : reject(new Error(m.error)); });
    w.once('error', e => { clearTimeout(timer); reject(e); });
    w.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`scan worker exited with code ${code}`)); });
  });
}

function list() {
  try {
    return fs.readdirSync(BASE).filter(f => f.endsWith('.meta.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(BASE, f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function prune() {
  for (const m of list().slice(KEEP)) for (const ext of ['.json', '.meta.json']) { try { fs.unlinkSync(path.join(BASE, m.id + ext)); } catch { /* */ } }
}

async function scanAndSave(inputs, name) {
  const started = Date.now();
  const { report, azure } = await runWorker(inputs);
  delete report.__raw;                                    // raw lines stay out (Log Analytics keeps those owner-only)
  for (const f of report.findings || []) for (const s of f.samples || []) delete s.raw;
  if (Array.isArray(report.frames) && report.frames.length > 20000) report.frames = report.frames.slice(-20000);
  const id = `az-${Date.now().toString(36)}`;
  const sev = {}; for (const f of report.findings || []) sev[f.sev] = (sev[f.sev] || 0) + 1;
  for (const c of azure.checks || []) sev[c.sev] = (sev[c.sev] || 0) + 1;
  const meta = {
    id, name: String(name || inputs.map(i => i.name).join(', ')).slice(0, 160), createdAt: Date.now(), scanMs: Date.now() - started,
    window: report.window || null, controller: azure.controller, boards: (azure.boards || []).length,
    hops: (azure.hops || []).map(h => ({ id: h.id, status: h.status })), bySeverity: sev,
  };
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(path.join(BASE, id + '.json'), JSON.stringify({ meta, report, azure }));
  fs.writeFileSync(path.join(BASE, id + '.meta.json'), JSON.stringify(meta));
  prune();
  return meta;
}

// ── probe helpers ────────────────────────────────────────────────────────────
const HOST_RX = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function tcp(host, port, ms = 2500) {
  return new Promise(resolve => {
    const t0 = Date.now(); const s = net.connect({ host, port });
    const done = (open, err) => { s.destroy(); resolve({ port, open, ms: Date.now() - t0, error: err || null }); };
    s.setTimeout(ms, () => done(false, 'timeout'));
    s.once('connect', () => done(true));
    s.once('error', e => done(false, e.code || e.message));
  });
}

function tlsInfo(host, ms = 4000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = tls.connect({ host, port: 443, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate() || {};
      resolve({
        ok: true, ms: Date.now() - t0, protocol: s.getProtocol(), authorized: s.authorized, authError: s.authorizationError ? String(s.authorizationError) : null,
        subject: c.subject ? c.subject.CN || JSON.stringify(c.subject) : null, issuer: c.issuer ? c.issuer.CN || c.issuer.O || null : null,
        validFrom: c.valid_from || null, validTo: c.valid_to || null, san: c.subjectaltname || null,
      });
      s.end();
    });
    s.setTimeout(ms, () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
    s.once('error', e => resolve({ ok: false, error: e.code || e.message }));
  });
}

function httpsHead(host, ms = 5000) {
  return new Promise(resolve => {
    const https = require('https');
    const t0 = Date.now();
    const req = https.request({ host, port: 443, path: '/', method: 'GET', rejectUnauthorized: false, timeout: ms }, res => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', d => { if (body.length < 20000) body += d; });
      res.on('end', () => {
        const title = (/<title>([^<]{0,120})<\/title>/i.exec(body) || [])[1] || null;
        resolve({ ok: true, ms: Date.now() - t0, status: res.statusCode, server: res.headers.server || null, title, azure: /azure|blu-ic|ic2|asp/i.test(body + (res.headers.server || '')) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

function ping(host) {
  return new Promise(resolve => {
    execFile('ping', ['-c', '3', '-W', '1', '-i', '0.3', host], { timeout: 6000 }, (err, out) => {
      const loss = (/(\d+(?:\.\d+)?)% packet loss/.exec(out || '') || [])[1];
      const avg = (/= [\d.]+\/([\d.]+)\//.exec(out || '') || [])[1];
      resolve({ ran: !(err && err.code === 'ENOENT'), loss: loss != null ? +loss : null, avgMs: avg != null ? +avg : null });
    });
  });
}

// Ports worth knowing on an IC2 / Cloud Connector controller (read-only connects).
const PORTS = [
  { port: 443, what: 'Web UI and API (HTTPS)' },
  { port: 80, what: 'Web UI redirect (HTTP)' },
  { port: 22, what: 'SSH (normally closed)' },
  { port: 5000, what: 'Direct host link — IP-Server mode (host connects to the board)' },
];

module.exports = function azureDebugRoutes(opts = {}) {
  const router = express.Router();
  fs.mkdirSync(INCOMING, { recursive: true });
  const upload = multer ? multer({ dest: INCOMING, limits: { fileSize: MAX_UPLOAD, files: 16 } }).array('bundle', 16) : null;
  let busy = false;

  router.post('/scan', (req, res) => {
    if (!upload) return res.status(500).json({ success: false, error: 'multer is not installed in backend/ (npm install multer)' });
    if (busy) return res.status(409).json({ success: false, error: 'A scan is already running. Try again in a moment.' });
    upload(req, res, async err => {
      const files = req.files || [];
      const cleanup = () => files.forEach(f => { try { fs.unlinkSync(f.path); } catch { /* */ } });
      if (err) { cleanup(); return res.status(400).json({ success: false, error: err.message }); }
      if (!files.length) return res.status(400).json({ success: false, error: 'Attach the controller log bundle (field "bundle").' });
      busy = true;
      try {
        const meta = await scanAndSave(files.map(f => ({ path: f.path, name: f.originalname })), req.body && req.body.name);
        res.json({ success: true, meta });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); } finally { busy = false; cleanup(); }
    });
  });

  router.post('/scan-text', express.json({ limit: '24mb' }), async (req, res) => {
    const text = String((req.body || {}).text || '');
    if (!text.trim()) return res.status(400).json({ success: false, error: 'Paste the IC2 log text first.' });
    if (busy) return res.status(409).json({ success: false, error: 'A scan is already running. Try again in a moment.' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-azure-'));
    const file = path.join(dir, 'ic2-syslog.txt');
    busy = true;
    try {
      fs.writeFileSync(file, text);
      const meta = await scanAndSave([{ path: file, name: 'ic2-syslog.txt' }], (req.body || {}).name || 'Pasted IC2 log');
      res.json({ success: true, meta });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); } finally { busy = false; fs.rmSync(dir, { recursive: true, force: true }); }
  });

  router.get('/reports', (_req, res) => res.json({ success: true, reports: list() }));
  router.get('/reports/:id', (req, res) => {
    const id = safeId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'bad id' });
    try { res.type('json').send(fs.readFileSync(path.join(BASE, id + '.json'))); } catch { res.status(404).json({ success: false, error: 'Report not found' }); }
  });
  router.delete('/reports/:id', (req, res) => {
    const id = safeId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'bad id' });
    for (const ext of ['.json', '.meta.json']) { try { fs.unlinkSync(path.join(BASE, id + ext)); } catch { /* */ } }
    res.json({ success: true });
  });

  router.post('/probe', express.json(), async (req, res) => {
    const host = String((req.body || {}).host || '').trim();
    if (!HOST_RX.test(host)) return res.status(400).json({ success: false, error: 'Enter the controller IP address or host name.' });
    const started = Date.now();
    const [pg, ports, cert, web] = await Promise.all([ping(host), Promise.all(PORTS.map(p => tcp(host, p.port).then(r => ({ ...r, what: p.what })))), tlsInfo(host), httpsHead(host)]);
    const hostname = cert && cert.subject && /^ic2-/i.test(cert.subject) ? cert.subject : null;
    res.json({ success: true, host, at: Date.now(), ms: Date.now() - started, ping: pg, ports, tls: cert, web, hostname });
  });

  router.get('/bus', (_req, res) => {
    const hub = typeof opts.trace === 'function' ? opts.trace() : null;
    if (!hub) return res.json({ success: true, available: false });
    const snap = hub.snapshot(Number.MAX_SAFE_INTEGER);
    const ids = {};
    for (const ev of snap.events || []) {
      const r = ev.reply;
      if (r && r.name === 'osdp_PDID' && r.decoded) ids[ev.address] = { ...r.decoded, azure: /^00:60:ee$/i.test(String(r.decoded.vendor || '')) };
    }
    res.json({ success: true, available: true, source: snap.source, stats: snap.stats, devices: (snap.health || []).map(h => ({ ...h, id: ids[h.address] || null })) });
  });

  // ── board firmware over RS-485 (AETHER_AZURE_FW) ───────────────────────────
  let fwMod = null, updater = null;
  try { fwMod = require('../azure/boardFirmware'); } catch (e) { console.warn('[AzureDebug] board firmware disabled:', e.message); }
  const fwBridge = (() => { try { return require('../routes-osdp-firmware'); } catch { return null; } })();
  if (fwMod) {
    updater = new fwMod.BoardUpdater({
      dataDir: path.join(__dirname, '..', 'data'),
      borrowPort: async p => (fwBridge && fwBridge.releaseEmulatorPort ? fwBridge.releaseEmulatorPort(typeof opts.osdp === 'function' ? opts.osdp() : null, p) : {}),
      returnPort: async (p, lease) => { if (lease && lease.wasOwned && fwBridge && fwBridge.reopenEmulatorPort) await fwBridge.reopenEmulatorPort(opts.osdp(), p, lease.baudRate); },
      isPortBusy: p => {
        const sn = typeof opts.sniffer === 'function' ? opts.sniffer() : null;
        const st = sn && sn.getStatus ? sn.getStatus() : null;
        return st && st.active && st.port === p ? `The OSDP sniffer is using ${p}. Stop it (Readers › OSDP Trace) first.` : null;
      },
    });
  }
  const fwReady = (_req, res, next) => (updater ? next() : res.status(500).json({ success: false, error: 'Board firmware updates are not available on this Aether (serialport module missing).' }));
  const devPath = p => { const s = String(p || '').trim(); return /^(\/dev\/)?[A-Za-z0-9_./-]+$/.test(s) && !s.includes('..') ? (s.startsWith('/dev/') ? s : `/dev/${s}`) : null; };
  const baudOf = b => ([9600, 19200, 38400, 57600, 115200, 230400].includes(+b) ? +b : 9600);
  const addrOf = a => (Number.isInteger(+a) && +a >= 0 && +a <= 126 ? +a : null);
  // Firmware uploads go to disk: a bulk archive ("All Azure Releases.zip") can be several GB.
  const fwIncoming = updater ? path.join(updater.dir, 'incoming') : null;
  const pkgUpload = multer && fwIncoming ? multer({ dest: fwIncoming, limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 32 } }).array('package', 32) : null;
  const { importArchive } = require('../azure/fwArchive');

  router.get('/firmware/packages', fwReady, (_req, res) => res.json({ success: true, packages: updater.packages() }));
  router.post('/firmware/packages', fwReady, (req, res) => {
    if (!pkgUpload) return res.status(500).json({ success: false, error: 'multer is not installed in backend/' });
    try { fs.mkdirSync(fwIncoming, { recursive: true }); } catch { /* */ }
    pkgUpload(req, res, err => {
      const cleanup = () => (req.files || []).forEach(f => fs.rm(f.path, { force: true }, () => {}));
      if (err) { cleanup(); return res.status(400).json({ success: false, error: err.message }); }
      if (!req.files || !req.files.length) return res.status(400).json({ success: false, error: 'Attach vendor packages (.zip), images (.upd / .e19), a bulk archive of packages, or a library saved from Aether (field "package").' });
      const packages = [], errors = [], skipped = [];
      let existing = 0;
      for (const f of req.files) {
        try {
          const head = Buffer.alloc(4); const fd = fs.openSync(f.path, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
          if (head.readUInt32LE(0) === 0x04034b50) {
            const r = importArchive(updater, f.path, f.originalname);
            packages.push(...r.packages); errors.push(...r.errors); skipped.push(...r.skipped); existing += r.existing;
            if (!r.packages.length && !r.errors.length) errors.push(`${f.originalname}: no board firmware packages inside`);
          } else {
            const r = updater.savePackages(f.originalname, fs.readFileSync(f.path));
            packages.push(...r.packages); errors.push(...r.errors); existing += r.packages.filter(p => p.existed).length;
          }
        } catch (e) { errors.push(e.message.includes(f.originalname) ? e.message : `${f.originalname}: ${e.message}`); }
      }
      cleanup();
      if (!packages.length) return res.status(400).json({ success: false, error: errors.join('; ') || 'No board firmware found' });
      const uniq = [...new Map(packages.map(p => [p.id, p])).values()];
      res.json({ success: true, package: uniq[0], packages: uniq, existing, skipped: skipped.length, skippedSample: skipped.slice(0, 12), errors });
    });
  });
  const sendZip = (res, z) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${z.name.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Content-Length', z.data.length);
    res.end(z.data);
  };
  router.get('/firmware/library/export', fwReady, (_req, res) => sendZip(res, updater.libraryZip()));
  router.get('/firmware/packages/:id/download', fwReady, (req, res) => {
    const z = /^fw-[0-9a-f]{12}$/.test(req.params.id) ? updater.packageZip(req.params.id) : null;
    if (!z) return res.status(404).json({ success: false, error: 'No such package' });
    sendZip(res, z);
  });
  router.delete('/firmware/packages/:id', fwReady, (req, res) => { updater.removePackage(req.params.id); res.json({ success: true }); });
  router.get('/firmware/ports', fwReady, async (_req, res) => {
    try {
      const { SerialPort } = require('serialport');
      const ports = (await SerialPort.list()).map(p => ({ path: p.path, manufacturer: p.manufacturer || null, serialNumber: p.serialNumber || null, vendorId: p.vendorId || null, productId: p.productId || null }));
      res.json({ success: true, ports });
    } catch (e) { res.json({ success: true, ports: [], note: `Could not list serial ports (${e.message}); type the path instead.` }); }
  });
  router.post('/firmware/scan', fwReady, express.json(), async (req, res) => {
    const b = req.body || {}; const portPath = devPath(b.port);
    if (!portPath) return res.status(400).json({ success: false, error: 'Pick the RS-485 port.' });
    const from = addrOf(b.from ?? 0), to = addrOf(b.to ?? 31);
    if (from == null || to == null || to < from) return res.status(400).json({ success: false, error: 'Address range must be 0–126.' });
    try { res.json({ success: true, port: portPath, baud: baudOf(b.baud), ...(await updater.scan({ portPath, baudRate: baudOf(b.baud), from, to })) }); }
    catch (e) { res.status(409).json({ success: false, error: e.message }); }
  });
  router.post('/firmware/plan', fwReady, express.json(), (req, res) => {
    const b = req.body || {}; const pkg = updater.pkg(String(b.packageId || ''));
    if (!pkg || !b.board) return res.status(400).json({ success: false, error: 'Pick a package and a board.' });
    res.json({ success: true, plan: fwMod.plan(b.board, pkg, { reinstall: !!b.reinstall, bootloader: ['auto', 'yes', 'no'].includes(b.bootloader) ? b.bootloader : 'auto' }) });
  });
  router.post('/firmware/update', fwReady, express.json(), (req, res) => {
    const b = req.body || {}; const portPath = devPath(b.port); const address = addrOf(b.address);
    if (!portPath || address == null) return res.status(400).json({ success: false, error: 'Port and board address are required.' });
    if (!/^[0-9A-F]{8}$/i.test(String(b.serial || ''))) return res.status(400).json({ success: false, error: 'Confirm the board serial number first.' });
    try {
      res.json({ success: true, ...updater.start({ portPath, baudRate: baudOf(b.baud), address, packageId: String(b.packageId || ''), serial: b.serial, reinstall: !!b.reinstall, bootloader: ['auto', 'yes', 'no'].includes(b.bootloader) ? b.bootloader : 'auto', fragmentSize: b.fragmentSize }) });
    } catch (e) { res.status(409).json({ success: false, error: e.message }); }
  });
  router.get('/firmware/job', fwReady, (_req, res) => res.json({ success: true, job: updater.status() }));
  router.post('/firmware/job/abort', fwReady, (_req, res) => res.json({ success: true, stopped: updater.abort() }));
  router.get('/firmware/history', fwReady, (_req, res) => res.json({ success: true, history: updater.history() }));

  return router;
};
