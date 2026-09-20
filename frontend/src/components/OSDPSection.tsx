import React, { useEffect, useState, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { useCardFormats, isValidFacilityCode, isValidCardNumber } from '../hooks/useCardFormats';
import InteractiveReader from './InteractiveReader';
import OsdpTraceTool from './OsdpTraceTool';
import CredentialQuickPills from './CredentialQuickPills';
import OSDPFirmwareWizard from './OSDPFirmwareWizard';
import OSDPBusManager from './OSDPBusManager';
import CollapsibleSection from './CollapsibleSection';
import OSDPSnifferTool from './OSDPSnifferTool';

type OSDPReader = {
  id: string;
  name: string;
  address: number;
  enabled: boolean;
  status: string;
  capabilities: string[];
  secureChannel: boolean;
  secureChannelEstablished?: boolean;
  serialPort?: string;
  baudRate?: number;
  scbkConfigured?: boolean;
};

type DetectedInterface = {
  id: string;
  name: string;
  port: string;
  type: 'usb' | 'onboard' | 'spi';
  online: boolean;
  baudRate: number;
  readerRange?: string;
};

type TransferItem = {
  id: string;
  type: 'card' | 'keypad' | 'config' | 'credentials' | 'firmware';
  name: string;
  data: any;
  timestamp: number;
  fileSize?: number;
};

type SnifferFrame = {
  ts: string;
  address: number;
  isReply: boolean;
  sequence: number;
  cmd: string;
  cmdName: string;
  length: number;
  dataHex: string;
  fullHex: string;
  decoded: any;
};

type SnifferPort = {
  path: string;
  manufacturer: string | null;
  serialNumber: string | null;
  reserved: boolean;
};

type OSDPSectionProps = {
  ipAddress: string;
  connected: boolean;
  onLog: (message: string) => void;
};

// v5.0 Category definitions - same as WiegandSection
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

const styles = {
  container: {
    padding: '20px',
    maxWidth: '1800px',
    margin: '0 auto',
    backgroundColor: 'transparent',
    minHeight: '100vh',
    color: '#EDE6DB'
  } as React.CSSProperties,
  card: {
    border: '1px solid rgba(74, 63, 54, 0.6)',
    borderRadius: '8px',
    padding: '20px',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    color: '#EDE6DB',
    marginBottom: '20px'
  } as React.CSSProperties,
  configPanel: {
    border: '1px solid rgba(74, 63, 54, 0.6)',
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '20px',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    color: '#EDE6DB'
  } as React.CSSProperties,
  input: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid rgba(74, 63, 54, 0.6)',
    borderRadius: '6px',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    color: '#EDE6DB',
    fontSize: '14px'
  } as React.CSSProperties,
  select: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid rgba(74, 63, 54, 0.6)',
    borderRadius: '6px',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    color: '#EDE6DB',
    fontSize: '14px',
    cursor: 'pointer'
  } as React.CSSProperties,
  button: {
    padding: '10px 20px',
    border: '1px solid rgba(74, 63, 54, 0.6)',
    borderRadius: '6px',
    backgroundColor: 'rgba(42, 35, 28, 0.6)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500
  } as React.CSSProperties,
  primaryButton: {
    padding: '12px 24px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#F0A73C',
    color: '#000',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: 'bold'
  } as React.CSSProperties,
  dangerButton: {
    padding: '10px 20px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#C6604F',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500
  } as React.CSSProperties,
  successButton: {
    padding: '10px 20px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#4F8B5C',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500
  } as React.CSSProperties,
  warningButton: {
    padding: '10px 20px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#E6C766',
    color: '#000',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500
  } as React.CSSProperties,
  tabActive: {
    padding: '12px 24px',
    border: 'none',
    borderBottom: '3px solid #F0A73C',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '14px',
    color: '#ffffff'
  } as React.CSSProperties,
  tabInactive: {
    padding: '12px 24px',
    border: 'none',
    borderBottom: '3px solid transparent',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    fontSize: '14px',
    color: '#A79C8C'
  } as React.CSSProperties,
  badge: {
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 'bold'
  } as React.CSSProperties,
  tableHeader: {
    padding: '12px',
    textAlign: 'left' as const,
    borderBottom: '2px solid rgba(74, 63, 54, 0.6)',
    color: '#ffffff',
    fontSize: '12px',
    fontWeight: 'bold'
  },
  tableCell: {
    padding: '12px',
    borderBottom: '1px solid rgba(74, 63, 54, 0.6)',
    color: '#EDE6DB',
    fontSize: '13px'
  },
  warningBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 'bold'
  } as React.CSSProperties,
  // ===== New styles for the consolidated layout =====
  emulateSubpanel: {
    border: '1px solid rgba(74, 63, 54, 0.6)',
    borderRadius: '8px',
    padding: '16px',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    color: '#EDE6DB',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    minHeight: '100%',
  } as React.CSSProperties,
  subpanelHeader: {
    margin: 0,
    color: '#ffffff',
    fontSize: '15px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingBottom: '8px',
    borderBottom: '1px solid rgba(74, 63, 54, 0.6)',
  } as React.CSSProperties,
};

