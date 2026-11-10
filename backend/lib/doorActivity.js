// backend/lib/doorActivity.js — AETHER_DOOR_ACTIVITY
//
// Per-door activity log: what happened on each door's I/O and reader, newest
// last, the last MAX_PER_DOOR entries per door. Fed by server.js from the paths
// that already exist (relay writes, the opto / zone monitors, the Controller
// Emulator's events) plus explicit entries the Doors page POSTs (cards presented,
// events / workflows started). Costs no extra I2C or emulator traffic: it only
// looks at values those paths already have.
//
// Entry: { id, t, doorId, kind, text, source, level }
//   kind   'lock' | 'dps' | 'rex' | 'input' | 'card' | 'event' | 'note'
//   source 'aether' | 'panel' | 'emulator' | 'workflow' | 'user'
//   level  'info' | 'ok' | 'warn'
//
// Doors come from the saved door config (backend/data/doors/door-config.json,
// written by routes-doors.js), re-read when its mtime changes (checked at most
// every CONFIG_CHECK_MS, or right away after invalidate()). The door shape and
// the role semantics mirror frontend/src/lib/doorOutputs.ts:
//   - DPS / REX: Aether outputs (relay / dac / od); logical = level, inverted by reverseSense.
//   - Lock: driven output (reverseSense is NOT applied: lockDriveIO), or on a
//     physical door a WATCHED input: 'opto-in' (OPTO n) / 'analog-in' (ADC n, eol | volts).
//   - Emulated doors (ioSource 'emulated', emuBoard = address): Lock = board output
//     lock.channel (follows the output as is), DPS / REX = board inputs (reverseSense applies).
//   - Custom ios: 'opto' / 'analog' are inputs (any stack, like the Doors page), 'relay' is REL n
//     (physical doors, stack 0); enabled !== false.
// Disabled doors are ignored. Every feed records the last logical value per
// door + role + terminal and logs only real changes.
//
// The mapping functions are pure (exported for tests); createDoorActivity()
// wraps them with the ring buffer, dedupe state, persistence and HTTP handlers.

'use strict';

const fs = require('fs');
const path = require('path');

const KINDS = ['lock', 'dps', 'rex', 'input', 'card', 'event', 'note'];
const SOURCES = ['aether', 'panel', 'emulator', 'workflow', 'user'];
const LEVELS = ['info', 'ok', 'warn'];
const MAX_PER_DOOR = 200;
const MAX_BUCKETS = 32;          // review fix 4: at most this many doors' logs are kept
const MAX_TEXT = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const LOCK_WATCH_TYPE = 'opto-in';
const LOCK_WATCH_ANALOG_TYPE = 'analog-in';
const DEFAULT_LOCK_WATCH_THRESHOLD = 5;

/* ───────────────────────── door shape (mirrors doorOutputs.ts) ───────────────────────── */

const isAssigned = (io) => { const ch = Number(io && io.channel); return Number.isInteger(ch) && ch >= 0; };
const isLockWatch = (io) => !!io && (io.hardwareType === LOCK_WATCH_TYPE || io.hardwareType === LOCK_WATCH_ANALOG_TYPE);
const isAnalogLockWatch = (io) => !!io && io.hardwareType === LOCK_WATCH_ANALOG_TYPE;
const outputKind = (io) => { const t = io && io.hardwareType; return t === 'dac' || t === 'od' ? t : 'relay'; };
const isEnabled = (d) => !!d && d.enabled !== false;
const isPhysicalEnabled = (d) => isEnabled(d) && (!d.ioSource || d.ioSource === 'physical');
const isEmulatedEnabled = (d) => isEnabled(d) && d.ioSource === 'emulated' && !!Number(d.emuBoard);
const stack0 = (io) => !Number(io && io.stackLevel);
function lockWatchThreshold(io) {
  const v = Number(io && io.thresholdVolts);
  if (!io || io.thresholdVolts === undefined || io.thresholdVolts === null || io.thresholdVolts === '' || !Number.isFinite(v)) return DEFAULT_LOCK_WATCH_THRESHOLD;
  return Math.min(10, Math.max(0.5, v));
}

