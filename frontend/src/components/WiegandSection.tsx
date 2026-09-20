import React, { useState, useEffect } from 'react';
import { useCardFormats, formatDisplayName, isValidFacilityCode, isValidCardNumber } from '../hooks/useCardFormats';
import KeypadEmulator from './KeypadEmulator';
import InteractiveWiegandReader from './InteractiveWiegandReader';
import WiegandFormatVisualizer from './WiegandFormatVisualizer';

interface WiegandTransmission {
  timestamp: string;
  facility: number;
  card: number;
  bits: number;
  d0Pin: number;
  d1Pin: number;
  pulseWidth: number;
  duration: number;
  success: boolean;
  output?: string;
  error?: string;
  readerName?: string;
  issueLevel?: number;
  formatId?: string;
}

interface ReaderConfig {
  name: string;
  d0Pin: number;
  d1Pin: number;
  pulseWidth: number;
  enabled: boolean;
}

interface WiegandSectionProps {
  ipAddress?: string;
  connected?: boolean;
  onLog?: (message: string) => void;
  onAuditLog?: (message: string) => void;
  onEmulationLog?: (message: string) => void;
}

// v5.0 Category definitions
const FORMAT_CATEGORIES = [
  { id: 'all', name: 'All Formats' },
  { id: 'wiegand', name: 'Standard Wiegand' },
  { id: 'hid', name: 'HID' },
  { id: 'wavelynx', name: 'WaveLynx' },
  { id: 'csn', name: 'CSN' },
  { id: 'awid', name: 'AWID' },
  { id: 'indala', name: 'Indala' },
  { id: 'em', name: 'EM Proximity' },
  { id: 'mifare', name: 'MIFARE/NFC' },
  { id: 'piv', name: 'Government/PIV' },
  { id: 'proprietary', name: 'Proprietary' },
  { id: 'generic', name: 'Generic/Testing' }
];

// v5.0 Parity type display info
const PARITY_INFO: Record<string, { label: string; color: string; warning?: string }> = {
  'std': { label: 'Standard', color: '#6FBF7E' },
  'none': { label: 'No Parity', color: '#786D60' },
  'interleaved': { label: 'Interleaved', color: '#E6C766', warning: 'Complex parity - verify with real cards' },
  'multi-row': { label: 'Multi-Row', color: '#C6604F', warning: 'Multi-row parity - complex encoding' },
  'xor': { label: 'XOR Checksum', color: '#5FB7B0', warning: 'XOR byte checksum - not traditional parity' },
  'scrambled': { label: 'Scrambled', color: '#D98A3D', warning: 'Scrambled bit positions - lookup tables required' }
};

const getApiUrl = (): string => {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  return `${protocol}//${hostname}:3001`;
};

