// config.js - Updated for WiegandManager with binary transmission
// Works with Raspberry Pi 5 + libgpiod v2

const WiegandManager = require('./WiegandManager');

// Global Wiegand manager instance
let wiegandManager = null;

/**
 * Initialize Wiegand system
 * Call this during server startup
 */
async function initializeWiegand() {
  console.log('[Wiegand API] Initializing Wiegand system...');
  
  try {
    wiegandManager = new WiegandManager();
    await wiegandManager.initialize();
    
    const status = wiegandManager.getStatus();
    
    if (!status.binaryExists) {
      console.error('[Wiegand API] ⚠️ WARNING: Wiegand binary not found!');
      console.error('[Wiegand API] Transmission will NOT work until binary is compiled.');
      console.error('[Wiegand API] To fix: cd wiegand && make');
    }
    
    if (status.readers.length === 0) {
      console.warn('[Wiegand API] ⚠️ WARNING: No readers configured!');
    }
    
    console.log('[Wiegand API] ✓ Initialization complete');
    console.log(`[Wiegand API]   Readers: ${status.readersCount}`);
    console.log(`[Wiegand API]   Binary: ${status.binaryExists ? '✓' : '✗'}`);
    console.log(`[Wiegand API]   Ready: ${status.ready ? '✓' : '✗'}`);
    
    return wiegandManager;
  } catch (error) {
    console.error('[Wiegand API] ✗ Initialization failed:', error.message);
    console.warn('[Wiegand API] Continuing without Wiegand support');
    return null;
  }
}

/**
 * GET /api/wiegand/config
 * Returns Wiegand reader configuration
 */
function getWiegandConfig(req, res) {
  if (!wiegandManager) {
    return res.status(503).json({
      ok: false,
      error: 'Wiegand system not initialized'
    });
  }

  try {
    const status = wiegandManager.getStatus();
    const readers = wiegandManager.getReaders();

    res.json({
      ok: true,
      chip: 'gpiochip0',
      doors: readers.map(r => ({
        door: r.id,
        id: r.id,
        name: r.name,
        d0: r.d0Pin,
        d1: r.d1Pin,
        format: r.bitWidth,
        enabled: r.enabled,
        status: r.enabled ? 'online' : 'disabled',
        sharedWith: r.sharedWith || null
      })),
      reserved: status.reservedPins,
      binaryExists: status.binaryExists,
      ready: status.ready,
      totalReaders: status.readersCount
    });
  } catch (error) {
    console.error('[Wiegand API] Config error:', error.message);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

/**
 * POST /api/wiegand/send
 * Send Wiegand card credential
 * 
 * Body: {
 *   door: string|number,        // Reader ID (required)
 *   readerId: string|number,    // Alternative to door
 *   facility: number,           // Facility code (required)
 *   card: number,              // Card number (required)
 *   format: number             // Wiegand format (optional, default from reader config)
 * }
 */
async function sendWiegandCard(req, res) {
  if (!wiegandManager) {
    return res.status(503).json({
      success: false,
      error: 'Wiegand system not initialized'
    });
  }

  try {
    // Extract parameters - support both 'door' and 'readerId'
    const { door, readerId, facility, card, format } = req.body;
    
    const targetReaderId = readerId || door;
    
    // Validate required parameters
    if (!targetReaderId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: door or readerId',
        example: {
          door: '1',
          facility: 123,
          card: 45678
        }
      });
    }

    if (facility === undefined || facility === null) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: facility'
      });
    }

    if (card === undefined || card === null) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: card'
      });
    }

    // Check if reader exists
    const reader = wiegandManager.getReader(targetReaderId.toString());
    if (!reader) {
      const availableReaders = wiegandManager.getReaders().map(r => r.id);
      return res.status(404).json({
        success: false,
        error: `Reader "${targetReaderId}" not found`,
        availableReaders
      });
    }

    // Check if reader can be used
    const canUse = wiegandManager.canUseReader(targetReaderId.toString());
    if (!canUse.canUse) {
      return res.status(400).json({
        success: false,
        error: canUse.reason
      });
    }

    // Log the transmission attempt
    console.log('[Wiegand API] Sending card credential:');
    console.log(`[Wiegand API]   Reader: ${targetReaderId} (${reader.name})`);
    console.log(`[Wiegand API]   Facility: ${facility}`);
    console.log(`[Wiegand API]   Card: ${card}`);
    console.log(`[Wiegand API]   Format: ${format || reader.bitWidth || 26}-bit`);

    // Send the card
    const result = await wiegandManager.sendCard(
      targetReaderId.toString(),
      parseInt(facility, 10),
      parseInt(card, 10),
      format ? parseInt(format, 10) : null
    );

    // Add warning if present
    if (canUse.warning) {
      result.warning = canUse.warning;
    }

    // Return success
    res.json({
      success: true,
      message: 'Credential transmitted successfully',
      ...result
    });

  } catch (error) {
    console.error('[Wiegand API] ✗ Send error:', error.message);
    
    // Provide helpful error response
    const errorResponse = {
      success: false,
      error: error.message
    };

    // Add helpful hints based on error type
    if (error.message.includes('not found or not executable')) {
      errorResponse.hint = 'Compile the binary: cd wiegand && make';
    } else if (error.message.includes('Permission denied')) {
      errorResponse.hint = 'Try running server with sudo or add user to gpio group';
    } else if (error.message.includes('busy')) {
      errorResponse.hint = 'Kill existing processes: sudo pkill -9 wiegand_tx';
    } else if (error.message.includes('exceeds maximum')) {
      errorResponse.hint = 'Check facility/card ranges for the selected format';
    }

    res.status(500).json(errorResponse);
  }
}

