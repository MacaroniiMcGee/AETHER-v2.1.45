import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Edit3, Radio, Save, Upload, RefreshCw, Plus, X, Trash2 } from 'lucide-react';
import { Socket } from 'socket.io-client';
import { DoorScene } from './DoorAnimation';
import DoorSettings from './DoorSettings';
import { useCardFormats, isValidFacilityCode, isValidCardNumber } from '../hooks/useCardFormats';

/** ---------- Types ---------- */

// I/O Hardware Types
type IOHardwareType = 'relay' | 'opto' | 'analog' | 'gpio';

// Base I/O Configuration
interface IOConfig {
  name: string;
  hardwareType: IOHardwareType;
  channel: number;        // 0-7 for Sequent, or GPIO pin number
  stackLevel?: number;    // 0-7 for multi-board Sequent setups
  active: boolean;
  reverseSense?: boolean;
}

// Door Lock - OUTPUT (controls relay)
interface DoorLockIO extends IOConfig {
  hardwareType: 'relay';
}

// Door Position Switch - INPUT (reads from opto or analog)
interface DoorDPSIO extends IOConfig {
  hardwareType: 'opto' | 'analog';
  supervisionState?: 'normal' | 'active' | 'trouble' | 'short';
}

// Request to Exit - INPUT (reads from opto or analog)
interface DoorREXIO extends IOConfig {
  hardwareType: 'opto' | 'analog';
  supervisionState?: 'normal' | 'active' | 'trouble' | 'short';
}

// Custom Event Types
type CustomEventStep = {
  id: number;
  // #3: added 'wait' (pure delay step) and 'pulse' (momentary
  // activate->hold->release on lock/DPS/REX) — mirrors the Emulation
  // page's block model and consolidates 3 steps (activate+wait+deactivate)
  // into 1.
  action: 'lock' | 'unlock' | 'open-dps' | 'close-dps' | 'activate-rex' | 'deactivate-rex' | 'toggle-io' | 'send-card' | 'wait' | 'pulse';
  ioId?: string;
  readerId?: string;
  cardFormat?: '26' | '34' | '35' | '37' | '48';
  facilityCode?: string;
  cardNumber?: string;
  delay: number;
  // #3 wait-step config (when action === 'wait')
  waitType?: 'seconds' | 'minutes' | 'random';
  waitValue?: number;          // seconds or minutes (per waitType)
  waitMin?: number;            // random lower bound (seconds)
  waitMax?: number;            // random upper bound (seconds)
  // #3 pulse-step config (when action === 'pulse')
  pulseTarget?: 'lock' | 'dps' | 'rex';
  pulseDuration?: number;      // ms held active before auto-release
};

type CustomEvent = {
  name: string;
  enabled: boolean;
  steps: CustomEventStep[];
};

// Dynamic I/O Types
type InputType = 'None' | 'REX-Button' | 'Entry Sensor' | 'Lock Sensor' | 'Safety Beam' | 'DPS' | 'AUX' | 'General';
type OutputType = 'None' | 'Strike Follower' | 'Lock' | 'Auto Door' | 'Sounder' | 'Strobe' | 'FAI' | 'General';

interface DoorIO {
  id: string;
  name: string;
  type: InputType | OutputType;
  hardwareType: IOHardwareType;
  channel: number;
  stackLevel?: number;
  active: boolean;
  enabled: boolean;
  reverseSense?: boolean;
  supervisionState?: 'normal' | 'active' | 'trouble' | 'short';
}

// Reader Types
interface Reader {
  id: string;
  name: string;
  type: 'wiegand' | 'osdp' | 'none';
  enabled: boolean;
  d0?: number;
  d1?: number;
  address?: number;
  assignedToDoor: number | null;
  position: 'in' | 'out' | null;
}

// Credential Types
type CredentialFormat = '26-bit' | '34-bit' | '35-bit' | '37-bit' | '48-bit' | 'custom';

interface CardCredential {
  id: string;
  name: string;
  format: CredentialFormat;
  facilityCode: string;
  cardNumber: string;
  customBits?: string;
}

// Main Door Type
interface Door {
  id: number;
  name: string;
  enabled: boolean;
  // #2: per-door I/O source. 'physical' = Sequent GPIO (default, unchanged);
  // 'emulated' = an emulated Azure controller board (emuBoard = its address).
  ioSource?: 'physical' | 'emulated';
  emuBoard?: number;          // emulated device address (0/undefined = none)
  emuReaderPort?: number;     // on-board reader port for emulated card-send
  lock: DoorLockIO;
  dps: DoorDPSIO;
  rexIn: DoorREXIO;
  ios: DoorIO[];
  reader: string | null;   // #3: single reader per door (was readers:{in,out})
  customEvents?: CustomEvent[];
}

// #2: live emulated board info, fetched from /api/emulator/status
interface EmuBoard {
  address: number;
  model: string;
  numInputs: number;
  numOutputs: number;
  numReaders: number;
  online: boolean;
  inputs: number[] | null;
  outputs: number[] | null;
}

// Global System I/O
interface GlobalSystemIO {
  name: string;
  hardwareType: IOHardwareType;
  channel: number;
  stackLevel?: number;
  active: boolean;
}

// Props for DoorSection
interface DoorSectionProps {
  ipAddress: string;
  connected: boolean;
  socket: Socket | null;
  readerPool: Reader[];
  credentialLibrary: CardCredential[];
  onUpdateReaderPool: (readers: Reader[]) => void;
  onLog: (type: 'success' | 'error' | 'info' | 'warn' | 'io', message: string) => void;
  onAuditLog: (message: string) => void;
}

/** ---------- API Helpers ---------- */

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `HTTP ${r.status}`);
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await r.json();
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Set Sequent IOplus Relay Output
 * @param ipAddress - Backend IP
 * @param channel - Relay channel (0-7)
 * @param state - 0 (off) or 1 (on)
 * @param stackLevel - Board stack level (0-7, default 0)
 */
async function setRelayOutput(ipAddress: string, channel: number, state: number, stackLevel = 0) {
  if (channel < 0 || channel > 7) {
    throw new Error(`Invalid relay channel ${channel}. Must be 0-7.`);
  }

  const url = `http://${ipAddress}:3001/api/gpio/set`;
  await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: channel, value: state, stackLevel })
  });
}

/**
 * Read Sequent IOplus Opto Input
 * @param ipAddress - Backend IP
 * @param channel - Opto input channel (0-7)
 * @param stackLevel - Board stack level (0-7, default 0)
 */
async function readOptoInput(ipAddress: string, channel: number, stackLevel = 0): Promise<{ state: number }> {
  if (channel < 0 || channel > 7) {
    throw new Error(`Invalid opto channel ${channel}. Must be 0-7.`);
  }

  const url = `http://${ipAddress}:3001/api/gpio/opto/${channel}?stackLevel=${stackLevel}`;
  return await fetchJson(url);
}

/**
 * Read Sequent IOplus Analog Input (with supervision)
 * @param ipAddress - Backend IP
 * @param channel - Analog input channel (0-7)
 * @param stackLevel - Board stack level (0-7, default 0)
 */
async function readAnalogInput(ipAddress: string, channel: number, stackLevel = 0): Promise<{
  voltage: number;
  state: string;
  supervisionState: 'NORMAL' | 'ALARM' | 'TAMPER' | 'TROUBLE';
}> {
  if (channel < 0 || channel > 7) {
    throw new Error(`Invalid analog channel ${channel}. Must be 0-7.`);
  }

  const url = `http://${ipAddress}:3001/api/supervision/zone?stackLevel=${stackLevel}&channel=${channel + 1}`;
  return await fetchJson(url);
}

/** ---------- #2: Emulated Controller API Helpers ---------- */

// Drive an emulated board OUTPUT (used for Lock when door is emulated).
async function setEmuOutput(ipAddress: string, address: number, idx: number, active: boolean) {
  const url = `http://${ipAddress}:3001/api/emulator/device/${address}/output/${idx}`;
  const r = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (r && (r as any).success === false) {
    throw new Error((r as any).error || `emulator output ${idx} rejected (addr ${address})`);
  }
}

// Drive an emulated board INPUT (used for DPS/REX when door is emulated).
async function setEmuInput(ipAddress: string, address: number, idx: number, active: boolean) {
  const url = `http://${ipAddress}:3001/api/emulator/device/${address}/input/${idx}`;
  const r = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (r && (r as any).success === false) {
    throw new Error((r as any).error || `emulator input ${idx} rejected (addr ${address})`);
  }
}

// Present a card on an emulated board's on-board reader port.
async function sendEmuCard(
  ipAddress: string, address: number, port: number,
  fmtBits: number, facility: number, card: number, formatId?: string
) {
  const url = `http://${ipAddress}:3001/api/emulator/device/${address}/reader/${port}/card`;
  // #fmt: prefer the catalog format id when provided; fall back to w<bits>.
  const fmt = formatId && formatId.trim() ? formatId : `w${fmtBits}`;
  const r = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: fmt, bits: fmtBits, facility, card }),
  });
  if (r && (r as any).success === false) {
    throw new Error((r as any).error || `emulator card rejected (addr ${address} port ${port})`);
  }
}

// Read an emulated board's live snapshot (for refreshing input/output state).
async function fetchEmuStatus(ipAddress: string): Promise<EmuBoard[]> {
  try {
    const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
    if (!r.ok) return [];
    const j = await r.json();
    const devices = j?.status?.devices || [];
    return devices.map((d: any) => ({
      address: d.address,
      model: d.model || '?',
      numInputs: d.numInputs || 0,
      numOutputs: d.numOutputs || 0,
      numReaders: typeof d.numReaders === 'number'
        ? d.numReaders
        : (Array.isArray(d.readerState) ? d.readerState.length : 0),
      online: d.online !== false,
      inputs: Array.isArray(d.inputs) ? d.inputs : null,
      outputs: Array.isArray(d.outputs) ? d.outputs : null,
    }));
  } catch {
    return [];
  }
}

/** ---------- Default Configurations ---------- */

