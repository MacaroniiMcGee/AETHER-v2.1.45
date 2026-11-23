// backend/routes/traffic.js — Traffic Inspector (/api/traffic), built on mitmproxy.   AETHER_TRAFFIC
//
//   GET    /status            installed?, version, state, settings, listeners, Pi addresses
//   PUT    /settings          {proxyEnabled, proxyPort, devices[{listenPort,target,name}], onlyHosts, autoStopMin, bodyMaxKB}
//   POST   /start             start mitmdump with the saved settings
//   POST   /stop
//   GET    /flows?since=SEQ   flow summaries newer than SEQ (poll this)
//   GET    /flows/:id         one flow with headers and bodies
//   DELETE /flows             clear the list
//   GET    /export.har        HAR 1.2 of the list (?ids=a,b,c for some)
//   GET    /export.mitm       this session's raw flows, for desktop mitmproxy / mitmweb
//   GET    /ca/:fmt           the capture certificate: pem | cer | p12 (never the private key)
//   GET    /log               last mitmdump output lines
//   POST   /gateway/release   stop forwarding for gateway devices (after their gateway is set back)
//   POST   /pcap/start        {mode: devices|all, iface, devices[], limitMB, minutes} — tcpdump via the root helper
//   POST   /pcap/stop
//   GET    /capture.pcap      the packet capture, for Wireshark
'use strict';

const express = require('express');
const TrafficManager = require('../traffic/TrafficManager');

module.exports = function trafficRoutes() {
  const router = express.Router();
  const mgr = new TrafficManager();
  module.exports.current = mgr;   // AETHER_TRACE: Event Trace reads controller flows
  const fail = (res, e) => res.status(e.status || 400).json({ error: e.message });
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

  router.get('/status', async (_req, res) => { try { res.json(await mgr.status()); } catch (e) { fail(res, e); } });
  router.put('/settings', (req, res) => {
    if (mgr.state === 'running' || mgr.state === 'starting') return res.status(409).json({ error: 'Stop the capture before changing its settings' });
    try { res.json(mgr.saveSettings(req.body || {})); } catch (e) { fail(res, e); }
  });
  router.post('/start', async (_req, res) => { try { res.json(await mgr.start()); } catch (e) { fail(res, e); } });
  router.post('/stop', async (_req, res) => { try { res.json(await mgr.stop()); } catch (e) { fail(res, e); } });

  router.get('/flows', (req, res) => res.json(mgr.list(Number(req.query.since) || 0)));
  router.get('/flows/:id', (req, res) => {
    const f = mgr.get(String(req.params.id));
    return f ? res.json(f) : res.status(404).json({ error: 'That request is no longer in the list' });
  });
  router.delete('/flows', (_req, res) => { mgr.clear(); res.json({ ok: true }); });

  router.get('/export.har', (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    res.setHeader('Content-Disposition', `attachment; filename="aether-traffic-${stamp()}.har"`);
    res.type('application/json').send(JSON.stringify(mgr.har(ids), null, 1));
  });
  router.get('/export.mitm', (_req, res) => {
    const f = mgr.sessionFile();
    if (!f) return res.status(404).json({ error: 'No capture yet — start the proxy first' });
    res.download(f, `aether-traffic-${stamp()}.mitm`);
  });
  router.get('/ca/:fmt', (req, res) => {
    const f = mgr.caFile(String(req.params.fmt));
    if (!f) return res.status(404).json({ error: 'The certificate is made the first time the capture starts — start it once' });
    const ext = String(req.params.fmt);
    res.setHeader('Content-Type', ext === 'pem' ? 'application/x-pem-file' : ext === 'cer' ? 'application/x-x509-ca-cert' : 'application/x-pkcs12');
    res.download(f, `aether-capture-ca.${ext}`);
  });
  router.get('/log', (_req, res) => res.json({ lines: mgr.log.slice(-200) }));

  router.post('/gateway/release', async (_req, res) => { try { res.json(await mgr.releaseGateway()); } catch (e) { fail(res, e); } });
  router.post('/pcap/start', async (req, res) => { try { res.json(await mgr.pcapStart(req.body || {})); } catch (e) { fail(res, e); } });
  router.post('/pcap/stop', async (_req, res) => { try { res.json(await mgr.pcapStop()); } catch (e) { fail(res, e); } });
  router.get('/capture.pcap', (_req, res) => {
    const f = mgr.pcapFile();
    if (!f) return res.status(404).json({ error: 'No packet capture yet' });
    res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
    res.download(f, `aether-capture-${stamp()}.pcap`);
  });

  router._manager = mgr;   // tests
  return router;
};
