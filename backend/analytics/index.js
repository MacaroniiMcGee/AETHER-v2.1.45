// analytics/index.js — scan entry point.
//
//   inspect(inputs, opts)            → Inspection report (bundle only)
//   productTest(inputs, journal, o)  → Inspection report + Product Test results
'use strict';

const fs = require('fs');

const bundle = require('./bundle');
const { parseBundle } = require('./parsers');
const { extract } = require('./events');
const nhp = require('./nhp');
const detectors = require('./detectors');
const producttest = require('./producttest');
const { fmtLocal } = require('./time');

const DEFAULTS = {
  publishWarnMs: 500,          // event → MQTT send
  logGapMs: 3 * 3600000,       // total silence in CloudConnector log (hourly heartbeat checked separately)
  sdkReplyTimeoutMs: 5000,
  latencyWarnMs: 1000,         // Product Test: Aether action → controller event
  latencyFailMs: 2000,
  earlyToleranceMs: 300,       // controller event may log slightly before the journal (clock resolution)
};

function coverage(p) {
  const span = list => list.length ? { from: list[0].t, to: list[list.length - 1].t, n: list.length } : null;
  return {
    cloudconnector: span(p.cc), health: span(p.health), sync: span(p.sync), audit: span(p.audit),
    aspsdk: span(p.asp.frames), other: span(p.other), archived: span(p.archived || []),
  };
}


/**
 * Capture the real log line behind every finding sample (plus continuation lines and
 * 3 lines of context) while the bundle is still unpacked. Kept OUT of the report:
 * returned as report.__raw and moved by the route to an owner-only <id>.raw.json.
 */
function captureRaw(report, manifest) {
  const { redact } = detectors;
  const byRel = new Map(manifest.files.map(f => [f.rel, f]));
  const cache = new Map();
  const linesOf = rel => {
    if (!cache.has(rel)) {
      const f = byRel.get(rel);
      let L = null;
      try { if (f && !f.skipped && f.size < 64 * 1024 * 1024) L = fs.readFileSync(f.abs, 'latin1').split(/\r?\n/); } catch { /* */ }
      cache.set(rel, L);
    }
    return cache.get(rel);
  };
  const STARTS = /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d|\w{3} \d\d \d\d:\d\d:\d\d)/;
  const raw = {};
  for (const f of report.findings) {
    (f.samples || []).forEach((smp, i) => {
      const fallback = smp.raw;
      delete smp.raw;
      const L = smp.file && smp.line ? linesOf(smp.file) : null;
      let entry = null;
      if (L && smp.line <= L.length) {
        const idx = smp.line - 1;
        let end = idx + 1;
        while (end < L.length && end < idx + 60 && L[end] !== '' && !STARTS.test(L[end])) end++;   // multi-line messages
        const line = L.slice(idx, end).join('\n').slice(0, 12000);
        entry = { file: smp.file, n: smp.line, line, before: L.slice(Math.max(0, idx - 3), idx).map(x => x.slice(0, 2000)), after: L.slice(end, end + 3).map(x => x.slice(0, 2000)) };
      } else if (fallback) {
        entry = { file: smp.file || '', n: smp.line || 0, line: fallback, before: [], after: [] };
      }
      if (!entry) return;
      entry.secret = [entry.line, ...entry.before, ...entry.after].some(x => redact(x) !== x);
      (raw[f.id] = raw[f.id] || {})[i] = entry;
      smp.hasRaw = true;
    });
  }
  return raw;
}

