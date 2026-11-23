'use strict';
// AETHER_AUTH: sign-in for the whole Aether UI, API and socket.io.
//
// - One account to start with: admin / Aether01! . Until that password is changed
//   the session can only reach the change-password page (and the auth API).
// - Nothing else is served without a session: pages redirect to /login, /api and
//   /socket.io answer 401. A few harmless paths stay open (see OPEN_PATHS).
// - Requests made on the Pi itself (127.0.0.1 with no proxy headers) are trusted:
//   the firmware runner's health check, the Stream View capture, pi-monitor.
//   A tunnel (cloudflared) also connects from 127.0.0.1 but always adds
//   Cf-Connecting-IP / X-Forwarded-For, so tunnelled visitors still sign in.
// - Accounts and sessions live outside the Aether folder (/var/lib/aether/auth,
//   falling back to backend/data/auth), so updates, pi-sync and backups don't carry them.
//
// Forgot the password?  On the Pi:  sudo node backend/lib/authManager.js --reset
// (puts admin / Aether01! back and signs everyone out; the backend picks it up within a few seconds).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'Aether01!';
const COOKIE = 'aether_session';
const IDLE_MS = 12 * 3600 * 1000;          // signed out after 12 h without use
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;   // and after 7 days regardless
const MIN_LEN = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// Reachable without a session.
const OPEN_EXACT = new Set([
  '/login', '/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/auth/ui.js',
  '/api/health', '/health',          // firmware runner, cluster status dots
  '/api/https/ping',                  // HTTPS "Check from this browser" (cross-origin)
  '/aether-https-shim.js',
  '/favicon.ico',
]);
const OPEN_PREFIX = ['/hv-fonts/'];
// Reachable with a session that still has to change the default password.
const CHANGE_ONLY = new Set(['/change-password', '/api/auth/change-password', '/api/auth/me']);

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'cdn-loop', 'true-client-ip'];

function candidateDirs() {
  return [process.env.AETHER_AUTH_DIR, '/var/lib/aether/auth', path.join(__dirname, '..', 'data', 'auth')].filter(Boolean);
}
function pickDir() {
  for (const d of candidateDirs()) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { /* next */ }
  }
  throw new Error('no writable folder for sign-in data');
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function scrypt(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(password), Buffer.from(salt, 'hex'), SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt);
  return { salt, hash: key.toString('hex'), algo: 'scrypt', N: SCRYPT.N };
}
async function verifyPassword(rec, password) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const key = await scrypt(password, rec.salt);
  const want = Buffer.from(rec.hash, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { out[k] = part.slice(i + 1).trim(); } }
  }
  return out;
}

function isLoopback(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
/** Made on the Pi itself, not through a proxy or tunnel. */
function isTrustedLocal(req) {
  if (process.env.AETHER_AUTH_TRUST_LOOPBACK === '0') return false;
  if (!isLoopback(req.socket && req.socket.remoteAddress)) return false;
  return !PROXY_HEADERS.some(h => req.headers[h] != null);
}
function clientIp(req) {
  const ra = String(req.socket && req.socket.remoteAddress || '');
  if (isLoopback(ra)) {
    const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return String(fwd);
  }
  return ra.replace(/^::ffff:/, '');
}
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return isLoopback(req.socket && req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/** Only same-site relative paths, or an absolute URL on the same host name (Vite dev on :5173). */
function safeNext(raw, req) {
  const s = String(raw || '');
  if (/^\/(?![\/\\])/.test(s) && !/[\r\n]/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.toLowerCase().replace(/^\[|\]$/g, '') === host) return u.toString();
  } catch (_) { /* not a URL */ }
  return '/';
}

function localHostNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`, 'aether']);
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n && n.address) names.add(n.address.toLowerCase());
  } catch (_) { /* */ }
  try { const f = global.__aetherHttps && global.__aetherHttps.fqdn && global.__aetherHttps.fqdn(); if (f) names.add(String(f).toLowerCase()); } catch (_) { /* */ }
  for (const extra of String(process.env.AETHER_AUTH_ORIGINS || '').split(',')) if (extra.trim()) names.add(extra.trim().toLowerCase());
  return names;
}
function originHost(origin) {
  try { return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return ''; }
}
/** An Origin that is this Pi on another port (Vite dev server), so it may send the cookie. */
function isOwnOrigin(origin, req) {
  const h = originHost(origin);
  if (!h) return false;
  if (req) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (host && h === host) return true;
  }
  return localHostNames().has(h);
}

/** https://<fqdn>[:port] when the HTTPS name is set up and this request came over plain HTTP from another machine. */
function secureBase(req) {
  try {
    const m = global.__aetherHttps;
    if (!m || (req.socket && req.socket.encrypted) || isLoopback(req.socket && req.socket.remoteAddress)) return '';
    if (/(?:^|;\s*)aether_http=1/.test(String(req.headers.cookie || ''))) return '';
    if (typeof m.redirectActive !== 'function' || !m.redirectActive()) return '';
    const host = m.fqdn();
    return host ? `https://${host}${m.listenPort === 443 ? '' : ':' + m.listenPort}` : '';
  } catch (_) { return ''; }
}

