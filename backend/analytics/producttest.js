// analytics/producttest.js — map Aether's journal (what was triggered) against the
// controller's logs (what was received) and grade every action.
//
// Time base: journal entries are Pi epoch ms; controller RealTime events carry their
// own epoch-ms timestamp in the payload ("t"), and log lines are converted from panel
// local time with timezone.json. No skew correction is applied (by design); clocks are
// assumed NTP-synced. `earlyToleranceMs` only absorbs timestamp resolution.
//
// Wiring map (optional, per channel key):
//   { "relay:6": { role: "dps", door: "<doorId>", active: "open" }, "emu:2:in:3": { role: "rex" }, ... }
// role: dps · rex · card · keypad · lock · input · output · ignore
// Channels without a mapping get a role inferred from co-occurrence (marked auto).
'use strict';

const { fmtDur } = require('./time');

const DRIVE_KINDS = new Set(['relay', 'gpio', 'emu-in']);
const OBSERVE_KINDS = new Set(['opto', 'emu-out']);

// Controller event types that are side-effects of an expected event (not "unsolicited")
const FOLLOW_ON = {
  accessgranted: ['unlocked', 'locked', 'open', 'closed', 'doorheldcleared'],
  rexactivated: ['unlocked', 'locked', 'rexdeactivated'],
  open: ['dooropentoolong', 'doorheldcleared', 'locked'],
  closed: ['locked', 'doorheldcleared', 'doorforcedcleared'],
  doorforcedopen: ['doorforcedcleared'],
  dooropentoolong: ['doorheldcleared', 'closed'],
  unlocked: ['locked', 'open', 'closed'],
  rexdeactivated: ['locked'],
};

/** What the controller should log for a journal entry under a role. */
function expectFor(entry, role, opt = {}) {
  const v = entry.v ? 1 : 0;
  switch (role) {
    case 'dps': {
      const openWhen = opt.active === 'closed' ? 0 : 1;
      return v === openWhen ? { dir: 'after', types: ['open', 'doorforcedopen'], label: 'door open' }
        : { dir: 'after', types: ['closed'], label: 'door closed' };
    }
    case 'rex': return v ? { dir: 'after', types: ['rexactivated'], label: 'REX activated' } : { dir: 'after', types: ['rexdeactivated'], label: 'REX released' };
    case 'card': case 'keypad': {
      const want = entry.m && entry.m.expect;
      const types = want === 'grant' ? ['accessgranted'] : want === 'deny' ? ['accessdenied*'] : ['accessgranted', 'accessdenied*'];
      return { dir: 'after', types, label: want ? `access ${want}` : 'access decision' };
    }
    case 'lock': return v ? { dir: 'before', types: ['unlocked'], label: 'controller unlocked (seen by Aether)' } : { dir: 'before', types: ['locked'], label: 'controller locked (seen by Aether)' };
    case 'input': return { dir: 'after', types: ['@io'], label: `input event${opt.ioId ? ' on ' + opt.ioId : ''}`, ioId: opt.ioId };
    case 'output': return { dir: 'before', types: ['@relay'], label: `output change${opt.ioId ? ' on ' + opt.ioId : ''}`, ioId: opt.ioId };
    default: return null;
  }
}

const typeMatch = (t, list) => list.some(x => x.endsWith('*') ? t.startsWith(x.slice(0, -1)) : t === x);

function buildPool(ev) {
  const pool = ev.rt.map((e, i) => ({ i, t: e.tEvent, type: e.type, src: e.srcId, port: e.ioPort, lag: e.lagMs, file: e.file, line: e.line, used: false }));
  const io = ev.io.filter(x => x.kind === 'event').map((x, i) => ({ i, t: x.t, type: '@io', id: x.id, reason: x.reason, file: x.file, line: x.line, used: false }));
  const relay = ev.relay.map((x, i) => ({ i, t: x.t, type: '@relay', id: x.id, to: x.to, file: x.file, line: x.line, used: false }));
  const byT = (a, b) => a.t - b.t;
  return { rt: pool.sort(byT), io: io.sort(byT), relay: relay.sort(byT) };
}

