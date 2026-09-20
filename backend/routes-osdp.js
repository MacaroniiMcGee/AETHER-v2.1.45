// routes-osdp.js - Enhanced Express routes for OSDP emulator
// UNIFIED VERSION - Uses formatService for all format lookups
// Includes interface detection and assignment

const path = require('path');

// Import formatService for unified format resolution
let formatService;
try {
  formatService = require('./lib/formatService');
  console.log('[OSDP Routes] formatService loaded for unified format resolution');
} catch (e) {
  console.warn('[OSDP Routes] formatService not available at ./lib/formatService, trying alternate path');
  try {
    formatService = require(path.join(__dirname, 'lib', 'formatService'));
  } catch (e2) {
    console.warn('[OSDP Routes] formatService not available, format endpoints will use fallback');
    formatService = null;
  }
}


module.exports = function attachOsdpRoutes(app, osdp) {
  
  // ========== INTERFACE DETECTION ==========
  
  // Detect available interfaces (USB, Sequent RS485, Waveshare SPI)
  app.get('/api/osdp/detect', async (req, res) => {
    try {
      const interfaces = await osdp.detectInterfaces();
      return res.json({ 
        success: true, 
        interfaces,
        count: interfaces.length,
        timestamp: Date.now()
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get cached detected interfaces
  app.get('/api/osdp/interfaces', (req, res) => {
    try {
      const interfaces = osdp.getDetectedInterfaces();
      return res.json({ success: true, interfaces });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== INTERFACE ASSIGNMENT ==========

  // Assign interface to reader
  app.post('/api/osdp/reader/:id/interface', async (req, res) => {
    try {
      const { interfaceId, port, baudRate } = req.body;
      
      if (!port) {
        return res.status(400).json({ success: false, error: 'port is required' });
      }
      
      const reader = await osdp.assignInterface(req.params.id, {
        interfaceId,
        port,
        baudRate: baudRate || 9600
      });
      
      return res.json({ success: true, reader, message: `Assigned ${port} to reader` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get reader's current interface
  app.get('/api/osdp/reader/:id/interface', (req, res) => {
    try {
      const reader = osdp.getReader(req.params.id);
      if (!reader) {
        return res.status(404).json({ success: false, error: 'Reader not found' });
      }
      
      return res.json({ 
        success: true, 
        interface: {
          port: reader.serialPort,
          baudRate: reader.baudRate || 9600,
          interfaceId: reader.interfaceId
        }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== READER MANAGEMENT ==========
  
  // List all readers
  app.get('/api/osdp/readers', (req, res) => {
    try {
      const readers = osdp.getReaders();
      return res.json({ success: true, readers });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get single reader
  app.get('/api/osdp/reader/:id', (req, res) => {
    try {
      const reader = osdp.getReader(req.params.id);
      if (!reader) return res.status(404).json({ success: false, error: 'Reader not found' });
      return res.json({ success: true, reader });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get system status
  app.get('/api/osdp/status', (req, res) => {
    try {
      const status = osdp.getStatus();
      return res.json({ success: true, status });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get statistics
  app.get('/api/osdp/stats', (req, res) => {
    try {
      const stats = osdp.getStats();
      return res.json({ success: true, stats });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get security info
  app.get('/api/osdp/security', (req, res) => {
    try {
      const security = osdp.getSecurityInfo();
      return res.json({ success: true, security });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Set custom SCBK
  app.post('/api/osdp/security/keyset', async (req, res) => {
    try {
      const { address, key } = req.body;
      if (address === undefined || !key) {
        return res.status(400).json({ success: false, error: 'address and key required' });
      }
      const result = await osdp.setCustomSCBK(address, key);
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Reset to default SCBK-D
  app.post('/api/osdp/security/reset', async (req, res) => {
    try {
      const { address } = req.body;
      if (address === undefined) {
        return res.status(400).json({ success: false, error: 'address required' });
      }
      const result = await osdp.resetToDefaultKey(address);
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== FORMATS - UNIFIED WITH formatService ==========

  // Get available formats - UNIFIED with formatService
  app.get('/api/osdp/formats', (req, res) => {
    try {
      let serviceFormats = [];
      
      // Get formats from unified formatService (credential-formats-master.json)
      if (formatService && typeof formatService.getAllFormats === 'function') {
        serviceFormats = formatService.getAllFormats().map(f => ({
          id: f.id,
          name: f.name,
          bits: f.bits,
          bitCount: f.bits,  // alias for compatibility
          facilityBits: f.facilityBits || 0,
          cardBits: f.cardBits || 0,
          parity: f.parity || 'std',
          description: f.description || '',
          hasFacility: (f.facilityBits || 0) > 0,
          maxFacility: f.facilityBits > 0 ? (f.facilityBits > 31 ? Math.pow(2, f.facilityBits) - 1 : (1 << f.facilityBits) - 1) : 0,
          maxCard: f.cardBits > 31 ? Math.pow(2, Math.min(f.cardBits, 53)) - 1 : (1 << f.cardBits) - 1,
          isCustom: false
        }));
        console.log(`[OSDP Routes] Loaded ${serviceFormats.length} formats from formatService`);
      } else {
        // Fallback formats if formatService not available
        serviceFormats = [
          { id: 'w26', name: 'Wiegand 26-bit (H10301)', bits: 26, bitCount: 26, facilityBits: 8, cardBits: 16, hasFacility: true, maxFacility: 255, maxCard: 65535, isCustom: false },
          { id: 'w34', name: 'Wiegand 34-bit', bits: 34, bitCount: 34, facilityBits: 16, cardBits: 16, hasFacility: true, maxFacility: 65535, maxCard: 65535, isCustom: false },
          { id: 'w37', name: 'Wiegand 37-bit (H10302)', bits: 37, bitCount: 37, facilityBits: 16, cardBits: 19, hasFacility: true, maxFacility: 65535, maxCard: 524287, isCustom: false }
        ];
        console.log('[OSDP Routes] Using fallback formats (formatService not available)');
      }

      // Add any custom formats from OSDP manager
      let customFormats = [];
      if (osdp && typeof osdp.getCustomFormats === 'function') {
        customFormats = (osdp.getCustomFormats() || []).map(f => ({
          id: f.id,
          name: f.name,
          bits: f.bitCount || f.bits,
          bitCount: f.bitCount || f.bits,
          facilityBits: f.facilityBits || 0,
          cardBits: f.cardBits || 0,
          parity: f.parityType || f.parity || 'none',
          description: f.description || '',
          hasFacility: (f.facilityBits || 0) > 0,
          maxFacility: f.facilityBits > 0 ? (1 << Math.min(f.facilityBits, 31)) - 1 : 0,
          maxCard: f.cardBits > 31 ? Math.pow(2, Math.min(f.cardBits, 53)) - 1 : (1 << f.cardBits) - 1,
          isCustom: true
        }));
      }

      const allFormats = [...serviceFormats, ...customFormats];

      return res.json({ 
        success: true, 
        formats: allFormats,
        count: allFormats.length,
        standardCount: serviceFormats.length,
        customCount: customFormats.length
      });
    } catch (e) {
      console.error('[OSDP Routes] Error fetching formats:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get single format details
  app.get('/api/osdp/format/:id', (req, res) => {
    try {
      const formatId = req.params.id;
      
      // Check formatService first
      if (formatService && typeof formatService.getFormatById === 'function') {
        const fmt = formatService.getFormatById(formatId);
        if (fmt) {
          return res.json({
            success: true,
            format: {
              id: fmt.id,
              name: fmt.name,
              bits: fmt.bits,
              bitCount: fmt.bits,
              facilityBits: fmt.facilityBits || 0,
              cardBits: fmt.cardBits || 0,
              parity: fmt.parity || 'std',
              description: fmt.description || '',
              hasFacility: (fmt.facilityBits || 0) > 0,
              isCustom: false
            }
          });
        }
      }

      // Check custom formats
      if (osdp && typeof osdp.getCustomFormats === 'function') {
        const customFormat = (osdp.getCustomFormats() || []).find(f => f.id === formatId);
        if (customFormat) {
          return res.json({
            success: true,
            format: {
              ...customFormat,
              isCustom: true
            }
          });
        }
      }

      return res.status(404).json({ success: false, error: 'Format not found' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get format variants by bit count
  app.get('/api/osdp/formats/variants/:bits', (req, res) => {
    try {
      const bits = parseInt(req.params.bits);
      if (isNaN(bits)) {
        return res.status(400).json({ success: false, error: 'Invalid bit count' });
      }
      
      let variants = [];
      if (formatService && typeof formatService.getFormatVariants === 'function') {
        variants = formatService.getFormatVariants(bits);
      }
      
      return res.json({
        success: true,
        bits,
        variants: variants.map(f => ({
          id: f.id,
          name: f.name,
          facilityBits: f.facilityBits || 0,
          cardBits: f.cardBits || 0,
          hasFacility: (f.facilityBits || 0) > 0
        })),
        count: variants.length
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get no-facility formats
  app.get('/api/osdp/formats/no-facility', (req, res) => {
    try {
      let formats = [];
      if (formatService && typeof formatService.getNoFacilityFormats === 'function') {
        formats = formatService.getNoFacilityFormats();
      }
      
      return res.json({
        success: true,
        formats: formats.map(f => ({
          id: f.id,
          name: f.name,
          bits: f.bits,
          cardBits: f.cardBits || f.bits
        })),
        count: formats.length
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== CUSTOM FORMAT MANAGEMENT ==========

  // Get custom formats only
  app.get('/api/osdp/formats/custom', (req, res) => {
    try {
      const customFormats = osdp.getCustomFormats ? osdp.getCustomFormats() : [];
      return res.json({ success: true, formats: customFormats, count: customFormats.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Create custom format
  app.post('/api/osdp/formats/custom', async (req, res) => {
    try {
      const { name, bitCount, facilityBits, cardBits, parityType, description } = req.body;

      if (!name || !bitCount) {
        return res.status(400).json({ success: false, error: 'Name and bitCount are required' });
      }

      if (bitCount < 8 || bitCount > 256) {
        return res.status(400).json({ success: false, error: 'bitCount must be between 8 and 256' });
      }

      const format = await osdp.addCustomFormat({
        name,
        bitCount: parseInt(bitCount),
        facilityBits: parseInt(facilityBits || 0),
        cardBits: parseInt(cardBits || 0),
        parityType: parityType || 'none',
        description: description || ''
      });

      return res.json({ success: true, format, message: 'Custom format created successfully' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Update custom format
  app.put('/api/osdp/formats/custom/:id', async (req, res) => {
    try {
      const formatId = req.params.id;
      const updates = req.body;

      await osdp.deleteCustomFormat(formatId);
      const format = await osdp.addCustomFormat({
        id: formatId,
        ...updates
      });

      return res.json({ success: true, format, message: 'Custom format updated successfully' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Delete custom format
  app.delete('/api/osdp/formats/custom/:id', async (req, res) => {
    try {
      const result = await osdp.deleteCustomFormat(req.params.id);
      return res.json({ success: true, ...result, message: 'Custom format deleted successfully' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== CARD READ OPERATIONS ==========

  // Send card read (supports all formats via formatService)
  app.post('/api/osdp/card-read', async (req, res) => {
    try {
      const body = req.body || {};
      const {
        readerId,
        format = 'w26',
        formatId,
        facility,
        card,
        bitCount,
        cardNumber
      } = body;

      if (!readerId) {
        return res.status(400).json({ success: false, error: 'readerId required' });
      }

      // Resolve format using formatService
      const resolvedFormatId = formatId || format;
      let fmt = null;
      
      if (formatService && typeof formatService.getFormatById === 'function') {
        fmt = formatService.getFormatById(resolvedFormatId);
      }
      
      // If not found by ID, try by bit count
      if (!fmt && bitCount && formatService && typeof formatService.getFormatByBits === 'function') {
        fmt = formatService.getFormatByBits(parseInt(bitCount));
      }
      
      // Check custom formats if not found
      if (!fmt && osdp && typeof osdp.getCustomFormats === 'function') {
        const customFormat = (osdp.getCustomFormats() || []).find(f => 
          f.id === resolvedFormatId || 
          (f.name && f.name.toLowerCase() === resolvedFormatId.toLowerCase())
        );
        if (customFormat) {
          fmt = {
            id: customFormat.id,
            name: customFormat.name,
            bits: customFormat.bitCount,
            facilityBits: customFormat.facilityBits || 0,
            cardBits: customFormat.cardBits || 0
          };
        }
      }

      // Fallback for common formats
      if (!fmt) {
        const fallbackFormats = {
          'w26': { id: 'w26', bits: 26, facilityBits: 8, cardBits: 16 },
          'wiegand26': { id: 'w26', bits: 26, facilityBits: 8, cardBits: 16 },
          'w34': { id: 'w34', bits: 34, facilityBits: 16, cardBits: 16 },
          'wiegand34': { id: 'w34', bits: 34, facilityBits: 16, cardBits: 16 },
          'w37': { id: 'w37', bits: 37, facilityBits: 16, cardBits: 19 },
          'wiegand37': { id: 'w37', bits: 37, facilityBits: 16, cardBits: 19 }
        };
        fmt = fallbackFormats[resolvedFormatId.toLowerCase()];
      }

      if (!fmt) {
        return res.status(400).json({ 
          success: false, 
          error: `Unknown format: ${resolvedFormatId}`,
          hint: 'Use format IDs like w26, w34, w37 or check /api/osdp/formats for available formats'
        });
      }

      const fc = Number(facility ?? 0);
      const id = Number(card ?? 0);
      const bits = fmt.bits;

      // Build combined card number based on format layout
      let numberBig;
      const facilityBits = fmt.facilityBits || 0;
      const cardBits = fmt.cardBits || bits;

      if (facilityBits === 0) {
        numberBig = BigInt(id);
      } else {
        const facilityMask = (BigInt(1) << BigInt(facilityBits)) - BigInt(1);
        const cardMask = (BigInt(1) << BigInt(cardBits)) - BigInt(1);
        numberBig = ((BigInt(fc) & facilityMask) << BigInt(cardBits)) | (BigInt(id) & cardMask);
      }

      console.log(`[OSDP] Card read: Format=${fmt.id}, FC=${fc}, Card=${id}, Bits=${bits}`);
      console.log(`[OSDP] Layout: FC:${facilityBits} bits, Card:${cardBits} bits`);

      await osdp.sendCardRead(readerId, {
        facilityCode: fc,
        cardNumber: numberBig.toString(),
        bitCount: bits
      }, fmt.id);

      return res.json({ 
        success: true, 
        queued: true, 
        bitCount: bits,
        format: fmt.id,
        formatName: fmt.name || fmt.id,
        facility: fc,
        card: id,
        hasFacility: facilityBits > 0
      });
    } catch (e) {
      console.error('[API] card-read error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== READER CONTROL ==========

  // LED control
  app.post('/api/osdp/led', async (req, res) => {
    try {
      const { readerId, color, state, duration } = req.body;
      if (!readerId) return res.status(400).json({ success: false, error: 'readerId required' });
      
      const result = await osdp.setLED(readerId, color, state, parseInt(duration || 0));
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Buzzer control
  app.post('/api/osdp/buzzer', async (req, res) => {
    try {
      const { readerId, duration } = req.body;
      if (!readerId) return res.status(400).json({ success: false, error: 'readerId required' });
      
      const result = await osdp.buzz(readerId, parseInt(duration || 200));
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Test reader
  app.post('/api/osdp/test/:readerId', async (req, res) => {
    try {
      const result = await osdp.testReader(req.params.readerId);
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Update reader configuration
  app.patch('/api/osdp/reader/:id', async (req, res) => {
    try {
      const reader = await osdp.updateReader(req.params.id, req.body);
      return res.json({ success: true, reader });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== KEYPAD OPERATIONS ==========

  // Send keypad data
  app.post('/api/osdp/keypad', async (req, res) => {
    console.log('[OSDP Route] POST /api/osdp/keypad called');
    
    try {
      const { readerId, data, format, facilityCode } = req.body;
      if (!readerId) return res.status(400).json({ success: false, error: 'readerId required' });
      if (!data) return res.status(400).json({ success: false, error: 'keypad data required' });
      
      const wiegandFormat = format || '8bit';
      const fc = facilityCode ? parseInt(facilityCode, 10) : 0;
      
      const result = await osdp.sendKeypadData(readerId, data, wiegandFormat, fc);
      
      return res.json({ success: true, ...result });
    } catch (e) {
      console.error('[OSDP Route] ERROR:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== READER ADD/DELETE ==========

  // Add new reader
  app.post('/api/osdp/reader', async (req, res) => {
    try {
      const reader = await osdp.addReader(req.body);
      return res.json({ success: true, reader });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Delete reader
  app.delete('/api/osdp/reader/:id', async (req, res) => {
    try {
      const result = await osdp.deleteReader(req.params.id);
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== BAUD RATE ==========

  // Change baud rate for a specific port
  app.post('/api/osdp/baudrate', async (req, res) => {
    try {
      const { port, baudRate } = req.body;
      if (!baudRate) {
        return res.status(400).json({ success: false, error: 'baudRate required' });
      }
      
      const validRates = [9600, 19200, 38400, 57600, 115200, 230400];
      if (!validRates.includes(baudRate)) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid baud rate. Valid options: ${validRates.join(', ')}`
        });
      }

      // changeBaudRate() already closes, reopens, updates readers and saves.
      // The old inline version called osdp.openSerialPort() and read
      // osdp.detectedInterfaces, neither of which existed — every call 500'd.
      const result = await osdp.changeBaudRate(port, baudRate);
      if (Array.isArray(osdp.detectedInterfaces)) {
        const iface = osdp.detectedInterfaces.find(i => i.port === port);
        if (iface) iface.baudRate = baudRate;
      }
      return res.json({
        success: true,
        ...result,
        message: `Port ${port || 'default'} now running at ${baudRate} baud`
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== PORT STATISTICS ==========

  // Get port statistics
  app.get('/api/osdp/ports/stats', (req, res) => {
    try {
      const stats = {};
      for (const [port, portStats] of osdp.portStats) {
        stats[port] = portStats;
      }
      return res.json({ success: true, stats });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ========== PACKET CAPTURE (DEBUGGING) ==========

  // Enable packet capture mode
  app.post('/api/osdp/capture/enable', (req, res) => {
    try {
      const result = osdp.enableCaptureMode();
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Disable packet capture mode
  app.post('/api/osdp/capture/disable', (req, res) => {
    try {
      const result = osdp.disableCaptureMode();
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Get captured packets
  app.get('/api/osdp/capture/packets', (req, res) => {
    try {
      const result = osdp.getCapturedPackets();
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Clear captured packets
  app.post('/api/osdp/capture/clear', (req, res) => {
    try {
      const result = osdp.clearCapturedPackets();
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[OSDP Routes] UNIFIED OSDP API routes loaded (dual-bus + formatService)');
};
