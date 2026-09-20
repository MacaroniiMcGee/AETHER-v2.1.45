// ControllerEmulatorSection.tsx
// New tab: emulates downstream OSDP devices (Azure Access I16S / O8S / IO168S) on an RS-485 bus.
// The Pi pretends to be 1-32 downstream boards so an upstream controller (IC2) can poll them.
//
// Design parity with the rest of the app:
//   - Sage / slate transparent palette
//   - Compact grid of address slots, click for detail
//   - Live trace panel at the bottom
//   - Single Start/Stop bus control at the top

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io as ioClient, Socket } from 'socket.io-client';
import {
  Cpu, Power, PowerOff, Plus, Trash2, RefreshCw, Zap, ZapOff, ChevronRight,
  Radio, Activity, AlertCircle, CheckCircle, X, Eye, EyeOff,
  Save, Download, Upload, FolderOpen,
  CreditCard, KeyRound, Send, Shuffle,
} from 'lucide-react';
import { useCardFormats, isValidFacilityCode, isValidCardNumber } from '../hooks/useCardFormats';
import CredentialQuickPills from './CredentialQuickPills';

// ── Types ──────────────────────────────────────────────────────────────
type DeviceModel = 'I16S' | 'O8S' | 'IO168S' | 'RI2MS' | 'RI4S';

interface ReaderPortState {
  ledColor: string;          // 'off' | 'red' | 'green' | 'amber' | ...
  buzzerOn: boolean;
  text: string;
}

interface DeviceSnap {
  address: number;
  model: DeviceModel;
  online: boolean;
  pollCount: number;
  lastPollAt: number;
  lastCommand: number | null;
  numInputs: number;
  numOutputs: number;
  inputs: number[] | null;
  outputs: number[] | null;
  readerState?: ReaderPortState[];     // present for RI2MS / RI4S
  tamperActive?: boolean;              // NEW — surfaced via LSTATR
  powerFailActive?: boolean;           // NEW — surfaced via LSTATR
}

interface FrameEntry {
  ts: number;
  direction: 'in' | 'out';
  addr: number;
  cmd?: number;
  seq?: number;
  hex: string;
  ok?: boolean;
  error?: string;
  handled?: boolean;
}

interface SerialPortInfo { path: string; manufacturer: string | null; serialNumber: string | null; }

interface SavedConfigMeta {
  name: string;
  deviceCount: number;
  savedAt: string | null;
}

interface ControllerEmulatorSectionProps {
  ipAddress: string;
  connected: boolean;
  logSystem: (type: string, message: string) => void;
}

// ── Constants ──────────────────────────────────────────────────────────
const MODELS: DeviceModel[] = ['I16S', 'O8S', 'IO168S', 'RI2MS', 'RI4S'];

// ─── Collapsible section wrapper — used for every major section in the device detail panel.
//     State persists in localStorage so user preferences stick across reloads.
interface CollapsibleSectionProps {
  storageKey: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}
const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  storageKey, title, icon, headerRight, defaultOpen = true, children, className = '', bodyClassName = '',
}) => {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem(`emu-section:${storageKey}`) : null;
      return stored === null ? defaultOpen : stored === 'true';
    } catch { return defaultOpen; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(`emu-section:${storageKey}`, String(open)); } catch {}
  }, [open, storageKey]);
  return (
    <div className={`mb-4 rounded border border-[#38302A]/50 bg-black/25 overflow-hidden ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-[#38302A]/20 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-sm font-semibold text-[#C4B9AB]">{title}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {headerRight}
          <ChevronRight className={`w-4 h-4 text-[#ADA294] transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>
      {open && <div className={`px-3 pb-3 pt-1 ${bodyClassName}`}>{children}</div>}
    </div>
  );
};


// Card-format categories — mirrored from OSDPSection for consistent UX
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
  { id: 'generic', name: 'Generic/Testing' },
];
const BAUDS = [9600, 19200, 38400, 57600, 115200];
const MAX_FRAMES = 200;
const SLOT_COUNT = 32;  // addresses 0-31

// Per-model accent (sage family with subtle distinctions, no purple)
// `image` is served from frontend/public/images/devices/<MODEL>.png — drop the
// three PNGs (RI2MS / RI4S / IO168S) into that folder. I16S and O8S reuse the
// IO168S image since they are physical subsets of the same board family.
const MODEL_STYLE: Record<DeviceModel, { tint: string; label: string; image: string }> = {
  'I16S':   { tint: '#6FC7C0', label: '16 In',     image: '/images/devices/IO168S.png' },
  'O8S':    { tint: '#5FB7B0', label: '8 Out',     image: '/images/devices/IO168S.png' },
  'IO168S': { tint: '#4E9E98', label: '16In/8Out', image: '/images/devices/IO168S.png' },
  'RI2MS':  { tint: '#8FD3CD', label: '2-Port Rdr', image: '/images/devices/RI2MS.png' },
  'RI4S':   { tint: '#9BE0DA', label: '4-Port Rdr', image: '/images/devices/RI4S.png' },
};

// OSDP command code → human label (for trace)
const CMD_NAMES: Record<number, string> = {
  0x60: 'POLL', 0x61: 'ID', 0x62: 'CAP', 0x64: 'LSTAT', 0x65: 'ISTAT', 0x66: 'OSTAT',
  0x67: 'RSTAT', 0x68: 'OUT', 0x69: 'LED', 0x6A: 'BUZ', 0x6B: 'TEXT', 0x6E: 'COMSET',
  0x40: 'ACK', 0x41: 'NAK', 0x45: 'PDID', 0x46: 'PDCAP', 0x48: 'LSTATR', 0x49: 'ISTATR',
  0x4A: 'OSTATR', 0x54: 'COM',
};