export default function OSDPSection({ ipAddress, connected, onLog }: OSDPSectionProps) {
  const [readers, setReaders] = useState<OSDPReader[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  
  const [interfaces, setInterfaces] = useState<DetectedInterface[]>([]);
  const [detecting, setDetecting] = useState(false);
  
  const [history, setHistory] = useState<{time: string; message: string}[]>([]);

  // ===== Sniffer state =====
  const [snifferPorts, setSnifferPorts] = useState<SnifferPort[]>([]);
  const [snifferPort, setSnifferPort] = useState<string>('');
  const [snifferBaud, setSnifferBaud] = useState<number>(9600);
  const [snifferAddr, setSnifferAddr] = useState<number>(0);
  const [snifferPollMs, setSnifferPollMs] = useState<number>(100);
  const [snifferActive, setSnifferActive] = useState<boolean>(false);
  const [snifferFrames, setSnifferFrames] = useState<SnifferFrame[]>([]);
  const [wireFrames, setWireFrames] = useState<SnifferFrame[]>([]);
  const [snifferHideAcks, setSnifferHideAcks] = useState<boolean>(true);
  const [snifferError, setSnifferError] = useState<string | null>(null);

  // ============================================================
  // CONSOLIDATED 6→3 TABS (was: card/keypad/led/transfer/config/history)
  // ============================================================
  const [mode, setMode] = useState<'emulate' | 'maintain' | 'history' | 'sniff'>('emulate');

  // Socket.IO connection — used by InteractiveReader to mirror osdp_LED / osdp_BUZ
  const [socket, setSocket] = useState<Socket | null>(null);

  // v5.0: Use shared format hook
  const apiUrl = `http://${ipAddress}:3001`;
  const {
    formats,
    loading: formatsLoading,
    getFormatById,
    getPopularFormats
  } = useCardFormats(apiUrl);

  // v5.0: Category filter state
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedBitCount, setSelectedBitCount] = useState<number>(26);
  const [selectedFormatId, setSelectedFormatId] = useState<string>('w26');
  
  const selectedFormat = getFormatById ? getFormatById(selectedFormatId) : undefined;
  const bits = selectedFormat?.bits || 26;

  // v5.0: Issue level support
  const [issueLevel, setIssueLevel] = useState<number>(0);
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
  const formatWarning = (selectedFormat as any)?.warning;

  // Filter formats by category
  const filteredByCategory = useMemo(() => {
    if (!formats || formats.length === 0) return [];
    if (selectedCategory === 'all') return formats;
    return formats.filter((f: any) => f.category === selectedCategory);
  }, [formats, selectedCategory]);

  // Get unique bit counts from filtered formats
  const availableBitCounts = useMemo(() => {
    if (!filteredByCategory || filteredByCategory.length === 0) return [26, 32, 34, 37];
    const bitSet = new Set(filteredByCategory.map((f: any) => f.bits));
    return Array.from(bitSet).sort((a, b) => a - b);
  }, [filteredByCategory]);

  // Get formats filtered by selected bit count (and category)
  const formatsForSelectedBits = useMemo(() => {
    if (!filteredByCategory || filteredByCategory.length === 0) return [];
    return filteredByCategory.filter((f: any) => f.bits === selectedBitCount);
  }, [filteredByCategory, selectedBitCount]);

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category);
    const filtered = category === 'all' ? formats : formats?.filter((f: any) => f.category === category);
    if (filtered && filtered.length > 0) {
      const bitCounts = Array.from(new Set(filtered.map((f: any) => f.bits))).sort((a: any, b: any) => a - b);
      const newBitCount = bitCounts.includes(selectedBitCount) ? selectedBitCount : bitCounts[0];
      setSelectedBitCount(newBitCount as number);
      
      const formatsInBit = filtered.filter((f: any) => f.bits === newBitCount);
      if (formatsInBit.length > 0) {
        setSelectedFormatId(formatsInBit[0].id);
      }
    }
  };

  const handleBitCountChange = (newBitCount: number) => {
    setSelectedBitCount(newBitCount);
    const formatsInBitCount = filteredByCategory?.filter((f: any) => f.bits === newBitCount) || [];
    if (formatsInBitCount.length > 0) {
      const popular = formatsInBitCount.find((f: any) => f.popularity === 'very-high' || f.popularity === 'high');
      setSelectedFormatId(popular?.id || formatsInBitCount[0].id);
    }
  };

  const handleFormatChange = (formatId: string) => {
    setSelectedFormatId(formatId);
    const format = getFormatById?.(formatId);
    if (format && format.bits !== selectedBitCount) {
      setSelectedBitCount(format.bits);
    }
    setIssueLevel(0);
  };

  // SHARED reader picker — used by Card composer, Keypad sender, AND visual reader mirror
  const [selectedReaderId, setSelectedReaderId] = useState<string>('');
  const [facility, setFacility] = useState<number>(123);
  const [cardNumber, setCardNumber] = useState<number>(45678);
  const [sending, setSending] = useState<string | null>(null);

  // LED manual override (drives the Manual LED block under the visual reader)
  const [ledColor, setLedColor] = useState<string>('green');
  const [ledState, setLedState] = useState<string>('on');
  const [ledDuration, setLedDuration] = useState<string>('1000');

  const [keypadData, setKeypadData] = useState<string>('');
  const [keypadFormat, setKeypadFormat] = useState<string>('8bit');

  // SCBK panel uses its own picker (it's a sensitive maintenance op — keep separate)
  const [keyReader, setKeyReader] = useState<string>('');
  const [customKey, setCustomKey] = useState<string>('');
  const [settingKey, setSettingKey] = useState(false);

  const [selectedPort, setSelectedPort] = useState<string>('');
  const [newBaudRate, setNewBaudRate] = useState<number>(9600);
  const [changingBaud, setChangingBaud] = useState(false);

  // ===== Editable Quick PINs (4 slots, localStorage-backed) =====
  const [quickPins, setQuickPins] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('aether-quick-pins-v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 4) return parsed.map(String);
      }
    } catch {}
    return ['1234', '1111', '', ''];
  });
  const [editingQuickPins, setEditingQuickPins] = useState(false);
  useEffect(() => {
    try { localStorage.setItem('aether-quick-pins-v1', JSON.stringify(quickPins)); } catch {}
  }, [quickPins]);


  // ===== Add Reader form state =====
  const [addReaderForm, setAddReaderForm] = useState({
    name: '',
    address: 0,
    serialPort: '',
    secureChannel: false,
    capabilities: ['LED', 'BUZZER', 'CARD', 'KEYPAD'] as string[],
  });
  const [addingReader, setAddingReader] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const submitAddReader = async () => {
    if (!addReaderForm.name.trim() || !addReaderForm.serialPort) {
      addHistory('✗ Name and serial port are required');
      return;
    }
    setAddingReader(true);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/reader`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addReaderForm),
      });
      const data = await r.json();
      if (data.success) {
        addHistory(`✓ Added reader ${data.reader.name} (addr 0x${data.reader.address.toString(16).padStart(2,'0')})`);
        setAddReaderForm({ name: '', address: 0, serialPort: '', secureChannel: false, capabilities: ['LED','BUZZER','CARD','KEYPAD'] });
        setShowAddForm(false);
        await fetchReaders();
      } else addHistory(`✗ ${data.error}`);
    } catch (e: any) { addHistory(`✗ ${e.message}`); }
    setAddingReader(false);
  };

  const deleteReader = async (readerId: string, readerName: string) => {
    if (!window.confirm(`Delete reader "${readerName}"? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${apiUrl}/api/osdp/reader/${readerId}`, { method: 'DELETE' });
      const data = await r.json();
      if (data.success) { addHistory(`✓ Deleted ${readerName}`); await fetchReaders(); }
      else addHistory(`✗ ${data.error}`);
    } catch (e: any) { addHistory(`✗ ${e.message}`); }
  };


  // Transfer tool state
  const [sourceReader, setSourceReader] = useState<string>('');
  const [targetReader, setTargetReader] = useState<string>('');
  const [transferType, setTransferType] = useState<'card' | 'keypad' | 'config' | 'credentials'>('card');
  const [transferQueue, setTransferQueue] = useState<TransferItem[]>([]);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferStatus, setTransferStatus] = useState<{ success: number; failed: number }>({ success: 0, failed: 0 });
  const [firmwareFile, setFirmwareFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);

  const getFacilityLabel = (): string => {
    if (!selectedFormat) return 'Facility Code';
    if ((selectedFormat as any).facilityLabel) {
      return (selectedFormat as any).facilityLabel;
    }
    if ((selectedFormat as any).techCodeBits) {
      return 'Tech Code';
    }
    return 'Facility Code';
  };

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

  const handleCardChange = (value: string) => {
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) {
      setCardNumber(0);
      return;
    }
    const maxVal = selectedFormat?.maxCard ?? 65535;
    const clamped = Math.max(0, Math.min(parsed, maxVal));
    setCardNumber(clamped);
  };

  const handleIssueLevelChange = (value: string) => {
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) {
      setIssueLevel(0);
      return;
    }
    const clamped = Math.max(0, Math.min(parsed, maxIssueLevel));
    setIssueLevel(clamped);
  };

  useEffect(() => {
    if (selectedFormat) {
      if (facility > selectedFormat.maxFacility) {
        setFacility(selectedFormat.maxFacility);
      }
      if (cardNumber > selectedFormat.maxCard) {
        setCardNumber(selectedFormat.maxCard);
      }
      if (selectedFormat.facilityBits === 0) {
        setFacility(0);
      }
      if (!(selectedFormat as any).hasIssueLevel) {
        setIssueLevel(0);
      }
    }
  }, [selectedFormatId, selectedFormat]);

  useEffect(() => {
    if (connected) {
      fetchReaders();
      fetchStatus();
      fetchStats();
      fetchInterfaces();
      refreshSnifferPorts();
      const interval = setInterval(() => { fetchReaders(); fetchStats(); }, 3000);
      return () => clearInterval(interval);
    } else {
      setReaders([]);
      setStatus(null);
      setInterfaces([]);
    }
  }, [connected, ipAddress]);

  // Socket.IO lifecycle
  useEffect(() => {
    if (!connected) {
      setSocket(null);
      return;
    }
    const s = io(apiUrl, { transports: ['websocket', 'polling'] });
    s.on('connect', () => onLog?.(`✓ Socket.IO connected (${apiUrl})`));
    s.on('disconnect', () => onLog?.(`○ Socket.IO disconnected`));
    s.on('osdp-wire-frame', (f: any) => {
      setWireFrames(prev => [{ ...f }, ...prev].slice(0, 500));
    });
    s.on('osdp-sniffer-frame', (f: SnifferFrame) => {
      setSnifferFrames(prev => [f, ...prev].slice(0, 500));
    });
    s.on('osdp-sniffer-status', (st: any) => setSnifferActive(!!st?.active));
    s.on('osdp-sniffer-error', (e: any) => setSnifferError(e?.message || 'sniffer error'));
    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, apiUrl]);

  useEffect(() => {
    if (readers.length > 0 && !selectedReaderId) {
      const first = readers.find(r => r.enabled);
      if (first) {
        setSelectedReaderId(first.id);
        setKeyReader(first.id);
      }
    }
    if (readers.length >= 2 && !sourceReader && !targetReader) {
      setSourceReader(readers[0].id);
      setTargetReader(readers[1].id);
    }
  }, [readers, selectedReaderId]);

  useEffect(() => {
    if (!formatsLoading && formats && formats.length > 0) {
      if (!formats.find(f => f.id === selectedFormatId)) {
        const popular = getPopularFormats ? getPopularFormats() : [];
        const defaultFormat = popular?.[0] || formats[0];
        if (defaultFormat) {
          setSelectedFormatId(defaultFormat.id);
          setSelectedBitCount(defaultFormat.bits);
        }
      }
    }
  }, [formatsLoading, formats]);

  const addHistory = (msg: string) => {
    setHistory(prev => [{ time: new Date().toLocaleTimeString(), message: msg }, ...prev].slice(0, 100));
    onLog(msg);
  };

  const fetchInterfaces = async () => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/interfaces`);
      const data = await r.json();
      if (data.success) {
        setInterfaces(data.interfaces || []);
        if (data.interfaces?.length > 0 && !selectedPort) {
          setSelectedPort(data.interfaces[0].port);
          setNewBaudRate(data.interfaces[0].baudRate || 9600);
        }
      }
    } catch (e) {}
  };

  const detectInterfaces = async () => {
    setDetecting(true);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/detect`);
      const data = await r.json();
      if (data.success) {
        setInterfaces(data.interfaces || []);
        addHistory(`✓ Detected ${data.count} interface(s)`);
        await fetchReaders();
      }
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
    setDetecting(false);
  };

  const changeBaudRate = async () => {
    if (!selectedPort) return;
    setChangingBaud(true);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/baudrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPort, baudRate: newBaudRate })
      });
      const data = await r.json();
      if (data.success) {
        addHistory(`✓ Set ${selectedPort} to ${newBaudRate} baud`);
        await fetchInterfaces();
      } else {
        addHistory(`✗ ${data.error}`);
      }
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
    setChangingBaud(false);
  };

  const fetchReaders = async () => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/readers`);
      const data = await r.json();
      if (data.success) setReaders(data.readers || []);
    } catch (e) {}
  };

  const fetchStatus = async () => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/status`);
      const data = await r.json();
      if (data.success) setStatus(data.status);
    } catch (e) {}
  };

  const fetchStats = async () => {
    try {
      const r = await fetch(`${apiUrl}/api/osdp/stats`);
      const data = await r.json();
      if (data.success) setStats(data.stats);
    } catch (e) {}
  };

  const validateSelectedFormatValues = (): { valid: boolean; message?: string } => {
    if (!selectedFormat) return { valid: true };
    if (!isCardOnly && !isValidFacilityCode(selectedFormat, facility)) {
      const label = getFacilityLabel();
      return { valid: false, message: `Invalid ${label}. Must be 0-${selectedFormat.maxFacility}` };
    }
    if (!isValidCardNumber(selectedFormat, cardNumber)) {
      return { valid: false, message: `Invalid card number. Must be 0-${selectedFormat.maxCard.toLocaleString()}` };
    }
    if (hasIssueLevel && (issueLevel < 0 || issueLevel > maxIssueLevel)) {
      return { valid: false, message: `Invalid issue level. Must be 0-${maxIssueLevel}` };
    }
    return { valid: true };
  };

  const sendCard = async (readerId: string) => {
    const validation = validateSelectedFormatValues();
    if (!validation.valid) {
      addHistory(`✗ ${validation.message}`);
      return;
    }

    setSending(readerId);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/card-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          readerId, 
          facility: isCardOnly ? 0 : facility, 
          card: cardNumber, 
          format: selectedFormatId,
          bits: bits,
          issueLevel: hasIssueLevel ? issueLevel : undefined
        })
      });
      const data = await r.json();
      if (data.success) {
        const fcLabel = getFacilityLabel();
        let msg = `✓ Card sent: ${bits}-bit ${selectedFormatId}`;
        if (!isCardOnly) msg += ` ${fcLabel}=${facility}`;
        if (hasIssueLevel) msg += ` IL=${issueLevel}`;
        msg += ` Card=${cardNumber}`;
        addHistory(msg);
      } else {
        addHistory(`✗ ${data.error}`);
      }
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
    setSending(null);
  };

  const toggleReaderEnabled = async (id: string, current: boolean) => {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/reader/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !current })
      });
      const data = await r.json();
      if (data.success) {
        addHistory(`✓ Reader ${!current ? 'enabled' : 'disabled'}`);
        await fetchReaders();
      } else {
        addHistory(`✗ ${data.error}`);
      }
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
    setLoading(false);
  };

  const toggleSecureChannel = async (id: string, current: boolean) => {
    setLoading(true);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/reader/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secureChannel: !current })
      });
      const data = await r.json();
      if (data.success) {
        addHistory(`✓ Secure channel ${!current ? 'enabled' : 'disabled'}`);
        await fetchReaders();
      } else {
        addHistory(`✗ ${data.error}`);
      }
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
    setLoading(false);
  };

  const controlLED = async () => {
    if (!selectedReaderId) return;
    try {
      await fetch(`${apiUrl}/api/osdp/led`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readerId: selectedReaderId, color: ledColor, state: ledState, duration: parseInt(ledDuration) })
      });
      addHistory(`✓ LED ${ledColor} ${ledState}`);
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
  };

  const buzzer = async (id: string) => {
    try {
      await fetch(`${apiUrl}/api/osdp/buzzer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readerId: id, duration: 200 })
      });
      addHistory(`✓ Buzzer activated`);
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
  };

  const sendKeypad = async () => {
    if (!selectedReaderId || !keypadData) return;
    try {
      const r = await fetch(`${apiUrl}/api/osdp/keypad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readerId: selectedReaderId, data: keypadData, format: keypadFormat })
      });
      const data = await r.json();
      if (data.success) {
        addHistory(`✓ Keypad: ${keypadData}`);
        setKeypadData('');
      } else addHistory(`✗ ${data.error}`);
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
  };

  // Quick PIN shortcuts bypass the bezel keypad and fire the API directly,
  // since the InteractiveReader owns its own internal PIN buffer.
  const quickSendPin = async (pin: string) => {
    if (!selectedReaderId) return;
    try {
      const r = await fetch(`${apiUrl}/api/osdp/keypad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readerId: selectedReaderId, data: pin, format: keypadFormat })
      });
      const data = await r.json();
      if (data.success) addHistory(`✓ Quick PIN: ${pin}`);
      else addHistory(`✗ ${data.error}`);
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
  };

  const setCustomSCBK = async () => {
    if (!keyReader) return;
    const hex = customKey.replace(/[^0-9A-Fa-f]/g, '');
    if (hex.length !== 32) { addHistory('✗ Key must be 32 hex chars'); return; }
    setSettingKey(true);
    try {
      const reader = readers.find(r => r.id === keyReader);
      const r = await fetch(`${apiUrl}/api/osdp/security/keyset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: reader?.address, key: hex })
      });
      const data = await r.json();
      if (data.success) { addHistory(`✓ SCBK set`); setCustomKey(''); }
      else addHistory(`✗ ${data.error}`);
    } catch (e: any) {
      addHistory(`✗ ${e.message}`);
    }
    setSettingKey(false);
  };

  const generateRandomKey = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    setCustomKey(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  };

  const generateRandomCard = () => {
    const maxFc = selectedFormat?.maxFacility ?? 255;
    const maxCard = selectedFormat?.maxCard ?? 65535;
    setFacility(Math.floor(Math.random() * Math.min(256, maxFc + 1)));
    setCardNumber(Math.floor(Math.random() * Math.min(65536, maxCard + 1)));
  };

  const loadPreset = (preset: string) => {
    const maxFc = selectedFormat?.maxFacility ?? 255;
    const maxCard = selectedFormat?.maxCard ?? 65535;
    
    switch (preset) {
      case 'test':
        setFacility(Math.min(123, maxFc));
        setCardNumber(Math.min(45678, maxCard));
        if (hasIssueLevel) setIssueLevel(1);
        break;
      case 'admin':
        setFacility(Math.min(255, maxFc));
        setCardNumber(Math.min(1, maxCard));
        if (hasIssueLevel) setIssueLevel(0);
        break;
      case 'visitor':
        setFacility(0);
        setCardNumber(Math.min(9999, maxCard));
        if (hasIssueLevel) setIssueLevel(0);
        break;
    }
  };

  const captureFromSource = async () => {
    if (!sourceReader) return;
    try {
      const res = await fetch(`${apiUrl}/api/osdp/capture/${sourceReader}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: transferType })
      });
      const data = await res.json();
      if (data.success) {
        const newItem: TransferItem = {
          id: `${Date.now()}-${Math.random()}`,
          type: transferType,
          name: `${transferType} from ${readers.find(r => r.id === sourceReader)?.name}`,
          data: data.capturedData,
          timestamp: Date.now()
        };
        setTransferQueue(prev => [...prev, newItem]);
        addHistory(`✓ Captured ${transferType} from source`);
      } else {
        addHistory(`✗ Capture failed: ${data.error}`);
      }
    } catch (err: any) {
      addHistory(`✗ Capture error: ${err.message}`);
    }
  };

  const transferToTarget = async (item: TransferItem) => {
    if (!targetReader) return;
    setIsTransferring(true);
    try {
      const res = await fetch(`${apiUrl}/api/osdp/transfer/${targetReader}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: item.type, data: item.data })
      });
      const data = await res.json();
      if (data.success) {
        setTransferStatus(prev => ({ ...prev, success: prev.success + 1 }));
        setTransferQueue(prev => prev.filter(i => i.id !== item.id));
        addHistory(`✓ Transferred ${item.type} to target`);
      } else {
        setTransferStatus(prev => ({ ...prev, failed: prev.failed + 1 }));
        addHistory(`✗ Transfer failed: ${data.error}`);
      }
    } catch (err: any) {
      setTransferStatus(prev => ({ ...prev, failed: prev.failed + 1 }));
      addHistory(`✗ Transfer error: ${err.message}`);
    }
    setIsTransferring(false);
  };

  const handleFirmwareUpload = async () => {
    if (!firmwareFile || !targetReader) return;
    setIsUploading(true);
    setUploadProgress(0);
    
    const formData = new FormData();
    formData.append('firmware', firmwareFile);
    formData.append('readerId', targetReader);

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        if (response.success) {
          addHistory(`✓ Firmware uploaded successfully`);
          setFirmwareFile(null);
        } else {
          addHistory(`✗ Upload failed: ${response.error}`);
        }
      }
      setIsUploading(false);
      setUploadProgress(0);
    });
    xhr.addEventListener('error', () => {
      addHistory(`✗ Upload error`);
      setIsUploading(false);
    });
    xhr.open('POST', `${apiUrl}/api/osdp/firmware-upload`);
    xhr.send(formData);
  };

  const swapReaders = () => {
    const temp = sourceReader;
    setSourceReader(targetReader);
    setTargetReader(temp);
  };

  // ===== Sniffer helpers =====
  const refreshSnifferPorts = async () => {
    setSnifferError(null);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/sniffer/ports`);
      const j = await r.json();
      const ports: SnifferPort[] = j.ports || [];
      setSnifferPorts(ports);
      if (!snifferPort) {
        const firstFree = ports.find(p => !p.reserved);
        if (firstFree) setSnifferPort(firstFree.path);
      }
    } catch (e: any) { setSnifferError(e.message); }
  };

  const startSniffer = async () => {
    setSnifferError(null);
    try {
      const r = await fetch(`${apiUrl}/api/osdp/sniffer/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: snifferPort, baud: snifferBaud, address: snifferAddr, pollMs: snifferPollMs })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'start failed');
      setSnifferFrames([]);
      addHistory(`✓ Sniffer started on ${snifferPort} @ ${snifferBaud}`);
    } catch (e: any) {
      setSnifferError(e.message);
      addHistory(`✗ Sniffer start failed: ${e.message}`);
    }
  };

  const stopSniffer = async () => {
    try {
      await fetch(`${apiUrl}/api/osdp/sniffer/stop`, { method: 'POST' });
      addHistory(`○ Sniffer stopped`);
    } catch (e: any) { setSnifferError(e.message); }
  };

  // Group readers by port
  const ioplusReaders = readers.filter(r => r.serialPort?.includes('ttyAMA') || (!r.serialPort && parseInt(r.id.replace(/\D/g, '')) <= 4));
  const usbReaders = readers.filter(r => r.serialPort?.includes('ttyACM') || r.serialPort?.includes('ttyUSB') || (!r.serialPort && parseInt(r.id.replace(/\D/g, '')) > 4));

  const selectedReader = readers.find(r => r.id === selectedReaderId);
  const facilityLabel = getFacilityLabel();
  const hasFacilityCode = selectedFormat ? selectedFormat.facilityBits > 0 : true;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#ffffff', fontSize: '28px', fontWeight: 800 }}> OSDP Reader Emulator v1.1.0</h2>
          <p style={{ margin: '5px 0 0 0', color: '#786D60' }}>
            {status?.initialized ? `${readers.filter(r => r.enabled).length}/${readers.length} readers active` : '⚠ Not initialized'}
            {stats && ` • ${stats.messagesSent || 0} messages`}
            {!formatsLoading && formats && ` • ${formats.length} formats loaded`}
            {socket?.connected && <span style={{ color: '#6FBF7E' }}> • ● Live</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={fetchReaders} style={styles.button}> Refresh</button>
          <button onClick={detectInterfaces} disabled={detecting} style={styles.button}>
            {detecting ? '⏳ Scanning...' : ' Scan Interfaces'}
          </button>
        </div>
      </div>

      {/* Connection Warning */}
      {!connected && (
        <div style={{
          backgroundColor: '#2E2410',
          border: '1px solid #E6C766',
          borderRadius: '8px',
          padding: '15px',
          marginBottom: '20px',
          color: '#F0C674'
        }}>
          ⚠️ Not connected to OSDP backend. Please check connection to {ipAddress}:3001
        </div>
      )}

      {/* ====== Tabs (consolidated 6→3) ====== */}
      <div style={{
        display: 'flex',
        gap: '5px',
        marginBottom: '20px',
        flexWrap: 'wrap',
        borderBottom: '2px solid rgba(74, 63, 54, 0.6)',
        paddingBottom: '0'
      }}>
        {[
          { id: 'emulate',  label: 'Emulate' },
          { id: 'maintain', label: 'Maintain' },
          { id: 'history',  label: 'History' }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id as any)}
            style={mode === tab.id ? styles.tabActive : styles.tabInactive}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* ============================================================
          EMULATE TAB — Card composer + Keypad + Visual Reader,
          all sharing one reader picker.
          ============================================================ */}
      {mode === 'emulate' && (
        <div>
          {/* Shared reader picker bar */}
          <div style={{ ...styles.configPanel, marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
              <label style={{ color: '#ffffff', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                 Target reader:
              </label>
              <select
                value={selectedReaderId}
                onChange={e => setSelectedReaderId(e.target.value)}
                style={{ ...styles.select, maxWidth: '320px' }}
              >
                <optgroup label=" IOplus RS485 (1-4)">
                  {ioplusReaders.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name} (0x{r.address.toString(16).padStart(2, '0')}){!r.enabled ? ' - OFF' : ''}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="USB Modules">
                  {usbReaders.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.name} (0x{r.address.toString(16).padStart(2, '0')}){!r.enabled ? ' - OFF' : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
              {selectedReader && (
                <>
                  <span style={{
                    ...styles.badge,
                    backgroundColor: selectedReader.enabled ? '#1E3A24' : '#3A1E1A',
                    color: selectedReader.enabled ? '#6FBF7E' : '#E0705F'
                  }}>
                    {selectedReader.enabled ? '● ACTIVE' : '○ OFF'}
                  </span>
                  {selectedReader.secureChannel && (
                    <span style={{
                      ...styles.badge,
                      backgroundColor: selectedReader.secureChannelEstablished ? '#1E3A24' : '#3A3418',
                      color: selectedReader.secureChannelEstablished ? '#6FBF7E' : '#E6C766'
                    }}>
                      🔒 {selectedReader.secureChannelEstablished ? 'SCS' : 'SC'}
                    </span>
                  )}
                  <span style={{ fontSize: '12px', color: '#786D60', fontFamily: 'monospace' }}>
                    {selectedReader.serialPort || '/dev/ttyACM0'}
                  </span>
                </>
              )}
              <span style={{
                ...styles.badge,
                marginLeft: 'auto',
                backgroundColor: socket?.connected ? '#1E3A24' : '#2E2410',
                color: socket?.connected ? '#6FBF7E' : '#E6C766'
              }}>
                {socket?.connected ? '● Live socket' : '○ Socket offline'}
              </span>
            </div>
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#786D60' }}>
              All three panels below target this reader. Card composer & keypad <em>send</em> data to the ACS;
              visual mirror <em>reflects</em> commands the ACS sends back.
            </div>
          </div>

          {/* 2-column emulation grid (Card composer + Reader-with-keypad) */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 460px',
            gap: '16px',
            alignItems: 'stretch'
          }}>

            {/* ===== Column 1: Card Composer ===== */}
            <div style={styles.emulateSubpanel}>
              <h3 style={styles.subpanelHeader}>Card Composer</h3>

              {/* Format warnings & parity type */}
              {selectedFormat && (parityType !== 'std' || formatWarning) && (
                <div style={{
                  backgroundColor: '#241E10',
                  border: `1px solid ${parityInfo.color}`,
                  borderRadius: '4px',
                  padding: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span style={{
                      ...styles.warningBadge,
                      backgroundColor: parityInfo.color + '30',
                      color: parityInfo.color,
                      border: `1px solid ${parityInfo.color}`
                    }}>
                      ⚡ {parityInfo.label}
                    </span>
                    {isCardOnly && (
                      <span style={{
                        ...styles.warningBadge,
                        backgroundColor: '#5FB7B030',
                        color: '#5FB7B0',
                        border: '1px solid #5FB7B0'
                      }}>
                        📇 Card-Only
                      </span>
                    )}
                    {hasIssueLevel && (
                      <span style={{
                        ...styles.warningBadge,
                        backgroundColor: '#5FB7B030',
                        color: '#5FB7B0',
                        border: '1px solid #5FB7B0'
                      }}>
                        🔢 Issue Level
                      </span>
                    )}
                  </div>
                  {(parityInfo.warning || formatWarning) && (
                    <div style={{ marginTop: '6px', fontSize: '11px', color: '#E6C766' }}>
                      ⚠️ {formatWarning || parityInfo.warning}
                    </div>
                  )}
                </div>
              )}

              {/* Format Selection */}
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold', color: '#ffffff', fontSize: '13px' }}>
                  Wiegand Format {formatsLoading && <span style={{ fontSize: '11px', color: '#786D60' }}>(Loading...)</span>}
                </label>

                <div style={{ marginBottom: '8px' }}>
                  <label style={{ fontSize: '11px', color: '#786D60', display: 'block', marginBottom: '3px' }}>Category</label>
                  <select
                    value={selectedCategory}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    disabled={formatsLoading}
                    style={{ ...styles.select, fontSize: '12px' }}
                  >
                    {FORMAT_CATEGORIES.map(cat => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))}
                  </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '8px' }}>
                  <div>
                    <label style={{ fontSize: '11px', color: '#786D60', display: 'block', marginBottom: '3px' }}>Bits</label>
                    <select
                      value={selectedBitCount}
                      onChange={(e) => handleBitCountChange(parseInt(e.target.value))}
                      disabled={formatsLoading}
                      style={{ ...styles.select, fontWeight: 'bold', fontSize: '13px', textAlign: 'center' }}
                    >
                      {availableBitCounts.map((bitCount: number) => (
                        <option key={bitCount} value={bitCount}>{bitCount}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: '11px', color: '#786D60', display: 'block', marginBottom: '3px' }}>
                      Format ({formatsForSelectedBits.length})
                    </label>
                    <select
                      value={selectedFormatId}
                      onChange={(e) => handleFormatChange(e.target.value)}
                      disabled={formatsLoading || formatsForSelectedBits.length === 0}
                      style={{ ...styles.select, fontSize: '12px' }}
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

                {selectedFormat && (
                  <div style={{
                    marginTop: '8px',
                    padding: '8px',
                    backgroundColor: 'rgba(0, 0, 0, 0.25)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '4px',
                    fontSize: '11px'
                  }}>
                    <div style={{ color: '#A79C8C', marginBottom: '4px' }}>{selectedFormat.description || selectedFormat.name}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ffffff', flexWrap: 'wrap', gap: '6px' }}>
                      {hasIssueLevel && <span style={{ color: '#5FB7B0' }}>IL: 0-{maxIssueLevel}</span>}
                      {hasFacilityCode ? (
                        <span>{facilityLabel}: 0-{selectedFormat.maxFacility.toLocaleString()}</span>
                      ) : (
                        <span style={{ color: '#786D60' }}>No {facilityLabel}</span>
                      )}
                      <span>Card: 0-{selectedFormat.maxCard.toLocaleString()}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Credential fields */}
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold', color: '#ffffff', fontSize: '13px' }}>
                  Credential
                </label>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: hasIssueLevel ? '1fr 1fr 1fr' : (hasFacilityCode ? '1fr 1fr' : '1fr'),
                  gap: '8px'
                }}>
                  {hasIssueLevel && (
                    <div>
                      <label style={{ fontSize: '11px', color: '#5FB7B0', display: 'block', marginBottom: '3px' }}>
                        IL <span style={{ color: '#ffffff' }}>(0-{maxIssueLevel})</span>
                      </label>
                      <input
                        type="number"
                        value={Number.isFinite(issueLevel) ? issueLevel : 0}
                        onChange={(e) => handleIssueLevelChange(e.target.value)}
                        min={0}
                        max={maxIssueLevel}
                        style={{ ...styles.input, borderColor: '#5FB7B0', fontSize: '13px' }}
                      />
                    </div>
                  )}

                  {hasFacilityCode && (
                    <div>
                      <label style={{ fontSize: '11px', color: '#A79C8C', display: 'block', marginBottom: '3px' }}>
                        {facilityLabel}
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
                          fontSize: '13px',
                          borderColor: selectedFormat && !isValidFacilityCode(selectedFormat, facility) ? '#C6604F' : 'rgba(74, 63, 54, 0.6)',
                          opacity: isCardOnly ? 0.5 : 1
                        }}
                      />
                    </div>
                  )}

                  <div>
                    <label style={{ fontSize: '11px', color: '#A79C8C', display: 'block', marginBottom: '3px' }}>
                      Card #
                    </label>
                    <input
                      type="number"
                      value={Number.isFinite(cardNumber) ? cardNumber : 0}
                      onChange={(e) => handleCardChange(e.target.value)}
                      min={0}
                      max={selectedFormat?.maxCard ?? 65535}
                      style={{
                        ...styles.input,
                        fontSize: '13px',
                        borderColor: selectedFormat && !isValidCardNumber(selectedFormat, cardNumber) ? '#C6604F' : 'rgba(74, 63, 54, 0.6)'
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Quick Actions */}
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={generateRandomCard} style={{ ...styles.button, flex: 1, fontSize: '12px', padding: '8px' }}>🎲 Random</button>
                <button onClick={() => loadPreset('test')} style={{ ...styles.button, flex: 1, fontSize: '12px', padding: '8px' }}> Test</button>
                <button onClick={() => loadPreset('admin')} style={{ ...styles.button, flex: 1, fontSize: '12px', padding: '8px' }}> Admin</button>
              </div>

              {/* Send button */}
              {/* credential-quick-pills */}
              <CredentialQuickPills
                current={{
                  formatId: selectedFormatId,
                  bits: selectedBitCount,
                  facility,
                  cardNumber,
                  issueLevel,
                }}
                hasIssueLevel={hasIssueLevel}
                onLoad={(cred) => {
                  if (cred.formatId !== undefined) setSelectedFormatId(cred.formatId);
                  if (cred.bits !== undefined) setSelectedBitCount(cred.bits);
                  if (cred.facility !== undefined) setFacility(cred.facility);
                  if (cred.cardNumber !== undefined) setCardNumber(cred.cardNumber);
                  if (cred.issueLevel !== undefined) setIssueLevel(cred.issueLevel);
                }}
                onLog={addHistory}
              />
              <button
                onClick={() => sendCard(selectedReaderId)}
                disabled={!selectedReaderId || !!sending || !selectedReader?.enabled}
                style={{
                  ...styles.primaryButton,
                  width: '100%',
                  fontSize: '14px',
                  marginTop: 'auto',
                  opacity: (!selectedReaderId || !!sending || !selectedReader?.enabled) ? 0.5 : 1,
                  cursor: (!selectedReaderId || !!sending || !selectedReader?.enabled) ? 'not-allowed' : 'pointer'
                }}
              >
                {sending ? '⏳ Sending...' : ` Send Card`}
              </button>
              {/* recent-activity-below-send */}
              <div style={{ background: 'rgba(0, 0, 0, 0.4)', border: '1px solid rgba(74, 63, 54, 0.55)', borderRadius: 4, padding: '10px 12px', marginTop: '8px', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#786D60' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#6FBF7E', display: 'inline-block' }}></span>
                    Recent activity
                  </div>
                  <button onClick={() => setMode('history')} style={{ background: 'none', border: 'none', color: '#ffffff', cursor: 'pointer', fontSize: '10px' }}>
                    View full history →
                  </button>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.6, flex: 1, minHeight: 0, maxHeight: 280, overflowY: 'auto' /* SCROLL_v3 */ }}>
                  {history.length === 0 ? (
                    <div style={{ color: '#5E5449' }}>No activity yet.</div>
                  ) : (
                    history.slice(0, 25).map((e, i) => (
                      <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span style={{ color: '#5E5449' }}>{e.time}</span>{' '}
                        <span style={{ color: e.message.startsWith('✓') ? '#6FBF7E' : e.message.startsWith('✗') ? '#E0705F' : '#EDE6DB' }}>
                          {e.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* ===== Column 2: Visual Reader (card + keypad) + Manual Override ===== */}
            <div style={styles.emulateSubpanel}>
              <h3 style={styles.subpanelHeader}>Interactive Reader</h3>

              {/* Tiny keypad format selector — applies to PIN entry inside the bezel below */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: '#786D60', whiteSpace: 'nowrap' }}>
                  Keypad format:
                </label>
                <select
                  value={keypadFormat}
                  onChange={e => setKeypadFormat(e.target.value)}
                  style={{ ...styles.select, fontSize: '11px', padding: '4px 8px', flex: 1 }}
                >
                  <option value="4bit">4-bit Packed</option>
                  <option value="8bit">8-bit ASCII</option>
                </select>
              </div>

              {selectedReader ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <InteractiveReader
                    reader={{
                      id: selectedReader.id,
                      name: selectedReader.name,
                      address: selectedReader.address,
                    }}
                    socket={socket || undefined}
                    backendUrl={apiUrl}
                    mode="both"
                    enableAudio
                    /* Wire the bezel's card-tap zone to the composer's existing
                       sendCard() so it picks up bits/issueLevel/parity etc. */
                    pocketCard={{
                      format:       selectedFormatId,
                      facilityCode: facility,
                      cardNumber:   cardNumber,
                    }}
                    onCardTap={() => sendCard(selectedReaderId)}
                    keypadFormat={keypadFormat as any}
                    autoSendOnHash
                  />
                </div>
              ) : (
                <div style={{ padding: '30px', textAlign: 'center', color: '#5E5449', fontSize: '12px' }}>
                  Pick a reader above.
                </div>
              )}

              {/* Manual override block (LED + Buzzer + Quick PINs) */}
              <div style={{
                borderTop: '1px solid rgba(74, 63, 54, 0.6)',
                paddingTop: '12px',
                marginTop: 'auto'
              }}>
                <div style={{ fontSize: '11px', color: '#786D60', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Manual Override
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                  <select value={ledColor} onChange={e => setLedColor(e.target.value)} style={styles.select}>
                  <option value="off">⚫ Off (0x00)</option>
                  <option value="red">🔴 Red (0x01)</option>
                  <option value="green">🟢 Green (0x02)</option>
                  <option value="amber">🟠 Amber (0x03)</option>
                  <option value="blue">🔵 Blue (0x04)</option>
                  <option value="magenta">🟣 Magenta (0x05)</option>
                  <option value="cyan">🩵 Cyan (0x06)</option>
                  <option value="white">⚪ White (0x07)</option>
                </select>
                  <select value={ledState} onChange={e => setLedState(e.target.value)} style={{ ...styles.select, fontSize: '12px', padding: '6px 8px' }}>
                    <option value="on">ON</option>
                    <option value="off">OFF</option>
                  </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                  <input
                    type="number"
                    value={ledDuration}
                    onChange={e => setLedDuration(e.target.value)}
                    style={{ ...styles.input, fontSize: '12px', padding: '6px 8px' }}
                    min={0}
                    step={100}
                    placeholder="ms"
                  />
                  <button onClick={controlLED} disabled={!selectedReaderId} style={{ ...styles.warningButton, padding: '6px', fontSize: '12px' }}>
                    Set LED
                  </button>
                </div>

                <button
                  onClick={() => selectedReaderId && buzzer(selectedReaderId)}
                  disabled={!selectedReaderId}
                  style={{
                    width: '100%',
                    padding: '8px',
                    backgroundColor: 'rgba(0, 0, 0, 0.25)',
                    border: '1px solid rgba(74, 63, 54, 0.6)',
                    borderRadius: '6px',
                    color: '#ffffff',
                    cursor: 'pointer',
                    fontSize: '12px',
                    marginBottom: '10px'
                  }}
                >
                   Trigger Buzzer
                </button>

                                {/* Quick PINs — editable; persisted to localStorage */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#786D60' }}>Quick PINs</span>
                  <button onClick={() => setEditingQuickPins(!editingQuickPins)}
                    style={{ background: 'none', border: 'none', color: '#ADA294', cursor: 'pointer', fontSize: 10 }}>
                    {editingQuickPins ? '✓ done' : '✏ edit'}
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' }}>
                  {quickPins.map((pin, i) => editingQuickPins ? (
                    <input
                      key={i}
                      value={pin}
                      onChange={e => {
                        const cleaned = e.target.value.replace(/[^0-9]/g, '').slice(0, 12);
                        setQuickPins(prev => prev.map((p, idx) => idx === i ? cleaned : p));
                      }}
                      placeholder={'PIN ' + (i+1)}
                      style={{
                        padding: '6px',
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid rgba(74, 63, 54, 0.6)',
                        borderRadius: '4px',
                        color: '#E3D8C8',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        textAlign: 'center',
                        width: '100%',
                        boxSizing: 'border-box',
                      }}
                    />
                  ) : (
                    <button
                      key={i}
                      onClick={() => pin && quickSendPin(pin)}
                      disabled={!selectedReaderId || !pin}
                      style={{
                        padding: '6px',
                        backgroundColor: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid rgba(74, 63, 54, 0.6)',
                        borderRadius: '4px',
                        color: pin ? '#E3D8C8' : '#4A3F36',
                        cursor: (selectedReaderId && pin) ? 'pointer' : 'not-allowed',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        opacity: (selectedReaderId && pin) ? 1 : 0.5
                      }}
                    >
                      {pin || '(empty)'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

          </div>

          {/* Live OSDP traffic trace (collapsible) — full history lives in History tab */}
          <OsdpTraceTool
            frames={wireFrames}
            onClear={() => setWireFrames([])}
            selectedReaderAddress={selectedReader?.address}
          />
        </div>
      )}

      {/* ============================================================
          MAINTAIN TAB — Transfer Tool + Config combined.
          ============================================================ */}
      {mode === 'maintain' && (
        <div>
          {/* Firmware Upload — replaced by wizard */}
          <CollapsibleSection
            storageKey="osdp-firmware-collapsed"
            title="Firmware Upload"
            subtitle="Push firmware to readers"
            borderClass="border-[#D98A3D]/30"
            titleColorClass="text-[#E6A24C]"
            bgClass="bg-[#D98A3D]/5"
          >
            <OSDPFirmwareWizard readers={readers} />
          </CollapsibleSection>

          {/* Bus & Reader manager */}
          <CollapsibleSection
            storageKey="osdp-busmgr-collapsed"
            title="Bus & Reader Manager"
            subtitle="RS485 buses and reader configuration"
            borderClass="border-[#4A3F36]/50"
            titleColorClass="text-[#E3D8C8]"
            bgClass="bg-[#241E19]/30"
          >
            <OSDPBusManager apiUrl={apiUrl} onLog={addHistory} />
          </CollapsibleSection>


          {/* OSDP Sniffer */}
          <CollapsibleSection
            storageKey="osdp-sniffer-collapsed"
            title="OSDP Sniffer"
            subtitle="Live frame capture with anomaly detection"
            borderClass="border-[#5FB7B0]/40"
            titleColorClass="text-[#8FD3CD]"
            bgClass="bg-[#5FB7B0]/5"
          >
            <OSDPSnifferTool apiUrl={apiUrl} onLog={addHistory} />
          </CollapsibleSection>
        </div>
      )}
      {/* History Tab — unchanged */}
      {mode === 'history' && (
        <div style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ margin: 0, color: '#ffffff' }}> Activity History</h3>
            <button onClick={() => setHistory([])} style={styles.dangerButton}>Clear All</button>
          </div>

          <div style={{
            maxHeight: '600px',
            overflowY: 'auto',
            border: '1px solid rgba(74, 63, 54, 0.6)',
            borderRadius: '8px',
            backgroundColor: 'rgba(0, 0, 0, 0.25)'
          }}>
            {history.length === 0 ? (
              <div style={{ padding: '60px', textAlign: 'center', color: '#5E5449' }}>
                No activity recorded yet
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, backgroundColor: 'rgba(0, 0, 0, 0.35)' }}>
                  <tr>
                    <th style={{ ...styles.tableHeader, width: '100px' }}>Time</th>
                    <th style={styles.tableHeader}>Event</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((e, i) => (
                    <tr key={i}>
                      <td style={{ ...styles.tableCell, fontFamily: 'monospace', color: '#786D60' }}>{e.time}</td>
                      <td style={{
                        ...styles.tableCell,
                        color: e.message.startsWith('✓') ? '#6FBF7E' : e.message.startsWith('✗') ? '#E0705F' : '#EDE6DB'
                      }}>
                        {e.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

