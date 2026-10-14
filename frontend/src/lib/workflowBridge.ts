// workflowBridge.ts — AETHER_DOOR_WORKFLOWS
//
// Door Custom Events run Emulation WORKFLOWS from the Pi's library
// (/api/emulations — shared by every door, page and browser). The Emulation
// page owns the run engine and stays mounted (hidden) on every tab, so other
// pages talk to it through window CustomEvents:
//
//   'aether:run-workflow'         {scope, requestId, workflowId, doorId, label, deadline}
//   'aether:run-workflow-result'  {scope, requestId, ok, error?}
//   'aether:edit-workflow'        {scope, workflowId?, newName?, doorId?, doorName?, eventIndex?, eventName?}
//   'aether:workflow-saved'       {scope, id, name, doorId, eventIndex, persisted}
//   'aether:navigate'             {scope, tab:'emulation'} | {scope, tab:'access-control', sub:'doors'}
// scope = the node's ipAddress (AETHER_DOOR_IO_WORKFLOWS: one app per cluster node).
//
// Blocks set to "This door" use THIS_DOOR_ID (door ids) / THIS_DOOR_READER
// (reader ids) and resolve at run time to the door whose event started the run.
// Everything here is plain TS (no React) so it can be unit-tested in Node.

// ───────────────────────── constants ─────────────────────────
export const THIS_DOOR_ID = -1;
export const THIS_DOOR_READER = '__this_door__';
export const THIS_DOOR = { doorId: THIS_DOOR_ID, readerId: THIS_DOOR_READER } as const;
export const THIS_DOOR_LABEL = 'This door (the door running the event)';
export const THIS_DOOR_NO_CONTEXT_ERROR = "'This door' only works when a door event runs this workflow";
export const RUN_TIMEOUT_MS = 5000;

export const EV_RUN = 'aether:run-workflow';
export const EV_RUN_RESULT = 'aether:run-workflow-result';
export const EV_EDIT = 'aether:edit-workflow';
export const EV_SAVED = 'aether:workflow-saved';
export const EV_NAVIGATE = 'aether:navigate';

// ───────────────────────── event plumbing ─────────────────────────
// In the browser everything goes through `window`; in Node (tests) a shared
// EventTarget stands in for it.
function bridgeTarget(): EventTarget {
  if (typeof window !== 'undefined' && window && typeof (window as any).addEventListener === 'function') return window;
  const g = globalThis as any;
  if (!g.__aetherBridgeTarget) g.__aetherBridgeTarget = new EventTarget();
  return g.__aetherBridgeTarget as EventTarget;
}

function makeEvent<T>(type: string, detail: T): Event {
  if (typeof CustomEvent === 'function') return new CustomEvent<T>(type, { detail });
  const e = new Event(type) as any;
  e.detail = detail;
  return e as Event;
}

function emit<T>(type: string, detail: T): void {
  bridgeTarget().dispatchEvent(makeEvent(type, detail));
}

function listen<T>(type: string, fn: (detail: T) => void): () => void {
  const h = (e: Event) => fn(((e as CustomEvent<T>).detail ?? ({} as T)) as T);
  const t = bridgeTarget();
  t.addEventListener(type, h);
  return () => t.removeEventListener(type, h);
}

// ───────────────────────── scope ─────────────────────────
// AETHER_DOOR_IO_WORKFLOWS: the cluster page mounts one full app PER NODE (all
// mounted, hidden) and window events are global, so every message carries the
// node's scope (its ipAddress) and listeners ignore other scopes. Otherwise the
// first node to answer (maybe an offline one) replies for everybody.
/** A scope, or a getter for one (the node's ipAddress can change at run time). */
export type ScopeArg = string | (() => string);
export const normScope = (s: unknown) => String(s ?? '').trim().toLowerCase();
/** The scope of one node: `${nodeId}|${ipAddress}` inside the cluster page, just the ipAddress standalone. */
export const nodeScope = (nodeId: string | null | undefined, ipAddress: string | null | undefined) =>
  nodeId ? `${nodeId}|${ipAddress || ''}` : String(ipAddress || '');
const scopeOf = (s: ScopeArg) => normScope(typeof s === 'function' ? s() : s);
/** listen(), but only to messages for `scope`. Messages without a scope are ignored. */
function listenScoped<T extends { scope?: string }>(type: string, scope: ScopeArg, fn: (detail: T) => void): () => void {
  return listen<T>(type, d => {
    if (!d || typeof d.scope !== 'string') return;
    if (normScope(d.scope) !== scopeOf(scope)) return;
    fn(d);
  });
}

