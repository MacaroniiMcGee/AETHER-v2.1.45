// backend/lib/httpsManager.js — AETHER_HTTPS (bundle "https-1")
//
// Serves the whole Aether app over HTTPS (port 443, or 3443 if 443 is taken) next
// to the existing http://<pi>:3001, with a real Let's Encrypt certificate for
// <host>.<domain> obtained by THIS Pi through Cloudflare DNS (dns-01). No server
// of ours is involved and nothing needs to reach into the network.
//
//   - Cloudflare: an API token limited to one zone (Zone.DNS Edit + Zone.Zone Read).
//     The Pi keeps an A record <host>.<domain> -> its LAN IP (DNS only, not proxied)
//     and adds/removes the _acme-challenge TXT record while a certificate is issued.
//   - Let's Encrypt: acme-client (vendored in backend/vendor/acme). Renews on its own
//     when fewer than 30 days are left (checked every 12 h).
//   - Until a real certificate exists (or after it expired), HTTPS uses a self-signed
//     certificate so the port always works (browser shows a warning).
//   - The page's many hardcoded http://<ip>:3001 calls are rewritten in the browser
//     by /aether-https-shim.js (served from here with this Pi's own addresses).
//   - http://<pi>:3001 page loads are sent to https://<host>.<domain> only after a
//     browser has proven it can open that address (Setup > HTTPS > Check), and never
//     for API calls, socket.io, or requests from this Pi itself. ?http=1 opts out.
//
// Secrets (token, private keys) live outside the Aether folder in /var/lib/aether/https
// (mode 600), so pi-sync and backups never pick them up.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const dnsP = require('dns').promises;

const VENDOR = path.join(__dirname, '..', 'vendor', 'acme', 'node_modules');
function vendor(name) { return require(path.join(VENDOR, name)); }

const RENEW_DAYS = 30;
const RENEW_CHECK_MS = 12 * 3600 * 1000;
const RENEW_RETRY_MS = 6 * 3600 * 1000;
const DNS_SYNC_MS = 10 * 60 * 1000;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function pickDir() {
  const cands = [process.env.AETHER_HTTPS_DIR, '/var/lib/aether/https', path.join(__dirname, '..', 'data', 'https')].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { /* next */ }
  }
  return cands[cands.length - 1];
}

function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }
function writeSecret(f, data) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, f);
  try { fs.chmodSync(f, 0o600); } catch (_) { /* best effort */ }
}

/** Parse a PEM certificate (first in the chain). Pure; exported for tests. */
function certInfo(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    const names = String(x.subjectAltName || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.replace(/^DNS:/, '').replace(/^IP Address:/, ''));
    const validTo = new Date(x.validTo);
    const validFrom = new Date(x.validFrom);
    const issuer = String(x.issuer || '').replace(/\n/g, ', ');
    return { names, validTo: validTo.toISOString(), validFrom: validFrom.toISOString(), issuer,
      daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86400000),
      staging: /STAGING|Fake LE|\(STAGING\)/i.test(issuer) };
  } catch (_) { return null; }
}

/** Is the Let's Encrypt cert usable for fqdn right now? (pure; exported for tests) */
function certUsable(info, fqdn, now = Date.now()) {
  if (!info || !fqdn) return false;
  if (new Date(info.validTo).getTime() <= now + 60000) return false;
  if (new Date(info.validFrom).getTime() > now + 60000) return false;
  return info.names.includes(fqdn);
}

