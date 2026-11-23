// backend/traffic/TrafficManager.js — runs mitmproxy (mitmdump) for the Traffic Inspector.  AETHER_TRAFFIC
//
// Three ways in (any mix):
//   device ports  (mitmproxy "reverse") Pi:8443 → https://<device>:443. Point a program at the
//                 Pi instead of the device; redirects to the device's address are rewritten.
//   proxy         clients set the Pi as their proxy (Pi:8080). HTTPS readable when the client
//                 trusts the Pi's capture certificate (CA).
//   gateway       (TRAFFIC-2, mitmproxy "transparent" + "dns") a device's gateway is set to
//                 the Pi; everything it sends out goes through mitmproxy: HTTP, raw TCP, its
//                 DNS, and where HTTPS goes (passed through untouched unless decrypting is on).
//                 Needs the root helper (backend/traffic/setup-root.sh, once).
// Plus a packet capture (tcpdump through the same helper) for Wireshark.
//
// mitmdump loads traffic/aether_addon.py, which streams JSON lines over a Unix socket.
// Flows live in memory (newest 3000, ~96 MB); the raw session is also written to
// data/traffic/session.mitm for desktop mitmproxy.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { spawn, execFile } = require('child_process');

const BACKEND = path.join(__dirname, '..');
const DATA = path.join(BACKEND, 'data', 'traffic');
const CONFDIR = path.join(DATA, 'mitmproxy');            // mitmproxy keeps its CA here
const SETTINGS = path.join(DATA, 'settings.json');
const SESSION = path.join(DATA, 'session.mitm');
const PCAP = path.join(DATA, 'capture.pcap');            // written by tcpdump via the helper
const SOCK = path.join(DATA, 'feed.sock');
const PIDFILE = path.join(DATA, 'mitmdump.pid');
const ADDON = path.join(__dirname, 'aether_addon.py');
const HELPER = process.env.AETHER_TRAFFIC_HELPER || '/usr/local/sbin/aether-traffic-net';
const HELPER_VERSION = 2;                                // the helper in this update

const MAX_FLOWS = 3000;
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_MSGS = 400;                                    // kept per TCP/UDP/WebSocket flow (counters keep counting)
const RESERVED_PORTS = new Set([22, 53, 80, 443, 554, 1883, 3001, 5173, 8554, 8888, 8889, 9997]);
const DEFAULT_GW = { enabled: false, devices: [], decrypt: false, port: 8081, dnsPort: 8053 };
const DEFAULTS = { proxyEnabled: true, proxyPort: 8080, devices: [], onlyHosts: '', autoStopMin: 120, bodyMaxKB: 1024, gateway: DEFAULT_GW };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = ip => String(ip || '').replace(/^::ffff:/, '');
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const err = (message, status = 400) => Object.assign(new Error(message), { status });

function findBinary() {
  const cands = [process.env.AETHER_MITMDUMP, path.join(BACKEND, 'vendor', 'mitmproxy', 'bin', 'mitmdump')].filter(Boolean);
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* */ } }
  for (const dir of (process.env.PATH || '').split(':').concat(['/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin')])) {
    const c = path.join(dir, 'mitmdump');
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* */ }
  }
  return null;
}

function portFree(port, udp = false) {
  return new Promise(resolve => {
    if (udp) {
      const s = dgram.createSocket('udp4');
      s.once('error', () => resolve(false));
      return s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
    }
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '0.0.0.0', exclusive: true }, () => s.close(() => resolve(true)));
  });
}
function portOpen(port) {
  return new Promise(resolve => {
    const c = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { c.destroy(); resolve(ok); };
    c.once('connect', () => done(true)); c.once('error', () => done(false));
    c.setTimeout(800, () => done(false));
  });
}

/** Run the root helper (sudo -n unless the backend already is root). */
function helper(args, timeout = 20000) {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const [cmd, a] = root ? [HELPER, args] : ['sudo', ['-n', HELPER, ...args]];
  return new Promise((resolve, reject) => execFile(cmd, a, { timeout }, (e, out, errOut) => {
    if (!e) return resolve(String(out).trim());
    const last = String(errOut || '').trim().split('\n').filter(Boolean).pop() || e.message;
    reject(err(last.replace(/^error: /, ''), 500));
  }));
}

