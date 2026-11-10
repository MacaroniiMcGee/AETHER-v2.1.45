// routes/logs.js - System logging API
//
// AETHER_LOGS_API (Update 69)
//  - GET  /api/logs?type=audit|system|emulation|access|security|all&limit=N
//    (default 500, max 2000, newest first). Before this the Reports page
//    called this URL and got 404.
//  - 'audit' and 'emulation' buckets join system/access/security.
//  - audit/system/emulation are persisted to backend/data/logs/<type>.json
//    (atomic tmp+rename, debounced, capped at PERSIST_CAP per type) so the
//    UI's logs survive a browser reload and a backend restart.
//  - POST / accepts {type, entries:[...]} batches (audit/system/emulation)
//    as well as the old single-entry body. Entries are validated and capped.
//  - DELETE /?type= clears that type (and its file).
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// In-memory log storage (newest first). Only TYPES are valid keys: a type
// from the request is checked with isType() so 'constructor', '__proto__',
// 'toString' etc. never reach logs[type].
const TYPES = ['system', 'access', 'security', 'audit', 'emulation'];
const isType = (t) => typeof t === 'string' && TYPES.includes(t);
const logs = {
  system: [],
  access: [],
  security: [],
  audit: [],
  emulation: []
};

const MAX_LOGS = 1000;            // memory-only buckets (access, security)
const PERSIST_CAP = 5000;         // persisted buckets
const PERSISTED = ['audit', 'system', 'emulation'];
const GET_DEFAULT = 500;
const GET_MAX = 2000;
const BATCH_MAX = 200;
const MSG_MAX = 2000;
const DETAILS_MAX = 4000;
const LEVELS = new Set(['info', 'success', 'warn', 'warning', 'error', 'io', 'door', 'debug']);

const LOG_DIR = process.env.AETHER_LOGS_DIR || path.join(__dirname, '..', 'data', 'logs');
const WRITE_DEBOUNCE_MS = 5000;   // SD-card wear: at most one rewrite per type per 5 s (flushed on exit)
const TS_MAX_AHEAD_MS = 86400000; // client timestamps clamped to [0, now + 1 day]

const capFor = (type) => (PERSISTED.includes(type) ? PERSIST_CAP : MAX_LOGS);
const tsOf = (e) => {
  if (typeof e.timestamp === 'number') return e.timestamp;
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) ? t : 0;
};
const genId = (type) => `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

// ---- Persistence -----------------------------------------------------------
const dirty = new Set();
let writeTimer = null;

function fileFor(type) { return path.join(LOG_DIR, `${type}.json`); }

function loadPersisted() {
  for (const type of PERSISTED) {
    try {
      const raw = fs.readFileSync(fileFor(type), 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        logs[type] = arr.filter(e => e && typeof e === 'object' && typeof e.message === 'string')
          .sort((a, b) => tsOf(b) - tsOf(a))
          .slice(0, PERSIST_CAP);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[Logs] could not load ${type} log: ${e.message}`);
    }
  }
}

function writeNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!dirty.size) return;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* reported below */ }
  for (const type of Array.from(dirty)) {
    dirty.delete(type);
    const file = fileFor(type);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(logs[type]));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn(`[Logs] could not save ${type} log: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function markDirty(type) {
  if (!PERSISTED.includes(type)) return;
  dirty.add(type);
  if (!writeTimer) {
    writeTimer = setTimeout(writeNow, WRITE_DEBOUNCE_MS);
    if (writeTimer.unref) writeTimer.unref();
  }
}

// server.js's SIGINT/SIGTERM handlers end in process.exit(), which fires this.
process.on('exit', writeNow);
loadPersisted();

// ---- Entry handling --------------------------------------------------------
// Helper to add log entry (server-side events; unchanged shape)
function addLog(type, entry) {
  if (!isType(type)) return;
  logs[type].unshift({
    id: genId(type),
    timestamp: new Date().toISOString(),
    ...entry
  });
  if (logs[type].length > capFor(type)) logs[type].length = capFor(type);
  markDirty(type);
}

/** Validate and cap one client-supplied entry. Returns null if unusable. */
function sanitizeEntry(type, raw) {
  if (!raw || typeof raw !== 'object') return null;
  let message = raw.message;
  if (typeof message !== 'string' || !message.trim()) return null;
  if (message.length > MSG_MAX) message = message.slice(0, MSG_MAX) + '…';

  const nowMs = Date.now();
  // Numbers (or numeric strings) are ms; other strings go through Date.parse
  // (Date.parse('-5') would otherwise read as a calendar date).
  let timestamp = typeof raw.timestamp === 'number' || (typeof raw.timestamp === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw.timestamp))
    ? Number(raw.timestamp)
    : Date.parse(raw.timestamp);
  if (!Number.isFinite(timestamp)) timestamp = nowMs;
  // Clamp: > 8.64e15 makes toISOString() throw; far-future rows would pin the top of the list.
  timestamp = Math.min(Math.max(0, Math.floor(timestamp)), nowMs + TS_MAX_AHEAD_MS);
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 120 ? raw.id : genId(type);
  const level = typeof raw.level === 'string' && LEVELS.has(raw.level) ? raw.level : 'info';

  const out = { id, timestamp, time: new Date(timestamp).toISOString(), message, level };
  const repeat = Math.floor(Number(raw.repeat));   // client collapses identical consecutive lines
  if (Number.isFinite(repeat) && repeat > 1) out.repeat = Math.min(repeat, 1e6);
  for (const k of ['category', 'source', 'node']) {
    if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k].slice(0, 64);
  }
  if (raw.details !== undefined) {
    try {
      const s = JSON.stringify(raw.details);
      if (s && s.length <= DETAILS_MAX) out.details = raw.details;
      else out.details = { truncated: true, preview: String(s).slice(0, 200) };
    } catch { /* unserialisable details dropped */ }
  }
  return out;
}

/** Insert sanitized entries, skipping ids already stored (client retries).
 *  The store is kept newest-first; only the (small) batch is sorted and then
 *  merged in one linear pass, so a write never re-sorts up to 5000 rows. */
function ingest(type, entries) {
  const store = logs[type];
  const seen = new Set(store.map(e => e.id));
  const fresh = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }
  if (!fresh.length) return 0;
  fresh.sort((a, b) => tsOf(b) - tsOf(a));
  const cap = capFor(type);
  let merged;
  if (!store.length || tsOf(fresh[fresh.length - 1]) >= tsOf(store[0])) {
    merged = fresh.concat(store);                      // common case: all newer than head
  } else {
    merged = [];
    let i = 0, j = 0;
    while ((i < fresh.length || j < store.length) && merged.length < cap) {
      if (j >= store.length || (i < fresh.length && tsOf(fresh[i]) >= tsOf(store[j]))) merged.push(fresh[i++]);
      else merged.push(store[j++]);
    }
  }
  if (merged.length > cap) merged.length = cap;
  logs[type] = merged;
  markDirty(type);
  return fresh.length;
}

// Exported helper functions
function logSystemEvent(message, level = 'info', data = {}) {
  addLog('system', { message, level, ...data });
}

function logAccessEvent(message, data = {}) {
  addLog('access', { message, ...data });
}

function logSecurityEvent(message, severity = 'medium', data = {}) {
  addLog('security', { message, severity, ...data });
}

// GET /api/logs?type=&limit=   (AETHER_LOGS_API)
router.get('/', (req, res) => {
  const type = String(req.query.type || 'all');
  const limit = Math.min(GET_MAX, Math.max(1, parseInt(req.query.limit) || GET_DEFAULT));
  let results;
  if (type === 'all') {
    results = TYPES
      .flatMap(t => logs[t].map(l => ({ ...l, logType: t })))
      .sort((a, b) => tsOf(b) - tsOf(a));
  } else if (isType(type)) {
    results = logs[type];
  } else {
    return res.status(400).json({ success: false, error: 'Invalid log type', types: [...TYPES, 'all'] });
  }
  const page = results.slice(0, limit);
  res.json({ success: true, type, count: page.length, total: results.length, logs: page });
});

// GET /api/logs/system
router.get('/system', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  const level = req.query.level;
  let results = logs.system;
  if (level) results = results.filter(l => l.level === level);
  res.json({
    success: true,
    type: 'system',
    count: results.slice(0, limit).length,
    total: results.length,
    logs: results.slice(0, limit)
  });
});

// GET /api/logs/access
router.get('/access', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  res.json({
    success: true,
    type: 'access',
    count: logs.access.slice(0, limit).length,
    total: logs.access.length,
    logs: logs.access.slice(0, limit)
  });
});

// GET /api/logs/security
router.get('/security', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  const severity = req.query.severity;
  let results = logs.security;
  if (severity) results = results.filter(l => l.severity === severity);
  res.json({
    success: true,
    type: 'security',
    count: results.slice(0, limit).length,
    total: results.length,
    logs: results.slice(0, limit)
  });
});

// GET /api/logs/all
router.get('/all', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  const combined = [
    ...logs.system.map(l => ({ ...l, type: 'system' })),
    ...logs.access.map(l => ({ ...l, type: 'access' })),
    ...logs.security.map(l => ({ ...l, type: 'security' }))
  ].sort((a, b) => tsOf(b) - tsOf(a));

  res.json({
    success: true,
    count: combined.slice(0, limit).length,
    total: combined.length,
    logs: combined.slice(0, limit)
  });
});

// GET /api/logs/stats
router.get('/stats', (req, res) => {
  const counts = {};
  let total = 0;
  for (const t of TYPES) { counts[t] = logs[t].length; total += logs[t].length; }
  res.json({
    success: true,
    stats: { ...counts, total, maxPerType: MAX_LOGS, maxPersistedPerType: PERSIST_CAP }
  });
});

// GET /api/logs/export
router.get('/export', (req, res) => {
  const { type } = req.query;
  const exportData = isType(type) ? { [type]: logs[type] } : logs;
  res.setHeader('Content-Disposition', `attachment; filename=logs-${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ exported: new Date().toISOString(), logs: exportData });
});

