// backend/routes/trace.js — Event Trace (/api/trace).   AETHER_TRACE
//
//   GET    /status                    sources, current run, sync channels, settings
//   PUT    /settings                  partial settings (cloud, sync, wire, thresholds, expectations, allowRaw)
//   GET    /live?since=SEQ            events newer than SEQ (poll this; scrubbed)
//   GET    /live/analysis             traces over the live buffer (no run)
//   GET    /cloud/inventory?url=&org= controllers and doors of the signed-in OnCAFE org
//   POST   /cloud/connect             start the OnCAFE push feed (+ event-log poll) with the saved settings
//   POST   /cloud/disconnect
//   GET    /wiring  PUT /wiring       wiring map shared with Log Analytics › Product Test (+ channels seen in 24 h)
//   GET    /doors                     per Aether door: OnCAFE pairing, description, channels, last traces (Doors page)
//   POST   /doors/import              re-read the Doors page config into the wiring map (admin)
//   POST   /command                   {kind, target, value, seconds, revertSec} — door/area/zone command to OnCAFE (admin)
//   POST   /sync                      send the sync markers now {set: start|end|check}
//   POST   /runs/start  {name, sync}  start a run (sends the start pair unless sync:false)
//   POST   /runs/stop   {sync}        stop (sends the end pair unless sync:false)
//   GET    /runs                      list
//   GET    /runs/:id                  analysis: clock offset, traces, unexplained, stats
//   GET    /runs/:id/events           all events of a run (scrubbed)
//   GET    /runs/:id/export.json|.csv
//   DELETE /runs/:id
//   POST   /runs/:id/import/har       raw HAR text (text/plain, up to 60 MB)
//   POST   /runs/:id/import/wire      {packets:[{ts,src,dst,sport,dport,bytes,sni,proto}]}
//   POST   /runs/:id/import/report    {reportId}   a Log Analytics report (controller logs)
//   GET    /reports                   Log Analytics reports to pick from
//   GET    /reveal?run=&event=        the original (plain text) payload of one event — logged
//   GET    /runs/:id/reveals          who looked at plain text, when
//   TRACE-4
//   GET    /tests                     sequences, door templates, the test running now, test runs
//   POST   /tests  PUT /tests/:id     save a sequence;  DELETE /tests/:id
//   POST   /tests/template            {kind, door, fc, cn, ...} → ready-made steps for one door
//   POST   /tests/:id/run             {repeat, minutes, gapMs} — run it (records a trace run, grades every step)
//   POST   /tests/stop                stop after the current step (DPS / REX put back)
//   GET    /tests/status              progress of the running test
//   GET    /runs/:id/test             graded report of a test run;  GET /runs/:id/test.csv
//   GET    /compare?a=&b=             run A (baseline) vs run B
//   GET    /alerts?since=SEQ          live alerts (failed / slow traces)
//   TRACE-5
//   GET    /clocks                    read every access controller's clock over SUNAPI now
//   GET    /jira  PUT /jira           Jira site / e-mail / API token (token never returned)
//   GET    /jira/issue/:key           summary and .har attachments of a ticket
//   POST   /runs/:id/import/jira      {key, attachmentId} — the Pi downloads that HAR into the run
//   POST   /runs/:id/jira             {key, comment} — attach the run's CSV / test CSV / summary to the ticket
//   GET    /suggest                   suggested wiring (doors page + seen + Discover) per channel and per controller door
//   POST   /suggest/apply             {channels:[...]} — take rows into the wiring map (admin)
//   POST   /discover  /discover/stop  GET /discover — the active probe (admin, same origin)
'use strict';

const express = require('express');
const { TraceEngine } = require('../trace/engine');

let engine = null;
function getEngine() { if (!engine) engine = new TraceEngine(); return engine; }

const CSV_COLS = ['time', 'status', 'sync', 'action', 'sent credential', 'decision', 'reported credential', 'credential check', 'expected', 'decision ms', 'cloud push ms', 'event log ms', 'notes'];
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ck = c => (c ? `${c.fc ?? '?'}-${c.cn ?? '?'}${c.format ? ' (' + c.format + ')' : ''}` : '');