// Default doors with CORRECT I/O separation
const createDefaultDoors = (): Door[] => [
  {
    id: 1,
    name: 'Main Entrance',
    enabled: true,
    ioSource: 'physical',
    lock: {
      name: 'Door Strike',
      hardwareType: 'relay',
      channel: 0,  // Relay 0
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'opto',  // Input - reads from opto
      channel: 0,  // Opto Input 0
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'opto',  // Input - reads from opto
      channel: 4,  // Opto Input 4 (different from DPS!)
      active: false,
      supervisionState: 'normal'
    },
    ios: [],
    reader: 'reader1',
    customEvents: Array.from({ length: 6 }, (_, i) => ({
      name: `Custom Event ${i + 1}`,
      enabled: false,
      steps: []
    }))
  },
  {
    id: 2,
    name: 'Back Door',
    enabled: true,
    ioSource: 'physical',
    lock: {
      name: 'Door Strike',
      hardwareType: 'relay',
      channel: 1,  // Relay 1
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'opto',
      channel: 1,  // Opto Input 1
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'opto',
      channel: 5,  // Opto Input 5
      active: false,
      supervisionState: 'normal'
    },
    ios: [],
    reader: 'reader2',
    customEvents: Array.from({ length: 6 }, (_, i) => ({
      name: `Custom Event ${i + 1}`,
      enabled: false,
      steps: []
    }))
  },
  {
    id: 3,
    name: 'Side Door',
    enabled: false,
    ioSource: 'physical',
    lock: {
      name: 'Door Strike',
      hardwareType: 'relay',
      channel: 2,  // Relay 2
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'opto',
      channel: 2,  // Opto Input 2
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'opto',
      channel: 6,  // Opto Input 6
      active: false,
      supervisionState: 'normal'
    },
    ios: [],
    reader: null,
    customEvents: Array.from({ length: 6 }, (_, i) => ({
      name: `Custom Event ${i + 1}`,
      enabled: false,
      steps: []
    }))
  },
  {
    id: 4,
    name: 'Elevator',
    enabled: false,
    ioSource: 'physical',
    lock: {
      name: 'Door Strike',
      hardwareType: 'relay',
      channel: 3,  // Relay 3
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'opto',
      channel: 3,  // Opto Input 3
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'opto',
      channel: 7,  // Opto Input 7
      active: false,
      supervisionState: 'normal'
    },
    ios: [],
    reader: null,
    customEvents: Array.from({ length: 6 }, (_, i) => ({
      name: `Custom Event ${i + 1}`,
      enabled: false,
      steps: []
    }))
  }
];

/** ---------- I/O Type Categories ---------- */
const SIMULATOR_OUTPUTS_TO_PANEL: InputType[] = ['REX-Button', 'Entry Sensor', 'Lock Sensor', 'Safety Beam', 'DPS', 'AUX'];
const PANEL_OUTPUTS_TO_SIMULATOR: OutputType[] = ['Strike Follower', 'Lock', 'Auto Door', 'Sounder', 'Strobe', 'FAI'];

const isSimulatorOutput = (type: string): boolean => SIMULATOR_OUTPUTS_TO_PANEL.includes(type as InputType);
const isPanelOutput = (type: string): boolean => PANEL_OUTPUTS_TO_SIMULATOR.includes(type as OutputType);

/** ---------- Main Component ---------- */

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

const DC = {
  text: 'rgb(var(--hv-text))', text2: 'rgb(var(--hv-text-2))', dim: 'rgb(var(--hv-text-3))', line: 'rgb(var(--hv-popup-panel))',
  good: 'rgb(var(--hv-success))', teal: 'rgb(var(--hv-info))', blue: 'rgb(var(--hv-info-text))', amber: 'rgb(var(--hv-brand))', warn: 'rgb(var(--hv-warning))', crit: 'rgb(var(--hv-error))',
};

