// backend/routes-emulator.js
const express = require('express');
const { SerialPort } = require('serialport');
const emulator = require('./osdp/OSDPDeviceEmulator');

module.exports = function(io, logSystem = () => {}, osdpManagerArg = null) {
  const router = express.Router();
  const getMgr = () => typeof osdpManagerArg === 'function' ? osdpManagerArg() : osdpManagerArg;
  const portsReleasedByEmulator = new Set();

  if (!emulator._wired) {
    emulator._wired = true;
    emulator.emit = (evt, payload) => { if (io) io.emit(evt, payload); };
    emulator.log  = (level, msg) => logSystem(level, msg);
  }

  router.get('/models', (_req, res) => {
    res.json({ success: true,
      models: Object.keys(require('./osdp/OSDPDeviceEmulator').MODEL_REGISTRY) });
  });

  router.get('/ports', async (_req, res) => {
    try {
      const ports = await SerialPort.list();
      res.json({ success: true, ports: ports.map(p => ({
        path: p.path, manufacturer: p.manufacturer || null, serialNumber: p.serialNumber || null
      })) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.get('/port-ownership', (req, res) => {
    const portPath = req.query.port;
    if (!portPath) return res.status(400).json({ success: false, error: 'port query param required' });
    const mgr = getMgr();
    if (!mgr || !mgr.serialPorts) return res.json({ success: true, ownedByOsdp: false, readers: [] });
    const ownedByOsdp = mgr.serialPorts.has(portPath);
    const readers = (mgr.getReadersOnPort && mgr.getReadersOnPort(portPath)) || [];
    res.json({ success: true, ownedByOsdp, readers });
  });

  router.get('/status', (_req, res) => {
    res.json({ success: true, status: emulator.status() });
  });

  router.post('/start', async (req, res) => {
    try {
      const portPath = req.body.port;
      const baud = parseInt(req.body.baud) || 9600;
      const force = !!req.body.force;
      const mgr = getMgr();

      if (mgr && mgr.serialPorts?.has(portPath)) {
        const readers = (mgr.getReadersOnPort && mgr.getReadersOnPort(portPath)) || [];
        if (!force) {
          return res.status(409).json({
            success: false, error: 'port_in_use', inUseBy: 'osdp-readers', portPath, readers,
            message: `Port ${portPath} is currently in use by OSDP reader emulation (${readers.length} reader(s) configured). Confirm to release it for the Controller Emulator.`,
          });
        }
        if (typeof mgr.releasePort === 'function') {
          await mgr.releasePort(portPath);
          portsReleasedByEmulator.add(portPath);
          logSystem('info', `[Emulator] Released ${portPath} from OSDPManager (${readers.length} reader(s) paused)`);
        }
      }

      await emulator.start({ port: portPath, baud });
      res.json({ success: true, status: emulator.status() });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  router.post('/stop', async (_req, res) => {
    try {
      const currentPort = emulator.status().port;
      await emulator.stop();
      if (currentPort && portsReleasedByEmulator.has(currentPort)) {
        const mgr = getMgr();
        if (mgr && typeof mgr.reacquirePort === 'function') {
          const r = await mgr.reacquirePort(currentPort);
          if (r.acquired) logSystem('info', `[Emulator] Re-acquired ${currentPort} for OSDPManager`);
          else logSystem('warn', `[Emulator] Could not reacquire ${currentPort}: ${r.reason}`);
        }
        portsReleasedByEmulator.delete(currentPort);
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.post('/device', (req, res) => {
    try {
      const { address, model, identity } = req.body;
      const dev = emulator.addDevice(parseInt(address), model, identity);
      res.json({ success: true, device: dev.snapshot() });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  router.delete('/device/:address', (req, res) => {
    const ok = emulator.removeDevice(parseInt(req.params.address));
    res.json({ success: ok });
  });

  router.post('/device/:address/input/:idx', (req, res) => {
    const addr = parseInt(req.params.address);
    const idx = parseInt(req.params.idx);
    const ok = emulator.setInput(addr, idx, !!req.body.active);
    if (!ok) return res.status(404).json({ success: false, error: 'No such device or input index' });
    const dev = emulator.getDevice(addr);
    res.json({ success: true, device: dev.snapshot() });
  });

  router.get('/device/:address', (req, res) => {
    const dev = emulator.getDevice(parseInt(req.params.address));
    if (!dev) return res.status(404).json({ success: false, error: 'No such device' });
    res.json({ success: true, device: dev.snapshot() });
  });


  // ── DEBUG: directly poke an output state (bypasses IC2) ───────────────
  router.post('/device/:address/output/:idx', (req, res) => {
    const addr = parseInt(req.params.address);
    const idx  = parseInt(req.params.idx);
    const val  = !!req.body.active;
    const dev = emulator.getDevice(addr);
    if (!dev) return res.status(404).json({ success: false, error: 'no device' });
    if (idx >= dev.numOutputs) return res.status(400).json({ success: false, error: 'idx out of range' });
    dev.outputs[idx] = val ? 1 : 0;
    dev.emit('output-changed', { address: addr, outNum: idx, state: val ? 1 : 0, auto: false });
    res.json({ success: true, outputs: Array.from(dev.outputs) });
  });


  // ── Emulator config: save / export / import ───────────────────────────
  // Configs are stored as JSON in backend/emulator-configs/ (local to this machine).
  const _cfgFs   = require('fs');
  const _cfgPath = require('path');
  const CONFIG_DIR = _cfgPath.join(__dirname, 'emulator-configs');
  if (!_cfgFs.existsSync(CONFIG_DIR)) _cfgFs.mkdirSync(CONFIG_DIR, { recursive: true });
  const _safeName = (n) => String(n || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  const _cfgFile  = (n) => _cfgPath.join(CONFIG_DIR, _safeName(n) + '.json');

  // List all saved configs (must be registered before /config/:name)
  router.post('/device/:address/tamper', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const active = !!req.body.active;
    const result = emulator.setTamper(addr, active);
    res.json(result);
  });

  router.post('/device/:address/powerfail', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const active = !!req.body.active;
    const result = emulator.setPowerFail(addr, active);
    res.json(result);
  });

  router.post('/device/:address/reader/:port/card', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const port = parseInt(req.params.port, 10);
    const { format, facility, card, issueLevel } = req.body || {};
    if (!format) {
      return res.status(400).json({ success: false, error: 'format (formatId) required' });
    }
    const result = emulator.queueCardRead(
      addr, port,
      String(format),
      Number(facility) || 0,
      Number(card) || 0,
      Number(issueLevel) || 0,
    );
    res.json(result);
  });

  router.post('/device/:address/reader/:port/keys', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const port = parseInt(req.params.port, 10);
    const { keys } = req.body || {};
    if (!keys && keys !== 0) {
      return res.status(400).json({ success: false, error: 'keys required (string or array)' });
    }
    const result = emulator.queueKeypadKeys(addr, port, keys);
    res.json(result);
  });

  router.get('/config/list', (req, res) => {
    try {
      const files = _cfgFs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'));
      const configs = files.map(f => {
        try {
          const d = JSON.parse(_cfgFs.readFileSync(_cfgPath.join(CONFIG_DIR, f), 'utf8'));
          return { name: f.replace(/\.json$/, ''), savedAt: d.savedAt || null,
                   deviceCount: Array.isArray(d.devices) ? d.devices.length : 0,
                   port: d.port || null, baud: d.baud || null };
        } catch { return { name: f.replace(/\.json$/, ''), error: 'unreadable' }; }
      });
      res.json({ success: true, configs });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Save the current emulator device set to a named config
  router.post('/config/save', (req, res) => {
    try {
      const name = _safeName(req.body.name);
      if (!name) return res.status(400).json({ success: false, error: 'name required' });
      const st = emulator.status();
      const devices = (st.devices || []).map(d => ({ address: d.address, model: d.model }));
      const payload = { name, savedAt: new Date().toISOString(),
                        port: st.port || req.body.port || null,
                        baud: st.baud || req.body.baud || 9600, devices };
      _cfgFs.writeFileSync(_cfgFile(name), JSON.stringify(payload, null, 2));
      res.json({ success: true, config: payload });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Apply a saved config — clears current devices and re-adds from the file
  router.post('/config/apply/:name', (req, res) => {
    try {
      const fp = _cfgFile(req.params.name);
      if (!_cfgFs.existsSync(fp)) return res.status(404).json({ success: false, error: 'not found' });
      const cfg = JSON.parse(_cfgFs.readFileSync(fp, 'utf8'));
      if (!Array.isArray(cfg.devices)) return res.status(400).json({ success: false, error: 'config has no devices array' });
      emulator.devices.clear();
      for (const d of cfg.devices) emulator._addDevice(d.address, d.model, d.identity || {});
      if (io) io.emit('emulator-config-applied', { name: _safeName(req.params.name), devices: cfg.devices });
      res.json({ success: true, applied: _safeName(req.params.name),
                 devices: cfg.devices, running: emulator.running });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Export — download the raw config JSON file
  router.get('/config/export/:name', (req, res) => {
    const fp = _cfgFile(req.params.name);
    if (!_cfgFs.existsSync(fp)) return res.status(404).json({ success: false, error: 'not found' });
    res.download(fp, _safeName(req.params.name) + '.json');
  });

  // Import — accept a posted config JSON and save it to the configs dir
  router.post('/config/import', (req, res) => {
    try {
      const cfg = (req.body && req.body.config) ? req.body.config : req.body;
      if (!cfg || !Array.isArray(cfg.devices))
        return res.status(400).json({ success: false, error: 'invalid config (need devices array)' });
      const name = _safeName(cfg.name || req.body.name || ('imported-' + Date.now()));
      const payload = { name, savedAt: new Date().toISOString(),
                        port: cfg.port || null, baud: cfg.baud || 9600, devices: cfg.devices };
      _cfgFs.writeFileSync(_cfgFile(name), JSON.stringify(payload, null, 2));
      res.json({ success: true, imported: name, config: payload });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Get one saved config's contents (generic — registered last)
  router.get('/config/:name', (req, res) => {
    try {
      const fp = _cfgFile(req.params.name);
      if (!_cfgFs.existsSync(fp)) return res.status(404).json({ success: false, error: 'not found' });
      res.json({ success: true, config: JSON.parse(_cfgFs.readFileSync(fp, 'utf8')) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Delete a saved config
  router.delete('/config/:name', (req, res) => {
    try {
      const fp = _cfgFile(req.params.name);
      if (!_cfgFs.existsSync(fp)) return res.status(404).json({ success: false, error: 'not found' });
      _cfgFs.unlinkSync(fp);
      res.json({ success: true, deleted: _safeName(req.params.name) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  return router;
};
