// analytics/time.js — wall-clock helpers.
//
// Controller logs carry panel-local time with no zone. The bundle's timezone.json
// names the IANA zone (e.g. America/New_York); every parsed record is converted to
// UTC epoch ms with it so Aether's journal (epoch ms) and the controller line up.
'use strict';

const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

/** Offset (ms) of `tz` from UTC at instant `utcMs`. */
function tzOffset(utcMs, tz) {
  if (!tz || tz === 'UTC') return 0;
  const p = {};
  for (const x of partsFmt(tz).formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Local wall-clock fields in `tz` → UTC epoch ms. */
function zonedToUtc(y, mo, d, h, mi, s, ms, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s, ms || 0);
  if (!tz || tz === 'UTC') return naive;
  let t = naive - tzOffset(naive, tz);
  t = naive - tzOffset(t, tz);          // second pass settles DST edges
  return t;
}

/** "2026-10-07 17:16:10" + ms → epoch ms */
function parseLocal(str, ms, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(str);
  if (!m) return NaN;
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], ms || 0, tz);
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** "Oct 08 00:00:00.453222" (syslog style, no year) → epoch ms; year inferred from a hint date. */
function parseSyslog(str, yearHint, monthHint, tz) {
  const m = /^(\w{3}) (\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(str);
  if (!m || !MONTHS[m[1]]) return NaN;
  const mo = MONTHS[m[1]];
  let y = yearHint;
  if (monthHint === 1 && mo === 12) y -= 1;        // Dec lines in a January file
  if (monthHint === 12 && mo === 1) y += 1;
  const frac = m[6] ? Math.round(Number('0.' + m[6]) * 1000) : 0;
  return zonedToUtc(y, mo, +m[2], +m[3], +m[4], +m[5], frac, tz);
}

function fmtLocal(utcMs, tz) {
  if (!Number.isFinite(utcMs)) return '';
  const p = {};
  for (const x of partsFmt(tz || 'UTC').formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const ms = String(((utcMs % 1000) + 1000) % 1000).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day} ${p.hour % 24 === 0 ? '00' : p.hour}:${p.minute}:${p.second}.${ms}`;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '—';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (a < 3600000) return `${Math.floor(a / 60000)}m ${Math.round((a % 60000) / 1000)}s`;
  if (a < 86400000) return `${Math.floor(a / 3600000)}h ${Math.round((a % 3600000) / 60000)}m`;
  return `${Math.floor(a / 86400000)}d ${Math.round((a % 86400000) / 3600000)}h`;
}

module.exports = { tzOffset, zonedToUtc, parseLocal, parseSyslog, fmtLocal, fmtDur };
