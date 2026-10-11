/**
 * KeypadEmulator.tsx - FULLY FIXED VERSION
 * 
 * CHANGES FROM ORIGINAL:
 * 1. Burst mode (4-bit/8-bit) now uses correct endpoint and parameters
 * 2. Uses /api/wiegand/raw for raw bit transmission (cleaner)
 * 3. Falls back to /api/wiegand/transmit with rawBits if /raw endpoint not available
 * 4. Fixed door/reader resolution
 */

import React, { useState } from 'react';
import emulatorFormats from '../Readers/Emulator_Formats.json';

interface UnifiedReader {
  id?: string;
  name: string;
  enabled: boolean;
  
  // Wiegand
  d0Pin?: number;
  d1Pin?: number;
  pulseWidth?: number;
  door?: number;
  
  // OSDP
  address?: number;
  capabilities?: string[];
  
  type?: 'wiegand' | 'osdp';
}

interface KeypadFormat {
  id: string;
  name: string;
  category: string;
  bitsPerKey?: number;
  bits?: number;
  encoding: string;
  hasParity: boolean;
  terminator?: string;
  terminatorCode?: string;
  hexMap?: Record<string, string>;
  keyMap?: Record<string, string>;
  transmission: 'burst' | 'single';
  description: string;
  facilityCodeRequired?: boolean;
  maxPin?: number;
}

interface KeypadEmulatorProps {
  apiUrl?: string;
  readers: UnifiedReader[];
  onLog?: (message: string) => void;
}

interface KeypadTransmission {
  timestamp: string;
  format: string;
  pin: string;
  facilityCode?: number;
  success: boolean;
  readerName: string;
  readerType: 'wiegand' | 'osdp';
}

