// trace/correlate.js — follow what Aether did (and what was done to the door) through the controller to the cloud.
//                                                                                                     AETHER_TRACE
// Four kinds of trace, one engine:
//   card     Aether presented a card / PIN                 → the controller's decision
//   input    Aether drove a controller input (DPS, REX, …) → the controller's door / input event
//   output   Aether saw a controller output change (strike, relay) → what caused it, when the controller
//            reported it, how long it stayed on
//   command  a command to OnCAFE (sent by Aether, or seen in Traffic Inspector / a HAR) → the controller's
//            event → the door state in the cloud → Aether seeing the output
//
// Clocks. Journal, wire, cloud push, API poll and Aether-sent commands are stamped on the Pi, so Pi-to-Pi
// hops need no correction. Event timestamps (eventTimestamp, controller logs) are on the controller's clock;
// sync markers (two cards, or a DPS/input pulse) give offset = controllerTime − piTime and the drift.
//
// Wiring map (shared with Log Analytics › Product Test, backend/data/analytics/settings.json "wiring"):
//   { "relay:6": { role: "dps", door: "<doorId>", active: "open" }, "opto:2": { role: "lock", door: "<doorId>" }, … }
//   roles: dps · rex · input (Aether → controller) · lock · output (controller → Aether) · card · keypad · ignore
// Unmapped channels get a role inferred from what the controller reported around them (≥ 50 % agreement).
'use strict';

const num = v => (v === undefined || v === null || v === '' ? null : String(v).replace(/^0+(?=\d)/, ''));
const credEq = (a, b) => !!(a && b && num(a.cn) !== null && num(a.cn) === num(b.cn) && (num(a.fc) === null || num(b.fc) === null || num(a.fc) === num(b.fc)));
const credKey = c => (c ? `${num(c.fc) ?? '?'}-${num(c.cn) ?? '?'}` : '');
const DRIVE = new Set(['relay', 'gpio', 'emu-in']);
const OBSERVE = new Set(['opto', 'emu-out']);

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function statsOf(arr) {
  const a = arr.filter(x => Number.isFinite(x));
  return a.length ? { n: a.length, min: Math.min(...a), p50: pct(a, 0.5), p95: pct(a, 0.95), max: Math.max(...a) } : { n: 0 };
}
const median = a => pct(a, 0.5);
const typeIn = (t, list) => list.some(x => (x.endsWith('*') ? t.startsWith(x.slice(0, -1)) : t === x));

/** What the controller should report for a journal edge under a role. */
function expectFor(e, role, opt = {}) {
  const v = e.journal ? e.journal.v : e.info && e.info.v;
  switch (role) {
    case 'dps': {
      const openWhen = opt.active === 'closed' ? 0 : 1;
      return v === openWhen ? { types: ['open', 'doorforcedopen', 'dooropen'], label: 'door open' } : { types: ['closed', 'doorclosed'], label: 'door closed' };
    }
    case 'rex': return v ? { types: ['rexactivated'], label: 'REX activated' } : { types: ['rexdeactivated'], label: 'REX released' };
    case 'input': return { types: v ? ['io-active', 'inputactive', '*active', 'alarm*', 'zone*'] : ['io-inactive', 'io-normal', 'inputnormal', '*normal', '*inactive'], label: `input ${v ? 'active' : 'normal'}`, io: true };
    case 'lock': return v ? { types: ['unlocked', 'doorunlocked'], label: 'controller unlocked', before: true } : { types: ['locked', 'doorlocked'], label: 'controller locked', before: true };
    case 'output': return { types: v ? ['io-active', 'activated', 'outputactive', 'relayon', '*activated'] : ['io-inactive', 'deactivated', 'outputinactive', 'relayoff', '*deactivated'], label: `output ${v ? 'on' : 'off'}`, before: true, io: true };
    default: return null;
  }
}
/** What the controller should report after a cloud command. */
function expectForCommand(c) {
  const v = c.value;
  switch (c.kind) {
    case 'override': return { types: v === 'lock' ? ['locked', 'temporaryoverride*'] : ['unlocked', 'temporaryoverride*', 'doorunlocked'], label: `temporary ${v || 'unlock'}`, lockTo: v === 'lock' ? 0 : 1 };
    case 'override-cancel': return { types: ['locked', 'temporaryoverride*'], label: 'override cancelled', lockTo: 0 };
    case 'lockdown': return { types: ['lockdown*', 'arealockdown*'], label: v ? 'lockdown on' : 'lockdown off', lockTo: v ? 0 : null };
    case 'maintenance': return { types: ['maintenancemode*'], label: v ? 'maintenance on' : 'maintenance off' };
    case 'shunt': return { types: v ? ['readershunted'] : ['readerunshunted'], label: v ? 'reader shunted' : 'reader unshunted' };
    case 'outputzone': return { types: v === 'activate' ? ['activated', '*activated'] : ['deactivated', '*deactivated'], label: `output zone ${v}`, outTo: v === 'activate' ? 1 : 0 };
    case 'inputzone': return { types: [`${v}*`, `*${v}ed`, `*${v}`], label: `input zone ${v}` };
    default: return { types: [], label: c.kind };
  }
}