export const WiegandSection: React.FC<WiegandSectionProps> = ({
  ipAddress,
  connected,
  onLog,
  onAuditLog,
  onEmulationLog
}) => {
  const apiUrl = ipAddress ? `http://${ipAddress}:3001` : getApiUrl();

  const [readers, setReaders] = useState<ReaderConfig[]>([
    { name: 'Reader 1', d0Pin: 17, d1Pin: 27, pulseWidth: 50, enabled: true },
    { name: 'Reader 2', d0Pin: 22, d1Pin: 23, pulseWidth: 50, enabled: true },
    { name: 'Reader 3', d0Pin: 24, d1Pin: 25, pulseWidth: 50, enabled: true },
    { name: 'Reader 4', d0Pin: 5, d1Pin: 6, pulseWidth: 50, enabled: true }
  ]);

  const [selectedReaderIndex, setSelectedReaderIndex] = useState<number>(0);
  const [showReaderConfig, setShowReaderConfig] = useState(false);
  const [mode, setMode] = useState<'emulate' | 'visualizer'>('emulate');
  const [keypadFormat, setKeypadFormat] = useState<string>('4bit');

  // v5.0: Category filter
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const {
    formats,
    loading: formatsLoading,
    error: formatsError,
    getFormatById,
    getPopularFormats
  } = useCardFormats(apiUrl);

  const [selectedFormatId, setSelectedFormatId] = useState<string>('w26');
  const [selectedBitCount, setSelectedBitCount] = useState<number>(26);
  const selectedFormat = getFormatById ? getFormatById(selectedFormatId) : undefined;
  const bits = selectedFormat?.bits || 26;

  // v5.0: Issue level support
  const [issueLevel, setIssueLevel] = useState<number>(0);

  // Check if format requires issue level
  const hasIssueLevel = selectedFormat && (selectedFormat as any).hasIssueLevel === true;
  const maxIssueLevel = (selectedFormat as any)?.maxIssueLevel ?? 63;
  const issueLevelBits = (selectedFormat as any)?.issueLevelBits ?? 0;

  // Check if format is card-only (no facility code)
  const isCardOnly = selectedFormat && (
    (selectedFormat as any).cardOnly === true || 
    selectedFormat.facilityBits === 0
  );

  // Get parity info for current format
  const parityType = (selectedFormat as any)?.parity || 'std';
  const parityInfo = PARITY_INFO[parityType] || PARITY_INFO['std'];

  // Get format warning
  const formatWarning = (selectedFormat as any)?.warning;

  // Filter formats by category
  const filteredByCategory = React.useMemo(() => {
    if (!formats || formats.length === 0) return [];
    if (selectedCategory === 'all') return formats;
    return formats.filter((f: any) => f.category === selectedCategory);
  }, [formats, selectedCategory]);

  // Get unique bit counts from filtered formats
  const availableBitCounts = React.useMemo(() => {
    if (!filteredByCategory || filteredByCategory.length === 0) return [26, 32, 34, 37];
    const bitSet = new Set(filteredByCategory.map((f: any) => f.bits));
    return Array.from(bitSet).sort((a, b) => a - b);
  }, [filteredByCategory]);

  // Get formats filtered by selected bit count (and category)
  const formatsForSelectedBits = React.useMemo(() => {
    if (!filteredByCategory || filteredByCategory.length === 0) return [];
    return filteredByCategory.filter((f: any) => f.bits === selectedBitCount);
  }, [filteredByCategory, selectedBitCount]);

  // When category changes, update bit count and format selection
  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category);
    // Find first available bit count in this category
    const filtered = category === 'all' ? formats : formats?.filter((f: any) => f.category === category);
    if (filtered && filtered.length > 0) {
      const bitCounts = Array.from(new Set(filtered.map((f: any) => f.bits))).sort((a: any, b: any) => a - b);
      const newBitCount = bitCounts.includes(selectedBitCount) ? selectedBitCount : bitCounts[0];
      setSelectedBitCount(newBitCount as number);
      
      // Select first format in that bit count
      const formatsInBit = filtered.filter((f: any) => f.bits === newBitCount);
      if (formatsInBit.length > 0) {
        setSelectedFormatId(formatsInBit[0].id);
      }
    }
  };

  // When bit count changes, select the first format in that bit count
  const handleBitCountChange = (newBitCount: number) => {
    setSelectedBitCount(newBitCount);
    const formatsInBitCount = filteredByCategory?.filter((f: any) => f.bits === newBitCount) || [];
    if (formatsInBitCount.length > 0) {
      const popular = formatsInBitCount.find((f: any) => f.popularity === 'very-high' || f.popularity === 'high');
      setSelectedFormatId(popular?.id || formatsInBitCount[0].id);
    }
  };

  // When format changes, update bit count to match
  const handleFormatChange = (formatId: string) => {
    setSelectedFormatId(formatId);
    const format = getFormatById?.(formatId);
    if (format && format.bits !== selectedBitCount) {
      setSelectedBitCount(format.bits);
    }
    // Reset issue level when changing formats
    setIssueLevel(0);
  };

  const [facility, setFacility] = useState<number>(123);
  const [card, setCard] = useState<number>(45678);

  const [isTransmitting, setIsTransmitting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<WiegandTransmission[]>([]);
  const [transmitterAvailable, setTransmitterAvailable] = useState(false);

  // Dynamic label for facility code field
  const getFacilityLabel = (): string => {
    if (!selectedFormat) return 'Facility Code';
    if ((selectedFormat as any).facilityLabel) {
      return (selectedFormat as any).facilityLabel;
    }
    if ((selectedFormat as any).techCodeBits) {
      return 'Tech Code';
    }
    if (selectedFormat.id.includes('_t') || selectedFormat.id.includes('30')) {
      if (selectedFormat.facilityBits === 4 || selectedFormat.facilityBits === 8) {
        return 'Tech Code';
      }
    }
    return 'Facility Code';
  };

  // Clamp facility value to format limits
  const handleFacilityChange = (value: string) => {
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) {
      setFacility(0);
      return;
    }
    const maxVal = selectedFormat?.maxFacility ?? 255;
    const clamped = Math.max(0, Math.min(parsed, maxVal));
    setFacility(clamped);
  };

  // Clamp card value to format limits
  const handleCardChange = (value: string) => {
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) {
      setCard(0);
      return;
    }
    const maxVal = selectedFormat?.maxCard ?? 65535;
    const clamped = Math.max(0, Math.min(parsed, maxVal));
    setCard(clamped);
  };

  // Clamp issue level value
  const handleIssueLevelChange = (value: string) => {
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) {
      setIssueLevel(0);
      return;
    }
    const clamped = Math.max(0, Math.min(parsed, maxIssueLevel));
    setIssueLevel(clamped);
  };

  // When format changes, clamp existing values to new limits
  useEffect(() => {
    if (selectedFormat) {
      if (facility > selectedFormat.maxFacility) {
        setFacility(selectedFormat.maxFacility);
      }
      if (card > selectedFormat.maxCard) {
        setCard(selectedFormat.maxCard);
      }
      if (selectedFormat.facilityBits === 0) {
        setFacility(0);
      }
      // Reset issue level if format doesn't support it
      if (!(selectedFormat as any).hasIssueLevel) {
        setIssueLevel(0);
      }
    }
  }, [selectedFormatId, selectedFormat]);

  const styles = {
    container: {
      padding: '20px',
      maxWidth: '1400px',
      margin: '0 auto',
      backgroundColor: 'transparent',
      minHeight: '100vh',
      color: '#EDE6DB'
    } as React.CSSProperties,
    card: {
      border: '1px solid rgba(74, 63, 54, 0.6)',
      borderRadius: '8px',
      padding: '20px',
      backgroundColor: 'rgba(0, 0, 0, 0.25)',
      color: '#EDE6DB'
    } as React.CSSProperties,
    configPanel: {
      border: '1px solid rgba(74, 63, 54, 0.6)',
      borderRadius: '8px',
      padding: '20px',
      marginBottom: '20px',
      backgroundColor: 'rgba(0, 0, 0, 0.25)',
      color: '#EDE6DB'
    } as React.CSSProperties,
    readerConfig: {
      border: '2px solid rgba(74, 63, 54, 0.6)',
      borderRadius: '8px',
      padding: '15px',
      backgroundColor: 'rgba(0, 0, 0, 0.25)',
      color: '#EDE6DB'
    } as React.CSSProperties,
    input: {
      width: '100%',
      padding: '8px',
      border: '1px solid rgba(74, 63, 54, 0.6)',
      borderRadius: '4px',
      backgroundColor: 'rgba(0, 0, 0, 0.25)',
      color: '#EDE6DB',
      fontSize: '14px'
    } as React.CSSProperties,
    button: {
      padding: '8px 16px',
      border: '1px solid rgba(74, 63, 54, 0.6)',
      borderRadius: '4px',
      backgroundColor: 'rgba(42, 35, 28, 0.6)',
      color: '#fff',
      cursor: 'pointer',
      fontSize: '14px'
    } as React.CSSProperties,
    tabActive: {
      padding: '10px 20px',
      border: 'none',
      borderBottom: '3px solid #F0A73C',
      backgroundColor: 'rgba(240, 167, 60, 0.14)',
      cursor: 'pointer',
      fontWeight: 'bold',
      fontSize: '14px',
      color: '#F0A73C'
    } as React.CSSProperties,
    tabInactive: {
      padding: '10px 20px',
      border: 'none',
      borderBottom: '3px solid transparent',
      backgroundColor: 'transparent',
      cursor: 'pointer',
      fontSize: '14px',
      color: '#A79C8C'
    } as React.CSSProperties,
    presetBtn: {
      flex: 1,
      padding: '8px',
      border: '2px solid rgba(74, 63, 54, 0.6)',
      backgroundColor: 'rgba(42, 35, 28, 0.6)',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '12px',
      color: '#EDE6DB'
    } as React.CSSProperties,
    transmitBtn: {
      width: '100%',
      padding: '12px',
      backgroundColor: '#F0A73C',
      color: '#000',
      border: 'none',
      borderRadius: '4px',
      fontSize: '16px',
      fontWeight: 'bold',
      cursor: 'pointer',
      marginTop: '10px'
    } as React.CSSProperties,
    broadcastBtn: {
      width: '100%',
      padding: '12px',
      backgroundColor: '#F0A73C',
      color: '#000',
      border: 'none',
      borderRadius: '4px',
      fontSize: '16px',
      fontWeight: 'bold',
      cursor: 'pointer',
      marginTop: '10px'
    } as React.CSSProperties,
    warningBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: 'bold'
    } as React.CSSProperties
  };

  useEffect(() => {
    const saved = localStorage.getItem('wiegandReaders');
    if (saved) {
      try {
        setReaders(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load reader configs:', e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('wiegandReaders', JSON.stringify(readers));
  }, [readers]);

  useEffect(() => {
    checkTransmitterStatus();
    loadHistory();
    if (!formatsLoading && formats && formats.length) {
      if (!formats.find(f => f.id === selectedFormatId)) {
        const popular = getPopularFormats ? getPopularFormats() : [];
        const defaultFormat = popular?.[0] || formats[0];
        if (defaultFormat) {
          setSelectedFormatId(defaultFormat.id);
          setSelectedBitCount(defaultFormat.bits);
        }
      } else {
        const currentFormat = formats.find(f => f.id === selectedFormatId);
        if (currentFormat && currentFormat.bits !== selectedBitCount) {
          setSelectedBitCount(currentFormat.bits);
        }
      }
    }
  }, [formatsLoading]);

  const checkTransmitterStatus = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/wiegand/status`);
      const data = await response.json();
      setTransmitterAvailable(data.success && (data.nativeTransmitter || (data.status && data.status.initialized)));
    } catch (error) {
      console.error('Failed to check transmitter status:', error);
      setTransmitterAvailable(false);
    }
  };

  const loadHistory = async () => {
    try {
      const response = await fetch(`${apiUrl}/api/wiegand/history?limit=20`);
      const data = await response.json();
      if (data.success) {
        setHistory(data.history);
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    }
  };

  const validateSelectedFormatValues = (): { valid: boolean; message?: string } => {
    if (!selectedFormat) return { valid: true };
    if (!isCardOnly && !isValidFacilityCode(selectedFormat, facility)) {
      const label = getFacilityLabel();
      return { valid: false, message: `Invalid ${label}. Must be 0-${selectedFormat.maxFacility}` };
    }
    if (!isValidCardNumber(selectedFormat, card)) {
      return { valid: false, message: `Invalid card number. Must be 0-${selectedFormat.maxCard.toLocaleString()}` };
    }
    if (hasIssueLevel && (issueLevel < 0 || issueLevel > maxIssueLevel)) {
      return { valid: false, message: `Invalid issue level. Must be 0-${maxIssueLevel}` };
    }
    return { valid: true };
  };

  const transmitToReader = async (readerIndex: number) => {
    const reader = readers[readerIndex];
    if (!reader.enabled) {
      showStatus(`Reader ${reader.name} is disabled`, 'error');
      onLog?.(`❌ ${reader.name} is disabled`);
      return;
    }

    const validation = validateSelectedFormatValues();
    if (!validation.valid) {
      showStatus(validation.message || 'Invalid credential for selected format', 'error');
      onLog?.(`❌ Validation failed: ${validation.message}`);
      return;
    }

    setIsTransmitting(true);
    setStatus('idle');
    setMessage(`Transmitting to ${reader.name}...`);

    const fcLabel = getFacilityLabel();
    let auditMsg = `Sending ${bits}-bit ${selectedFormatId} credential`;
    if (!isCardOnly) auditMsg += ` (${fcLabel}:${facility}`;
    if (hasIssueLevel) auditMsg += `, IL:${issueLevel}`;
    auditMsg += `, Card:${card}) to ${reader.name}`;
    onAuditLog?.(auditMsg);

    try {
      const response = await fetch(`${apiUrl}/api/wiegand/transmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          d0Pin: reader.d0Pin,
          d1Pin: reader.d1Pin,
          facility: isCardOnly ? 0 : facility,
          card,
          bits,
          pulseWidth: reader.pulseWidth,
          formatId: selectedFormatId,
          issueLevel: hasIssueLevel ? issueLevel : undefined
        })
      });

      const data = await response.json();

      if (data.success) {
        setStatus('success');
        setMessage(`✓ Transmitted to ${reader.name} successfully! (${data.result?.duration || 0}ms)`);
        
        const newHistoryItem: WiegandTransmission = {
          timestamp: new Date().toISOString(),
          facility: isCardOnly ? 0 : facility,
          card,
          bits,
          d0Pin: reader.d0Pin,
          d1Pin: reader.d1Pin,
          pulseWidth: reader.pulseWidth,
          duration: data.result?.duration || 0,
          success: true,
          output: data.result?.output,
          readerName: reader.name,
          formatId: selectedFormatId,
          issueLevel: hasIssueLevel ? issueLevel : undefined
        };
        setHistory(prev => [newHistoryItem, ...prev].slice(0, 50));
        
        onLog?.(`✓ Wiegand credential transmitted to ${reader.name}`);
        onEmulationLog?.(`Wiegand ${bits}-bit ${selectedFormatId}: ${isCardOnly ? '' : `${fcLabel}=${facility}, `}${hasIssueLevel ? `IL=${issueLevel}, ` : ''}Card=${card} on ${reader.name}`);
        onAuditLog?.(`Credential transmitted successfully to ${reader.name}`);
        
        setTimeout(() => loadHistory(), 100);
        
      } else {
        setStatus('error');
        setMessage(`✗ Transmission to ${reader.name} failed: ${data.error}`);
        
        const newHistoryItem: WiegandTransmission = {
          timestamp: new Date().toISOString(),
          facility: isCardOnly ? 0 : facility,
          card,
          bits,
          d0Pin: reader.d0Pin,
          d1Pin: reader.d1Pin,
          pulseWidth: reader.pulseWidth,
          duration: 0,
          success: false,
          error: data.error,
          readerName: reader.name,
          formatId: selectedFormatId
        };
        setHistory(prev => [newHistoryItem, ...prev].slice(0, 50));
        
        onLog?.(`❌ Wiegand transmission failed: ${data.error}`);
      }
    } catch (error: any) {
      setStatus('error');
      setMessage(`✗ Error: ${error.message}`);
      
      const newHistoryItem: WiegandTransmission = {
        timestamp: new Date().toISOString(),
        facility: isCardOnly ? 0 : facility,
        card,
        bits,
        d0Pin: reader.d0Pin,
        d1Pin: reader.d1Pin,
        pulseWidth: reader.pulseWidth,
        duration: 0,
        success: false,
        error: error.message,
        readerName: reader.name,
        formatId: selectedFormatId
      };
      setHistory(prev => [newHistoryItem, ...prev].slice(0, 50));
      
      onLog?.(`❌ Wiegand error: ${error.message}`);
    } finally {
      setIsTransmitting(false);
      setTimeout(() => {
        setStatus('idle');
        setMessage('');
      }, 5000);
    }
  };

  const transmitToBoth = async () => {
    const validation = validateSelectedFormatValues();
    if (!validation.valid) {
      showStatus(validation.message || 'Invalid credential for selected format', 'error');
      onLog?.(`❌ Validation failed: ${validation.message}`);
      return;
    }

    const fcLabel = getFacilityLabel();
    let auditMsg = `Broadcasting ${bits}-bit ${selectedFormatId} credential`;
    if (!isCardOnly) auditMsg += ` (${fcLabel}:${facility}`;
    if (hasIssueLevel) auditMsg += `, IL:${issueLevel}`;
    auditMsg += `, Card:${card}) to all readers`;
    onAuditLog?.(auditMsg);
    
    setIsTransmitting(true);
    const enabledReaders = readers.filter(r => r.enabled);

    if (enabledReaders.length === 0) {
      showStatus('No readers enabled', 'error');
      setIsTransmitting(false);
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < readers.length; i++) {
      if (!readers[i].enabled) continue;

      try {
        const response = await fetch(`${apiUrl}/api/wiegand/transmit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            d0Pin: readers[i].d0Pin,
            d1Pin: readers[i].d1Pin,
            facility: isCardOnly ? 0 : facility,
            card,
            bits,
            pulseWidth: readers[i].pulseWidth,
            formatId: selectedFormatId,
            issueLevel: hasIssueLevel ? issueLevel : undefined
          })
        });

        const data = await response.json();
        if (data.success) {
          successCount++;
        } else {
          failCount++;
        }

        if (i < readers.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        failCount++;
      }
    }

    setIsTransmitting(false);

    if (failCount === 0) {
      showStatus(`✓ Transmitted to all ${successCount} readers successfully!`, 'success');
    } else if (successCount === 0) {
      showStatus(`✗ Failed to transmit to all readers`, 'error');
    } else {
      showStatus(`⚠ Partial success: ${successCount} succeeded, ${failCount} failed`, 'error');
    }

    loadHistory();
  };

  const showStatus = (msg: string, type: 'idle' | 'success' | 'error') => {
    setStatus(type);
    setMessage(msg);
    setTimeout(() => {
      setStatus('idle');
      setMessage('');
    }, 5000);
  };

  const clearHistory = async () => {
    try {
      await fetch(`${apiUrl}/api/wiegand/history`, { method: 'DELETE' });
      setHistory([]);
      setMessage('History cleared');
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  };

  const loadPreset = (preset: string) => {
    const maxFc = selectedFormat?.maxFacility ?? 255;
    const maxCard = selectedFormat?.maxCard ?? 65535;
    
    switch (preset) {
      case 'test':
        setFacility(Math.min(123, maxFc));
        setCard(Math.min(45678, maxCard));
        if (hasIssueLevel) setIssueLevel(1);
        break;
      case 'admin':
        setFacility(Math.min(255, maxFc));
        setCard(Math.min(1, maxCard));
        if (hasIssueLevel) setIssueLevel(0);
        break;
      case 'visitor':
        setFacility(0);
        setCard(Math.min(9999, maxCard));
        if (hasIssueLevel) setIssueLevel(0);
        break;
    }
  };

  const updateReader = (index: number, field: keyof ReaderConfig, value: any) => {
    const newReaders = [...readers];
    newReaders[index] = { ...newReaders[index], [field]: value };
    setReaders(newReaders);
  };

  const facilityLabel = getFacilityLabel();
  const hasFacilityCode = selectedFormat ? selectedFormat.facilityBits > 0 : true;

  return (
    <div style={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#E3D8C8', fontSize: '28px', fontWeight: 800 }}>Wiegand Transmitter v1.1.0</h2>
          <p style={{ color: '#ADA294', fontSize: '15px', margin: '6px 0 0 0' }}>Send Wiegand credentials and keypad PINs to Emulated Wiegand readers</p>
        </div>
        <button onClick={() => setShowReaderConfig(!showReaderConfig)} style={styles.button}>
          ⚙️ {showReaderConfig ? 'Hide' : 'Configure'} Readers
        </button>
      </div>

      {!transmitterAvailable && (
        <div style={{
          backgroundColor: '#2E2410',
          border: '1px solid #E6C766',
          borderRadius: '4px',
          padding: '12px',
          marginBottom: '20px',
          color: '#F0C674'
        }}>
          ⚠️ Wiegand transmitter not available. Please compile wiegand_tx first.
        </div>
      )}

      {showReaderConfig && (
        <div style={styles.configPanel}>
          <h3 style={{ marginTop: 0, color: '#E3D8C8' }}>Reader Configuration</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {readers.map((reader, index) => (
              <div key={index} style={{
                ...styles.readerConfig,
                opacity: reader.enabled ? 1 : 0.5
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <input
                    type="text"
                    value={reader.name}
                    onChange={(e) => updateReader(index, 'name', e.target.value)}
                    style={{
                      fontSize: '16px',
                      fontWeight: 'bold',
                      border: 'none',
                      backgroundColor: 'transparent',
                      width: '60%',
                      color: '#E3D8C8'
                    }}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#EDE6DB' }}>
                    <input
                      type="checkbox"
                      checked={reader.enabled}
                      onChange={(e) => updateReader(index, 'enabled', e.target.checked)}
                      style={{ marginRight: '8px' }}
                    />
                    Enabled
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                  <div>
                    <label style={{ fontSize: '12px', color: '#A79C8C', display: 'block', marginBottom: '5px' }}>D0 Pin</label>
                    <input
                      type="number"
                      value={reader.d0Pin}
                      onChange={(e) => updateReader(index, 'd0Pin', parseInt(e.target.value))}
                      min={0}
                      max={27}
                      disabled={!reader.enabled}
                      style={styles.input}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: '#A79C8C', display: 'block', marginBottom: '5px' }}>D1 Pin</label>
                    <input
                      type="number"
                      value={reader.d1Pin}
                      onChange={(e) => updateReader(index, 'd1Pin', parseInt(e.target.value))}
                      min={0}
                      max={27}
                      disabled={!reader.enabled}
                      style={styles.input}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', color: '#A79C8C', display: 'block', marginBottom: '5px' }}>Pulse (μs)</label>
                    <input
                      type="number"
                      value={reader.pulseWidth}
                      onChange={(e) => updateReader(index, 'pulseWidth', parseInt(e.target.value))}
                      min={10}
                      max={1000}
                      step={10}
                      disabled={!reader.enabled}
                      style={styles.input}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{
        display: 'flex',
        gap: '10px',
        marginBottom: '20px',
        justifyContent: 'center'
      }}>
        <button
          onClick={() => setMode('emulate')}
          style={{
            ...(mode === 'emulate' ? styles.tabActive : styles.tabInactive),
            padding: '12px 30px',
            fontSize: '16px'
          }}
        >
           Emulation
        </button>
        <button
          onClick={() => setMode('visualizer')}
          style={{
            ...(mode === 'visualizer' ? styles.tabActive : styles.tabInactive),
            padding: '12px 30px',
            fontSize: '16px'
          }}
        >
          Format Visualizer
        </button>
      </div>

      {mode === 'emulate' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div style={styles.card}>
            <h3 style={{ marginTop: 0, color: '#E3D8C8' }}>Transmit Credential</h3>

            <div style={{
              display: 'flex',
              gap: '10px',
              marginBottom: '20px',
              borderBottom: '2px solid rgba(74, 63, 54, 0.6)',
              paddingBottom: '10px'
            }}>
              {readers.map((reader, index) => (
                <button
                  key={index}
                  onClick={() => setSelectedReaderIndex(index)}
                  disabled={!reader.enabled}
                  style={selectedReaderIndex === index ? styles.tabActive : styles.tabInactive}
                >
                  {reader.name}
                  {!reader.enabled && ' (Disabled)'}
                </button>
              ))}
              <button
                onClick={() => setSelectedReaderIndex(-1)}
                style={selectedReaderIndex === -1 ? styles.tabActive : styles.tabInactive}
              >
                All Readers
              </button>
            </div>

            {/* v5.0: Format warnings and parity type display */}
            {selectedFormat && (parityType !== 'std' || formatWarning) && (
              <div style={{
                backgroundColor: '#241E10',
                border: `1px solid ${parityInfo.color}`,
                borderRadius: '4px',
                padding: '10px',
                marginBottom: '15px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{
                    ...styles.warningBadge,
                    backgroundColor: parityInfo.color + '30',
                    color: parityInfo.color,
                    border: `1px solid ${parityInfo.color}`
                  }}>
                    ⚡ {parityInfo.label} Parity
                  </span>
                  {isCardOnly && (
                    <span style={{
                      ...styles.warningBadge,
                      backgroundColor: 'rgba(74, 63, 54, 0.35)',
                      color: '#ADA294',
                      border: '1px solid #ADA294'
                    }}>
                      📇 Card-Only Format
                    </span>
                  )}
                  {hasIssueLevel && (
                    <span style={{
                      ...styles.warningBadge,
                      backgroundColor: '#5FB7B030',
                      color: '#5FB7B0',
                      border: '1px solid #5FB7B0'
                    }}>
                      🔢 Issue Level Required
                    </span>
                  )}
                  {(selectedFormat as any).requiresBigInt && (
                    <span style={{
                      ...styles.warningBadge,
                      backgroundColor: 'rgba(74, 63, 54, 0.35)',
                      color: '#ADA294',
                      border: '1px solid #ADA294'
                    }}>
                      📊 BigInt Format
                    </span>
                  )}
                </div>
                {(parityInfo.warning || formatWarning) && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#E6C766' }}>
                    ⚠️ {formatWarning || parityInfo.warning}
                  </div>
                )}
              </div>
            )}

            {/* Credential Input Fields */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#E3D8C8' }}>
                Credential
              </label>
              
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: hasIssueLevel ? '1fr 1fr 2fr' : (hasFacilityCode ? '1fr 2fr' : '1fr'),
                gap: '10px' 
              }}>
                {/* Issue Level (v5.0) */}
                {hasIssueLevel && (
                  <div>
                    <label style={{ fontSize: '12px', color: '#5FB7B0', display: 'block', marginBottom: '5px' }}>
                      Issue Level
                      <span style={{ color: '#E3D8C8', marginLeft: '5px' }}>
                        (0-{maxIssueLevel})
                      </span>
                    </label>
                    <input
                      type="number"
                      value={Number.isFinite(issueLevel) ? issueLevel : 0}
                      onChange={(e) => handleIssueLevelChange(e.target.value)}
                      min={0}
                      max={maxIssueLevel}
                      style={{
                        ...styles.input,
                        borderColor: '#5FB7B0'
                      }}
                    />
                    <div style={{ color: '#786D60', fontSize: '10px', marginTop: '3px' }}>
                      {issueLevelBits}-bit field
                    </div>
                  </div>
                )}

                {/* Facility Code */}
                {hasFacilityCode && (
                  <div>
                    <label style={{ fontSize: '12px', color: '#A79C8C', display: 'block', marginBottom: '5px' }}>
                      {facilityLabel}
                      {selectedFormat && (
                        <span style={{ color: '#E3D8C8', marginLeft: '5px' }}>
                          (0-{selectedFormat.maxFacility.toLocaleString()})
                        </span>
                      )}
                    </label>
                    <input
                      type="number"
                      value={Number.isFinite(facility) ? facility : 0}
                      onChange={(e) => handleFacilityChange(e.target.value)}
                      min={0}
                      max={selectedFormat?.maxFacility ?? 255}
                      disabled={isCardOnly}
                      style={{
                        ...styles.input,
                        borderColor: selectedFormat && !isValidFacilityCode(selectedFormat, facility)
                          ? '#C6604F'
                          : 'rgba(74, 63, 54, 0.6)',
                        opacity: isCardOnly ? 0.5 : 1
                      }}
                    />
                    {selectedFormat && !isValidFacilityCode(selectedFormat, facility) && (
                      <div style={{ color: '#E0705F', fontSize: '11px', marginTop: '3px' }}>
                        Must be 0-{selectedFormat.maxFacility.toLocaleString()}
                      </div>
                    )}
                  </div>
                )}

                {/* Card Number */}
                <div>
                  <label style={{ fontSize: '12px', color: '#A79C8C', display: 'block', marginBottom: '5px' }}>
                    Card Number
                    {selectedFormat && (
                      <span style={{ color: '#E3D8C8', marginLeft: '5px' }}>
                        (0-{selectedFormat.maxCard.toLocaleString()})
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    value={Number.isFinite(card) ? card : 0}
                    onChange={(e) => handleCardChange(e.target.value)}
                    min={0}
                    max={selectedFormat?.maxCard ?? 65535}
                    style={{
                      ...styles.input,
                      borderColor: selectedFormat && !isValidCardNumber(selectedFormat, card)
                        ? '#C6604F'
                        : 'rgba(74, 63, 54, 0.6)'
                    }}
                  />
                  {selectedFormat && !isValidCardNumber(selectedFormat, card) && (
                    <div style={{ color: '#E0705F', fontSize: '11px', marginTop: '3px' }}>
                      Must be 0-{selectedFormat.maxCard.toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Format Selection - v5.0 with Category Filter */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#E3D8C8' }}>
                Wiegand Format {formatsLoading && <span style={{ fontSize: '11px', color: '#786D60' }}>(Loading...)</span>}
              </label>
              
              {/* Category Filter (v5.0) */}
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '11px', color: '#786D60', display: 'block', marginBottom: '3px' }}>
                  Category Filter
                </label>
                <select
                  value={selectedCategory}
                  onChange={(e) => handleCategoryChange(e.target.value)}
                  disabled={formatsLoading}
                  style={{
                    ...styles.input,
                    fontSize: '12px'
                  }}
                >
                  {FORMAT_CATEGORIES.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </div>

              {/* Bit Count + Format Type */}
              <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: '#786D60', display: 'block', marginBottom: '3px' }}>
                    Bits
                  </label>
                  <select
                    value={selectedBitCount}
                    onChange={(e) => handleBitCountChange(parseInt(e.target.value))}
                    disabled={formatsLoading}
                    style={{
                      ...styles.input,
                      fontWeight: 'bold',
                      fontSize: '14px',
                      textAlign: 'center'
                    }}
                  >
                    {availableBitCounts.map((bitCount: number) => (
                      <option key={bitCount} value={bitCount}>
                        {bitCount}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: '11px', color: '#786D60', display: 'block', marginBottom: '3px' }}>
                    Format ({formatsForSelectedBits.length} available)
                  </label>
                  <select
                    value={selectedFormatId}
                    onChange={(e) => handleFormatChange(e.target.value)}
                    disabled={formatsLoading || formatsForSelectedBits.length === 0}
                    style={styles.input}
                  >
                    {formatsForSelectedBits.length === 0 ? (
                      <option>No formats for {selectedBitCount}-bit</option>
                    ) : (
                      formatsForSelectedBits.map((f: any) => (
                        <option key={f.id} value={f.id}>
                          {f.name || f.id}
                          {f.parity && f.parity !== 'std' ? ` [${PARITY_INFO[f.parity]?.label || f.parity}]` : ''}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              {/* Format Info Panel */}
              {selectedFormat && (
                <div style={{
                  marginTop: '10px',
                  padding: '10px',
                  backgroundColor: 'rgba(0, 0, 0, 0.25)',
                  border: '1px solid #E3D8C8',
                  borderRadius: '4px',
                  fontSize: '12px'
                }}>
                  <div style={{ color: '#A79C8C', marginBottom: '5px' }}>{selectedFormat.description || selectedFormat.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#E3D8C8', flexWrap: 'wrap', gap: '10px' }}>
                    {hasIssueLevel && (
                      <span style={{ color: '#5FB7B0' }}>IL: 0-{maxIssueLevel}</span>
                    )}
                    {hasFacilityCode ? (
                      <span>{facilityLabel}: 0-{selectedFormat.maxFacility.toLocaleString()}</span>
                    ) : (
                      <span style={{ color: '#786D60' }}>No {facilityLabel}</span>
                    )}
                    <span>Card: 0-{selectedFormat.maxCard.toLocaleString()}</span>
                  </div>
                  <div style={{ marginTop: '5px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    {(selectedFormat as any).manufacturer && (
                      <span style={{ color: '#786D60', fontSize: '11px' }}>
                        🏭 {(selectedFormat as any).manufacturer}
                      </span>
                    )}
                    {(selectedFormat as any).category && (
                      <span style={{ color: '#786D60', fontSize: '11px' }}>
                        📁 {(selectedFormat as any).category}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#E3D8C8' }}>
                Quick Presets
              </label>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => loadPreset('test')} style={styles.presetBtn}>
                  Test (123:45678)
                </button>
                <button onClick={() => loadPreset('admin')} style={styles.presetBtn}>
                  Admin (255:1)
                </button>
                <button onClick={() => loadPreset('visitor')} style={styles.presetBtn}>
                  Visitor (0:9999)
                </button>
              </div>
            </div>

            {selectedReaderIndex >= 0 ? (
              <button
                onClick={() => transmitToReader(selectedReaderIndex)}
                disabled={isTransmitting || !transmitterAvailable || !readers[selectedReaderIndex].enabled}
                style={{
                  ...styles.transmitBtn,
                  opacity: isTransmitting || !transmitterAvailable ? 0.5 : 1,
                  cursor: isTransmitting || !transmitterAvailable ? 'not-allowed' : 'pointer'
                }}
              >
                {isTransmitting ? '⏳ Transmitting...' : ` Transmit to ${readers[selectedReaderIndex].name}`}
              </button>
            ) : (
              <button
                onClick={transmitToBoth}
                disabled={isTransmitting || !transmitterAvailable}
                style={{
                  ...styles.broadcastBtn,
                  opacity: isTransmitting || !transmitterAvailable ? 0.5 : 1,
                  cursor: isTransmitting || !transmitterAvailable ? 'not-allowed' : 'pointer'
                }}
              >
                {isTransmitting ? '⏳ Broadcasting...' : ' Transmit to All Readers'}
              </button>
            )}

            {message && (
              <div style={{
                marginTop: '15px',
                padding: '10px',
                borderRadius: '4px',
                backgroundColor: status === 'success' ? '#1E3A24' :
                  status === 'error' ? '#3A1E1A' : 'rgba(58, 48, 38, 0.55)',
                border: `1px solid ${status === 'success' ? '#6FBF7E' :
                  status === 'error' ? '#C6604F' : '#E3D8C8'}`,
                color: status === 'success' ? '#6FBF7E' :
                  status === 'error' ? '#E0705F' : '#E3D8C8'
              }}>
                {message}
              </div>
            )}
            {/* Transmission History (inside left card) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px', marginBottom: '15px' }}>
              <h3 style={{ margin: 0, color: '#E3D8C8' }}>Transmission History</h3>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={loadHistory} style={styles.button}> Refresh</button>
                <button onClick={clearHistory} style={styles.button}>🗑️ Clear</button>
              </div>
            </div>
            <div style={{
              maxHeight: '350px',
              overflowY: 'auto',
              border: '1px solid rgba(74, 63, 54, 0.6)',
              borderRadius: '4px',
              backgroundColor: 'rgba(0, 0, 0, 0.25)'
            }}>
              {history.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#786D60' }}>
                  No transmissions yet
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid rgba(74, 63, 54, 0.6)', color: '#E3D8C8' }}>Time</th>
                      <th style={{ padding: '8px', textAlign: 'left', borderBottom: '2px solid rgba(74, 63, 54, 0.6)', color: '#E3D8C8' }}>Credential</th>
                      <th style={{ padding: '8px', textAlign: 'center', borderBottom: '2px solid rgba(74, 63, 54, 0.6)', color: '#E3D8C8' }}>Status</th>
                      <th style={{ padding: '8px', textAlign: 'right', borderBottom: '2px solid rgba(74, 63, 54, 0.6)', color: '#E3D8C8' }}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item, index) => (
                      <tr key={index} style={{ borderBottom: '1px solid rgba(74, 63, 54, 0.6)' }}>
                        <td style={{ padding: '8px', color: '#EDE6DB' }}>
                          {new Date(item.timestamp).toLocaleTimeString()}
                        </td>
                        <td style={{ padding: '8px' }}>
                          <div style={{ fontWeight: 'bold', color: '#E3D8C8' }}>
                            {item.issueLevel !== undefined && ('IL:' + item.issueLevel + ' ')}
                            {item.facility > 0 && ('Fac:' + item.facility + ' ')}
                            Card:{item.card}
                          </div>
                          <div style={{ color: '#786D60', fontSize: '11px' }}>
                            {item.formatId || (item.bits + '-bit')} • {item.readerName || ('D0:' + item.d0Pin + ' D1:' + item.d1Pin)}
                          </div>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          <span style={{
                            padding: '2px 8px',
                            borderRadius: '12px',
                            backgroundColor: item.success ? '#1E3A24' : '#3A1E1A',
                            color: item.success ? '#6FBF7E' : '#E0705F',
                            fontSize: '11px'
                          }}>
                            {item.success ? '✓ Success' : '✗ Failed'}
                          </span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right', color: '#A79C8C' }}>
                          {item.duration}ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Interactive Wiegand Reader */}
          <div style={styles.card}>
            <h3 style={{ marginTop: 0, color: '#E3D8C8' }}>Interactive Wiegand Reader</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '15px' }}>
              <label style={{ fontSize: '11px', color: '#786D60', whiteSpace: 'nowrap' }}>
                Keypad format:
              </label>
              <select
                value={keypadFormat}
                onChange={e => setKeypadFormat(e.target.value)}
                style={{ ...styles.input, fontSize: '11px', padding: '4px 8px', flex: 1 }}
              >
                <option value="4bit">4-bit Packed</option>
                <option value="8bit">8-bit ASCII</option>
                <option value="8bit-wiegand">8-bit Wiegand (Farpointe)</option>
                <option value="26bit">26-bit (Single Packet)</option>
              </select>
            </div>
            {selectedReaderIndex >= 0 && readers[selectedReaderIndex] ? (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <InteractiveWiegandReader
                  reader={{
                    name: readers[selectedReaderIndex].name,
                    d0Pin: readers[selectedReaderIndex].d0Pin,
                    d1Pin: readers[selectedReaderIndex].d1Pin,
                    pulseWidth: readers[selectedReaderIndex].pulseWidth,
                  }}
                  backendUrl={apiUrl}
                  keypadFormat={keypadFormat}
                  facilityCode={isCardOnly ? 0 : facility}
                  pocketCard={{
                    facilityCode: isCardOnly ? 0 : facility,
                    cardNumber: card,
                    format: bits,
                  }}
                />
              </div>
            ) : (
              <div style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: '#786D60',
                backgroundColor: 'rgba(0, 0, 0, 0.25)',
                borderRadius: '4px',
                border: '1px dashed rgba(74, 63, 54, 0.6)',
              }}>
               Interactive Reader is Only Available Per Reader<br />
		Please Select Individual Reader Please!
              </div>
            )}
          </div>
        </div>
      )}

      {mode === 'visualizer' && (
        <div style={{ ...styles.card, marginTop: '20px' }}>
          <WiegandFormatVisualizer />
        </div>
      )}

    </div>
  );
};

export default WiegandSection;

