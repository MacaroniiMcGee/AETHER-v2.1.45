// AETHER_SUNAPI_LIMITS — NHP limits test + firmware comparison (Update SUNAPI-5).
//
// Runs backend/tools/nhp_limits.py (Python standard library only) against a device saved in
// the SUNAPI Console. The password comes from the console's credential store and goes to the
// script in its environment, never on a command line or to the browser.
//
//   POST   /api/sunapi/limits/runs              start a run   {deviceId, levels[], doorToken?, doorCommands?, capacityMenus?, capacityCap?, lockoutUser?, lockoutPassword?, confirmed:{door,capacity,lockout}}
//   GET    /api/sunapi/limits/job?since=N       the running / last job with progress events from N
//   POST   /api/sunapi/limits/job/stop          stop it (SIGINT: the script removes its test objects first)
//   GET    /api/sunapi/limits/runs[?deviceId=]  saved runs (newest first)
//   GET    /api/sunapi/limits/runs/:id          one run with its full report (all sheets)
//   GET    /api/sunapi/limits/runs/:id/xlsx     the Excel report
//   DELETE /api/sunapi/limits/runs/:id
//   POST   /api/sunapi/limits/import?name=x.xlsx   body = .xlsx (application/octet-stream) -> saved as a run
//   POST   /api/sunapi/limits/export-xlsx       {name, sheets:{name: rows}} -> .xlsx (the Compare tab's Excel download)
//
// Data: backend/data/sunapi/limits/<id>/ (meta.json, report.json, report.xlsx, report.log.jsonl, output.txt).
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const BASE = path.join(__dirname, '..', 'data', 'sunapi');
const RUNS = path.join(BASE, 'limits');
const TOOL = path.join(__dirname, '..', 'tools', 'nhp_limits.py');
const KEEP_RUNS = 60;
const LEVELS = ['discovery', 'protocol', 'validation', 'load', 'connector', 'door', 'capacity', 'lockout'];
const RISKY = ['door', 'capacity', 'lockout'];
const PY = process.env.AETHER_PYTHON || 'python3';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const safeId = id => (typeof id === 'string' && /^[a-z0-9-]{4,64}$/i.test(id) ? id : null);
const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const runDir = id => path.join(RUNS, id);
const tokenOk = v => typeof v === 'string' && /^[\w.-]{1,32}$/.test(v);
const listOk = v => typeof v === 'string' && /^[\w.,-]{0,400}$/.test(v);

function summaryOf(report) {
  const m = {};
  for (const r of ((report && report.sheets && report.sheets.Summary) || []).slice(1)) { if (!r[0]) break; m[String(r[0])] = r[1]; }
  const counts = {};
  for (const r of ((report && report.sheets && report.sheets.Results) || []).slice(1)) { const k = r[6]; if (k) counts[k] = (counts[k] || 0) + 1; }
  return { model: m.Model || '', firmware: m.Firmware || '', levels: m['Levels run'] || '', started: m.Started || '', tool: m.Tool || '', counts };
}

function prune() {
  let all = [];
  try { all = fs.readdirSync(RUNS).map(id => ({ id, m: readJson(path.join(runDir(id), 'meta.json'), null) })).filter(x => x.m); } catch { return; }
  all.sort((a, z) => (z.m.startedAt || 0) - (a.m.startedAt || 0));
  for (const old of all.slice(KEEP_RUNS)) fs.rmSync(runDir(old.id), { recursive: true, force: true });
}

