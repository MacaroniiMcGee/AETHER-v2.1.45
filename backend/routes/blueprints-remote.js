// blueprints-remote.js - Board Blueprints on GitHub, the Pi side (AETHER_BLUEPRINTS_GH).
//
//   app.use('/api/blueprints', require('./routes/blueprints-remote')());
//
// The page in Aether's Tools -> Board Blueprints panel talks only to this router. The router talks to the
// Board Blueprints service with this Aether's machine id + secret, which stay on the Pi
// (backend/data/blueprints-credentials.json, mode 600) and are never sent to the browser.
//
//   GET  /status                  -> { installed:{version,date}, latest, machine, online, setup, outbox, updating }
//   POST /setup {serviceUrl}      -> first-run: where the service lives (https)
//   POST /update                  -> download <service>/app, check it, theme it like apply.sh, install (button only)
//   POST /rollback                -> back to the version before the last update
//   GET  /page                    -> the installed page (Cache-Control: no-cache + ETag)
//   POST /machine/request {name, space}, GET /machine, POST /machine/forget
//   GET  /spaces                  -> this Aether's own space only
//   ANY  /s/<space>/...           -> the service's /s/:space API in this Aether's own space (whatever <space> says).
//                                    Offline writes queue in data/blueprints/outbox/ and replay in order; reads fall
//                                    back to data/blueprints/cache/. A replayed write that hits someone else's newer
//                                    copy is kept in outbox/conflicts/ (never overwritten) and listed in /status.
//   GET  /outbox, POST /outbox/replay, GET|POST /outbox/conflicts/:id[/keep-mine|/discard]
//
// Node built-ins only (no npm packages). Every network call has a timeout.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const PAGE = 'board-blueprint-studio.html';
const MARKER = /<title>\s*Board Blueprints\s*<\/title>/i;
const MIN_PAGE = 500 * 1024;
const MAX_PAGE = 40 * 1024 * 1024;
const MAX_BODY = 25 * 1024 * 1024;
const CRED_KEYS = ['serviceUrl', 'machineId', 'machineSecret', 'name', 'space', 'status'];

class BbError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}
const netErr = (msg, tooBig) => Object.assign(new Error(msg), { network: !tooBig, tooBig: !!tooBig });

