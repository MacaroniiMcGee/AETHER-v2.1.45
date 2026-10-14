// doorOutputs.ts — AETHER_DOOR_OUTPUTS (Update 69)
//
// A door's Lock, DPS and REX are all OUTPUTS that Aether drives into the
// access controller's inputs. Each one is one of:
//   'relay' : REL 1-8           (channel 0-7, POST /api/gpio/set)
//   'dac'   : analog DAC 1-4    (channel 0-3, activeVolts when active, 0 V idle)
//   'od'    : open-drain O.D. 1-4 (channel 0-3, switch to GND; hidden in the UI)
// channel -1 = not assigned (never driven).
//
// Legacy saved hardwareType 'opto' / 'analog' on DPS/REX always drove the relay
// with that channel, so they normalize to 'relay' with the channel unchanged.
//
// Shared by the Doors page, Settings, Pinout, I/O Mapping and Emulation.
// Every network helper takes the backend base URL, e.g. `http://${ip}:3001`.

export type DoorOutputKind = 'relay' | 'dac' | 'od';
export type DoorOutputRoleKey = 'lock' | 'dps' | 'rexIn';

export interface DoorOutputLike {
  name?: string;
  hardwareType?: string;
  channel: number;
  stackLevel?: number;
  reverseSense?: boolean;
  activeVolts?: number;
  active?: boolean;
  analogMode?: string;       // AETHER_ANALOG_IN: 'analog-in' Lock only ('eol' | 'volts')
  thresholdVolts?: number;   // AETHER_ANALOG_IN: 'analog-in' volts mode
  [k: string]: any;
}

export interface DoorLike {
  id?: number;
  name: string;
  enabled?: boolean;
  ioSource?: 'physical' | 'emulated' | string;
  lock?: DoorOutputLike;
  dps?: DoorOutputLike;
  rexIn?: DoorOutputLike;
  [k: string]: any;
}

export interface SystemOutputLike {
  name: string;
  hardwareType?: string;
  channel: number;
  stackLevel?: number;
  [k: string]: any;
}

export type DoorOutputConflict = { key: string; label: string; users: string[] };

export type DoorOutputUser = {
  kind: DoorOutputKind; channel: number; stackLevel: number;
  label: string;          // e.g. 'REL 1', 'DAC 2', 'O.D. 3'
  user: string;           // e.g. 'Main Entrance DPS'
  doorName: string; role: 'Lock' | 'DPS' | 'REX'; roleKey: DoorOutputRoleKey;
};

export const DOOR_OUTPUT_CHANNELS: Record<DoorOutputKind, number> = { relay: 8, dac: 4, od: 4 };
export const DOOR_OUTPUT_ROLES: { key: DoorOutputRoleKey; role: 'Lock' | 'DPS' | 'REX' }[] = [
  { key: 'lock', role: 'Lock' }, { key: 'dps', role: 'DPS' }, { key: 'rexIn', role: 'REX' },
];
export const DEFAULT_ACTIVE_VOLTS = 10;

/* AETHER_LOCK_WATCH (Update 71): a physical door's Lock can instead be an INPUT
 * Aether watches: the controller's lock relay wired to OPTO n (channel 0-7).
 * Saved as hardwareType 'opto-in'. It is never driven and is not an output, so
 * it never counts in output clash checks. reverseSense inverts it (unlocked = OFF).
 *
 * AETHER_ANALOG_IN (Update 72): or an EOL zone ADC n (channel 0-7), saved as
 * hardwareType 'analog-in' with analogMode 'eol' (default: supervision ALARM =
 * unlocked, NORMAL = locked, TROUBLE / TAMPER = stays locked and is reported) or
 * 'volts' (volts >= thresholdVolts = unlocked, default 5 V, 0.5-10). reverseSense
 * inverts the unlocked result in both modes. isLockWatch is true for both kinds. */
