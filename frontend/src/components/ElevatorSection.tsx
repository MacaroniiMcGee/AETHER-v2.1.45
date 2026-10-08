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
//  4. When the car reaches a floor, that floor's tracking relay turns ON so the
//     ACU knows where the car is; it turns OFF when the car leaves.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings, Bell, CreditCard, ChevronUp, ChevronDown, Lock, Download, Trash2, X, Play, Shuffle } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────
interface FloorCfg {
  id: number;            // floor number (1 = bottom)
  name: string;
  secured: boolean;      // needs an ACU grant before its car button works
  relay: number;         // tracking relay 1-8 (0 = none)
  input: number;         // ACU grant input 1-8 (0 = none)
}

interface ElevatorCfg {
  floors: FloorCfg[];
  grantSource: 'open' | 'controller' | 'simulated';
  version?: number;
  inputType: 'opto' | 'analog';
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

const FORMATS = [
  { id: 'wiegand26', name: '26-bit H10301', bits: 26, fc: 255, card: 65535 },
  { id: 'wiegand34', name: '34-bit H10302', bits: 34, fc: 65535, card: 65535 },
  { id: 'wiegand37', name: '37-bit H10302', bits: 37, fc: 65535, card: 524287 },
  { id: 'wiegand48', name: '48-bit HID', bits: 48, fc: 65535, card: 999999999 },
  { id: 'wiegand64', name: '64-bit SEOS', bits: 64, fc: 999999999, card: 999999999 },
];

const DEFAULT_NAMES = ['Main Lobby', 'Meeting Rooms', 'Co-Working', 'Office Suites', 'IT & Operations', 'Conference Center', 'Executive Offices', 'Penthouse'];
const defaultCfg = (): ElevatorCfg => ({
  floors: DEFAULT_NAMES.map((name, i) => ({ id: i + 1, name, secured: i !== 0, relay: i + 1, input: i + 1 })),
  grantSource: 'open',
  version: 2,
  inputType: 'opto',
  analogThreshold: 2.5,
  grantWindow: 10,
  cardFloors: [2, 3, 4, 5, 6, 7, 8],
  readerType: 'osdp',
  readerId: '',
  format: 'wiegand26',
  facility: 123,
  card: 12345,
  speed: 1,
  doorHold: 6,
  autoReturn: 20,
});

const STORE_KEY = 'aether.elevator.v2';
const loadCfg = (): ElevatorCfg => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const c = { ...defaultCfg(), ...saved };
      // v1 defaulted to "controller", which locks every secured floor when no
      // controller is wired. v2 defaults to "open".
      if (!saved.version) { c.grantSource = 'open'; c.version = 2; }
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
  const base = backendUrl || `http://${window.location.hostname}:3001`;
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
  const [inputs, setInputs] = useState<Record<number, boolean>>({});   // ACU input channel -> active
  const [simGrants, setSimGrants] = useState<Record<number, number>>({}); // floor -> expires at
  const [tracking, setTracking] = useState<Record<number, boolean>>({}); // floor -> relay on
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
  const setRelay = useCallback(async (floorId: number, on: boolean) => {
    const f = cfgRef.current.floors.find(x => x.id === floorId);
    setTracking(p => ({ ...p, [floorId]: on }));
    if (!f || !f.relay) return;
    try {
      // /api/gpio/set takes a 0-based pin; relays are numbered 1-8
      await fetch(`${base}/api/gpio/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: f.relay - 1, value: on ? 1 : 0 }) });
    } catch { /* bench without backend */ }
  }, [base]);

  const isAuthorized = useCallback((floorId: number) => {
    const f = cfgRef.current.floors.find(x => x.id === floorId);
    if (!f) return false;
    if (cfgRef.current.grantSource === 'open' || !f.secured) return true;
    if (cfgRef.current.grantSource === 'controller') return !!(f.input && inputs[f.input]);
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
    setRelay(floor, true);
    setSimGrants(p => { const n = { ...p }; delete n[floor]; return n; });
    log(floor, 'ok', `Arrived at ${floor} · tracking relay ${floorsById[floor]?.relay || '–'} ON${wasCar ? '' : ' (hall call)'}`);
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
      setRelay(s.carFloor, false);
      setStats(p => ({ ...p, trips: p.trips + 1 }));
      log(s.carFloor, 'info', `Leaving ${s.carFloor} ${s.dir === 'up' ? '▲' : '▼'} to ${next} · tracking relay ${floorsById[s.carFloor]?.relay || '–'} OFF`);
      sync();
    }, 80);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorsById, setRelay, log]);

  // ── Rider actions ────────────────────────────────────────────────────────
  const pressFloor = (floorId: number) => {
    const s = S.current;
    if (s.stopped) { log(floorId, 'warn', `Button ${floorId}: car is stopped`); return; }
    if (s.carCalls.includes(floorId)) return;
    if (!isAuthorized(floorId)) {
      setFlash(floorId); setTimeout(() => setFlash(f => (f === floorId ? null : f)), 700);
      setStats(p => ({ ...p, denied: p.denied + 1 }));
      log(floorId, 'warn', `Button ${floorId} refused: secured floor, no grant${cfgRef.current.grantSource === 'controller' ? ` (input ${cfgRef.current.floors.find(x => x.id === floorId)?.input || 'none'} is off)` : ''}. Present a card first.`);
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
    log(s.carFloor, 'err', 'EMERGENCY STOP: all calls cancelled');
    sync();
  };
  const resume = () => {
    const s = S.current; s.stopped = false;
    if (s.doors === 'open') { s.holdUntil = Date.now() + cfgRef.current.doorHold * 1000; }
    setRelay(s.carFloor, true);
    log(s.carFloor, 'ok', 'Resumed');
    sync();
  };

  const presentCard = async (random = false) => {
    const c = cfgRef.current;
    if (c.readerType === 'none' || !c.readerId) { log(S.current.carFloor, 'err', 'No reader set up. Choose one in Settings.'); setShowSettings(true); return; }
    const fmt = FORMATS.find(f => f.id === c.format) || FORMATS[0];
    const fc = random ? Math.floor(Math.random() * Math.min(fmt.fc, 255)) + 1 : c.facility;
    const card = random ? Math.floor(Math.random() * Math.min(fmt.card, 99999)) + 1 : c.card;
    setReader('busy');
    try {
      const r = c.readerType === 'osdp'
        ? await fetch(`${base}/api/osdp/card-read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readerId: c.readerId, facility: fc, card, format: fmt.id }) })
        : await fetch(`${base}/api/wiegand/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ door: parseInt(c.readerId, 10), facility: fc, card, format: fmt.bits, parity: 'std', pulseUs: 50, spaceUs: 1000 }) });
      const j = await r.json().catch(() => ({}));
      if (!(j.success || j.ok)) throw new Error(j.error || `HTTP ${r.status}`);
      log(S.current.carFloor, 'info', `Card presented: ${fmt.name} FC ${fc} #${card} → ${c.readerType.toUpperCase()} ${c.readerId}`);
      if (c.grantSource === 'simulated') {
        const until = Date.now() + c.grantWindow * 1000;
        setSimGrants(p => { const n = { ...p }; for (const f of c.cardFloors) n[f] = until; return n; });
        setStats(p => ({ ...p, granted: p.granted + 1 }));
        log(S.current.carFloor, 'ok', `Simulated grant: floors ${c.cardFloors.join(', ') || 'none'} for ${c.grantWindow}s`);
        c.cardFloors.forEach(f => onFloorAccess?.(f, c.readerId, true));
      }
      setReader('ok');
    } catch (e: any) {
      log(S.current.carFloor, 'err', `Card not sent: ${e.message}`);
      setReader('deny');
    }
    setTimeout(() => setReader('idle'), 1500);
  };

  // ── ACU inputs from the backend ──────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onInput = (d: { type: 'opto' | 'analog'; pin: number; state: number; voltage?: number; supervisionState?: string }) => {
      const c = cfgRef.current;
      if (d.type !== c.inputType) return;
      const ch = d.pin + 1;
      let active: boolean;
      if (d.supervisionState) active = d.supervisionState === 'active';
      else if (d.type === 'analog') active = (d.voltage ?? 0) >= c.analogThreshold * 1000;
      else active = d.state === 1;
      setInputs(p => {
        if (!!p[ch] === active) return p;
        const floor = c.floors.find(f => f.input === ch);
        if (floor) {
          log(floor.id, active ? 'ok' : 'info', `Controller ${active ? 'granted' : 'released'} floor ${floor.id} (input ${ch})`);
          if (active) { setStats(s => ({ ...s, granted: s.granted + 1 })); onFloorAccess?.(floor.id, c.readerId, true); }
        }
        return { ...p, [ch]: active };
      });
    };
    socket.on('input_state_change', onInput);
    return () => { socket.off('input_state_change', onInput); };
  }, [socket, log, onFloorAccess]);

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
  const fmt = FORMATS.find(f => f.id === cfg.format) || FORMATS[0];
  const readerName = cfg.readerType === 'none' ? 'No reader'
    : (cfg.readerType === 'osdp' ? readers.osdp : readers.wiegand).find(r => r.id === cfg.readerId)?.name || (cfg.readerId ? `${cfg.readerType.toUpperCase()} ${cfg.readerId}` : 'Reader not chosen');
  const grantLeft = (f: number) => Math.max(0, Math.ceil(((simGrants[f] || 0) - now) / 1000));

  const inputOn = (f: FloorCfg) => !!(f.input && inputs[f.input]);
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
            {topFloor} floors · {cfg.grantSource === 'open' ? 'open: every floor works, grant inputs light buttons' : cfg.grantSource === 'controller' ? `secured floors need a controller grant (${cfg.inputType} inputs)` : 'grants simulated by this page'} · {stats.trips} trips · {stats.granted} granted · {stats.denied} refused
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
          style={{ background: 'linear-gradient(180deg,rgb(var(--hv-popup-panel)) 0%,rgb(var(--hv-widget-panel)) 100%)', borderColor: 'rgb(var(--hv-modal))', boxShadow: 'inset 0 1px 0 rgb(var(--hv-contrast) / 0.06)' }}>
          {/* Position indicator */}
          <div className="w-full rounded-lg px-4 py-3 flex items-center justify-between" style={{ background: 'rgb(var(--hv-surface))', border: '1px solid #000', boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)' }}>
            <div className="flex flex-col items-center w-8">
              <ChevronUp size={22} style={{ color: dir === 'up' ? C.amberHi : 'rgb(var(--hv-widget))', filter: dir === 'up' ? `drop-shadow(0 0 6px ${C.amber})` : 'none' }} />
              <ChevronDown size={22} style={{ color: dir === 'down' ? C.amberHi : 'rgb(var(--hv-widget))', filter: dir === 'down' ? `drop-shadow(0 0 6px ${C.amber})` : 'none' }} />
            </div>
            <div className="font-mono font-bold text-6xl tabular-nums" style={{ color: stopped ? C.crit : C.amberHi, textShadow: `0 0 14px color-mix(in srgb, ${stopped ? C.crit : C.amber} 67%, transparent)` }}>{carFloor}</div>
            <div className="w-24 text-right font-mono text-[11px] font-bold leading-tight" style={{ color: stopped ? C.crit : C.amber }}>{statusText}</div>
          </div>

          {/* Card reader */}
          <button onClick={() => presentCard(false)} disabled={reader === 'busy' || stopped}
            className="w-full rounded-xl border px-4 py-3 flex items-center gap-3 transition-all disabled:opacity-50 group"
            style={{ background: 'rgb(var(--hv-surface))', borderColor: reader === 'ok' ? C.good : reader === 'deny' ? C.crit : 'rgb(var(--hv-line))' }}
            title="Present the configured card at the car reader">
            <span className="w-3 h-3 rounded-full shrink-0" style={{
              background: reader === 'ok' ? C.good : reader === 'deny' ? C.crit : reader === 'busy' ? C.amber : 'rgb(var(--hv-line))',
              boxShadow: reader === 'idle' ? 'none' : `0 0 10px ${reader === 'ok' ? C.good : reader === 'deny' ? C.crit : C.amber}` }} />
            <CreditCard size={22} style={{ color: C.text2 }} />
            <div className="min-w-0 flex-1 text-left">
              <div className="text-sm font-bold">{reader === 'busy' ? 'Reading…' : reader === 'ok' ? 'Card sent' : reader === 'deny' ? 'Card not sent' : 'Present card'}</div>
              <div className="text-[11px] truncate" style={{ color: C.dim }}>{readerName} · FC {cfg.facility} · #{cfg.card}</div>
            </div>
            <span onClick={(e) => { e.stopPropagation(); presentCard(true); }} title="Present a random card" className="p-1.5 rounded hover:bg-hv-contrast/10" style={{ color: C.dim }}><Shuffle size={14} /></span>
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
                        background: st === 'lit' ? 'radial-gradient(circle at 50% 40%, rgb(var(--hv-brand-text)), rgb(var(--hv-brand)) 70%)' : 'radial-gradient(circle at 50% 35%, rgb(var(--hv-line)), rgb(var(--hv-widget)) 75%)',
                        color: st === 'lit' ? 'rgb(var(--hv-brand-tint))' : st === 'locked' ? 'rgb(var(--hv-text-3))' : C.text,
                        border: `3px solid ${refused ? C.crit : st === 'lit' ? 'rgb(var(--hv-brand-text))' : st === 'granted' ? C.teal : st === 'free' ? 'rgb(var(--hv-line-strong))' : 'rgb(var(--hv-line))'}`,
                        boxShadow: refused ? `0 0 16px ${C.crit}` : st === 'lit' ? `0 0 18px color-mix(in srgb, ${C.amber} 67%, transparent)` : st === 'granted' ? `0 0 14px color-mix(in srgb, ${C.teal} 53%, transparent)` : 'inset 0 -2px 4px rgba(0,0,0,0.5)',
                      }}>
                      {id}
                      {st === 'locked' && <Lock size={11} className="absolute bottom-2" style={{ color: 'rgb(var(--hv-text-3))' }} />}
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
              className="flex-1 h-11 rounded-lg border font-bold text-sm disabled:opacity-40" style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-modal))' }}>◀ ▶</button>
            <button onClick={closeDoors} disabled={doors !== 'open'} title="Door close"
              className="flex-1 h-11 rounded-lg border font-bold text-sm disabled:opacity-40" style={{ background: 'rgb(var(--hv-widget))', borderColor: 'rgb(var(--hv-modal))' }}>▶ ◀</button>
            {stopped
              ? <button onClick={resume} title="Resume normal service" className="flex-1 h-11 rounded-lg font-bold text-sm flex items-center justify-center gap-1.5" style={{ background: 'rgb(var(--hv-success-tint-strong))', border: `1px solid ${C.good}`, color: 'rgb(var(--hv-success-text))' }}><Play size={15} />Resume</button>
              : <button onClick={emergencyStop} title="Emergency stop" className="flex-1 h-11 rounded-lg font-bold text-sm flex items-center justify-center gap-1.5" style={{ background: 'rgb(var(--hv-error-tint-strong))', border: `1px solid ${C.crit}`, color: 'rgb(var(--hv-error-text))' }}><Bell size={15} />Stop</button>}
          </div>

          {/* Legend */}
          <div className="w-full grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]" style={{ color: C.dim }}>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ border: `2px solid ${C.teal}` }} />granted, press to go</span>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: C.amber }} />selected</span>
            {cfg.grantSource !== 'open' && <span className="flex items-center gap-1.5"><Lock size={10} />secured, needs a card</span>}
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ border: '2px solid rgb(var(--hv-line-strong))' }} />{cfg.grantSource === 'open' ? 'press to go' : 'free access'}</span>
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
              <div ref={shaftRef} className="relative border-x" style={{ gridColumn: 2, gridRow: `1 / span ${floorsDesc.length}`, borderColor: 'rgb(var(--hv-line))',
                background: 'linear-gradient(90deg, transparent 2px, rgb(var(--hv-line)) 2px 5px, transparent 5px calc(100% - 5px), rgb(var(--hv-line)) calc(100% - 5px) calc(100% - 2px), transparent calc(100% - 2px)), rgba(0,0,0,0.3)' }}>
                <div className="absolute pointer-events-none" style={{
                  left: 'calc(50% - 1px)', width: 2, top: 0,
                  height: (topFloor - carPos) * ROW + 5, transition: 'height 90ms linear',
                  background: 'repeating-linear-gradient(180deg,rgb(var(--hv-text-3)) 0 3px,rgb(var(--hv-modal)) 3px 5px)',
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
                    <div className="flex items-center justify-center" style={{ gridColumn: 3, gridRow: row }}>
                      <Sig on={trk} color={C.good} label={`TRK${f.relay ? ' ' + f.relay : ''}`} title={`Tracking relay ${f.relay || '(none)'} → controller: ${trk ? 'ON, car is here' : 'off'}`} />
                    </div>
                    <div className="flex items-center justify-center" style={{ gridColumn: 4, gridRow: row }}>
                      <Sig on={acu} color={C.teal} label={`ACU${f.input ? ' ' + f.input : ''}`} title={`Grant ${cfg.grantSource === 'simulated' ? '(simulated)' : `input ${f.input || '(none)'} from the controller`}: ${acu ? 'on' : 'off'}`} />
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

      {showSettings && <SettingsModal cfg={cfg} setCfg={setCfg} readers={readers} onClose={() => setShowSettings(false)} />}
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
function SettingsModal({ cfg, setCfg, readers, onClose }: {
  cfg: ElevatorCfg; setCfg: React.Dispatch<React.SetStateAction<ElevatorCfg>>;
  readers: { osdp: { id: string; name: string }[]; wiegand: { id: string; name: string }[] }; onClose: () => void;
}) {
  const up = (p: Partial<ElevatorCfg>) => setCfg(c => ({ ...c, ...p }));
  const upFloor = (id: number, p: Partial<FloorCfg>) => setCfg(c => ({ ...c, floors: c.floors.map(f => f.id === id ? { ...f, ...p } : f) }));
  const inp = 'rounded-md px-2 py-1.5 text-sm border w-full';
  const st = { background: 'rgb(var(--hv-surface))', borderColor: 'rgb(var(--hv-line))', color: 'rgb(var(--hv-text))' };
  const fmt = FORMATS.find(f => f.id === cfg.format) || FORMATS[0];
  const list = cfg.readerType === 'osdp' ? readers.osdp : readers.wiegand;
  const H = ({ children }: { children: React.ReactNode }) => <h3 className="text-xs font-bold tracking-wider mb-2" style={{ color: 'rgb(var(--hv-text-3))' }}>{children}</h3>;
  const L = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="block"><span className="block text-[11px] mb-1" style={{ color: 'rgb(var(--hv-text-2))' }}>{label}</span>{children}</label>;

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
              <select className={inp} style={st} value={cfg.format} onChange={e => up({ format: e.target.value })}>
                {FORMATS.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
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
              <L label="Grant inputs are">
                <select className={inp} style={st} value={cfg.inputType} onChange={e => up({ inputType: e.target.value as any })}>
                  <option value="opto">Opto inputs</option><option value="analog">Analog inputs</option>
                </select>
              </L>
              {cfg.inputType === 'analog' && <L label="Active at (V)"><input type="number" step={0.1} min={0} max={10} className={inp} style={st} value={cfg.analogThreshold} onChange={e => up({ analogThreshold: parseFloat(e.target.value) || 2.5 })} /></L>}
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
          <H>FLOORS AND WIRING</H>
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'rgb(var(--hv-popup-panel))' }}>
            <div className="grid grid-cols-[40px_minmax(0,1fr)_90px_90px_90px] gap-2 px-3 py-2 text-[10px] font-bold tracking-wider" style={{ color: 'rgb(var(--hv-text-3))', background: 'rgb(var(--hv-surface) / 0.25)' }}>
              <span>FL</span><span>NAME</span><span>SECURED</span><span>TRACK RELAY</span><span>GRANT INPUT</span>
            </div>
            {[...cfg.floors].sort((a, b) => b.id - a.id).map(f => (
              <div key={f.id} className="grid grid-cols-[40px_minmax(0,1fr)_90px_90px_90px] gap-2 px-3 py-1.5 items-center border-t" style={{ borderColor: 'rgb(var(--hv-popup-panel))' }}>
                <span className="font-mono font-bold">{f.id}</span>
                <input className={inp} style={st} value={f.name} onChange={e => upFloor(f.id, { name: e.target.value })} />
                <button onClick={() => upFloor(f.id, { secured: !f.secured })} className="relative w-10 h-5 rounded-full" style={{ background: f.secured ? 'rgb(var(--hv-success-strong))' : 'rgb(var(--hv-line))' }}>
                  <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: f.secured ? 22 : 2 }} />
                </button>
                <select className={inp} style={st} value={f.relay} onChange={e => upFloor(f.id, { relay: parseInt(e.target.value) })}>
                  <option value={0}>none</option>{[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>Relay {n}</option>)}
                </select>
                <select className={inp} style={st} value={f.input} onChange={e => upFloor(f.id, { input: parseInt(e.target.value) })}>
                  <option value={0}>none</option>{[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>Input {n}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="text-[11px] mt-2" style={{ color: 'rgb(var(--hv-text-3))' }}>Track relay: on while the car is at that floor (tells the controller where the car is). Grant input: the controller turns it on to allow that floor.</p>
        </section>

        <section>
          <H>MOTION AND DOORS</H>
          <div className="grid grid-cols-3 gap-3">
            <L label={`Speed: ${cfg.speed} floor/s`}><input type="range" min={0.5} max={3} step={0.5} value={cfg.speed} onChange={e => up({ speed: parseFloat(e.target.value) })} className="w-full" /></L>
            <L label={`Doors stay open: ${cfg.doorHold}s`}><input type="range" min={3} max={30} step={1} value={cfg.doorHold} onChange={e => up({ doorHold: parseInt(e.target.value) })} className="w-full" /></L>
            <L label={cfg.autoReturn ? `Return to lobby after ${cfg.autoReturn}s idle` : 'Return to lobby: off'}><input type="range" min={0} max={120} step={5} value={cfg.autoReturn} onChange={e => up({ autoReturn: parseInt(e.target.value) })} className="w-full" /></L>
          </div>
        </section>

        <div className="flex justify-between items-center">
          <button onClick={() => { if (confirm('Reset all elevator settings to defaults?')) setCfg(defaultCfg()); }} className="text-xs underline" style={{ color: 'rgb(var(--hv-text-3))' }}>Reset to defaults</button>
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
      els.push(<line key={`v${i}`} x1={x} x2={x} y1={top} y2={bot} stroke="rgb(var(--hv-warning-text))" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />);
      if (i < bars) {
        const xn = x + dir * pitch;
        els.push(
          <path key={`x${i}`} d={`M${x},${top} L${xn},${mid} L${x},${bot} M${xn},${top} L${x},${mid} L${xn},${bot}`}
            fill="none" stroke="rgb(var(--hv-brand))" strokeWidth={1} vectorEffect="non-scaling-stroke" />);
      }
    }
    const edge = x0 + dir * bars * pitch;             // leading stile with handle
    els.push(<rect key="stile" x={Math.min(edge, edge + dir * 3) - 0} y={top} width={3} height={bot - top} fill="rgb(var(--hv-warning-text))" />);
    els.push(<rect key="handle" x={edge + (dir === 1 ? -4 : 1)} y={mid - 4} width={3} height={8} rx={1} fill="rgb(var(--hv-brand-hover))" />);
    return els;
  };
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="cab-wall" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--hv-text-3))" /><stop offset="1" stopColor="rgb(var(--hv-brand-tint-strong))" />
        </linearGradient>
        <linearGradient id="cab-light" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--hv-warning-text))" stopOpacity=".55" /><stop offset=".6" stopColor="rgb(var(--hv-warning-text))" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cab-header" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--hv-modal))" /><stop offset="1" stopColor="rgb(var(--hv-popup-panel))" />
        </linearGradient>
      </defs>
      {/* cab interior */}
      <rect x={1} y={1} width={w - 2} height={h - 2} rx={3} fill="url(rgb(var(--hv-pink))-wall)" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} x={8 + i * ((w - 16) / 7)} y={9} width={(w - 16) / 7 - 4} height={h - 20} rx={1.5}
          fill="none" stroke="rgb(var(--hv-brand-tint))" strokeOpacity=".7" />
      ))}
      <rect x={1} y={1} width={w - 2} height={h - 2} rx={3} fill="url(rgb(var(--hv-pink))-light)" />
      {/* ceiling lamp and handrail */}
      <rect x={half - 26} y={5} width={52} height={3} rx={1.5} fill="rgb(var(--hv-warning-text))" opacity={moving ? 0.8 : 1} />
      <rect x={10} y={h - 16} width={w - 20} height={2} rx={1} fill="rgb(var(--hv-warning))" opacity=".9" />
      {/* gate halves */}
      <g style={{ transform: `scaleX(${fold})`, transformOrigin: '0px 0px', transition: ease }}>{lattice(1)}</g>
      <g style={{ transform: `scaleX(${fold})`, transformOrigin: `${w}px 0px`, transition: ease }}>{lattice(-1)}</g>
      {/* header with rivets, and the sill */}
      <rect x={0} y={0} width={w} height={5} rx={2} fill="url(rgb(var(--hv-pink))-header)" />
      {Array.from({ length: 9 }, (_, i) => <circle key={i} cx={12 + i * ((w - 24) / 8)} cy={2.5} r={0.9} fill="rgb(var(--hv-text-3))" />)}
      <rect x={0} y={h - 4} width={w} height={4} rx={1} fill="rgb(var(--hv-text-2))" />
      <rect x={0} y={h - 4} width={w} height={1} fill="rgb(var(--hv-text-2))" />
      {/* frame */}
      <rect x={0.75} y={0.75} width={w - 1.5} height={h - 1.5} rx={3} fill="none" stroke={frame} strokeWidth={1.5} />
    </svg>
  );
}
