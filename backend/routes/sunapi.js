// backend/routes/sunapi.js — SUNAPI Console (/api/sunapi)          AETHER_SUNAPI
//
// Talks to Hanwha devices — cameras, recorders, access control — over SUNAPI
// (/stw-cgi/*.cgi by default, per-device root) on behalf of the browser, so any PC on the
// LAN can drive them through the Pi, one at a time or many at once (/batch).
//
//   GET    /devices                      saved devices (passwords never returned)
//   POST   /devices                      add  {name, host, port, https, user, password}
//   PUT    /devices/:id                  edit (omit password to keep it)
//   DELETE /devices/:id
//   POST   /devices/:id/connect          deviceinfo + attributes.cgi (cached)
//   GET    /devices/:id/attributes       cached attributes XML (?refresh=1 refetches)
//   POST   /devices/:id/request          one SUNAPI call {path, query, method, body, accept, confirmed}
//   GET    /devices/:id/history          last requests for that device
//   DELETE /devices/:id/history
//   GET    /snapshots?deviceId=          saved "all views" captures (metadata)
//   GET    /snapshots/:sid               one capture
//   POST   /snapshots                    save a capture made by the page
//   DELETE /snapshots/:sid
//   POST   /devices/:id/reader-file      send a file to an OSDP reader through an access controller (SUNAPI-3)
//                                        body: raw .bin (application/octet-stream) or JSON {libraryId}; settings in the query
//   GET    /devices/:id/reader-file      the transfer in progress / last one for that device
//
// Data: backend/data/sunapi/ — devices.json, sunapi-credentials.json (0600, git-ignored),
// attributes/<id>.xml, history/<id>.json, snapshots/<sid>.json.
// No npm dependencies: HTTP Digest (MD5 / SHA-256, qop=auth) and Basic are done here.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE = path.join(__dirname, '..', 'data', 'sunapi');
const DEVICES = path.join(BASE, 'devices.json');
const CREDS = path.join(BASE, 'sunapi-credentials.json');
const ATTR_DIR = path.join(BASE, 'attributes');
const HIST_DIR = path.join(BASE, 'history');
const SNAP_DIR = path.join(BASE, 'snapshots');

const KEEP_HISTORY = 150;
const KEEP_SNAPSHOTS = 40;
const MAX_BODY = 4 * 1024 * 1024;          // bytes kept from one device response
const HISTORY_BODY = 64 * 1024;            // bytes of a response kept in history
const BATCH_BODY = 512 * 1024;             // per device in a multi-device request (64 × 512 KB worst case)
const SAFE_ACTIONS = new Set(['view', 'check', 'monitor', 'monitordiff']);
const KINDS = new Set(['camera', 'recorder', 'access', 'other']);
const PATH_RE = /^\/[a-z0-9_-]{1,40}\/[a-z0-9_]+\.cgi$/i;              // /<root>/<name>.cgi only
const cleanRoot = r => (typeof r === 'string' && /^[a-z0-9_-]{1,40}$/i.test(r.trim()) ? r.trim() : 'stw-cgi');
const rootOf = d => cleanRoot(d.cgiRoot);
const withRoot = (d, p) => p.replace(/^\/[^/]+\//, `/${rootOf(d)}/`);

/** Best guess at what a device is from deviceinfo / attributes (user can override). */
function guessKind(info, attrXml) {
  const hay = [info && (info.DeviceType || info.deviceType), info && info.Model, attrXml && (/name="ModelType"[^>]*value="([^"]*)"/.exec(attrXml) || [])[1]].filter(Boolean).join(' ');
  if (/\b(NVR|DVR|HVR|recorder|WRN|XRN|PRN|QRN|ARN|HRX)/i.test(hay)) return 'recorder';
  if (/access|door|ACU|\bACSC?\b|\bNHP-|\bXHP-|controller|reader|\bSAC-|intercom/i.test(hay)) return 'access';
  if (/NWC|camera|dome|bullet|PTZ|fisheye|box|multi|encoder|X[NV][A-Z]-|Q[NV][A-Z]-|P[NV][A-Z]-|PND|XND|QND|XNO|XNV|XNP|XNF/i.test(hay)) return 'camera';
  return null;
}

// ---------------------------------------------------------------- storage
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
function writeJson(f, v, mode) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, f);
  if (mode) { try { fs.chmodSync(f, mode); } catch { /* */ } }
}
const loadDevices = () => readJson(DEVICES, []);
const saveDevices = d => writeJson(DEVICES, d);
const loadCreds = () => readJson(CREDS, {});
const saveCreds = c => writeJson(CREDS, c, 0o600);

const newId = () => crypto.randomBytes(5).toString('hex');
const safeId = id => (typeof id === 'string' && /^[a-z0-9-]{4,64}$/i.test(id) ? id : null);
const publicDevice = d => { const { password, ...rest } = d; return rest; };

