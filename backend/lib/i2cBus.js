// backend/lib/i2cBus.js
//
// One gate for every `ioplus` CLI call in the backend process.
//
// Why: the IOplus HAT is a microcontroller on I2C. Two transactions from
// separate `ioplus` processes can interleave on the bus, which is a known way
// to wedge the HAT until a power cycle. The GPIO queue already spaced its own
// commands, but other callers (supervision/EOL ADC reads, watchdog) ran the
// CLI directly and could overlap it. Everything now goes through here:
//
//   - strictly one ioplus process at a time, with a short settle gap after each
//   - a hard timeout per call (a hung call can't block the bus forever)
//   - a flight recorder: the last 1000 transactions (who, what, how long, result)
//   - per-source rates, error and slow-call counts
//   - when calls start failing in a row, a dump file is written with the
//     recorder contents plus a system snapshot (undervoltage/throttle flags,
//     CPU temp, load, memory, recent kernel I2C messages)
//
// Usage:  const bus = require('./lib/i2cBus');
//         const out = await bus.run(['0', 'relrd', '1'], { source: 'gpio-queue' });

const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IOPLUS_BIN = process.env.IOPLUS_BIN || 'ioplus';
// Minimum idle time on the bus after every call. Measured on the IOplus
// (hardware 04.00, firmware 01.36) on a Pi 5: back-to-back calls hung the HAT
// after 740 reads; with 100 ms between calls it ran 5,632 reads clean.
// Enforced inside the cross-process lock, so it holds across all processes.
const MIN_GAP_MS = Number(process.env.I2C_MIN_GAP_MS || 100);
const TIMEOUT_MS = Number(process.env.I2C_TIMEOUT_MS || 4000);
const SLOW_MS = 400;                                             // a normal call is ~10-60 ms
const RING_SIZE = 1000;
const DUMP_AFTER_FAILURES = 3;                                   // consecutive failures before a dump
// Dumps go to backend/logs/i2c; if that isn't writable (e.g. created by a root
// run and now the backend runs as a normal user) fall back to /tmp.
const DUMP_DIR = (() => {
  const want = process.env.I2C_DUMP_DIR || path.join(__dirname, '..', 'logs', 'i2c');
  try { fs.mkdirSync(want, { recursive: true }); fs.accessSync(want, fs.constants.W_OK); return want; }
  catch (_) {
    const alt = path.join(os.tmpdir(), 'aether-i2c-dumps');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (__) {}
    console.warn(`[I2C] ${want} not writable; lock-up dumps will go to ${alt}`);
    return alt;
  }
})();
const DUMP_KEEP = 30;

// Cross-process lock. The in-process chain below only orders calls made by
// this backend; a second backend, a script or someone running `ioplus` by hand
// could still collide with it. Every call is wrapped in `flock` on a shared
// lock file, so all processes that use this gate take turns.
const LOCK_FILE = process.env.I2C_LOCK_FILE || '/tmp/aether-i2c.lock';
const LOCK_WAIT_S = Number(process.env.I2C_LOCK_WAIT_S || 5);
let FLOCK = null;
try {
  for (const d of ['/usr/bin/flock', '/bin/flock']) { if (fs.existsSync(d)) { FLOCK = d; break; } }
  if (FLOCK) {
    // world-writable so root and non-root backends can share it
    const fd = fs.openSync(LOCK_FILE, 'a', 0o666); fs.closeSync(fd);
    try { fs.chmodSync(LOCK_FILE, 0o666); } catch (_) { /* owned by another user: fine */ }
  }
} catch (_) { /* lock file not creatable: in-process ordering still applies */ }

// Which HTTP request (or timer) caused a bus call. Set by the Express
// middleware and carried through the GPIO queue.
const als = new AsyncLocalStorage();
const currentOrigin = () => als.getStore() || null;
const withOrigin = (origin, fn) => als.run(origin, fn);
function middleware(req, _res, next) {
  const ref = req.get('referer') || '';
  const client = /\/stream\b/.test(ref) ? 'stream-view' : ref ? 'browser' : 'api';
  als.run({ route: `${req.method} ${req.path}`, client }, next);
}

const ring = [];              // flight recorder
let seq = 0;
let tail = Promise.resolve(); // serialization chain
let inFlight = 0;
let waiting = 0;
let maxWaiting = 0;
let consecutiveFailures = 0;
let lastDumpAt = 0;
let lastOkAt = 0;
let lastFailAt = 0;
const startedAt = Date.now();
const sources = new Map();    // source -> { calls, errors, slow, totalMs, lastAt, minute: [timestamps] }
const routes = new Map();     // "client METHOD /path" -> { calls, recent }

