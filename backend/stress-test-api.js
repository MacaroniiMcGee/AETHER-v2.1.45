#!/usr/bin/env node
/**
 * Try to knock the IOplus HAT offline THROUGH THE BACKEND, the way real use does.
 *
 * Unlike stress-test-4hr.js (which runs `ioplus` directly and bypasses the
 * backend's I2C gate), this hits the backend's HTTP API from many clients at
 * once, with no pauses: relay writes, pulses, relay and input reads, full GPIO
 * scans and EOL/supervision reads. The backend has to squeeze all of that onto
 * the bus while keeping 100 ms between HAT calls.
 *
 *   node stress-test-api.js                  30 min, 12 clients
 *   node stress-test-api.js --minutes 120 --clients 24
 *   node stress-test-api.js --direct         also run a second program that
 *                                            uses ioplus through the shared lock
 *   node stress-test-api.js --no-relays      reads only (relays won't click)
 *   node stress-test-api.js --keep-going     don't stop when the HAT fails
 *
 * Every 10 s it prints: requests/s, HAT calls/s, failures, the SHORTEST idle
 * time the HAT got between two calls (must stay >= ~100 ms), and the longest
 * time a command waited for the bus.
 *
 * It stops when the HAT fails 3 times in a row (the lock-up signature), saves
 * a lock-up dump through the backend, and prints the calls leading up to it.
 * Ctrl+C stops it and prints the report. All relays are switched off at the end.
 * Report: backend/logs/stress-api-<time>.json (or /tmp if logs isn't writable).
 */
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const has = name => argv.includes(name);
const BASE = opt('--url', 'http://127.0.0.1:3001');
const MINUTES = Number(opt('--minutes', 30));
const CLIENTS = Number(opt('--clients', 12));
const DIRECT = has('--direct');
const RELAYS = !has('--no-relays');
const KEEP_GOING = has('--keep-going');
const LOCK = process.env.I2C_LOCK_FILE || '/tmp/aether-i2c.lock';
const IOPLUS = process.env.IOPLUS_BIN || 'ioplus';

if (typeof fetch !== 'function') { console.error('Needs Node 18+'); process.exit(1); }

// ---------- operations (weights add up to ~100) ----------
const rnd = n => Math.floor(Math.random() * n);
const post = (p, body) => ['POST', p, body];
const get = p => ['GET', p];
const OPS = [
  ...(RELAYS ? [
    ['relay write', 25, () => post('/api/gpio/write', { pin: rnd(8), value: rnd(2) })],
    ['relay pulse', 8, () => post('/api/gpio/pulse', { pin: rnd(8), duration: 150 })],
    ['batch pulse', 4, () => post('/api/gpio/batch-pulse', { pins: [rnd(8), rnd(8)], duration: 200 })],
  ] : []),
  ['relay read', 15, () => get(`/api/gpio/read/${rnd(8)}`)],
  ['input read', 20, () => get(`/api/gpio/input/${rnd(8)}`)],
  ['opto read', 10, () => get(`/api/gpio/opto/${rnd(8)}`)],
  ['gpio status', 10, () => get('/api/gpio/status')],
  ['EOL status', 8, () => get('/api/supervision/status')],
];
const TOTAL_W = OPS.reduce((a, o) => a + o[1], 0);
function pickOp() { let r = Math.random() * TOTAL_W; for (const o of OPS) { if ((r -= o[1]) < 0) return o; } return OPS[0]; }

// ---------- state ----------
const t0 = Date.now();
const endAt = t0 + MINUTES * 60000;
let running = true;
let stopReason = 'time up';
const byOp = {};
const req = { ok: 0, fail: 0, lastPrint: 0, msTotal: 0, msMax: 0 };
const hat = { calls: 0, fails: 0, minIdleMs: Infinity, maxWaitMs: 0, lastId: 0, prev: null, belowGap: 0, worstStreak: 0 };
const direct = { ok: 0, fail: 0 };
const intervals = [];
let lockupAt = null, lockupTail = null, dumpName = null;

