// trace/correlate.js — follow each thing Aether did through the controller to the cloud.   AETHER_TRACE
//
// Input: events (normalize.js) from every source, the sync cards sent, settings.
// Output: { clock, traces[], unexplained[], stats, sync[] }
//
// Clocks. Journal, wire, cloud push and API poll are all stamped on the Pi when Aether sees them, so
// "Aether → cloud push" needs no correction. Event timestamps (eventTimestamp, controller logs) are on
// the controller's clock. The sync cards give the offset: offset = controllerTime − piSendTime for the
// same card (this includes the reader → decision time, typically tens of ms). The start pair and the end
// pair give the drift. With no offset, controller-clock hops are shown "uncorrected".
'use strict';

const num = v => (v === undefined || v === null || v === '' ? null : String(v).replace(/^0+(?=\d)/, ''));
const credEq = (a, b) => !!(a && b && num(a.cn) !== null && num(a.cn) === num(b.cn) && (num(a.fc) === null || num(b.fc) === null || num(a.fc) === num(b.fc)));
const credKey = c => (c ? `${num(c.fc) ?? '?'}-${num(c.cn) ?? '?'}` : '');

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

/** Group cloud/controller copies of one controller event (same eventId, or same type+time). */
function groupDecisions(events) {
  const groups = new Map();
  for (const e of events) {
    if (!(e.lane === 'cloud' || e.lane === 'controller') || !e.access) continue;
    const k = e.eventId ? `id:${e.eventId}` : `t:${e.type}:${e.t}:${credKey(e.cred)}`;
    let g = groups.get(k);
    if (!g) { g = { key: k, type: e.type, t: e.t, cred: null, door: null, copies: [] }; groups.set(k, g); }
    g.copies.push(e);
    if (!g.cred && e.cred) g.cred = e.cred;
    if (!g.door && e.door) g.door = e.door;
    if (g.t == null && e.t != null) g.t = e.t;
  }
  // a controller-log copy without eventId: attach to a cloud group with the same type within 50 ms
  const out = [...groups.values()];
  const loose = out.filter(g => g.copies.every(c => c.src === 'controller'));
  for (const g of loose) {
    const twin = out.find(h => h !== g && h.type === g.type && h.t != null && g.t != null && Math.abs(h.t - g.t) <= 50 && h.copies.some(c => c.src !== 'controller'));
    if (twin) { twin.copies.push(...g.copies); g.merged = true; }
  }
  return out.filter(g => !g.merged && g.t != null).sort((a, b) => a.t - b.t);
}

/**
 * Work out the controller clock offset from the sync cards.
 * syncs: [{ at, fc, cn, set: 'start'|'end'|'check', idx }]
 */