export const LOCK_WATCH_TYPE = 'opto-in';
export const LOCK_WATCH_ANALOG_TYPE = 'analog-in';   // AETHER_ANALOG_IN
export const DEFAULT_LOCK_WATCH_THRESHOLD = 5;       // AETHER_ANALOG_IN
export type LockWatchSupervision = 'normal' | 'active' | 'trouble' | 'short';
export function isLockWatch(io: { hardwareType?: string } | null | undefined): boolean {
  return !!io && (io.hardwareType === LOCK_WATCH_TYPE || io.hardwareType === LOCK_WATCH_ANALOG_TYPE);
}
/** AETHER_ANALOG_IN: Lock watched on an EOL zone (ADC n). */
export function isAnalogLockWatch(io: { hardwareType?: string } | null | undefined): boolean {
  return !!io && io.hardwareType === LOCK_WATCH_ANALOG_TYPE;
}
export function lockWatchLabel(io: { channel?: number; hardwareType?: string } | null | undefined): string {
  if (!isDoorOutputAssigned(io)) return 'Not assigned';
  return `${isAnalogLockWatch(io) ? 'ADC' : 'OPTO'} ${Number(io!.channel) + 1}`;   // AETHER_ANALOG_IN
}
/** Logical unlocked state of a watched lock from an opto level (0/1). */
export function lockWatchActive(io: { reverseSense?: boolean }, optoLevel: number | boolean): boolean {
  const on = !!optoLevel;
  return io && io.reverseSense ? !on : on;
}
/** AETHER_ANALOG_IN: threshold of a volts-mode analog watch, clamped to 0.5-10 V (default 5). */
export function lockWatchThreshold(io: { thresholdVolts?: number } | null | undefined): number {
  const v = Number(io && io.thresholdVolts);
  if (!io || io.thresholdVolts === undefined || io.thresholdVolts === null || (io.thresholdVolts as any) === '' || !Number.isFinite(v)) return DEFAULT_LOCK_WATCH_THRESHOLD;
  return Math.min(10, Math.max(0.5, v));
}
/** AETHER_ANALOG_IN: is a user-entered watch threshold acceptable (0.5 <= v <= 10)? */
export function isValidLockWatchThreshold(v: any): boolean {
  const n = Number(v);
  return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= 0.5 && n <= 10;
}

/**
 * AETHER_ANALOG_IN: what an 'input_state_change' event (or a one-off read shaped
 * like one) means for a watched Lock. Pure. Returns null when the event is not
 * for this lock (other type / channel, or the lock is not watched) or carries no
 * usable reading (e.g. an analog zone in UNKNOWN / ERROR in eol mode).
 *   opto-in : active = level (reverseSense inverts).
 *   analog-in, eol  : ALARM => unlocked; NORMAL => locked; TROUBLE / TAMPER =>
 *                     locked, supervisionState 'trouble' / 'short'.
 *   analog-in, volts: volts (or voltage mV / 1000) >= thresholdVolts => unlocked.
 * reverseSense inverts `active` in every mode, except TROUBLE / TAMPER, which
 * always read as locked (a fault never shows the door unlocked).
 */
export function lockWatchFromEvent(
  io: { hardwareType?: string; channel?: number; reverseSense?: boolean; analogMode?: string; thresholdVolts?: number } | null | undefined,
  ev: { type?: string; pin?: number; channel?: number; state?: number | boolean; voltage?: number; volts?: number | string; supervisionState?: string } | null | undefined
): { active: boolean; supervisionState?: LockWatchSupervision } | null {
  if (!io || !ev || !isLockWatch(io) || !isDoorOutputAssigned(io)) return null;
  const pin = Number(ev.pin ?? ev.channel);
  if (!Number.isInteger(pin) || pin !== Number(io.channel)) return null;
  const inv = (on: boolean) => (io.reverseSense ? !on : on);
  if (!isAnalogLockWatch(io)) {
    if (ev.type !== 'opto' || ev.state === undefined || ev.state === null) return null;
    return { active: inv(!!Number(ev.state)) };
  }
  if (ev.type !== 'analog') return null;
  if (io.analogMode === 'volts') {
    const given = (x: any) => x !== undefined && x !== null && x !== '' && Number.isFinite(Number(x));
    const v = given(ev.volts) ? Number(ev.volts) : given(ev.voltage) ? Number(ev.voltage) / 1000 : NaN;
    if (!Number.isFinite(v)) return null;
    return { active: inv(v >= lockWatchThreshold(io)) };
  }
  const st = String(ev.supervisionState || '').toUpperCase();
  if (st === 'ALARM') return { active: inv(true), supervisionState: 'active' };
  if (st === 'NORMAL') return { active: inv(false), supervisionState: 'normal' };
  // trouble / tamper: a wiring fault, not a lock state: always LOCKED (even with
  // reverseSense) and the fault is reported
  if (st === 'TROUBLE') return { active: false, supervisionState: 'trouble' };
  if (st === 'TAMPER') return { active: false, supervisionState: 'short' };
  return null;
}

