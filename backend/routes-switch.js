// routes-switch.js — HTTP surface for SwitchManager
//
// Mounted the same way as routes-emulator: a factory taking io and a getter for
// the manager, so a failed SwitchManager init leaves the routes mounted and
// returning a clean 503 rather than crashing the server at require time.
//
//   const switchRoutes = require('./routes-switch');
//   app.use('/api/switch', switchRoutes(io, () => switchManager, logSystemEvent));

const express = require('express');

module.exports = function switchRoutes(io, getManager, logSystemEvent = () => {}) {
  const router = express.Router();

  const withManager = handler => async (req, res) => {
    const mgr = getManager();
    if (!mgr || !mgr.initialized) {
      return res.status(503).json({
        success: false,
        error: 'Switch manager not initialized — check switch-config.json and credentials'
      });
    }
    try {
      await handler(mgr, req, res);
    } catch (err) {
      console.error(`[Switch] ${req.method} ${req.path}:`, err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };

  router.get('/status', withManager(async (mgr, _req, res) => {
    res.json({ success: true, ...mgr.getStatus() });
  }));

  router.get('/profiles', withManager(async (mgr, _req, res) => {
    res.json({ success: true, profiles: mgr.getStatus().profiles });
  }));

  // Cached view of every port — cheap, no SSH. Use /verify for ground truth.
  router.get('/ports/:profileId', withManager(async (mgr, req, res) => {
    const ports = await mgr.refreshProfile(req.params.profileId);
    res.json({ success: true, profileId: req.params.profileId, ports });
  }));

  // Reads the real switch. One SSH round trip.
  router.get('/verify/:profileId/:port', withManager(async (mgr, req, res) => {
    const state = await mgr.verifyPort(req.params.profileId, Number(req.params.port));
    res.json({ success: true, ...state });
  }));

  /**
   * POST /api/switch/port
   * { profileId, port, action: "enable"|"disable", holdMs?, reason? }
   *
   * A disable with no holdMs gets config.defaultHoldMs, not an indefinite hold —
   * the safe default is the one that heals itself.
   */
  router.post('/port', withManager(async (mgr, req, res) => {
    const { profileId, port, ports, action, holdMs, reason } = req.body || {};
    if (!profileId || (port === undefined && !Array.isArray(ports)) || !action) {
      return res.status(400).json({ success: false, error: 'profileId, port (or ports) and action are required' });
    }
    if (!['enable', 'disable'].includes(String(action).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'action must be "enable" or "disable"' });
    }

    const enable = String(action).toLowerCase() === 'enable';
    const opts = {
      holdMs: holdMs === undefined ? undefined : Number(holdMs),
      reason: reason || `api:${req.ip || 'local'}`,
    };

    // Bulk form: one request, per-port outcomes, nothing aborted halfway.
    if (Array.isArray(ports)) {
      const bulk = await mgr.setPorts(profileId, ports, enable, opts);
      io.emit('switch:bulk-change', bulk);
      try {
        const okCount = bulk.results.filter(r => r.ok).length;
        logSystemEvent(`Switch ${profileId}: ${okCount}/${bulk.results.length} ports ${enable ? 'enabled' : 'disabled'}` +
          (reason ? ` (${reason})` : ''), 'info');
      } catch (_) {}
      return res.json({ success: true, ...bulk });
    }

    let result;
    try {
      result = await mgr.setPort(profileId, Number(port), enable, opts);
    } catch (err) {
      // Denylist rejections are the caller's fault, not a server fault — 403 so a
      // scenario runner can tell "you asked for a forbidden port" from "it broke".
      if (/Refusing to touch|out of range/.test(err.message)) {
        return res.status(403).json({ success: false, error: err.message });
      }
      throw err;
    }

    io.emit('switch:port-change', result);
    try {
      logSystemEvent(`Switch ${profileId} port ${port} ${enable ? 'enabled' : 'disabled'}` +
        (reason ? ` (${reason})` : ''), 'info');
    } catch (_) {}

    res.json({ success: true, ...result });
  }));

  /**
   * POST /api/switch/poe
   * { profileId, port, action: "enable"|"disable", holdMs?, reason? }
   *
   * Cutting PoE cold-boots the device; dropping the link does not. Kept as a
   * separate endpoint so a caller has to mean it.
   */
  router.post('/poe', withManager(async (mgr, req, res) => {
    const { profileId, port, ports, action, holdMs, reason } = req.body || {};
    if (!profileId || (port === undefined && !Array.isArray(ports)) || !action) {
      return res.status(400).json({ success: false, error: 'profileId, port (or ports) and action are required' });
    }
    if (!['enable', 'disable'].includes(String(action).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'action must be "enable" or "disable"' });
    }

    const enable = String(action).toLowerCase() === 'enable';
    const opts = {
      holdMs: holdMs === undefined ? undefined : Number(holdMs),
      reason: reason || `api:${req.ip || 'local'}`,
    };

    if (Array.isArray(ports)) {
      const bulk = await mgr.setPoeBulk(profileId, ports, enable, opts);
      io.emit('switch:bulk-change', bulk);
      try {
        const okCount = bulk.results.filter(r => r.ok).length;
        logSystemEvent(`Switch ${profileId}: PoE ${enable ? 'on' : 'off'} for ${okCount}/${bulk.results.length} ports`,
          enable ? 'info' : 'warning');
      } catch (_) {}
      return res.json({ success: true, ...bulk });
    }

    let result;
    try {
      result = await mgr.setPoe(profileId, Number(port), enable, opts);
    } catch (err) {
      if (/Refusing to touch|out of range/.test(err.message)) {
        return res.status(403).json({ success: false, error: err.message });
      }
      throw err;
    }

    io.emit('switch:poe-change', result);
    try {
      logSystemEvent(`Switch ${profileId} port ${port} PoE ${enable ? 'on' : 'off'}` +
        (reason ? ` (${reason})` : ''), enable ? 'info' : 'warning');
    } catch (_) {}

    res.json({ success: true, ...result });
  }));

  /** Name a port: PUT /api/switch/profiles/:id/alias {port, alias} */
  router.put('/profiles/:id/alias', withManager(async (mgr, req, res) => {
    const { port, alias } = req.body || {};
    if (port === undefined) {
      return res.status(400).json({ success: false, error: 'port is required' });
    }
    try {
      const result = await mgr.setPortAlias(req.params.id, Number(port), alias);
      io.emit('switch:alias-changed', result);
      res.json({ success: true, ...result });
    } catch (err) {
      const code = /Unknown switch profile/.test(err.message) ? 404 : 400;
      return res.status(code).json({ success: false, error: err.message });
    }
  }));

  /**
   * PUT /api/switch/poe-max { profileId, port, maxMw }
   * maxMw null clears the cap. This is switch configuration, not a test action.
   */
  router.put('/poe-max', withManager(async (mgr, req, res) => {
    const { profileId, port, maxMw } = req.body || {};
    if (!profileId || port === undefined) {
      return res.status(400).json({ success: false, error: 'profileId and port are required' });
    }
    try {
      const result = await mgr.setPoeMax(profileId, Number(port), maxMw === null ? null : maxMw);
      io.emit('switch:poe-max-changed', result);
      try {
        logSystemEvent(`Switch ${profileId} port ${port} PoE cap ` +
          (result.maxMw === null ? 'cleared' : `${result.maxMw} mW`), 'info');
      } catch (_) {}
      res.json({ success: true, ...result });
    } catch (err) {
      if (/Refusing to touch|out of range|outside the supported/.test(err.message)) {
        return res.status(400).json({ success: false, error: err.message });
      }
      throw err;
    }
  }));

  /** Persist running config. Port and PoE test changes never save; caps should. */
  router.post('/write-config/:profileId', withManager(async (mgr, req, res) => {
    const result = await mgr.writeStartupConfig(req.params.profileId);
    try { logSystemEvent(`Switch ${req.params.profileId} config saved to startup`, 'warning'); } catch (_) {}
    res.json({ success: true, ...result });
  }));

  router.get('/held', withManager(async (mgr, _req, res) => {
    res.json({ success: true, held: mgr.getStatus().heldPorts });
  }));

  // Panic button. Restores everything we are holding down.
  router.post('/revert-all', withManager(async (mgr, req, res) => {
    const results = await mgr.revertAll(req.body?.reason || 'api revert-all');
    io.emit('switch:revert-all', { results });
    try { logSystemEvent(`Switch revert-all: ${results.length} port(s)`, 'warning'); } catch (_) {}
    res.json({ success: true, results });
  }));

  // Re-read hardware and heal drift. Safe to call any time.
  router.post('/reconcile', withManager(async (mgr, _req, res) => {
    const repairs = await mgr.reconcile();
    res.json({ success: true, repairs });
  }));

  // Full console read: status, LLDP labels, counters, uptime. Several SSH round
  // trips, so it is explicit rather than automatic.
  router.post('/snapshot/:profileId', withManager(async (mgr, req, res) => {
    const snap = await mgr.getPortSnapshot(req.params.profileId);
    io.emit('switch:snapshot', {
      profileId: snap.profileId, at: snap.at,
      uptimeSeconds: snap.uptimeSeconds, rebootSuspected: snap.rebootSuspected,
    });
    if (snap.rebootSuspected) {
      try {
        logSystemEvent(`Switch ${snap.profileId} appears to have rebooted — ports were silently re-enabled`, 'warning');
      } catch (_) {}
    }
    res.json({ success: true, ...snap });
  }));

  // Last snapshot without touching the switch.
  router.get('/snapshot/:profileId', withManager(async (mgr, req, res) => {
    const snap = mgr.getCachedSnapshot(req.params.profileId);
    if (!snap) return res.json({ success: true, snapshot: null });
    res.json({ success: true, ...snap });
  }));

  // ── profile management ───────────────────────────────────────────────────

  router.post('/profiles', withManager(async (mgr, req, res) => {
    try {
      const profile = await mgr.addProfile(req.body || {});
      io.emit('switch:profiles-changed', { action: 'add', profileId: profile.id });
      try { logSystemEvent(`Switch profile added: ${profile.name} (${profile.host})`, 'info'); } catch (_) {}
      res.json({ success: true, profile });
    } catch (err) {
      // Bad input, not a server fault — 400 so the editor can show it inline.
      return res.status(400).json({ success: false, error: err.message });
    }
  }));

  router.put('/profiles/:id', withManager(async (mgr, req, res) => {
    try {
      const profile = await mgr.updateProfile(req.params.id, req.body || {});
      io.emit('switch:profiles-changed', { action: 'update', profileId: profile.id });
      res.json({ success: true, profile });
    } catch (err) {
      const code = /Unknown switch profile/.test(err.message) ? 404 : 400;
      return res.status(code).json({ success: false, error: err.message });
    }
  }));

  router.delete('/profiles/:id', withManager(async (mgr, req, res) => {
    try {
      const result = await mgr.deleteProfile(req.params.id);
      io.emit('switch:profiles-changed', { action: 'delete', profileId: req.params.id });
      try { logSystemEvent(`Switch profile deleted: ${req.params.id}`, 'warning'); } catch (_) {}
      res.json({ success: true, ...result });
    } catch (err) {
      const code = /Unknown switch profile/.test(err.message) ? 404 : 409;
      return res.status(code).json({ success: false, error: err.message });
    }
  }));

  /** Store the switch password. Written to switch-credentials.json at 0600,
   *  never into switch-config.json, and never echoed back. */
  router.post('/profiles/:id/password', withManager(async (mgr, req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ success: false, error: 'password is required' });
    try {
      await mgr.setCredential(req.params.id, password);
      res.json({ success: true });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }));

  // Log in and read `show system` — confirms host, credentials and privilege.
  router.post('/profiles/:id/test', withManager(async (mgr, req, res) => {
    try {
      const result = await mgr.testConnection(req.params.id);
      res.json({ success: true, ...result });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  }));

  // ── traffic monitor ──────────────────────────────────────────────────────

  router.post('/monitor/:profileId', withManager(async (mgr, req, res) => {
    // Forward samples to the socket so an open chart updates on its own.
    // Attached here rather than at mount time, because the manager does not
    // exist yet when the routes are first wired up.
    if (!mgr._trafficForwarded) {
      mgr.on('traffic-sample', d => io.emit('switch:traffic-sample', d));
      mgr._trafficForwarded = true;
    }

    const { enabled, intervalMs } = req.body || {};
    if (enabled === false) return res.json({ success: true, ...mgr.stopMonitor(req.params.profileId) });
    const r = await mgr.startMonitor(req.params.profileId, intervalMs);
    io.emit('switch:monitor', { ...r, running: true });
    res.json({ success: true, ...r, running: true });
  }));

  /** Cheap state-only poll for live tiles — link and PoE, no LLDP/ARP/counters. */
  router.get('/live/:profileId', withManager(async (mgr, req, res) => {
    const state = await mgr.getLiveState(req.params.profileId);
    res.json({ success: true, ...state });
  }));

  /** Every state change Aether made, for chart markers and the event list. */
  router.get('/events/:profileId', withManager(async (mgr, req, res) => {
    const since = req.query.since ? Number(req.query.since) : null;
    res.json({ success: true, events: mgr.getEvents(req.params.profileId, since) });
  }));

  /** Traffic for all ports at once — for tile sparklines. */
  router.get('/traffic/:profileId', withManager(async (mgr, req, res) => {
    res.json({ success: true, ...mgr.getAllTraffic(req.params.profileId) });
  }));

  router.get('/traffic/:profileId/:port', withManager(async (mgr, req, res) => {
    res.json({ success: true, ...mgr.getTraffic(req.params.profileId, Number(req.params.port)) });
  }));

  router.get('/stats', withManager(async (mgr, _req, res) => {
    res.json({ success: true, stats: mgr.getStatus().stats });
  }));

  return router;
};
