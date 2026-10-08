// ============================================================================
// Device firmware — send Aether updates and single script files from the browser
// ============================================================================
//
// Mounted at /api/device-firmware by server.js.
//
// Two kinds of upload:
//   • Update bundle  (.zip / .tgz / .tar.gz / the paste-uNN.txt form)
//       If it holds an apply.sh, that runs with the Aether folder as $1.
//       Otherwise its backend/ and frontend/ files are copied over the Aether folder.
//   • Single file    (any file + a destination path inside the Aether folder)
//
// Every job backs up first. The work itself runs in runner.sh, launched through
// /usr/local/sbin/aether-fw-launch (one-time setup, see device-firmware/setup.sh)
// so it lives in its own systemd unit and survives `systemctl restart aether-backend`.
// After a backend restart runner.sh waits for /api/health; if the backend doesn't
// come back it restores the backup and restarts the old version.
//
// Job state lives on disk in <aether>/.device-firmware/jobs/<id>/ (job.json written
// here, status.json and log.txt written by the runner), so the page can follow a job
// straight through a backend restart.
// ============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

let multer;
try { multer = require('multer'); } catch (e) { multer = null; }

const ROOT = path.resolve(__dirname, '..');                 // the Aether folder (holds backend/ and frontend/)
const DATA = path.join(ROOT, '.device-firmware');
const JOBS = path.join(DATA, 'jobs');
const INCOMING = path.join(DATA, 'incoming');
const LAUNCHER = '/usr/local/sbin/aether-fw-launch';
const LOCAL_RUNNER = path.join(__dirname, 'device-firmware', 'runner.sh');
const SETUP_SCRIPT = path.join(__dirname, 'device-firmware', 'setup.sh');
const PORT = Number(process.env.PORT) || 3001;
const MAX_UPLOAD = 300 * 1024 * 1024;
const KEEP_JOBS = 15;
const SERVICE = process.env.AETHER_SERVICE || 'aether-backend';

// Paths a single-file upload may never write to
const BLOCKED = [/(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /^\.device-firmware(\/|$)/];

for (const d of [DATA, JOBS, INCOMING]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* reported by /status */ } }

// ---------------------------------------------------------------- helpers
const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

function newId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
const validId = id => /^\d{8}-\d{6}-[a-f0-9]{4}$/.test(String(id || ''));
const jobDir = id => path.join(JOBS, id);
const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
const writeJson = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); };

// "backend/x.js" style path relative to ROOT, or null if it would leave the Aether folder
function safeRel(p) {
  const rel = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.split('/').some(s => s === '..' || s === '')) return null;
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (BLOCKED.some(r => r.test(rel))) return null;
  return rel;
}

