import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, Edit3, Radio, Save, Upload, RefreshCw, Plus, X, Trash2, AlertTriangle } from 'lucide-react';
import { Socket } from 'socket.io-client';
import { DoorScene } from './DoorAnimation';
import DoorSettings from './DoorSettings';
import { useCardFormats, isValidFacilityCode, isValidCardNumber } from '../hooks/useCardFormats';
// AETHER_DOOR_OUTPUTS (Update 69): shared door-output helpers
import {
  DoorOutputKind, DoorOutputConflict, DOOR_OUTPUT_CHANNELS, DOOR_OUTPUT_ROLES,
  doorOutputKind, doorOutputLabel, doorActiveVolts, doorOutputKey, doorOutputsSignature,
  isDoorOutputAssigned, isPhysicalEnabledDoor, normalizeDoorOutputs, migrateSavedDoor, lockDriveIO,
  findDoorOutputConflicts, describeDoorOutputConflict, pickFreeRelayChannels,
  driveDoorOutput, readDoorOutput,
  // AETHER_LOCK_WATCH (Update 71): a physical door's Lock may be watched on an opto input
  LOCK_WATCH_TYPE, isLockWatch, lockWatchLabel, lockWatchActive,
  // AETHER_ANALOG_IN (Update 72): ... or on an EOL zone (ADC n); custom input ios
  LOCK_WATCH_ANALOG_TYPE, lockWatchFromEvent, readLockWatch, isCustomInputIO, customIOLabel,
} from '../lib/doorOutputs';
// AETHER_READER_DIR (Update 71): every enrolled Wiegand / OSDP reader on the Pi
import { DirReader, loadEnrolledReaders, dirReaderLabel, resolveLegacyReaderId, sendCardToDirReader } from '../lib/readerDirectory';
import { requestRunWorkflow, onWorkflowSaved, nodeScope } from '../lib/workflowBridge';   // AETHER_DOOR_WORKFLOWS

/** ---------- Types ---------- */

// I/O Hardware Types
type IOHardwareType = 'relay' | 'opto' | 'analog' | 'gpio' | 'dac' | 'od' | 'opto-in' | 'analog-in';   // 'opto-in': AETHER_LOCK_WATCH, 'analog-in': AETHER_ANALOG_IN (Lock only)

// AETHER_DOOR_OUTPUTS (Update 69): a door's Lock, DPS and REX are all things
// Aether DRIVES into the controller's inputs (kinds: relay / dac / od, see
// ../lib/doorOutputs). channel -1 = not assigned.

// Base I/O Configuration
interface IOConfig {
  name: string;
  hardwareType: IOHardwareType;
  channel: number;        // 0-7 for Sequent, or GPIO pin number
  stackLevel?: number;    // 0-7 for multi-board Sequent setups
  active: boolean;
  reverseSense?: boolean;
  activeVolts?: number;   // 'dac' only: volts driven when active (0-10, default 10)
}

// Door Lock - Aether OUTPUT (drives the controller's lock-sense / strike input),
// or AETHER_LOCK_WATCH: 'opto-in' = an Aether INPUT (OPTO n) watching the
// controller's lock relay (physical doors only; never driven).
interface DoorLockIO extends IOConfig {
  hardwareType: DoorOutputKind | typeof LOCK_WATCH_TYPE | typeof LOCK_WATCH_ANALOG_TYPE;
  // AETHER_ANALOG_IN: 'analog-in' = watching EOL zone ADC n
  analogMode?: 'eol' | 'volts';     // default 'eol'
  thresholdVolts?: number;          // 'volts' mode, 0.5-10 (default 5)
  supervisionState?: 'normal' | 'active' | 'trouble' | 'short';   // eol mode: last zone state
}

// Door Position Switch - Aether OUTPUT driving the controller's DPS input.
// Legacy saved 'opto' / 'analog' are normalized to 'relay' on load (they
// always drove the relay with that channel).
interface DoorDPSIO extends IOConfig {
  hardwareType: DoorOutputKind | 'opto' | 'analog';
  supervisionState?: 'normal' | 'active' | 'trouble' | 'short';
}

