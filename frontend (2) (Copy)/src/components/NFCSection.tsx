/**
 * NFCSection.tsx - NFC Card Reader Component
 * 
 * FIXED VERSION - Reduced polling interval from 2s to 10s to prevent
 * unnecessary API calls that contribute to I2C bus saturation over time.
 */

import React, { useState, useEffect, useCallback } from 'react';

interface CardFormat {
  id: string;
  name: string;
  category?: string;
  bits: number;
  facilityBits: number;
  cardBits: number;
  maxFacility?: number;
  maxCard?: number;
  hasParity?: boolean;
  description?: string;
}

interface Reader {
  id: string;
  name: string;
  type: 'wiegand' | 'osdp';
  door?: number;
  address?: number;
  pins?: { d0: number; d1: number };
  online: boolean;
}

interface NFCCard {
  uid: string;
  type: string;
  atqa?: string;
  sak?: string;
  source?: 'pn532' | 'rc522';
  timestamp: string;
}

interface ConversionResult {
  facility: number;
  card: number;
  decimal: string;
  binary: string;
}

interface NFCConfig {
  mode: 'manual' | 'auto';
  autoTarget: { type: 'wiegand' | 'osdp'; readerId: string } | null;
  autoFormat: string;
  enabled: boolean;
}

interface ReaderStatus {
  connected: boolean;
  polling: boolean;
  lastUid: string | null;
  lastScan: string | null;
  error: string | null;
  chipVersion?: string;
}

const API_BASE = 'http://192.168.1.2:3001';

// ═══════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function uidToBytes(uid: string): number[] {
  const clean = uid.replace(/[\s:-]/g, '').toUpperCase();
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

function uidToBigInt(uid: string): bigint {
  const clean = uid.replace(/[\s:-]/g, '').toUpperCase();
  return BigInt('0x' + clean);
}

function convertUidToFormat(uid: string, format: CardFormat): ConversionResult {
  const bytes = uidToBytes(uid);
  const uidBigInt = uidToBigInt(uid);
  let facility = 0;
  let card = 0;
  const fcBits = format.facilityBits || 0;
  const cardBits = format.cardBits || format.bits;
  
  if (fcBits === 0) {
    if (cardBits >= 53) {
      const mask = (BigInt(1) << BigInt(31)) - BigInt(1);
      card = Number(uidBigInt & mask);
    } else {
      const mask = (BigInt(1) << BigInt(cardBits)) - BigInt(1);
      card = Number(uidBigInt & mask);
    }
  } else {
    const fcByteCount = Math.ceil(fcBits / 8);
    const cardByteCount = Math.ceil(cardBits / 8);
    for (let i = 0; i < fcByteCount && i < bytes.length; i++) {
      facility = (facility << 8) | (bytes[i] || 0);
    }
    if (fcBits < 31) facility = facility & ((1 << fcBits) - 1);
    facility = facility >>> 0;
    for (let i = fcByteCount; i < fcByteCount + cardByteCount && i < bytes.length; i++) {
      card = (card << 8) | (bytes[i] || 0);
    }
    if (cardBits < 31) card = card & ((1 << cardBits) - 1);
    card = card >>> 0;
  }
  const binaryBits = Math.min(format.bits, 64);
  const binary = uidBigInt.toString(2).padStart(binaryBits, '0').slice(-binaryBits);
  return { facility, card, decimal: uidBigInt.toString(), binary };
}