/** This Pi's LAN IPv4 addresses, best first (eth*, then wlan*, then the rest). */
function lanIps() {
  const out = [];
  const nets = os.networkInterfaces();
  const rank = (n) => (/^(eth|en)/.test(n) ? 0 : /^wl/.test(n) ? 1 : /^(docker|br-|veth|tailscale|zt|tun|wg)/.test(n) ? 9 : 5);
  for (const name of Object.keys(nets).sort((a, b) => rank(a) - rank(b))) {
    if (rank(name) === 9) continue;
    for (const a of nets[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

/** Rewrite rule used by the browser shim, shared so it can be tested here. (pure) */
const SHIM_SOURCE = function shim(SELF) {
  try {
    if (location.protocol !== 'https:') return;
    var hosts = {};
    ['localhost', '127.0.0.1', '[::1]', location.hostname].concat(SELF.hosts || []).forEach(function (h) { if (h) hosts[String(h).toLowerCase()] = 1; });
    var PORT = String(SELF.port || 3001);
    var warned = {};
    var rw = function (u) {
      if (typeof u !== 'string' && !(u && typeof u.href === 'string')) return u;
      var s = typeof u === 'string' ? u : u.href;
      if (!/^(https?|wss?):\/\//i.test(s)) return u;
      var x; try { x = new URL(s); } catch (e) { return u; }
      if (x.port !== PORT) return u;
      var host = x.hostname.toLowerCase();
      if (!hosts[host]) {
        if (!warned[host]) { warned[host] = 1; try { console.warn('[Aether HTTPS] ' + x.origin + ' is another device over plain HTTP; the browser blocks it on an HTTPS page. Open that device by its own HTTPS address.'); } catch (e) { /* */ } }
        return u;
      }
      var ws = /^wss?:$/i.test(x.protocol);
      return (ws ? 'wss://' : 'https://') + location.host + x.pathname + x.search + x.hash;
    };
    window.__aetherHttpsRewrite = rw;
    var of = window.fetch;
    if (of) window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || (input && input instanceof URL)) input = rw(String(input));
        else if (input && typeof Request !== 'undefined' && input instanceof Request) { var n = rw(input.url); if (n !== input.url) input = new Request(n, input); }
      } catch (e) { /* leave it */ }
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
    patchProp(window.HTMLSourceElement, 'src'); patchProp(window.HTMLScriptElement, 'src'); patchProp(window.HTMLAnchorElement, 'href');
    patchProp(window.HTMLLinkElement, 'href');
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      var k = String(n).toLowerCase();
      if ((k === 'src' || k === 'href' || k === 'action') && typeof v === 'string') v = rw(v);
      return sa.call(this, n, v);
    };
  } catch (e) { try { console.warn('[Aether HTTPS] shim failed', e); } catch (_) { /* */ } }
};

class HttpsManager {
  constructor({ app, io, httpServer, log = console, port = 3001 }) {
    this.app = app; this.io = io; this.httpServer = httpServer; this.log = log; this.httpPort = Number(port) || 3001;
    this.dir = pickDir();
    this.f = {
      config: path.join(this.dir, 'config.json'),
      token: path.join(this.dir, 'cloudflare-token.key'),
      account: path.join(this.dir, 'acme-account.key'),
      leKey: path.join(this.dir, 'le-privkey.key'),
      leCrt: path.join(this.dir, 'le-fullchain.pem'),
      ssKey: path.join(this.dir, 'selfsigned.key'),
      ssCrt: path.join(this.dir, 'selfsigned.pem'),
      state: path.join(this.dir, 'state.json'),
    };
    this.cfg = Object.assign({ domain: '', host: '', email: '', agreed: false, staging: false, redirect: true, browserVerified: false, ipOverride: '' }, readJson(this.f.config, {}));
    this.state = Object.assign({ recordIp: null, lastSync: null, dnsError: null, lastIssueAt: null, lastIssueError: null, nextTryAt: 0, zoneId: null }, readJson(this.f.state, {}));
    this.server = null; this.listenPort = null; this.listenError = null; this.source = 'none';
    this.job = { running: false, steps: [], error: null, startedAt: null, finishedAt: null, ok: null };
    this.timers = [];
  }

  // ---------- config ----------
  fqdn() { return this.cfg.domain && this.cfg.host ? `${this.cfg.host}.${this.cfg.domain}` : ''; }
  tokenSet() { try { return fs.statSync(this.f.token).size > 10; } catch (_) { return false; } }
  token() { try { return fs.readFileSync(this.f.token, 'utf8').trim(); } catch (_) { return ''; } }
  saveCfg() { writeSecret(this.f.config, JSON.stringify(this.cfg, null, 2)); }
  saveState() { try { writeSecret(this.f.state, JSON.stringify(this.state, null, 2)); } catch (_) { /* best effort */ } }
  ip() { return (this.cfg.ipOverride && /^\d+\.\d+\.\d+\.\d+$/.test(this.cfg.ipOverride)) ? this.cfg.ipOverride : (lanIps()[0] || null); }

  leInfo() { try { return certInfo(fs.readFileSync(this.f.leCrt, 'utf8')); } catch (_) { return null; } }
  realCertOk() { return certUsable(this.leInfo(), this.fqdn()); }

  // ---------- certificates ----------
  async ensureSelfSigned() {
    const want = new Set(['aether', os.hostname(), `${os.hostname()}.local`, 'localhost', ...(this.fqdn() ? [this.fqdn()] : []), ...lanIps(), '127.0.0.1']);
    let info = null;
    try { info = certInfo(fs.readFileSync(this.f.ssCrt, 'utf8')); fs.accessSync(this.f.ssKey); } catch (_) { info = null; }
    const covers = info && [...want].every(n => info.names.includes(n));
    if (info && covers && info.daysLeft > 30) return;
    const x509 = vendor('@peculiar/x509');
    x509.cryptoProvider.set(crypto.webcrypto);
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const now = new Date(Date.now() - 3600 * 1000);
    const names = [...want].map(n => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? { type: 'ip', value: n } : { type: 'dns', value: n }));
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: crypto.randomBytes(8).toString('hex').replace(/^[89a-f]/, '1'),
      name: `CN=${this.fqdn() || os.hostname() || 'aether'}, O=Aether (self-signed)`,
      notBefore: now, notAfter: new Date(now.getTime() + 397 * 86400000),
      signingAlgorithm: alg, keys,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        new x509.SubjectAlternativeNameExtension(names, false),
      ],
    });
    const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
    writeSecret(this.f.ssKey, keyPem);
    writeSecret(this.f.ssCrt, cert.toString('pem') + '\n');
    this.log.log(`[HTTPS] self-signed certificate made for ${[...want].join(', ')}`);
  }

  currentCreds() {
    if (this.realCertOk()) {
      try { return { key: fs.readFileSync(this.f.leKey), cert: fs.readFileSync(this.f.leCrt), source: 'letsencrypt' }; } catch (_) { /* fall back */ }
    }
    return { key: fs.readFileSync(this.f.ssKey), cert: fs.readFileSync(this.f.ssCrt), source: 'self-signed' };
  }

  async reloadCert() {
    if (!this.realCertOk()) await this.ensureSelfSigned();
    const c = this.currentCreds();
    this.source = c.source;
    if (this.server) this.server.setSecureContext({ key: c.key, cert: c.cert, minVersion: 'TLSv1.2' });
    return c.source;
  }

  // ---------- HTTPS server ----------
  async startServer() {
    await this.reloadCert().catch(e => { this.listenError = `certificate: ${e.message}`; throw e; });
    const c = this.currentCreds();
    const srv = https.createServer({ key: c.key, cert: c.cert, minVersion: 'TLSv1.2' }, this.app);
    const ports = process.env.HTTPS_PORT ? [Number(process.env.HTTPS_PORT)] : [443, 3443];
    for (const p of ports) {
      const ok = await new Promise((resolve) => {
        const onErr = (e) => { srv.removeListener('listening', onOk); this.listenError = `${p}: ${e.code || e.message}`; resolve(false); };
        const onOk = () => { srv.removeListener('error', onErr); resolve(true); };
        srv.once('error', onErr); srv.once('listening', onOk);
        srv.listen(p, '0.0.0.0');
      });
      if (ok) { this.listenPort = p; this.listenError = null; break; }
    }
    if (!this.listenPort) { this.log.warn(`[HTTPS] could not listen (${this.listenError}); HTTP on ${this.httpPort} keeps working`); return; }
    srv.on('error', (e) => this.log.warn(`[HTTPS] server error: ${e.message}`));
    srv.on('tlsClientError', () => { /* browsers probing a self-signed cert: not worth logging */ });
    this.server = srv;
    this.attachSocketIo(srv);
    this.log.log(`[HTTPS] listening on ${this.listenPort} (${this.source} certificate${this.fqdn() ? ', ' + this.fqdn() : ''})`);
  }

  // socket.io on both servers. io.attach() replaces io.engine/io.httpServer with the
  // new ones, so put the HTTP ones back and make io.engine.clientsCount count both
  // (server.js pauses I/O polling when it reads 0).
  attachSocketIo(srv) {
    const io = this.io;
    if (!io || typeof io.attach !== 'function') return;
    const httpEngine = io.engine, httpSrv = io.httpServer;
    io.attach(srv, { cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] } });
    const httpsEngine = io.engine;
    this.httpsEngine = httpsEngine;
    if (httpEngine && httpsEngine !== httpEngine) {
      io.engine = new Proxy(httpEngine, {
        get(t, k) {
          if (k === 'clientsCount') return (t.clientsCount || 0) + (httpsEngine.clientsCount || 0);
          if (k === 'close') return function () { try { httpsEngine.close(); } catch (_) { /* */ } return t.close.apply(t, arguments); };
          const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      io.eio = httpEngine;
    }
    if (httpSrv) io.httpServer = httpSrv;
  }

  // ---------- Cloudflare ----------
  async cf(method, p, body, tokenOverride) {
    const tok = tokenOverride || this.token();
    if (!tok) throw new Error('No Cloudflare token saved');
    const url = (process.env.AETHER_CF_API || 'https://api.cloudflare.com/client/v4') + p;
    const opts = { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let j, status;
    if (typeof fetch === 'function') {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      try { const r = await fetch(url, { ...opts, signal: ctl.signal }); status = r.status; j = await r.json().catch(() => null); }
      catch (e) { throw new Error(`Cloudflare unreachable: ${e.name === 'AbortError' ? 'timed out' : (e.cause && e.cause.code) || e.message}`); }
      finally { clearTimeout(t); }
    } else {
      const axios = vendor('axios');
      try { const r = await axios({ url, method, headers: opts.headers, data: body, timeout: 20000, validateStatus: () => true }); status = r.status; j = r.data; }
      catch (e) { throw new Error(`Cloudflare unreachable: ${e.code || e.message}`); }
    }
    if (!j || j.success !== true) {
      const msg = j && Array.isArray(j.errors) && j.errors.length ? j.errors.map(e => `${e.message}${e.code ? ' (' + e.code + ')' : ''}`).join('; ') : `HTTP ${status}`;
      throw new Error(`Cloudflare: ${msg}`);
    }
    return j;
  }

  async zoneId(tok) {
    if (!tok && this.state.zoneId && this.state.zoneFor === this.cfg.domain) return this.state.zoneId;
    const j = await this.cf('GET', `/zones?name=${encodeURIComponent(this.cfg.domain)}`, undefined, tok);
    const z = (j.result || [])[0];
    if (!z) throw new Error(`The token can't see ${this.cfg.domain}. Check the token's Zone Resources include this domain and it has Zone · Zone · Read.`);
    if (z.status && z.status !== 'active') throw new Error(`${this.cfg.domain} is "${z.status}" in Cloudflare, not Active yet (nameservers still changing?)`);
    if (!tok) { this.state.zoneId = z.id; this.state.zoneFor = this.cfg.domain; this.saveState(); }
    return z.id;
  }

  /** Check a token (the saved one if none given): active, sees the zone, can list DNS records. */
  async testToken(tok) {
    if (!this.cfg.domain) throw new Error('Set the domain first');
    const v = await this.cf('GET', '/user/tokens/verify', undefined, tok);
    if (v.result && v.result.status && v.result.status !== 'active') throw new Error(`Token is ${v.result.status}`);
    const zid = await this.zoneId(tok);
    await this.cf('GET', `/zones/${zid}/dns_records?per_page=1`, undefined, tok);
    return { zoneId: zid };
  }

  async syncARecord(force = false) {
    const name = this.fqdn(); const ip = this.ip();
    if (!name || !this.tokenSet()) return { skipped: true };
    if (!ip) throw new Error('This Pi has no LAN IPv4 address');
    if (!force && this.state.recordIp === ip && this.state.recordFor === name && this.state.lastSync && Date.now() - this.state.lastSync < 6 * 3600 * 1000) return { ip, unchanged: true };
    const zid = await this.zoneId();
    const list = await this.cf('GET', `/zones/${zid}/dns_records?type=A&name=${encodeURIComponent(name)}`);
    const recs = list.result || [];
    const body = { type: 'A', name, content: ip, ttl: 120, proxied: false, comment: 'Aether Pi (kept up to date by the Pi)' };
    if (recs[0]) {
      if (recs[0].content !== ip || recs[0].proxied) await this.cf('PUT', `/zones/${zid}/dns_records/${recs[0].id}`, body);
      for (const extra of recs.slice(1)) await this.cf('DELETE', `/zones/${zid}/dns_records/${extra.id}`).catch(() => {});
    } else {
      await this.cf('POST', `/zones/${zid}/dns_records`, body);
    }
    this.state.recordIp = ip; this.state.recordFor = name; this.state.lastSync = Date.now(); this.state.dnsError = null; this.saveState();
    return { ip };
  }

  // ---------- Let's Encrypt ----------
  step(msg, level = 'info') {
    this.job.steps.push({ t: Date.now(), msg, level });
    if (this.job.steps.length > 60) this.job.steps.shift();
    this.log.log(`[HTTPS] ${msg}`);
  }

  async waitTxt(name, value) {
    const r = new dnsP.Resolver(); r.setServers((process.env.AETHER_DNS_SERVERS || '1.1.1.1,8.8.8.8').split(','));
    const until = Date.now() + Number(process.env.AETHER_TXT_WAIT_MS || 90000);
    while (Date.now() < until) {
      try { const recs = await r.resolveTxt(name); if (recs.some(parts => parts.join('') === value)) return true; } catch (_) { /* not yet / blocked */ }
      await new Promise(res => setTimeout(res, 5000));
    }
    return false;
  }

  canIssue() {
    if (!this.cfg.domain || !this.cfg.host) return 'Set the domain and this Pi\'s name first';
    if (!this.tokenSet()) return 'Save a Cloudflare token first';
    if (!this.cfg.agreed) return 'Accept the Let\'s Encrypt Subscriber Agreement first';
    return null;
  }

  async issue({ reason = 'requested' } = {}) {
    const why = this.canIssue(); if (why) throw new Error(why);
    if (this.job.running) throw new Error('Already working on it');
    this.job = { running: true, steps: [], error: null, startedAt: Date.now(), finishedAt: null, ok: null };
    const fqdn = this.fqdn();
    const created = [];
    let zid = null;
    try {
      this.step(`Getting a certificate for ${fqdn} (${reason}${this.cfg.staging ? ', Let\'s Encrypt TEST server' : ''})`);
      zid = await this.zoneId();
      this.step(`Cloudflare zone found`);
      const a = await this.syncARecord(true);
      this.step(`DNS: ${fqdn} → ${a.ip}`);
      const acme = vendor('acme-client');
      let accountKey;
      try { accountKey = fs.readFileSync(this.f.account); } catch (_) { accountKey = await acme.crypto.createPrivateEcdsaKey(); writeSecret(this.f.account, accountKey); }
      const client = new acme.Client({ directoryUrl: process.env.AETHER_ACME_DIRECTORY || (this.cfg.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production), accountKey });
      const certKey = await acme.crypto.createPrivateEcdsaKey();
      const [, csr] = await acme.crypto.createCsr({ commonName: fqdn, altNames: [fqdn] }, certKey);
      const cert = await client.auto({
        csr, email: this.cfg.email || undefined, termsOfServiceAgreed: true,
        challengePriority: ['dns-01'], skipChallengeVerification: true,
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'dns-01') throw new Error(`unexpected challenge ${challenge.type}`);
          const name = `_acme-challenge.${authz.identifier.value}`;
          const r = await this.cf('POST', `/zones/${zid}/dns_records`, { type: 'TXT', name, content: keyAuthorization, ttl: 120, comment: 'Aether ACME challenge (temporary)' });
          created.push(r.result.id);
          this.step('Proof record added in Cloudflare; waiting for it to be visible');
          const seen = await this.waitTxt(name, keyAuthorization);
          this.step(seen ? 'Proof record visible; asking Let\'s Encrypt to check it' : 'Could not see the proof record from here (DNS may be blocked); asking Let\'s Encrypt anyway', seen ? 'info' : 'warn');
          if (!seen) await new Promise(res => setTimeout(res, Number(process.env.AETHER_TXT_EXTRA_MS || 15000)));
        },
        challengeRemoveFn: async () => {
          while (created.length) { const id = created.pop(); await this.cf('DELETE', `/zones/${zid}/dns_records/${id}`).catch(() => {}); }
        },
      });
      writeSecret(this.f.leKey, certKey);
      writeSecret(this.f.leCrt, cert);
      const info = this.leInfo();
      if (!certUsable(info, fqdn)) throw new Error('Let\'s Encrypt returned a certificate that does not cover ' + fqdn);
      this.state.lastIssueAt = Date.now(); this.state.lastIssueError = null; this.state.nextTryAt = 0; this.saveState();
      const src = await this.reloadCert();
      this.step(`Certificate installed (${info.staging ? 'TEST, browsers will not trust it' : 'trusted'}, valid until ${info.validTo.slice(0, 10)}); HTTPS now uses ${src === 'letsencrypt' ? 'it' : 'the self-signed one'}`, 'ok');
      this.job.ok = true;
    } catch (e) {
      const msg = String((e && e.message) || e).replace(/Bearer [^\s]+/g, 'Bearer ***');
      this.job.error = msg; this.job.ok = false;
      this.state.lastIssueError = msg; this.state.nextTryAt = Date.now() + RENEW_RETRY_MS; this.saveState();
      this.step(`Failed: ${msg}`, 'error');
      if (zid) while (created.length) { const id = created.pop(); await this.cf('DELETE', `/zones/${zid}/dns_records/${id}`).catch(() => {}); }
    } finally {
      this.job.running = false; this.job.finishedAt = Date.now();
    }
    return this.job.ok;
  }

  async renewTick() {
    try {
      if (this.canIssue() || this.job.running) return;
      const info = this.leInfo();
      const covers = info && info.names.includes(this.fqdn()) && (!!info.staging === !!this.cfg.staging);
      const due = !covers || info.daysLeft < RENEW_DAYS;
      if (!due) return;
      if (!this.state.lastIssueAt && !covers && !info) return;      // never issued: only on request
      if (Date.now() < (this.state.nextTryAt || 0)) return;
      await this.issue({ reason: covers ? `renewal, ${info.daysLeft} days left` : 'name changed' });
    } catch (e) { this.log.warn(`[HTTPS] renew check: ${e.message}`); }
  }

  async dnsTick() {
    try { await this.syncARecord(false); }
    catch (e) { this.state.dnsError = e.message; this.saveState(); this.log.warn(`[HTTPS] DNS update: ${e.message}`); }
  }

  // ---------- status ----------
  url() {
    if (!this.listenPort) return null;
    const host = this.realCertOk() ? this.fqdn() : (this.ip() || os.hostname());
    return `https://${host}${this.listenPort === 443 ? '' : ':' + this.listenPort}`;
  }

  redirectActive() { return !!(this.cfg.redirect && this.cfg.browserVerified && this.realCertOk() && this.listenPort); }

  status() {
    const le = this.leInfo();
    return {
      success: true,
      config: { domain: this.cfg.domain, host: this.cfg.host, fqdn: this.fqdn(), email: this.cfg.email, agreed: !!this.cfg.agreed, staging: !!this.cfg.staging,
        redirect: !!this.cfg.redirect, ipOverride: this.cfg.ipOverride || '', tokenSet: this.tokenSet() },
      https: { listening: !!this.listenPort, port: this.listenPort, error: this.listenError, url: this.url(), certSource: this.source },
      letsencrypt: le ? { ...le, usable: this.realCertOk() } : null,
      dns: { ip: this.ip(), ips: lanIps(), recordIp: this.state.recordIp, recordFor: this.state.recordFor || null, lastSync: this.state.lastSync, error: this.state.dnsError },
      lastIssueAt: this.state.lastIssueAt, lastIssueError: this.state.lastIssueError, nextTryAt: this.state.nextTryAt || null,
      browserVerified: !!this.cfg.browserVerified, redirectActive: this.redirectActive(),
      job: this.job, secretsDir: this.dir,
    };
  }

  // ---------- express ----------
  routes() {
    const app = this.app;
    const bad = (res, e, code = 400) => res.status(code).json({ success: false, error: String((e && e.message) || e) });

    app.get('/api/https/status', (_req, res) => res.json(this.status()));
    app.get('/api/https/ping', (req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, fqdn: this.fqdn(), secure: !!req.secure || !!(req.socket && req.socket.encrypted) }); });

    app.post('/api/https/config', async (req, res) => {
      try {
        const b = req.body || {};
        const next = { ...this.cfg };
        if (b.domain !== undefined) { const d = String(b.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, ''); if (d && !DOMAIN_RE.test(d)) return bad(res, 'That domain doesn\'t look right (example: example.com)'); next.domain = d; }
        if (b.host !== undefined) { const h = String(b.host).trim().toLowerCase(); if (h && !HOST_RE.test(h)) return bad(res, 'Pi name: letters, numbers and dashes only (example: bench1)'); next.host = h; }
        if (b.email !== undefined) { const m = String(b.email).trim(); if (m && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) return bad(res, 'That email doesn\'t look right'); next.email = m; }
        if (b.ipOverride !== undefined) { const ip = String(b.ipOverride).trim(); if (ip && !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return bad(res, 'IP must look like 192.168.1.50'); next.ipOverride = ip; }
        for (const k of ['agreed', 'staging', 'redirect']) if (b[k] !== undefined) next[k] = !!b[k];
        if (next.domain !== this.cfg.domain || next.host !== this.cfg.host) { next.browserVerified = false; this.state.zoneId = null; this.state.recordIp = null; this.saveState(); }
        if (b.token !== undefined && String(b.token).trim()) {
          const tok = String(b.token).trim();
          if (!/^[A-Za-z0-9_-]{20,200}$/.test(tok)) return bad(res, 'That doesn\'t look like a Cloudflare API token');
          this.cfg = next;   // testToken needs the domain
          try { await this.testToken(tok); } catch (e) { return bad(res, `Token not saved: ${e.message}`); }
          writeSecret(this.f.token, tok + '\n');
          this.state.zoneId = null; this.saveState();
        }
        this.cfg = next; this.saveCfg();
        if (this.fqdn() && this.tokenSet()) this.syncARecord(true).catch(e => { this.state.dnsError = e.message; this.saveState(); });
        await this.reloadCert().catch(() => {});
        res.json(this.status());
      } catch (e) { bad(res, e, 500); }
    });

    app.post('/api/https/token/test', async (_req, res) => {
      try { const r = await this.testToken(); res.json({ success: true, ...r }); } catch (e) { bad(res, e); }
    });
    app.post('/api/https/token/clear', (_req, res) => {
      try { fs.rmSync(this.f.token, { force: true }); this.state.zoneId = null; this.saveState(); res.json(this.status()); } catch (e) { bad(res, e, 500); }
    });
    app.post('/api/https/dns-sync', async (_req, res) => {
      try { const r = await this.syncARecord(true); res.json({ success: true, ...r, status: this.status() }); }
      catch (e) { this.state.dnsError = e.message; this.saveState(); bad(res, e); }
    });
    app.post('/api/https/issue', (_req, res) => {
      const why = this.canIssue(); if (why) return bad(res, why);
      if (this.job.running) return bad(res, 'Already working on it', 409);
      this.issue({ reason: 'requested' }).catch(() => {});
      res.json(this.status());
    });
    // A browser opened https://<fqdn>/api/https/ping: safe to send http page loads there.
    app.post('/api/https/browser-ok', (req, res) => {
      const origin = String((req.body && req.body.origin) || '');
      let host = ''; try { host = new URL(origin).hostname; } catch (_) { /* */ }
      if (!this.realCertOk() || host !== this.fqdn()) return bad(res, 'Not verified: the browser did not reach the HTTPS name');
      this.cfg.browserVerified = true; this.saveCfg(); res.json(this.status());
    });

    app.get('/aether-https-shim.js', (_req, res) => {
      const hosts = [...new Set([...lanIps(), os.hostname(), `${os.hostname()}.local`, this.fqdn()].filter(Boolean).map(s => s.toLowerCase()))];
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(`/* Aether HTTPS shim (AETHER_HTTPS): on an HTTPS page, sends this Pi's http://<addr>:${this.httpPort} calls to the page's own HTTPS address. */\n(${SHIM_SOURCE.toString()})(${JSON.stringify({ hosts, port: this.httpPort })});\n`);
    });
  }

  /** Middleware for http page loads -> https://<fqdn> (registered before the built pages). */
  redirector() {
    return (req, res, next) => {
      try {
        if (req.method !== 'GET' || (req.socket && req.socket.encrypted) || !this.redirectActive()) return next();
        if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
        const ra = String(req.socket && req.socket.remoteAddress || '');
        if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return next();
        if (req.query && req.query.http === '1') { res.setHeader('Set-Cookie', 'aether_http=1; Path=/; Max-Age=31536000; SameSite=Lax'); return next(); }
        if (/(?:^|;\s*)aether_http=1/.test(String(req.headers.cookie || ''))) return next();
        const accept = String(req.headers.accept || '');
        if (!accept.includes('text/html')) return next();
        const target = `https://${this.fqdn()}${this.listenPort === 443 ? '' : ':' + this.listenPort}${req.originalUrl}`;
        return res.redirect(302, target);
      } catch (_) { return next(); }
    };
  }

  async start() {
    try { await this.startServer(); } catch (e) { this.log.warn(`[HTTPS] not started: ${e.message}`); }
    const t1 = setTimeout(() => this.dnsTick(), 20000);
    const t2 = setTimeout(() => this.renewTick(), 120000);
    const i1 = setInterval(() => this.dnsTick(), DNS_SYNC_MS);
    const i2 = setInterval(() => this.renewTick(), RENEW_CHECK_MS);
    const i3 = setInterval(() => { this.reloadCert().catch(() => {}); }, 6 * 3600 * 1000);   // switch to self-signed if the real one lapsed
    for (const t of [t1, t2, i1, i2, i3]) { if (t.unref) t.unref(); this.timers.push(t); }
  }
}

/** Wire into server.js: install({ app, io, server, port }) before the built-pages block. */
function install({ app, io, server, port, log }) {
  const m = new HttpsManager({ app, io, httpServer: server, port, log: log || console });
  m.routes();
  app.use(m.redirector());
  setImmediate(() => { m.start().catch(e => console.warn('[HTTPS] start failed:', e.message)); });
  return m;
}

module.exports = { install, HttpsManager, certInfo, certUsable, lanIps, SHIM_SOURCE };
