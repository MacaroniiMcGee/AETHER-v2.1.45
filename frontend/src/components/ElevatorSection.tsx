// ElevatorSection.tsx: an access-controlled elevator, laid out like the real thing.
//
//  Car panel (COP)        what a rider sees: floor display, card reader, floor
//                         buttons, door open/close, alarm/stop.
//  Hoistway               the car moving between floors, its doors, hall calls,
//                         and each floor's two hardware signals.
//
// How access works (same as a real destination-lockout install):
//  1. Rider presents a card at the car reader. The credential goes to the
//     access controller (ACU) over OSDP or Wiegand.
//  2. The ACU grants floors by driving one input per floor on this unit
//     ("Controller" grant source). "Open" (the default) lets every button work
//     so the panel can be tested with nothing wired; a grant input that turns
//     on still lights its floor. "Simulated" grants the card's floors from
//     this page for a few seconds.
//  3. Granted floor buttons light up; a secured floor's button does nothing
//     until it is granted. Unsecured floors (the lobby by default) always work.
//  4. When the car reaches a floor, that floor's tracking output turns ON so the
//     ACU knows where the car is; it turns OFF when the car leaves.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, Bell, CreditCard, ChevronUp, ChevronDown, Lock, Download, Trash2, X, Play, Shuffle } from 'lucide-react';
import { useCardFormats, type CardFormat } from '../hooks/useCardFormats';
import { driveDoorOutput, doorOutputChannelLabel, DOOR_OUTPUT_CHANNELS, loadSavedDoors, collectDoorOutputUsers, type DoorOutputUser } from '../lib/doorOutputs';

// ── Types ──────────────────────────────────────────────────────────────────
// AETHER_ELEV_TRACK: a floor's tracking OUTPUT (Aether -> controller floor-tracking input).
//   relay ch 0-7 (REL 1-8), od ch 0-3 (O.D. 1-4), dac ch 0-3 (DAC 1-4, used as a contact:
//   ON = 0 V, OFF = restVolts), emu = emulated board `address`, its INPUT `channel`.
export type TrackKind = 'none' | 'relay' | 'od' | 'dac' | 'emu';
export interface TrackCfg { kind: TrackKind; channel: number; address?: number; restVolts?: number }
// AETHER_ELEV_GRANT: a floor's grant INPUT (controller output -> Aether).
//   opto ch 0-7 (OPTO 1-8), analog = EOL zone ch 0-7 (ADC 1-8, voltage threshold),
//   emu = emulated board `address`, its OUTPUT `channel` (driven by the panel).
export type GrantKind = 'none' | 'opto' | 'analog' | 'emu';
export interface GrantCfg { kind: GrantKind; channel: number; address?: number }

export interface FloorCfg {
  id: number;            // floor number (1 = bottom)
  name: string;
  secured: boolean;      // needs an ACU grant before its car button works
  track: TrackCfg;
  grant: GrantCfg;
  button: TrackCfg;      // AETHER_ELEV_BUTTON_OUT: car-panel button output (pulsed on every press), same kinds as track
  hall: TrackCfg;        // AETHER_ELEV_BUTTON_OUT: hall-call button output (pulsed on every press)
  relay?: number;        // legacy (config v2): tracking relay 1-8, 0 = none. Migrated to `track`, unused.
  input?: number;        // legacy (config v2): grant input 1-8, 0 = none. Migrated to `grant`, unused.
}

export type EmuBoardInfo = { address: number; model: string; numInputs: number; numOutputs: number; online: boolean; inputs?: any[] | null; outputs?: any[] | null };

export interface ElevatorCfg {
  floors: FloorCfg[];
  grantSource: 'open' | 'controller' | 'simulated';
  version?: number;
  inputType: 'opto' | 'analog'; // legacy (v2): global grant input type; now per floor in `grant.kind`
  analogThreshold: number;      // volts
  grantWindow: number;          // s, simulated grants
  cardFloors: number[];         // floors a simulated card grants
  readerType: 'none' | 'osdp' | 'wiegand';
  readerId: string;
  format: string;
  facility: number;
  card: number;
  speed: number;                // floors per second
  doorHold: number;             // s
  autoReturn: number;           // s idle before returning to the lobby (0 = off)
  buttonPulseMs: number;        // AETHER_ELEV_BUTTON_OUT: button / hall-call output pulse, 100-5000 ms
}

type Doors = 'closed' | 'opening' | 'open' | 'closing';

interface LogEntry { id: number; t: Date; floor: number; kind: 'info' | 'ok' | 'warn' | 'err'; msg: string }

interface ElevatorSectionProps {
  socket?: any;
  backendUrl?: string;
  onFloorAccess?: (floor: number, reader: string, granted: boolean) => void;
  // Kept for compatibility with older parents; inputs now arrive over the socket.
  ioPlusAnalogInputs?: number[];
  ioPlusOptoInputs?: boolean[];
  inputType?: 'analog' | 'opto';
  analogThreshold?: number;
}

// AETHER_ELEV_FORMATS (Update 65): the format list comes from the shared card-format
// catalog (/api/formats, the same list Readers › Wiegand uses) and the real format id is
// sent, so a 37-bit H10302 goes out as H10302, not as "the first 37-bit format".
// This short list is only the fallback while the catalog loads or if it can't be reached.
type ElevFormat = { id: string; name: string; bits: number; fc: number; card: number };
const FORMATS: ElevFormat[] = [
  { id: 'w26', name: 'Wiegand 26 (H10301)', bits: 26, fc: 255, card: 65535 },
  { id: 'w34', name: 'Wiegand 34 (H10306)', bits: 34, fc: 65535, card: 65535 },
  { id: 'w37', name: 'Wiegand 37 (H10304)', bits: 37, fc: 65535, card: 524287 },
  { id: 'w48', name: 'Wiegand 48 (HID Corporate 1000)', bits: 48, fc: 4194303, card: 8388607 },
];
const toElevFormat = (f: CardFormat): ElevFormat => ({ id: f.id, name: f.name, bits: f.bits, fc: f.maxFacility, card: f.maxCard });
// Settings saved before Update 65 hold ids like 'wiegand26'; the catalog calls that 'w26'
const normFormatId = (id: string) => { const m = /^wiegand(\d+)$/i.exec(id || ''); return m ? `w${m[1]}` : id; };
const findFormat = (list: ElevFormat[], id: string) => list.find(f => f.id === normFormatId(id)) || list[0] || FORMATS[0];

// ── Tracking / grant wiring helpers (pure) ─────────────────────────────────
export const ELEV_CFG_VERSION = 4;   // AETHER_ELEV_BUTTON_OUT: v4 adds button / hall outputs + buttonPulseMs
export const DEFAULT_PULSE_MS = 500;
/** AETHER_ELEV_BUTTON_OUT: button pulse length, 100-5000 ms (default 500). */
export const clampPulseMs = (v: any) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? DEFAULT_PULSE_MS : Math.round(Math.min(5000, Math.max(100, n))); };
export const DEFAULT_REST_VOLTS = 5;
const NO_TRACK: TrackCfg = { kind: 'none', channel: 0 };
const NO_GRANT: GrantCfg = { kind: 'none', channel: 0 };
const assigned = (x?: { kind: string; channel: number }) => !!x && x.kind !== 'none' && Number.isInteger(x.channel) && x.channel >= 0;

/** Rest (OFF) voltage of a DAC tracking output, 0.5-10 V (default 5). */
export const clampRestVolts = (v: any) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? DEFAULT_REST_VOLTS : Math.min(10, Math.max(0.5, n)); };

/** Terminal label: 'REL 3', 'O.D. 2', 'DAC 3', '#12 Input 4' (emulated inputs 1-based), 'none'. */
export function trackLabel(t?: TrackCfg): string {
  if (!t || !assigned(t)) return 'none';
  if (t.kind === 'emu') return `#${t.address ?? '?'} Input ${t.channel + 1}`;
  return doorOutputChannelLabel(t.kind as 'relay' | 'od' | 'dac', t.channel);
}
/** 'OPTO 3', 'ADC 5' (EOL zone), '#12 Output 2', 'none'. */
export function grantLabel(g?: GrantCfg): string {
  if (!g || !assigned(g)) return 'none';
  if (g.kind === 'emu') return `#${g.address ?? '?'} Output ${g.channel + 1}`;
  return `${g.kind === 'analog' ? 'ADC' : 'OPTO'} ${g.channel + 1}`;
}
/** Identity of a tracking terminal (matches doorOutputKey for HAT outputs, stack 0). */
export const trackKey = (t?: TrackCfg): string | null =>
  !t || !assigned(t) ? null : t.kind === 'emu' ? `emu:${t.address ?? -1}:${t.channel}` : `${t.kind}:0:${t.channel}`;
/** Key of a grant input in the `inputs` state. */
export const grantKey = (g?: GrantCfg): string | null =>
  !g || !assigned(g) ? null : `${g.kind}:${g.kind === 'emu' ? (g.address ?? -1) : 0}:${g.channel}`;

const TRACK_KINDS: TrackKind[] = ['none', 'relay', 'od', 'dac', 'emu'];
const GRANT_KINDS: GrantKind[] = ['none', 'opto', 'analog', 'emu'];
const normTrack = (t: any): TrackCfg | null => t && typeof t === 'object' && TRACK_KINDS.includes(t.kind)
  ? { kind: t.kind, channel: Number(t.channel) || 0, ...(t.address != null ? { address: Number(t.address) } : {}), ...(t.kind === 'dac' ? { restVolts: clampRestVolts(t.restVolts) } : {}) } : null;
const normGrant = (g: any): GrantCfg | null => g && typeof g === 'object' && GRANT_KINDS.includes(g.kind)
  ? { kind: g.kind, channel: Number(g.channel) || 0, ...(g.address != null ? { address: Number(g.address) } : {}) } : null;

/** Config v2 `relay` N (1-8, 0 = none) -> track. */
export const trackFromRelay = (relay: any): TrackCfg => { const n = parseInt(relay, 10); return n > 0 ? { kind: 'relay', channel: n - 1 } : { ...NO_TRACK }; };
/** Config v2 `input` N (1-8, 0 = none) + global inputType -> grant. */
export const grantFromInput = (input: any, inputType: any): GrantCfg => { const n = parseInt(input, 10); return n > 0 ? { kind: inputType === 'analog' ? 'analog' : 'opto', channel: n - 1 } : { ...NO_GRANT }; };

/** Merge a saved config over the defaults and bring it to ELEV_CFG_VERSION. Old fields stay, unused. */
export function migrateElevCfg(saved: any): ElevatorCfg {
  const c: ElevatorCfg = { ...defaultCfg(), ...saved };
  // v1 defaulted to "controller", which locks every secured floor when no
  // controller is wired. v2 defaults to "open".
  if (!saved.version) c.grantSource = 'open';
  if (!Array.isArray(c.floors) || !c.floors.some((f: any) => f && typeof f === 'object')) c.floors = defaultCfg().floors;
  if (Array.isArray(c.floors)) {
    c.floors = c.floors.filter((f: any) => f && typeof f === 'object').map((f: any) => ({ ...f,
      track: normTrack(f.track) ?? trackFromRelay(f.relay),
      grant: normGrant(f.grant) ?? grantFromInput(f.input, saved.inputType),
      button: normTrack(f.button) ?? { ...NO_TRACK },    // AETHER_ELEV_BUTTON_OUT: v3 and older = none
      hall: normTrack(f.hall) ?? { ...NO_TRACK } }));
  }
  c.buttonPulseMs = clampPulseMs(c.buttonPulseMs);
  c.version = ELEV_CFG_VERSION;
  return c;
}

