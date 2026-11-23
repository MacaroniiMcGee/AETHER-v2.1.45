// backend/lib/remoteAccess.js — AETHER_REMOTE (bundle "remote-1")
//
// Remote Access: reach this Pi from anywhere at https://r-<code>.aetheraccesstools.com.
//
//   - Each unit has a serial number (the Pi's own) and an activation key written at the
//     factory. Turning Remote Access on sends both to the activation service (a Cloudflare
//     Worker we run); it creates this unit's own Cloudflare Tunnel and address and returns
//     a tunnel token. No Cloudflare account key ever lives on the Pi.
//   - cloudflared runs as a child of the backend with that token and hands visitors to
//     http://localhost:3001. Cloudflare adds Cf-Connecting-IP to every request, so the
//     sign-in (authManager) treats every remote visitor as remote: they must sign in.
//   - Remote Access cannot be turned on unless the sign-in (LOGIN-1/2) is installed.
//
// Files (outside the Aether folder, mode 600): /var/lib/aether/remote/
//   identity.json  { key }                 activation key (serial is read from the Pi)
//   tunnel.json    { hostname, url, token }  this unit's tunnel (the token is a secret)
//   config.json    { enabled, apiBase }

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const DEFAULT_API = 'https://activate.aetheraccesstools.com';
const KEY_RE = /^AK-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
const LOG_LINES = 80;

function pickDir() {
  const cands = [process.env.AETHER_REMOTE_DIR, '/var/lib/aether/remote', path.join(__dirname, '..', 'data', 'remote')].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { /* next */ }
  }
  return cands[cands.length - 1];
}
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }
function writeSecret(f, obj) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f); try { fs.chmodSync(f, 0o600); } catch (_) { /* */ } }

/** The Pi's own serial number (lowercase hex); falls back to a stable id from machine-id. */
function piSerial() {
  if (process.env.AETHER_SERIAL) return String(process.env.AETHER_SERIAL).trim().toLowerCase();
  try { const s = fs.readFileSync('/sys/firmware/devicetree/base/serial-number', 'utf8').replace(/\0/g, '').trim(); if (/^[0-9a-f]{8,}$/i.test(s)) return s.toLowerCase(); } catch (_) { /* */ }
  try { const m = /^Serial\s*:\s*([0-9a-f]+)/mi.exec(fs.readFileSync('/proc/cpuinfo', 'utf8')); if (m && !/^0+$/.test(m[1])) return m[1].toLowerCase(); } catch (_) { /* */ }
  try { const id = fs.readFileSync('/etc/machine-id', 'utf8').trim(); if (id) return 'm-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 16); } catch (_) { /* */ }
  return 'm-' + crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
}

function findCloudflared() {
  const cands = [process.env.AETHER_CLOUDFLARED, path.join(__dirname, '..', 'vendor', 'cloudflared', 'cloudflared'), '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'].filter(Boolean);
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) { /* next */ } }
  return null;
}

class RemoteAccess {
  constructor({ app, log = console }) {
    this.app = app; this.log = log;
    this.dir = pickDir();
    this.f = { identity: path.join(this.dir, 'identity.json'), tunnel: path.join(this.dir, 'tunnel.json'), config: path.join(this.dir, 'config.json'), pid: path.join(this.dir, 'cloudflared.pid') };
    this.cfg = Object.assign({ enabled: false, apiBase: '' }, readJson(this.f.config, {}));
    this.serial = piSerial();
    this.proc = null; this.connections = new Set(); this.lastError = null; this.lines = [];
    this.restartTimer = null; this.backoff = 5000; this.startedAt = null; this.stopping = false;
    this.cfVersion = null; this.busy = null;
  }

  apiBase() { return (process.env.AETHER_REMOTE_API || this.cfg.apiBase || DEFAULT_API).replace(/\/+$/, ''); }
  identity() { return readJson(this.f.identity, null); }
  tunnel() { return readJson(this.f.tunnel, null); }
  saveCfg() { writeSecret(this.f.config, this.cfg); }
  authInstalled() { return fs.existsSync(path.join(__dirname, 'authManager.js')); }

  note(line, level = 'info') {
    const s = String(line).replace(/eyJ[A-Za-z0-9_-]{20,}/g, '***');   // never keep a token in the log
    this.lines.push({ t: Date.now(), level, msg: s.slice(0, 400) });
    if (this.lines.length > LOG_LINES) this.lines.shift();
  }

