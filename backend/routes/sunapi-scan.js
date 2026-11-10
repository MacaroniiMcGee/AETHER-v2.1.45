// backend/routes/sunapi-scan.js — find Hanwha / SUNAPI devices on the LAN.   AETHER_SUNAPI
//
// Three passes, all from the Pi:
//   1. ONVIF WS-Discovery (UDP multicast 239.255.255.250:3702) — model + name, no login.
//   2. HTTP sweep of the Pi's /24s (or ranges you give): an UNAUTHENTICATED request to
//      /stw-cgi/system.cgi. SUNAPI answers 401 with a digest realm such as iPolis_<MAC>, which
//      identifies the device without a login attempt (so it never counts toward lockout).
//   3. Optional identify: with one user/password, ONE deviceinfo call per SUNAPI host for
//      model / firmware / type. Exactly one try per device.
// Scans run as background jobs (poll GET /scan/:id).
'use strict';

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');

const MAX_HOSTS = 2048;
const isMac = m => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(m || '').replace(/-/g, ':'));
const normMac = m => (isMac(m) ? String(m).replace(/-/g, ':').toLowerCase() : undefined);
const HANWHA_OUI = /^(00:09:18|00:16:6c|e4:30:22|44:b4:23|00:1a:f4|00:00:f0|8c:71:f8)/i;
const HANWHA_MODEL = /^(NHP-|XHP-|SAC-|ACU-|X[NVPOFDBC][A-Z]?-|Q[NVOD][A-Z]?-|P[NVOD][A-Z]?-|T[NV][A-Z]?-|A[NO][A-Z]?-|L[NVO][A-Z]?-|HC[OVBD]-|[XQPA]RN-|SPE-|SAC-|SNP-|SNV-|SND-|SNO-|SNB-|SNF-|SRN-|KRN-|WRN-|XRN-)/i;

// ---------------------------------------------------------------- ranges
const ip2n = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const n2ip = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIp = s => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every(o => Number(o) <= 255);

function localNets() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      // Sweep the /24 the Pi sits in, even when the netmask is wider (a /16 is 65k hosts).
      const prefix = Math.max(24, maskBits(a.netmask));
      const base = (ip2n(a.address) & (prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0)) >>> 0;
      out.push({ iface: name, address: a.address, cidr: `${n2ip(base)}/${prefix}` });
    }
  }
  return out;
}
function maskBits(m) { return (m || '255.255.255.0').split('.').reduce((n, o) => n + (Number(o).toString(2).match(/1/g) || []).length, 0); }

/** "192.168.1.0/24, 10.0.0.5-10.0.0.40, 10.0.0.99" → host list (network/broadcast excluded for CIDRs). */
function parseRanges(text) {
  const hosts = new Set();
  for (const raw of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    let m;
    if ((m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(raw)) && isIp(m[1])) {
      const bits = Number(m[2]);
      if (bits < 21 || bits > 32) throw new Error(`${raw}: use /21 to /32 (at most ${MAX_HOSTS} addresses)`);
      const size = 2 ** (32 - bits);
      const base = (ip2n(m[1]) & (bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0)) >>> 0;
      for (let i = size > 2 ? 1 : 0; i < (size > 2 ? size - 1 : size); i++) hosts.add(n2ip(base + i));
    } else if ((m = /^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+|\d{1,3})$/.exec(raw)) && isIp(m[1])) {
      const a = ip2n(m[1]);
      const b = m[2].includes('.') ? ip2n(m[2]) : ((a & 0xffffff00) >>> 0) + Number(m[2]);
      if (!(m[2].includes('.') ? isIp(m[2]) : Number(m[2]) <= 255) || b < a) throw new Error(`${raw}: bad range`);
      if (b - a >= MAX_HOSTS) throw new Error(`${raw}: more than ${MAX_HOSTS} addresses`);
      for (let n = a; n <= b; n++) hosts.add(n2ip(n));
    } else if (isIp(raw)) hosts.add(raw);
    else throw new Error(`"${raw}" is not an IP, range or CIDR`);
    if (hosts.size > MAX_HOSTS) throw new Error(`More than ${MAX_HOSTS} addresses — narrow the range`);
  }
  return [...hosts];
}