/* AETHER_ANALOG_IN (Update 72): door custom I/O ("ios") signal types. Custom ios
 * have always been: 'relay' = REL n, driven by toggle-io; 'opto' / 'analog' =
 * an Aether INPUT (OPTO n / ADC n) that follows 'input_state_change' events and
 * was never driven (toggle-io only ever wrote a relay for 'relay'). So the
 * existing values keep their meaning; anything else is legacy and not driven.
 * Custom ios never count in output clash checks (collectDoorOutputUsers). */
export function isCustomInputIO(io: { hardwareType?: string } | null | undefined): boolean {
  return !!io && (io.hardwareType === 'opto' || io.hardwareType === 'analog');
}
export function customIOLabel(io: { hardwareType?: string; channel?: number } | null | undefined): string {
  if (!isDoorOutputAssigned(io)) return 'Not assigned';
  const n = Number(io!.channel) + 1;
  return io!.hardwareType === 'opto' ? `OPTO ${n}` : io!.hardwareType === 'analog' ? `ADC ${n}` : io!.hardwareType === 'relay' ? `REL ${n}` : `${io!.hardwareType || 'channel'} ${n}`;
}

export type DoorInputUser = { kind: 'opto' | 'analog'; channel: number; label: string; user: string; doorName: string };
/**
 * AETHER_ANALOG_IN: Aether INPUTS that enabled doors watch, per terminal: a
 * physical door's watched Lock (OPTO n / ADC n) and custom input ios (opto /
 * analog; these follow the Pi's inputs whatever the door's I/O source).
 * Stack 0 only (the inputs Aether reads).
 */
export function collectDoorInputUsers(doors: DoorLike[]): DoorInputUser[] {
  const out: DoorInputUser[] = [];
  for (const d of doors || []) {
    if (!d || d.enabled === false) continue;
    const lock = d.lock;
    if (isPhysicalEnabledDoor(d) && lock && isLockWatch(lock) && isDoorOutputAssigned(lock) && !lock.stackLevel) {
      out.push({ kind: isAnalogLockWatch(lock) ? 'analog' : 'opto', channel: Number(lock.channel), label: lockWatchLabel(lock), user: `${d.name} Lock (watched)`, doorName: d.name });
    }
    for (const io of Array.isArray(d.ios) ? d.ios : []) {
      if (!io || io.enabled === false || !isCustomInputIO(io) || !isDoorOutputAssigned(io) || Number(io.channel) > 7 || io.stackLevel) continue;
      out.push({ kind: io.hardwareType, channel: Number(io.channel), label: customIOLabel(io), user: `${d.name} ${io.name || 'I/O'}`, doorName: d.name });
    }
  }
  return out;
}

/* ───────────────────────────── pure helpers ───────────────────────────── */

/** Anything that is not 'dac' / 'od' drives a relay. */
export function doorOutputKind(io: { hardwareType?: string } | null | undefined): DoorOutputKind {
  const t = io && io.hardwareType;
  return t === 'dac' || t === 'od' ? t : 'relay';
}