// POST /api/logs
//   batch:  { type: 'audit'|'system'|'emulation', entries: [{id, timestamp, message, level, ...}] }
//   single: { type, message, level, severity, ...data }   (back-compat)
router.post('/', (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.entries)) {
    const type = body.type;
    if (!PERSISTED.includes(type)) {
      return res.status(400).json({ success: false, error: `Batch type must be one of ${PERSISTED.join(', ')}` });
    }
    if (body.entries.length > BATCH_MAX) {
      return res.status(413).json({ success: false, error: `At most ${BATCH_MAX} entries per batch` });
    }
    const clean = body.entries.map(e => sanitizeEntry(type, e)).filter(Boolean);
    const added = ingest(type, clean);
    return res.json({ success: true, received: body.entries.length, accepted: clean.length, added });
  }

  const { type = 'system', message, level, severity, ...data } = body;
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });
  if (!isType(type)) return res.status(400).json({ success: false, error: 'Invalid log type' });
  if (PERSISTED.includes(type)) {
    const clean = sanitizeEntry(type, { ...body, level: level || 'info' });
    if (!clean) return res.status(400).json({ success: false, error: 'Invalid entry' });
    ingest(type, [clean]);
  } else {
    addLog(type, { message, level, severity, ...data });
  }
  res.json({ success: true, message: 'Log entry added' });
});

// DELETE /api/logs?type=
router.delete('/', (req, res) => {
  const { type } = req.query;
  if (isType(type)) {
    const count = logs[type].length;
    logs[type] = [];
    markDirty(type);
    writeNow();
    res.json({ success: true, message: `Cleared ${count} ${type} logs` });
  } else if (type) {
    res.status(400).json({ success: false, error: 'Invalid log type' });
  } else {
    const counts = {};
    for (const t of TYPES) { counts[t] = logs[t].length; logs[t] = []; markDirty(t); }
    writeNow();
    res.json({ success: true, message: 'All logs cleared', cleared: counts });
  }
});

module.exports = {
  router,
  logSystemEvent,
  logAccessEvent,
  logSecurityEvent
};
