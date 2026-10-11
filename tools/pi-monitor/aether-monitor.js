#!/usr/bin/env node
/*
 * Aether Pi monitor — runs outside the backend so it keeps recording when the
 * backend or the IOplus HAT is stuck.
 *
 *   aether-monitor sample          append one sample (run every 30 s by systemd)
 *   aether-diag [hours]            report for the last N hours (default 24)
 *   aether-diag --lockups          list saved I2C lock-up dumps with a summary each
 *
 * Samples: /var/log/aether-monitor/YYYY-MM-DD.jsonl (kept 14 days)
 * Each sample: Pi power/thermal flags, temp, load, memory, top CPU processes,
 * whether the VMS stream capture is running, the backend's I2C bus stats, and
 * any new kernel I2C / under-voltage messages.
 *
 * It never touches the I2C bus itself.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const LOG_DIR = process.env.AETHER_MONITOR_DIR || '/var/log/aether-monitor';
const BACKEND = process.env.AETHER_BACKEND || 'http://127.0.0.1:3001';
const DUMP_DIR = process.env.AETHER_I2C_DUMPS || '';           // set by install.sh
const KEEP_DAYS = 14;
const STATE_FILE = path.join(LOG_DIR, '.state.json');

const THROTTLE_BITS = {
  0: 'under-voltage', 1: 'freq-capped', 2: 'throttled', 3: 'soft-temp-limit',
  16: 'under-voltage-occurred', 17: 'freq-capped-occurred', 18: 'throttled-occurred', 19: 'soft-temp-limit-occurred',
};

function sh(cmd, args, timeout = 3000) {
  try { return execFileSync(cmd, args, { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return null; }
}

function getJson(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (_) {} }

async function sample() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const state = readState();
  const t = new Date();

  // power / thermal
  const thr = sh('vcgencmd', ['get_throttled']);
  const thrVal = thr ? parseInt(thr.split('=')[1] || '0', 16) : null;
  const flags = thrVal == null ? null : Object.entries(THROTTLE_BITS).filter(([b]) => thrVal & (1 << Number(b))).map(([, n]) => n);
  let temp = null;
  try { temp = Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 100) / 10; } catch (_) {}

  // top processes
  const ps = sh('ps', ['-eo', 'pcpu,rss,comm', '--sort=-pcpu', '--no-headers']);
  const top = ps ? ps.split('\n').slice(0, 6).map(l => {
    const [cpu, rss, ...c] = l.trim().split(/\s+/);
    return { cmd: c.join(' '), cpu: Number(cpu), mb: Math.round(Number(rss) / 1024) };
  }) : null;

  // stream capture running? (Xvfb :99 only exists while a VMS is watching)
  const pg = sh('pgrep', ['-f', 'Xvfb :99']);
  const streaming = !!(pg && pg.length);

  // kernel messages since last sample
  const dmesg = sh('dmesg', ['--time-format', 'iso', '--level=err,warn']);
  let kernel = [];
  if (dmesg) {
    const lines = dmesg.split('\n').filter(l => /i2c|bcm2835|under-?voltage|brcm-?i2c|throttl|Voltage normalised/i.test(l));
    const lastSeen = state.lastKernelLine || '';
    const idx = lastSeen ? lines.lastIndexOf(lastSeen) : -1;
    kernel = (idx >= 0 ? lines.slice(idx + 1) : lines.slice(-10)).slice(-20);
    if (lines.length) state.lastKernelLine = lines[lines.length - 1];
  }

  // backend + bus
  const diag = await getJson(`${BACKEND}/api/i2c/diag`);
  const bus = diag && diag.bus ? {
    healthy: diag.bus.healthy,
    consecutiveFailures: diag.bus.consecutiveFailures,
    callsPerMin: diag.bus.lastMinute.calls,
    errorsPerMin: diag.bus.lastMinute.errors,
    busyPct: diag.bus.lastMinute.busyPct,
    maxWaitMs: diag.bus.lastMinute.maxWaitMs,
    topRoutes: Object.entries(diag.bus.byRoute || {}).slice(0, 5).map(([k, v]) => `${k} ${v.perMinute}/min`),
    queueHealthy: diag.queue ? diag.queue.boardHealthy : null,
  } : null;

  const rec = {
    t: t.toISOString(),
    uptimeSec: Math.round(os.uptime()),
    load1: Math.round(os.loadavg()[0] * 100) / 100,
    memFreeMB: Math.round(os.freemem() / 1048576),
    tempC: temp,
    throttled: thr ? thr.split('=')[1] : null,
    flags,
    streaming,
    backend: !!diag,
    bus,
    top,
    kernel: kernel.length ? kernel : undefined,
  };
  const file = path.join(LOG_DIR, `${t.toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  writeState(state);

  // prune
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && new Date(m[1]).getTime() < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
  }
}

// ---------------- report ----------------

function loadSamples(hours) {
  const since = Date.now() - hours * 3600000;
  const out = [];
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl')).sort(); } catch (_) {}
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (new Date(r.t).getTime() >= since) out.push(r); } catch (_) {}
    }
  }
  return out;
}

const fmtT = iso => new Date(iso).toLocaleString();
const pad = (s, n) => String(s).padEnd(n);

function summarizeDump(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tx = d.transactions || [];
  const firstFail = tx.find(x => !x.ok);
  const failAt = firstFail ? firstFail.t : Date.parse(d.writtenAt);
  const before = tx.filter(x => x.t >= failAt - 60000 && x.t < failAt);
  const byRoute = {};
  for (const x of before) { const k = `${x.client || '?'} ${x.route || x.source}`; byRoute[k] = (byRoute[k] || 0) + 1; }
  const overlapsWait = before.reduce((a, x) => Math.max(a, x.waitMs || 0), 0);
  return {
    file: path.basename(file), reason: d.reason, writtenAt: d.writtenAt,
    firstFailure: firstFail ? { at: new Date(firstFail.t).toISOString(), cmd: firstFail.cmd, source: firstFail.source, route: firstFail.route, err: firstFail.err } : null,
    callsInMinuteBefore: before.length,
    byRoute: Object.entries(byRoute).sort((a, b) => b[1] - a[1]),
    maxWaitMs: overlapsWait,
    system: d.system,
  };
}

function report(hours) {
  const s = loadSamples(hours);
  console.log(`\nAether Pi monitor — last ${hours} h (${s.length} samples, every 30 s)\n`);
  if (!s.length) { console.log('  No samples yet. Is the timer running?  systemctl status aether-monitor.timer\n'); }
  else {
    const uv = s.filter(r => r.flags && r.flags.includes('under-voltage'));
    const temps = s.map(r => r.tempC).filter(v => typeof v === 'number');
    const hot = temps.length ? `${Math.max(...temps)}°C` : 'n/a';
    const load = s.reduce((a, r) => Math.max(a, r.load1 || 0), 0);
    const streamPct = Math.round(100 * s.filter(r => r.streaming).length / s.length);
    const noBackend = s.filter(r => !r.backend);
    const unhealthy = s.filter(r => r.bus && (!r.bus.healthy || r.bus.queueHealthy === false));
    const reboots = s.filter((r, i) => i > 0 && r.uptimeSec < s[i - 1].uptimeSec);

    console.log('  POWER / THERMAL');
    console.log(`    under-voltage right now in ${uv.length} of ${s.length} samples${uv.length ? `  <-- first ${fmtT(uv[0].t)}` : ''}`);
    const everUV = s.some(r => r.flags && r.flags.includes('under-voltage-occurred'));
    console.log(`    under-voltage since boot: ${everUV ? 'YES' : 'no'}`);
    console.log(`    max CPU temp ${hot}, max load ${load} (${os.cpus().length} cores)`);
    console.log('\n  STREAM');
    console.log(`    capture running in ${streamPct}% of samples`);
    console.log('\n  I2C / HAT');
    console.log(`    backend unreachable in ${noBackend.length} samples, bus/HAT unhealthy in ${unhealthy.length}`);
    const busy = s.filter(r => r.bus).map(r => r.bus.busyPct);
    if (busy.length) console.log(`    bus busy: avg ${Math.round(busy.reduce((a, b) => a + b, 0) / busy.length)}%, max ${Math.max(...busy)}%`);
    const cpm = s.filter(r => r.bus).map(r => r.bus.callsPerMin);
    if (cpm.length) console.log(`    I2C calls/min: avg ${Math.round(cpm.reduce((a, b) => a + b, 0) / cpm.length)}, max ${Math.max(...cpm)}`);
    if (reboots.length) console.log(`    Pi rebooted ${reboots.length}x (${reboots.map(r => fmtT(r.t)).join(', ')})`);

    if (unhealthy.length) {
      const first = unhealthy[0];
      const i = s.indexOf(first);
      const prev = s.slice(Math.max(0, i - 4), i + 1);
      console.log(`\n  FIRST UNHEALTHY SAMPLE ${fmtT(first.t)} — the 2 minutes leading up to it:`);
      console.log(`    ${pad('time', 22)}${pad('temp', 7)}${pad('load', 6)}${pad('stream', 8)}${pad('calls/min', 11)}${pad('busy%', 7)}flags`);
      for (const r of prev) {
        console.log(`    ${pad(new Date(r.t).toLocaleTimeString(), 22)}${pad(r.tempC ?? '-', 7)}${pad(r.load1, 6)}${pad(r.streaming ? 'yes' : 'no', 8)}${pad(r.bus ? r.bus.callsPerMin : '-', 11)}${pad(r.bus ? r.bus.busyPct : '-', 7)}${(r.flags || []).filter(f => !f.endsWith('occurred')).join(',')}`);
      }
      if (first.bus && first.bus.topRoutes) console.log(`    busiest routes: ${first.bus.topRoutes.join('; ')}`);
    }
    const kern = s.filter(r => r.kernel).flatMap(r => r.kernel);
    if (kern.length) {
      console.log(`\n  KERNEL I2C / POWER MESSAGES (${kern.length})`);
      for (const l of kern.slice(-10)) console.log(`    ${l}`);
    }
  }
  listLockups(3);
  console.log('');
}

function listLockups(limit) {
  if (!DUMP_DIR || !fs.existsSync(DUMP_DIR)) return;
  const files = fs.readdirSync(DUMP_DIR).filter(f => f.startsWith('lockup-')).sort().reverse().slice(0, limit);
  if (!files.length) { console.log('\n  No I2C lock-up dumps saved.'); return; }
  console.log(`\n  I2C LOCK-UP DUMPS (newest ${files.length})`);
  for (const f of files) {
    try {
      const d = summarizeDump(path.join(DUMP_DIR, f));
      console.log(`\n    ${d.file}  (${d.reason})`);
      if (d.firstFailure) console.log(`      first failure ${fmtT(d.firstFailure.at)}: "${d.firstFailure.cmd}" from ${d.firstFailure.source} via ${d.firstFailure.route} -> ${d.firstFailure.err}`);
      console.log(`      I2C calls in the minute before: ${d.callsInMinuteBefore}, longest wait for the bus ${d.maxWaitMs} ms`);
      for (const [k, n] of d.byRoute.slice(0, 5)) console.log(`        ${String(n).padStart(4)}  ${k}`);
      const sys = d.system || {};
      console.log(`      Pi then: ${sys.cpuTempC ?? '?'}°C, load ${(sys.load || []).join('/')}, flags: ${(sys.throttleFlags || []).join(', ') || 'none'}`);
    } catch (e) { console.log(`    ${f}: unreadable (${e.message})`); }
  }
}

const [, , mode, arg] = process.argv;
const invokedAs = path.basename(process.argv[1] || '');
if (mode === 'sample') {
  sample().catch(e => { console.error(e.message); process.exit(1); });
} else if (mode === '--lockups' || arg === '--lockups') {
  listLockups(30); console.log('');
} else if (mode === 'report' || invokedAs === 'aether-diag' || !mode || /^\d+$/.test(mode)) {
  const h = Number(/^\d+$/.test(mode || '') ? mode : arg) || 24;
  report(h);
} else {
  console.log('usage: aether-monitor sample | aether-diag [hours] | aether-diag --lockups');
}