/**
 * POST /api/wiegand/test/:readerId
 * Test a specific reader with a test credential
 */
async function testWiegandReader(req, res) {
  if (!wiegandManager) {
    return res.status(503).json({
      success: false,
      error: 'Wiegand system not initialized'
    });
  }

  try {
    const readerId = req.params.readerId;
    
    if (!readerId) {
      return res.status(400).json({
        success: false,
        error: 'Missing readerId parameter'
      });
    }

    console.log(`[Wiegand API] Testing reader ${readerId}...`);

    const result = await wiegandManager.testReader(readerId.toString());

    res.json({
      success: true,
      message: `Test successful for reader ${readerId}`,
      ...result
    });

  } catch (error) {
    console.error('[Wiegand API] ✗ Test error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/wiegand/status
 * Get Wiegand system status
 */
function getWiegandStatus(req, res) {
  if (!wiegandManager) {
    return res.json({
      initialized: false,
      ready: false,
      error: 'Wiegand manager not initialized'
    });
  }

  try {
    const status = wiegandManager.getStatus();
    res.json(status);
  } catch (error) {
    console.error('[Wiegand API] Status error:', error.message);
    res.status(500).json({
      initialized: true,
      ready: false,
      error: error.message
    });
  }
}

/**
 * GET /api/wiegand/readers
 * Get list of all readers with details
 */
function getWiegandReaders(req, res) {
  if (!wiegandManager) {
    return res.status(503).json({
      success: false,
      error: 'Wiegand system not initialized'
    });
  }

  try {
    const readers = wiegandManager.getReaders();
    
    res.json({
      success: true,
      readers: readers.map(r => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        gpio: {
          d0: r.d0Pin,
          d1: r.d1Pin
        },
        format: r.bitWidth,
        pulseWidth: r.pulseWidth,
        sharedWith: r.sharedWith || null,
        status: r.enabled ? 'ready' : 'disabled'
      }))
    });
  } catch (error) {
    console.error('[Wiegand API] Readers error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/wiegand/send-raw
 * Send raw bit string (not yet implemented in binary)
 */
async function sendWiegandRaw(req, res) {
  if (!wiegandManager) {
    return res.status(503).json({
      success: false,
      error: 'Wiegand system not initialized'
    });
  }

  try {
    const { door, readerId, bits } = req.body;
    const targetReaderId = readerId || door;

    if (!targetReaderId || !bits) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: door/readerId and bits'
      });
    }

    const result = await wiegandManager.sendRaw(targetReaderId.toString(), bits);

    res.json({
      success: true,
      message: 'Raw bits transmitted successfully',
      ...result
    });

  } catch (error) {
    // Most likely "not yet implemented" error
    console.error('[Wiegand API] Raw send error:', error.message);
    res.status(501).json({
      success: false,
      error: error.message,
      hint: 'Use /api/wiegand/send with facility and card instead'
    });
  }
}

/**
 * Setup function - register all Wiegand routes
 * Usage in server.js:
 *   const wiegandConfig = require('./config');
 *   await wiegandConfig.setup(app);
 */
async function setup(app) {
  console.log('[Wiegand API] Setting up routes...');
  
  // Initialize Wiegand manager
  await initializeWiegand();

  // Register routes
  app.get('/api/wiegand/config', getWiegandConfig);
  app.get('/api/wiegand/status', getWiegandStatus);
  app.get('/api/wiegand/readers', getWiegandReaders);
  app.post('/api/wiegand/send', sendWiegandCard);
  app.post('/api/wiegand/send-raw', sendWiegandRaw);
  app.post('/api/wiegand/test/:readerId', testWiegandReader);

  console.log('[Wiegand API] ✓ Routes registered');
  
  return wiegandManager;
}

/**
 * Get the Wiegand manager instance
 * Use this to pass to AutomationManager or other components
 */
function getWiegandManager() {
  return wiegandManager;
}

module.exports = {
  setup,
  initializeWiegand,
  getWiegandManager,
  getWiegandConfig,
  getWiegandStatus,
  getWiegandReaders,
  sendWiegandCard,
  sendWiegandRaw,
  testWiegandReader
};