/** True when the role has a channel to drive (channel >= 0). */
export function isDoorOutputAssigned(io: { channel?: number } | null | undefined): boolean {
  const ch = Number(io && io.channel);
  return Number.isInteger(ch) && ch >= 0;
}

/** Rewrite legacy hardwareType to the kind it actually drives. Channel untouched. */
export function normalizeDoorOutput<T extends { hardwareType?: string }>(io: T): T {
  if (!io) return io;
  if (isLockWatch(io)) return io;              // AETHER_LOCK_WATCH: an input, keep as is
  const kind = doorOutputKind(io);
  return io.hardwareType === kind ? io : { ...io, hardwareType: kind };
}

/** Normalize a door's Lock / DPS / REX (returns a copy; input not mutated). */
export function normalizeDoorOutputs<T extends { lock?: any; dps?: any; rexIn?: any }>(door: T): T {
  if (!door) return door;
  const d: any = { ...door };
  for (const { key } of DOOR_OUTPUT_ROLES) if (d[key]) d[key] = normalizeDoorOutput(d[key]);
  return d;
}

/**
 * Migrate one door object as saved by any Aether version to the current shape:
 * legacy `gpio` -> `channel`, `readers:{in,out}` -> `reader`, missing
 * hardwareType -> relay, then normalizeDoorOutputs.
 */
export function migrateSavedDoor<T = any>(door: any): T {
  const migrateEdge = (edge: any) => {
    if (!edge) return edge;
    const next = { ...edge };
    if (next.channel === undefined && next.gpio !== undefined) next.channel = next.gpio;
    delete next.gpio;
    return next;
  };
  const d: any = { ...door };
  if (d.reader === undefined) {
    d.reader = d.readers && typeof d.readers === 'object' ? (d.readers.in || d.readers.out || null) : null;
  }
  delete d.readers;
  for (const { key } of DOOR_OUTPUT_ROLES) if (d[key]) d[key] = migrateEdge(d[key]);
  if (Array.isArray(d.ios)) d.ios = d.ios.map((io: any) => migrateEdge(io));
  if (d.lock && d.lock.channel !== undefined && !d.lock.hardwareType) {
    d.lock = { ...d.lock, hardwareType: 'relay' };
    if (d.dps) d.dps = { ...d.dps, hardwareType: 'relay', supervisionState: 'normal' };
    if (d.rexIn) d.rexIn = { ...d.rexIn, hardwareType: 'relay', supervisionState: 'normal' };
  }
  return normalizeDoorOutputs(d);
}

/**
 * The Lock has always driven `active` straight through (its reverseSense flag
 * was never applied to the output), so keep that for every kind.
 */
export function lockDriveIO<T extends { reverseSense?: boolean }>(io: T): T {
  return io && io.reverseSense ? { ...io, reverseSense: false } : io;
}

/** Volts for an active analog output: 0 < v <= 10, else the 10 V default. */
export function doorActiveVolts(io: { activeVolts?: number } | null | undefined): number {
  const v = Number(io && io.activeVolts);
  if (!io || io.activeVolts === undefined || io.activeVolts === null || !Number.isFinite(v) || v <= 0) return DEFAULT_ACTIVE_VOLTS;
  return Math.min(10, v);
}

/** Is a user-entered active voltage acceptable (0 < v <= 10)? */
export function isValidActiveVolts(v: any): boolean {
  const n = Number(v);
  return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n > 0 && n <= 10;
}

/** 1-based terminal label: REL 1 (= channel 0), DAC 2, O.D. 3. */
export function doorOutputChannelLabel(kind: DoorOutputKind, channel: number): string {
  if (!isDoorOutputAssigned({ channel })) return 'Not assigned';
  const n = Number(channel) + 1;
  return kind === 'dac' ? `DAC ${n}` : kind === 'od' ? `O.D. ${n}` : `REL ${n}`;
}

export function doorOutputLabel(io: DoorOutputLike): string {
  const base = doorOutputChannelLabel(doorOutputKind(io), io.channel);
  return io.stackLevel && isDoorOutputAssigned(io) ? `${base} (stack ${io.stackLevel})` : base;
}