const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** Options for cors(): credentials only for this Pi on another port (Vite dev); everyone else as before. */
function corsDelegate() {
  return (req, cb) => {
    const origin = req.headers.origin;
    if (origin && isOwnOrigin(origin, req)) return cb(null, { origin: true, credentials: true, methods: CORS_METHODS });
    cb(null, { origin: '*', methods: CORS_METHODS });
  };
}
/** cors option for the socket.io server. */
function socketCors() {
  return { origin: (origin, cb) => cb(null, origin && isOwnOrigin(origin) ? origin : '*'), credentials: true, methods: CORS_METHODS };
}
/** If sign-in cannot start, refuse everything except the Pi's own requests and the health check. */
function failClosed(app, err) {
  const msg = `Aether sign-in could not start (${err && err.message}). Check the backend log.`;
  console.error('[Auth] ' + msg);
  app.use((req, res, next) => (req.path === '/api/health' || req.path === '/health' || isTrustedLocal(req)) ? next() : res.status(503).type('text/plain').send(msg));
}

class AuthManager {
  constructor({ io, log } = {}) {
    this.io = io || null;
    this.log = log || console;
    this.dir = pickDir();
    this.usersFile = path.join(this.dir, 'users.json');
    this.sessionsFile = path.join(this.dir, 'sessions.json');
    this.fails = new Map();   // ip -> { count, until }
    this.users = null;
    this.sessions = {};
    this.lastSaveSeen = 0;
    this.verifiers = [];   // (req) -> identity | null  (cluster: requests from the main Pi)
    this.uiParts = [];
    this.openPaths = OPEN_EXACT;   // other modules may add paths that check their own credentials     // (req, identity) -> browser JS appended to /api/auth/ui.js
    this.load();
  }