function cleanHost(h) {
  let s = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (/^\[.*\]$/.test(s)) return s;                  // [ipv6]
  if (/:\d+$/.test(s) && s.split(':').length === 2) s = s.split(':')[0];
  return /^[a-z0-9.\-]{1,253}$/i.test(s) ? s : null;
}

// ---------------------------------------------------------------- digest auth
const authCache = new Map();   // deviceId -> {scheme, realm, nonce, opaque, qop, algorithm, nc}

function parseChallenges(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== 'www-authenticate') continue;
    const v = rawHeaders[i + 1];
    const m = /^\s*(\w+)\s*(.*)$/.exec(v);
    if (!m) continue;
    const params = {};
    const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
    let p;
    while ((p = re.exec(m[2]))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
    out.push({ scheme: m[1].toLowerCase(), ...params });
  }
  return out;
}

function pickChallenge(list, digestOnly) {
  const digests = list.filter(c => c.scheme === 'digest');
  const sha = digests.find(c => /^sha-256(-sess)?$/i.test(c.algorithm || ''));
  const md5 = digests.find(c => !c.algorithm || /^md5(-sess)?$/i.test(c.algorithm));
  if (sha) return sha;
  if (md5) return md5;
  return digestOnly ? null : (list.find(c => c.scheme === 'basic') || null);
}

const qs = v => String(v).replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, '');   // quoted-string, no header injection