function analyze(manifest, opts) {
  const p = parseBundle(manifest, opts);
  p.dbFiles = manifest.files.filter(f => f.type === 'db').map(f => ({ rel: f.rel, size: f.size }));
  const ev = extract(p.cc);
  ev.panel = nhp.extract(p.cc);
  const ctx = { p, ev, opts, summary: {} };
  const findings = detectors.runAll(ctx);
  const tz = p.zone.tz;
  const sevCount = {};
  for (const f of findings) sevCount[f.sev] = (sevCount[f.sev] || 0) + 1;
  const catCount = {};
  for (const f of findings) catCount[f.cat] = (catCount[f.cat] || 0) + 1;

  const report = {
    version: 1,
    createdAt: Date.now(),
    zone: p.zone,
    sources: manifest.sources,
    files: p.files,
    coverage: coverage(p),
    summary: { ...ctx.summary, findings: findings.length, bySeverity: sevCount, byCategory: catCount },
    findings,
    // Timeline data for the UI (controller-side)
    events: ev.rt.map(e => ({ t: e.tEvent, logT: e.t, lag: e.lagMs, type: e.type, cls: e.cls, src: e.srcId, port: e.ioPort, file: e.file, line: e.line })),
    panelEvents: ev.panel.map(e => ({ t: e.t, logT: e.logT, name: e.name, src: e.src, data: e.data, types: e.types, file: e.file, line: e.line })),
    archives: Object.values(p.archives || {}),
    transitions: ev.ap.map(a => ({ t: a.t, ap: a.ap, event: a.event, from: a.from, to: a.to, relay: a.relay })),
    io: ev.io.filter(x => x.kind !== 'physical').map(x => ({ t: x.t, id: x.id, status: x.status, reason: x.reason })),
    frames: p.asp.frames.map(f => ({
      t: f.t, dir: f.dir, peer: f.peer, code: f.code, name: f.name, conf: f.conf, seq: f.seq, len: f.len, lenOk: f.lenOk,
      serial: f.serial, evCode: f.evCode, evName: f.evName, evConf: f.evConf, ctrlTime: f.ctrlTime, ackSerial: f.ackSerial,
      ackOf: f.ackOf, hostname: f.hostname, hex: f.hex, file: f.file, line: f.line, lastSerial: f.lastSerial, point: f.point,
      events: f.events ? f.events.map(e => ({ serial: e.serial, ctrlTime: e.ctrlTime, code: e.code, name: e.name, conf: e.conf, point: e.point, data: e.data })) : undefined,
    })),
    doors: Object.fromEntries(Object.entries(((p.cfg['doors.json'] || {}).json) || {}).map(([id, d]) => [id, {
      name: d.name, shortHeldOpenTime: d.shortHeldOpenTime, longHeldOpenTime: d.longHeldOpenTime, shortStrikeTime: d.shortStrikeTime,
      longStrikeTime: d.longStrikeTime, unlockOnREX: d.unlockOnREX, showRexActivatedEvents: d.showRexActivatedEvents,
      doorContact: d.doorContactB || d.doorContactA, rex: d.epbB || d.epbA, relay: d.relayB || d.relayA, reader: d.readerIndexSideA || d.readerIndexSideB,
    }])),
    opts,
  };
  report.window = {
    from: Math.min(...Object.entries(report.coverage).filter(([k, c]) => c && k !== 'archived').map(([, c]) => c.from)),
    to: Math.max(...Object.entries(report.coverage).filter(([k, c]) => c && k !== 'archived').map(([, c]) => c.to)),
  };
  report.symptoms = require('./playbook').symptomCatalog();
  report.__raw = captureRaw(report, manifest);
  report.windowLocal = { from: fmtLocal(report.window.from, tz), to: fmtLocal(report.window.to, tz) };
  return { report, p, ev };
}

/**
 * @param {{path:string,name?:string}[]} inputs uploaded bundle file(s)
 * @param {object} [opts]
 */
function inspect(inputs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const m = bundle.open(inputs);
  try {
    const { report } = analyze(m, o);
    report.mode = 'inspection';
    return report;
  } finally { m.cleanup(); }
}

/**
 * @param journal  array of journal entries (see journal.js)
 * @param wiring   optional channel → role map
 */
function productTest(inputs, journal, opts = {}, wiring = {}) {
  const o = { ...DEFAULTS, ...opts };
  const m = bundle.open(inputs);
  try {
    const { report, ev, p } = analyze(m, o);
    report.mode = 'product-test';
    report.productTest = producttest.correlate({ journal, ev, p, opts: o, wiring, doors: report.doors });
    return report;
  } finally { m.cleanup(); }
}

module.exports = { inspect, productTest, DEFAULTS };
