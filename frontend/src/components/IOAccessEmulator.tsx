import React, { useEffect, useMemo, useState } from 'react';
import { Wifi, WifiOff, Activity, Settings, FileText, PlayCircle, Circle, Radio, Building2, Cpu, Cloud, Terminal, Monitor, Network, Wrench, Gauge } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import OSDPSection from './OSDPSection';
import ReadersSection from './ReadersSection';
import ElevatorSection from './ElevatorSection';
import EmulationSection from './EmulationSection';
import AutomationSection from './AutomationSection';
import ControllerEmulatorSection from './ControllerEmulatorSection';
import DoorSection from './DoorSection';  // ✅ NEW: Extracted Door Section with corrected I/O architecture
import OSDPTransferTool from './OSDPTransferTool'; 
import ConfigSection, { SETUP_TABS, TOOL_TABS } from './ConfigSection';   // AETHER-GNB-2DEPTH
import type { SetupId, ToolId } from './ConfigSection';
import type { ReadersPage, ReaderStats } from './ReadersSection';
import { FEATURES as READER_FEATURES } from './ReadersSection';
import Reports from './Reports';
import StreamToolPanel from './stream/StreamToolPanel';
import SwitchSection from './SwitchSection';
import { TopBar, SideNav, PageHeader, useNavCollapsed, StatusDot } from './shell/AppShell';
import type { ClusterNav, NavItem } from './shell/AppShell';
import EOLCalibrationSection from './EOLCalibrationSection';
import EmulatedBoardsSection from './EmulatedBoardsSection';
/** ---------- Types ---------- */
type InputType =
  | 'None' | 'REX-Button' | 'Entry Sensor' | 'Lock Sensor'
  | 'Safety Beam' | 'DPS' | 'AUX' | 'General';
type OutputType =
  | 'None' | 'Strike Follower' | 'Lock'
  | 'Auto Door' | 'Sounder' | 'Strobe' | 'FAI' | 'General';
type LogEntry = { time: string; message: string };
type SystemLogEntry = { time: string; type: 'success'|'error'|'info'|'warn'|'io'|string; message: string };
type InputItem = { 
  id: number; 
  name: string; 
  type: InputType; 
  channel: number; 
  active: boolean;
  restingState?: 'NO' | 'NC';
};
type OutputItem = { 
  id: number; 
  name: string; 
  type: OutputType; 
  channel: number; 
  active: boolean;
  inputType?: 'opto' | 'analog';
  supervisionType?: 'NO' | 'NC' | 'Supervised-NO' | 'Supervised-NC';
  supervisionState?: 'normal' | 'active' | 'trouble' | 'short';
};
// Reader Types (shared with DoorSection)
type ReaderType = 'wiegand' | 'osdp' | 'none';
type CredentialFormat = '26-bit' | '34-bit' | '35-bit' | '37-bit' | '48-bit' | 'custom';
type Reader = {
  id: string;
  name: string;
  type: ReaderType;
  enabled: boolean;
  d0?: number;
  d1?: number;
  address?: number;
  assignedToDoor: number | null;
  position: 'in' | 'out' | null;
};
type CardCredential = {
  id: string;
  name: string;
  format: CredentialFormat;
  facilityCode: string;
  cardNumber: string;
  customBits?: string;
};
// Door type for EmulationSection compatibility (minimal - DoorSection manages full state)
type DoorEdgeIO = { 
  channel: number; 
  active: boolean; 
  reverseSense?: boolean;
  inputType?: 'opto' | 'analog';
};
type DoorIO = {
  id: string;
  name: string;
  type: InputType | OutputType;
  channel: number;
  active: boolean;
  enabled: boolean;
  reverseSense?: boolean;
  direction?: 'input' | 'output';
};
type Door = {
  id: number;
  name: string;
  enabled: boolean;
  lock: DoorEdgeIO & { name: string };
  dps: DoorEdgeIO & { name: string };
  rexIn: DoorEdgeIO & { name: string };
  ios: DoorIO[];
  readers: {
    in: string | null;
    out: string | null;
  };
};
type WiegandReader = { id: string; name: string; enabled: boolean };
/** Utility: Robust fetch with timeout */
async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `HTTP ${r.status}`);
    }
    if (ct.includes('application/json')) return await r.json();
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}
/**
 * GPIO Control Function - Uses Sequent IOplus API
 */
async function postGpio(ipAddress: string, channel: number, state: number) {
  if (channel < 0 || channel > 7) {
    throw new Error(`Invalid channel ${channel}. Sequent IOplus only has channels 0-7.`);
  }
  
  console.log(`[Frontend] Sequent IOplus - Channel: ${channel}, Value: ${state}`);
  
  const url = `http://${ipAddress}:3001/api/gpio/set`;
  await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: channel, value: state })
  });
}
/** ---------- Cluster props (optional — omit for standalone mode) ---------- */
interface IOAccessEmulatorProps {
  /** When provided by ClusterManager, locks the IP to this value */
  externalIp?: string;
  /** Unique node ID — used to namespace localStorage keys */
  nodeId?: string;
  /** Node display label shown in the header when nested inside a cluster */
  nodeLabel?: string;
  /** Callback so ClusterManager can track live connection status per node */
  onConnectionChange?: (nodeId: string, connected: boolean) => void;
  /** Node switcher for the top bar when running inside ClusterManager */
  cluster?: ClusterNav;
}
/** Small count badge for 2-depth navigation items (4px gap to the label, per HV Navigation menu). */
/* AETHER-GNB-2DEPTH: 2-depth pages for Readers / Setup / Tools, remembered per browser tab
   (same sessionStorage keys the old in-page tab bars used). */
const READER_PAGES: { id: ReadersPage; label: string }[] = [
  { id: 'osdp', label: 'OSDP' },
  { id: 'trace', label: 'OSDP Trace' },
  { id: 'wiegand', label: 'Wiegand' },
  { id: 'formats', label: 'Card Formats' },
  { id: 'nfc', label: 'NFC' },
];
const recallPage = <X extends string>(key: string, ok: readonly { id: string }[], dflt: X, legacy: Record<string, X> = {}): X => {
  try { const v = sessionStorage.getItem(key) || ''; if (legacy[v]) return legacy[v]; if (ok.some(x => x.id === v)) return v as X; } catch { /* */ }
  return dflt;
};
const rememberPage = (key: string, v: string) => { try { sessionStorage.setItem(key, v); } catch { /* */ } };

const NavBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="ml-1 min-w-[20px] h-[18px] px-1.5 rounded-full bg-hv-contrast/10 text-hv-text-2 text-[11px] leading-[18px] text-center font-medium">{children}</span>
);