function authHeader(ch, method, uri, user, pass) {
  if (ch.scheme === 'basic') return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const alg = (ch.algorithm || 'MD5').toUpperCase();
  const hashName = alg.startsWith('SHA-256') ? 'sha256' : 'md5';
  const H = s => crypto.createHash(hashName).update(s).digest('hex');
  ch.nc = (ch.nc || 0) + 1;
  const nc = ch.nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  let ha1 = H(`${user}:${ch.realm}:${pass}`);
  if (alg.endsWith('-SESS')) ha1 = H(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qop = ch.qop ? (ch.qop.split(',').map(s => s.trim()).includes('auth') ? 'auth' : null) : null;
  const response = qop ? H(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${qs(user)}"`, `realm="${qs(ch.realm)}"`, `nonce="${qs(ch.nonce)}"`, `uri="${qs(uri)}"`,
    `algorithm=${String(ch.algorithm || 'MD5').replace(/[^\w-]/g, '')}`, `response="${response}"`,
  ];
  if (ch.opaque) parts.push(`opaque="${qs(ch.opaque)}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return 'Digest ' + parts.join(', ');
}

/** One HTTP exchange with a hard deadline: a device that keeps streaming (monitor, MJPEG)
 *  is cut at the deadline or at maxBody and what arrived is returned, flagged truncated. */
function rawRequest(dev, { method, uri, headers, body, timeoutMs, maxBody = MAX_BODY, onBodySent }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = v => { if (!settled) { settled = true; clearTimeout(deadline); resolve(v); } };
    const fail = e => { if (!settled) { settled = true; clearTimeout(deadline); reject(e); } };
    let finishPartial = null;
    const deadline = setTimeout(() => {
      if (finishPartial) finishPartial(true);
      else { req.destroy(); fail(Object.assign(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })); }
    }, timeoutMs + 500);
    const lib = dev.https ? https : http;
    const req = lib.request({
      host: dev.host.replace(/^\[|\]$/g, ''), port: dev.port || (dev.https ? 443 : 80),
      method, path: uri, headers, timeout: timeoutMs,
      rejectUnauthorized: false,                    // devices ship self-signed certificates
    }, res => {
      const chunks = []; let size = 0; let cut = false;
      finishPartial = byDeadline => { cut = cut || byDeadline; res.destroy(); done(); };
      const done = () => ok({ res, buf: Buffer.concat(chunks), truncated: cut || !res.complete });
      res.on('data', c => {
        if (size >= maxBody) return;
        const room = maxBody - size;
        chunks.push(c.length > room ? c.subarray(0, room) : c);
        size += Math.min(c.length, room);
        if (c.length >= room) { cut = true; res.destroy(); done(); }
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', e => (size ? done() : fail(e)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', fail);
    if (body) req.write(body);
    req.end(() => { if (typeof onBodySent === 'function') onBodySent(); });
  });
}

/** One SUNAPI call with Digest (preferred) or Basic auth. Retries once on 401: a fresh
 *  challenge, or a cached nonce the device no longer accepts (stale / parallel calls). */
async function sunapiCall(dev, pass, { method = 'GET', uri, body, contentType, accept = 'json', timeoutMs = 15000, maxBody, digestOnly = false, forget = false, onBodySent }) {
  const headers = { Accept: accept === 'text' ? 'text/plain, */*' : 'application/json, text/plain, */*', 'User-Agent': 'Aether-SUNAPI-Console' };
  if (body) { headers['Content-Type'] = contentType || 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  const t0 = Date.now();
  let ch = authCache.get(dev.id);
  let first = await rawRequest(dev, { method, uri, headers: ch ? { ...headers, Authorization: authHeader(ch, method, uri, dev.user, pass) } : headers, body, timeoutMs, maxBody, onBodySent });
  let authNote = ch ? 'cached' : 'none';
  if (first.res.statusCode === 401) {
    const picked = pickChallenge(parseChallenges(first.res.rawHeaders), digestOnly);
    if (picked) {
      // same nonce as the cached one: keep counting so the retry is not a replay
      ch = ch && picked.nonce === ch.nonce && picked.scheme === ch.scheme ? ch : { ...picked, nc: 0 };
      authCache.set(dev.id, ch);
      first = await rawRequest(dev, { method, uri, headers: { ...headers, Authorization: authHeader(ch, method, uri, dev.user, pass) }, body, timeoutMs, maxBody, onBodySent });
      authNote = picked.scheme === 'basic' ? 'basic' : `digest ${picked.algorithm || 'MD5'}`;
    } else if (digestOnly) authNote = 'no digest offered — login not sent';
    if (first.res.statusCode === 401) authCache.delete(dev.id);
  }
  if (forget) authCache.delete(dev.id);
  const { res, buf, truncated } = first;
  const ct = String(res.headers['content-type'] || '');
  const binary = /^(image|video|audio)\/|application\/octet-stream/i.test(ct);
  return {
    status: res.statusCode, statusText: res.statusMessage || '',
    headers: res.headers, contentType: ct, ms: Date.now() - t0, bytes: buf.length, truncated,
    bodyEncoding: binary ? 'base64' : 'utf8', body: binary ? buf.toString('base64') : buf.toString('utf8'),
    auth: authNote,
  };
}

const friendlyError = e => {
  const c = e && e.code;
  if (c === 'ECONNREFUSED') return 'The device refused the connection — check the port and HTTP/HTTPS.';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'The Pi has no route to that address.';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'That host name does not resolve from the Pi.';
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET') return (e.message || 'Timed out') + ' — is the device on and reachable from the Pi?';
  if (c === 'EPROTO' || /wrong version number/i.test(e.message || '')) return 'TLS failed — this port probably speaks plain HTTP; turn HTTPS off.';
  return e && e.message ? e.message : String(e);
};

// ---------------------------------------------------------------- history
const histFile = id => path.join(HIST_DIR, `${id}.json`);
function pushHistory(id, entry) {
  const h = readJson(histFile(id), []);
  h.unshift(entry);
  writeJson(histFile(id), h.slice(0, KEEP_HISTORY));
}

const dec = x => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
/** Hide secrets (Password=, NewPassword=, Key=…) before a query is stored in history. */
const maskQuery = q => String(q || '').replace(/(^|&)([^=&]*(?:password|passwd|pwd|secret|passphrase|privatekey|psk)[^=&]*)=([^&]*)/gi, '$1$2=********');

function parseQuery(q) {
  const out = {};
  for (const part of String(q || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = dec(i < 0 ? part : part.slice(0, i));
    out[k.toLowerCase()] = i < 0 ? '' : dec(part.slice(i + 1));
  }
  return out;
}

// ---------------------------------------------------------------- router
module.exports = function sunapiRoutes() {
  const router = express.Router();
  router.use(express.json({ limit: '30mb' }));

  const getDev = (req, res) => {
    const id = safeId(req.params.id);
    const d = id && loadDevices().find(x => x.id === id);
    if (!d) { res.status(404).json({ error: 'Device not found' }); return null; }
    return d;
  };

  router.get('/devices', (_req, res) => {
    const creds = loadCreds();
    res.json(loadDevices().map(d => ({ ...publicDevice(d), hasPassword: !!creds[d.id] })));
  });

  router.post('/devices', (req, res) => {
    const b = req.body || {};
    const host = cleanHost(b.host);
    if (!host) return res.status(400).json({ error: 'Enter the device IP address or host name' });
    const https_ = !!b.https;
    const port = Number(b.port) || (https_ ? 443 : 80);
    if (port < 1 || port > 65535) return res.status(400).json({ error: 'Port must be 1–65535' });
    const d = { id: newId(), name: String(b.name || '').trim().slice(0, 60) || host, host, port, https: https_, user: String(b.user || 'admin').slice(0, 64), kind: KINDS.has(b.kind) ? b.kind : 'other', kindManual: KINDS.has(b.kind) && b.kind !== 'other', cgiRoot: cleanRoot(b.cgiRoot), createdAt: Date.now() };
    const all = loadDevices(); all.push(d); saveDevices(all);
    if (typeof b.password === 'string' && b.password) { const c = loadCreds(); c[d.id] = b.password; saveCreds(c); }
    res.json({ ...d, hasPassword: !!b.password });
  });

  router.put('/devices/:id', (req, res) => {
    const d = getDev(req, res); if (!d) return;
    const b = req.body || {};
    if (b.host !== undefined) { const h = cleanHost(b.host); if (!h) return res.status(400).json({ error: 'Invalid host' }); d.host = h; }
    if (b.name !== undefined) d.name = String(b.name).trim().slice(0, 60) || d.host;
    if (b.https !== undefined) d.https = !!b.https;
    if (b.port !== undefined) d.port = Number(b.port) || (d.https ? 443 : 80);
    if (b.user !== undefined) d.user = String(b.user).slice(0, 64);
    if (b.kind !== undefined && KINDS.has(b.kind)) { d.kind = b.kind; d.kindManual = true; }
    if (b.cgiRoot !== undefined) d.cgiRoot = cleanRoot(b.cgiRoot);
    const all = loadDevices().map(x => (x.id === d.id ? d : x)); saveDevices(all);
    if (typeof b.password === 'string' && b.password) { const c = loadCreds(); c[d.id] = b.password; saveCreds(c); }
    authCache.delete(d.id);
    res.json({ ...publicDevice(d), hasPassword: !!loadCreds()[d.id] });
  });

  router.delete('/devices/:id', (req, res) => {
    const d = getDev(req, res); if (!d) return;
    saveDevices(loadDevices().filter(x => x.id !== d.id));
    const c = loadCreds(); delete c[d.id]; saveCreds(c);
    for (const f of [path.join(ATTR_DIR, `${d.id}.xml`), histFile(d.id)]) { try { fs.unlinkSync(f); } catch { /* */ } }
    authCache.delete(d.id);
    res.json({ ok: true });
  });

  const fetchAttributes = async (d, pass) => {
    const r = await sunapiCall(d, pass, { uri: `/${rootOf(d)}/attributes.cgi`, accept: 'text', timeoutMs: 30000 });
    if (r.status !== 200 || !/<capabilities|<attributes|<cgis/i.test(r.body)) {
      const err = new Error(r.status === 401 ? 'Wrong user name or password' : `attributes.cgi answered HTTP ${r.status}`);
      err.status = r.status; throw err;
    }
    fs.mkdirSync(ATTR_DIR, { recursive: true });
    fs.writeFileSync(path.join(ATTR_DIR, `${d.id}.xml`), r.body);
    return r.body;
  };

  router.post('/devices/:id/connect', async (req, res) => {
    const d = getDev(req, res); if (!d) return;
    const pass = loadCreds()[d.id] || '';
    try {
      let info = await sunapiCall(d, pass, { uri: `/${rootOf(d)}/system.cgi?msubmenu=deviceinfo&action=view`, accept: 'json' });
      // HTTPS-only devices (e.g. recent access controllers) redirect plain HTTP: switch this device to HTTPS once
      if ([301, 302, 303, 307, 308].includes(info.status) && info.headers.location) {
        let u = null; try { u = new URL(info.headers.location, `http://${d.host}/`); } catch { /* */ }
        if (u && u.protocol === 'https:' && (u.hostname === d.host || u.hostname === d.host.replace(/^\[|\]$/g, ''))) {
          d.https = true; d.port = Number(u.port) || 443;
          saveDevices(loadDevices().map(x => (x.id === d.id ? { ...x, https: true, port: d.port } : x)));
          authCache.delete(d.id);
          info = await sunapiCall(d, pass, { uri: `/${rootOf(d)}/system.cgi?msubmenu=deviceinfo&action=view`, accept: 'json' });
          info.switchedToHttps = true;
        }
      }
      if (info.status === 401) {
        return res.status(401).json({ error: 'Wrong user name or password. Hanwha devices lock the account for a while after several failed tries.' });
      }
      let parsed = null;
      try { parsed = JSON.parse(info.body); } catch {
        parsed = {};
        for (const line of info.body.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) parsed[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      }
      const attrFile = path.join(ATTR_DIR, `${d.id}.xml`);
      let attrBytes = 0; let attrError = null;
      const fw = parsed && (parsed.FirmwareVersion || parsed.firmwareVersion);
      const stale = !fs.existsSync(attrFile) || req.body?.refresh || (fw && d.firmware && fw !== d.firmware);
      if (stale) {
        try { attrBytes = (await fetchAttributes(d, pass)).length; } catch (e) { attrError = e.message; }
      } else attrBytes = fs.statSync(attrFile).size;
      const all = loadDevices();
      const rec = all.find(x => x.id === d.id);
      if (rec) {
        rec.lastSeen = Date.now();
        if (parsed && parsed.Model) rec.model = parsed.Model;
        if (fw) rec.firmware = fw;
        if (parsed && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(parsed.ConnectedMACAddress || '')) rec.mac = parsed.ConnectedMACAddress.replace(/-/g, ':').toLowerCase();
        if (!rec.kindManual) {
          let xml = ''; try { xml = fs.readFileSync(attrFile, 'utf8').slice(0, 20000); } catch { /* */ }
          const k = guessKind(parsed, xml); if (k) rec.kind = k;
        }
        saveDevices(all);
      }
      res.json({ ok: info.status === 200, status: info.status, switchedToHttps: !!info.switchedToHttps, kind: rec ? rec.kind : d.kind, info: parsed, ms: info.ms, auth: info.auth, attributes: { bytes: attrBytes, error: attrError } });
    } catch (e) {
      res.status(502).json({ error: friendlyError(e) });
    }
  });

  router.get('/devices/:id/attributes', async (req, res) => {
    const d = getDev(req, res); if (!d) return;
    const f = path.join(ATTR_DIR, `${d.id}.xml`);
    try {
      if (req.query.refresh || !fs.existsSync(f)) await fetchAttributes(d, loadCreds()[d.id] || '');
      res.type('application/xml').send(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      res.status(e.status === 401 ? 401 : 502).json({ error: friendlyError(e) });
    }
  });

  router.post('/devices/:id/request', async (req, res) => {
    const d = getDev(req, res); if (!d) return;
    const b = req.body || {};
    const p = String(b.path || '');
    if (!PATH_RE.test(p)) return res.status(400).json({ error: 'Path must look like /stw-cgi/<name>.cgi' });
    const query = String(b.query || '').replace(/^\?/, '');
    if (query.length > 8000) return res.status(400).json({ error: 'Query too long' });
    const q = parseQuery(query);
    const action = (q.action || '').toLowerCase();
    if (action && !SAFE_ACTIONS.has(action) && b.confirmed !== true) {
      return res.status(428).json({ error: `"${action}" changes the device — confirm it in the page first.` });
    }
    const method = String(b.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    const body = method === 'POST' && b.body ? (typeof b.body === 'string' ? b.body : JSON.stringify(b.body)) : undefined;
    const uri = withRoot(d, p) + (query ? `?${query}` : '');
    const timeoutMs = Math.max(2000, Math.min(Number(b.timeoutMs) || 15000, 120000));
    const entry = { at: Date.now(), method, path: withRoot(d, p), query: maskQuery(query), cgi: p.replace(/^\/[^/]+\/|\.cgi$/g, ''), submenu: q.msubmenu || '', action, origin: b.origin || 'manual' };
    try {
      const r = await sunapiCall(d, loadCreds()[d.id] || '', { method, uri, body, accept: b.accept, timeoutMs });
      if (b.history !== false) {
        pushHistory(d.id, { ...entry, status: r.status, ms: r.ms, bytes: r.bytes, contentType: r.contentType, body: r.bodyEncoding === 'utf8' ? r.body.slice(0, HISTORY_BODY) : null, clipped: r.bodyEncoding === 'utf8' && r.body.length > HISTORY_BODY });
      }
      res.json({ ...r, url: `${d.https ? 'https' : 'http'}://${d.host}${(d.port && d.port !== (d.https ? 443 : 80)) ? ':' + d.port : ''}${uri}` });
    } catch (e) {
      const msg = friendlyError(e);
      if (b.history !== false) pushHistory(d.id, { ...entry, status: 0, error: msg });
      res.status(502).json({ error: msg });
    }
  });

  // ------------------------------------------------------------ reader file transfer (SUNAPI-3)
  // Hands a file (reader firmware or a reader config file) to an access controller, which then
  // sends it to one OSDP reader with osdp_FILETRANSFER. Default call is the controller team's
  // temporary one:  POST /stw-cgi/accesscontrol.cgi?msubmenu=credentialreader&action=install
  //                 &Index=<physical port>&Reader.Index=<reader on that port>   (body = raw file)
  // The page may send its own query (the official call is still being implemented).
  // Runs in the background: the controller may not answer until the reader has the whole file,
  // which at 9600 baud is ~16 min for a 630 KB image. One transfer per device at a time.
  const readerJobs = new Map();                 // deviceId -> job (kept after it ends, for the page)
  const FW_INDEX = path.join(__dirname, '..', 'data', 'firmware-library.json');
  const FW_DIR = path.join(__dirname, '..', 'data', 'firmware-library');
  const READER_FILE_MAX = 20 * 1024 * 1024;
  const publicJob = j => j && { id: j.id, deviceId: j.deviceId, state: j.state, phase: j.phase, startedAt: j.startedAt, sentAt: j.sentAt || null, endedAt: j.endedAt || null,
    ms: (j.endedAt || Date.now()) - j.startedAt, file: j.file, portIndex: j.portIndex, readerIndex: j.readerIndex, fileType: j.fileType, path: j.path, query: j.query, url: j.url, result: j.result || null, error: j.error || null };

  router.get('/firmware-library', (_req, res) => {
    const list = readJson(FW_INDEX, []);
    res.json((Array.isArray(list) ? list : []).map(e => ({ id: e.id, filename: e.filename, model: e.model || null, version: e.version || null, sizeBytes: e.sizeBytes, sha256: e.sha256, notes: e.notes || null })));
  });

  router.get('/devices/:id/reader-file', (req, res) => {
    const d = getDev(req, res); if (!d) return;
    res.json(publicJob(readerJobs.get(d.id)) || null);
  });

  router.post('/devices/:id/reader-file', express.raw({ type: 'application/octet-stream', limit: READER_FILE_MAX }), async (req, res) => {
    const d = getDev(req, res); if (!d) return;
    const q0 = req.query || {};
    if (String(q0.confirmed) !== '1') return res.status(428).json({ error: 'Sending a file to a reader changes it — confirm it in the page first.' });
    const running = readerJobs.get(d.id);
    if (running && running.state === 'running') return res.status(409).json({ error: 'A transfer to this controller is already running — wait for it to finish.' });

    const portIndex = Number(q0.portIndex); const readerIndex = Number(q0.readerIndex);
    if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex > 64) return res.status(400).json({ error: 'Port index must be a whole number (the physical reader port, e.g. 1)' });
    if (!Number.isInteger(readerIndex) || readerIndex < 0 || readerIndex > 126) return res.status(400).json({ error: 'Reader index must be 0–126' });
    const fileType = q0.fileType === 'config' ? 'config' : 'firmware';

    // the file: uploaded bytes, or one from Aether's firmware library
    let buf = null; let name = '';
    if (Buffer.isBuffer(req.body) && req.body.length) {
      buf = req.body; name = String(q0.name || 'upload.bin').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    } else if (q0.libraryId) {
      const e = (readJson(FW_INDEX, []) || []).find(x => x.id === String(q0.libraryId));
      if (!e) return res.status(404).json({ error: 'That file is no longer in the firmware library' });
      const f = path.join(FW_DIR, path.basename(e.storedPath || ''));
      try { buf = fs.readFileSync(f); } catch { return res.status(404).json({ error: `Library file missing on the Pi: ${path.basename(f)}` }); }
      name = e.filename;
    }
    if (!buf || !buf.length) return res.status(400).json({ error: 'Choose a file to send' });

    const p = String(q0.path || '/stw-cgi/accesscontrol.cgi');
    if (!PATH_RE.test(p)) return res.status(400).json({ error: 'Path must look like /stw-cgi/<name>.cgi' });
    const query = String(q0.query || `msubmenu=credentialreader&action=install&Index=${portIndex}&Reader.Index=${readerIndex}`).replace(/^\?/, '');
    if (query.length > 2000) return res.status(400).json({ error: 'Query too long' });
    const timeoutMs = Math.max(60000, Math.min((Number(q0.timeoutMin) || 30) * 60000, 90 * 60000));
    const uri = withRoot(d, p) + `?${query}`;
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const job = {
      id: newId(), deviceId: d.id, state: 'running', phase: 'login', startedAt: Date.now(), portIndex, readerIndex, fileType,
      file: { name, bytes: buf.length, sha256 }, path: withRoot(d, p), query: maskQuery(query),
      url: `${d.https ? 'https' : 'http'}://${d.host}${(d.port && d.port !== (d.https ? 443 : 80)) ? ':' + d.port : ''}${uri}`,
    };
    readerJobs.set(d.id, job);
    res.json(publicJob(job));

    const pass = loadCreds()[d.id] || '';
    const q = parseQuery(query);
    const entry = { at: job.startedAt, method: 'POST', path: job.path, query: job.query, cgi: p.replace(/^\/[^/]+\/|\.cgi$/g, ''), submenu: q.msubmenu || '', action: (q.action || '').toLowerCase(),
      origin: 'reader-file', file: `${name} · ${buf.length} bytes · sha256 ${sha256.slice(0, 16)}… · port ${portIndex} reader ${readerIndex} · ${fileType}` };
    try {
      // Get a login challenge with a tiny request first, so the file is uploaded once instead of twice.
      if (!authCache.has(d.id)) {
        const pre = await sunapiCall(d, pass, { uri: `/${rootOf(d)}/system.cgi?msubmenu=deviceinfo&action=view`, timeoutMs: 15000 });
        if (pre.status === 401) throw Object.assign(new Error('Wrong user name or password for this controller.'), { code: 'EAUTH' });
      }
      job.phase = 'uploading';
      const r = await sunapiCall(d, pass, {
        method: 'POST', uri, body: buf, contentType: 'application/octet-stream', accept: 'text', timeoutMs,
        onBodySent: () => { job.phase = 'waiting'; job.sentAt = Date.now(); },
      });
      const head = r.bodyEncoding === 'utf8' ? String(r.body).slice(0, 600) : '';
      const refused = r.status !== 200 || /"Response"\s*:\s*"Fail"|"Error"\s*:|^\s*NG\b|^\s*Error\b/im.test(head);
      job.result = { status: r.status, statusText: r.statusText, ms: r.ms, contentType: r.contentType, bytes: r.bytes, body: r.bodyEncoding === 'utf8' ? r.body.slice(0, HISTORY_BODY) : '', bodyEncoding: r.bodyEncoding, auth: r.auth, headers: r.headers, truncated: r.truncated };
      job.state = refused ? 'refused' : 'done';
      pushHistory(d.id, { ...entry, status: r.status, ms: Date.now() - job.startedAt, bytes: r.bytes, contentType: r.contentType, body: job.result.body });
    } catch (e) {
      job.error = friendlyError(e);
      job.state = 'error';
      pushHistory(d.id, { ...entry, status: 0, ms: Date.now() - job.startedAt, error: job.error });
    } finally {
      job.endedAt = Date.now();
      job.phase = 'ended';
    }
  });

  // ------------------------------------------------------------ network scan
  const scanner = require('./sunapi-scan')({ sunapiCall, guessKind, loadDevices, friendlyError });
  router.get('/scan/networks', (_req, res) => res.json(scanner.networks()));
  router.post('/scan', (req, res) => {
    try { res.json(scanner.start(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.get('/scan/:sid', (req, res) => {
    const j = scanner.get(String(req.params.sid));
    if (!j) return res.status(404).json({ error: 'Scan not found (the backend may have restarted)' });
    res.json(j);
  });
  router.post('/scan/:sid/cancel', (req, res) => res.json({ ok: scanner.cancel(String(req.params.sid)) }));

  // Add many devices at once (from scan results) with one shared login.
  router.post('/devices/bulk', (req, res) => {
    const b = req.body || {};
    const list = Array.isArray(b.devices) ? b.devices.slice(0, 256) : [];
    if (!list.length) return res.status(400).json({ error: 'Nothing to add' });
    const all = loadDevices(); const creds = loadCreds(); const added = [];
    for (const x of list) {
      const host = cleanHost(x.host);
      if (!host || all.some(d => d.host === host && (d.port || 80) === (Number(x.port) || 80))) continue;
      const https_ = !!x.https;
      const d = {
        id: newId(), name: String(x.name || '').trim().slice(0, 60) || (x.model ? `${x.model} ${host.split('.').pop()}` : host),
        host, port: Number(x.port) || (https_ ? 443 : 80), https: https_, user: String(b.user || 'admin').slice(0, 64),
        kind: KINDS.has(x.kind) ? x.kind : 'other', kindManual: false, cgiRoot: cleanRoot(b.cgiRoot),
        model: x.model ? String(x.model).slice(0, 40) : undefined, mac: x.mac ? String(x.mac).slice(0, 17) : undefined, createdAt: Date.now(), source: 'scan',
      };
      all.push(d); added.push(d);
      if (b.password) creds[d.id] = String(b.password);
    }
    saveDevices(all); if (b.password) saveCreds(creds);
    res.json({ added: added.map(d => ({ ...d, hasPassword: !!b.password })) });
  });

  // ------------------------------------------------------------ fleet: one request, many devices
  // {deviceIds[], path, query, accept, confirmed, timeoutMs, verifyQuery?}
  // Runs up to 8 devices at once. A device whose cached attributes.cgi lacks the cgi/submenu
  // (or the action) is skipped, not sent. With verifyQuery, each device that accepted a change
  // is read back and the answer returned as `readback` for the page to check.
  router.post('/batch', async (req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.deviceIds) ? [...new Set(b.deviceIds.map(safeId).filter(Boolean))].slice(0, 64) : [];
    if (!ids.length) return res.status(400).json({ error: 'No devices selected' });
    const p = String(b.path || '');
    if (!PATH_RE.test(p)) return res.status(400).json({ error: 'Path must look like /stw-cgi/<name>.cgi' });
    const query = String(b.query || '').replace(/^\?/, '');
    const q = parseQuery(query);
    const action = (q.action || '').toLowerCase();
    if (action && !SAFE_ACTIONS.has(action) && b.confirmed !== true) return res.status(428).json({ error: `"${action}" changes devices — confirm it in the page first.` });
    const verifyQuery = b.verifyQuery ? String(b.verifyQuery).replace(/^\?/, '') : '';
    if (verifyQuery && (parseQuery(verifyQuery).action || '').toLowerCase() !== 'view') return res.status(400).json({ error: 'verifyQuery must be a view' });
    const cgi = p.replace(/^\/[^/]+\/|\.cgi$/g, '');
    const timeoutMs = Math.max(2000, Math.min(Number(b.timeoutMs) || 15000, 120000));
    const devices = loadDevices(); const creds = loadCreds();

    const supports = id => {
      let xml; try { xml = fs.readFileSync(path.join(ATTR_DIR, `${id}.xml`), 'utf8'); } catch { return null; }   // unknown → try anyway
      const c = new RegExp(`<(?:\\w+:)?cgi name="${cgi}">([\\s\\S]*?)</(?:\\w+:)?cgi>`).exec(xml);
      if (!c) return `${cgi}.cgi not supported by this model`;
      const s = new RegExp(`<(?:\\w+:)?submenu name="${(q.msubmenu || '').replace(/[^\w.-]/g, '')}">([\\s\\S]*?)</(?:\\w+:)?submenu>`).exec(c[1]);
      if (!s) return `${q.msubmenu} not supported by this model`;
      // "add/update" in attributes.cgi covers both action=add and action=update
      const acts = [...s[1].matchAll(/<(?:\w+:)?action name="([^"]+)"/g)].flatMap(m => m[1].split('/'));
      if (action && !acts.includes(action)) return `"${action}" not supported by this model`;
      return true;
    };

    const one = async id => {
      const d = devices.find(x => x.id === id);
      if (!d) return { deviceId: id, name: '(removed)', skipped: 'Device not found' };
      const base = { deviceId: id, name: d.name, host: d.host, model: d.model || '', kind: d.kind || 'other' };
      const sup = supports(id);
      if (typeof sup === 'string') return { ...base, skipped: sup };
      const dp = withRoot(d, p);
      const uri = dp + (query ? `?${query}` : '');
      const entry = { at: Date.now(), method: 'GET', path: dp, query: maskQuery(query), cgi, submenu: q.msubmenu || '', action, origin: 'fleet' };
      try {
        const r = await sunapiCall(d, creds[id] || '', { uri, accept: b.accept, timeoutMs, maxBody: BATCH_BODY });
        if (b.history !== false) pushHistory(id, { ...entry, status: r.status, ms: r.ms, bytes: r.bytes, contentType: r.contentType, body: r.bodyEncoding === 'utf8' ? r.body.slice(0, HISTORY_BODY) : null, clipped: r.bodyEncoding === 'utf8' && r.body.length > HISTORY_BODY });
        const out = { ...base, result: r };
        const refused = r.status !== 200 || /"Response"\s*:\s*"Fail"/.test(r.body.slice(0, 300));
        if (verifyQuery && !refused) {
          try {
            const v = await sunapiCall(d, creds[id] || '', { uri: `${dp}?${verifyQuery}`, accept: 'json', timeoutMs, maxBody: BATCH_BODY });
            out.readback = { status: v.status, body: v.bodyEncoding === 'utf8' ? v.body : '' };
          } catch (e) { out.readback = { status: 0, error: friendlyError(e) }; }
        }
        return out;
      } catch (e) {
        const msg = friendlyError(e);
        if (b.history !== false) pushHistory(id, { ...entry, status: 0, error: msg });
        return { ...base, error: msg };
      }
    };

    const t0 = Date.now();
    const results = new Array(ids.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) { const i = next++; results[i] = await one(ids[i]); }
    }));
    res.json({ ms: Date.now() - t0, results });
  });

  router.get('/devices/:id/history', (req, res) => {
    const d = getDev(req, res); if (!d) return;
    res.json(readJson(histFile(d.id), []));
  });
  router.delete('/devices/:id/history', (req, res) => {
    const d = getDev(req, res); if (!d) return;
    try { fs.unlinkSync(histFile(d.id)); } catch { /* */ }
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ snapshots
  const snapMeta = s => ({ id: s.id, deviceId: s.deviceId, deviceName: s.deviceName, name: s.name, model: s.model, firmware: s.firmware, createdAt: s.createdAt, count: Object.keys(s.results || {}).length, failed: Object.values(s.results || {}).filter(r => !r || r.status !== 200).length, ms: s.ms });
  router.get('/snapshots', (req, res) => {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const list = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).map(f => readJson(path.join(SNAP_DIR, f), null)).filter(Boolean)
      .filter(s => !req.query.deviceId || s.deviceId === req.query.deviceId).map(snapMeta).sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
  });
  router.get('/snapshots/:sid', (req, res) => {
    const sid = safeId(req.params.sid);
    const s = sid && readJson(path.join(SNAP_DIR, `${sid}.json`), null);
    if (!s) return res.status(404).json({ error: 'Snapshot not found' });
    res.json(s);
  });
  router.post('/snapshots', (req, res) => {
    const b = req.body || {};
    if (!b.results || typeof b.results !== 'object') return res.status(400).json({ error: 'results missing' });
    const dev = loadDevices().find(x => x.id === b.deviceId);
    const s = { id: `${Date.now().toString(36)}-${newId()}`, deviceId: b.deviceId || null, deviceName: dev ? dev.name : (b.deviceName || ''), name: String(b.name || '').slice(0, 80) || new Date().toLocaleString(), model: b.model || dev?.model || '', firmware: b.firmware || dev?.firmware || '', createdAt: Date.now(), ms: Number(b.ms) || 0, results: b.results };
    writeJson(path.join(SNAP_DIR, `${s.id}.json`), s);
    const all = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).map(f => ({ f, t: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs })).sort((a, z) => z.t - a.t);
    for (const old of all.slice(KEEP_SNAPSHOTS)) { try { fs.unlinkSync(path.join(SNAP_DIR, old.f)); } catch { /* */ } }
    res.json(snapMeta(s));
  });
  router.delete('/snapshots/:sid', (req, res) => {
    const sid = safeId(req.params.sid);
    if (!sid) return res.status(400).json({ error: 'bad id' });
    try { fs.unlinkSync(path.join(SNAP_DIR, `${sid}.json`)); } catch { /* */ }
    res.json({ ok: true });
  });

  return router;
};

// exported for tests
module.exports._internal = { parseChallenges, pickChallenge, authHeader, cleanHost, parseQuery };