/** Try to match one action; returns the candidate or null. */
function findMatch(pool, entry, exp, opts, door, dryRun) {
  const list = exp.types[0] === '@io' ? pool.io : exp.types[0] === '@relay' ? pool.relay : pool.rt;
  let lo, hi;
  if (exp.dir === 'after') { lo = entry.t - opts.earlyToleranceMs; hi = entry.t + opts.matchWindowMs; }
  else { lo = entry.t - opts.matchWindowMs; hi = entry.t + opts.earlyToleranceMs; }
  let best = null;
  for (const c of list) {
    if (c.t < lo) continue;
    if (c.t > hi) break;
    if (c.used) continue;
    if (exp.types[0][0] === '@') {
      if (exp.ioId && !String(c.id).includes(exp.ioId.replace(/^.*#(input_|output_)?/, ''))) continue;
    } else {
      if (!typeMatch(c.type, exp.types)) continue;
      if (door && c.src && c.src !== door) continue;
    }
    if (!best || (exp.dir === 'after' ? c.t < best.t : c.t > best.t)) best = c;
    if (exp.dir === 'after') break;     // earliest after is best
  }
  if (best && !dryRun) best.used = true;
  return best;
}

/** Infer a role for an unmapped channel by trying each candidate and counting matches. */
function inferRole(entries, pool, opts) {
  const kind = entries[0].k;
  if (kind === 'card') return { role: 'card', auto: true, score: 1 };
  if (kind === 'keypad') return { role: 'keypad', auto: true, score: 1 };
  const cands = DRIVE_KINDS.has(kind)
    ? [['dps', { active: 'open' }], ['dps', { active: 'closed' }], ['rex', {}], ['input', {}]]
    : OBSERVE_KINDS.has(kind) ? [['lock', {}], ['output', {}]] : [];
  let best = null;
  for (const [role, opt] of cands) {
    let hit = 0;
    for (const e of entries) {
      const exp = expectFor(e, role, opt);
      if (exp && findMatch(pool, e, exp, opts, null, true)) hit++;
    }
    const score = hit / entries.length;
    // prefer specific door roles over generic I/O when equally good
    const rank = score + (role === 'input' || role === 'output' ? -0.05 : 0);
    if (!best || rank > best.rank) best = { role, ...opt, auto: true, score, rank };
  }
  if (!best || best.score < 0.5) return { role: 'unmapped', auto: true, score: best ? best.score : 0 };
  delete best.rank;
  return best;
}

function correlate({ journal, ev, p, opts, wiring = {}, doors = {} }) {
  const o = { matchWindowMs: Math.max(opts.latencyFailMs * 3, 5000), ...opts };
  const actions = journal.filter(e => e.k !== 'marker').sort((a, b) => a.t - b.t);
  const markers = journal.filter(e => e.k === 'marker');
  const res = { window: null, coverage: 'none', roles: {}, results: [], unsolicited: [], runs: [], summary: {}, notes: [] };
  if (!actions.length) { res.notes.push('The journal has no actions to test.'); return res; }

  res.window = { from: actions[0].t, to: actions[actions.length - 1].t };
  const ccFrom = p.cc.length ? p.cc[0].t : null, ccTo = p.cc.length ? p.cc[p.cc.length - 1].t : null;
  if (ccFrom == null) res.notes.push('The bundle has no CloudConnector log — nothing to compare against.');
  else if (res.window.to < ccFrom || res.window.from > ccTo) {
    res.coverage = 'none';
    res.notes.push(`The controller logs (${new Date(ccFrom).toISOString()} → ${new Date(ccTo).toISOString()}) do not overlap the test window. Export the controller logs right after the test so the rotating logs still contain it.`);
  } else res.coverage = res.window.from >= ccFrom && res.window.to <= ccTo ? 'full' : 'partial';

  const pool = buildPool(ev);

  // Roles per channel
  const byCh = new Map();
  for (const a of actions) { if (!byCh.has(a.ch)) byCh.set(a.ch, []); byCh.get(a.ch).push(a); }
  for (const [ch, list] of byCh) {
    const w = wiring[ch];
    res.roles[ch] = w && w.role ? { ...w, auto: false } : inferRole(list, pool, o);
    res.roles[ch].kind = list[0].k;
    res.roles[ch].count = list.length;
  }

  // Grade, in time order (so each controller event is consumed once)
  for (const a of actions) {
    const role = res.roles[a.ch];
    const row = { t: a.t, ch: a.ch, k: a.k, v: a.v, src: a.src, m: a.m || null, run: a.run || null, role: role.role, auto: !!role.auto };
    const covered = ccFrom != null && a.t >= ccFrom - 1000 && a.t <= ccTo + 1000;
    if (role.role === 'ignore') { row.status = 'skip'; row.note = 'channel ignored in wiring map'; res.results.push(row); continue; }
    if (role.role === 'unmapped') { row.status = 'unmapped'; row.note = 'no controller reaction matched this channel — set its role in the wiring map'; res.results.push(row); continue; }
    const exp = expectFor(a, role.role, role);
    if (!exp) { row.status = 'skip'; res.results.push(row); continue; }
    row.expect = exp.label; row.expectTypes = exp.types;
    if (!covered) { row.status = 'no-data'; row.note = 'outside the controller log window'; res.results.push(row); continue; }
    const doorId = role.door || null;
    const m = findMatch(pool, a, exp, o, doorId, false);
    if (!m) {
      row.status = 'fail'; row.note = `controller never logged ${exp.label} within ${fmtDur(o.matchWindowMs)}`;
    } else {
      const lat = exp.dir === 'after' ? m.t - a.t : a.t - m.t;
      row.latency = lat;
      row.matched = { type: m.type === '@io' ? `input ${m.id} (${m.reason})` : m.type === '@relay' ? `relay ${m.id} ${m.to}` : m.type, t: m.t, file: m.file, line: m.line, publishLag: m.lag != null ? m.lag : null };
      if (exp.types.includes('doorforcedopen') && m.type === 'doorforcedopen') row.note = 'controller reported FORCED OPEN (no grant/REX/unlock before the door opened)';
      if (lat > o.latencyFailMs) { row.status = 'fail'; row.note = `${exp.label} after ${fmtDur(lat)} (limit ${fmtDur(o.latencyFailMs)})`; }
      else if (lat > o.latencyWarnMs) { row.status = 'warn'; row.note = row.note || `${exp.label} after ${fmtDur(lat)}`; }
      else row.status = 'pass';
      if (row.status === 'pass' && m.lag != null && m.lag > o.publishWarnMs) { row.status = 'warn'; row.note = `cloud publish took ${fmtDur(m.lag)}`; }
    }
    res.results.push(row);
  }

  // Controller events in the window that no action explains
  const consumed = pool.rt.filter(c => c.used);
  const lo = res.window.from - 2000, hi = res.window.to + o.latencyFailMs;
  for (const c of pool.rt) {
    if (c.used || c.t < lo || c.t > hi) continue;
    const explained = consumed.some(u => (FOLLOW_ON[u.type] || []).includes(c.type) && c.t >= u.t && c.t - u.t < 120000)
      || pool.rt.some(u => u !== c && (FOLLOW_ON[u.type] || []).includes(c.type) && c.t >= u.t && c.t - u.t < 120000 && u.t >= lo);
    const sev = /forced|denied/.test(c.type) ? 'high' : explained ? 'info' : 'medium';
    res.unsolicited.push({ t: c.t, type: c.type, src: c.src, port: c.port, file: c.file, line: c.line, explained, sev });
  }

  // Per-run summary
  const runIds = [...new Set(actions.map(a => a.run).filter(Boolean))];
  const runMeta = id => { const s = markers.find(mk => mk.run === id && mk.m && mk.m.event === 'run-start'); return s ? s.m.name : id; };
  const tally = rows => {
    const c = { pass: 0, warn: 0, fail: 0, unmapped: 0, 'no-data': 0, skip: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    const lats = rows.map(r => r.latency).filter(x => x != null).sort((a, b) => a - b);
    c.latencyP50 = lats.length ? lats[Math.floor(lats.length / 2)] : null;
    c.latencyP95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : null;
    c.latencyMax = lats.length ? lats[lats.length - 1] : null;
    c.verdict = c.fail ? 'FAIL' : c.warn ? 'PASS WITH WARNINGS' : c.pass ? 'PASS' : 'NO RESULT';
    return c;
  };
  res.summary = tally(res.results);
  res.summary.unsolicited = res.unsolicited.filter(u => !u.explained).length;
  res.summary.actions = actions.length;
  res.runs = runIds.map(id => ({ id, name: runMeta(id), ...tally(res.results.filter(r => r.run === id)) }));
  res.thresholds = { latencyWarnMs: o.latencyWarnMs, latencyFailMs: o.latencyFailMs, matchWindowMs: o.matchWindowMs, earlyToleranceMs: o.earlyToleranceMs, publishWarnMs: o.publishWarnMs };
  res.doorNames = Object.fromEntries(Object.entries(doors).map(([id, d]) => [id, d.name]));
  return res;
}

module.exports = { correlate, expectFor, inferRole };