const runCsv = a => [CSV_COLS.concat('reader ms', 'reader showed').join(',')].concat(a.traces.map(t => [
  new Date(t.at).toISOString(), t.status, t.sync ? 'yes' : '', t.action.label, ck(t.action.cred), t.decision ? t.decision.type : '', ck(t.decision && t.decision.cred),
  t.credCheck, t.expect || '', t.latency.decision ?? '', t.latency.push ?? '', t.latency.api ?? '', t.notes.join('; '), t.latency.reader ?? '', t.reader ? t.reader.colour : '',
].map(csvCell).join(','))).join('\n') + '\n';
const testCsv = r => [['repeat', 'step', 'what', 'door', 'time', 'status', 'result', 'decision ms', 'cloud push ms', 'strike ms', 'held ms', 'why'].join(',')]
  .concat(r.report.steps.map(x => [x.iter, x.idx + 1, x.text, x.door || '', new Date(x.at).toISOString(), x.status, x.result || '', x.latency.decision ?? '', x.latency.push ?? '', x.latency.output ?? '', x.held ?? '', x.why.join('; ')].map(csvCell).join(','))).join('\n') + '\n';
/** A few lines for a Jira comment. */
function summaryText(a, t) {
  const s = a.stats, f = v => (v == null ? '—' : `${Math.round(v)} ms`);
  const L = [`Aether Event Trace — ${a.meta.name} (${new Date(a.meta.start).toISOString().replace('T', ' ').slice(0, 19)} UTC${a.meta.end ? `, ${Math.round((a.meta.end - a.meta.start) / 1000)} s` : ''})`,
    `Verdict: ${s.verdict} · ${s.actions} traced · ${s.pass} pass · ${s.warn} warn · ${s.fail} fail`,
    `Aether → controller decision p50 ${f(s.decision.p50)} / p95 ${f(s.decision.p95)} · cloud push p50 ${f(s.push.p50)} / p95 ${f(s.push.p95)} · event log p50 ${f(s.api.p50)}`,
    `Controller clock: ${a.clock.offset == null ? 'offset unknown (no sync markers matched)' : `${a.clock.offset > 0 ? 'ahead of' : 'behind'} the Pi by ${Math.abs(Math.round(a.clock.offset))} ms`}${a.clock.drift && a.clock.drift.perHourMs != null ? `, drift ${Math.round(a.clock.drift.perHourMs)} ms/h` : ''}`];
  if (a.integrity && a.integrity.verdict !== 'no-data') L.push(`Events: ${a.integrity.counts.push} pushed · never pushed ${a.integrity.lostInPush.length} · pushed twice ${a.integrity.duplicates.length} · out of order ${a.integrity.outOfOrder.length} · only in controller log ${a.integrity.onlyInLog.length}`);
  if (t) L.push(`Test "${t.sequence.name}": ${t.iterations} repeat(s), ${t.report.totals.pass} passed, ${t.report.totals.warn} warnings, ${t.report.totals.fail} failed`);
  const bad = a.traces.filter(x => x.status === 'fail' && !x.sync).slice(0, 10);
  if (bad.length) { L.push('', 'Failures:'); for (const x of bad) L.push(`- ${new Date(x.at).toISOString().slice(11, 23)} ${x.action.label}: ${x.notes[0] || 'failed'}`); }
  L.push('', 'Attached: traces CSV' + (t ? ', test CSV' : '') + ', summary JSON.');
  return L.join('\n');
}

