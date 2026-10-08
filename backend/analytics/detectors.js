// analytics/detectors.js — Inspection-mode anomaly rules.
//
// Each rule reads the parsed bundle (ctx) and pushes findings:
//   { id, cat, sev, title, detail, count, first, last, samples[], fix, basis }
// cat:  cloud · door · delivery · config · security · panel
// sev:  critical · high · medium · low · info
// basis: 'confirmed' (stated by the log) · 'derived' (computed from timing/sequence)
//        · 'heuristic' (pattern that usually means trouble; verify)
'use strict';

const { signature } = require('./events');
const { fmtDur } = require('./time');

// ── redaction: nothing secret ever leaves the scanner ────────────────────────
const SECRET_KEYS = /("?\b(?:token|sessionToken|accessKeyId|secretAccessKey|secret|password|passwd|pwd|pass|apiKey|api_key|privateKey|clientSecret|authorization)"?\s*[:=]\s*"?)([^",\s}]{4,})/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /(Bearer\s+)([A-Za-z0-9._\-+/=]{12,})/g;
const LONG_B64 = /([A-Za-z0-9+/_-]{48,}={0,2})/g;
function redact(s) {
  return String(s)
    .replace(JWT, v => `«redacted JWT ${v.length} chars»`)
    .replace(SECRET_KEYS, (_, k, v) => (/^\*+$/.test(v) || /^«redacted/.test(v) ? k + v : `${k}«redacted ${v.length} chars»`))
    .replace(BEARER, (_, k, v) => `${k}«redacted ${v.length} chars»`)
    .replace(LONG_B64, v => (/\d/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && !/^\/|\/\/|\/[a-z]+\//.test(v)) ? `«redacted ${v.length} chars»` : v);
}

const MAX_SAMPLES = 12;
// `raw` (unredacted, only when redaction changed something) never reaches the saved report:
// routes-analytics.js moves it to a separate <id>.raw.json for the "Show raw" button.
const sample = (r, text) => {
  const orig = String(text != null ? text : (r.msg || ''));
  const red = redact(orig);
  const s = { t: r.t, file: r.file, line: r.line, text: red.slice(0, 600) };
  if (red !== orig) s.raw = orig.slice(0, 4000);
  return s;
};

function mk(list, f) {
  const samples = (f.samples || []).slice(0, MAX_SAMPLES);
  const ts = (f.times || (f.samples || []).map(s => s.t)).filter(Number.isFinite);
  list.push({
    id: f.id, cat: f.cat, sev: f.sev, title: f.title, detail: f.detail || '', fix: f.fix || '',
    basis: f.basis || 'confirmed', count: f.count != null ? f.count : (f.samples || []).length,
    first: ts.length ? Math.min(...ts) : null, last: ts.length ? Math.max(...ts) : null,
    samples, metrics: f.metrics || null,
  });
}

const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };

// libmosquitto return codes (the Cloud Connector's MQTT client prints them verbatim)
const MOSQ = {
  0: 'clean disconnect', 1: 'out of memory', 2: 'protocol error', 3: 'invalid arguments', 4: 'no connection',
  5: 'connection refused by broker', 6: 'not found', 7: 'connection lost', 8: 'TLS error', 9: 'payload too large',
  10: 'not supported', 11: 'authentication failed', 12: 'ACL denied', 13: 'unknown', 14: 'system/socket error (errno)',
  15: 'DNS lookup error', 16: 'proxy error', 19: 'keepalive timeout (broker unreachable)', 20: 'lookup error',
};

// ═════════════════════════════════════════════════════════════════════════════
// CLOUD / MQTT
// ═════════════════════════════════════════════════════════════════════════════
function cloud(ctx, F) {
  const { p } = ctx;
  const audit = p.audit;

  // Disconnects with reason codes (audit + CC)
  const disc = [];
  for (const r of audit) {
    const m = /\[MQTT ([^\]]+)\] Disconnect Error Code: (\d+)/.exec(r.msg);
    if (m) disc.push({ r, host: m[1], code: +m[2] });
  }
  for (const r of p.cc) {
    const m = /Unexpected MQTT disconnect, code: (\d+)/.exec(r.msg);
    if (m) disc.push({ r, host: 'CloudConnector', code: +m[1] });
  }
  const byCode = {};
  for (const d of disc) (byCode[d.code] = byCode[d.code] || []).push(d);
  for (const [code, list] of Object.entries(byCode)) {
    const c = +code;
    const meaning = MOSQ[c] || 'unrecognized code';
    mk(F, {
      id: `cloud.mqtt.disconnect.${c}`, cat: 'cloud', sev: c === 0 ? 'info' : (c === 11 || c === 8 ? 'high' : list.length >= 3 ? 'high' : 'medium'),
      title: `MQTT disconnect code ${c} — ${meaning}`,
      detail: `${list.length} disconnect(s) from the cloud broker with code ${c} (${meaning}, libmosquitto numbering).`,
      fix: c === 7 || c === 19 ? 'Check WAN stability, NAT/firewall idle timeouts and broker keepalive; correlate with network-monitor drops.'
        : c === 14 ? 'Socket-level error — look for DHCP renewals, link flaps or DNS failures at these times.'
          : c === 11 ? 'Device credentials rejected — re-claim or refresh the device token.' : '',
      samples: list.map(d => sample(d.r)), count: list.length,
    });
  }

  // Outages: disconnect / de-init → next Connected
  const conn = audit.filter(r => /\] Connected$|Device already connected/.test(r.msg));
  const downs = audit.filter(r => /Disconnect Error Code|De-Initialized|Token Expired/.test(r.msg));
  const outages = [];
  for (const d of downs) {
    if (outages.length && d.t <= outages[outages.length - 1].end) continue;
    const up = conn.find(c => c.t >= d.t);
    const end = up ? up.t : null;
    outages.push({ start: d.t, end: end || d.t, open: !up, r: d });
  }
  const longOut = outages.filter(o => o.open || o.end - o.start > 60000);
  if (longOut.length) {
    mk(F, {
      id: 'cloud.outage', cat: 'cloud', sev: longOut.some(o => o.open || o.end - o.start > 600000) ? 'high' : 'medium',
      title: `Cloud connection outages over 60 s (${longOut.length})`,
      detail: longOut.slice(0, 8).map(o => `${o.open ? 'never reconnected' : fmtDur(o.end - o.start)} starting at line ${o.r.line}`).join('; '),
      basis: 'derived', samples: longOut.map(o => sample(o.r, `${o.r.msg} — down ${o.open ? 'until end of log' : fmtDur(o.end - o.start)}`)),
      metrics: { outages: longOut.map(o => ({ start: o.start, end: o.end, open: o.open })) },
    });
  }

  // Reconnect storms: ≥3 connects within one hour
  const storms = [];
  for (let i = 0; i < conn.length; i++) {
    const j = conn.findIndex((c, k) => k > i && c.t - conn[i].t > 3600000);
    const n = (j < 0 ? conn.length : j) - i;
    if (n >= 3 && (!storms.length || conn[i].t > storms[storms.length - 1].t + 3600000)) storms.push({ t: conn[i].t, n, r: conn[i] });
  }
  if (storms.length) mk(F, {
    id: 'cloud.reconnect-storm', cat: 'cloud', sev: 'medium', basis: 'derived',
    title: `Reconnect storms (${storms.length} hour-windows with 3+ reconnects)`,
    detail: 'The controller reconnected to the broker repeatedly within an hour; events published in between may be delayed or replayed.',
    samples: storms.map(s => sample(s.r, `${s.n} connects within 1 h starting here`)),
  });

  const simple = [
    [/Token Expired/, 'cloud.token-expired', 'medium', 'MQTT token expired', 'The broker token expired before refresh; the connector had to reconnect.', 'Check controller clock (NTP) and the token refresh schedule.'],
    [/Publish Error/, 'cloud.publish-error', 'high', 'MQTT publish errors', 'Messages failed to publish.', ''],
    [/Device partial reset performed|De-initializing all modules/, 'config.reset', 'medium', 'Controller reset / module de-initialization', 'Configuration change events from the audit log.', ''],
    [/Device claimed/, 'cloud.claim', 'info', 'Device (re)claimed', '', ''],
  ];
  for (const [rx, id, sev, title, detail, fix] of simple) {
    const hits = audit.filter(r => rx.test(r.msg));
    if (hits.length) mk(F, { id, cat: id.split('.')[0], sev, title: `${title} (${hits.length})`, detail, fix, samples: hits.map(r => sample(r)), count: hits.length });
  }

  // Broker host changes
  const hosts = [];
  for (const r of audit) { const m = /\[MQTT ([^\]]+)\] Connected/.exec(r.msg); if (m && (!hosts.length || hosts[hosts.length - 1].h !== m[1])) hosts.push({ h: m[1], r }); }
  if (hosts.length > 1) mk(F, {
    id: 'cloud.broker-change', cat: 'cloud', sev: 'info', title: `Broker endpoint changed ${hosts.length - 1} time(s)`,
    detail: hosts.map(h => h.h).join(' → '), samples: hosts.map(h => sample(h.r)),
  });

  // CC-side token refresh retries
  const tokRetry = p.cc.filter(r => /token expired, will be updated/.test(r.msg));
  if (tokRetry.length) mk(F, {
    id: 'cloud.http-token-retry', cat: 'cloud', sev: tokRetry.length > 5 ? 'medium' : 'low',
    title: `HTTP API token expired during artifact publish (${tokRetry.length})`,
    detail: 'The device API token was stale when used; the connector slept and retried.', samples: tokRetry.map(r => sample(r)), count: tokRetry.length,
  });

  // Network monitor drops
  const nw = p.cc.filter(r => /NW_MNTR_DISCONNECTED/.test(r.msg));
  if (nw.length) mk(F, {
    id: 'cloud.network-drop', cat: 'cloud', sev: 'medium', title: `Network monitor reported DISCONNECTED (${nw.length})`,
    detail: 'The connector\'s own network monitor lost the cloud.', samples: nw.map(r => sample(r)),
  });

  // HTTP non-200
  const http = p.cc.filter(r => /parsed resp code: \((\d+)\)/.test(r.msg) && !/\(200\)|\(201\)|\(204\)/.test(r.msg));
  if (http.length) mk(F, { id: 'cloud.http-error', cat: 'cloud', sev: 'medium', title: `Cloud HTTP API errors (${http.length})`, samples: http.map(r => sample(r)) });
}