// ---------------------------------------------------------------- WS-Discovery
function probeXml(types) {
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe>${types ? `<d:Types>${types}</d:Types>` : ''}</d:Probe></e:Body></e:Envelope>`;
}

/** ONVIF profiles say what a device is: A/C/D only exist on access control, S/T on video. */
function onvifKind(scopes, types) {
  const hay = `${scopes.join(' ')} ${types}`;
  if (/\/Profile\/[ACD]\b|\/type\/(access|door|accesscontrol)|AccessControl|DoorControl|tac:|tdc:/i.test(hay)) return 'access';
  if (/\/type\/(recorder|nvr|storage)\b/i.test(hay)) return 'recorder';
  if (/video_encoder|NetworkVideoTransmitter|\/Profile\/[ST]\b|\/type\/(ptz|video|camera)/i.test(hay)) return 'camera';
  return null;
}

function parseProbeMatch(xml, from) {
  const tag = name => { const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml); return m ? m[1].trim() : ''; };
  const scopes = tag('Scopes').split(/\s+/).filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  const scope = k => { const s = scopes.find(x => x.toLowerCase().startsWith(`onvif://www.onvif.org/${k.toLowerCase()}/`)); return s ? s.split('/').slice(4).join('/') : ''; };
  const xaddrs = tag('XAddrs').split(/\s+/).filter(Boolean);
  let ip = from;
  for (const x of xaddrs) { const m = /^https?:\/\/(\d+\.\d+\.\d+\.\d+)/.exec(x); if (m) { ip = m[1]; break; } }
  const mac = (scope('MAC') || '').replace(/-/g, ':').toLowerCase();
  const types = tag('Types');
  return { ip, onvif: true, onvifXAddr: xaddrs.find(x => x.includes(ip)) || xaddrs[0] || '', model: scope('hardware'), name: scope('name'), mac: /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : '', onvifTypes: types, scopes, kindHint: onvifKind(scopes, types) };
}

function wsDiscovery(ms, shouldStop) {
  return new Promise(resolve => {
    const found = new Map();
    const sockets = [];
    const timers = [];
    const addrs = localNets().map(n => n.address);
    if (!addrs.length) addrs.push('0.0.0.0');
    for (const addr of addrs) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => { try { s.close(); } catch { /* */ } });
        s.on('message', (buf, rinfo) => {
          const xml = buf.toString('utf8');
          if (!/ProbeMatch/i.test(xml)) return;
          const r = parseProbeMatch(xml, rinfo.address);
          const prev = found.get(r.ip);
          found.set(r.ip, prev ? { ...prev, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v)) } : r);
        });
        s.bind(0, addr === '0.0.0.0' ? undefined : addr, () => {
          try { s.setMulticastTTL(2); if (addr !== '0.0.0.0') s.setMulticastInterface(addr); } catch { /* */ }
          // cameras answer NetworkVideoTransmitter; access control / IO devices only tds:Device or an untyped probe
          for (const types of ['dn:NetworkVideoTransmitter', 'tds:Device', '']) {
            const m = Buffer.from(probeXml(types));
            const send = () => { try { s.send(m, 3702, '239.255.255.250', () => {}); } catch { /* socket closed (scan stopped) */ } };
            send();
            timers.push(setTimeout(send, 400));   // UDP: say it twice
          }
        });
        sockets.push(s);
      } catch { /* */ }
    }
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - t0 >= ms || shouldStop()) {
        clearInterval(timer);
        for (const t of timers) clearTimeout(t);
        for (const s of sockets) { try { s.close(); } catch { /* */ } }
        resolve([...found.values()]);
      }
    }, 100);
  });
}