// ───────────────────────── run ─────────────────────────
export type RunWorkflowRequest = {
  workflowId: string; doorId: number; label: string;
  /** AETHER_DOOR_IO_WORKFLOWS: the node (ipAddress) whose Emulation must run it. */
  scope: string;
  /** ms epoch after which the requester has given up ("Emulation engine not ready"): never start a run after it. */
  deadline?: number;
};
/** Margin kept before the deadline so a reply can't land after the requester timed out. */
export const DEADLINE_MARGIN_MS = 250;
export const DEADLINE_ERROR = 'Emulation answered too late — the run was not started; try again';
/** True when a run for `req` must no longer be started (its requester is about to / did time out). */
export const pastDeadline = (req: { deadline?: number }, now = Date.now()) =>
  typeof req.deadline === 'number' && Number.isFinite(req.deadline) && now >= req.deadline - DEADLINE_MARGIN_MS;
export type RunWorkflowResult = { ok: boolean; error?: string };
type RunWire = RunWorkflowRequest & { requestId: string };
type RunResultWire = RunWorkflowResult & { requestId: string; scope: string };

let reqSeq = 0;
const newRequestId = () => `wf-${Date.now().toString(36)}-${(++reqSeq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Ask the Emulation engine OF THIS NODE (req.scope) to start a saved workflow for a door. Resolves once it has started (or refused). */
export function requestRunWorkflow(req: RunWorkflowRequest, timeoutMs = RUN_TIMEOUT_MS): Promise<RunWorkflowResult> {
  return new Promise(resolve => {
    const requestId = newRequestId();
    const scope = normScope(req.scope);
    const deadline = Date.now() + timeoutMs;   // the handler refuses to start after this
    let done = false;
    const finish = (r: RunWorkflowResult) => { if (done) return; done = true; clearTimeout(timer); off(); resolve(r); };
    const off = listenScoped<RunResultWire>(EV_RUN_RESULT, scope, d => {
      if (d.requestId === requestId) finish({ ok: !!d.ok, ...(d.error ? { error: d.error } : {}) });
    });
    const timer = setTimeout(() => finish({ ok: false, error: 'Emulation engine not ready' }), timeoutMs);
    emit<RunWire>(EV_RUN, { ...req, scope, deadline, requestId });
  });
}

/**
 * Emulation side: answer run requests for `scope` only (other nodes' requests are
 * ignored, never answered). The handler resolves when the run has STARTED (not
 * finished), and must check pastDeadline(req) right before starting it.
 */
export function onRunWorkflowRequest(scope: ScopeArg, handler: (req: RunWorkflowRequest) => Promise<RunWorkflowResult>): () => void {
  return listenScoped<RunWire>(EV_RUN, scope, async d => {
    if (!d.requestId) return;
    let r: RunWorkflowResult;
    try { r = await handler({ workflowId: d.workflowId, doorId: d.doorId, label: d.label, scope: d.scope, deadline: d.deadline }); }
    catch (e: any) { r = { ok: false, error: e?.message || String(e) }; }
    emit<RunResultWire>(EV_RUN_RESULT, { requestId: d.requestId, scope: normScope(d.scope), ok: !!r.ok, ...(r.error ? { error: r.error } : {}) });
  });
}

// ───────────────────────── edit / saved / navigate ─────────────────────────
export type EditWorkflowRequest = {
  scope: string;   // AETHER_DOOR_IO_WORKFLOWS
  workflowId?: string;
  newName?: string;
  doorId?: number;
  doorName?: string;
  eventIndex?: number;
  eventName?: string;
};
export const requestEditWorkflow = (req: EditWorkflowRequest) => emit<EditWorkflowRequest>(EV_EDIT, { ...req, scope: normScope(req.scope) });
export const onEditWorkflowRequest = (scope: ScopeArg, fn: (req: EditWorkflowRequest) => void) => listenScoped<EditWorkflowRequest>(EV_EDIT, scope, fn);

export type WorkflowSaved = { scope: string; id: string; name: string; doorId: number; eventIndex: number; persisted?: boolean };
export const emitWorkflowSaved = (d: WorkflowSaved) => emit<WorkflowSaved>(EV_SAVED, { ...d, scope: normScope(d.scope) });
export const onWorkflowSaved = (scope: ScopeArg, fn: (d: WorkflowSaved) => void) => listenScoped<WorkflowSaved>(EV_SAVED, scope, fn);

export type NavigateTarget = { tab: 'emulation' } | { tab: 'access-control'; sub: 'doors' };
type NavigateWire = NavigateTarget & { scope: string };
export const navigate = (t: NavigateTarget, scope: string) => emit<NavigateWire>(EV_NAVIGATE, { ...t, scope: normScope(scope) } as NavigateWire);
export const navigateToEmulation = (scope: string) => navigate({ tab: 'emulation' }, scope);
export const navigateToDoors = (scope: string) => navigate({ tab: 'access-control', sub: 'doors' }, scope);
export const onNavigate = (scope: ScopeArg, fn: (t: NavigateTarget) => void) =>
  listenScoped<NavigateWire>(EV_NAVIGATE, scope, d => fn(d.tab === 'emulation' ? { tab: 'emulation' } : { tab: 'access-control', sub: 'doors' }));

// ───────────────────────── ids / names ─────────────────────────
/** Same rule as backend safeId(): the file id POST /api/emulations gives a name. */
export function safeWorkflowId(str: string): string {
  return String(str).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

export const WORKFLOW_ID_MAX = 64;   // backend safeId() keeps 64 chars

/**
 * A name whose id is not taken yet (POST with an existing id OVERWRITES that workflow).
 * The id keeps only 64 characters, so the base is shortened to leave room for the
 * " (n)" suffix — otherwise a long name's suffixes would all be cut off and collide.
 */
export function uniqueWorkflowName(base: string, existing: { id?: string; name?: string }[]): string {
  const ids = new Set((existing || []).map(w => String(w?.id ?? '')));
  const name0 = (base || '').trim() || 'Door event';
  const fit = (suffix: string) => {
    // safeId maps each UTF-16 unit to one char, so code-unit length = id length
    const room = Math.max(1, WORKFLOW_ID_MAX - suffix.length);
    let b = name0.length > room ? name0.slice(0, room) : name0;
    if (/[\uD800-\uDBFF]$/.test(b)) b = b.slice(0, -1);   // don't leave half a surrogate pair
    return `${b.replace(/\s+$/, '') || 'W'}${suffix}`;
  };
  const free = (nm: string) => !ids.has(safeWorkflowId(nm));
  const first = fit('');
  if (free(first)) return first;
  for (let n = 2; n < 10000; n++) {
    const nm = fit(` (${n})`);
    if (free(nm)) return nm;
  }
  for (;;) {   // practically unreachable
    const nm = fit(` ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    if (free(nm)) return nm;
  }
}