const byFloorOrder = (floors: FloorCfg[]) => [...floors].sort((a, b) => a.id - b.id);

/** Auto-assign tracking: an online emulated board with inputs takes floors in order
 *  (prefers a board already picked for tracking); otherwise O.D. 1-4, then DAC 1-4 (rest 5 V), then none. */
export function autoAssignTracking(floors: FloorCfg[], boards: EmuBoardInfo[]): FloorCfg[] {
  const usable = boards.filter(b => b.online && b.numInputs > 0);
  const picked = floors.find(f => f.track?.kind === 'emu')?.track.address;
  const board = usable.find(b => b.address === picked) || usable[0];
  const order = byFloorOrder(floors).map(f => f.id);
  return floors.map(f => {
    const i = order.indexOf(f.id);
    const track: TrackCfg = board ? (i < board.numInputs ? { kind: 'emu', address: board.address, channel: i } : { ...NO_TRACK })
      : i < 4 ? { kind: 'od', channel: i } : i < 8 ? { kind: 'dac', channel: i - 4, restVolts: DEFAULT_REST_VOLTS } : { ...NO_TRACK };
    return { ...f, track };
  });
}

/** Auto-assign grants: EOL zones (ADC 1-8, analog) in floor order, unless an emulated board
 *  with outputs is selected (already used for a grant) or online: then its outputs. */
export function autoAssignGrants(floors: FloorCfg[], boards: EmuBoardInfo[]): FloorCfg[] {
  const withOut = boards.filter(b => b.numOutputs > 0);
  const picked = floors.find(f => f.grant?.kind === 'emu')?.grant.address;
  const board = withOut.find(b => b.address === picked) || withOut.find(b => b.online);
  const order = byFloorOrder(floors).map(f => f.id);
  return floors.map(f => {
    const i = order.indexOf(f.id);
    const grant: GrantCfg = board ? (i < board.numOutputs ? { kind: 'emu', address: board.address, channel: i } : { ...NO_GRANT })
      : i < 8 ? { kind: 'analog', channel: i } : { ...NO_GRANT };
    return { ...f, grant };
  });
}

/** AETHER_ELEV_SHARED + AETHER_ELEV_BUTTON_OUT: who else uses each floor output's terminal
 *  (doors, other floors' tracking / button / hall call, the same floor's other roles).
 *  Keyed `${floorId}:${role}`. Notes only, never a block. */
export type OutRole = 'track' | 'button' | 'hall';
export const OUT_ROLES: { key: OutRole; name: string }[] = [{ key: 'track', name: 'tracking' }, { key: 'button', name: 'button' }, { key: 'hall', name: 'hall call' }];
export function outputShareNotes(floors: FloorCfg[], doorUsers: Pick<DoorOutputUser, 'kind' | 'channel' | 'stackLevel' | 'user'>[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const all = floors.flatMap(f => OUT_ROLES.map(r => ({ f, r, k: trackKey(f[r.key]) })));
  for (const a of all) {
    if (!a.k) continue;
    const notes = [
      ...doorUsers.filter(u => !u.stackLevel && `${u.kind}:0:${u.channel}` === a.k).map(u => u.user),
      ...all.filter(b => b !== a && b.k === a.k).map(b => b.r.key === 'track' ? `floor ${b.f.id}` : `floor ${b.f.id} ${b.r.name}`),
    ];
    if (notes.length) out[`${a.f.id}:${a.r.key}`] = notes;
  }
  return out;
}
/** Tracking-only view (Update 71 shape): floorId -> notes. */
export function trackShareNotes(floors: FloorCfg[], doorUsers: Pick<DoorOutputUser, 'kind' | 'channel' | 'stackLevel' | 'user'>[]): Record<number, string[]> {
  const all = outputShareNotes(floors, doorUsers), out: Record<number, string[]> = {};
  for (const f of floors) if (all[`${f.id}:track`]) out[f.id] = all[`${f.id}:track`];
  return out;
}

/** AETHER_ELEV_BUTTON_OUT: Auto-assign buttons. Needs an online emulated board with at least one free
 *  input per floor (inputs not used by tracking): buttons take the free inputs in floor order, hall calls
 *  the ones after (none when they run out). Without such a board nothing changes (relays / O.D. / DAC are
 *  left to tracking) and `note` says why. Prefers a board already used by tracking, then by buttons. */
export function autoAssignButtons(floors: FloorCfg[], boards: EmuBoardInfo[]): { floors: FloorCfg[]; note: string } {
  const n = floors.length;
  const prefer = [floors.find(f => f.track?.kind === 'emu')?.track.address, floors.find(f => f.button?.kind === 'emu')?.button.address];
  const online = boards.filter(b => b.online && b.numInputs > 0)
    .sort((a, b) => { const ia = prefer.indexOf(a.address), ib = prefer.indexOf(b.address); return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib); });
  const freeOf = (b: EmuBoardInfo) => {
    const used = new Set(floors.filter(f => f.track?.kind === 'emu' && f.track.address === b.address).map(f => f.track.channel));
    return Array.from({ length: b.numInputs }, (_, i) => i).filter(i => !used.has(i));
  };
  const board = online.find(b => freeOf(b).length >= n);
  if (!board) return { floors, note: `No online emulated board has ${n} free inputs; buttons left as they are (relays, O.D. and DAC stay with tracking).` };
  const free = freeOf(board);
  const order = byFloorOrder(floors).map(f => f.id);
  const next = floors.map(f => {
    const i = order.indexOf(f.id);
    const h = free[n + i];
    return { ...f, button: { kind: 'emu' as const, address: board.address, channel: free[i] },
      hall: h !== undefined ? { kind: 'emu' as const, address: board.address, channel: h } : { ...NO_TRACK } };
  });
  const halls = Math.max(0, Math.min(n, free.length - n));
  return { floors: next, note: `Buttons on #${board.address} inputs ${free[0] + 1}-${free[n - 1] + 1}${halls ? `, hall calls on the next ${halls}` : ', no inputs left for hall calls'}.` };
}