function formatUid(uid: string): string {
  const clean = uid.replace(/[\s:-]/g, '').toUpperCase();
  return clean.match(/.{2}/g)?.join(':') || clean;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════

export const NFCSection: React.FC = () => {
  const [formats, setFormats] = useState<CardFormat[]>([]);
  const [readers, setReaders] = useState<Reader[]>([]);
  const [lastCard, setLastCard] = useState<NFCCard | null>(null);
  const [history, setHistory] = useState<NFCCard[]>([]);
  const [connected, setConnected] = useState(false);
  const [polling, setPolling] = useState(false);
  const [nfcPollingEnabled, setNfcPollingEnabled] = useState(false);
  const [config, setConfig] = useState<NFCConfig>({ mode: 'manual', autoTarget: null, autoFormat: 'w26', enabled: true });
  const [selectedFormatId, setSelectedFormatId] = useState('w26');
  const [selectedReaderId, setSelectedReaderId] = useState('');
  const [transmitting, setTransmitting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error' | 'scanning'>('idle');
  const [message, setMessage] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [formatFilter, setFormatFilter] = useState<string>('all');
  const [pn532Status, setPn532Status] = useState<ReaderStatus>({ connected: false, polling: false, lastUid: null, lastScan: null, error: null });
  const [rc522Status, setRc522Status] = useState<ReaderStatus>({ connected: false, polling: false, lastUid: null, lastScan: null, error: null });

  const selectedFormat = formats.find(f => f.id === selectedFormatId) || formats[0];
  const conversion = lastCard && selectedFormat ? convertUidToFormat(lastCard.uid, selectedFormat) : null;

  // ═══════════════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════════════

  const loadFormats = useCallback(async () => {
    try {
      const res = await fetch(API_BASE + '/api/formats');
      const data = await res.json();
      if (data.success && data.formats) {
        setFormats(data.formats);
      }
    } catch (err) {
      setFormats([
        { id: 'w26', name: 'Wiegand 26 (H10301)', bits: 26, facilityBits: 8, cardBits: 16 },
        { id: 'w34', name: 'Wiegand 34', bits: 34, facilityBits: 16, cardBits: 16 },
      ]);
    }
  }, []);

  const loadReaders = useCallback(async () => {
    try {
      const res = await fetch(API_BASE + '/api/nfc/readers');
      const data = await res.json();
      if (data.success && data.readers) {
        setReaders(data.readers);
        const wiegandReader = data.readers.find((r: Reader) => r.type === 'wiegand');
        if (wiegandReader && !selectedReaderId) setSelectedReaderId(wiegandReader.id);
      }
    } catch (err) {}
  }, [selectedReaderId]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(API_BASE + '/api/nfc/status');
      const data = await res.json();
      if (data.success) {
        setConnected(data.connected || data.status?.connected || false);
        if (data.lastCard || data.status?.lastCard) setLastCard(data.lastCard || data.status?.lastCard);
        if (data.config) setConfig(data.config);
        if (data.pn532) setPn532Status(data.pn532);
        if (data.rc522) setRc522Status(data.rc522);
        if (data.status?.polling !== undefined) setNfcPollingEnabled(data.status.polling);
      }
    } catch (err) {
      setConnected(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(API_BASE + '/api/nfc/history?limit=50');
      const data = await res.json();
      if (data.success && data.history) setHistory(data.history);
    } catch (err) {}
  }, []);

  // ═══════════════════════════════════════════════════════════════════════
  // EFFECTS
  // ═══════════════════════════════════════════════════════════════════════

  // Initial load - once only
  useEffect(() => {
    loadFormats();
    loadReaders();
    loadStatus();
    loadHistory();
  }, [loadFormats, loadReaders, loadStatus, loadHistory]);

  // ⚠️ REDUCED POLLING - 10 seconds instead of 2 seconds
  // This reduces API calls from 43,200/day to 8,640/day
  useEffect(() => {
    const interval = setInterval(() => {
      loadStatus();
      // Only load history if panel is visible
      if (showHistory) {
        loadHistory();
      }
    }, 10000);  // ← Was 2000ms, now 10000ms
    
    return () => clearInterval(interval);
  }, [loadStatus, loadHistory, showHistory]);

  // ═══════════════════════════════════════════════════════════════════════
  // NFC POLLING CONTROL
  // ═══════════════════════════════════════════════════════════════════════

  const toggleNfcPolling = async () => {
    try {
      const endpoint = nfcPollingEnabled ? '/api/nfc/polling/stop' : '/api/nfc/polling/start';
      const res = await fetch(API_BASE + endpoint, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setNfcPollingEnabled(!nfcPollingEnabled);
        setMessage(nfcPollingEnabled ? 'NFC polling stopped' : 'NFC polling started');
        setStatus('success');
      } else {
        setMessage(data.error || 'Failed to toggle polling');
        setStatus('error');
      }
    } catch (err) {
      setMessage('Failed to toggle polling');
      setStatus('error');
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // CARD OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════

  const scanCard = async () => {
    if (polling) return;
    setStatus('scanning');
    setMessage('Hold card to reader...');
    setPolling(true);
    let card: NFCCard | null = null;

    console.log('[DEBUG] Starting PN532 scan...');
    try {
      const res = await fetch(API_BASE + '/api/nfc/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeout: 8000 })
      });
      console.log('[DEBUG] PN532 response:', res.status);
      const data = await res.json();
      console.log('[DEBUG] PN532 data:', data);
      if (data.success && data.card) {
        card = { ...data.card, source: 'pn532' as const };
      }
    } catch (e) {
      console.log('[DEBUG] PN532 error:', e);
    }

    if (!card) {
      console.log('[DEBUG] Trying RC522...');
      try {
        const res = await fetch(API_BASE + '/api/rc522/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeout: 5000 })
        });
        const data = await res.json();
        if (data.success && data.card) {
          card = { ...data.card, source: 'rc522' as const };
        }
      } catch (e) {
        console.log('[DEBUG] RC522 error:', e);
      }
    }

    console.log('[DEBUG] Final card:', card);
    if (card) {
      setLastCard(card);
      setStatus('success');
      setMessage('✓ ' + (card.source?.toUpperCase() || 'NFC') + ': ' + formatUid(card.uid));
      loadHistory();
    } else {
      setStatus('error');
      setMessage('No card detected');
    }
    setPolling(false);
  };

  const transmitCard = async (card?: NFCCard) => {
    const cardToTransmit = card || lastCard;
    if (!cardToTransmit || !selectedReaderId || !selectedFormat) return;
    const reader = readers.find(r => r.id === selectedReaderId);
    if (!reader) return;
    setTransmitting(true);
    try {
      await fetch(API_BASE + '/api/gpio/release', { method: 'POST' });
      const convResult = convertUidToFormat(cardToTransmit.uid, selectedFormat);
      const res = await fetch(API_BASE + '/api/nfc/transmit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: cardToTransmit.uid,
          targetType: reader.type,
          readerId: reader.id,
          format: selectedFormat.bits,
          d0Pin: reader.pins?.d0 || 17,
          d1Pin: reader.pins?.d1 || 27
        })
      });
      const data = await res.json();
      if (data.success) {
        setStatus('success');
        setMessage('✓ Sent to ' + reader.name + ': FC=' + convResult.facility + ' Card=' + convResult.card);
      } else {
        setStatus('error');
        setMessage(data.error || 'Transmit failed');
      }
    } catch (err) {
      setStatus('error');
      setMessage('Transmit failed');
    } finally {
      setTransmitting(false);
    }
  };

  const toggleAutoMode = async () => {
    const newMode = config.mode === 'manual' ? 'auto' : 'manual';
    try {
      const res = await fetch(API_BASE + '/api/nfc/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode, autoFormat: selectedFormatId })
      });
      const data = await res.json();
      if (data.success && data.config) setConfig(data.config);
    } catch (err) {}
  };

  const clearHistory = async () => {
    try {
      await fetch(API_BASE + '/api/nfc/history', { method: 'DELETE' });
      setHistory([]);
    } catch (err) {}
  };

  // ═══════════════════════════════════════════════════════════════════════
  // FORMAT FILTERING
  // ═══════════════════════════════════════════════════════════════════════

  const formatCategories = React.useMemo(() => {
    const cats = new Map<string, CardFormat[]>();
    formats.forEach(f => {
      const cat = f.category || 'other';
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(f);
    });
    return cats;
  }, [formats]);

  const filteredFormats = React.useMemo(() => {
    if (formatFilter === 'all') return formats;
    return formats.filter(f => f.category === formatFilter);
  }, [formats, formatFilter]);

  const categoryLabels: Record<string, string> = {
    wiegand: '🔢 Wiegand', hid: '🏢 HID', wavelynx: '📡 Wavelynx', csn: '💳 CSN',
    awid: '📶 AWID', indala: '🔷 Indala', em: '⚡ EM Prox', mifare: '📱 MIFARE/NFC',
    piv: '🏛️ Government/PIV', proprietary: '🏭 Proprietary', generic: '🔧 Testing', other: '📋 Other'
  };

  // ═══════════════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════════════

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: '15px', fontFamily: 'Arial, sans-serif', color: '#eee' },
    card: { border: '1px solid #3a3a5a', borderRadius: '8px', padding: '15px', backgroundColor: '#16213e', marginBottom: '15px' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' },
    title: { margin: 0, color: '#00d9ff', fontSize: '18px' },
    statusBadge: { padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold' },
    select: { width: '100%', padding: '10px', border: '1px solid #4a4a6a', borderRadius: '4px', backgroundColor: '#0f3460', color: '#eee', fontSize: '14px', cursor: 'pointer', marginBottom: '10px' },
    button: { padding: '12px 20px', border: 'none', borderRadius: '6px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s' },
    cardDisplay: { padding: '20px', backgroundColor: '#0f3460', border: '2px solid #00d9ff', borderRadius: '8px', textAlign: 'center', marginBottom: '15px' },
    uidDisplay: { fontSize: '28px', fontWeight: 'bold', fontFamily: 'monospace', color: '#00d9ff', letterSpacing: '2px' },
    conversionGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginTop: '15px' },
    conversionItem: { padding: '10px', backgroundColor: '#2d2d44', borderRadius: '4px', textAlign: 'center' },
    label: { fontSize: '11px', color: '#888', marginBottom: '4px' },
    value: { fontSize: '16px', fontWeight: 'bold', color: '#4ade80', fontFamily: 'monospace' },
    filterRow: { display: 'flex', gap: '5px', marginBottom: '10px', flexWrap: 'wrap' },
    filterBtn: { padding: '4px 8px', border: '1px solid #4a4a6a', borderRadius: '4px', backgroundColor: '#0f3460', color: '#aaa', fontSize: '11px', cursor: 'pointer' },
    filterBtnActive: { backgroundColor: '#00d9ff', color: '#000', borderColor: '#00d9ff' }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h3 style={styles.title}>📱 NFC Readers</h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button 
              onClick={toggleNfcPolling}
              style={{ 
                ...styles.button, 
                padding: '4px 10px', 
                fontSize: '11px',
                backgroundColor: nfcPollingEnabled ? '#4ade80' : '#4a4a6a',
                color: nfcPollingEnabled ? '#000' : '#aaa'
              }}
            >
              {nfcPollingEnabled ? '⏸ Stop Poll' : '▶ Start Poll'}
            </button>
            <div style={{ ...styles.statusBadge, backgroundColor: pn532Status.connected ? '#1a4d2e' : '#4d1a1a', color: pn532Status.connected ? '#4ade80' : '#ff6b6b', fontSize: '11px' }}>
              PN532 {pn532Status.connected ? '●' : '○'}
            </div>
            <div style={{ ...styles.statusBadge, backgroundColor: rc522Status.connected ? '#1a4d2e' : '#4d1a1a', color: rc522Status.connected ? '#4ade80' : '#ff6b6b', fontSize: '11px' }}>
              RC522 {rc522Status.connected ? '●' : '○'}
            </div>
          </div>
        </div>
        
        {message && (
          <div style={{ padding: '10px', borderRadius: '4px', marginBottom: '15px', backgroundColor: status === 'success' ? '#1a4d2e' : status === 'error' ? '#4d1a1a' : status === 'scanning' ? '#4d4d1a' : '#2d2d44', color: status === 'success' ? '#4ade80' : status === 'error' ? '#ff6b6b' : status === 'scanning' ? '#ffdd57' : '#00d9ff', textAlign: 'center', fontSize: '14px' }}>
            {status === 'scanning' && '🔄 '}{message}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginBottom: '15px', padding: '10px', backgroundColor: '#2d2d44', borderRadius: '6px' }}>
          <button onClick={() => config.mode !== 'manual' && toggleAutoMode()} style={{ ...styles.button, flex: 1, backgroundColor: config.mode === 'manual' ? '#00d9ff' : '#0f3460', color: config.mode === 'manual' ? '#000' : '#888' }}>📋 Manual</button>
          <button onClick={() => config.mode !== 'auto' && toggleAutoMode()} style={{ ...styles.button, flex: 1, backgroundColor: config.mode === 'auto' ? '#4ade80' : '#0f3460', color: config.mode === 'auto' ? '#000' : '#888' }}>🔄 Auto-Transmit</button>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>Target Reader</label>
          <select value={selectedReaderId} onChange={(e) => setSelectedReaderId(e.target.value)} style={styles.select}>
            {readers.length === 0 ? <option value="">No readers available</option> : (
              <>
                <optgroup label="🔌 Wiegand Readers">
                  {readers.filter(r => r.type === 'wiegand').map(reader => (
                    <option key={reader.id} value={reader.id}>{reader.online ? '●' : '○'} {reader.name}{reader.pins && ` [GPIO ${reader.pins.d0}/${reader.pins.d1}]`}</option>
                  ))}
                </optgroup>
                <optgroup label="📡 OSDP Readers">
                  {readers.filter(r => r.type === 'osdp').map(reader => (
                    <option key={reader.id} value={reader.id}>{reader.online ? '●' : '○'} {reader.name}{reader.address !== undefined && ` [Addr ${reader.address}]`}</option>
                  ))}
                </optgroup>
              </>
            )}
          </select>
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>Format Category</label>
          <div style={styles.filterRow}>
            <button onClick={() => setFormatFilter('all')} style={{ ...styles.filterBtn, ...(formatFilter === 'all' ? styles.filterBtnActive : {}) }}>All ({formats.length})</button>
            {Array.from(formatCategories.keys()).map(cat => (
              <button key={cat} onClick={() => setFormatFilter(cat)} style={{ ...styles.filterBtn, ...(formatFilter === cat ? styles.filterBtnActive : {}) }}>{categoryLabels[cat] || cat} ({formatCategories.get(cat)?.length})</button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>Wiegand Format ({filteredFormats.length} formats)</label>
          <select value={selectedFormatId} onChange={(e) => setSelectedFormatId(e.target.value)} style={styles.select}>
            {filteredFormats.map(fmt => (
              <option key={fmt.id} value={fmt.id}>{fmt.name} ({fmt.bits}-bit{fmt.facilityBits > 0 ? `, FC:${fmt.facilityBits}b` : ''}{fmt.cardBits > 0 ? `, Card:${fmt.cardBits}b` : ''})</option>
            ))}
          </select>
          {selectedFormat && <div style={{ fontSize: '11px', color: '#888', marginTop: '5px' }}>{selectedFormat.description || `${selectedFormat.bits}-bit format`}</div>}
        </div>

        {config.mode === 'manual' && (
          <button onClick={scanCard} disabled={polling} style={{ ...styles.button, width: '100%', fontSize: '16px', padding: '15px', backgroundColor: (pn532Status.connected || rc522Status.connected) ? '#00d9ff' : '#ff9f43', color: '#000', opacity: polling ? 0.5 : 1, cursor: polling ? 'not-allowed' : 'pointer' }}>
            {polling ? '🔄 Scanning...' : (pn532Status.connected || rc522Status.connected) ? '📡 Scan Card' : '📡 Try Scan (No Reader)'}
          </button>
        )}
      </div>

      {lastCard && (
        <div style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h4 style={{ margin: 0, color: '#00d9ff' }}>Last Scanned Card</h4>
            {lastCard.source && <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', backgroundColor: lastCard.source === 'pn532' ? '#1a3d5c' : '#3d1a5c', color: lastCard.source === 'pn532' ? '#00d9ff' : '#d966ff' }}>{lastCard.source === 'pn532' ? '📡 PN532' : '📻 RC522'}</span>}
          </div>
          <div style={styles.cardDisplay}>
            <div style={{ fontSize: '12px', color: '#888', marginBottom: '5px' }}>UID</div>
            <div style={styles.uidDisplay}>{formatUid(lastCard.uid)}</div>
            <div style={{ fontSize: '12px', color: '#aaa', marginTop: '8px' }}>{lastCard.type}</div>
          </div>
          {conversion && selectedFormat && (
            <>
              <div style={{ fontSize: '13px', color: '#00d9ff', marginBottom: '10px', textAlign: 'center' }}>→ {selectedFormat.name}</div>
              <div style={styles.conversionGrid}>
                <div style={styles.conversionItem}><div style={styles.label}>Facility Code</div><div style={styles.value}>{selectedFormat.facilityBits > 0 ? conversion.facility : 'N/A'}</div></div>
                <div style={styles.conversionItem}><div style={styles.label}>Card Number</div><div style={styles.value}>{conversion.card.toLocaleString()}</div></div>
                <div style={styles.conversionItem}><div style={styles.label}>Decimal</div><div style={styles.value}>{BigInt(conversion.decimal).toLocaleString()}</div></div>
                <div style={styles.conversionItem}><div style={styles.label}>Format</div><div style={styles.value}>{selectedFormat.bits}-bit</div></div>
              </div>
            </>
          )}
          {config.mode === 'manual' && (
            <button onClick={() => transmitCard()} disabled={transmitting || !selectedReaderId} style={{ ...styles.button, width: '100%', marginTop: '15px', backgroundColor: '#4ade80', color: '#000', fontSize: '16px', padding: '12px', opacity: (transmitting || !selectedReaderId) ? 0.5 : 1, cursor: (transmitting || !selectedReaderId) ? 'not-allowed' : 'pointer' }}>
              {transmitting ? '📤 Transmitting...' : '📤 Transmit to Reader'}
            </button>
          )}
        </div>
      )}

      <div style={styles.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <h4 style={{ margin: 0, color: '#00d9ff' }}>Scan History ({history.length})</h4>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setShowHistory(!showHistory)} style={{ ...styles.button, padding: '5px 10px', fontSize: '12px', backgroundColor: '#2d2d44', color: '#00d9ff', border: '1px solid #4a4a6a' }}>{showHistory ? 'Hide' : 'Show'}</button>
            {history.length > 0 && <button onClick={clearHistory} style={{ ...styles.button, padding: '5px 10px', fontSize: '12px', backgroundColor: '#4d1a1a', color: '#ff6b6b' }}>Clear</button>}
          </div>
        </div>
        {showHistory && (
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {history.length === 0 ? <div style={{ textAlign: 'center', color: '#888', padding: '20px' }}>No cards scanned yet</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead><tr style={{ backgroundColor: '#0f3460' }}><th style={{ padding: '8px', textAlign: 'left', color: '#00d9ff' }}>Time</th><th style={{ padding: '8px', textAlign: 'left', color: '#00d9ff' }}>UID</th><th style={{ padding: '8px', textAlign: 'left', color: '#00d9ff' }}>Type</th><th style={{ padding: '8px', textAlign: 'center', color: '#00d9ff' }}>Actions</th></tr></thead>
                <tbody>
                  {history.map((card, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #3a3a5a' }}>
                      <td style={{ padding: '8px', color: '#aaa' }}>{new Date(card.timestamp).toLocaleTimeString()}</td>
                      <td style={{ padding: '8px', fontFamily: 'monospace', color: '#00d9ff' }}>{formatUid(card.uid)}</td>
                      <td style={{ padding: '8px', color: '#aaa' }}>{card.type}</td>
                      <td style={{ padding: '8px', textAlign: 'center' }}><button onClick={() => { setLastCard(card); transmitCard(card); }} style={{ ...styles.button, padding: '4px 8px', fontSize: '11px', backgroundColor: '#4ade80', color: '#000' }}>📤 Send</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div style={{ fontSize: '11px', color: '#666', textAlign: 'center' }}>
        PN532: {pn532Status.connected ? '✓ I2C' : '✗'} | RC522: {rc522Status.connected ? '✓ SPI' : '✗'} | 
        Mode: {config.mode} | Format: {selectedFormat?.name || 'None'} | 
        Polling: {nfcPollingEnabled ? '▶ Active' : '⏸ Stopped'}
      </div>
    </div>
  );
};

export default NFCSection;