// ───────────────────────── legacy step conversion ─────────────────────────
// Old door Custom Event step (DoorSection / DoorSettings CustomEventStep).
export type LegacyDoorStep = {
  id?: number;
  action: 'lock' | 'unlock' | 'open-dps' | 'close-dps' | 'activate-rex' | 'deactivate-rex' | 'toggle-io' | 'send-card' | 'wait' | 'pulse' | string;
  ioId?: string;
  readerId?: string;
  cardFormat?: string;
  facilityCode?: string | number;
  cardNumber?: string | number;
  delay?: number;
  waitType?: 'seconds' | 'minutes' | 'random';
  waitValue?: number;
  waitMin?: number;
  waitMax?: number;
  pulseTarget?: 'lock' | 'dps' | 'rex' | string;
  pulseDuration?: number;
};

// The Emulation block fields this conversion writes (subset of EmulationSection WorkflowBlock).
export type BridgeBlock = {
  id: string;
  type: 'door' | 'reader' | 'wait' | 'log';
  doorId?: number;
  eventType?: 'lock' | 'dps' | 'rexIn' | 'io';   // AETHER_DOOR_IO_WORKFLOWS: 'io' = a door Custom I/O (ioRef)
  ioRef?: CustomIoRef;
  action?: 'activate' | 'deactivate' | 'pulse' | 'toggle';
  pulseDuration?: number;
  readerId?: string;
  format?: string;
  mode?: 'single';
  readType?: 'card';
  facilityCode?: number;
  cardNumber?: number;
  sequenceMode?: 'sequential';
  delayBetweenCards?: number;
  pinValue?: string;
  keypadFormat?: '4bit';
  waitType?: 'seconds' | 'minutes' | 'random';
  waitValue?: number;
  waitMin?: number;
  waitMax?: number;
  logMessage?: string;
  logLevel?: 'info' | 'warning';
  assertCondition?: boolean;
};
export type BridgeColumn = { id: string; blocks: BridgeBlock[] };