module.exports = function sunapiLimitsRoutes() {
  const router = express.Router();
  fs.mkdirSync(RUNS, { recursive: true });
  let job = null;   // { meta, events[], child, out[] }

  const devices = () => readJson(path.join(BASE, 'devices.json'), []);
  const creds = () => readJson(path.join(BASE, 'sunapi-credentials.json'), {});

  router.get('/runs', (req, res) => {
    let list = [];
    try { list = fs.readdirSync(RUNS).map(id => readJson(path.join(runDir(id), 'meta.json'), null)).filter(Boolean); } catch { /* */ }
    if (req.query.deviceId) list = list.filter(m => m.deviceId === req.query.deviceId);
    list.sort((a, z) => (z.startedAt || 0) - (a.startedAt || 0));
    res.json(list);
  });

  router.get('/runs/:id', (req, res) => {
    const id = safeId(req.params.id);
    const meta = id && readJson(path.join(runDir(id), 'meta.json'), null);
    if (!meta) return res.status(404).json({ error: 'Run not found' });
    res.json({ ...meta, report: readJson(path.join(runDir(id), 'report.json'), null) });
  });

  router.get('/runs/:id/xlsx', (req, res) => {
    const id = safeId(req.params.id);
    const meta = id && readJson(path.join(runDir(id), 'meta.json'), null);
    const f = id && path.join(runDir(id), 'report.xlsx');
    if (!meta || !fs.existsSync(f)) return res.status(404).json({ error: 'No Excel report for this run' });
    const name = (meta.fileName || `nhp-limits-${(meta.host || 'report').replace(/[^\w.-]/g, '_')}-${(meta.firmware || '').replace(/[^\w.-]/g, '_')}-${id}.xlsx`).replace(/"/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    fs.createReadStream(f).pipe(res);
  });

  router.delete('/runs/:id', (req, res) => {
    const id = safeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    if (job && job.meta.id === id && job.meta.state === 'running') return res.status(409).json({ error: 'This run is still going. Stop it first.' });
    fs.rmSync(runDir(id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  router.get('/job', (req, res) => {
    if (!job) return res.json(null);
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    res.json({ ...job.meta, events: job.events.slice(since), eventCount: job.events.length, outputTail: job.out.slice(-12), steps: job.steps || [] });
  });

  router.post('/job/stop', (req, res) => {
    if (!job || job.meta.state !== 'running' || !job.child) return res.status(409).json({ error: 'No test is running' });
    job.meta.stopping = true;
    try { job.child.kill('SIGINT'); } catch { /* */ }
    setTimeout(() => { if (job && job.child && job.meta.state === 'running') { try { job.child.kill('SIGKILL'); } catch { /* */ } } }, 120000);
    res.json({ ok: true });
  });

  router.post('/runs', (req, res) => {
    const b = req.body || {};
    if (job && job.meta.state === 'running') return res.status(409).json({ error: `A test is already running on ${job.meta.deviceName}. Wait for it or stop it.` });
    const dev = devices().find(d => d.id === b.deviceId);
    if (!dev) return res.status(404).json({ error: 'Device not found' });
    const pass = creds()[dev.id];
    if (!pass) return res.status(400).json({ error: 'No password saved for this device. Edit the device and add one.' });
    if (!fs.existsSync(TOOL)) return res.status(500).json({ error: 'nhp_limits.py is missing on the Pi (backend/tools). Reinstall Update SUNAPI-5.' });
    const levels = (Array.isArray(b.levels) ? b.levels : []).filter(l => LEVELS.includes(l));
    if (!levels.length) return res.status(400).json({ error: 'Pick at least one test level' });
    const confirmed = b.confirmed || {};
    const missing = RISKY.filter(l => levels.includes(l) && confirmed[l] !== true);
    if (missing.length) return res.status(428).json({ error: `Confirm first: ${missing.join(', ')} change the controller.`, needs: missing });
    if (levels.includes('door') && !tokenOk(b.doorToken)) return res.status(400).json({ error: 'The door test needs a door token (e.g. 1)' });
    for (const k of ['doorCommands', 'capacityMenus']) if (b[k] != null && !listOk(b[k])) return res.status(400).json({ error: `${k} has characters it should not` });
    if (b.lockoutUser != null && b.lockoutUser !== '' && !/^[\w.@-]{1,64}$/.test(b.lockoutUser)) return res.status(400).json({ error: 'Lockout user name has characters it should not' });

    const id = newId(), dir = runDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const args = [TOOL, '--host', dev.host, '--port', String(dev.port || (dev.https ? 443 : 80)), '--scheme', dev.https ? 'https' : 'http',
      '--user', dev.user || 'admin', '--root', dev.cgiRoot || 'stw-cgi', '--levels', levels.join(','), '--yes',
      '--out', path.join(dir, 'report.xlsx'), '--json-out', path.join(dir, 'report.json')];
    if (b.doorToken) args.push('--door-token', b.doorToken);
    if (b.doorCommands) args.push('--door-commands', b.doorCommands);
    if (b.capacityMenus) args.push('--capacity-menus', b.capacityMenus);
    if (b.capacityCap) args.push('--capacity-cap', String(Math.min(250000, Math.max(1, parseInt(b.capacityCap, 10) || 1000))));
    if (b.lockoutUser) args.push('--lockout-user', b.lockoutUser);
    const env = { ...process.env, NHP_PASSWORD: pass, NHP_PROGRESS: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    if (b.lockoutPassword) env.NHP_LOCKOUT_PASSWORD = String(b.lockoutPassword);

    const meta = { id, source: 'run', deviceId: dev.id, deviceName: dev.name, host: dev.host, model: dev.model || '', firmware: dev.firmware || '',
      levels, doorToken: b.doorToken || null, startedAt: Date.now(), endedAt: null, state: 'running', counts: {}, level: null, error: null };
    writeJson(path.join(dir, 'meta.json'), meta);
    let child;
    try { child = spawn(PY, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { meta.state = 'error'; meta.error = `Could not start Python: ${e.message}`; writeJson(path.join(dir, 'meta.json'), meta); return res.status(500).json({ error: meta.error }); }
    job = { meta, events: [], child, out: [], steps: null };
    const outFile = fs.createWriteStream(path.join(dir, 'output.txt'));
    let buf = '';
    const onData = chunk => {
      outFile.write(chunk);
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line.startsWith('@@')) {
          try {
            const ev = JSON.parse(line.slice(2));
            if (ev.t === 'level') meta.level = ev.level;
            if (ev.t === 'result') { meta.counts[ev.result] = (meta.counts[ev.result] || 0) + 1; job.events.push({ ...ev, at: Date.now() }); }
            if (ev.t === 'sequence') job.steps = ev.menus.map(m => ({ menu: m, phase: 'pending', declared: ev.declared ? ev.declared[m] : null }));
            if (ev.t === 'step') {
              if (!job.steps) job.steps = [];
              let st = job.steps.find(x => x.menu === ev.menu);
              if (!st) { st = { menu: ev.menu }; job.steps.push(st); }
              const { t, ...rest } = ev;
              Object.assign(st, rest, { phase: ev.phase === 'cleanup' ? (st.result ? 'finished' : 'cleanup') : ev.phase, at: Date.now() });
              if (ev.phase === 'cleanup') { st.removed = ev.removed; st.left = ev.left; }
            }
          } catch { /* not ours */ }
        } else if (line.trim()) { job.out.push(line); if (job.out.length > 200) job.out.shift(); }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { meta.error = e.code === 'ENOENT' ? `${PY} is not installed on the Pi` : e.message; });
    child.on('close', code => {
      outFile.end();
      const report = readJson(path.join(dir, 'report.json'), null);
      if (report) { const sm = summaryOf(report); Object.assign(meta, { model: sm.model || meta.model, firmware: sm.firmware || meta.firmware, counts: sm.counts, tool: sm.tool }); }
      meta.endedAt = Date.now();
      meta.state = meta.stopping ? 'stopped' : code === 0 && report ? 'done' : 'error';
      if (meta.state === 'error' && !meta.error) meta.error = (job.out.slice(-3).join(' · ') || `exit code ${code}`).slice(0, 400);
      delete meta.stopping; meta.level = null;
      if (job.steps && job.steps.length) meta.steps = job.steps;
      writeJson(path.join(dir, 'meta.json'), meta);
      job.child = null;
      prune();
    });
    res.json(meta);
  });

  // ---- built-in mock NHP (Push sequence rehearsal without hardware) ----
  const MOCK_DIR = path.join(__dirname, '..', 'tools', 'mock');
  const MOCK_PORT = 18443, MOCK_REDIRECT = 18080, MOCK_ID = 'aethermock';
  let mock = null;   // { child, https, startedAt, log[] }
  const mockState = () => ({ running: !!(mock && mock.child), https: mock ? mock.https : null, startedAt: mock ? mock.startedAt : null, deviceId: MOCK_ID, port: MOCK_PORT, log: mock ? mock.log.slice(-5) : [] });
  router.get('/mock', (req, res) => res.json(mockState()));
  router.post('/mock/start', (req, res) => {
    if (mock && mock.child) return res.json(mockState());
    if (!fs.existsSync(path.join(MOCK_DIR, 'mock_nhp.py'))) return res.status(500).json({ error: 'The mock controller files are missing (backend/tools/mock). Reinstall Update SUNAPI-5.' });
    const cert = path.join(MOCK_DIR, 'mock.crt'), key = path.join(MOCK_DIR, 'mock.key');
    const launch = useTls => {
      const args = [path.join(MOCK_DIR, 'mock_nhp.py'), String(MOCK_PORT), String(MOCK_REDIRECT)].concat(useTls ? [cert, key] : []);
      const child = spawn(PY, args, { cwd: MOCK_DIR, env: { ...process.env, MOCK_LOCK_S: '20', MOCK_AP_MAX: String(Math.min(500, Math.max(1, parseInt(req.body && req.body.accessLevels, 10) || 30))) }, stdio: ['ignore', 'pipe', 'pipe'] });
      mock = { child, https: useTls, startedAt: Date.now(), log: [] };
      const add = d => { mock && mock.log.push(...d.toString().split('\n').filter(Boolean)); if (mock && mock.log.length > 50) mock.log.splice(0, mock.log.length - 50); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      child.on('close', () => { if (mock && mock.child === child) mock.child = null; });
      // register (or refresh) the mock as a SUNAPI Console device
      const devs = devices().filter(d => d.id !== MOCK_ID);
      devs.push({ id: MOCK_ID, name: 'Built-in mock NHP (Aether)', host: '127.0.0.1', port: MOCK_PORT, https: useTls, user: 'admin', kind: 'access', kindManual: true, cgiRoot: 'stw-cgi', model: 'NHP-P200 (mock)', firmware: '26.04.03_mock', source: 'mock' });
      writeJson(path.join(BASE, 'devices.json'), devs);
      const c = creds(); c[MOCK_ID] = 'Passw0rd!'; fs.writeFileSync(path.join(BASE, 'sunapi-credentials.json'), JSON.stringify(c), { mode: 0o600 });
      setTimeout(() => res.json(mockState()), 900);
    };
    if (fs.existsSync(cert) && fs.existsSync(key)) return launch(true);
    execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=Aether mock NHP'], { timeout: 60000 }, err => launch(!err));
  });
  router.post('/mock/stop', (req, res) => {
    if (mock && mock.child) { try { mock.child.kill('SIGTERM'); } catch { /* */ } mock.child = null; }
    res.json(mockState());
  });

  router.post('/export-xlsx', (req, res) => {
    const b = req.body || {};
    if (!b.sheets || typeof b.sheets !== 'object') return res.status(400).json({ error: 'sheets missing' });
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nhp-export-'));
    const inp = path.join(dir, 'in.json'), out = path.join(dir, 'out.xlsx');
    fs.writeFileSync(inp, JSON.stringify({ sheets: b.sheets }));
    execFile(PY, [TOOL, '--json-to-xlsx', inp, out], { timeout: 60000 }, err => {
      if (err || !fs.existsSync(out)) { fs.rmSync(dir, { recursive: true, force: true }); return res.status(500).json({ error: `Could not build the Excel file: ${err ? err.message.split('\n')[0] : 'no output'}` }); }
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${String(b.name || 'compare').replace(/[^\w .-]/g, '_')}.xlsx"`);
      fs.createReadStream(out).on('close', () => fs.rmSync(dir, { recursive: true, force: true })).pipe(res);
    });
  });

  router.post('/import', express.raw({ type: 'application/octet-stream', limit: '40mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.slice(0, 2).toString() !== 'PK') return res.status(400).json({ error: 'That is not an .xlsx file' });
    const id = newId(), dir = runDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const name = String(req.query.name || 'report.xlsx').replace(/[^\w .()-]/g, '_').slice(0, 120);
    fs.writeFileSync(path.join(dir, 'report.xlsx'), buf);
    execFile(PY, [TOOL, '--xlsx-to-json', path.join(dir, 'report.xlsx'), path.join(dir, 'report.json')], { timeout: 60000 }, (err, so, se) => {
      const report = readJson(path.join(dir, 'report.json'), null);
      if (err || !report || !report.sheets || !report.sheets.Results || !report.sheets.Summary) {
        fs.rmSync(dir, { recursive: true, force: true });
        return res.status(400).json({ error: err ? `Could not read it: ${(se || err.message).toString().trim().split('\n').pop()}` : `${name} is not an nhp_limits report (no Summary / Results sheet)` });
      }
      const s = summaryOf(report);
      const ctl = (report.sheets.Summary.find(r => r[0] === 'Controller') || [])[1] || '';
      const meta = { id, source: 'import', fileName: name, deviceId: null, deviceName: name, host: String(ctl).replace(/^https?:\/\//, ''), ...s,
        startedAt: Date.now(), endedAt: Date.now(), state: 'done', levels: s.levels ? s.levels.split(/,\s*/) : [] };
      writeJson(path.join(dir, 'meta.json'), meta);
      prune();
      res.json(meta);
    });
  });

  return router;
};