  // ---------- storage ----------
  load() {
    const u = readJson(this.usersFile, null);
    this.users = u && u.users && typeof u.users === 'object' ? u : null;
    this.usersMtime = this.mtime(this.usersFile);
    const s = readJson(this.sessionsFile, {});
    this.sessions = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    this.sessionsMtime = this.mtime(this.sessionsFile);
  }
  mtime(f) { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } }
  /** Pick up a --reset done from the terminal while the backend runs. */
  refreshFromDisk(force) {
    const now = Date.now();
    if (!force && now - (this.lastDiskCheck || 0) < 3000) return;
    this.lastDiskCheck = now;
    if (this.mtime(this.usersFile) !== this.usersMtime || this.mtime(this.sessionsFile) !== this.sessionsMtime) {
      this.load();
      this.disconnectRevoked();
    }
  }
  async ensureDefault() {
    if (this.users && this.users.users[DEFAULT_USER]) return;
    const rec = await hashPassword(DEFAULT_PASS);
    this.users = { version: 1, users: { [DEFAULT_USER]: { ...rec, role: 'admin', mustChange: true, createdAt: new Date().toISOString() } } };
    this.saveUsers();
    this.log.log(`[Auth] created the default account (${DEFAULT_USER}); its password must be changed at first sign-in`);
  }
  saveUsers() { writeJson(this.usersFile, this.users); this.usersMtime = this.mtime(this.usersFile); }
  saveSessions() { writeJson(this.sessionsFile, this.sessions); this.sessionsMtime = this.mtime(this.sessionsFile); }

  // ---------- sessions ----------
  createSession(user, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions[sha256(token)] = { user, created: now, seen: now, ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 160) };
    this.pruneSessions();
    this.saveSessions();
    return token;
  }
  pruneSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.sessions)) {
      if (!s || now - s.seen > IDLE_MS || now - s.created > MAX_AGE_MS || !this.userRec(s.user)) delete this.sessions[k];
    }
  }
  userRec(name) { return this.users && this.users.users ? this.users.users[name] : null; }
  /** -> { sid, user, mustChange } or null */
  sessionFor(req) {
    this.refreshFromDisk();
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const sid = sha256(token);
    const s = this.sessions[sid];
    const now = Date.now();
    if (!s) return null;
    const rec = this.userRec(s.user);
    if (!rec || now - s.seen > IDLE_MS || now - s.created > MAX_AGE_MS) {
      delete this.sessions[sid]; this.saveSessions(); return null;
    }
    s.seen = now;
    if (now - this.lastSaveSeen > 60000) { this.lastSaveSeen = now; try { this.saveSessions(); } catch (_) { /* */ } }
    return { sid, user: s.user, mustChange: !!rec.mustChange, role: rec.role || 'admin' };
  }
  /** A request made for someone: another Aether's gateway (bearer token), checked by registered verifiers. */
  verified(req) {
    for (const v of this.verifiers) { try { const id = v(req); if (id) return id; } catch (_) { /* */ } }
    return null;
  }
  /** Account check for other modules (cluster claim). Counts toward the brute-force lock. */
  async checkPassword(req, user, pass) {
    const ip = clientIp(req);
    const wait = this.lockedFor(ip);
    if (wait) return { ok: false, status: 429, error: `Too many attempts. Try again in ${wait} s.` };
    this.refreshFromDisk(true);
    await this.ensureDefault();
    const name = String(user || '').trim().toLowerCase();
    const rec = this.userRec(name);
    const ok = rec ? await verifyPassword(rec, String(pass || '')) : (await scrypt(String(pass || ''), '00'), false);
    if (!ok) { this.noteFail(ip); return { ok: false, status: 401, error: 'Wrong user name or password' }; }
    this.fails.delete(ip);
    return { ok: true, user: name, mustChange: !!rec.mustChange };
  }

  revoke(predicate) {
    let n = 0;
    for (const [k, s] of Object.entries(this.sessions)) if (predicate(k, s)) { delete this.sessions[k]; n++; }
    if (n) this.saveSessions();
    this.disconnectRevoked();
    return n;
  }
  disconnectRevoked() {
    if (!this.io) return;
    try {
      const nsps = this.io._nsps instanceof Map ? [...this.io._nsps.values()] : [this.io.of('/')];
      for (const nsp of nsps) for (const sock of nsp.sockets.values()) {
        const sid = sock.data && sock.data.aetherSid;
        if (sid && !this.sessions[sid]) sock.disconnect(true);
      }
    } catch (_) { /* */ }
  }

  cookie(req, token, maxAgeMs) {
    const parts = [`${COOKIE}=${token ? encodeURIComponent(token) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor((token ? maxAgeMs : 0) / 1000)}`];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  // ---------- brute force ----------
  lockedFor(ip) {
    const f = this.fails.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }
  noteFail(ip) {
    const f = this.fails.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (f.count - 5)) * 1000;
    this.fails.set(ip, f);
    if (this.fails.size > 5000) this.fails.clear();
  }

  // ---------- middleware ----------
  gate() {
    return (req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      const p = req.path;
      if (OPEN_EXACT.has(p) || OPEN_PREFIX.some(x => p.startsWith(x))) return next();
      if (isTrustedLocal(req)) { req.aetherUser = { user: 'local', role: 'admin', local: true }; return next(); }
      const v = this.verified(req);
      if (v) { req.aetherUser = v; return next(); }
      const s = this.sessionFor(req);
      const api = p.startsWith('/api/') || p === '/api' || p.startsWith('/socket.io');
      if (!s) {
        if (api) { res.setHeader('X-Aether-Auth', 'login'); return res.status(401).json({ success: false, error: 'Sign in required', authRequired: true }); }
        return this.toPage(req, res, '/login');
      }
      req.aetherUser = s;
      if (s.mustChange && !CHANGE_ONLY.has(p)) {
        if (api) { res.setHeader('X-Aether-Auth', 'change'); return res.status(403).json({ success: false, error: 'Change the default password first', mustChangePassword: true }); }
        return this.toPage(req, res, '/change-password');
      }
      next();
    };
  }
  /** Redirect a page load to /login or /change-password. The sign-in page itself moves to HTTPS when this browser can reach it. */
  toPage(req, res, where) {
    const accept = String(req.headers.accept || '');
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(401).type('text/plain').send('Sign in required');
    if (!accept.includes('text/html') && !/\.html?$/.test(req.path) && req.path !== '/') {
      return res.status(401).type('text/plain').send('Sign in required');
    }
    const go = () => {
      const next = req.originalUrl && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${where}${next}`);
    };
    go();
  }

  socketMiddleware() {
    return (socket, next) => {
      const req = socket.request;
      if (isTrustedLocal(req) || this.verified(req)) return next();
      const s = this.sessionFor(req);
      if (!s) return next(new Error('auth_required'));
      if (s.mustChange) return next(new Error('password_change_required'));
      socket.data = socket.data || {};
      socket.data.aetherSid = s.sid;
      next();
    };
  }

  // ---------- routes ----------
  routes(app, express) {
    const json = express.json({ limit: '8kb' });
    const form = express.urlencoded({ extended: false, limit: '8kb' });
    const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

    app.get('/login', (req, res) => {
      noStore(res);
      if (this.sessionFor(req)) return res.redirect(302, safeNext(req.query.next, req));
      res.type('html').send(pageHtml('login', { next: safeNext(req.query.next, req), secure: secureBase(req) }));
    });
    app.get('/change-password', (req, res) => {
      noStore(res);
      const s = this.sessionFor(req);
      if (!s) return res.redirect(302, '/login');
      res.type('html').send(pageHtml('change', { next: safeNext(req.query.next, req), user: s.user, forced: s.mustChange }));
    });

    app.get('/api/auth/status', (req, res) => {
      noStore(res);
      const s = this.sessionFor(req);
      res.json({ success: true, authenticated: !!s, user: s ? s.user : null, mustChange: s ? s.mustChange : false, local: !s && isTrustedLocal(req) });
    });
    app.get('/api/auth/me', (req, res) => { noStore(res); const s = req.aetherUser || {}; res.json({ success: true, user: s.user || null, role: s.role || null, mustChange: !!s.mustChange }); });

    app.post('/api/auth/login', json, form, async (req, res) => {
      noStore(res);
      const ip = clientIp(req);
      const wait = this.lockedFor(ip);
      if (wait) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ success: false, error: `Too many attempts. Try again in ${wait} s.` }); }
      const user = String((req.body && req.body.username) || '').trim().toLowerCase();
      const pass = String((req.body && req.body.password) || '');
      try {
        this.refreshFromDisk(true);
        await this.ensureDefault();
        const rec = this.userRec(user);
        const ok = rec ? await verifyPassword(rec, pass) : (await scrypt(pass, '00'), false);
        if (!ok) {
          this.noteFail(ip);
          this.log.warn(`[Auth] failed sign-in for "${user.slice(0, 40)}" from ${ip}`);
          return res.status(401).json({ success: false, error: 'Wrong user name or password' });
        }
        this.fails.delete(ip);
        const token = this.createSession(user, req);
        res.setHeader('Set-Cookie', this.cookie(req, token, MAX_AGE_MS));
        this.log.log(`[Auth] ${user} signed in from ${ip}`);
        const next = safeNext(req.body && req.body.next, req);
        res.json({ success: true, user, mustChange: !!rec.mustChange, next: rec.mustChange ? `/change-password${next !== '/' ? '?next=' + encodeURIComponent(next) : ''}` : next });
      } catch (e) {
        this.log.error('[Auth] sign-in error:', e.message);
        res.status(500).json({ success: false, error: 'Sign-in failed on the Pi: ' + e.message });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      noStore(res);
      const s = this.sessionFor(req);
      if (s) this.revoke((k) => k === s.sid);
      res.setHeader('Set-Cookie', this.cookie(req, '', 0));
      res.json({ success: true });
    });

    app.post('/api/auth/change-password', json, form, async (req, res) => {
      noStore(res);
      const s = req.aetherUser && req.aetherUser.sid ? req.aetherUser : this.sessionFor(req);
      if (!s || !s.sid) return res.status(401).json({ success: false, error: 'Sign in required', authRequired: true });
      const ip = clientIp(req);
      const wait = this.lockedFor(ip);
      if (wait) return res.status(429).json({ success: false, error: `Too many attempts. Try again in ${wait} s.` });
      const cur = String((req.body && req.body.current) || '');
      const pw = String((req.body && req.body.password) || '');
      const confirm = String((req.body && req.body.confirm) || '');
      const rec = this.userRec(s.user);
      if (!rec) return res.status(401).json({ success: false, error: 'Account not found' });
      if (!(await verifyPassword(rec, cur))) { this.noteFail(ip); return res.status(400).json({ success: false, field: 'current', error: 'Current password is wrong' }); }
      const problem = passwordProblem(pw, { user: s.user, current: cur });
      if (problem) return res.status(400).json({ success: false, field: 'password', error: problem });
      if (pw !== confirm) return res.status(400).json({ success: false, field: 'confirm', error: 'The two new passwords don\'t match' });
      Object.assign(rec, await hashPassword(pw), { mustChange: false, changedAt: new Date().toISOString() });
      this.saveUsers();
      // Everyone else using this account is signed out; this browser gets a fresh session.
      this.revoke((_k, x) => x.user === s.user);
      const token = this.createSession(s.user, req);
      res.setHeader('Set-Cookie', this.cookie(req, token, MAX_AGE_MS));
      this.log.log(`[Auth] ${s.user} changed the password from ${ip}; other sessions signed out`);
      res.json({ success: true, next: safeNext(req.body && req.body.next, req) });
    });

    app.get('/api/auth/ui.js', (req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      const who = this.sessionFor(req) || (isTrustedLocal(req) ? { user: 'local', local: true } : null);
      let extra = '';
      for (const part of this.uiParts) { try { extra += part(req, who) || ''; } catch (e) { this.log.warn('[Auth] ui part failed:', e.message); } }
      // Extras first: they rewrite node URLs, and the sign-in helper wraps them.
      res.send(`/* Aether sign-in helper (AETHER_AUTH) */\n${extra}(${UI_SOURCE.toString()})();\n`);
    });
  }
}

function passwordProblem(pw, { user, current }) {
  if (pw.length < MIN_LEN) return `Use at least ${MIN_LEN} characters`;
  if (pw.length > 200) return 'That password is too long';
  if (pw === DEFAULT_PASS) return 'Choose something other than the default password';
  if (pw === current) return 'The new password must be different from the current one';
  if (user && pw.toLowerCase().includes(user.toLowerCase())) return 'Don\'t include the user name in the password';
  return null;
}

// ---------------------------------------------------------------------------
// Pages (served by the backend, so nothing from the app loads before sign-in)
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pageHtml(kind, { next = '/', user = '', forced = false, secure = '' } = {}) {
  const login = kind === 'login';
  const title = login ? 'Sign in' : (forced ? 'Set a new password' : 'Change password');
  const intro = login
    ? 'Sign in to use the Aether tools on this Pi.'
    : (forced ? 'You signed in with the default password. Choose your own before continuing.' : `Change the password for <b>${esc(user)}</b>.`);
  const fields = login ? `
      <label for="u">User name</label>
      <input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
      <label for="p">Password</label>
      <div class="pw"><input id="p" name="password" type="password" autocomplete="current-password" required><button type="button" class="eye" aria-label="Show password">Show</button></div>` : `
      <input type="text" name="username" value="${esc(user)}" autocomplete="username" hidden>
      <label for="c">Current password</label>
      <div class="pw"><input id="c" name="current" type="password" autocomplete="current-password" required ${forced ? '' : 'autofocus'}><button type="button" class="eye" aria-label="Show password">Show</button></div>
      <label for="n">New password</label>
      <div class="pw"><input id="n" name="password" type="password" autocomplete="new-password" minlength="${MIN_LEN}" required ${forced ? 'autofocus' : ''}><button type="button" class="eye" aria-label="Show password">Show</button></div>
      <p class="hint">At least ${MIN_LEN} characters, not the default password.</p>
      <label for="r">Confirm new password</label>
      <div class="pw"><input id="r" name="confirm" type="password" autocomplete="new-password" required><button type="button" class="eye" aria-label="Show password">Show</button></div>`;
  const button = login ? 'Sign in' : (forced ? 'Save and continue' : 'Change password');
  const footer = login ? '' : `<form method="dialog" class="alt"><button type="button" id="out" class="link">Sign out</button>${forced ? '' : ` · <a class="link" href="${esc(next)}">Cancel</a>`}</form>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Aether</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('hv-theme')==='light'?'light':'dark'}catch(e){document.documentElement.dataset.theme='dark'}</script>
<style>
@font-face{font-family:'Noto Sans';font-weight:400;font-display:swap;src:url(/hv-fonts/noto-sans-latin-400-normal.woff2) format('woff2')}
@font-face{font-family:'Noto Sans';font-weight:600;font-display:swap;src:url(/hv-fonts/noto-sans-latin-600-normal.woff2) format('woff2')}
@font-face{font-family:'Noto Sans';font-weight:700;font-display:swap;src:url(/hv-fonts/noto-sans-latin-700-normal.woff2) format('woff2')}
:root,:root[data-theme=dark]{color-scheme:dark;--bg:16 16 17;--panel:32 32 33;--box:48 48 49;--line:79 79 80;--text:255 255 255;--text2:200 200 201;--text3:133 133 135;--brand:243 115 33;--brandh:214 84 0;--brandt:255 154 92;--err:250 77 77;--errt:255 122 122;--errtint:49 24 24}
:root[data-theme=light]{color-scheme:light;--bg:238 239 241;--panel:255 255 255;--box:246 246 247;--line:201 201 202;--text:0 0 0;--text2:59 59 60;--text3:118 118 119;--brand:243 115 33;--brandh:214 84 0;--brandt:196 80 6;--err:229 62 62;--errt:196 47 47;--errtint:253 236 236}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:rgb(var(--bg));color:rgb(var(--text));font:14px/1.45 'Noto Sans',system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:380px;background:rgb(var(--panel));border:1px solid rgb(var(--line)/.6);border-radius:12px;padding:28px 28px 22px;box-shadow:0 10px 40px rgb(0 0 0/.25)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.mark{width:34px;height:34px;border-radius:8px;background:rgb(var(--brand));display:grid;place-items:center;color:#fff;font-weight:700;font-size:18px}
.brand b{font-size:16px;letter-spacing:.2px}.brand span{display:block;color:rgb(var(--text3));font-size:12px}
h1{font-size:20px;font-weight:700;margin:0 0 4px}
p.intro{color:rgb(var(--text2));margin:0 0 18px}
label{display:block;font-size:12px;font-weight:600;color:rgb(var(--text2));margin:12px 0 5px}
input{width:100%;height:40px;padding:0 12px;border-radius:8px;border:1px solid rgb(var(--line));background:rgb(var(--box));color:rgb(var(--text));font:inherit;outline:none}
input:focus{border-color:rgb(var(--brand));box-shadow:0 0 0 3px rgb(var(--brand)/.25)}
input[aria-invalid=true]{border-color:rgb(var(--err))}
.pw{position:relative}.pw input{padding-right:64px}
.eye{position:absolute;right:6px;top:6px;height:28px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:rgb(var(--text3));font:inherit;font-size:12px;cursor:pointer}
.eye:hover{color:rgb(var(--text))}
.hint{margin:6px 0 0;color:rgb(var(--text3));font-size:12px}
.err{display:none;margin:16px 0 0;padding:9px 12px;border-radius:8px;background:rgb(var(--errtint));color:rgb(var(--errt));font-size:13px}
.err.on{display:block}
.note{display:none;margin:14px 0 0;color:rgb(var(--text3));font-size:12px}.note.on{display:block}.note b{color:rgb(var(--text2));font-weight:600}
button.go{margin-top:20px;width:100%;height:42px;border:0;border-radius:8px;background:rgb(var(--brand));color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.go:hover{background:rgb(var(--brandh))}button.go:disabled{opacity:.6;cursor:default}
.alt{margin:14px 0 0;text-align:center;color:rgb(var(--text3));font-size:12px}
.link{background:none;border:0;padding:0;color:rgb(var(--brandt));font:inherit;cursor:pointer;text-decoration:none}
.link:hover{text-decoration:underline}
.foot{margin-top:18px;text-align:center;color:rgb(var(--text3));font-size:11px}
</style></head>
<body>
<main class="card">
  <div class="brand"><div class="mark" aria-hidden="true">A</div><div><b>Aether</b><span>Access control test bench</span></div></div>
  <h1>${title}</h1>
  <p class="intro">${intro}</p>
  <form id="f" novalidate>
    <input type="hidden" name="next" value="${esc(next)}">${fields}
    <div class="err" id="e" role="alert"></div>
    <div class="note" id="note"></div>
    <button class="go" id="b" type="submit">${button}</button>
  </form>
  ${footer}
</main>
<script>
(function(){
  var f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');
  document.querySelectorAll('.eye').forEach(function(x){x.addEventListener('click',function(){var i=x.previousElementSibling;var show=i.type==='password';i.type=show?'text':'password';x.textContent=show?'Hide':'Show';i.focus();});});
  function fail(msg,field){e.textContent=msg;e.classList.add('on');f.querySelectorAll('input').forEach(function(i){i.removeAttribute('aria-invalid')});
    var el=field&&f.querySelector('[name="'+field+'"]');if(el){el.setAttribute('aria-invalid','true');el.focus();el.select&&el.select();}}
  f.addEventListener('submit',function(ev){ev.preventDefault();e.classList.remove('on');
    var data={};new FormData(f).forEach(function(v,k){data[k]=v});
    ${login ? "if(!data.username||!data.password){fail('Enter your user name and password.',!data.username?'username':'password');return;}" : "if(data.password!==data.confirm){fail(\"The two new passwords don't match.\",'confirm');return;}"}
    b.disabled=true;
    fetch('${login ? '/api/auth/login' : '/api/auth/change-password'}',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(data)})
      .then(function(r){return r.json().catch(function(){return{success:false,error:'Unexpected answer from the Pi (HTTP '+r.status+')'}})})
      .then(function(j){if(j&&j.success){location.replace(j.next||'/');return;}b.disabled=false;
        ${login ? "fail((j&&j.error)||'Sign-in failed.','password');" : "if(j&&j.authRequired){location.replace('/login');return;}fail((j&&j.error)||'Could not change the password.',j&&j.field);"}})
      .catch(function(){b.disabled=false;fail('Could not reach the Pi. Check the connection and try again.');});
  });
  // Move to the secure address if this browser can reach it (DNS can hide it: routers often block public names that point to a LAN address).
  var secure=${JSON.stringify(login ? secure : '')}, n=document.getElementById('note');
  if(secure){var done=false,bt=b.textContent;b.disabled=true;b.textContent='Checking secure connection...';
    var ac=window.AbortController?new AbortController():null,t=setTimeout(function(){ac&&ac.abort();fallback();},3000);
    function fallback(){if(done)return;done=true;clearTimeout(t);b.disabled=false;b.textContent=bt;
      n.innerHTML="This browser can&#39;t reach <b>"+secure.slice(8)+"</b>, so you&#39;re signing in over the local network (not encrypted).";n.classList.add('on');}
    fetch(secure+'/api/https/ping',{cache:'no-store',signal:ac?ac.signal:undefined}).then(function(r){return r.json()}).then(function(j){
      if(done)return;if(!j||!j.success){fallback();return;}done=true;clearTimeout(t);
      document.cookie='aether_https_ok=1; Path=/; Max-Age=86400; SameSite=Lax';
      location.replace(secure+location.pathname+location.search);}).catch(fallback);}
  var out=document.getElementById('out');
  if(out)out.addEventListener('click',function(){fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).finally(function(){location.replace('/login')});});
})();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Browser helper, loaded by index.html: sends the cookie to this Pi on other
// ports (Vite dev), sends the page to /login when the session ends, and adds
// the account menu (Change password / Sign out).
// ---------------------------------------------------------------------------
function UI_SOURCE() {
  if (window.__aetherAuth) return;
  window.__aetherAuth = true;
  var here = location.hostname.toLowerCase();
  var ports = { '3001': 1, '3443': 1, '443': 1, '': 1 };
  var backend = (location.port === '5173') ? location.protocol + '//' + location.hostname + ':3001' : '';
  function sameHostOtherOrigin(url) {
    try { var u = new URL(url, location.href); return u.origin !== location.origin && u.hostname.toLowerCase() === here && ports[u.port] ? u : null; } catch (e) { return null; }
  }
  var leaving = false;
  function goLogin(change) {
    if (leaving) return; leaving = true;
    var nextUrl = backend ? location.href : (location.pathname + location.search + location.hash);
    location.href = backend + (change ? '/change-password' : '/login') + '?next=' + encodeURIComponent(nextUrl);
  }
  function check(status, hdr) {
    if (status === 401 && hdr === 'login') goLogin(false);
    else if (status === 403 && hdr === 'change') goLogin(true);
  }
  var of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (sameHostOtherOrigin(url)) {
        init = Object.assign({}, init || {}, { credentials: 'include' });
      }
      return of.call(this, input, init).then(function (r) {
        try {
          var u = new URL(r.url || url, location.href);
          if (u.hostname.toLowerCase() === here) check(r.status, r.headers.get('X-Aether-Auth'));
        } catch (e) { /* */ }
        return r;
      });
    };
  }
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__aUrl = url; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    try { if (sameHostOtherOrigin(x.__aUrl)) x.withCredentials = true; } catch (e) { /* */ }
    x.addEventListener('load', function () {
      try { var u = new URL(x.responseURL || x.__aUrl, location.href); if (u.hostname.toLowerCase() === here) check(x.status, x.getResponseHeader('X-Aether-Auth')); } catch (e) { /* */ }
    });
    return XS.apply(this, arguments);
  };

  if (/^\/stream(\/|$)/.test(location.pathname)) return;   // Stream View capture page: no menu

  function menu(user) {
    if (document.getElementById('aether-acct')) return;
    var css = document.createElement('style');
    css.textContent = '#aether-acct{position:fixed;right:14px;bottom:14px;z-index:2147483000;font:12px/1.3 "Noto Sans",system-ui,sans-serif}' +
      '#aether-acct>button{display:flex;align-items:center;gap:6px;height:30px;padding:0 11px 0 7px;border-radius:15px;border:1px solid rgb(var(--hv-line-strong,79 79 80));background:rgb(var(--hv-popup-panel,40 40 41)/.92);color:rgb(var(--hv-text-2,200 200 201));cursor:pointer;box-shadow:0 2px 10px rgb(0 0 0/.25);backdrop-filter:blur(6px);opacity:.75;transition:opacity .15s}' +
      '#aether-acct>button:hover,#aether-acct.open>button{opacity:1;color:rgb(var(--hv-text,255 255 255))}' +
      '#aether-acct .av{width:18px;height:18px;border-radius:50%;background:rgb(var(--hv-brand,243 115 33));color:#fff;display:grid;place-items:center;font-weight:700;font-size:10px;text-transform:uppercase}' +
      '#aether-acct .mn{display:none;position:absolute;right:0;bottom:36px;min-width:180px;padding:6px;border-radius:10px;border:1px solid rgb(var(--hv-line-strong,79 79 80));background:rgb(var(--hv-popup-panel,40 40 41));box-shadow:0 8px 28px rgb(0 0 0/.35)}' +
      '#aether-acct.open .mn{display:block}' +
      '#aether-acct .who{padding:6px 10px 8px;color:rgb(var(--hv-text-3,133 133 135));border-bottom:1px solid rgb(var(--hv-line,51 51 52));margin-bottom:4px}' +
      '#aether-acct .who b{display:block;color:rgb(var(--hv-text,255 255 255));font-size:13px}' +
      '#aether-acct .mn a,#aether-acct .mn button{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;background:none;color:rgb(var(--hv-text-2,200 200 201));font:inherit;font-size:13px;text-decoration:none;cursor:pointer}' +
      '#aether-acct .mn a:hover,#aether-acct .mn button:hover{background:rgb(var(--hv-box,48 48 49));color:rgb(var(--hv-text,255 255 255))}';
    document.head.appendChild(css);
    var w = document.createElement('div'); w.id = 'aether-acct';
    var safe = String(user).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
    w.innerHTML = '<button type="button" aria-haspopup="true" aria-expanded="false" title="Account"><span class="av">' + safe.charAt(0) + '</span>' + safe + '</button>' +
      '<div class="mn" role="menu"><div class="who">Signed in as<b>' + safe + '</b></div>' +
      '<a role="menuitem" href="' + backend + '/change-password?next=' + encodeURIComponent(backend ? location.href : location.pathname + location.search) + '">Change password</a>' +
      '<button role="menuitem" type="button" data-out>Sign out</button></div>';
    var btn = w.firstChild;
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); var o = w.classList.toggle('open'); btn.setAttribute('aria-expanded', o ? 'true' : 'false'); });
    document.addEventListener('click', function () { w.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') w.classList.remove('open'); });
    w.querySelector('[data-out]').addEventListener('click', function () {
      of.call(window, backend + '/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(function () {}).then(function () { leaving = true; location.href = backend + '/login'; });
    });
    document.body.appendChild(w);
  }
  function start() {
    of.call(window, backend + '/api/auth/status', { credentials: 'include', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.authenticated) { if (j.mustChange) goLogin(true); else menu(j.user); }
      else if (j && !j.local) goLogin(false);
    }).catch(function () { /* backend unreachable: the app shows its own offline state */ });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  // Screens that only listen on the socket never see a 401, so look every 30 s and on return to the tab.
  function recheck() {
    if (leaving || document.hidden) return;
    of.call(window, backend + '/api/auth/status', { credentials: 'include', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && !j.authenticated && !j.local) goLogin(false);
      else if (j && j.mustChange) goLogin(true);
    }).catch(function () { /* offline */ });
  }
  setInterval(recheck, 30000);
  document.addEventListener('visibilitychange', recheck);
}

