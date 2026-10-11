// backend/routes-analytics.js — Log Analytics (/api/analytics)
//
// Inspection:   upload a Cloud Connector log bundle → anomaly report
// Product Test: bundle + Aether's action journal (local run, time window or uploaded
//               file) → every triggered action graded against what the controller logged
//
// Reports are kept in backend/data/analytics/reports (newest 30).
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const journal = require('./analytics/journal');
const { DEFAULTS } = require('./analytics/index');
const { redact } = require('./analytics/detectors');

let multer;
try { multer = require('multer'); } catch { multer = null; }

const BASE = path.join(__dirname, 'data', 'analytics');
const REPORTS = path.join(BASE, 'reports');
const INCOMING = path.join(BASE, 'incoming');
const SETTINGS = path.join(BASE, 'settings.json');
const KEEP_REPORTS = 30;
const MAX_UPLOAD = 512 * 1024 * 1024;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return { thresholds: {}, wiring: {} }; }
}
function writeSettings(s) {
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}

function listReports() {
  try {
    fs.mkdirSync(REPORTS, { recursive: true });
    return fs.readdirSync(REPORTS).filter(f => f.endsWith('.meta.json')).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf8')); } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

function pruneReports() {
  const all = listReports();
  for (const r of all.slice(KEEP_REPORTS)) {
    for (const ext of ['.json', '.meta.json', '.raw.json']) { try { fs.unlinkSync(path.join(REPORTS, r.id + ext)); } catch { /* */ } }
  }
}

const safeId = id => /^[a-z0-9-]{6,64}$/i.test(id) ? id : null;

function runWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'analytics', 'worker.js'), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('Scan took longer than 5 minutes and was stopped')); }, 5 * 60000);
    w.once('message', m => { clearTimeout(timer); m.ok ? resolve(m.report) : reject(new Error(m.error)); });
    w.once('error', e => { clearTimeout(timer); reject(e); });
    w.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`scan worker exited with code ${code}`)); });
  });
}

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = t => Number.isFinite(t) ? new Date(t).toISOString() : '';

