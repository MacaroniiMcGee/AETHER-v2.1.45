/**
 * gpio-routes.js - ENHANCED with Input Type Configuration
 * 
 * New endpoints:
 * - GET  /api/gpio/input/config - Get input configuration
 * - POST /api/gpio/input/config - Set input type (opto/analog)
 */

const express = require('express');
const router = express.Router();
const ioplusController = require('../controllers/ioplusController');

// ==================== RELAY ENDPOINTS ====================

/**
 * Set relay state
 * POST /api/gpio/set
 * Body: { pin: 0-7, state: 0|1 }
 */
router.post('/set', async (req, res) => {
  try {
    const { pin, state } = req.body;
    
    if (pin === undefined || state === undefined) {
      return res.status(400).json({ error: 'Missing pin or state' });
    }
    
    const pinNum = parseInt(pin);
    const stateNum = parseInt(state);
    
    console.log(`[GPIO Routes] Set relay request: pin=${pinNum}, state=${stateNum}`);
    
    await ioplusController.setRelay(pinNum, stateNum);
    
    res.json({ success: true, pin: pinNum, state: stateNum });
  } catch (error) {
    console.error('[GPIO Routes] Set relay error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Pulse relay (turn on then off after duration)
 * POST /api/gpio/pulse
 * Body: { pin: 0-7, duration: milliseconds }
 */
router.post('/pulse', async (req, res) => {
  try {
    const { pin, duration = 3000 } = req.body;
    
    if (pin === undefined) {
      return res.status(400).json({ error: 'Missing pin' });
    }
    
    const pinNum = parseInt(pin);
    const durationNum = parseInt(duration);
    
    console.log(`[GPIO Routes] Pulse relay request: pin=${pinNum}, duration=${durationNum}ms`);
    
    await ioplusController.pulseRelay(pinNum, durationNum);
    
    res.json({ success: true, pin: pinNum, duration: durationNum });
  } catch (error) {
    console.error('[GPIO Routes] Pulse relay error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get relay state
 * GET /api/gpio/relay/:pin
 */
router.get('/relay/:pin', async (req, res) => {
  try {
    const pin = parseInt(req.params.pin);
    
    console.log(`[GPIO Routes] Get relay state: pin=${pin}`);
    
    const state = await ioplusController.getRelay(pin);
    
    res.json({ pin, state });
  } catch (error) {
    console.error('[GPIO Routes] Get relay error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all relay states
 * GET /api/gpio/relays
 */
router.get('/relays', async (req, res) => {
  try {
    console.log('[GPIO Routes] Get all relays');
    
    const states = await ioplusController.getAllRelays();
    
    res.json({ relays: states });
  } catch (error) {
    console.error('[GPIO Routes] Get relays error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INPUT ENDPOINTS ====================

/**
 * Read input (auto-detects opto or analog based on config)
 * GET /api/gpio/input/:pin
 * Returns: { type: 'opto'|'analog', digital: 0|1, voltage?: number, threshold?: number }
 */
router.get('/input/:pin', async (req, res) => {
  try {
    const pin = parseInt(req.params.pin);
    
    console.log(`[GPIO Routes] Read input: pin=${pin}`);
    
    const result = await ioplusController.readInput(pin);
    
    res.json({ pin, ...result });
  } catch (error) {
    console.error('[GPIO Routes] Read input error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all input states
 * GET /api/gpio/inputs
 */
router.get('/inputs', async (req, res) => {
  try {
    console.log('[GPIO Routes] Get all inputs');
    
    const states = await ioplusController.getAllInputs();
    
    res.json({ inputs: states });
  } catch (error) {
    console.error('[GPIO Routes] Get inputs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INPUT CONFIGURATION ====================

/**
 * Get input configuration
 * GET /api/gpio/input/config
 * Returns: { inputTypes: [], analogThresholds: [] }
 */
router.get('/input/config', async (req, res) => {
  try {
    console.log('[GPIO Routes] Get input configuration');
    
    const config = ioplusController.getInputConfig();
    
    res.json(config);
  } catch (error) {
    console.error('[GPIO Routes] Get input config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Set input type configuration
 * POST /api/gpio/input/config
 * Body: { pin: 0-7, type: 'opto'|'analog', threshold?: 5.0 }
 */
router.post('/input/config', async (req, res) => {
  try {
    const { pin, type, threshold } = req.body;
    
    if (pin === undefined || !type) {
      return res.status(400).json({ error: 'Missing pin or type' });
    }
    
    const pinNum = parseInt(pin);
    const thresholdNum = threshold ? parseFloat(threshold) : 5.0;
    
    console.log(`[GPIO Routes] Set input config: pin=${pinNum}, type=${type}, threshold=${thresholdNum}`);
    
    const result = await ioplusController.setInputType(pinNum, type, thresholdNum);
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[GPIO Routes] Set input config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Batch update input configuration
 * POST /api/gpio/input/config/batch
 * Body: { configs: [{ pin, type, threshold }] }
 */
router.post('/input/config/batch', async (req, res) => {
  try {
    const { configs } = req.body;
    
    if (!Array.isArray(configs)) {
      return res.status(400).json({ error: 'configs must be an array' });
    }
    
    console.log(`[GPIO Routes] Batch update input config: ${configs.length} inputs`);
    
    const results = [];
    for (const config of configs) {
      try {
        const result = await ioplusController.setInputType(
          parseInt(config.pin),
          config.type,
          config.threshold ? parseFloat(config.threshold) : 5.0
        );
        results.push({ success: true, ...result });
      } catch (error) {
        results.push({ success: false, pin: config.pin, error: error.message });
      }
    }
    
    res.json({ results });
  } catch (error) {
    console.error('[GPIO Routes] Batch config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATUS ENDPOINTS ====================

/**
 * Get complete system status
 * GET /api/gpio/status
 */
router.get('/status', async (req, res) => {
  try {
    console.log('[GPIO Routes] Get system status');
    
    const status = await ioplusController.getStatus();
    
    res.json(status);
  } catch (error) {
    console.error('[GPIO Routes] Get status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get board information
 * GET /api/gpio/board
 */
router.get('/board', async (req, res) => {
  try {
    console.log('[GPIO Routes] Get board info');
    
    const info = await ioplusController.getBoardInfo();
    
    res.json(info);
  } catch (error) {
    console.error('[GPIO Routes] Get board info error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Turn all relays off (emergency stop)
 * POST /api/gpio/alloff
 */
router.post('/alloff', async (req, res) => {
  try {
    console.log('[GPIO Routes] Turn all relays off');
    
    const results = await ioplusController.allRelaysOff();
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('[GPIO Routes] All off error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