/** Identity of a physical terminal: kind + stack + channel. */
export function doorOutputKey(io: DoorOutputLike): string {
  return `${doorOutputKind(io)}:${io.stackLevel || 0}:${io.channel}`;
}

/** Comparable signature of what a door drives (kind/channel/stack/activeVolts per role). */
export function doorOutputsSignature(door: DoorLike | null | undefined): string {
  if (!door) return '';
  return DOOR_OUTPUT_ROLES.map(({ key }) => {
    const io = door[key];
    if (!io) return `${key}:-`;
    if (isLockWatch(io)) return `${key}:watch:${io.hardwareType}:${io.channel}`;   // AETHER_ANALOG_IN: mode/threshold are not terminals
    const kind = doorOutputKind(io);
    return `${key}:${doorOutputKey(io)}${kind === 'dac' ? `@${doorActiveVolts(io)}` : ''}`;
  }).join('|');
}

/** Doors whose outputs Aether drives on the Sequent board: enabled + physical. */
export function isPhysicalEnabledDoor(d: DoorLike | null | undefined): boolean {
  return !!d && d.enabled !== false && (!d.ioSource || d.ioSource === 'physical');
}

/** Every assigned Lock/DPS/REX output of enabled physical doors. */
export function collectDoorOutputUsers(doors: DoorLike[]): DoorOutputUser[] {
  const out: DoorOutputUser[] = [];
  for (const d of doors || []) {
    if (!isPhysicalEnabledDoor(d)) continue;
    for (const { key, role } of DOOR_OUTPUT_ROLES) {
      const io = d[key];
      if (!io || !isDoorOutputAssigned(io) || isLockWatch(io)) continue;   // a watched lock is an input
      const norm = { ...io, channel: Number(io.channel) };
      out.push({
        kind: doorOutputKind(norm), channel: norm.channel, stackLevel: Number(norm.stackLevel) || 0,
        label: doorOutputLabel(norm), user: `${d.name} ${role}`, doorName: d.name, role, roleKey: key,
      });
    }
  }
  return out;
}

/**
 * Terminals shared by more than one user among enabled physical doors' Lock /
 * DPS / REX and configured relay system outputs (channel >= 0). Disabled doors,
 * emulated-board doors and unassigned roles (-1) never count.
 */
export function findDoorOutputConflicts(doors: DoorLike[], systemOutputs: SystemOutputLike[] = []): DoorOutputConflict[] {
  const map = new Map<string, DoorOutputConflict>();
  const add = (io: DoorOutputLike, label: string, user: string) => {
    const key = doorOutputKey(io);
    const hit = map.get(key) || { key, label, users: [] };
    hit.users.push(user);
    map.set(key, hit);
  };
  for (const u of collectDoorOutputUsers(doors)) add({ hardwareType: u.kind, channel: u.channel, stackLevel: u.stackLevel }, u.label, u.user);
  for (const g of systemOutputs || []) {
    if (!g || (g.hardwareType && g.hardwareType !== 'relay') || !isDoorOutputAssigned(g)) continue;
    const io = { ...g, hardwareType: 'relay', channel: Number(g.channel) };
    add(io, doorOutputLabel(io), `${g.name} (System Output)`);
  }
  return Array.from(map.values()).filter(c => c.users.length > 1);
}

/** Conflicts that involve one door's own Lock/DPS/REX. */
export function conflictsInvolvingDoor(door: DoorLike, doors: DoorLike[], systemOutputs: SystemOutputLike[] = []): DoorOutputConflict[] {
  const prefix = DOOR_OUTPUT_ROLES.map(r => `${door.name} ${r.role}`);
  return findDoorOutputConflicts(doors, systemOutputs).filter(c => c.users.some(u => prefix.includes(u)));
}

export function describeDoorOutputConflict(c: DoorOutputConflict): string {
  return `${c.label} is used by: ${c.users.join(', ')}`;
}

