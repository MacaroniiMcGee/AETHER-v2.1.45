// trace/tests.js — scripted test sequences for Event Trace.   AETHER_TRACE (TRACE-4)
//
// A sequence is a list of steps run unattended against Aether doors (Doors page), inside a trace run:
//   card     present a card on the door's reader (Wiegand, OSDP or emulated board)
//   rex      press the door's REX for holdMs
//   dps      open or close the door's DPS
//   command  an OnCAFE command to the door's OnCAFE door / its area (Setup › Commands must be on)
//   wait     wait ms
// Each step carries what should happen:
//   expect = { result: grant|deny|any, events: [patterns], noEvents: [patterns], strike: on|off|stays-on|any,
//              minMs, maxMs, output: <channel>, withinMs }
// Event patterns: 'open' exact · 'held*' prefix · '*forcedopen' suffix (never its negation).
// After the run the steps are graded against the run's traces and events: pass / warn / fail per step, and per
// step across repeats (pass rate, latency p50 / p95) for load runs.
'use strict';

const { credEq, statsOf } = require('./correlate');

const STEP_KINDS = ['card', 'rex', 'dps', 'command', 'wait'];
const CMD_KINDS = ['override', 'maintenance', 'shunt', 'lockdown'];
const RESULTS = ['grant', 'deny', 'any'];
const STRIKES = ['on', 'off', 'stays-on', 'any'];
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const pats = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(x => String(x).trim().toLowerCase().replace(/[^a-z0-9*_-]/g, '')).filter(Boolean).slice(0, 12);
const typeIn = (t, list) => list.some(x => {
  if (x.startsWith('*')) { const s = x.slice(1); return t.endsWith(s) && !/(de|in|dis|un|non)$/.test(t.slice(0, t.length - s.length)); }
  return x.endsWith('*') ? t.startsWith(x.slice(0, -1)) : t === x;
});
const granted = t => /^accessgranted/.test(String(t || ''));

function cleanStep(s = {}) {
  const kind = STEP_KINDS.includes(s.kind) ? s.kind : 'wait';
  const e = s.expect && typeof s.expect === 'object' ? s.expect : {};
  const step = { kind, label: str(s.label, 80) };
  step.door = Number.isInteger(Number(s.door)) && s.door !== '' && s.door != null ? Number(s.door) : null;   // a wait may name a door too (its events)
  if (kind === 'card') {
    step.fc = s.fc === '' || s.fc == null ? '' : String(int(s.fc, 0, 2 ** 31 - 1, 0));
    step.cn = String(s.cn ?? '').replace(/\D/g, '').slice(0, 20);
    if (s.format) step.format = str(s.format, 40);
  }
  if (kind === 'rex') step.holdMs = int(s.holdMs, 100, 30000, 500);
  if (kind === 'dps') step.state = s.state === 'close' ? 'close' : 'open';
  if (kind === 'command') {
    step.cmd = CMD_KINDS.includes(s.cmd) ? s.cmd : 'override';
    step.value = step.cmd === 'override' ? (s.value === 'lock' ? 'lock' : 'unlock') : s.value === false || s.value === 'off' ? false : true;
    if (step.cmd === 'override') step.seconds = int(s.seconds, 5, 3600, 30);
  }
  if (kind === 'wait') step.ms = int(s.ms, 100, 15 * 60000, 2000);
  if (kind !== 'wait' || e.events || e.noEvents) {
    step.expect = {
      ...(kind === 'card' ? { result: RESULTS.includes(e.result) ? e.result : 'any' } : {}),
      ...(pats(e.events).length ? { events: pats(e.events) } : {}),
      ...(pats(e.noEvents).length ? { noEvents: pats(e.noEvents) } : {}),
      ...(STRIKES.includes(e.strike) && e.strike !== 'any' ? { strike: e.strike } : {}),
      ...(Number(e.minMs) > 0 ? { minMs: int(e.minMs, 0, 3600000, 0) } : {}),
      ...(Number(e.maxMs) > 0 ? { maxMs: int(e.maxMs, 0, 3600000, 0) } : {}),
      ...(e.output && /^[\w:.\-]{1,80}$/.test(String(e.output)) ? { output: String(e.output) } : {}),
      withinMs: int(e.withinMs, 500, 15 * 60000, kind === 'wait' ? Math.max(2000, step.ms || 0) : 10000),
    };
  }
  // how long to wait after the action before the next step (grading is done afterwards, so this only paces the test)
  step.afterMs = int(s.afterMs, 0, 15 * 60000, kind === 'wait' ? 0 : kind === 'card' ? 3000 : 1500);
  return step;
}

