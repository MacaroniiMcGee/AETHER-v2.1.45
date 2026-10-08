const express = require('express');
const router = express.Router();
const supervision = require('../controllers/supervisionController');

/**
 * Supervision Monitoring Routes
 * 1K/2K Supervision for alarm zones
 */

// ==================== SYSTEM STATUS ====================

/**
 * GET /api/supervision/status
 * Get comprehensive supervision status for all zones
 */
router.get('/status', async (req, res) => {
  try {
    const status = await supervision.getStatus();
    res.json(status);
  } catch (error) {
    console.error('[Supervision Routes] Status error:', error);
    res.status(500).json({
      error: error.message,
      controller: 'supervision',
      healthy: false
    });
  }
});

/**
 * GET /api/supervision/health
 * Health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    const health = await supervision.healthCheck();
    res.json(health);
  } catch (error) {
    console.error('[Supervision Routes] Health check error:', error);
    res.status(500).json({
      healthy: false,
      error: error.message
    });
  }
});

// ==================== ZONE OPERATIONS ====================

/**
 * GET /api/supervision/zone/:board/:channel
 * Read specific supervision zone
 */
router.get('/zone/:board/:channel', async (req, res) => {
  try {
    const board = parseInt(req.params.board);
    const channel = parseInt(req.params.channel);
    
    if (isNaN(board) || isNaN(channel)) {
      return res.status(400).json({ 
        error: 'Invalid board or channel number' 
      });
    }
    
    const zone = await supervision.readZone(board, channel);
    res.json(zone);
  } catch (error) {
    console.error('[Supervision Routes] Zone read error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/supervision/board/:board/zones
 * Get all zones on a specific board
 */
router.get('/board/:board/zones', async (req, res) => {
  try {
    const board = parseInt(req.params.board);
    
    if (isNaN(board)) {
      return res.status(400).json({ error: 'Invalid board number' });
    }
    
    const zones = await supervision.readAllZones(board);
    
    res.json({
      board,
      zones,
      summary: {
        total: zones.length,
        alarms: zones.filter(z => z.state === 'ALARM').length,
        tampers: zones.filter(z => z.state === 'TAMPER').length,
        troubles: zones.filter(z => z.state === 'TROUBLE').length,
        normal: zones.filter(z => z.state === 'NORMAL').length
      }
    });
  } catch (error) {
    console.error('[Supervision Routes] Board zones error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ALARM QUERIES ====================

/**
 * GET /api/supervision/alarms
 * Get all zones currently in alarm state
 */
router.get('/alarms', async (req, res) => {
  try {
    const status = await supervision.getStatus();
    
    const alarms = [];
    status.boards.forEach(board => {
      if (board.zones) {
        board.zones.forEach(zone => {
          if (zone.state === 'ALARM') {
            alarms.push(zone);
          }
        });
      }
    });
    
    res.json({
      count: alarms.length,
      alarms
    });
  } catch (error) {
    console.error('[Supervision Routes] Alarms query error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/supervision/tampers
 * Get all zones currently in tamper state
 */
router.get('/tampers', async (req, res) => {
  try {
    const status = await supervision.getStatus();
    
    const tampers = [];
    status.boards.forEach(board => {
      if (board.zones) {
        board.zones.forEach(zone => {
          if (zone.state === 'TAMPER') {
            tampers.push(zone);
          }
        });
      }
    });
    
    res.json({
      count: tampers.length,
      tampers
    });
  } catch (error) {
    console.error('[Supervision Routes] Tampers query error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/supervision/troubles
 * Get all zones currently in trouble state
 */
router.get('/troubles', async (req, res) => {
  try {
    const status = await supervision.getStatus();
    
    const troubles = [];
    status.boards.forEach(board => {
      if (board.zones) {
        board.zones.forEach(zone => {
          if (zone.state === 'TROUBLE') {
            troubles.push(zone);
          }
        });
      }
    });
    
    res.json({
      count: troubles.length,
      troubles
    });
  } catch (error) {
    console.error('[Supervision Routes] Troubles query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== UTILITIES ====================

/**
 * POST /api/supervision/detect-boards
 * Detect available boards with analog inputs
 */
router.post('/detect-boards', async (req, res) => {
  try {
    const boards = await supervision.detectBoards();
    
    res.json({
      success: true,
      detectedBoards: boards,
      totalBoards: boards.length
    });
  } catch (error) {
    console.error('[Supervision Routes] Detect boards error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/supervision/calibrate/:board/:channel
 * Calibrate a specific zone
 * Body: { expectedState: 'NORMAL' | 'ALARM' | 'TAMPER' | 'TROUBLE' }
 */
router.post('/calibrate/:board/:channel', async (req, res) => {
  try {
    const board = parseInt(req.params.board);
    const channel = parseInt(req.params.channel);
    const { expectedState } = req.body;
    
    if (isNaN(board) || isNaN(channel)) {
      return res.status(400).json({ 
        error: 'Invalid board or channel number' 
      });
    }
    
    if (!expectedState) {
      return res.status(400).json({ 
        error: 'Missing expectedState parameter' 
      });
    }
    
    const result = await supervision.calibrateZone(board, channel, expectedState);
    
    res.json({
      success: true,
      calibration: result,
      message: `Zone ${board}-${channel} calibrated for ${expectedState}`
    });
  } catch (error) {
    console.error('[Supervision Routes] Calibrate error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/supervision/config
 * Get current configuration (thresholds, reference resistor, etc.)
 */
router.get('/config', async (req, res) => {
  try {
    res.json({
      vcc: supervision.vcc,
      eolResistor: supervision.eolResistor,
      alarmResistor: supervision.alarmResistor,
      thresholds: supervision.thresholds,
      calibrationDate: supervision.calibration ? supervision.calibration.calibrationDate : null,
      defaultProfile: supervision.getDefaultProfile().name,
      zoneProfiles: supervision.store.zoneProfiles,
      zonesPerBoard: supervision.zonesPerBoard,
      maxBoards: supervision.maxBoards
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 4-POINT EOL CALIBRATION ====================
// Guided version of backend/4point.sh. Flow:
//   start -> capture TAMPER, ALARM, NORMAL, TROUBLE (any order, re-capture allowed)
//   -> review the preview -> apply as a named profile (e.g. "1k/2.2k", "3k/4.5k")
// Profiles, the default profile and per-zone overrides are saved in
// data/supervision-calibration.json.

const badRequest = (res, error) => res.status(400).json({ success: false, error: error.message || String(error) });

/**
 * GET /api/supervision/calibration
 * Current thresholds, last applied calibration, session in progress, history
 */
router.get('/calibration', (req, res) => {
  try {
    res.json({ success: true, ...supervision.getCalibrationInfo() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/supervision/calibration/start
 * Body: { board, channel, eolResistor?, alarmResistor?, samples?, technician?, notes?,
 *         profileId? (recalibrate an existing profile) }
 */
router.post('/calibration/start', (req, res) => {
  try {
    const { board = 0, channel, ...options } = req.body || {};
    const session = supervision.startCalibration(parseInt(board, 10), parseInt(channel, 10), options);
    res.json({ success: true, session });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/supervision/calibration/capture
 * Body: { state: 'TAMPER' | 'ALARM' | 'NORMAL' | 'TROUBLE', samples? }
 */
router.post('/calibration/capture', async (req, res) => {
  try {
    const { state, samples } = req.body || {};
    const result = await supervision.captureCalibrationPoint(state, samples);
    res.json({ success: true, ...result });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * GET /api/supervision/calibration/sample/:board/:channel?samples=5
 * Averaged reading without touching the session (for the live meter)
 */
router.get('/calibration/sample/:board/:channel', async (req, res) => {
  try {
    const board = parseInt(req.params.board, 10);
    const channel = parseInt(req.params.channel, 10);
    const samples = parseInt(req.query.samples, 10) || 3;
    const reading = await supervision.sampleVoltage(board, channel, samples, 50);
    const profile = supervision.getZoneProfile(board, channel);
    res.json({
      success: true, ...reading,
      state: supervision.getZoneState(reading.millivolts, board, channel),
      profileId: profile.id, profileName: profile.name
    });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/supervision/calibration/apply
 * Save the captured calibration as a named profile
 * Body: { name?, profileId? (overwrite), makeDefault?, assignZone? }
 */
router.post('/calibration/apply', (req, res) => {
  try {
    const profile = supervision.applyCalibration(req.body || {});
    res.json({ success: true, profile, calibration: profile, defaultProfileId: supervision.getDefaultProfile().id });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/supervision/calibration/cancel
 */
router.post('/calibration/cancel', (req, res) => {
  res.json({ success: true, cancelled: supervision.cancelCalibration() });
});

/**
 * POST /api/supervision/calibration/reset
 * Factory profile becomes the default and zone overrides are cleared.
 * Saved profiles are kept.
 */
router.post('/calibration/reset', (req, res) => {
  try {
    supervision.resetCalibrationToDefaults();
    res.json({ success: true, defaultProfileId: 'factory', thresholds: supervision.thresholds });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- Profiles ----------

/**
 * GET /api/supervision/calibration/profiles
 */
router.get('/calibration/profiles', (req, res) => {
  res.json({
    success: true,
    defaultProfileId: supervision.getDefaultProfile().id,
    profiles: supervision.getProfiles(),
    zoneProfiles: supervision.store.zoneProfiles
  });
});

/**
 * PUT /api/supervision/calibration/profiles/:id
 * Body: { name }
 */
router.put('/calibration/profiles/:id', (req, res) => {
  try {
    const profile = supervision.renameProfile(req.params.id, (req.body || {}).name);
    res.json({ success: true, profile });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * POST /api/supervision/calibration/profiles/:id/default
 * Use this profile for every zone without its own override
 */
router.post('/calibration/profiles/:id/default', (req, res) => {
  try {
    const profile = supervision.setDefaultProfile(req.params.id);
    res.json({ success: true, profile, thresholds: supervision.thresholds });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * DELETE /api/supervision/calibration/profiles/:id
 * Zones using it go back to the default; if it was the default, factory takes over
 */
router.delete('/calibration/profiles/:id', (req, res) => {
  try {
    const result = supervision.deleteProfile(req.params.id);
    res.json({ success: true, ...result, defaultProfileId: supervision.getDefaultProfile().id });
  } catch (error) {
    badRequest(res, error);
  }
});

/**
 * PUT /api/supervision/calibration/zones/:board/:channel
 * Body: { profileId } — null or "default" to follow the default profile
 */
router.put('/calibration/zones/:board/:channel', (req, res) => {
  try {
    const result = supervision.assignZoneProfile(
      parseInt(req.params.board, 10), parseInt(req.params.channel, 10), (req.body || {}).profileId
    );
    res.json({ success: true, ...result });
  } catch (error) {
    badRequest(res, error);
  }
});

// ==================== ERROR HANDLING ====================

// 404 handler for unknown supervision routes
router.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    availableEndpoints: [
      'GET /api/supervision/status',
      'GET /api/supervision/health',
      'GET /api/supervision/zone/:board/:channel',
      'GET /api/supervision/board/:board/zones',
      'GET /api/supervision/alarms',
      'GET /api/supervision/tampers',
      'GET /api/supervision/troubles',
      'POST /api/supervision/detect-boards',
      'POST /api/supervision/calibrate/:board/:channel',
      'GET /api/supervision/config',
      'GET /api/supervision/calibration',
      'POST /api/supervision/calibration/start',
      'POST /api/supervision/calibration/capture',
      'GET /api/supervision/calibration/sample/:board/:channel',
      'POST /api/supervision/calibration/apply',
      'POST /api/supervision/calibration/cancel',
      'POST /api/supervision/calibration/reset',
      'GET /api/supervision/calibration/profiles',
      'PUT /api/supervision/calibration/profiles/:id',
      'POST /api/supervision/calibration/profiles/:id/default',
      'DELETE /api/supervision/calibration/profiles/:id',
      'PUT /api/supervision/calibration/zones/:board/:channel'
    ]
  });
});

module.exports = router;
