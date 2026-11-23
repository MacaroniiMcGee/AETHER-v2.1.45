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
    try { const st = await eng.cloud.start(eng.settings.cloud); eng.refreshDoorConfig().catch(() => {}); res.json(st); } catch (e) { fail(res, e); }
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

  router.get('/reveal', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Aether admin can see plain text' });
    try { res.json({ raw: eng.reveal(req.query.run ? String(req.query.run) : null, String(req.query.event || '').slice(0, 64), who(req)) }); } catch (e) { fail(res, e); }
  });

  return router;
};
module.exports.getEngine = getEngine;
