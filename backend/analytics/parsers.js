// analytics/parsers.js — turn bundle files into normalized records.
//
// Record: { t (UTC epoch ms), level, mod, fn, ln, msg, file, line, src }
// src: 'cc' CloudConnector · 'health' HealthMonitor · 'sync' SyncTiming · 'audit' · 'other'
'use strict';

const fs = require('fs');
const { parseLocal } = require('./time');
const aspsdk = require('./aspsdk');

// "2026-10-07 17:16:10,787 [DEBUG] ACAAS : checkForTriggers : 65 => msg"
// "2026-09-27 12:29:39,475 [DEBUG] SYNC [96] do_db_migrations : 1973 => msg"
const CC_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)[,.](\d{1,3}) \[(\w+)\] (.+?) : (\d+) => ?(.*)$/;

function splitHead(head) {
  const i = head.lastIndexOf(' : ');
  if (i >= 0) return [head.slice(0, i).trim(), head.slice(i + 3).trim()];
  const parts = head.trim().split(/\s+/);
  const fn = parts.pop();
  return [parts.join(' ') || fn, fn];
}

const MAX_MSG = 6000;

function parseCCText(text, file, src, tz) {
  const recs = [];
  const lines = text.split(/\r?\n/);
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = CC_LINE.exec(l);
    if (m) {
      const [mod, fn] = splitHead(m[4]);
      last = {
        t: parseLocal(m[1], +m[2].padEnd(3, '0'), tz), local: `${m[1]}.${m[2].padEnd(3, '0')}`,
        level: m[3].toUpperCase().replace('WARNING', 'WARN'), mod, fn, ln: +m[5],
        msg: m[6], file, line: i + 1, src,
      };
      recs.push(last);
    } else if (last && l.trim() && last.msg.length < MAX_MSG) {
      last.msg += '\n' + l;          // continuation of a multi-line message
    }
  }
  return recs;
}

// "2026-04-03 11:24:49,System,[MQTT host] Connected"
function parseAuditText(text, file, tz) {
  const recs = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),([^,]*),(.*)$/.exec(l);
    if (!m) return;
    recs.push({ t: parseLocal(m[1], 0, tz), local: m[1], level: 'AUDIT', mod: m[2] || 'Audit', fn: '', ln: 0, msg: m[3].trim(), file, line: i + 1, src: 'audit' });
  });
  return recs;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Read the config snapshots worth knowing about. Keys are basenames. */
function readConfigs(files) {
  const cfg = {};
  for (const f of files.filter(x => x.type === 'config' && !x.skipped && x.size < 4 * 1024 * 1024)) {
    const base = f.rel.split('/').pop();
    const raw = fs.readFileSync(f.abs, 'utf8');
    let json = null;
    try { json = JSON.parse(raw); } catch { /* .conf files are not always JSON */ }
    cfg[base] = { rel: f.rel, json, raw: raw.length < 200000 ? raw : raw.slice(0, 200000) };
  }
  return cfg;
}

function bundleTimezone(cfg) {
  const tzj = cfg['timezone.json'] && cfg['timezone.json'].json;
  const tz = tzj && (tzj.tz_location || tzj.timezone);
  try { if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return { tz, from: 'timezone.json', posix: tzj.POSIXTimeZone || '' }; } } catch { /* */ }
  return { tz: 'UTC', from: 'default (timezone.json missing or unreadable)', posix: '' };
}

/** Parse every recognized file. */
function parseBundle(manifest, opts = {}) {
  const cfg = readConfigs(manifest.files);
  const zone = opts.tzOverride ? { tz: opts.tzOverride, from: 'override', posix: '' } : bundleTimezone(cfg);
  const tz = zone.tz;
  const out = { zone, cfg, cc: [], health: [], sync: [], audit: [], other: [], archived: [], archives: {}, asp: { frames: [], notes: [] }, files: [] };
  for (const f of manifest.files) {
    const entry = { rel: f.rel, type: f.type, size: f.size, records: 0, skipped: f.skipped };
    out.files.push(entry);
    if (f.skipped) continue;
    if (f.type.startsWith('archived-')) {
      // Older log snapshots: kept apart from the live timeline
      const text = fs.readFileSync(f.abs, 'latin1');
      const r = f.type === 'archived-audit' ? parseAuditText(text, f.rel, tz) : parseCCText(text, f.rel, 'archive', tz);
      for (const x of r) { x.src = 'archive'; x.archive = f.archive; }
      out.archived.push(...r);
      entry.records = r.length;
      const a = out.archives[f.archive] = out.archives[f.archive] || { name: f.archive, files: 0, records: 0, from: null, to: null };
      a.files++; a.records += r.length;
      for (const x of r) { if (Number.isFinite(x.t)) { a.from = a.from == null ? x.t : Math.min(a.from, x.t); a.to = a.to == null ? x.t : Math.max(a.to, x.t); } }
      continue;
    }
    if (!['cloudconnector', 'health', 'sync', 'audit', 'aspsdk', 'otherlog'].includes(f.type)) continue;
    const text = fs.readFileSync(f.abs, 'latin1');
    if (f.type === 'aspsdk') {
      const r = aspsdk.parseText(text, f.rel, { tz });
      out.asp.frames.push(...r.frames); out.asp.notes.push(...r.notes);
      entry.records = r.frames.length + r.notes.length;
    } else if (f.type === 'audit') {
      const r = parseAuditText(text, f.rel, tz); out.audit.push(...r); entry.records = r.length;
    } else {
      const src = { cloudconnector: 'cc', health: 'health', sync: 'sync', otherlog: 'other' }[f.type];
      const r = parseCCText(text, f.rel, src, tz);
      out[src].push(...r); entry.records = r.length;
    }
  }
  const byT = (a, b) => (a.t - b.t) || 0;
  out.cc.sort(byT); out.health.sort(byT); out.sync.sort(byT); out.audit.sort(byT); out.other.sort(byT);
  out.asp.frames.sort(byT); out.asp.notes.sort(byT); out.archived.sort(byT);
  return out;
}

module.exports = { parseBundle, parseCCText, parseAuditText, readJSON };