export type ConvertOptions = {
  /** The door's own reader id: a send-card step on it becomes "This door". */
  doorReaderId?: string | null;
  /** The door's custom I/O: a toggle-io step becomes a Custom I/O slot (its position here). */
  doorIos?: { id: string; name?: string }[];
};

/**
 * Old step list -> Emulation workflow. One column per step; a step's `delay`
 * (ms, waited BEFORE the step by the old runner) becomes a Wait column in front
 * of it, and globalDelay is 0, so timing matches the old runner.
 */
export function convertDoorStepsToWorkflow(steps: LegacyDoorStep[], eventName: string, opts: ConvertOptions = {}): { columns: BridgeColumn[]; globalDelay: number } {
  const columns: BridgeColumn[] = [];
  let n = 0;
  const uid = () => `cv${(++n).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const push = (b: Omit<BridgeBlock, 'id'>) => { columns.push({ id: `col-${uid()}`, blocks: [{ id: `block-${uid()}`, ...b }] }); };
  const door = (eventType: 'lock' | 'dps' | 'rexIn', action: 'activate' | 'deactivate' | 'pulse', pulseDuration = 500) =>
    push({ type: 'door', doorId: THIS_DOOR_ID, eventType, action, pulseDuration });
  const warn = (msg: string) => push({ type: 'log', logLevel: 'warning', logMessage: msg, assertCondition: false });

  (steps || []).forEach((s, i) => {
    if (!s) return;
    // Emulation reads waitValue / waitMin / waitMax with `|| default`, so a 0 would
    // become 5 s / 1 s: zero-length waits are skipped, never written as 0.
    const delay = Number(s.delay);
    if (Number.isFinite(delay) && delay > 0) push({ type: 'wait', waitType: 'seconds', waitValue: delay / 1000 });
    switch (s.action) {
      case 'lock': door('lock', 'deactivate'); break;           // old: toggleDoorLock(false) = LOCKED
      case 'unlock': door('lock', 'activate'); break;           // old: toggleDoorLock(true)  = UNLOCKED
      case 'open-dps': door('dps', 'activate'); break;
      case 'close-dps': door('dps', 'deactivate'); break;
      case 'activate-rex': door('rexIn', 'activate'); break;
      case 'deactivate-rex': door('rexIn', 'deactivate'); break;
      case 'pulse': {
        const t = String(s.pulseTarget || 'lock').toLowerCase();
        let hold = Number(s.pulseDuration);
        if (!Number.isFinite(hold) || hold <= 0) hold = 1000;   // old runner's default hold
        door(t === 'dps' ? 'dps' : t === 'rex' ? 'rexIn' : 'lock', 'pulse', hold);
        break;
      }
      case 'wait': {
        const num = (v: any, d: number) => { const x = Number(v ?? d); return Number.isFinite(x) ? x : d; };
        if (s.waitType === 'random') {
          // old runner: lo = max(0, min ?? 1), hi = max(lo, max ?? 5) seconds
          const lo = Math.max(0, num(s.waitMin, 1));
          const hi = Math.max(lo, num(s.waitMax, 5));
          if (hi <= 0) break;                                   // always 0 s: nothing to wait
          // min 0 can't be stored (it reads as 1 s); 1 ms keeps the old 0..max range
          push({ type: 'wait', waitType: 'random', waitMin: lo > 0 ? lo : 0.001, waitMax: hi });
        } else if (s.waitType === 'minutes') {
          const v = num(s.waitValue, 1);
          if (v > 0) push({ type: 'wait', waitType: 'minutes', waitValue: v });
        } else {
          const v = num(s.waitValue, 5);
          if (v > 0) push({ type: 'wait', waitType: 'seconds', waitValue: v });
        }
        break;
      }
      case 'send-card': {
        const fc = parseInt(String(s.facilityCode ?? ''), 10);
        const cn = parseInt(String(s.cardNumber ?? ''), 10);
        if (!s.cardFormat || !Number.isFinite(fc) || !Number.isFinite(cn)) {
          warn(`Step ${i + 1} (send card) was missing its format, facility code or card number — not converted`);
          break;
        }
        const own = !s.readerId || (opts.doorReaderId && s.readerId === opts.doorReaderId);
        push({
          type: 'reader', readerId: own ? THIS_DOOR_READER : s.readerId,
          // generic Wiegand format of that length in the Pi catalog ('w26', 'w34', …) —
          // the old step sent bits only, which is what these formats are.
          format: `w${s.cardFormat}`,
          mode: 'single', readType: 'card', facilityCode: fc, cardNumber: cn,
          sequenceMode: 'sequential', delayBetweenCards: 500, pinValue: '1234', keypadFormat: '4bit',
        });
        break;
      }
      case 'toggle-io': {
        // AETHER_DOOR_IO_WORKFLOWS: → Door block on This door, Custom I/O slot = the io's position
        const ios = opts.doorIos || [];
        const idx = s.ioId ? ios.findIndex(x => x && x.id === s.ioId) : -1;
        // {id, index}: the id on the running door first (same door), else the same slot
        if (idx >= 0 && idx < MAX_CUSTOM_IO) push({ type: 'door', doorId: THIS_DOOR_ID, eventType: 'io', ioRef: { id: String(s.ioId), index: idx }, action: 'toggle', pulseDuration: 500 });
        else warn(`Step ${i + 1} (toggle custom I/O${s.ioId ? ` ${s.ioId}` : ''}) was not converted — ${s.ioId ? 'that I/O is not on this door any more' : 'no I/O was selected'}`);
        break;
      }
      default:
        warn(`Step ${i + 1} (unknown action "${s.action}") was not converted`);
    }
  });
  if (columns.length === 0) warn(`"${eventName || 'Event'}" had no steps`);
  return { columns, globalDelay: 0 };
}

// ───────────────────────── "This door" resolution ─────────────────────────
// (one object type, not a union: the app is type-checked without strictNullChecks, where a union wouldn't narrow)
export type ResolveResult<T> = { ok: boolean; value?: T; error?: string };

/** A block's door id: THIS_DOOR_ID -> the run's context door. */
export function resolveDoorId(blockDoorId: number | undefined | null, contextDoorId: number | null | undefined): ResolveResult<number> {
  const id = Number(blockDoorId ?? 1);
  if (id !== THIS_DOOR_ID) return { ok: true, value: id };
  if (contextDoorId === null || contextDoorId === undefined || !Number.isFinite(Number(contextDoorId))) return { ok: false, error: THIS_DOOR_NO_CONTEXT_ERROR };
  return { ok: true, value: Number(contextDoorId) };
}

/** Does this block use "This door" anywhere? */
export function blockUsesThisDoor(b: any): boolean {
  if (!b || typeof b !== 'object') return false;
  switch (b.type) {
    case 'door': return Number(b.doorId) === THIS_DOOR_ID;
    case 'reader': return b.readerId === THIS_DOOR_READER;
    case 'waitInput': return (b.waitInputType === 'door_dps' || b.waitInputType === 'door_rex' || b.waitInputType === 'door_io') && Number(b.waitInputDoorId) === THIS_DOOR_ID;
    case 'log': return !!b.assertCondition && b.assertSource === 'door_io' && Number(b.assertDoorId) === THIS_DOOR_ID;   // AETHER_DOOR_IO_WORKFLOWS
    case 'scenario': return b.scenarioReaderId === THIS_DOOR_READER || b.scenarioReader2Id === THIS_DOOR_READER || Number(b.scenarioDoorId) === THIS_DOOR_ID;
    default: return false;
  }
}

/** The reader id a saved door uses: its `reader`, else (emulated door) its board's reader port. */
export function doorReaderIdOf(door: { reader?: string | null; ioSource?: string; emuBoard?: number; emuReaderPort?: number } | null | undefined): string | null {
  if (!door) return null;
  if (door.reader) return String(door.reader);
  if (door.ioSource === 'emulated' && Number(door.emuBoard) > 0) return `ctrl-emu-${Number(door.emuBoard)}-${Number(door.emuReaderPort) || 0}`;
  return null;
}

export type PoolReader = { id: string; type?: string; name?: string; d0?: number; d1?: number; assignedToDoor?: number | null; address?: number };
export type WiegandCfgDoor = { door?: number | string; d0?: number | string; d1?: number | string; readerId?: string };
export type LegacyPoolReader = { id: string; d0?: number; d1?: number };

const samePins = (a: { d0?: any; d1?: any }, b: { d0?: any; d1?: any }) =>
  a.d0 !== undefined && a.d0 !== null && b.d0 !== undefined && b.d0 !== null &&
  Number(a.d0) === Number(b.d0) && Number(a.d1) === Number(b.d1);

/**
 * Map a Doors-page reader id to a reader in the Emulation reader pool:
 *   ctrl-emu-<a>-<p> -> same id
 *   osdp-<id>        -> OSDP reader whose id is <id>
 *   wg-<n>           -> Wiegand reader assigned to door n, else the one on
 *                       /api/wiegand/config doors[n]'s D0/D1 (or its readerId)
 *   legacy 'readerN' -> same id if present, else the Wiegand reader on the
 *                       legacy pool entry's D0/D1 pins
 */
export function mapDoorReaderToPool(
  doorReaderId: string | null | undefined,
  pool: PoolReader[],
  wiegandDoors: WiegandCfgDoor[] = [],
  legacyPool: LegacyPoolReader[] = [],
): ResolveResult<string> {
  const rid = doorReaderId ? String(doorReaderId) : '';
  if (!rid) return { ok: false, error: 'the door has no reader assigned' };
  const P = pool || [];
  if (P.some(r => r.id === rid)) return { ok: true, value: rid };
  if (rid.startsWith('ctrl-emu-')) return { ok: false, error: `emulated reader ${rid} is not available (board not running?)` };
  if (rid.startsWith('osdp-')) {
    const raw = rid.slice(5);
    const hit = P.find(r => r.type === 'osdp' && r.id === raw);
    return hit ? { ok: true, value: hit.id } : { ok: false, error: `OSDP reader ${raw} is not in the reader list` };
  }
  const wiegand = P.filter(r => r.type === 'wiegand');
  const m = rid.match(/^wg-(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    const byDoor = wiegand.find(r => r.assignedToDoor !== null && r.assignedToDoor !== undefined && Number(r.assignedToDoor) === n);
    if (byDoor) return { ok: true, value: byDoor.id };
    const cfg = (wiegandDoors || []).find(d => Number(d && d.door) === n);
    if (cfg) {
      const byPins = wiegand.find(r => samePins(r, cfg));
      if (byPins) return { ok: true, value: byPins.id };
      if (cfg.readerId && P.some(r => r.id === cfg.readerId)) return { ok: true, value: String(cfg.readerId) };
    }
    return { ok: false, error: `no Wiegand reader found for Wiegand door ${n}` };
  }
  const old = (legacyPool || []).find(r => r.id === rid);
  if (old) {
    const byPins = wiegand.find(r => samePins(r, old));
    if (byPins) return { ok: true, value: byPins.id };
    return { ok: false, error: `no Wiegand reader on D0 ${old.d0} / D1 ${old.d1} (legacy reader ${rid})` };
  }
  return { ok: false, error: `reader ${rid} is not in the reader list` };
}

/** Is this a Doors-page reader id (as opposed to an Emulation pool id)? */
export const looksLikeDoorReaderId = (id: string | null | undefined) =>
  !!id && (/^wg-\d+$/.test(id) || id.startsWith('osdp-') || /^reader\d+$/.test(id));

// ───────────────────────── link a workflow to a door event (on the Pi) ─────────────────────────
/**
 * Read-modify-write /api/doors/config so door `doorId`'s event `eventIndex`
 * runs workflow `workflowId`. Used when the builder saves while the Doors page
 * (which normally owns that file) is not mounted. Also refreshes the Doors
 * page's localStorage cache.
 */
export async function linkWorkflowToDoorEvent(
  base: string,
  link: { doorId: number; eventIndex: number; workflowId: string; workflowName: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RunWorkflowResult> {
  try {
    const r = await fetchImpl(`${base}/api/doors/config`);
    const j: any = await r.json().catch(() => null);
    const config = j && j.config;
    if (!r.ok || !config || !Array.isArray(config.doors)) return { ok: false, error: 'no saved door configuration on the Pi — save the door first' };
    const next = applyWorkflowLink(config, link);
    if (!next) return { ok: false, error: `door ${link.doorId} is not in the saved door configuration` };
    const w = await fetchImpl(`${base}/api/doors/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const wj: any = await w.json().catch(() => ({}));
    if (!w.ok || wj?.success === false) return { ok: false, error: wj?.error || `HTTP ${w.status}` };
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('doorSectionConfig', JSON.stringify(next)); } catch { /* non-fatal */ }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Pure part of linkWorkflowToDoorEvent: a copy of `config` with the link set (null if the door is missing). */
export function applyWorkflowLink(config: any, link: { doorId: number; eventIndex: number; workflowId: string; workflowName: string }): any | null {
  if (!config || !Array.isArray(config.doors)) return null;
  let found = false;
  const doors = config.doors.map((d: any) => {
    if (Number(d?.id) !== Number(link.doorId)) return d;
    found = true;
    const events = Array.isArray(d.customEvents) ? d.customEvents.map((e: any) => ({ ...e })) : [];
    while (events.length <= link.eventIndex) events.push({ name: `Custom Event ${events.length + 1}`, enabled: true, steps: [] });
    events[link.eventIndex] = { ...events[link.eventIndex], workflowId: link.workflowId, workflowName: link.workflowName };
    return { ...d, customEvents: events };
  });
  return found ? { ...config, doors } : null;
}