/** migrateSavedDoor (doorOutputs.ts) in plain JS: gpio -> channel, missing / legacy hardwareType -> relay. */
function migrateDoor(door) {
  if (!door || typeof door !== 'object') return null;
  const edge = (e) => {
    if (!e || typeof e !== 'object') return e;
    const n = { ...e };
    if (n.channel === undefined && n.gpio !== undefined) n.channel = n.gpio;
    delete n.gpio;
    return n;
  };
  const d = { ...door };
  for (const k of ['lock', 'dps', 'rexIn']) if (d[k]) d[k] = edge(d[k]);
  d.ios = Array.isArray(d.ios) ? d.ios.map(edge) : [];
  if (d.lock && d.lock.channel !== undefined && !d.lock.hardwareType) {
    d.lock = { ...d.lock, hardwareType: 'relay' };
    if (d.dps) d.dps = { ...d.dps, hardwareType: 'relay' };
    if (d.rexIn) d.rexIn = { ...d.rexIn, hardwareType: 'relay' };
  }
  for (const k of ['lock', 'dps', 'rexIn']) {             // normalizeDoorOutput
    const io = d[k];
    if (io && !isLockWatch(io) && io.hardwareType !== outputKind(io)) d[k] = { ...io, hardwareType: outputKind(io) };
  }
  d.id = Number(d.id);
  return Number.isInteger(d.id) ? d : null;
}

/** Doors from a parsed door-config.json (wrapper { config } or bare). */
function doorsFromConfig(json) {
  const cfg = json && json.config && typeof json.config === 'object' ? json.config : json;
  if (!cfg || !Array.isArray(cfg.doors)) return [];
  return cfg.doors.map(migrateDoor).filter(Boolean);
}

const ROLE = { lock: { kind: 'lock', word: 'Lock' }, dps: { kind: 'dps', word: 'DPS' }, rexIn: { kind: 'rex', word: 'REX' } };
function roleText(key, on) {
  if (key === 'dps') return on ? 'DPS OPEN' : 'DPS closed';
  if (key === 'rexIn') return on ? 'REX pressed' : 'REX released';
  return on ? 'Lock UNLOCKED' : 'Lock LOCKED';
}
const ioName = (io, fallback) => String((io && io.name) || fallback).slice(0, 60);

/* A "change" is a candidate entry plus its dedupe key / value:
 *   { doorId, key, value, kind, text, level, source, restoredText? }
 * value is 0 / 1, or a fault name ('TROUBLE' / 'TAMPER') for zones. */

/** Relay write REL pin+1 (stack 0) -> physical doors' driven Lock / DPS / REX on that relay, and custom relay ios. */
function changesForRelay(doors, pin, state) {
  const out = [];
  const ch = Number(pin);
  if (!Number.isInteger(ch) || ch < 0) return out;
  const on = !!state, label = `REL ${ch + 1}`;
  for (const d of doors || []) {
    if (!isEnabled(d)) continue;
    if (isPhysicalEnabled(d)) {
      for (const key of ['lock', 'dps', 'rexIn']) {
        const io = d[key];
        if (!io || !isAssigned(io) || isLockWatch(io) || outputKind(io) !== 'relay' || !stack0(io) || Number(io.channel) !== ch) continue;
        const logical = key === 'lock' ? on : (io.reverseSense ? !on : on);   // the Lock drives straight through (lockDriveIO)
        out.push({ doorId: d.id, key: `${d.id}:${key}:relay:${ch}`, value: logical ? 1 : 0, kind: ROLE[key].kind,
          text: `${roleText(key, logical)} · ${label}`, level: 'info', source: 'aether' });
      }
    }
    if (!isPhysicalEnabled(d)) continue;   // review fix 6: custom relay ios are driven only for Aether (physical) doors
    for (const io of d.ios || []) {
      if (!io || io.enabled === false || io.hardwareType !== 'relay' || !isAssigned(io) || !stack0(io) || Number(io.channel) !== ch) continue;
      out.push({ doorId: d.id, key: `${d.id}:io:${io.id || io.name}:relay:${ch}`, value: on ? 1 : 0, kind: 'input',
        text: `${ioName(io, 'I/O')} ${on ? 'ON' : 'OFF'} · ${label}`, level: 'info', source: 'aether' });
    }
  }
  return out;
}