// ═════════════════════════════════════════════════════════════════════════════
// DOOR / EVENT BEHAVIOR
// ═════════════════════════════════════════════════════════════════════════════
function doorCfg(ctx) {
  const d = (ctx.p.cfg['doors.json'] || {}).json || {};
  const map = {};
  for (const [id, v] of Object.entries(d)) map[id] = v;
  return map;
}

function door(ctx, F) {
  const { ev } = ctx;
  const doors = doorCfg(ctx);
  const nameOf = id => (doors[id] && doors[id].name) ? `${doors[id].name}` : (id ? id.slice(0, 8) : 'door');
  const rt = ev.rt.filter(e => e.cls === 'door' || e.srcType === 'door');

  const forced = rt.filter(e => e.type === 'doorforcedopen');
  if (forced.length) mk(F, {
    id: 'door.forced', cat: 'security', sev: 'high', title: `Door forced open (${forced.length})`,
    detail: `Door opened without a grant, REX or unlock. Doors: ${[...new Set(forced.map(e => nameOf(e.srcId)))].join(', ')}.`,
    samples: forced.map(e => ({ t: e.tEvent, file: e.file, line: e.line, text: `${nameOf(e.srcId)} — doorforcedopen (${e.ioPort})` })),
  });

  // Held open: open → dooropentoolong; compare against configured shortHeldOpenTime
  const held = rt.filter(e => e.type === 'dooropentoolong');
  if (held.length) {
    const rows = [], off = [];
    for (const h of held) {
      const open = [...rt].reverse().find(e => e.srcId === h.srcId && e.type === 'open' && e.tEvent <= h.tEvent);
      const clr = rt.find(e => e.srcId === h.srcId && e.type === 'doorheldcleared' && e.tEvent >= h.tEvent);
      const cfgS = Number((doors[h.srcId] || {}).shortHeldOpenTime);
      const after = open ? h.tEvent - open.tEvent : null;
      rows.push({ h, after, clearedAfter: clr ? clr.tEvent - h.tEvent : null });
      if (after != null && Number.isFinite(cfgS) && cfgS > 0 && Math.abs(after - cfgS * 1000) > 3000) off.push({ h, after, cfgS });
    }
    const durs = rows.map(r => r.clearedAfter).filter(x => x != null);
    mk(F, {
      id: 'door.held', cat: 'door', sev: held.length > 10 ? 'medium' : 'low', title: `Door held open too long (${held.length})`,
      detail: `Held-open alarms raised ${held.length} time(s). Door stayed open after the alarm: median ${fmtDur(pct(durs, 50))}, longest ${fmtDur(Math.max(0, ...durs))}.`,
      samples: rows.map(r => ({ t: r.h.tEvent, file: r.h.file, line: r.h.line, text: `${nameOf(r.h.srcId)} held-open alarm ${r.after != null ? fmtDur(r.after) + ' after open' : ''}${r.clearedAfter != null ? `, cleared ${fmtDur(r.clearedAfter)} later` : ', never cleared in log'}` })),
      metrics: { stillOpenAfterAlarmMs: { p50: pct(durs, 50), p95: pct(durs, 95), max: durs.length ? Math.max(...durs) : null } },
    });
    if (off.length) mk(F, {
      id: 'door.held-timer', cat: 'door', sev: 'medium', basis: 'derived',
      title: `Held-open alarm timing differs from configuration (${off.length})`,
      detail: `Configured held-open time vs actual time from "open" to "dooropentoolong" differs by more than 3 s.`,
      samples: off.map(o => ({ t: o.h.tEvent, file: o.h.file, line: o.h.line, text: `${nameOf(o.h.srcId)}: configured ${o.cfgS}s, alarm after ${fmtDur(o.after)}` })),
    });
  }

  // Unlock without a logged cause
  const causes = rt.filter(e => ['accessgranted', 'rexactivated'].includes(e.type));
  const unl = rt.filter(e => e.type === 'unlocked');
  const noCause = unl.filter(u => {
    if (causes.some(c => c.srcId === u.srcId && u.tEvent - c.tEvent >= -500 && u.tEvent - c.tEvent <= 3000)) return false;
    if (ctx.ev.incoming.some(m => u.t - m.t >= 0 && u.t - m.t <= 5000)) return false;
    return true;
  });
  // Schedule-driven unlocks are logged by the scheduler; exclude when the schedule state machine fired
  const sched = ctx.p.cc.filter(r => /onDoorSchedulerStateChange|scheduleStateMachine/.test(r.fn));
  const noCause2 = noCause.filter(u => !sched.some(s => Math.abs(s.t - u.t) <= 5000));
  if (noCause2.length) mk(F, {
    id: 'door.unlock-no-cause', cat: 'door', sev: 'medium', basis: 'heuristic',
    title: `Unlocks with no grant, REX, schedule or remote command nearby (${noCause2.length})`,
    detail: 'No access-granted, REX, scheduler transition or incoming cloud message within 3–5 s before the unlock. Could be a manual/remote unlock not logged at DEBUG, or an unexpected relay drive.',
    samples: noCause2.map(u => ({ t: u.tEvent, file: u.file, line: u.line, text: `${nameOf(u.srcId)} unlocked (${u.ioPort})` })),
  });

  // Strike duration: unlocked → locked vs configured strike times
  const longS = [];
  for (const u of unl) {
    const l = rt.find(e => e.srcId === u.srcId && e.type === 'locked' && e.tEvent > u.tEvent);
    if (!l) continue;
    const d = doors[u.srcId] || {};
    const maxS = Math.max(Number(d.shortStrikeTime) || 0, Number(d.longStrikeTime) || 0);
    const dur = l.tEvent - u.tEvent;
    // relock may wait for the door to close ("onfollowgrantime" etc.) — only flag when the door was closed the whole time
    const openedBetween = rt.some(e => e.srcId === u.srcId && e.type === 'open' && e.tEvent >= u.tEvent && e.tEvent <= l.tEvent);
    if (maxS > 0 && dur > (maxS + 5) * 1000 && !openedBetween) longS.push({ u, dur, maxS });
  }
  if (longS.length) mk(F, {
    id: 'door.strike-long', cat: 'door', sev: 'medium', basis: 'derived',
    title: `Strike stayed released longer than configured (${longS.length})`,
    detail: 'Unlocked → locked took longer than the longest configured strike time + 5 s while the door never opened.',
    samples: longS.map(s => ({ t: s.u.tEvent, file: s.u.file, line: s.u.line, text: `${nameOf(s.u.srcId)} released ${fmtDur(s.dur)} (config max ${s.maxS}s)` })),
  });

  // Denials / invalid PIN bursts
  const denied = rt.filter(e => /^accessdenied/.test(e.type));
  if (denied.length) {
    const bursts = [];
    for (let i = 0; i < denied.length; i++) {
      const win = denied.filter(d => d.srcId === denied[i].srcId && d.tEvent >= denied[i].tEvent && d.tEvent - denied[i].tEvent <= 60000);
      if (win.length >= 3 && (!bursts.length || denied[i].tEvent > bursts[bursts.length - 1].t + 60000)) bursts.push({ t: denied[i].tEvent, n: win.length, e: denied[i] });
    }
    const types = {};
    for (const d of denied) types[d.type] = (types[d.type] || 0) + 1;
    mk(F, {
      id: 'door.denied', cat: 'door', sev: 'low', title: `Access denied (${denied.length})`,
      detail: Object.entries(types).map(([k, v]) => `${k}: ${v}`).join(', '),
      samples: denied.map(e => ({ t: e.tEvent, file: e.file, line: e.line, text: `${nameOf(e.srcId)} ${e.type}` })),
    });
    if (bursts.length) mk(F, {
      id: 'door.denied-burst', cat: 'security', sev: 'high', basis: 'derived',
      title: `Repeated denials within 60 s — possible credential guessing (${bursts.length})`,
      samples: bursts.map(b => ({ t: b.t, file: b.e.file, line: b.e.line, text: `${b.n} denials at ${nameOf(b.e.srcId)} within 60 s (${b.e.type})` })),
    });
  }

  // REX activated without deactivate
  const rexA = rt.filter(e => e.type === 'rexactivated');
  const stuck = rexA.filter(a => !rt.some(e => e.srcId === a.srcId && e.type === 'rexdeactivated' && e.tEvent >= a.tEvent && e.tEvent - a.tEvent < 60000));
  if (stuck.length) mk(F, {
    id: 'door.rex-stuck', cat: 'door', sev: 'medium', basis: 'derived', title: `REX activated with no release within 60 s (${stuck.length})`,
    detail: 'A request-to-exit input stayed active; check for a stuck button or wiring short.',
    samples: stuck.map(e => ({ t: e.tEvent, file: e.file, line: e.line, text: `${nameOf(e.srcId)} rexactivated` })),
  });

  // Door state sequence: duplicate open/open or closed/closed, open at end
  const bySrc = {};
  for (const e of rt.filter(x => x.type === 'open' || x.type === 'closed')) (bySrc[e.srcId] = bySrc[e.srcId] || []).push(e);
  const dups = [], leftOpen = [];
  for (const [src, list] of Object.entries(bySrc)) {
    for (let i = 1; i < list.length; i++) if (list[i].type === list[i - 1].type) dups.push(list[i]);
    const lastE = list[list.length - 1];
    if (lastE.type === 'open') leftOpen.push(lastE);
    void src;
  }
  if (dups.length) mk(F, {
    id: 'door.sequence', cat: 'door', sev: 'medium', basis: 'derived', title: `Door contact sequence breaks (${dups.length})`,
    detail: 'Two "open" or two "closed" events in a row for the same door — an intermediate transition was missed or published twice.',
    samples: dups.map(e => ({ t: e.tEvent, file: e.file, line: e.line, text: `${nameOf(e.srcId)} ${e.type} repeated` })),
  });
  if (dups.length >= 2) {
    const tz = ctx.p.zone.tz, hm = {};
    for (const e of dups) { const k = require('./time').fmtLocal(e.tEvent, tz).slice(11, 16); hm[k] = (hm[k] || 0) + 1; }
    const top = Object.entries(hm).sort((a, b) => b[1] - a[1])[0];
    if (top[1] >= 2) F[F.length - 1].detail += ` ${top[1]} of ${dups.length} happen at ${top[0]} local time — check the schedules that fire then (a schedule re-asserting door state).`;
  }
  if (leftOpen.length) mk(F, {
    id: 'door.left-open', cat: 'door', sev: 'low', basis: 'derived', title: `Door still open at end of log (${leftOpen.length})`,
    samples: leftOpen.map(e => ({ t: e.tEvent, file: e.file, line: e.line, text: `${nameOf(e.srcId)} last state: open` })),
  });

  // Access-point state machine continuity
  const apBy = {};
  for (const a of ctx.ev.ap) (apBy[a.ap] = apBy[a.ap] || []).push(a);
  const breaks = [];
  for (const all of Object.values(apBy)) {
    // REX / held / forced lines report a placeholder "Closed -> Closed"; only real moves chain
    const list = all.filter(a => a.from !== a.to);
    for (let i = 1; i < list.length; i++) {
      if (list[i].from !== list[i - 1].to && list[i].t - list[i - 1].t < 6 * 3600000) breaks.push({ a: list[i], prev: list[i - 1] });
    }
  }
  if (breaks.length) mk(F, {
    id: 'door.state-jump', cat: 'door', sev: 'medium', basis: 'derived', title: `Access-point state jumps (${breaks.length})`,
    detail: 'A transition started from a state the previous transition did not end in — the controller skipped or lost a state change.',
    samples: breaks.map(b => sample(b.a, `${b.a.ap}: previous ended ${b.prev.to}, next starts ${b.a.from} → ${b.a.to} (${b.a.event})`)),
  });

  // Info: event mix
  const mix = {};
  for (const e of rt) mix[e.type] = (mix[e.type] || 0) + 1;
  ctx.summary.eventMix = mix;
}