module.exports = function blueprintsRemote(opts = {}) {
  const ROOT = path.resolve(opts.root || path.join(__dirname, '..', '..'));
  const DATA = path.resolve(opts.dataDir || path.join(ROOT, 'backend', 'data'));
  const FE = path.join(ROOT, 'frontend');
  const CREDS = path.join(DATA, 'blueprints-credentials.json');
  const BB = path.join(DATA, 'blueprints');
  const CACHE = path.join(BB, 'cache');
  const OUT = path.join(BB, 'outbox');
  const CONF = path.join(OUT, 'conflicts');
  const FAILED = path.join(OUT, 'failed');
  const SHAMAP = path.join(BB, 'outbox-shas.json');
  const CUR = path.join(BB, 'current.html'), CUR_META = path.join(BB, 'installed.json');
  const PREV = path.join(BB, 'previous.html'), PREV_META = path.join(BB, 'previous.json');
  const PUB = path.join(FE, 'public', PAGE), SRC = path.join(FE, '.bbs-source-blueprints'), DIST = path.join(FE, 'dist');
  const T = { status: 6000, app: 90000, api: 20000, theme: 180000, ...(opts.timeouts || {}) };
  const allowHttp = !!opts.allowHttp;

  // ---------------------------------------------------------------- files (owned by the Aether folder's owner)
  const owner = () => { try { const s = fs.statSync(ROOT); return { uid: s.uid, gid: s.gid }; } catch (e) { return null; } };
  const asRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
  function fix(p) { const o = owner(); if (asRoot() && o && o.uid !== 0) { try { fs.chownSync(p, o.uid, o.gid); } catch (e) {} } }
  function mkdirs(d) { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); fix(d); } }
  function writeAtomic(p, data, mode) {
    mkdirs(path.dirname(p));
    const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
      if (mode) fs.chmodSync(tmp, mode);
      fix(tmp); fs.renameSync(tmp, p);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  }
  const readOrNull = p => { try { return fs.readFileSync(p); } catch (e) { return null; } };
  const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
  const writeJson = (p, o, mode) => writeAtomic(p, JSON.stringify(o, null, 2) + '\n', mode);
  function putBack(p, buf) { try { if (buf == null) fs.rmSync(p, { force: true }); else writeAtomic(p, buf); } catch (e) {} }

  // ---------------------------------------------------------------- credentials (never leave this module)
  function readCreds() {
    const c = readJson(CREDS);
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  }
  function saveCreds(c) {
    const o = {}; for (const k of CRED_KEYS) if (c[k] != null && c[k] !== '') o[k] = c[k];
    if (o.serviceUrl == null) o.serviceUrl = '';
    writeJson(CREDS, o, 0o600);
  }
  const publicMachine = c => (c.machineId ? { id: c.machineId, status: c.status || 'unknown', name: c.name || '', space: c.space || '' } : null);
  const machineAuth = c => `Machine ${c.machineId}:${c.machineSecret}`;

  function normService(s) {
    s = String(s || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    let u; try { u = new URL(s); } catch (e) { throw new BbError(400, 'That is not a web address (it should start with https://).', 'bad-url'); }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || allowHttp)))
      throw new BbError(400, 'The service address must start with https://.', 'bad-url');
    if (u.username || u.password || u.search || u.hash) throw new BbError(400, 'Give only the service address, without a password or ?query.', 'bad-url');
    return u.origin + u.pathname.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- HTTP client with timeouts
  function request(method, url, { headers = {}, body, timeout = T.api, maxBytes = MAX_BODY } = {}) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch (e) { return reject(netErr('bad address')); }
      const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!mod) return reject(netErr('bad address'));
      const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const h = { 'User-Agent': 'Aether-Blueprints', Accept: 'application/json', ...headers };
      if (data) { h['Content-Length'] = data.length; if (!h['Content-Type']) h['Content-Type'] = 'application/json'; }
      let done = false, timer = null;
      const fin = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
      const req = mod.request(u, { method, headers: h }, res => {
        const chunks = []; let n = 0;
        res.on('data', ch => { n += ch.length; if (n > maxBytes) { fin(reject, netErr('response too large', true)); req.destroy(); } else chunks.push(ch); });
        res.on('end', () => fin(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', e => fin(reject, netErr(e.message)));
      });
      timer = setTimeout(() => { fin(reject, netErr('timed out')); req.destroy(); }, timeout);
      req.on('error', e => fin(reject, netErr(e.message)));
      if (data) req.write(data);
      req.end();
    });
  }
  const parse = buf => { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } };
  const svcErr = (r, fallback) => { const j = parse(r.body); return new BbError(r.status, (j && typeof j.error === 'string' && j.error) || fallback, (j && j.code) || 'service'); };

  // ---------------------------------------------------------------- installed page
  function installedInfo() {
    if (fs.existsSync(CUR)) { const m = readJson(CUR_META) || {}; return { version: m.version || null, date: m.date || null, source: m.source || 'service', installedAt: m.installedAt || null }; }
    if (fs.existsSync(PUB)) return { version: null, date: null, source: 'aether-update', installedAt: null };
    return null;
  }
  function pageFile() {
    for (const f of [CUR, PUB, path.join(DIST, PAGE)]) if (fs.existsSync(f)) return f;
    return null;
  }
  let etagCache = null;
  function etagOf(f) {
    const st = fs.statSync(f);
    if (etagCache && etagCache.f === f && etagCache.m === st.mtimeMs && etagCache.s === st.size) return etagCache.e;
    const e = '"' + crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 20) + '"';
    etagCache = { f, m: st.mtimeMs, s: st.size, e };
    return e;
  }
  function checkPage(html) {
    if (html.length < MIN_PAGE) return `the download is only ${Math.round(html.length / 1024)} KB, too small to be the page`;
    if (!/<html[\s>]/i.test(html.slice(0, 4096)) && !/^\s*<!doctype html/i.test(html)) return 'the download is not an HTML page';
    if (!MARKER.test(html)) return 'the download is not the Board Blueprints page';
    return '';
  }
  function runTheme() {
    return new Promise((resolve, reject) => {
      const o = { cwd: FE, timeout: T.theme, maxBuffer: 4 << 20 };
      const own = owner(); if (asRoot() && own && own.uid !== 0) { o.uid = own.uid; o.gid = own.gid; }
      execFile('python3', ['scripts/hv-pages.py', '--apply'], o, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'theming failed'));
        else resolve();
      });
    });
  }
  function copyToDist(buf) {
    if (!fs.existsSync(DIST)) return;
    try { writeAtomic(path.join(DIST, PAGE), buf); } catch (e) { console.warn('[Blueprints] could not copy the page into frontend/dist:', e.message); }
  }

  let updating = false, lastUpdate = null;
  async function doUpdate() {
    const c = readCreds();
    if (!c.serviceUrl) throw new BbError(409, 'Set the Board Blueprints service address first.', 'setup');
    let r;
    try { r = await request('GET', c.serviceUrl + '/app', { timeout: T.app, maxBytes: MAX_PAGE, headers: { Accept: 'text/html' } }); }
    catch (e) { throw new BbError(502, `Couldn't download the new version (${e.tooBig ? 'it is too large' : e.message}). The current page is unchanged.`, 'download'); }
    if (r.status !== 200) throw new BbError(502, `The service answered ${r.status} instead of the page. The current page is unchanged.`, 'download');
    const html = r.body.toString('utf8');
    const bad = checkPage(html);
    if (bad) throw new BbError(502, `Not installed: ${bad}. The current page is unchanged.`, 'bad-page');
    let version = String(r.headers['x-bb-version'] || '') || null, date = null, notes = '';
    try {
      const v = await request('GET', c.serviceUrl + '/version', { timeout: T.status });
      const j = v.status === 200 && parse(v.body);
      if (j) { if (!version) version = j.version || null; if (!version || version === j.version) { date = j.date || null; notes = j.notes || ''; } }
    } catch (e) {}

    const oldPub = readOrNull(PUB), oldSrc = readOrNull(SRC);
    const prior = readOrNull(CUR) || oldPub, priorMeta = fs.existsSync(CUR) ? readJson(CUR_META) : { version: null, date: null, source: 'aether-update' };
    let themed = Buffer.from(html, 'utf8'), isThemed = false;
    try {
      writeAtomic(SRC, themed);
      writeAtomic(PUB, themed);
      if (fs.existsSync(path.join(FE, 'scripts', 'hv-pages.py')) && fs.existsSync(path.join(FE, 'src', 'theme', 'hv-tokens.css'))) {
        try { await runTheme(); } catch (e) { throw new BbError(500, `Theming the new version failed (${e.message}). The current page is unchanged.`, 'theme'); }
        themed = fs.readFileSync(PUB);
        const bad2 = checkPage(themed.toString('utf8'));
        if (bad2) throw new BbError(500, `Theming broke the new version (${bad2}). The current page is unchanged.`, 'theme');
        isThemed = true;
      }
      if (prior) { writeAtomic(PREV, prior); writeJson(PREV_META, priorMeta || {}); }
      writeAtomic(CUR, themed);
      writeJson(CUR_META, { version, date, notes, themed: isThemed, source: 'service', installedAt: new Date().toISOString() });
    } catch (e) {
      putBack(PUB, oldPub); putBack(SRC, oldSrc);
      throw e instanceof BbError ? e : new BbError(500, `Installing the new version failed (${e.message}). The current page is unchanged.`, 'install');
    }
    copyToDist(themed);
    etagCache = null;
    return { installed: installedInfo(), themed: isThemed, canRollback: fs.existsSync(PREV) };
  }

  function doRollback() {
    if (!fs.existsSync(PREV)) throw new BbError(409, 'There is no earlier version on this Aether to go back to.', 'no-previous');
    const prev = fs.readFileSync(PREV), prevMeta = readJson(PREV_META) || {};
    const cur = readOrNull(CUR) || readOrNull(PUB), curMeta = fs.existsSync(CUR) ? (readJson(CUR_META) || {}) : { source: 'aether-update' };
    writeAtomic(CUR, prev);
    writeJson(CUR_META, { ...prevMeta, rolledBackAt: new Date().toISOString() });
    if (cur) { writeAtomic(PREV, cur); writeJson(PREV_META, curMeta); }
    writeAtomic(PUB, prev);
    copyToDist(prev);
    etagCache = null;
    return { installed: installedInfo(), canRollback: true };
  }

  // ---------------------------------------------------------------- outbox, cache, sha chaining
  let seq = 0;
  const listDir = d => { try { return fs.readdirSync(d).filter(f => /^\d{13}-\d{6}\.json$/.test(f)).sort(); } catch (e) { return []; } };
  // each queued write remembers the team space it was made in: if the owner moves this Aether to another space before it
  // uploads, it is kept in outbox/failed/ instead of landing in the new space
  function enqueue(method, rel, body, space) {
    const id = `${String(Date.now()).padStart(13, '0')}-${String(seq++ % 1e6).padStart(6, '0')}`;
    const item = { id, method, path: rel, space: space || null, body: body === undefined ? null : body, queuedAt: new Date().toISOString() };
    writeJson(path.join(OUT, id + '.json'), item);
    return item;
  }
  const itemName = it => (it.body && (it.body.name || (it.body.project && it.body.project.name))) || (it.path.match(/\/projects\/([^/?]+)/) || [])[1] || it.path;
  const brief = (it, extra) => ({ id: it.id, method: it.method, path: it.path, name: itemName(it), queuedAt: it.queuedAt, ...extra });
  let lastReplay = null, lastError = null;
  function outboxInfo() {
    const conflicts = listDir(CONF).map(f => readJson(path.join(CONF, f))).filter(Boolean)
      .map(it => brief(it, { conflictAt: it.conflictAt, theirSha: it.theirSha || null }));
    const failed = listDir(FAILED).map(f => readJson(path.join(FAILED, f))).filter(Boolean)
      .map(it => brief(it, { failedAt: it.failedAt, error: it.error || '' }));
    return { pending: listDir(OUT).length, conflicts, failed, lastReplay, lastError };
  }
  const cacheFile = (space, rel) => path.join(CACHE, crypto.createHash('sha1').update(space + '\n' + rel).digest('hex') + '.json');
  const shaOf = j => (j && (typeof j.sha === 'string' ? j.sha : j.current && typeof j.current.sha === 'string' ? j.current.sha : typeof j.current === 'string' ? j.current : null)) || null;
  const sameSha = (a, b) => (a || null) === (b || null);
  const projPath = rel => rel.split('?')[0];
  const shaKey = (space, rel) => space + ':' + projPath(rel);   // sha chaining is per team space
  // the only paths the page uses under /s/<space>: /projects, /projects/<id>, /library (+ ?sha=<40 hex> on DELETE).
  // Anything else (encoded dots, backslashes, extra segments) is refused here, so the Pi never asks the service for
  // another space or another endpoint with its machine key, whatever URL normalisation would make of it.
  const REL_OK = /^\/(projects(\/[a-z0-9][a-z0-9-]{0,62})?|library)(\?sha=[0-9a-f]{40})?$/;

  let replaying = null;
  function replay() {
    if (replaying) return replaying;
    replaying = (async () => {
      const c = readCreds();
      if (!c.serviceUrl || !c.machineId || !c.space) return;
      const files = listDir(OUT);
      if (!files.length) return;
      const shas = readJson(SHAMAP) || {};
      let sent = 0;
      for (const f of files) {
        const fp = path.join(OUT, f);
        const it = readJson(fp);
        if (!it) { try { fs.renameSync(fp, path.join(mkd(FAILED), f)); } catch (e) {} continue; }
        if (it.space && it.space !== c.space) {
          writeJson(path.join(mkd(FAILED), f), { ...it, failedAt: new Date().toISOString(), status: 0,
            error: `Saved for team space ${it.space}, but this Aether now saves to ${c.space}; not uploaded.` });
          fs.rmSync(fp, { force: true });
          continue;
        }
        const key = shaKey(it.space || c.space, it.path), body = it.body && typeof it.body === 'object' ? { ...it.body } : it.body;
        const origSha = body && typeof body === 'object' ? body.sha : undefined;
        if (body && typeof body === 'object' && shas[key] && sameSha(origSha, shas[key].from)) body.sha = shas[key].to;
        let r;
        try { r = await send(c, it.method, it.path, body); }
        catch (e) { lastError = 'Still offline: ' + e.message; break; }
        if (r.status >= 200 && r.status < 300) {
          const j = parse(r.body);
          if (it.method === 'DELETE') delete shas[key];
          else if (shaOf(j)) shas[key] = { from: origSha || null, to: shaOf(j) };
          fs.rmSync(fp, { force: true }); sent++;
          continue;
        }
        if (r.status === 409) {
          const j = parse(r.body);
          writeJson(path.join(mkd(CONF), f), { ...it, conflictAt: new Date().toISOString(), theirSha: shaOf(j), service: j });
          fs.rmSync(fp, { force: true });
          continue;
        }
        if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) {
          const j = parse(r.body); lastError = (j && j.error) || `The service answered ${r.status}; will try again later.`;
          break;
        }
        const j = parse(r.body);
        writeJson(path.join(mkd(FAILED), f), { ...it, failedAt: new Date().toISOString(), status: r.status, error: (j && j.error) || `The service answered ${r.status}.` });
        fs.rmSync(fp, { force: true });
      }
      writeJson(SHAMAP, shas);
      if (sent) { lastReplay = new Date().toISOString(); if (!listDir(OUT).length) lastError = null; }
    })().catch(e => { lastError = e.message; }).finally(() => { replaying = null; });
    return replaying;
  }
  function mkd(d) { mkdirs(d); return d; }
  function send(c, method, rel, body) {
    return request(method, `${c.serviceUrl}/s/${encodeURIComponent(c.space)}${rel}`, {
      headers: { Authorization: machineAuth(c) }, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' && body == null ? undefined : body, timeout: T.api,
    });
  }
  const interval = opts.replayIntervalMs === undefined ? 60000 : opts.replayIntervalMs;
  if (interval > 0) { const t = setInterval(() => { if (listDir(OUT).length) replay(); }, interval); if (t.unref) t.unref(); }

  // ---------------------------------------------------------------- status / machine
  async function machineNow(c, online) {
    if (!c.machineId) return null;
    const m = publicMachine(c);
    if (!online) return m;
    try {
      const r = await request('GET', c.serviceUrl + '/machines/me', { headers: { Authorization: machineAuth(c) }, timeout: T.status });
      const j = parse(r.body) || {};
      if (r.status === 200) {
        const next = { ...c, status: j.status || c.status, name: j.name || c.name, space: j.space || c.space };
        if (next.status !== c.status || next.name !== c.name || next.space !== c.space) saveCreds(next);
        return publicMachine(next);
      }
      if (r.status === 401 || r.status === 403) return { ...m, status: j.status || 'not-recognised' };
    } catch (e) {}
    return m;
  }
  async function status() {
    const c = readCreds();
    const out = { installed: installedInfo(), latest: null, machine: publicMachine(c), online: false,
      setup: { serviceUrl: c.serviceUrl || '', needed: !c.serviceUrl }, outbox: null, updating, lastUpdate,
      canRollback: fs.existsSync(PREV) };
    if (c.serviceUrl) {
      try {
        const r = await request('GET', c.serviceUrl + '/version', { timeout: T.status });
        const j = r.status === 200 && parse(r.body);
        if (j) { out.latest = { version: j.version || null, date: j.date || null, notes: j.notes || '' }; out.online = true; }
      } catch (e) {}
      out.machine = await machineNow(c, out.online);
      if (out.online && listDir(OUT).length) replay();
    }
    out.outbox = outboxInfo();
    return out;
  }

  // ---------------------------------------------------------------- HTTP plumbing
  function send_(res, code, obj, headers = {}) {
    if (res.headersSent) return;
    const body = Buffer.from(JSON.stringify(obj));
    res.statusCode = code;
    for (const [k, v] of Object.entries({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })) res.setHeader(k, v);
    res.setHeader('Content-Length', body.length);
    res.end(body);
  }
  function readBody(req) {
    if (req._body || (req.body !== undefined && req.readableEnded)) return Promise.resolve(req.body == null ? {} : req.body);
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0, bad = false;
      req.on('data', ch => { n += ch.length; if (n > MAX_BODY) bad = true; else chunks.push(ch); });
      req.on('end', () => {
        if (bad) return reject(new BbError(413, 'That is too large to send.', 'too-large'));
        const s = Buffer.concat(chunks).toString('utf8').trim();
        if (!s) return resolve({});
        try { resolve(JSON.parse(s)); } catch (e) { reject(new BbError(400, 'The request was not valid JSON.', 'bad-json')); }
      });
      req.on('error', reject);
    });
  }
  function notInstalledPage() {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Board Blueprints</title></head>' +
      '<body style="font:15px system-ui,sans-serif;background:#1b1b1b;color:#ddd;padding:32px">' +
      '<h2>Board Blueprints isn\'t installed on this Aether yet</h2>' +
      '<p>Install it with the Board Blueprints update in Device Firmware, or download it from the service:</p>' +
      '<button onclick="this.disabled=true;fetch(\'/api/blueprints/update\',{method:\'POST\'}).then(r=>r.json()).then(j=>{if(j.error){alert(j.error);this.disabled=false}else location.reload()})">Download Board Blueprints</button>' +
      '</body></html>';
  }

  async function route(req, res, next) {
    let url = req.url || '/';
    if (url.startsWith('/api/blueprints')) url = url.slice('/api/blueprints'.length) || '/';
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q), search = q < 0 ? '' : url.slice(q);
    const M = req.method;

    if (pathname === '/status' && M === 'GET') return send_(res, 200, await status());

    if (pathname === '/setup' && M === 'POST') {
      const b = await readBody(req);
      const c = readCreds();
      const s = normService(b.serviceUrl);
      const next_ = { ...c, serviceUrl: s };
      if (c.serviceUrl && s !== c.serviceUrl) { delete next_.machineId; delete next_.machineSecret; delete next_.status; }
      saveCreds(next_);
      return send_(res, 200, { setup: { serviceUrl: s, needed: !s }, machine: publicMachine(next_) });
    }

    if (pathname === '/update' && M === 'POST') {
      if (updating) throw new BbError(409, 'An update is already running.', 'busy');
      updating = true;
      try { const r = await doUpdate(); lastUpdate = { ok: true, at: new Date().toISOString(), version: r.installed && r.installed.version }; return send_(res, 200, { success: true, ...r }); }
      catch (e) { lastUpdate = { ok: false, at: new Date().toISOString(), error: e.message }; throw e; }
      finally { updating = false; }
    }

    if (pathname === '/rollback' && M === 'POST') {
      if (updating) throw new BbError(409, 'An update is running; try again in a moment.', 'busy');
      return send_(res, 200, { success: true, ...doRollback() });
    }

    if (pathname === '/page' && (M === 'GET' || M === 'HEAD')) {
      const f = pageFile();
      const base = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
      if (!f) { res.statusCode = 200; for (const [k, v] of Object.entries(base)) res.setHeader(k, v); return res.end(M === 'HEAD' ? undefined : notInstalledPage()); }
      const etag = etagOf(f);
      const inm = String(req.headers['if-none-match'] || '');
      res.setHeader('ETag', etag);
      for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
      const info = installedInfo(); if (info && info.version) res.setHeader('X-BB-Version', info.version);
      if (inm && inm.split(/\s*,\s*/).some(t => t === etag || t === 'W/' + etag || t === '*')) { res.statusCode = 304; return res.end(); }
      const buf = fs.readFileSync(f);
      res.statusCode = 200; res.setHeader('Content-Length', buf.length);
      return res.end(M === 'HEAD' ? undefined : buf);
    }

    if (pathname === '/machine/request' && M === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 80), space = String(b.space || '').trim().slice(0, 80);
      if (!name || !space) throw new BbError(400, 'Give this Aether a name and pick a team space.', 'bad-request');
      const c = readCreds();
      if (!c.serviceUrl) throw new BbError(409, 'Set the Board Blueprints service address first.', 'setup');
      if (c.machineId && c.status === 'approved' && !b.replace) throw new BbError(409, 'This Aether is already approved. Forget it first to request again.', 'already-approved');
      let r;
      try { r = await request('POST', c.serviceUrl + '/machines/request', { body: { name, space }, timeout: T.api }); }
      catch (e) { throw new BbError(503, `Couldn't reach the Board Blueprints service (${e.message}).`, 'offline'); }
      if (r.status < 200 || r.status >= 300) throw svcErr(r, `The service answered ${r.status}.`);
      const j = parse(r.body) || {};
      if (!j.id || !j.secret) throw new BbError(502, 'The service did not return a machine id.', 'service');
      const nc = { ...c, machineId: String(j.id), machineSecret: String(j.secret), name, space: j.space || space, status: j.status || 'pending' };
      saveCreds(nc);
      return send_(res, 200, { machine: publicMachine(nc) });
    }
    if (pathname === '/machine' && M === 'GET') {
      const c = readCreds();
      let online = false;
      if (c.serviceUrl) { try { const r = await request('GET', c.serviceUrl + '/version', { timeout: T.status }); online = r.status === 200; } catch (e) {} }
      return send_(res, 200, { machine: c.serviceUrl ? await machineNow(c, online) : publicMachine(c), online });
    }
    if (pathname === '/machine/forget' && M === 'POST') {
      const c = readCreds(); delete c.machineId; delete c.machineSecret; delete c.status; saveCreds(c);
      return send_(res, 200, { machine: null });
    }

    if (pathname === '/spaces' && M === 'GET') {
      const c = readCreds();
      return send_(res, 200, c.space ? [{ slug: c.space, name: c.space, own: true }] : []);
    }

    if (pathname === '/outbox' && M === 'GET') return send_(res, 200, outboxInfo());
    if (pathname === '/outbox/replay' && M === 'POST') { await replay(); return send_(res, 200, outboxInfo()); }
    let m = pathname.match(/^\/outbox\/conflicts\/(\d{13}-\d{6})(?:\/(keep-mine|discard))?$/);
    if (m) {
      const fp = path.join(CONF, m[1] + '.json');
      const it = readJson(fp);
      if (!it) throw new BbError(404, 'That conflict is no longer there.', 'not-found');
      if (!m[2] && M === 'GET') { const { service, ...rest } = it; return send_(res, 200, rest); }
      if (m[2] === 'discard' && M === 'POST') { fs.rmSync(fp, { force: true }); return send_(res, 200, { discarded: true, outbox: outboxInfo() }); }
      if (m[2] === 'keep-mine' && M === 'POST') {
        const body = it.body && typeof it.body === 'object' ? { ...it.body, sha: it.theirSha || undefined } : it.body;
        enqueue(it.method, it.path, body, it.space || readCreds().space); fs.rmSync(fp, { force: true });
        await replay();
        return send_(res, 200, { queued: true, outbox: outboxInfo() });
      }
    }

    m = pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
    if (m) return proxy(req, res, M, (m[2] || '') + search);

    if (typeof next === 'function') return next();
    return send_(res, 404, { error: 'Not found.', code: 'not-found' });
  }

  async function proxy(req, res, M, rel) {
    const c = readCreds();
    if (!c.serviceUrl) throw new BbError(409, 'Set the Board Blueprints service address first.', 'setup');
    if (!c.machineId || !c.machineSecret || !c.space) throw new BbError(403, 'This Aether is not set up to save to GitHub yet. Request access for it first.', 'no-machine');
    if (!REL_OK.test(rel)) throw new BbError(400, 'Bad path.', 'bad-request');
    const pass = (r, extra) => {
      res.statusCode = r.status;
      res.setHeader('Content-Type', r.headers['content-type'] || 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      for (const [k, v] of Object.entries(extra || {})) res.setHeader(k, v);
      res.end(r.body);
    };
    if (M === 'GET' || M === 'HEAD') {
      const cf = cacheFile(c.space, rel);
      let r = null;
      try { r = await send(c, 'GET', rel); } catch (e) {}
      if (r && r.status === 200) {
        try { writeJson(cf, { space: c.space, path: rel, at: new Date().toISOString(), contentType: r.headers['content-type'] || '', body: r.body.toString('utf8') }); } catch (e) {}
        if (listDir(OUT).length) replay();
        return pass(r, { 'X-BB-Source': 'live' });
      }
      if (r && r.status < 500) return pass(r);
      const cached = readJson(cf);
      if (cached) return pass({ status: 200, headers: { 'content-type': cached.contentType || 'application/json' }, body: Buffer.from(cached.body) }, { 'X-BB-Source': 'cache', 'X-BB-Cached-At': cached.at });
      throw new BbError(503, 'The Board Blueprints service is offline and this Aether has no saved copy of that yet.', 'offline');
    }
    if (!['PUT', 'POST', 'DELETE', 'PATCH'].includes(M)) throw new BbError(405, 'Method not allowed.', 'bad-request');
    let body = await readBody(req);
    if (M === 'DELETE' && body && typeof body === 'object' && !Object.keys(body).length) body = null;
    const key = shaKey(c.space, rel);
    const shas = readJson(SHAMAP) || {};
    if (body && typeof body === 'object' && shas[key] && sameSha(body.sha, shas[key].from)) body = { ...body, sha: shas[key].to };
    if (listDir(OUT).length) await replay();
    const queue = why => {
      const it = enqueue(M, rel, body, c.space);
      return send_(res, 202, { queued: true, id: it.id, status: 'queued', message: 'Saved here, will upload when online.', reason: why });
    };
    if (listDir(OUT).length) return queue('earlier changes are still waiting to upload');
    let r;
    try { r = await send(c, M, rel, body); } catch (e) { return queue('offline'); }
    if (r.status === 502 || r.status === 503 || r.status === 504) return queue(`service answered ${r.status}`);
    if (r.status >= 200 && r.status < 300 && shas[key]) { delete shas[key]; writeJson(SHAMAP, shas); }
    return pass(r);
  }

  const handler = (req, res, next) => {
    route(req, res, next).catch(e => {
      const st = e instanceof BbError ? e.status : 500;
      if (!(e instanceof BbError)) console.warn('[Blueprints]', e && e.message);
      send_(res, st, { error: e instanceof BbError ? e.message : 'Something went wrong on the Aether.', code: e.code || 'error' });
    });
  };
  handler.replay = replay;   // for tests
  return handler;
};