  cloudflaredVersion(bin) {
    if (!bin) { this.cfVersion = null; return; }
    execFile(bin, ['--version'], { timeout: 8000 }, (e, out) => { this.cfVersion = e ? null : String(out).trim().split('\n')[0]; });
  }

  status() {
    const t = this.tunnel();
    const bin = findCloudflared();
    return {
      success: true,
      serial: this.serial,
      identitySet: !!(this.identity() || {}).key,
      authInstalled: this.authInstalled(),
      enabled: !!this.cfg.enabled,
      hostname: t ? t.hostname : null, url: t ? t.url : null, activatedAt: t ? t.activatedAt : null,
      running: !!this.proc, connected: this.connections.size > 0, connections: this.connections.size,
      upSince: this.startedAt, lastError: this.lastError, busy: this.busy,
      cloudflared: { path: bin, version: this.cfVersion },
      apiBase: this.apiBase(),
      log: this.lines.slice(-30),
    };
  }

  // ---------- activation ----------
  async activate() {
    const id = this.identity();
    if (!id || !id.key) throw new Error('No activation key on this unit yet');
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
    let r, j;
    try {
      r = await fetch(`${this.apiBase()}/v1/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serial: this.serial, key: id.key }), signal: ctl.signal });
      j = await r.json().catch(() => null);
    } catch (e) {
      throw new Error(`Can't reach the activation service (${e.name === 'AbortError' ? 'timed out' : (e.cause && e.cause.code) || e.message}). Is this Pi on the internet?`);
    } finally { clearTimeout(tm); }
    if (!r.ok || !j || !j.success) throw new Error((j && j.error) || `Activation service answered HTTP ${r.status}`);
    if (!j.token || !j.hostname) throw new Error('Activation service gave an incomplete answer');
    const prev = this.tunnel() || {};
    writeSecret(this.f.tunnel, { hostname: j.hostname, url: j.url || `https://${j.hostname}`, token: j.token, activatedAt: prev.hostname === j.hostname && prev.activatedAt ? prev.activatedAt : Date.now() });
    this.note(`Activated: ${j.hostname}`);
    return j;
  }

  // ---------- cloudflared ----------
  start() {
    if (this.proc || !this.cfg.enabled) return;
    const t = this.tunnel();
    if (!t || !t.token) { this.lastError = 'Not activated'; return; }
    const bin = findCloudflared();
    if (!bin) { this.lastError = 'cloudflared is not installed on this Pi (re-apply Update REMOTE-1 with internet, or: sudo apt install cloudflared)'; this.note(this.lastError, 'error'); return; }
    this.cloudflaredVersion(bin);
    clearTimeout(this.restartTimer); this.restartTimer = null;
    this.stopping = false; this.connections.clear();
    const env = { ...process.env, TUNNEL_TOKEN: t.token, NO_AUTOUPDATE: 'true' };
    this.killStale();
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--loglevel', 'info', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p; this.startedAt = Date.now();
    try { fs.writeFileSync(this.f.pid, String(p.pid)); } catch (_) { /* */ }
    this.note(`Starting cloudflared (${t.hostname})`);
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        const s = line.trim(); if (!s) continue;
        const idx = /connIndex=(\d+)/.exec(s);
        if (/Registered tunnel connection/i.test(s)) { this.connections.add(idx ? idx[1] : String(this.connections.size)); this.lastError = null; this.backoff = 5000; }
        else if (/Unregistered tunnel connection|Connection terminated|Lost connection/i.test(s) && idx) this.connections.delete(idx[1]);
        const level = /\bERR\b|error|not valid|failed/i.test(s) ? 'error' : /\bWRN\b/.test(s) ? 'warn' : 'info';
        if (level !== 'info' || /Registered|Unregistered|Starting tunnel|Initial protocol|Updated to new configuration/i.test(s)) this.note(s, level);
        if (/Unauthorized|invalid token|token is not valid|tunnel not found|Tunnel credentials/i.test(s)) this.lastError = 'Cloudflare refused this unit\'s tunnel token. Turn Remote Access off and on again.';
      }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', (e) => { this.lastError = `cloudflared: ${e.message}`; this.note(this.lastError, 'error'); });
    p.on('exit', (code, sig) => {
      this.proc = null; this.connections.clear();
      if (this.stopping || !this.cfg.enabled) { this.note('cloudflared stopped'); return; }
      this.lastError = this.lastError || `cloudflared exited (${sig || code}); retrying`;
      this.note(`cloudflared exited (${sig || code}); retrying in ${Math.round(this.backoff / 1000)} s`, 'warn');
      this.restartTimer = setTimeout(() => this.start(), this.backoff);
      if (this.restartTimer.unref) this.restartTimer.unref();
      this.backoff = Math.min(this.backoff * 2, 120000);
    });
  }