// ── Component ──────────────────────────────────────────────────────────
const ControllerEmulatorSection: React.FC<ControllerEmulatorSectionProps> = ({ ipAddress, connected, logSystem }) => {
  // Bus state
  const [running, setRunning]   = useState(false);
  const [port, setPort]         = useState<string>('');
  const [baud, setBaud]         = useState<number>(9600);
  const [ports, setPorts]       = useState<SerialPortInfo[]>([]);
  const [framesIn, setFramesIn] = useState(0);
  const [framesOut, setFramesOut] = useState(0);

  // Devices
  const [devices, setDevices]   = useState<DeviceSnap[]>([]);
  const [selectedAddr, setSelectedAddr] = useState<number | null>(null);

  // Trace
  const [frames, setFrames]     = useState<FrameEntry[]>([]);
  const [showTrace, setShowTrace] = useState(true);

  // Add-device modal
  const [showAddModal, setShowAddModal] = useState<{ open: boolean; address: number }>({ open: false, address: 0 });
  const [addModel, setAddModel] = useState<DeviceModel>('IO168S');

  // Config save/load/import/export
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigMeta[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<string>('');
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Port-conflict confirmation modal (shown when chosen port is held by OSDPManager)
  const [conflictModal, setConflictModal] = useState<{
    open: boolean;
    portPath: string;
    readers: { id: string; name: string; address: number; enabled: boolean }[];
  }>({ open: false, portPath: '', readers: [] });

  const socketRef = useRef<Socket | null>(null);
  const apiBase = `http://${ipAddress}:3001`;

  // Forces a re-render once per second so time-based indicators (poll-age dots, etc.)
  // update smoothly even when there's no new data from the socket.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Card Composer state — mirrors OSDPSection so credential UX is consistent ──
  const { formats, loading: formatsLoading, getFormatById, getPopularFormats } = useCardFormats(apiBase);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedBitCount, setSelectedBitCount] = useState<number>(26);
  const [selectedFormatId, setSelectedFormatId] = useState<string>('w26');
  const [facility, setFacility] = useState<number>(123);
  const [cardNumber, setCardNumber] = useState<number>(45678);
  const [issueLevel, setIssueLevel] = useState<number>(0);
  const [targetReaderPort, setTargetReaderPort] = useState<number>(0);
  const [pinValue, setPinValue] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);

  // ── Initial fetch + socket wiring ────────────────────────────────────
  const refreshPorts = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/emulator/ports`);
      const j = await r.json();
      if (j.success) setPorts(j.ports);
    } catch (e) { /* silent */ }
  }, [apiBase]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/emulator/status`);
      const j = await r.json();
      if (j.success && j.status) {
        setRunning(j.status.running);
        setPort(curr => curr || j.status.port || '');
        setBaud(j.status.baud || 9600);
        setDevices(j.status.devices || []);
        setFramesIn(j.status.framesIn || 0);
        setFramesOut(j.status.framesOut || 0);
      }
    } catch (e) { /* silent */ }
  }, [apiBase]);

  useEffect(() => {
    refreshPorts();
    refreshStatus();

    const sock = ioClient(apiBase || undefined, { transports: ['websocket', 'polling'] });
    socketRef.current = sock;

    sock.on('emulator-started',       refreshStatus);
    sock.on('emulator-stopped',       () => { setRunning(false); setDevices([]); });
    sock.on('emulator-device-added',  (dev: DeviceSnap) => {
      setDevices(prev => [...prev.filter(d => d.address !== dev.address), dev].sort((a,b)=>a.address-b.address));
    });
    sock.on('emulator-device-removed', ({ address }: { address: number }) => {
      setDevices(prev => prev.filter(d => d.address !== address));
    });
    sock.on('emulator-device-update', (dev: DeviceSnap) => {
      setDevices(prev => prev.map(d => d.address === dev.address ? dev : d));
    });
    // Reader-state events (RI2MS / RI4S only) — patch the targeted reader port
    sock.on('reader-state', ({ address, readerNum, state }: { address: number; readerNum: number; state: ReaderPortState }) => {
      setDevices(prev => prev.map(d => {
        if (d.address !== address || !d.readerState) return d;
        const newReaderState = d.readerState.map((r, i) => i === readerNum ? state : r);
        return { ...d, readerState: newReaderState };
      }));
    });
    sock.on('emulator-frame', (f: Omit<FrameEntry, 'ts'>) => {
      setFrames(prev => {
        const next = [{ ...f, ts: Date.now() }, ...prev];
        return next.slice(0, MAX_FRAMES);
      });
      if (f.direction === 'in') setFramesIn(n => n + 1);
      else setFramesOut(n => n + 1);
    });
    sock.on('emulator-config-applied', () => { refreshStatus(); });
    sock.on('emulator-error', ({ error }: { error: string }) => {
      logSystem('error', `[Emulator] ${error}`);
    });

    return () => { sock.disconnect(); socketRef.current = null; };
  }, [apiBase, refreshPorts, refreshStatus, logSystem]);

  // ── Bus lifecycle ────────────────────────────────────────────────────
  const startBus = async (force = false) => {
    if (!port) { logSystem('error', 'No serial port selected'); return; }
    try {
      const r = await fetch(`${apiBase}/api/emulator/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Intentionally omit `devices` — backend keeps whatever was added via the UI.
        body: JSON.stringify({ port, baud, force }),
      });
      if (r.status === 409) {
        // Port is held by OSDPManager — show confirmation modal listing affected readers.
        const conflict = await r.json();
        setConflictModal({
          open: true,
          portPath: conflict.portPath || port,
          readers: conflict.readers || [],
        });
        return;
      }
      const j = await r.json();
      if (j.success) {
        setRunning(true);
        logSystem('success', `Emulator started on ${port} @ ${baud}${force ? ' (port released from reader emulation)' : ''}`);
      } else {
        logSystem('error', `Start failed: ${j.error}`);
      }
    } catch (e: any) {
      logSystem('error', `Start failed: ${e.message}`);
    }
  };

  const confirmConflictAndStart = () => {
    setConflictModal({ open: false, portPath: '', readers: [] });
    startBus(true);   // retry with force=true
  };

  const stopBus = async () => {
    try {
      await fetch(`${apiBase}/api/emulator/stop`, { method: 'POST' });
      setRunning(false);
      logSystem('info', 'Emulator stopped');
    } catch (e: any) { logSystem('error', e.message); }
  };

  // ── Device CRUD ──────────────────────────────────────────────────────
  const addDevice = async (address: number, model: DeviceModel) => {
    try {
      const r = await fetch(`${apiBase}/api/emulator/device`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, model }),
      });
      const j = await r.json();
      if (!j.success) logSystem('error', `Add failed: ${j.error}`);
      else logSystem('info', `Added ${model} at address ${address}`);
    } catch (e: any) { logSystem('error', e.message); }
  };

  const removeDevice = async (address: number) => {
    if (!confirm(`Remove device at address ${address}?`)) return;
    try {
      await fetch(`${apiBase}/api/emulator/device/${address}`, { method: 'DELETE' });
      if (selectedAddr === address) setSelectedAddr(null);
    } catch (e: any) { logSystem('error', e.message); }
  };

  const toggleInput = async (address: number, idx: number, currentValue: number) => {
    try {
      await fetch(`${apiBase}/api/emulator/device/${address}/input/${idx}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentValue }),
      });
    } catch (e: any) { logSystem('error', e.message); }
  };

  // ── Card Composer derived state ────────────────────────────────────────
  const selectedFormat = getFormatById ? getFormatById(selectedFormatId) : undefined;
  const isCardOnly = selectedFormat && ((selectedFormat as any).cardOnly === true || selectedFormat.facilityBits === 0);
  const hasIssueLevel = selectedFormat && (selectedFormat as any).hasIssueLevel === true;
  const maxIssueLevel = (selectedFormat as any)?.maxIssueLevel ?? 63;
  const hasFacilityCode = selectedFormat ? selectedFormat.facilityBits > 0 : true;

  const filteredByCategory = useMemo(() => {
    if (!formats || formats.length === 0) return [] as any[];
    if (selectedCategory === 'all') return formats as any[];
    return (formats as any[]).filter(f => f.category === selectedCategory);
  }, [formats, selectedCategory]);

  const availableBitCounts = useMemo(() => {
    if (!filteredByCategory || filteredByCategory.length === 0) return [26, 32, 34, 37];
    const s = new Set(filteredByCategory.map((f: any) => f.bits));
    return Array.from(s).sort((a, b) => (a as number) - (b as number));
  }, [filteredByCategory]);

  const formatsForSelectedBits = useMemo(() => {
    if (!filteredByCategory || filteredByCategory.length === 0) return [] as any[];
    return filteredByCategory.filter((f: any) => f.bits === selectedBitCount);
  }, [filteredByCategory, selectedBitCount]);

  const handleCategoryChange = (cat: string) => {
    setSelectedCategory(cat);
    const filtered = cat === 'all' ? formats : (formats || []).filter((f: any) => f.category === cat);
    if (filtered && filtered.length > 0) {
      const counts = Array.from(new Set(filtered.map((f: any) => f.bits))).sort((a: any, b: any) => a - b);
      const newCount = counts.includes(selectedBitCount) ? selectedBitCount : (counts[0] as number);
      setSelectedBitCount(newCount);
      const inBits = filtered.filter((f: any) => f.bits === newCount);
      if (inBits.length > 0) setSelectedFormatId(inBits[0].id);
    }
  };

  const handleBitCountChange = (newBits: number) => {
    setSelectedBitCount(newBits);
    const inBits = (filteredByCategory || []).filter((f: any) => f.bits === newBits);
    if (inBits.length > 0) {
      const popular = inBits.find((f: any) => f.popularity === 'very-high' || f.popularity === 'high');
      setSelectedFormatId(popular?.id || inBits[0].id);
    }
  };

  const handleFormatChange = (fid: string) => {
    setSelectedFormatId(fid);
    const f = getFormatById?.(fid);
    if (f && f.bits !== selectedBitCount) setSelectedBitCount(f.bits);
    setIssueLevel(0);
  };

  // Initialize format defaults once loaded
  useEffect(() => {
    if (!formatsLoading && formats && formats.length > 0) {
      if (!formats.find((f: any) => f.id === selectedFormatId)) {
        const popular = getPopularFormats ? getPopularFormats() : [];
        const def = popular?.[0] || formats[0];
        if (def) {
          setSelectedFormatId(def.id);
          setSelectedBitCount(def.bits);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatsLoading, formats]);

  // Send a card to the selected reader port on a specific board.
  const sendCardToReader = async (address: number, port: number) => {
    if (!selectedFormat) { logSystem('error', 'No format selected'); return; }
    if (!isCardOnly && !isValidFacilityCode(selectedFormat, facility)) {
      logSystem('error', `Invalid facility code (max ${selectedFormat.maxFacility})`); return;
    }
    if (!isValidCardNumber(selectedFormat, cardNumber)) {
      logSystem('error', `Invalid card number (max ${selectedFormat.maxCard.toLocaleString()})`); return;
    }
    setSending(true);
    try {
      const body = {
        format: selectedFormatId,
        facility: isCardOnly ? 0 : facility,
        card: cardNumber,
        issueLevel: hasIssueLevel ? issueLevel : 0,
      };
      const r = await fetch(`${apiBase}/api/emulator/device/${address}/reader/${port}/card`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.success) {
        logSystem('success', `Sent ${j.bitCount}-bit ${selectedFormatId} FC=${body.facility} Card=${body.card} → #${address} reader ${port}`);
      } else {
        logSystem('error', `Send card failed: ${j.error}`);
      }
    } catch (e: any) {
      logSystem('error', `Send card error: ${e.message}`);
    }
    setSending(false);
  };

  const sendPinToReader = async (address: number, port: number, keys: string) => {
    const trimmed = (keys || '').trim();
    if (!trimmed) { logSystem('error', 'PIN is empty'); return; }
    setSending(true);
    try {
      const r = await fetch(`${apiBase}/api/emulator/device/${address}/reader/${port}/keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: trimmed }),
      });
      const j = await r.json();
      if (j.success) {
        logSystem('success', `Sent PIN "${trimmed}" (${j.count} keys) → #${address} reader ${port}`);
        setPinValue('');
      } else {
        logSystem('error', `Send PIN failed: ${j.error}`);
      }
    } catch (e: any) {
      logSystem('error', `Send PIN error: ${e.message}`);
    }
    setSending(false);
  };

  const loadPreset = (preset: 'test' | 'admin' | 'visitor') => {
    const maxFc = selectedFormat?.maxFacility ?? 255;
    const maxCard = selectedFormat?.maxCard ?? 65535;
    if (preset === 'test') {
      setFacility(Math.min(123, maxFc));
      setCardNumber(Math.min(45678, maxCard));
      if (hasIssueLevel) setIssueLevel(1);
    } else if (preset === 'admin') {
      setFacility(Math.min(255, maxFc));
      setCardNumber(Math.min(1, maxCard));
      if (hasIssueLevel) setIssueLevel(0);
    } else {
      setFacility(0);
      setCardNumber(Math.min(9999, maxCard));
      if (hasIssueLevel) setIssueLevel(0);
    }
  };

  const generateRandomCard = () => {
    const maxFc = selectedFormat?.maxFacility ?? 255;
    const maxCard = selectedFormat?.maxCard ?? 65535;
    setFacility(Math.floor(Math.random() * Math.min(256, maxFc + 1)));
    setCardNumber(Math.floor(Math.random() * Math.min(65536, maxCard + 1)));
  };

  // ── Status toggles: tamper + power-fail (LSTATR bits) ───────────────
  // Latching toggles. Backend flips this.tamperActive / this.powerFailActive on
  // the targeted device; IC2 sees the bit change on its next LSTAT poll.
  const toggleTamper = async (address: number, currentValue: boolean) => {
    try {
      await fetch(`${apiBase}/api/emulator/device/${address}/tamper`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentValue }),
      });
    } catch (e: any) { logSystem('error', e.message); }
  };

  const togglePowerFail = async (address: number, currentValue: boolean) => {
    try {
      await fetch(`${apiBase}/api/emulator/device/${address}/powerfail`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentValue }),
      });
    } catch (e: any) { logSystem('error', e.message); }
  };

  // ── Config: save / load / import / export ───────────────────────────
  const refreshConfigs = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/emulator/config/list`);
      const j = await r.json();
      if (j.success) setSavedConfigs(j.configs || []);
    } catch (e) { /* silent */ }
  }, [apiBase]);

  useEffect(() => { refreshConfigs(); }, [refreshConfigs]);

  const saveConfig = async () => {
    const name = saveName.trim();
    if (!name) { logSystem('error', 'Config name required'); return; }
    try {
      const r = await fetch(`${apiBase}/api/emulator/config/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (j.success) {
        logSystem('success', `Saved config "${name}" (${j.config.devices.length} devices)`);
        setShowSaveModal(false); setSaveName('');
        refreshConfigs();
      } else logSystem('error', `Save failed: ${j.error}`);
    } catch (e: any) { logSystem('error', e.message); }
  };

  const applyConfig = async (name: string) => {
    if (!name) return;
    if (!confirm(`Apply config "${name}"? This replaces all currently configured devices.`)) return;
    try {
      const r = await fetch(`${apiBase}/api/emulator/config/apply/${encodeURIComponent(name)}`, { method: 'POST' });
      const j = await r.json();
      if (j.success) {
        logSystem('success', `Applied config "${name}" (${j.devices.length} devices)`);
        refreshStatus();
      } else logSystem('error', `Apply failed: ${j.error}`);
    } catch (e: any) { logSystem('error', e.message); }
  };

  const exportConfig = (name: string) => {
    if (!name) { logSystem('error', 'Select a config to export'); return; }
    window.open(`${apiBase}/api/emulator/config/export/${encodeURIComponent(name)}`, '_blank');
  };

  const importConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const cfg = JSON.parse(text);
        const r = await fetch(`${apiBase}/api/emulator/config/import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: cfg }),
        });
        const j = await r.json();
        if (j.success) {
          logSystem('success', `Imported config "${j.imported}"`);
          refreshConfigs();
          setSelectedConfig(j.imported);
        } else logSystem('error', `Import failed: ${j.error}`);
      } catch (e: any) { logSystem('error', `Import failed: ${e.message}`); }
    };
    input.click();
  };

  // ── Render helpers ───────────────────────────────────────────────────
  const deviceByAddr = (addr: number): DeviceSnap | null => devices.find(d => d.address === addr) || null;
  const selectedDevice = selectedAddr !== null ? deviceByAddr(selectedAddr) : null;

  return (
    <div className="space-y-4">
      {/* ── HEADER ─────────────────────────────────────────────────── */}
      <div className="rounded-xl p-6 border shadow-2xl bg-gradient-to-br from-[#241E19]/40 to-[#15110B]/40 border-[#4A3F36]/50">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <Cpu className="w-8 h-8 text-[#6FC7C0]" />
              Controller Emulator
            </h1>
            <p className="text-[#ADA294] text-sm mt-1">
              Emulates Azure Access downstream OSDP boards (I16S / O8S / IO168S) on an RS-485 bus.
              Connect this Pi's USB-to-RS485 adapter to an IC2's downstream port to simulate up to 32 devices.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-2 ${running ? 'bg-[#6FC7C0]/20 text-[#6FC7C0] border border-[#6FC7C0]/40' : 'bg-[#38302A]/40 text-[#ADA294] border border-[#4A3F36]/50'}`}>
              <div className={`w-2 h-2 rounded-full ${running ? 'bg-[#6FC7C0] animate-pulse' : 'bg-[#786D60]'}`} />
              {running ? 'Running' : 'Stopped'}
            </div>
            <div className="text-xs text-[#ADA294]">
              ↓ {framesIn}  ↑ {framesOut}
            </div>
          </div>
        </div>

        {/* Bus controls */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="text-xs text-[#ADA294] block mb-1">Serial Port</label>
            <div className="flex gap-2">
              <select disabled={running} value={port} onChange={e => setPort(e.target.value)} className="flex-1 bg-black/25 border border-[#38302A]/50 rounded px-3 py-2 text-sm disabled:opacity-50">
                <option value="">— Select port —</option>
                {ports.map(p => (
                  <option key={p.path} value={p.path}>
                    {p.path}{p.manufacturer ? ` (${p.manufacturer})` : ''}
                  </option>
                ))}
              </select>
              <button disabled={running} onClick={refreshPorts} className="px-3 py-2 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded text-sm disabled:opacity-50" title="Refresh port list">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs text-[#ADA294] block mb-1">Baud</label>
            <select disabled={running} value={baud} onChange={e => setBaud(parseInt(e.target.value))} className="bg-black/25 border border-[#38302A]/50 rounded px-3 py-2 text-sm disabled:opacity-50">
              {BAUDS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          {running ? (
            <button onClick={stopBus} className="px-6 py-2 bg-[#C6604F] hover:bg-[#A84E3F] rounded font-semibold flex items-center gap-2">
              <PowerOff className="w-4 h-4" /> Stop Bus
            </button>
          ) : (
            <button onClick={() => startBus(false)} disabled={!port} className="px-6 py-2 bg-[#6FC7C0] hover:bg-[#4E9E98] disabled:opacity-50 disabled:cursor-not-allowed rounded font-semibold flex items-center gap-2">
              <Power className="w-4 h-4" /> Start Bus
            </button>
          )}
        </div>

        {/* Config save / load / import / export */}
        <div className="flex items-end gap-2 flex-wrap mt-3 pt-3 border-t border-[#38302A]/40">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-[#ADA294] block mb-1 flex items-center gap-1">
              <FolderOpen className="w-3 h-3" /> Saved Configurations
            </label>
            <div className="flex gap-2">
              <select
                value={selectedConfig}
                onChange={e => setSelectedConfig(e.target.value)}
                className="flex-1 bg-black/25 border border-[#38302A]/50 rounded px-3 py-2 text-sm"
              >
                <option value="">— Select a saved config —</option>
                {savedConfigs.map(c => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.deviceCount} devices)
                  </option>
                ))}
              </select>
              <button
                onClick={refreshConfigs}
                className="px-3 py-2 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded text-sm"
                title="Refresh config list"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
          <button
            onClick={() => applyConfig(selectedConfig)}
            disabled={!selectedConfig}
            className="px-4 py-2 bg-[#6FC7C0] hover:bg-[#4E9E98] disabled:opacity-40 disabled:cursor-not-allowed text-[#15110B] rounded font-semibold text-sm flex items-center gap-2"
            title="Load selected config (replaces current devices)"
          >
            <FolderOpen className="w-4 h-4" /> Load
          </button>
          <button
            onClick={() => { setSaveName(''); setShowSaveModal(true); }}
            className="px-4 py-2 bg-[#38302A]/50 hover:bg-[#4A3F36]/60 rounded font-semibold text-sm flex items-center gap-2"
            title="Save current devices as a config"
          >
            <Save className="w-4 h-4" /> Save
          </button>
          <button
            onClick={() => exportConfig(selectedConfig)}
            disabled={!selectedConfig}
            className="px-4 py-2 bg-[#38302A]/50 hover:bg-[#4A3F36]/60 disabled:opacity-40 disabled:cursor-not-allowed rounded font-semibold text-sm flex items-center gap-2"
            title="Download selected config as JSON"
          >
            <Download className="w-4 h-4" /> Export
          </button>
          <button
            onClick={importConfig}
            className="px-4 py-2 bg-[#38302A]/50 hover:bg-[#4A3F36]/60 rounded font-semibold text-sm flex items-center gap-2"
            title="Import a config JSON file"
          >
            <Upload className="w-4 h-4" /> Import
          </button>
        </div>
      </div>

      {/* ── DEVICE GRID ─────────────────────────────────────────────── */}
      <div className="rounded-xl p-6 border shadow-2xl bg-gradient-to-br from-[#241E19]/40 to-[#15110B]/40 border-[#4A3F36]/50">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Radio className="w-5 h-5 text-[#6FC7C0]" />
            Devices ({devices.length}/{SLOT_COUNT})
          </h2>
          <div className="text-xs text-[#ADA294]">Click an empty slot to add · click a device to inspect</div>
        </div>

        <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
          {Array.from({ length: SLOT_COUNT }).map((_, addr) => {
            const dev = deviceByAddr(addr);
            const isSelected = selectedAddr === addr;
            if (dev) {
              const style = MODEL_STYLE[dev.model];
              // Tiered poll-status — drives the corner indicator dot.
              const pollAge = dev.lastPollAt > 0 ? Date.now() - dev.lastPollAt : Infinity;
              let pollStatus: { color: string; pulse: boolean; label: string };
              if (!isFinite(pollAge)) {
                pollStatus = { color: 'bg-[#4A3F36]', pulse: false, label: 'never polled' };
              } else if (pollAge < 3000) {
                pollStatus = { color: 'bg-[#6FC7C0]', pulse: true, label: `polled ${Math.round(pollAge)} ms ago` };
              } else if (pollAge < 8000) {
                pollStatus = { color: 'bg-[#E6C766]', pulse: false, label: `polled ${(pollAge / 1000).toFixed(1)}s ago — slower than usual` };
              } else if (pollAge < 20000) {
                pollStatus = { color: 'bg-[#D98A3D]', pulse: true, label: `polled ${(pollAge / 1000).toFixed(1)}s ago — suspect` };
              } else {
                pollStatus = { color: 'bg-[#C6604F]', pulse: false, label: `last poll ${(pollAge / 1000).toFixed(0)}s ago — likely lost` };
              }
              return (
                <button
                  key={addr}
                  onClick={() => setSelectedAddr(addr)}
                  className={`relative p-2 rounded border text-left transition-all overflow-hidden min-h-[90px] ${
                    isSelected ? 'border-2 shadow-lg' : 'border-[#4A3F36]/50 hover:border-[#786D60]'
                  }`}
                  style={{
                    borderColor: isSelected ? style.tint : undefined,
                    background: `linear-gradient(110deg, ${style.tint}20 0%, ${style.tint}10 50%, ${style.tint}35 100%)`,
                  }}
                >
                  {/* Tinted "well" behind the image — fills the void around the board */}
                  <div
                    className="absolute right-0 top-0 bottom-0 pointer-events-none"
                    style={{
                      width: '62%',
                      background: `linear-gradient(to right, transparent 0%, ${style.tint}25 30%, ${style.tint}40 100%)`,
                    }}
                  />
                  {/* Board image, sitting on top of the well */}
                  <img
                    src={style.image}
                    alt=""
                    aria-hidden
                    className="absolute right-1 top-1 bottom-1 opacity-60 pointer-events-none"
                    style={{ maxWidth: '60%', height: 'calc(100% - 0.5rem)', objectFit: 'contain', objectPosition: 'right center' }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <div className="relative flex items-center justify-between pr-[62%]">
                    <span className="text-xs font-bold text-white">#{addr}</span>
                  </div>
                  <div className="relative text-xs font-semibold mt-1 pr-[62%] truncate" style={{ color: style.tint }}>{dev.model}</div>
                  <div className="relative text-[10px] text-[#ADA294] pr-[62%] truncate">{style.label}</div>
                  <div className="relative text-[10px] text-[#786D60] mt-1 pr-[62%] truncate">{dev.pollCount} polls</div>
                  {/* Poll-status dot — 4-state, tiered by time since last POLL. Hover for details. */}
                  <div
                    className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ring-2 ring-[#15110B]/60 ${pollStatus.color} ${pollStatus.pulse ? 'animate-pulse' : ''}`}
                    title={pollStatus.label}
                  />
                  {/* Alarm corner dots — quick visual cue if tamper or power-fail is set */}
                  {(dev.tamperActive || dev.powerFailActive) && (
                    <div className="absolute bottom-1.5 right-1.5 flex gap-1">
                      {dev.tamperActive && <div className="w-1.5 h-1.5 rounded-full bg-[#C6604F] animate-pulse ring-2 ring-[#15110B]/60" title="Tamper active" />}
                      {dev.powerFailActive && <div className="w-1.5 h-1.5 rounded-full bg-[#D98A3D] animate-pulse ring-2 ring-[#15110B]/60" title="Power-fail active" />}
                    </div>
                  )}
                </button>
              );
            }
            return (
              <button
                key={addr}
                onClick={() => { setShowAddModal({ open: true, address: addr }); setAddModel('IO168S'); }}
                className="p-2 rounded border border-dashed border-[#38302A]/50 hover:border-[#786D60] hover:bg-[#38302A]/20 text-[#786D60] hover:text-[#C4B9AB] flex flex-col items-center justify-center min-h-[78px]"
              >
                <Plus className="w-4 h-4 opacity-50" />
                <span className="text-[10px] mt-1">#{addr}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── DEVICE DETAIL PANEL ─────────────────────────────────────── */}
      {selectedDevice && (
        <div className="rounded-xl p-6 border shadow-2xl bg-gradient-to-br from-[#241E19]/40 to-[#15110B]/40 border-[#4A3F36]/50">
          <div className="flex items-start gap-4 mb-4">
            {/* Board image */}
            <div className="shrink-0 w-32 h-24 rounded border border-[#38302A]/50 bg-black/30 overflow-hidden flex items-center justify-center">
              <img
                src={MODEL_STYLE[selectedDevice.model].image}
                alt={`${selectedDevice.model} board`}
                className="max-w-full max-h-full object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-white flex items-center gap-2 flex-wrap">
                <span className="px-2 py-0.5 rounded text-xs font-mono" style={{ background: MODEL_STYLE[selectedDevice.model].tint + '30', color: MODEL_STYLE[selectedDevice.model].tint }}>
                  addr {selectedDevice.address}
                </span>
                {selectedDevice.model}
                <span className="text-xs text-[#ADA294] font-normal">{MODEL_STYLE[selectedDevice.model].label}</span>
              </h3>
              <div className="flex items-center gap-3 mt-2 text-xs text-[#ADA294]">
                <span>{selectedDevice.pollCount} polls</span>
                {selectedDevice.lastCommand !== null && (
                  <span>last cmd: {CMD_NAMES[selectedDevice.lastCommand] || `0x${selectedDevice.lastCommand.toString(16)}`}</span>
                )}
                {selectedDevice.numInputs > 0 && <span>{selectedDevice.numInputs} in</span>}
                {selectedDevice.numOutputs > 0 && <span>{selectedDevice.numOutputs} out</span>}
                {selectedDevice.readerState && <span>{selectedDevice.readerState.length} readers</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => removeDevice(selectedDevice.address)} className="px-2 py-1 bg-[#C6604F]/80 hover:bg-[#C6604F] rounded text-xs flex items-center gap-1">
                <Trash2 className="w-3 h-3" /> Remove
              </button>
              <button onClick={() => setSelectedAddr(null)} className="p-1 hover:bg-[#38302A]/40 rounded">
                <X className="w-4 h-4 text-[#ADA294]" />
              </button>
            </div>
          </div>

          {/* Reader state (RI2MS / RI4S) — LED color, buzzer, text */}
          {selectedDevice.readerState && selectedDevice.readerState.length > 0 && (
            <CollapsibleSection
              storageKey="readers"
              title={`Readers (${selectedDevice.readerState.length})`}
              icon={<Radio className="w-4 h-4 text-[#6FC7C0]" />}
              headerRight={<span className="text-xs text-[#786D60] hidden md:inline">driven by upstream</span>}
            >
              <div className="grid grid-cols-2 gap-2">
                {selectedDevice.readerState.map((r, i) => {
                  const colorMap: Record<string, string> = {
                    off: '#4A3F36', red: '#ef4444', green: '#22c55e', amber: '#f59e0b',
                    blue: '#3b82f6', magenta: '#ec4899', cyan: '#06b6d4', white: '#f8fafc',
                  };
                  const isTarget = targetReaderPort === i;
                  return (
                    <button
                      key={i}
                      onClick={() => setTargetReaderPort(i)}
                      className={`text-left p-3 rounded border transition-all ${
                        isTarget
                          ? 'border-[#6FC7C0] bg-[#6FC7C0]/10 shadow-[0_0_8px_rgba(111,199,192,0.2)]'
                          : 'border-[#38302A]/50 bg-black/25 hover:border-[#4A3F36]'
                      }`}
                      title={isTarget ? 'Selected target for Send Credential' : 'Click to target this reader'}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-xs font-mono ${isTarget ? 'text-[#6FC7C0]' : 'text-[#ADA294]'}`}>
                          Reader {i}{isTarget ? ' • TARGET' : ''}
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full transition-colors" style={{ backgroundColor: colorMap[r.ledColor] || '#4A3F36', boxShadow: r.ledColor !== 'off' ? `0 0 6px ${colorMap[r.ledColor]}` : undefined }} title={`LED: ${r.ledColor}`} />
                          <Radio className={`w-3 h-3 ${r.buzzerOn ? 'text-[#E6C766] animate-pulse' : 'text-[#4A3F36]'}`} />
                        </div>
                      </div>
                      <div className="text-[11px] font-mono bg-black/40 rounded px-2 py-1 min-h-[28px] text-[#E3D8C8] break-all">
                        {r.text || <span className="text-[#4A3F36] italic">no text</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CollapsibleSection>
          )}

          {/* ── Card Composer: send credentials to a reader port ────────────────────── */}
          {selectedDevice.readerState && selectedDevice.readerState.length > 0 && (
            <CollapsibleSection
              storageKey="composer"
              title="Send Credential"
              icon={<CreditCard className="w-4 h-4 text-[#6FC7C0]" />}
              headerRight={<span className="text-xs text-[#786D60]">→ R{targetReaderPort}</span>}
              bodyClassName="space-y-3"
            >
                  {/* Target port selector */}
                  <div>
                    <label className="text-[11px] text-[#ADA294] block mb-1">Target reader port</label>
                    <div className="flex flex-wrap gap-1">
                      {selectedDevice.readerState.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setTargetReaderPort(i)}
                          className={`px-3 py-1 rounded text-xs font-mono border ${
                            targetReaderPort === i
                              ? 'bg-[#6FC7C0]/30 border-[#6FC7C0] text-white'
                              : 'bg-black/25 border-[#38302A]/50 text-[#ADA294] hover:border-[#4A3F36]'
                          }`}
                        >
                          R{i}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Format selection — Category / Bits / Format */}
                  <div className="space-y-2">
                    <div>
                      <label className="text-[11px] text-[#ADA294] block mb-1">
                        Category {formatsLoading && <span className="text-[#786D60]">(loading…)</span>}
                      </label>
                      <select
                        value={selectedCategory}
                        onChange={e => handleCategoryChange(e.target.value)}
                        disabled={formatsLoading}
                        className="w-full bg-black/25 border border-[#38302A]/50 rounded px-2 py-1.5 text-xs"
                      >
                        {FORMAT_CATEGORIES.map(cat => (
                          <option key={cat.id} value={cat.id}>{cat.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-[80px_1fr] gap-2">
                      <div>
                        <label className="text-[11px] text-[#ADA294] block mb-1">Bits</label>
                        <select
                          value={selectedBitCount}
                          onChange={e => handleBitCountChange(parseInt(e.target.value))}
                          disabled={formatsLoading}
                          className="w-full bg-black/25 border border-[#38302A]/50 rounded px-2 py-1.5 text-xs font-bold text-center"
                        >
                          {availableBitCounts.map(b => (
                            <option key={b as number} value={b as number}>{b as number}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] text-[#ADA294] block mb-1">
                          Format ({formatsForSelectedBits.length})
                        </label>
                        <select
                          value={selectedFormatId}
                          onChange={e => handleFormatChange(e.target.value)}
                          disabled={formatsLoading || formatsForSelectedBits.length === 0}
                          className="w-full bg-black/25 border border-[#38302A]/50 rounded px-2 py-1.5 text-xs"
                        >
                          {formatsForSelectedBits.length === 0 ? (
                            <option>No formats at {selectedBitCount}-bit</option>
                          ) : (
                            formatsForSelectedBits.map((f: any) => (
                              <option key={f.id} value={f.id}>
                                {f.name || f.id}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    </div>
                    {selectedFormat && (
                      <div className="text-[10px] text-[#786D60] px-1">
                        {(selectedFormat as any).description || selectedFormat.name}
                        {' • '}
                        {hasFacilityCode ? `FC: 0-${selectedFormat.maxFacility}` : 'No FC'}
                        {' / '}Card: 0-{selectedFormat.maxCard.toLocaleString()}
                      </div>
                    )}
                  </div>

                  {/* Credential inputs */}
                  <div className={`grid gap-2 ${hasIssueLevel ? 'grid-cols-3' : (hasFacilityCode ? 'grid-cols-2' : 'grid-cols-1')}`}>
                    {hasIssueLevel && (
                      <div>
                        <label className="text-[11px] text-[#5FB7B0] block mb-1">IL (0-{maxIssueLevel})</label>
                        <input
                          type="number"
                          value={issueLevel}
                          onChange={e => setIssueLevel(Math.max(0, Math.min(maxIssueLevel, parseInt(e.target.value) || 0)))}
                          min={0} max={maxIssueLevel}
                          className="w-full bg-black/25 border border-[#5FB7B0]/50 rounded px-2 py-1.5 text-xs font-mono"
                        />
                      </div>
                    )}
                    {hasFacilityCode && (
                      <div>
                        <label className="text-[11px] text-[#ADA294] block mb-1">Facility</label>
                        <input
                          type="number"
                          value={facility}
                          onChange={e => setFacility(Math.max(0, Math.min(selectedFormat?.maxFacility ?? 255, parseInt(e.target.value) || 0)))}
                          min={0} max={selectedFormat?.maxFacility ?? 255}
                          disabled={isCardOnly}
                          className={`w-full bg-black/25 border rounded px-2 py-1.5 text-xs font-mono ${
                            selectedFormat && !isValidFacilityCode(selectedFormat, facility)
                              ? 'border-[#C6604F]/60'
                              : 'border-[#38302A]/50'
                          }`}
                        />
                      </div>
                    )}
                    <div>
                      <label className="text-[11px] text-[#ADA294] block mb-1">Card #</label>
                      <input
                        type="number"
                        value={cardNumber}
                        onChange={e => setCardNumber(Math.max(0, Math.min(selectedFormat?.maxCard ?? 65535, parseInt(e.target.value) || 0)))}
                        min={0} max={selectedFormat?.maxCard ?? 65535}
                        className={`w-full bg-black/25 border rounded px-2 py-1.5 text-xs font-mono ${
                          selectedFormat && !isValidCardNumber(selectedFormat, cardNumber)
                            ? 'border-[#C6604F]/60'
                            : 'border-[#38302A]/50'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Quick action buttons */}
                  <div className="flex gap-1.5">
                    <button onClick={generateRandomCard} className="flex-1 px-2 py-1 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded text-[11px] flex items-center justify-center gap-1">
                      <Shuffle className="w-3 h-3" /> Random
                    </button>
                    <button onClick={() => loadPreset('test')} className="flex-1 px-2 py-1 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded text-[11px]">
                      Test
                    </button>
                    <button onClick={() => loadPreset('admin')} className="flex-1 px-2 py-1 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded text-[11px]">
                      Admin
                    </button>
                    <button onClick={() => loadPreset('visitor')} className="flex-1 px-2 py-1 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded text-[11px]">
                      Visitor
                    </button>
                  </div>

                  {/* Quick Credentials (saved pills) */}
                  <CredentialQuickPills
                    current={{
                      formatId: selectedFormatId,
                      bits: selectedBitCount,
                      facility,
                      cardNumber,
                      issueLevel,
                    }}
                    hasIssueLevel={hasIssueLevel}
                    onLoad={(cred: any) => {
                      if (cred.formatId !== undefined) setSelectedFormatId(cred.formatId);
                      if (cred.bits !== undefined) setSelectedBitCount(cred.bits);
                      if (cred.facility !== undefined) setFacility(cred.facility);
                      if (cred.cardNumber !== undefined) setCardNumber(cred.cardNumber);
                      if (cred.issueLevel !== undefined) setIssueLevel(cred.issueLevel);
                    }}
                    onLog={(m: string) => logSystem('info', m)}
                  />

                  {/* Send Card */}
                  <button
                    onClick={() => sendCardToReader(selectedDevice.address, targetReaderPort)}
                    disabled={sending || !selectedFormat}
                    className="w-full px-3 py-2 bg-[#6FC7C0] hover:bg-[#4E9E98] disabled:opacity-50 disabled:cursor-not-allowed text-[#15110B] font-semibold rounded text-sm flex items-center justify-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    {sending ? 'Sending…' : `Send Card → Reader ${targetReaderPort}`}
                  </button>

                  {/* PIN entry */}
                  <div className="pt-2 border-t border-[#38302A]/40">
                    <div className="flex items-center gap-2 mb-1">
                      <KeyRound className="w-3 h-3 text-[#ADA294]" />
                      <span className="text-[11px] text-[#ADA294] uppercase tracking-wide">PIN / Keypad</span>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={pinValue}
                        onChange={e => setPinValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') sendPinToReader(selectedDevice.address, targetReaderPort, pinValue); }}
                        placeholder='digits + #/* (e.g. "1234#")'
                        className="flex-1 bg-black/25 border border-[#38302A]/50 rounded px-2 py-1.5 text-xs font-mono"
                      />
                      <button
                        onClick={() => sendPinToReader(selectedDevice.address, targetReaderPort, pinValue)}
                        disabled={sending || !pinValue.trim()}
                        className="px-3 py-1.5 bg-[#38302A]/50 hover:bg-[#4A3F36]/60 disabled:opacity-50 rounded text-xs font-semibold flex items-center gap-1"
                      >
                        <Send className="w-3 h-3" /> Send PIN
                      </button>
                    </div>
                  </div>
            </CollapsibleSection>
          )}

          {/* Inputs (simulate by clicking) */}
          {selectedDevice.numInputs > 0 && selectedDevice.inputs && (
            <CollapsibleSection
              storageKey="inputs"
              title={`Inputs (${selectedDevice.numInputs})`}
              icon={<Zap className="w-4 h-4 text-[#E6C766]" />}
              headerRight={<span className="text-xs text-[#786D60] hidden md:inline">click to toggle</span>}
            >
              <div className="grid grid-cols-8 gap-1.5">
                {selectedDevice.inputs.map((v, i) => (
                  <button
                    key={i}
                    onClick={() => toggleInput(selectedDevice.address, i, v)}
                    className={`p-2 rounded border text-xs font-mono flex flex-col items-center gap-1 transition-all ${
                      v ? 'bg-[#6FC7C0]/30 border-[#6FC7C0] text-white' : 'bg-black/25 border-[#38302A]/50 text-[#ADA294] hover:border-[#786D60]'
                    }`}
                  >
                    <span>IN{i}</span>
                    {v ? <Zap className="w-3 h-3" /> : <ZapOff className="w-3 h-3" />}
                  </button>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* Outputs (read-only — driven by IC2) */}
          {selectedDevice.numOutputs > 0 && selectedDevice.outputs && (
            <CollapsibleSection
              storageKey="outputs"
              title={`Outputs (${selectedDevice.numOutputs})`}
              icon={<Power className="w-4 h-4 text-[#7BD497]" />}
              headerRight={<span className="text-xs text-[#786D60] hidden md:inline">read-only</span>}
            >
              <div className="grid grid-cols-8 gap-1.5">
                {selectedDevice.outputs.map((v, i) => (
                  <div
                    key={i}
                    className={`p-2 rounded border text-xs font-mono flex flex-col items-center gap-1 ${
                      v ? 'bg-[#6FC7C0]/30 border-[#6FC7C0] text-white' : 'bg-black/25 border-[#38302A]/50 text-[#786D60]'
                    }`}
                  >
                    <span>OUT{i}</span>
                    <div className={`w-2 h-2 rounded-full ${v ? 'bg-[#6FC7C0]' : 'bg-[#4A3F36]'}`} />
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}

          {/* ── Status: Tamper + Power Fail (latching toggles) ──────── */}
          {/* Always shown — applies to every device model. Reported via LSTATR. */}
          <CollapsibleSection
            storageKey="status"
            title="Status"
            icon={<AlertCircle className="w-4 h-4 text-[#E6A24C]" />}
            headerRight={<span className="text-xs text-[#786D60] hidden md:inline">latching — via LSTATR</span>}
          >
            <div className="flex gap-2">
              <button
                onClick={() => toggleTamper(selectedDevice.address, !!selectedDevice.tamperActive)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-2 ${
                  selectedDevice.tamperActive
                    ? 'bg-[#C6604F]/30 border-[#C6604F] text-[#F0A79A] shadow-[0_0_10px_rgba(239,68,68,0.3)]'
                    : 'bg-black/25 border-[#38302A]/50 text-[#ADA294] hover:border-[#4A3F36]'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${selectedDevice.tamperActive ? 'bg-[#E0705F] animate-pulse' : 'bg-[#4A3F36]'}`} />
                TAMPER
              </button>
              <button
                onClick={() => togglePowerFail(selectedDevice.address, !!selectedDevice.powerFailActive)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-2 ${
                  selectedDevice.powerFailActive
                    ? 'bg-[#C9862E]/30 border-[#D98A3D] text-[#F0C08A] shadow-[0_0_10px_rgba(249,115,22,0.3)]'
                    : 'bg-black/25 border-[#38302A]/50 text-[#ADA294] hover:border-[#4A3F36]'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${selectedDevice.powerFailActive ? 'bg-[#E6A24C] animate-pulse' : 'bg-[#4A3F36]'}`} />
                POWER FAIL
              </button>
            </div>
          </CollapsibleSection>

          {selectedDevice.numInputs === 0 && selectedDevice.numOutputs === 0 && !selectedDevice.readerState && (
            <div className="text-sm text-[#786D60] text-center py-4">No I/O on this device model.</div>
          )}
        </div>
      )}

      {/* ── TRACE PANEL ─────────────────────────────────────────────── */}
      <div className="rounded-xl border shadow-2xl bg-gradient-to-br from-[#241E19]/40 to-[#15110B]/40 border-[#4A3F36]/50 overflow-hidden">
        <button onClick={() => setShowTrace(s => !s)} className="w-full p-3 flex items-center justify-between hover:bg-[#38302A]/20">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#6FC7C0]" />
            <span className="text-sm font-semibold text-white">Bus Trace ({frames.length})</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#ADA294]">
            {showTrace ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            <ChevronRight className={`w-4 h-4 transition-transform ${showTrace ? 'rotate-90' : ''}`} />
          </div>
        </button>
        {showTrace && (
          <div className="max-h-[280px] overflow-y-auto font-mono text-[11px] border-t border-[#38302A]/50">
            {frames.length === 0 ? (
              <div className="text-[#786D60] text-center py-6">No frames yet. Start the bus and an upstream controller polls.</div>
            ) : (
              frames.map((f, i) => (
                <div key={i} className={`flex items-start gap-2 px-3 py-1 border-b border-[#241E19]/50 ${f.direction === 'in' ? 'bg-black/10' : ''}`}>
                  <span className="text-[#786D60] w-16 shrink-0">{new Date(f.ts).toLocaleTimeString('en-US', { hour12: false })}</span>
                  <span className={`w-6 shrink-0 ${f.direction === 'in' ? 'text-[#5FB7B0]' : 'text-[#6FC7C0]'}`}>
                    {f.direction === 'in' ? '↓' : '↑'}
                  </span>
                  <span className="text-[#C4B9AB] w-12 shrink-0">#{f.addr}</span>
                  <span className="text-[#F0C674] w-16 shrink-0">{f.cmd ? (CMD_NAMES[f.cmd] || `0x${f.cmd.toString(16)}`) : ''}</span>
                  <span className="text-[#786D60] truncate flex-1">{f.hex}</span>
                  {f.error && <span className="text-[#E0705F] shrink-0">{f.error}</span>}
                  {f.handled === false && f.direction === 'in' && <span className="text-[#4A3F36] shrink-0">(no device)</span>}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── SAVE CONFIG MODAL ───────────────────────────────────────── */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowSaveModal(false)}>
          <div className="bg-[#15110B] border border-[#38302A] rounded-xl p-6 w-[420px]" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-1 text-white flex items-center gap-2">
              <Save className="w-5 h-5 text-[#6FC7C0]" /> Save Configuration
            </h3>
            <p className="text-xs text-[#ADA294] mb-4">
              Saves the current {devices.length} device(s) to a named config file on this machine.
            </p>
            <input
              type="text"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveConfig(); }}
              placeholder="Config name (e.g. azure-3board)"
              autoFocus
              className="w-full bg-black/25 border border-[#38302A]/50 rounded px-3 py-2 text-sm mb-4"
            />
            <div className="flex gap-3">
              <button onClick={() => setShowSaveModal(false)} className="flex-1 px-4 py-2 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded">Cancel</button>
              <button onClick={saveConfig} className="flex-1 px-4 py-2 bg-[#6FC7C0] hover:bg-[#4E9E98] text-[#15110B] font-semibold rounded">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── ADD DEVICE MODAL ────────────────────────────────────────── */}
      {showAddModal.open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowAddModal({ open: false, address: 0 })}>
          <div className="bg-[#15110B] border border-[#38302A] rounded-xl p-6 w-[420px]" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-1 text-white">Add Device at Address {showAddModal.address}</h3>
            <p className="text-xs text-[#ADA294] mb-4">Choose which Azure Access board model to emulate at this address.</p>
            <div className="space-y-2 mb-4">
              {MODELS.map(m => (
                <button
                  key={m}
                  onClick={() => setAddModel(m)}
                  className={`w-full p-3 rounded border text-left flex items-center gap-3 ${addModel === m ? 'border-[#6FC7C0] bg-[#6FC7C0]/15' : 'border-[#38302A] hover:bg-[#38302A]/30'}`}
                >
                  <div className="shrink-0 w-16 h-12 rounded bg-black/30 overflow-hidden flex items-center justify-center">
                    <img
                      src={MODEL_STYLE[m].image}
                      alt=""
                      className="max-w-full max-h-full object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                  <div className="flex-1 flex items-center justify-between">
                    <span className="font-semibold text-white">{m}</span>
                    <span className="text-xs text-[#ADA294]">{MODEL_STYLE[m].label}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowAddModal({ open: false, address: 0 })} className="flex-1 px-4 py-2 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded">Cancel</button>
              <button onClick={() => { addDevice(showAddModal.address, addModel); setShowAddModal({ open: false, address: 0 }); }} className="flex-1 px-4 py-2 bg-[#6FC7C0] hover:bg-[#4E9E98] text-[#15110B] font-semibold rounded">Add</button>
            </div>
          </div>
        </div>
      )}
      {/* ── PORT CONFLICT CONFIRMATION MODAL ─────────────────────────── */}
      {conflictModal.open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConflictModal({ open: false, portPath: '', readers: [] })}>
          <div className="bg-[#15110B] border border-[#C9862E]/60 rounded-xl p-6 w-[500px] max-w-[95vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <div className="shrink-0 w-10 h-10 rounded-full bg-[#C9862E]/20 border border-[#C9862E]/50 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-[#E6C766]" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Port In Use by Reader Emulation</h3>
                <p className="text-xs text-[#ADA294] mt-0.5">Confirm to release the port for downstream-controller emulation.</p>
              </div>
            </div>

            <div className="bg-black/30 border border-[#38302A]/50 rounded p-3 mb-4">
              <div className="text-xs text-[#786D60] mb-1">Port</div>
              <div className="font-mono text-sm text-white mb-3">{conflictModal.portPath}</div>

              <div className="text-xs text-[#786D60] mb-1">
                Affected readers ({conflictModal.readers.length})
              </div>
              {conflictModal.readers.length === 0 ? (
                <div className="text-sm text-[#ADA294] italic">No readers configured — port is held but idle.</div>
              ) : (
                <div className="space-y-1 max-h-[200px] overflow-y-auto">
                  {conflictModal.readers.map(r => (
                    <div key={r.id} className="flex items-center justify-between text-sm py-1 px-2 rounded bg-[#241E19]/50">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${r.enabled ? 'bg-[#6FC7C0]' : 'bg-[#4A3F36]'}`} />
                        <span className="text-[#E3D8C8]">{r.name}</span>
                      </div>
                      <span className="font-mono text-xs text-[#786D60]">addr {r.address}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="text-xs text-[#ADA294] mb-4">
              Starting the Controller Emulator on this port will close the reader polling. Stopping the bus later will automatically restore it.
            </div>

            <div className="flex gap-3">
              <button onClick={() => setConflictModal({ open: false, portPath: '', readers: [] })} className="flex-1 px-4 py-2 bg-[#38302A]/40 hover:bg-[#4A3F36]/50 rounded">
                Cancel
              </button>
              <button onClick={confirmConflictAndStart} className="flex-1 px-4 py-2 bg-[#C9862E] hover:bg-[#A96F22] text-white font-semibold rounded flex items-center justify-center gap-2">
                <Power className="w-4 h-4" /> Release & Start
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ControllerEmulatorSection;