// ---------------------------------------------------------------- HTTP sweep
function probeHost(ip, port, tls, root, timeoutMs) {
  return new Promise(resolve => {
    const lib = tls ? https : http;
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(hard); resolve(v); } };
    const hard = setTimeout(() => { try { req.destroy(); } catch { /* */ } finish(null); }, timeoutMs * 2 + 500);   // streams never go idle
    const req = lib.request({ host: ip, port, method: 'GET', path: `/${root}/system.cgi?msubmenu=deviceinfo&action=view`, timeout: timeoutMs, rejectUnauthorized: false, headers: { Accept: 'application/json', 'User-Agent': 'Aether-SUNAPI-Scan' } }, res => {
      const chunks = []; let size = 0;
      const end = () => {
        const auth = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) if (res.rawHeaders[i].toLowerCase() === 'www-authenticate') auth.push(res.rawHeaders[i + 1]);
        finish({ ip, port, https: tls, status: res.statusCode, auth, server: String(res.headers.server || ''), location: String(res.headers.location || ''), body: Buffer.concat(chunks).toString('utf8') });
      };
      res.on('data', c => { chunks.push(c); size += c.length; if (size >= 16384) { res.destroy(); end(); } });
      res.on('end', end);
      res.on('close', end);
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
    req.end();
  });
}

/** Many recent Hanwha devices redirect HTTP to HTTPS (or another port): follow once, same host only. */
async function probeFollow(ip, port, tls, root, timeoutMs) {
  const p = await probeHost(ip, port, tls, root, timeoutMs);
  if (!p || ![301, 302, 303, 307, 308].includes(p.status) || !p.location) return p;
  let u; try { u = new URL(p.location, `${tls ? 'https' : 'http'}://${ip}:${port}/`); } catch { return p; }
  if (u.hostname !== ip) return p;
  const tls2 = u.protocol === 'https:';
  const port2 = Number(u.port) || (tls2 ? 443 : 80);
  if (port2 === port && tls2 === tls) return p;
  const p2 = await probeHost(ip, port2, tls2, root, timeoutMs);
  return p2 ? { ...p2, redirectedFrom: `${tls ? 'https' : 'http'}:${port}` } : p;
}