function solveClock(syncs, groups, opt) {
  const results = [];
  const used = new Set();
  for (const s of syncs) {
    const cand = groups.filter(g => !used.has(g) && credEq(s, g.cred) && Math.abs(g.t - s.at) < opt.maxOffsetMs);
    // nearest in time (raw clocks) — the offset is small next to the gaps between sync cards
    cand.sort((a, b) => Math.abs(a.t - s.at) - Math.abs(b.t - s.at));
    const g = cand[0];
    if (g) used.add(g);
    results.push({ ...s, matched: !!g, eventT: g ? g.t : null, type: g ? g.type : null, offset: g ? g.t - s.at : null });
  }
  // Without credentials in the cloud events, fall back to the gap pattern: the two cards of ONE send whose
  // access events are spaced like Aether spaced them (±250 ms). Of all such pairs, take the one nearest the
  // send, and never a decision already used or one whose credential belongs to another card.
  const sends = new Map();
  for (const r of results) { const k = `${r.set}|${r.batch || ''}`; if (!sends.has(k)) sends.set(k, []); sends.get(k).push(r); }
  for (const pair of sends.values()) {
    pair.sort((x, y) => x.idx - y.idx);
    for (let i = 0; i + 1 < pair.length; i++) {
      const a = pair[i], b = pair[i + 1];
      if (a.matched && b.matched) continue;
      const gap = b.at - a.at;
      const free = groups.filter(g => !used.has(g) && !g.cred && Math.abs(g.t - a.at) < opt.maxOffsetMs);
      let best = null;
      for (const g1 of free) {
        for (const g2 of free) {
          if (g2 === g1 || Math.abs((g2.t - g1.t) - gap) > 250) continue;
          const score = Math.abs(g1.t - a.at);
          if (!best || score < best.score) best = { g1, g2, score };
        }
      }
      if (best) {
        used.add(best.g1); used.add(best.g2);
        Object.assign(a, { matched: true, eventT: best.g1.t, type: best.g1.type, offset: best.g1.t - a.at, byPattern: true });
        Object.assign(b, { matched: true, eventT: best.g2.t, type: best.g2.type, offset: best.g2.t - b.at, byPattern: true });
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
 * @param {object} s  settings ({ thresholds, expectations, wire })
 */
function correlate(events, syncs = [], s = {}) {
  const th = { decisionWarn: 1000, decisionFail: 2000, pushWarn: 3000, pushFail: 10000, matchWindowMs: 30000, maxOffsetMs: 10 * 60000, ...(s.thresholds || {}) };
  const ev = [...events].sort((a, b) => (a.at ?? a.t ?? 0) - (b.at ?? b.t ?? 0));
  const groups = groupDecisions(ev);
  // A sync card's "sent" time is its journal entry (stamped when the reader output finished), when we have it.
  const cardsSent = ev.filter(e => e.src === 'journal' && e.type === 'card');
  const syncJournal = new Set();
  syncs = syncs.map(x => {
    const j = cardsSent.filter(e => !syncJournal.has(e) && credEq(x, e.cred) && e.at >= x.at - 200 && e.at <= x.at + 3000).sort((a, b) => a.at - b.at)[0];
    if (j) { syncJournal.add(j); return { ...x, at: j.at, queuedAt: x.at }; }
    return x;
  });
  const clock = solveClock(syncs, groups, th);
  const off = clock.offset;
  const toPi = t => (t == null ? null : off == null ? t : t - off);
  const used = new Set(clock.used);

  const actions = ev.filter(e => e.src === 'journal' && (e.type === 'card' || e.type === 'keypad'));
  const wire = ev.filter(e => e.lane === 'wire' && e.at != null);
  const observed = ev.filter(e => e.src === 'journal' && (e.type === 'opto' || e.type === 'emu-out'));
  const expectFor = a => {
    if (a.info && a.info.expect) return a.info.expect;
    const x = (s.expectations || []).find(r => credEq({ fc: r.fc, cn: r.cn }, a.cred));
    return x ? x.expect : null;
  };

  const traces = actions.map(a => {
    const t0 = a.at;
    const isSync = syncJournal.has(a) || !!(a.info && a.info.sync);
    // the decision: same credential first, then any unused access event in the window
    const inWin = groups.filter(g => !used.has(g) || isSync).filter(g => { const tp = toPi(g.t); return tp >= t0 - 1500 && tp <= t0 + th.matchWindowMs; });
    let g = inWin.find(x => credEq(a.cred, x.cred));
    let matchedBy = g ? 'credential' : null;
    if (!g) {
      // no card number in the event: nearest unused decision before the next card was sent
      const ai = actions.indexOf(a);
      const next = actions.slice(ai + 1).find(o => o.at > t0);
      const until = next ? next.at : t0 + th.matchWindowMs;
      g = inWin.filter(x => !x.cred && !used.has(x) && toPi(x.t) <= until).sort((x, y) => Math.abs(toPi(x.t) - t0) - Math.abs(toPi(y.t) - t0))[0];
    }
    if (g && !matchedBy) matchedBy = 'time';
    if (!g && a.cred) {
      // a decision a few seconds after the card with a different credential that no other action sent: decoded wrong
      const near = inWin.filter(x => x.cred && !used.has(x) && Math.abs(toPi(x.t) - t0) <= 5000
        && !actions.some(o => o !== a && credEq(o.cred, x.cred) && Math.abs(o.at - toPi(x.t)) < th.matchWindowMs))
        .sort((x, y) => Math.abs(toPi(x.t) - t0) - Math.abs(toPi(y.t) - t0));
      if (near[0]) { g = near[0]; matchedBy = 'time (credential differs)'; }
    }
    if (g && !isSync) used.add(g);

    const hops = [{ id: 'sent', label: 'Aether sent', at: t0, ms: 0, clock: 'pi' }];
    let pushAt = null, apiAt = null, decisionMs = null;
    if (g) {
      const tp = toPi(g.t);
      decisionMs = tp - t0;
      hops.push({ id: 'decided', label: 'Controller decided', at: tp, ms: decisionMs, clock: 'controller', corrected: off != null, raw: g.t });
      const ctrl = g.copies.find(c => c.src === 'controller' && c.publishAt != null);
      if (ctrl) hops.push({ id: 'published', label: 'Cloud Connector published', at: toPi(ctrl.publishAt), ms: toPi(ctrl.publishAt) - t0, clock: 'controller', corrected: off != null, raw: ctrl.publishAt });
      const w = wire.find(x => x.at >= Math.min(t0, tp) && x.at <= t0 + 10000 && x.dir !== 'in');
      if (w) hops.push({ id: 'wire', label: `Left the controller (${w.label})`, at: w.at, ms: w.at - t0, clock: 'pi' });
      const push = g.copies.filter(c => c.src === 'cloud-mqtt' && c.at != null).sort((x, y) => x.at - y.at)[0];
      if (push) { pushAt = push.at; hops.push({ id: 'push', label: 'Cloud pushed (MQTT)', at: push.at, ms: push.at - t0, clock: 'pi' }); }
      const stored = g.copies.find(c => c.cloudAt != null);
      if (stored) hops.push({ id: 'stored', label: 'Cloud stored', at: stored.cloudAt, ms: stored.cloudAt - t0, clock: 'cloud' });
      const api = g.copies.filter(c => c.src === 'cloud-api' && c.at != null).sort((x, y) => x.at - y.at)[0];
      if (api) { apiAt = api.at; hops.push({ id: 'api', label: 'In the event log (API)', at: api.at, ms: api.at - t0, clock: 'pi', resolution: api.pollMs }); }
      const har = g.copies.filter(c => c.src === 'har' && c.at != null).sort((x, y) => x.at - y.at)[0];
      if (har) hops.push({ id: 'browser', label: 'Browser received (HAR)', at: har.at, ms: har.at - t0, clock: 'browser' });
    }
    const lock = observed.find(o => o.at >= t0 && o.at <= t0 + 8000 && o.journal && o.journal.v === 1);
    if (lock) hops.push({ id: 'lock', label: `Aether saw ${lock.journal.ch} change`, at: lock.at, ms: lock.at - t0, clock: 'pi' });
    hops.sort((x, y) => x.at - y.at);

    // credential check
    let credCheck = 'n/a';
    if (g && a.cred && g.cred) credCheck = credEq(a.cred, g.cred) ? 'match' : 'mismatch';
    else if (g && a.cred && !g.cred) credCheck = 'not-reported';
    // expectation
    const expect = expectFor(a);
    const result = g ? (g.type.startsWith('accessgranted') ? 'grant' : g.type.startsWith('accessdenied') ? 'deny' : g.type) : null;
    const notes = [];
    let status = 'pass';
    const bad = (m) => { status = 'fail'; notes.push(m); };
    const warn = (m) => { if (status === 'pass') status = 'warn'; notes.push(m); };
    if (!g) bad(`No controller decision within ${Math.round(th.matchWindowMs / 1000)} s`);
    if (credCheck === 'mismatch') bad(`Credential changed on the way: sent ${credKey(a.cred)}, controller reported ${credKey(g.cred)}${g.cred.format ? ' (' + g.cred.format + ')' : ''}`);
    if (expect && result && expect !== result) bad(`Expected ${expect}, got ${g.type}`);
    if (g && off == null) warn('Controller clock offset unknown (no sync cards matched) — controller hops are uncorrected');
    if (decisionMs != null && off != null) {
      if (decisionMs > th.decisionFail) bad(`Decision took ${decisionMs} ms (limit ${th.decisionFail})`);
      else if (decisionMs > th.decisionWarn) warn(`Decision took ${decisionMs} ms (warn at ${th.decisionWarn})`);
      else if (decisionMs < -500) warn(`Decision stamped ${-decisionMs} ms before the card was sent — check the clock offset`);
    }
    if (g && pushAt == null && apiAt == null && !isSync) warn('Not seen from the cloud (push or event log)');
    if (pushAt != null) {
      const d = pushAt - t0;
      if (d > th.pushFail) bad(`Cloud push after ${d} ms (limit ${th.pushFail})`);
      else if (d > th.pushWarn) warn(`Cloud push after ${d} ms (warn at ${th.pushWarn})`);
    }
    return {
      id: a.id, at: t0, sync: isSync, action: { label: a.label, ch: a.info && a.info.ch, cred: a.cred, type: a.type },
      decision: g ? { type: g.type, t: g.t, cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(c => c.src))], matchedBy, clientType: (g.copies.find(c => c.clientType) || {}).clientType || null, eventIds: g.copies.map(c => c.id) } : null,
      hops, expect, result, credCheck, status, notes,
      latency: { decision: off != null ? decisionMs : null, push: pushAt != null ? pushAt - t0 : null, api: apiAt != null ? apiAt - t0 : null },
    };
  });

  const unexplained = groups.filter(g => !used.has(g) && !traces.some(t => t.decision && t.decision.t === g.t && t.decision.type === g.type))
    .map(g => ({ type: g.type, t: g.t, at: toPi(g.t), cred: g.cred, door: g.door, sources: [...new Set(g.copies.map(c => c.src))] }));

  const real = traces.filter(t => !t.sync);
  const stats = {
    actions: real.length, pass: real.filter(t => t.status === 'pass').length, warn: real.filter(t => t.status === 'warn').length, fail: real.filter(t => t.status === 'fail').length,
    decision: statsOf(real.map(t => t.latency.decision).filter(x => x != null)),
    push: statsOf(real.map(t => t.latency.push).filter(x => x != null)),
    api: statsOf(real.map(t => t.latency.api).filter(x => x != null)),
    decisionToPush: statsOf(real.filter(t => t.latency.push != null && t.latency.decision != null).map(t => t.latency.push - t.latency.decision)),
    credMismatch: real.filter(t => t.credCheck === 'mismatch').length,
    unexplained: unexplained.length,
  };
  stats.verdict = !real.length ? 'no-data' : stats.fail ? 'fail' : stats.warn ? 'warn' : 'pass';
  const { used: _u, ...clk } = clock;
  return { clock: clk, traces, unexplained, stats };
}

module.exports = { correlate, credEq, credKey, statsOf, groupDecisions, solveClock };