/** Group copies of one controller event (same eventId, or same type+time). Door-state snapshots are separate. */
function groupEvents(events) {
  const groups = new Map();
  for (const e of events) {
    if (!(e.lane === 'cloud' || e.lane === 'controller') || e.type === 'door-state' || e.type === 'command' || e.src === 'command') continue;
    const k = e.eventId ? `id:${e.eventId}:${e.type}` : `t:${e.type}:${e.t}:${credKey(e.cred)}:${e.door && e.door.id || ''}`;
    let g = groups.get(k);
    if (!g) { g = { key: k, type: e.type, t: e.t, cred: null, door: null, access: !!e.access, trigger: null, clientType: null, ioId: null, copies: [] }; groups.set(k, g); }
    g.copies.push(e);
    if (!g.cred && e.cred) g.cred = e.cred;
    if (!g.door && e.door) g.door = e.door;
    if (g.t == null && e.t != null) g.t = e.t;
    if (!g.trigger && e.info && e.info.trigger) g.trigger = e.info.trigger;
    if (!g.clientType && e.clientType) g.clientType = e.clientType;
    if (!g.ioId && e.info && e.info.ioId) g.ioId = e.info.ioId;
    if (e.clock === 'cloud') g.cloudClock = true;
  }
  const out = [...groups.values()];
  for (const g of out.filter(x => x.copies.every(c => c.src === 'controller'))) {
    const twin = out.find(h => h !== g && h.type === g.type && h.t != null && g.t != null && Math.abs(h.t - g.t) <= 50 && h.copies.some(c => c.src !== 'controller'));
    if (twin) { twin.copies.push(...g.copies); g.merged = true; }
  }
  return out.filter(g => !g.merged && g.t != null).sort((a, b) => a.t - b.t);
}
const groupDecisions = events => groupEvents(events).filter(g => g.access);

/**
 * Controller clock offset from the sync markers.
 * syncs: card  { at, fc, cn, set, idx, batch }
 *        input { at, ch, v, set, idx, batch, types[], door }    (a DPS / input pulse)
 */
function solveClock(syncs, groups, opt) {
  const results = [];
  const used = new Set();
  const fits = (s, g) => (s.types ? typeIn(g.type, s.types) && (!s.door || !g.door || g.door.id === s.door) : credEq(s, g.cred));
  for (const s of syncs) {
    const cand = groups.filter(g => !used.has(g) && !g.cloudClock && fits(s, g) && Math.abs(g.t - s.at) < opt.maxOffsetMs && (s.types || g.cred));
    cand.sort((a, b) => Math.abs(a.t - s.at) - Math.abs(b.t - s.at));
    const g = s.types ? null : cand[0];   // input pulses are matched as a pair below (open/closed look alike across pulses)
    if (g) used.add(g);
    results.push({ ...s, matched: !!g, eventT: g ? g.t : null, type: g ? g.type : null, offset: g ? g.t - s.at : null });
  }
  // Pairs: the two markers of ONE send whose events are spaced like Aether spaced them (±250 ms), nearest the send.
  const sends = new Map();
  for (const r of results) { const k = `${r.set}|${r.batch || ''}`; if (!sends.has(k)) sends.set(k, []); sends.get(k).push(r); }
  for (const pair of sends.values()) {
    pair.sort((x, y) => x.idx - y.idx);
    for (let i = 0; i + 1 < pair.length; i++) {
      const a = pair[i], b = pair[i + 1];
      if (a.matched && b.matched) continue;
      const gap = b.at - a.at;
      const pool = groups.filter(g => !used.has(g) && !g.cloudClock && Math.abs(g.t - a.at) < opt.maxOffsetMs);
      const okA = g => (a.types ? fits(a, g) : !g.cred), okB = g => (b.types ? fits(b, g) : !g.cred);
      let best = null;
      for (const g1 of pool) {
        if (!okA(g1)) continue;
        for (const g2 of pool) {
          if (g2 === g1 || !okB(g2) || Math.abs((g2.t - g1.t) - gap) > 250) continue;
          const score = Math.abs(g1.t - a.at);
          if (!best || score < best.score) best = { g1, g2, score };
        }
      }
      if (best) {
        used.add(best.g1); used.add(best.g2);
        Object.assign(a, { matched: true, eventT: best.g1.t, type: best.g1.type, offset: best.g1.t - a.at, byPattern: !a.types });
        Object.assign(b, { matched: true, eventT: best.g2.t, type: best.g2.type, offset: best.g2.t - b.at, byPattern: !b.types });
      }
    }
  }
  const offs = set => results.filter(r => r.matched && (!set || r.set === set)).map(r => r.offset);
  const start = offs('start'), end = offs('end');
  const offset = start.length ? median(start) : (offs().length ? median(offs()) : null);
  let drift = null;
  if (start.length && end.length) {
    const t1 = median(results.filter(r => r.set === 'start').map(r => r.at)), t2 = median(results.filter(r => r.set === 'end').map(r => r.at));
    const hours = (t2 - t1) / 3600000;
    drift = { startMs: median(start), endMs: median(end), changeMs: median(end) - median(start), perHourMs: hours > 0 ? (median(end) - median(start)) / hours : null };
  }
  const gaps = [];
  for (const pair of sends.values()) {
    const p = pair.filter(r => r.matched);
    for (let i = 0; i + 1 < p.length; i++) gaps.push({ set: p[i].set, sent: p[i + 1].at - p[i].at, seen: p[i + 1].eventT - p[i].eventT });
  }
  return { offset, drift, sync: results, gaps, used };
}