export const KeypadEmulator: React.FC<KeypadEmulatorProps> = ({
  apiUrl = 'http://localhost:3001',
  readers,
  onLog
}) => {
  const formats = emulatorFormats.keypadFormats as KeypadFormat[];
  const [selectedFormatId, setSelectedFormatId] = useState<string>('4bit');
  const [input, setInput] = useState<string>('');
  const [facilityCode, setFacilityCode] = useState<number>(0);
  const [selectedReaderIndex, setSelectedReaderIndex] = useState<number>(0);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<KeypadTransmission[]>([]);

  const selectedFormat = formats.find(f => f.id === selectedFormatId) || formats[0];

  const detectReaderType = (reader: UnifiedReader): 'wiegand' | 'osdp' => {
    if (reader.type) return reader.type;
    if (reader.d0Pin !== undefined && reader.d1Pin !== undefined) return 'wiegand';
    if (reader.id !== undefined || reader.address !== undefined) return 'osdp';
    return 'osdp';
  };

  const selectedReader = selectedReaderIndex >= 0 && selectedReaderIndex < readers.length 
    ? readers[selectedReaderIndex] 
    : null;
  const readerType = selectedReader ? detectReaderType(selectedReader) : null;
  const readerAvailable = selectedReader?.enabled || false;

  /**
   * Get key value from format definition
   * Uses hexMap from Emulator_Formats.json
   */
  const getKeyValue = (key: string, format: KeypadFormat): number => {
    // Check hexMap first (from JSON)
    if (format.hexMap && format.hexMap[key]) {
      return parseInt(format.hexMap[key], 16);
    }
    
    // Fallback encodings based on format type
    if (format.encoding === 'nibble' || format.id === '4bit') {
      if (key >= '0' && key <= '9') return parseInt(key, 10);
      if (key === '*') return 0x0A;
      if (key === '#') return 0x0B;
    } else if (format.encoding === 'ascii' || format.id === '8bit') {
      if (key === '#') return 0x0D;  // Enter/CR
      if (key === '*') return 0x1B;  // Escape
      return key.charCodeAt(0);      // ASCII code
    } else if (format.encoding === 'wiegand8bit' || format.id === '8bit-wiegand') {
      // Farpointe 8-bit: high nibble = complement of low nibble
      if (key >= '0' && key <= '9') {
        const low = parseInt(key, 10);
        return ((~low & 0x0F) << 4) | low;
      }
      if (key === '*') return 0x5A;
      if (key === '#') return 0x4B;
    }
    
    return key.charCodeAt(0);
  };

  /**
   * Get bit string from keyMap if available
   */
  const getKeyBits = (key: string, format: KeypadFormat): string | null => {
    if (format.keyMap && format.keyMap[key]) {
      return format.keyMap[key];
    }
    return null;
  };

  const styles = {
    card: {
      border: '1px solid #3a3a5a',
      borderRadius: '8px',
      padding: '20px',
      backgroundColor: '#16213e',
      color: '#eee',
      marginBottom: '20px'
    } as React.CSSProperties,
    input: {
      width: '100%',
      padding: '8px',
      border: '1px solid #4a4a6a',
      borderRadius: '4px',
      backgroundColor: '#0f3460',
      color: '#eee',
      fontSize: '14px'
    } as React.CSSProperties,
    select: {
      width: '100%',
      padding: '8px',
      border: '1px solid #4a4a6a',
      borderRadius: '4px',
      backgroundColor: '#0f3460',
      color: '#eee',
      fontSize: '14px',
      cursor: 'pointer'
    } as React.CSSProperties,
    keypadButton: {
      padding: '20px',
      fontSize: '24px',
      fontWeight: 'bold',
      border: '2px solid #4a4a6a',
      borderRadius: '8px',
      backgroundColor: '#2d2d44',
      color: '#00d9ff',
      cursor: 'pointer',
      transition: 'all 0.2s',
      userSelect: 'none'
    } as React.CSSProperties,
    specialButton: {
      padding: '20px',
      fontSize: '16px',
      fontWeight: 'bold',
      border: '2px solid #4a4a6a',
      borderRadius: '8px',
      backgroundColor: '#1a4d5e',
      color: '#00d9ff',
      cursor: 'pointer',
      transition: 'all 0.2s'
    } as React.CSSProperties,
    display: {
      padding: '20px',
      backgroundColor: '#0f3460',
      border: '2px solid #00d9ff',
      borderRadius: '8px',
      fontSize: '32px',
      fontWeight: 'bold',
      textAlign: 'center',
      color: '#00d9ff',
      minHeight: '60px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'monospace',
      letterSpacing: '4px'
    } as React.CSSProperties
  };

  const handleKeyPress = async (key: string) => {
    if (!selectedReader || !readerAvailable) {
      setStatus('error');
      setMessage('Reader not available');
      return;
    }

    if (key === 'C' || key === '*') {
      setInput('');
      setStatus('idle');
      setMessage('');
      return;
    }

    if (key === '#') {
      if (input.length === 0) {
        setStatus('error');
        setMessage('Enter PIN first');
        return;
      }
      await transmitPIN();
      return;
    }

    if (key >= '0' && key <= '9') {
      if (input.length >= 10) {
        setStatus('error');
        setMessage('Maximum 10 digits');
        return;
      }
      setInput(input + key);
      setStatus('idle');
      setMessage('');
    }
  };

  const transmitPIN = async () => {
    if (!input || input.length === 0) {
      setStatus('error');
      setMessage('Enter PIN first');
      return;
    }

    setIsTransmitting(true);
    setStatus('idle');
    setMessage('');

    if (!selectedReader || !readerType) {
      setStatus('error');
      setMessage('Reader not configured');
      setIsTransmitting(false);
      return;
    }

    try {
      let result;

      if (readerType === 'osdp') {
        result = await transmitOSDPKeypad();
      } else {
        result = await transmitWiegandKeypad();
      }

      if (result.success) {
        setStatus('success');
        setMessage(`✓ PIN sent: ${input} (${selectedFormat.name})`);
        
        if (onLog) {
          onLog(`✓ Keypad PIN: ${input} (${selectedFormat.id}) → ${selectedReader.name}`);
        }

        const transmission: KeypadTransmission = {
          timestamp: new Date().toISOString(),
          format: selectedFormat.id,
          pin: input,
          facilityCode: selectedFormat.facilityCodeRequired ? facilityCode : undefined,
          success: true,
          readerName: selectedReader.name,
          readerType
        };
        
        setHistory([transmission, ...history.slice(0, 49)]);
        setInput('');
      } else {
        setStatus('error');
        setMessage(`✗ Failed: ${result.error || 'Unknown error'}`);
        
        if (onLog) {
          onLog(`✗ Keypad failed: ${result.error}`);
        }
      }
    } catch (error) {
      setStatus('error');
      const errorMsg = error instanceof Error ? error.message : 'Network error';
      setMessage(`✗ Error: ${errorMsg}`);
      
      if (onLog) {
        onLog(`✗ Keypad error: ${errorMsg}`);
      }
    } finally {
      setIsTransmitting(false);
    }
  };

  const transmitOSDPKeypad = async (): Promise<{ success: boolean; error?: string }> => {
    if (!selectedReader) {
      return { success: false, error: 'No reader selected' };
    }

    const readerId = selectedReader.id || selectedReader.address?.toString();
    if (!readerId) {
      return { success: false, error: 'Reader ID not configured' };
    }

    const requestBody = {
      readerId: readerId,
      data: input,
      format: selectedFormat.id,
      facilityCode: selectedFormat.facilityCodeRequired ? facilityCode : undefined
    };

    console.log('[Keypad] OSDP request:', requestBody);

    const response = await fetch(`${apiUrl}/api/osdp/keypad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const result = await response.json();
    return { success: result.success || result.ok, error: result.error };
  };

  /**
   * FIXED: Wiegand keypad transmission
   * 
   * For burst mode (4-bit/8-bit): Send each key as raw bits
   * For single mode (26-bit PIN): Send as card credential
   */
  const transmitWiegandKeypad = async (): Promise<{ success: boolean; error?: string }> => {
    if (!selectedReader) {
      return { success: false, error: 'No reader selected' };
    }

    // Get GPIO pins from reader config
    const d0Pin = selectedReader.d0Pin;
    const d1Pin = selectedReader.d1Pin;
    const pulseWidth = selectedReader.pulseWidth || 50;
    
    if (d0Pin === undefined || d1Pin === undefined) {
      return { success: false, error: 'Reader GPIO pins not configured (need d0Pin and d1Pin)' };
    }

    // ═══════════════════════════════════════════════════════════════════
    // SINGLE PACKET MODE (26-bit PIN as card credential)
    // ═══════════════════════════════════════════════════════════════════
    if (selectedFormat.transmission === 'single') {
      const pin = parseInt(input, 10);
      if (isNaN(pin)) {
        return { success: false, error: 'Invalid PIN' };
      }
      
      if (selectedFormat.maxPin && pin > selectedFormat.maxPin) {
        return { success: false, error: `PIN must be 0-${selectedFormat.maxPin}` };
      }

      const requestBody = {
        d0Pin,
        d1Pin,
        facility: facilityCode,
        card: pin,
        bits: selectedFormat.bits || 26,
        pulseWidth
      };

      console.log('[Keypad] Wiegand single-packet (26-bit PIN):', requestBody);

      const response = await fetch(`${apiUrl}/api/wiegand/transmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const result = await response.json();
      return { success: result.success || result.ok, error: result.error };
    }

    // ═══════════════════════════════════════════════════════════════════
    // BURST MODE (4-bit / 8-bit) - Send each key as raw bits
    // ═══════════════════════════════════════════════════════════════════
    const keysToSend = input + '#';  // Append # terminator
    const bitLength = selectedFormat.bitsPerKey || (selectedFormat.id === '8bit' || selectedFormat.id === '8bit-wiegand' ? 8 : 4);
    
    console.log(`[Keypad] Wiegand ${selectedFormat.id} burst mode:`);
    console.log(`  Keys: "${keysToSend}" (${keysToSend.length} keys)`);
    console.log(`  Bits per key: ${bitLength}`);
    console.log(`  GPIO: D0=${d0Pin}, D1=${d1Pin}`);

    for (let i = 0; i < keysToSend.length; i++) {
      const key = keysToSend[i];
      
      // Get bits from keyMap or calculate from hex value
      let rawBits = getKeyBits(key, selectedFormat);
      if (!rawBits) {
        const keyValue = getKeyValue(key, selectedFormat);
        rawBits = keyValue.toString(2).padStart(bitLength, '0');
      }
      
      console.log(`[Keypad] Key ${i + 1}/${keysToSend.length}: '${key}' → ${rawBits} (${rawBits.length} bits)`);

      // ✅ FIXED: Use /api/wiegand/raw endpoint for raw bit transmission
      // Falls back to /api/wiegand/transmit with rawBits parameter
      const requestBody = {
        d0Pin,
        d1Pin,
        rawBits,
        pulseWidth
      };

      // Try /api/wiegand/raw first (cleaner endpoint)
      let response = await fetch(`${apiUrl}/api/wiegand/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      // If /raw endpoint doesn't exist (404), fall back to /transmit with rawBits
      if (response.status === 404) {
        console.log('[Keypad] /api/wiegand/raw not found, using /api/wiegand/transmit');
        response = await fetch(`${apiUrl}/api/wiegand/transmit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
      }

      const result = await response.json();
      
      if (!result.success && !result.ok) {
        return { success: false, error: `Failed on key '${key}': ${result.error || 'Unknown error'}` };
      }
      
      // Inter-key delay (50ms like real keypads)
      if (i < keysToSend.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    console.log('[Keypad] ✓ Wiegand burst transmission complete');
    return { success: true };
  };

  const clearHistory = () => setHistory([]);

  return (
    <div style={{ padding: '10px', fontFamily: 'Arial, sans-serif' }}>
      <div style={styles.card}>
        <h3 style={{ marginTop: 0, color: '#00d9ff' }}>⌨️ Keypad Emulator</h3>
        
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>
            Select Reader
          </label>
          <select
            value={selectedReaderIndex}
            onChange={(e) => setSelectedReaderIndex(parseInt(e.target.value, 10))}
            style={styles.select}
            disabled={isTransmitting}
          >
            {readers.length === 0 ? (
              <option value={-1}>No readers available</option>
            ) : (
              readers.map((reader, index) => {
                const type = detectReaderType(reader);
                const statusIcon = reader.enabled ? '✓' : '✗';
                const pinsInfo = reader.d0Pin !== undefined ? ` [GPIO ${reader.d0Pin}/${reader.d1Pin}]` : '';
                return (
                  <option key={index} value={index}>
                    {statusIcon} {reader.name} ({type.toUpperCase()}){pinsInfo}
                  </option>
                );
              })
            )}
          </select>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>
            Keypad Format
          </label>
          <select
            value={selectedFormatId}
            onChange={(e) => setSelectedFormatId(e.target.value)}
            style={styles.select}
            disabled={isTransmitting}
          >
            {formats.map((format) => (
              <option key={format.id} value={format.id}>
                {format.name} ({format.transmission === 'burst' ? 'Burst' : 'Single'})
              </option>
            ))}
          </select>
        </div>

        {selectedFormat.facilityCodeRequired && (
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>
              Facility Code
            </label>
            <input
              type="number"
              min="0"
              max="255"
              value={facilityCode}
              onChange={(e) => setFacilityCode(parseInt(e.target.value, 10) || 0)}
              style={styles.input}
              disabled={isTransmitting}
            />
          </div>
        )}

        <div style={{
          padding: '10px',
          backgroundColor: '#2d2d44',
          borderRadius: '4px',
          marginBottom: '15px',
          fontSize: '12px',
          color: '#00d9ff'
        }}>
          <strong>ℹ️ {selectedFormat.name}</strong><br/>
          {selectedFormat.description}
          <br/>
          <span style={{ color: selectedFormat.transmission === 'burst' ? '#ffa500' : '#4ade80' }}>
            Mode: {selectedFormat.transmission === 'burst' 
              ? '🔥 Burst (one packet per key)' 
              : '📦 Single packet'}
          </span>
          {selectedFormat.bitsPerKey && (
            <span style={{ marginLeft: '10px', color: '#aaa' }}>
              | {selectedFormat.bitsPerKey} bits/key
            </span>
          )}
        </div>

        {/* Debug info for selected reader */}
        {selectedReader && readerType === 'wiegand' && (
          <div style={{
            padding: '8px',
            backgroundColor: '#1a3a2a',
            borderRadius: '4px',
            marginBottom: '15px',
            fontSize: '11px',
            color: '#4ade80',
            fontFamily: 'monospace'
          }}>
            TX Pins: D0=GPIO{selectedReader.d0Pin} D1=GPIO{selectedReader.d1Pin} | 
            Pulse: {selectedReader.pulseWidth || 50}μs
          </div>
        )}
      </div>

      <div style={styles.card}>
        {message && (
          <div style={{
            padding: '10px',
            marginBottom: '15px',
            borderRadius: '4px',
            backgroundColor: status === 'success' ? '#1a4d2e' : status === 'error' ? '#4d1a1a' : '#2d2d44',
            color: status === 'success' ? '#4ade80' : status === 'error' ? '#ff6b6b' : '#00d9ff',
            fontSize: '13px',
            textAlign: 'center'
          }}>
            {message}
          </div>
        )}

        <div style={styles.display}>
          {input || '_ _ _ _ _'}
        </div>

        <div style={{
          marginTop: '10px',
          padding: '8px',
          backgroundColor: '#2d2d44',
          borderRadius: '4px',
          fontSize: '11px',
          textAlign: 'center',
          color: '#00d9ff'
        }}>
          <strong>Enter PIN → Press # to SEND</strong> | <strong>* to CLEAR</strong>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '10px',
          marginTop: '15px'
        }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
            <button
              key={num}
              onClick={() => handleKeyPress(num.toString())}
              disabled={isTransmitting || !readerAvailable}
              onMouseEnter={(e) => {
                if (!e.currentTarget.disabled) {
                  e.currentTarget.style.backgroundColor = '#00d9ff';
                  e.currentTarget.style.color = '#000';
                }
              }}
              onMouseLeave={(e) => {
                if (!e.currentTarget.disabled) {
                  e.currentTarget.style.backgroundColor = '#2d2d44';
                  e.currentTarget.style.color = '#00d9ff';
                }
              }}
              style={{
                ...styles.keypadButton,
                opacity: isTransmitting || !readerAvailable ? 0.5 : 1,
                cursor: isTransmitting || !readerAvailable ? 'not-allowed' : 'pointer'
              }}
            >
              {num}
            </button>
          ))}
          
          <button
            onClick={() => handleKeyPress('*')}
            disabled={isTransmitting || !readerAvailable}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = '#ffa500';
                e.currentTarget.style.color = '#000';
              }
            }}
            onMouseLeave={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = '#1a4d5e';
                e.currentTarget.style.color = '#00d9ff';
              }
            }}
            style={{
              ...styles.specialButton,
              opacity: isTransmitting || !readerAvailable ? 0.5 : 1,
              cursor: isTransmitting || !readerAvailable ? 'not-allowed' : 'pointer'
            }}
          >
            * CLEAR
          </button>

          <button
            onClick={() => handleKeyPress('0')}
            disabled={isTransmitting || !readerAvailable}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = '#00d9ff';
                e.currentTarget.style.color = '#000';
              }
            }}
            onMouseLeave={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = '#2d2d44';
                e.currentTarget.style.color = '#00d9ff';
              }
            }}
            style={{
              ...styles.keypadButton,
              opacity: isTransmitting || !readerAvailable ? 0.5 : 1,
              cursor: isTransmitting || !readerAvailable ? 'not-allowed' : 'pointer'
            }}
          >
            0
          </button>

          <button
            onClick={() => handleKeyPress('#')}
            disabled={isTransmitting || !readerAvailable || input.length === 0}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = '#4ade80';
                e.currentTarget.style.color = '#000';
              }
            }}
            onMouseLeave={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.backgroundColor = '#1a4d5e';
                e.currentTarget.style.color = '#00d9ff';
              }
            }}
            style={{
              ...styles.specialButton,
              opacity: isTransmitting || !readerAvailable || input.length === 0 ? 0.5 : 1,
              cursor: isTransmitting || !readerAvailable || input.length === 0 ? 'not-allowed' : 'pointer'
            }}
          >
            # SEND
          </button>
        </div>

        <button
          onClick={() => handleKeyPress('C')}
          disabled={isTransmitting}
          style={{
            width: '100%',
            marginTop: '10px',
            padding: '10px',
            border: '2px solid #4a4a6a',
            borderRadius: '4px',
            backgroundColor: '#4d1a1a',
            color: '#ff6b6b',
            cursor: isTransmitting ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: 'bold',
            opacity: isTransmitting ? 0.5 : 1
          }}
        >
          CLEAR ALL
        </button>
      </div>

      {/* History Section */}
      <div style={styles.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <h4 style={{ margin: 0, color: '#00d9ff' }}>Transmission History</h4>
          <button
            onClick={clearHistory}
            disabled={history.length === 0}
            style={{
              padding: '5px 10px',
              border: '1px solid #4a4a6a',
              borderRadius: '4px',
              backgroundColor: '#2d2d44',
              color: '#ff6b6b',
              cursor: history.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              opacity: history.length === 0 ? 0.5 : 1
            }}
          >
            Clear History
          </button>
        </div>

        <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #3a3a5a', borderRadius: '4px' }}>
          {history.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
              No transmissions yet
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead style={{ backgroundColor: '#16213e', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #3a3a5a', color: '#00d9ff' }}>Time</th>
                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #3a3a5a', color: '#00d9ff' }}>Format</th>
                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #3a3a5a', color: '#00d9ff' }}>PIN</th>
                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #3a3a5a', color: '#00d9ff' }}>FC</th>
                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #3a3a5a', color: '#00d9ff' }}>Protocol</th>
                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid #3a3a5a', color: '#00d9ff' }}>Reader</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid #3a3a5a' }}>
                    <td style={{ padding: '8px', color: '#eee' }}>
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '12px',
                        backgroundColor: '#1a4d5e',
                        color: '#00d9ff',
                        fontSize: '11px'
                      }}>
                        {item.format}
                      </span>
                    </td>
                    <td style={{ padding: '8px', color: '#00d9ff', fontWeight: 'bold', fontFamily: 'monospace' }}>
                      {item.pin}
                    </td>
                    <td style={{ padding: '8px', color: '#aaa' }}>
                      {item.facilityCode !== undefined ? item.facilityCode : '-'}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '12px',
                        backgroundColor: item.readerType === 'osdp' ? '#2d4d1a' : '#4d2d1a',
                        color: item.readerType === 'osdp' ? '#90ee90' : '#ffa500',
                        fontSize: '10px'
                      }}>
                        {item.readerType.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '8px', color: '#aaa' }}>
                      {item.readerName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

export default KeypadEmulator;