/**
 * `count` DISTINCT relay channels not used by enabled physical doors' relay
 * outputs (stack 0) or system outputs. Never repeats a channel; when the
 * board runs out the remaining slots are -1 (not assigned).
 */
export function pickFreeRelayChannels(doors: DoorLike[], systemOutputs: { channel: number }[], count: number): number[] {
  const used = new Set<number>();
  for (const u of collectDoorOutputUsers(doors)) if (u.kind === 'relay' && !u.stackLevel) used.add(u.channel);
  for (const g of systemOutputs || []) if (g && isDoorOutputAssigned(g)) used.add(Number(g.channel));
  const free = [0, 1, 2, 3, 4, 5, 6, 7].filter(ch => !used.has(ch));
  return Array.from({ length: count }, (_, i) => (i < free.length ? free[i] : -1));
}

/** Parse GET /api/doors/config (wrapper or bare config) into migrated doors. */
export function parseSavedDoorConfig(json: any): { doors: any[]; systemOutputs: Record<string, SystemOutputLike>; version?: string } | null {
  const cfg = json && json.config && typeof json.config === 'object' ? json.config : json;
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.doors)) return null;
  return { doors: cfg.doors.map((d: any) => migrateSavedDoor(d)), systemOutputs: cfg.systemOutputs || {}, version: cfg.version };
}

/* ─────────────────────────────── network ─────────────────────────────── */

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `HTTP ${r.status}`);
    }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

const postJson = (url: string, body: any) =>
  fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Load the saved door config from the Pi (GET {base}/api/doors/config) and
 * return its doors migrated + normalized (all doors, including disabled /
 * emulated ones — filter with isPhysicalEnabledDoor). Returns [] when nothing
 * is saved; throws on network/HTTP errors.
 */
export async function loadSavedDoors(base: string): Promise<any[]> {
  const data = await fetchJson(`${base}/api/doors/config`);
  if (data && data.success === false) return [];
  const parsed = parseSavedDoorConfig(data);
  return parsed ? parsed.doors : [];
}

/**
 * Drive one door output. `on` is the LOGICAL state (unlocked / open / pressed);
 * reverseSense inverts the electrical level (pass lockDriveIO(door.lock) for
 * the Lock). `who` (e.g. 'Main Entrance REX') is used in error messages.
 * Refuses unassigned (-1) or out-of-range channels with a clear Error.
 * Resolves to a short description of what was driven, e.g. 'REL 2 ON', 'DAC 1 10.0 V'.
 */
export async function driveDoorOutput(base: string, io: DoorOutputLike, on: boolean, who = 'Output'): Promise<string> {
  if (!io || !isDoorOutputAssigned(io)) throw new Error(`${who} has no output assigned`);
  if (isLockWatch(io)) throw new Error(`${who} is watched on ${lockWatchLabel(io)}; the controller drives it`);
  const kind = doorOutputKind(io);
  const ch = Number(io.channel);
  const max = DOOR_OUTPUT_CHANNELS[kind];
  if (ch >= max) {
    throw new Error(`${who}: invalid ${kind === 'relay' ? 'relay' : kind === 'dac' ? 'analog output' : 'open-drain'} channel ${ch}. Must be 0-${max - 1}.`);
  }
  const level = io.reverseSense ? !on : on;
  if (kind === 'dac') {
    const volts = level ? doorActiveVolts(io) : 0;
    await postJson(`${base}/api/gpio/dac`, { channel: ch, voltage: volts });
    return `${doorOutputLabel(io)} ${volts.toFixed(1)} V`;
  }
  if (kind === 'od') {
    await postJson(`${base}/api/gpio/od`, { channel: ch, on: level });
    return `${doorOutputLabel(io)} ${level ? 'ON' : 'OFF'}`;
  }
  await postJson(`${base}/api/gpio/set`, { pin: ch, value: level ? 1 : 0, stackLevel: io.stackLevel || 0 });
  return `${doorOutputLabel(io)} ${level ? 'ON' : 'OFF'}`;
}