function src(name) {
  let s = sources.get(name);
  if (!s) { s = { calls: 0, errors: 0, timeouts: 0, slow: 0, totalMs: 0, maxMs: 0, lastAt: 0, lastError: null, recent: [] }; sources.set(name, s); }
  return s;
}

function record(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

// With flock: run ioplus and then sleep MIN_GAP_MS while still holding the
// lock, so the next call from ANY process waits out the gap too.
const GAP_S = (MIN_GAP_MS / 1000).toFixed(3);
const IN_LOCK = `"$0" "$@"; rc=$?; sleep ${GAP_S}; exit $rc`;

function execIoplus(args, timeoutMs) {
  const [bin, argv, limit] = FLOCK
    ? [FLOCK, ['-w', String(LOCK_WAIT_S), '-E', '75', LOCK_FILE, '/bin/sh', '-c', IN_LOCK, IOPLUS_BIN, ...args],
       timeoutMs + LOCK_WAIT_S * 1000 + MIN_GAP_MS]
    : [IOPLUS_BIN, args, timeoutMs];
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout: limit, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.timedOut = !!err.killed;
        err.stdout = stdout; err.stderr = stderr;
        if (FLOCK && err.code === 75) {
          err.message = `I2C lock busy for ${LOCK_WAIT_S}s (another process is holding the bus)`;
          err.stderr = err.message;
        }
        return reject(err);
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Run one ioplus command. Resolves with trimmed stdout; rejects on non-zero
 * exit, stderr output, or timeout. Calls never overlap.
 * @param {string[]} args  e.g. ['0', 'relrd', '1']
 * @param {{source?: string, timeoutMs?: number, allowStderr?: boolean}} opts
 */
function run(args, opts = {}) {
  const source = opts.source || 'unknown';
  const origin = opts.origin || currentOrigin();
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const queuedAt = Date.now();
  waiting++;
  maxWaiting = Math.max(maxWaiting, waiting);

  const job = tail.then(async () => {
    waiting--;
    inFlight++;
    const id = ++seq;
    const t0 = Date.now();
    const s = src(source);
    let ok = false, out = '', errMsg = null, timedOut = false;
    try {
      const r = await execIoplus(args.map(String), timeoutMs);
      out = r.stdout.trim();
      const errText = (r.stderr || '').trim();
      if (errText && !opts.allowStderr && !/warning/i.test(errText)) throw new Error(errText);
      ok = true;
      return out;
    } catch (e) {
      timedOut = !!e.timedOut;
      errMsg = timedOut ? `timeout after ${timeoutMs}ms` : String((e.stderr && e.stderr.trim()) || e.message || e).slice(0, 200);
      const err = new Error(errMsg);
      err.timedOut = timedOut;
      throw err;
    } finally {
      const ms = Math.max(0, Date.now() - t0 - (FLOCK ? MIN_GAP_MS : 0));
      inFlight--;
      s.calls++; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms); s.lastAt = t0;
      s.recent.push(t0); while (s.recent.length && s.recent[0] < t0 - 60000) s.recent.shift();
      if (ms > SLOW_MS) s.slow++;
      if (!ok) { s.errors++; if (timedOut) s.timeouts++; s.lastError = errMsg; }
      record({ id, t: t0, waitMs: t0 - queuedAt, ms, source, cmd: args.join(' '), ok, out: ok ? out.slice(0, 40) : undefined, err: errMsg || undefined,
        route: origin ? origin.route : 'timer', client: origin ? origin.client : 'internal' });
      if (origin) {
        const k = `${origin.client} ${origin.route}`;
        const r = routes.get(k) || { calls: 0, recent: [] };
        r.calls++; r.recent.push(t0); while (r.recent.length && r.recent[0] < t0 - 60000) r.recent.shift();
        routes.set(k, r);
      }
      if (ok) {
        consecutiveFailures = 0; lastOkAt = Date.now();
      } else {
        consecutiveFailures++; lastFailAt = Date.now();
        if (consecutiveFailures === DUMP_AFTER_FAILURES) writeDump('consecutive-failures').catch(() => {});
      }
      // Without flock the gap has to be enforced here (this process only)
      if (!FLOCK && MIN_GAP_MS > 0) await new Promise(r => setTimeout(r, MIN_GAP_MS));
    }
  });
  // keep the chain alive regardless of this job's outcome
  tail = job.catch(() => {});
  return job;
}

// ---------- system snapshot ----------

function sh(cmd, args, timeoutMs = 2000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// vcgencmd get_throttled bits
const THROTTLE_BITS = {
  0: 'under-voltage now', 1: 'ARM frequency capped now', 2: 'throttled now', 3: 'soft temp limit now',
  16: 'under-voltage has occurred', 17: 'frequency capping has occurred', 18: 'throttling has occurred', 19: 'soft temp limit has occurred',
};

async function systemSnapshot() {
  const [throttled, temp, volts, dmesg] = await Promise.all([
    sh('vcgencmd', ['get_throttled']),
    sh('vcgencmd', ['measure_temp']),
    sh('vcgencmd', ['measure_volts', 'core']),
    sh('dmesg', ['--ctime', '--level=err,warn']).then(o => o
      ? o.split('\n').filter(l => /i2c|bcm2835|under-?voltage|brcm|throttl/i.test(l)).slice(-20)
      : null),
  ]);
  let throttleFlags = null;
  if (throttled) {
    const v = parseInt((throttled.split('=')[1] || '0'), 16);
    throttleFlags = Object.entries(THROTTLE_BITS).filter(([b]) => v & (1 << Number(b))).map(([, n]) => n);
  }
  let cpuTempC = null;
  if (temp) cpuTempC = parseFloat(temp.replace(/[^0-9.]/g, ''));
  else {
    try { cpuTempC = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch (_) {}
  }
  return {
    at: new Date().toISOString(),
    host: os.hostname(),
    uptimeSec: Math.round(os.uptime()),
    load: os.loadavg().map(n => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    memFreeMB: Math.round(os.freemem() / 1048576),
    memTotalMB: Math.round(os.totalmem() / 1048576),
    cpuTempC,
    throttled, throttleFlags,
    coreVolts: volts,
    kernelI2cMessages: dmesg,
  };
}

// ---------- stats / dumps ----------

function stats() {
  const now = Date.now();
  const last60 = ring.filter(e => e.t > now - 60000);
  const bySource = {};
  for (const [name, s] of sources) {
    bySource[name] = {
      calls: s.calls, errors: s.errors, timeouts: s.timeouts, slow: s.slow,
      perMinute: s.recent.length,
      avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0, maxMs: s.maxMs,
      lastAt: s.lastAt || null, lastError: s.lastError,
    };
  }
  return {
    startedAt: new Date(startedAt).toISOString(),
    healthy: consecutiveFailures === 0,
    consecutiveFailures,
    lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
    lastFailAt: lastFailAt ? new Date(lastFailAt).toISOString() : null,
    inFlight, waiting, maxWaiting,
    minGapMs: MIN_GAP_MS, timeoutMs: TIMEOUT_MS,
    crossProcessLock: FLOCK ? LOCK_FILE : null,
    pid: process.pid,
    lastMinute: {
      calls: last60.length,
      errors: last60.filter(e => !e.ok).length,
      busyPct: Math.round(last60.reduce((a, e) => a + e.ms, 0) / 600) ,  // % of the minute the bus was in use
      maxWaitMs: last60.reduce((a, e) => Math.max(a, e.waitMs), 0),
    },
    bySource,
    byRoute: Object.fromEntries([...routes.entries()]
      .map(([k, r]) => [k, { calls: r.calls, perMinute: r.recent.filter(t => t > now - 60000).length }])
      .sort((a, b) => b[1].perMinute - a[1].perMinute)),
  };
}

function recent(n = 100) {
  return ring.slice(-n);
}

async function writeDump(reason) {
  const now = Date.now();
  if (now - lastDumpAt < 60000) return null;   // at most one dump a minute
  lastDumpAt = now;
  const snap = await systemSnapshot();
  const data = { reason, writtenAt: new Date(now).toISOString(), stats: stats(), system: snap, transactions: ring.slice() };
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const file = path.join(DUMP_DIR, `lockup-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    // keep the newest DUMP_KEEP dumps
    const old = fs.readdirSync(DUMP_DIR).filter(f => f.startsWith('lockup-')).sort().reverse().slice(DUMP_KEEP);
    for (const f of old) fs.unlink(path.join(DUMP_DIR, f), () => {});
    console.error(`[I2C] ${reason}: flight recorder saved to ${file}`);
    if (snap.throttleFlags && snap.throttleFlags.length) console.error(`[I2C] Pi power/thermal flags: ${snap.throttleFlags.join(', ')}`);
    return file;
  } catch (e) {
    console.error('[I2C] could not write dump:', e.message);
    return null;
  }
}

function listDumps() {
  try {
    return fs.readdirSync(DUMP_DIR).filter(f => f.startsWith('lockup-')).sort().reverse()
      .map(f => ({ file: f, bytes: fs.statSync(path.join(DUMP_DIR, f)).size }));
  } catch (_) { return []; }
}

function readDump(name) {
  if (!/^lockup-[0-9TZ-]+\.json$/.test(name)) throw new Error('bad dump name');
  return JSON.parse(fs.readFileSync(path.join(DUMP_DIR, name), 'utf8'));
}

module.exports = { run, stats, recent, systemSnapshot, writeDump, listDumps, readDump, DUMP_DIR, middleware, currentOrigin, withOrigin };
