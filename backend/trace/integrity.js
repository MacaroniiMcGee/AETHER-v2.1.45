// trace/integrity.js — did every event make it, once, in order?   AETHER_TRACE (TRACE-4)
//
// Counts the same controller events across the places they show up and flags:
//   lost in push      in the event log (API) or the controller's own log, never pushed over MQTT
//   not in event log  pushed, but the event-log poll never returned it (only events older than 3 poll intervals)
//   only in the log   in the controller's log (Log Analytics report), never in the cloud at all
//   duplicates        the same event pushed more than once
//   out of order      pushed after an event the controller stamped later (per controller, > orderSlackMs apart)
// Events are matched by eventId when they have one, otherwise by type + door + controller time (±50 ms).
'use strict';

const keyOf = e => (e.eventId ? `id:${e.eventId}` : null);
const fuzzy = e => `${e.type}|${(e.door && (e.door.id || e.door.name)) || ''}`;

function integrity(events, opt = {}) {
  const pollMs = Number(opt.pollMs) || 2000;
  const slack = Number(opt.orderSlackMs) || 1000;
  const now = Number(opt.now) || Date.now();
  const ev = (events || []).filter(e => (e.lane === 'cloud' || e.lane === 'controller') && e.type && e.src !== 'command' && e.type !== 'door-state' && !/^io-/.test(e.type));
  const by = { 'cloud-mqtt': [], 'cloud-api': [], controller: [], har: [] };
  for (const e of ev) if (by[e.src]) by[e.src].push(e);
  const pushed = by['cloud-mqtt'], logged = by['cloud-api'], ctrl = by.controller;
  // index pushes
  const pushById = new Map();
  for (const e of pushed) { const k = keyOf(e); if (k) pushById.set(k, (pushById.get(k) || []).concat(e)); }
  const near = (list, e) => list.find(p => fuzzy(p) === fuzzy(e) && p.t != null && e.t != null && Math.abs(p.t - e.t) <= 50);
  const inPush = e => { const k = keyOf(e); return k ? pushById.has(k) : !!near(pushed, e); };
  const apiOn = logged.length > 0 || !!opt.apiEnabled;
  const lostInPush = [], notInLog = [], onlyInLog = [], duplicates = [], outOfOrder = [];
  const seenLost = new Set();
  for (const e of logged) { if (!inPush(e)) { const k = keyOf(e) || fuzzy(e) + e.t; if (!seenLost.has(k)) { seenLost.add(k); lostInPush.push(brief(e, 'event log')); } } }
  for (const e of ctrl) {
    if (inPush(e)) continue;
    const inLog = logged.some(l => (keyOf(l) && keyOf(l) === keyOf(e)) || (fuzzy(l) === fuzzy(e) && l.t != null && e.t != null && Math.abs(l.t - e.t) <= 50));
    if (inLog) { const k = keyOf(e) || fuzzy(e) + e.t; if (!seenLost.has(k)) { seenLost.add(k); lostInPush.push(brief(e, 'controller log + event log')); } }
    else onlyInLog.push(brief(e, 'controller log'));
  }
  if (apiOn) {
    for (const e of pushed) {
      if (e.at != null && now - e.at < pollMs * 3) continue;     // the poll may not have caught up yet
      const k = keyOf(e);
      const there = k ? logged.some(l => keyOf(l) === k) : !!near(logged, e);
      if (!there && !notInLog.some(x => x.key === (k || fuzzy(e) + e.t))) notInLog.push({ ...brief(e, 'push'), key: k || fuzzy(e) + e.t });
    }
  }
  for (const [k, list] of pushById) if (list.length > 1) duplicates.push({ ...brief(list[0], 'push'), copies: list.length, gapMs: list[list.length - 1].at - list[0].at, key: k });
  // order: by arrival, per controller; an event stamped earlier than one already pushed, by more than the slack
  const byCtrl = new Map();
  for (const e of [...pushed].filter(e => e.at != null && e.t != null).sort((a, b) => a.at - b.at)) {
    const c = e.controllerId || '?';
    const s = byCtrl.get(c) || { maxT: -Infinity, maxE: null };
    if (e.t < s.maxT - slack) outOfOrder.push({ ...brief(e, 'push'), after: brief(s.maxE, 'push'), byMs: s.maxT - e.t });
    if (e.t > s.maxT) { s.maxT = e.t; s.maxE = e; }
    byCtrl.set(c, s);
  }
  const counts = { push: pushed.length, eventLog: logged.length, controllerLog: ctrl.length, har: by.har.length, uniquePushed: pushById.size };
  const issues = lostInPush.length + duplicates.length + outOfOrder.length + onlyInLog.length + notInLog.length;
  const verdict = !ev.length ? 'no-data' : lostInPush.length || onlyInLog.length ? 'fail' : duplicates.length || outOfOrder.length || notInLog.length ? 'warn' : 'pass';
  const cap = l => l.slice(0, 200);
  return { counts, verdict, issues, lostInPush: cap(lostInPush), notInLog: cap(notInLog.map(({ key, ...r }) => r)), onlyInLog: cap(onlyInLog), duplicates: cap(duplicates.map(({ key, ...r }) => r)), outOfOrder: cap(outOfOrder), apiOn };
}

function brief(e, where) {
  if (!e) return null;
  return { type: e.type, t: e.t ?? null, at: e.at ?? null, door: e.door ? e.door.name || e.door.id : null, cred: e.cred || null, eventId: e.eventId || null, controllerId: e.controllerId || null, where };
}

module.exports = { integrity };
