// backend/routes-qr.js — Tools › QR Credentials (AETHER_QR_CREDENTIALS)
//
// Wired from server.js right after the OSDP reader enroller:
//   require('./routes-qr')({ app, io, enroller, getOsdpManager, formatService, releasePort, reopenPort })
// Everything is under /api/qr. Sockets: qr:event, qr:status.
'use strict';

const path = require('path');
const { QrCredentials } = require('./qr/QrCredentials');
const { OsdpListenOnly } = require('./qr/OsdpListenOnly');

module.exports = function attachQr({ app, io, enroller, getOsdpManager, formatService, releasePort, reopenPort, dataFile } = {}) {
  const qr = new QrCredentials({
    file: dataFile || path.join(__dirname, 'data', 'qr-credentials.json'),
    formatService, getOsdpManager,
  });
  const listener = new OsdpListenOnly({ releasePort, reopenPort });
  const emit = (ch, payload) => { try { io && io.emit(ch, payload); } catch { /* */ } };

  // ── Source 1: reader polled by Aether (the enroller is the controller) ─────
  let pollerHooked = false;
  if (enroller && typeof enroller.on === 'function') {
    enroller.on('card', rec => {
      qr.ingest({ source: 'aether', address: enroller.address, osdpFormat: rec.format, binary: rec.binary, wieg: rec.match || null })
        .catch(e => console.warn('[QR] ingest failed:', e.message));
    });
    // osdp_FMT (character data) is only noted by the enroller; catch the text too.
    if (typeof enroller._onFrame === 'function' && typeof enroller._tick === 'function' && typeof enroller._write === 'function') {
      const { decodeFrame } = require('./osdp/trace/osdpDecoder');
      const OSDPPacket = require('./osdp/OSDPPacket');
      const origFrame = enroller._onFrame.bind(enroller);
      enroller._onFrame = function qrFrame(raw) {
        origFrame(raw);
        try {
          const f = decodeFrame(raw);
          if (f.ok && f.isReply && f.name === 'osdp_FMT' && f.decoded) qr.ingest({ source: 'aether', address: f.address, text: f.decoded.fmt }).catch(() => {});
        } catch { /* */ }
      };
      // LED/buzzer feedback: send our command in place of the next poll, so it
      // never overlaps a poll that is still waiting for its reply.
      enroller._qrQueue = [];
      const origTick = enroller._tick.bind(enroller);
      enroller._tick = function qrTick() {
        if (this._qrQueue.length && this.active && this.port && this.port.isOpen && !this.needId) {
          const { cmd, data } = this._qrQueue.shift();
          const seq = this._nextSeq();
          this.stats.polls++;
          this._write(this.port, OSDPPacket.buildPacket({ address: this.address, command: cmd, data, sequence: seq }));
          return;
        }
        return origTick();
      };
      qr.poller = (cmd, data) => { if (enroller.active && enroller._qrQueue.length < 6) enroller._qrQueue.push({ cmd, data }); };
      qr.pollerPort = () => (enroller.active ? enroller.portPath : null);
      pollerHooked = true;
    }
  }

  // ── Source 2: listen-only tap on the reader-to-panel wires ─────────────────
  listener.on('read', r => qr.ingest({ source: 'listen', ...r }).catch(e => console.warn('[QR] ingest failed:', e.message)));
  listener.on('status', s => emit('qr:status', { listen: s }));
  listener.on('error', e => emit('qr:status', { listenError: e.message }));

  qr.on('event', ev => emit('qr:event', ev));
  qr.on('armed', a => emit('qr:status', { armed: a }));

  const pollerStatus = () => {
    if (!enroller || typeof enroller.getStatus !== 'function') return { available: false };
    const s = enroller.getStatus();
    return { available: true, hooked: pollerHooked, active: s.active, port: s.port, baud: s.baud, address: s.address, online: s.online, reader: s.reader, lastReplyAgoMs: s.lastReplyAgoMs };
  };

  const h = fn => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json({ success: true, ...out }); }
    catch (e) { res.status(e.status || 400).json({ success: false, error: e.message }); }
  };

  // The Pi's LAN addresses, so phone links can skip DNS (routers often refuse a
  // public name that points to a private IP: "DNS rebinding protection").
  const lanAddresses = () => {
    const out = [];
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      if (/^(lo|docker|br-|veth|virbr|tun|tap|wg)/.test(name)) continue;
      for (const a of nets[name] || []) if (a.family === 'IPv4' || a.family === 4) { if (!a.internal) out.push({ iface: name, address: a.address }); }
    }
    return out;
  };
  const httpPort = Number(process.env.PORT) || 3001;

  app.get('/api/qr/status', h(req => ({ ...qr.snapshot(Number(req.query.since) || 0), poller: pollerStatus(), listen: listener.status(), formats: qr.formats(), lan: { addresses: lanAddresses(), httpPort } })));
  app.get('/api/qr/events', h(req => { const s = qr.snapshot(Number(req.query.since) || 0); return { events: s.events, lastEventId: s.lastEventId, armed: s.armed }; }));
  app.post('/api/qr/settings', h(req => ({ settings: qr.setSettings(req.body || {}) })));

  app.post('/api/qr/badges', h(req => ({ badge: qr.issueBadge(req.body || {}) })));
  app.post('/api/qr/badges/:id/revoke', h(req => ({ badge: qr.revoke(req.params.id, true) })));
  app.post('/api/qr/badges/:id/restore', h(req => ({ badge: qr.revoke(req.params.id, false) })));
  app.post('/api/qr/badges/:id/relink', h(req => ({ badge: qr.relink(req.params.id) })));
  app.delete('/api/qr/badges/:id', h(req => qr.remove(req.params.id)));
  app.get('/api/qr/badges/:id/code', h(req => qr.currentCode(req.params.id)));
  app.get('/api/qr/enroll/:code', h(req => ({ badge: qr.claimEnrollment(req.params.code) })));
  // Phones re-check the clock and code lifetime whenever they can reach Aether.
  app.get('/api/qr/clock', h(() => ({ serverTime: Date.now(), windowSec: qr.settings.windowSec })));

  app.post('/api/qr/tests', h(req => ({ test: qr.addTest(req.body || {}) })));
  app.delete('/api/qr/tests/:id', h(req => qr.removeTest(req.params.id)));
  app.post('/api/qr/arm', h(req => ({ armed: qr.arm((req.body || {}).testId || null, (req.body || {}).seconds) })));
  app.get('/api/qr/results.csv', (_req, res) => { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="qr-reader-results.csv"'); res.send(qr.resultsCsv()); });
  app.post('/api/qr/results/clear', h(() => { qr.clearResults(); return {}; }));

  app.get('/api/qr/ports', h(async () => ({ ports: enroller && enroller.listPorts ? await enroller.listPorts() : [] })));
  app.post('/api/qr/listen/start', h(async req => ({ listen: await listener.start(req.body || {}) })));
  app.post('/api/qr/listen/stop', h(async () => ({ listen: await listener.stop() })));

  // Bench check without hardware: push text or bits through the same pipeline.
  app.post('/api/qr/simulate', h(async req => {
    const { text, binary, source } = req.body || {};
    if (text == null && !binary) throw new Error('Send text or binary.');
    if (binary && !/^[01]+$/.test(binary)) throw new Error('binary must be 0s and 1s.');
    return { event: await qr.ingest({ source: source === 'listen' ? 'listen' : 'simulated', address: null, text: text != null ? String(text) : undefined, binary }) };
  }));

  console.log(`[QR] QR Credentials ready (${qr.badges.length} badges, ${qr.tests.length} test codes${pollerHooked ? '' : ', reader feedback unavailable'})`);
  return { qr, listener };
};
