// analytics/journal.js — structured record of everything Aether does to (and sees
// from) the controller under test. Product Test compares this against the
// controller's own logs.
//
// One JSON object per line in backend/data/analytics/journal/YYYY-MM-DD.jsonl (UTC date):
//   { t, k, ch, v, src, m?, run? }
//   t   epoch ms (Pi clock)
//   k   kind: relay · gpio · opto · emu-in · emu-out · card · keypad · tamper · powerfail · marker
//   ch  channel key: relay:6 · gpio:17 · opto:0 · emu:2:in:3 · emu:2:out:0 · emu:2:rdr:0
//       · wiegand:<readerId> · osdp:<readerId> · run
//   v   value (1/0 for edges; card/keypad: 1)
//   src physical · emulated · wiegand · osdp · api · ui
//   m   extra detail (fc, cn, bits, keys, name, text …)
//   run id of the test run active when recorded
//
// Recording is always on; it is cheap (a few hundred bytes per action) and kept 14 days.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'analytics', 'journal');
const RUNS = path.join(__dirname, '..', 'data', 'analytics', 'runs.json');
const KEEP_DAYS = 14;

let buffer = [];
let flushTimer = null;
let currentRun = null;
let runs = [];
let stats = { recorded: 0, since: Date.now(), byKind: {} };
const listeners = new Set();

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

function loadRuns() {
  try { runs = JSON.parse(fs.readFileSync(RUNS, 'utf8')); } catch { runs = []; }
  const open = runs.find(r => !r.end);
  currentRun = open ? open.id : null;
}
function saveRuns() {
  try { fs.mkdirSync(path.dirname(RUNS), { recursive: true }); fs.writeFileSync(RUNS, JSON.stringify(runs.slice(-200), null, 1)); } catch { /* */ }
}

const dayFile = t => path.join(DIR, `${new Date(t).toISOString().slice(0, 10)}.jsonl`);

function flush() {
  flushTimer = null;
  if (!buffer.length) return;
  const batch = buffer; buffer = [];
  const byFile = new Map();
  for (const e of batch) {
    const f = dayFile(e.t);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(JSON.stringify(e));
  }
  try {
    ensureDir();
    for (const [f, lines] of byFile) fs.appendFileSync(f, lines.join('\n') + '\n');
  } catch (e) { console.warn('[Analytics] journal write failed:', e.message); }
}

function prune() {
  try {
    ensureDir();
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(DIR)) {
      const m = /^(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f);
      if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(DIR, f));
    }
  } catch { /* */ }
}

/** Record one entry. Never throws. */
function record(k, ch, v, src, m) {
  try {
    const e = { t: Date.now(), k, ch: String(ch), v: v === true ? 1 : v === false ? 0 : v, src: src || 'api' };
    if (m && Object.keys(m).length) e.m = m;
    if (currentRun) e.run = currentRun;
    buffer.push(e);
    stats.recorded++; stats.byKind[k] = (stats.byKind[k] || 0) + 1;
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
    for (const fn of listeners) { try { fn(e); } catch { /* */ } }
    return e;
  } catch { return null; }
}

function startRun(name, meta = {}) {
  if (currentRun) stopRun('superseded');
  const id = `run-${Date.now().toString(36)}`;
  runs.push({ id, name: String(name || 'Test run').slice(0, 120), start: Date.now(), end: null, meta });
  currentRun = id;
  saveRuns();
  record('marker', 'run', 1, 'ui', { event: 'run-start', name });
  return runs[runs.length - 1];
}

function stopRun(reason = 'stopped') {
  if (!currentRun) return null;
  record('marker', 'run', 0, 'ui', { event: 'run-stop', reason });
  const r = runs.find(x => x.id === currentRun);
  if (r) r.end = Date.now();
  currentRun = null;
  saveRuns();
  flush();
  return r;
}

/** Read entries in [from, to] (epoch ms), optionally only one run. */
function read({ from = 0, to = Date.now(), run = null } = {}) {
  flush();
  if (run) {
    const r = runs.find(x => x.id === run);
    if (r) { from = r.start - 1000; to = (r.end || Date.now()) + 1000; }
  }
  const out = [];
  try {
    ensureDir();
    for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.jsonl')).sort()) {
      const day = Date.parse(f.slice(0, 10));
      if (day + 86400000 < from || day > to) continue;
      for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.t >= from && e.t <= to && (!run || e.run === run || e.k === 'marker')) out.push(e);
        } catch { /* skip bad line */ }
      }
    }
  } catch { /* */ }
  return out.sort((a, b) => a.t - b.t);
}

/** Parse an uploaded journal (JSONL, or a JSON array/object with .entries). */
function parseUpload(text) {
  const s = String(text).trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const arr = Array.isArray(j) ? j : (j.entries || j.journal || []);
      return arr.filter(e => e && Number.isFinite(e.t) && e.k);
    } catch { /* fall back to JSONL */ }
  }
  return s.split(/\r?\n/).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && Number.isFinite(e.t) && e.k).sort((a, b) => a.t - b.t);
}