/**
 * Read back what Aether is DRIVING on a door output; resolves to the LOGICAL
 * state (reverseSense applied as in driveDoorOutput). relay: GET /api/gpio/status
 * relays[ch].state; dac: GET /api/gpio/dac/:ch (active if >= activeVolts/2);
 * od: GET /api/gpio/od/:ch .on. Pass `getRelayStatus` to share one status call
 * between several outputs. Throws on unassigned channel or read failure.
 */
export async function readDoorOutput(
  base: string,
  io: DoorOutputLike,
  getRelayStatus?: () => Promise<any>,
  who = 'Output'
): Promise<boolean> {
  if (!io || !isDoorOutputAssigned(io)) throw new Error(`${who} has no output assigned`);
  if (isLockWatch(io)) return (await readLockWatch(base, io, who)).active;   // AETHER_LOCK_WATCH / AETHER_ANALOG_IN: read the input instead
  const kind = doorOutputKind(io);
  const ch = Number(io.channel);
  let level: boolean;
  if (kind === 'dac') {
    const r = await fetchJson(`${base}/api/gpio/dac/${ch}`);
    const v = Number(r && r.voltage);
    if (!Number.isFinite(v)) throw new Error(`no voltage for ${doorOutputLabel(io)}`);
    level = v >= doorActiveVolts(io) / 2;
  } else if (kind === 'od') {
    const r = await fetchJson(`${base}/api/gpio/od/${ch}`);
    level = !!(r && r.on);
  } else {
    const st = await (getRelayStatus ? getRelayStatus() : fetchJson(`${base}/api/gpio/status`));
    const row = Array.isArray(st && st.relays) ? st.relays.find((x: any) => Number(x.channel) === ch) : undefined;
    if (!row) throw new Error(`no relay status for ${doorOutputLabel(io)}`);
    if (row.error) throw new Error(`${doorOutputLabel(io)}: ${row.error}`);
    level = !!row.state;
  }
  return io.reverseSense ? !level : level;
}

/**
 * AETHER_LOCK_WATCH / AETHER_ANALOG_IN: one-off read of a watched Lock, shaped
 * like lockWatchFromEvent. opto-in: GET /api/gpio/opto/:ch. analog-in: GET
 * /api/supervision/status (the backend's shared, 5 s-cached zone scan;
 * boards[0].zones[] with 1-based `channel`, `state`, `voltage` mV, `volts`) — the
 * same read EmulationSection uses (not /zone/..., which hits the ADC directly).
 */
export async function readLockWatch(base: string, io: DoorOutputLike, who = 'Lock'): Promise<{ active: boolean; supervisionState?: LockWatchSupervision }> {
  if (!io || !isDoorOutputAssigned(io)) throw new Error(`${who} has no input assigned`);
  const ch = Number(io.channel);
  let ev: any;
  if (isAnalogLockWatch(io)) {
    const r = await fetchJson(`${base}/api/supervision/status`);
    const zones = Array.isArray(r && r.boards && r.boards[0] && r.boards[0].zones) ? r.boards[0].zones : [];
    const z = zones.find((x: any) => Number(x && x.channel) === ch + 1);
    if (!z || String(z.state || '').toUpperCase() === 'ERROR') throw new Error(`no reading for ${lockWatchLabel(io)}${z && z.error ? `: ${z.error}` : ''}`);
    ev = { type: 'analog', pin: ch, voltage: Number(z.voltage), volts: z.volts, supervisionState: z.state };
  } else {
    const r = await fetchJson(`${base}/api/gpio/opto/${ch}`);
    const v = r && (r.state ?? r.value);
    if (v === undefined || v === null) throw new Error(`no reading for ${lockWatchLabel(io)}`);
    ev = { type: 'opto', pin: ch, state: Number(v) };
  }
  const res = lockWatchFromEvent(io, ev);
  if (!res) throw new Error(`${lockWatchLabel(io)}: no usable reading${ev.supervisionState ? ` (${ev.supervisionState})` : ''}`);
  return res;
}