// What a changed path needs afterwards
function effectOf(rel) {
  if (/^frontend\/(src|public|index\.html|vite\.config|tailwind\.config|postcss\.config|tsconfig|package\.json)/.test(rel)) return 'rebuild';
  if (/^backend\//.test(rel)) return 'restart';
  return 'none';
}

async function setupReady() {
  if (!fs.existsSync(LAUNCHER)) return false;
  const r = await run('sudo', ['-n', LAUNCHER, '--check'], { timeout: 8000 });
  return r.ok && r.stdout.includes('ok');
}

async function flashing() {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/osdp/firmware-status`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j && j.inProgress ? j : null;
  } catch (e) { return null; }
}

function loadJob(id) {
  const dir = jobDir(id);
  const job = readJson(path.join(dir, 'job.json'));
  if (!job) return null;
  const st = readJson(path.join(dir, 'status.json'));
  if (st) Object.assign(job, { state: st.state, step: st.step, finishedAt: st.finishedAt || null, result: st.result || null });
  job.hasBackup = fs.existsSync(path.join(dir, 'backup.tgz'));
  return job;
}

// A job still marked running whose unit or process is gone was cut off (power loss, reboot)
async function reconcile(job) {
  if (!job || !['queued', 'running'].includes(job.state)) return job;
  let alive = false;
  if (job.launch === 'systemd') {
    const r = await run('systemctl', ['is-active', `aether-fw-${job.id}`], { timeout: 5000 });
    alive = r.stdout.trim() === 'active' || r.stdout.trim() === 'activating';
  } else if (job.pid) {
    try { process.kill(job.pid, 0); alive = true; } catch (e) { alive = false; }
  }
  if (!alive && Date.now() - (job.launchedAt || 0) > 15000) {
    const st = readJson(path.join(jobDir(job.id), 'status.json'), {});
    if (!st.state || ['queued', 'running'].includes(st.state)) {
      writeJson(path.join(jobDir(job.id), 'status.json'), { ...st, state: 'interrupted', step: st.step || '', finishedAt: Date.now() });
      job.state = 'interrupted';
    }
  }
  return job;
}

function listJobs() {
  let ids = [];
  try { ids = fs.readdirSync(JOBS).filter(validId).sort().reverse(); } catch (e) { /* none */ }
  return ids.map(loadJob).filter(Boolean);
}

async function activeJob() {
  for (const j of listJobs()) {
    if (['queued', 'running'].includes(j.state)) { const r = await reconcile(j); if (['queued', 'running'].includes(r.state)) return r; }
  }
  return null;
}

// Full-folder backups: only ONE is kept. When an update finishes, its backup replaces the previous
// one (older backup files are deleted; their jobs and logs stay in History, just without Restore).
// Never runs while a job is running, so an update in progress always has its own backup to fall back on.
function pruneOldBackups() {
  const all = listJobs();
  if (all.some(j => ['queued', 'running'].includes(j.state))) return;
  let kept = false;
  for (const j of all) {                                  // newest first
    if (j.type !== 'bundle' || !j.hasBackup || !done(j.state)) continue;
    if (!kept) { kept = true; continue; }                 // the newest: this is the backup
    try {
      fs.rmSync(path.join(jobDir(j.id), 'backup.tgz'), { force: true });
      fs.appendFileSync(path.join(jobDir(j.id), 'log.txt'), `\n[${new Date().toLocaleTimeString()}] Backup replaced by a newer update's backup.\n`);
    } catch (e) { /* try again next time */ }
  }
}
const done = s => !!s && !['staged', 'queued', 'running'].includes(s);

function prune() {
  pruneOldBackups();
  const jobs = listJobs().filter(j => !['queued', 'running', 'staged'].includes(j.state));
  for (const j of jobs.slice(KEEP_JOBS)) { try { fs.rmSync(jobDir(j.id), { recursive: true, force: true }); } catch (e) { /* keep */ } }
  // staged uploads nobody applied, older than a day
  for (const j of listJobs().filter(j => j.state === 'staged' && Date.now() - j.createdAt > 86400000)) {
    try { fs.rmSync(jobDir(j.id), { recursive: true, force: true }); } catch (e) { /* keep */ }
  }
}

