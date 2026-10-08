// backend/routes-vms.js
// Support endpoints for the VMS Stream View (frontend /stream) and the
// on-demand RTSP pipeline in /streaming.
//
// Mount in server.js:
//   app.use('/api/vms', require('./routes-vms')(io));
//
// Endpoints:
//   GET  /api/vms/elevator-state    -> { success, state }  last state the Elevator page published
//   POST /api/vms/elevator-state    <- state object; re-broadcast as socket 'vms:elevator'
//   GET  /api/vms/display-config    -> { success, config }
//   POST /api/vms/display-config    <- config object (saved to data/vms-display-config.json)
//   GET  /api/vms/stream-status     -> { success, rtspUrl, ready, viewers, ... } from mediamtx's local API
//   POST /api/vms/event             <- { kind, text, where } shown in the Stream View event list

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');

const CONFIG_FILE = path.join(__dirname, 'data', 'vms-display-config.json');
const MTX_API = process.env.MTX_API || 'http://127.0.0.1:9997';
const MTX_PATH = process.env.MTX_PATH || 'aether';
const RTSP_PORT = Number(process.env.RTSP_PORT || 8554);

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

module.exports = function (io) {
  const router = express.Router();
  let elevatorState = null;
  let lastElevatorEmit = 0;

  // ---- Elevator relay ----
  // The elevator simulation runs inside the Elevator page, so the page posts
  // its state here and the Stream View picks it up (GET on load, socket after).
  router.get('/elevator-state', (_req, res) => {
    res.json({ success: true, state: elevatorState });
  });

  router.post('/elevator-state', (req, res) => {
    const s = req.body || {};
    if (!Array.isArray(s.floors)) return res.status(400).json({ success: false, error: 'floors[] required' });
    elevatorState = {
      carFloor: Number(s.carFloor) || 1,
      targetFloor: s.targetFloor == null ? null : Number(s.targetFloor),
      floors: s.floors.slice(0, 32).map(f => ({
        id: Number(f.id), name: String(f.name || `Floor ${f.id}`).slice(0, 40),
        access: !!f.access, called: !!f.called,
      })),
      trips: Number(s.trips) || 0,
      granted: Number(s.granted) || 0,
      denied: Number(s.denied) || 0,
      updatedAt: Date.now(),
    };
    // Cap socket fan-out at 4/s; the Stream View only renders at 1 Hz.
    const now = Date.now();
    if (io && now - lastElevatorEmit > 250) {
      lastElevatorEmit = now;
      io.emit('vms:elevator', elevatorState);
    }
    res.json({ success: true });
  });

  // ---- Free-form events for the Stream View event list ----
  router.post('/event', (req, res) => {
    const { kind = 'system', text, where } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: 'text required' });
    if (io) io.emit('vms:event', { at: Date.now(), kind: String(kind), text: String(text).slice(0, 120), where: where ? String(where).slice(0, 40) : undefined });
    res.json({ success: true });
  });

  // ---- Display config (kept for VMSDisplayConfig in the Config tab) ----
  router.get('/display-config', async (_req, res) => {
    try {
      const raw = await fsp.readFile(CONFIG_FILE, 'utf8').catch(() => null);
      res.json({ success: true, config: raw ? JSON.parse(raw) : null });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/display-config', async (req, res) => {
    try {
      await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ ...(req.body || {}), savedAt: new Date().toISOString() }, null, 2));
      await fsp.rename(tmp, CONFIG_FILE);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- Stream status (from mediamtx, if it is running on this unit) ----
  router.get('/stream-status', async (_req, res) => {
    const host = lanAddress();
    const rtspUrl = `rtsp://${host}:${RTSP_PORT}/${MTX_PATH}`;
    try {
      const p = await getJson(`${MTX_API}/v3/paths/get/${encodeURIComponent(MTX_PATH)}`);
      res.json({
        success: true, installed: true, rtspUrl, host, port: RTSP_PORT, path: MTX_PATH,
        ready: !!p.ready,                                   // capture is publishing frames
        viewers: Array.isArray(p.readers) ? p.readers.length : 0,
        tracks: p.tracks || [],
        bytesSent: p.bytesSent || 0,
      });
    } catch (e) {
      // 404 from mediamtx = path idle (nobody watching, capture not started)
      if (/HTTP 404/.test(e.message)) {
        return res.json({ success: true, installed: true, rtspUrl, host, port: RTSP_PORT, path: MTX_PATH, ready: false, viewers: 0 });
      }
      res.json({ success: true, installed: false, rtspUrl, host, port: RTSP_PORT, path: MTX_PATH, ready: false, viewers: 0, error: 'RTSP service not running on this unit' });
    }
  });

  return router;
};
