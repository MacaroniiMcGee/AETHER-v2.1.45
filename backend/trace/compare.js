// trace/compare.js — put two runs side by side (baseline A vs new B).   AETHER_TRACE (TRACE-4)
//
// Per kind and per hop: p50 / p95 / max, A → B, and whether it really moved (≥ 25 % and ≥ 100 ms, the
// same "numbers only unless it moved" rule as the NHP Firmware Diff page). Results: failures that are new
// in B, failures fixed in B, event names only one run saw, sync / clock, integrity, and — when both runs ran
// the same test sequence — every step's pass rate and latency.
'use strict';

const HOPS = [['decision', 'Aether → controller decision'], ['push', 'Aether → cloud push'], ['api', 'Aether → event log'], ['decisionToPush', 'Controller → cloud push'], ['output', 'Controller → Aether saw the output'], ['hardware', 'Controller event → output edge'], ['ack', 'OnCAFE answered a command']];
const KINDS = ['card', 'input', 'output', 'command'];
const MIN_PCT = 0.25, MIN_MS = 100;

function moved(a, b) {
  if (a == null || b == null) return a == null && b == null ? 'same' : 'only-one';
  const d = b - a;
  if (Math.abs(d) < MIN_MS || Math.abs(d) < Math.abs(a) * MIN_PCT) return 'same';
  return d > 0 ? 'worse' : 'better';
}
const sig = t => `${t.kind}|${String(t.action.label).replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '')}|${t.expect || ''}|${(t.decision && t.decision.door && (t.decision.door.name || t.decision.door.id)) || ''}`;
const why = t => (t.notes && t.notes[0]) || t.result || 'failed';
const typesOf = events => { const m = new Map(); for (const e of events || []) if ((e.lane === 'cloud' || e.lane === 'controller') && e.type) m.set(e.type, (m.get(e.type) || 0) + 1); return m; };

function compare(A, B, evA, evB, testA, testB) {
  const hops = [];
  for (const k of ['all', ...KINDS]) {
    const sa = k === 'all' ? A.stats : A.stats.byKind[k], sb = k === 'all' ? B.stats : B.stats.byKind[k];
    if (!sa || !sb) continue;
    for (const [h, label] of HOPS) {
      const x = sa[h] || {}, y = sb[h] || {};
      if (!x.n && !y.n) continue;
      hops.push({ kind: k, hop: h, label, a: { n: x.n || 0, p50: x.p50 ?? null, p95: x.p95 ?? null, max: x.max ?? null }, b: { n: y.n || 0, p50: y.p50 ?? null, p95: y.p95 ?? null, max: y.max ?? null },
        p50: moved(x.p50, y.p50), p95: moved(x.p95, y.p95) });
    }
  }
  const counts = {};
  for (const k of ['all', ...KINDS]) {
    const sa = k === 'all' ? A.stats : A.stats.byKind[k], sb = k === 'all' ? B.stats : B.stats.byKind[k];
    if (sa && sb) counts[k] = { a: { actions: sa.actions, pass: sa.pass, warn: sa.warn, fail: sa.fail }, b: { actions: sb.actions, pass: sb.pass, warn: sb.warn, fail: sb.fail } };
  }
  const failA = new Map(), failB = new Map();
  for (const t of A.traces) if (!t.sync && t.status === 'fail') failA.set(sig(t), t);
  for (const t of B.traces) if (!t.sync && t.status === 'fail') failB.set(sig(t), t);
  const newFail = [...failB].filter(([s]) => !failA.has(s)).map(([, t]) => ({ kind: t.kind, label: t.action.label, expect: t.expect, why: why(t), at: t.at }));
  const fixed = [...failA].filter(([s]) => !failB.has(s)).map(([, t]) => ({ kind: t.kind, label: t.action.label, expect: t.expect, why: why(t), at: t.at }));
  const ta = typesOf(evA), tb = typesOf(evB);
  const onlyA = [...ta].filter(([t]) => !tb.has(t)).map(([t, n]) => ({ type: t, n }));
  const onlyB = [...tb].filter(([t]) => !ta.has(t)).map(([t, n]) => ({ type: t, n }));
  const clock = { a: { offset: A.clock.offset, drift: A.clock.drift && A.clock.drift.perHourMs }, b: { offset: B.clock.offset, drift: B.clock.drift && B.clock.drift.perHourMs } };
  const integ = A.integrity && B.integrity ? Object.fromEntries(['lostInPush', 'notInLog', 'onlyInLog', 'duplicates', 'outOfOrder'].map(k => [k, { a: A.integrity[k].length, b: B.integrity[k].length }])) : null;
  let steps = null;
  if (testA && testB && testA.sequence && testB.sequence && testA.sequence.id === testB.sequence.id) {
    const rows = new Map();
    for (const s of testA.report.byStep) rows.set(s.idx, { idx: s.idx, text: s.text, a: s, b: null });
    for (const s of testB.report.byStep) rows.set(s.idx, { ...(rows.get(s.idx) || { idx: s.idx, text: s.text, a: null }), b: s });
    steps = [...rows.values()].sort((x, y) => x.idx - y.idx).map(r => ({
      idx: r.idx, text: r.text,
      a: r.a && { runs: r.a.runs, pass: r.a.pass, fail: r.a.fail, decision: r.a.decision.p50 ?? null, push: r.a.push.p50 ?? null },
      b: r.b && { runs: r.b.runs, pass: r.b.pass, fail: r.b.fail, decision: r.b.decision.p50 ?? null, push: r.b.push.p50 ?? null },
      result: !r.a || !r.b ? 'only-one' : (r.b.fail / r.b.runs) > (r.a.fail / r.a.runs) ? 'worse' : (r.b.fail / r.b.runs) < (r.a.fail / r.a.runs) ? 'better' : 'same',
      decision: r.a && r.b ? moved(r.a.decision.p50, r.b.decision.p50) : 'only-one', push: r.a && r.b ? moved(r.a.push.p50, r.b.push.p50) : 'only-one',
    }));
  }
  const worse = hops.filter(h => h.p50 === 'worse' || h.p95 === 'worse').length + newFail.length + (steps ? steps.filter(s => s.result === 'worse').length : 0);
  const better = hops.filter(h => h.p50 === 'better' || h.p95 === 'better').length + fixed.length + (steps ? steps.filter(s => s.result === 'better').length : 0);
  return {
    a: { id: A.meta && A.meta.id, name: A.meta && A.meta.name, start: A.meta && A.meta.start, verdict: A.stats.verdict },
    b: { id: B.meta && B.meta.id, name: B.meta && B.meta.name, start: B.meta && B.meta.start, verdict: B.stats.verdict },
    summary: { worse, better, newFail: newFail.length, fixed: fixed.length, onlyA: onlyA.length, onlyB: onlyB.length },
    hops, counts, newFail, fixed, types: { onlyA, onlyB }, clock, integrity: integ, steps,
    rule: `A change counts only when it moves by at least ${MIN_PCT * 100} % and ${MIN_MS} ms.`,
  };
}

module.exports = { compare, moved };