  // A cloudflared left running by a backend that died without cleaning up (two would share one token).
  killStale() {
    let pid = 0; try { pid = Number(fs.readFileSync(this.f.pid, 'utf8')); } catch (_) { return; }
    if (!pid || (this.proc && this.proc.pid === pid)) return;
    try { if (!/cloudflared/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) return; } catch (_) { return; }
    try { process.kill(pid, 'SIGTERM'); this.note(`Stopped a cloudflared left over from before (pid ${pid})`, 'warn'); } catch (_) { /* gone */ }
  }

  stop() {
    clearTimeout(this.restartTimer); this.restartTimer = null;
    const p = this.proc; if (!p) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      const k = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) { /* */ } }, 5000);
      p.once('exit', () => { clearTimeout(k); resolve(); });
      try { p.kill('SIGTERM'); } catch (_) { clearTimeout(k); resolve(); }
    });
  }

  // ---------- express ----------
  routes() {
    const app = this.app;
    const bad = (res, e, code = 400) => res.status(code).json({ success: false, error: String((e && e.message) || e) });
    app.get('/api/remote/status', (_req, res) => res.json(this.status()));

    app.post('/api/remote/identity', (req, res) => {
      try {
        const b = req.body || {};
        const key = String(b.key || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!KEY_RE.test(key)) return bad(res, 'That doesn\'t look like an activation key (AK-XXXXXX-XXXXXX-XXXXXX-XXXXXX)');
        writeSecret(this.f.identity, { key, savedAt: Date.now() });
        if (b.apiBase !== undefined) { const a = String(b.apiBase).trim(); if (a && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(a)) return bad(res, 'Activation service must be an https:// address'); this.cfg.apiBase = a; this.saveCfg(); }
        res.json(this.status());
      } catch (e) { bad(res, e, 500); }
    });

    app.post('/api/remote/enable', async (_req, res) => {
      if (!this.authInstalled()) return bad(res, 'Install the sign-in update (LOGIN-2) first: without it anyone on the internet could control this Pi.');
      if (this.busy) return bad(res, 'Already working on it', 409);
      this.busy = 'enable';
      try {
        await this.activate();
        this.cfg.enabled = true; this.saveCfg(); this.lastError = null;
        await this.stop(); this.start();
        res.json(this.status());
      } catch (e) { this.lastError = e.message; this.note(e.message, 'error'); bad(res, e); }
      finally { this.busy = null; }
    });

    app.post('/api/remote/disable', async (_req, res) => {
      try { this.cfg.enabled = false; this.saveCfg(); await this.stop(); this.lastError = null; this.note('Remote Access turned off'); res.json(this.status()); }
      catch (e) { bad(res, e, 500); }
    });

    app.post('/api/remote/restart', async (_req, res) => {
      try { if (!this.cfg.enabled) return bad(res, 'Remote Access is off'); await this.stop(); this.backoff = 5000; this.start(); res.json(this.status()); }
      catch (e) { bad(res, e, 500); }
    });
  }
}

/** Wire into server.js after the HTTPS install (before the built-pages block). */
function install({ app, log }) {
  const m = new RemoteAccess({ app, log: log || console });
  m.routes();
  const kill = () => { if (m.proc) { try { m.proc.kill('SIGTERM'); } catch (_) { /* */ } } };
  process.on('exit', kill);
  setImmediate(() => { if (m.cfg.enabled) { if (m.authInstalled()) m.start(); else { m.lastError = 'Sign-in not installed; Remote Access stays off'; m.log.warn('[REMOTE] ' + m.lastError); } } });
  m.log.log(`[REMOTE] serial ${m.serial}, remote access ${m.cfg.enabled ? 'on' : 'off'}`);
  return m;
}

module.exports = { install, RemoteAccess, piSerial, KEY_RE };