// ── hooks into the running backend ───────────────────────────────────────────
function wrap(obj, name, fn) {
  if (!obj || typeof obj[name] !== 'function' || obj[name].__journal) return false;
  const orig = obj[name];
  const w = function (...args) {
    const res = orig.apply(this, args);
    try {
      if (res && typeof res.then === 'function') {
        res.then(r => { try { fn(args, r, null); } catch { /* */ } }, err => { try { fn(args, null, err); } catch { /* */ } });
      } else fn(args, res, null);
    } catch { /* never break the caller */ }
    return res;
  };
  w.__journal = true;
  obj[name] = w;
  return true;
}

/**
 * Attach to the backend. Every getter is called lazily because some managers are
 * created after the HTTP server starts.
 * @param {{ gpioQueue?, gpioEvents?, getWiegand?: Function, getOsdp?: Function, emulator? }} d
 */
function attach(d = {}) {
  loadRuns();
  prune();
  setInterval(prune, 6 * 3600000).unref();

  // Physical relays (Pi → panel inputs) and opto inputs (panel outputs → Pi)
  const optoLast = new Map();
  const optoEdge = (ch, val) => {
    const v = val ? 1 : 0;
    if (optoLast.get(ch) === v) return;
    const first = !optoLast.has(ch);
    optoLast.set(ch, v);
    if (!first) record('opto', `opto:${ch}`, v, 'physical');
  };
  if (d.gpioQueue) {
    wrap(d.gpioQueue, 'enqueue', (args, res, err) => {
      if (err) return;
      const [op, a, b] = args;
      if (op === 'setRelay') record('relay', `relay:${a}`, b ? 1 : 0, 'physical');
      else if (op === 'readOptoInput' && res && typeof res === 'object') optoEdge(a, res.state);
      else if (op === 'readAllOpto' && Number.isInteger(res)) for (let i = 0; i < 8; i++) optoEdge(i, (res >> i) & 1);
    });
  }
  if (d.gpioEvents && typeof d.gpioEvents.on === 'function') {
    d.gpioEvents.on('gpio_change', ({ pin, value }) => record('gpio', `gpio:${pin}`, value ? 1 : 0, 'physical'));
  }

  // Emulated controller boards (OSDP device emulator)
  const emu = d.emulator;
  if (emu) {
    wrap(emu, 'setInput', (args, ok) => { if (ok !== false) record('emu-in', `emu:${args[0]}:in:${args[1]}`, args[2] ? 1 : 0, 'emulated'); });
    wrap(emu, 'queueCardRead', (args, ok) => {
      if (ok && ok.success === false) return;
      record('card', `emu:${args[0]}:rdr:${args[1]}`, 1, 'emulated', { format: args[2], fc: args[3], cn: args[4] });
    });
    wrap(emu, 'queueKeypadKeys', (args, ok) => {
      if (ok && ok.success === false) return;
      record('keypad', `emu:${args[0]}:rdr:${args[1]}`, 1, 'emulated', { count: Array.isArray(args[2]) ? args[2].length : undefined });
    });
    const origEmit = emu.emit;
    if (typeof origEmit === 'function' && !origEmit.__journal) {
      const w = function (evt, p) {
        try {
          if (evt === 'output-changed' && p) record('emu-out', `emu:${p.address}:out:${p.outNum}`, p.state ? 1 : 0, 'emulated', p.auto ? { auto: true } : undefined);
          else if (evt === 'tamper-changed') record('tamper', 'emu:tamper', p ? 1 : 0, 'emulated');
          else if (evt === 'powerfail-changed') record('powerfail', 'emu:powerfail', p ? 1 : 0, 'emulated');
        } catch { /* */ }
        return origEmit.apply(this, arguments);
      };
      w.__journal = true;
      emu.emit = w;
    }
  }

  // Card senders are created during startup and may be replaced; re-check periodically.
  const hookManagers = () => {
    const wm = d.getWiegand && d.getWiegand();
    if (wm) {
      let inSend = 0;
      if (wrap(wm, 'sendCard', (args, r, err) => { inSend = 0; if (!err) record('card', `wiegand:${args[0]}`, 1, 'wiegand', { fc: args[1], cn: args[2], format: args[3] || undefined }); })) {
        const orig = wm.sendCard;
        wm.sendCard = function (...a) { inSend++; return orig.apply(this, a); };
        wm.sendCard.__journal = true;
      }
      wrap(wm, 'sendRaw', (args, r, err) => { if (!err && !inSend) record('card', `wiegand:${args[0]}`, 1, 'wiegand', { bits: String(args[1]).length }); });
    }
    const om = d.getOsdp && d.getOsdp();
    if (om) {
      wrap(om, 'sendCardRead', (args, r, err) => { if (!err) record('card', `osdp:${args[0]}`, 1, 'osdp', { format: args[2] }); });
      wrap(om, 'sendKeypadData', (args, r, err) => { if (!err) record('keypad', `osdp:${args[0]}`, 1, 'osdp', { count: String(args[1] || '').length }); });
    }
  };
  hookManagers();
  setInterval(hookManagers, 5000).unref();
}

function status() {
  flush();
  let files = [];
  try { ensureDir(); files = fs.readdirSync(DIR).filter(x => x.endsWith('.jsonl')).map(f => ({ day: f.slice(0, 10), size: fs.statSync(path.join(DIR, f)).size })); } catch { /* */ }
  return { currentRun: runs.find(r => r.id === currentRun) || null, runs: runs.slice(-50).reverse(), stats, files };
}

function onRecord(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { attach, record, startRun, stopRun, read, parseUpload, status, onRecord, _flush: flush };
