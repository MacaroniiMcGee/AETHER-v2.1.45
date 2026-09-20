// backend/routes-doors.js
// Durable persistence for the Doors section configuration (doors + their
// custom event sequences). Mirrors the proven /api/emulations pattern:
// a single JSON file on disk, so the config survives a backend reboot.
//
// Mount in server.js with ONE line (see install notes):
//   app.use('/api/doors', require('./routes-doors')());
//
// Endpoints:
//   GET  /api/doors/config        -> { success, config }   (config: null if none saved yet)
//   POST /api/doors/config        -> { success }            (body = the full config object)
//   DELETE /api/doors/config      -> { success }            (clears saved config)
//
// The frontend (DoorSection.tsx) POSTs the entire door config on "Save
// Settings" and GETs it on startup so events load after a reboot.

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');

module.exports = function () {
  const router = express.Router();

  // Self-contained data location; created on demand. Kept separate from
  // the sequences dir so door config and emulation sequences never collide.
  const DOORS_DIR = path.join(__dirname, 'data', 'doors');
  const CONFIG_FILE = path.join(DOORS_DIR, 'door-config.json');

  async function ensureDir() {
    try { await fsp.mkdir(DOORS_DIR, { recursive: true }); } catch (_) {}
  }

  // GET current saved config (null if nothing saved yet — NOT an error)
  router.get('/config', async (_req, res) => {
    try {
      await ensureDir();
      let raw;
      try {
        raw = await fsp.readFile(CONFIG_FILE, 'utf8');
      } catch (e) {
        // File doesn't exist yet -> no config saved; that's a normal state.
        return res.json({ success: true, config: null });
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // Corrupt file -> report but don't crash; frontend falls back.
        return res.status(500).json({ success: false, error: 'Saved door config is corrupt JSON' });
      }
      return res.json({ success: true, config: parsed });
    } catch (e) {
      return res.status(500).json({ success: false, error: (e && e.message) ? e.message : String(e) });
    }
  });

  // POST/save the full config (atomic write via temp file + rename so a
  // crash mid-write can't leave a half-written, unparseable config).
  router.post('/config', async (req, res) => {
    try {
      const config = req.body;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return res.status(400).json({ success: false, error: 'Body must be a config object' });
      }
      if (!Array.isArray(config.doors)) {
        return res.status(400).json({ success: false, error: 'config.doors[] is required' });
      }
      await ensureDir();
      const payload = {
        ...config,
        savedAt: new Date().toISOString(),
      };
      const tmp = CONFIG_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fsp.rename(tmp, CONFIG_FILE);
      return res.json({ success: true, savedAt: payload.savedAt, doors: config.doors.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: (e && e.message) ? e.message : String(e) });
    }
  });

  // DELETE saved config (optional housekeeping)
  router.delete('/config', async (_req, res) => {
    try {
      await fsp.unlink(CONFIG_FILE).catch(() => {});
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: (e && e.message) ? e.message : String(e) });
    }
  });

  return router;
};