const IOAccessEmulator: React.FC<IOAccessEmulatorProps> = ({
  externalIp,
  nodeId,
  nodeLabel,
  onConnectionChange,
  cluster,
}) => {
  // Namespace localStorage per node so each Pi has its own saved config.
  // Falls back to the legacy 'systemConfig' key in standalone mode.
  const storageKey = nodeId ? `systemConfig_${nodeId}` : 'systemConfig';
  /** ---------- Top-level state ---------- */
  const [connected, setConnected] = useState(false);
  // When running inside a cluster the IP is controlled externally.
  const [ipAddress, setIpAddress] = useState(externalIp || 'localhost');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [activeTab, setActiveTab] = useState<'access-control'|'readers'|'emulation'|'automation'|'controller-emulator'|'setup'|'tools'|'reports'>('access-control');
  const [activeAccessControlTab, setActiveAccessControlTab] = useState<'control'|'doors'|'elevator'>('control');
  const [readersPage, setReadersPage] = useState<ReadersPage>(() => recallPage<ReadersPage>('aether.readers.tab', READER_PAGES, 'osdp', { builder: 'trace' }));
  const [setupPage, setSetupPage] = useState<SetupId>(() => recallPage<SetupId>('aether.config.tab', SETUP_TABS, 'pinout'));
  const [toolsPage, setToolsPage] = useState<ToolId>(() => recallPage<ToolId>('aether.tools.tab', TOOL_TABS, 'oncafe'));
  const [readerStats, setReaderStats] = useState<ReaderStats | null>(null);
  const [navCollapsed, toggleNav] = useNavCollapsed();
  // Switch control, console builder and stream view are grouped under Tools
  // rather than each holding a slot in the main bar.
  /** ---------- Shared State (used by multiple components) ---------- */
  const [readerPool, setReaderPool] = useState<Reader[]>([
    { id: 'reader1', name: 'Wiegand Reader 1', type: 'wiegand', enabled: true, d0: 17, d1: 27, assignedToDoor: 1, position: 'in' },
    { id: 'reader2', name: 'Wiegand Reader 2', type: 'wiegand', enabled: true, d0: 22, d1: 23, assignedToDoor: 2, position: 'in' },
    { id: 'reader3', name: 'Wiegand Reader 3', type: 'wiegand', enabled: false, d0: 24, d1: 25, assignedToDoor: null, position: null },
    { id: 'reader4', name: 'Wiegand Reader 4', type: 'wiegand', enabled: false, d0: 5, d1: 6, assignedToDoor: null, position: null }
  ]);
  const [credentialLibrary, setCredentialLibrary] = useState<CardCredential[]>([
    { id: 'card-1', name: 'Default Card (26-bit)', format: '26-bit', facilityCode: '123', cardNumber: '12345' },
    { id: 'card-2', name: 'Admin Card (26-bit)', format: '26-bit', facilityCode: '123', cardNumber: '99999' },
    { id: 'card-3', name: 'Corp ID (34-bit)', format: '34-bit', facilityCode: '65535', cardNumber: '1234567' },
    { id: 'card-4', name: 'Gov ID (37-bit)', format: '37-bit', facilityCode: '511', cardNumber: '1234567' },
    { id: 'card-5', name: 'HID Mobile (48-bit)', format: '48-bit', facilityCode: '4095', cardNumber: '123456789' }
  ]);
  /** ---------- IO state (for I/O Controls tab) ---------- */
  const [inputs, setInputs] = useState<InputItem[]>([
    { id: 1, name: 'Device Input 1', type: 'REX-Button', channel: 0, active: false, restingState: 'NO' },
    { id: 2, name: 'Device Input 2', type: 'REX-Button', channel: 1, active: false, restingState: 'NO' },
    { id: 3, name: 'Device Input 3', type: 'REX-Button', channel: 2, active: false, restingState: 'NO' },
    { id: 4, name: 'Device Input 4', type: 'REX-Button', channel: 3, active: false, restingState: 'NO' },
    { id: 5, name: 'Device Input 5', type: 'Entry Sensor', channel: 4, active: false, restingState: 'NO' },
    { id: 6, name: 'Device Input 6', type: 'Safety Beam', channel: 5, active: false, restingState: 'NO' },
    { id: 7, name: 'Device Input 7', type: 'General', channel: 6, active: false, restingState: 'NO' },
    { id: 8, name: 'Device Input 8', type: 'General', channel: 7, active: false, restingState: 'NO' }
  ]);
  const [outputs, setOutputs] = useState<OutputItem[]>([
    { id: 1, name: 'Device Output 1', type: 'Strike Follower', channel: 0, active: false, inputType: 'opto' },
    { id: 2, name: 'Device Output 2', type: 'Strike Follower', channel: 1, active: false, inputType: 'opto' },
    { id: 3, name: 'Device Output 3', type: 'Strike Follower', channel: 2, active: false, inputType: 'opto' },
    { id: 4, name: 'Device Output 4', type: 'Strike Follower', channel: 3, active: false, inputType: 'opto' },
    { id: 5, name: 'Device Output 5', type: 'Sounder', channel: 4, active: false, inputType: 'opto' },
    { id: 6, name: 'Device Output 6', type: 'Strobe', channel: 5, active: false, inputType: 'opto' },
    { id: 7, name: 'Device Output 7', type: 'General', channel: 6, active: false, inputType: 'opto' },
    { id: 8, name: 'Device Output 8', type: 'General', channel: 7, active: false, inputType: 'opto' }
  ]);
  const [controllerOutputs, setControllerOutputs] = useState<OutputItem[]>([
    { id: 1, name: 'Controller Output 1', type: 'None', channel: 0, active: false },
    { id: 2, name: 'Controller Output 2', type: 'None', channel: 1, active: false },
    { id: 3, name: 'Controller Output 3', type: 'None', channel: 2, active: false },
    { id: 4, name: 'Controller Output 4', type: 'None', channel: 3, active: false }
  ]);
  // ── Live Controller Emulator I/O (from /api/emulator/* socket events) ─
  // Live items use id = address*100 + ioIndex (board 12, output 3 -> 1203).
  // The 4 static controllerOutputs above (ids 1..4) act as fallback when the
  // emulator is stopped; live items are appended/replaced separately below.
  const [controllerInputs, setControllerInputs] = useState<InputItem[]>([]);
  // Minimal door state for EmulationSection compatibility
  // DoorSection manages its own detailed door state with corrected I/O architecture
  const [doors, setDoors] = useState<Door[]>([
    { id: 1, name: 'Main Entrance', enabled: true, lock: { name: 'Door Strike', channel: 0, active: false }, dps: { name: 'Door Position', channel: 0, active: false }, rexIn: { name: 'REX Button', channel: 4, active: false }, ios: [], readers: { in: 'reader1', out: null } },
    { id: 2, name: 'Back Door', enabled: true, lock: { name: 'Door Strike', channel: 1, active: false }, dps: { name: 'Door Position', channel: 1, active: false }, rexIn: { name: 'REX Button', channel: 5, active: false }, ios: [], readers: { in: 'reader2', out: null } },
    { id: 3, name: 'Side Door', enabled: false, lock: { name: 'Door Strike', channel: 2, active: false }, dps: { name: 'Door Position', channel: 2, active: false }, rexIn: { name: 'REX Button', channel: 6, active: false }, ios: [], readers: { in: null, out: null } },
    { id: 4, name: 'Elevator', enabled: false, lock: { name: 'Door Strike', channel: 3, active: false }, dps: { name: 'Door Position', channel: 3, active: false }, rexIn: { name: 'REX Button', channel: 7, active: false }, ios: [], readers: { in: null, out: null } }
  ]);
  /** ---------- Wiegand ---------- */
  const [wiegandReaders, setWiegandReaders] = useState<WiegandReader[]>([]);
  const [wiegandStatus, setWiegandStatus] = useState<any>(null);
  const [selectedReaderId, setSelectedReaderId] = useState<string>('');
  /** ---------- Emulation ---------- */
  const [isEmulating, setIsEmulating] = useState(false);
  const [repeatCount, setRepeatCount] = useState(1);
  /** ---------- Logs ---------- */
  const [auditLog, setAuditLog] = useState<LogEntry[]>([]);
  const [emulationLog, setEmulationLog] = useState<LogEntry[]>([]);
  const [systemLog, setSystemLog] = useState<SystemLogEntry[]>([]);
  /** ---------- Logging helpers ---------- */
  const now = () => new Date().toLocaleString();
  const logAudit = (message: string) => setAuditLog(prev => [{ time: now(), message }, ...prev].slice(0, 200));
  const logEmulation = (message: string) => setEmulationLog(prev => [{ time: now(), message }, ...prev].slice(0, 200));
  const logSystem = (type: SystemLogEntry['type'], message: string) =>
    setSystemLog(prev => [{ time: now(), timestamp: Date.now(), type, message }, ...prev].slice(0, 300));
  /** ---------- API fetchers ---------- */
  const fetchWiegandReaders = async () => {
    if (!connected) return;
    try {
      const data = await fetchJson(`http://${ipAddress}:3001/api/wiegand/readers`);
      if ((data as any).success) {
        const readers: WiegandReader[] = (data as any).readers || [];
        setWiegandReaders(readers);
        const firstEnabled = readers.find(r => r.enabled);
        if (firstEnabled && !selectedReaderId) setSelectedReaderId(firstEnabled.id);
        logSystem('success', `Loaded ${readers.length} Wiegand readers`);
      }
    } catch (e) {
      console.error(e);
      logSystem('error', 'Failed to load Wiegand readers');
    }
  };
  // ── #1 SOURCE FIX: fetch OSDP readers and merge them into the SHARED
  //    readerPool so they appear everywhere the pool is used (Doors event
  //    steps, reader assignment, etc). Previously nothing fetched
  //    /api/osdp/readers into readerPool, so ACM0/ACM1/AMA0 OSDP readers
  //    never showed up in Doors. Mirrors EmulationSection's loader.
  //    De-dupes by id and preserves any existing Wiegand assignments.
  const fetchOsdpReadersIntoPool = async () => {
    if (!connected) return;
    try {
      const data = await fetchJson(`http://${ipAddress}:3001/api/osdp/readers`);
      if (!(data as any).success) return;
      const raw = (data as any).readers;
      const list: any[] = Array.isArray(raw) ? raw : Object.values(raw || {});
      const osdpReaders: Reader[] = list.map((r: any) => ({
        id: r.id || `osdp-${r.address}`,
        name: r.name || `OSDP ${r.address}${r.serialPort ? ` (${String(r.serialPort).replace('/dev/', '')})` : ''}`,
        type: 'osdp',
        enabled: r.enabled !== false,
        address: r.address,
        assignedToDoor: r.door ?? null,
        position: 'in',
      }));
      if (osdpReaders.length === 0) return;
      setReaderPool(prev => {
        // Drop any prior osdp-type entries, keep wiegand/others, then append fresh.
        const nonOsdp = prev.filter(p => p.type !== 'osdp');
        const seen = new Set(nonOsdp.map(p => p.id));
        const merged = [...nonOsdp];
        for (const o of osdpReaders) {
          if (!seen.has(o.id)) { merged.push(o); seen.add(o.id); }
        }
        return merged;
      });
      logSystem('success', `Loaded ${osdpReaders.length} OSDP readers`);
    } catch (e) {
      console.error(e);
      logSystem('error', 'Failed to load OSDP readers');
    }
  };
  const fetchWiegandStatus = async () => {
    if (!connected) return;
    try {
      const data = await fetchJson(`http://${ipAddress}:3001/api/wiegand/status`);
      if ((data as any).success) {
        setWiegandStatus((data as any).status);
        if (!((data as any).status?.initialized)) logSystem('warn', 'Wiegand system not initialized');
      }
    } catch (e) {
      console.error(e);
    }
  };
  /** ---------- Connection ---------- */
  const handleConnect = async () => {
    if (!connected) {
      try {
        const r = await fetch(`http://${ipAddress}:3001/api/health`);
        if (r.ok) {
          setConnected(true);
          logSystem('success', `Connected to ${ipAddress}`);
          fetchWiegandReaders();
          fetchOsdpReadersIntoPool();   // #1 source fix: merge OSDP readers into the shared pool
          fetchWiegandStatus();
        } else {
          logSystem('error', `Health check failed for ${ipAddress}`);
        }
      } catch {
        logSystem('error', `Failed to connect to ${ipAddress}`);
      }
    } else {
      setConnected(false);
      logSystem('info', 'Disconnected');
    }
  };
  /** ---------- IO toggles ---------- */
  const toggleInput = async (id: number) => {
    if (!connected) return;
    const item = inputs.find(i => i.id === id);
    if (!item) return;
    const newState = !item.active;
    
    const restingState = item.restingState || 'NO';
    const gpioValue = restingState === 'NO' 
      ? (newState ? 1 : 0)
      : (newState ? 0 : 1);
    
    await postGpio(ipAddress, item.channel, gpioValue);
    setInputs(prev => prev.map(i => i.id === id ? { ...i, active: newState } : i));
    logSystem('io', `${item.name} (Channel ${item.channel}, ${restingState}) ${newState ? 'ACTIVATED' : 'DEACTIVATED'} [GPIO=${gpioValue}]`);
  };
  const toggleOutput = async (id: number) => {
    if (!connected) return;
    const item = outputs.find(o => o.id === id);
    if (!item) return;
    const newState = !item.active;
    await postGpio(ipAddress, item.channel, newState ? 1 : 0);
    setOutputs(prev => prev.map(o => o.id === id ? { ...o, active: newState } : o));
    logSystem('io', `${item.name} (Channel ${item.channel}) ${newState ? 'ENGAGED' : 'RELEASED'}`);
  };
  const toggleControllerOutput = async (id: number) => {
    if (!connected) return;
    const item = controllerOutputs.find(o => o.id === id);
    if (!item) return;
    // Emulated-board outputs (id >= 100) are driven by the controller over OSDP;
    // they must never switch the HAT's relays.
    if (id >= 100) return;
    const newState = !item.active;
    await postGpio(ipAddress, item.channel, newState ? 1 : 0);
    setControllerOutputs(prev => prev.map(o => o.id === id ? { ...o, active: newState } : o));
    logSystem('io', `${item.name} (Channel ${item.channel}) ${newState ? 'ENGAGED' : 'RELEASED'}`);
  };
  /** ---------- Config functions ---------- */
  const updateInputField = async (id: number, field: keyof InputItem, value: any) => {
    const input = inputs.find(i => i.id === id);
    if (!input) return;
    
    setInputs(prev => prev.map(i => i.id === id ? { ...i, [field]: value } as InputItem : i));
    logAudit(`Modified Input ${id}: ${String(field)} = ${value}`);
    
    if (field === 'restingState' && connected) {
      const newRestingState = value as 'NO' | 'NC';
      const currentActive = input.active;
      const gpioValue = newRestingState === 'NO' 
        ? (currentActive ? 1 : 0)
        : (currentActive ? 0 : 1);
      
      await postGpio(ipAddress, input.channel, gpioValue);
      logSystem('io', `${input.name} (Channel ${input.channel}) resting state changed to ${newRestingState}, GPIO updated to ${gpioValue}`);
    }
  };
  const updateOutputField = (id: number, field: keyof OutputItem, value: any) => {
    setOutputs(prev => prev.map(o => o.id === id ? { ...o, [field]: value } as OutputItem : o));
    logAudit(`Modified Output ${id}: ${String(field)} = ${value}`);
  };
  /** ---------- WebSocket Connection ---------- */
  useEffect(() => {
    if (!connected) return;
    const newSocket = io(`http://${ipAddress}:3001`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });
    newSocket.on('connect', () => {
      console.log('[WebSocket] Connected to backend');
      // NOTE: We no longer poll all inputs on connect to avoid I2C bus saturation
      // Input states will update via WebSocket 'input_state_change' events from backend
    });
    newSocket.on('disconnect', () => {
      console.log('[WebSocket] Disconnected from backend');
    });
    newSocket.on('input_state_change', (data: { 
      type: 'opto' | 'analog'; 
      pin: number; 
      state: number; 
      voltage?: number;
      supervisionState?: string;
      timestamp: number 
    }) => {
      console.log('[WebSocket] Input state change:', data);
      
      const channel = data.pin;
      
      setOutputs(prev => prev.map(output => {
        if (output.channel !== channel) return output;
        
        const outputInputType = output.inputType || 'opto';
        if (data.type !== outputInputType) return output;
        
        let newActive = output.active;
        let newSupervisionState: 'normal' | 'active' | 'trouble' | 'short' = output.supervisionState || 'normal';
        const gpioValue = data.state;
        
        if (data.type === 'analog' && (output.supervisionType === 'Supervised-NO' || output.supervisionType === 'Supervised-NC')) {
          const apiState = (data.supervisionState || 'NORMAL').toUpperCase();
          if (apiState === 'ALARM') { newSupervisionState = 'active'; newActive = true; }
          else if (apiState === 'TAMPER') { newSupervisionState = 'short'; newActive = true; }
          else if (apiState === 'TROUBLE') { newSupervisionState = 'trouble'; newActive = false; }
          else { newSupervisionState = 'normal'; newActive = false; }
        } else if (output.supervisionType === 'Supervised-NO' || output.supervisionType === 'Supervised-NC') {
          newSupervisionState = gpioValue === 1 ? 'active' : 'normal';
          newActive = newSupervisionState === 'active';
        } else {
          newActive = output.supervisionType === 'NC' ? gpioValue === 0 : gpioValue === 1;
        }
        
        return { ...output, active: newActive, supervisionState: newSupervisionState };
      }));
    });
    // ── Controller Emulator live I/O sync ────────────────────────────
    // Merges live emulated-board I/O into the controllerOutputs / controllerInputs
    // arrays. Live items have id = address*100 + ioIndex, so they never collide
    // with the static fallback (ids 1..4).
    const buildIoFromDevices = (devices: any[]) => {
      const liveOuts: OutputItem[] = [];
      const liveIns:  InputItem[]  = [];
      for (const dev of devices || []) {
        const addr  = dev.address;
        const model = dev.model || '?';
        const nOut  = dev.numOutputs || 0;
        const nIn   = dev.numInputs  || 0;
        for (let i = 0; i < nOut; i++) {
          liveOuts.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} — Output ${i}`,
            type: 'None',
            channel: i,
            active: !!(dev.outputs && dev.outputs[i]),
          } as OutputItem);
        }
        for (let i = 0; i < nIn; i++) {
          liveIns.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} — Input ${i}`,
            type: 'General',
            channel: i,
            active: !!(dev.inputs && dev.inputs[i]),
            restingState: 'NO',
          } as InputItem);
        }
      }
      // Keep the 4 static fallback entries (ids 1..4); replace any live ones.
      setControllerOutputs(prev => {
        const staticOnly = prev.filter(o => o.id < 100);
        return [...staticOnly, ...liveOuts].sort((a, b) => a.id - b.id);
      });
      setControllerInputs(liveIns.sort((a, b) => a.id - b.id));
    };
    const refetchEmulatorStatus = async () => {
      try {
        const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
        const j = await r.json();
        if (j.success && j.status) buildIoFromDevices(j.status.devices || []);
      } catch (e) { /* emulator may be stopped — that's OK */ }
    };
    // Initial sync (in case the emulator is already running when we connect)
    refetchEmulatorStatus();
    newSocket.on('emulator-started',        refetchEmulatorStatus);
    newSocket.on('emulator-config-applied', refetchEmulatorStatus);
    newSocket.on('emulator-device-added',   refetchEmulatorStatus);
    newSocket.on('emulator-device-removed', refetchEmulatorStatus);
    newSocket.on('emulator-stopped', () => {
      // Drop live entries on stop; keep the static 4 fallback outputs.
      setControllerOutputs(prev => prev.filter(o => o.id < 100));
      setControllerInputs([]);
    });
    newSocket.on('emulator-device-update', (dev: any) => {
      if (!dev || dev.address == null) return;
      const addr  = dev.address;
      const model = dev.model || '?';
      setControllerOutputs(prev => {
        const others = prev.filter(o => o.id < 100 || Math.floor(o.id / 100) !== addr);
        const mine: OutputItem[] = [];
        for (let i = 0; i < (dev.numOutputs || 0); i++) {
          mine.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} — Output ${i}`,
            type: 'None', channel: i,
            active: !!(dev.outputs && dev.outputs[i]),
          } as OutputItem);
        }
        return [...others, ...mine].sort((a, b) => a.id - b.id);
      });
      setControllerInputs(prev => {
        const others = prev.filter(o => Math.floor(o.id / 100) !== addr);
        const mine: InputItem[] = [];
        for (let i = 0; i < (dev.numInputs || 0); i++) {
          mine.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} — Input ${i}`,
            type: 'General', channel: i,
            active: !!(dev.inputs && dev.inputs[i]),
            restingState: 'NO',
          } as InputItem);
        }
        return [...others, ...mine].sort((a, b) => a.id - b.id);
      });
    });
    setSocket(newSocket);
    return () => {
      newSocket.disconnect();
      setSocket(null);
    };
  }, [connected, ipAddress]);
  // Sync external IP when ClusterManager changes it (e.g. user renames the node IP in sidebar)
  useEffect(() => {
    if (externalIp) setIpAddress(externalIp);
  }, [externalIp]);
  // Report connection changes back to ClusterManager
  useEffect(() => {
    if (nodeId && onConnectionChange) {
      onConnectionChange(nodeId, connected);
    }
  }, [connected, nodeId, onConnectionChange]);
  // Load saved config on mount: the copy on the Pi wins; the browser copy is the fallback
  useEffect(() => {
    const apply = (config: any) => {
      if (config.outputs) setOutputs(config.outputs);
      if (config.inputs) setInputs(config.inputs);
      if (config.controllerOutputs) setControllerOutputs(config.controllerOutputs.filter((o: any) => o.id < 100));
      if (config.readerPool) setReaderPool(config.readerPool);
      if (config.credentialLibrary) setCredentialLibrary(config.credentialLibrary);
    };
    let local: any = null;
    try { const raw = localStorage.getItem(storageKey); if (raw) local = JSON.parse(raw); } catch (e) { console.error('Failed to load system config:', e); }
    if (local) apply(local);
    fetch(`http://${ipAddress}:3001/api/config/app`).then(r => r.json()).then(j => {
      if (j?.success && j.config) apply(j.config);
    }).catch(() => { /* backend offline: keep the browser copy */ });
  }, [storageKey, ipAddress]);
  /** ---------- UI ---------- */
  const reportsPanel = (
      <Reports
        apiUrl={`http://${ipAddress}:3001`}
        auditLog={auditLog}
        emulationLog={emulationLog}
        systemLog={systemLog}
        onClearAudit={() => {
          setAuditLog([]);
          logSystem('info', 'Audit log cleared');
        }}
        onClearEmulation={() => {
          setEmulationLog([]);
          logSystem('info', 'Emulation log cleared');
        }}
        onClearSystem={() => {
          setSystemLog([]);
          logSystem('info', 'System log cleared');
        }}
      />
  );
  const NAV: NavItem[] = [
    { id: 'access-control', label: 'Access Control', icon: <Building2 size={20} />, children: [
      { id: 'control', label: 'Controls', badge: <NavBadge>{inputs.length + outputs.length}</NavBadge> },
      { id: 'doors', label: 'Doors', badge: <NavBadge>{doors.filter(d => d.enabled).length}</NavBadge> },
      { id: 'elevator', label: 'Elevator' },
    ] },
    { id: 'readers', label: 'Readers', icon: <Radio size={20} />, children: READER_PAGES
        .filter(r => r.id !== 'nfc' || READER_FEATURES.NFC)
        .map(r => ({ ...r, badge: r.id === 'osdp' && readerStats ? <NavBadge>{readerStats.osdp.connected}</NavBadge>
          : r.id === 'wiegand' && readerStats ? <NavBadge>{readerStats.wiegand.readers}</NavBadge> : undefined })) },
    { id: 'emulation', label: 'Emulation', icon: <PlayCircle size={20} />,
      badge: isEmulating ? <span className="ml-auto h-5 px-2 rounded-full bg-hv-success/15 text-hv-success-fg text-[11px] leading-5 font-semibold">Running</span> : undefined },
    // Automation stays hidden from navigation (its render block below is kept).
    { id: 'controller-emulator', label: 'Controller Emulator', icon: <Cpu size={20} /> },
    { id: 'setup', label: 'Setup', icon: <Settings size={20} />, children: SETUP_TABS.map(t => ({ id: t.id, label: t.label })) },
    { id: 'tools', label: 'Tools', icon: <Wrench size={20} />, children: TOOL_TABS.map(t => ({ id: t.id, label: t.label })) },
    { id: 'reports', label: 'Reports', icon: <FileText size={20} /> },
  ];
  const navLabel = NAV.find(n => n.id === activeTab)?.label ?? 'Automation';
  const activeChild: string | undefined =
    activeTab === 'access-control' ? activeAccessControlTab
    : activeTab === 'readers' ? readersPage
    : activeTab === 'setup' ? setupPage
    : activeTab === 'tools' ? toolsPage : undefined;
  const subLabel = activeChild ? NAV.find(n => n.id === activeTab)?.children?.find(c => c.id === activeChild)?.label : undefined;
  const pageDescription: string | undefined =
    activeTab === 'access-control'
      ? ({ control: 'System inputs, outputs and controller GPIO', doors: 'Door simulation: locks, position and request-to-exit', elevator: 'Floor access control: relays and floor selection' } as const)[activeAccessControlTab]
    : activeTab === 'readers'
      ? ({
          osdp: readerStats ? `${readerStats.osdp.connected}/${readerStats.osdp.total} active${readerStats.osdp.serialOpen ? ' · RS-485 open' : ''}` : 'OSDP reader emulation and maintenance',
          trace: 'Decoded OSDP traffic between the controller and readers',
          wiegand: readerStats ? `${readerStats.wiegand.active} of ${readerStats.wiegand.readers} readers enabled` : 'Wiegand reader emulation',
          formats: 'Build and analyze card formats for OSDP and Wiegand',
          nfc: 'PN532 NFC reader',
        } as Record<ReadersPage, string>)[readersPage]
    : activeTab === 'setup' ? SETUP_TABS.find(t => t.id === setupPage)?.description
    : activeTab === 'tools' ? TOOL_TABS.find(t => t.id === toolsPage)?.description
    : activeTab === 'reports' ? 'Audit, system and emulation logs, and log analytics'
    : undefined;
  const pageTitle = subLabel ?? (activeTab === 'reports' ? 'Reports' : undefined);
  const crumbs = ['Aether', ...(nodeLabel ? [nodeLabel] : []), navLabel, ...(subLabel ? [subLabel] : [])];
  return (
    <div className="min-h-screen flex flex-col bg-hv-surface text-hv-text">
      <TopBar
        onToggleNav={toggleNav}
        navCollapsed={navCollapsed}
        title="Aether"
        version="v1.5"
        subtitle="Access Emulation Testing Hardware Evaluation Resource"
        cluster={cluster}
      >
        <label htmlFor={`node-ip-${nodeId ?? 'local'}`} className="text-xs text-hv-text-3 hidden md:inline">Node IP</label>
        <input
          id={`node-ip-${nodeId ?? 'local'}`}
          type="text"
          placeholder="localhost"
          value={ipAddress}
          onChange={(e) => { if (!externalIp) setIpAddress(e.target.value); }}
          disabled={connected || !!externalIp}
          title={externalIp ? 'IP is managed by the Cluster Manager' : undefined}
          className="h-8 w-40 px-3 rounded-hv-xs border border-hv-line-strong bg-hv-contrast/[0.04] text-sm font-mono text-hv-text placeholder:text-hv-text-3 focus:outline-none focus:border-hv-info disabled:opacity-60"
        />
        <span className={`h-6 inline-flex items-center gap-1.5 px-2.5 rounded-full text-xs font-medium ${connected ? 'bg-hv-success/15 text-hv-success-fg' : 'bg-hv-contrast/5 text-hv-text-3'}`}>
          <StatusDot on={connected} />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
        <button
          onClick={handleConnect}
          className={`h-8 min-w-[80px] px-4 rounded-hv-xs text-sm font-semibold inline-flex items-center justify-center gap-2 ${
            connected ? 'bg-hv-contrast/15 hover:bg-hv-contrast/20 text-hv-text' : 'bg-hv-brand hover:bg-hv-brand-hover text-[#FFFFFF]'
          }`}
        >
          {connected ? <WifiOff size={16} /> : <Wifi size={16} />}
          {connected ? 'Disconnect' : 'Connect'}
        </button>
      </TopBar>
      <div className="flex flex-1 min-h-0">
        <SideNav
          items={NAV}
          active={activeTab}
          activeChild={activeChild}
          collapsed={navCollapsed}
          onSelect={(id, child) => {
            setActiveTab(id as any);
            if (!child) return;   // parent click: reopen the section's last page
            if (id === 'access-control') setActiveAccessControlTab(child as any);
            if (id === 'readers') { setReadersPage(child as ReadersPage); rememberPage('aether.readers.tab', child); }
            if (id === 'setup') { setSetupPage(child as SetupId); rememberPage('aether.config.tab', child); }
            if (id === 'tools') { setToolsPage(child as ToolId); rememberPage('aether.tools.tab', child); }
          }}
        />
        <main className="flex-1 min-w-0 p-6">
          <PageHeader
            crumbs={crumbs}
            title={pageTitle}
            description={pageDescription}
          />
      <div className="max-w-[1800px] mx-auto">
        {/* ACCESS CONTROL MODULES TAB */}
        {activeTab === 'access-control' && (
          <div className="space-y-6">
            {/* CONTROLS SUB-TAB */}
            {activeAccessControlTab === 'control' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  {/* Inputs */}
                  <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgb(var(--hv-widget) / 0.55)', borderColor: 'rgb(var(--hv-line))' }}>
                    <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                      <div className="w-3 h-3 bg-hv-brand rounded-full animate-pulse" />
                      Input Group (Relay Outputs)
                    </h2>
                    <div className="space-y-3">
                      {inputs.map(input => (
                        <div key={input.id} className="rounded-lg p-4 border" style={{ background: 'rgb(var(--hv-surface) / 0.5)', borderColor: 'rgb(var(--hv-popup-panel))' }}>
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-3">
                                <div className={`w-4 h-4 rounded-full ${input.active ? 'bg-hv-success shadow-lg shadow-hv-success/40' : 'bg-hv-line-strong'}`} />
                                <div>
                                  <div className="font-semibold">{input.name}</div>
                                  <div className="text-xs text-hv-text-3">
                                    Channel {input.channel} • {input.type}
                                    {input.restingState && (
                                      <span className="ml-2 px-2 py-0.5 bg-hv-brand/15 rounded text-hv-brand-text">
                                        {input.restingState}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <button
                              onClick={() => toggleInput(input.id)}
                              disabled={!connected}
                              className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                                input.active ? 'bg-hv-success-tint text-hv-success-fg ring-1 ring-inset ring-hv-success/40 hover:bg-hv-success-tint-strong' : 'bg-hv-popup-panel hover:bg-hv-box'
                              } disabled:opacity-30 disabled:cursor-not-allowed`}
                            >
                              {input.active ? 'ACTIVE' : 'INACTIVE'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Outputs */}
                  <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgb(var(--hv-widget) / 0.55)', borderColor: 'rgb(var(--hv-line))' }}>
                    <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                      <div className="w-3 h-3 bg-hv-info rounded-full animate-pulse" />
                      Output Group (Monitoring Inputs)
                    </h2>
                    <div className="space-y-3">
                      {outputs.map(output => {
                        const isSupervised = output.supervisionType === 'Supervised-NO' || output.supervisionType === 'Supervised-NC';
                        const supervisionState = output.supervisionState || 'normal';
                        
                        const stateColors = {
                          normal: 'bg-hv-popup-panel text-hv-text-2',
                          active: 'bg-hv-success-strong/40 text-hv-success-text',
                          trouble: 'bg-hv-brand-hover/40 text-hv-brand-text',
                          short: 'bg-hv-error-strong/40 text-hv-error-text'
                        };
                        
                        const indicatorColors = {
                          normal: 'bg-hv-line-strong',
                          active: 'bg-hv-success shadow-lg shadow-hv-success/40',
                          trouble: 'bg-hv-warning shadow-lg shadow-hv-warning/40',
                          short: 'bg-hv-error shadow-lg shadow-hv-error/40'
                        };
                        
                        return (
                          <div key={output.id} className="rounded-lg p-4 border" style={{ background: 'rgb(var(--hv-surface) / 0.5)', borderColor: 'rgb(var(--hv-popup-panel))' }}>
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-3">
                                  <div className={`w-4 h-4 rounded-full ${
                                    isSupervised 
                                      ? indicatorColors[supervisionState]
                                      : (output.active ? 'bg-hv-success shadow-lg shadow-hv-success/40' : 'bg-hv-line-strong')
                                  }`} />
                                  <div>
                                    <div className="font-semibold">{output.name}</div>
                                    <div className="text-xs text-hv-text-3">
                                      Channel {output.channel} • {output.type}
                                      {output.inputType && (
                                        <span className="ml-2 px-2 py-0.5 bg-hv-info/15 rounded text-hv-info-text">
                                          {output.inputType === 'opto' ? 'Opto' : 'Analog 0-10V'}
                                        </span>
                                      )}
                                      {output.supervisionType && (
                                        <span className="ml-2 px-2 py-0.5 bg-hv-info/15 rounded text-hv-info-text">
                                          {output.supervisionType}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className={`px-4 py-2 rounded-lg font-semibold ${
                                isSupervised 
                                  ? stateColors[supervisionState]
                                  : (output.active ? 'bg-hv-success-strong/40 text-hv-success-text' : 'bg-hv-popup-panel text-hv-text-3')
                              }`}>
                                {isSupervised 
                                  ? supervisionState.toUpperCase()
                                  : (output.active ? 'TRIGGERED' : 'WAITING')
                                }
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {/* Controller Outputs */}
                <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgb(var(--hv-widget) / 0.55)', borderColor: 'rgb(var(--hv-line))' }}>
                  <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                    <div className="w-3 h-3 bg-hv-info rounded-full animate-pulse" />
                    Controller Aux Outputs
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    {controllerOutputs.filter(o => o.id < 100).map(output => (
                      <div key={output.id} className="rounded-lg p-4 border" style={{ background: 'rgb(var(--hv-surface) / 0.5)', borderColor: 'rgb(var(--hv-popup-panel))' }}>
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              <div className={`w-4 h-4 rounded-full ${output.active ? 'bg-hv-info shadow-lg shadow-hv-info/40' : 'bg-hv-line-strong'}`} />
                              <div>
                                <div className="font-semibold">{output.name}</div>
                                <div className="text-xs text-hv-text-3">Channel {output.channel} • {output.type}</div>
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={() => toggleControllerOutput(output.id)}
                            disabled={!connected}
                            className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                              output.active ? 'bg-hv-brand hover:bg-hv-brand-hover' : 'bg-hv-popup-panel hover:bg-hv-box'
                            } disabled:opacity-30 disabled:cursor-not-allowed`}
                          >
                            {output.active ? 'TRIGGERED' : 'IDLE'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Emulated downstream boards: inputs sent over OSDP, outputs driven by the controller */}
                <EmulatedBoardsSection ipAddress={ipAddress} connected={connected} socket={socket} logSystem={logSystem} />
              </div>
            )}
            {/* ✅ DOORS SUB-TAB - Now using extracted DoorSection component with corrected I/O architecture */}
            {activeAccessControlTab === 'doors' && (
              <DoorSection
                ipAddress={ipAddress}
                connected={connected}
                socket={socket}
                readerPool={readerPool}
                credentialLibrary={credentialLibrary}
                onUpdateReaderPool={setReaderPool}
                onLog={logSystem}
                onAuditLog={logAudit}
              />
            )}
            {/* ELEVATOR SUB-TAB */}
            {activeAccessControlTab === 'elevator' && (
              <ElevatorSection 
                socket={socket}
                backendUrl={`http://${ipAddress}:3001`}
                onFloorAccess={(floor, reader, granted) => {
                  logAudit(`Elevator Floor ${floor}: Access ${granted ? 'GRANTED' : 'DENIED'} via ${reader}`);
                  logSystem(granted ? 'success' : 'error', `Elevator Floor ${floor} access ${granted ? 'granted' : 'denied'}`);
                }}
              />
            )}
          </div>
        )}
        {/* READERS TAB */}
        {activeTab === 'readers' && (
          <ReadersSection 
            page={readersPage}
            onStats={setReaderStats}
            ipAddress={ipAddress}
            connected={connected}
            readerPool={readerPool}                           
            credentialLibrary={credentialLibrary}            
            onUpdateReaderPool={setReaderPool}              
            onUpdateCredentialLibrary={setCredentialLibrary} 
            onLog={(msg) => logSystem('info', msg)}
            onAuditLog={(msg) => logAudit(msg)}
            onEmulationLog={(msg) => logEmulation(msg)}
          />
        )}
        {/* EMULATION TAB */}
        {/* EMULATION stays mounted while you visit other pages: a workflow run lives
            inside this component, so unmounting it orphaned the run (Stop could no
            longer reach it) and cancelled scheduled runs. It is only hidden. */}
        <div hidden={activeTab !== 'emulation'}>
          <EmulationSection
            active={activeTab === 'emulation'}
            ipAddress={ipAddress}
            connected={connected}
            inputs={inputs}
            outputs={outputs}
            controllerOutputs={controllerOutputs}
            controllerInputs={controllerInputs}
            doors={doors}
            repeatCount={repeatCount}
            setRepeatCount={setRepeatCount}
            isEmulating={isEmulating}
            setIsEmulating={setIsEmulating}
            logEmulation={logEmulation}
            logSystem={logSystem}
            postGpio={postGpio}
          />
        </div>
        {/* AUTOMATION TAB — hidden from the tab bar; kept so it can be restored */}
        {activeTab === 'automation' && (
          <AutomationSection
            ipAddress={ipAddress}
            connected={connected}
            inputs={inputs}
            outputs={outputs}
            controllerOutputs={controllerOutputs}
            logSystem={logSystem}
          />
        )}
        {/* CONTROLLER EMULATOR TAB */}
        {activeTab === 'controller-emulator' && (
          <ControllerEmulatorSection
            ipAddress={ipAddress}
            connected={connected}
            logSystem={logSystem}
          />
        )}
        {/* REPORTS — its own GNB item (AETHER-GNB-2DEPTH) */}
        {activeTab === 'reports' && reportsPanel}
        {/* SETUP and TOOLS — configuration pages and the hands-on tools, page picked in the GNB */}
        {(activeTab === 'setup' || activeTab === 'tools') && (
          <ConfigSection
            mode={activeTab}
            page={activeTab === 'setup' ? setupPage : toolsPage}
            eolPanel={<EOLCalibrationSection ipAddress={ipAddress} connected={connected} logSystem={logSystem} logAudit={logAudit} />}
            toolPanels={{
              // Board Blueprint Studio: a standalone page (frontend/public). It fills the
              // panel's width (beside the cluster sidebar) and may go full screen.
              blueprint: (
                <div style={{ width: '100%', height: 'calc(100vh - 210px)', minHeight: 560 }}>
                  <iframe src="/board-blueprint-studio.html?v=3fa31dbd" title="Board Blueprint Studio" allowFullScreen
                    style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, display: 'block', background: 'rgb(var(--hv-surface))' }} />
                </div>
              ),
              switch: <SwitchSection ipAddress={ipAddress} connected={connected} socket={socket} logSystem={logSystem} logAudit={logAudit} />,
              // The console builder breaks out to full viewport width on purpose:
              // it is an iframe with its own layout and the page gutters crop it.
              oncafe: (
                <div style={{ width: '100%', height: 'calc(100vh - 210px)' }}>
                  <iframe src="/oncafe-console-builder.html?v=aa79712a" title="OnCafe Console Builder"
                    style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />
                </div>
              ),
              stream: <StreamToolPanel ipAddress={ipAddress} />,
            }}
            inputs={inputs}
            outputs={outputs}
            controllerOutputs={controllerOutputs}
            onUpdateInput={updateInputField}
            onUpdateOutput={updateOutputField}
            onUpdateControllerOutput={(id, field, value) => {
              setControllerOutputs(prev => 
                prev.map(o => o.id === id ? { ...o, [field]: value } as OutputItem : o)
              );
              logAudit(`Modified Controller Output ${id}: ${String(field)} = ${value}`);
            }}
            onSaveConfig={async () => {
              try {
                const config = {
                  version: '3.0',
                  timestamp: new Date().toISOString(),
                  inputs,
                  outputs,
                  controllerOutputs,
                  readerPool,
                  credentialLibrary
                };
                const cfg = { ...config, controllerOutputs: controllerOutputs.filter(o => o.id < 100) };
                localStorage.setItem(storageKey, JSON.stringify(cfg));
                const r = await fetch(`http://${ipAddress}:3001/api/config/app`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
                if (!r.ok) throw new Error(`the Pi answered HTTP ${r.status}`);
                logSystem('success', 'System configuration saved to the Pi');
                logAudit('Saved complete system configuration');
              } catch (e: any) {
                logSystem('error', `Failed to save configuration: ${e.message}`);
                throw e;
              }
            }}
            onLoadConfig={() => {
              try {
                const savedConfig = localStorage.getItem(storageKey);
                if (!savedConfig) {
                  logSystem('warn', 'No saved configuration found');
                  return;
                }
                const config = JSON.parse(savedConfig);
                if (config.inputs) setInputs(config.inputs);
                if (config.outputs) setOutputs(config.outputs);
                if (config.controllerOutputs) setControllerOutputs(config.controllerOutputs);
                if (config.readerPool) setReaderPool(config.readerPool);
                if (config.credentialLibrary) setCredentialLibrary(config.credentialLibrary);
                logSystem('success', `Configuration loaded (v${config.version || '1.0'})`);
                logAudit('Loaded complete system configuration');
              } catch (e: any) {
                logSystem('error', `Failed to load configuration: ${e.message}`);
              }
            }}
            onResetConfig={() => {
              if (!confirm('Reset all I/O configurations to defaults?')) return;
              setInputs([
                { id: 1, name: 'Device Input 1', type: 'REX-Button', channel: 0, active: false, restingState: 'NO' },
                { id: 2, name: 'Device Input 2', type: 'REX-Button', channel: 1, active: false, restingState: 'NO' },
                { id: 3, name: 'Device Input 3', type: 'REX-Button', channel: 2, active: false, restingState: 'NO' },
                { id: 4, name: 'Device Input 4', type: 'REX-Button', channel: 3, active: false, restingState: 'NO' },
                { id: 5, name: 'Device Input 5', type: 'Entry Sensor', channel: 4, active: false, restingState: 'NO' },
                { id: 6, name: 'Device Input 6', type: 'Safety Beam', channel: 5, active: false, restingState: 'NO' },
                { id: 7, name: 'Device Input 7', type: 'General', channel: 6, active: false, restingState: 'NO' },
                { id: 8, name: 'Device Input 8', type: 'General', channel: 7, active: false, restingState: 'NO' }
              ]);
              setOutputs([
                { id: 1, name: 'Device Output 1', type: 'Strike Follower', channel: 0, active: false, inputType: 'opto' },
                { id: 2, name: 'Device Output 2', type: 'Strike Follower', channel: 1, active: false, inputType: 'opto' },
                { id: 3, name: 'Device Output 3', type: 'Strike Follower', channel: 2, active: false, inputType: 'opto' },
                { id: 4, name: 'Device Output 4', type: 'Strike Follower', channel: 3, active: false, inputType: 'opto' },
                { id: 5, name: 'Device Output 5', type: 'Sounder', channel: 4, active: false, inputType: 'opto' },
                { id: 6, name: 'Device Output 6', type: 'Strobe', channel: 5, active: false, inputType: 'opto' },
                { id: 7, name: 'Device Output 7', type: 'General', channel: 6, active: false, inputType: 'opto' },
                { id: 8, name: 'Device Output 8', type: 'General', channel: 7, active: false, inputType: 'opto' }
              ]);
              setControllerOutputs([
                { id: 1, name: 'Controller Output 1', type: 'None', channel: 0, active: false },
                { id: 2, name: 'Controller Output 2', type: 'None', channel: 1, active: false },
                { id: 3, name: 'Controller Output 3', type: 'None', channel: 2, active: false },
                { id: 4, name: 'Controller Output 4', type: 'None', channel: 3, active: false }
              ]);
              logSystem('warn', 'I/O Configuration reset to defaults');
              logAudit('Reset I/O configuration to factory defaults');
            }}
            onExportConfig={() => {
              try {
                const config = {
                  version: '3.0',
                  timestamp: new Date().toISOString(),
                  inputs,
                  outputs,
                  controllerOutputs,
                  readerPool,
                  credentialLibrary
                };
                const dataStr = JSON.stringify(config, null, 2);
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(dataBlob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `aether-config-${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                logSystem('success', 'Configuration exported successfully');
                logAudit('Exported system configuration');
              } catch (e: any) {
                logSystem('error', `Failed to export configuration: ${e.message}`);
              }
            }}
            onImportConfig={(file) => {
              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const config = JSON.parse(e.target?.result as string);
                  if (config.inputs) setInputs(config.inputs);
                  if (config.outputs) setOutputs(config.outputs);
                  if (config.controllerOutputs) setControllerOutputs(config.controllerOutputs);
                  if (config.readerPool) setReaderPool(config.readerPool);
                  if (config.credentialLibrary) setCredentialLibrary(config.credentialLibrary);
                  logSystem('success', `Configuration imported from ${file.name}`);
                  logAudit(`Imported configuration from ${file.name}`);
                } catch (e: any) {
                  logSystem('error', `Failed to import configuration: ${e.message}`);
                }
              };
              reader.readAsText(file);
            }}
          />
        )}
        </div>
        </main>
      </div>
    </div>
  );
};
export default IOAccessEmulator;
