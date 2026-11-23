// backend/routes/trace.js — Event Trace (/api/trace).   AETHER_TRACE
//
//   GET    /status                    sources, current run, sync channels, settings
//   PUT    /settings                  partial settings (cloud, sync, wire, thresholds, expectations, allowRaw)
//   GET    /live?since=SEQ            events newer than SEQ (poll this; scrubbed)
//   GET    /live/analysis             traces over the live buffer (no run)
//   GET    /cloud/inventory?url=&org= controllers and doors of the signed-in OnCAFE org
//   POST   /cloud/connect             start the OnCAFE push feed (+ event-log poll) with the saved settings
//   POST   /cloud/disconnect
//   POST   /sync                      send the sync cards now {set: start|end|check}
//   POST   /runs/start  {name, sync}  start a run (sends the start pair unless sync:false)
//   POST   /runs/stop   {sync}        stop (sends the end pair unless sync:false)
//   GET    /runs                      list
//   GET    /runs/:id                  analysis: clock offset, traces, unexplained, stats
//   GET    /runs/:id/events           all events of a run (scrubbed)
//   GET    /runs/:id/export.json|.csv
//   DELETE /runs/:id
//   POST   /runs/:id/import/har       raw HAR text (text/plain or application/json up to 200 MB)
//   POST   /runs/:id/import/wire      {packets:[{ts,src,dst,sport,dport,bytes,sni,proto}]}
//   POST   /runs/:id/import/report    {reportId}   a Log Analytics report (controller logs)
//   GET    /reports                   Log Analytics reports to pick from
//   GET    /reveal?run=&event=        the original (plain text) payload of one event — logged
//   GET    /runs/:id/reveals          who looked at plain text, when
'use strict';

const express = require('express');
const { TraceEngine } = require('../trace/engine');

let engine = null;
function getEngine() { if (!engine) engine = new TraceEngine(); return engine; }

const CSV_COLS = ['time', 'status', 'sync', 'action', 'sent credential', 'decision', 'reported credential', 'credential check', 'expected', 'decision ms', 'cloud push ms', 'event log ms', 'notes'];
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ck = c => (c ? `${c.fc ?? '?'}-${c.cn ?? '?'}${c.format ? ' (' + c.format + ')' : ''}` : '');

module.exports = function traceRoutes() {
  const router = express.Router();
  const eng = getEngine();
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
  const who = req => (req.aetherUser && (req.aetherUser.user || req.aetherUser.name)) || req.ip || '?';
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/status', (_req, res) => res.json(eng.status()));
  router.put('/settings', express.json({ limit: '256kb' }), (req, res) => { try { res.json(eng.saveSettings(req.body || {})); } catch (e) { fail(res, e); } });
  router.get('/live', (req, res) => res.json(eng.liveSince(Number(req.query.since) || 0)));
  router.get('/live/analysis', (_req, res) => { try { res.json(eng.analyze(null)); } catch (e) { fail(res, e); } });

  router.get('/cloud/inventory', async (req, res) => {
    try { res.json(await eng.cloud.inventory(String(req.query.url || eng.settings.cloud.url), String(req.query.org || eng.settings.cloud.org))); } catch (e) { fail(res, e); }
  });
  router.post('/cloud/connect', express.json(), async (_req, res) => {
    try { res.json(await eng.cloud.start(eng.settings.cloud)); } catch (e) { fail(res, e); }
  });
  router.post('/cloud/disconnect', express.json(), async (_req, res) => { await eng.cloud.stop(); res.json(eng.cloud.status()); });

  router.post('/sync', express.json(), async (req, res) => {
    try { res.json({ sent: await eng.sendSync(['start', 'end', 'check'].includes(req.body && req.body.set) ? req.body.set : 'check') }); } catch (e) { fail(res, e); }
  });

  router.post('/runs/start', express.json(), async (req, res) => {
    try { res.json(await eng.startRun((req.body || {}).name, { sync: (req.body || {}).sync, note: (req.body || {}).note })); } catch (e) { fail(res, e); }
  });
  router.post('/runs/stop', express.json(), async (req, res) => {
    try { res.json(await eng.stopRun('stopped', { sync: (req.body || {}).sync })); } catch (e) { fail(res, e); }
  });
  router.get('/runs', (_req, res) => res.json({ runs: eng.listRuns(), current: eng.run ? eng.run.id : null }));
  router.get('/runs/:id', (req, res) => { try { res.json(eng.analyze(String(req.params.id))); } catch (e) { fail(res, e); } });
  router.get('/runs/:id/events', (req, res) => res.json({ events: eng.readEvents(String(req.params.id)) }));
  router.get('/runs/:id/reveals', (req, res) => {
    const { Vault } = require('../trace/redact');
    const path = require('path');
    res.json({ reveals: new Vault(path.join(__dirname, '..', 'data', 'trace', 'runs', String(req.params.id).replace(/[^\w-]/g, ''))).reveals() });
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
      const a = eng.analyze(String(req.params.id));
      const rows = [CSV_COLS.join(',')].concat(a.traces.map(t => [
        new Date(t.at).toISOString(), t.status, t.sync ? 'yes' : '', t.action.label, ck(t.action.cred), t.decision ? t.decision.type : '', ck(t.decision && t.decision.cred),
        t.credCheck, t.expect || '', t.latency.decision ?? '', t.latency.push ?? '', t.latency.api ?? '', t.notes.join('; '),
      ].map(csvCell).join(',')));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${req.params.id}.csv"`);
      res.send(rows.join('\n') + '\n');
    } catch (e) { fail(res, e); }
  });

  router.post('/runs/:id/import/har', express.text({ type: () => true, limit: '200mb' }), (req, res) => {
    try { res.json(eng.importHar(String(req.params.id), typeof req.body === 'string' ? req.body : JSON.stringify(req.body))); } catch (e) { fail(res, e); }
  });
  router.post('/runs/:id/import/wire', express.json({ limit: '20mb' }), (req, res) => {
    try { res.json(eng.importWire(String(req.params.id), (req.body || {}).packets)); } catch (e) { fail(res, e); }
  });
  router.post('/runs/:id/import/report', express.json(), (req, res) => {
    try { res.json(eng.importReport(String(req.params.id), String((req.body || {}).reportId || ''))); } catch (e) { fail(res, e); }
  });
  router.get('/reports', (_req, res) => res.json({ reports: eng.listReports() }));

  router.get('/reveal', (req, res) => {
    try { res.json({ raw: eng.reveal(req.query.run ? String(req.query.run) : null, String(req.query.event || ''), who(req)) }); } catch (e) { fail(res, e); }
  });

  return router;
};
module.exports.getEngine = getEngine;