/**
 * @param {object[]} events
 * @param {object[]} syncs
 * @param {object} s     settings ({ thresholds, expectations, doorConfig })
 * @param {object} ctx   { wiring }
 */
function correlate(events, syncs = [], s = {}, ctx = {}) {
  const th = { decisionWarn: 1000, decisionFail: 2000, pushWarn: 3000, pushFail: 10000, matchWindowMs: 30000, maxOffsetMs: 10 * 60000, inputWindowMs: 10000, outputWindowMs: 10000, commandWarn: 5000, commandFail: 15000, heldToleranceMs: 1500, ...(s.thresholds || {}) };
  const wiring = ctx.wiring || {};
  const doorCfg = s.doorConfig || {};
  const ev = [...events].sort((a, b) => (a.at ?? a.t ?? 0) - (b.at ?? b.t ?? 0));
  const groups = groupEvents(ev);

  // sync markers → their journal entries (stamped when the reader / relay finished)
  const journalEv = ev.filter(e => e.src === 'journal');
  const syncJournal = new Set();
  syncs = syncs.map(x => {
    const j = journalEv.filter(e => !syncJournal.has(e) && e.at >= x.at - 200 && e.at <= x.at + 3000
      && (x.types ? e.journal && e.journal.ch === x.ch && e.journal.v === x.v : e.type === 'card' && credEq(x, e.cred))).sort((a, b) => a.at - b.at)[0];
    if (j) { syncJournal.add(j); return { ...x, at: j.at, queuedAt: x.at }; }
    return x;
  });
  const clock = solveClock(syncs, groups, th);
  const off = clock.offset;
  const toPi = t => (t == null ? null : off == null ? t : t - off);
  const gPi = g => (g.cloudClock ? g.t : toPi(g.t));        // cloud-stamped (d/settings tid) events are not shifted
  const used = new Set(clock.used);

  const wire = ev.filter(e => e.lane === 'wire' && e.at != null && e.src !== 'command');
  const doorStates = ev.filter(e => e.type === 'door-state' && e.at != null);
  const commands = ev.filter(e => e.type === 'command' && e.cmd);

  // ── roles for journal channels ─────────────────────────────────────────
  const byCh = new Map();
  for (const e of journalEv) {
    if (!e.journal || !(DRIVE.has(e.type) || OBSERVE.has(e.type))) continue;
    if (!byCh.has(e.journal.ch)) byCh.set(e.journal.ch, []);
    byCh.get(e.journal.ch).push(e);
  }
  const roles = {};
  for (const [ch, list] of byCh) {
    const w = wiring[ch];
    if (w && w.role) { roles[ch] = { ...w, auto: false, kind: list[0].type, count: list.length }; continue; }
    const cands = DRIVE.has(list[0].type) ? [['dps', { active: 'open' }], ['dps', { active: 'closed' }], ['rex', {}], ['input', {}]] : [['lock', {}], ['output', {}]];
    let best = null;
    for (const [role, opt] of cands) {
      let hit = 0;
      for (const e of list) {
        const x = expectFor(e, role, opt);
        const win = x.before ? [-th.outputWindowMs, 2000] : [-500, th.inputWindowMs];
        if (groups.some(g => typeIn(g.type, x.types) && gPi(g) - e.at >= win[0] && gPi(g) - e.at <= win[1])) hit++;
      }
      const score = hit / list.length;
      const rank = score + (role === 'input' || role === 'output' ? -0.05 : 0);
      if (!best || rank > best.rank) best = { role, ...opt, auto: true, score, rank };
    }
    roles[ch] = best && best.score >= 0.5 ? { role: best.role, active: best.active, auto: true, score: best.score, kind: list[0].type, count: list.length } : { role: 'unmapped', auto: true, score: best ? best.score : 0, kind: list[0].type, count: list.length };
  }

  /** Hops after a controller event group, from t0 (Pi clock). */
  const cloudHops = (g, t0, extra = {}) => {
    const hops = [];
    const tp = gPi(g);
    hops.push({ id: 'decided', label: extra.decidedLabel || 'Controller reported', at: tp, ms: tp - t0, clock: g.cloudClock ? 'cloud' : 'controller', corrected: g.cloudClock || off != null, raw: g.t });
    const ctrl = g.copies.find(c => c.src === 'controller' && c.publishAt != null);
    if (ctrl) hops.push({ id: 'published', label: 'Cloud Connector published', at: toPi(ctrl.publishAt), ms: toPi(ctrl.publishAt) - t0, clock: 'controller', corrected: off != null, raw: ctrl.publishAt });
    const w = wire.find(x => x.at >= Math.min(t0, tp) && x.at <= t0 + 10000 && x.dir !== 'in');
    if (w) hops.push({ id: 'wire', label: `Left the controller (${w.label})`, at: w.at, ms: w.at - t0, clock: 'pi' });
    const push = g.copies.filter(c => c.src === 'cloud-mqtt' && c.at != null).sort((x, y) => x.at - y.at)[0];
    if (push) hops.push({ id: 'push', label: 'Cloud pushed (MQTT)', at: push.at, ms: push.at - t0, clock: 'pi' });
    const stored = g.copies.find(c => c.cloudAt != null && c.clock !== 'cloud');
    if (stored) hops.push({ id: 'stored', label: 'Cloud stored', at: stored.cloudAt, ms: stored.cloudAt - t0, clock: 'cloud' });
    const api = g.copies.filter(c => c.src === 'cloud-api' && c.at != null).sort((x, y) => x.at - y.at)[0];
    if (api) hops.push({ id: 'api', label: 'In the event log (API)', at: api.at, ms: api.at - t0, clock: 'pi', resolution: api.pollMs });
    const har = g.copies.filter(c => c.src === 'har' && c.at != null).sort((x, y) => x.at - y.at)[0];
    if (har) hops.push({ id: 'browser', label: 'Browser received (HAR)', at: har.at, ms: har.at - t0, clock: 'browser' });
    return { hops, push: push ? push.at : null, api: api ? api.at : null, decided: tp };
  };
  const doorOf = ch => (roles[ch] && roles[ch].door) || null;
  const lockChannels = door => Object.entries(roles).filter(([, r]) => r.role === 'lock' && (!door || !r.door || r.door === door)).map(([ch]) => ch);
  const traces = [];

  // ── 1. cards ───────────────────────────────────────────────────────────
  const cards = journalEv.filter(e => e.type === 'card' || e.type === 'keypad');
  const expectCard = a => {
    if (a.info && a.info.expect) return a.info.expect;
    const x = (s.expectations || []).find(r => credEq({ fc: r.fc, cn: r.cn }, a.cred));
    return x ? x.expect : null;
  };
  for (const a of cards) {
    const t0 = a.at;
    const isSync = syncJournal.has(a) || !!(a.info && a.info.sync);
    const acc = groups.filter(g => g.access);
    const inWin = acc.filter(g => !used.has(g) || isSync).filter(g => { const tp = gPi(g); return tp >= t0 - 1500 && tp <= t0 + th.matchWindowMs; });
    let g = inWin.find(x => credEq(a.cred, x.cred));
    let matchedBy = g ? 'credential' : null;
    if (!g) {
      const next = cards.find(o => o.at > t0);
      const until = next ? next.at : t0 + th.matchWindowMs;
      g = inWin.filter(x => !x.cred && !used.has(x) && gPi(x) <= until).sort((x, y) => Math.abs(gPi(x) - t0) - Math.abs(gPi(y) - t0))[0];
    }
    if (g && !matchedBy) matchedBy = 'time';
    if (!g && a.cred) {
      const near = inWin.filter(x => x.cred && !used.has(x) && Math.abs(gPi(x) - t0) <= 5000
        && !cards.some(o => o !== a && credEq(o.cred, x.cred) && Math.abs(o.at - gPi(x)) < th.matchWindowMs))
        .sort((x, y) => Math.abs(gPi(x) - t0) - Math.abs(gPi(y) - t0));
      if (near[0]) { g = near[0]; matchedBy = 'time (credential differs)'; }
    }
    if (g && !isSync) used.add(g);
    const hops = [{ id: 'sent', label: 'Aether sent', at: t0, ms: 0, clock: 'pi' }];
    let ch = null;
    if (g) { ch = cloudHops(g, t0, { decidedLabel: 'Controller decided' }); hops.push(...ch.hops); }
    const lock = journalEv.find(o => OBSERVE.has(o.type) && o.at >= t0 && o.at <= t0 + 8000 && o.journal && o.journal.v === 1);
    if (lock) hops.push({ id: 'lock', label: `Aether saw ${lock.journal.ch} change`, at: lock.at, ms: lock.at - t0, clock: 'pi' });
    hops.sort((x, y) => x.at - y.at);
    let credCheck = 'n/a';
    if (g && a.cred && g.cred) credCheck = credEq(a.cred, g.cred) ? 'match' : 'mismatch';
    else if (g && a.cred && !g.cred) credCheck = 'not-reported';
    const expect = expectCard(a);
    const result = g ? (g.type.startsWith('accessgranted') ? 'grant' : g.type.startsWith('accessdenied') ? 'deny' : g.type) : null;
    const notes = [];
    let status = 'pass';
    const bad = m => { status = 'fail'; notes.push(m); };
    const warn = m => { if (status === 'pass') status = 'warn'; notes.push(m); };
    const decisionMs = ch ? ch.decided - t0 : null;
    if (!g) bad(`No controller decision within ${Math.round(th.matchWindowMs / 1000)} s`);
    if (credCheck === 'mismatch') bad(`Credential changed on the way: sent ${credKey(a.cred)}, controller reported ${credKey(g.cred)}${g.cred.format ? ' (' + g.cred.format + ')' : ''}`);
    if (expect && result && expect !== result) bad(`Expected ${expect}, got ${g.type}`);
    if (g && off == null) warn('Controller clock offset unknown (no sync markers matched) — controller hops are uncorrected');
    if (decisionMs != null && off != null) {
      if (decisionMs > th.decisionFail) bad(`Decision took ${decisionMs} ms (limit ${th.decisionFail})`);
      else if (decisionMs > th.decisionWarn) warn(`Decision took ${decisionMs} ms (warn at ${th.decisionWarn})`);
      else if (decisionMs < -500) warn(`Decision stamped ${-decisionMs} ms before the card was sent — check the clock offset`);
    }
    if (g && ch.push == null && ch.api == null && !isSync) warn('Not seen from the cloud (push or event log)');
    if (ch && ch.push != null) {
      const d = ch.push - t0;
      if (d > th.pushFail) bad(`Cloud push after ${d} ms (limit ${th.pushFail})`);
      else if (d > th.pushWarn) warn(`Cloud push after ${d} ms (warn at ${th.pushWarn})`);
    }
    traces.push({
      id: a.id, kind: 'card', at: t0, sync: isSync, action: { label: a.label, ch: a.info && a.info.ch, cred: a.cred, type: a.type },
      decision: g ? { type: g.type, t: g.t, cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(c => c.src))], matchedBy, clientType: g.clientType, eventIds: g.copies.map(c => c.id) } : null,
      hops, expect, result, credCheck, status, notes,
      latency: { decision: off != null ? decisionMs : null, push: ch && ch.push != null ? ch.push - t0 : null, api: ch && ch.api != null ? ch.api - t0 : null },
    });
  }

  // ── 2. inputs: Aether → controller (DPS, REX, inputs) ──────────────────
  const drives = journalEv.filter(e => DRIVE.has(e.type) && e.journal && roles[e.journal.ch] && ['dps', 'rex', 'input'].includes(roles[e.journal.ch].role));
  for (const a of drives) {
    const r = roles[a.journal.ch];
    const x = expectFor(a, r.role, r);
    const t0 = a.at;
    const isSync = syncJournal.has(a);
    const door = r.door || null;
    const next = drives.find(o => o.at > t0 && o.journal.ch === a.journal.ch);
    const until = Math.min(t0 + th.inputWindowMs, next ? next.at : Infinity);
    const g = groups.filter(h => (!used.has(h) || isSync) && typeIn(h.type, x.types) && (!door || !h.door || h.door.id === door)
      && (!x.io || !r.ioId || String(h.ioId || '').includes(String(r.ioId).replace(/^.*#(input_|output_)?/, '')))
      && gPi(h) >= t0 - 1500 && gPi(h) <= until).sort((p, q) => Math.abs(gPi(p) - t0) - Math.abs(gPi(q) - t0))[0];
    if (g && !isSync) used.add(g);
    const notes = [];
    let status = 'pass';
    const bad = m => { status = 'fail'; notes.push(m); };
    const warn = m => { if (status === 'pass') status = 'warn'; notes.push(m); };
    const hops = [{ id: 'sent', label: `Aether ${a.journal.v ? 'set' : 'cleared'} ${a.journal.ch}`, at: t0, ms: 0, clock: 'pi' }];
    let ch = null;
    if (g) { ch = cloudHops(g, t0, { decidedLabel: `Controller: ${g.type}` }); hops.push(...ch.hops); }
    const ds = doorStates.find(d => d.at >= t0 && d.at <= t0 + th.inputWindowMs + 5000 && (!door || (d.door && d.door.id === door)));
    if (ds) hops.push({ id: 'state', label: `Cloud door state: ${ds.label}`, at: ds.at, ms: ds.at - t0, clock: 'pi' });
    hops.sort((p, q) => p.at - q.at);
    if (!g) {
      if (r.role === 'rex' && !a.journal.v) warn('Controller did not report the REX release (doors often have "show REX events" off for releases)');
      else bad(`Controller never reported ${x.label} within ${Math.round((until - t0) / 1000)} s`);
    } else {
      if (g.type === 'doorforcedopen') {
        const grant = traces.find(t => t.kind === 'card' && t.result === 'grant' && t0 - t.at >= 0 && t0 - t.at < 15000 && (!door || !t.decision.door || t.decision.door.id === door));
        if (grant) bad(`Door opened ${Math.round((t0 - grant.at) / 100) / 10} s after a granted card, but the controller reported FORCED OPEN`);
        else notes.push('Controller reported forced open (no grant, REX or unlock before the door opened)');
      }
      const ms = ch.decided - t0;
      if (off == null) warn('Controller clock offset unknown — controller hop uncorrected');
      else if (ms > th.decisionFail) bad(`${x.label} reported ${ms} ms after the change (limit ${th.decisionFail})`);
      else if (ms > th.decisionWarn) warn(`${x.label} reported ${ms} ms after the change`);
      if (ch.push == null && ch.api == null && !isSync) warn('Not seen from the cloud (push or event log)');
      if (ch.push != null && ch.push - t0 > th.pushFail) bad(`Cloud push after ${ch.push - t0} ms (limit ${th.pushFail})`);
      else if (ch.push != null && ch.push - t0 > th.pushWarn) warn(`Cloud push after ${ch.push - t0} ms`);
    }
    if (r.auto) notes.push(`Role ${r.role} inferred (${Math.round((r.score || 0) * 100)} % agreement) — set it in Setup › Wiring to be sure`);
    traces.push({
      id: a.id, kind: 'input', at: t0, sync: isSync, role: r.role, action: { label: `${a.journal.ch} → ${a.journal.v ? 'on' : 'off'} (${r.role}${door ? '' : ''})`, ch: a.journal.ch, cred: null, type: a.type, v: a.journal.v },
      decision: g ? { type: g.type, t: g.t, cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(c => c.src))], matchedBy: 'type and time', clientType: g.clientType, eventIds: g.copies.map(c => c.id) } : null,
      expect: x.label, result: g ? g.type : null, credCheck: 'n/a', hops, status, notes,
      latency: { decision: g && off != null ? ch.decided - t0 : null, push: ch && ch.push != null ? ch.push - t0 : null, api: ch && ch.api != null ? ch.api - t0 : null },
    });
  }

  // ── 3. commands: OnCAFE → controller → door state → Aether ────────────
  for (const c of commands) {
    const t0 = c.at;
    const cmd = c.cmd;
    const x = expectForCommand(cmd);
    const targets = [].concat(cmd.target || []).map(String);
    const doorHit = h => !targets.length || !h.door || targets.includes(String(h.door.id)) || targets.includes(String(h.controllerId));
    let g = groups.filter(h => !used.has(h) && typeIn(h.type, x.types) && doorHit(h) && gPi(h) >= t0 - 1500 && gPi(h) <= t0 + th.matchWindowMs)
      .sort((p, q) => gPi(p) - gPi(q))[0];
    let matchedBy = g ? 'type and target' : null;
    if (!g && targets.length) {
      g = groups.filter(h => !used.has(h) && h.door && targets.includes(String(h.door.id)) && gPi(h) >= t0 - 500 && gPi(h) <= t0 + 10000).sort((p, q) => gPi(p) - gPi(q))[0];
      if (g) matchedBy = 'target and time';
    }
    if (g) used.add(g);
    const hops = [{ id: 'sent', label: `${c.src === 'command' ? 'Aether sent' : c.src === 'har' ? 'Browser sent' : 'Seen on the wire'}: ${x.label}`, at: t0, ms: 0, clock: c.clock || 'pi' }];
    if (c.info && Number.isFinite(c.info.ackMs)) hops.push({ id: 'ack', label: `OnCAFE answered ${c.info.status || ''}`.trim(), at: t0 + c.info.ackMs, ms: c.info.ackMs, clock: c.clock || 'pi' });
    let ch = null;
    if (g) { ch = cloudHops(g, t0, { decidedLabel: `Controller: ${g.type}` }); hops.push(...ch.hops); }
    const ds = doorStates.find(d => d.at >= t0 && d.at <= t0 + th.matchWindowMs && (!targets.length || (d.door && targets.includes(String(d.door.id)))));
    if (ds) hops.push({ id: 'state', label: `Cloud door state: ${ds.label}`, at: ds.at, ms: ds.at - t0, clock: 'pi' });
    let saw = null;
    const wantV = x.lockTo != null ? x.lockTo : x.outTo != null ? x.outTo : null;
    if (wantV != null) {
      const chans = x.outTo != null ? Object.entries(roles).filter(([, r]) => r.role === 'output').map(([k]) => k) : targets.flatMap(d => lockChannels(d));
      saw = journalEv.find(o => OBSERVE.has(o.type) && o.journal && chans.includes(o.journal.ch) && o.journal.v === wantV && o.at >= t0 && o.at <= t0 + th.matchWindowMs);
      if (saw) hops.push({ id: 'lock', label: `Aether saw ${saw.journal.ch} → ${wantV ? 'on' : 'off'}`, at: saw.at, ms: saw.at - t0, clock: 'pi' });
    }
    hops.sort((p, q) => p.at - q.at);
    const notes = [];
    let status = 'pass';
    const bad = m => { status = 'fail'; notes.push(m); };
    const warn = m => { if (status === 'pass') status = 'warn'; notes.push(m); };
    if (c.info && c.info.error) bad(`OnCAFE refused the command: ${c.info.error}`);
    if (!g) bad(`Controller never reported ${x.label} within ${Math.round(th.matchWindowMs / 1000)} s`);
    const endAt = saw ? saw.at : ch ? (ch.push ?? ch.decided) : null;
    if (endAt != null) {
      const d = endAt - t0;
      if (d > th.commandFail) bad(`${saw ? 'Door hardware' : 'Controller'} answered the command after ${d} ms (limit ${th.commandFail})`);
      else if (d > th.commandWarn) warn(`${saw ? 'Door hardware' : 'Controller'} answered after ${d} ms`);
    }
    if (wantV != null && !saw && targets.flatMap(d => lockChannels(d)).length && x.outTo == null) warn('Aether did not see the strike output change (Setup › Wiring maps a lock channel to this door)');
    if (g && off == null && !g.cloudClock) warn('Controller clock offset unknown — controller hop uncorrected');
    traces.push({
      id: c.id, kind: 'command', at: t0, sync: false, action: { label: c.label, ch: null, cred: null, type: 'command', cmd },
      decision: g ? { type: g.type, t: g.t, cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(q => q.src))], matchedBy, clientType: g.clientType, eventIds: g.copies.map(q => q.id) } : null,
      expect: x.label, result: g ? g.type : null, credCheck: 'n/a', hops, status, notes,
      latency: { decision: g && (off != null || g.cloudClock) ? gPi(g) - t0 : null, push: ch && ch.push != null ? ch.push - t0 : null, api: ch && ch.api != null ? ch.api - t0 : null, output: saw ? saw.at - t0 : null, ack: c.info && Number.isFinite(c.info.ackMs) ? c.info.ackMs : null },
    });
  }

  // ── 4. outputs: controller → Aether (strike, relays) ───────────────────
  const observes = journalEv.filter(e => OBSERVE.has(e.type) && e.journal && roles[e.journal.ch] && ['lock', 'output'].includes(roles[e.journal.ch].role));
  const lastOn = new Map();
  for (const o of observes) {
    const r = roles[o.journal.ch];
    const x = expectFor(o, r.role, r);
    const door = r.door || null;
    const v = o.journal.v;
    // the controller's own report of this change (usually just before Aether sees it)
    const g = groups.filter(h => !used.has(h) && typeIn(h.type, x.types) && (!door || !h.door || h.door.id === door)
      && gPi(h) - o.at >= -th.outputWindowMs && gPi(h) - o.at <= 2000).sort((p, q) => Math.abs(gPi(p) - o.at) - Math.abs(gPi(q) - o.at))[0];
    if (g) used.add(g);
    // what asked for it (only for "on" edges)
    let cause = null;
    if (v === 1) {
      const lo = o.at - 15000;
      const cands = traces.filter(t => t.at >= lo && t.at <= o.at && (
        (t.kind === 'card' && t.result === 'grant') || (t.kind === 'input' && t.role === 'rex' && t.action.v === 1) ||
        (t.kind === 'command' && ((r.role === 'lock' && expectForCommand(t.action.cmd).lockTo === 1) || (r.role === 'output' && expectForCommand(t.action.cmd).outTo === 1))))
        && (!door || r.role === 'output' || !t.decision || !t.decision.door || t.decision.door.id === door || (t.kind === 'command' && [].concat(t.action.cmd.target || []).includes(door))));
      const best = cands.sort((a, b) => b.at - a.at)[0];
      if (best) cause = { kind: best.kind, label: best.kind === 'card' ? `card ${credKey(best.action.cred)} granted` : best.kind === 'input' ? 'REX' : best.expect, at: best.at, traceId: best.id };
      else if (g && g.trigger) cause = { kind: 'controller', label: `${g.trigger}${g.clientType ? ' · ' + g.clientType : ''}`, at: gPi(g) };
    }
    const t0 = cause ? cause.at : g ? Math.min(gPi(g), o.at) : o.at;
    const hops = [];
    if (cause) hops.push({ id: 'cause', label: `Asked by ${cause.label}`, at: cause.at, ms: 0, clock: 'pi' });
    let ch = null;
    if (g) { ch = cloudHops(g, t0, { decidedLabel: `Controller: ${g.type}` }); hops.push(...ch.hops); }
    hops.push({ id: 'lock', label: `Aether saw ${o.journal.ch} → ${v ? 'on' : 'off'}`, at: o.at, ms: o.at - t0, clock: 'pi' });
    const ds = doorStates.find(d => d.at >= o.at - 2000 && d.at <= o.at + 15000 && (!door || (d.door && d.door.id === door)));
    if (ds) hops.push({ id: 'state', label: `Cloud door state: ${ds.label}`, at: ds.at, ms: ds.at - t0, clock: 'pi' });
    hops.sort((p, q) => p.at - q.at);
    const notes = [];
    let status = 'pass';
    const warn = m => { if (status === 'pass') status = 'warn'; notes.push(m); };
    const bad = m => { status = 'fail'; notes.push(m); };
    let held = null;
    if (v === 1) lastOn.set(o.journal.ch, o.at);
    else if (lastOn.has(o.journal.ch)) {
      held = o.at - lastOn.get(o.journal.ch);
      lastOn.delete(o.journal.ch);
      const cfg = door && doorCfg[door];
      if (cfg && Number.isFinite(cfg.grantMs) && r.role === 'lock') {
        const want = cfg.grantMs;
        if (Math.abs(held - want) > Math.max(th.heldToleranceMs, want * 0.1)) warn(`Strike held ${(held / 1000).toFixed(1)} s; door is set to ${(want / 1000).toFixed(1)} s`);
        else notes.push(`Strike held ${(held / 1000).toFixed(1)} s (door set to ${(want / 1000).toFixed(1)} s)`);
      } else notes.push(`On for ${(held / 1000).toFixed(1)} s`);
    }
    if (v === 1 && !cause) warn(`${r.role === 'lock' ? 'Strike' : 'Output'} turned on and nothing Aether saw asked for it (schedule, automation or someone else?)`);
    if (!g) warn(`Controller did not report ${x.label}`);
    else if (off != null || g.cloudClock) {
      const lag = o.at - gPi(g);
      if (lag > th.decisionFail) bad(`Output changed ${lag} ms after the controller reported it`);
    }
    if (r.auto) notes.push(`Role ${r.role} inferred — set it in Setup › Wiring to be sure`);
    traces.push({
      id: o.id, kind: 'output', at: t0, sync: false, role: r.role, cause, held,
      action: { label: `${o.journal.ch} → ${v ? 'on' : 'off'} (${r.role})`, ch: o.journal.ch, cred: null, type: o.type, v },
      decision: g ? { type: g.type, t: g.t, cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(q => q.src))], matchedBy: 'type and time', clientType: g.clientType, eventIds: g.copies.map(q => q.id) } : null,
      expect: x.label, result: g ? g.type : null, credCheck: 'n/a', hops, status, notes,
      latency: { decision: g && (off != null || g.cloudClock) ? gPi(g) - t0 : null, push: ch && ch.push != null ? ch.push - t0 : null, api: ch && ch.api != null ? ch.api - t0 : null, output: o.at - t0, hardware: g && (off != null || g.cloudClock) ? o.at - gPi(g) : null },
    });
  }
  traces.sort((a, b) => a.at - b.at);

  const unexplained = groups.filter(g => !used.has(g) && g.access && !traces.some(t => t.decision && t.decision.t === g.t && t.decision.type === g.type))
    .map(g => ({ type: g.type, t: g.t, at: gPi(g), cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(c => c.src))] }));

  const statsFor = list => {
    const real = list.filter(t => !t.sync);
    const st = {
      actions: real.length, pass: real.filter(t => t.status === 'pass').length, warn: real.filter(t => t.status === 'warn').length, fail: real.filter(t => t.status === 'fail').length,
      decision: statsOf(real.map(t => t.latency.decision).filter(x => x != null)),
      push: statsOf(real.map(t => t.latency.push).filter(x => x != null)),
      api: statsOf(real.map(t => t.latency.api).filter(x => x != null)),
      decisionToPush: statsOf(real.filter(t => t.latency.push != null && t.latency.decision != null).map(t => t.latency.push - t.latency.decision)),
      output: statsOf(real.map(t => t.latency.output).filter(x => x != null)),
      hardware: statsOf(real.map(t => t.latency.hardware).filter(x => x != null)),
      ack: statsOf(real.map(t => t.latency.ack).filter(x => x != null)),
      credMismatch: real.filter(t => t.credCheck === 'mismatch').length,
    };
    st.verdict = !real.length ? 'no-data' : st.fail ? 'fail' : st.warn ? 'warn' : 'pass';
    return st;
  };
  const stats = { ...statsFor(traces), unexplained: unexplained.length, byKind: {} };
  for (const k of ['card', 'input', 'output', 'command']) stats.byKind[k] = statsFor(traces.filter(t => t.kind === k));
  stats.byKind.card.unexplained = unexplained.length;
  const { used: _u, ...clk } = clock;
  return { clock: clk, traces, unexplained, stats, roles };
}

module.exports = { correlate, credEq, credKey, statsOf, groupDecisions, groupEvents, solveClock, expectFor, expectForCommand };