/** OPTO ch+1 now reads v -> watched opto Locks (physical) and custom opto ios. */
function changesForOpto(doors, ch, v) {
  const out = [];
  ch = Number(ch);
  if (!Number.isInteger(ch) || ch < 0) return out;
  const on = !!Number(v), label = `OPTO ${ch + 1}`;
  for (const d of doors || []) {
    if (!isEnabled(d)) continue;
    const lock = d.lock;
    if (isPhysicalEnabled(d) && lock && lock.hardwareType === LOCK_WATCH_TYPE && isAssigned(lock) && stack0(lock) && Number(lock.channel) === ch) {
      const unlocked = lock.reverseSense ? !on : on;
      out.push({ doorId: d.id, key: `${d.id}:lock:opto:${ch}`, value: unlocked ? 1 : 0, kind: 'lock',
        text: `${unlocked ? 'Lock UNLOCKED by panel' : 'Lock relocked'} · ${label}`, level: 'info', source: 'panel' });
    }
    for (const io of d.ios || []) {
      if (!io || io.enabled === false || io.hardwareType !== 'opto' || !isAssigned(io) || Number(io.channel) !== ch) continue;   // stack not checked, like the Doors page (review fix 6)
      const active = io.reverseSense ? !on : on;
      out.push({ doorId: d.id, key: `${d.id}:io:${io.id || io.name}:opto:${ch}`, value: active ? 1 : 0, kind: 'input',
        text: `${ioName(io, 'Input')} ${active ? 'ACTIVE' : 'idle'} · ${label}`, level: 'info', source: 'panel' });
    }
  }
  return out;
}

/** lockWatchFromEvent (doorOutputs.ts) for an analog-in lock. */
function analogLockState(lock, ev) {
  const inv = (on) => (lock.reverseSense ? !on : on);
  if (lock.analogMode === 'volts') {
    const given = (x) => x !== undefined && x !== null && x !== '' && Number.isFinite(Number(x));
    const v = given(ev.volts) ? Number(ev.volts) : given(ev.voltage) ? Number(ev.voltage) / 1000 : NaN;
    if (!Number.isFinite(v)) return null;
    return { active: inv(v >= lockWatchThreshold(lock)), sup: 'normal', volts: v };
  }
  const st = String(ev.supervisionState || '').toUpperCase();
  if (st === 'ALARM') return { active: inv(true), sup: 'normal' };
  if (st === 'NORMAL') return { active: inv(false), sup: 'normal' };
  if (st === 'TROUBLE') return { active: false, sup: 'TROUBLE' };
  if (st === 'TAMPER') return { active: false, sup: 'TAMPER' };
  return null;
}