// Start runner.sh for a job: through the launcher (own systemd unit) when set up, else as a detached child
async function launch(job, env) {
  const dir = jobDir(job.id);
  const lines = Object.entries({ ROOT, SERVICE, PORT, ...env }).map(([k, v]) => `${k}=${shq(String(v))}`);
  fs.writeFileSync(path.join(dir, 'job.env'), lines.join('\n') + '\n');
  writeJson(path.join(dir, 'status.json'), { state: 'queued', step: 'Starting', at: Date.now() });

  if (await setupReady()) {
    const r = await run('sudo', ['-n', LAUNCHER, job.id], { timeout: 20000 });
    if (!r.ok) throw new Error(`Launcher failed: ${(r.stderr || r.stdout).trim() || 'exit ' + r.code}`);
    Object.assign(job, { launch: 'systemd', launchedAt: Date.now() });
  } else {
    if (env.NEEDS_RESTART === '1') throw new Error('Restarting the backend needs the one-time setup (see the top of this page).');
    const child = spawn('bash', [LOCAL_RUNNER, dir], { detached: true, stdio: 'ignore', cwd: dir });
    child.unref();
    Object.assign(job, { launch: 'child', pid: child.pid, launchedAt: Date.now() });
  }
  job.state = 'queued';
  writeJson(path.join(dir, 'job.json'), stripState(job));
  return job;
}
const shq = s => `'${s.replace(/'/g, `'\\''`)}'`;
const stripState = j => { const { state, step, finishedAt, result, hasBackup, ...rest } = j; return rest; };

async function guardBusy(res, mayRestart) {
  const busy = await activeJob();
  if (busy) { res.status(409).json({ success: false, error: `Another job is running: ${busy.title}` }); return true; }
  if (mayRestart) {
    const f = await flashing();
    if (f) { res.status(409).json({ success: false, error: `A reader firmware transfer is in progress${f.readerId ? ` on ${f.readerId}` : ''}. Wait for it to finish; restarting now would cut it off.` }); return true; }
  }
  return false;
}

// ---------------------------------------------------------------- bundle unpacking
// paste-uNN.txt: cat > /tmp/uNN.b64 <<'UNNEOF' … UNNEOF  +  echo "<sha256>  /tmp/uNN.b64" | sha256sum -c …
function decodePaste(text) {
  const m = text.replace(/\r\n/g, '\n').match(/cat\s*>\s*\S+\s*<<'?(\w+)'?\n([\s\S]*?)\n\1(\n|$)/);
  if (!m) return null;
  const b64 = m[2] + '\n';
  const sha = (text.match(/echo\s+"([0-9a-f]{64})\s+\S+"\s*\|\s*sha256sum/) || [])[1];
  if (sha && crypto.createHash('sha256').update(b64).digest('hex') !== sha) throw new Error('Checksum mismatch: the pasted update is incomplete or was changed.');
  return { buf: Buffer.from(m[2].replace(/\s+/g, ''), 'base64'), checked: !!sha };
}

function badEntry(name) {
  const n = name.replace(/\\/g, '/');
  return n.startsWith('/') || n.split('/').includes('..');
}

async function unpack(file, origName, dest) {
  const lower = origName.toLowerCase();
  let archive = file, kind;
  const notes = [];
  if (lower.endsWith('.txt') || lower.endsWith('.sh')) {
    const p = decodePaste(fs.readFileSync(file, 'utf8'));
    if (!p) throw new Error('This text file is not an Aether update (no embedded bundle found).');
    archive = file + '.tgz'; fs.writeFileSync(archive, p.buf); kind = 'tgz';
    notes.push(p.checked ? 'Paste-style update, checksum verified' : 'Paste-style update (no checksum line)');
  } else if (lower.endsWith('.zip')) kind = 'zip';
  else if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) kind = 'tgz';
  else if (lower.endsWith('.tar')) kind = 'tar';
  else throw new Error('Use a .zip, .tgz, .tar.gz, .tar, or the paste-uNN.txt file.');

  const list = kind === 'zip' ? await run('unzip', ['-Z1', archive]) : await run('tar', [kind === 'tar' ? '-tf' : '-tzf', archive]);
  if (!list.ok) throw new Error(`Could not read the archive: ${(list.stderr || '').trim().slice(0, 300)}`);
  const entries = list.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const bad = entries.find(badEntry);
  if (bad) throw new Error(`Refusing archive: entry "${bad}" points outside the bundle.`);

  fs.mkdirSync(dest, { recursive: true });
  const x = kind === 'zip'
    ? await run('unzip', ['-q', '-o', archive, '-d', dest])
    : await run('tar', [kind === 'tar' ? '-xf' : '-xzf', archive, '-C', dest, '--no-same-owner']);
  if (!x.ok) throw new Error(`Could not unpack: ${(x.stderr || '').trim().slice(0, 300)}`);
  return { entries, notes };
}

// apply.sh at the top or one folder down; otherwise a folder holding backend/ or frontend/
function findPayload(dir) {
  const candidates = [dir];
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name !== '__MACOSX') candidates.push(path.join(dir, e.name)); } catch (e) { /* empty */ }
  for (const c of candidates) if (fs.existsSync(path.join(c, 'apply.sh'))) return { kind: 'apply', base: c };
  for (const c of candidates) if (fs.existsSync(path.join(c, 'backend')) || fs.existsSync(path.join(c, 'frontend'))) return { kind: 'overlay', base: c };
  return null;
}

function walk(base, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(base, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- routes
module.exports = function deviceFirmwareRoutes() {
  const router = express.Router();
  const upload = multer ? multer({ dest: INCOMING, limits: { fileSize: MAX_UPLOAD } }).single('file') : null;
  const withUpload = (req, res, next) => {
    if (!upload) return res.status(500).json({ success: false, error: 'multer is not installed in backend/ (npm install multer)' });
    upload(req, res, err => err ? res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: err.message }) : next());
  };
  const cleanupUpload = req => { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); };

  // ---- overview
  router.get('/status', async (_req, res) => {
    const ready = await setupReady();
    await Promise.all(listJobs().map(reconcile));
    pruneOldBackups();
    const jobs = listJobs().slice(0, KEEP_JOBS);
    res.json({
      success: true, root: ROOT, service: SERVICE, setupReady: ready,
      setupCommand: `sudo bash ${SETUP_SCRIPT}`,
      flashing: await flashing(),
      jobs: jobs.map(j => ({ ...j, files: undefined, fileCount: (j.files || []).length })),
    });
  });

  // ---- bundle: upload + inspect (nothing changes yet)
  router.post('/bundle', withUpload, async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file received (field name "file").' });
    const id = newId(), dir = jobDir(id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const { entries, notes } = await unpack(req.file.path, req.file.originalname, path.join(dir, 'bundle'));
      const payload = findPayload(path.join(dir, 'bundle'));
      if (!payload) throw new Error('No apply.sh and no backend/ or frontend/ folder in this bundle.');
      const relBase = path.relative(path.join(dir, 'bundle'), payload.base);
      let title = req.file.originalname, does = { rebuild: false, restart: false };
      let files = [];
      if (payload.kind === 'apply') {
        const script = fs.readFileSync(path.join(payload.base, 'apply.sh'), 'utf8');
        const t = script.split('\n').slice(0, 8).map(l => l.match(/^#\s*(Update\b.+)$/i)).find(Boolean);
        if (t) title = t[1].trim();
        does = { rebuild: /npm\s+run\s+build|vite\s+build/.test(script), restart: /systemctl\s+restart/.test(script) };
        files = entries.filter(e => !e.endsWith('/')).map(e => e.replace(/^\.\//, ''));
        if (/sudo\s+(?!.*systemctl\s+restart)/.test(script.replace(/sudo\s+systemctl\s+restart[^\n]*/g, ''))) notes.push('apply.sh also uses sudo for something other than a restart; that step will fail without a terminal.');
      } else {
        files = walk(payload.base).filter(f => !/(^|\/)(node_modules|\.git)(\/|$)/.test(f));
        const unsafe = files.find(f => !safeRel(f));
        if (unsafe) throw new Error(`Refusing bundle: "${unsafe}" can't be written.`);
        does = { rebuild: files.some(f => effectOf(f) === 'rebuild'), restart: files.some(f => effectOf(f) === 'restart') };
        notes.push(`${files.length} file(s) will be copied into the Aether folder`);
        files = files.map(f => ({ path: f, exists: fs.existsSync(path.join(ROOT, f)) }));
      }
      const job = { id, type: 'bundle', title, source: req.file.originalname, size: req.file.size, createdAt: Date.now(), payload: payload.kind, base: relBase, does, notes, files };
      writeJson(path.join(dir, 'job.json'), job);
      writeJson(path.join(dir, 'status.json'), { state: 'staged', step: 'Waiting for Apply', at: Date.now() });
      prune();
      res.json({ success: true, job: { ...job, state: 'staged' } });
    } catch (e) {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      res.status(400).json({ success: false, error: e.message });
    } finally { cleanupUpload(req); }
  });

  router.post('/jobs/:id/apply', async (req, res) => {
    const { id } = req.params;
    if (!validId(id)) return res.status(400).json({ success: false, error: 'Bad job id' });
    const job = loadJob(id);
    if (!job || job.type !== 'bundle' || job.state !== 'staged') return res.status(404).json({ success: false, error: 'No staged bundle with that id' });
    if (await guardBusy(res, true)) return;
    try {
      const needsRestart = job.payload === 'apply' ? job.does.restart : job.does.restart;
      await launch(job, {
        MODE: 'bundle', PAYLOAD: job.payload, SRC: path.join(jobDir(id), 'bundle', job.base || ''),
        REBUILD: job.payload === 'overlay' && job.does.rebuild ? '1' : '0',
        RESTART: job.payload === 'overlay' && job.does.restart ? '1' : '0',
        NEEDS_RESTART: needsRestart ? '1' : '0',
      });
      res.json({ success: true, job: loadJob(id) });
    } catch (e) {
      writeJson(path.join(jobDir(id), 'status.json'), { state: 'staged', step: 'Waiting for Apply', at: Date.now() });
      res.status(400).json({ success: false, error: e.message });
    }
  });

  router.delete('/jobs/:id', (req, res) => {
    const { id } = req.params;
    const job = validId(id) && loadJob(id);
    if (!job) return res.status(404).json({ success: false, error: 'Not found' });
    if (['queued', 'running'].includes(job.state)) return res.status(409).json({ success: false, error: 'Job is running' });
    fs.rmSync(jobDir(id), { recursive: true, force: true });
    res.json({ success: true });
  });

  // ---- job progress: status + log from a byte offset (the page polls this)
  router.get('/jobs/:id', async (req, res) => {
    const { id } = req.params;
    if (!validId(id)) return res.status(400).json({ success: false, error: 'Bad job id' });
    const job = await reconcile(loadJob(id));
    if (!job) return res.status(404).json({ success: false, error: 'Not found' });
    if (job.type === 'bundle' && done(job.state)) pruneOldBackups();
    const from = Math.max(0, Number(req.query.offset) || 0);
    let log = '', size = 0;
    try {
      const f = path.join(jobDir(id), 'log.txt');
      size = fs.statSync(f).size;
      if (size > from) {
        const fd = fs.openSync(f, 'r'); const len = Math.min(size - from, 512 * 1024);
        const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, from); fs.closeSync(fd);
        log = b.toString('utf8'); size = from + len;
      } else size = from;
    } catch (e) { size = from; }
    res.json({ success: true, job, log, offset: size });
  });

  // ---- restore a job's backup
  router.post('/jobs/:id/restore', async (req, res) => {
    const { id } = req.params;
    const src = validId(id) && loadJob(id);
    if (!src || !fs.existsSync(path.join(jobDir(id), 'backup.tgz'))) return res.status(404).json({ success: false, error: 'No backup for that job' });
    const restart = src.type === 'bundle' ? true : effectOf(src.dest) === 'restart';
    const rebuild = src.type === 'file' && effectOf(src.dest) === 'rebuild';
    if (await guardBusy(res, restart)) return;
    const nid = newId(); fs.mkdirSync(jobDir(nid), { recursive: true });
    const job = { id: nid, type: 'restore', title: `Restore before: ${src.title}`, restoreOf: id, createdAt: Date.now(), does: { rebuild, restart } };
    writeJson(path.join(jobDir(nid), 'job.json'), job);
    try {
      await launch(job, {
        MODE: 'restore', BACKUP: path.join(jobDir(id), 'backup.tgz'),
        REMOVE: src.type === 'file' && !src.existed ? src.dest : '',
        REBUILD: rebuild ? '1' : '0', RESTART: restart ? '1' : '0', NEEDS_RESTART: restart ? '1' : '0',
      });
      res.json({ success: true, job: loadJob(nid) });
    } catch (e) { fs.rmSync(jobDir(nid), { recursive: true, force: true }); res.status(400).json({ success: false, error: e.message }); }
  });

  // ---- single file
  // Find where a file with this name already lives, to prefill the destination
  router.get('/find', async (req, res) => {
    const name = path.basename(String(req.query.name || ''));
    if (!name) return res.json({ success: true, matches: [] });
    const matches = [];
    const skip = new Set(['node_modules', '.git', '.device-firmware', 'dist']);
    (function scan(rel, depth) {
      if (depth > 6 || matches.length >= 20) return;
      let ents = []; try { ents = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!skip.has(e.name)) scan(r, depth + 1); } else if (e.name === name) matches.push(r);
      }
    })('', 0);
    res.json({ success: true, matches: matches.map(m => ({ path: m, effect: effectOf(m) })) });
  });

  // Folder listing for the destination picker
  router.get('/browse', (req, res) => {
    const rel = String(req.query.dir || '').replace(/^\/+|\/+$/g, '');
    if (rel && !safeRel(rel)) return res.status(400).json({ success: false, error: 'Not allowed' });
    try {
      const ents = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
        .filter(e => !['node_modules', '.git', '.device-firmware'].includes(e.name))
        .map(e => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      res.json({ success: true, dir: rel, entries: ents });
    } catch (e) { res.status(404).json({ success: false, error: 'Folder not found' }); }
  });

  router.post('/file', withUpload, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'No file received (field name "file").' });
      const dest = safeRel(req.body.dest);
      if (!dest) return res.status(400).json({ success: false, error: 'Destination must be a path inside the Aether folder (not node_modules or .git).' });
      const abs = path.join(ROOT, dest);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return res.status(400).json({ success: false, error: 'Destination is a folder; add the file name.' });
      if (!fs.existsSync(path.dirname(abs))) return res.status(400).json({ success: false, error: `Folder ${path.dirname(dest)} doesn't exist.` });
      const after = ['none', 'rebuild', 'restart'].includes(req.body.after) ? req.body.after : effectOf(dest);
      if (await guardBusy(res, after === 'restart')) return;
      if (after === 'restart' && !(await setupReady())) return res.status(400).json({ success: false, error: 'Restarting the backend needs the one-time setup (see the top of this page). You can upload with "Then: nothing" and restart by hand.' });

      const id = newId(), dir = jobDir(id); fs.mkdirSync(dir, { recursive: true });
      const existed = fs.existsSync(abs);
      if (existed) {
        const b = await run('tar', ['-czf', path.join(dir, 'backup.tgz'), '-C', ROOT, dest]);
        if (!b.ok) { fs.rmSync(dir, { recursive: true, force: true }); return res.status(500).json({ success: false, error: `Backup failed, nothing changed: ${b.stderr.trim()}` }); }
      } else {
        // empty backup so restore just removes the new file
        await run('tar', ['-czf', path.join(dir, 'backup.tgz'), '-T', '/dev/null']);
      }
      const mode = existed ? (fs.statSync(abs).mode & 0o777) : (/\.(sh|py)$/.test(dest) ? 0o755 : 0o644);
      fs.copyFileSync(req.file.path, abs + '.fw-new');
      fs.chmodSync(abs + '.fw-new', mode);
      fs.renameSync(abs + '.fw-new', abs);
      fs.writeFileSync(path.join(dir, 'log.txt'), `Wrote ${dest} (${req.file.size} bytes)${existed ? ', old copy backed up' : ', new file'}\n`);

      const job = { id, type: 'file', title: dest, dest, existed, source: req.file.originalname, size: req.file.size, createdAt: Date.now(), does: { rebuild: after === 'rebuild', restart: after === 'restart' } };
      writeJson(path.join(dir, 'job.json'), job);
      if (after === 'none') {
        writeJson(path.join(dir, 'status.json'), { state: 'success', step: 'Done', finishedAt: Date.now(), at: Date.now() });
      } else {
        await launch(job, {
          MODE: 'file', DEST: dest, EXISTED: existed ? '1' : '0', BACKUP: path.join(dir, 'backup.tgz'),
          REBUILD: after === 'rebuild' ? '1' : '0', RESTART: after === 'restart' ? '1' : '0', NEEDS_RESTART: after === 'restart' ? '1' : '0',
        });
      }
      prune();
      res.json({ success: true, job: loadJob(id) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    } finally { cleanupUpload(req); }
  });

  // Restart / rebuild on their own (e.g. after several "Then: nothing" uploads)
  router.post('/action', express.json(), async (req, res) => {
    const what = req.body && req.body.action;
    if (!['rebuild', 'restart'].includes(what)) return res.status(400).json({ success: false, error: 'action must be rebuild or restart' });
    if (await guardBusy(res, what === 'restart')) return;
    const id = newId(); fs.mkdirSync(jobDir(id), { recursive: true });
    const job = { id, type: 'action', title: what === 'rebuild' ? 'Rebuild web pages' : `Restart ${SERVICE}`, createdAt: Date.now(), does: { rebuild: what === 'rebuild', restart: what === 'restart' } };
    writeJson(path.join(jobDir(id), 'job.json'), job);
    try {
      await launch(job, { MODE: 'action', REBUILD: what === 'rebuild' ? '1' : '0', RESTART: what === 'restart' ? '1' : '0', NEEDS_RESTART: what === 'restart' ? '1' : '0' });
      res.json({ success: true, job: loadJob(id) });
    } catch (e) { fs.rmSync(jobDir(id), { recursive: true, force: true }); res.status(400).json({ success: false, error: e.message }); }
  });

  return router;
};
