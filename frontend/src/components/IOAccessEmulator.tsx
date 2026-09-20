import React, { useEffect, useMemo, useState } from 'react';
import { Wifi, WifiOff, Activity, Settings, FileText, PlayCircle, Circle, Radio, Building2, Cpu, Cloud, Terminal, Monitor, Network, Wrench } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import OSDPSection from './OSDPSection';
import ReadersSection from './ReadersSection';
import ElevatorSection from './ElevatorSection';
import EmulationSection from './EmulationSection';
import AutomationSection from './AutomationSection';
import ControllerEmulatorSection from './ControllerEmulatorSection';
import DoorSection from './DoorSection';  // ✅ NEW: Extracted Door Section with corrected I/O architecture
import OSDPTransferTool from './OSDPTransferTool'; 
import ConfigSection from './ConfigSection'; 
import Reports from './Reports';
import StreamView from './StreamView';
import SwitchSection from './SwitchSection';
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
}
const IOAccessEmulator: React.FC<IOAccessEmulatorProps> = ({
  externalIp,
  nodeId,
  nodeLabel,
  onConnectionChange,
}) => {
  // Namespace localStorage per node so each Pi has its own saved config.
  // Falls back to the legacy 'systemConfig' key in standalone mode.
  const storageKey = nodeId ? `systemConfig_${nodeId}` : 'systemConfig';
  /** ---------- Top-level state ---------- */
  const [connected, setConnected] = useState(false);
  // When running inside a cluster the IP is controlled externally.
  const [ipAddress, setIpAddress] = useState(externalIp || 'localhost');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [activeTab, setActiveTab] = useState<'access-control'|'readers'|'emulation'|'automation'|'controller-emulator'|'config'|'reports'|'tools'>('access-control');
  const [activeAccessControlTab, setActiveAccessControlTab] = useState<'control'|'doors'|'elevator'>('control');
  // Switch control, console builder and stream view are grouped under Tools
  // rather than each holding a slot in the main bar.
  const [activeToolsTab, setActiveToolsTab] = useState<'switch'|'oncafe'|'stream'>('switch');
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
  // Load saved config on mount
  useEffect(() => {
    try {
      const savedConfig = localStorage.getItem(storageKey);
      if (savedConfig) {
        const config = JSON.parse(savedConfig);
        if (config.outputs) setOutputs(config.outputs);
        if (config.inputs) setInputs(config.inputs);
        if (config.controllerOutputs) setControllerOutputs(config.controllerOutputs);
        if (config.readerPool) setReaderPool(config.readerPool);
        if (config.credentialLibrary) setCredentialLibrary(config.credentialLibrary);
      }
    } catch (e) { 
      console.error('Failed to load system config:', e); 
    }
  }, [storageKey]);
  /** ---------- UI ---------- */
  return (
    <div className="min-h-screen text-white p-6" style={{ background: 'radial-gradient(900px 520px at 88% -8%, rgba(240,167,60,.10) 0%, transparent 60%), radial-gradient(700px 500px at 6% 2%, rgba(240,167,60,.045) 0%, transparent 55%), #1B1613' }}>
      <div className="max-w-[1800px] mx-auto mb-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
           <h1 className="text-4xl font-bold bg-gradient-to-r from-[#FFC66E] to-[#F0A73C] bg-clip-text text-transparent">
  Aether v1.5
</h1>
<p className="text-sm text-[#ADA294] tracking-wide mt-0.5">
  Access Emulation Testing Hardware Evaluation Resource
</p>
<p className="text-[#786D60] mt-1">
  {nodeLabel ? `Node: ${nodeLabel}` : 'Access Control Emulator - Modular Architecture'}
</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="localhost"
                value={ipAddress}
                onChange={(e) => { if (!externalIp) setIpAddress(e.target.value); }}
                disabled={connected || !!externalIp}
                title={externalIp ? 'IP is managed by the Cluster Manager' : undefined}
                className="border rounded-lg px-4 py-2 w-48 disabled:opacity-50"
                style={{ background: '#241E19', borderColor: '#38302A' }}
              />
              <button
                onClick={handleConnect}
                className={`px-6 py-2 rounded-lg font-semibold flex items-center gap-2 ${
                  connected ? 'bg-[#C6604F] hover:bg-[#A84E3F]' : 'bg-[#4F8B5C] hover:bg-[#3E6E48]'
                }`}
              >
                {connected ? <WifiOff size={20} /> : <Wifi size={20} />}
                {connected ? 'Disconnect' : 'Connect'}
              </button>
            </div>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              connected ? 'bg-[#4F8B5C]/20 text-[#7BD497]' : 'text-[#786D60]'
            }`} style={!connected ? { background: '#241E19' } : {}}>
              <Circle size={12} fill={connected ? 'currentColor' : 'none'} />
              {connected ? 'Connected' : 'Disconnected'}
            </div>
          </div>
        </div>
                {/* Main Tab Navigation */}
        {/* Automation is hidden from the bar, not removed — its render block below
            is untouched, so adding 'automation' back to this array restores it. */}
        <div className="flex border-b justify-around" style={{ borderColor: '#38302A' }}>
          {['access-control', 'readers', 'emulation', 'automation', 'controller-emulator', 'tools', 'config', 'reports'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`px-3 py-3 font-semibold relative whitespace-nowrap ${
                activeTab === tab ? 'text-[#F0A73C]' : 'text-[#786D60] hover:text-[#F3ECE3]'
              }`}
            >
              {tab === 'access-control' && <Building2 className="inline mr-2" size={20} />}
              {tab === 'readers' && <Radio className="inline mr-2" size={20} />}
              {tab === 'emulation' && <PlayCircle className="inline mr-2" size={20} />}
              {tab === 'automation' && <Activity className="inline mr-2" size={20} />}
              {tab === 'controller-emulator' && <Cpu className="inline mr-2" size={20} />}
              {tab === 'tools' && <Wrench className="inline mr-2" size={20} />}
              {tab === 'config' && <Settings className="inline mr-2" size={20} />}
              {tab === 'reports' && <FileText className="inline mr-2" size={20} />}
              {tab === 'access-control' ? 'Access Control Modules' : tab === 'controller-emulator' ? 'Controller Emulator' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#F0A73C]" />}
            </button>
          ))}
        </div>
      </div>
      <div className="max-w-[1800px] mx-auto">
        {/* ACCESS CONTROL MODULES TAB */}
        {activeTab === 'access-control' && (
          <div className="space-y-6">
            {/* Access Control Modules Header */}
            <div className="rounded-xl p-6 border shadow-2xl" style={{ background: 'linear-gradient(160deg, #241E19, #1B1613)', borderColor: '#38302A' }}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                    <Building2 className="w-8 h-8 text-[#F0A73C]" />
                    Access Control Modules
                  </h1>
                  <p className="text-[#ADA294] mt-2">Manage doors, controls, and elevators</p>
                </div>
              </div>
              {/* Module Type Cards */}
              <div className="grid grid-cols-3 gap-4">
                {/* Controls Card */}
                <button
                  onClick={() => setActiveAccessControlTab('control')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeAccessControlTab === 'control'
                      ? 'border-[#F0A73C] bg-gradient-to-br from-[#F0A73C]/15 to-[#F0A73C]/5 shadow-lg shadow-[#F0A73C]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Activity className={`w-8 h-8 ${activeAccessControlTab === 'control' ? 'text-[#F0A73C]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#F0A73C]/15 text-[#FFC66E] text-xs rounded-full border border-[#F0A73C]/30">
                      {inputs.length + outputs.length} I/O
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Controls</h3>
                  <p className="text-sm text-[#ADA294]">System I/O management</p>
                  <div className="mt-3 text-xs text-[#786D60]">Inputs | Outputs | Controller GPIO</div>
                </button>
                {/* Doors Card */}
                <button
                  onClick={() => setActiveAccessControlTab('doors')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeAccessControlTab === 'doors'
                      ? 'border-[#5FB7B0] bg-gradient-to-br from-[#5FB7B0]/15 to-[#5FB7B0]/5 shadow-lg shadow-[#5FB7B0]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Activity className={`w-8 h-8 ${activeAccessControlTab === 'doors' ? 'text-[#5FB7B0]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#7BD497]/15 text-[#7BD497] text-xs rounded-full border border-[#7BD497]/30">
                      {doors.filter(d => d.enabled).length} Active
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Doors</h3>
                  <p className="text-sm text-[#ADA294]">{doors.length} doors configured</p>
                  <div className="mt-3 text-xs text-[#786D60]">Complete Door Simulation</div>
                </button>
                {/* Elevator Card */}
                <button
                  onClick={() => setActiveAccessControlTab('elevator')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeAccessControlTab === 'elevator'
                      ? 'border-[#8FB488] bg-gradient-to-br from-[#8FB488]/15 to-[#8FB488]/5 shadow-lg shadow-[#8FB488]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Building2 className={`w-8 h-8 ${activeAccessControlTab === 'elevator' ? 'text-[#8FB488]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#8FB488]/15 text-[#8FB488] text-xs rounded-full border border-[#8FB488]/30">
                      Multi-Floor
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Elevators</h3>
                  <p className="text-sm text-[#ADA294]">Floor access control</p>
                  <div className="mt-3 text-xs text-[#786D60]">Relay control | Floor selection</div>
                </button>
              </div>
            </div>
            {/* CONTROLS SUB-TAB */}
            {activeAccessControlTab === 'control' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  {/* Inputs */}
                  <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
                    <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                      <div className="w-3 h-3 bg-[#F0A73C] rounded-full animate-pulse" />
                      Input Group (Relay Outputs)
                    </h2>
                    <div className="space-y-3">
                      {inputs.map(input => (
                        <div key={input.id} className="rounded-lg p-4 border" style={{ background: 'rgba(21, 17, 11, 0.5)', borderColor: '#2A241E' }}>
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-3">
                                <div className={`w-4 h-4 rounded-full ${input.active ? 'bg-[#6FBF7E] shadow-lg shadow-[#6FBF7E]/40' : 'bg-[#4A3F36]'}`} />
                                <div>
                                  <div className="font-semibold">{input.name}</div>
                                  <div className="text-xs text-[#786D60]">
                                    Channel {input.channel} • {input.type}
                                    {input.restingState && (
                                      <span className="ml-2 px-2 py-0.5 bg-[#F0A73C]/15 rounded text-[#FFC66E]">
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
                                input.active ? 'bg-[#4F8B5C] hover:bg-[#3E6E48]' : 'bg-[#2A231C] hover:bg-[#322A22]'
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
                  <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
                    <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                      <div className="w-3 h-3 bg-[#5FB7B0] rounded-full animate-pulse" />
                      Output Group (Monitoring Inputs)
                    </h2>
                    <div className="space-y-3">
                      {outputs.map(output => {
                        const isSupervised = output.supervisionType === 'Supervised-NO' || output.supervisionType === 'Supervised-NC';
                        const supervisionState = output.supervisionState || 'normal';
                        
                        const stateColors = {
                          normal: 'bg-[#2A231C] text-[#ADA294]',
                          active: 'bg-[#4F8B5C]/40 text-[#CDEBD3]',
                          trouble: 'bg-[#C79A34]/40 text-[#F3E4BE]',
                          short: 'bg-[#C6604F]/40 text-[#F5D4CD]'
                        };
                        
                        const indicatorColors = {
                          normal: 'bg-[#4A3F36]',
                          active: 'bg-[#6FBF7E] shadow-lg shadow-[#6FBF7E]/40',
                          trouble: 'bg-[#E6C766] shadow-lg shadow-[#E6C766]/40',
                          short: 'bg-[#E0705F] shadow-lg shadow-[#E0705F]/40'
                        };
                        
                        return (
                          <div key={output.id} className="rounded-lg p-4 border" style={{ background: 'rgba(21, 17, 11, 0.5)', borderColor: '#2A241E' }}>
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-3">
                                  <div className={`w-4 h-4 rounded-full ${
                                    isSupervised 
                                      ? indicatorColors[supervisionState]
                                      : (output.active ? 'bg-[#6FBF7E] shadow-lg shadow-[#6FBF7E]/40' : 'bg-[#4A3F36]')
                                  }`} />
                                  <div>
                                    <div className="font-semibold">{output.name}</div>
                                    <div className="text-xs text-[#786D60]">
                                      Channel {output.channel} • {output.type}
                                      {output.inputType && (
                                        <span className="ml-2 px-2 py-0.5 bg-[#5FB7B0]/15 rounded text-[#8FD3CD]">
                                          {output.inputType === 'opto' ? 'Opto' : 'Analog 0-10V'}
                                        </span>
                                      )}
                                      {output.supervisionType && (
                                        <span className="ml-2 px-2 py-0.5 bg-[#5FB7B0]/15 rounded text-[#8FD3CD]">
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
                                  : (output.active ? 'bg-[#4F8B5C]/40 text-[#CDEBD3]' : 'bg-[#2A231C] text-[#786D60]')
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
                <div className="backdrop-blur rounded-xl p-6 border" style={{ background: 'rgba(36, 30, 25, 0.55)', borderColor: '#38302A' }}>
                  <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
                    <div className="w-3 h-3 bg-[#5FB7B0] rounded-full animate-pulse" />
                    Controller Based Aux Inputs / Outputs
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    {controllerOutputs.map(output => (
                      <div key={output.id} className="rounded-lg p-4 border" style={{ background: 'rgba(21, 17, 11, 0.5)', borderColor: '#2A241E' }}>
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              <div className={`w-4 h-4 rounded-full ${output.active ? 'bg-[#5FB7B0] shadow-lg shadow-[#5FB7B0]/40' : 'bg-[#4A3F36]'}`} />
                              <div>
                                <div className="font-semibold">{output.name}</div>
                                <div className="text-xs text-[#786D60]">Channel {output.channel} • {output.type}</div>
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={() => toggleControllerOutput(output.id)}
                            disabled={!connected}
                            className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                              output.active ? 'bg-[#F0A73C] hover:bg-[#C9862E]' : 'bg-[#2A231C] hover:bg-[#322A22]'
                            } disabled:opacity-30 disabled:cursor-not-allowed`}
                          >
                            {output.active ? 'TRIGGERED' : 'IDLE'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
        {activeTab === 'emulation' && (
          <EmulationSection
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
        )}
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
        {/* CONFIG TAB */}
        {activeTab === 'config' && (
          <ConfigSection
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
            onSaveConfig={() => {
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
                localStorage.setItem(storageKey, JSON.stringify(config));
                logSystem('success', 'System configuration saved successfully');
                logAudit('Saved complete system configuration');
              } catch (e: any) {
                logSystem('error', `Failed to save configuration: ${e.message}`);
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
        {/* TOOLS TAB — switch control, console builder and stream view */}
        {activeTab === 'tools' && (
          <div className="space-y-6">
            <div className="rounded-xl p-6 border shadow-2xl" style={{ background: 'linear-gradient(160deg, #241E19, #1B1613)', borderColor: '#38302A' }}>
              <div className="flex items-center justify-between mb-5 flex-wrap gap-4">
                <div>
                  <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                    <Wrench className="w-8 h-8 text-[#F0A73C]" />
                    Tools
                  </h1>
                  <p className="text-[#ADA294] mt-2">Switch control, console building and live video</p>
                </div>
              </div>
              {/* Cards mirror the Access Control module picker so the two tabs
                  read the same way, with a compact button row beneath for
                  switching once you know where you are going. */}
              <div className="grid grid-cols-3 gap-4">
                <button
                  onClick={() => setActiveToolsTab('switch')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeToolsTab === 'switch'
                      ? 'border-[#F0A73C] bg-gradient-to-br from-[#F0A73C]/15 to-[#F0A73C]/5 shadow-lg shadow-[#F0A73C]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Network className={`w-8 h-8 ${activeToolsTab === 'switch' ? 'text-[#F0A73C]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#F0A73C]/15 text-[#FFC66E] text-xs rounded-full border border-[#F0A73C]/30">
                      Live
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Switch Ports</h3>
                  <p className="text-sm text-[#ADA294]">Link and power control</p>
                  <div className="mt-3 text-xs text-[#786D60]">Disconnects | PoE | Traffic</div>
                </button>

                <button
                  onClick={() => setActiveToolsTab('oncafe')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeToolsTab === 'oncafe'
                      ? 'border-[#5FB7B0] bg-gradient-to-br from-[#5FB7B0]/15 to-[#5FB7B0]/5 shadow-lg shadow-[#5FB7B0]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Terminal className={`w-8 h-8 ${activeToolsTab === 'oncafe' ? 'text-[#5FB7B0]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#5FB7B0]/15 text-[#8FD3CD] text-xs rounded-full border border-[#5FB7B0]/30">
                      Builder
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">OnCAFE Console</h3>
                  <p className="text-sm text-[#ADA294]">Console configuration</p>
                  <div className="mt-3 text-xs text-[#786D60]">Layouts | Devices | Export</div>
                </button>

                <button
                  onClick={() => setActiveToolsTab('stream')}
                  className={`p-6 rounded-lg border-2 transition-all text-left ${
                    activeToolsTab === 'stream'
                      ? 'border-[#8FB488] bg-gradient-to-br from-[#8FB488]/15 to-[#8FB488]/5 shadow-lg shadow-[#8FB488]/20'
                      : 'border-[#38302A] bg-[#241E19]/50 hover:border-[#4A3F36]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Monitor className={`w-8 h-8 ${activeToolsTab === 'stream' ? 'text-[#8FB488]' : 'text-[#786D60]'}`} />
                    <span className="px-2 py-1 bg-[#8FB488]/15 text-[#8FB488] text-xs rounded-full border border-[#8FB488]/30">
                      Video
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Stream View</h3>
                  <p className="text-sm text-[#ADA294]">Live camera feeds</p>
                  <div className="mt-3 text-xs text-[#786D60]">Monitor | Verify | Record</div>
                </button>
              </div>

            </div>
            {activeToolsTab === 'switch' && (
              <SwitchSection
                ipAddress={ipAddress}
                connected={connected}
                socket={socket}
                logSystem={logSystem}
                logAudit={logAudit}
              />
            )}
            {/* The console builder breaks out to full viewport width on purpose:
                it is an iframe with its own layout and the page gutters crop it.
                Height allows for the sub-tab header above it. */}
            {activeToolsTab === 'oncafe' && (
              <div style={{ width: '100vw', marginLeft: 'calc(50% - 50vw)', height: 'calc(100vh - 260px)' }}>
                <iframe
                  src="/oncafe-console-builder.html"
                  title="OnCafe Console Builder"
                  style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                />
              </div>
            )}
            {activeToolsTab === 'stream' && <StreamView />}
          </div>
        )}
        {/* REPORTS TAB */}
        {activeTab === 'reports' && (
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
        )}
      </div>
    </div>
  );
};
export default IOAccessEmulator;