/** Drive one floor's tracking output. `on` = car is at the floor. */
async function driveTrack(base: string, t: TrackCfg | undefined, on: boolean, who: string): Promise<void> {
  if (!t || !assigned(t)) return;
  if (t.kind === 'emu') {
    if (t.address == null) throw new Error(`${who}: no emulated board chosen`);
    const r = await fetch(`${base}/api/emulator/device/${t.address}/input/${t.channel}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: on }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || `HTTP ${r.status}`);
    return;
  }
  // DAC as a contact: reverseSense makes ON = 0 V and OFF = restVolts
  const io = t.kind === 'dac' ? { hardwareType: 'dac', channel: t.channel, activeVolts: clampRestVolts(t.restVolts), reverseSense: true }
    : { hardwareType: t.kind, channel: t.channel };
  await driveDoorOutput(base, io, on, who);
}

const DEFAULT_NAMES = ['Main Lobby', 'Meeting Rooms', 'Co-Working', 'Office Suites', 'IT & Operations', 'Conference Center', 'Executive Offices', 'Penthouse'];
// The doors use REL 1-8, so tracking defaults to O.D. 1-4 then DAC 1-4 (as Auto-assign without a board).
const defaultCfg = (): ElevatorCfg => ({
  floors: autoAssignTracking(DEFAULT_NAMES.map((name, i) => ({ id: i + 1, name, secured: i !== 0, track: { ...NO_TRACK }, grant: { kind: 'opto', channel: i }, button: { ...NO_TRACK }, hall: { ...NO_TRACK } })), []),
  grantSource: 'open',
  version: ELEV_CFG_VERSION,
  inputType: 'opto',
  analogThreshold: 2.5,
  grantWindow: 10,
  cardFloors: [2, 3, 4, 5, 6, 7, 8],
  readerType: 'osdp',
  readerId: '',
  format: 'w26',
  facility: 123,
  card: 12345,
  speed: 1,
  doorHold: 6,
  autoReturn: 20,
  buttonPulseMs: DEFAULT_PULSE_MS,   // AETHER_ELEV_BUTTON_OUT
});

const STORE_KEY = 'aether.elevator.v2';
const loadCfg = (): ElevatorCfg => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const c = migrateElevCfg(JSON.parse(raw));
      if (Array.isArray(c.floors) && c.floors.length) return c;
    }
  } catch { /* storage unavailable */ }
  return defaultCfg();
};

const C = {
  panel: 'rgb(var(--hv-widget) / 0.55)', line: 'rgb(var(--hv-popup-panel))', line2: 'rgb(var(--hv-line))', text: 'rgb(var(--hv-text))', text2: 'rgb(var(--hv-text-2))', dim: 'rgb(var(--hv-text-3))',
  amber: 'rgb(var(--hv-brand))', amberHi: 'rgb(var(--hv-brand-text))', teal: 'rgb(var(--hv-info))', good: 'rgb(var(--hv-success))', crit: 'rgb(var(--hv-error))', warn: 'rgb(var(--hv-warning))',
};

const DOOR_MS = 1200;
// Hoistway columns: floor+name · shaft · TRK · ACU · hall call
const HOIST_COLS = 'minmax(150px,220fr) minmax(220px,404fr) minmax(96px,142fr) minmax(96px,130fr) 56px';

// ── Component ──────────────────────────────────────────────────────────────
export function ElevatorSection({ socket, backendUrl, onFloorAccess }: ElevatorSectionProps) {
  const onFloorAccessRef = useRef(onFloorAccess);   // parent passes a new function every render
  onFloorAccessRef.current = onFloorAccess;
  const base = backendUrl || `http://${window.location.hostname}:3001`;
  const { formats: catalog } = useCardFormats(base);
  const fmts = useMemo<ElevFormat[]>(() => (catalog.length ? catalog.map(toElevFormat) : FORMATS), [catalog]);
  const fmtsRef = useRef(fmts); fmtsRef.current = fmts;
  const [cfg, setCfg] = useState<ElevatorCfg>(loadCfg);
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ } }, [cfg]);

  // Live state (render copy) + a ref the engine reads without stale closures
  const [carFloor, setCarFloor] = useState(1);
  const [carPos, setCarPos] = useState(1);
  const shaftRef = useRef<HTMLDivElement>(null);
  const [shaftW, setShaftW] = useState(0);
  useEffect(() => {
    const el = shaftRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setShaftW(el.clientWidth));
    ro.observe(el); setShaftW(el.clientWidth);
    return () => ro.disconnect();
  }, []);                   // fractional, for the shaft animation
  const [dir, setDir] = useState<'up' | 'down' | 'idle'>('idle');
  const [doors, setDoors] = useState<Doors>('closed');
  const [stopped, setStopped] = useState(false);
  const [carCalls, setCarCalls] = useState<number[]>([]);    // lit car buttons
  const [hallCalls, setHallCalls] = useState<number[]>([]);
  const [inputs, setInputs] = useState<Record<string, boolean>>({});   // grantKey ('opto:0:2', 'emu:12:1') -> active
  const inputsRef = useRef<Record<string, boolean>>({});
  const [simGrants, setSimGrants] = useState<Record<number, number>>({}); // floor -> expires at
  const [tracking, setTracking] = useState<Record<number, boolean>>({}); // floor -> tracking output on
  const [reader, setReader] = useState<'idle' | 'ok' | 'deny' | 'busy'>('idle');
  const [flash, setFlash] = useState<number | null>(null);   // floor button that was refused
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState({ trips: 0, granted: 0, denied: 0 });
  const [showSettings, setShowSettings] = useState(false);
  const [readers, setReaders] = useState<{ osdp: { id: string; name: string }[]; wiegand: { id: string; name: string }[] }>({ osdp: [], wiegand: [] });
  const [now, setNow] = useState(Date.now());

  const S = useRef({ carFloor: 1, carPos: 1, dir: 'idle' as 'up' | 'down' | 'idle', doors: 'closed' as Doors, doorsAt: 0, holdUntil: 0,
    stopped: false, carCalls: [] as number[], hallCalls: [] as number[], moving: false, lastMoveAt: 0, idleSince: Date.now() });
  const cfgRef = useRef(cfg); cfgRef.current = cfg;

  const logId = useRef(0);
  const log = useCallback((floor: number, kind: LogEntry['kind'], msg: string) => {
    setLogs(p => [{ id: ++logId.current, t: new Date(), floor, kind, msg }, ...p].slice(0, 150));
  }, []);

  const floorsById = useMemo(() => Object.fromEntries(cfg.floors.map(f => [f.id, f])), [cfg.floors]);
  const topFloor = cfg.floors.length;

  // ── Hardware ─────────────────────────────────────────────────────────────
  // AETHER_ELEV_TRACK: relay / O.D. / DAC via driveDoorOutput, emulated board input via the emulator API
  const trackOnRef = useRef<Record<number, boolean>>({});   // floors whose tracking this page turned ON
  const setTrack = useCallback(async (floorId: number, on: boolean, floors?: FloorCfg[]) => {
    const f = (floors || cfgRef.current.floors).find(x => x.id === floorId);
    trackOnRef.current = { ...trackOnRef.current, [floorId]: on };
    setTracking(p => ({ ...p, [floorId]: on }));
    if (!f) return;
    try {
      await driveTrack(base, f.track, on, `Floor ${floorId} tracking`);
    } catch { /* bench without backend */ }
  }, [base]);
  // On stop / reset: tracking outputs this page turned ON go OFF. Others are left alone
  // (relays / outputs may be shared with Doors).
  const allTrackingOff = useCallback((floors?: FloorCfg[]) => {
    for (const f of floors || cfgRef.current.floors) if (trackOnRef.current[f.id]) setTrack(f.id, false, floors);
  }, [setTrack]);

  // On load and when tracking wiring changes, put DAC tracking outputs of floors the car is NOT
  // at to their rest voltage: a DAC idles at 0 V, which the panel reads as ON. Relays, O.D. and
  // emulated inputs idle OFF already and may be shared with Doors, so they are not touched here.
  const trackSig = useMemo(() => JSON.stringify(cfg.floors.map(f => [f.id, f.track])), [cfg.floors]);
  // DACs a door also uses are skipped (the door owns that terminal).
  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      const dacFloors = cfgRef.current.floors.filter(f => f.track && f.track.kind === 'dac');
      if (!dacFloors.length) return;
      let doorDacs = new Set<number>();
      try {
        const doors = await loadSavedDoors(base);
        doorDacs = new Set(collectDoorOutputUsers(doors).filter(u => u.kind === 'dac' && !u.stackLevel).map(u => u.channel));
      } catch { return; }   // can't tell what doors use: drive nothing
      if (dead) return;
      const s = S.current;
      for (const f of dacFloors) {
        if (f.id !== s.carFloor && !doorDacs.has(Number(f.track.channel))) setTrack(f.id, false);
      }
    }, 1500);
    return () => { dead = true; clearTimeout(t); };
  }, [trackSig, setTrack, base]);

  // AETHER_ELEV_BUTTON_OUT: pulse a floor's button / hall-call output (ON, then OFF after
  // buttonPulseMs) so the panel sees every press. A pulse already running on the same
  // terminal is not restarted. Timers are keyed by terminal (trackKey).
  const [pulsing, setPulsing] = useState<Record<string, boolean>>({});   // `${floor}:button|hall` -> on
  const pulseRef = useRef<Record<string, { timer: any; t: TrackCfg; tag: string; on: Promise<void> }>>({});
  const pulseOut = useCallback((floorId: number, role: 'button' | 'hall') => {
    const f = cfgRef.current.floors.find(x => x.id === floorId);
    const t = f?.[role], k = trackKey(t);
    if (!f || !t || !k || pulseRef.current[k]) return;
    const who = `Floor ${floorId} ${role === 'button' ? 'button' : 'hall call'}`;
    const tag = `${floorId}:${role}`;
    log(floorId, 'info', `${who} → ${trackLabel(t)} pulse`);
    setPulsing(p => ({ ...p, [tag]: true }));
    const on = driveTrack(base, t, true, who).catch(() => { /* bench without backend */ });
    const timer = setTimeout(() => {
      delete pulseRef.current[k];
      setPulsing(p => { const n = { ...p }; delete n[tag]; return n; });
      on.then(() => driveTrack(base, t, false, who)).catch(() => { /* bench */ });
    }, clampPulseMs(cfgRef.current.buttonPulseMs));
    pulseRef.current[k] = { timer, t, tag, on };
  }, [base, log]);
  // Stop / reset / leaving the page: release every held button / hall output
  const releasePulses = useCallback(() => {
    for (const k of Object.keys(pulseRef.current)) {
      const p = pulseRef.current[k];
      clearTimeout(p.timer); delete pulseRef.current[k];
      p.on.then(() => driveTrack(base, p.t, false, p.tag)).catch(() => { /* bench */ });
    }
    setPulsing({});
  }, [base]);
  useEffect(() => () => releasePulses(), [releasePulses]);
  // A DAC button / hall output idles at 0 V, which the panel reads as pressed: park it at its
  // rest voltage on load and when that wiring changes. DACs a door or any tracking uses are skipped.
  const btnSig = useMemo(() => JSON.stringify(cfg.floors.map(f => [f.id, f.button, f.hall])), [cfg.floors]);
  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      const c = cfgRef.current;
      const outs = c.floors.flatMap(f => [f.button, f.hall]).filter(o => o && o.kind === 'dac');
      if (!outs.length) return;
      const busy = new Set<number>(c.floors.filter(f => f.track?.kind === 'dac').map(f => Number(f.track.channel)));
      try {
        const doors = await loadSavedDoors(base);
        collectDoorOutputUsers(doors).filter(u => u.kind === 'dac' && !u.stackLevel).forEach(u => busy.add(u.channel));
      } catch { return; }   // can't tell what doors use: drive nothing
      if (dead) return;
      for (const o of outs) if (!busy.has(Number(o.channel)) && !pulseRef.current[trackKey(o) || '']) driveTrack(base, o, false, 'Button output').catch(() => { /* bench */ });
    }, 1500);
    return () => { dead = true; clearTimeout(t); };
  }, [btnSig, base]);

  const isAuthorized = useCallback((floorId: number) => {
    const f = cfgRef.current.floors.find(x => x.id === floorId);
    if (!f) return false;
    if (cfgRef.current.grantSource === 'open' || !f.secured) return true;
    if (cfgRef.current.grantSource === 'controller') { const k = grantKey(f.grant); return !!(k && inputs[k]); }
    return (simGrants[floorId] || 0) > Date.now();
  }, [inputs, simGrants]);

  // ── Engine ───────────────────────────────────────────────────────────────
  const sync = () => {
    const s = S.current;
    setCarFloor(s.carFloor); setCarPos(s.carPos); setDir(s.dir); setDoors(s.doors); setStopped(s.stopped);
    setCarCalls([...s.carCalls]); setHallCalls([...s.hallCalls]);
  };

  const openDoors = (reason?: string) => {
    const s = S.current;
    if (s.stopped || s.moving) return;
    if (s.doors === 'open') { s.holdUntil = Date.now() + cfgRef.current.doorHold * 1000; return; }
    if (s.doors === 'opening') return;
    s.doors = 'opening'; s.doorsAt = Date.now();
    if (reason) log(s.carFloor, 'info', reason);
    sync();
  };

  const closeDoors = () => {
    const s = S.current;
    if (s.doors === 'open') { s.doors = 'closing'; s.doorsAt = Date.now(); sync(); }
  };

  const pickNext = (): number | null => {
    const s = S.current;
    const all = Array.from(new Set([...s.carCalls, ...s.hallCalls]));
    if (!all.length) return null;
    const above = all.filter(f => f > s.carFloor).sort((a, b) => a - b);
    const below = all.filter(f => f < s.carFloor).sort((a, b) => b - a);
    if (all.includes(s.carFloor)) return s.carFloor;
    if (s.dir === 'up' && above.length) return above[0];
    if (s.dir === 'down' && below.length) return below[0];
    return (above.length ? above[0] : below[0]) ?? null;
  };

  const arrive = (floor: number) => {
    const s = S.current;
    s.moving = false; s.carFloor = floor; s.carPos = floor;
    const wasCar = s.carCalls.includes(floor);
    s.carCalls = s.carCalls.filter(f => f !== floor);
    s.hallCalls = s.hallCalls.filter(f => f !== floor);
    const more = s.carCalls.length + s.hallCalls.length > 0;
    if (!more) s.dir = 'idle';
    setTrack(floor, true);
    setSimGrants(p => { const n = { ...p }; delete n[floor]; return n; });
    log(floor, 'ok', `Arrived at ${floor} · tracking ${trackLabel(floorsById[floor]?.track)} ON${wasCar ? '' : ' (hall call)'}`);
    s.doors = 'opening'; s.doorsAt = Date.now();
    sync();
  };

  useEffect(() => {
    const iv = setInterval(() => {
      const s = S.current, c = cfgRef.current, t = Date.now();
      setNow(t);
      if (s.stopped) return;

      // Doors
      if (s.doors === 'opening' && t - s.doorsAt >= DOOR_MS) { s.doors = 'open'; s.holdUntil = t + c.doorHold * 1000; sync(); return; }
      if (s.doors === 'open' && t >= s.holdUntil) { s.doors = 'closing'; s.doorsAt = t; sync(); return; }
      if (s.doors === 'closing' && t - s.doorsAt >= DOOR_MS) { s.doors = 'closed'; s.idleSince = t; sync(); return; }
      if (s.doors !== 'closed') return;

      // Travel
      if (s.moving) {
        const step = (t - s.lastMoveAt) / 1000 * c.speed;
        s.lastMoveAt = t;
        const target = pickNext();
        if (target == null) { s.moving = false; s.dir = 'idle'; s.carPos = Math.round(s.carPos); s.carFloor = s.carPos; sync(); return; }
        const d = target > s.carPos ? 1 : -1;
        let pos = s.carPos + d * step;
        // stop at the first called floor reached on the way (collective control)
        const calls = Array.from(new Set([...s.carCalls, ...s.hallCalls]));
        const hit = calls
          .filter(f => d > 0 ? (f > s.carPos + 1e-6 && f <= pos + 1e-6) : (f < s.carPos - 1e-6 && f >= pos - 1e-6))
          .sort((a, b) => d > 0 ? a - b : b - a)[0];
        if (hit != null) { arrive(hit); return; }
        s.carPos = pos;
        const passing = Math.round(pos);   // the indicator changes as the car nears a floor
        if (passing !== s.carFloor && passing >= 1 && passing <= c.floors.length) s.carFloor = passing;
        setCarPos(pos); setCarFloor(s.carFloor);
        return;
      }

      // Idle, doors closed: next call?
      const next = pickNext();
      if (next == null) {
        if (c.autoReturn > 0 && s.carFloor !== 1 && t - s.idleSince > c.autoReturn * 1000) {
          s.hallCalls = [...s.hallCalls, 1]; log(s.carFloor, 'info', 'Idle: returning to the lobby'); sync();
        }
        return;
      }
      if (next === s.carFloor) {
        s.carCalls = s.carCalls.filter(f => f !== next); s.hallCalls = s.hallCalls.filter(f => f !== next);
        s.doors = 'opening'; s.doorsAt = t; sync(); return;
      }
      s.dir = next > s.carFloor ? 'up' : 'down';
      s.moving = true; s.lastMoveAt = t;
      setTrack(s.carFloor, false);
      setStats(p => ({ ...p, trips: p.trips + 1 }));
      log(s.carFloor, 'info', `Leaving ${s.carFloor} ${s.dir === 'up' ? '▲' : '▼'} to ${next} · tracking ${trackLabel(floorsById[s.carFloor]?.track)} OFF`);
      sync();
    }, 80);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorsById, setTrack, log]);

  // ── Rider actions ────────────────────────────────────────────────────────
  const pressFloor = (floorId: number) => {
    const s = S.current;
    pulseOut(floorId, 'button');   // AETHER_ELEV_BUTTON_OUT: every press, accepted or refused
    if (s.stopped) { log(floorId, 'warn', `Button ${floorId}: car is stopped`); return; }
    if (s.carCalls.includes(floorId)) return;
    if (!isAuthorized(floorId)) {
      setFlash(floorId); setTimeout(() => setFlash(f => (f === floorId ? null : f)), 700);
      setStats(p => ({ ...p, denied: p.denied + 1 }));
      log(floorId, 'warn', `Button ${floorId} refused: secured floor, no grant${cfgRef.current.grantSource === 'controller' ? ` (grant ${grantLabel(cfgRef.current.floors.find(x => x.id === floorId)?.grant)} is off)` : ''}. Present a card first.`);
      return;
    }
    if (floorId === s.carFloor && !s.moving) { openDoors(`Button ${floorId}: already here, opening doors`); return; }
    s.carCalls = [...s.carCalls, floorId];
    if (cfgRef.current.grantSource === 'simulated') setSimGrants(p => { const n = { ...p }; delete n[floorId]; return n; });
    log(floorId, 'ok', `Button ${floorId} lit`);
    sync();
  };

  const hallCall = (floorId: number) => {
    const s = S.current;
    pulseOut(floorId, 'hall');     // AETHER_ELEV_BUTTON_OUT: every press (demo calls too)
    if (s.stopped || s.hallCalls.includes(floorId)) return;
    if (floorId === s.carFloor && !s.moving) { openDoors(`Hall call at ${floorId}: car is here, opening doors`); return; }
    s.hallCalls = [...s.hallCalls, floorId];
    log(floorId, 'info', `Hall call at ${floorId}`);
    sync();
  };

  const emergencyStop = () => {
    const s = S.current;
    s.stopped = true; s.moving = false; s.carCalls = []; s.hallCalls = [];
    s.carPos = Math.round(s.carPos); s.carFloor = s.carPos; s.dir = 'idle';
    if (s.doors !== 'closed') s.doors = 'open';
    allTrackingOff();
    releasePulses();   // AETHER_ELEV_BUTTON_OUT
    log(s.carFloor, 'err', 'EMERGENCY STOP: all calls cancelled, tracking outputs OFF');
    sync();
  };
  const resume = () => {
    const s = S.current; s.stopped = false;
    if (s.doors === 'open') { s.holdUntil = Date.now() + cfgRef.current.doorHold * 1000; }
    setTrack(s.carFloor, true);
    log(s.carFloor, 'ok', 'Resumed');
    sync();
  };

  const presentCard = async (random = false) => {
    const c = cfgRef.current;
    if (c.readerType === 'none' || !c.readerId) { log(S.current.carFloor, 'err', 'No reader set up. Choose one in Settings.'); setShowSettings(true); return; }
    const fmt = findFormat(fmtsRef.current, c.format);
    const fc = random ? Math.floor(Math.random() * Math.min(fmt.fc, 255)) + 1 : c.facility;
    const card = random ? Math.floor(Math.random() * Math.min(fmt.card, 99999)) + 1 : c.card;
    setReader('busy');
    try {
      const r = c.readerType === 'osdp'
        ? await fetch(`${base}/api/osdp/card-read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readerId: c.readerId, facility: fc, card, format: fmt.id }) })
        : await fetch(`${base}/api/wiegand/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ door: parseInt(c.readerId, 10), facility: fc, card, format: fmt.id, pulseUs: 50, spaceUs: 1000 }) });
      const j = await r.json().catch(() => ({}));
      if (!(j.success || j.ok)) throw new Error(j.error || `HTTP ${r.status}`);
      log(S.current.carFloor, 'info', `Card presented: ${fmt.name} FC ${fc} #${card} → ${c.readerType.toUpperCase()} ${c.readerId}`);
      if (c.grantSource === 'simulated') {
        const until = Date.now() + c.grantWindow * 1000;
        setSimGrants(p => { const n = { ...p }; for (const f of c.cardFloors) n[f] = until; return n; });
        setStats(p => ({ ...p, granted: p.granted + 1 }));
        log(S.current.carFloor, 'ok', `Simulated grant: floors ${c.cardFloors.join(', ') || 'none'} for ${c.grantWindow}s`);
        c.cardFloors.forEach(f => onFloorAccessRef.current?.(f, c.readerId, true));
      }
      setReader('ok');
    } catch (e: any) {
      log(S.current.carFloor, 'err', `Card not sent: ${e.message}`);
      setReader('deny');
    }
    setTimeout(() => setReader('idle'), 1500);
  };

  // ── ACU inputs from the backend ──────────────────────────────────────────
  // AETHER_ELEV_GRANT: grants are kept per input key (grantKey) so each floor can use
  // its own kind: OPTO / EOL zone ('input_state_change') or an emulated board OUTPUT
  // the panel drives ('output-changed' payloads, 'emulator-device-update' snapshots).
  const applyGrant = useCallback((key: string, active: boolean) => {
    if (!!inputsRef.current[key] === active) return;
    inputsRef.current = { ...inputsRef.current, [key]: active };
    setInputs(inputsRef.current);
    const c = cfgRef.current;
    for (const floor of c.floors.filter(f => grantKey(f.grant) === key)) {
      log(floor.id, active ? 'ok' : 'info', `Controller ${active ? 'granted' : 'released'} floor ${floor.id} (${grantLabel(floor.grant)})`);
      if (active) { setStats(s => ({ ...s, granted: s.granted + 1 })); onFloorAccessRef.current?.(floor.id, c.readerId, true); }
    }
  }, [log]);
  // Emulated board snapshot: apply the outputs any floor watches on that board
  const applyEmuSnapshot = useCallback((dev: any) => {
    if (!dev || !Array.isArray(dev.outputs)) return;
    const addr = Number(dev.address) & 0x7F;
    for (const f of cfgRef.current.floors) {
      if (f.grant?.kind !== 'emu' || f.grant.address !== addr) continue;
      const k = grantKey(f.grant);
      if (k && f.grant.channel < dev.outputs.length) applyGrant(k, !!dev.outputs[f.grant.channel]);
    }
  }, [applyGrant]);

  const [emuBoards, setEmuBoards] = useState<EmuBoardInfo[]>([]);
  const refreshEmu = useCallback(async () => {
    try {
      const j = await (await fetch(`${base}/api/emulator/status`)).json();
      const devs: any[] = (j && j.success !== false && j.status && j.status.devices) || [];
      setEmuBoards(devs.map(d => ({ address: Number(d.address), model: d.model || '?', numInputs: d.numInputs || 0, numOutputs: d.numOutputs || 0,
        online: d.online !== false, inputs: Array.isArray(d.inputs) ? d.inputs : null, outputs: Array.isArray(d.outputs) ? d.outputs : null })));
      devs.forEach(applyEmuSnapshot);
      // a board that is gone (emulator stopped / removed) grants nothing
      const live = new Set(devs.map(d => Number(d.address) & 0x7F));
      for (const k of Object.keys(inputsRef.current)) if (k.startsWith('emu:') && !live.has(Number(k.split(':')[1]))) applyGrant(k, false);
    } catch { setEmuBoards([]); }
  }, [base, applyEmuSnapshot, applyGrant]);
  useEffect(() => { refreshEmu(); }, [refreshEmu]);
  useEffect(() => { if (showSettings) refreshEmu(); }, [showSettings, refreshEmu]);

  useEffect(() => {
    if (!socket) return;
    const onInput = (d: { type: 'opto' | 'analog'; pin: number; state: number; voltage?: number; supervisionState?: string }) => {
      const c = cfgRef.current;
      if (d.type !== 'opto' && d.type !== 'analog') return;
      let active: boolean;
      // AETHER_ELEV_ANALOG (Update 69): analog events now carry the zone's EOL state
      // (NORMAL/ALARM/...), which is not a grant signal; analog grants go by voltage.
      if (d.type === 'analog') active = (d.voltage ?? 0) >= c.analogThreshold * 1000;
      else if (d.supervisionState) active = d.supervisionState === 'active';
      else active = d.state === 1;
      applyGrant(`${d.type}:0:${d.pin}`, active);
    };
    // Same events as DoorSection's emulated-board sync
    const onOutputChanged = (m: any) => {
      if (!m) return;
      const addr = Number(m.address) & 0x7F, out = Number(m.outNum ?? m.idx);
      if (!Number.isFinite(addr) || !Number.isFinite(out)) return;
      applyGrant(`emu:${addr}:${out}`, !!(m.state ?? (m.active ? 1 : 0)));
    };
    const onBoards = () => { refreshEmu(); };
    const BOARD_EVENTS = ['emulator-started', 'emulator-stopped', 'emulator-config-applied', 'emulator-device-added', 'emulator-device-removed'];
    socket.on('input_state_change', onInput);
    socket.on('output-changed', onOutputChanged);
    socket.on('emulator-device-update', applyEmuSnapshot);
    BOARD_EVENTS.forEach(e => socket.on(e, onBoards));
    return () => {
      socket.off('input_state_change', onInput);
      socket.off('output-changed', onOutputChanged);
      socket.off('emulator-device-update', applyEmuSnapshot);
      BOARD_EVENTS.forEach(e => socket.off(e, onBoards));
    };
  }, [socket, applyGrant, applyEmuSnapshot, refreshEmu]);

  // Readers for the settings dropdowns
  useEffect(() => {
    (async () => {
      const out = { osdp: [] as { id: string; name: string }[], wiegand: [] as { id: string; name: string }[] };
      try { const j = await (await fetch(`${base}/api/osdp/readers`)).json(); if (j.success && j.readers) out.osdp = j.readers.map((r: any) => ({ id: r.id, name: r.name || `Reader ${r.address}` })); } catch { /* none */ }
      try { const j = await (await fetch(`${base}/api/wiegand/config`)).json(); if (j.ok && j.doors) out.wiegand = j.doors.map((d: any) => ({ id: String(d.door), name: d.name || `Wiegand door ${d.door}` })); } catch { /* none */ }
      setReaders(out);
      setCfg(c => (c.readerId || c.readerType === 'none') ? c
        : c.readerType === 'osdp' && out.osdp[0] ? { ...c, readerId: out.osdp[0].id }
        : c.readerType === 'wiegand' && out.wiegand[0] ? { ...c, readerId: out.wiegand[0].id } : c);
    })();
  }, [base]);

  // VMS Stream View snapshot (same shape as before)
  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`${base}/api/vms/elevator-state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carFloor, targetFloor: dir === 'idle' ? null : (carCalls[0] ?? hallCalls[0] ?? null),
          floors: cfg.floors.map(f => ({ id: f.id, name: f.name, access: isAuthorized(f.id), called: carCalls.includes(f.id) || hallCalls.includes(f.id) })),
          trips: stats.trips, granted: stats.granted, denied: stats.denied,
        }),
      }).catch(() => { /* optional */ });
    }, 300);
    return () => clearTimeout(t);
  }, [base, carFloor, dir, carCalls, hallCalls, cfg.floors, stats, isAuthorized]);

  // Demo runs
  const demo = (kind: 'all' | 'round' | 'random' | 'clear') => {
    const s = S.current;
    if (kind === 'clear') { s.carCalls = []; s.hallCalls = []; log(s.carFloor, 'warn', 'All calls cleared'); sync(); return; }
    const floors = kind === 'all' ? cfg.floors.map(f => f.id).filter(f => f !== s.carFloor)
      : kind === 'round' ? [topFloor, 1] : [1 + Math.floor(Math.random() * topFloor)];
    log(s.carFloor, 'info', `Demo: hall calls at ${floors.join(', ')}`);
    floors.forEach(f => hallCall(f));
  };

  // ── Render helpers ───────────────────────────────────────────────────────
  const statusText = stopped ? 'STOPPED'
    : doors === 'open' ? 'DOORS OPEN' : doors === 'opening' ? 'OPENING' : doors === 'closing' ? 'CLOSING'
    : dir !== 'idle' ? (dir === 'up' ? 'GOING UP' : 'GOING DOWN') : 'READY';
  // Gate position target; CSS transitions it over DOOR_MS so opening/closing animate smoothly
  const doorGap = doors === 'open' || doors === 'opening' ? 1 : 0;
  // Row height fills the space beside the car panel: taller rows for fewer floors
  const ROW = Math.max(52, Math.min(80, Math.floor(644 / Math.max(1, topFloor))));
  const floorsDesc = [...cfg.floors].sort((a, b) => b.id - a.id);
  const carW = Math.max(0, Math.min(shaftW - 20, 420));
  const fmt = findFormat(fmts, cfg.format);
  const readerName = cfg.readerType === 'none' ? 'No reader'
    : (cfg.readerType === 'osdp' ? readers.osdp : readers.wiegand).find(r => r.id === cfg.readerId)?.name || (cfg.readerId ? `${cfg.readerType.toUpperCase()} ${cfg.readerId}` : 'Reader not chosen');
  const grantLeft = (f: number) => Math.max(0, Math.ceil(((simGrants[f] || 0) - now) / 1000));

  const inputOn = (f: FloorCfg) => { const k = grantKey(f.grant); return !!(k && inputs[k]); };
  const buttonState = (f: FloorCfg): 'lit' | 'granted' | 'free' | 'locked' =>
    carCalls.includes(f.id) ? 'lit'
    : cfg.grantSource === 'open' ? (inputOn(f) ? 'granted' : 'free')
    : !f.secured ? 'free' : isAuthorized(f.id) ? 'granted' : 'locked';

  // Car panel buttons: two columns, ascending from the bottom like a real COP
  const copRows = useMemo(() => {
    const ids = cfg.floors.map(f => f.id).sort((a, b) => a - b);
    const rows: number[][] = [];
    for (let i = 0; i < ids.length; i += 2) rows.push(ids.slice(i, i + 2));
    return rows.reverse();
  }, [cfg.floors]);

  return (
    <div className="space-y-4" style={{ color: C.text }}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-5 py-3" style={{ background: C.panel, borderColor: C.line2 }}>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold">Elevator</h2>
          <div className="text-xs" style={{ color: C.dim }}>
            {topFloor} floors · {cfg.grantSource === 'open' ? 'open: every floor works, grant inputs light buttons' : cfg.grantSource === 'controller' ? 'secured floors need a controller grant' : 'grants simulated by this page'} · {stats.trips} trips · {stats.granted} granted · {stats.denied} refused
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span style={{ color: C.dim }}>Demo</span>
          {([['all', 'All floors'], ['round', 'Round trip'], ['random', 'Random'], ['clear', 'Clear calls']] as const).map(([k, l]) => (
            <button key={k} onClick={() => demo(k)} className="px-2.5 py-1.5 rounded-md border font-semibold hover:bg-hv-contrast/5" style={{ borderColor: C.line2, color: C.text2 }}>{l}</button>
          ))}
          <button onClick={() => setShowSettings(true)} title="Settings" className="ml-1 w-8 h-8 rounded-md flex items-center justify-center border hover:bg-hv-contrast/5" style={{ borderColor: C.line2, color: C.text2 }}><Settings size={16} /></button>
        </div>
      </div>

      <div className="grid gap-5 grid-cols-1 xl:grid-cols-[500px_minmax(0,1fr)]">
        {/* ── Car operating panel ── */}
        <div className="rounded-2xl border p-5 flex flex-col items-center gap-4"
          style={{ background: 'linear-gradient(180deg,#2A2621 0%,#1D1A16 100%)', borderColor: '#4A433B', color: '#ECE4D8', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)' }}>
          {/* Position indicator */}
          <div className="w-full rounded-lg px-4 py-3 flex items-center justify-between" style={{ background: '#0B0907', border: '1px solid #000', boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)' }}>
            <div className="flex flex-col items-center w-8">
              <ChevronUp size={22} style={{ color: dir === 'up' ? C.amberHi : '#2A2118', filter: dir === 'up' ? `drop-shadow(0 0 6px ${C.amber})` : 'none' }} />
              <ChevronDown size={22} style={{ color: dir === 'down' ? C.amberHi : '#2A2118', filter: dir === 'down' ? `drop-shadow(0 0 6px ${C.amber})` : 'none' }} />
            </div>
            <div className="font-mono font-bold text-6xl tabular-nums" style={{ color: stopped ? C.crit : C.amberHi, textShadow: `0 0 14px color-mix(in srgb, ${stopped ? C.crit : C.amber} 67%, transparent)` }}>{carFloor}</div>
            <div className="w-24 text-right font-mono text-[11px] font-bold leading-tight" style={{ color: stopped ? C.crit : C.amber }}>{statusText}</div>
          </div>

          {/* Card reader */}
          <button onClick={() => presentCard(false)} disabled={reader === 'busy' || stopped}
            className="w-full rounded-xl border px-4 py-3 flex items-center gap-3 transition-all disabled:opacity-50 group"
            style={{ background: '#151210', borderColor: reader === 'ok' ? C.good : reader === 'deny' ? C.crit : '#3A332C' }}
            title="Present the configured card at the car reader">
            <span className="w-3 h-3 rounded-full shrink-0" style={{
              background: reader === 'ok' ? C.good : reader === 'deny' ? C.crit : reader === 'busy' ? C.amber : '#3A3129',
              boxShadow: reader === 'idle' ? 'none' : `0 0 10px ${reader === 'ok' ? C.good : reader === 'deny' ? C.crit : C.amber}` }} />
            <CreditCard size={22} style={{ color: '#ADA294' }} />
            <div className="min-w-0 flex-1 text-left">
              <div className="text-sm font-bold">{reader === 'busy' ? 'Reading…' : reader === 'ok' ? 'Card sent' : reader === 'deny' ? 'Card not sent' : 'Present card'}</div>
              <div className="text-[11px] truncate" style={{ color: '#786D60' }}>{readerName} · FC {cfg.facility} · #{cfg.card}</div>
            </div>
            <span onClick={(e) => { e.stopPropagation(); presentCard(true); }} title="Present a random card" className="p-1.5 rounded hover:bg-hv-contrast/10" style={{ color: '#786D60' }}><Shuffle size={14} /></span>
          </button>

          {/* Floor buttons */}
          <div className="flex flex-col gap-3 py-1">
            {copRows.map((row, i) => (
              <div key={i} className="flex gap-8 justify-center">
                {row.map(id => {
                  const f = floorsById[id]; if (!f) return null;
                  const st = buttonState(f);
                  const refused = flash === id;
                  const left = cfg.grantSource === 'simulated' && st === 'granted' ? grantLeft(id) : 0;
                  return (
                    <button key={id} onClick={() => pressFloor(id)} title={`${id} · ${f.name}${f.secured ? (st === 'locked' ? ' · secured, needs a card' : ' · granted') : ' · free access'}`}
                      className={`relative w-[76px] h-[76px] rounded-full flex items-center justify-center font-bold text-2xl transition-all ${refused ? 'animate-pulse' : ''}`}
                      style={{
                        background: st === 'lit' ? 'radial-gradient(circle at 50% 40%, #FFD58C, #F0A73C 70%)' : 'radial-gradient(circle at 50% 35%, #3B352F, #221E1A 75%)',
                        color: st === 'lit' ? '#2A1A05' : st === 'locked' ? '#6E6459' : '#ECE4D8',
                        border: `3px solid ${refused ? C.crit : st === 'lit' ? '#FFE0A6' : st === 'granted' ? C.teal : st === 'free' ? '#5A5249' : '#3A332C'}`,
                        boxShadow: refused ? `0 0 16px ${C.crit}` : st === 'lit' ? `0 0 18px ${C.amber}aa` : st === 'granted' ? `0 0 14px ${C.teal}88` : 'inset 0 -2px 4px rgba(0,0,0,0.5)',
                      }}>
                      {id}
                      {st === 'locked' && <Lock size={11} className="absolute bottom-2" style={{ color: '#6E6459' }} />}
                      {left > 0 && <span className="absolute -top-1 -right-1 text-[10px] px-1 rounded-full font-bold" style={{ background: 'rgb(var(--hv-info-tint))', color: 'rgb(var(--hv-info-fg))', boxShadow: 'inset 0 0 0 1px rgb(var(--hv-info) / 0.4)' }}>{left}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Door + alarm buttons */}
          <div className="flex gap-3 w-full">
            <button onClick={() => openDoors('Door open button')} disabled={stopped || dir !== 'idle'} title="Door open"
              className="flex-1 h-11 rounded-lg border font-bold text-sm disabled:opacity-40" style={{ background: '#221E1A', borderColor: '#4A433B' }}>◀ ▶</button>
            <button onClick={closeDoors} disabled={doors !== 'open'} title="Door close"
              className="flex-1 h-11 rounded-lg border font-bold text-sm disabled:opacity-40" style={{ background: '#221E1A', borderColor: '#4A433B' }}>▶ ◀</button>
            {stopped
              ? <button onClick={resume} title="Resume normal service" className="flex-1 h-11 rounded-lg font-bold text-sm flex items-center justify-center gap-1.5" style={{ background: '#2F4A36', border: `1px solid ${C.good}`, color: '#DDF5E2' }}><Play size={15} />Resume</button>
              : <button onClick={emergencyStop} title="Emergency stop" className="flex-1 h-11 rounded-lg font-bold text-sm flex items-center justify-center gap-1.5" style={{ background: '#5A231C', border: `1px solid ${C.crit}`, color: '#FFD9D2' }}><Bell size={15} />Stop</button>}
          </div>

          {/* Legend */}
          <div className="w-full grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]" style={{ color: '#786D60' }}>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ border: `2px solid ${C.teal}` }} />granted, press to go</span>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: C.amber }} />selected</span>
            {cfg.grantSource !== 'open' && <span className="flex items-center gap-1.5"><Lock size={10} />secured, needs a card</span>}
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ border: '2px solid #5A5249' }} />{cfg.grantSource === 'open' ? 'press to go' : 'free access'}</span>
          </div>
        </div>

        {/* ── Hoistway ──
            Columns: floor + name · shaft · TRK · ACU · hall call. The shaft is one
            cell spanning every floor, so the car always lines up with it. */}
        <div className="rounded-2xl border overflow-hidden" style={{ background: C.panel, borderColor: C.line2 }}>
          <div className="grid text-[10px] font-bold tracking-wider px-5 py-2 border-b" style={{ gridTemplateColumns: HOIST_COLS, columnGap: 24, color: C.dim, borderColor: C.line }}>
            <span>FLOOR</span><span className="text-center">SHAFT</span><span className="text-center">TRACKING</span><span className="text-center">ACU GRANT</span><span className="text-center">CALL</span>
          </div>
          <div className="relative">
            {/* row stripes */}
            {floorsDesc.map((f, i) => (
              <div key={f.id} className="absolute left-0 right-0 border-b" style={{ top: i * ROW, height: ROW, borderColor: C.line, background: carFloor === f.id && dir === 'idle' ? 'rgb(var(--hv-brand) / 0.07)' : 'transparent' }} />
            ))}
            <div className="relative grid px-5" style={{ gridTemplateColumns: HOIST_COLS, gridTemplateRows: `repeat(${floorsDesc.length}, ${ROW}px)`, columnGap: 24 }}>
              {/* shaft: one cell for all floors */}
              <div ref={shaftRef} className="relative border-x" style={{ gridColumn: 2, gridRow: `1 / span ${floorsDesc.length}`, borderColor: '#3A332C',
                background: 'linear-gradient(90deg, transparent 2px, #3A342D 2px 5px, transparent 5px calc(100% - 5px), #3A342D calc(100% - 5px) calc(100% - 2px), transparent calc(100% - 2px)), rgba(0,0,0,0.3)' }}>
                <div className="absolute pointer-events-none" style={{
                  left: 'calc(50% - 1px)', width: 2, top: 0,
                  height: (topFloor - carPos) * ROW + 5, transition: 'height 90ms linear',
                  background: 'repeating-linear-gradient(180deg,#6B6259 0 3px,#4A433B 3px 5px)',
                }} />
                {carW > 40 && (
                  <div className="absolute pointer-events-none" style={{
                    left: (shaftW - carW) / 2, width: carW, height: ROW - 10,
                    top: (topFloor - carPos) * ROW + 5, transition: 'top 90ms linear',
                    filter: `drop-shadow(0 0 10px color-mix(in srgb, ${stopped ? C.crit : C.amber} 33%, transparent))`,
                  }}>
                    <CarCab w={carW} h={ROW - 10} gap={doorGap} stopped={stopped} moving={dir !== 'idle'} />
                  </div>
                )}
              </div>

              {floorsDesc.map((f, i) => {
                const here = carFloor === f.id && dir === 'idle';
                const trk = !!tracking[f.id];
                const acu = cfg.grantSource === 'simulated' ? (simGrants[f.id] || 0) > now : inputOn(f);
                const hc = hallCalls.includes(f.id);
                const cc = carCalls.includes(f.id);
                const row = i + 1;
                return (
                  <React.Fragment key={f.id}>
                    <div className="flex items-center gap-3 min-w-0" style={{ gridColumn: 1, gridRow: row }}>
                      <span className="w-7 text-right font-mono font-bold text-lg shrink-0" style={{ color: here ? C.amberHi : C.text2 }}>{f.id}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate" title={f.name}>{f.name}</div>
                        <div className="text-[10px] truncate" style={{ color: C.dim }}>
                          {cfg.grantSource === 'open' ? 'open' : f.secured ? 'secured' : 'free access'}{cc ? ' · selected in car' : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-center justify-center gap-0.5" style={{ gridColumn: 3, gridRow: row }}>
                      <Sig on={trk} color={C.good} label={f.track?.kind === 'emu' ? `TRK #${f.track.address} ${f.track.channel + 1}` : assigned(f.track) ? trackLabel(f.track) : 'TRK'} title={`Tracking ${trackLabel(f.track)} → controller: ${trk ? 'ON, car is here' : 'off'}`} />
                      {/* AETHER_ELEV_BUTTON_OUT: button / hall-call outputs, lit while pulsing */}
                      {(assigned(f.button) || assigned(f.hall)) && (
                        <span className="flex gap-2 text-[9px] font-mono font-bold leading-none whitespace-nowrap">
                          {([['button', 'BTN'], ['hall', 'HC']] as const).filter(([r]) => assigned(f[r])).map(([r, l]) => (
                            <span key={r} title={`${r === 'button' ? 'Car button' : 'Hall call'} output ${trackLabel(f[r])}: pulses on every press`}
                              style={{ color: pulsing[`${f.id}:${r}`] ? C.amberHi : C.dim, textShadow: pulsing[`${f.id}:${r}`] ? `0 0 6px ${C.amber}` : 'none' }}>{l} {f[r].kind === 'emu' ? `#${f[r].address} ${f[r].channel + 1}` : trackLabel(f[r])}</span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-center" style={{ gridColumn: 4, gridRow: row }}>
                      <Sig on={acu} color={C.teal} label={f.grant?.kind === 'emu' ? `ACU #${f.grant.address} ${f.grant.channel + 1}` : assigned(f.grant) ? grantLabel(f.grant) : 'ACU'} title={`Grant ${cfg.grantSource === 'simulated' ? '(simulated)' : `input ${grantLabel(f.grant)} from the controller`}: ${acu ? 'on' : 'off'}`} />
                    </div>
                    <div className="flex items-center justify-center" style={{ gridColumn: 5, gridRow: row }}>
                      <button onClick={() => hallCall(f.id)} disabled={stopped} title={`Call the car to floor ${f.id}`}
                        className="w-12 h-12 rounded-full border-2 flex items-center justify-center disabled:opacity-40"
                        style={{ borderColor: hc ? C.amberHi : 'rgb(var(--hv-modal))', background: hc ? `color-mix(in srgb, ${C.amber} 20%, transparent)` : 'rgb(var(--hv-widget-panel))', boxShadow: hc ? `0 0 10px color-mix(in srgb, ${C.amber} 53%, transparent)` : 'none' }}>
                        <span className="block w-4 h-4 rounded-full" style={{ background: hc ? C.amberHi : 'rgb(var(--hv-modal))' }} />
                      </button>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Log */}
      <div className="rounded-xl border" style={{ background: C.panel, borderColor: C.line2 }}>
        <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: C.line }}>
          <span className="text-sm font-bold">Activity</span>
          <div className="flex gap-1">
            <button title="Download log" onClick={() => {
              const txt = [...logs].reverse().map(l => `${l.t.toLocaleString()}  F${l.floor}  ${l.kind.toUpperCase()}  ${l.msg}`).join('\n');
              const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = `elevator-log-${Date.now()}.txt`; a.click();
            }} className="w-7 h-7 rounded flex items-center justify-center hover:bg-hv-contrast/5" style={{ color: C.text2 }}><Download size={14} /></button>
            <button title="Clear log" onClick={() => setLogs([])} className="w-7 h-7 rounded flex items-center justify-center hover:bg-hv-contrast/5" style={{ color: C.text2 }}><Trash2 size={14} /></button>
          </div>
        </div>
        <div className="h-[170px] overflow-y-auto px-4 py-2 font-mono text-[11px] space-y-0.5">
          {logs.length === 0 ? <div className="py-6 text-center" style={{ color: C.dim }}>No activity yet. Present a card, then press a floor.</div>
            : logs.map(l => (
              <div key={l.id} className="flex gap-3">
                <span style={{ color: C.dim }}>{l.t.toLocaleTimeString()}</span>
                <span className="w-6" style={{ color: C.text2 }}>F{l.floor}</span>
                <span style={{ color: l.kind === 'ok' ? 'rgb(var(--hv-success-text))' : l.kind === 'err' ? 'rgb(var(--hv-error-text))' : l.kind === 'warn' ? C.warn : C.text2 }}>{l.msg}</span>
              </div>
            ))}
        </div>
      </div>

      {showSettings && <SettingsModal cfg={cfg} setCfg={setCfg} readers={readers} formats={fmts} base={base} boards={emuBoards} onReset={() => { allTrackingOff(); releasePulses(); /* AETHER_ELEV_BUTTON_OUT */ }} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function Sig({ on, color, label, title }: { on: boolean; color: string; label: string; title: string }) {
  return (
    <span title={title} className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold font-mono whitespace-nowrap min-w-[96px] justify-center"
      style={{ background: on ? `color-mix(in srgb, ${color} 15%, transparent)` : 'rgba(0,0,0,0.25)', color: on ? color : 'rgb(var(--hv-text-3))', border: `1px solid ${on ? `color-mix(in srgb, ${color} 40%, transparent)` : 'rgb(var(--hv-popup-panel))'}` }}>
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: on ? color : 'rgb(var(--hv-line))', boxShadow: on ? `0 0 8px ${color}` : 'none' }} />{label}
    </span>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────
// AETHER_ELEV_MODAL_REMOUNT (Update 66): these two wrappers used to be defined inside
// SettingsModal. The page re-renders every 80 ms for the car animation, and a component
// defined inside another is a new component on every render, so React rebuilt every
// dropdown and input in the window 12 times a second: an open dropdown closed before you
// could pick from it and a field lost focus while typing. At module level they stay put.
const H = ({ children }: { children: React.ReactNode }) => <h3 className="text-xs font-bold tracking-wider mb-2" style={{ color: 'rgb(var(--hv-text-3))' }}>{children}</h3>;
const L = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="block"><span className="block text-[11px] mb-1" style={{ color: 'rgb(var(--hv-text-2))' }}>{label}</span>{children}</label>;

function SettingsModal({ cfg, setCfg, readers, formats, base, boards, onReset, onClose }: {
  cfg: ElevatorCfg; setCfg: React.Dispatch<React.SetStateAction<ElevatorCfg>>;
  readers: { osdp: { id: string; name: string }[]; wiegand: { id: string; name: string }[] }; formats: ElevFormat[];
  base: string; boards: EmuBoardInfo[]; onReset: () => void; onClose: () => void;
}) {
  const up = (p: Partial<ElevatorCfg>) => setCfg(c => ({ ...c, ...p }));
  const upFloor = (id: number, p: Partial<FloorCfg>) => setCfg(c => ({ ...c, floors: c.floors.map(f => f.id === id ? { ...f, ...p } : f) }));
  const inp = 'rounded-md px-2 py-1.5 text-sm border w-full';
  const st = { background: 'rgb(var(--hv-surface))', borderColor: 'rgb(var(--hv-line))', color: 'rgb(var(--hv-text))' };
  const fmt = findFormat(formats, cfg.format);
  const list = cfg.readerType === 'osdp' ? readers.osdp : readers.wiegand;
  // AETHER_ELEV_SHARED: door outputs, for "also used by" notes (never blocks saving)
  const [doorUsers, setDoorUsers] = useState<DoorOutputUser[]>([]);
  useEffect(() => { loadSavedDoors(base).then(d => setDoorUsers(collectDoorOutputUsers(d))).catch(() => setDoorUsers([])); }, [base]);
  const shared = useMemo(() => outputShareNotes(cfg.floors, doorUsers), [cfg.floors, doorUsers]);   // AETHER_ELEV_BUTTON_OUT: all output roles
  const [autoNote, setAutoNote] = useState('');
  const inBoards = boards.filter(b => b.numInputs > 0), outBoards = boards.filter(b => b.numOutputs > 0);
  const anyAnalog = cfg.floors.some(f => f.grant?.kind === 'analog');
  // Changing kind keeps the channel when it fits, else 0; an emulated pick defaults to the first board.
  // AETHER_ELEV_BUTTON_OUT: shared by tracking, button and hall-call outputs (role)
  const setOutKind = (f: FloorCfg, role: OutRole, kind: TrackKind) => {
    const cur = f[role] || NO_TRACK;
    const max = kind === 'emu' ? Infinity : kind === 'none' ? 1 : DOOR_OUTPUT_CHANNELS[kind];
    const t: TrackCfg = { kind, channel: cur.channel < max ? cur.channel : 0 };
    if (kind === 'emu') t.address = cur.address ?? (inBoards.find(b => b.online) || inBoards[0])?.address;
    if (kind === 'dac') t.restVolts = cur.restVolts ?? DEFAULT_REST_VOLTS;
    upFloor(f.id, { [role]: t });
  };
  // One output picker: kind, then channel (or board + input), rest V for a DAC, shared-use note
  const outPick = (f: FloorCfg, role: OutRole, label: string) => {
    const t = f[role] || NO_TRACK, set = (n: TrackCfg) => upFloor(f.id, { [role]: n });
    const note = shared[`${f.id}:${role}`];
    return (<>
      <span className="w-12" style={{ color: 'rgb(var(--hv-text-2))' }}>{label}</span>
      <div className="w-28"><select className={inp} style={st} value={t.kind} onChange={e => setOutKind(f, role, e.target.value as TrackKind)}>
        <option value="none">none</option><option value="relay">Relay</option><option value="od">Open drain</option><option value="dac">Analog (DAC)</option><option value="emu">Emulated board</option>
      </select></div>
      {t.kind === 'emu' ? emuPick(t.address, t.channel, inBoards, 'Input', (address, channel) => set({ ...t, address, channel }))
        : t.kind !== 'none' && <div className="w-24"><select className={inp} style={st} value={t.channel} onChange={e => set({ ...t, channel: parseInt(e.target.value) })}>
          {Array.from({ length: DOOR_OUTPUT_CHANNELS[t.kind] }, (_, i) => <option key={i} value={i}>{doorOutputChannelLabel(t.kind as 'relay' | 'od' | 'dac', i)}</option>)}
        </select></div>}
      {t.kind === 'dac' && <div className="w-20" title="Rest (OFF) voltage, 0.5-10 V"><input type="number" step={0.5} min={0.5} max={10} className={inp} style={st}
        value={t.restVolts ?? DEFAULT_REST_VOLTS}
        onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) set({ ...t, restVolts: v }); }}
        onBlur={() => set({ ...t, restVolts: clampRestVolts(t.restVolts) })} /></div>}
      {t.kind === 'dac' && <span style={{ color: 'rgb(var(--hv-text-3))' }}>V rest</span>}
      {/* AETHER_ELEV_SHARED: a note, never a block */}
      {note && <span style={{ color: 'rgb(var(--hv-warning-text))' }}>also {note.join(', ')}</span>}
    </>);
  };
  const setGrantKind = (f: FloorCfg, kind: GrantKind) => {
    const g: GrantCfg = { kind, channel: kind === 'emu' || f.grant.channel < 8 ? f.grant.channel : 0 };
    if (kind === 'emu') g.address = f.grant.address ?? (outBoards.find(b => b.online) || outBoards[0])?.address;
    upFloor(f.id, { grant: g });
  };
  // Board picker + index picker for an emulated input (tracking) or output (grant)
  const emuPick = (address: number | undefined, channel: number, list: EmuBoardInfo[], what: 'Input' | 'Output', set: (address: number, channel: number) => void) => {
    const b = list.find(x => x.address === address);
    const n = Math.max(b ? (what === 'Input' ? b.numInputs : b.numOutputs) : 0, channel + 1);
    return (<>
      <div className="w-28"><select className={inp} style={st} value={address ?? ''} onChange={e => set(parseInt(e.target.value), 0)}>
        {address == null && <option value="">{list.length ? 'Board…' : 'No boards'}</option>}
        {address != null && !b && <option value={address}>#{address} (not running)</option>}
        {list.map(x => <option key={x.address} value={x.address}>#{x.address} {x.model}{x.online ? '' : ' (offline)'}</option>)}
      </select></div>
      <div className="w-24"><select className={inp} style={st} value={channel} disabled={address == null} onChange={e => set(address as number, parseInt(e.target.value))}>
        {Array.from({ length: n }, (_, i) => <option key={i} value={i}>{what} {i + 1}</option>)}
      </select></div>
    </>);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border p-6 space-y-6" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))', color: 'rgb(var(--hv-text))' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Elevator settings</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-hv-contrast/5"><X size={18} /></button>
        </div>

        <section>
          <H>CAR READER AND CARD</H>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            <L label="Reader type">
              <select className={inp} style={st} value={cfg.readerType} onChange={e => up({ readerType: e.target.value as any, readerId: '' })}>
                <option value="osdp">OSDP</option><option value="wiegand">Wiegand</option><option value="none">None</option>
              </select>
            </L>
            <div className="sm:col-span-2"><L label="Reader">
              <select className={inp} style={st} value={cfg.readerId} disabled={cfg.readerType === 'none'} onChange={e => up({ readerId: e.target.value })}>
                <option value="">{list.length ? 'Choose…' : 'None found'}</option>
                {list.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </L></div>
            <L label="Format">
              <select className={inp} style={st} value={fmt.id} onChange={e => up({ format: e.target.value })}>
                {formats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </L>
            <div className="grid grid-cols-2 gap-2 col-span-2">
              <L label="FC"><input type="number" className={inp} style={st} min={0} max={fmt.fc} value={cfg.facility} onChange={e => up({ facility: Math.max(0, Math.min(fmt.fc, parseInt(e.target.value) || 0)) })} /></L>
              <L label="Card"><input type="number" className={inp} style={st} min={1} max={fmt.card} value={cfg.card} onChange={e => up({ card: Math.max(1, Math.min(fmt.card, parseInt(e.target.value) || 1)) })} /></L>
            </div>
          </div>
        </section>

        <section>
          <H>WHO GRANTS FLOORS</H>
          <div className="flex flex-wrap gap-2 mb-3">
            {([['open', 'Open (no controller)'], ['controller', 'Access controller'], ['simulated', 'Simulated grants']] as const).map(([k, l]) => (
              <button key={k} onClick={() => up({ grantSource: k })} className="px-3 py-1.5 rounded-md text-sm font-semibold border"
                style={cfg.grantSource === k ? { background: 'rgb(var(--hv-success-tint-strong))', borderColor: 'rgb(var(--hv-success))', color: 'rgb(var(--hv-success-text))' } : { borderColor: 'rgb(var(--hv-line))', color: 'rgb(var(--hv-text-2))' }}>{l}</button>
            ))}
          </div>
          {cfg.grantSource !== 'simulated' ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
              {anyAnalog && <L label="Analog grant active at (V)"><input type="number" step={0.1} min={0} max={10} className={inp} style={st} value={cfg.analogThreshold} onChange={e => up({ analogThreshold: parseFloat(e.target.value) || 2.5 })} /></L>}
              <p className="col-span-2 text-[11px]" style={{ color: 'rgb(var(--hv-text-3))' }}>
                {cfg.grantSource === 'open'
                  ? 'Every floor button works. If the controller turns a floor\u2019s grant input on, that button lights up (nothing is locked).'
                  : 'Secured floors stay locked until the controller turns their grant input on.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <L label="Grant lasts (s)"><input type="number" min={3} max={120} className={inp} style={st} value={cfg.grantWindow} onChange={e => up({ grantWindow: Math.max(3, parseInt(e.target.value) || 10) })} /></L>
              </div>
              <div className="text-[11px]" style={{ color: 'rgb(var(--hv-text-2))' }}>The card grants these floors:</div>
              <div className="flex flex-wrap gap-1.5">
                {cfg.floors.map(f => {
                  const on = cfg.cardFloors.includes(f.id);
                  return <button key={f.id} onClick={() => up({ cardFloors: on ? cfg.cardFloors.filter(x => x !== f.id) : [...cfg.cardFloors, f.id].sort((a, b) => a - b) })}
                    className="w-9 h-9 rounded-full text-sm font-bold border" style={on ? { borderColor: 'rgb(var(--hv-info))', color: 'rgb(var(--hv-success-text))', background: 'rgb(var(--hv-info) / 0.2)' } : { borderColor: 'rgb(var(--hv-line))', color: 'rgb(var(--hv-text-3))' }}>{f.id}</button>;
                })}
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <H>FLOORS AND WIRING</H>
            <div className="flex gap-1.5 -mt-2">
              {([['Auto-assign tracking', () => setCfg(c => ({ ...c, floors: autoAssignTracking(c.floors, boards) }))],
                 ['Auto-assign grants', () => setCfg(c => ({ ...c, floors: autoAssignGrants(c.floors, boards) }))],
                 // AETHER_ELEV_BUTTON_OUT: emulated board inputs only; never takes relays / O.D. / DAC
                 ['Auto-assign buttons', () => { const r = autoAssignButtons(cfg.floors, boards); setAutoNote(r.note); setCfg(c => ({ ...c, floors: r.floors })); }]] as const).map(([l, fn]) => (
                <button key={l} onClick={fn} className="px-2.5 py-1 rounded-md border text-xs font-semibold hover:bg-hv-contrast/5" style={{ borderColor: 'rgb(var(--hv-line))', color: 'rgb(var(--hv-text-2))' }}>{l}</button>
              ))}
            </div>
          </div>
          {autoNote && <p className="text-[11px] mb-2" style={{ color: 'rgb(var(--hv-text-2))' }}>{autoNote}</p>}
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'rgb(var(--hv-popup-panel))' }}>
            <div className="grid grid-cols-[40px_minmax(0,1fr)_70px] gap-2 px-3 py-2 text-[10px] font-bold tracking-wider" style={{ color: 'rgb(var(--hv-text-3))', background: 'rgb(var(--hv-surface) / 0.25)' }}>
              <span>FL</span><span>NAME · TRACKING · GRANT · BUTTON · HALL CALL</span><span>SECURED</span>
            </div>
            {[...cfg.floors].sort((a, b) => b.id - a.id).map(f => {
              const t = f.track || { kind: 'none', channel: 0 }, g = f.grant || { kind: 'none', channel: 0 };
              return (
              <div key={f.id} className="px-3 py-1.5 border-t space-y-1.5" style={{ borderColor: 'rgb(var(--hv-popup-panel))' }}>
                <div className="grid grid-cols-[40px_minmax(0,1fr)_70px] gap-2 items-center">
                  <span className="font-mono font-bold">{f.id}</span>
                  <input className={inp} style={st} value={f.name} onChange={e => upFloor(f.id, { name: e.target.value })} />
                  <button onClick={() => upFloor(f.id, { secured: !f.secured })} className="relative w-10 h-5 rounded-full" style={{ background: f.secured ? 'rgb(var(--hv-success-strong))' : 'rgb(var(--hv-line))' }}>
                    <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: f.secured ? 22 : 2 }} />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-12 text-[11px]">
                  {/* AETHER_ELEV_TRACK */}
                  {outPick(f, 'track', 'Tracking')}
                </div>
                {/* AETHER_ELEV_BUTTON_OUT: car button + hall-call outputs, pulsed on every press */}
                <div className="flex flex-wrap items-center gap-2 pl-12 text-[11px]">{outPick(f, 'button', 'Button')}</div>
                <div className="flex flex-wrap items-center gap-2 pl-12 text-[11px]">{outPick(f, 'hall', 'Hall call')}</div>
                {[t, f.button, f.hall].some(o => o?.kind === 'dac') && <div className="pl-12 text-[10px]" style={{ color: 'rgb(var(--hv-text-3))' }}>Analog: 0 V = on, rest voltage = off. Set rest to the panel input's open voltage.</div>}
                <div className="flex flex-wrap items-center gap-2 pl-12 text-[11px]">
                  {/* AETHER_ELEV_GRANT */}
                  <span className="w-12" style={{ color: 'rgb(var(--hv-text-2))' }}>Grant</span>
                  <div className="w-28"><select className={inp} style={st} value={g.kind} onChange={e => setGrantKind(f, e.target.value as GrantKind)}>
                    <option value="none">none</option><option value="opto">Opto input</option><option value="analog">EOL zone (analog)</option><option value="emu">Emulated board</option>
                  </select></div>
                  {g.kind === 'emu' ? emuPick(g.address, g.channel, outBoards, 'Output', (address, channel) => upFloor(f.id, { grant: { ...g, address, channel } }))
                    : g.kind !== 'none' && <div className="w-24"><select className={inp} style={st} value={g.channel} onChange={e => upFloor(f.id, { grant: { ...g, channel: parseInt(e.target.value) } })}>
                      {Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{g.kind === 'analog' ? 'ADC' : 'OPTO'} {i + 1}</option>)}
                    </select></div>}
                </div>
              </div>
              );
            })}
          </div>
          <p className="text-[11px] mt-2" style={{ color: 'rgb(var(--hv-text-3))' }}>Tracking output: on while the car is at that floor (tells the controller where the car is). Grant input: the controller turns it on to allow that floor. Button / hall call: pulsed on every press so the controller sees which floor was selected. Terminals may be shared with doors or other floors.</p>
        </section>

        <section>
          <H>MOTION AND DOORS</H>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <L label={`Speed: ${cfg.speed} floor/s`}><input type="range" min={0.5} max={3} step={0.5} value={cfg.speed} onChange={e => up({ speed: parseFloat(e.target.value) })} className="w-full" /></L>
            <L label={`Doors stay open: ${cfg.doorHold}s`}><input type="range" min={3} max={30} step={1} value={cfg.doorHold} onChange={e => up({ doorHold: parseInt(e.target.value) })} className="w-full" /></L>
            <L label={cfg.autoReturn ? `Return to lobby after ${cfg.autoReturn}s idle` : 'Return to lobby: off'}><input type="range" min={0} max={120} step={5} value={cfg.autoReturn} onChange={e => up({ autoReturn: parseInt(e.target.value) })} className="w-full" /></L>
            {/* AETHER_ELEV_BUTTON_OUT */}
            <L label="Button pulse (ms)"><input type="number" min={100} max={5000} step={50} className={inp} style={st} value={cfg.buttonPulseMs ?? DEFAULT_PULSE_MS}
              onChange={e => { const v = parseInt(e.target.value); if (Number.isFinite(v)) up({ buttonPulseMs: v }); }}
              onBlur={() => up({ buttonPulseMs: clampPulseMs(cfg.buttonPulseMs) })} /></L>
          </div>
        </section>

        <div className="flex justify-between items-center">
          <button onClick={() => { if (confirm('Reset all elevator settings to defaults?')) { onReset(); setCfg(defaultCfg()); } }} className="text-xs underline" style={{ color: 'rgb(var(--hv-text-3))' }}>Reset to defaults</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg font-semibold" style={{ background: 'rgb(var(--hv-success-tint-strong))', border: '1px solid rgb(var(--hv-success))', color: 'rgb(var(--hv-success-text))' }}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default ElevatorSection;

// Car drawn as an old cage elevator: lit wood-panelled cab, brass frame and a
// bi-parting brass scissor gate that folds to both sides. The gate halves are
// scaled horizontally, which compresses the lattice like a real folding gate;
// strokes don't scale, so the bars stay crisp.
function CarCab({ w, h, gap, stopped, moving }: { w: number; h: number; gap: number; stopped: boolean; moving: boolean }) {
  const half = w / 2;
  const pitch = 9;                                   // bar spacing when closed
  const bars = Math.floor((half - 4) / pitch);
  const top = 5, bot = h - 5;                        // gate span (inside header and sill)
  const mid = (top + bot) / 2;
  const fold = 1 - gap * 0.86;                       // folded gate keeps ~14% of its width
  const ease = `transform ${DOOR_MS}ms cubic-bezier(.45,.05,.35,1)`;
  const frame = stopped ? C.crit : 'rgb(var(--hv-brand))';
  const lattice = (dir: 1 | -1) => {
    const x0 = dir === 1 ? 3 : w - 3;
    const els: React.ReactNode[] = [];
    for (let i = 0; i <= bars; i++) {
      const x = x0 + dir * i * pitch;
      els.push(<line key={`v${i}`} x1={x} x2={x} y1={top} y2={bot} stroke="#E2BE6E" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />);
      if (i < bars) {
        const xn = x + dir * pitch;
        els.push(
          <path key={`x${i}`} d={`M${x},${top} L${xn},${mid} L${x},${bot} M${xn},${top} L${x},${mid} L${xn},${bot}`}
            fill="none" stroke="#B48C45" strokeWidth={1} vectorEffect="non-scaling-stroke" />);
      }
    }
    const edge = x0 + dir * bars * pitch;             // leading stile with handle
    els.push(<rect key="stile" x={Math.min(edge, edge + dir * 3) - 0} y={top} width={3} height={bot - top} fill="#E9C87A" />);
    els.push(<rect key="handle" x={edge + (dir === 1 ? -4 : 1)} y={mid - 4} width={3} height={8} rx={1} fill="#8A6A2E" />);
    return els;
  };
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="cab-wall" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#8A5E36" /><stop offset="1" stopColor="#5B3B20" />
        </linearGradient>
        <linearGradient id="cab-light" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#FFE9B8" stopOpacity=".55" /><stop offset=".6" stopColor="#FFE9B8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cab-header" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#4A4038" /><stop offset="1" stopColor="#2A241F" />
        </linearGradient>
      </defs>
      {/* cab interior */}
      <rect x={1} y={1} width={w - 2} height={h - 2} rx={3} fill="url(#cab-wall)" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} x={8 + i * ((w - 16) / 7)} y={9} width={(w - 16) / 7 - 4} height={h - 20} rx={1.5}
          fill="none" stroke="#3F2814" strokeOpacity=".7" />
      ))}
      <rect x={1} y={1} width={w - 2} height={h - 2} rx={3} fill="url(#cab-light)" />
      {/* ceiling lamp and handrail */}
      <rect x={half - 26} y={5} width={52} height={3} rx={1.5} fill="#FFF3D6" opacity={moving ? 0.8 : 1} />
      <rect x={10} y={h - 16} width={w - 20} height={2} rx={1} fill="#D9B566" opacity=".9" />
      {/* gate halves */}
      <g style={{ transform: `scaleX(${fold})`, transformOrigin: '0px 0px', transition: ease }}>{lattice(1)}</g>
      <g style={{ transform: `scaleX(${fold})`, transformOrigin: `${w}px 0px`, transition: ease }}>{lattice(-1)}</g>
      {/* header with rivets, and the sill */}
      <rect x={0} y={0} width={w} height={5} rx={2} fill="url(#cab-header)" />
      {Array.from({ length: 9 }, (_, i) => <circle key={i} cx={12 + i * ((w - 24) / 8)} cy={2.5} r={0.9} fill="#8C7B63" />)}
      <rect x={0} y={h - 4} width={w} height={4} rx={1} fill="#9AA3AB" />
      <rect x={0} y={h - 4} width={w} height={1} fill="#C9D0D6" />
      {/* frame */}
      <rect x={0.75} y={0.75} width={w - 1.5} height={h - 1.5} rx={3} fill="none" stroke={frame} strokeWidth={1.5} />
    </svg>
  );
}