const ts = () => new Date().toISOString().slice(11, 19);
const elapsed = () => { const s = Math.round((Date.now() - t0) / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };

async function call(method, p, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(BASE + p, {
      method, signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/json', 'x-aether-client': 'stress-test' } : { 'x-aether-client': 'stress-test' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { ok: r.ok && !(j && j.success === false), status: r.status, j, text };
  } catch (e) {
    return { ok: false, status: 0, text: e.name === 'AbortError' ? 'timeout (30 s)' : e.message };
  } finally { clearTimeout(timer); }
}

// ---------- load ----------
async function client() {
  while (running && Date.now() < endAt) {
    const [name, , make] = pickOp();
    const [method, p, body] = make();
    const s = Date.now();
    const r = await call(method, p, body);
    const ms = Date.now() - s;
    const o = byOp[name] || (byOp[name] = { ok: 0, fail: 0, msTotal: 0, msMax: 0, lastErr: null });
    if (r.ok) { o.ok++; req.ok++; } else { o.fail++; req.fail++; o.lastErr = `${r.status} ${(r.j && (r.j.error || r.j.message)) || r.text}`.slice(0, 120); }
    o.msTotal += ms; o.msMax = Math.max(o.msMax, ms);
    req.msTotal += ms; req.msMax = Math.max(req.msMax, ms);
    if (r.status === 0) await new Promise(res => setTimeout(res, 1000));   // backend down: don't spin
  }
}

// A second program sharing the HAT, going through the same lock (like any
// well-behaved script should): `flock <lock> sh -c 'ioplus 0 optrd; sleep 0.1'`
async function directClient() {
  while (running && Date.now() < endAt) {
    const ok = await new Promise(res => execFile('flock', ['-w', '15', LOCK, '/bin/sh', '-c', '"$0" "$@"; rc=$?; sleep 0.1; exit $rc', IOPLUS, '0', 'optrd'],
      { timeout: 25000 }, (err, stdout, stderr) => res(!err && !/fail|error/i.test(String(stderr)))));
    ok ? direct.ok++ : direct.fail++;
  }
}

// ---------- watch the bus through the backend's flight recorder ----------
async function sample(final = false) {
  const [d, rc] = await Promise.all([call('GET', '/api/i2c/diag'), call('GET', '/api/i2c/recent?n=1000')]);
  const bus = d.j && d.j.bus;
  const txs = (rc.j && rc.j.transactions) || [];
  let newCalls = 0, newFails = 0, minIdle = Infinity, maxWait = 0;
  for (const e of txs) {
    if (e.id <= hat.lastId) continue;
    newCalls++; if (!e.ok) newFails++;
    maxWait = Math.max(maxWait, e.waitMs || 0);
    // idle time the HAT got since the previous call finished
    if (hat.prev && e.id === hat.prev.id + 1) {
      const idle = e.t - (hat.prev.t + hat.prev.ms);
      minIdle = Math.min(minIdle, idle);
      if (idle < 95) hat.belowGap++;
    }
    hat.prev = e; hat.lastId = e.id;
  }
  hat.calls += newCalls; hat.fails += newFails;
  hat.minIdleMs = Math.min(hat.minIdleMs, minIdle);
  hat.maxWaitMs = Math.max(hat.maxWaitMs, maxWait);
  const streak = bus ? bus.consecutiveFailures : null;
  if (streak != null) hat.worstStreak = Math.max(hat.worstStreak, streak);

  const secs = Math.max(1, (Date.now() - (req.lastSampleAt || t0)) / 1000);
  const reqs = req.ok + req.fail;
  const rps = ((reqs - (req.lastReqs || 0)) / secs).toFixed(1);
  req.lastSampleAt = Date.now(); req.lastReqs = reqs;
  const row = {
    at: new Date().toISOString(), elapsed: elapsed(), requests: reqs, reqFails: req.fail, rps: Number(rps),
    hatCalls: newCalls, hatCallsPerSec: +(newCalls / secs).toFixed(1), hatFails: newFails,
    minIdleMs: Number.isFinite(minIdle) ? minIdle : null, maxWaitMs: maxWait,
    queued: bus ? bus.waiting : null, streak, healthy: bus ? bus.healthy : null,
    direct: DIRECT ? { ...direct } : undefined,
  };
  intervals.push(row);
  if (!final) {
    console.log(`${ts()} ${row.elapsed.padStart(7)} | req ${String(reqs).padStart(6)} (${rps}/s, ${req.fail} failed) | HAT ${String(row.hatCallsPerSec).padStart(4)}/s, ` +
      `${hat.fails} failed, min idle ${row.minIdleMs ?? '-'} ms, max wait ${maxWait} ms, queued ${row.queued ?? '?'}` +
      (DIRECT ? ` | 2nd program ${direct.ok} ok/${direct.fail} failed` : '') +
      (d.ok ? '' : '  !! backend not answering'));
  }

  if (!lockupAt && streak != null && streak >= 3) {
    lockupAt = new Date().toISOString();
    lockupTail = txs.slice(-15);
    console.log('\n' + '!'.repeat(78));
    console.log(`!! HAT FAILED ${streak} TIMES IN A ROW at ${lockupAt} after ${hat.calls} HAT calls (${elapsed()})`);
    console.log('!! Last calls before it:');
    for (const e of lockupTail) console.log(`!!   ${new Date(e.t).toISOString().slice(11, 23)} ${e.ok ? 'ok  ' : 'FAIL'} ${String(e.ms).padStart(5)}ms wait ${String(e.waitMs).padStart(5)}ms  ${e.source.padEnd(12)} ${e.cmd}${e.err ? '  ' + e.err : ''}`);
    const dump = await call('POST', '/api/i2c/dump');
    dumpName = dump.j && (dump.j.file || dump.j.name || dump.j.dump) || null;
    console.log(`!! Lock-up dump saved${dumpName ? ': ' + dumpName : ''} (see: aether-diag --lockups)`);
    console.log('!'.repeat(78) + '\n');
    if (!KEEP_GOING) { stopReason = 'HAT failed 3 times in a row'; running = false; }
  }
}

// ---------- report ----------
function report() {
  const reqs = req.ok + req.fail;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const knocked = !!lockupAt;
  const lines = [
    '', '='.repeat(78), 'AETHER API STRESS TEST - REPORT', '='.repeat(78),
    `Ran ${mins} min with ${CLIENTS} clients${DIRECT ? ' + a second program on the lock' : ''}${RELAYS ? '' : ' (reads only)'}. Stopped: ${stopReason}.`,
    '',
    `Requests to backend: ${reqs} (${(reqs / (mins * 60)).toFixed(1)}/s), ${req.fail} failed, avg ${reqs ? Math.round(req.msTotal / reqs) : 0} ms, worst ${req.msMax} ms`,
    `HAT calls:           ${hat.calls} (${(hat.calls / (mins * 60)).toFixed(1)}/s), ${hat.fails} failed, worst failure streak ${hat.worstStreak}`,
    `Shortest HAT idle:   ${Number.isFinite(hat.minIdleMs) ? hat.minIdleMs + ' ms' : 'n/a'} (should be >= ~100)${hat.belowGap ? `  <-- ${hat.belowGap} gaps under 95 ms!` : ''}`,
    `Longest bus wait:    ${hat.maxWaitMs} ms`,
    DIRECT ? `2nd program:         ${direct.ok} ok, ${direct.fail} failed` : null,
    '', 'By request type:',
    ...Object.entries(byOp).map(([n, o]) => `  ${n.padEnd(12)} ${String(o.ok + o.fail).padStart(6)}  failed ${String(o.fail).padStart(4)}  avg ${String(Math.round(o.msTotal / Math.max(1, o.ok + o.fail))).padStart(5)} ms  worst ${String(o.msMax).padStart(5)} ms${o.lastErr ? '  last error: ' + o.lastErr : ''}`),
    '',
    knocked ? `RESULT: KNOCKED OFFLINE at ${lockupAt} after ${hat.calls} HAT calls. Dump saved${dumpName ? ' (' + dumpName + ')' : ''}.`
      : hat.fails ? `RESULT: HAT stayed up, but ${hat.fails} calls failed. Check aether-diag.`
      : 'RESULT: HAT STAYED UP. No failed HAT calls.',
    '='.repeat(78),
  ].filter(l => l !== null);
  console.log(lines.join('\n'));
  let dir = path.join(__dirname, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch { dir = os.tmpdir(); }
  const file = path.join(dir, `stress-api-${new Date(t0).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify({ options: { BASE, MINUTES, CLIENTS, DIRECT, RELAYS }, stopReason, req, hat, direct, byOp, lockupAt, lockupTail, dumpName, intervals }, null, 2));
  console.log(`Saved: ${file}`);
}

// ---------- main ----------
(async () => {
  const h = await call('GET', '/api/health');
  if (!h.ok) { console.error(`Backend not answering at ${BASE} (${h.text}). Start it: sudo systemctl start aether-backend`); process.exit(1); }
  const d = await call('GET', '/api/i2c/diag');
  if (!d.j || !d.j.bus) { console.error('Backend has no /api/i2c/diag (update 7+ needed).'); process.exit(1); }
  if (!d.j.bus.healthy) console.warn(`!! The HAT is already failing (${d.j.bus.consecutiveFailures} in a row). Power cycle first for a clean test.`);
  hat.lastId = ((await call('GET', '/api/i2c/recent?n=1')).j?.transactions?.[0]?.id) || 0;

  console.log(`Stress test: ${CLIENTS} clients for ${MINUTES} min against ${BASE}${DIRECT ? ', plus a 2nd program on the lock' : ''}${RELAYS ? '' : ', reads only'}`);
  console.log(`Backend gap: ${d.j.bus.minGapMs ?? '?'} ms, lock: ${d.j.bus.crossProcessLock || 'none'}. Ctrl+C to stop early.`);
  if (RELAYS) console.log('Relays will switch rapidly.');
  console.log('');

  const stop = sig => { if (running) { console.log(`\n${sig}: stopping...`); stopReason = 'stopped by you'; running = false; } else process.exit(1); };
  process.on('SIGINT', () => stop('Ctrl+C')); process.on('SIGTERM', () => stop('SIGTERM'));

  const sampler = setInterval(() => { sample().catch(e => console.log('sample error', e.message)); }, 10000);
  const work = [...Array(CLIENTS)].map(() => client());
  if (DIRECT) work.push(directClient());
  const timeLimit = setInterval(() => { if (Date.now() >= endAt) running = false; }, 1000);
  await Promise.all(work);
  clearInterval(sampler); clearInterval(timeLimit);
  await sample(true).catch(() => {});

  if (RELAYS && !lockupAt) {
    process.stdout.write('Switching all relays off... ');
    for (let pin = 0; pin < 8; pin++) await call('POST', '/api/gpio/write', { pin, value: 0 });
    console.log('done');
  }
  report();
  process.exit(lockupAt ? 2 : 0);
})();