// ═════════════════════════════════════════════════════════════════════════════
// DELIVERY & TIMING
// ═════════════════════════════════════════════════════════════════════════════
function delivery(ctx, F) {
  const { p, ev, opts } = ctx;

  // Event → MQTT publish lag (controller event time vs publish log time)
  const devEv = ev.rt.filter(e => e.cls !== 'controller');   // controller-class events (fw/cc update) carry their start time
  const lags = devEv.map(e => e.lagMs).filter(x => x != null && x > -60000 && x < 3600000);
  if (lags.length) {
    const slow = devEv.filter(e => e.lagMs != null && e.lagMs > opts.publishWarnMs);
    ctx.summary.publishLag = { n: lags.length, p50: pct(lags, 50), p95: pct(lags, 95), max: Math.max(...lags) };
    if (slow.length) mk(F, {
      id: 'delivery.publish-lag', cat: 'delivery', sev: slow.some(e => e.lagMs > 5000) ? 'high' : 'medium', basis: 'derived',
      title: `Slow event publish to cloud (${slow.length} over ${opts.publishWarnMs} ms)`,
      detail: `Event time → MQTT send: median ${fmtDur(pct(lags, 50))}, p95 ${fmtDur(pct(lags, 95))}, max ${fmtDur(Math.max(...lags))}.`,
      samples: slow.sort((a, b) => b.lagMs - a.lagMs).map(e => ({ t: e.tEvent, file: e.file, line: e.line, text: `${e.type} published after ${fmtDur(e.lagMs)}` })),
      metrics: ctx.summary.publishLag,
    });
    const neg = devEv.filter(e => e.lagMs != null && e.lagMs < -2000);
    if (neg.length) mk(F, {
      id: 'delivery.clock-skew', cat: 'delivery', sev: 'medium', basis: 'derived',
      title: `Event timestamps ahead of log clock (${neg.length})`,
      detail: 'The event payload time is later than the log line that published it — the controller clock or the timezone conversion is off.',
      samples: neg.map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.type}: payload ${fmtDur(-e.lagMs)} ahead` })),
    });
  }

  // Door transitions that never reached the cloud
  const lost = [];
  for (const a of ev.ap) {
    if (/^Strikes?Active$/.test(a.event) && a.from === a.to) continue;
    const pub = ev.rt.some(e => e.t >= a.t - 50 && e.t - a.t <= 5000);
    if (!pub) lost.push(a);
  }
  if (lost.length) mk(F, {
    id: 'delivery.unpublished', cat: 'delivery', sev: 'high', basis: 'heuristic',
    title: `Door transitions with no cloud event published within 5 s (${lost.length})`,
    detail: 'The access point changed state but no RealTime MQTT event followed. Some transitions may be filtered by door settings (ignoreAccessEvents / showRexActivatedEvents).',
    samples: lost.map(a => sample(a, `${a.ap} ${a.event} (${a.from} → ${a.to})`)),
  });

  // Offline event store trend
  const rows = ev.offlineRows;
  if (rows.length >= 2) {
    const first = rows[0], last = rows[rows.length - 1];
    let drains = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].rows < rows[i - 1].rows) drains++;
    const dbFile = (p.dbFiles || []).find(f => /offlineEvnt\.db$/.test(f.rel));
    ctx.summary.offlineRows = { first: first.rows, last: last.rows, drains, samples: rows.length };
    const dbSmall = dbFile && dbFile.size <= 32768;
    if (last.rows > first.rows && drains === 0) mk(F, {
      id: 'delivery.offline-growth', cat: 'delivery', sev: dbSmall ? 'info' : last.rows > 500 ? 'medium' : 'low', basis: 'heuristic',
      title: `Offline event counter rose ${first.rows} → ${last.rows} and never dropped`,
      detail: dbSmall
        ? `The bundled offlineEvnt.db is only ${Math.round(dbFile.size / 1024)} KB (effectively empty), so the logged "rows" figure behaves like an ever-increasing row id, not a real backlog. Verify only if the cloud is missing events.`
        : `Every event is written to the offline DB before publish and the logged row count only rose${dbFile ? ` (bundled DB ${Math.round(dbFile.size / 1024)} KB)` : ''} — events may be piling up unacknowledged.`,
      samples: [sample(first), sample(last)],
    });
  }

  // Log time gaps and clock jumps (per file)
  const gaps = [], jumps = [];
  const byFile = {};
  for (const r of p.cc) (byFile[r.file] = byFile[r.file] || []).push(r);
  for (const list of Object.values(byFile)) {
    for (let i = 1; i < list.length; i++) {
      const d = list[i].t - list[i - 1].t;
      if (d > opts.logGapMs) gaps.push({ a: list[i - 1], b: list[i], d });
      if (d < -2000) jumps.push({ a: list[i - 1], b: list[i], d });
    }
  }
  if (gaps.length) mk(F, {
    id: 'delivery.log-gap', cat: 'delivery', sev: gaps.some(g => g.d > 6 * 3600000) ? 'medium' : 'low', basis: 'derived',
    title: `Silent periods in CloudConnector log over ${fmtDur(opts.logGapMs)} (${gaps.length})`,
    detail: 'No log lines at all for this long — the process hung, the device was off, or logging stopped.',
    samples: gaps.sort((x, y) => y.d - x.d).map(g => sample(g.b, `${fmtDur(g.d)} with no log lines before this`)),
  });
  // Heartbeat: the connector runs a scheduled device sync on a fixed period (hourly)
  const hb = p.cc.filter(r => r.fn === 'doDeviceScheduledSync');
  if (hb.length >= 6) {
    const iv = [];
    for (let i = 1; i < hb.length; i++) iv.push(hb[i].t - hb[i - 1].t);
    const period = pct(iv, 50);
    const missed = [];
    for (let i = 1; i < hb.length; i++) if (iv[i - 1] > period * 1.6 && hb[i].file === hb[i - 1].file) missed.push({ r: hb[i], d: iv[i - 1] });
    ctx.summary.heartbeat = { period, count: hb.length, missed: missed.length };
    if (missed.length) mk(F, {
      id: 'delivery.heartbeat', cat: 'delivery', sev: missed.some(m => m.d > period * 4) ? 'medium' : 'low', basis: 'derived',
      title: `Missed scheduled device syncs (${missed.length})`,
      detail: `The connector's scheduled sync normally runs every ${fmtDur(period)}. These gaps mean the scheduler stalled, the process restarted, or the device was down.`,
      samples: missed.map(m => sample(m.r, `${fmtDur(m.d)} since previous scheduled sync`)),
    });
  }
  if (jumps.length) mk(F, {
    id: 'delivery.clock-jump', cat: 'delivery', sev: 'medium', basis: 'derived', title: `Clock went backwards in the log (${jumps.length})`,
    detail: 'Timestamps decreased between consecutive lines — NTP step correction or RTC reset.',
    samples: jumps.map(j => sample(j.b, `time stepped back ${fmtDur(-j.d)}`)),
  });

  // Restarts & FSM
  const starts = p.health.filter(r => /CloudConnector is starting/.test(r.msg));
  if (starts.length) mk(F, {
    id: 'delivery.restart', cat: 'delivery', sev: starts.length > 1 ? 'medium' : 'info', title: `CloudConnector restarts (${starts.length})`,
    samples: starts.map(r => sample(r)),
  });
  const ntpFail = p.health.filter(r => /NTP/.test(r.msg) && /fail|error|unable/i.test(r.msg));
  if (ntpFail.length) mk(F, { id: 'delivery.ntp', cat: 'delivery', sev: 'medium', title: `NTP sync failures (${ntpFail.length})`, samples: ntpFail.map(r => sample(r)) });

  // Sync durations
  const syncs = [...p.health, ...p.sync].map(r => ({ r, m: /Sync Done \[(?:(\d+)s)?(\d+)ms/.exec(r.msg) })).filter(x => x.m)
    .map(x => ({ r: x.r, ms: (+x.m[1] || 0) * 1000 + +x.m[2] }));
  const syncTimes = p.sync.map(r => ({ r, m: /finished in (\d+)ms/.exec(r.msg) })).filter(x => x.m).map(x => ({ r: x.r, ms: +x.m[1] }));
  if (syncs.length) {
    ctx.summary.sync = { count: syncs.length, p50: pct(syncs.map(s => s.ms), 50), max: Math.max(...syncs.map(s => s.ms)) };
    const slow = syncs.filter(s => s.ms > 30000);
    if (slow.length) mk(F, {
      id: 'delivery.sync-slow', cat: 'config', sev: 'medium', basis: 'derived', title: `Slow full controller syncs (${slow.length} over 30 s)`,
      samples: slow.map(s => sample(s.r)),
    });
    const daySpan = (p.health.length ? p.health[p.health.length - 1].t - p.health[0].t : 0) / 86400000;
    if (daySpan > 0 && syncs.length / daySpan > 4) mk(F, {
      id: 'config.sync-frequent', cat: 'config', sev: 'low', basis: 'derived',
      title: `Frequent full syncs (${syncs.length} in ${daySpan.toFixed(1)} days)`,
      detail: 'Each full sync rewrites configuration to the panel; frequent syncs usually follow reconnects or cloud-side changes.',
      samples: syncs.map(s => sample(s.r)),
    });
  }
  const slowSteps = syncTimes.filter(s => s.ms > 5000);
  if (slowSteps.length) mk(F, {
    id: 'config.sync-step-slow', cat: 'config', sev: 'low', basis: 'derived', title: `Slow sync steps (${slowSteps.length} over 5 s)`,
    samples: slowSteps.map(s => sample(s.r)),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// PANEL LINK (ASP SDK trace)
// ═════════════════════════════════════════════════════════════════════════════
function panel(ctx, F) {
  const { asp } = ctx.p;
  const frames = asp.frames;
  if (!frames.length) return;
  const aspsdk = require('./aspsdk');

  const ev = frames.filter(f => f.dir === 'E' && f.events && f.events.length);
  const recs = [];
  for (const f of ev) for (const r of f.events) recs.push({ ...r, t: f.t, file: f.file, line: f.line });
  const reconnectTimes = asp.notes.filter(n => /ASPSDK::Connect|Connecting to|keepalive/i.test(n.msg)).map(n => n.t);
  const nearReconnect = t => reconnectTimes.some(rt => Math.abs(rt - t) < 10 * 60000);

  // Serial continuity. Skips are normal (unsubscribed event classes); rewinds are replays.
  const big = [], replays = [];
  let skipped = 0, maxSerial = 0, cur = null, prev = null;
  for (const r of recs) {
    if (!r.serial) continue;                              // serial 0 = startup/status report
    if (maxSerial && r.serial <= maxSerial) {             // replay of already-seen events
      if (!cur) { cur = { from: r, to: r, n: 0, below: maxSerial }; replays.push(cur); }
      cur.to = r; cur.n++;
      continue;
    }
    cur = null;
    if (prev) {
      const d = r.serial - prev.serial;
      if (d > 1) { skipped += d - 1; if (d - 1 >= 10 || nearReconnect(r.t)) big.push({ a: prev, b: r, missing: d - 1 }); }
    }
    prev = r; maxSerial = r.serial;
  }
  ctx.summary.sdkSerial = { records: recs.length, skipped, replayEpisodes: replays.length, replayed: replays.reduce((s, x) => s + x.n, 0) };
  if (big.length) mk(F, {
    id: 'panel.event-gap', cat: 'panel', sev: 'high', basis: 'heuristic',
    title: `Large panel event serial gaps (${big.length}) — possible lost events`,
    detail: `Gaps of 10+ serials, or any gap within 10 min of an SDK reconnect/keepalive miss. Small skips (${skipped} serials over the whole trace) are normal — the controller also numbers event classes this host does not receive.`,
    samples: big.map(g => ({ t: g.b.t, file: g.b.file, line: g.b.line, text: `serial ${g.a.serial} → ${g.b.serial}: ${g.missing} skipped${nearReconnect(g.b.t) ? ' (near a reconnect)' : ''}` })),
  });
  if (replays.length) mk(F, {
    id: 'panel.serial-replay', cat: 'panel', sev: 'low', basis: 'derived',
    title: `Panel replayed already-delivered events (${replays.length} episode${replays.length > 1 ? 's' : ''}, ${replays.reduce((s, x) => s + x.n, 0)} events)`,
    detail: 'The event serial went back below the highest one already seen — after a reconnect the controller re-sends events. The cloud may receive duplicates.',
    samples: replays.map(x => ({ t: x.from.t, file: x.from.file, line: x.from.line, text: `${x.n} event(s), serials ${x.from.serial}…${x.to.serial}, after ${x.below} had been seen${nearReconnect(x.from.t) ? ' (right after a reconnect)' : ''}` })),
  });

  // Event ack: the host acks the last serial of each frame
  const acks = new Map();
  for (const f of frames) if (f.dir === 'S' && f.ackSerial != null && !acks.has(f.ackSerial)) acks.set(f.ackSerial, f);
  const ackLat = [];
  const unacked = [];
  for (const e of ev) {
    const a = acks.get(e.lastSerial);
    if (a && a.t >= e.t - 50) ackLat.push(a.t - e.t);
    if (!a || a.t - e.t > 5000) unacked.push({ e, a });
  }
  ctx.summary.sdkAck = { p50: pct(ackLat, 50), p95: pct(ackLat, 95) };
  if (unacked.length) mk(F, {
    id: 'panel.event-unacked', cat: 'panel', sev: unacked.length > 10 ? 'medium' : 'low', basis: 'derived',
    title: `Panel event frames not acknowledged within 5 s (${unacked.length} of ${ev.length})`,
    detail: `Typical ack time ${fmtDur(pct(ackLat, 50))}. An unacked event stays queued on the controller and is replayed later.`,
    samples: unacked.map(({ e, a }) => ({ t: e.t, file: e.file, line: e.line, text: `${e.evName} serial ${e.lastSerial} — ${a ? `acked after ${fmtDur(a.t - e.t)}` : 'never acked in trace'}` })),
  });

  // Commands / replies
  const pr = aspsdk.pairCommands(frames, ctx.opts.sdkReplyTimeoutMs);
  const lat = pr.pairs.map(x => x.latency);
  ctx.summary.sdk = {
    frames: frames.length, events: ev.length, commands: frames.filter(f => f.dir === 'S').length,
    replyP50: pct(lat, 50), replyP95: pct(lat, 95), replyMax: lat.length ? Math.max(...lat) : null,
    peers: [...new Set(frames.map(f => f.peer))],
  };
  if (pr.unanswered.length) mk(F, {
    id: 'panel.no-reply', cat: 'panel', sev: 'high', basis: 'derived', title: `SDK commands without a timely reply (${pr.unanswered.length})`,
    samples: pr.unanswered.map(u => ({ t: u.cmd.t, file: u.cmd.file, line: u.cmd.line, text: `${u.cmd.name} (${u.cmd.code}) — ${u.reason}` })),
  });
  const slow = pr.pairs.filter(x => x.latency > 1000);
  if (slow.length) mk(F, {
    id: 'panel.slow-reply', cat: 'panel', sev: 'low', basis: 'derived', title: `Slow SDK replies over 1 s (${slow.length})`,
    samples: slow.sort((a, b) => b.latency - a.latency).map(x => ({ t: x.cmd.t, file: x.cmd.file, line: x.cmd.line, text: `${x.cmd.name}: ${fmtDur(x.latency)}` })),
  });
  const badLen = frames.filter(f => f.ok && !f.lenOk);
  if (badLen.length) mk(F, {
    id: 'panel.malformed', cat: 'panel', sev: 'medium', basis: 'derived', title: `Malformed / truncated frames (${badLen.length})`,
    samples: badLen.map(f => ({ t: f.t, file: f.file, line: f.line, text: `${f.dirName} ${f.code}: declared ${f.declaredLen} bytes, got ${f.len}` })),
  });
  const unknown = frames.filter(f => f.conf === 'unknown' || (f.events || []).some(r => r.conf === 'unknown'));
  if (unknown.length) {
    const codes = {};
    for (const f of unknown) {
      if (f.conf === 'unknown') codes[`${f.dirName} ${f.code}`] = (codes[`${f.dirName} ${f.code}`] || 0) + 1;
      for (const r of (f.events || []).filter(x => x.conf === 'unknown')) codes[`event ${r.code}`] = (codes[`event ${r.code}`] || 0) + 1;
    }
    mk(F, {
      id: 'panel.unknown-codes', cat: 'panel', sev: 'info', basis: 'derived', title: `Undecoded SDK codes (${Object.keys(codes).length})`,
      detail: Object.entries(codes).map(([k, v]) => `${k} ×${v}`).join(', '),
      samples: unknown.map(f => ({ t: f.t, file: f.file, line: f.line, text: `${f.dirName} ${f.hex.slice(0, 120)}` })),
    });
  }

  // Keepalive misses, reconnects
  const ka = asp.notes.filter(n => /did not ACK the keepalive/i.test(n.msg));
  if (ka.length) mk(F, {
    id: 'panel.keepalive', cat: 'panel', sev: 'high', title: `Controller missed SDK keepalive (${ka.length})`,
    detail: 'The SDK link between Cloud Connector and the controller firmware stopped answering.', samples: ka.map(n => sample(n, n.msg)),
  });
  const rc = asp.notes.filter(n => /Connecting to .*reconnect|ASPSDK::Connect/i.test(n.msg));
  if (rc.length > 1) mk(F, {
    id: 'panel.reconnect', cat: 'panel', sev: 'medium', title: `SDK (re)connections to the controller (${rc.length})`,
    samples: rc.map(n => sample(n, n.msg)),
  });
  const errs = asp.notes.filter(n => /^(error|warning|fatal)$/i.test(n.level) || /\berror\b|fail/i.test(n.msg));
  if (errs.length) mk(F, { id: 'panel.sdk-errors', cat: 'panel', sev: 'medium', title: `SDK errors/warnings (${errs.length})`, samples: errs.map(n => sample(n, `<${n.level}> ${n.msg}`)) });

  // Peer IP change
  const peers = [];
  for (const f of frames) if (f.peer && (!peers.length || peers[peers.length - 1].ip !== f.peer)) peers.push({ ip: f.peer, f });
  if (peers.length > 1) mk(F, {
    id: 'panel.ip-change', cat: 'config', sev: 'low', title: `Controller SDK address changed (${peers.length - 1})`,
    detail: peers.map(x => x.ip).join(' → ') + '. Likely a DHCP lease change (hostname.conf shows DHCP).',
    samples: peers.map(x => ({ t: x.f.t, file: x.f.file, line: x.f.line, text: `talking to ${x.ip}` })),
  });

  // Panel event → cloud publish
  const rt = ctx.ev.rt;
  if (rt.length) {
    const ccStart = rt[0].t, ccEnd = rt[rt.length - 1].t;
    const missing = [], lagP = [];
    for (const e of recs) {
      // only high-confidence codes — medium ones map to several possible cloud events
      if (e.conf !== 'high' || !e.types.length || e.t < ccStart || e.t > ccEnd) continue;
      const m = rt.find(r => e.types.includes(r.type) && r.tEvent >= e.ctrlTime - 1500 && r.tEvent <= e.ctrlTime + 5000);
      if (!m) missing.push(e); else lagP.push(m.t - e.t);
    }
    if (lagP.length) ctx.summary.panelToCloud = { n: lagP.length, p50: pct(lagP, 50), p95: pct(lagP, 95), max: Math.max(...lagP) };
    const slowP = [];
    for (const e of recs) {
      if (e.conf !== 'high' || !e.types.length) continue;
      const m = rt.find(r => e.types.includes(r.type) && r.tEvent >= e.ctrlTime - 1500 && r.tEvent <= e.ctrlTime + 5000);
      if (m && m.t - e.t > 2000) slowP.push({ e, lag: m.t - e.t });
    }
    if (slowP.length) mk(F, {
      id: 'delivery.panel-to-cloud-slow', cat: 'delivery', sev: 'low', basis: 'derived',
      title: `Panel event → cloud publish over 2 s (${slowP.length})`,
      detail: `SDK event received → MQTT RealTime publish: median ${fmtDur(ctx.summary.panelToCloud.p50)}, p95 ${fmtDur(ctx.summary.panelToCloud.p95)}.`,
      samples: slowP.sort((a, b) => b.lag - a.lag).map(x => ({ t: x.e.t, file: x.e.file, line: x.e.line, text: `${x.e.name} published after ${fmtDur(x.lag)}` })),
    });
    if (missing.length) mk(F, {
      id: 'panel.event-not-published', cat: 'delivery', sev: 'medium', basis: 'heuristic',
      title: `Panel events with no matching cloud event (${missing.length})`,
      detail: 'The controller reported an event over the SDK, but no RealTime MQTT event of the matching type followed within 5 s.',
      samples: missing.map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.name}${e.point ? ' @ ' + e.point : ''} (serial ${e.serial})` })),
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CONFIG / SYNC — every ERROR & WARN signature, with known meanings
// ═════════════════════════════════════════════════════════════════════════════
const KNOWN = [
  { rx: /Automation triggered failed/, sev: 'info', cat: 'config', title: 'Automation lookup on every event (no automations configured)', note: 'Logged for every event because the trigger map is empty (automationIds.size() : 0). Expected when no automations exist — not a fault.', level: 'any' },
  { rx: /checkNUpdateDoorFPISchedule/, sev: 'low', cat: 'config', title: 'Door schedule evaluation logged at ERROR level', note: 'Reports schedule offset/isActive during normal evaluation; the ERROR level is misleading.' },
  { rx: /FloorId +not found in map/, sev: 'medium', cat: 'config', title: 'Permission references a floor that is not configured', note: 'Access permissions include a floor ID missing from the elevator map (elevator.json is empty). Elevator/floor permissions will not be applied.', fix: 'Remove the floor from the access profile or configure the elevator.' },
  { rx: /panel cjson object is NULL|Parse failed for panel/, sev: 'medium', cat: 'config', title: 'Panel object missing in sync payload', note: 'Controller sync received no panel section; panel-level settings were skipped.' },
  { rx: /ioPort not found/, sev: 'medium', cat: 'config', title: 'Reader configuration references an unknown I/O port', note: 'A reader payload points at an I/O port the controller does not have configured.' },
  { rx: /Failed to save configuration for zone/, sev: 'medium', cat: 'config', title: 'Zone configuration could not be saved', note: 'Zone state change happened but persisting it failed — the zone may revert after restart.' },
  { rx: /Pending for Camera Platform Package Update/, sev: 'info', cat: 'config', title: 'Camera platform package update pending', note: '' },
  { rx: /acs_entitlement is null|Applying the License/, sev: 'low', cat: 'config', title: 'Entitlement/license artifacts re-applied', note: '' },
  { rx: /IO config not found for IO/, sev: 'medium', cat: 'config', title: 'Events from an input that is not in the I/O configuration', note: 'The controller reports state for an I/O point (often alarm-input channel 0) that has no entry in ioconfig.json, so the connector drops it. Usually an unassigned/aux input wired on the panel, or a channel-numbering mismatch.' },
  { rx: /Found wrong reader state/, sev: 'medium', cat: 'config', title: 'Reader state reported for a reader index the connector does not know', note: 'CredentialReaderState arrived with a port/reader index that maps to no configured reader (e.g. PortIndex -1, ReaderIndex 3). Check the reader ports configured on the controller vs the cloud.' },
  { rx: /ParseCardHolderEventDetails.*attribute not found/, sev: 'low', cat: 'config', title: 'Access event without credential details', note: 'An AccessGranted/Denied event arrived without cardholder fields (ReaderIndex, CredentialHolderName, …). Normal for anonymous grants such as REX or schedule unlocks; a problem if it happens on card reads.', groupByFn: true },
  { rx: /AWS CA certificate file is not available|AmazonRootCACertBundle\.pem/, sev: 'low', cat: 'cloud', title: 'AWS CA certificate missing at start-up', note: 'The connector could not open its AWS root CA bundle while starting. If MQTT connected right after, it fell back to another trust store; if TLS errors follow, reinstall the Cloud Connector package.' },
  { rx: /(InputZone|OutputZone)\.json/, sev: 'info', cat: 'config', title: 'Zone configuration file absent', note: 'No input/output zones are configured for this controller, so the zone files do not exist yet. Expected unless zones were configured.', groupByFn: true },
  { rx: /Error in response: code: 8335|Failed to get Sync Object Detail/, sev: 'medium', cat: 'cloud', title: 'Cloud sync failed: "Failed to get Sync Object Detail" (8335)', note: 'The cloud backend returned error 8335 while the controller fetched a sync object; that object (e.g. zones) was not synced on this pass.', fix: 'Check whether the next sync succeeded; repeated 8335 errors are a cloud-side issue to report.' },
  { rx: /Invalid BE Response/, sev: 'low', cat: 'cloud', title: 'Sync retried after an invalid backend response', note: '' },
  { rx: /token expired, will be updated/, skip: true },
  { rx: /Unexpected MQTT disconnect/, skip: true },
];

function configSync(ctx, F) {
  const { p } = ctx;
  const live = [...p.cc, ...p.health, ...p.sync, ...p.other];
  const lower = { critical: 'high', high: 'medium', medium: 'low', low: 'info', info: 'info' };
  const groups = new Map();
  const add = (r, archived) => {
    const known = KNOWN.find(k => k.rx.test(`${r.fn} ${r.msg}`));
    const isProblem = r.level === 'ERROR' || r.level === 'WARN' || r.level === 'FATAL' || r.level === 'CRITICAL';
    if (!known && !isProblem) return;
    if (known && known.skip) return;
    if (known && known.level !== 'any' && !isProblem) return;
    // Same source line = same message template, whatever the variable parts say
    const key = (archived ? 'arch:' : '') + (known ? `known:${known.title}` : `${r.mod}:${r.fn}:${r.ln}`);
    if (!groups.has(key)) groups.set(key, { known, recs: [], sig: signature(r), level: r.level, archived, lines: new Set() });
    const g = groups.get(key);
    g.recs.push(r); g.lines.add(`${r.mod}:${r.fn}:${r.ln}`);
  };
  for (const r of live) add(r, false);
  for (const r of p.archived || []) add(r, true);
  let n = 0;
  for (const g of groups.values()) {
    const k = g.known;
    const base = k ? k.sev : (g.level === 'ERROR' || g.level === 'FATAL' ? 'medium' : 'low');
    const archNames = g.archived ? [...new Set(g.recs.map(r => r.archive))].join(', ') : '';
    mk(F, {
      id: `config.sig.${++n}`, cat: k ? k.cat : (/mqtt|http|cloud/i.test(g.sig) ? 'cloud' : 'config'),
      sev: g.archived ? lower[base] : base,
      title: `${k ? k.title : `${g.level}: ${g.sig.replace(/^[^:]+:[^:]+: /, '').slice(0, 90)}`} (${g.recs.length})${g.archived ? ' — archived logs' : ''}`,
      detail: (k ? k.note : `Unclassified ${g.level} message from ${g.recs[0].mod}:${g.recs[0].fn}${g.lines.size > 1 ? ` (${g.lines.size} source lines)` : ''}. Signature: ${g.sig}`)
        + (g.archived ? ` Seen only in archived snapshot(s): ${archNames}.` : ''),
      fix: k && k.fix ? k.fix : '', samples: g.recs.map(r => sample(r, g.archived ? `[${r.archive}] ${r.msg}` : undefined)), count: g.recs.length,
      times: g.recs.map(r => r.t),
    });
  }

  // Version drift between config snapshots
  const cfg = p.cfg;
  const v = {};
  const put = (k, val) => { if (val) v[k] = String(val); };
  const vc = (cfg['versions.conf'] || {}).json || {};
  const sc = (cfg['system.conf'] || {}).json || {};
  const cp = (((cfg['commonProperties.json'] || {}).json || {}).features || {}).firmwareDetails || {};
  put('versions.conf firmware', vc.firmwareVersion); put('versions.conf edgeapp', vc.edgeappVersion);
  put('system.conf firmware', sc.firmwareVersion); put('system.conf edgeapp', sc.edgeappVersion);
  put('commonProperties version', cp.version); put('commonProperties currVersion', cp.currVersion);
  ctx.summary.device = {
    model: sc.modelNumber || '', family: /^NHP/i.test(sc.modelNumber || '') ? 'Hanwha NHP' : /azure/i.test(sc.manufacturer || '') ? 'Azure Access' : (sc.manufacturer || ''), serial: sc.serialNo || '', mac: sc.macAddress || '', org: sc.orgShortName || '',
    firmware: vc.firmwareVersion || sc.firmwareVersion || '', edgeapp: vc.edgeappVersion || sc.edgeappVersion || '',
    hostname: ((cfg['hostname.conf'] || {}).json || {}).hostname || '', deviceId: ((cfg['device_status.conf'] || {}).json || {}).deviceId || '',
  };
  const fw = new Set([v['versions.conf firmware'], v['system.conf firmware'], v['commonProperties version']].filter(Boolean));
  const ea = new Set([v['versions.conf edgeapp'], v['system.conf edgeapp']].filter(Boolean));
  if (fw.size > 1 || ea.size > 1) mk(F, {
    id: 'config.version-drift', cat: 'config', sev: 'low', basis: 'derived',
    title: 'Version mismatch between configuration snapshots',
    detail: Object.entries(v).map(([a, b]) => `${a}: ${b}`).join(' · ') + '. A stale system.conf/commonProperties can make the cloud show the wrong firmware.',
    samples: [],
  });
  const fwHist = p.audit.filter(r => /firmware version/i.test(r.msg));
  const distinct = [...new Set(fwHist.map(r => r.msg))];
  if (distinct.length > 1) mk(F, {
    id: 'config.fw-change', cat: 'config', sev: 'info', title: `Firmware changed during audit history (${distinct.length} versions)`,
    samples: fwHist.filter((r, i, a) => i === 0 || a[i - 1].msg !== r.msg).map(r => sample(r)),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECURITY — secrets in logs and in the bundle
// ═════════════════════════════════════════════════════════════════════════════
const LEAK = [
  { rx: /"sessionToken"\s*:\s*"(?!\*{4})([^"]{20,})/, what: 'AWS S3 sessionToken' },
  { rx: /"secretAccessKey"\s*:\s*"(?!\*{4})([^"]{10,})/, what: 'AWS secretAccessKey' },
  { rx: /"accessKeyId"\s*:\s*"(?!\*{4})(A[SK]IA[A-Z0-9]{12,})/, what: 'AWS accessKeyId' },
  { rx: /"token"\s*:\s*"(?!\*{4})([^"]{20,})/, what: 'API/MQTT token' },
  { rx: /Bearer\s+([A-Za-z0-9._\-]{20,})/, what: 'Bearer token' },
  { rx: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/, what: 'JWT' },
  { rx: /(?:password|passwd|pwd)\s*[:=]\s*"?(?!\*{4})([^\s",]{4,})/i, what: 'password' },
  { rx: /\bPASS:\s*(?!\*{4})\S{8,}/, what: 'MQTT/API password' },
  { rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key' },
];

function security(ctx, F) {
  const { p } = ctx;
  const all = [...p.cc, ...p.health, ...p.sync, ...p.audit, ...p.other, ...(p.archived || [])];
  const hits = {};
  for (const r of all) {
    for (const L of LEAK) {
      if (L.rx.test(r.msg)) (hits[L.what] = hits[L.what] || []).push(r);
    }
  }
  for (const [what, recs] of Object.entries(hits)) {
    mk(F, {
      id: `security.leak.${what.replace(/\W+/g, '-').toLowerCase()}`, cat: 'security', sev: /secret|session|private|password/i.test(what) ? 'critical' : 'high',
      title: `${what} written to logs in plaintext (${recs.length})`,
      detail: `Logged in clear text${recs.some(r => r.archive) ? ` — including archived snapshot(s) ${[...new Set(recs.filter(r => r.archive).map(r => r.archive))].join(', ')}` : ''}. Anyone with the log bundle can use it while it is valid. Origin: ${[...new Set(recs.map(r => `${r.mod}:${r.fn}`))].join(', ')}.${/session|token|JWT/i.test(what) ? ' Other secrets in the same messages are masked as ****.' : ''}`,
      fix: 'Mask this field in the connector\'s debug logging; treat existing bundles as sensitive and avoid sharing them outside the team.',
      samples: recs.map(r => sample(r)), count: recs.length,
    });
  }
  // Credential-bearing files inside the bundle
  const credFiles = [];
  for (const [name, c] of Object.entries(p.cfg)) {
    if (!c.raw) continue;
    for (const L of LEAK) if (L.rx.test(c.raw)) { credFiles.push({ name, rel: c.rel, what: L.what }); break; }
  }
  if (credFiles.length) mk(F, {
    id: 'security.bundle-creds', cat: 'security', sev: 'high', title: `Bundle contains credential files (${credFiles.length})`,
    detail: credFiles.map(c => `${c.rel} (${c.what})`).join(', '),
    fix: 'Handle this bundle as confidential.', samples: [],
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// STATISTICAL — rare messages and volume spikes
// ═════════════════════════════════════════════════════════════════════════════
function statistical(ctx, F) {
  const { p } = ctx;
  const sig = new Map();
  for (const r of p.cc) {
    const s = signature(r);
    if (!sig.has(s)) sig.set(s, []);
    sig.get(s).push(r);
  }
  const total = p.cc.length;
  if (total > 500) {
    const rare = [...sig.values()].filter(l => l.length <= 2 && !['ERROR', 'WARN'].includes(l[0].level))
      .filter(l => !/send_event_over_mqtt|publish_backend_api_token|S3 expiry|getItems/.test(l[0].fn + l[0].msg));
    if (rare.length) mk(F, {
      id: 'stat.rare', cat: 'config', sev: 'info', basis: 'heuristic', title: `Rare log messages (${rare.length} seen at most twice)`,
      detail: 'Messages that almost never occur in this bundle. Usually one-off state changes worth a glance.',
      samples: rare.slice(0, 40).map(l => sample(l[0])), count: rare.length,
    });
  }
  // Hourly event volume spikes
  const hours = new Map();
  for (const e of ctx.ev.rt) { const h = Math.floor(e.tEvent / 3600000); hours.set(h, (hours.get(h) || 0) + 1); }
  const vals = [...hours.values()];
  if (vals.length >= 12) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    const spikes = [...hours.entries()].filter(([, n]) => (n - mean) / sd > 3 && n >= 20);
    if (spikes.length) mk(F, {
      id: 'stat.spike', cat: 'door', sev: 'low', basis: 'heuristic', title: `Event volume spikes (${spikes.length} hours > 3σ)`,
      detail: `Typical ${mean.toFixed(1)} events/hour.`,
      samples: spikes.map(([h, n]) => ({ t: h * 3600000, file: '', line: 0, text: `${n} events in this hour` })),
    });
  }
  ctx.summary.hourly = [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => ({ t: h * 3600000, n }));
}

// ═════════════════════════════════════════════════════════════════════════════
// NHP PANEL FEED (Monitor Diff events with the controller's own UTC timestamps)
// ═════════════════════════════════════════════════════════════════════════════
function nhpPanel(ctx, F) {
  const pe = ctx.ev.panel || [];
  if (!pe.length) return;
  const rt = ctx.ev.rt;
  const timed = pe.filter(e => e.hasTime);

  // Controller event → connector received (log) and → cloud published
  // State snapshots replayed at connect carry the time of the last change, not a delivery delay
  const live = timed.filter(e => e.logT - e.t < 10 * 60000);
  const recv = live.map(e => e.logT - e.t);
  ctx.summary.nhpFeed = { events: pe.length, recvP50: pct(recv, 50), recvP95: pct(recv, 95), recvMax: recv.length ? Math.max(...recv) : null };
  const lateRecv = live.filter(e => e.logT - e.t > 2000);
  if (lateRecv.length) mk(F, {
    id: 'panel.nhp-feed-late', cat: 'delivery', sev: lateRecv.some(e => e.logT - e.t > 10000) ? 'medium' : 'low', basis: 'derived',
    title: `Controller events reached the connector late (${lateRecv.length} over 2 s)`,
    detail: `Controller event time → Cloud Connector received: median ${fmtDur(pct(recv, 50))}, p95 ${fmtDur(pct(recv, 95))}. Batches that arrive late are usually a re-subscribe after reconnect or a busy controller.`,
    samples: lateRecv.sort((a, b) => (b.logT - b.t) - (a.logT - a.t)).map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.name} ${JSON.stringify(e.data)} received ${fmtDur(e.logT - e.t)} later` })),
  });
  // Clock: an event can't be received before it happened
  const early = timed.filter(e => e.t - e.logT > 2000);
  if (early.length) mk(F, {
    id: 'panel.nhp-clock', cat: 'delivery', sev: 'medium', basis: 'derived',
    title: `Controller clock ahead of connector log clock (${early.length})`,
    detail: `Event timestamps are up to ${fmtDur(Math.max(...early.map(e => e.t - e.logT)))} later than the line that received them. Either the controller and the connector disagree on time, or timezone.json does not match the log's local time.`,
    samples: early.map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.name}: event ${fmtDur(e.t - e.logT)} after it was logged` })),
  });

  // Every mappable controller event should become a cloud RealTime event
  if (rt.length) {
    const lo = rt[0].t - 60000, hi = rt[rt.length - 1].t + 60000;
    const used = new Set(), missing = [], lag = [];
    for (const e of pe) {
      if (!e.types.length || e.logT < lo || e.logT > hi) continue;
      const i = rt.findIndex((r, k) => !used.has(k) && e.types.some(x => x.endsWith('*') ? r.type.startsWith(x.slice(0, -1)) : r.type === x)
        && r.t >= e.logT - 1000 && r.t - e.logT <= 5000);
      if (i < 0) missing.push(e); else { used.add(i); lag.push(rt[i].t - e.t); }
    }
    if (lag.length) ctx.summary.panelToCloud = { n: lag.length, p50: pct(lag, 50), p95: pct(lag, 95), max: Math.max(...lag) };
    const anon = missing.filter(e => e.name === 'AccessControl.AccessGranted' && e.data && e.data.Type === 'Anonymous');
    if (anon.length) mk(F, {
      id: 'panel.nhp-anon-grant', cat: 'delivery', sev: 'low', basis: 'derived',
      title: `Anonymous access grants not published as accessgranted (${anon.length})`,
      detail: 'Grants with Type "Anonymous" (REX / free-access) were not sent to the cloud as accessgranted. The cloud may rely on rexactivated instead — confirm this is the intended behavior.',
      samples: anon.map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.name} ${e.src} ${JSON.stringify(e.data)}` })),
    });
    missing.splice(0, missing.length, ...missing.filter(e => !anon.includes(e)));
    if (missing.length) mk(F, {
      id: 'panel.nhp-not-published', cat: 'delivery', sev: 'high', basis: 'derived',
      title: `Controller events never published to the cloud (${missing.length})`,
      detail: 'The NHP reported these events to the connector, but no matching RealTime MQTT event followed within 5 s.',
      samples: missing.map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.name} ${e.src} ${JSON.stringify(e.data)} → expected ${e.types.join('/')}` })),
    });
  }

  // Reader offline periods
  const rd = pe.filter(e => e.name === 'AccessControl.CredentialReaderState');
  const off = [];
  for (const e of rd.filter(x => x.data.State === 'Offline')) {
    const back = rd.find(x => x.src === e.src && x.t > e.t && x.data.State !== 'Offline');
    off.push({ e, dur: back ? back.t - e.t : null });
  }
  const blips = off.length && off.every(o => o.dur != null && o.dur < 5000);
  const tod = {};
  for (const o of off) { const k = require('./time').fmtLocal(o.e.t, ctx.p.zone.tz).slice(11, 16); tod[k] = (tod[k] || 0) + 1; }
  const daily = Object.entries(tod).sort((a, b) => b[1] - a[1])[0];
  if (off.length) mk(F, {
    id: 'panel.reader-offline', cat: 'door', sev: off.some(o => o.dur == null || o.dur > 60000) ? 'high' : blips ? 'low' : 'medium', basis: 'confirmed',
    title: blips ? `Reader blinked offline for under 5 s (${off.length})` : `Reader went offline (${off.length})`,
    detail: (blips ? 'Each outage lasted under 5 seconds' : 'The controller lost its reader (OSDP/Wiegand). Credentials presented while offline are not read')
      + (daily && daily[1] >= 3 ? `; ${daily[1]} of ${off.length} happen around ${daily[0]} local — a scheduled re-init or sync, not wiring.` : '.'),
    fix: 'Check reader wiring, power and OSDP address/baud; correlate with reader tamper/power events.',
    samples: off.map(o => ({ t: o.e.t, file: o.e.file, line: o.e.line, text: `${o.e.src} offline ${o.dur == null ? '— no recovery in log' : `for ${fmtDur(o.dur)}`}` })),
  });

  // Case tamper
  const tamper = pe.filter(e => e.name === 'SystemEvent.CaseTampering' && e.data.State === true);
  if (tamper.length) mk(F, {
    id: 'security.case-tamper', cat: 'security', sev: 'medium', basis: 'confirmed', title: `Controller case tamper (${tamper.length})`,
    samples: tamper.map(e => ({ t: e.t, file: e.file, line: e.line, text: 'SystemEvent.CaseTampering = true' })),
  });

  // Every door open was forced — no valid access preceded any of them
  const opens = pe.filter(e => e.name === 'AccessControl.DoorPhysicalState' && e.data.DoorPhysicalState === 'Open');
  const forced = pe.filter(e => e.name === 'AccessControl.DoorAlarmState' && e.data.Status === 'DoorForcedOpen');
  if (opens.length >= 5 && forced.length / opens.length > 0.8) mk(F, {
    id: 'door.all-forced', cat: 'door', sev: 'medium', basis: 'derived',
    title: `${forced.length} of ${opens.length} door opens were forced`,
    detail: 'Almost every door open had no grant, REX or unlock before it. On a test rig that drives the door contact this is expected; on a real door it means the lock is not holding or the DPS is miswired.',
    samples: forced.slice(0, 5).map(e => ({ t: e.t, file: e.file, line: e.line, text: `${e.src} forced open` })),
  });

  // Inputs toggling on unconfigured channels (feeds the "IO config not found" errors)
  const ai = pe.filter(e => e.name === 'AlarmInput');
  if (ai.length) {
    const byCh = {};
    for (const e of ai) byCh[e.src] = (byCh[e.src] || 0) + 1;
    ctx.summary.nhpAlarmInputs = byCh;
  }
  const mix = {};
  for (const e of pe) mix[e.name] = (mix[e.name] || 0) + 1;
  ctx.summary.nhpEventMix = mix;
}

// Archived snapshots and audit-log restarts
function history(ctx, F) {
  const { p } = ctx;
  const arch = Object.values(p.archives || {});
  if (arch.length) mk(F, {
    id: 'config.archives', cat: 'config', sev: 'info', basis: 'confirmed', title: `Archived log snapshots in the bundle (${arch.length})`,
    detail: 'Older log sets kept by the controller. They are scanned for errors and leaked secrets (findings marked "archived logs") but kept out of the live timeline.',
    samples: arch.sort((a, b) => (a.from || 0) - (b.from || 0)).map(a => ({ t: a.from, file: a.name, line: 0, text: `${a.name}: ${a.records} lines, ${a.from ? new Date(a.from).toISOString().slice(0, 10) : '?'} → ${a.to ? new Date(a.to).toISOString().slice(0, 10) : '?'}` })),
  });
  const starts = p.audit.filter(r => /CloudConnector application started/.test(r.msg));
  if (starts.length) mk(F, {
    id: 'delivery.app-starts', cat: 'delivery', sev: 'info', basis: 'confirmed', title: `Cloud Connector application starts in audit history (${starts.length})`,
    detail: 'Each start is a reboot, an app update or a crash/restart. Starts minutes apart usually mean a crash loop or an install.',
    samples: starts.map(r => sample(r)),
  });
}

const RULES = [cloud, door, delivery, panel, nhpPanel, history, configSync, security, statistical];
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function runAll(ctx) {
  const F = [];
  for (const rule of RULES) {
    try { rule(ctx, F); } catch (e) {
      F.push({ id: `internal.${rule.name}`, cat: 'config', sev: 'info', title: `Rule "${rule.name}" could not run`, detail: e.message, basis: 'derived', count: 0, samples: [], first: null, last: null });
    }
  }
  F.sort((a, b) => (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || (b.count - a.count));
  try { require('./playbook').explain(F, ctx); } catch (e) { console.warn('[Analytics] playbook failed:', e.message); }
  return F;
}

module.exports = { runAll, redact, SEV_ORDER, MOSQ };
