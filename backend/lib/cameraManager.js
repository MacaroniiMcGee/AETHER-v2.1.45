'use strict';
// AETHER_CAMERAS: RTSP cameras shown as live tiles in the cluster overview.
//
// Each Aether keeps its own camera list (cameras.json in the sign-in folder, 0600:
// RTSP URLs can carry passwords) and has its own mediamtx (the aether-stream service
// that already serves the VMS stream) pull them on demand. Browsers get HLS through
// this backend, so the sign-in and the cluster gateway cover every camera:
//
//   camera ──RTSP──▶ mediamtx path cam-<id> (on demand) ──HLS 127.0.0.1:8888──▶
//   /api/cameras/<id>/hls/index.m3u8 (signed in) ──▶ main Pi /n/<node>/... ──▶ browser
//
// mediamtx keeps runtime changes only until it restarts, so the settings are
// re-applied every 30 s: HLS on 127.0.0.1 only, camera paths readable only from
// this Pi (the VMS paths 'aether' and 'live' stay open as before).

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const MTX_API = process.env.MTX_API || 'http://127.0.0.1:9997';
const HLS_ADDR = process.env.AETHER_HLS_ADDR || '127.0.0.1:8888';
const PREFIX = 'cam-';
const BUILTIN_PATH = process.env.MTX_PATH || 'aether';   // this Pi's own Stream View (aether-stream)
const MAIN = 'main';                                       // the node's own tile: built-in stream or an IP camera
const MAX_CAMERAS = 16;

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeJson(f, o) { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode: 0o600 }); fs.renameSync(t, f); }

function mtx(method, p, body, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const u = new URL(MTX_API + p);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout: timeoutMs,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', c => { if (buf.length < 1e6) buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) { /* */ } resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e }));
    req.end(data || undefined);
  });
}

/** Call this backend from itself (trusted local request). */
function localJson(method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT || 3001), path: p, method, timeout: 8000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
    req.end(data || undefined);
  });
}