// Request to Exit - Aether OUTPUT driving the controller's REX input.
interface DoorREXIO extends IOConfig {
  hardwareType: DoorOutputKind | 'opto' | 'analog';
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
  steps: CustomEventStep[];   // legacy step list — runs only when no workflow is linked
  // AETHER_DOOR_WORKFLOWS: Emulation workflow (/api/emulations id) this event runs
  workflowId?: string;
  workflowName?: string;
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
  nodeId?: string;   // AETHER_DOOR_IO_WORKFLOWS: cluster node id (bridge scope)
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

// Default doors. Lock/DPS/REX are all Aether OUTPUTS (Update 69). No relay is
// used twice: Doors 1-2 take REL 1-6, Door 3 REL 7-8; the rest are left
// unassigned (-1) — assign a free output in Settings. Doors 3-4 start disabled.
const createDefaultDoors = (): Door[] => [
  {
    id: 1,
    name: 'Main Entrance',
    enabled: true,
    ioSource: 'physical',
    lock: {
      name: 'Door Strike',
      hardwareType: 'relay',
      channel: 0,  // REL 1
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'relay',  // Aether output -> controller DPS input
      channel: 1,  // REL 2
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'relay',  // Aether output -> controller REX input
      channel: 2,  // REL 3
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
      channel: 3,  // REL 4
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'relay',  // Aether output -> controller DPS input
      channel: 4,  // REL 5
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'relay',  // Aether output -> controller REX input
      channel: 5,  // REL 6
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
      channel: 6,  // REL 7
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'relay',  // Aether output -> controller DPS input
      channel: 7,  // REL 8
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'relay',  // Aether output -> controller REX input
      channel: -1,  // not assigned (no free relay)
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
      channel: -1,  // not assigned (no free relay)
      active: false
    },
    dps: {
      name: 'Door Position',
      hardwareType: 'relay',  // Aether output -> controller DPS input
      channel: -1,  // not assigned (no free relay)
      active: false,
      supervisionState: 'normal'
    },
    rexIn: {
      name: 'REX Button',
      hardwareType: 'relay',  // Aether output -> controller REX input
      channel: -1,  // not assigned (no free relay)
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

// #5: a new door with the Add-door defaults (shared by createDoor and the
// AETHER_DOOR_LAYOUT button). `ch` = [lock, dps, rex] channels.
const newDoorWithDefaults = (id: number, name: string, source: 'physical' | 'emulated', ch: [number, number, number]): Door => ({
  id,
  name,
  enabled: true,
  ioSource: source,
  emuBoard: 0,
  emuReaderPort: 0,
  lock:  { name: 'Door Strike',  hardwareType: 'relay', channel: ch[0], active: false },
  dps:   { name: 'Door Position', hardwareType: 'relay', channel: ch[1], active: false, supervisionState: 'normal' },
  rexIn: { name: 'REX Button',   hardwareType: 'relay', channel: ch[2], active: false, supervisionState: 'normal' },
  ios: [],
  reader: null,
  customEvents: Array.from({ length: 6 }, (_, i) => ({ name: `Custom Event ${i + 1}`, enabled: false, steps: [] })),
});

// AETHER_LOCK_WATCH (Update 71): Lock watched on OPTO n (physical doors only).
const isWatchedLock = (d: Door) => (d.ioSource || 'physical') === 'physical' && isLockWatch(d.lock);

/* AETHER_DOOR_LAYOUT (Update 71): the 4-door bench layout. Door n (id 1-4):
 * enabled, physical, DPS = REL 2n-1 (channel 2n-2), REX = REL 2n (channel 2n-1),
 * Lock = watched OPTO n (channel n-1, 'opto-in'), reverseSense off on all three.
 * Names, readers, events and custom I/O are kept; missing doors 1-4 are created
 * (while there is a free slot); doors 5+ are untouched. Pure: returns new doors. */
const applyFourDoorLayout = (doors: Door[], maxDoors = 8): { doors: Door[]; created: number[]; skipped: number[] } => {
  const created: number[] = [], skipped: number[] = [];
  let next = doors.slice();
  for (let n = 1; n <= 4; n++) {
    if (next.some(d => d.id === n)) continue;
    if (next.length >= maxDoors) { skipped.push(n); continue; }
    next.push(newDoorWithDefaults(n, `Door ${n}`, 'physical', [-1, -1, -1]));
    created.push(n);
  }
  next = next.map(d => {
    if (d.id < 1 || d.id > 4) return d;
    const n = d.id;
    return {
      ...d,
      enabled: true,
      ioSource: 'physical',
      lock:  { ...d.lock,  hardwareType: LOCK_WATCH_TYPE, channel: n - 1, stackLevel: 0, reverseSense: false, active: false },
      dps:   { ...d.dps,   hardwareType: 'relay', channel: 2 * n - 2, stackLevel: 0, reverseSense: false },
      rexIn: { ...d.rexIn, hardwareType: 'relay', channel: 2 * n - 1, stackLevel: 0, reverseSense: false },
    };
  });
  // keep the 8-slot grid in id order when doors were added
  if (created.length) next.sort((a, b) => a.id - b.id);
  return { doors: next, created, skipped };
};

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

const REX_PULSE_MS = 1000;   // AETHER_DOOR_BUTTONS: how long a REX click holds the input

const DC = {
  text: 'rgb(var(--hv-text))', text2: 'rgb(var(--hv-text-2))', dim: 'rgb(var(--hv-text-3))', line: 'rgb(var(--hv-popup-panel))',
  good: 'rgb(var(--hv-success))', teal: 'rgb(var(--hv-info))', blue: 'rgb(var(--hv-info-text))', amber: 'rgb(var(--hv-brand))', warn: 'rgb(var(--hv-warning))', crit: 'rgb(var(--hv-error))',
};

// AETHER_DOOR_BUTTONS (Update 74): IoRow lives at module level. It used to be defined inside
// DoorSection, so every re-render (the emulator sends board updates ~10x a second) made it a
// NEW component type and React rebuilt every button. A click whose mouse-down and mouse-up
// landed on two different builds of the button never fired: PRESS / OPEN worked only sometimes.
const IoRow = ({ label, meta, dot, badge, btn, active, onClick, disabled, title, activeColor = DC.good }: {
  label: string; meta: React.ReactNode; dot: string | null; badge?: React.ReactNode;
  btn: string; active: boolean; onClick: (e: React.MouseEvent) => void; disabled?: boolean; title?: string; activeColor?: string;
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

const IconBtn: React.FC<{ title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({ title, onClick, disabled, danger, children }) => (
  <button title={title} aria-label={title} onClick={onClick} disabled={disabled}
    className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors disabled:opacity-30 ${danger ? 'hover:bg-hv-error-hover/60 hover:text-hv-text' : 'hover:bg-hv-contrast/5 hover:text-hv-text'}`}
    style={{ color: 'rgb(var(--hv-text-3))' }}>
    {children}
  </button>
);

/* ---------- AETHER_DOOR_ACTIVITY: per-door activity log ----------
 * The Pi keeps the last 200 entries per door (backend/lib/doorActivity.js) from the relay
 * writes, opto / zone monitors and the Controller Emulator, plus what this page POSTs (cards
 * presented, events / workflows started). The page keeps the newest ACT_KEEP per door in a
 * small store OUTSIDE React state: each door's log subscribes to its own door, so a new line
 * re-renders that one log, never the door grid. Socket entries are batched (ACT_FLUSH_MS). */
type DoorActivityEntry = {
  id: string; t: number; doorId: number;
  kind: 'lock' | 'dps' | 'rex' | 'input' | 'card' | 'event' | 'note';
  text: string; source: string; level: 'info' | 'ok' | 'warn';
};
const ACT_KEEP = 50;
const ACT_SHOW = 4;
const ACT_FLUSH_MS = 250;
const ACT_EMPTY: DoorActivityEntry[] = [];
const ACT_KIND_COLOR: Record<string, string> = {
  lock: DC.good, dps: DC.blue, rex: DC.amber, input: DC.teal, card: DC.text, event: DC.text2, note: DC.dim,
};

type ActivityStore = {
  get: (doorId: number) => DoorActivityEntry[];
  merge: (entries: DoorActivityEntry[]) => void;
  clear: (doorId: number) => void;
  subscribe: (fn: () => void) => () => void;
};
/** Newest-first entries per door, deduped by id, ACT_KEEP per door. A door's array changes identity only when it changes. */
function createActivityStore(): ActivityStore {
  let data: Record<number, DoorActivityEntry[]> = {};
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(fn => { try { fn(); } catch { /* one bad listener never stops the others */ } });
  return {
    get: (doorId) => data[doorId] || ACT_EMPTY,
    merge(entries) {
      const byDoor: Record<number, DoorActivityEntry[]> = {};
      for (const e of entries) {
        if (!e || typeof e.id !== 'string' || !Number.isInteger(Number(e.doorId))) continue;
        (byDoor[Number(e.doorId)] = byDoor[Number(e.doorId)] || []).push(e);
      }
      let changed = false;
      const next = { ...data };
      for (const [k, add] of Object.entries(byDoor)) {
        const id = Number(k);
        const cur = next[id] || ACT_EMPTY;
        const seen = new Set(cur.map(e => e.id));
        const fresh = add.filter(e => !seen.has(e.id) && (seen.add(e.id), true));
        if (!fresh.length) continue;
        next[id] = [...fresh, ...cur].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, ACT_KEEP);
        changed = true;
      }
      if (changed) { data = next; notify(); }
    },
    clear(doorId) {
      if (!data[doorId]) return;
      const next = { ...data };
      delete next[doorId];
      data = next;
      notify();
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

const fmtActTime = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
};

const DoorActivityRow: React.FC<{ e: DoorActivityEntry }> = ({ e }) => {
  const color = e.level === 'warn' ? DC.warn : (ACT_KIND_COLOR[e.kind] || DC.dim);
  return (
    <div className="flex items-center gap-2 text-[11px] leading-5 min-w-0" title={`${new Date(e.t).toLocaleString()} · ${e.source} · ${e.text}`}>
      <span className="font-mono shrink-0 tabular-nums" style={{ color: DC.dim }}>{fmtActTime(e.t)}</span>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
      <span className="truncate flex-1 min-w-0" style={{ color: e.level === 'warn' ? DC.warn : e.level === 'ok' ? DC.text : DC.text2 }}>{e.text}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider" style={{ color: DC.dim }}>{e.source}</span>
    </div>
  );
};

/** One door's log. Reads its own door from the store, so only this log re-renders on a new line. */
const DoorActivityLog = React.memo(({ doorId, store, onClear, disabled }: {
  doorId: number; store: ActivityStore; onClear: (doorId: number) => void; disabled?: boolean;
}) => {
  const entries = React.useSyncExternalStore(store.subscribe, () => store.get(doorId), () => store.get(doorId));
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, ACT_SHOW);
  return (
    <div className="px-4 py-2 border-t" style={{ borderColor: DC.line }}>
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-bold tracking-wider flex-1" style={{ color: DC.dim }}>ACTIVITY</div>
        {entries.length > ACT_SHOW && (
          <button onClick={() => setExpanded(x => !x)} className="text-[11px] underline" style={{ color: DC.text2 }}
            title={expanded ? 'Show the newest lines only' : `Show the last ${entries.length} lines`}>
            {expanded ? 'less' : `all ${entries.length}`}
          </button>
        )}
        <button onClick={() => onClear(doorId)} disabled={disabled || entries.length === 0} title="Clear this door's activity" aria-label="Clear this door's activity"
          className="w-6 h-6 rounded-md flex items-center justify-center transition-colors disabled:opacity-30 hover:bg-hv-contrast/5 hover:text-hv-text" style={{ color: DC.dim }}>
          <Trash2 size={12} />
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px]" style={{ color: DC.dim }}>No activity yet</div>
      ) : (
        <div className={expanded ? 'overflow-y-auto pr-1' : ''} style={expanded ? { maxHeight: 180 } : undefined}>
          {shown.map(e => <DoorActivityRow key={e.id} e={e} />)}
        </div>
      )}
    </div>
  );
});

const DoorSection: React.FC<DoorSectionProps> = ({
  ipAddress,
  nodeId,
  connected,
  socket,
  readerPool,
  credentialLibrary,
  onUpdateReaderPool,
  onLog,
  onAuditLog
}) => {
  // Door state
  const [doors, setDoors] = useState<Door[]>(() => createDefaultDoors().map(d => normalizeDoorOutputs(d)));
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
  const apiBase = `http://${ipAddress}:3001`;
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

  /** ---------- AETHER_READER_DIR (Update 71): enrolled readers ---------- */
  // Every Wiegand / OSDP reader enrolled on the Pi (same list as the Elevator
  // page). Loaded on connect and whenever door Settings opens; no polling.
  const [dirReaders, setDirReaders] = useState<DirReader[]>([]);
  const loadDirReaders = useCallback(async (quiet = false) => {
    try {
      const { readers, errors } = await loadEnrolledReaders(apiBase);
      // keep the last good list when both sources failed
      if (readers.length || !errors.length) setDirReaders(readers);
      if (errors.length && !quiet) onLog('warn', `Enrolled readers: ${errors.join('; ')}`);
    } catch (e: any) {
      if (!quiet) onLog('warn', `Enrolled readers not loaded: ${e.message}`);
    }
  }, [apiBase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (connected) loadDirReaders(); }, [connected, loadDirReaders]);
  useEffect(() => { if (connected && showDoorSettings) loadDirReaders(true); }, [connected, showDoorSettings, loadDirReaders]);

  // Saved id -> current id: legacy pool ids ('reader1'…) map to the enrolled
  // Wiegand reader on the same D0/D1 pins; an old pool OSDP id maps to the
  // enrolled OSDP reader with that id. Anything else is returned unchanged.
  const resolveReaderId = (id: string | null | undefined): string | null => {
    const r = resolveLegacyReaderId(id, readerPool, dirReaders);
    if (!r || r !== id || r.startsWith('wg-') || r.startsWith('osdp-') || r.startsWith('ctrl-emu-')) return r;
    const old = readerPool.find(p => p.id === r);
    const hit = old && old.type === 'osdp' ? dirReaders.find(d => d.type === 'osdp' && d.osdpId === r) : undefined;
    return hit ? hit.id : r;
  };
  const dirReaderById = (id: string | null | undefined) => (id ? dirReaders.find(r => r.id === id) : undefined);

  // Migrate door.reader once enrolled readers are known (also after a config
  // load). Local state only: the server copy changes when the user saves.
  useEffect(() => {
    if (!dirReaders.length) return;
    if (!doors.some(d => d.reader && resolveReaderId(d.reader) !== d.reader)) return;
    setDoors(prev => prev.map(d => {
      const r = resolveReaderId(d.reader);
      return r !== d.reader ? { ...d, reader: r } : d;
    }));
  }, [dirReaders, doors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reader list for DoorSettings: enrolled readers + legacy pool readers no
  // enrolled reader replaces (so nothing saved disappears).
  const settingsReaders = [
    ...dirReaders.map(r => ({ id: r.id, name: r.name, type: r.type, enabled: r.enabled, d0: r.d0, d1: r.d1, address: r.address, label: dirReaderLabel(r) })),
    ...readerPool
      .filter(p => !dirReaders.some(d => d.id === p.id) && resolveReaderId(p.id) === p.id)
      .map(p => ({ ...p, legacy: true })),
  ];

  /** ---------- WebSocket Input Monitoring ---------- */
  useEffect(() => {
    if (!socket || !connected) return;

    // Listen for input state changes from backend
    const handleInputStateChange = (data: {
      type: 'opto' | 'analog';
      pin: number;
      state: number;
      voltage?: number;
      volts?: number | string;   // AETHER_ANALOG_IN: analog events carry volts too
      supervisionState?: string;
      timestamp: number;
    }) => {
      // AETHER_DOOR_OUTPUTS (Update 69): DPS and REX are Aether OUTPUTS, so they
      // no longer follow opto events (that made them mirror OPTO n). Only
      // custom door I/Os configured as opto/analog inputs follow these events.
      setDoors(prevDoors => prevDoors.map(door => {
        // AETHER_LOCK_WATCH: a watched Lock follows its OPTO input (change events
        // + the snapshot sent on connect). reverseSense = unlocked when OFF.
        // AETHER_ANALOG_IN: ... or its EOL zone (ADC n; eol / volts mode).
        const w = isWatchedLock(door) ? lockWatchFromEvent(door.lock, data) : null;
        if (w && (door.lock.active !== w.active || door.lock.supervisionState !== w.supervisionState)) {
          door = { ...door, lock: { ...door.lock, active: w.active, supervisionState: w.supervisionState } };
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

        return { ...door, ios: updatedIos };
      }));
    };

    socket.on('input_state_change', handleInputStateChange);

    return () => {
      socket.off('input_state_change', handleInputStateChange);
    };
  }, [socket, connected]);

  // AETHER_LOCK_WATCH: the opto snapshot is only sent when the socket connects,
  // so read each watched lock once when the watched set changes (config load,
  // Settings save, 4-door layout) or on connect. Change events do the rest.
  // AETHER_ANALOG_IN: the signature also carries the watch type / mode / threshold.
  const watchSig = doors.filter(d => isWatchedLock(d) && isDoorOutputAssigned(d.lock))
    .map(d => `${d.id}:${d.lock.channel}:${d.lock.reverseSense ? 1 : 0}:${d.lock.hardwareType}:${d.lock.analogMode || 'eol'}:${d.lock.thresholdVolts ?? ''}`).join(',');
  useEffect(() => {
    if (!connected || !watchSig) return;
    let cancelled = false;
    for (const part of watchSig.split(',')) {
      const [idS, chS, rev, hw, mode, thr] = part.split(':');
      const id = Number(idS), ch = Number(chS);
      const sameWatch = (d: Door) => d.id === id && isWatchedLock(d) && Number(d.lock.channel) === ch && d.lock.hardwareType === hw;
      readLockWatch(apiBase, { hardwareType: hw, channel: ch, reverseSense: rev === '1', analogMode: mode, thresholdVolts: thr === '' ? undefined : Number(thr) })
        .then(w => {
          if (cancelled) return;
          setDoors(prev => prev.map(d => sameWatch(d) && (d.lock.active !== w.active || d.lock.supervisionState !== w.supervisionState)
            ? { ...d, lock: { ...d.lock, active: w.active, supervisionState: w.supervisionState } } : d));
        })
        .catch(() => { /* next input event updates it */ });
    }
    return () => { cancelled = true; };
  }, [connected, watchSig, apiBase]);

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

    // AETHER_DOOR_BUTTONS (Update 74): the emulator sends a board update after every poll
    // reply (~10/s). Each one used to refetch /api/emulator/status and re-render every door.
    // Now: board-list refetches are coalesced (at most one per 2 s) and only stored when the
    // list actually changed; emulated doors' DPS / REX follow the update payload directly.
    let lastBoardsSig = '';
    const refreshBoards = async () => {
      const boards = await fetchEmuStatus(ipAddress);
      if (cancelled) return;
      const sig = JSON.stringify(boards);
      if (sig !== lastBoardsSig) { lastBoardsSig = sig; setEmuBoards(boards); }
    };
    let refreshTimer: any = null, lastRefreshAt = 0;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      const wait = Math.max(0, 2000 - (Date.now() - lastRefreshAt));
      refreshTimer = setTimeout(() => { refreshTimer = null; lastRefreshAt = Date.now(); refreshBoards(); }, wait);
    };
    lastRefreshAt = Date.now();
    refreshBoards();

    if (socket && connected) {
      const onAny = () => { lastRefreshAt = 0; scheduleRefresh(); };   // board added/removed/started: refresh promptly
      const onDeviceUpdate = (snap: any) => {
        if (!snap || !Array.isArray(snap.inputs)) { scheduleRefresh(); return; }
        const addr = Number(snap.address) & 0x7F;
        setDoors(prev => {
          let changed = false;
          const next = prev.map(d => {
            if (d.ioSource !== 'emulated' || !d.emuBoard || (Number(d.emuBoard) & 0x7F) !== addr) return d;
            const follow = (io: any) => {
              const raw = snap.inputs[Number(io.channel)];
              if (raw === undefined || raw === null) return io;
              const active = io.reverseSense ? !raw : !!raw;
              return io.active === active ? io : { ...io, active, supervisionState: active ? 'active' : 'normal' };
            };
            const dps = follow(d.dps), rexIn = follow(d.rexIn);
            if (dps === d.dps && rexIn === d.rexIn) return d;
            changed = true;
            return { ...d, dps, rexIn };
          });
          return changed ? next : prev;            // unchanged: no re-render
        });
        scheduleRefresh();
      };

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
      socket.on('emulator-device-update', onDeviceUpdate);
      socket.on('output-changed', onOutputChanged);

      return () => {
        cancelled = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        Object.values(relockTimers).forEach(t => clearTimeout(t));
        socket.off('emulator-started', onAny);
        socket.off('emulator-stopped', onAny);
        socket.off('emulator-config-applied', onAny);
        socket.off('emulator-device-added', onAny);
        socket.off('emulator-device-removed', onAny);
        socket.off('emulator-device-update', onDeviceUpdate);
        socket.off('output-changed', onOutputChanged);
      };
    }
    return () => { cancelled = true; if (refreshTimer) clearTimeout(refreshTimer); };
  }, [socket, connected, ipAddress]);

  const [configLoads, setConfigLoads] = useState(0);
  // AETHER_DOOR_BUTTONS (Update 74): physical doors' DPS / REX follow the real relays.
  // The page used to keep its own idea of each relay, so after another page, another
  // browser or an Emulation run moved a relay, a click sent the state the relay already
  // had and nothing happened. The Pi now announces every relay write ('relay_state_change');
  // the current relays are read once on connect.
  useEffect(() => {
    if (!socket || !connected) return;
    const apply = (ch: number, on: boolean) => setDoors(prev => {
      let changed = false;
      const next = prev.map(d => {
        if (d.ioSource === 'emulated') return d;
        const follow = (io: any) => {
          if (!io || doorOutputKind(io) !== 'relay' || Number(io.stackLevel || 0) !== 0 || Number(io.channel) !== ch) return io;
          const active = io.reverseSense ? !on : on;
          return io.active === active ? io : { ...io, active, supervisionState: active ? 'active' : 'normal' };
        };
        const dps = follow(d.dps), rexIn = follow(d.rexIn);
        if (dps === d.dps && rexIn === d.rexIn) return d;
        changed = true;
        return { ...d, dps, rexIn };
      });
      return changed ? next : prev;
    });
    const onRelay = (m: any) => { if (m && Number.isInteger(Number(m.channel))) apply(Number(m.channel), !!Number(m.state)); };
    socket.on('relay_state_change', onRelay);
    fetchJson(`${apiBase}/api/gpio/status`).then((st: any) => {
      for (const r of (st && Array.isArray(st.relays) ? st.relays : [])) if (!r.error && (r.state === 0 || r.state === 1)) apply(Number(r.channel), r.state === 1);
    }).catch(() => { /* keep the page's state */ });
    return () => { socket.off('relay_state_change', onRelay); };
  }, [socket, connected, apiBase, configLoads]);

  /** ---------- AETHER_DOOR_ACTIVITY: per-door activity log ---------- */
  const activityStoreRef = useRef<ActivityStore | null>(null);
  if (!activityStoreRef.current) activityStoreRef.current = createActivityStore();
  const activityStore = activityStoreRef.current;
  // Live lines from the Pi, batched: at most one store update per ACT_FLUSH_MS.
  const actPendingRef = useRef<DoorActivityEntry[]>([]);
  const actTimerRef = useRef<any>(null);
  const queueActivity = useCallback((entries: DoorActivityEntry[]) => {
    if (!entries.length) return;
    actPendingRef.current.push(...entries);
    if (actTimerRef.current) return;
    actTimerRef.current = setTimeout(() => {
      actTimerRef.current = null;
      const batch = actPendingRef.current;
      actPendingRef.current = [];
      activityStore.merge(batch);
    }, ACT_FLUSH_MS);
  }, [activityStore]);
  useEffect(() => () => { if (actTimerRef.current) clearTimeout(actTimerRef.current); }, []);
  // Bumped whenever a door's log is cleared (here or on another page): a GET that started
  // before the clear is ignored, so it can't bring the old lines back.
  const actClearGenRef = useRef<Record<number, number>>({});
  const dropDoorActivity = useCallback((doorId: number) => {
    actClearGenRef.current[doorId] = (actClearGenRef.current[doorId] || 0) + 1;
    actPendingRef.current = actPendingRef.current.filter(e => Number(e.doorId) !== doorId);
    activityStore.clear(doorId);
  }, [activityStore]);
  useEffect(() => {
    if (!socket || !connected) return;
    const onActivity = (e: any) => { if (e && typeof e.id === 'string') queueActivity([e]); };
    const onCleared = (m: any) => { const id = Number(m && m.doorId); if (Number.isInteger(id)) dropDoorActivity(id); };
    socket.on('door_activity', onActivity);
    socket.on('door_activity_cleared', onCleared);
    return () => { socket.off('door_activity', onActivity); socket.off('door_activity_cleared', onCleared); };
  }, [socket, connected, queueActivity, dropDoorActivity]);
  // The last ACT_KEEP per door: on connect, config load, and when the set of doors changes.
  const actDoorIds = doors.map(d => d.id).join(',');
  useEffect(() => {
    if (!connected || !actDoorIds) return;
    let cancelled = false;
    for (const id of actDoorIds.split(',')) {
      const gen = actClearGenRef.current[Number(id)] || 0;
      fetchJson(`${apiBase}/api/doors/activity?door=${id}&limit=${ACT_KEEP}`)
        .then((r: any) => {
          if (cancelled || (actClearGenRef.current[Number(id)] || 0) !== gen) return;   // cleared while loading
          if (r && Array.isArray(r.entries)) activityStore.merge(r.entries);
        })
        .catch(() => { /* no log on this Pi yet: live lines still arrive */ });
    }
    return () => { cancelled = true; };
  }, [connected, apiBase, actDoorIds, configLoads, activityStore]);
  /** Fire-and-forget: things only this page knows (cards presented, events started). Never blocks the action. */
  const postDoorActivity = (doorId: number | undefined | null, kind: DoorActivityEntry['kind'], text: string, level: DoorActivityEntry['level'] = 'info', source = 'user') => {
    if (doorId === undefined || doorId === null || !Number.isInteger(Number(doorId)) || !connected) return;
    fetch(`${apiBase}/api/doors/${doorId}/activity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text: text.slice(0, 200), source, level }),
    }).then(r => (r.ok ? r.json() : null)).then((j: any) => { if (j && j.entry) queueActivity([j.entry]); }).catch(() => { /* the log is best effort */ });
  };
  const clearDoorActivity = useCallback((doorId: number) => {
    dropDoorActivity(doorId);
    fetch(`${apiBase}/api/doors/${doorId}/activity`, { method: 'DELETE' }).catch(() => { /* cleared locally */ });
  }, [apiBase, dropDoorActivity]);

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
    // AETHER_LOCK_WATCH: the controller drives a watched lock; nothing to drive.
    if (isWatchedLock(door)) {
      onLog('info', `${door.name}: Lock is driven by the controller; watching ${lockWatchLabel(door.lock)}`);
      return;
    }

    // #2-fix: explicit direction (event steps) drives unconditionally,
    // avoiding the stale-`doors`-closure skip bug in the async event loop.
    // Manual button passes nothing → toggle (uses live render state, fine).
    const newState = desired !== undefined ? desired : !door.lock.active;
    const emu = boardForDoor(door);
    if (!emu && !isDoorOutputAssigned(door.lock)) { onLog('error', `${door.name} Lock has no output assigned`); return; }
    let driven = '';
    try {
      if (emu) {
        if (door.lock.channel >= emu.numOutputs) {
          throw new Error(`Lock OUTPUT ${door.lock.channel} out of range — board #${emu.address} (${emu.model}) has ${emu.numOutputs} outputs (0-${emu.numOutputs - 1})`);
        }
        await setEmuOutput(ipAddress, emu.address, door.lock.channel, newState);
      } else {
        driven = await driveDoorOutput(apiBase, lockDriveIO(door.lock), newState, `${door.name} Lock`);
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? { ...d, lock: { ...d.lock, active: newState } } : d
      ));

      const where = emu ? `OUTPUT ${door.lock.channel} (#${emu.address})` : driven;
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
    if (!emu && !isDoorOutputAssigned(door.dps)) { onLog('error', `${door.name} DPS has no output assigned`); return; }
    // reverseSense (physical): handled inside driveDoorOutput.
    let driven = '';

    try {
      if (emu) {
        if (door.dps.channel >= emu.numInputs) {
          throw new Error(`DPS INPUT ${door.dps.channel} out of range — board #${emu.address} (${emu.model}) has ${emu.numInputs} inputs (0-${emu.numInputs - 1})`);
        }
        // reverseSense still applies: asserted-open may mean input LOW.
        const emuActive = door.dps.reverseSense ? !newState : newState;
        await setEmuInput(ipAddress, emu.address, door.dps.channel, emuActive);
      } else {
        driven = await driveDoorOutput(apiBase, door.dps, newState, `${door.name} DPS`);
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? {
          ...d,
          dps: { ...d.dps, active: newState, supervisionState: newState ? 'active' : 'normal' }
        } : d
      ));

      const where = emu ? `INPUT ${door.dps.channel} (#${emu.address})` : driven;
      onLog('io', `${door.name} DPS (${where}) driven ${newState ? 'OPEN' : 'CLOSED'}`);
      onAuditLog(`${door.name}: DPS ${newState ? 'opened' : 'closed'}`);
    } catch (e: any) {
      onLog('error', `Failed to drive ${door.name} DPS (${emu ? `ch ${door.dps.channel}` : doorOutputLabel(door.dps)}): ${e.message}`);
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
    if (!emu && !isDoorOutputAssigned(door.rexIn)) { onLog('error', `${door.name} REX has no output assigned`); return; }
    let driven = '';

    try {
      if (emu) {
        if (door.rexIn.channel >= emu.numInputs) {
          throw new Error(`REX INPUT ${door.rexIn.channel} out of range — board #${emu.address} (${emu.model}) has ${emu.numInputs} inputs (0-${emu.numInputs - 1})`);
        }
        const emuActive = door.rexIn.reverseSense ? !newState : newState;
        await setEmuInput(ipAddress, emu.address, door.rexIn.channel, emuActive);
      } else {
        driven = await driveDoorOutput(apiBase, door.rexIn, newState, `${door.name} REX`);
      }

      setDoors(prev => prev.map(d =>
        d.id === doorId ? {
          ...d,
          rexIn: { ...d.rexIn, active: newState, supervisionState: newState ? 'active' : 'normal' }
        } : d
      ));

      const where = emu ? `INPUT ${door.rexIn.channel} (#${emu.address})` : driven;
      onLog('io', `${door.name} REX (${where}) driven ${newState ? 'PRESSED' : 'IDLE'}`);
      onAuditLog(`${door.name}: REX ${newState ? 'pressed' : 'released'}`);
    } catch (e: any) {
      onLog('error', `Failed to drive ${door.name} REX (${emu ? `ch ${door.rexIn.channel}` : doorOutputLabel(door.rexIn)}): ${e.message}`);
    }
  };

  // AETHER_DOOR_BUTTONS (Update 74): a REX click is a momentary press (held REX_PULSE_MS),
  // like a real button. It used to latch: the 2nd click only released it, and a REX left
  // held stops the panel seeing the next press.
  const rexPulsing = React.useRef<Set<number>>(new Set());
  const pulseDoorREX = async (doorId: number) => {
    if (rexPulsing.current.has(doorId)) return;          // already mid-press
    rexPulsing.current.add(doorId);
    try {
      await simulateDoorREX(doorId, true);
      await new Promise(r => setTimeout(r, REX_PULSE_MS));
      await simulateDoorREX(doorId, false);
    } finally { rexPulsing.current.delete(doorId); }
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

    // AETHER_DOOR_OUTPUTS (Update 69): physical door — read back what Aether
    // is DRIVING on Lock / DPS / REX (they are outputs, not opto inputs).
    let relayStatus: Promise<any> | null = null;
    const getRelayStatus = () => {
      if (!relayStatus) relayStatus = fetchJson(`${apiBase}/api/gpio/status`);
      return relayStatus;
    };
    const results: { key: 'lock' | 'dps' | 'rexIn'; role: string; active?: boolean; supervisionState?: any }[] = [];
    const failures: string[] = [];
    for (const { key, role: baseRole } of DOOR_OUTPUT_ROLES) {
      if (!isDoorOutputAssigned(door[key])) continue;   // not assigned: nothing driven
      // AETHER_LOCK_WATCH: a watched lock reads its OPTO input (reverseSense applies there).
      // AETHER_ANALOG_IN: or its EOL zone (ADC n) via readLockWatch.
      const watched = key === 'lock' && isLockWatch(door.lock);
      const role = watched ? `${baseRole} (watched ${lockWatchLabel(door.lock)})` : baseRole;
      try {
        if (watched) {   // AETHER_ANALOG_IN: keep the zone's supervision state too
          const w = await readLockWatch(apiBase, door.lock, `${door.name} ${baseRole}`);
          results.push({ key, role, active: w.active, supervisionState: w.supervisionState });
          continue;
        }
        const io = key === 'lock' ? lockDriveIO(door.lock) : door[key];
        results.push({ key, role, active: await readDoorOutput(apiBase, io, getRelayStatus, `${door.name} ${baseRole}`) });
      } catch (e: any) {
        failures.push(`${role}${watched ? '' : ` (${doorOutputLabel(door[key])})`}: ${e.message}`);
      }
    }
    if (failures.length) onLog('error', `Failed to refresh ${door.name}: ${failures.join('; ')}`);
    const got = results.filter(r => r.active !== undefined);
    if (!got.length) return;
    setDoors(prev => prev.map(d => {
      if (d.id !== doorId) return d;
      const next: any = { ...d };
      for (const r of got) {
        next[r.key] = r.key === 'lock'
          ? { ...d.lock, active: r.active, ...(isLockWatch(d.lock) ? { supervisionState: r.supervisionState } : {}) }   // AETHER_ANALOG_IN
          : { ...(d as any)[r.key], active: r.active, supervisionState: r.active ? 'active' : 'normal' };
      }
      return next;
    }));
    const word = (r: { key: string; active?: boolean }) =>
      r.key === 'lock' ? (r.active ? 'UNLOCKED' : 'locked') : r.key === 'dps' ? (r.active ? 'OPEN' : 'closed') : (r.active ? 'PRESSED' : 'idle');
    onLog('info', `${door.name}: ${isLockWatch(door.lock) ? 'I/O' : 'Outputs'} read back — ${got.map(r => `${r.role}:${word(r)}`).join(' ')}`);
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
        // AETHER_LOCK_WATCH: lock / unlock / pulse-lock steps cannot drive a watched lock — warn and skip.
        const lockStep = step.action === 'lock' || step.action === 'unlock' ||
          (step.action === 'pulse' && !['dps', 'rex'].includes(String(step.pulseTarget || 'lock').toLowerCase()));
        if (lockStep && isWatchedLock(cur)) {
          onLog('warn', `Step ${i + 1} (${step.action}${step.action === 'pulse' ? ' lock' : ''}): ${cur.name} Lock is watched on ${lockWatchLabel(cur.lock)} (driven by the controller) — skipped`);
          hooks?.onStepEnd?.(i, step, true);   // skipped, not failed (not counted as ran)
          continue;
        }

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
              // AETHER_ANALOG_IN: input ios are not driven (toggleDoorDynamicIO logs why)
              if (await toggleDoorDynamicIO(doorId, step.ioId)) onLog('io', `Step ${i + 1}: Toggled I/O on ${door.name}`);
              else { hooks?.onStepEnd?.(i, step, true); continue; }   // input I/O: not driven — skipped, not counted as ran
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
            }, door.id);   // AETHER_DOOR_ACTIVITY: logged on this door
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
      if (door && connected) postDoorActivity(door.id, 'event', `Event ${eventNumber} refused: door is disabled`, 'warn');   // AETHER_DOOR_ACTIVITY
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
      postDoorActivity(door.id, 'event', `Event "${event.name}" refused: disabled`, 'warn');   // AETHER_DOOR_ACTIVITY
      return;
    }

    onAuditLog(`Executing custom event: ${event.name} on ${door.name}`);
    // AETHER_DOOR_WORKFLOWS: a linked workflow runs in the Emulation engine with this door as "This door"
    if (event.workflowId) {
      await runEventWorkflow(door, event);
      return;
    }
    onLog('info', `🎬 Starting custom event: ${event.name} (${event.steps.length} steps)`);
    postDoorActivity(door.id, 'event', `Event "${event.name}" started (${event.steps.length} steps)`);   // AETHER_DOOR_ACTIVITY
    await runEventSteps(doorId, event.steps);
    onLog('success', `✓ Custom event completed: ${event.name}`);
  };

  // AETHER_DOOR_WORKFLOWS: start a door event's workflow (also used by Test Run).
  // Resolves once Emulation has started it (or refused); the run's progress is in the Emulation log.
  const runEventWorkflow = async (door: { id: number; name: string }, event: { name: string; workflowId?: string; workflowName?: string }, prefix = '🎬'): Promise<{ ok: boolean; error?: string }> => {
    const wf = event.workflowName || event.workflowId || '';
    onLog('info', `${prefix} ${event.name} on ${door.name}: starting workflow "${wf}"`);
    const r = await requestRunWorkflow({ workflowId: String(event.workflowId), doorId: door.id, label: `${door.name} · ${event.name}`, scope: nodeScope(nodeId, ipAddress) });   // AETHER_DOOR_IO_WORKFLOWS: this node's Emulation only
    if (r.ok) onLog('success', `${prefix} ${event.name}: workflow "${wf}" started — follow it in the Emulation log`);
    else onLog('error', `${prefix} ${event.name}: workflow "${wf}" not started — ${r.error}`);
    // AETHER_DOOR_ACTIVITY: started / refused (a Test Run from Settings says so)
    const test = prefix === '🧪' ? ' (test run)' : '';
    if (r.ok) postDoorActivity(door.id, 'event', `Event "${event.name}" started workflow "${wf}"${test}`, 'info', 'workflow');
    else postDoorActivity(door.id, 'event', `Event "${event.name}" workflow "${wf}" not started${test}: ${r.error || 'refused'}`, 'warn', 'workflow');
    return r;
  };

  // AETHER_DOOR_WORKFLOWS: the builder saved a workflow for one of our events. When
  // it already wrote the link to the Pi (persisted) only local state is updated;
  // otherwise link it here and save.
  const doorsRef = useRef(doors);
  doorsRef.current = doors;
  const saveDoorConfigRef = useRef<null | ((d?: any[]) => Promise<boolean>)>(null);   // set below, after saveDoorConfiguration
  const scopeRef = useRef(nodeScope(nodeId, ipAddress)); scopeRef.current = nodeScope(nodeId, ipAddress);   // AETHER_DOOR_IO_WORKFLOWS: bridge scope = this node
  useEffect(() => onWorkflowSaved(() => scopeRef.current, d => {
    if (!d || d.doorId === undefined || d.eventIndex === undefined) return;
    const prev = doorsRef.current;
    if (!prev.some(x => x.id === Number(d.doorId))) return;
    const next = prev.map(x => {
      if (x.id !== Number(d.doorId)) return x;
      const events = Array.isArray(x.customEvents) ? x.customEvents.map(e => ({ ...e })) : [];
      while (events.length <= d.eventIndex) events.push({ name: `Custom Event ${events.length + 1}`, enabled: true, steps: [] });
      events[d.eventIndex] = { ...events[d.eventIndex], workflowId: d.id, workflowName: d.name };
      return { ...x, customEvents: events };
    });
    doorsRef.current = next;
    setDoors(next);
    if (!d.persisted) saveDoorConfigRef.current?.(next);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps


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

  // AETHER_ANALOG_IN: resolves true when the I/O was toggled.
  const toggleDoorDynamicIO = async (doorId: number, ioId: string): Promise<boolean> => {
    if (!connected) return false;
    const door = doors.find(d => d.id === doorId);
    if (!door || !door.enabled) return false;

    const io = door.ios.find(i => i.id === ioId);
    if (!io || io.channel < 0) return false;
    // AETHER_ANALOG_IN: an opto / analog custom I/O is an Aether INPUT; it follows
    // the panel's output (input_state_change), so there is nothing to drive.
    if (isCustomInputIO(io)) {
      onLog('warn', `${door.name}: ${io.name} is an input (${customIOLabel(io)}); it follows the panel — not toggled`);
      return false;
    }

    const newState = !io.active;

    try {
      if (io.hardwareType === 'relay') {
        // AETHER_DOOR_IO_WORKFLOWS: Reverse Sense ("Active at Rest") = relay ON while INACTIVE,
        // the same rule as driveDoorOutput and Emulation's customIoDriveLevel (it was ignored here).
        const relayOn = io.reverseSense ? !newState : newState;
        await setRelayOutput(ipAddress, io.channel, relayOn ? 1 : 0, io.stackLevel);
      }
      // For opto/analog inputs, we just toggle the local state for simulation

      setDoors(prev => prev.map(d => {
        if (d.id !== doorId) return d;
        return {
          ...d,
          ios: d.ios.map(i => i.id === ioId ? { ...i, active: newState } : i)
        };
      }));

      onLog('io', `${door.name} ${io.name} (${io.hardwareType} ${io.channel}) ${newState ? 'ACTIVE' : 'INACTIVE'}${io.hardwareType === 'relay' && io.reverseSense ? ` (relay ${newState ? 'OFF' : 'ON'}, Reverse Sense)` : ''}`);   // AETHER_DOOR_IO_WORKFLOWS
      return true;
    } catch (e: any) {
      onLog('error', `Failed to toggle ${io.name}: ${e.message}`);
      return false;
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
    // AETHER_READER_DIR: only legacy pool ids update the pool (enrolled wg-/osdp- ids don't).
    if (readerId && !readerId.startsWith('ctrl-emu-') && readerPool.some(r => r.id === readerId) && !dirReaderById(readerId)) {
      onUpdateReaderPool(readerPool.map(r =>
        r.id === readerId ? { ...r, assignedToDoor: doorId, position: 'in' }
        : (r.assignedToDoor === doorId ? { ...r, assignedToDoor: null, position: null } : r)
      ));
    }
    onAuditLog(`${readerId ? 'Assigned' : 'Cleared'} reader for Door ${doorId}`);
  };

  const sendCredentialToReader = async (readerId: string, credential: { format: number; facility: number; card: number; formatId?: string }, doorId?: number) => {
    if (!connected) return;
    // AETHER_DOOR_ACTIVITY: log the card on the door it was presented at (the given door, else
    // the door this reader is assigned to). Fire-and-forget; never blocks the send.
    const actDoor = doorId !== undefined
      ? doorsRef.current.find(d => d.id === doorId)
      : doorsRef.current.find(d => !!d.reader && (d.reader === readerId || resolveReaderId(d.reader) === resolveReaderId(readerId)));
    const cardDesc = `Card FC ${credential.facility} #${credential.card} (${credential.format}-bit)`;
    const logCard = (via: string, error?: string) => {
      if (!actDoor) return;
      if (error === undefined) postDoorActivity(actDoor.id, 'card', `${cardDesc} presented on ${actDoor.name} · ${via}`, 'ok');
      else postDoorActivity(actDoor.id, 'card', `${cardDesc} NOT sent on ${actDoor.name} · ${via}: ${error}`, 'warn');
    };

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
        logCard(`#${addr} Reader ${port}`);   // AETHER_DOOR_ACTIVITY
      } catch (e: any) {
        onLog('error', `✗ Emulated card error: ${e.message}`);
        logCard(`#${addr} Reader ${port}`, e.message);   // AETHER_DOOR_ACTIVITY
      }
      return;
    }

    // AETHER_READER_DIR: enrolled Wiegand / OSDP reader (legacy pool ids resolve
    // to the enrolled reader on the same pins); otherwise the legacy pool path.
    const dir = dirReaderById(resolveReaderId(readerId));
    if (dir) {
      try {
        const where = await sendCardToDirReader(apiBase, dir, { bits: credential.format, facility: credential.facility, card: credential.card, formatId: credential.formatId });
        onLog('success', `✓ Credential transmitted to ${where}`);
        onAuditLog(`Card sent: FC=${credential.facility}, Card=${credential.card} on ${dir.name}`);
        logCard(dir.type === 'osdp' ? 'OSDP' : 'Wiegand');   // AETHER_DOOR_ACTIVITY
      } catch (e: any) {
        onLog('error', `✗ Transmission to ${dir.name} failed: ${e.message}`);
        logCard(dir.type === 'osdp' ? 'OSDP' : 'Wiegand', e.message);   // AETHER_DOOR_ACTIVITY
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
        logCard('Wiegand');   // AETHER_DOOR_ACTIVITY
      } else {
        onLog('error', `✗ Transmission failed: ${(result as any).error || 'Unknown error'}`);
        logCard('Wiegand', (result as any).error || 'Unknown error');   // AETHER_DOOR_ACTIVITY
      }
    } catch (e: any) {
      onLog('error', `✗ API error: ${e.message}`);
      logCard(reader.type === 'osdp' ? 'OSDP' : 'Wiegand', e.message);   // AETHER_DOOR_ACTIVITY
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
    // AETHER_DOOR_OUTPUTS (Update 69): Lock/DPS/REX are relay outputs; pick
    // relays no enabled physical door or system output already uses.
    // Never reuses a relay; roles left -1 (not assigned) when the board is full.
    // Emulated doors keep the board-channel defaults (0 / 0 / 1).
    const [relayCh, dpsCh, rexCh] = newDoorSource === 'emulated'
      ? [0, 0, 1]
      : pickFreeRelayChannels(doors, [globalPowerFault, globalBatteryFault, globalTamper, globalFAI], 3);
    if (newDoorSource !== 'emulated' && [relayCh, dpsCh, rexCh].some(c => c < 0)) {
      onLog('warn', `Not enough free relays: some outputs of "${name}" are not assigned. Pick an output for each in Settings.`);
    }
    const door: Door = newDoorWithDefaults(nextId, name, newDoorSource, [relayCh, dpsCh, rexCh]);
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

  // AETHER_DOOR_LAYOUT (Update 71): one-click 4-door layout. Local state only —
  // nothing is driven or saved; Save Configuration keeps it, Load Configuration undoes it.
  const applyLayoutButton = () => {
    const { doors: next, created, skipped } = applyFourDoorLayout(doors, MAX_DOORS);
    setDoors(next);
    onAuditLog('Applied 4-door layout to Doors 1-4');
    onLog('info', `4-door layout applied to Doors 1-4: DPS = REL 1/3/5/7, REX = REL 2/4/6/8, Lock watched on OPTO 1-4${created.length ? ` (created Door ${created.join(', ')})` : ''}. Not saved yet: press Save Configuration to keep it, or Load Configuration to undo.`);
    if (skipped.length) onLog('warn', `No free slot for Door ${skipped.join(', ')} (maximum ${MAX_DOORS} doors)`);
  };

  const toggleDoorEnabled = (doorId: number) => {
    setDoors(prev => prev.map(door =>
      door.id === doorId ? { ...door, enabled: !door.enabled } : door
    ));
    onAuditLog(`Toggled Door ${doorId} enabled status`);
  };

  /** ---------- Configuration Persistence ---------- */
  const systemOutputList = () => [globalPowerFault, globalBatteryFault, globalTamper, globalFAI];

  const saveDoorConfiguration = async (doorsOverride?: any[]): Promise<boolean> => {
    // AETHER_DOOR_OUTPUTS: shared outputs do NOT block this save (events,
    // enable toggles, Save Configuration…) — the page banner keeps warning.
    // Only a door's Settings save is gated, in applyDoorEdit.
    const doorsToSave = (doorsOverride || doors).map((d: any) => normalizeDoorOutputs(d));
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
    return true;
  };
  saveDoorConfigRef.current = saveDoorConfiguration;   // AETHER_DOOR_WORKFLOWS

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
        // Migrate from old format if needed (shared with loadSavedDoors).
        // AETHER_DOOR_OUTPUTS: legacy opto/analog DPS/REX -> relay (same channel).
        const migratedDoors = config.doors.map((door: any) => migrateSavedDoor<Door>(door));
        setDoors(migratedDoors);
        setConfigLoads(n => n + 1);   // AETHER_DOOR_BUTTONS: re-read the real relays over the saved states
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

  /** ---------- AETHER_DOOR_OUTPUTS (Update 69): door Settings save gate ---------- */
  // Shared outputs that involve THIS door (its Lock/DPS/REX vs. another enabled
  // physical door, a system output, or another of its own outputs). Clashes
  // between other doors are ignored here so unrelated edits still save.
  const conflictsForDoor = (candidate: any): DoorOutputConflict[] => {
    const norm = normalizeDoorOutputs(candidate);
    if (!isPhysicalEnabledDoor(norm)) return [];
    const nextDoors = doors.map(d => d.id === norm.id ? norm : d);
    if (!nextDoors.some(d => d.id === norm.id)) nextDoors.push(norm);
    // AETHER_LOCK_WATCH: a watched lock is an input, so it never claims a relay
    const mine = new Set(DOOR_OUTPUT_ROLES.filter(({ key }) => norm[key] && isDoorOutputAssigned(norm[key]) && !isLockWatch(norm[key])).map(({ key }) => doorOutputKey(norm[key])));
    return findDoorOutputConflicts(nextDoors, systemOutputList()).filter(c => mine.has(c.key));
  };

  // Out-of-range channel for the chosen kind (e.g. DAC 5) — should not happen
  // via the UI, but never persist a dead output. -1 (not assigned) is allowed.
  const rangeProblems = (norm: any): string[] => {
    if (norm.ioSource === 'emulated') return [];
    const out: string[] = [];
    for (const { key, role } of DOOR_OUTPUT_ROLES) {
      const io = norm[key];
      if (!io) continue;
      const kind = doorOutputKind(io);
      if (isDoorOutputAssigned(io) && io.channel >= DOOR_OUTPUT_CHANNELS[kind]) {
        out.push(`${role}: channel ${io.channel + 1} does not exist for ${kind === 'dac' ? 'analog outputs (DAC 1–4)' : kind === 'od' ? 'open-drain (O.D. 1–4)' : 'relays (REL 1–8)'}`);
      }
      if (kind === 'dac' && io.activeVolts !== undefined && !(Number(io.activeVolts) > 0 && Number(io.activeVolts) <= 10)) {
        out.push(`${role}: active voltage must be more than 0 V and at most 10 V`);
      }
    }
    return out;
  };

  // What DoorSettings shows inline. `blocking` = Save would be refused.
  // Reviewer #9: an edit that leaves this door's Lock/DPS/REX outputs exactly
  // as saved (kind/channel/stack/activeVolts) is NOT blocked even if the door
  // already clashes — so e.g. custom-event edits are never lost. Changing an
  // output while a clash remains (or creating one) is blocked.
  const checkDoorEdit = (candidate: any): { problems: string[]; blocking: boolean } => {
    const norm = normalizeDoorOutputs(candidate);
    const range = rangeProblems(norm);
    const clashes = conflictsForDoor(norm).map(describeDoorOutputConflict);
    const saved = doors.find(d => d.id === norm.id);
    const outputsUnchanged = !!saved && doorOutputsSignature(normalizeDoorOutputs(saved)) === doorOutputsSignature(norm);
    return { problems: [...range, ...clashes], blocking: range.length > 0 || (clashes.length > 0 && !outputsUnchanged) };
  };

  // Apply an edited door from Settings. Refused (false, logged) when blocking;
  // otherwise update + persist (an unchanged pre-existing clash is only warned).
  const applyDoorEdit = (updatedDoor: any): boolean => {
    const norm = normalizeDoorOutputs(updatedDoor);
    const { problems, blocking } = checkDoorEdit(norm);
    if (blocking) {
      onLog('error', `Settings for ${norm.name} not saved: give each output its own channel, or disable the door.`);
      problems.forEach(m => onLog('error', `  ${m}`));
      return false;
    }
    if (problems.length) onLog('warn', `${norm.name} still shares outputs (unchanged): ${problems.join('; ')}`);
    const nextDoors = doors.map(d => d.id === norm.id ? norm : d);
    setDoors(nextDoors);
    onAuditLog(`Updated settings for ${norm.name}`);
    saveDoorConfiguration(nextDoors);
    return true;
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
  // AETHER_ANALOG_IN: EOL zone wording for a supervision state (short = TAMPER)
  const zoneWord = (s?: string) => s === 'active' ? 'ALARM' : s === 'trouble' ? 'TROUBLE' : s === 'short' ? 'TAMPER' : 'NORMAL';

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
    } else if (dirReaderById(rid)) {
      label = dirReaderLabel(dirReaderById(rid)!);   // AETHER_READER_DIR
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
      sendCredentialToReader(door.reader!, { format: fmtBits, facility, card, formatId: fmt.id } as any, door.id);   // AETHER_DOOR_ACTIVITY: logged on this door
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

  const renderDoorCard = (door: Door) => {
    const emu = door.ioSource === 'emulated';
    const board = emuBoards.find(x => x.address === door.emuBoard);
    const isOpen = door.dps.active;
    const unlocked = door.lock.active;
    // AETHER_ANALOG_IN: zone fault on a watched lock ('trouble' | 'short'), else null
    const lockFault = !emu && isWatchedLock(door) && (door.lock.supervisionState === 'trouble' || door.lock.supervisionState === 'short') ? door.lock.supervisionState : null;
    const state = !door.enabled ? 'DISABLED' : isOpen ? 'OPEN' : unlocked ? 'UNLOCKED' : 'LOCKED';
    const stateColor = !door.enabled ? DC.dim : isOpen ? DC.blue : unlocked ? DC.good : DC.crit;
    const events = (door.customEvents || []).map((e, i) => ({ ...e, num: i + 1 })).filter(e => e.enabled);
    const chan = (io: { channel: number; hardwareType?: string; stackLevel?: number; activeVolts?: number }, kind: 'in' | 'out') =>
      emu ? `${kind === 'out' ? 'Output' : 'Input'} ${io.channel}${door.emuBoard ? ` · #${door.emuBoard}` : ''}`
          : isLockWatch(io) ? `Watched · ${lockWatchLabel(io)}`   // AETHER_LOCK_WATCH
          : `${doorOutputLabel(io)}${doorOutputKind(io) === 'dac' ? ` · ${doorActiveVolts(io)} V` : ''}`;

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
            <IconBtn title={emu ? 'Refresh inputs from the emulated board' : 'Read back what Aether is driving'} onClick={() => refreshDoorInputs(door.id)} disabled={!connected || !door.enabled}><RefreshCw size={15} /></IconBtn>
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
              {/* AETHER_ANALOG_IN: a watched EOL zone in TROUBLE / TAMPER stays LOCKED and says so */}
              <IoRow label={door.lock.name} meta={<>{chan(door.lock, 'out')}{emu ? ' · driven by controller' : ''}{lockFault ? ` · ${zoneWord(lockFault)}` : ''}</>}
                dot={(lockFault && supColor(lockFault)) || (unlocked ? DC.good : null)} active={unlocked} btn={unlocked ? 'UNLOCKED' : 'LOCKED'}
                onClick={() => toggleDoorLock(door.id)} disabled={!connected || !door.enabled}
                title={emu ? 'Shows the controller’s lock output. Click to override.'
                  : isWatchedLock(door) ? `Read-only: the controller drives this lock (watching ${lockWatchLabel(door.lock)})` : 'Toggle the lock output'} />
              <IoRow label={door.dps.name} meta={<>{chan(door.dps, 'in')}{door.dps.supervisionState && door.dps.supervisionState !== 'normal' ? ` · ${door.dps.supervisionState.toUpperCase()}` : ''}</>}
                dot={supColor(door.dps.supervisionState) || (isOpen ? DC.blue : null)} active={isOpen} activeColor={DC.blue}
                btn={isOpen ? 'OPEN' : 'CLOSED'} onClick={() => simulateDoorDPS(door.id)} disabled={!connected || !door.enabled}
                title="Drive the controller’s door position input" />
              <IoRow label={door.rexIn.name} meta={<>{chan(door.rexIn, 'in')}{door.rexIn.supervisionState && door.rexIn.supervisionState !== 'normal' ? ` · ${door.rexIn.supervisionState.toUpperCase()}` : ''}</>}
                dot={supColor(door.rexIn.supervisionState) || (door.rexIn.active ? DC.amber : null)} active={door.rexIn.active} activeColor={DC.amber}
                btn={door.rexIn.active ? 'PRESSED' : 'PRESS'} onClick={(e) => (e && e.shiftKey) || door.rexIn.active ? simulateDoorREX(door.id) : pulseDoorREX(door.id)} disabled={!connected || !door.enabled}
                title={`Press the controller’s request-to-exit input for ${REX_PULSE_MS / 1000} s. Shift+click holds it pressed until clicked again.`} />
              {/* AETHER_ANALOG_IN: custom input I/O (OPTO n / ADC n) — read-only, follows the panel */}
              {(door.ios || []).filter(io => io.enabled !== false && isCustomInputIO(io)).map(io => (
                <React.Fragment key={io.id}><IoRow label={io.name}
                  meta={<>Input · {customIOLabel(io)}{io.hardwareType === 'analog' ? ` · ${zoneWord(io.supervisionState)}` : ''}</>}
                  dot={(io.hardwareType === 'analog' && io.supervisionState !== 'active' && supColor(io.supervisionState)) || (io.active ? DC.teal : null)}
                  active={io.active} activeColor={DC.teal} btn={io.active ? 'ACTIVE' : 'IDLE'}
                  onClick={() => {}} disabled title={`Read-only: follows the panel on ${customIOLabel(io)}`} /></React.Fragment>
              ))}
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
                        title={e.workflowId ? `Run "${e.name}" — workflow "${e.workflowName || e.workflowId}"` /* AETHER_DOOR_WORKFLOWS */ : `Run "${e.name}" (${e.steps.length} steps)`}
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

        {/* AETHER_DOOR_ACTIVITY: what happened on this door's I/O and reader */}
        <DoorActivityLog doorId={door.id} store={activityStore} onClear={clearDoorActivity} disabled={!connected} />

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
      {/* AETHER_DOOR_OUTPUTS (Update 69): shared-output warning */}
      {(() => {
        const conflicts = findDoorOutputConflicts(doors, systemOutputList());
        if (!conflicts.length) return null;
        return (
          <div role="alert" className="rounded-xl px-4 py-3 border flex gap-3"
            style={{ background: 'rgb(var(--hv-warning-tint))', borderColor: 'rgb(var(--hv-warning) / 0.55)', color: 'rgb(var(--hv-warning-text))' }}>
            <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: DC.warn }} />
            <div className="min-w-0 text-sm">
              <div className="font-bold">
                {conflicts.length === 1 ? 'One output is' : `${conflicts.length} outputs are`} shared by more than one enabled door
              </div>
              <ul className="mt-1 space-y-0.5">
                {conflicts.map(c => <li key={c.key}>{describeDoorOutputConflict(c)}</li>)}
              </ul>
              <div className="mt-1 text-xs" style={{ color: 'rgb(var(--hv-text-2))' }}>
                Pressing one of these also drives the others. Give each its own output in the door’s Settings → Mandatory I/O, or disable the door. Settings for an affected door can’t be saved until its clash is fixed.
              </div>
            </div>
          </div>
        );
      })()}

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
          {/* AETHER_DOOR_LAYOUT */}
          <button
            onClick={applyLayoutButton}
            title="Doors 1-4: DPS = REL 1/3/5/7, REX = REL 2/4/6/8, Lock watched on OPTO 1-4. Press Save Configuration to keep it."
            className="px-6 py-3 bg-hv-popup-panel hover:bg-hv-box border border-hv-line rounded-lg font-semibold flex items-center justify-center gap-2"
          >
            <Plus size={20} />
            Apply 4-door layout
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
          readers={settingsReaders as any}
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
            // AETHER_DOOR_OUTPUTS: returns false (DoorSettings stays open and
            // shows the clash) when this door would share an output.
            if (!applyDoorEdit(updatedDoor)) return false;
            setShowDoorSettings(false);
            setEditingDoorId(null);
            return true;
          }}
          checkOutputConflicts={checkDoorEdit}
          // AETHER_DOOR_WORKFLOWS: workflow library, save-without-closing, run a linked workflow
          ipAddress={ipAddress}
          nodeId={nodeId}   /* AETHER_DOOR_IO_WORKFLOWS: bridge scope */
          onPersistDoor={(updatedDoor: any) => applyDoorEdit(updatedDoor)}
          onRunWorkflow={async (doorId: number, event: any) => {
            const d = doors.find(x => x.id === doorId);
            if (!connected) { onLog('error', 'Test Run: not connected'); return { ok: false, error: 'not connected' }; }
            return runEventWorkflow({ id: doorId, name: d?.name || `Door ${doorId}` }, event, '🧪');
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
          onApplyEventToAllDoors={(eventIndex: number, event: any, updatedDoor?: any) => {
            // #1: copy `event` into slot `eventIndex` on EVERY door, leaving
            // each door's OTHER event slots untouched. Then persist so the
            // mass-assignment survives a reboot.
            // AETHER_DOOR_WORKFLOWS: the event now carries its workflow link, so this
            // links the same workflow on every door. `updatedDoor` = the door just
            // saved from Settings (`doors` here is still the pre-save state).
            const baseDoors = updatedDoor ? doors.map(d => d.id === updatedDoor.id ? normalizeDoorOutputs(updatedDoor) : d) : doors;
            const nextDoors = baseDoors.map(d => {
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
