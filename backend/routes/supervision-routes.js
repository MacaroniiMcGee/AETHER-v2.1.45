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
      rref: supervision.rref,
      vcc: supervision.vcc,
      thresholds: supervision.thresholds,
      zonesPerBoard: supervision.zonesPerBoard,
      maxBoards: supervision.maxBoards
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
      'GET /api/supervision/config'
    ]
  });
});

module.exports = router;