// ───────────────────────── door Custom I/O ("Additional I/O") ─────────────────────────
// AETHER_DOOR_IO_WORKFLOWS. A door has up to 6 custom I/O (door.ios): relay outputs
// (REL n, driven by Aether) and opto / analog inputs (OPTO n / ADC n, follow the panel).
// Blocks name one with an ioRef: {id} for a specific door, {index} (0-based slot) for
// "This door" — the slot is looked up on whichever door runs the event.
export const MAX_CUSTOM_IO = 6;
export type CustomIoRef = { id?: string; index?: number };
export type DoorCustomIo = { id: string; name?: string; hardwareType?: string; channel?: number; stackLevel?: number; enabled?: boolean; reverseSense?: boolean };

export const isCustomIoInput = (io: { hardwareType?: string } | null | undefined) => !!io && (io.hardwareType === 'opto' || io.hardwareType === 'analog');
export const isCustomIoRelay = (io: { hardwareType?: string } | null | undefined) => !!io && io.hardwareType === 'relay';
const assigned = (io: { channel?: number } | null | undefined) => !!io && Number.isInteger(Number(io.channel)) && Number(io.channel) >= 0;
/** 'REL 5' / 'OPTO 5' / 'ADC 5' (1-based), like lib/doorOutputs customIOLabel. */
export function customIoChannelLabel(io: { hardwareType?: string; channel?: number } | null | undefined): string {
  if (!assigned(io)) return 'Not assigned';
  const n = Number(io!.channel) + 1;
  return io!.hardwareType === 'opto' ? `OPTO ${n}` : io!.hardwareType === 'analog' ? `ADC ${n}` : io!.hardwareType === 'relay' ? `REL ${n}` : `${io!.hardwareType || 'channel'} ${n}`;
}
/** Picker / summary text: 'Custom I/O: Strike Follower · REL 5' or '… · OPTO 5 (input)'. */
export function customIoOptionLabel(io: DoorCustomIo): string {
  return `Custom I/O: ${io.name || io.id} · ${customIoChannelLabel(io)}${isCustomIoInput(io) ? ' (input)' : ''}`;
}
export const customIoSlotLabel = (index: number) => `Custom I/O ${Number(index) + 1}`;
/**
 * Select value for a ref: 'io:id:<id>' / 'io:idx:<n>'. `thisDoor`: the picker lists
 * slots, so a ref carrying both (a converted step: {id, index}) shows its slot.
 */
