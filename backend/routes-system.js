// backend/routes-system.js
//
// Config page support:
//   GET  /api/config/app                 I/O mapping, reader pool, credential library (stored on the Pi)
//   POST /api/config/app
//   GET  /api/config/backup              one JSON file with every Aether config file on this unit
//   POST /api/config/restore             write a backup back (keeps a copy of what it replaces)
//   GET  /api/system/info                Pi health and inventory (no I2C except a cached HAT query)
//   POST /api/system/restart             restart the backend (only when systemd will bring it back)
//   GET  /api/network/nm                 NetworkManager view of an interface
//   POST /api/network/apply              change IP/DHCP/hostname through the root helper, with rollback
//   GET  /api/network/pending            is a rollback armed?
//   POST /api/network/confirm            keep the new settings (cancels the rollback)

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 4000) => new Promise(resolve =>
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') })));

const readText = async (p) => { try { return (await fsp.readFile(p, 'utf8')).replace(/\0/g, '').trim(); } catch { return null; } };

const ROOT = __dirname;                                   // backend/
const DATA = path.join(ROOT, 'data');
const APP_CONFIG = path.join(DATA, 'app-config.json');
const NETCFG = '/usr/local/sbin/aether-netcfg';

// Files a backup contains (relative to backend/). Only these can be restored.
const BACKUP_GLOBS = [
  ['data', /^[\w.-]+\.json$/],
  ['data/doors', /^[\w.-]+\.json$/],
  ['data/sequences', /^[\w.-]+\.json$/],
  ['data/emulations', /^[\w.-]+\.json$/],
  ['emulator-configs', /^[\w.-]+\.json$/],
  ['config', /^[\w.-]+\.json$/],
  ['wiegand', /^wiegand-config\.json$/],
  ['osdp', /^(osdp-config|custom-formats)\.json$/],
];
const allowedRel = (rel) => {
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return false;
  const dir = path.posix.dirname(norm), base = path.posix.basename(norm);
  return BACKUP_GLOBS.some(([d, re]) => d === dir && re.test(base));
};

async function collectBackup() {
  const files = {};
  for (const [dir, re] of BACKUP_GLOBS) {
    let names = [];
    try { names = await fsp.readdir(path.join(ROOT, dir)); } catch { continue; }
    for (const n of names.filter(n => re.test(n)).sort()) {
      const rel = `${dir}/${n}`;
      try {
        const raw = await fsp.readFile(path.join(ROOT, rel), 'utf8');
        files[rel] = JSON.parse(raw);
      } catch { /* skip unreadable / non-JSON */ }
    }
  }
  return files;
}

// ── CPU usage (per core) from /proc/stat deltas ─────────────────────────────
let lastCpu = null;
async function cpuSample() {
  const txt = await readText('/proc/stat');
  if (!txt) return null;
  return txt.split('\n').filter(l => /^cpu\d*\s/.test(l)).map(l => {
    const [name, ...v] = l.trim().split(/\s+/); const n = v.map(Number);
    const idle = n[3] + (n[4] || 0); const total = n.reduce((a, b) => a + b, 0);
    return { name, idle, total };
  });
}
async function cpuUsage() {
  let a = lastCpu && Date.now() - lastCpu.at < 15000 ? lastCpu.s : null;
  if (!a) { a = await cpuSample(); await new Promise(r => setTimeout(r, 300)); }
  const b = await cpuSample();
  lastCpu = { at: Date.now(), s: b };
  if (!a || !b) return null;
  const pct = b.map((x, i) => { const dT = x.total - a[i].total, dI = x.idle - a[i].idle; return dT > 0 ? Math.round((1 - dI / dT) * 100) : 0; });
  return { total: pct[0], cores: pct.slice(1) };
}

// ── USB inventory from sysfs (no lsusb needed) ─────────────────────────────
async function usbDevices() {
  const base = '/sys/bus/usb/devices';
  let names = [];
  try { names = await fsp.readdir(base); } catch { return { hubs: [], devices: [], rootHubs: 0 }; }
  const out = [];
  for (const n of names) {
    if (n.includes(':')) continue;                      // interfaces
    const d = path.join(base, n);
    const vid = await readText(path.join(d, 'idVendor'));
    if (!vid) continue;
    out.push({
      port: n, vid, pid: await readText(path.join(d, 'idProduct')),
      product: await readText(path.join(d, 'product')), manufacturer: await readText(path.join(d, 'manufacturer')),
      cls: await readText(path.join(d, 'bDeviceClass')), speed: await readText(path.join(d, 'speed')),
      root: n.startsWith('usb'),
    });
  }
  const isHub = x => x.cls === '09';
  return {
    rootHubs: out.filter(x => x.root).length,
    hubs: out.filter(x => isHub(x) && !x.root),
    devices: out.filter(x => !isHub(x)),
  };
}

async function serialPorts() {
  const res = [];
  try {
    for (const n of await fsp.readdir('/dev/serial/by-id')) {
      let target = null; try { target = path.basename(await fsp.readlink(path.join('/dev/serial/by-id', n))); } catch { /* */ }
      res.push({ id: n, dev: target ? `/dev/${target}` : null });
    }
  } catch { /* none */ }
  try {
    for (const n of (await fsp.readdir('/dev')).filter(n => /^tty(ACM|USB|AMA)\d+$/.test(n)).sort())
      if (!res.some(r => r.dev === `/dev/${n}`)) res.push({ id: null, dev: `/dev/${n}` });
  } catch { /* */ }
  return res;
}

async function fanInfo() {
  try {
    for (const h of await fsp.readdir('/sys/class/hwmon')) {
      const rpm = await readText(`/sys/class/hwmon/${h}/fan1_input`);
      if (rpm != null) {
        const pwm = await readText(`/sys/class/hwmon/${h}/pwm1`);
        return { rpm: Number(rpm), pwmPct: pwm != null ? Math.round(Number(pwm) / 255 * 100) : null };
      }
    }
  } catch { /* */ }
  return null;
}

let hatCache = null;
async function hatInfo(i2cBus) {
  if (hatCache && Date.now() - hatCache.at < (hatCache.v?.firmware ? 10 * 60 * 1000 : 30 * 1000)) return hatCache.v;
  let v = null;
  try {
    const r = await i2cBus.run(['0', 'board'], { source: 'system-info', timeoutMs: 3000 });
    const txt = typeof r === 'string' ? r : (r && (r.out || r.stdout)) || '';
    const m = txt.match(/Hardware\s+([\d.]+),\s*Firmware\s+([\d.]+)(?:,\s*CPU temperature\s+(-?\d+)\s*C)?(?:,\s*voltage\s+([\d.]+)\s*V)?/i);
    v = m ? { hardware: m[1], firmware: m[2], tempC: m[3] ? Number(m[3]) : null, volts: m[4] ? Number(m[4]) : null, raw: txt.trim() } : { raw: txt.trim() };
  } catch (e) { v = { error: e.message }; }
  hatCache = { at: Date.now(), v };
  return v;
}

const pkgVersion = async (p) => { try { return JSON.parse(await fsp.readFile(p, 'utf8')).version || null; } catch { return null; } };

// ── Network traffic: /proc/net/dev sampled every 2 s, last 10 min kept ─────
const TRAFFIC_EVERY_MS = 2000, TRAFFIC_KEEP = 300;
const traffic = { last: null, samples: [] };   // samples: { t, ifaces: { name: { rx, tx } } } in bytes/s
async function readNetDev() {
  const txt = await readText('/proc/net/dev');
  const out = {};
  for (const line of (txt || '').split('\n').slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/); if (!m) continue;
    const name = m[1].trim(); if (name === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    out[name] = { rx: f[0], tx: f[8] };
  }
  return out;
}
async function sampleTraffic() {
  const now = Date.now(), cur = await readNetDev();
  if (traffic.last) {
    const dt = (now - traffic.last.t) / 1000, ifaces = {};
    for (const [n, c] of Object.entries(cur)) {
      const p = traffic.last.c[n]; if (!p || dt <= 0) continue;
      const d = (a, b) => (a >= b ? a - b : a);   // counter reset
      ifaces[n] = { rx: Math.round(d(c.rx, p.rx) / dt), tx: Math.round(d(c.tx, p.tx) / dt) };
    }
    traffic.samples.push({ t: now, ifaces });
    if (traffic.samples.length > TRAFFIC_KEEP) traffic.samples.shift();
  }
  traffic.last = { t: now, c: cur };
}
sampleTraffic().catch(() => {});
setInterval(() => sampleTraffic().catch(() => {}), TRAFFIC_EVERY_MS).unref();

// ── Network helper (root, via sudo) ────────────────────────────────────────
const netcfg = (args, timeout = 20000) => run('sudo', ['-n', NETCFG, ...args], timeout);

module.exports = function systemRoutes({ i2cBus }) {
  const router = express.Router();

  // ---------- App config on the Pi ----------
  router.get('/config/app', async (_req, res) => {
    try { res.json({ success: true, config: JSON.parse(await fsp.readFile(APP_CONFIG, 'utf8')) }); }
    catch { res.json({ success: true, config: null }); }
  });
  router.post('/config/app', async (req, res) => {
    try {
      await fsp.mkdir(DATA, { recursive: true });
      const tmp = APP_CONFIG + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({ ...req.body, savedAt: new Date().toISOString() }, null, 2));
      await fsp.rename(tmp, APP_CONFIG);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- Backup / restore ----------
  router.get('/config/backup', async (_req, res) => {
    try {
      const files = await collectBackup();
      res.json({ success: true, backup: { aetherBackup: 1, createdAt: new Date().toISOString(), host: os.hostname(), files } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.post('/config/restore', async (req, res) => {
    const b = req.body && (req.body.backup || req.body);
    if (!b || b.aetherBackup !== 1 || typeof b.files !== 'object') return res.status(400).json({ success: false, error: 'Not an Aether backup file' });
    const rels = Object.keys(b.files);
    const bad = rels.filter(r => !allowedRel(r));
    if (bad.length) return res.status(400).json({ success: false, error: `Backup contains files Aether won't write: ${bad.slice(0, 5).join(', ')}` });
    try {
      // keep what we're about to replace
      const dir = path.join(DATA, 'backups');
      await fsp.mkdir(dir, { recursive: true });
      const keep = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await fsp.writeFile(path.join(dir, keep), JSON.stringify({ aetherBackup: 1, createdAt: new Date().toISOString(), host: os.hostname(), files: await collectBackup() }));
      const written = [];
      for (const rel of rels) {
        const abs = path.join(ROOT, rel);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs + '.tmp', JSON.stringify(b.files[rel], null, 2));
        await fsp.rename(abs + '.tmp', abs);
        written.push(rel);
      }
      res.json({ success: true, written, previous: `data/backups/${keep}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- System info ----------
  router.get('/system/info', async (_req, res) => {
    try {
      const [cpu, meminfo, df, temp, fan, usb, serial, model, serialNo, osRel, svc, ps, snap, hat, backendVer, frontendVer] = await Promise.all([
        cpuUsage(),
        readText('/proc/meminfo'),
        run('df', ['-kP', '/']),
        readText('/sys/class/thermal/thermal_zone0/temp'),
        fanInfo(),
        usbDevices(),
        serialPorts(),
        readText('/proc/device-tree/model'),
        readText('/proc/device-tree/serial-number'),
        readText('/etc/os-release'),
        run('systemctl', ['is-active', 'aether-backend', 'aether-stream', 'aether-monitor.timer']),
        run('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']),
        i2cBus.systemSnapshot().catch(() => null),
        hatInfo(i2cBus),
        pkgVersion(path.join(ROOT, 'package.json')),
        pkgVersion(path.join(ROOT, '..', 'frontend', 'package.json')),
      ]);
      const mem = {};
      (meminfo || '').split('\n').forEach(l => { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mem[m[1]] = Number(m[2]) * 1024; });
      const dfl = df.out.trim().split('\n')[1]?.split(/\s+/) || [];
      const svcNames = ['aether-backend', 'aether-stream', 'aether-monitor.timer'];
      const svcState = svc.out.trim().split('\n');
      const nets = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
        (addrs || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, ip: a.address, mac: a.mac, cidr: a.cidr })));
      const b = i2cBus.stats();
      res.json({
        success: true,
        at: new Date().toISOString(),
        device: {
          model, serial: serialNo, hostname: os.hostname(),
          os: (osRel || '').match(/PRETTY_NAME="?([^"\n]+)/)?.[1] || null,
          kernel: os.release(), arch: os.arch(),
          uptimeS: Math.round(os.uptime()), bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
        },
        cpu: { ...cpu, count: os.cpus().length, mhz: os.cpus()[0]?.speed || null, load: os.loadavg().map(x => +x.toFixed(2)) },
        memory: { total: mem.MemTotal || os.totalmem(), available: mem.MemAvailable ?? os.freemem(), swapTotal: mem.SwapTotal || 0, swapFree: mem.SwapFree || 0 },
        disk: dfl.length >= 5 ? { total: Number(dfl[1]) * 1024, used: Number(dfl[2]) * 1024, free: Number(dfl[3]) * 1024, mount: dfl[5] } : null,
        thermal: { cpuC: temp ? Math.round(Number(temp) / 100) / 10 : null, fan, throttleFlags: snap?.throttleFlags || [], throttled: snap?.throttled || null },
        usb, serialPorts: serial,
        network: nets,
        services: svcNames.map((n, i) => ({ name: n, state: svcState[i] || 'unknown' })),
        processes: ps.out.trim().split('\n').slice(1, 7).map(l => { const [pid, comm, c, m] = l.trim().split(/\s+/); return { pid: Number(pid), name: comm, cpu: Number(c), mem: Number(m) }; }),
        backend: { pid: process.pid, node: process.version, uptimeS: Math.round(process.uptime()), rss: process.memoryUsage().rss, version: backendVer, frontendVersion: frontendVer, dir: path.resolve(ROOT, '..') },
        hat: { ...hat, i2cAddress: '0x28' },
        i2c: { healthy: b.healthy, consecutiveFailures: b.consecutiveFailures, minGapMs: b.minGapMs, lastMinute: b.lastMinute, lastFailAt: b.lastFailAt, crossProcessLock: !!b.crossProcessLock },
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.post('/system/restart', async (_req, res) => {
    const r = await run('systemctl', ['show', 'aether-backend', '-p', 'Restart', '--value']);
    const policy = r.out.trim();
    if (!process.env.INVOCATION_ID || !policy || policy === 'no') {
      return res.status(409).json({ success: false, error: 'The backend isn’t set to restart itself. Run: sudo systemctl restart aether-backend' });
    }
    res.json({ success: true });
    setTimeout(() => process.exit(1), 400);   // systemd brings it back
  });

  // ---------- Network traffic ----------
  router.get('/network/traffic', (req, res) => {
    const since = Number(req.query.since) || 0;
    const totals = traffic.last ? traffic.last.c : {};
    res.json({ success: true, intervalMs: TRAFFIC_EVERY_MS, ifaces: Object.keys(totals), totals,
      samples: traffic.samples.filter(s => s.t > since) });
  });

  // ---------- Network (NetworkManager) ----------
  router.get('/network/nm', async (req, res) => {
    const iface = String(req.query.iface || 'eth0');
    if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(iface)) return res.status(400).json({ success: false, error: 'bad interface' });
    const nm = await run('systemctl', ['is-active', 'NetworkManager']);
    if (nm.out.trim() !== 'active') return res.json({ success: true, manager: 'other', supported: false });
    const dev = await run('nmcli', ['-t', '-g', 'GENERAL.CONNECTION', 'device', 'show', iface]);
    const con = dev.out.trim();
    let cfg = { method: null, addresses: '', gateway: '', dns: '' };
    if (con) {
      const r = await run('nmcli', ['-t', '-g', 'ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns', 'connection', 'show', con]);
      const [method, addresses, gateway, dns] = r.out.split('\n');
      cfg = { method, addresses: (addresses || '').replace(/\\/g, ''), gateway: gateway || '', dns: (dns || '').replace(/,/g, ' ') };
    }
    const helper = await run('sudo', ['-n', NETCFG, 'check']);
    res.json({ success: true, manager: 'NetworkManager', supported: true, connection: con || null, helperInstalled: helper.ok, ...cfg });
  });

  router.post('/network/apply', async (req, res) => {
    const { iface = 'eth0', mode = 'dhcp', ip = '', prefix = '24', gateway = '', dns = '', hostname = '' } = req.body || {};
    const r = await netcfg(['apply', String(iface), String(mode), String(ip), String(prefix), String(gateway), String(dns).trim().replace(/\s+/g, ','), String(hostname)]);
    if (!r.ok) {
      const msg = (r.err || r.out).trim();
      const notInstalled = /a password is required|not allowed|command not found|No such file/i.test(msg);
      return res.status(notInstalled ? 501 : 400).json({ success: false, error: notInstalled ? 'The network helper isn’t installed on this Pi yet (it comes with the Aether update).' : msg });
    }
    let info = {}; try { info = JSON.parse(r.out.trim().split('\n').pop()); } catch { /* */ }
    res.json({ success: true, rollbackSeconds: 90, ...info });
  });

  router.get('/network/pending', async (_req, res) => {
    const r = await run('systemctl', ['is-active', 'aether-net-rollback.timer']);
    const pending = r.out.trim() === 'active';
    let info = null;
    try { info = JSON.parse(await fsp.readFile('/run/aether-net-rollback.json', 'utf8')); } catch { /* none */ }
    const secondsLeft = pending && info?.deadline ? Math.max(0, info.deadline - Math.floor(Date.now() / 1000)) : null;
    res.json({ success: true, pending, secondsLeft, iface: info?.iface || null });
  });

  router.post('/network/confirm', async (_req, res) => {
    const r = await netcfg(['confirm']);
    res.status(r.ok ? 200 : 500).json({ success: r.ok, error: r.ok ? undefined : (r.err || r.out).trim() });
  });

  return router;
};