module.exports = function analyticsRoutes() {
  const router = express.Router();
  fs.mkdirSync(INCOMING, { recursive: true });
  const upload = multer ? multer({ dest: INCOMING, limits: { fileSize: MAX_UPLOAD, files: 20 } }).fields([{ name: 'bundle', maxCount: 16 }, { name: 'journal', maxCount: 1 }]) : null;
  let busy = false;

  // ── scan ────────────────────────────────────────────────────────────────
  router.post('/scan', (req, res) => {
    if (!upload) return res.status(500).json({ success: false, error: 'multer is not installed in backend/ (npm install multer)' });
    if (busy) return res.status(409).json({ success: false, error: 'A scan is already running — try again in a moment.' });
    upload(req, res, async (err) => {
      const tmp = [...((req.files || {}).bundle || []), ...((req.files || {}).journal || [])].map(f => f.path);
      const cleanup = () => tmp.forEach(p => { try { fs.unlinkSync(p); } catch { /* */ } });
      if (err) { cleanup(); return res.status(400).json({ success: false, error: err.message }); }
      const bundles = (req.files || {}).bundle || [];
      if (!bundles.length) { cleanup(); return res.status(400).json({ success: false, error: 'Attach the Cloud Connector log bundle (field "bundle").' }); }
      const mode = req.body.mode === 'product-test' ? 'product-test' : 'inspection';
      const settings = readSettings();
      let opts = { ...DEFAULTS, ...(settings.thresholds || {}) };
      try { if (req.body.opts) opts = { ...opts, ...JSON.parse(req.body.opts) }; } catch { /* ignore bad opts */ }
      let wiring = settings.wiring || {};
      try { if (req.body.wiring) wiring = { ...wiring, ...JSON.parse(req.body.wiring) }; } catch { /* */ }

      let entries = null, journalLabel = '';
      if (mode === 'product-test') {
        const jf = ((req.files || {}).journal || [])[0];
        if (req.body.journalSource === 'upload' || jf) {
          if (!jf) { cleanup(); return res.status(400).json({ success: false, error: 'Attach the emulator journal (field "journal").' }); }
          entries = journal.parseUpload(fs.readFileSync(jf.path, 'utf8'));
          journalLabel = `uploaded ${jf.originalname}`;
        } else if (req.body.runId) {
          entries = journal.read({ run: String(req.body.runId) });
          journalLabel = `run ${req.body.runId}`;
        } else {
          const from = Number(req.body.from) || 0, to = Number(req.body.to) || Date.now();
          entries = journal.read({ from, to });
          journalLabel = from ? `journal ${iso(from)} → ${iso(to)}` : 'journal (bundle window)';
          entries.__bundleWindow = !from;
        }
        if (!entries.length && !entries.__bundleWindow) { cleanup(); return res.status(400).json({ success: false, error: `No journal entries found for ${journalLabel}.` }); }
      }

      busy = true;
      const started = Date.now();
      try {
        const inputs = bundles.map(f => ({ path: f.path, name: f.originalname }));
        let jr = entries ? [...entries] : null;
        if (entries && entries.__bundleWindow) {
          // No run or window chosen: use the journal for whatever span the controller logs cover
          const probe = await runWorker({ inputs, mode: 'inspection', opts, wiring });
          const cc = (probe.coverage || {}).cloudconnector || probe.window;
          jr = cc ? journal.read({ from: cc.from - 60000, to: cc.to + 60000 }) : [];
          journalLabel = `journal entries during the controller log window (${jr.length})`;
        }
        const report = await runWorker({ inputs, mode, journal: jr, opts, wiring });
        const id = `${mode === 'product-test' ? 'pt' : 'in'}-${Date.now().toString(36)}`;
        report.id = id;
        report.name = String(req.body.name || bundles.map(f => f.originalname).join(', ')).slice(0, 160);
        report.journalLabel = journalLabel;
        report.scanMs = Date.now() - started;
        fs.mkdirSync(REPORTS, { recursive: true });
        // Raw log lines (unredacted, with context) go to a separate owner-only file, never into the report/CSV
        const raws = report.__raw || {};
        delete report.__raw;
        for (const f of report.findings || []) for (const smp of f.samples || []) delete smp.raw;
        if (Object.keys(raws).length) fs.writeFileSync(path.join(REPORTS, id + '.raw.json'), JSON.stringify(raws), { mode: 0o600 });
        fs.writeFileSync(path.join(REPORTS, id + '.json'), JSON.stringify(report));
        const meta = {
          id, name: report.name, mode, createdAt: report.createdAt, window: report.window, device: (report.summary || {}).device || {},
          bySeverity: (report.summary || {}).bySeverity || {}, findings: (report.findings || []).length,
          verdict: report.productTest ? report.productTest.summary.verdict : null,
        };
        fs.writeFileSync(path.join(REPORTS, id + '.meta.json'), JSON.stringify(meta));
        pruneReports();
        res.json({ success: true, id, meta });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      } finally { busy = false; cleanup(); }
    });
  });

  // ── reports ─────────────────────────────────────────────────────────────
  router.get('/reports', (_req, res) => res.json({ success: true, reports: listReports() }));

  router.get('/reports/:id', (req, res) => {
    const id = safeId(req.params.id);
    const p = id && path.join(REPORTS, id + '.json');
    if (!p || !fs.existsSync(p)) return res.status(404).json({ success: false, error: 'Report not found' });
    res.setHeader('Content-Type', 'application/json');
    fs.createReadStream(p).pipe(res);
  });

  router.delete('/reports/:id', (req, res) => {
    const id = safeId(req.params.id);
    if (!id) return res.status(400).json({ success: false });
    for (const ext of ['.json', '.meta.json', '.raw.json']) { try { fs.unlinkSync(path.join(REPORTS, id + ext)); } catch { /* */ } }
    res.json({ success: true });
  });

  // Show raw: the original log line behind a finding sample (with context), on request (can be turned off in settings: allowRaw=false)
  router.get('/reports/:id/raw', (req, res) => {
    if (readSettings().allowRaw === false) return res.status(403).json({ success: false, error: 'Showing raw lines is turned off in Log Analytics settings.' });
    const id = safeId(req.params.id);
    const p = id && path.join(REPORTS, id + '.raw.json');
    if (!p || !fs.existsSync(p)) return res.status(404).json({ success: false, error: 'No raw lines stored for this report — rescan the bundle to capture them.' });
    let raws; try { raws = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return res.status(500).json({ success: false, error: 'Raw store unreadable' }); }
    const f = String(req.query.f || ''), i = String(Number(req.query.i));
    const raw = raws[f] && raws[f][i];
    if (raw == null) return res.status(404).json({ success: false, error: 'Line not found' });
    console.log(`[Analytics] raw line revealed: report ${id} finding ${f} sample ${i} from ${req.ip}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...(typeof raw === 'string' ? { line: raw, before: [], after: [] } : raw) });
  });

  // CSV exports: findings, product-test results, decoded SDK frames
  router.get('/reports/:id/:kind.csv', (req, res) => {
    const id = safeId(req.params.id);
    const p = id && path.join(REPORTS, id + '.json');
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    let rows;
    if (req.params.kind === 'findings') {
      const syl = Object.fromEntries((r.symptoms || []).map(x => [x.id, x.label]));
      rows = [['severity', 'category', 'basis', 'title', 'count', 'first', 'last', 'related_problems', 'detail', 'likely_cause', 'confidence', 'owner', 'troubleshooting', 'example']]
          .concat([...(r.findings || [])].sort((a, b) => (b.last || 0) - (a.last || 0)).map(f => { const pb = f.playbook || {}; return [f.sev, f.cat, f.basis, f.title, f.count, iso(f.first), iso(f.last), (f.symptoms || []).map(x => syl[x] || x).join('; '), f.detail, pb.cause || '', pb.confidence || '', pb.owner || '', (pb.steps || (f.fix ? [f.fix] : [])).map((x, k) => `${k + 1}. ${x}`).join('\n'), (f.samples[0] || {}).text || '']; }));
    } else if (req.params.kind === 'results' && r.productTest) {
      rows = [['time', 'status', 'channel', 'kind', 'value', 'role', 'expected', 'matched', 'latency_ms', 'publish_lag_ms', 'note', 'run']]
        .concat(r.productTest.results.map(x => [iso(x.t), x.status, x.ch, x.k, x.v, x.role, x.expect || '', x.matched ? x.matched.type : '', x.latency != null ? x.latency : '', x.matched && x.matched.publishLag != null ? x.matched.publishLag : '', x.note || '', x.run || '']));
    } else if (req.params.kind === 'frames') {
      rows = [['time', 'dir', 'peer', 'code', 'name', 'confidence', 'serial', 'event', 'point', 'hex']]
        .concat((r.frames || []).map(f => [iso(f.t), f.dir, f.peer, f.code, f.name, f.conf, f.serial != null ? f.serial : '', f.evName || '', f.point || '', f.hex]));
    } else return res.status(404).end();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-${req.params.kind}.csv"`);
    res.send(rows.map(r2 => r2.map(csvCell).join(',')).join('\n'));
  });

  // ── settings: thresholds + wiring map ───────────────────────────────────
  router.get('/settings', (_req, res) => {
    const s = readSettings();
    res.json({ success: true, defaults: DEFAULTS, thresholds: { ...DEFAULTS, ...(s.thresholds || {}) }, wiring: s.wiring || {}, allowRaw: s.allowRaw !== false });
  });
  router.put('/settings', (req, res) => {
    const s = readSettings();
    const b = req.body || {};
    if (b.thresholds && typeof b.thresholds === 'object') {
      const t = {};
      for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(Number(b.thresholds[k])) && Number(b.thresholds[k]) >= 0) t[k] = Number(b.thresholds[k]);
      s.thresholds = t;
    }
    if (b.wiring && typeof b.wiring === 'object') {
      const w = {};
      for (const [ch, v] of Object.entries(b.wiring)) {
        if (!v || typeof v !== 'object' || !/^[\w:.\-]{1,80}$/.test(ch)) continue;
        if (!['dps', 'rex', 'card', 'keypad', 'lock', 'input', 'output', 'ignore'].includes(v.role)) continue;
        w[ch] = { role: v.role, ...(v.door ? { door: String(v.door).slice(0, 64) } : {}), ...(v.active ? { active: v.active === 'closed' ? 'closed' : 'open' } : {}), ...(v.ioId ? { ioId: String(v.ioId).slice(0, 120) } : {}), ...(v.label ? { label: String(v.label).slice(0, 60) } : {}) };
      }
      s.wiring = w;
    }
    if (typeof b.allowRaw === 'boolean') s.allowRaw = b.allowRaw;
    writeSettings(s);
    res.json({ success: true, thresholds: { ...DEFAULTS, ...s.thresholds }, wiring: s.wiring || {}, allowRaw: s.allowRaw !== false });
  });

  // ── journal ─────────────────────────────────────────────────────────────
  router.get('/journal/status', (_req, res) => res.json({ success: true, ...journal.status() }));
  router.post('/journal/run/start', (req, res) => res.json({ success: true, run: journal.startRun((req.body || {}).name || 'Test run') }));
  router.post('/journal/run/stop', (_req, res) => res.json({ success: true, run: journal.stopRun('stopped from Analytics') }));
  router.post('/journal/record', (req, res) => {
    const b = req.body || {};
    const kinds = ['marker', 'relay', 'gpio', 'opto', 'emu-in', 'emu-out', 'card', 'keypad', 'tamper', 'powerfail'];
    if (!kinds.includes(b.k)) return res.status(400).json({ success: false, error: `k must be one of ${kinds.join(', ')}` });
    const e = journal.record(b.k, String(b.ch || (b.k === 'marker' ? 'note' : '')).slice(0, 80), b.v != null ? b.v : 1, 'ui', b.m && typeof b.m === 'object' ? b.m : undefined);
    res.json({ success: true, entry: e });
  });
  router.get('/journal/recent', (req, res) => {
    const n = Math.min(500, Number(req.query.limit) || 100);
    const since = Number(req.query.since) || Date.now() - 3600000;
    res.json({ success: true, entries: journal.read({ from: since }).slice(-n) });
  });
  router.get('/journal/export', (req, res) => {
    const run = req.query.run ? String(req.query.run) : null;
    const from = Number(req.query.from) || 0, to = Number(req.query.to) || Date.now();
    const entries = journal.read({ run, from, to });
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="aether-journal-${run || new Date(from || Date.now()).toISOString().slice(0, 10)}.jsonl"`);
    res.send(entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  });

  router.get('/health', (_req, res) => res.json({ success: true, multer: !!multer, busy, redactCheck: redact('"token":"abcdefghijkl"') }));

  return router;
};