// ---------------------------------------------------------------------------

/** Wire into server.js right after the socket.io server is created (before every route). */
function install({ app, io, express, log }) {
  const m = new AuthManager({ io, log: log || console });
  m.ensureDefault().catch(e => (log || console).error('[Auth] could not create the default account:', e.message));
  app.use(m.gate());
  m.routes(app, express || require('express'));
  if (io && typeof io.use === 'function') io.use(m.socketMiddleware());
  // Refuse the engine.io handshake too (it is answered before Express sees it). io.opts is
  // merged into every later io.attach(), so the HTTPS server's engine gets it as well.
  const allowRequest = (req, cb) => {
    if (isTrustedLocal(req) || m.verified(req)) return cb(null, true);
    const s = m.sessionFor(req);
    if (s && !s.mustChange) return cb(null, true);
    cb(s ? 'Change the default password first' : 'Sign in required', false);
  };
  if (io) {
    if (io.opts) io.opts.allowRequest = allowRequest;
    if (io.engine && io.engine.opts) io.engine.opts.allowRequest = allowRequest;
  }
  // Cluster gateway (one sign-in for every enrolled Aether) and camera streams. Optional modules.
  for (const mod of ['./clusterGateway', './cameraManager']) {
    try { require(mod).install({ app, io, express, auth: m, log: log || console }); }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes(mod.slice(2))) (log || console).error(`[Auth] ${mod} failed to start:`, e.message); }
  }
  const t = setInterval(() => { m.pruneSessions(); m.disconnectRevoked(); }, 60000);
  if (t.unref) t.unref();
  (log || console).log(`[Auth] sign-in required for every page and API (accounts in ${m.dir})`);
  return m;
}

module.exports = { install, failClosed, clientIp, parseCookies, corsDelegate, socketCors, AuthManager, passwordProblem, isTrustedLocal, isOwnOrigin, safeNext, pageHtml, DEFAULT_USER, candidateDirs };

// ---- terminal: node backend/lib/authManager.js --reset ----
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--reset') {
    let n = 0;
    for (const d of candidateDirs()) for (const f of ['users.json', 'sessions.json']) {
      try { fs.unlinkSync(path.join(d, f)); n++; } catch (_) { /* not there */ }
    }
    console.log(n ? `Sign-in reset: user "${DEFAULT_USER}", password "${DEFAULT_PASS}" (must be changed at next sign-in). Everyone is signed out.`
      : 'Nothing to reset (no sign-in data found). The default account is admin / Aether01!');
    if (n && typeof process.getuid === 'function' && process.getuid() !== 0) console.log('If the Pi still accepts the old password, run this again with sudo.');
  } else {
    console.log('Usage: node backend/lib/authManager.js --reset    (sign-in back to admin / Aether01!)');
  }
}