function cleanSequence(q = {}) {
  return {
    id: /^seq-[a-z0-9]{4,20}$/.test(String(q.id || '')) ? q.id : `seq-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: str(q.name, 80) || 'Test sequence',
    note: str(q.note, 300),
    steps: (Array.isArray(q.steps) ? q.steps : []).slice(0, 200).map(cleanStep),
    repeat: int(q.repeat, 1, 10000, 1),
    minutes: int(q.minutes, 0, 24 * 60, 0),      // load run: keep repeating for this long (0 = just `repeat` times)
    gapMs: int(q.gapMs, 0, 3600000, 2000),       // between repeats
    sync: q.sync !== false,                      // sync markers at start / end of the run
    updatedAt: Number(q.updatedAt) || Date.now(),
  };
}

/** Ready-made steps for one door ("door behaviours"). card = { fc, cn } of a credential with access. */
function template(kind, door, card = {}, opt = {}) {
  const c = { fc: card.fc ?? '', cn: card.cn ?? '' };
  const bad = { fc: opt.badFc ?? c.fc, cn: opt.badCn ?? '' };
  const grantMs = Number(opt.grantMs) > 0 ? Number(opt.grantMs) : 5000;
  const heldMs = Number(opt.heldMs) > 0 ? Number(opt.heldMs) : 30000;
  const T = {
    valid: [{ kind: 'card', door, ...c, label: 'Valid card', expect: { result: 'grant', strike: 'on' } }],
    invalid: [{ kind: 'card', door, ...bad, label: 'Card without access', expect: { result: 'deny', strike: 'off' } }],
    rex: [{ kind: 'rex', door, label: 'REX', expect: { events: ['rexactivated'] } }],
    forced: [
      { kind: 'dps', door, state: 'open', label: 'Force the door open', expect: { events: ['doorforcedopen', 'forced*', '*forcedopen'] } },
      { kind: 'wait', ms: 3000 },
      { kind: 'dps', door, state: 'close', label: 'Close it', expect: { events: ['closed', 'doorclosed'] } },
    ],
    held: [
      { kind: 'card', door, ...c, label: 'Valid card', expect: { result: 'grant' }, afterMs: 1000 },
      { kind: 'dps', door, state: 'open', label: 'Open and hold', expect: { events: ['open', 'dooropen'] }, afterMs: 0 },
      { kind: 'wait', door, ms: heldMs + 5000, label: 'Hold past the held-open time', expect: { events: ['held*', 'doorheld*', '*heldopen'], withinMs: heldMs + 15000 } },
      { kind: 'dps', door, state: 'close', label: 'Close it', expect: { events: ['closed', 'doorclosed'] } },
    ],
    apb: [
      { kind: 'card', door, ...c, label: 'Valid card', expect: { result: 'grant' } },
      { kind: 'wait', ms: 3000 },
      { kind: 'card', door, ...c, label: 'Same card again (anti-passback)', expect: { result: 'deny', events: ['*passback*', 'antipassback*', 'accessdenied*'] } },
    ],
    lockdown: [
      { kind: 'command', door, cmd: 'lockdown', value: true, label: 'Lockdown on', expect: { events: ['lockdown*', '*lockdown'] } },
      { kind: 'card', door, ...c, label: 'Valid card during lockdown', expect: { result: 'deny', strike: 'off' } },
      { kind: 'command', door, cmd: 'lockdown', value: false, label: 'Lockdown off', expect: { events: ['lockdown*', '*lockdown*', 'normal*'] } },
    ],
    override: [
      { kind: 'command', door, cmd: 'override', value: 'unlock', seconds: 30, label: 'Temporary unlock (30 s)', expect: { strike: 'on' } },
      { kind: 'wait', ms: 5000 },
      { kind: 'command', door, cmd: 'override', value: 'lock', seconds: 30, label: 'Temporary lock', expect: { strike: 'off' } },
    ],
    firstcard: [{ kind: 'card', door, ...c, label: 'First card unlock', expect: { result: 'grant', strike: 'stays-on', minMs: grantMs + 5000, withinMs: grantMs + 20000 }, afterMs: grantMs + 10000 }],
    schedule: [{ kind: 'card', door, ...c, label: 'Card outside its schedule', expect: { result: 'deny', strike: 'off' } }],
    elevator: [{ kind: 'card', door, ...c, label: 'Elevator card (floor output)', expect: { result: 'grant', ...(opt.output ? { output: opt.output } : { strike: 'on' }) } }],
  };
  return (T[kind] || []).map(cleanStep);
}
const TEMPLATES = [
  { id: 'valid', label: 'Valid card', hint: 'Granted, the strike turns on' },
  { id: 'invalid', label: 'Card without access', hint: 'Denied, the strike stays off' },
  { id: 'rex', label: 'REX', hint: 'REX activated reported' },
  { id: 'forced', label: 'Door forced open', hint: 'DPS opened without a grant' },
  { id: 'held', label: 'Door held open', hint: 'Granted, opened, held past the held-open time' },
  { id: 'apb', label: 'Anti-passback', hint: 'Same card twice: the second is denied' },
  { id: 'lockdown', label: 'Lockdown', hint: 'Lockdown on, a valid card is denied, lockdown off' },
  { id: 'override', label: 'Temporary unlock', hint: 'OnCAFE temporary unlock, then lock' },
  { id: 'firstcard', label: 'First card unlock', hint: 'Granted and the strike stays on' },
  { id: 'schedule', label: 'Outside schedule', hint: 'A card whose schedule is off now is denied' },
  { id: 'elevator', label: 'Elevator floor', hint: 'Granted and the floor output turns on' },
];

/** Human line for a step (reports, timeline). */
function stepText(s, doorName) {
  const at = doorName ? ` · ${doorName}` : '';
  if (s.label) return s.label + at;
  switch (s.kind) {
    case 'card': return `Card ${s.fc !== '' ? s.fc + '-' : ''}${s.cn}${at}`;
    case 'rex': return `REX ${s.holdMs} ms${at}`;
    case 'dps': return `DPS ${s.state}${at}`;
    case 'command': return `${s.cmd} ${s.value}${at}`;
    default: return `Wait ${Math.round((s.ms || 0) / 1000)} s`;
  }
}

/**
 * Grade a test run. log = [{ iter, idx, at, end, kind, door, doorName, oncafe, chs:{lock,dps,rex}, cred, cmd, error, text }]
 * a = correlate() result for the run, events = the run's events, th = thresholds.
 */
function grade(a, events, log, steps, th = {}) {
  const offset = a.clock && a.clock.offset;
  const piAt = e => (e.at != null && e.src !== 'controller' && e.clock !== 'controller' ? e.at : e.t != null && offset != null ? e.t - offset : e.at != null ? e.at : null);
  const cloudEv = events.filter(e => (e.lane === 'cloud' || e.lane === 'controller') && e.type && e.src !== 'command');
  const usedCard = new Set(), usedIn = new Set(), usedCmd = new Set();
  const out = [];
  // a step's strike / output window ends where the next step starts (a later card must not count for this one)
  const order = [...log].filter(l => !l.skipped).sort((x, y) => x.at - y.at);
  const nextAt = new Map(order.map((l, i) => [l, order[i + 1] ? order[i + 1].at : Infinity]));
  for (const L of log) {
    const s = steps[L.idx] || {};
    const x = s.expect || {};
    const within = x.withinMs || 10000;
    const lag = th.pushFail || 10000;
    const r = { iter: L.iter, idx: L.idx, kind: L.kind, text: L.text, door: L.doorName || null, at: L.at, status: 'pass', checks: [], why: [], latency: {}, traceId: null };
    const fail = (m) => { r.status = 'fail'; r.why.push(m); };
    const warn = (m) => { if (r.status === 'pass') r.status = 'warn'; r.why.push(m); };
    if (L.error) { r.status = 'error'; r.why.push(L.error); out.push(r); continue; }
    if (L.skipped) { r.status = 'skipped'; r.why.push('stopped before this step'); out.push(r); continue; }
    let tr = null;
    if (L.kind === 'card') {
      tr = a.traces.find(t => t.kind === 'card' && !t.sync && !usedCard.has(t.id) && Math.abs(t.at - L.at) < 4000 && (!L.cred || credEq(t.action.cred, L.cred)));
      if (tr) usedCard.add(tr.id);
      if (!tr) fail('Aether did not record the card (check the door\'s reader)');
      else {
        const res = tr.decision ? tr.decision.type : null;
        r.checks.push({ what: 'decision', want: x.result || 'any', got: res || 'none' });
        if (!res) fail('The controller never reported a decision');
        else if (x.result === 'grant' && !granted(res)) fail(`Expected a grant, got ${res}`);
        else if (x.result === 'deny' && granted(res)) fail(`Expected a denial, got ${res}`);
        if (tr.status === 'fail' && r.status !== 'fail') fail(tr.notes[0] || 'trace failed');
        else if (tr.status === 'warn') warn(tr.notes[0] || 'slow');
      }
    } else if (L.kind === 'rex' || L.kind === 'dps') {
      const chs = [L.chs && L.chs[L.kind], L.raw].filter(Boolean);
      tr = a.traces.find(t => t.kind === 'input' && !t.sync && !usedIn.has(t.id) && chs.includes(t.action.ch) && t.at >= L.at - 500 && t.at <= L.at + 3000);
      if (tr) usedIn.add(tr.id);
      if (!tr) { if (!x.events) fail('Aether did not record the input change (is the door wired in Setup › Wiring?)'); }
      else if (!x.events) { if (tr.status === 'fail') fail(tr.notes[0] || 'the controller did not report it'); else if (tr.status === 'warn') warn(tr.notes[0] || 'slow'); }
    } else if (L.kind === 'command') {
      tr = a.traces.find(t => t.kind === 'command' && !usedCmd.has(t.id) && Math.abs(t.at - L.at) < 3000);
      if (tr) usedCmd.add(tr.id);
      if (!tr) fail('The command was not recorded');
      else if (tr.status === 'fail') fail(tr.notes[0] || 'command failed');
      else if (tr.status === 'warn') warn(tr.notes[0] || 'slow');
    }
    if (tr) { r.traceId = tr.id; r.latency = { decision: tr.latency.decision, push: tr.latency.push, api: tr.latency.api, ack: tr.latency.ack ?? null }; r.result = tr.result || (tr.decision && tr.decision.type) || null; }
    // controller / cloud events for this door within the window
    const from = L.at - 1000, to = (L.end || L.at) + within + lag;
    const mine = cloudEv.filter(e => { const t = piAt(e); return t != null && t >= from && t <= to && (!L.oncafe || !e.door || !e.door.id || e.door.id === L.oncafe); });
    if (x.events) {
      const hit = mine.find(e => typeIn(e.type, x.events));
      r.checks.push({ what: 'events', want: x.events.join(' / '), got: hit ? hit.type : 'none' });
      if (!hit) fail(`No ${x.events.join(' / ')} from the controller within ${Math.round((within + lag) / 1000)} s`);
      else if (!r.latency.push && hit.src === 'cloud-mqtt' && hit.at != null) r.latency.push = hit.at - L.at;
    }
    if (x.noEvents) {
      const hit = mine.find(e => typeIn(e.type, x.noEvents));
      r.checks.push({ what: 'no events', want: `none of ${x.noEvents.join(' / ')}`, got: hit ? hit.type : 'none' });
      if (hit) fail(`The controller reported ${hit.type}`);
    }
    // strike / output
    const outCh = x.output || (L.chs && L.chs.lock) || null;
    if (x.strike || x.output) {
      if (!outCh) warn('No strike channel for this door (Doors page lock, or Setup › Wiring): strike not checked');
      else {
        const outs = a.traces.filter(t => t.kind === 'output' && (t.action.ch === outCh || (L.lockRaw && t.action.ch === L.lockRaw)));
        const until = Math.min(L.at + within, (nextAt.get(L) ?? Infinity) + 150);
        const on = outs.find(t => t.action.v === 1 && t.at >= L.at - 200 && t.at <= until);
        const want = x.output ? 'on' : x.strike;
        r.checks.push({ what: x.output ? `output ${outCh}` : 'strike', want, got: on ? 'on' : 'off' });
        if (want === 'off') { if (on) fail(`The strike turned on (${new Date(on.at).toLocaleTimeString()})`); }
        else if (!on) fail(`The ${x.output ? 'output' : 'strike'} did not turn on within ${Math.round(within / 1000)} s`);
        else {
          r.latency.output = on.at - L.at;
          const offT = outs.find(t => t.action.v === 0 && t.at > on.at);
          const held = offT ? offT.at - on.at : null;
          r.held = held;
          if (want === 'stays-on' && held != null && held < (x.minMs || 0)) fail(`The strike relocked after ${Math.round(held / 1000)} s (wanted ≥ ${Math.round((x.minMs || 0) / 1000)} s)`);
          if (x.minMs && want !== 'stays-on' && held != null && held < x.minMs) fail(`Held ${Math.round(held / 100) / 10} s, wanted ≥ ${Math.round(x.minMs / 100) / 10} s`);
          if (x.maxMs && held != null && held > x.maxMs) fail(`Held ${Math.round(held / 100) / 10} s, wanted ≤ ${Math.round(x.maxMs / 100) / 10} s`);
        }
      }
    }
    out.push(r);
  }
  // per step across repeats
  const byStep = [];
  for (const [i, s] of steps.entries()) {
    if (s.kind === 'wait' && !(s.expect && (s.expect.events || s.expect.noEvents))) continue;
    const rs = out.filter(r => r.idx === i);
    if (!rs.length) continue;
    byStep.push({
      idx: i, text: rs[0].text, kind: s.kind, runs: rs.length,
      pass: rs.filter(r => r.status === 'pass').length, warn: rs.filter(r => r.status === 'warn').length,
      fail: rs.filter(r => r.status === 'fail' || r.status === 'error').length,
      decision: statsOf(rs.map(r => r.latency.decision).filter(v => v != null)),
      push: statsOf(rs.map(r => r.latency.push).filter(v => v != null)),
      output: statsOf(rs.map(r => r.latency.output).filter(v => v != null)),
    });
  }
  const graded = out.filter(r => !(r.kind === 'wait' && !r.checks.length && r.status === 'pass'));
  const totals = { steps: graded.length, pass: graded.filter(r => r.status === 'pass').length, warn: graded.filter(r => r.status === 'warn').length, fail: graded.filter(r => r.status === 'fail' || r.status === 'error').length, skipped: graded.filter(r => r.status === 'skipped').length };
  totals.verdict = !totals.steps ? 'no-data' : totals.fail ? 'fail' : totals.warn ? 'warn' : 'pass';
  // latency over time (load runs): one point per graded step with a latency
  const series = graded.filter(r => r.latency.decision != null || r.latency.push != null).map(r => ({ at: r.at, iter: r.iter, idx: r.idx, decision: r.latency.decision ?? null, push: r.latency.push ?? null, status: r.status }));
  return { steps: graded, byStep, totals, series };
}

module.exports = { cleanStep, cleanSequence, template, TEMPLATES, STEP_KINDS, stepText, grade, typeIn };