const IconBtn: React.FC<{ title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({ title, onClick, disabled, danger, children }) => (
  <button title={title} aria-label={title} onClick={onClick} disabled={disabled}
    className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors disabled:opacity-30 ${danger ? 'hover:bg-hv-error-hover/60 hover:text-hv-text' : 'hover:bg-hv-contrast/5 hover:text-hv-text'}`}
    style={{ color: 'rgb(var(--hv-text-3))' }}>
    {children}
  </button>
);

const DoorSection: React.FC<DoorSectionProps> = ({
  ipAddress,
  connected,
  socket,
  readerPool,
  credentialLibrary,
  onUpdateReaderPool,
  onLog,
  onAuditLog
}) => {
  // Door state
  const [doors, setDoors] = useState<Door[]>(createDefaultDoors);
  const [showDoorSettings, setShowDoorSettings] = useState(false);
  // #5: fixed 8-slot model + add-door dialog
  const MAX_DOORS = 8;
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newDoorName, setNewDoorName] = useState('');
  const [newDoorSource, setNewDoorSource] = useState<'physical' | 'emulated'>('physical');
  const [editingDoorId, setEditingDoorId] = useState<number | null>(null);
  const [showSystemOutputConfig, setShowSystemOutputConfig] = useState(false);
  const [systemOutputsCollapsed, setSystemOutputsCollapsed] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<string>('card-1');
  // #cred: per-door editable credential entry (format/facility/card), keyed by door id
  // #fmt: shared card-format catalog (same hook the OSDP page uses — all 63 formats)
  const cardFormatApiUrl = `http://${ipAddress}:3001`;
  const { formats: cardFormats, loading: cardFormatsLoading, getFormatById: getCardFormatById } = useCardFormats(cardFormatApiUrl);
  // credEntry now tracks a format id (e.g. 'w26') + a category/bits filter per door
  const [credEntry, setCredEntry] = useState<Record<number, { fmtId: string; fc: string; card: string; cat: string }>>({});
  // #2: live emulated boards (from /api/emulator/status), refreshed on socket events
  const [emuBoards, setEmuBoards] = useState<EmuBoard[]>([]);
  // #lockmon-debug: last-seen output snapshot per door (temporary, visible on Lock pill)

  // Global System I/O
  const [globalPowerFault, setGlobalPowerFault] = useState<GlobalSystemIO>({
    name: 'Power Fault',
    hardwareType: 'relay',
    channel: -1,  // -1 = unconfigured
    active: false
  });

  const [globalBatteryFault, setGlobalBatteryFault] = useState<GlobalSystemIO>({
    name: 'Battery Fault',
    hardwareType: 'relay',
    channel: -1,
    active: false
  });

  const [globalTamper, setGlobalTamper] = useState<GlobalSystemIO>({
    name: 'System Tamper',
    hardwareType: 'relay',
    channel: -1,
    active: false
  });

  const [globalFAI, setGlobalFAI] = useState<GlobalSystemIO>({
    name: 'Fire Alarm Input',
    hardwareType: 'relay',
    channel: -1,
    active: false
  });

  /** ---------- WebSocket Input Monitoring ---------- */
  useEffect(() => {
    if (!socket || !connected) return;

    // Listen for input state changes from backend
    const handleInputStateChange = (data: {
      type: 'opto' | 'analog';
      pin: number;
      state: number;
      voltage?: number;
      supervisionState?: string;
      timestamp: number;
    }) => {
      // Update DPS and REX states based on incoming input changes
      setDoors(prevDoors => prevDoors.map(door => {
        let updatedDoor = { ...door };

        // Check DPS
        if (door.dps.hardwareType === data.type && door.dps.channel === data.pin) {
          const newActive = door.dps.reverseSense ? !data.state : !!data.state;
          let supervisionState: 'normal' | 'active' | 'trouble' | 'short' = 'normal';

          if (data.type === 'analog' && data.supervisionState) {
            const apiState = data.supervisionState.toUpperCase();
            if (apiState === 'ALARM') supervisionState = 'active';
            else if (apiState === 'TAMPER') supervisionState = 'short';
            else if (apiState === 'TROUBLE') supervisionState = 'trouble';
          } else {
            supervisionState = newActive ? 'active' : 'normal';
          }

          updatedDoor = {
            ...updatedDoor,
            dps: { ...door.dps, active: newActive, supervisionState }
          };
        }

        // Check REX
        if (door.rexIn.hardwareType === data.type && door.rexIn.channel === data.pin) {
          const newActive = door.rexIn.reverseSense ? !data.state : !!data.state;
          let supervisionState: 'normal' | 'active' | 'trouble' | 'short' = 'normal';

          if (data.type === 'analog' && data.supervisionState) {
            const apiState = data.supervisionState.toUpperCase();
            if (apiState === 'ALARM') supervisionState = 'active';
            else if (apiState === 'TAMPER') supervisionState = 'short';
            else if (apiState === 'TROUBLE') supervisionState = 'trouble';
          } else {
            supervisionState = newActive ? 'active' : 'normal';
          }

          updatedDoor = {
            ...updatedDoor,
            rexIn: { ...door.rexIn, active: newActive, supervisionState }
          };
        }

        // Check dynamic I/Os that are inputs
        const updatedIos = door.ios.map(io => {
          if ((io.hardwareType === 'opto' || io.hardwareType === 'analog') &&
              io.hardwareType === data.type && io.channel === data.pin) {
            const newActive = io.reverseSense ? !data.state : !!data.state;
            let supervisionState: 'normal' | 'active' | 'trouble' | 'short' = 'normal';

            if (data.type === 'analog' && data.supervisionState) {
              const apiState = data.supervisionState.toUpperCase();
              if (apiState === 'ALARM') supervisionState = 'active';
              else if (apiState === 'TAMPER') supervisionState = 'short';
              else if (apiState === 'TROUBLE') supervisionState = 'trouble';
            } else {
              supervisionState = newActive ? 'active' : 'normal';
            }

            return { ...io, active: newActive, supervisionState };
          }
          return io;
        });

        return { ...updatedDoor, ios: updatedIos };
      }));
    };

    socket.on('input_state_change', handleInputStateChange);

    return () => {
      socket.off('input_state_change', handleInputStateChange);
    };
  }, [socket, connected]);

  /** ---------- #2/#lockmon: Live Emulated Board Sync ----------
   * IC2 unlocks by sending OSDP TEMP-ON (output -> 1) then PERM-ON
   * (output -> 0) when grant time expires. That is a SHORT PULSE. A status
   * refetch races and usually only catches the trailing 0, so we follow the
   * raw `output-changed` event payload DIRECTLY (state:1 caught instantly),
   * exactly like the working Controller Emulator page. Status refetch is used
   * only for board-list housekeeping, never to derive lock state.
   */
  useEffect(() => {
    let cancelled = false;

    const refreshBoards = async () => {
      const boards = await fetchEmuStatus(ipAddress);
      if (!cancelled) setEmuBoards(boards);
    };
    refreshBoards();

    if (socket && connected) {
      const onAny = () => refreshBoards();

      // Direct payload handler — the lock follows IC2's output command live.
      // IC2's unlock is a brief pulse (TEMP-ON -> PERM-ON). Mirror state:1
      // instantly; when it returns to 0, hold the visible UNLOCKED state for
      // a minimum dwell so a short grant pulse is clearly seen (the door WAS
      // granted). A later genuine lock still lands after the dwell.
      const relockTimers: Record<number, any> = {};
      const MIN_UNLOCK_MS = 2500;
      const onOutputChanged = (msg: any) => {
        if (!msg) return;
        const addr = Number(msg.address) & 0x7F;
        const outNum = Number(msg.outNum ?? msg.idx);
        const state = msg.state ?? (msg.active ? 1 : 0);
        if (!Number.isFinite(addr) || !Number.isFinite(outNum)) return;
        const becameActive = !!state;

        const setLock = (active: boolean) => setDoors(prev => prev.map(d => {
          if (d.ioSource !== 'emulated' || !d.emuBoard) return d;
          if ((Number(d.emuBoard) & 0x7F) !== addr) return d;
          if (Number(d.lock.channel) !== outNum) return d;
          if (d.lock.active === active) return d;
          return { ...d, lock: { ...d.lock, active } };
        }));

        // key by addr|out so concurrent doors don't collide
        const key = addr * 1000 + outNum;
        if (becameActive) {
          if (relockTimers[key]) { clearTimeout(relockTimers[key]); delete relockTimers[key]; }
          setLock(true);
        } else {
          // defer the relock so a short pulse stays visibly UNLOCKED
          if (relockTimers[key]) clearTimeout(relockTimers[key]);
          relockTimers[key] = setTimeout(() => { setLock(false); delete relockTimers[key]; }, MIN_UNLOCK_MS);
        }
      };

      socket.on('emulator-started', onAny);
      socket.on('emulator-stopped', onAny);
      socket.on('emulator-config-applied', onAny);
      socket.on('emulator-device-added', onAny);
      socket.on('emulator-device-removed', onAny);
      socket.on('emulator-device-update', onAny);
      socket.on('output-changed', onOutputChanged);

      return () => {
        cancelled = true;
        Object.values(relockTimers).forEach(t => clearTimeout(t));
        socket.off('emulator-started', onAny);
        socket.off('emulator-stopped', onAny);
        socket.off('emulator-config-applied', onAny);
        socket.off('emulator-device-added', onAny);
        socket.off('emulator-device-removed', onAny);
        socket.off('emulator-device-update', onAny);
        socket.off('output-changed', onOutputChanged);
      };
    }
    return () => { cancelled = true; };
  }, [socket, connected, ipAddress]);

  // #2: helper — the EmuBoard a door is bound to (or undefined)
  const boardForDoor = (door: Door): EmuBoard | undefined => {
    if (door.ioSource !== 'emulated' || !door.emuBoard) return undefined;
    return emuBoards.find(b => b.address === door.emuBoard);
  };

  /** ---------- Load Configuration on Mount ---------- */
  useEffect(() => {
    loadDoorConfigurationFromBackend();
  }, []);

  /** ---------- Global System I/O Handlers ---------- */
  const toggleGlobalIO = async (
    io: GlobalSystemIO,
    setIO: React.Dispatch<React.SetStateAction<GlobalSystemIO>>
  ) => {
    if (!connected || io.channel === -1) return;

    const newState = !io.active;
    try {
      await setRelayOutput(ipAddress, io.channel, newState ? 1 : 0, io.stackLevel);
      setIO(prev => ({ ...prev, active: newState }));
      onLog('io', `${io.name} (Channel ${io.channel}) ${newState ? 'ACTIVE' : 'NORMAL'}`);
    } catch (e: any) {
      onLog('error', `Failed to toggle ${io.name}: ${e.message}`);
    }
  };

  /** ---------- Door Lock Handler (OUTPUT) ---------- */
  const toggleDoorLock = async (doorId: number, desired?: boolean) => {
    if (!connected) return;
    const door = doors.find(d => d.id === doorId);
    if (!door || !door.enabled) return;

    // #2-fix: explicit direction (event steps) drives unconditionally,
    // avoiding the stale-`doors`-closure skip bug in the async event loop.
    // Manual button passes nothing → toggle (uses live render state, fine).
    const newState = desired !== undefined ? desired : !door.lock.active;
    const emu = boardForDoor(door);
    try {
      if (emu) {
        if (door.lock.channel >= emu.numOutputs) {
          throw new Error(`Lock OUTPUT ${door.lock.channel} out of range — board #${emu.address} (${emu.model}) has ${emu.numOutputs} outputs (0-${emu.numOutputs - 1})`);
        }
        await setEmuOutput(ipAddress, emu.address, door.lock.channel, newState);
      } else {
        await setRelayOutput(ipAddress, door.lock.channel, newState ? 1 : 0, door.lock.stackLevel);
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? { ...d, lock: { ...d.lock, active: newState } } : d
      ));

      const where = emu ? `OUTPUT ${door.lock.channel} (#${emu.address})` : `Relay ${door.lock.channel}`;
      onLog('io', `${door.name} Lock (${where}) ${newState ? 'UNLOCKED' : 'LOCKED'}`);
      onAuditLog(`${door.name}: Lock ${newState ? 'released' : 'engaged'}`);
    } catch (e: any) {
      onLog('error', `Failed to toggle ${door.name} lock: ${e.message}`);
    }
  };

  /** ---------- Door DPS Simulation ----------
   * #3: This now ACTUALLY drives the backend (physical /api/gpio/set on the
   * matching input channel — for a loopback rig where a relay is wired to the
   * opto/analog input). Previously this only flipped local React state, so the
   * animation showed "open" but nothing reached the panel/controller.
   * Behavior: TOGGLE (door stays open until clicked again). reverseSense-aware.
   * Failures surface via onLog('error', ...) instead of a silent no-op.
   * (Per-door physical/emulated source selection is change #2 — not here.)
   */
  const simulateDoorDPS = async (doorId: number, desired?: boolean) => {
    if (!connected) return;
    const door = doors.find(d => d.id === doorId);
    if (!door || !door.enabled) return;

    // #2-fix: explicit direction (event steps) DRIVES unconditionally.
    // The old skip-guard used a stale `doors` closure inside the async event
    // loop, which made the second of an open→close (or close→open) pair get
    // wrongly skipped. Re-driving to the same state is harmless.
    const newState = desired !== undefined ? desired : !door.dps.active;
    const emu = boardForDoor(door);
    // reverseSense: when set, asserting "open" means driving the line LOW.
    const gpioValue = door.dps.reverseSense ? (newState ? 0 : 1) : (newState ? 1 : 0);

    try {
      if (emu) {
        if (door.dps.channel >= emu.numInputs) {
          throw new Error(`DPS INPUT ${door.dps.channel} out of range — board #${emu.address} (${emu.model}) has ${emu.numInputs} inputs (0-${emu.numInputs - 1})`);
        }
        // reverseSense still applies: asserted-open may mean input LOW.
        const emuActive = door.dps.reverseSense ? !newState : newState;
        await setEmuInput(ipAddress, emu.address, door.dps.channel, emuActive);
      } else {
        await setRelayOutput(ipAddress, door.dps.channel, gpioValue, door.dps.stackLevel);
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? {
          ...d,
          dps: { ...d.dps, active: newState, supervisionState: newState ? 'active' : 'normal' }
        } : d
      ));

      const where = emu ? `INPUT ${door.dps.channel} (#${emu.address})` : `${door.dps.hardwareType} ch ${door.dps.channel} [GPIO=${gpioValue}]`;
      onLog('io', `${door.name} DPS (${where}) driven ${newState ? 'OPEN' : 'CLOSED'}`);
      onAuditLog(`${door.name}: DPS ${newState ? 'opened' : 'closed'}`);
    } catch (e: any) {
      onLog('error', `Failed to drive ${door.name} DPS (ch ${door.dps.channel}): ${e.message}`);
    }
  };

  /** ---------- Door REX Simulation ----------
   * #3: Now actually drives the backend (physical /api/gpio/set). TOGGLE
   * behavior per current UX (press = assert, press again = release).
   * reverseSense-aware; failures surfaced via onLog('error', ...).
   */
  const simulateDoorREX = async (doorId: number, desired?: boolean) => {
    if (!connected) return;
    const door = doors.find(d => d.id === doorId);
    if (!door || !door.enabled) return;

    // #2-fix: when an explicit direction is given (event steps), DRIVE it
    // unconditionally. The previous skip-guard compared against `door` read
    // from a STALE `doors` closure inside the async event loop — after an
    // 'activate' step, the closure still showed REX idle, so the following
    // 'deactivate' was wrongly skipped ("already IDLE"). Re-driving to the
    // same state is harmless; correctness matters more than the micro-opt.
    const newState = desired !== undefined ? desired : !door.rexIn.active;
    const emu = boardForDoor(door);
    const gpioValue = door.rexIn.reverseSense ? (newState ? 0 : 1) : (newState ? 1 : 0);

    try {
      if (emu) {
        if (door.rexIn.channel >= emu.numInputs) {
          throw new Error(`REX INPUT ${door.rexIn.channel} out of range — board #${emu.address} (${emu.model}) has ${emu.numInputs} inputs (0-${emu.numInputs - 1})`);
        }
        const emuActive = door.rexIn.reverseSense ? !newState : newState;
        await setEmuInput(ipAddress, emu.address, door.rexIn.channel, emuActive);
      } else {
        await setRelayOutput(ipAddress, door.rexIn.channel, gpioValue, door.rexIn.stackLevel);
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? {
          ...d,
          rexIn: { ...d.rexIn, active: newState, supervisionState: newState ? 'active' : 'normal' }
        } : d
      ));

      const where = emu ? `INPUT ${door.rexIn.channel} (#${emu.address})` : `${door.rexIn.hardwareType} ch ${door.rexIn.channel} [GPIO=${gpioValue}]`;
      onLog('io', `${door.name} REX (${where}) driven ${newState ? 'PRESSED' : 'IDLE'}`);
      onAuditLog(`${door.name}: REX ${newState ? 'pressed' : 'released'}`);
    } catch (e: any) {
      onLog('error', `Failed to drive ${door.name} REX (ch ${door.rexIn.channel}): ${e.message}`);
    }
  };

  /** ---------- Read Door Input States ---------- */
  const refreshDoorInputs = async (doorId: number) => {
    if (!connected) return;
    const door = doors.find(d => d.id === doorId);
    if (!door) return;

    // #2: emulated door — read input states from the board snapshot.
    const emuB = boardForDoor(door);
    if (emuB) {
      try {
        const boards = await fetchEmuStatus(ipAddress);
        const b = boards.find(x => x.address === emuB.address);
        if (!b) { onLog('error', `${door.name}: emulated board #${emuB.address} not found`); return; }
        const rawDps = b.inputs && door.dps.channel < b.numInputs ? !!b.inputs[door.dps.channel] : false;
        const rawRex = b.inputs && door.rexIn.channel < b.numInputs ? !!b.inputs[door.rexIn.channel] : false;
        const dpsActive = door.dps.reverseSense ? !rawDps : rawDps;
        const rexActive = door.rexIn.reverseSense ? !rawRex : rawRex;
        setDoors(prev => prev.map(d =>
          d.id === doorId ? {
            ...d,
            dps: { ...d.dps, active: dpsActive, supervisionState: dpsActive ? 'active' : 'normal' },
            rexIn: { ...d.rexIn, active: rexActive, supervisionState: rexActive ? 'active' : 'normal' }
          } : d
        ));
        onLog('info', `${door.name}: Inputs refreshed from emulated #${b.address} — DPS:${dpsActive ? 'OPEN' : 'closed'} REX:${rexActive ? 'PRESSED' : 'idle'}`);
      } catch (e: any) {
        onLog('error', `Failed to refresh ${door.name} from emulated board: ${e.message}`);
      }
      return;
    }

    try {
      // Read DPS
      let dpsState = false;
      let dpsSupervision: 'normal' | 'active' | 'trouble' | 'short' = 'normal';

      if (door.dps.hardwareType === 'opto') {
        const result = await readOptoInput(ipAddress, door.dps.channel, door.dps.stackLevel);
        dpsState = door.dps.reverseSense ? !result.state : !!result.state;
        dpsSupervision = dpsState ? 'active' : 'normal';
      } else if (door.dps.hardwareType === 'analog') {
        const result = await readAnalogInput(ipAddress, door.dps.channel, door.dps.stackLevel);
        const apiState = result.supervisionState;
        if (apiState === 'ALARM') { dpsState = true; dpsSupervision = 'active'; }
        else if (apiState === 'TAMPER') { dpsState = true; dpsSupervision = 'short'; }
        else if (apiState === 'TROUBLE') { dpsState = false; dpsSupervision = 'trouble'; }
        else { dpsState = false; dpsSupervision = 'normal'; }
      }

      // Read REX
      let rexState = false;
      let rexSupervision: 'normal' | 'active' | 'trouble' | 'short' = 'normal';

      if (door.rexIn.hardwareType === 'opto') {
        const result = await readOptoInput(ipAddress, door.rexIn.channel, door.rexIn.stackLevel);
        rexState = door.rexIn.reverseSense ? !result.state : !!result.state;
        rexSupervision = rexState ? 'active' : 'normal';
      } else if (door.rexIn.hardwareType === 'analog') {
        const result = await readAnalogInput(ipAddress, door.rexIn.channel, door.rexIn.stackLevel);
        const apiState = result.supervisionState;
        if (apiState === 'ALARM') { rexState = true; rexSupervision = 'active'; }
        else if (apiState === 'TAMPER') { rexState = true; rexSupervision = 'short'; }
        else if (apiState === 'TROUBLE') { rexState = false; rexSupervision = 'trouble'; }
        else { rexState = false; rexSupervision = 'normal'; }
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? {
          ...d,
          dps: { ...d.dps, active: dpsState, supervisionState: dpsSupervision },
          rexIn: { ...d.rexIn, active: rexState, supervisionState: rexSupervision }
        } : d
      ));

      onLog('info', `${door.name}: Inputs refreshed - DPS: ${dpsSupervision}, REX: ${rexSupervision}`);
    } catch (e: any) {
      onLog('error', `Failed to refresh ${door.name} inputs: ${e.message}`);
    }
  };

  /** ---------- Custom Event Handler ---------- */
  // #feat: shared step runner — used by BOTH handleCustomEvent (saved events)
  // and the editor's Test Run (possibly-unsaved steps). hooks drive the
  // executing-step highlight (5) and the result summary (6). Returns counts.
  type EventRunHooks = {
    onStepStart?: (index: number, step: CustomEventStep) => void;
    onStepEnd?: (index: number, step: CustomEventStep, ok: boolean) => void;
  };
  const runEventSteps = async (
    doorId: number,
    steps: CustomEventStep[],
    hooks?: EventRunHooks
  ): Promise<{ ran: number; failed: number; total: number }> => {
    const door = doors.find(d => d.id === doorId);
    const summary = { ran: 0, failed: 0, total: steps.length };
    if (!door) { onLog('error', 'Cannot run steps: door not found'); return summary; }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      hooks?.onStepStart?.(i, step);
      let __stepFailed = false;
      if (step.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, step.delay));
      }

      try {
        // #2 stale-state fix: re-read the door from current state each step.
        // toggleDoorLock / simulate* update React state asynchronously, so the
        // `door` captured at function start goes stale across multi-step
        // sequences. Reading the live door here makes guards/decisions correct.
        const cur = doors.find(d => d.id === doorId) || door;

        switch (step.action) {
          case 'lock':
            // #2-fix: drive LOCKED directionally (active:false). Previously
            // guarded on stale `cur.lock.active`, which skipped a later 'lock'
            // after an 'unlock' in the same sequence.
            await toggleDoorLock(doorId, false);
            onLog('io', `Step ${i + 1}: Locked ${door.name}`);
            break;
          case 'unlock':
            // #2-fix: drive UNLOCKED directionally (active:true).
            await toggleDoorLock(doorId, true);
            onLog('io', `Step ${i + 1}: Unlocked ${door.name}`);
            break;
          case 'open-dps':
            // #2: DIRECTIONAL — explicitly OPEN (was a blind toggle)
            await simulateDoorDPS(doorId, true);
            onLog('io', `Step ${i + 1}: DPS set OPEN on ${door.name}`);
            break;
          case 'close-dps':
            // #2: DIRECTIONAL — explicitly CLOSE
            await simulateDoorDPS(doorId, false);
            onLog('io', `Step ${i + 1}: DPS set CLOSED on ${door.name}`);
            break;
          case 'activate-rex':
            await simulateDoorREX(doorId, true);
            onLog('io', `Step ${i + 1}: REX ACTIVATED on ${door.name}`);
            break;
          case 'deactivate-rex':
            await simulateDoorREX(doorId, false);
            onLog('io', `Step ${i + 1}: REX RELEASED on ${door.name}`);
            break;
          case 'wait': {
            // #3: pure wait step (seconds / minutes / random range)
            let ms: number;
            if (step.waitType === 'random') {
              const lo = Math.max(0, (step.waitMin ?? 1)) * 1000;
              const hi = Math.max(lo, (step.waitMax ?? 5) * 1000);
              ms = lo + Math.random() * (hi - lo);
              onLog('io', `Step ${i + 1}: Wait ~${Math.round(ms)}ms (random ${step.waitMin ?? 1}-${step.waitMax ?? 5}s) on ${door.name}`);
            } else if (step.waitType === 'minutes') {
              ms = (step.waitValue ?? 1) * 60000;
              onLog('io', `Step ${i + 1}: Wait ${step.waitValue ?? 1} min on ${door.name}`);
            } else {
              ms = (step.waitValue ?? 5) * 1000;
              onLog('io', `Step ${i + 1}: Wait ${step.waitValue ?? 5} sec on ${door.name}`);
            }
            await new Promise(resolve => setTimeout(resolve, ms));
            break;
          }
          case 'pulse': {
            // #3 + pulse-fix: momentary activate -> hold -> auto-release.
            // Robustness: explicit target normalization, a real (non-zero)
            // default hold, and clear per-phase logging so a pulse can never
            // silently no-op. Drives the SAME directional functions the
            // working open/close-dps steps use.
            const rawTarget = (step.pulseTarget || 'lock').toString().toLowerCase();
            const target: 'lock' | 'dps' | 'rex' =
              rawTarget === 'dps' ? 'dps' : rawTarget === 'rex' ? 'rex' : 'lock';
            let holdMs = Number(step.pulseDuration);
            if (!Number.isFinite(holdMs) || holdMs <= 0) holdMs = 1000;
            onLog('io', `Step ${i + 1}: Pulse ${target.toUpperCase()} — begin (hold ${holdMs}ms)`);
            if (target === 'lock') {
              await toggleDoorLock(doorId, true);
              await new Promise(r => setTimeout(r, holdMs));
              await toggleDoorLock(doorId, false);
              onLog('io', `Step ${i + 1}: Pulse LOCK — unlocked then relocked`);
            } else if (target === 'dps') {
              await simulateDoorDPS(doorId, true);
              await new Promise(r => setTimeout(r, holdMs));
              await simulateDoorDPS(doorId, false);
              onLog('io', `Step ${i + 1}: Pulse DPS — opened then closed`);
            } else {
              await simulateDoorREX(doorId, true);
              await new Promise(r => setTimeout(r, holdMs));
              await simulateDoorREX(doorId, false);
              onLog('io', `Step ${i + 1}: Pulse REX — activated then released`);
            }
            break;
          }
          case 'toggle-io':
            if (step.ioId) {
              await toggleDoorDynamicIO(doorId, step.ioId);
              onLog('io', `Step ${i + 1}: Toggled I/O on ${door.name}`);
            } else {
              onLog('warn', `Step ${i + 1}: toggle-io step has no I/O selected — skipped`);
            }
            break;
          case 'send-card': {
            // #3: resolve the reader. If the step has no explicit readerId,
            // fall back to the door's assigned reader so the step still works.
            const targetReader = step.readerId || cur.reader || '';
            if (!targetReader) {
              onLog('warn', `Step ${i + 1}: send-card has no reader (none selected and door has no assigned reader) — skipped`);
              break;
            }
            if (!step.cardFormat || step.facilityCode === undefined || step.cardNumber === undefined) {
              onLog('warn', `Step ${i + 1}: send-card missing format/FC/card — skipped`);
              break;
            }
            await sendCredentialToReader(targetReader, {
              format: parseInt(step.cardFormat, 10),
              facility: parseInt(String(step.facilityCode), 10),
              card: parseInt(String(step.cardNumber), 10)
            });
            onLog('io', `Step ${i + 1}: Card presented on ${door.name}`);
            break;
          }
          default:
            onLog('warn', `Step ${i + 1}: unknown action "${step.action}" — skipped`);
        }
      } catch (e: any) {
        __stepFailed = true;
        summary.failed++;
        onLog('error', `Step ${i + 1} (${step.action}) failed: ${e.message}`);
      }
      if (!__stepFailed) summary.ran++;
      hooks?.onStepEnd?.(i, step, !__stepFailed);
    }


    return summary;
  };

  const handleCustomEvent = async (doorId: number, eventNumber: number) => {
    const door = doors.find(d => d.id === doorId);
    if (!door || !connected || !door.enabled) {
      onLog('error', `Cannot execute custom event: door not found or not enabled`);
      return;
    }

    const customEvents = door.customEvents || [];
    if (eventNumber < 1 || eventNumber > customEvents.length) {
      onLog('error', `Invalid custom event number: ${eventNumber}`);
      return;
    }

    const event = customEvents[eventNumber - 1];
    if (!event.enabled) {
      onLog('warn', `Custom event "${event.name}" is disabled`);
      return;
    }

    onAuditLog(`Executing custom event: ${event.name} on ${door.name}`);
    onLog('info', `🎬 Starting custom event: ${event.name} (${event.steps.length} steps)`);
    await runEventSteps(doorId, event.steps);
    onLog('success', `✓ Custom event completed: ${event.name}`);
  };


  /** ---------- Dynamic I/O Handlers ---------- */
  const addDoorIO = (doorId: number) => {
    const door = doors.find(d => d.id === doorId);
    if (!door || door.ios.length >= 6) return;

    const newIO: DoorIO = {
      id: `door${doorId}-io-${Date.now()}`,
      name: `I/O ${door.ios.length + 1}`,
      type: 'General',
      hardwareType: 'relay',
      channel: 0,
      active: false,
      enabled: true
    };

    setDoors(prev => prev.map(d =>
      d.id === doorId ? { ...d, ios: [...d.ios, newIO] } : d
    ));

    onAuditLog(`Added I/O to ${door.name}`);
  };

  const removeDoorIO = (doorId: number, ioId: string) => {
    setDoors(prev => prev.map(d =>
      d.id === doorId ? { ...d, ios: d.ios.filter(io => io.id !== ioId) } : d
    ));
    onAuditLog(`Removed I/O from Door ${doorId}`);
  };

  const toggleDoorDynamicIO = async (doorId: number, ioId: string) => {
    if (!connected) return;
    const door = doors.find(d => d.id === doorId);
    if (!door || !door.enabled) return;

    const io = door.ios.find(i => i.id === ioId);
    if (!io || io.channel < 0) return;

    const newState = !io.active;

    try {
      if (io.hardwareType === 'relay') {
        await setRelayOutput(ipAddress, io.channel, newState ? 1 : 0, io.stackLevel);
      }
      // For opto/analog inputs, we just toggle the local state for simulation

      setDoors(prev => prev.map(d => {
        if (d.id !== doorId) return d;
        return {
          ...d,
          ios: d.ios.map(i => i.id === ioId ? { ...i, active: newState } : i)
        };
      }));

      onLog('io', `${door.name} ${io.name} (${io.hardwareType} ${io.channel}) ${newState ? 'ACTIVE' : 'INACTIVE'}`);
    } catch (e: any) {
      onLog('error', `Failed to toggle ${io.name}: ${e.message}`);
    }
  };

  const updateDoorIOConfig = (doorId: number, ioId: string, field: keyof DoorIO, value: any) => {
    setDoors(prev => prev.map(d =>
      d.id === doorId ? {
        ...d,
        ios: d.ios.map(io => io.id === ioId ? { ...io, [field]: value } : io)
      } : d
    ));
  };

  /** ---------- Reader & Credential Handlers ---------- */
  const assignReaderToDoor = (doorId: number, readerId: string | null) => {
    // #3: single reader per door. ctrl-emu-* ids are emulated board readers
    // (not in readerPool) and are assigned directly.
    setDoors(prev => prev.map(d =>
      d.id === doorId ? { ...d, reader: readerId } : d
    ));
    if (readerId && !readerId.startsWith('ctrl-emu-')) {
      onUpdateReaderPool(readerPool.map(r =>
        r.id === readerId ? { ...r, assignedToDoor: doorId, position: 'in' }
        : (r.assignedToDoor === doorId ? { ...r, assignedToDoor: null, position: null } : r)
      ));
    }
    onAuditLog(`${readerId ? 'Assigned' : 'Cleared'} reader for Door ${doorId}`);
  };

  const sendCredentialToReader = async (readerId: string, credential: { format: number; facility: number; card: number; formatId?: string }) => {
    if (!connected) return;

    // #2: emulated board reader id form: 'ctrl-emu-<addr>-<port>'
    if (readerId.startsWith('ctrl-emu-')) {
      const m = readerId.match(/^ctrl-emu-(\d+)-(\d+)$/);
      if (!m) { onLog('error', `Bad emulated reader id: ${readerId}`); return; }
      const addr = parseInt(m[1], 10);
      const port = parseInt(m[2], 10);
      try {
        await sendEmuCard(ipAddress, addr, port, credential.format, credential.facility, credential.card, credential.formatId);
        onLog('success', `✓ Credential presented to emulated #${addr} reader ${port}`);
        onAuditLog(`Card sent (emulated #${addr} rdr ${port}): FC=${credential.facility}, Card=${credential.card}`);
      } catch (e: any) {
        onLog('error', `✗ Emulated card error: ${e.message}`);
      }
      return;
    }

    const reader = readerPool.find(r => r.id === readerId);
    if (!reader || !reader.enabled) {
      onLog('error', 'Reader not found or disabled');
      return;
    }

    try {
      const result = await fetchJson(`http://${ipAddress}:3001/api/wiegand/transmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          d0Pin: reader.d0,
          d1Pin: reader.d1,
          facility: credential.facility,
          card: credential.card,
          bits: credential.format,
          format: credential.formatId,   // #fmt: also send the catalog format id
          pulseWidth: 50
        })
      });

      if ((result as any).success) {
        onLog('success', `✓ Credential transmitted to ${reader.name}`);
        onAuditLog(`Card sent: FC=${credential.facility}, Card=${credential.card} on ${reader.name}`);
      } else {
        onLog('error', `✗ Transmission failed: ${(result as any).error || 'Unknown error'}`);
      }
    } catch (e: any) {
      onLog('error', `✗ API error: ${e.message}`);
    }
  };

  const sendLibraryCredentialToReader = async (readerId: string, credentialId: string) => {
    const credential = credentialLibrary.find(c => c.id === credentialId);
    if (!credential) return;

    await sendCredentialToReader(readerId, {
      format: parseInt(credential.format.split('-')[0], 10),
      facility: parseInt(credential.facilityCode, 10),
      card: parseInt(credential.cardNumber, 10)
    });
  };

  /** ---------- Door Management ---------- */
  // #5: create a new door in the next free slot with sensible defaults.
  const createDoor = () => {
    if (doors.length >= MAX_DOORS) {
      onLog('warn', `Maximum of ${MAX_DOORS} doors reached`);
      return;
    }
    const name = (newDoorName || '').trim() || `Door ${doors.length + 1}`;
    const nextId = (doors.reduce((m, d) => Math.max(m, d.id), 0) || 0) + 1;
    // pick the next free relay/input channels (0-7 wrap) based on existing count
    const idx = doors.length;
    const relayCh = idx % 8;
    const dpsCh = idx % 8;
    const rexCh = (idx + 4) % 8;
    const door: Door = {
      id: nextId,
      name,
      enabled: true,
      ioSource: newDoorSource,
      emuBoard: 0,
      emuReaderPort: 0,
      lock:  { name: 'Door Strike',  hardwareType: 'relay', channel: relayCh, active: false },
      dps:   { name: 'Door Position', hardwareType: 'opto', channel: dpsCh, active: false, supervisionState: 'normal' },
      rexIn: { name: 'REX Button',   hardwareType: 'opto', channel: rexCh, active: false, supervisionState: 'normal' },
      ios: [],
      reader: null,
      customEvents: Array.from({ length: 6 }, (_, i) => ({ name: `Custom Event ${i + 1}`, enabled: false, steps: [] })),
    };
    setDoors(prev => [...prev, door]);
    setShowAddDialog(false);
    setNewDoorName('');
    setNewDoorSource('physical');
    onAuditLog(`Added door: ${name}`);
    onLog('success', `Door "${name}" created`);
    // open Settings on the new door so it can be configured immediately
    setEditingDoorId(nextId);
    setShowDoorSettings(true);
  };

  // #5: delete a door (empties its slot back to an Add tile).
  const deleteDoor = (doorId: number) => {
    const d = doors.find(x => x.id === doorId);
    if (!d) return;
    if (!confirm(`Delete door "${d.name}"? This cannot be undone.`)) return;
    setDoors(prev => prev.filter(x => x.id !== doorId));
    onAuditLog(`Deleted door: ${d.name}`);
    onLog('warn', `Door "${d.name}" deleted`);
  };

  const toggleDoorEnabled = (doorId: number) => {
    setDoors(prev => prev.map(door =>
      door.id === doorId ? { ...door, enabled: !door.enabled } : door
    ));
    onAuditLog(`Toggled Door ${doorId} enabled status`);
  };

  /** ---------- Configuration Persistence ---------- */
  const saveDoorConfiguration = async (doorsOverride?: any[]) => {
    const doorsToSave = doorsOverride || doors;
    const config = {
      version: '3.0',
      timestamp: new Date().toISOString(),
      systemOutputs: {
        powerFault: globalPowerFault,
        batteryFault: globalBatteryFault,
        tamper: globalTamper,
        fai: globalFAI
      },
      doors: doorsToSave.map(door => ({
        id: door.id,
        name: door.name,
        enabled: door.enabled,
        ioSource: door.ioSource || 'physical',
        emuBoard: door.emuBoard || 0,
        emuReaderPort: door.emuReaderPort || 0,
        lock: door.lock,
        dps: door.dps,
        rexIn: door.rexIn,
        ios: door.ios,
        reader: door.reader ?? null,
        customEvents: door.customEvents
      }))
    };

    // localStorage = instant cache (kept). Backend POST = durable across reboot.
    try {
      localStorage.setItem('doorSectionConfig', JSON.stringify(config));
    } catch (e: any) {
      onLog('error', `Local save failed: ${e.message}`);
    }
    try {
      const resp = await fetchJson(`http://${ipAddress}:3001/api/doors/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (resp && (resp as any).success) {
        onLog('success', 'Door configuration saved to device (will survive reboot)');
        onAuditLog('Saved door configuration to backend');
      } else {
        onLog('warn', `Saved locally; device save returned: ${(resp as any)?.error || 'unknown'}`);
      }
    } catch (e: any) {
      // Backend unreachable: local cache still holds it; don't lose the user's work.
      onLog('warn', `Saved locally only — device not reachable (${e.message}). Will not survive reboot until re-saved while connected.`);
    }
  };

  // #persist: apply a parsed config object to state (shared by localStorage
  // load AND backend load). Pure application logic — no source assumptions.
  const applyDoorConfig = (config: any) => {
    try {
      if (!config) return false;

      if (config.systemOutputs) {
        setGlobalPowerFault(config.systemOutputs.powerFault || globalPowerFault);
        setGlobalBatteryFault(config.systemOutputs.batteryFault || globalBatteryFault);
        setGlobalTamper(config.systemOutputs.tamper || globalTamper);
        setGlobalFAI(config.systemOutputs.fai || globalFAI);
      }

      if (config.doors) {
        // Migrate from old format if needed
        const migratedDoors = config.doors.map((door: any) => {
          // Legacy: a 'gpio' field was used in older DoorSettings — migrate to 'channel'.
          const migrateEdge = (edge: any) => {
            if (!edge) return edge;
            const next = { ...edge };
            if (next.channel === undefined && next.gpio !== undefined) {
              next.channel = next.gpio;
            }
            delete next.gpio;
            return next;
          };
          let d = { ...door };
          // #3: migrate legacy readers:{in,out} -> single reader (prefer 'in')
          if (d.reader === undefined) {
            if (d.readers && typeof d.readers === 'object') {
              d.reader = d.readers.in || d.readers.out || null;
            } else {
              d.reader = null;
            }
          }
          delete d.readers;
          if (d.lock) d.lock = migrateEdge(d.lock);
          if (d.dps) d.dps = migrateEdge(d.dps);
          if (d.rexIn) d.rexIn = migrateEdge(d.rexIn);
          if (Array.isArray(d.ios)) d.ios = d.ios.map((io: any) => migrateEdge(io));

          // Check if using old channel-based format without hardwareType
          if (d.lock && d.lock.channel !== undefined && !d.lock.hardwareType) {
            return {
              ...d,
              lock: { ...d.lock, hardwareType: 'relay' as const },
              dps: { ...d.dps, hardwareType: 'opto' as const, supervisionState: 'normal' as const },
              rexIn: { ...d.rexIn, hardwareType: 'opto' as const, supervisionState: 'normal' as const }
            };
          }
          return d;
        });
        setDoors(migratedDoors);
      }

      onLog('success', `Door configuration loaded (v${config.version || '1.0'})`);
      onAuditLog('Loaded door configuration');
      return true;
    } catch (e: any) {
      onLog('error', `Failed to apply configuration: ${e.message}`);
      return false;
    }
  };

  // localStorage-only load (instant, used as fallback)
  const loadDoorConfiguration = () => {
    try {
      const savedConfig = localStorage.getItem('doorSectionConfig');
      if (!savedConfig) return false;
      return applyDoorConfig(JSON.parse(savedConfig));
    } catch (e: any) {
      onLog('error', `Failed to load local configuration: ${e.message}`);
      return false;
    }
  };

  // #persist: backend-first load so events survive a reboot. Tries the
  // backend; on any miss/error falls back to localStorage, then defaults.
  const loadDoorConfigurationFromBackend = async () => {
    try {
      const data = await fetchJson(`http://${ipAddress}:3001/api/doors/config`);
      if (data && (data as any).success && (data as any).config) {
        const ok = applyDoorConfig((data as any).config);
        if (ok) {
          onLog('success', 'Door configuration restored from device (survives reboot)');
          return;
        }
      }
      // No backend config (or it failed to apply) -> local fallback
      if (!loadDoorConfiguration()) {
        onLog('info', 'No saved door configuration — using defaults');
      }
    } catch (e: any) {
      // Backend unreachable -> local fallback (don't block the UI)
      if (!loadDoorConfiguration()) {
        onLog('info', 'Backend not reachable for door config — using local/defaults');
      }
    }
  };

  const resetDoorConfiguration = () => {
    if (!confirm('Reset all door configurations to defaults? This cannot be undone.')) {
      return;
    }

    setGlobalPowerFault({ name: 'Power Fault', hardwareType: 'relay', channel: -1, active: false });
    setGlobalBatteryFault({ name: 'Battery Fault', hardwareType: 'relay', channel: -1, active: false });
    setGlobalTamper({ name: 'System Tamper', hardwareType: 'relay', channel: -1, active: false });
    setGlobalFAI({ name: 'Fire Alarm Input', hardwareType: 'relay', channel: -1, active: false });
    setDoors(createDefaultDoors());

    onLog('warn', 'Door configuration reset to defaults');
    onAuditLog('Reset door configuration to defaults');
  };

  /** #redesign: one door as a self-contained transparent card. */
  // ── Door card (compact) ────────────────────────────────────────────────
  const [credOpen, setCredOpen] = useState<Record<number, boolean>>({});
  const [lastEvent, setLastEvent] = useState<Record<number, number>>({});
  const [runningEvent, setRunningEvent] = useState<Record<number, number | null>>({});

  const runDoorEvent = async (doorId: number, num: number) => {
    setLastEvent(p => ({ ...p, [doorId]: num }));
    setRunningEvent(p => ({ ...p, [doorId]: num }));
    try { await handleCustomEvent(doorId, num); }
    finally { setRunningEvent(p => ({ ...p, [doorId]: null })); }
  };

  const supColor = (s?: string) =>
    s === 'active' ? DC.good : s === 'trouble' ? DC.warn : s === 'short' ? DC.crit : null;

  const renderReader = (door: Door) => {
    const rid = door.reader;
    if (!rid) {
      return (
        <div className="flex items-center gap-2 text-xs" style={{ color: DC.dim }}>
          <Radio className="w-3.5 h-3.5 shrink-0" />
          No reader assigned. Choose one in
          <button onClick={() => { setEditingDoorId(door.id); setShowDoorSettings(true); }} className="underline" style={{ color: DC.text2 }}>Settings</button>.
        </div>
      );
    }
    let label = rid;
    if (rid.startsWith('ctrl-emu-')) {
      const m = rid.match(/^ctrl-emu-(\d+)-(\d+)$/);
      if (m) {
        const addr = parseInt(m[1], 10), port = parseInt(m[2], 10);
        const b = emuBoards.find(x => x.address === addr);
        label = `#${addr}${b ? ' ' + b.model : ''} · Reader ${port}`;
      }
    } else {
      const r = readerPool.find(x => x.id === rid);
      if (r) label = `${r.name} ${r.type === 'wiegand' ? `(D0:${r.d0}, D1:${r.d1})` : `(OSDP ${r.address})`}`;
    }

    const entry = credEntry[door.id] || { fmtId: 'w26', fc: '', card: '', cat: 'all' };
    const setEntry = (patch: Partial<{ fmtId: string; fc: string; card: string; cat: string }>) =>
      setCredEntry(prev => ({ ...prev, [door.id]: { ...(prev[door.id] || { fmtId: 'w26', fc: '', card: '', cat: 'all' }), ...patch } }));
    const fmt = getCardFormatById ? getCardFormatById(entry.fmtId) : undefined;
    const fmtBits = fmt?.bits ?? 26;
    const hasFC = fmt ? (fmt.facilityBits !== 0) : true;
    const maxFC = fmt?.maxFacility ?? 255;
    const maxCard = fmt?.maxCard ?? 65535;
    const catFormats = (cardFormats || []).filter((f: any) => entry.cat === 'all' ? true : f.category === entry.cat);

    const prefillFromLibrary = (credId: string) => {
      const cred = credentialLibrary.find(x => x.id === credId);
      if (!cred) return;
      let fid = 'w26';
      const raw = String(cred.format || '').toLowerCase();
      const byId = (cardFormats || []).find((f: any) => f.id === raw);
      if (byId) fid = byId.id;
      else {
        const m = raw.match(/(\d+)/);
        if (m) {
          const b = parseInt(m[1], 10);
          const byBits = (cardFormats || []).find((f: any) => f.bits === b);
          if (byBits) fid = byBits.id;
        }
      }
      setEntry({ fmtId: fid, fc: String(cred.facilityCode ?? ''), card: String(cred.cardNumber ?? '') });
    };
    const clampFC = (v: string) => { if (v === '') return ''; const n = parseInt(v, 10); return Number.isFinite(n) ? String(Math.max(0, Math.min(n, maxFC))) : ''; };
    const clampCard = (v: string) => { if (v === '') return ''; const n = parseInt(v, 10); return Number.isFinite(n) ? String(Math.max(0, Math.min(n, maxCard))) : ''; };

    const ready = !!fmt && entry.card !== '' && (!hasFC || entry.fc !== '');
    const presentCard = () => {
      const facility = hasFC ? parseInt(entry.fc, 10) : 0;
      const card = parseInt(entry.card, 10);
      if (!fmt) { onLog('error', 'Select a valid card format'); return; }
      if (hasFC && (!Number.isFinite(facility) || !isValidFacilityCode(fmt, facility))) { onLog('error', `Invalid facility code (0-${maxFC})`); setCredOpen(p => ({ ...p, [door.id]: true })); return; }
      if (!Number.isFinite(card) || !isValidCardNumber(fmt, card)) { onLog('error', `Invalid card number (0-${maxCard.toLocaleString()})`); setCredOpen(p => ({ ...p, [door.id]: true })); return; }
      sendCredentialToReader(door.reader!, { format: fmtBits, facility, card, formatId: fmt.id } as any);
    };
    const open = !!credOpen[door.id];
    const inputCls = 'w-full rounded-md px-2 py-1.5 text-sm border outline-none focus:border-hv-info';
    const inputStyle = { background: 'rgb(var(--hv-surface))', borderColor: DC.line, color: DC.text };

    return (
      <div>
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 shrink-0" style={{ color: DC.teal }} />
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate" style={{ color: DC.text }} title={label}>{label}</div>
            <button onClick={() => setCredOpen(p => ({ ...p, [door.id]: !open }))} className="text-[11px] flex items-center gap-1.5 max-w-full" style={{ color: DC.dim }}
              title={fmt ? `${fmt.bits}-bit ${fmt.name}` : undefined}>
              <span className="truncate">{fmt ? `${fmt.bits}-bit` : 'Format'}{hasFC ? ` · FC ${entry.fc || '–'}` : ''} · Card {entry.card || '–'}</span>
              <span className="shrink-0 underline" style={{ color: DC.text2 }}>{open ? 'done' : 'edit'}</span>
            </button>
          </div>
          <button onClick={presentCard} disabled={!connected || !door.enabled || cardFormatsLoading || !ready}
            title={ready ? 'Send this credential to the reader' : 'Enter the card details first'}
            className="px-3 py-1.5 rounded-md text-xs font-bold border transition-colors disabled:opacity-35"
            style={{ background: 'rgb(var(--hv-info) / 0.15)', borderColor: 'rgb(var(--hv-info) / 0.45)', color: 'rgb(var(--hv-success-text))' }}>
            Present card
          </button>
        </div>

        {open && (
          <div className="mt-3 space-y-2">
            <select defaultValue="" onChange={(e) => { if (e.target.value) prefillFromLibrary(e.target.value); }} className={inputCls} style={inputStyle}>
              <option value="">Fill from a saved credential…</option>
              {credentialLibrary.map(cred => <option key={cred.id} value={cred.id}>{cred.name} ({cred.format})</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <select value={entry.cat} disabled={cardFormatsLoading} className={inputCls} style={inputStyle}
                onChange={(e) => {
                  const cat = e.target.value;
                  const list = (cardFormats || []).filter((f: any) => cat === 'all' ? true : f.category === cat);
                  setEntry({ cat, fmtId: list.some((f: any) => f.id === entry.fmtId) ? entry.fmtId : (list[0]?.id || entry.fmtId) });
                }}>
                {FORMAT_CATEGORIES.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
              </select>
              <select value={entry.fmtId} onChange={(e) => setEntry({ fmtId: e.target.value })} disabled={cardFormatsLoading || catFormats.length === 0} className={inputCls} style={inputStyle}>
                {catFormats.length === 0
                  ? <option>{cardFormatsLoading ? 'Loading…' : 'No formats'}</option>
                  : catFormats.map((f: any) => <option key={f.id} value={f.id}>{f.name || f.id} ({f.bits}-bit)</option>)}
              </select>
            </div>
            <div className={`grid ${hasFC ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
              {hasFC && (
                <input type="number" value={entry.fc} min={0} max={maxFC} placeholder={`Facility (0-${maxFC.toLocaleString()})`}
                  onChange={(e) => setEntry({ fc: e.target.value })} onBlur={(e) => setEntry({ fc: clampFC(e.target.value) })} className={inputCls} style={inputStyle} />
              )}
              <input type="number" value={entry.card} min={0} max={maxCard} placeholder={`Card (0-${maxCard.toLocaleString()})`}
                onChange={(e) => setEntry({ card: e.target.value })} onBlur={(e) => setEntry({ card: clampCard(e.target.value) })} className={inputCls} style={inputStyle} />
            </div>
          </div>
        )}
      </div>
    );
  };

  const IoRow = ({ label, meta, dot, badge, btn, active, onClick, disabled, title, activeColor = DC.good }: {
    label: string; meta: React.ReactNode; dot: string | null; badge?: React.ReactNode;
    btn: string; active: boolean; onClick: () => void; disabled?: boolean; title?: string; activeColor?: string;
  }) => (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dot || 'rgb(var(--hv-line))', boxShadow: dot ? `0 0 8px color-mix(in srgb, ${dot} 53%, transparent)` : 'none' }} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold truncate" style={{ color: DC.text }}>{label}{badge}</div>
        <div className="text-[11px] truncate" style={{ color: DC.dim }}>{meta}</div>
      </div>
      <button onClick={onClick} disabled={disabled} title={title}
        className="w-[92px] shrink-0 py-1.5 rounded-md text-xs font-bold border transition-all disabled:opacity-35"
        style={active
          ? { background: `color-mix(in srgb, ${activeColor} 20%, transparent)`, borderColor: activeColor, color: 'rgb(var(--hv-text))' }
          : { background: 'rgb(var(--hv-widget-panel))', borderColor: DC.line, color: DC.text2 }}>
        {btn}
      </button>
    </div>
  );

  const renderDoorCard = (door: Door) => {
    const emu = door.ioSource === 'emulated';
    const board = emuBoards.find(x => x.address === door.emuBoard);
    const isOpen = door.dps.active;
    const unlocked = door.lock.active;
    const state = !door.enabled ? 'DISABLED' : isOpen ? 'OPEN' : unlocked ? 'UNLOCKED' : 'LOCKED';
    const stateColor = !door.enabled ? DC.dim : isOpen ? DC.blue : unlocked ? DC.good : DC.crit;
    const events = (door.customEvents || []).map((e, i) => ({ ...e, num: i + 1 })).filter(e => e.enabled);
    const chan = (io: { channel: number; hardwareType?: string }, kind: 'in' | 'out') =>
      emu ? `${kind === 'out' ? 'Output' : 'Input'} ${io.channel}${door.emuBoard ? ` · #${door.emuBoard}` : ''}`
          : kind === 'out' ? `Relay ${io.channel}` : `${io.hardwareType === 'analog' ? 'Analog' : 'Opto'} ${io.channel}`;

    return (
      <div key={door.id} className="rounded-xl border overflow-hidden transition-colors"
        style={{ background: 'rgb(var(--hv-widget) / 0.45)', borderColor: door.enabled && (isOpen || unlocked) ? `color-mix(in srgb, ${stateColor} 40%, transparent)` : 'rgb(var(--hv-line))' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: DC.line }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-lg font-bold truncate" style={{ color: DC.text }}>{door.name}</h3>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider shrink-0"
                style={{ background: `color-mix(in srgb, ${stateColor} 13%, transparent)`, color: stateColor, border: `1px solid color-mix(in srgb, ${stateColor} 33%, transparent)` }}>{state}</span>
            </div>
            <div className="text-[11px] mt-0.5 truncate" style={{ color: DC.dim }}>
              {emu
                ? <>Azure controller · {board ? `#${board.address} ${board.model}${board.online ? '' : ' (offline)'}` : <span style={{ color: DC.warn }}>no board selected</span>}</>
                : 'Aether · onboard Sequent I/O'}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <IconBtn title="Refresh inputs from hardware" onClick={() => refreshDoorInputs(door.id)} disabled={!connected || !door.enabled}><RefreshCw size={15} /></IconBtn>
            <IconBtn title="Door settings" onClick={() => { setEditingDoorId(door.id); setShowDoorSettings(true); }}><Settings size={15} /></IconBtn>
            <IconBtn title="Delete this door" onClick={() => deleteDoor(door.id)} danger><Trash2 size={15} /></IconBtn>
            <button onClick={() => toggleDoorEnabled(door.id)} title={door.enabled ? 'Enabled: click to disable' : 'Disabled: click to enable'}
              className="ml-1 relative w-10 h-5 rounded-full transition-colors" style={{ background: door.enabled ? 'rgb(var(--hv-success-strong))' : 'rgb(var(--hv-line))' }}>
              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: door.enabled ? 22 : 2 }} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
          {/* Door: fills the whole panel, whatever height the controls make it */}
          <div className="relative sm:border-r" style={{ borderColor: DC.line, background: 'rgb(var(--hv-surface) / 0.45)', minHeight: 270 }}>
            <DoorScene isLocked={!door.lock.active} isOpen={door.dps.active} rexActive={door.rexIn.active} enabled={door.enabled}
              viewBox="22 1 156 250"
              style={{ position: 'absolute', top: 10, left: 8, width: 'calc(100% - 16px)', height: 'calc(100% - 20px)' }} />
            {door.enabled && door.rexIn.active && (
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[10px] font-bold"
                style={{ background: 'rgb(var(--hv-brand) / 0.2)', color: DC.amber, border: `1px solid color-mix(in srgb, ${DC.amber} 40%, transparent)` }}>REX</span>
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-col min-w-0">
            <div className="divide-y divide-hv-popup-panel">
              <IoRow label={door.lock.name} meta={<>{chan(door.lock, 'out')}{emu ? ' · driven by controller' : ''}</>}
                dot={unlocked ? DC.good : null} active={unlocked} btn={unlocked ? 'UNLOCKED' : 'LOCKED'}
                onClick={() => toggleDoorLock(door.id)} disabled={!connected || !door.enabled}
                title={emu ? 'Shows the controller’s lock output. Click to override.' : 'Toggle the door strike relay'} />
              <IoRow label={door.dps.name} meta={<>{chan(door.dps, 'in')}{door.dps.supervisionState && door.dps.supervisionState !== 'normal' ? ` · ${door.dps.supervisionState.toUpperCase()}` : ''}</>}
                dot={supColor(door.dps.supervisionState) || (isOpen ? DC.blue : null)} active={isOpen} activeColor={DC.blue}
                btn={isOpen ? 'OPEN' : 'CLOSED'} onClick={() => simulateDoorDPS(door.id)} disabled={!connected || !door.enabled}
                title="Drive the door position input" />
              <IoRow label={door.rexIn.name} meta={<>{chan(door.rexIn, 'in')}{door.rexIn.supervisionState && door.rexIn.supervisionState !== 'normal' ? ` · ${door.rexIn.supervisionState.toUpperCase()}` : ''}</>}
                dot={supColor(door.rexIn.supervisionState) || (door.rexIn.active ? DC.amber : null)} active={door.rexIn.active} activeColor={DC.amber}
                btn={door.rexIn.active ? 'PRESSED' : 'PRESS'} onClick={() => simulateDoorREX(door.id)} disabled={!connected || !door.enabled}
                title="Drive the request-to-exit input" />
            </div>

            {/* Events */}
            <div className="px-3 py-2.5 border-t" style={{ borderColor: DC.line }}>
              <div className="text-[10px] font-bold tracking-wider mb-1.5" style={{ color: DC.dim }}>EVENTS</div>
              {events.length === 0 ? (
                <div className="text-[11px]" style={{ color: DC.dim }}>None set up. Add them in <button className="underline" style={{ color: DC.text2 }} onClick={() => { setEditingDoorId(door.id); setShowDoorSettings(true); }}>Settings</button>.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {events.map(e => {
                    const running = runningEvent[door.id] === e.num;
                    const last = lastEvent[door.id] === e.num;
                    return (
                      <button key={e.num} onClick={() => runDoorEvent(door.id, e.num)} disabled={!connected || !door.enabled || running}
                        title={`Run "${e.name}" (${e.steps.length} steps)`}
                        className="px-2.5 py-1 rounded-md text-[11px] font-semibold border flex items-center gap-1 max-w-full disabled:opacity-60"
                        style={{ background: running ? 'rgb(var(--hv-info) / 0.25)' : last ? 'rgb(var(--hv-info) / 0.1)' : 'rgb(var(--hv-widget-panel))', borderColor: running || last ? `color-mix(in srgb, ${DC.teal} 53%, transparent)` : DC.line, color: running || last ? 'rgb(var(--hv-success-text))' : DC.text2 }}>
                        <span style={{ fontSize: 8 }}>{running ? '■' : '▶'}</span><span className="truncate">{e.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Reader */}
            <div className="px-3 py-2.5 border-t mt-auto" style={{ borderColor: DC.line }}>
              {renderReader(door)}
            </div>
          </div>
        </div>

        {/* Footer: I/O source */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-t text-xs" style={{ borderColor: DC.line, background: 'rgb(var(--hv-surface) / 0.35)' }}>
          <span style={{ color: DC.dim }}>I/O</span>
          <div className="flex p-0.5 rounded-md" style={{ background: 'rgb(var(--hv-surface))' }}>
            {(['physical', 'emulated'] as const).map(src => {
              const on = (door.ioSource || 'physical') === src;
              return (
                <button key={src} onClick={() => setDoors(prev => prev.map(d => d.id === door.id ? { ...d, ioSource: src } : d))}
                  className="px-2.5 py-1 rounded font-semibold transition-colors"
                  style={on ? { background: 'rgb(var(--hv-success-tint-strong))', color: 'rgb(var(--hv-success-text))' } : { color: DC.dim }}>
                  {src === 'physical' ? 'Aether (Sequent)' : 'Azure (emulated)'}
                </button>
              );
            })}
          </div>
          {emu && (
            <>
              <select value={door.emuBoard ?? 0} className="rounded-md px-2 py-1 border" style={{ background: 'rgb(var(--hv-surface))', borderColor: DC.line, color: DC.text }}
                onChange={(e) => setDoors(prev => prev.map(d => d.id === door.id ? { ...d, emuBoard: parseInt(e.target.value) || 0 } : d))}>
                <option value={0}>{emuBoards.length ? 'Select board…' : 'No boards online'}</option>
                {emuBoards.map(b => (
                  <option key={b.address} value={b.address} title={`${b.numInputs} in / ${b.numOutputs} out${b.numReaders ? ` / ${b.numReaders} readers` : ''}`}>#{b.address} {b.model}{b.online ? '' : ' (offline)'}</option>
                ))}
              </select>
              {board && board.numReaders > 0 && (
                <select value={door.emuReaderPort ?? 0} className="rounded-md px-2 py-1 border" style={{ background: 'rgb(var(--hv-surface))', borderColor: DC.line, color: DC.text }}
                  onChange={(e) => setDoors(prev => prev.map(d => d.id === door.id ? { ...d, emuReaderPort: parseInt(e.target.value) || 0 } : d))}>
                  {Array.from({ length: board.numReaders }, (_, i) => <option key={i} value={i}>Reader {i}</option>)}
                </select>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  /** ---------- Render ---------- */
  return (
    <div className="space-y-6">
      {/* Global System I/O Panel */}
      <div className="backdrop-blur rounded-xl px-5 py-4 border" style={{ background: 'rgb(var(--hv-widget) / 0.45)', borderColor: 'rgb(var(--hv-error-tint-strong))' }}>
        <div className="flex items-center justify-between mb-3">
          <h2
            onClick={() => setSystemOutputsCollapsed(v => !v)}
            className="text-lg font-bold flex items-center gap-2 cursor-pointer select-none"
            title={systemOutputsCollapsed ? 'Expand' : 'Collapse'}
          >
            <span className="text-hv-text-3 text-base w-4 inline-block">{systemOutputsCollapsed ? '▶' : '▼'}</span>
            <div className="w-2.5 h-2.5 bg-hv-error rounded-full" />
            System Outputs
            <span className="text-xs font-normal" style={{ color: DC.dim }}>ACS global triggers</span>
          </h2>
          <button
            onClick={() => setShowSystemOutputConfig(!showSystemOutputConfig)}
            className="px-3 py-1.5 text-sm bg-hv-popup-panel hover:bg-hv-box rounded-lg font-semibold flex items-center gap-2 transition-all"
          >
            <Settings size={15} />
            {showSystemOutputConfig ? 'Hide Config' : 'Configure GPIO'}
          </button>
        </div>

        {!systemOutputsCollapsed && (<>
        {showSystemOutputConfig && (
          <div className="mb-6 p-4 bg-hv-surface/60 rounded-lg border border-hv-line">
            <h3 className="text-lg font-bold mb-3 text-hv-info-fg">Relay Channel Configuration</h3>
            <p className="text-xs text-hv-text-3 mb-4">
              Configure Sequent IOplus relay channels (0-7). Enter -1 for unconfigured.
            </p>
            <div className="grid grid-cols-4 gap-4">
              {[
                { io: globalPowerFault, setIO: setGlobalPowerFault, label: 'Power Fault Relay' },
                { io: globalBatteryFault, setIO: setGlobalBatteryFault, label: 'Battery Fault Relay' },
                { io: globalTamper, setIO: setGlobalTamper, label: 'System Tamper Relay' },
                { io: globalFAI, setIO: setGlobalFAI, label: 'Fire Alarm Relay' }
              ].map(({ io, setIO, label }) => (
                <div key={label}>
                  <label className="block text-sm font-semibold text-hv-text-2 mb-2">{label}</label>
                  <input
                    type="number"
                    value={io.channel === -1 ? '' : io.channel}
                    onChange={(e) => setIO(prev => ({ ...prev, channel: parseInt(e.target.value) || -1 }))}
                    placeholder="-1"
                    min={-1}
                    max={7}
                    className="w-full bg-hv-widget border border-hv-popup-panel rounded-lg px-3 py-2 text-hv-text"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { io: globalPowerFault, setIO: setGlobalPowerFault, color: DC.crit, activeLabel: 'FAULT' },
            { io: globalBatteryFault, setIO: setGlobalBatteryFault, color: DC.amber, activeLabel: 'FAULT' },
            { io: globalTamper, setIO: setGlobalTamper, color: DC.warn, activeLabel: 'TAMPER' },
            { io: globalFAI, setIO: setGlobalFAI, color: DC.crit, activeLabel: 'FIRE ALARM' }
          ].map(({ io, setIO, color, activeLabel }) => {
            const unconfigured = io.channel === -1;
            return (
              <div key={io.name} className="flex items-center gap-3 rounded-lg px-3 py-2.5 border"
                style={{ background: io.active ? `color-mix(in srgb, ${color} 12%, transparent)` : 'rgb(var(--hv-surface) / 0.55)', borderColor: io.active ? `color-mix(in srgb, ${color} 53%, transparent)` : DC.line }}>
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${io.active ? 'animate-pulse' : ''}`}
                  style={{ background: io.active ? color : 'rgb(var(--hv-line))', boxShadow: io.active ? `0 0 10px ${color}` : 'none' }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate" style={{ color: DC.text }}>{io.name}</div>
                  <div className="text-[11px]" style={{ color: unconfigured ? DC.warn : DC.dim }}>
                    {unconfigured ? 'No relay set' : `Relay ${io.channel}`}
                  </div>
                </div>
                <button
                  onClick={() => toggleGlobalIO(io, setIO)}
                  disabled={!connected || unconfigured}
                  title={unconfigured ? 'Set a relay channel in Configure GPIO first' : io.active ? 'Click to restore' : 'Click to trigger'}
                  className="px-2.5 py-1.5 rounded-md text-[11px] font-bold border shrink-0 disabled:opacity-35"
                  style={io.active ? { background: `color-mix(in srgb, ${color} 25%, transparent)`, borderColor: color, color: 'rgb(var(--hv-text))' } : { background: 'rgb(var(--hv-widget-panel))', borderColor: DC.line, color: DC.text2 }}>
                  {io.active ? activeLabel : 'NORMAL'}
                </button>
              </div>
            );
          })}
        </div>
        </>)}
      </div>

      {/* #5: fixed 8-slot transparent grid — configured doors render as
          cards, empty slots show a "+ Add Door" tile. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {Array.from({ length: MAX_DOORS }, (_, slot) => {
          const door = doors[slot];
          if (door) return renderDoorCard(door);
          return (
            <button
              key={`empty-${slot}`}
              onClick={() => { setNewDoorName(''); setNewDoorSource('physical'); setShowAddDialog(true); }}
              className="bg-hv-widget/30 hover:bg-hv-widget/50 backdrop-blur rounded-xl border-2 border-dashed border-hv-line/70 hover:border-hv-success-strong/50 transition-all min-h-[200px] flex flex-col items-center justify-center gap-3 text-hv-text-3 hover:text-hv-success-text group"
            >
              <div className="w-14 h-14 rounded-full border-2 border-current flex items-center justify-center group-hover:scale-110 transition-transform">
                <Plus size={28} />
              </div>
              <div className="text-sm font-semibold">Add Door</div>
              <div className="text-[11px] text-hv-text-3">Slot {slot + 1} of {MAX_DOORS}</div>
            </button>
          );
        })}
      </div>


      {/* Configuration Management */}
      <div className="bg-hv-widget/60 backdrop-blur rounded-xl p-6 border border-hv-line">
        <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <div className="w-3 h-3 bg-hv-text-3 rounded-full" />
          Configuration Management
        </h2>
        <p className="text-sm text-hv-text-2 mb-4">
          Save your complete door configuration including system outputs, door I/O mappings,
          reader assignments, and custom events. Save writes to this device so it survives a reboot.
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => saveDoorConfiguration()}
            className="flex-1 px-6 py-3 bg-hv-popup-panel hover:bg-hv-box border border-hv-line-strong rounded-lg font-semibold flex items-center justify-center gap-2"
          >
            <Save size={20} />
            Save Configuration
          </button>
          <button
            onClick={() => loadDoorConfigurationFromBackend()}
            className="flex-1 px-6 py-3 bg-hv-popup-panel hover:bg-hv-box border border-hv-line rounded-lg font-semibold flex items-center justify-center gap-2"
          >
            <Upload size={20} />
            Load Configuration
          </button>
          <button
            onClick={() => resetDoorConfiguration()}
            className="px-6 py-3 bg-hv-widget hover:bg-hv-popup-panel border border-hv-error-hover/60 text-hv-error-text rounded-lg font-semibold flex items-center justify-center gap-2"
          >
            <RefreshCw size={20} />
            Reset to Defaults
          </button>
        </div>
      </div>

      {/* #5: Add Door dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-hv-surface rounded-xl w-[420px] border border-hv-line overflow-hidden">
            <div className="bg-gradient-to-r from-hv-success-strong/25 to-hv-info-tint/40 p-5 border-b border-hv-line flex items-center justify-between">
              <h3 className="text-xl font-bold text-hv-text flex items-center gap-2"><Plus size={22} /> Add Door</h3>
              <button onClick={() => setShowAddDialog(false)} className="text-hv-text-3 hover:text-hv-text"><X size={22} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-hv-text-2 mb-2">Door Name</label>
                <input
                  type="text"
                  value={newDoorName}
                  onChange={(e) => setNewDoorName(e.target.value)}
                  placeholder={`Door ${doors.length + 1}`}
                  autoFocus
                  className="w-full bg-hv-widget border border-hv-line rounded-lg px-4 py-2.5 text-hv-text focus:outline-none focus:ring-2 focus:ring-hv-success"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-hv-text-2 mb-2">I/O Source</label>
                <div className="flex gap-1 bg-hv-surface/30 p-1 rounded-lg">
                  {(['physical', 'emulated'] as const).map(src => (
                    <button
                      key={src}
                      onClick={() => setNewDoorSource(src)}
                      className={`flex-1 px-3 py-2 rounded text-sm font-semibold transition-all ${
                        newDoorSource === src ? 'bg-hv-success-tint text-hv-success-fg ring-1 ring-inset ring-hv-success/40' : 'text-hv-text-3 hover:bg-hv-popup-panel'
                      }`}
                    >
                      {src === 'physical' ? 'Physical (Sequent GPIO)' : 'Emulated (Azure)'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-hv-text-3 mt-2">
                  You can change the source, board, channels and readers in Settings after creating.
                </p>
              </div>
            </div>
            <div className="bg-hv-widget-panel/60 p-5 border-t border-hv-line flex gap-3">
              <button onClick={() => setShowAddDialog(false)} className="flex-1 px-4 py-2.5 bg-hv-popup-panel hover:bg-hv-box rounded-lg font-semibold">Cancel</button>
              <button onClick={createDoor} className="flex-1 px-4 py-2.5 bg-hv-success-tint text-hv-success-fg ring-1 ring-inset ring-hv-success/40 hover:bg-hv-success-tint-strong rounded-lg font-semibold flex items-center justify-center gap-2">
                <Plus size={18} /> Create &amp; Configure
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Door Settings Modal */}
      {showDoorSettings && editingDoorId !== null && (
        <DoorSettings
          door={doors.find(d => d.id === editingDoorId)! as any}
          readers={readerPool as any}
          emuBoard={(() => {
            const dd = doors.find(d => d.id === editingDoorId);
            if (!dd || dd.ioSource !== 'emulated' || !dd.emuBoard) return null;
            const b = emuBoards.find(x => x.address === dd.emuBoard);
            return b ? { address: b.address, model: b.model, numInputs: b.numInputs, numOutputs: b.numOutputs, numReaders: b.numReaders } : null;
          })()}
          onClose={() => {
            setShowDoorSettings(false);
            setEditingDoorId(null);
          }}
          onSave={(updatedDoor: any) => {
            // #persist: build the next doors array explicitly so we can save it
            // to the backend immediately (setDoors is async — reading `doors`
            // right after wouldn't include this change yet).
            const nextDoors = doors.map(d => d.id === updatedDoor.id ? updatedDoor : d);
            setDoors(nextDoors);
            setShowDoorSettings(false);
            setEditingDoorId(null);
            onAuditLog(`Updated settings for ${updatedDoor.name}`);
            // Auto-persist to device on Save Settings (silent, durable).
            saveDoorConfiguration(nextDoors);
          }}
          onTestRun={async (doorId: number, steps: any, hooks: any) => {
            // #feat: inline Test Run — execute the editor's CURRENT steps
            // (possibly unsaved) via the shared runner, reporting progress
            // back to the editor for the highlight + summary.
            if (!connected) {
              onLog('error', 'Test Run: not connected');
              return { ran: 0, failed: 0, total: steps.length };
            }
            onLog('info', `🧪 Test Run: ${steps.length} step(s) on door ${doorId}`);
            const result = await runEventSteps(doorId, steps, {
              onStepStart: (idx: number) => hooks.onStepStart(idx),
              onStepEnd: (idx: number, _s: any, ok: boolean) => hooks.onStepEnd(idx, ok),
            });
            onLog('success', `🧪 Test Run complete: ${result.ran}/${result.total} ran, ${result.failed} failed`);
            return result;
          }}
          onApplyEventToAllDoors={(eventIndex: number, event: any) => {
            // #1: copy `event` into slot `eventIndex` on EVERY door, leaving
            // each door's OTHER event slots untouched. Then persist so the
            // mass-assignment survives a reboot.
            const nextDoors = doors.map(d => {
              const events = Array.isArray(d.customEvents) ? [...d.customEvents] : [];
              // Ensure the array is long enough to hold this slot.
              while (events.length <= eventIndex) {
                events.push({ name: `Custom Event ${events.length + 1}`, enabled: false, steps: [] } as any);
              }
              events[eventIndex] = JSON.parse(JSON.stringify(event));
              return { ...d, customEvents: events };
            });
            setDoors(nextDoors);
            onAuditLog(`Applied event slot ${eventIndex + 1} ("${event?.name}") to all ${nextDoors.length} doors`);
            onLog('success', `Event applied to all ${nextDoors.length} doors (slot ${eventIndex + 1})`);
            // Persist the mass-assignment to the device.
            saveDoorConfiguration(nextDoors);
          }}
        />
      )}
    </div>
  );
};

export default DoorSection;