function classify(p) {
  const realm = (p.auth.map(a => /realm="([^"]*)"/i.exec(a)).find(Boolean) || [])[1] || '';
  let mac = '';
  const m = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.exec(realm);
  if (m) mac = m[0].replace(/-/g, ':').toLowerCase();
  let info = null;
  if (p.status === 200) {
    try { info = JSON.parse(p.body); } catch {
      const kv = {}; for (const l of p.body.split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
      if (Object.keys(kv).length) info = kv;
    }
  }
  const digest = p.auth.some(a => /^\s*digest/i.test(a));
  let sunapi = 'no';
  if (/ipolis|wisenet|hanwha|samsung/i.test(realm) || (info && (info.Model || info.FirmwareVersion))) sunapi = 'yes';
  else if (p.status === 401 && digest) sunapi = 'maybe';           // something answers this path with a login
  return { sunapi, realm, mac, info, server: p.server, status: p.status };
}

// ---------------------------------------------------------------- jobs
module.exports = function makeScanner({ sunapiCall, guessKind, loadDevices, friendlyError }) {
  const jobs = new Map();

  function view(job) {
    const known = loadDevices();
    const results = [...job.hosts.values()].map(h => {
      const dev = known.find(d => d.host === h.ip) || (isMac(h.mac) ? known.find(d => isMac(d.mac) && d.mac.toLowerCase() === h.mac) : undefined);
      return { ...h, existingId: dev ? dev.id : null, existingName: dev ? dev.name : null };
    }).sort((a, b) => ip2n(a.ip) - ip2n(b.ip));
    return { id: job.id, state: job.state, phase: job.phase, done: job.done, total: job.total, startedAt: job.startedAt, ms: (job.endedAt || Date.now()) - job.startedAt, error: job.error, ranges: job.ranges, results };
  }

  async function run(job, opt) {
    const merge = (ip, v) => {
      const prev = job.hosts.get(ip) || { ip };
      const next = { ...prev };
      for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== '' && x !== null) next[k] = x;
      job.hosts.set(ip, next);
    };
    try {
      // 1. WS-Discovery
      if (opt.onvif) {
        job.phase = 'ONVIF discovery';
        for (const r of await wsDiscovery(3500, () => job.cancel)) {
          merge(r.ip, { onvif: true, onvifXAddr: r.onvifXAddr, model: r.model, name: r.name, mac: r.mac, kindHint: r.kindHint });
        }
      }
      // 2. sweep
      if (opt.sweep && !job.cancel) {
        const ports = opt.ports.length ? opt.ports : [80, 443];
        const tasks = [];
        const seen = new Set();
        const add = (ip, port, tls) => { const k = `${ip}|${port}|${tls}`; if (!seen.has(k)) { seen.add(k); tasks.push({ ip, port, tls }); } };
        for (const ip of job.targets) for (const port of ports) add(ip, port, port === 443 || opt.httpsPorts.includes(port));
        // ONVIF finds: the ports above, plus the scheme/port their own ONVIF address uses
        for (const h of job.hosts.values()) {
          if (!job.targets.includes(h.ip)) for (const port of ports) add(h.ip, port, port === 443 || opt.httpsPorts.includes(port));
          try { const u = new URL(h.onvifXAddr || ''); const tls = u.protocol === 'https:'; add(h.ip, Number(u.port) || (tls ? 443 : 80), tls); } catch { /* no xaddr */ }
        }
        job.phase = 'Checking for SUNAPI'; job.total = tasks.length; job.done = 0;
        let i = 0;
        await Promise.all(Array.from({ length: 64 }, async () => {
          while (i < tasks.length && !job.cancel) {
            const t = tasks[i++];
            const p = await probeFollow(t.ip, t.port, t.tls, opt.root, opt.timeoutMs);
            job.done++;
            if (!p) continue;
            const c = classify(p);
            const prev = job.hosts.get(t.ip);
            const rank = { yes: 3, maybe: 2, no: 1 };
            // keep the best answer per address; every responder stays listed so nothing vanishes silently
            if (prev && rank[prev.sunapi] && rank[prev.sunapi] >= rank[c.sunapi] && !(prev.sunapi === c.sunapi && p.https && !prev.https)) continue;
            merge(t.ip, {
              sunapi: c.sunapi, port: p.port, https: p.https, realm: c.realm, server: c.server, mac: c.mac || undefined,
              model: c.info && c.info.Model, firmware: c.info && c.info.FirmwareVersion, deviceType: c.info && c.info.DeviceType,
              answer: `${p.https ? 'HTTPS' : 'HTTP'} ${p.port} → ${p.status}${c.realm ? ` · realm ${c.realm}` : ''}${c.server ? ` · ${c.server}` : ''}${p.redirectedFrom ? ` (redirected from ${p.redirectedFrom})` : ''}`,
            });
          }
        }));
      }
      // 3. identify with one login attempt each
      if (opt.identify && !job.cancel) {
        // Only addresses the sweep itself saw answering SUNAPI — never an address a (spoofable)
        // WS-Discovery reply merely named — and only over Digest, so the password never goes out in clear.
        const cands = [...job.hosts.values()].filter(h => (h.sunapi === 'yes' || h.sunapi === 'maybe') && h.port);
        job.phase = 'Identifying'; job.total = cands.length; job.done = 0;
        let i = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (i < cands.length && !job.cancel) {
            const h = cands[i++];
            const tmp = { id: `scan-${job.id}-${h.ip}`, host: h.ip, port: h.port || 80, https: !!h.https, user: opt.identify.user };
            try {
              const r = await sunapiCall(tmp, opt.identify.password, { uri: `/${opt.root}/system.cgi?msubmenu=deviceinfo&action=view`, accept: 'json', timeoutMs: 5000, maxBody: 65536, digestOnly: true, forget: true });
              if (r.status === 401 && /no digest/.test(r.auth)) merge(h.ip, { identify: 'no-digest' });
              else if (r.status === 401) merge(h.ip, { identify: 'wrong-login' });
              else if (r.status === 200) {
                let info; try { info = JSON.parse(r.body); } catch { info = {}; for (const l of r.body.split(/\r?\n/)) { const k = l.indexOf('='); if (k > 0) info[l.slice(0, k).trim()] = l.slice(k + 1).trim(); } }
                merge(h.ip, { identify: 'ok', sunapi: 'yes', model: info.Model, firmware: info.FirmwareVersion, deviceType: info.DeviceType, mac: normMac(info.ConnectedMACAddress), serial: info.SerialNumber, deviceName: info.DeviceName });
              } else merge(h.ip, { identify: `http-${r.status}` });
            } catch (e) { merge(h.ip, { identify: 'error', identifyError: friendlyError(e) }); }
            job.done++;
          }
        }));
      }
      // MACs the Pi learned while sweeping (same L2 segment only)
      try {
        for (const line of require('fs').readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1)) {
          const [ip, , flags, mac] = line.trim().split(/\s+/);
          const h = ip && job.hosts.get(ip);
          if (h && !h.mac && flags === '0x2' && isMac(mac) && mac !== '00:00:00:00:00:00') merge(ip, { mac: mac.toLowerCase() });
        }
      } catch { /* not Linux */ }
      for (const h of job.hosts.values()) {
        const vendorHanwha = h.sunapi === 'yes' || HANWHA_OUI.test(h.mac || '') || HANWHA_MODEL.test(h.model || '') || /ipolis|wisenet|hanwha/i.test(h.realm || '');
        merge(h.ip, { vendor: vendorHanwha ? 'Hanwha' : '', kind: guessKind({ DeviceType: h.deviceType, Model: h.model }, '') || h.kindHint || 'other' });
      }
      job.state = job.cancel ? 'cancelled' : 'done';
    } catch (e) {
      job.state = 'error'; job.error = e.message;
    }
    job.phase = ''; job.endedAt = Date.now();
  }

  function start(body) {
    const b = body || {};
    const nets = localNets();
    const rangesText = String(b.ranges || '').trim() || nets.map(n => n.cidr).join(', ');
    const targets = b.sweep === false ? [] : parseRanges(rangesText);
    const ports = String(b.ports || '80, 443').split(/[\s,]+/).map(Number).filter(p => p > 0 && p < 65536).slice(0, 4);
    const opt = {
      onvif: b.onvif !== false, sweep: b.sweep !== false, ports,
      httpsPorts: ports.filter(p => p === 443 || p === 8443),
      root: /^[a-z0-9_-]{1,40}$/i.test(b.cgiRoot || '') ? b.cgiRoot : 'stw-cgi',
      timeoutMs: Math.max(400, Math.min(Number(b.timeoutMs) || 1500, 5000)),
      identify: b.identify && b.identify.user && b.identify.password ? { user: String(b.identify.user).slice(0, 64), password: String(b.identify.password) } : null,
    };
    if (!opt.onvif && !opt.sweep) throw new Error('Turn on ONVIF discovery or the address sweep');
    for (const j of jobs.values()) if (j.state === 'running') throw new Error('A scan is already running');
    const job = { id: crypto.randomBytes(5).toString('hex'), state: 'running', phase: 'Starting', done: 0, total: 0, startedAt: Date.now(), hosts: new Map(), targets, ranges: rangesText, cancel: false };
    jobs.set(job.id, job);
    while (jobs.size > 5) jobs.delete(jobs.keys().next().value);
    run(job, opt);
    return view(job);
  }

  return {
    start,
    get: id => { const j = jobs.get(id); return j ? view(j) : null; },
    cancel: id => { const j = jobs.get(id); if (j) j.cancel = true; return !!j; },
    networks: () => localNets(),
  };
};

module.exports._internal = { parseRanges, parseProbeMatch, classify, onvifKind };