/** EOL zone event {type:'analog', pin, voltage mV, volts, supervisionState} -> watched analog Locks and custom analog ios. */
function changesForZone(doors, ev) {
  const out = [];
  if (!ev || ev.type !== 'analog') return out;
  const ch = Number(ev.pin ?? ev.channel);
  if (!Number.isInteger(ch) || ch < 0) return out;
  const label = `ADC ${ch + 1}`;
  const st = String(ev.supervisionState || '').toUpperCase();
  for (const d of doors || []) {
    if (!isEnabled(d)) continue;
    const lock = d.lock;
    if (isPhysicalEnabled(d) && lock && isAnalogLockWatch(lock) && isAssigned(lock) && stack0(lock) && Number(lock.channel) === ch) {
      const r = analogLockState(lock, ev);
      if (r) {
        const fault = r.sup !== 'normal';
        const vtxt = lock.analogMode === 'volts' ? ` (${r.volts.toFixed(1)} V)` : '';
        out.push({ doorId: d.id, key: `${d.id}:lock:analog:${ch}`, value: fault ? r.sup : (r.active ? 1 : 0), kind: 'lock',
          text: fault ? `Lock zone ${r.sup} · ${label}` : `${r.active ? 'Lock UNLOCKED by panel' : 'Lock relocked'}${vtxt} · ${label}`,
          level: fault ? 'warn' : 'info', source: 'panel',
          restoredText: fault ? undefined : `Lock zone restored, ${r.active ? 'UNLOCKED' : 'locked'} · ${label}` });
      }
    }
    for (const io of d.ios || []) {
      if (!io || io.enabled === false || io.hardwareType !== 'analog' || !isAssigned(io) || Number(io.channel) !== ch) continue;   // stack not checked, like the Doors page (review fix 6)
      if (!['ALARM', 'NORMAL', 'TROUBLE', 'TAMPER'].includes(st)) continue;
      // same as the Doors page: state = ALARM / TAMPER, reverseSense inverts; TROUBLE / TAMPER reported
      const raw = st === 'ALARM' || st === 'TAMPER';
      const active = io.reverseSense ? !raw : raw;
      const fault = st === 'TROUBLE' || st === 'TAMPER';
      out.push({ doorId: d.id, key: `${d.id}:io:${io.id || io.name}:analog:${ch}`, value: fault ? st : (active ? 1 : 0), kind: 'input',
        text: fault ? `${ioName(io, 'Input')} zone ${st} · ${label}` : `${ioName(io, 'Input')} ${active ? 'ACTIVE' : 'idle'} · ${label}`,
        level: fault ? 'warn' : 'info', source: 'panel',
        restoredText: fault ? undefined : `${ioName(io, 'Input')} zone restored, ${active ? 'ACTIVE' : 'idle'} · ${label}` });
    }
  }
  return out;
}

const sameBoard = (d, address) => (Number(d.emuBoard) & 0x7F) === (Number(address) & 0x7F);

/** Controller Emulator 'output-changed' {address, outNum, state, auto, via} -> emulated doors' Lock on that output. */
function changesForEmuOutput(doors, msg) {
  const out = [];
  if (!msg) return out;
  const addr = Number(msg.address), outNum = Number(msg.outNum ?? msg.idx);
  if (!Number.isInteger(addr) || !Number.isInteger(outNum)) return out;
  const on = !!Number(msg.state ?? (msg.active ? 1 : 0));
  const byApi = msg.via === 'api';                 // set from Aether (Doors page / workflow), not by the panel
  const where = `#${addr & 0x7F} output ${outNum}`;
  for (const d of doors || []) {
    if (!isEmulatedEnabled(d) || !sameBoard(d, addr)) continue;
    const lock = d.lock;
    if (!lock || !isAssigned(lock) || Number(lock.channel) !== outNum) continue;
    const text = byApi ? `${on ? 'Lock UNLOCKED' : 'Lock LOCKED'} · ${where}`
      : on ? `Lock UNLOCKED by panel · ${where}`
      : msg.auto ? `Lock relocked (pulse ended) · ${where}` : `Lock relocked by panel · ${where}`;
    out.push({ doorId: d.id, key: `${d.id}:lock:emu:${addr & 0x7F}:${outNum}`, value: on ? 1 : 0, kind: 'lock',
      text, level: 'info', source: byApi ? 'aether' : 'panel' });
  }
  return out;
}

/** One emulated board input changed (index idx now raw) -> emulated doors' DPS / REX on that input. */
function changesForEmuInput(doors, address, idx, raw) {
  const out = [];
  const addr = Number(address);
  if (!Number.isInteger(addr) || !Number.isInteger(Number(idx))) return out;
  const where = `#${addr & 0x7F} input ${idx}`;
  for (const d of doors || []) {
    if (!isEmulatedEnabled(d) || !sameBoard(d, addr)) continue;
    for (const key of ['dps', 'rexIn']) {
      const io = d[key];
      if (!io || !isAssigned(io) || Number(io.channel) !== Number(idx)) continue;
      const on = io.reverseSense ? !raw : !!raw;
      out.push({ doorId: d.id, key: `${d.id}:${key}:emu:${addr & 0x7F}:${idx}`, value: on ? 1 : 0, kind: ROLE[key].kind,
        text: `${roleText(key, on)} · ${where}`, level: 'info', source: 'emulator' });
    }
  }
  return out;
}

