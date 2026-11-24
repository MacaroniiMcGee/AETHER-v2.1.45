// trace/clockcheck.js — read each access controller's own clock over SUNAPI.   AETHER_TRACE (TRACE-5)
//
// Uses the controllers saved in Tools › SUNAPI Console (backend/data/sunapi/devices.json, kind "access", with
// their login kept on the Pi). For each: GET /stw-cgi/system.cgi?msubmenu=date&action=view, timed on the Pi.
//   offsetMs = controller UTC − Pi time at the middle of the request (± half the round trip, + up to 1 s
//   because SUNAPI reports whole seconds). Positive = the controller is ahead.
// Event Trace runs this at the start of every run (and on demand) and warns when it is off by more than
// clockWarnMs, next to the offset the sync markers measure.
'use strict';

const fs = require('fs');
const path = require('path');

const SUNAPI = path.join(__dirname, '..', 'data', 'sunapi');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** "2026-11-23 20:01:02" / "2026-11-23T20:01:02Z" / "20261123T200102" → ms (UTC). */
function parseUtc(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})(?:\.(\d+))?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac, tz] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, frac ? Math.round(Number('0.' + frac) * 1000) : 0);
  if (tz && /^[+-]/.test(tz)) { const sg = tz[0] === '-' ? -1 : 1; const hh = +tz.slice(1, 3), mm = +tz.slice(-2); t -= sg * (hh * 60 + mm) * 60000; }
  return Number.isFinite(t) ? t : null;
}

/** Pull the controller's UTC time and how it keeps time out of a SUNAPI date view (JSON or key=value). */
function readDate(body) {
  let j = null;
  try { j = JSON.parse(body); } catch { /* key=value text */ }
  const flat = {};
  const walk = (o, p = '') => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v, p + k + '.'); else flat[(p + k)] = v; } };
  if (j) walk(j);
  else for (const line of String(body || '').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) flat[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const key = re => Object.keys(flat).find(k => re.test(k.split('.').pop()));
  const utcK = key(/^utc(time)?$/i) || key(/utc/i);
  const utc = utcK ? parseUtc(flat[utcK]) : null;
  const syncK = key(/^(synctype|timesync|ntpenable|syncmode)$/i);
  const ntpK = key(/^(ntpserver|ntpaddress|ntpserveraddress\d*)$/i);
  const tzK = key(/^(timezone|timezoneindex|posixtimezone)$/i);
  const localK = key(/^localtime$/i);
  return { utc, sync: syncK ? String(flat[syncK]) : null, ntp: ntpK ? String(flat[ntpK]) : null, tz: tzK ? String(flat[tzK]) : null, local: localK ? String(flat[localK]) : null, keys: Object.keys(flat).slice(0, 30) };
}

async function checkControllers(opt = {}) {
  let sunapiCall;
  try { ({ sunapiCall } = require('../routes/sunapi')); } catch { return { available: false, reason: 'Tools › SUNAPI Console is not installed on this Pi', controllers: [] }; }
  const devices = readJson(path.join(SUNAPI, 'devices.json'), []).filter(d => d && (d.kind === 'access' || /^NHP|^NOP|ACS/i.test(String(d.model || ''))));
  const creds = readJson(path.join(SUNAPI, 'sunapi-credentials.json'), {});
  const only = opt.ids && opt.ids.length ? new Set(opt.ids) : null;
  const list = devices.filter(d => !only || only.has(d.id)).slice(0, 16);
  const out = await Promise.all(list.map(async d => {
    const base = { id: d.id, name: d.name || d.host, host: d.host, model: d.model || null };
    if (!creds[d.id]) return { ...base, error: 'No login saved for it in Tools › SUNAPI Console' };
    const root = d.cgiRoot || 'stw-cgi';
    const t1 = Date.now();
    try {
      const r = await sunapiCall(d, creds[d.id], { uri: `/${root}/system.cgi?msubmenu=date&action=view`, accept: 'json', timeoutMs: opt.timeoutMs || 8000 });
      const t2 = Date.now();
      if (r.status !== 200) return { ...base, error: `HTTP ${r.status}${r.status === 401 ? ' (login refused)' : ''}` };
      const x = readDate(r.body);
      if (x.utc == null) return { ...base, error: 'The controller did not report a UTC time', fields: x.keys };
      const mid = (t1 + t2) / 2;
      return { ...base, at: t2, offsetMs: Math.round(x.utc - mid), rttMs: t2 - t1, resolutionMs: 1000 + Math.round((t2 - t1) / 2), sync: x.sync, ntp: x.ntp, tz: x.tz, local: x.local };
    } catch (e) { return { ...base, error: e && e.message ? e.message : String(e) }; }
  }));
  return { available: true, at: Date.now(), controllers: out };
}

module.exports = { checkControllers, readDate, parseUtc };