export const customIoRefValue = (ref: CustomIoRef | null | undefined, thisDoor = false) =>
  !ref ? ''
  : thisDoor && Number.isInteger(ref.index) ? `io:idx:${ref.index}`   // AETHER_DOOR_IO_WORKFLOWS
  : ref.id !== undefined && ref.id !== null && ref.id !== '' ? `io:id:${ref.id}` : Number.isInteger(ref.index) ? `io:idx:${ref.index}` : '';
export function parseCustomIoRefValue(v: string): CustomIoRef | null {
  if (v.startsWith('io:id:')) return { id: v.slice(6) };
  const m = v.match(/^io:idx:(\d+)$/);
  return m ? { index: Number(m[1]) } : null;
}

/**
 * Find a block's custom I/O on a door. Error text says what is missing.
 * A ref with both (a converted step: {id, index}) tries the id on this door first,
 * then the slot position; `note` then says the slot was used.
 */
export function resolveCustomIo(door: { id?: number; name?: string; ios?: DoorCustomIo[] } | null | undefined, ref: CustomIoRef | null | undefined): ResolveResult<{ io: DoorCustomIo; index: number; note?: string }> {
  const dn = door?.name || (door?.id !== undefined ? `Door ${door.id}` : 'the door');
  if (!door) return { ok: false, error: 'door not found' };
  const ios = Array.isArray(door.ios) ? door.ios : [];
  if (!ref) return { ok: false, error: 'no Custom I/O selected' };
  let index = -1;
  let note: string | undefined;
  const hasId = ref.id !== undefined && ref.id !== null && ref.id !== '';
  if (hasId) index = ios.findIndex(x => x && x.id === ref.id);
  if (hasId && index < 0 && !Number.isInteger(ref.index)) return { ok: false, error: `${dn} has no Custom I/O "${ref.id}" any more` };
  if (index >= 0) { /* found by id */ }
  else if (Number.isInteger(ref.index)) {
    if (hasId) note = `I/O "${ref.id}" is not on ${dn} — using ${customIoSlotLabel(Number(ref.index))} (by position)`;
    index = Number(ref.index);
    if (index < 0 || index >= ios.length || !ios[index]) return { ok: false, error: `${dn} has no ${customIoSlotLabel(index)} (it has ${ios.length})` };
  } else return { ok: false, error: 'no Custom I/O selected' };
  const io = ios[index];
  if (io.enabled === false) return { ok: false, error: `${dn} ${io.name || customIoSlotLabel(index)} is disabled` };
  if (!assigned(io)) return { ok: false, error: `${dn} ${io.name || customIoSlotLabel(index)} has no channel assigned` };
  return { ok: true, value: { io, index, ...(note ? { note } : {}) } };
}

