'use strict';
// AETHER_CLUSTER: one sign-in for every enrolled Aether.
//
// The Aether you sign in to (the main Pi) keeps the cluster list. Enrolling another
// Aether ("claiming" it) needs that Aether's own admin password once; the two then
// share a random key. From then on the browser only talks to the main Pi, which
// passes everything for that node through, requests and live connections alike:
//
//   browser ──(signed in)──▶ main Pi  /n/<host>:<port>/<path>  ──(key)──▶ node <path>
//
// so HTTPS pages, a Cloudflare Tunnel and one sign-in cover every node, and the
// nodes themselves never need to be reachable from outside.
//
// Stored in the sign-in folder (cluster.json, 0600):
//   hubId, self {name,color}, nodes {"host:port": {host,port,name,color,token,...}}   (main Pi)
//   managedBy {hubId: {name, url, tokenHash, since}}                                  (enrolled node)

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const COLORS = ['blue', 'cyan', 'emerald', 'violet', 'orange', 'pink', 'amber', 'teal'];
const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i;
const AUTH_SCHEME = 'AetherHub';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeJson(f, o) { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode: 0o600 }); fs.renameSync(t, f); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

function selfHosts() {
  const out = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`]);
  try { for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if (a && a.address) out.add(a.address.toLowerCase()); } catch (_) { /* */ }
  try { const f = global.__aetherHttps && global.__aetherHttps.fqdn && global.__aetherHttps.fqdn(); if (f) out.add(String(f).toLowerCase()); } catch (_) { /* */ }
  return out;
}

function normKey(host, port) { return `${String(host).trim().toLowerCase()}:${Number(port) || 3001}`; }
function parseTarget(raw) {
  const m = /^\[?([^\]/]+?)\]?:(\d{1,5})$/.exec(String(raw || ''));
  if (!m || !HOST_RE.test(m[1])) return null;
  return { host: m[1].toLowerCase(), port: Number(m[2]), key: normKey(m[1], m[2]) };
}

/** POST JSON to another Aether (plain HTTP on the LAN). */
function postJson(host, port, p, body, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ host, port, path: p, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', c => { if (buf.length < 65536) buf += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) { /* */ } resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ status: 0, error: e }));
    req.end(data);
  });
}

class ClusterGateway {
  constructor({ auth, io, log }) {
    this.auth = auth; this.io = io; this.log = log || console;
    this.file = path.join(auth.dir, 'cluster.json');
    this.load();
  }
  load() {
    const d = readJson(this.file, {});
    this.data = {
      hubId: d.hubId || crypto.randomBytes(8).toString('hex'),
      self: Object.assign({ name: 'Pi Unit 1', color: 'blue' }, d.self || {}),
      nodes: d.nodes && typeof d.nodes === 'object' ? d.nodes : {},
      managedBy: d.managedBy && typeof d.managedBy === 'object' ? d.managedBy : {},
    };
    if (!d.hubId) this.save();
  }
  save() { writeJson(this.file, this.data); }

  // ---------- node side: trust requests from the main Pi ----------
  verifier() {
    return (req) => {
      const h = String(req.headers.authorization || '');
      if (!h.startsWith(AUTH_SCHEME + ' ')) return null;
      const [hubId, token] = h.slice(AUTH_SCHEME.length + 1).trim().split('.');
      const m = hubId && token && this.data.managedBy[hubId];
      if (!m || !safeEq(m.tokenHash, sha256(token))) return null;
      return { user: `cluster:${m.name || hubId}`, role: 'admin', hub: hubId };
    };
  }

  // ---------- browser: send enrolled nodes' URLs through this Pi ----------
  uiPart() {
    return (_req, who) => {
      if (!who) return '';
      const keys = Object.keys(this.data.nodes);
      if (!keys.length) return '';
      return `/* Aether cluster gateway (AETHER_CLUSTER) */\n(${GATEWAY_SOURCE.toString()})(${JSON.stringify({ nodes: keys })});\n`;
    };
  }

  publicNodes() {
    return Object.entries(this.data.nodes).map(([key, n]) => ({
      key, host: n.host, port: n.port, name: n.name, color: n.color, claimedAt: n.claimedAt,
      remoteName: n.remoteName || null, order: n.order || 0,
    })).sort((a, b) => a.order - b.order || String(a.claimedAt).localeCompare(String(b.claimedAt)));
  }

  routes(app, express) {
    const json = express.json({ limit: '16kb' });
    const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

    // Main Pi: the cluster as every browser sees it.
    app.get('/api/cluster/nodes', (req, res) => {
      noStore(res);
      const managed = Object.values(this.data.managedBy).map(m => ({ name: m.name, url: m.url || null, since: m.since }));
      res.json({ success: true, hubId: this.data.hubId, self: { ...this.data.self, hosts: [...selfHosts()] }, nodes: this.publicNodes(), managedBy: managed });
    });

    app.patch('/api/cluster/self', json, (req, res) => {
      const b = req.body || {};
      if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (n) this.data.self.name = n; }
      if (b.color !== undefined && COLORS.includes(b.color)) this.data.self.color = b.color;
      this.save(); res.json({ success: true, self: this.data.self });
    });

    // Main Pi: enroll another Aether with its own admin password.
    app.post('/api/cluster/claim', json, async (req, res) => {
      noStore(res);
      const b = req.body || {};
      const host = String(b.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
      const port = Number(b.port) || 3001;
      if (!HOST_RE.test(host) || port < 1 || port > 65535) return res.status(400).json({ success: false, field: 'host', error: 'Enter the node\'s IP address (example: 192.168.1.33)' });
      if (selfHosts().has(host) && port === Number(process.env.PORT || 3001)) return res.status(400).json({ success: false, field: 'host', error: 'That is this Pi. It is always part of its own cluster.' });
      const key = normKey(host, port);
      const r = await postJson(host, port, '/api/cluster/enroll', {
        username: b.username || 'admin', password: b.password || '',
        hubId: this.data.hubId, hubName: this.data.self.name, hubUrl: String(b.hubUrl || '').slice(0, 200),
      });
      if (r.status === 0) {
        const code = r.error && r.error.code;
        return res.status(502).json({ success: false, field: 'host', error: code === 'ETIMEDOUT' ? `No answer from ${host}:${port}. Is it on and on this network?` : `Can't reach ${host}:${port} (${code || r.error.message}).` });
      }
      if (r.status === 404) return res.status(409).json({ success: false, field: 'host', error: `${host} doesn't support enrolling yet. Install the same Aether update on it first.` });
      if (!r.json || !r.json.success) return res.status(r.status === 401 || r.status === 429 || r.status === 409 ? 400 : 502).json({ success: false, field: r.status === 401 ? 'password' : r.status === 409 ? 'password' : 'host', error: (r.json && r.json.error) || `Unexpected answer from ${host} (HTTP ${r.status})` });
      const prev = this.data.nodes[key];
      const used = new Set([this.data.self.color, ...Object.values(this.data.nodes).map(n => n.color)]);
      this.data.nodes[key] = {
        host, port, token: r.json.token,
        name: String(b.name || '').trim().slice(0, 40) || (prev && prev.name) || r.json.name || `Pi Unit ${Object.keys(this.data.nodes).length + 2}`,
        color: (prev && prev.color) || (COLORS.includes(b.color) && b.color) || COLORS.find(c => !used.has(c)) || 'cyan',
        remoteName: r.json.name || null, claimedAt: new Date().toISOString(), order: prev ? prev.order : Object.keys(this.data.nodes).length + 1,
      };
      this.save();
      this.log.log(`[Cluster] enrolled ${key} (${this.data.nodes[key].name})`);
      res.json({ success: true, node: this.publicNodes().find(n => n.key === key) });
    });

    app.patch('/api/cluster/nodes/:key', json, (req, res) => {
      const n = this.data.nodes[req.params.key];
      if (!n) return res.status(404).json({ success: false, error: 'Not enrolled' });
      const b = req.body || {};
      if (b.name !== undefined) { const v = String(b.name).trim().slice(0, 40); if (v) n.name = v; }
      if (b.color !== undefined && COLORS.includes(b.color)) n.color = b.color;
      this.save(); res.json({ success: true, node: this.publicNodes().find(x => x.key === req.params.key) });
    });

    app.delete('/api/cluster/nodes/:key', async (req, res) => {
      const n = this.data.nodes[req.params.key];
      if (!n) return res.json({ success: true });
      const r = await postJson(n.host, n.port, '/api/cluster/leave', {}, { Authorization: `${AUTH_SCHEME} ${this.data.hubId}.${n.token}` }, 5000);
      delete this.data.nodes[req.params.key]; this.save();
      this.log.log(`[Cluster] removed ${req.params.key}${r.status === 200 ? '' : ' (node not told: unreachable)'}`);
      res.json({ success: true, nodeInformed: r.status === 200 });
    });

    // Node: a main Pi asks to enroll this Aether. Open path; needs this Aether's own admin password.
    app.post('/api/cluster/enroll', json, async (req, res) => {
      noStore(res);
      const b = req.body || {};
      const hubId = String(b.hubId || '');
      if (!/^[a-f0-9]{16}$/.test(hubId)) return res.status(400).json({ success: false, error: 'Bad request' });
      if (hubId === this.data.hubId) return res.status(400).json({ success: false, error: 'A Pi can\'t enroll itself' });
      const chk = await this.auth.checkPassword(req, b.username, b.password);
      if (!chk.ok) return res.status(chk.status).json({ success: false, error: chk.status === 401 ? 'Wrong user name or password for that node' : chk.error });
      if (chk.mustChange) return res.status(409).json({ success: false, error: 'That node still has the default password. Sign in to it directly once (http://<its IP>:3001) and set its own password, then enroll it.' });
      const token = crypto.randomBytes(32).toString('base64url');
      this.data.managedBy[hubId] = { name: String(b.hubName || 'Main Aether').slice(0, 40), url: /^https?:\/\//.test(String(b.hubUrl || '')) ? String(b.hubUrl).slice(0, 200) : null, tokenHash: sha256(token), since: new Date().toISOString(), from: require('./authManager').clientIp(req) };
      this.save();
      this.log.log(`[Cluster] enrolled into "${this.data.managedBy[hubId].name}" by ${chk.user}`);
      res.json({ success: true, token, name: this.data.self.name });
    });

    // Node: the main Pi removed this node.
    app.post('/api/cluster/leave', (req, res) => {
      const v = this.verifier()(req);
      if (!v) return res.status(401).json({ success: false, error: 'Not from the main Pi' });
      delete this.data.managedBy[v.hub]; this.save();
      this.log.log('[Cluster] left the cluster (removed by the main Pi)');
      res.json({ success: true });
    });

    // Pass-through to an enrolled node. The sign-in gate has already checked the session.
    app.use('/n/:target', (req, res) => this.proxyHttp(req, res));
  }

  nodeFor(target) {
    const t = parseTarget(target);
    return t && this.data.nodes[t.key] ? { ...this.data.nodes[t.key], key: t.key } : null;
  }
  forwardHeaders(req, n, upgrade) {
    const h = { ...req.headers };
    for (const k of ['cookie', 'authorization', 'origin', 'referer', 'host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'cdn-loop', 'true-client-ip', 'x-real-ip']) delete h[k];
    if (!upgrade) { delete h.connection; delete h['keep-alive']; delete h.upgrade; }
    h.host = `${n.host}:${n.port}`;
    h.authorization = `${AUTH_SCHEME} ${this.data.hubId}.${n.token}`;
    return h;
  }
  proxyHttp(req, res) {
    const n = this.nodeFor(req.params.target);
    if (!n) return res.status(404).json({ success: false, error: 'Not an enrolled node' });
    const upstream = http.request({ host: n.host, port: n.port, method: req.method, path: req.url || '/', headers: this.forwardHeaders(req, n, false) }, (up) => {
      const headers = { ...up.headers };
      delete headers['set-cookie'];
      for (const k of Object.keys(headers)) if (/^access-control-/i.test(k)) delete headers[k];
      // The node's own sign-in answer must not sign this page out of the main Pi.
      if (headers['x-aether-auth']) { headers['x-aether-node-auth'] = headers['x-aether-auth']; delete headers['x-aether-auth']; }
      if (up.statusCode === 401 && headers['x-aether-node-auth']) headers['x-aether-node-auth'] = 'key-rejected';
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.status(502).json({ success: false, error: `${n.name} (${n.key}) is not answering: ${e.code || e.message}`, nodeOffline: true });
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  // Live connections (socket.io websocket upgrades) to /n/<host:port>/...
  attachUpgrade(server) {
    if (!server || server.__aetherClusterUpgrade) return;
    server.__aetherClusterUpgrade = true;
    server.on('upgrade', (req, socket, head) => {
      const m = /^\/n\/([^/]+)(\/.*)?$/.exec(req.url || '');
      if (!m) return;   // socket.io's own handler deals with it
      const fail = (code, msg) => { try { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_) { /* */ } };
      const authed = require('./authManager').isTrustedLocal(req) || (() => { const s = this.auth.sessionFor(req); return s && !s.mustChange; })();
      if (!authed) return fail(401, 'Unauthorized');
      const n = this.nodeFor(decodeURIComponent(m[1]));
      if (!n) return fail(404, 'Not Found');
      const up = net.connect(n.port, n.host);
      up.setTimeout(15000, () => up.destroy());
      up.on('connect', () => {
        up.setTimeout(0);
        const headers = this.forwardHeaders(req, n, true);
        let head0 = `${req.method} ${m[2] || '/'} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) for (const vv of [].concat(v)) head0 += `${k}: ${vv}\r\n`;
        up.write(head0 + '\r\n');
        if (head && head.length) up.write(head);
        up.pipe(socket); socket.pipe(up);
      });
      up.on('error', () => fail(502, 'Bad Gateway'));
      socket.on('error', () => up.destroy());
      up.on('close', () => socket.destroy());
      socket.on('close', () => up.destroy());
    });
  }
}

// ---------------------------------------------------------------------------
// Browser: rewrite http://<enrolled node>:<port>/... to this page's origin /n/<node>/...
// (loaded inside /api/auth/ui.js, after the HTTPS shim and before the sign-in helper)
// ---------------------------------------------------------------------------
function GATEWAY_SOURCE(CFG) {
  try {
    if (window.__aetherGateway) return;
    var nodes = {};
    (CFG.nodes || []).forEach(function (k) { nodes[String(k).toLowerCase()] = 1; });
    var base = location.port === '5173' ? location.protocol + '//' + location.hostname + ':3001' : location.origin;
    var rw = function (u) {
      if (typeof u !== 'string' && !(u && typeof u.href === 'string')) return u;
      var s = typeof u === 'string' ? u : u.href;
      if (!/^(https?|wss?):\/\//i.test(s)) return u;
      var x; try { x = new URL(s); } catch (e) { return u; }
      var port = x.port || (/^(https|wss):$/i.test(x.protocol) ? '443' : '80');
      var key = x.hostname.toLowerCase().replace(/^\[|\]$/g, '') + ':' + port;
      if (!nodes[key]) return u;
      var out = base + '/n/' + key + x.pathname + x.search + x.hash;
      if (/^wss?:$/i.test(x.protocol)) out = out.replace(/^http/, 'ws');
      return out;
    };
    window.__aetherGateway = { rewrite: rw, nodes: Object.keys(nodes) };
    var of = window.fetch;
    if (of) window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || (input && input instanceof URL)) input = rw(String(input));
        else if (input && typeof Request !== 'undefined' && input instanceof Request) { var n = rw(input.url); if (n !== input.url) input = new Request(n, input); }
      } catch (e) { /* */ }
      return of.call(this, input, init);
    };
    var xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url) { var a = Array.prototype.slice.call(arguments); a[1] = rw(url); return xo.apply(this, a); };
    var wrapCtor = function (name) {
      var O = window[name]; if (!O) return;
      var W = function (url, p) { return arguments.length > 1 ? new O(rw(url), p) : new O(rw(url)); };
      W.prototype = O.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { if (k in O) try { Object.defineProperty(W, k, { value: O[k] }); } catch (e) { /* */ } });
      window[name] = W;
    };
    wrapCtor('WebSocket'); wrapCtor('EventSource');
    var wo = window.open;
    if (wo) window.open = function (url) { var a = Array.prototype.slice.call(arguments); if (a.length) a[0] = rw(a[0]); return wo.apply(this, a); };
    var patchProp = function (C, prop) {
      if (!C) return; var d = Object.getOwnPropertyDescriptor(C.prototype, prop);
      if (!d || !d.set) return;
      Object.defineProperty(C.prototype, prop, { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, rw(v)); } });
    };
    patchProp(window.HTMLImageElement, 'src'); patchProp(window.HTMLIFrameElement, 'src'); patchProp(window.HTMLMediaElement, 'src');
    patchProp(window.HTMLSourceElement, 'src'); patchProp(window.HTMLAnchorElement, 'href');
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      var k = String(n).toLowerCase();
      if ((k === 'src' || k === 'href') && typeof v === 'string') v = rw(v);
      return sa.call(this, n, v);
    };
  } catch (e) { try { console.warn('[Aether cluster] gateway failed', e); } catch (_) { /* */ } }
}

function install({ app, io, express, auth, log }) {
  const g = new ClusterGateway({ auth, io, log });
  auth.verifiers.push(g.verifier());
  auth.uiParts.push(g.uiPart());
  g.routes(app, express);
  // Enrolling is open (it checks this Aether's own password); everything else needs a session or the key.
  if (auth.openPaths) auth.openPaths.add('/api/cluster/enroll');
  if (io) {
    if (io.httpServer) g.attachUpgrade(io.httpServer);
    const attach = io.attach.bind(io);   // the HTTPS server attaches later (httpsManager)
    io.attach = function (srv, opts) { const r = attach(srv, opts); try { g.attachUpgrade(srv); } catch (_) { /* */ } return r; };
  }
  global.__aetherCluster = g;
  (log || console).log(`[Cluster] ${Object.keys(g.data.nodes).length} enrolled node(s)${Object.keys(g.data.managedBy).length ? '; this Aether is enrolled in ' + Object.values(g.data.managedBy).map(m => m.name).join(', ') : ''}`);
  return g;
}

module.exports = { install, ClusterGateway, GATEWAY_SOURCE, parseTarget };
