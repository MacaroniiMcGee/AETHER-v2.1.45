// ✅ FIXED: Wiegand transmit - supports BOTH card credentials AND raw bits
app.post('/api/wiegand/transmit', (req, res) => {
  const { d0Pin, d1Pin, facility, card, bits, pulseWidth, rawBits, parity } = req.body;
  
  const d0 = parseInt(d0Pin) || 5;
  const d1 = parseInt(d1Pin) || 6;
  const pulse = parseInt(pulseWidth) || 50;
  const startTime = Date.now();
  
  // Use native binary
  const binPath = RESOLVED_WIEGAND_TX_PATH;
  if (!fs.existsSync(binPath)) {
    console.error(`[WIEGAND-NATIVE] Binary not found at ${binPath}`);
    return res.status(500).json({ success: false, error: `Wiegand transmitter not found at ${binPath}`, duration: 0 });
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // MODE 1: RAW BITS (for keypad burst mode - 4-bit/8-bit)
  // ═══════════════════════════════════════════════════════════════════════
  if (typeof rawBits === 'string' && rawBits.trim()) {
    const bitString = rawBits.trim();
    
    // Validate bit string
    if (!/^[01]+$/.test(bitString)) {
      return res.status(400).json({ 
        success: false, 
        error: 'rawBits must contain only 0s and 1s', 
        duration: 0 
      });
    }
    
    console.log(`[WIEGAND-RAW] Transmit raw bits: D0=${d0}, D1=${d1}, Bits="${bitString}" (${bitString.length} bits)`);
    
    // For raw bits, we use WiegandManager.sendRaw() if available,
    // OR we need to implement direct GPIO pulsing
    if (wiegandManager && typeof wiegandManager.sendRaw === 'function') {
      // Find a reader that matches these pins
      const readers = wiegandManager.getReaders();
      const matchingReader = readers.find(r => 
        (r.pins && r.pins.d0 === d0 && r.pins.d1 === d1)
      );
      
      if (matchingReader) {
        wiegandManager.sendRaw(matchingReader.id, bitString)
          .then(result => {
            const duration = Date.now() - startTime;
            console.log(`[WIEGAND-RAW] ✓ Raw transmission successful (${duration}ms)`);
            io.emit('wiegand_raw_sent', { d0Pin: d0, d1Pin: d1, bits: bitString, timestamp: Date.now(), duration });
            res.json({ 
              success: true, 
              message: 'Raw bits transmitted',
              result: { duration, bits: bitString.length, d0Pin: d0, d1Pin: d1 }
            });
          })
          .catch(err => {
            const duration = Date.now() - startTime;
            console.error(`[WIEGAND-RAW] Failed:`, err.message);
            res.status(500).json({ success: false, error: err.message, duration });
          });
        return;
      }
    }
    
    // Fallback: Use native binary with a "raw" pseudo-format
    // This requires the native binary to support raw mode, OR we implement GPIO directly
    
    // If native binary doesn't support raw mode, use gpioset directly for each bit
    console.log(`[WIEGAND-RAW] Using direct GPIO pulsing for ${bitString.length} bits`);
    
    // Async GPIO pulsing
    (async () => {
      try {
        for (let i = 0; i < bitString.length; i++) {
          const bit = bitString[i];
          const pin = (bit === '0') ? d0 : d1;
          
          // Pulse the appropriate pin
          await execAsync(`gpioset -c 0 -z ${pin}=1`);
          await new Promise(r => setTimeout(r, pulse / 1000)); // Convert μs to ms (min 1ms)
          await execAsync(`gpioset -c 0 -z ${pin}=0`);
          
          // Inter-pulse delay (2ms standard Wiegand timing)
          if (i < bitString.length - 1) {
            await new Promise(r => setTimeout(r, 2));
          }
        }
        
        const duration = Date.now() - startTime;
        console.log(`[WIEGAND-RAW] ✓ Raw transmission complete (${duration}ms)`);
        io.emit('wiegand_raw_sent', { d0Pin: d0, d1Pin: d1, bits: bitString, timestamp: Date.now(), duration });
        res.json({ 
          success: true, 
          message: 'Raw bits transmitted via GPIO',
          result: { duration, bits: bitString.length, d0Pin: d0, d1Pin: d1 }
        });
      } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`[WIEGAND-RAW] GPIO error:`, err.message);
        res.status(500).json({ success: false, error: err.message, duration });
      }
    })();
    
    return;
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // MODE 2: CARD CREDENTIAL (facility/card/bits) - standard card emulation
  // ═══════════════════════════════════════════════════════════════════════
  const fc = parseInt(facility) || 0;
  const cardNum = parseInt(card) || 0;
  const bitsNum = parseInt(bits) || 26;
  
  console.log(`[WIEGAND-NATIVE] Transmit card: D0=${d0}, D1=${d1}, FC=${fc}, Card=${cardNum}, Bits=${bitsNum}`);
  
  // Validate 26-bit format
  if (bitsNum === 26) {
    if (fc < 0 || fc > 255) {
      return res.status(400).json({ success: false, error: '26-bit format: facility must be 0-255', duration: 0 });
    }
    if (cardNum < 0 || cardNum > 65535) {
      return res.status(400).json({ success: false, error: '26-bit format: card must be 0-65535', duration: 0 });
    }
  }
  
  const args = [String(d0), String(d1), String(fc), String(cardNum), String(bitsNum), String(pulse)];
  console.log(`[WIEGAND-NATIVE] Command: ${binPath} ${args.join(' ')}`);
  
  const p = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  
  p.stdout.on('data', d => { 
    const line = d.toString().trim();
    stdout += line + '\n'; 
    if (line) console.log(`[WIEGAND-NATIVE] ${line}`);
  });
  p.stderr.on('data', d => { stderr += d.toString(); });
  
  p.on('error', (err) => {
    const duration = Date.now() - startTime;
    const historyEntry = { timestamp: new Date().toISOString(), facility: fc, card: cardNum, bits: bitsNum, d0Pin: d0, d1Pin: d1, pulseWidth: pulse, duration, success: false, output: stdout, error: err.message };
    wiegandHistory.unshift(historyEntry);
    if (wiegandHistory.length > MAX_HISTORY) wiegandHistory.pop();
    console.error('[WIEGAND-NATIVE] Spawn error:', err.message);
    return res.status(500).json({ success: false, error: err.message, duration });
  });
  
  p.on('exit', (code) => {
    const duration = Date.now() - startTime;
    const success = code === 0;
    const historyEntry = { timestamp: new Date().toISOString(), facility: fc, card: cardNum, bits: bitsNum, d0Pin: d0, d1Pin: d1, pulseWidth: pulse, duration, success, output: stdout, error: success ? null : (stderr || `exit ${code}`) };
    wiegandHistory.unshift(historyEntry);
    if (wiegandHistory.length > MAX_HISTORY) wiegandHistory.pop();
    
    if (!success) {
      console.error(`[WIEGAND-NATIVE] Transmission failed (exit ${code}): ${stderr}`);
      return res.status(500).json({ success: false, error: stderr || `exit code ${code}`, duration });
    }
    
    console.log(`[WIEGAND-NATIVE] ✓ Transmission successful (${duration}ms)`);
    io.emit('wiegand_card_read', { d0Pin: d0, d1Pin: d1, facility: fc, card: cardNum, bits: bitsNum, timestamp: Date.now(), duration });
    res.json({ 
      success: true, 
      message: 'Wiegand transmission completed',
      result: {
        duration,
        facility: fc,
        card: cardNum,
        bits: bitsNum,
        d0Pin: d0,
        d1Pin: d1,
        output: stdout.trim()
      }
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL: Dedicated endpoint for raw bits (cleaner API)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/wiegand/raw', async (req, res) => {
  const { d0Pin, d1Pin, rawBits, pulseWidth } = req.body;
  
  if (!rawBits || typeof rawBits !== 'string') {
    return res.status(400).json({ success: false, error: 'rawBits is required' });
  }
  
  const bitString = rawBits.trim();
  if (!/^[01]+$/.test(bitString)) {
    return res.status(400).json({ success: false, error: 'rawBits must contain only 0s and 1s' });
  }
  
  const d0 = parseInt(d0Pin) || 5;
  const d1 = parseInt(d1Pin) || 6;
  const pulse = parseInt(pulseWidth) || 50;
  const startTime = Date.now();
  
  console.log(`[WIEGAND-RAW] /api/wiegand/raw: D0=${d0}, D1=${d1}, Bits="${bitString}" (${bitString.length} bits)`);
  
  try {
    // Try WiegandManager first
    if (wiegandManager && typeof wiegandManager.sendRaw === 'function') {
      const readers = wiegandManager.getReaders();
      const matchingReader = readers.find(r => 
        r.pins && r.pins.d0 === d0 && r.pins.d1 === d1
      );
      
      if (matchingReader) {
        const result = await wiegandManager.sendRaw(matchingReader.id, bitString);
        const duration = Date.now() - startTime;
        io.emit('wiegand_raw_sent', { d0Pin: d0, d1Pin: d1, bits: bitString, timestamp: Date.now(), duration });
        return res.json({ success: true, result: { ...result, duration } });
      }
    }
    
    // Fallback: Direct GPIO pulsing
    for (let i = 0; i < bitString.length; i++) {
      const bit = bitString[i];
      const pin = (bit === '0') ? d0 : d1;
      
      await execAsync(`gpioset -c 0 -z ${pin}=1`);
      await new Promise(r => setTimeout(r, Math.max(1, pulse / 1000)));
      await execAsync(`gpioset -c 0 -z ${pin}=0`);
      
      if (i < bitString.length - 1) {
        await new Promise(r => setTimeout(r, 2));
      }
    }
    
    const duration = Date.now() - startTime;
    io.emit('wiegand_raw_sent', { d0Pin: d0, d1Pin: d1, bits: bitString, timestamp: Date.now(), duration });
    res.json({ success: true, result: { duration, bits: bitString.length } });
    
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error('[WIEGAND-RAW] Error:', err.message);
    res.status(500).json({ success: false, error: err.message, duration });
  }
});