/** Validate settings coming from the page. Throws with a message the page can show. */
function checkSettings(s) {
  const out = { ...DEFAULTS };
  const seen = new Set();
  const port = (v, what, unique = true) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw err(`${what}: use a port from 1024 to 65535`);
    if (RESERVED_PORTS.has(n)) throw err(`${what}: port ${n} is used by Aether or the Pi`);
    if (unique) { if (seen.has(n)) throw err(`Port ${n} is used twice`); seen.add(n); }
    return n;
  };
  out.proxyEnabled = s.proxyEnabled !== false;
  out.proxyPort = port(s.proxyPort ?? DEFAULTS.proxyPort, 'Proxy port', out.proxyEnabled);
  out.devices = (Array.isArray(s.devices) ? s.devices : []).slice(0, 16).map((d, i) => {
    const listenPort = port(d.listenPort, `Device ${i + 1}`);
    let u;
    try { u = new URL(/^[a-z]+:\/\//i.test(String(d.target || '')) ? String(d.target) : `https://${d.target}`); } catch { throw err(`Device ${i + 1}: "${d.target}" is not an address`); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) throw err(`Device ${i + 1}: use http://host:port or https://host:port`);
    return { listenPort, target: `${u.protocol}//${u.host}`, name: String(d.name || '').slice(0, 60).trim() };
  });
  const g = { ...DEFAULT_GW, ...(s.gateway || {}) };
  const ips = (Array.isArray(g.devices) ? g.devices : String(g.devices || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
  for (const ip of ips) if (!IPV4.test(ip)) throw err(`Gateway: "${ip}" is not an IPv4 address`);
  out.gateway = {
    enabled: !!g.enabled, devices: [...new Set(ips)].slice(0, 32), decrypt: !!g.decrypt,
    port: port(g.port, 'Gateway port', !!g.enabled), dnsPort: port(g.dnsPort, 'Gateway DNS port', !!g.enabled),
  };
  if (out.gateway.enabled && !out.gateway.devices.length) throw err('Gateway: add the IP address of at least one device');
  if (!out.proxyEnabled && !out.devices.length && !out.gateway.enabled) throw err('Turn on the proxy, add a device port or use gateway mode');
  out.onlyHosts = String(s.onlyHosts || '').slice(0, 2000).trim();
  if (out.onlyHosts) hostsRegex(out.onlyHosts);
  const m = Number(s.autoStopMin ?? DEFAULTS.autoStopMin);
  out.autoStopMin = Number.isFinite(m) ? Math.max(0, Math.min(24 * 60, Math.round(m))) : DEFAULTS.autoStopMin;
  const b = Number(s.bodyMaxKB ?? DEFAULTS.bodyMaxKB);
  out.bodyMaxKB = Number.isFinite(b) ? Math.max(16, Math.min(8192, Math.round(b))) : DEFAULTS.bodyMaxKB;
  return out;
}

/** "10.0.0.5, cam.local, 10.0.1.*" → mitmproxy allow_hosts regex. */
function hostsRegex(list) {
  const parts = list.split(/[\s,;]+/).filter(Boolean).map(h => {
    if (!/^[a-z0-9.*:[\]-]+$/i.test(h)) throw err(`"${h}" is not a host name or IP (wildcards like 10.0.1.* are fine)`);
    return h.replace(/[.[\]]/g, m => '\\' + m).replace(/\*/g, '[^.:]*');
  });
  return `^(?:${parts.join('|')})(?::\\d+)?$`;
}

const SUNAPI_RE = /^\/([a-z0-9_-]{1,40})\/([a-z0-9_]+)\.cgi(?:\?(.*))?$/i;
function sunapiTag(p) {
  const m = SUNAPI_RE.exec(p || '');
  if (!m) return null;
  const q = new URLSearchParams(m[3] || '');
  const get = k => { for (const [a, b] of q) if (a.toLowerCase() === k) return b; return ''; };
  return { root: m[1], cgi: m[2], submenu: get('msubmenu'), action: get('action') };
}

function maskHeaders(h) {
  return (h || []).map(([k, v]) => {
    if (/^(proxy-)?authorization$/i.test(k) && /^basic\s+/i.test(v)) {
      let user = '';
      try { user = Buffer.from(v.replace(/^basic\s+/i, ''), 'base64').toString('utf8').split(':')[0]; } catch { /* */ }
      return [k, `Basic •••••• (user: ${user || '?'})`];
    }
    return [k, v];
  });
}
const header = (h, name) => { const f = (h || []).find(([k]) => k.toLowerCase() === name); return f ? f[1] : ''; };

/** DNS message (mitmproxy to_json) → short text for the list. */
function dnsInfo(f) {
  const q = (f.request && f.request.questions && f.request.questions[0]) || null;
  const ans = ((f.response && f.response.answers) || []).map(a => String(a.data ?? '')).filter(Boolean);
  const rcode = f.response ? (f.response.response_code ?? f.response.responseCode ?? '') : '';
  return { question: q ? `${q.type || ''} ${q.name || ''}`.trim() : '', answers: ans.slice(0, 8), rcode: String(rcode) };
}

class TrafficManager {
  constructor() {
    fs.mkdirSync(CONFDIR, { recursive: true });
    this.settings = { ...DEFAULTS };
    try { this.settings = checkSettings(JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch { /* defaults */ }
    this.state = 'stopped';          // stopped | starting | running | stopping | error
    this.error = null;
    this.child = null;
    this.startedAt = null;
    this.autoStopAt = null;
    this.running = null;             // settings in use by the running proxy
    this.gwOn = null;                // device IPs the helper is redirecting for us
    this.log = [];
    this.flows = new Map();
    this.order = [];
    this.bytes = 0;
    this.seq = 0;
    this.clearedAt = 0;
    this.version = null;
    this.binary = null;
    this.pcap = null;                // { mode, iface, devices, startedAt, limitMB, stopAt }
    this._helper = { at: 0, value: null };
    this._timer = null;
    this._pcapTimer = null;
    this._feed = null;
    this._killStale();
    // A backend that died while gateway mode was on would leave devices redirected to a dead
    // port: keep them online (forwarding only) until someone presses Release.
    this.helperStatus(true).then(h => { if (h && h.gateway) helper(['gw-pass', ...String(h.devices || '').split(/\s+/).filter(Boolean)]).catch(() => {}); }).catch(() => {});
    process.once('exit', () => { try { this.child && this.child.kill('SIGKILL'); } catch { /* */ } });
  }

  // ── mitmproxy + helper ──────────────────────────────────────────────────
  async probe() {
    const bin = findBinary();
    if (bin !== this.binary) { this.binary = bin; this.version = null; }
    if (bin && !this.version) {
      this.version = await new Promise(resolve => execFile(bin, ['--version'], { timeout: 20000 }, (e, out) => {
        const m = /Mitmproxy:\s*([\w.]+)/i.exec(String(out || ''));
        resolve(m ? m[1] : null);
      }));
    }
    return { installed: !!(bin && this.version), binary: bin, version: this.version };
  }

  async helperStatus(fresh = false) {
    if (!fresh && Date.now() - this._helper.at < 4000) return this._helper.value;
    let v;
    try {
      const j = JSON.parse(await helper(['status'], 8000));
      v = { installed: true, ...j, current: j.version >= HELPER_VERSION };
    } catch (e) {
      v = { installed: false, error: e.message };
    }
    this._helper = { at: Date.now(), value: v };
    return v;
  }
  async _needHelper(what) {
    const h = await this.helperStatus(true);
    const cmd = `sudo bash ${path.join(BACKEND, 'traffic', 'setup-root.sh')}`;
    if (!h.installed) throw err(`${what} needs the one-time root setup. In a terminal on the Pi run:  ${cmd}`, 412);
    if (!h.current) throw err(`The root helper is out of date. In a terminal on the Pi run again:  ${cmd}`, 412);
    return h;
  }

  // ── status ──────────────────────────────────────────────────────────────
  addresses() {
    const out = [];
    for (const [iface, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface, address: a.address });
    }
    return out;
  }
  interfaces() {
    try { return fs.readdirSync('/sys/class/net').filter(n => n !== 'lo').sort(); } catch { return Object.keys(os.networkInterfaces()).filter(n => n !== 'lo'); }
  }
  listeners(s = this.running || this.settings) {
    const l = [];
    if (s.proxyEnabled) l.push({ kind: 'proxy', port: s.proxyPort });
    for (const d of s.devices) l.push({ kind: 'device', port: d.listenPort, target: d.target, name: d.name });
    if (s.gateway && s.gateway.enabled) l.push({ kind: 'gateway', port: s.gateway.port, dnsPort: s.gateway.dnsPort, devices: s.gateway.devices, decrypt: s.gateway.decrypt });
    return l;
  }
  async status() {
    const inst = await this.probe();
    const h = await this.helperStatus();
    return {
      ...inst, state: this.state, error: this.error, settings: this.settings,
      running: this.running, listeners: this.state === 'running' ? this.listeners() : [],
      startedAt: this.startedAt, autoStopAt: this.autoStopAt, addresses: this.addresses(), interfaces: this.interfaces(),
      count: this.order.length, seq: this.seq, caReady: fs.existsSync(path.join(CONFDIR, 'mitmproxy-ca-cert.pem')),
      sessionBytes: (() => { try { return fs.statSync(SESSION).size; } catch { return 0; } })(),
      helper: h, setupCommand: `sudo bash ${path.join(BACKEND, 'traffic', 'setup-root.sh')}`,
      forwarding: h && h.forwarding && !h.gateway ? String(h.devices || '').split(/\s+/).filter(Boolean) : [],
      pcap: this.pcapStatus(h),
    };
  }

  saveSettings(s) {
    const c = checkSettings(s);
    this.settings = c;
    fs.writeFileSync(SETTINGS, JSON.stringify(c, null, 2));
    return c;
  }

  // ── start / stop ────────────────────────────────────────────────────────
  async start() {
    if (this.state === 'running' || this.state === 'starting') throw err('Already running', 409);
    const { binary, installed } = await this.probe();
    if (!installed) throw err('mitmproxy is not installed on this Pi — run the Traffic Inspector update again (it installs it)', 503);
    const s = this.settings;
    const gw = s.gateway.enabled ? s.gateway : null;
    if (gw) await this._needHelper('Gateway mode');
    for (const l of this.listeners(s)) {
      if (!(await portFree(l.port))) throw err(`Port ${l.port} is already in use on the Pi — pick another one`, 409);
      if (l.kind === 'gateway' && !(await portFree(l.dnsPort, true))) throw err(`UDP port ${l.dnsPort} is already in use on the Pi — pick another DNS port`, 409);
    }
    this.state = 'starting'; this.error = null; this.log = [];
    await this._openFeed();

    const args = ['--set', `confdir=${CONFDIR}`, '--set', 'ssl_insecure=true', '--set', 'flow_detail=0',
      '--set', 'termlog_verbosity=info', '--set', `save_stream_file=${SESSION}`, '-s', ADDON];
    if (s.proxyEnabled) args.push('--mode', `regular@${s.proxyPort}`);
    for (const d of s.devices) args.push('--mode', `reverse:${d.target}@${d.listenPort}`);
    if (gw) args.push('--mode', `transparent@${gw.port}`, '--mode', `dns@${gw.dnsPort}`);
    if (s.onlyHosts) args.push('--set', `allow_hosts=${hostsRegex(s.onlyHosts)}`);

    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AETHER_TRAFFIC_SOCK: SOCK, AETHER_TRAFFIC_BODY_MAX: String(s.bodyMaxKB * 1024), AETHER_TRAFFIC_GW_DECRYPT: gw && gw.decrypt ? '1' : '0', PYTHONUNBUFFERED: '1' },
    });
    this.child = child; this.running = s;
    try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch { /* */ }
    const onData = b => {
      for (const line of String(b).split(/\r?\n/)) if (line.trim()) { this.log.push(line); if (this.log.length > 300) this.log.shift(); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    let exited = false;
    child.on('exit', (code, sig) => {
      exited = true;
      if (this.child !== child) return;
      this.child = null; this._clearTimer(); this.autoStopAt = null;
      try { fs.unlinkSync(PIDFILE); } catch { /* */ }
      this._gatewayPass();                     // never leave devices redirected to a dead port
      for (const f of this.flows.values()) if ((f.kind === 'tcp' || f.kind === 'udp') && !f.closed) { f.closed = true; f.seq = ++this.seq; }
      if (this.state === 'stopping') { this.state = 'stopped'; return; }
      this.state = 'error';
      const tail = this.log.filter(l => /error|exception|address|denied|cannot|failed/i.test(l)).slice(-3).join(' · ');
      this.error = `mitmproxy stopped (${sig || `exit ${code}`})${tail ? ': ' + tail : ''}`;
    });

    const deadline = Date.now() + 30000;
    for (;;) {
      await sleep(300);
      if (exited) { this.state = 'error'; throw err(this.error || 'mitmproxy did not start', 500); }
      // (the transparent port is not connected to: mitmproxy would try to reach the connection's own address)
      const open = await Promise.all(this.listeners(s).map(l => (l.kind === 'gateway' ? portFree(l.port).then(f => !f) : portOpen(l.port))));
      if (open.every(Boolean)) break;
      if (Date.now() > deadline) {
        this.state = 'stopping'; child.kill('SIGKILL');
        this.state = 'error'; this.error = `mitmproxy did not open its ports in 30 s. ${this.log.slice(-2).join(' · ')}`;
        throw err(this.error, 500);
      }
    }
    if (gw) {
      try { await helper(['gw-on', String(gw.port), String(gw.dnsPort), ...gw.devices]); this.gwOn = gw.devices.slice(); this._helper.at = 0; }
      catch (e) { this.state = 'stopping'; child.kill('SIGTERM'); this.state = 'error'; this.error = `Gateway rules failed: ${e.message}`; throw err(this.error, 500); }
    }
    this.state = 'running'; this.startedAt = Date.now();
    if (s.autoStopMin > 0) {
      this.autoStopAt = Date.now() + s.autoStopMin * 60000;
      this._timer = setTimeout(() => { this.stop().then(() => { this.error = `Stopped by itself after ${s.autoStopMin} min`; }).catch(() => {}); }, s.autoStopMin * 60000);
      this._timer.unref();
    }
    return this.status();
  }

  /** Capture off for gateway devices, but keep forwarding so they stay online. */
  async _gatewayPass() {
    const ips = this.gwOn; if (!ips) return;
    this.gwOn = null;
    try { await helper(['gw-pass', ...ips]); } catch { try { await helper(['gw-off']); } catch { /* */ } }
    this._helper.at = 0;
  }
  async releaseGateway() {
    if (this.state === 'running' || this.state === 'starting') throw err('Stop the capture first', 409);
    await helper(['gw-off']); this._helper.at = 0;
    return this.status();
  }

  async stop() {
    const child = this.child;
    this._clearTimer(); this.autoStopAt = null;
    await this._gatewayPass();
    if (!child) { if (this.state !== 'error') this.state = 'stopped'; return this.status(); }
    this.state = 'stopping'; this.error = null;
    child.kill('SIGTERM');
    for (let i = 0; i < 30 && this.child === child; i++) await sleep(100);
    if (this.child === child) { child.kill('SIGKILL'); await sleep(200); }
    this.state = 'stopped';
    return this.status();
  }

  _clearTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  /** A mitmdump left behind by a backend crash would hold the ports — end it. */
  _killStale() {
    let pid;
    try { pid = Number(fs.readFileSync(PIDFILE, 'utf8')); } catch { return; }
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('mitmdump') && cmd.includes('aether_addon.py')) process.kill(pid, 'SIGKILL');
    } catch { /* gone */ }
    try { fs.unlinkSync(PIDFILE); } catch { /* */ }
  }

  // ── packet capture (tcpdump via the helper) ─────────────────────────────
  pcapStatus(h) {
    const size = (() => { try { return fs.statSync(PCAP).size; } catch { return 0; } })();
    const running = !!(h && h.pcap);
    if (!running && this.pcap && !this.pcap.endedAt) { this.pcap.endedAt = Date.now(); this._clearPcapTimer(); }
    return { running, tcpdump: !!(h && h.tcpdump), bytes: size, ...(this.pcap || {}) };
  }
  async pcapStart(o = {}) {
    const h = await this._needHelper('Packet capture');
    if (!h.tcpdump) throw err('tcpdump is missing — run the one-time root setup again', 412);
    const mode = o.mode === 'all' ? 'all' : 'devices';
    const iface = String(o.iface || '');
    if (!this.interfaces().includes(iface)) throw err(`No network interface "${iface}" on this Pi`);
    const ips = [...new Set((Array.isArray(o.devices) ? o.devices : String(o.devices || '').split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean))];
    if (mode === 'devices') {
      if (!ips.length || ips.length > 32) throw err('Give 1 to 32 device IP addresses');
      for (const ip of ips) if (!IPV4.test(ip)) throw err(`"${ip}" is not an IPv4 address`);
    }
    const limitMB = Math.max(10, Math.min(2000, Math.round(Number(o.limitMB) || 200)));
    const minutes = Math.max(1, Math.min(24 * 60, Math.round(Number(o.minutes) || 60)));
    await helper(['pcap-start', mode, iface, ...(mode === 'devices' ? ips : [])]);
    this._helper.at = 0;
    this.pcap = { mode, iface, devices: mode === 'devices' ? ips : [], startedAt: Date.now(), limitMB, stopAt: Date.now() + minutes * 60000, endedAt: null, endReason: null };
    this._clearPcapTimer();
    this._pcapTimer = setInterval(() => {
      let size = 0; try { size = fs.statSync(PCAP).size; } catch { /* */ }
      if (size >= limitMB * 1048576) this.pcapStop(`reached ${limitMB} MB`).catch(() => {});
      else if (Date.now() >= this.pcap.stopAt) this.pcapStop(`ran ${minutes} min`).catch(() => {});
    }, 2000);
    this._pcapTimer.unref();
    return this.status();
  }
  async pcapStop(reason = null) {
    this._clearPcapTimer();
    await helper(['pcap-stop']);
    this._helper.at = 0;
    if (this.pcap && !this.pcap.endedAt) { this.pcap.endedAt = Date.now(); this.pcap.endReason = reason; }
    return this.status();
  }
  _clearPcapTimer() { if (this._pcapTimer) { clearInterval(this._pcapTimer); this._pcapTimer = null; } }
  pcapFile() { try { return fs.statSync(PCAP).size > 24 ? PCAP : null; } catch { return null; } }

  // ── the feed from the addon ─────────────────────────────────────────────
  _openFeed() {
    if (this._feed) return Promise.resolve();
    try { fs.unlinkSync(SOCK); } catch { /* */ }
    return new Promise((resolve, reject) => {
      const srv = net.createServer(sock => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', d => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { this._ingest(JSON.parse(line)); } catch { /* bad line */ }
          }
        });
        sock.on('error', () => {});
      });
      srv.once('error', reject);
      srv.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch { /* */ } this._feed = srv; resolve(); });
      srv.unref();
    });
  }

  _size(f) {
    let n = 2000 + (f.request?.body?.length || 0) + (f.response?.body?.length || 0);
    for (const m of (f.messages || [])) n += (m.data?.length || 0) + 100;
    for (const m of (f.ws?.messages || [])) n += (m.data?.length || 0) + 100;
    return n;
  }
  _put(f, isNew) {
    const old = this.flows.get(f.id);
    if (old) this.bytes -= old._size; else if (isNew !== false) this.order.push(f.id);
    f.seq = ++this.seq;
    f._size = this._size(f);
    this.bytes += f._size;
    this.flows.set(f.id, f);
    while (this.order.length > MAX_FLOWS || (this.bytes > MAX_BYTES && this.order.length > 1)) {
      const id = this.order.shift(); const g = this.flows.get(id);
      if (g) { this.bytes -= g._size; this.flows.delete(id); }
    }
  }
  _addMsg(holder, m) {
    holder.messages = holder.messages || [];
    holder.messages.push(m);
    holder.count = (holder.count || 0) + 1;
    if (m.fromClient) holder.up = (holder.up || 0) + (m.bytes || 0); else holder.down = (holder.down || 0) + (m.bytes || 0);
    if (holder.messages.length > MAX_MSGS) { holder.messages.shift(); holder.dropped = (holder.dropped || 0) + 1; }
  }

  _ingest(r) {
    if (!r || typeof r.id !== 'string') return;
    if (r.ts && r.ts * 1000 < this.clearedAt) return;       // late update for a flow cleared from the list
    const kind = r.kind || 'http';
    const old = this.flows.get(r.id);
    if (old && old.ts < this.clearedAt) return;

    if (kind === 'http') {
      if (!r.request) return;
      this._put({
        ...(old || {}),
        id: r.id, kind, ts: Math.round(r.ts * 1000), client: clean(r.client), mode: r.mode || '', clientTls: !!r.clientTls,
        request: { ...r.request, headers: maskHeaders(r.request.headers) },
        response: r.response ? { ...r.response, headers: maskHeaders(r.response.headers) } : (old && old.response) || null,
        error: r.error || null, pending: !r.response && !r.error, sunapi: sunapiTag(r.request.path),
      });
    } else if (kind === 'ws') {
      if (!old) return;
      const f = { ...old, ws: { ...(old.ws || {}), messages: (old.ws && old.ws.messages || []).slice() } };
      if (r.phase === 'msg' && r.msg) this._addMsg(f.ws, r.msg);
      if (r.phase === 'end') { f.ws.closed = true; f.ws.closeCode = r.closeCode ?? null; }
      this._put(f);
    } else if (kind === 'tcp' || kind === 'udp') {
      const f = old ? { ...old, messages: (old.messages || []).slice() } : {
        id: r.id, kind, ts: Math.round((r.ts || Date.now() / 1000) * 1000), client: clean(r.client), mode: r.mode || '',
        server: r.server || ['', 0], sni: r.sni || null, messages: [], count: 0, up: 0, down: 0, closed: false, error: null,
      };
      if (r.phase === 'start') Object.assign(f, { client: clean(r.client) || f.client, server: r.server || f.server, sni: r.sni || f.sni, mode: r.mode || f.mode });
      if (r.phase === 'msg' && r.msg) this._addMsg(f, r.msg);
      if (r.phase === 'end') { f.closed = true; if (r.error) f.error = r.error; }
      this._put(f);
    } else if (kind === 'dns') {
      this._put({
        id: r.id, kind, ts: old ? old.ts : Math.round((r.ts || Date.now() / 1000) * 1000), client: clean(r.client), mode: r.mode || '',
        request: r.request || (old && old.request) || null, response: r.response || (old && old.response) || null,
        error: r.error || null, pending: !r.response && !r.error,
      });
    } else if (kind === 'tls') {
      this._put({
        id: r.id, kind, ts: Math.round(r.ts * 1000), client: clean(r.client), mode: r.mode || '', server: r.server || ['', 0],
        sni: r.sni || null, alpn: r.alpn || [], failed: r.phase === 'failed', error: r.phase === 'failed' ? (r.error || 'refused') : null,
      });
    }
  }

  // ── reading flows ───────────────────────────────────────────────────────
  summary(f) {
    const base = { id: f.id, seq: f.seq, ts: f.ts, client: f.client, mode: f.mode, kind: f.kind, error: f.error || null, pending: !!f.pending };
    if (f.kind === 'http' || !f.kind) {
      const rq = f.request, rs = f.response;
      return {
        ...base, kind: 'http',
        method: rq.method, scheme: rq.scheme, host: rq.host, port: rq.port, path: rq.path,
        status: rs ? rs.status : null, reqBytes: rq.bytes, resBytes: rs ? rs.bytes : null,
        ms: rs && rs.tsEnd && f.ts ? Math.round(rs.tsEnd * 1000 - f.ts) : null,
        contentType: rs ? header(rs.headers, 'content-type') : '', sunapi: f.sunapi,
        challenge: !!(rs && rs.status === 401 && header(rs.headers, 'www-authenticate')),   // first half of a Digest login
        ws: f.ws ? { count: f.ws.count || 0, up: f.ws.up || 0, down: f.ws.down || 0, closed: !!f.ws.closed } : null,
      };
    }
    const srv = f.server || ['', 0];
    const common = { method: f.kind.toUpperCase(), scheme: f.kind, host: srv[0], port: srv[1], path: '', status: null, reqBytes: 0, resBytes: null, ms: null, contentType: '', sunapi: null, challenge: false, ws: null };
    if (f.kind === 'tcp' || f.kind === 'udp') {
      return { ...base, ...common, reqBytes: f.up || 0, resBytes: f.down || 0, stream: { count: f.count || 0, up: f.up || 0, down: f.down || 0, closed: !!f.closed, sni: f.sni }, pending: !f.closed };
    }
    if (f.kind === 'dns') {
      const d = dnsInfo(f);
      return { ...base, ...common, host: d.question.split(' ').pop() || '', port: 53, dns: d };
    }
    return { ...base, ...common, tls: { sni: f.sni, alpn: f.alpn || [], failed: !!f.failed } };   // tls passthrough
  }
  list(since = 0) {
    const out = [];
    for (const id of this.order) { const f = this.flows.get(id); if (f && f.seq > since) out.push(this.summary(f)); }
    return { seq: this.seq, epoch: this.clearedAt, count: this.order.length, flows: out };
  }
  get(id) {
    const f = this.flows.get(id);
    if (!f) return null;
    const { _size, ...rest } = f;
    return { kind: 'http', ...rest };
  }
  clear() {
    this.flows.clear(); this.order = []; this.bytes = 0; this.clearedAt = Date.now();   // pages see the new epoch and reload
  }

  har(ids) {
    const pick = (ids && ids.length ? ids : this.order).map(id => this.flows.get(id)).filter(f => f && (f.kind || 'http') === 'http');
    const hdr = h => (h || []).map(([name, value]) => ({ name, value }));
    const content = m => (m && m.body != null ? (m.bodyEncoding === 'base64' ? { text: m.body, encoding: 'base64' } : { text: m.body }) : {});
    return {
      log: {
        version: '1.2', creator: { name: 'Aether Traffic Inspector', version: '2' },
        entries: pick.map(f => {
          const rq = f.request, rs = f.response;
          const url = `${rq.scheme}://${rq.host}${(rq.scheme === 'https' && rq.port === 443) || (rq.scheme === 'http' && rq.port === 80) ? '' : ':' + rq.port}${rq.path}`;
          const q = (() => { try { return [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); } catch { return []; } })();
          const total = rs && rs.tsEnd ? Math.max(0, Math.round(rs.tsEnd * 1000 - f.ts)) : -1;
          return {
            startedDateTime: new Date(f.ts).toISOString(), time: total,
            request: { method: rq.method, url, httpVersion: rq.httpVersion, headers: hdr(rq.headers), queryString: q, cookies: [], headersSize: -1, bodySize: rq.bytes,
              ...(rq.body != null && rq.bytes ? { postData: { mimeType: header(rq.headers, 'content-type'), ...content(rq) } } : {}) },
            response: rs
              ? { status: rs.status, statusText: rs.reason || '', httpVersion: rs.httpVersion, headers: hdr(rs.headers), cookies: [], content: { size: rs.bytes, mimeType: header(rs.headers, 'content-type'), ...content(rs) }, redirectURL: header(rs.headers, 'location'), headersSize: -1, bodySize: rs.bytes }
              : { status: 0, statusText: f.error || 'no response', httpVersion: '', headers: [], cookies: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1, _error: f.error },
            cache: {}, timings: { send: 0, wait: total, receive: 0 }, serverIPAddress: rq.host, _client: f.client,
            ...(f.ws ? { _webSocketMessages: (f.ws.messages || []).map(m => ({ type: m.fromClient ? 'send' : 'receive', time: m.ts, opcode: m.text ? 1 : 2, data: m.data })) } : {}),
          };
        }),
      },
    };
  }

  caFile(fmt) {
    // Only the *-cert files: mitmproxy-ca.pem / mitmproxy-ca.p12 hold the private key and are never served.
    const name = { pem: 'mitmproxy-ca-cert.pem', cer: 'mitmproxy-ca-cert.cer', p12: 'mitmproxy-ca-cert.p12' }[fmt];
    if (!name) return null;
    const p = path.join(CONFDIR, name);
    return fs.existsSync(p) ? p : null;
  }
  sessionFile() { return fs.existsSync(SESSION) ? SESSION : null; }
}

module.exports = TrafficManager;
module.exports._internal = { checkSettings, hostsRegex, sunapiTag, maskHeaders, dnsInfo, DATA };