/** Inputs that differ between two snapshots' input arrays (prev null = none: first snapshot is a baseline). */
function diffInputs(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return [];
  const out = [];
  for (let i = 0; i < next.length; i++) if ((prev[i] ? 1 : 0) !== (next[i] ? 1 : 0)) out.push({ idx: i, raw: next[i] ? 1 : 0 });
  return out;
}

/** Validate a POSTed entry. Returns { ok, entry? , error? }. */
function validateEntry(doorIdRaw, body) {
  const doorId = Number(doorIdRaw);
  if (!/^\d+$/.test(String(doorIdRaw)) || !Number.isInteger(doorId) || doorId < 0 || doorId > 100000) return { ok: false, error: 'door id must be a non-negative integer' };
  const b = body && typeof body === 'object' ? body : {};
  const kind = b.kind === undefined ? 'note' : b.kind;
  if (!KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
  if (typeof b.text !== 'string' || !b.text.trim()) return { ok: false, error: 'text is required' };
  const text = b.text.trim();
  if (text.length > MAX_TEXT) return { ok: false, error: `text must be at most ${MAX_TEXT} characters` };
  const source = b.source === undefined ? 'user' : b.source;
  if (!SOURCES.includes(source)) return { ok: false, error: `source must be one of ${SOURCES.join(', ')}` };
  const level = b.level === undefined ? 'info' : b.level;
  if (!LEVELS.includes(level)) return { ok: false, error: `level must be one of ${LEVELS.join(', ')}` };
  return { ok: true, entry: { doorId, kind, text: text.replace(/[\r\n\t]+/g, ' '), source, level } };
}

/* ───────────────────────── service ───────────────────────── */

function createDoorActivity(opts = {}) {
  const configFile = opts.configFile || path.join(__dirname, '..', 'data', 'doors', 'door-config.json');
  const dataFile = opts.dataFile || path.join(__dirname, '..', 'data', 'door-activity.json');
  const maxPerDoor = opts.maxPerDoor || MAX_PER_DOOR;
  const maxBuckets = opts.maxBuckets || MAX_BUCKETS;
  const persistMs = opts.persistMs === undefined ? 5000 : opts.persistMs;
  const configCheckMs = opts.configCheckMs === undefined ? 2000 : opts.configCheckMs;
  const now = opts.now || Date.now;
  const log = opts.log || ((...a) => console.warn('[DoorActivity]', ...a));
  let emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const onCleared = typeof opts.onCleared === 'function' ? opts.onCleared : () => {};   // review fix 5
  const rateMax = opts.ratePerSec || 20;

  const buf = new Map();          // doorId -> entries (oldest first)
  const last = new Map();         // dedupe key -> last logical value
  const emuInputs = new Map();    // board address -> last inputs array
  const rate = new Map();         // doorId -> { at, n }
  let seq = 0;
  let cfg = { mtimeMs: -1, checkedAt: -Infinity, doors: [] };
  // persistence state (review fix 3): gen counts changes, savedGen = gen of the last good write
  let saveTimer = null, gen = 0, savedGen = 0, writing = false, again = false, tmpSeq = 0;
  const isDirty = () => gen !== savedGen;
  const tmpName = () => `${dataFile}.${process.pid}.${tmpSeq++}.tmp`;   // unique: a sync flush never collides with an async write

  // ── persistence ──
  function load() {
    let raw;
    try { raw = fs.readFileSync(dataFile, 'utf8'); } catch (e) {
      if (e && e.code !== 'ENOENT') log('could not read', dataFile, e.message);
      return;
    }
    let j;
    try { j = JSON.parse(raw); } catch (e) {
      // corrupt: keep it for inspection instead of overwriting it with an empty log
      const keep = `${dataFile}.corrupt-${now()}`;
      try { fs.renameSync(dataFile, keep); log(`corrupt ${path.basename(dataFile)} moved to ${path.basename(keep)}`); }
      catch (e2) { log('corrupt log could not be moved:', e2.message); }
      return;
    }
    const doors = j && j.doors && typeof j.doors === 'object' ? j.doors : {};
    for (const [k, arr] of Object.entries(doors)) {
      const id = Number(k);
      if (!Number.isInteger(id) || !Array.isArray(arr)) continue;
      const ok = arr.filter(e => e && typeof e.text === 'string' && Number.isFinite(Number(e.t)) && typeof e.id === 'string');
      if (ok.length) buf.set(id, ok.slice(-maxPerDoor));
    }
  }
  function snapshotJson() {
    const doors = {};
    for (const [id, arr] of buf) if (arr.length) doors[id] = arr.slice(-maxPerDoor);
    return JSON.stringify({ version: 1, savedAt: new Date(now()).toISOString(), doors });
  }
  function writeSync() {
    const g = gen;
    const tmp = tmpName();
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(tmp, snapshotJson(), 'utf8');
      fs.renameSync(tmp, dataFile);
      savedGen = Math.max(savedGen, g);          // clean only once the rename succeeded
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} log('save failed:', e.message); }
  }
  /** One async write at a time; a save asked for during a write runs once more after it. */
  async function runSave() {
    if (writing) { again = true; return; }
    writing = true; again = false;
    const g = gen;
    const tmp = tmpName();
    const fsp = fs.promises;
    let ok = false;
    try {
      await fsp.mkdir(path.dirname(dataFile), { recursive: true });
      await fsp.writeFile(tmp, snapshotJson(), 'utf8');
      if (savedGen >= g) { await fsp.unlink(tmp).catch(() => {}); ok = true; }   // a sync flush already wrote newer data
      else { await fsp.rename(tmp, dataFile); savedGen = Math.max(savedGen, g); ok = true; }
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      log('save failed:', e.message);
    } finally {
      writing = false;
    }
    if (ok && (again || isDirty())) { again = false; if (isDirty()) armSave(); }
    else if (!ok) armSave();                      // retry after the normal delay, never in a tight loop
  }
  function armSave() {
    if (saveTimer || persistMs < 0) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (isDirty()) runSave(); }, persistMs);
    if (saveTimer.unref) saveTimer.unref();
  }
  function scheduleSave() { gen++; armSave(); }
  function flushSync() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (isDirty()) writeSync();
  }

  // ── door config ──
  /** Review fix 4: drop buckets of doors no longer configured; keep at most maxBuckets (most recent activity). */
  function pruneBuckets(doors) {
    const ids = new Set(doors.map(d => d.id));
    let changed = false;
    for (const id of Array.from(buf.keys())) if (!ids.has(id)) { buf.delete(id); changed = true; }
    if (buf.size > maxBuckets) {
      const byRecent = Array.from(buf.entries()).sort((x, y) => (y[1].length ? y[1][y[1].length - 1].t : 0) - (x[1].length ? x[1][x[1].length - 1].t : 0));
      for (const [id] of byRecent.slice(maxBuckets)) buf.delete(id);
      changed = true;
    }
    if (changed) scheduleSave();
  }
  function getDoors(force = false) {
    const t = now();
    if (!force && t - cfg.checkedAt < configCheckMs) return cfg.doors;
    cfg.checkedAt = t;
    let st;
    try { st = fs.statSync(configFile); } catch (_) { cfg = { mtimeMs: -1, checkedAt: t, doors: [] }; return cfg.doors; }
    if (st.mtimeMs === cfg.mtimeMs) return cfg.doors;
    try {
      cfg = { mtimeMs: st.mtimeMs, checkedAt: t, doors: doorsFromConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))) };
      pruneBuckets(cfg.doors);       // only after a good read: a missing / corrupt config never wipes the log
    } catch (e) {
      cfg.mtimeMs = st.mtimeMs;   // corrupt / half-written: keep the last good doors, retry on the next mtime change
      log('door config not read:', e.message);
    }
    return cfg.doors;
  }
  function invalidate() {
    cfg.checkedAt = -Infinity;
    try { getDoors(true); } catch (e) { log('door config not read:', e && e.message); }
  }

  // ── entries ──
  // AETHER_AEGIS_AUTOMATION: meta { value, initial, key } goes to emit() as a 2nd argument (automation
  // rules read the structured value instead of the text); the stored / sent entry is unchanged.
  function add(e, meta) {
    const t = Number.isFinite(Number(e.t)) ? Number(e.t) : now();
    const entry = { id: `${t.toString(36)}-${(seq++).toString(36)}`, t, doorId: Number(e.doorId),
      kind: KINDS.includes(e.kind) ? e.kind : 'note', text: String(e.text || '').slice(0, MAX_TEXT),
      source: SOURCES.includes(e.source) ? e.source : 'aether', level: LEVELS.includes(e.level) ? e.level : 'info' };
    let arr = buf.get(entry.doorId);
    if (!arr) { arr = []; buf.set(entry.doorId, arr); }
    arr.push(entry);
    if (arr.length > maxPerDoor) arr.splice(0, arr.length - maxPerDoor);
    scheduleSave();
    try { emit(entry, meta || null); } catch (_) { /* a socket problem never breaks the feed */ }
    return entry;
  }
  /**
   * Apply candidate changes: log the ones whose value differs from the last seen.
   * baseline (a first read after nobody was watching): silent only when nothing was
   * remembered for that key; a value that differs from the remembered one is a change
   * that happened while unmonitored and is logged as such (review fix 1).
   */
  function apply(changes, { baseline = false, at } = {}) {
    const added = [];
    for (const c of changes) {
      const had = last.has(c.key);
      const prev = last.get(c.key);
      last.set(c.key, c.value);
      if (!had && baseline) continue;
      if (had && prev === c.value) continue;
      // leaving a zone fault (TROUBLE / TAMPER) says so instead of a plain lock / input change
      let text = typeof prev === 'string' && c.restoredText ? c.restoredText : c.text;
      if (baseline) text = `${text} (changed while unmonitored)`;
      added.push(add({ doorId: c.doorId, kind: c.kind, text: text.slice(0, MAX_TEXT), source: c.source, level: c.level, t: at },
        { value: c.value, initial: !!baseline, key: c.key }));   // AETHER_AEGIS_AUTOMATION: baseline ("changed while unmonitored") = initial
    }
    return added;
  }
  /** Remember values without logging (emulator lock outputs from a board snapshot). */
  function remember(changes) { for (const c of changes) last.set(c.key, c.value); }
  /** Review fix 2: forget what we knew about emulated boards (all, or one address). */
  function forgetEmu(addr) {
    const tag = addr === undefined ? ':emu:' : `:emu:${addr}:`;
    for (const k of Array.from(last.keys())) if (k.includes(tag)) last.delete(k);
    if (addr === undefined) emuInputs.clear(); else emuInputs.delete(addr);
  }
  function list(doorId, limit) {
    let n = Number(limit);
    n = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
    let all;
    if (doorId === undefined || doorId === null || doorId === '') {
      all = [];
      for (const arr of buf.values()) all.push(...arr);
      all.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } else {
      all = buf.get(Number(doorId)) || [];
    }
    return all.slice(-n).reverse();
  }
  function clear(doorId) {
    const had = (buf.get(Number(doorId)) || []).length;
    buf.delete(Number(doorId));
    scheduleSave();
    try { onCleared(Number(doorId)); } catch (_) { /* socket problem: the HTTP answer still goes out */ }
    return had;
  }
  function allowPost(doorId) {
    const t = now();
    const r = rate.get(doorId);
    if (!r || t - r.at >= 1000) { rate.set(doorId, { at: t, n: 1 }); return true; }
    if (r.n >= rateMax) return false;
    r.n++;
    return true;
  }

  // ── feeds (never throw into the I/O paths) ──
  const guard = (name, fn) => (...args) => {
    try { return fn(...args); } catch (e) { log(`${name} feed error:`, e && e.message); return []; }
  };
  const onRelayWrite = guard('relay', (pin, state) => apply(changesForRelay(getDoors(), pin, state)));
  const onOpto = guard('opto', (ch, v, o = {}) => apply(changesForOpto(getDoors(), ch, v), { baseline: !!o.initial, at: o.at }));
  const onZone = guard('zone', (ev, o = {}) => apply(changesForZone(getDoors(), ev), { baseline: !!o.initial, at: ev && ev.timestamp }));
  const onEmulatorEvent = guard('emulator', (evt, payload) => {
    if (evt === 'output-changed') return apply(changesForEmuOutput(getDoors(), payload));
    // a (re)start or applied config rebuilds every board with outputs 0 and sends no output-changed
    if (evt === 'emulator-started' || evt === 'emulator-config-applied') { forgetEmu(); return []; }
    if (evt === 'emulator-device-removed' && payload) { forgetEmu(Number(payload.address) & 0x7F); return []; }
    if ((evt === 'emulator-device-update' || evt === 'emulator-device-added') && payload) {
      const addr = Number(payload.address) & 0x7F;
      if (!Number.isInteger(addr)) return [];
      const doors = getDoors();
      // the snapshot's outputs are the truth for the lock (silently): a later output-changed is compared with them
      if (Array.isArray(payload.outputs)) payload.outputs.forEach((st, i) => remember(changesForEmuOutput(doors, { address: addr, outNum: i, state: st })));
      if (!Array.isArray(payload.inputs)) return [];
      const prev = emuInputs.get(addr);
      emuInputs.set(addr, payload.inputs.slice());
      if (!prev) {                     // first snapshot of this board: remember, don't log
        payload.inputs.forEach((raw, i) => apply(changesForEmuInput(doors, addr, i, raw), { baseline: true }));
        return [];
      }
      const ch = diffInputs(prev, payload.inputs);
      if (!ch.length) return [];
      return ch.flatMap(({ idx, raw }) => apply(changesForEmuInput(doors, addr, idx, raw)));
    }
    return [];
  });

  // ── HTTP handlers (plain (req, res) so they are testable without express) ──
  const handlers = {
    list(req, res) {
      const q = req.query || {};
      if (q.door !== undefined && q.door !== '' && !/^\d+$/.test(String(q.door))) return res.status(400).json({ success: false, error: 'door must be an integer' });
      const entries = list(q.door, q.limit);
      res.json({ success: true, entries });
    },
    post(req, res) {
      const v = validateEntry(req.params && req.params.id, req.body);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error });
      // review fix 4: only doors in the saved door config
      if (!getDoors().some(d => d.id === v.entry.doorId)) return res.status(404).json({ success: false, error: `door ${v.entry.doorId} is not in the saved door config` });
      if (!allowPost(v.entry.doorId)) return res.status(429).json({ success: false, error: 'too many entries for this door (max 20/s)' });
      const entry = add(v.entry);
      res.json({ success: true, entry });
    },
    clear(req, res) {
      const raw = req.params && req.params.id;
      if (!/^\d+$/.test(String(raw))) return res.status(400).json({ success: false, error: 'door id must be an integer' });
      const removed = clear(Number(raw));
      res.json({ success: true, removed });
    },
  };
  function router(express) {
    const r = (express || require('express')).Router();
    r.get('/activity', handlers.list);
    r.post('/:id/activity', handlers.post);
    r.delete('/:id/activity', handlers.clear);
    return r;
  }

  load();
  try { getDoors(true); } catch (_) { /* prunes buckets of doors no longer configured */ }
  return {
    add, list, clear, apply, getDoors, invalidate, flushSync, router, handlers,
    onRelayWrite, onOpto, onZone, onEmulatorEvent,
    setEmit(fn) { emit = typeof fn === 'function' ? fn : () => {}; },
    _state: { buf, last, emuInputs, isDirty, get writing() { return writing; } },
  };
}

module.exports = {
  createDoorActivity, validateEntry, migrateDoor, doorsFromConfig,
  changesForRelay, changesForOpto, changesForZone, changesForEmuOutput, changesForEmuInput, diffInputs,
  KINDS, SOURCES, LEVELS, MAX_PER_DOOR, MAX_TEXT,
};