/** rtsp://user:pass@host/... -> rtsp://user:•••@host/... */
function maskUrl(u) {
  try { const x = new URL(u); if (x.password) x.password = '•••'; return x.toString(); } catch (_) { return String(u).replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:•••@'); }
}
// ---------- Hanwha (SUNAPI) cameras: find the stream address from a login ----------
function sunapiClient() {
  try { const m = require('../routes/sunapi'); return typeof m.sunapiCall === 'function' ? m.sunapiCall : null; } catch (_) { return null; }
}
/** key=value text or JSON -> object (SUNAPI answers either way). */
function parseSunapi(body) {
  try { return JSON.parse(body); } catch (_) { /* text */ }
  const o = {};
  for (const l of String(body || '').split(/\r?\n/)) { const k = l.indexOf('='); if (k > 0) o[l.slice(0, k).trim()] = l.slice(k + 1).trim(); }
  return o;
}
/** media.cgi videoprofile -> [{ channel, profiles: [{ profile, name, codec, width, height }] }] */
function videoProfiles(o) {
  const out = new Map();
  const put = (ch, p) => { if (!out.has(ch)) out.set(ch, []); out.get(ch).push(p); };
  const prof = (x) => {
    const [w, h] = String(x.Resolution || '').split('x').map(Number);
    return { profile: Number(x.Profile), name: x.Name || '', codec: String(x.EncodingType || '').toUpperCase(), width: w || 0, height: h || 0 };
  };
  if (Array.isArray(o.VideoProfiles)) {
    for (const c of o.VideoProfiles) for (const x of c.Profiles || []) put(Number(c.Channel) || 0, prof(x));
  } else {
    const tmp = {};
    for (const [k, v] of Object.entries(o)) {
      const m = /^Channel\.(\d+)\.Profile\.(\d+)\.(\w+)$/.exec(k);
      if (m) { const key = `${m[1]}.${m[2]}`; (tmp[key] = tmp[key] || { Channel: m[1], Profile: m[2] })[m[3]] = v; }
    }
    for (const x of Object.values(tmp)) put(Number(x.Channel), prof(x));
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([channel, profiles]) => ({ channel, profiles: profiles.filter(p => p.profile > 0) }));
}
/** Tiles: an H.264 stream, the smallest at least 640 wide (the camera's sub stream). Browsers can't play MJPEG in HLS; H.265 only on some. */
function pickProfile(profiles, quality) {
  const ok = profiles.filter(p => p.codec !== 'MJPEG');
  const h264 = ok.filter(p => /264/.test(p.codec));
  const pool = h264.length ? h264 : ok;
  if (!pool.length) return null;
  const sorted = [...pool].sort((a, b) => a.width - b.width);
  if (quality === 'main') return sorted[sorted.length - 1];
  return sorted.find(p => p.width >= 640) || sorted[sorted.length - 1];
}
function withCreds(uri, user, pass) {
  try { const u = new URL(uri); u.username = encodeURIComponent(user); u.password = encodeURIComponent(pass); return u.toString(); } catch (_) { return uri; }
}

/** Log in to one Hanwha camera (Digest only) and return its live streams, one per channel. */
async function hanwhaStreams({ host, port, https, user, password, root = 'stw-cgi', quality = 'sub' }) {
  const call = sunapiClient();
  if (!call) throw Object.assign(new Error('The SUNAPI Console update is needed on this Pi'), { code: 'NOSUNAPI' });
  const dev = { id: `hw-${host}-${Date.now()}`, host, port: Number(port) || (https ? 443 : 80), https: !!https, user };
  const get = (uri) => call(dev, password, { uri, accept: 'text', timeoutMs: 8000, maxBody: 256 * 1024, digestOnly: true, forget: true });
  const info = await get(`/${root}/system.cgi?msubmenu=deviceinfo&action=view`);
  if (info.status === 401) throw Object.assign(new Error(/no digest/.test(info.auth || '') ? 'Camera asked for an unencrypted login; not sent' : 'Wrong user name or password'), { code: 'LOGIN' });
  if (info.status !== 200) throw new Error(`Camera answered HTTP ${info.status}`);
  const di = parseSunapi(info.body);
  const name = di.DeviceName || di.Model || host;
  let channels = [];
  const vp = await get(`/${root}/media.cgi?msubmenu=videoprofile&action=view`);
  if (vp.status === 200) channels = videoProfiles(parseSunapi(vp.body));
  if (!channels.length) channels = [{ channel: 0, profiles: [{ profile: 2, codec: 'H264', width: 0, height: 0, name: '' }] }];
  const streams = [];
  for (const c of channels) {
    const p = pickProfile(c.profiles, quality);
    if (!p) continue;
    let uri = '';
    const su = await get(`/${root}/media.cgi?msubmenu=streamuri&action=view&Channel=${c.channel}&Profile=${p.profile}&MediaType=Live&Mode=Full&ClientType=PC&StreamType=RTPUnicast&TransportProtocol=TCP&RTSPOverHTTP=False`);
    if (su.status === 200) { const o = parseSunapi(su.body); uri = o.URI || o.Uri || o.URL || ''; }
    if (!/^rtsps?:\/\//i.test(uri)) uri = channels.length > 1 ? `rtsp://${host}:554/${c.channel}/profile${p.profile}/media.smp` : `rtsp://${host}:554/profile${p.profile}/media.smp`;
    streams.push({ channel: c.channel, profile: p.profile, codec: p.codec, resolution: p.width ? `${p.width}x${p.height}` : '', url: withCreds(uri, user, password),
      name: channels.length > 1 ? `${name} · Ch ${c.channel + 1}` : name });
  }
  if (!streams.length) throw new Error('No H.264 stream profile found on the camera');
  return { name, model: di.Model || '', mac: di.ConnectedMACAddress || '', streams };
}

function validRtsp(u) {
  try { const x = new URL(u); return (x.protocol === 'rtsp:' || x.protocol === 'rtsps:') && !!x.hostname; } catch (_) { return false; }
}

class CameraManager {
  constructor({ auth, log }) {
    this.log = log || console;
    this.file = path.join(auth.dir, 'cameras.json');
    const d = readJson(this.file, {});
    this.cameras = Array.isArray(d.cameras) ? d.cameras : [];
    // The node's own tile. Default: the built-in Aether stream; can be swapped to an IP camera.
    this.primary = d.primary && d.primary.type === 'camera' && validRtsp(d.primary.url) ? d.primary : { type: 'builtin' };
    this.builtinAvailable = false;
    this.mtxUp = null; this.lastError = null; this.syncing = false;
  }
  save() { writeJson(this.file, { primary: this.primary, cameras: this.cameras }); }
  /** Cameras mediamtx must pull: the extra streams, plus the main tile when it is an IP camera. */
  pulled() { return this.primary.type === 'camera' ? [{ ...this.primary, id: MAIN }, ...this.cameras] : this.cameras; }
  /** mediamtx path behind a tile id ('main' or a camera id). */
  mtxPathFor(id) {
    if (id === MAIN) return this.primary.type === 'camera' ? PREFIX + MAIN : BUILTIN_PATH;
    return this.cameras.find(x => x.id === id) ? PREFIX + id : null;
  }
  pathName(c) { return PREFIX + c.id; }
  pathConf(c) {
    return { source: c.url, sourceOnDemand: true, sourceOnDemandStartTimeout: '20s', sourceOnDemandCloseAfter: '15s', rtspTransport: c.transport === 'udp' ? 'udp' : 'tcp' };
  }

  /** Make mediamtx match cameras.json. Safe to call any time. */
  async sync() {
    if (this.syncing) return; this.syncing = true;
    try {
      const g = await mtx('GET', '/v3/config/global/get');
      if (g.status !== 200 || !g.json) { this.mtxUp = false; this.lastError = g.status ? `mediamtx API answered HTTP ${g.status}` : 'Camera streaming is not running on this Pi (aether-stream service).'; return; }
      this.mtxUp = true; this.lastError = null;
      const users = [
        { user: 'any', pass: '', ips: [], permissions: [{ action: 'read', path: 'aether' }, { action: 'read', path: 'live' }] },
        { user: 'any', pass: '', ips: ['127.0.0.1', '::1'], permissions: [{ action: 'publish' }, { action: 'read' }, { action: 'playback' }, { action: 'api' }, { action: 'metrics' }, { action: 'pprof' }] },
      ];
      const cur = g.json;
      const want = { hls: true, hlsAddress: HLS_ADDR, hlsAlwaysRemux: false, hlsVariant: 'lowLatency', hlsSegmentCount: 7, hlsSegmentDuration: '1s', hlsPartDuration: '200ms', hlsMuxerCloseAfter: '30s' };
      const authOk = JSON.stringify(cur.authInternalUsers || []) === JSON.stringify(users);
      const patch = {};
      for (const [k, v] of Object.entries(want)) if (cur[k] !== v) patch[k] = v;
      if (!authOk) patch.authInternalUsers = users;
      if (Object.keys(patch).length) {
        const r = await mtx('PATCH', '/v3/config/global/patch', patch);
        if (r.status !== 200) { this.lastError = `mediamtx refused the HLS settings: ${(r.json && r.json.error) || r.status}`; this.log.warn('[Cameras] ' + this.lastError); }
        else this.log.log('[Cameras] mediamtx: HLS on ' + HLS_ADDR + ', camera paths readable only from this Pi');
      }
      const list = await mtx('GET', '/v3/config/paths/list?itemsPerPage=1000');
      const items = (list.json && list.json.items) || [];
      this.builtinAvailable = items.some(p => p.name === BUILTIN_PATH);
      const have = new Map(items.filter(p => String(p.name).startsWith(PREFIX)).map(p => [p.name, p]));
      for (const c of this.pulled()) {
        const name = this.pathName(c), conf = this.pathConf(c), ex = have.get(name);
        have.delete(name);
        if (!ex) { const r = await mtx('POST', `/v3/config/paths/add/${name}`, conf); if (r.status !== 200) this.log.warn(`[Cameras] add ${name}: ${(r.json && r.json.error) || r.status}`); continue; }
        if (Object.entries(conf).some(([k, v]) => ex[k] !== v)) await mtx('PATCH', `/v3/config/paths/patch/${name}`, conf);
      }
      for (const name of have.keys()) await mtx('DELETE', `/v3/config/paths/delete/${name}`);
    } finally { this.syncing = false; }
  }

  async states() {
    const out = {};
    if (!this.mtxUp) return out;
    const r = await mtx('GET', '/v3/paths/list?itemsPerPage=1000');
    for (const p of (r.json && r.json.items) || []) {
      const st = { ready: !!p.ready, readers: Array.isArray(p.readers) ? p.readers.length : 0, tracks: p.tracks || [] };
      if (String(p.name).startsWith(PREFIX)) out[p.name.slice(PREFIX.length)] = st;
      else if (p.name === BUILTIN_PATH) out['@builtin'] = st;
    }
    return out;
  }

  /** Also keep the camera in Tools > SUNAPI Console (with its login), unless it is already there. */
  async saveToSunapi({ host, port, https, name, user, password }) {
    const list = await localJson('GET', '/api/sunapi/devices');
    if (!Array.isArray(list) || list.some(d => d.host === host)) return;
    await localJson('POST', '/api/sunapi/devices', { host, port: Number(port) || (https ? 443 : 80), https: !!https, name, user, password, kind: 'camera' });
  }

  primaryView(st = {}) {
    if (this.primary.type === 'camera') return { id: MAIN, type: 'camera', name: this.primary.name, url: maskUrl(this.primary.url), transport: this.primary.transport || 'tcp', live: st[MAIN] || { ready: false, readers: 0, tracks: [] } };
    return { id: MAIN, type: 'builtin', name: 'Aether Stream View', available: !!this.builtinAvailable, live: st['@builtin'] || { ready: false, readers: 0, tracks: [] } };
  }

  view(c, st) {
    return { id: c.id, name: c.name, url: maskUrl(c.url), transport: c.transport || 'tcp', createdAt: c.createdAt, source: c.source || null, live: st || { ready: false, readers: 0, tracks: [] } };
  }

  routes(app, express) {
    const json = express.json({ limit: '16kb' });
    const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

    app.get('/api/cameras', async (_req, res) => {
      noStore(res);
      if (this.mtxUp === null) await this.sync().catch(() => {});
      const st = await this.states().catch(() => ({}));
      res.json({ success: true, streaming: !!this.mtxUp, error: this.lastError, primary: this.primaryView(st), cameras: this.cameras.map(c => this.view(c, st[c.id])) });
    });

    // Hanwha: add found cameras with one login. { devices:[{ip,port,https,name}], user, password, quality, saveToSunapi }
    app.post('/api/cameras/hanwha', json, async (req, res) => {
      const b = req.body || {};
      const devices = (Array.isArray(b.devices) ? b.devices : []).slice(0, 32);
      const user = String(b.user || 'admin').slice(0, 64), password = String(b.password || '');
      if (!devices.length) return res.status(400).json({ success: false, error: 'Pick at least one camera' });
      if (!password) return res.status(400).json({ success: false, field: 'password', error: 'Enter the cameras\' password' });
      if (!sunapiClient()) return res.status(409).json({ success: false, error: 'This Pi needs the SUNAPI Console update for Hanwha discovery' });
      const results = [];
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < devices.length) {
          const d = devices[i++];
          const host = String(d.ip || '').trim();
          if (!/^\d{1,3}(\.\d{1,3}){3}$|^[a-z0-9.-]+$/i.test(host)) { results.push({ ip: host, ok: false, error: 'Bad address' }); continue; }
          try {
            const r = await hanwhaStreams({ host, port: d.port, https: d.https, user, password, quality: b.quality === 'main' ? 'main' : 'sub' });
            const added = [];
            for (const s of r.streams) {
              if (this.cameras.length >= MAX_CAMERAS) break;
              if (this.cameras.some(c => c.url === s.url)) continue;
              const c = { id: crypto.randomBytes(5).toString('hex'), name: String(d.name || '').trim() && r.streams.length === 1 ? String(d.name).trim().slice(0, 60) : s.name.slice(0, 60), url: s.url, transport: 'tcp', createdAt: new Date().toISOString(), source: { vendor: 'Hanwha', host, model: r.model, channel: s.channel, profile: s.profile, codec: s.codec, resolution: s.resolution } };
              this.cameras.push(c); added.push(c.name);
            }
            results.push({ ip: host, ok: true, model: r.model, added, skipped: r.streams.length - added.length });
            if (b.saveToSunapi !== false) this.saveToSunapi({ host, port: d.port, https: d.https, name: r.name, user, password }).catch(() => {});
          } catch (e) {
            results.push({ ip: host, ok: false, error: e.code === 'LOGIN' || e.code === 'NOSUNAPI' ? e.message : `Could not read the camera: ${e.message}` });
          }
        }
      }));
      if (results.some(r => r.ok && r.added.length)) { this.save(); await this.sync().catch(() => {}); }
      this.log.log(`[Cameras] Hanwha: ${results.filter(r => r.ok).length}/${results.length} cameras read, ${results.reduce((n, r) => n + (r.added ? r.added.length : 0), 0)} streams added`);
      res.json({ success: true, streaming: !!this.mtxUp, error: this.lastError, results });
    });

    // Swap the node's own tile: { type: 'builtin' } or { type: 'camera', name, url, transport }.
    app.put('/api/cameras/primary', json, async (req, res) => {
      const b = req.body || {};
      if (b.type === 'builtin') this.primary = { type: 'builtin' };
      else if (b.type === 'camera') {
        let url = String(b.url || '').trim();
        if (url.includes('•••') && this.primary.type === 'camera' && maskUrl(this.primary.url) === url) url = this.primary.url;   // unchanged, still masked
        if (!validRtsp(url)) return res.status(400).json({ success: false, field: 'url', error: 'Enter an RTSP address (example: rtsp://user:pass@192.168.1.50:554/stream1)' });
        this.primary = { type: 'camera', name: String(b.name || '').trim().slice(0, 60) || 'IP camera', url, transport: b.transport === 'udp' ? 'udp' : 'tcp', createdAt: new Date().toISOString() };
      } else return res.status(400).json({ success: false, error: 'type must be builtin or camera' });
      this.save(); await this.sync().catch(() => {});
      this.log.log(`[Cameras] main tile -> ${this.primary.type === 'builtin' ? 'built-in Aether stream' : maskUrl(this.primary.url)}`);
      const st = await this.states().catch(() => ({}));
      res.json({ success: true, streaming: !!this.mtxUp, error: this.lastError, primary: this.primaryView(st) });
    });

    app.post('/api/cameras', json, async (req, res) => {
      const b = req.body || {};
      const url = String(b.url || '').trim();
      const name = String(b.name || '').trim().slice(0, 60) || 'Camera';
      if (!validRtsp(url)) return res.status(400).json({ success: false, field: 'url', error: 'Enter an RTSP address (example: rtsp://user:pass@192.168.1.50:554/stream1)' });
      if (this.cameras.length >= MAX_CAMERAS) return res.status(400).json({ success: false, error: `Up to ${MAX_CAMERAS} streams per Pi` });
      const c = { id: crypto.randomBytes(5).toString('hex'), name, url, transport: b.transport === 'udp' ? 'udp' : 'tcp', createdAt: new Date().toISOString() };
      this.cameras.push(c); this.save();
      await this.sync().catch(() => {});
      this.log.log(`[Cameras] added "${name}" (${maskUrl(url)})`);
      res.json({ success: true, streaming: !!this.mtxUp, error: this.lastError, camera: this.view(c) });
    });

    app.patch('/api/cameras/:id', json, async (req, res) => {
      const c = this.cameras.find(x => x.id === req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'No such stream' });
      const b = req.body || {};
      if (b.name !== undefined) c.name = String(b.name).trim().slice(0, 60) || c.name;
      if (b.url !== undefined && String(b.url).trim() && !String(b.url).includes('•••')) {
        if (!validRtsp(String(b.url).trim())) return res.status(400).json({ success: false, field: 'url', error: 'Enter an RTSP address' });
        c.url = String(b.url).trim();
      }
      if (b.transport !== undefined) c.transport = b.transport === 'udp' ? 'udp' : 'tcp';
      this.save(); await this.sync().catch(() => {});
      res.json({ success: true, camera: this.view(c) });
    });

    app.delete('/api/cameras/:id', async (req, res) => {
      const before = this.cameras.length;
      this.cameras = this.cameras.filter(x => x.id !== req.params.id);
      if (this.cameras.length !== before) { this.save(); await this.sync().catch(() => {}); }
      res.json({ success: true });
    });

    // HLS from mediamtx (127.0.0.1 only), behind the sign-in.
    app.get(/^\/api\/cameras\/([a-f0-9]{10}|main)\/hls\/(.+)$/, (req, res) => {
      const id = req.params[0], rest = req.params[1];
      const mpath = this.mtxPathFor(id);
      if (!mpath) return res.status(404).end();
      if (!/^[A-Za-z0-9_.\-]+$/.test(rest)) return res.status(400).end();
      const [h, p] = HLS_ADDR.split(':');
      // mediamtx answers browsers with a cookie-check redirect; this request isn't a browser's, so say it passed.
      const qs = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
      qs.set('cookieCheck', '1');
      const q = '?' + qs.toString();
      const up = http.request({ host: h, port: Number(p), path: `/${mpath}/${rest}${q}`, method: 'GET', headers: { 'user-agent': 'aether-hls' } }, (r) => {
        const headers = {};
        for (const k of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) if (r.headers[k]) headers[k] = r.headers[k];
        res.writeHead(r.statusCode || 502, headers);
        r.pipe(res);
      });
      up.setTimeout(30000, () => up.destroy());
      up.on('error', () => { if (!res.headersSent) res.status(502).json({ success: false, error: 'Camera streaming is not running on this Pi' }); else res.destroy(); });
      req.on('close', () => up.destroy());
      up.end();
    });
  }
}

function install({ app, express, auth, log }) {
  const m = new CameraManager({ auth, log });
  m.routes(app, express);
  const tick = () => m.sync().catch(e => (log || console).warn('[Cameras] sync:', e.message));
  setTimeout(tick, 3000).unref?.();
  const t = setInterval(tick, 30000); if (t.unref) t.unref();
  global.__aetherCameras = m;
  return m;
}

module.exports = { install, CameraManager, maskUrl, validRtsp, hanwhaStreams, videoProfiles, pickProfile, parseSunapi };