module.exports = function traceRoutes() {
  const router = express.Router();
  const eng = getEngine();
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
  const who = req => (req.aetherUser && (req.aetherUser.user || req.aetherUser.name)) || req.ip || '?';
  // Plain text (and the switch that allows it) is for Aether admins. Without the Aether login installed, everyone is.
  const isAdmin = req => !req.aetherUser || req.aetherUser.role === 'admin' || req.aetherUser.local === true;
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/status', (req, res) => res.json({ ...eng.status(), me: { admin: isAdmin(req) } }));
  router.put('/settings', express.json({ limit: '256kb' }), (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      if ('allowRaw' in body && body.allowRaw !== eng.settings.allowRaw && !isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change who may see plain text' });
      if (body.commands && !!body.commands.enabled !== eng.settings.commands.enabled && !isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can turn commands on or off' });
      const changed = (k, a, b) => JSON.stringify(a) !== JSON.stringify(b);
      if (body.sync && body.sync.channel && changed('ch', { ...eng.settings.sync.channel, ...body.sync.channel }, eng.settings.sync.channel) && !isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change what the sync markers drive' });
      if (body.cloud && body.cloud.zones && changed('z', body.cloud.zones, eng.settings.cloud.zones) && !isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change the zones under test' });
      res.json(eng.saveSettings(body));
    } catch (e) { fail(res, e); }
  });
  router.get('/live', (req, res) => res.json(eng.liveSince(Number(req.query.since) || 0)));
  router.get('/live/analysis', (_req, res) => { try { res.json(eng.analyze(null)); } catch (e) { fail(res, e); } });

  router.get('/cloud/inventory', async (req, res) => {
    try {
      const inv = await eng.cloud.inventory(String(req.query.url || eng.settings.cloud.url), String(req.query.org || eng.settings.cloud.org));
      eng.refreshDoorConfig().catch(() => {});
      res.json(inv);
    } catch (e) { fail(res, e); }
  });
  router.post('/cloud/connect', express.json(), async (_req, res) => {
    try { try { eng.maybeAutoAdopt(); } catch { /* the doors can still be picked by hand */ }   // TRACE-9: first connect watches the paired doors
      const st = await eng.cloud.start(eng.settings.cloud); eng.refreshDoorConfig().catch(() => {}); res.json(st); } catch (e) { fail(res, e); }
  });
  router.post('/cloud/disconnect', express.json(), async (_req, res) => { await eng.cloud.stop(); res.json(eng.cloud.status()); });

  // wiring map (shared with Log Analytics › Product Test) and the channels Aether used lately
  router.get('/wiring', (_req, res) => { try { res.json({ wiring: eng.wiring(), channels: eng.channelsSeen() }); } catch (e) { fail(res, e); } });
  router.put('/wiring', express.json({ limit: '64kb' }), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change the wiring map' });
    try { res.json({ wiring: eng.saveWiring((req.body || {}).wiring || {}, `event trace (${who(req)})`, (req.body || {}).base ?? null) }); } catch (e) { fail(res, e); } });

  // Doors page pairing: what Event Trace knows per Aether door, and a manual re-import of the door config
  router.get('/doors', (_req, res) => { try { res.json(eng.doorsSummary()); } catch (e) { fail(res, e); } });
  router.post('/doors/import', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change the wiring map' });
    try { res.json(eng.importDoors(`event trace (${who(req)})`)); } catch (e) { fail(res, e); }
  });

  // a door / area / zone command sent to OnCAFE by Aether (admins only; doors under test only)
  router.post('/command', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can send commands to OnCAFE' });
    // a page from another site must not be able to make the Pi send commands (even a local, signed-out browser)
    const origin = req.headers.origin;
    let own = !origin;
    if (origin) { try { own = require('../lib/authManager').isOwnOrigin(origin, req); } catch { own = false; } }
    if (!own) return res.status(403).json({ error: 'Commands are only accepted from the Aether page itself' });
    try { res.json(await eng.command(req.body || {}, who(req))); } catch (e) { fail(res, e); }
  });

  router.post('/sync', express.json(), async (req, res) => {
    try { res.json({ sent: await eng.sendSync(['start', 'end', 'check'].includes(req.body && req.body.set) ? req.body.set : 'check') }); } catch (e) { fail(res, e); }
  });

  const testBusy = res => { if (eng.test && eng.test.state !== 'done') { res.status(409).json({ error: 'A test is running: stop it on the Tests tab first' }); return true; } return false; };
  router.post('/runs/start', express.json(), async (req, res) => {
    if (testBusy(res)) return;
    try { res.json(await eng.startRun((req.body || {}).name, { sync: (req.body || {}).sync, note: (req.body || {}).note })); } catch (e) { fail(res, e); }
  });
  router.post('/runs/stop', express.json(), async (req, res) => {
    if (testBusy(res)) return;
    try { res.json(await eng.stopRun('stopped', { sync: (req.body || {}).sync })); } catch (e) { fail(res, e); }
  });
  router.get('/runs', (_req, res) => res.json({ runs: eng.listRuns(), current: eng.run ? eng.run.id : null }));
  router.get('/runs/:id', (req, res) => { try { res.json(eng.analyze(String(req.params.id))); } catch (e) { fail(res, e); } });
  router.get('/runs/:id/events', (req, res) => res.json({ events: eng.readEvents(String(req.params.id)) }));
  router.get('/runs/:id/reveals', (req, res) => {
    const id = String(req.params.id);
    if (!/^trace-[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'Bad run id' });
    const { Vault } = require('../trace/redact');
    res.json({ reveals: new Vault(require('path').join(__dirname, '..', 'data', 'trace', 'runs', id)).reveals() });
  });
  router.delete('/runs/:id', (req, res) => { try { eng.deleteRun(String(req.params.id)); res.json({ ok: true }); } catch (e) { fail(res, e); } });

  router.get('/runs/:id/export.json', (req, res) => {
    try {
      const a = eng.analyze(String(req.params.id));
      res.set('Content-Disposition', `attachment; filename="${req.params.id}.json"`);
      res.json({ ...a, events: eng.readEvents(String(req.params.id)) });
    } catch (e) { fail(res, e); }
  });
  router.get('/runs/:id/export.csv', (req, res) => {
    try {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${req.params.id}.csv"`);
      res.send(runCsv(eng.analyze(String(req.params.id))));
    } catch (e) { fail(res, e); }
  });

  router.post('/runs/:id/import/har', express.text({ type: () => true, limit: '60mb' }), (req, res) => {
    try { res.json(eng.importHar(String(req.params.id), typeof req.body === 'string' ? req.body : JSON.stringify(req.body))); } catch (e) { fail(res, e); }
  });
  router.post('/runs/:id/import/wire', express.json({ limit: '20mb' }), (req, res) => {
    try { res.json(eng.importWire(String(req.params.id), (req.body || {}).packets)); } catch (e) { fail(res, e); }
  });
  router.post('/runs/:id/import/report', express.json(), (req, res) => {
    try { res.json(eng.importReport(String(req.params.id), String((req.body || {}).reportId || ''))); } catch (e) { fail(res, e); }
  });
  router.get('/reports', (_req, res) => res.json({ reports: eng.listReports() }));

  // ── TRACE-4: test sequences, compare, alerts ──────────────────────────
  const ownOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return require('../lib/authManager').isOwnOrigin(o, req); } catch { return false; } };
  router.get('/tests', (_req, res) => { try { res.json({ sequences: eng.sequences(), templates: eng.templates(), current: eng.testStatus(), runs: eng.testRuns() }); } catch (e) { fail(res, e); } });
  router.get('/tests/status', (_req, res) => res.json({ current: eng.testStatus() }));
  router.post('/tests/template', express.json(), (req, res) => {
    const b = req.body || {};
    try { res.json({ steps: eng.templateSteps(String(b.kind || ''), b.door == null ? null : Number(b.door), { fc: b.fc ?? '', cn: b.cn ?? '' }, { badCn: b.badCn, grantMs: b.grantMs, heldMs: b.heldMs, output: b.output }) }); } catch (e) { fail(res, e); }
  });
  router.post('/tests/stop', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can stop a test' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Tests can only be stopped from the Aether page itself' });
    res.json({ current: eng.stopTest() });
  });
  const saveSeq = (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change test sequences' });
    // a stored test drives hardware the next time an admin runs it: only the Aether page may change one
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Tests can only be changed from the Aether page itself' });
    try { res.json(eng.saveSequence({ ...(req.body || {}), ...(req.params.id ? { id: req.params.id } : { id: undefined }) })); } catch (e) { fail(res, e); }
  };
  router.post('/tests', express.json({ limit: '256kb' }), saveSeq);
  router.put('/tests/:id', express.json({ limit: '256kb' }), saveSeq);
  router.delete('/tests/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change test sequences' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Tests can only be changed from the Aether page itself' });
    try { eng.deleteSequence(String(req.params.id)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  router.post('/tests/:id/run', express.json(), async (req, res) => {
    // a test moves real hardware (and may send OnCAFE commands): admins only, and only from the Aether page itself
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can run tests' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Tests can only be started from the Aether page itself' });
    const b = req.body || {};
    try { res.json({ current: await eng.runTest(String(req.params.id), { repeat: b.repeat, minutes: b.minutes, gapMs: b.gapMs }, who(req)) }); } catch (e) { fail(res, e); }
  });
  // ── TRACE-9: Ready to trace? / Test this door ──
  router.get('/ready', (_req, res) => { try { res.json(eng.readiness()); } catch (e) { fail(res, e); } });
  router.post('/ready/adopt', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change the doors under test' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Only the Aether page itself can change the doors under test' });
    try { res.json({ ...eng.adoptPairing(), ready: eng.readiness() }); } catch (e) { fail(res, e); }
  });
  router.post('/ready/wiring', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change the wiring map' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Only the Aether page itself can change the wiring map' });
    try { res.json(eng._autoApplyWiring(who(req))); } catch (e) { fail(res, e); }
  });
  router.get('/doors/:id/check/plan', (req, res) => {
    try { const p = eng.doorCheckPlan(Number(req.params.id), { held: req.query.held === undefined ? undefined : req.query.held === '1' });
      res.json({ door: p.info.id, name: p.name, steps: p.steps.filter(s => s.kind !== 'wait' || s.label).map(s => s.label), skipped: p.skipped }); } catch (e) { fail(res, e); }
  });
  router.post('/doors/:id/check', express.json(), async (req, res) => {
    // moves real hardware like any test: admins only, and only from the Aether page itself
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can test a door' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Door checks can only be started from the Aether page itself' });
    const b = req.body || {};
    try { res.json({ current: await eng.doorCheck(Number(req.params.id), { held: b.held }, who(req)) }); } catch (e) { fail(res, e); }
  });
  router.get('/doorchecks', (_req, res) => { try { res.json(eng.doorChecks()); } catch (e) { fail(res, e); } });
  router.get('/runs/:id/doorcheck', (req, res) => { try { res.json(eng.doorCheckResult(String(req.params.id))); } catch (e) { fail(res, e.code === 'ENOENT' ? Object.assign(new Error('That run no longer exists'), { status: 404 }) : e); } });
  router.get('/runs/:id/test', (req, res) => { try { res.json(eng.testReport(String(req.params.id))); } catch (e) { fail(res, e.code === 'ENOENT' ? Object.assign(new Error('That run no longer exists'), { status: 404 }) : e); } });
  router.get('/runs/:id/test.csv', (req, res) => {
    try {
      const r = eng.testReport(String(req.params.id));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${req.params.id}-test.csv"`);
      res.send(testCsv(r));
    } catch (e) { fail(res, e); }
  });
  router.get('/compare', (req, res) => { try { res.json(eng.compareRuns(String(req.query.a || ''), String(req.query.b || ''))); } catch (e) { fail(res, e); } });
  router.get('/alerts', (req, res) => res.json(eng.alertsSince(Number(req.query.since) || 0)));

  // ── TRACE-5: controller clocks (SUNAPI) and Jira ──────────────────────
  // TRACE-8: controller links (reachable from this Pi; emulated Azure boards polled by their IC2). Read-only, no login used.
  router.get('/links', async (req, res) => { try { res.json(req.query.fresh ? await eng.checkLinks() : (eng.links && Date.now() - eng.links.at < 30000 ? eng.links : await eng.checkLinks())); } catch (e) { fail(res, e); } });
  router.get('/clocks', async (_req, res) => { try { res.json(await eng.checkClocks()); } catch (e) { fail(res, e); } });
  const jira = require('../trace/jira');
  router.get('/jira', (_req, res) => res.json(jira.status()));
  router.put('/jira', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can set the Jira login' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Only the Aether page itself can set the Jira login' });
    try { const st = jira.configure(req.body || {}); let me = null; if (st.configured && (req.body || {}).test) me = await jira.whoAmI(); res.json({ ...st, me }); } catch (e) { fail(res, e); }
  });
  // the Jira login is the admin's: only admins use it, even to read
  router.get('/jira/issue/:key', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can use the Jira login' });
    try { res.json(await jira.issue(req.params.key)); } catch (e) { fail(res, e); } });
  router.post('/runs/:id/import/jira', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can use the Jira login' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Only the Aether page itself can import from Jira' });
    try {
      const b = req.body || {};
      const iss = await jira.issue(b.key);
      const a = iss.attachments.find(x => x.id === String(b.attachmentId));
      if (!a) return res.status(404).json({ error: 'That attachment is not on the ticket' });
      const buf = await jira.download(a.id);
      const r = eng.importHar(String(req.params.id), buf.toString('utf8'));
      res.json({ ...r, from: `${iss.key} · ${a.filename}` });
    } catch (e) { fail(res, e); }
  });
  router.post('/runs/:id/jira', express.json(), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can post to Jira' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Only the Aether page itself can post to Jira' });
    try {
      const id = String(req.params.id), b = req.body || {};
      const key = jira.checkKey(b.key);
      const a = eng.analyze(id);
      let t = null; try { t = eng.testReport(id); } catch { /* not a test run */ }
      const files = [{ name: `${id}-traces.csv`, data: runCsv(a), type: 'text/csv' }];
      if (t) files.push({ name: `${id}-test.csv`, data: testCsv(t), type: 'text/csv' });
      const { traces, unexplained, roles, ...rest } = a;   // the summary: stats, clock, integrity, meta (no payloads)
      files.push({ name: `${id}-summary.json`, data: JSON.stringify({ ...rest, test: t ? { sequence: t.sequence, totals: t.report.totals, byStep: t.report.byStep } : null, failures: traces.filter(x => x.status === 'fail' && !x.sync).slice(0, 200).map(x => ({ at: x.at, kind: x.kind, action: x.action.label, notes: x.notes })) }, null, 1), type: 'application/json' });
      const attached = await jira.attach(key, files);
      let commented = false;
      if (b.comment !== false) { await jira.comment(key, summaryText(a, t)); commented = true; }
      res.json({ key, attached, commented });
    } catch (e) { fail(res, e); }
  });

  router.get('/suggest', (_req, res) => { try { res.json(eng.suggest()); } catch (e) { fail(res, e); } });
  // Hydra (Board Blueprint Studio, same origin) reads this to build the wiring sheet: the controller board by model,
  // Aether's board, and per controller door which Aether terminal goes where
  router.get('/hydra', (_req, res) => {
    try {
      const sg = eng.suggest();
      const tplOf = m => { const x = String(m || '').toUpperCase(); return /P400/.test(x) ? 'p400' : /P200/.test(x) ? 'p200' : /P100/.test(x) ? 'p100' : /IC2/.test(x) ? 'ic2' : null; };
      res.json({ kind: 'aether-wiring', version: 1, at: sg.at, source: 'Aether Event Trace', wiegand: eng.channels().wiegand.map(w => w.id),
        controllers: sg.controllers.map(c => ({ ...c, tpl: tplOf(c.model) })) });
    } catch (e) { fail(res, e); }
  });
  router.post('/suggest/apply', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can change the wiring map' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Only the Aether page itself can change the wiring map' });
    try { res.json(eng.applySuggestion((req.body || {}).channels, who(req))); } catch (e) { fail(res, e); }
  });
  router.get('/discover', (_req, res) => res.json({ current: eng.discoverStatus() }));
  router.post('/discover', express.json(), async (req, res) => {
    // Discover moves real relays, presents cards and (with Commands on) unlocks doors: admins only, from the Aether page itself
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can run Discover' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Discover can only be started from the Aether page itself' });
    try { res.json({ current: await eng.discover(req.body || {}, who(req)) }); } catch (e) { fail(res, e); }
  });
  router.post('/discover/stop', express.json(), (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can stop Discover' });
    if (!ownOrigin(req)) return res.status(403).json({ error: 'Discover can only be stopped from the Aether page itself' });
    res.json({ current: eng.stopDiscover() });
  });

  router.get('/reveal', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can see plain text' });
    try { res.json({ raw: eng.reveal(req.query.run ? String(req.query.run) : null, String(req.query.event || '').slice(0, 64), who(req)) }); } catch (e) { fail(res, e); }
  });

  return router;
};
module.exports.getEngine = getEngine;