/**
 * Relay level for driving a custom relay output. `active` is the I/O's logical state;
 * reverseSense ("Active at Rest": relay ON when inactive) inverts the relay.
 * toggle inverts the relay's CURRENT state (read from /api/gpio/status).
 */
export function customIoDriveLevel(action: 'activate' | 'deactivate' | 'toggle', currentRelayOn: boolean, reverseSense?: boolean): { relayOn: boolean; active: boolean } {
  if (action === 'toggle') {
    const relayOn = !currentRelayOn;
    return { relayOn, active: reverseSense ? !relayOn : relayOn };
  }
  const active = action === 'activate';
  return { active, relayOn: reverseSense ? !active : active };
}

/**
 * Is a custom INPUT active? opto: ON = active; analog (EOL zone): ALARM / TAMPER = active.
 * reverseSense flips it (opto OFF = active; zone NORMAL / TROUBLE = active), as the
 * door's Custom I/O settings describe.
 */
export function customInputActive(io: { hardwareType?: string; reverseSense?: boolean }, reading: { opto?: boolean; zone?: string | null }): boolean {
  if (io.hardwareType === 'analog') {
    const st = String(reading.zone || '').toUpperCase();
    const alarm = st === 'ALARM' || st === 'TAMPER';
    const quiet = st === 'NORMAL' || st === 'TROUBLE';
    return io.reverseSense ? quiet : alarm;
  }
  const on = !!reading.opto;
  return io.reverseSense ? !on : on;
}

/**
 * The block's door changed: keep "the same" Custom I/O. To This door → its slot
 * (position of the id on the old door). To a specific door → the same id if that
 * door has it, else the I/O at the same position; if there is none, the slot is
 * kept ({index}) and the picker shows it as missing.
 */
export function remapCustomIoRef(ref: CustomIoRef | undefined, fromIos: { id: string }[], toIos: { id: string }[], fromThis: boolean, toThis: boolean): CustomIoRef | undefined {
  if (!ref) return ref;
  const hasId = ref.id !== undefined && ref.id !== null && ref.id !== '';
  const posOfId = hasId && !fromThis ? (fromIos || []).findIndex(x => x && x.id === ref.id) : -1;
  if (toThis) {
    if (Number.isInteger(ref.index)) return ref;
    return { index: posOfId >= 0 ? posOfId : 0 };
  }
  if (hasId && (toIos || []).some(x => x && x.id === ref.id)) return { id: ref.id };
  const pos = posOfId >= 0 ? posOfId : Number.isInteger(ref.index) ? Number(ref.index) : -1;
  const io = pos >= 0 ? (toIos || [])[pos] : undefined;
  return io ? { id: io.id } : pos >= 0 ? { index: pos } : ref;
}
