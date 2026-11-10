// AETHER_AEGIS_AUTOMATION — Automation page (AEGIS: Automation & Emulation for General
// Interactive Scenarios). Rules run on the Pi (backend/automation/AutomationManager.js):
//   WHEN  one event the server sees: a relay write, an opto / EOL zone change, door activity,
//         a card read, a schedule, or Run now
//   IF    optional checks against the last known I/O state, a time window, days
//   THEN  relay set / pulse, switch port, Wiegand card, delay, log (+ the original Pi GPIO ones)
// The page header comes from the app shell. Every component is defined at module level: a
// component defined inside another is a new type on each render, and the 4 s poll then
// rebuilds its buttons mid-click (the Doors page lost clicks that way).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Trash2, Pencil, Copy, Play, X, Search, AlertTriangle, Zap, Clock, CreditCard, DoorOpen,
  Radio, Activity, Hand, Cpu, Network, CircleDot, ArrowRight,
} from 'lucide-react';

/* ───────────────────────── types ───────────────────────── */

// IOAccessEmulator's items use `channel`; very old ones used `gpio`. All three lists
// (inputs, outputs, controllerOutputs) are driven through /api/gpio/set = IOplus relays.
type IOItem = { id: number; name: string; type: string; channel?: number; gpio?: number; active: boolean };
const pinOf = (io: IOItem): number => (io.channel ?? io.gpio ?? 0);

type SwitchProfileLite = { id: string; name: string; host: string; portCount: number; denyPorts: number[]; portAliases?: Record<string, string> };
type WiegandReaderLite = { id: string; name?: string; door?: string | number };

type RuleStats = { executions?: number; lastExecuted?: string | null; errors?: number; lastError?: string | null; skipped?: number; lastDurationMs?: number };
export type AutomationRule = {
  id: string; name: string; description?: string; enabled: boolean; priority: number;
  trigger?: any; conditions?: any; actions: any[]; stats?: RuleStats; [k: string]: any;
};
type EngineStats = {
  triggers?: number; lastTriggerAt?: string | null; firedToday?: number; errorsToday?: number; errorsTotal?: number;
  eventsSeen?: Record<string, { count: number; lastAt: number | null }>;
  actionsAvailable?: { relay?: boolean; wiegand?: boolean; switch?: boolean };
};
type FiringEntry = { ts: number; ruleId: string; ruleName?: string; trigger?: string; cause?: string; ok: boolean; skipped?: boolean; error?: string | null; messages?: string[]; durationMs?: number };
type Engine = 'loading' | 'running' | 'unavailable' | 'offline';

interface AutomationSectionProps {
  ipAddress: string;
  connected: boolean;
  inputs: IOItem[];
  outputs: IOItem[];
  controllerOutputs: IOItem[];
  doors?: any[];
  readers?: any[];
  logSystem: (type: string, message: string) => void;
}

/* ───────────────────────── naming (pure, tested) ───────────────────────── */

/** Names the plain-English summaries use. Every lookup falls back to the bare terminal name. */
export type NameCtx = {
  relay?: Record<number, string>;      // channel 0-7 -> "Device Input 1, Main Entrance DPS"
  opto?: Record<number, string>;
  zone?: Record<number, string>;       // zone 1-8
  door?: Record<number, string>;       // door id -> name
  profile?: Record<string, { name: string; portAliases?: Record<string, string> }>;
};
const withName = (base: string, name?: string) => (name ? `${base} (${name})` : base);
export const relayLabel = (ch: number, n: NameCtx = {}) => withName(`REL ${ch + 1}`, n.relay?.[ch]);
export const optoLabel = (ch: number, n: NameCtx = {}) => withName(`OPTO ${ch + 1}`, n.opto?.[ch]);
export const zoneLabel = (z: number, n: NameCtx = {}) => withName(`ADC ${z}`, n.zone?.[z]);
const isSet = (v: any) => v !== undefined && v !== null && v !== '' && v !== 'any';
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fmtMs = (ms: number) => {
  const v = Number(ms) || 0;
  if (v < 1000) return `${v} ms`;
  if (v < 60_000) return `${+(v / 1000).toFixed(1)} s`;
  if (v < 3_600_000) return `${+(v / 60_000).toFixed(1)} min`;
  if (v < 86_400_000) return `${+(v / 3_600_000).toFixed(1)} h`;
  return `${+(v / 86_400_000).toFixed(1)} days`;
};
export const fmtDays = (days: any): string => {
  if (!Array.isArray(days) || !days.length) return 'every day';
  const d = Array.from(new Set(days.map((x: any) => (Number(x) === 7 ? 0 : Number(x))))).sort((a, b) => a - b);
  if (d.length === 7) return 'every day';
  if (d.join() === '1,2,3,4,5') return 'on weekdays';
  if (d.join() === '0,6') return 'at weekends';
  return `on ${d.map(x => DAY_SHORT[x] || `day ${x}`).join(', ')}`;
};

const DOOR_EVENT_WORDS: Record<string, { name: string; on: string; off: string }> = {
  lock: { name: 'lock', on: 'unlocks', off: 'locks' },
  dps: { name: 'DPS', on: 'opens', off: 'closes' },
  rexIn: { name: 'REX', on: 'is pressed', off: 'is released' },
  rex: { name: 'REX', on: 'is pressed', off: 'is released' },
  input: { name: 'input', on: 'goes active', off: 'goes idle' },
};

/** WHEN, in words. */
export function describeTrigger(tr: any, n: NameCtx = {}): string {
  if (!tr || !tr.type) return 'any Pi GPIO pin changes (original rule)';
  switch (tr.type) {
    case 'relay_change': {
      const what = isSet(tr.channel) ? relayLabel(Number(tr.channel), n) : 'any relay';
      return `${what} ${isSet(tr.value) ? (Number(tr.value) === 1 ? 'turns ON' : 'turns OFF') : 'changes'}`;
    }
    case 'opto_change': {
      const what = isSet(tr.channel) ? optoLabel(Number(tr.channel), n) : 'any opto input';
      return `${what} ${isSet(tr.value) ? (Number(tr.value) === 1 ? 'goes active' : 'goes idle') : 'changes'}`;
    }
    case 'zone_change': {
      const what = isSet(tr.zone) ? `EOL zone ${zoneLabel(Number(tr.zone), n)}` : 'any EOL zone';
      return isSet(tr.state) ? `${what} goes ${String(tr.state).toUpperCase()}` : `${what} changes`;
    }
    case 'door_event': {
      const door = isSet(tr.doorId) ? (n.door?.[Number(tr.doorId)] || `Door ${tr.doorId}`) : 'any door';
      const ev = tr.event || tr.role;
      if (ev === 'card') return `a card is presented at ${door}`;
      if (ev === 'event') return `an event is started on ${door}`;
      const w = DOOR_EVENT_WORDS[ev];
      if (!w) return `anything happens on ${door}`;
      if (tr.value === 'fault') return `${door} ${w.name} zone reports a fault`;
      return `${door} ${w.name} ${isSet(tr.value) ? (Number(tr.value) === 1 ? w.on : w.off) : 'changes'}`;
    }
    case 'card_read': {
      const src = isSet(tr.source) ? `${String(tr.source).toUpperCase()} ` : '';
      const card = isSet(tr.card) ? ` ${isSet(tr.facility) ? `${tr.facility}:` : ''}${tr.card}` : (isSet(tr.facility) ? ` with FC ${tr.facility}` : '');
      const at = isSet(tr.readerId) ? ` on reader ${tr.readerId}` : '';
      return `${src ? `an ${src}` : 'a '}card${card} is read${at}`.replace(/^an ([^AEIOU])/, 'a $1');
    }
    case 'reader_event':
      return `a card is read${isSet(tr.readerId) ? ` on reader ${tr.readerId}` : ''}`;
    case 'gpio_change':
      return `Pi GPIO ${tr.pin} goes ${Number(tr.value) === 1 ? 'HIGH' : 'LOW'}`;
    case 'schedule':
      return `it is ${tr.time || '??:??'} ${fmtDays(tr.days)}`;
    case 'manual':
      return 'you press Run now';
    default:
      return `"${tr.type}" happens`;
  }
}

/** One IF condition, in words. */
export function describeCondition(c: any, n: NameCtx = {}): string {
  if (!c || !c.type) return 'the original event filter matches';
  switch (c.type) {
    case 'relay_state': return `${relayLabel(Number(c.channel), n)} is ${Number(c.value) === 1 ? 'ON' : 'OFF'}`;
    case 'opto_state': return `${optoLabel(Number(c.channel), n)} is ${Number(c.value) === 1 ? 'active' : 'idle'}`;
    case 'zone_state': return `EOL zone ${zoneLabel(Number(c.zone), n)} is ${String(c.state || '?').toUpperCase()}`;
    case 'gpio_state': return `Pi GPIO ${c.pin} is ${Number(c.value) === 1 ? 'HIGH' : 'LOW'}`;
    case 'time_window': return `it is between ${c.from || '??:??'} and ${c.to || '??:??'}`;
    case 'days': return `it is ${fmtDays(c.days).replace(/^on /, '').replace(/^at /, '')}`.replace('it is every day', 'any day');
    default: return `"${c.type}" holds`;
  }
}

/** One THEN action (API shape {type, params} or the editor's flat shape), in words. */
export function describeAction(raw: any, n: NameCtx = {}): string {
  if (!raw?.type) return 'unknown action';
  const a = { type: raw.type, ...(raw.params || raw) };
  switch (a.type) {
    case 'relay_set': {
      const base = `turn ${relayLabel(Number(a.channel), n)} ${Number(a.value) === 1 ? 'ON' : 'OFF'}`;
      return Number(a.duration) > 0 ? `${base} for ${fmtMs(Number(a.duration))}` : base;
    }
    case 'relay_pulse': return `pulse ${relayLabel(Number(a.channel), n)} for ${fmtMs(Number(a.duration) || 500)}`;
    case 'gpio': {
      const base = `set Pi GPIO ${a.pin} ${Number(a.value) === 1 ? 'HIGH' : 'LOW'}`;
      return Number(a.duration) > 0 ? `${base} for ${fmtMs(Number(a.duration))}` : base;
    }
    case 'gpio_pulse': return `pulse Pi GPIO ${a.pin} for ${fmtMs(Number(a.duration || a.msec) || 300)}`;
    case 'switch_port': {
      const prof = n.profile?.[a.profileId];
      const alias = prof?.portAliases?.[String(a.port)];
      const where = `${prof?.name || a.profileId} port ${a.port}${alias ? ` (${alias})` : ''}`;
      if (a.action === 'enable') return `bring up ${where}`;
      return `take down ${where} ${Number(a.holdMs) === 0 ? 'until restored by hand' : `for ${fmtMs(Number(a.holdMs) || 0)}`}`;
    }
    case 'wiegand_send': return `send card ${a.facility}:${a.card} on reader ${a.readerId}`;
    case 'wiegand_raw': return `send raw Wiegand bits on reader ${a.readerId}`;
    case 'delay': return `wait ${fmtMs(Number(a.duration ?? a.ms ?? a.msec) || 0)}`;
    case 'log': return `log "${a.message || ''}"`;
    default: return `${a.type} (not run by the engine)`;
  }
}

/** The whole rule as one sentence: When … and … → do …, then … */
export function ruleSentence(rule: Pick<AutomationRule, 'trigger' | 'conditions' | 'actions'>, n: NameCtx = {}): { when: string; ifs: string[]; then: string[] } {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : (rule.conditions && Array.isArray(rule.conditions.all) ? rule.conditions.all : []);
  const hasTrigger = !!(rule.trigger && rule.trigger.type);
  // A rule saved without a trigger uses its conditions as the original event filter.
  const ifs = hasTrigger ? conds.map((c: any) => describeCondition(c, n)) : [];
  let when = describeTrigger(rule.trigger, n);
  if (!hasTrigger && rule.conditions && typeof rule.conditions === 'object') {
    if (rule.conditions.schedule) when = describeTrigger({ type: 'schedule', ...rule.conditions.schedule }, n);
    else {
      const c0 = conds[0] || (!Array.isArray(rule.conditions) && rule.conditions);
      if (c0 && Number.isInteger(c0.pin)) when = `Pi GPIO ${c0.pin}${Number.isInteger(c0.value) ? ` goes ${c0.value === 1 ? 'HIGH' : 'LOW'}` : ' changes'} (original rule)`;
    }
  }
  const then = (rule.actions || []).map((a: any) => {
    const d = describeAction(a, n);
    return Number(a?.delay) > 0 ? `after ${fmtMs(Number(a.delay))}, ${d}` : d;
  });
  return { when, ifs, then };
}
export function ruleSummaryText(rule: Pick<AutomationRule, 'trigger' | 'conditions' | 'actions'>, n: NameCtx = {}): string {
  const s = ruleSentence(rule, n);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  return `When ${s.when}${s.ifs.length ? ` and ${s.ifs.join(' and ')}` : ''} → ${s.then.length ? s.then.map((t, i) => (i ? t : cap(t))).join(', then ') : 'do nothing'}`;
}

/** Build the NameCtx from the page's I/O lists and the saved door config. */
export function buildNames(lists: IOItem[][], doors: any[], profiles: SwitchProfileLite[] = []): NameCtx {
  const relay: Record<number, string[]> = {}, opto: Record<number, string[]> = {}, zone: Record<number, string[]> = {}, door: Record<number, string> = {};
  const push = (m: Record<number, string[]>, k: number, v: string) => { if (!Number.isInteger(k)) return; (m[k] = m[k] || []); if (!m[k].includes(v)) m[k].push(v); };
  for (const list of lists) for (const io of list || []) {
    if (!io || io.id >= 100) continue;                // live emulated-board items are not HAT relays
    const ch = pinOf(io);
    if (ch >= 0 && ch <= 7) push(relay, ch, io.name);
  }
  for (const d of doors || []) {
    if (!d || !Number.isInteger(Number(d.id))) continue;
    door[Number(d.id)] = d.name || `Door ${d.id}`;
    if (d.enabled === false || (d.ioSource && d.ioSource !== 'physical')) continue;
    const roles: [string, string][] = [['lock', 'Lock'], ['dps', 'DPS'], ['rexIn', 'REX']];
    for (const [k, word] of roles) {
      const io = d[k]; if (!io) continue;
      const ch = Number(io.channel ?? io.gpio); if (!Number.isInteger(ch) || ch < 0) continue;
      const t = io.hardwareType || 'relay';
      const label = `${d.name || `Door ${d.id}`} ${word}`;
      if (t === 'relay') push(relay, ch, label);
      else if (t === 'opto' || t === 'opto-in') push(opto, ch, label);
      else if (t === 'analog' || t === 'analog-in') push(zone, ch + 1, label);
    }
    for (const io of d.ios || []) {
      const ch = Number(io?.channel ?? io?.gpio); if (!io || io.enabled === false || !Number.isInteger(ch) || ch < 0) continue;
      const label = `${d.name || `Door ${d.id}`} ${io.name || 'I/O'}`;
      if (io.hardwareType === 'relay') push(relay, ch, label);
      else if (io.hardwareType === 'opto') push(opto, ch, label);
      else if (io.hardwareType === 'analog') push(zone, ch + 1, label);
    }
  }
  const join = (m: Record<number, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.slice(0, 2).join(', ') + (v.length > 2 ? ` +${v.length - 2}` : '')]));
  return {
    relay: join(relay), opto: join(opto), zone: join(zone), door,
    profile: Object.fromEntries(profiles.map(p => [p.id, { name: p.name, portAliases: p.portAliases }])),
  };
}

// AETHER_AEGIS_AUTOMATION (review fixes): helpers for the stricter checks
export const MAX_MS = 24 * 3600 * 1000;   // the engine refuses longer waits (timers overflow past 2^31-1 ms)
/** "7:05" -> "07:05"; anything else -> null (the backend normalises the same way). */
export function normTime(v: any): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
export const isPiPin = (v: any) => v !== null && v !== undefined && v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 27;
/** A rule saved without a trigger and with no pin filter runs on EVERY Pi GPIO write (the original matcher). */
export function firesOnEveryGpioWrite(rule: Pick<AutomationRule, 'trigger' | 'conditions'>): boolean {
  if (rule.trigger && rule.trigger.type) return false;
  const c = rule.conditions;
  if (!c || typeof c !== 'object') return false;   // the engine never matches these
  if (!Array.isArray(c) && c.schedule) return false;
  const list = Array.isArray(c) ? c : (Array.isArray(c.all) ? c.all : [c.all || c]);
  return list.every((x: any) => x && typeof x === 'object' && typeof x.pin !== 'number' && typeof x.value !== 'number' && (!x.event || x.event === 'gpio_change'));
}

/** The backend wants an explicit rule id; derived from the name, editable on a new rule. */
export const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
export function uniqueId(base: string, taken: string[]): string {
  const b = slugify(base) || 'rule';
  if (!taken.includes(b)) return b;
  for (let i = 2; i < 1000; i++) { const c = `${b}-${i}`.slice(0, 52); if (!taken.includes(c)) return c; }
  return `${b}-${Date.now()}`;
}

/* ───────────────────────── editor model (pure, tested) ───────────────────────── */

type Keyed = { _k: number };
export type ActionDraft = Keyed & { type: string; delay: number; [k: string]: any };
export type CondDraft = Keyed & { type: string; [k: string]: any };
export type Draft = {
  originalId: string | null;          // null = new rule
  id: string; name: string; description: string; priority: number; enabled: boolean;
  trigger: { type: string; [k: string]: any };
  legacyConditions?: any;             // a rule saved without a trigger keeps its conditions as they were
  conditions: CondDraft[];
  actions: ActionDraft[];
  extra: Record<string, any>;         // fields this page does not edit, kept on save
};
let _keySeq = 1;
const nextKey = () => _keySeq++;

/** API rule -> editor draft. Flattens action params; older shapes are mapped to what saves the same. */
export function ruleToDraft(rule: AutomationRule, opts: { copy?: boolean; taken?: string[] } = {}): Draft {
  const { id, name, description, enabled, priority, trigger, conditions, actions, stats, disabledReason, ...extra } = rule;   // the loop guard's reason clears on save
  let tr: any = trigger && trigger.type ? { ...trigger } : { type: 'legacy' };
  if (tr.type === 'reader_event') tr = { type: 'card_read', source: 'any', readerId: tr.readerId ?? null };   // same match, current shape
  if (tr.type === 'schedule' && !tr.days && conditions && conditions.schedule?.days) tr.days = conditions.schedule.days;
  const conds = tr.type === 'legacy' ? [] : (Array.isArray(conditions) ? conditions : (conditions && Array.isArray(conditions.all) ? conditions.all : []));
  return {
    originalId: opts.copy ? null : id,
    id: opts.copy ? uniqueId(`${name} copy`, opts.taken || []) : id,
    name: opts.copy ? `${name} (copy)` : name,
    description: description || '',
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 5,
    enabled: opts.copy ? false : enabled !== false,
    trigger: tr,
    legacyConditions: tr.type === 'legacy' ? conditions : undefined,
    conditions: conds.map((c: any) => ({ _k: nextKey(), ...c, type: c?.type || '' })),
    actions: (actions || []).map((a: any) => {
      const flat: ActionDraft = { _k: nextKey(), type: a?.type, delay: Number(a?.delay) || 0, ...(a?.params || {}) };
      if (flat.type === 'delay' && flat.duration === undefined) flat.duration = Number(flat.ms ?? flat.msec) || 0;
      if (flat.type === 'delay') { delete flat.ms; delete flat.msec; }
      return flat;
    }),
    extra,
  };
}

export function emptyDraft(): Draft {
  return {
    originalId: null, id: '', name: '', description: '', priority: 5, enabled: true,
    trigger: { type: 'opto_change', channel: 0, value: 1 }, conditions: [], actions: [], extra: {},
  };
}

/** Editor draft -> API rule (the shape AutomationManager validates and saves). */
export function draftToRule(d: Draft): AutomationRule {
  const strip = (o: any) => { const { _k, ...rest } = o; return rest; };
  const conds = d.conditions.map(strip).filter(c => c.type);
  const actions = d.actions.map(a => {
    const { _k, type, delay, ...fields } = a;
    const params: any = { ...fields };
    if (type === 'delay') params.duration = Math.max(0, Math.round(Number(params.duration) || 0));
    const out: any = { type, params };
    if (Number(delay) > 0) out.delay = Math.round(Number(delay));
    return out;
  });
  const rule: AutomationRule = {
    ...d.extra,
    id: d.originalId || d.id.trim() || slugify(d.name),
    name: d.name.trim(),
    description: d.description,
    enabled: d.enabled,
    priority: d.priority,
    actions,
  };
  if (d.trigger.type === 'legacy') {
    rule.conditions = d.legacyConditions ?? {};
    delete rule.trigger;
  } else {
    const tr: any = { ...d.trigger };
    for (const k of Object.keys(tr)) if (tr[k] === '' || tr[k] === 'any' || tr[k] === undefined) tr[k] = null;
    tr.type = d.trigger.type;
    rule.trigger = tr;
    // The scheduler reads conditions.schedule (older engines only read that copy).
    rule.conditions = tr.type === 'schedule'
      ? { schedule: { time: tr.time = normTime(tr.time) || tr.time, ...(Array.isArray(tr.days) && tr.days.length ? { days: tr.days } : {}) }, ...(conds.length ? { all: conds } : {}) }
      : conds;
  }
  return rule;
}

/** What is wrong with a draft before it goes to the Pi (the backend checks again). */
export function draftProblems(d: Draft, taken: string[]): string[] {
  const p: string[] = [];
  if (!d.name.trim()) p.push('Give the rule a name.');
  const id = d.originalId || d.id.trim() || slugify(d.name);
  if (!id) p.push('The rule needs an ID (letters or numbers).');
  else if (!d.originalId && taken.includes(id)) p.push(`A rule with ID "${id}" already exists.`);
  if (!d.actions.length) p.push('Add at least one THEN action.');
  if (d.trigger.type === 'schedule' && !/^\d{1,2}:\d{2}$/.test(String(d.trigger.time || ''))) p.push('Pick a time for the schedule.');
  if (d.trigger.type === 'schedule' && /^\d{1,2}:\d{2}$/.test(String(d.trigger.time || '')) && !normTime(d.trigger.time)) p.push('The schedule time is not a valid time of day.');
  if (d.trigger.type === 'gpio_change' && !isPiPin(d.trigger.pin)) p.push('Pick a Pi GPIO pin (0-27).');
  for (const a of d.actions) {
    if ((a.type === 'gpio' || a.type === 'gpio_pulse') && !isPiPin(a.pin)) p.push('A Pi GPIO action needs a pin (0-27).');
    const tooLong = [a.delay, a.duration].some(v => Number(v) > MAX_MS);
    if (tooLong) p.push('Waits and durations can be at most 24 h.');
    if (a.type === 'switch_port' && !a.profileId) p.push('A switch port action needs a switch profile.');
    if (a.type === 'wiegand_send' && (!a.readerId || !Number.isInteger(Number(a.facility)) || !Number.isInteger(Number(a.card)))) p.push('A Wiegand card action needs a reader, FC and card number.');
  }
  return p;
}

/* ───────────────────────── constants ───────────────────────── */

const SWITCH_HOLDS = [
  { label: '30 seconds', ms: 30_000 }, { label: '5 minutes', ms: 300_000 }, { label: '15 minutes', ms: 900_000 },
  { label: '1 hour', ms: 3_600_000 }, { label: '4 hours (CLC-004)', ms: 14_400_000 }, { label: '24 hours', ms: 86_400_000 },
  { label: '7 days (CLC-005)', ms: 604_800_000 }, { label: 'Until turned back on', ms: 0 },
];
const CH8 = [0, 1, 2, 3, 4, 5, 6, 7];
const ZONES = [1, 2, 3, 4, 5, 6, 7, 8];
const ZONE_STATES = ['ALARM', 'NORMAL', 'TROUBLE', 'TAMPER'];

const TRIGGERS: { type: string; label: string; hint: string; icon: React.ReactNode; hidden?: boolean }[] = [
  { type: 'opto_change', label: 'Opto input', hint: 'OPTO 1-8 on the HAT changes (what the panel drives)', icon: <CircleDot size={14} /> },
  { type: 'relay_change', label: 'Relay', hint: 'REL 1-8 is written by any page, workflow or rule', icon: <Zap size={14} /> },
  { type: 'zone_change', label: 'EOL zone', hint: 'ADC 1-8 supervision state changes', icon: <Activity size={14} /> },
  { type: 'door_event', label: 'Door', hint: 'Door activity: lock, DPS, REX, inputs, cards', icon: <DoorOpen size={14} /> },
  { type: 'card_read', label: 'Card', hint: 'A card is sent or read (OSDP, Wiegand, NFC)', icon: <CreditCard size={14} /> },
  { type: 'schedule', label: 'Schedule', hint: 'A time of day, on chosen days', icon: <Clock size={14} /> },
  { type: 'manual', label: 'Run now only', hint: 'Started by hand from this page', icon: <Hand size={14} /> },
  { type: 'gpio_change', label: 'Pi GPIO', hint: 'A Raspberry Pi GPIO pin written by Aether (advanced)', icon: <Cpu size={14} /> },
];
const ACTIONS: { type: string; label: string; advanced?: boolean }[] = [
  { type: 'relay_set', label: 'Set relay' },
  { type: 'relay_pulse', label: 'Pulse relay' },
  { type: 'switch_port', label: 'Switch port' },
  { type: 'wiegand_send', label: 'Send Wiegand card' },
  { type: 'delay', label: 'Wait' },
  { type: 'log', label: 'Log message' },
  { type: 'gpio', label: 'Pi GPIO set (advanced)', advanced: true },
  { type: 'gpio_pulse', label: 'Pi GPIO pulse (advanced)', advanced: true },
];
const CONDITIONS: { type: string; label: string }[] = [
  { type: 'relay_state', label: 'Relay is' },
  { type: 'opto_state', label: 'Opto input is' },
  { type: 'zone_state', label: 'EOL zone is' },
  { type: 'time_window', label: 'Time is between' },
  { type: 'days', label: 'Day is' },
];
const FEEDS: { key: string; label: string }[] = [
  { key: 'opto_change', label: 'Opto' }, { key: 'relay_change', label: 'Relay' }, { key: 'zone_change', label: 'Zones' },
  { key: 'door_event', label: 'Doors' }, { key: 'card_read', label: 'Cards' }, { key: 'gpio_change', label: 'Pi GPIO' },
];

function newAction(type: string, ctx: { profiles: SwitchProfileLite[]; readers: WiegandReaderLite[] }, delay = 0): ActionDraft {
  const base = { _k: nextKey(), type, delay };
  switch (type) {
    case 'relay_set': return { ...base, channel: 0, value: 1, duration: 0 };
    case 'relay_pulse': return { ...base, channel: 0, duration: 500 };
    // no default pin: 17 and friends are Wiegand lines on this HAT, so a pin must be chosen
    case 'gpio': return { ...base, pin: null, value: 1 };
    case 'gpio_pulse': return { ...base, pin: null, duration: 300 };
    case 'switch_port': return { ...base, profileId: ctx.profiles[0]?.id || '', port: 1, action: 'disable', holdMs: 900_000, reason: '' };
    case 'wiegand_send': return { ...base, readerId: ctx.readers[0]?.id || '', facility: 123, card: 12345, format: null };
    case 'delay': return { ...base, duration: 1000 };
    case 'log': return { ...base, message: '' };
    default: return base;
  }
}
function newCondition(type: string): CondDraft {
  const base = { _k: nextKey(), type };
  switch (type) {
    case 'relay_state': case 'opto_state': return { ...base, channel: 0, value: 1 };
    case 'zone_state': return { ...base, zone: 1, state: 'ALARM' };
    case 'time_window': return { ...base, from: '08:00', to: '17:00' };
    case 'days': return { ...base, days: [1, 2, 3, 4, 5] };
    default: return base;
  }
}
function triggerDefaults(type: string): { type: string; [k: string]: any } {
  switch (type) {
    case 'opto_change': case 'relay_change': return { type, channel: 0, value: 1 };
    case 'zone_change': return { type, zone: 1, state: 'ALARM' };
    case 'door_event': return { type, doorId: null, event: 'dps', value: 1 };
    case 'card_read': return { type, source: 'any', facility: null, card: null, readerId: null };
    case 'schedule': return { type, time: '02:00', days: [] };
    case 'gpio_change': return { type, pin: null, value: 1 };
    default: return { type };
  }
}

/* ───────────────────────── fetch ───────────────────────── */

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    const body: any = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok || (body && body.success === false)) {
      const err: any = new Error((body && (body.error || body.message)) || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}
const jsonInit = (method: string, body?: any): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const timeAgo = (iso?: string | number | null) => {
  if (!iso) return 'never';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};
const clock = (ts: number) => { const d = new Date(ts); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

/* ───────────────────────── small UI pieces (module level) ───────────────────────── */

const inp = 'w-full rounded-md px-2.5 py-1.5 text-sm border border-hv-line bg-hv-surface text-hv-text outline-none focus:border-hv-info disabled:opacity-50';
const sel = inp;

const H: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
  <div className="flex items-center justify-between gap-2 mb-2">
    <div className="text-[10px] font-bold uppercase tracking-wider text-hv-text-3">{children}</div>
    {right}
  </div>
);

const Field: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({ label, className = '', children }) => (
  <label className={`block min-w-0 ${className}`}>
    <span className="block text-[11px] text-hv-text-3 mb-1">{label}</span>
    {children}
  </label>
);

const IconBtn: React.FC<{ title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({ title, onClick, disabled, danger, children }) => (
  <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
    className={`w-8 h-8 rounded-md flex items-center justify-center text-hv-text-3 transition-colors disabled:opacity-30 ${danger ? 'hover:bg-hv-error-hover/60 hover:text-hv-text' : 'hover:bg-hv-contrast/5 hover:text-hv-text'}`}>
    {children}
  </button>
);

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand';
const PILL: Record<Tone, string> = {
  neutral: 'bg-hv-contrast/5 text-hv-text-2 ring-hv-line',
  good: 'bg-hv-success-tint text-hv-success-fg ring-hv-success/40',
  warn: 'bg-hv-warning-tint text-hv-warning-fg ring-hv-warning/40',
  bad: 'bg-hv-error-tint text-hv-error-fg ring-hv-error/40',
  info: 'bg-hv-info-tint text-hv-info-fg ring-hv-info/40',
  brand: 'bg-hv-brand-tint text-hv-brand-fg ring-hv-brand/40',
};
const Pill: React.FC<{ tone?: Tone; title?: string; children: React.ReactNode }> = ({ tone = 'neutral', title, children }) => (
  <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap ${PILL[tone]}`}>{children}</span>
);

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; disabled?: boolean; title: string }> = ({ on, onChange, disabled, title }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={title} title={title} disabled={disabled} onClick={() => onChange(!on)}
    className="relative w-10 h-5 rounded-full shrink-0 transition-colors disabled:opacity-40"
    style={{ background: on ? 'rgb(var(--hv-success-strong))' : 'rgb(var(--hv-line))' }}>
    {/* same switch as the Doors page's door enable */}
    <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: on ? 22 : 2 }} />
  </button>
);

/** A row of choice buttons (the Elevator settings pattern). */
function Seg<T extends string | number | null>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1">
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" onClick={() => onChange(v)}
          className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors ${value === v ? 'bg-hv-success-tint-strong border-hv-success text-hv-success-text' : 'border-hv-line text-hv-text-2 hover:bg-hv-contrast/5'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

const anyNum = (v: string) => (v === '' ? null : Number(v));

const ChannelSelect: React.FC<{ kind: 'relay' | 'opto'; value: any; onChange: (v: number | null) => void; names: NameCtx; allowAny?: boolean }> = ({ kind, value, onChange, names, allowAny }) => (
  <select className={sel} value={value === null || value === undefined ? '' : String(value)} onChange={e => onChange(anyNum(e.target.value))}>
    {allowAny && <option value="">Any {kind === 'relay' ? 'relay' : 'opto input'}</option>}
    {CH8.map(ch => <option key={ch} value={ch}>{kind === 'relay' ? relayLabel(ch, names) : optoLabel(ch, names)}</option>)}
  </select>
);
const ZoneSelect: React.FC<{ value: any; onChange: (v: number | null) => void; names: NameCtx; allowAny?: boolean }> = ({ value, onChange, names, allowAny }) => (
  <select className={sel} value={value === null || value === undefined ? '' : String(value)} onChange={e => onChange(anyNum(e.target.value))}>
    {allowAny && <option value="">Any zone</option>}
    {ZONES.map(z => <option key={z} value={z}>{zoneLabel(z, names)}</option>)}
  </select>
);
const DaysPicker: React.FC<{ days: number[]; onChange: (d: number[]) => void }> = ({ days, onChange }) => (
  <div className="flex flex-wrap gap-1">
    {[1, 2, 3, 4, 5, 6, 0].map(d => {
      const on = days.includes(d);
      return (
        <button key={d} type="button" onClick={() => onChange(on ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b))}
          className={`w-10 py-1 rounded-md text-xs font-semibold border ${on ? 'bg-hv-info/20 border-hv-info text-hv-text' : 'border-hv-line text-hv-text-3 hover:bg-hv-contrast/5'}`}>
          {DAY_SHORT[d]}
        </button>
      );
    })}
  </div>
);

/* ───────────────────────── summary strip ───────────────────────── */

const Tile: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'normal' | 'bad' }> = ({ label, value, sub, tone = 'normal' }) => (
  <div className={`rounded-lg border px-4 py-3 bg-hv-surface/55 ${tone === 'bad' ? 'border-hv-error-hover' : 'border-hv-line'}`}>
    <div className="text-[11px] text-hv-text-3">{label}</div>
    <div className="text-2xl font-bold font-mono mt-0.5 text-hv-text">{value}</div>
    {sub && <div className={`text-[11px] mt-0.5 truncate ${tone === 'bad' ? 'text-hv-error-fg' : 'text-hv-text-3'}`}>{sub}</div>}
  </div>
);

const SummaryStrip: React.FC<{ rules: AutomationRule[]; stats: EngineStats | null; engine: Engine; firings: FiringEntry[] }> = ({ rules, stats, engine, firings }) => {
  const enabled = rules.filter(r => r.enabled !== false).length;
  const errors = stats?.errorsToday ?? firings.filter(f => !f.ok && !f.skipped && new Date(f.ts).toDateString() === new Date().toDateString()).length;
  const fired = stats?.firedToday ?? firings.filter(f => new Date(f.ts).toDateString() === new Date().toDateString()).length;
  const engineTone: Tone = engine === 'running' ? 'good' : engine === 'loading' ? 'neutral' : 'bad';
  const engineText = engine === 'running' ? 'Engine running' : engine === 'loading' ? 'Connecting…' : engine === 'unavailable' ? 'Engine not initialized' : 'Pi offline';
  const seen = stats?.eventsSeen || {};
  return (
    <section className="rounded-xl border border-hv-line bg-hv-widget/50 p-4 space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Rules" value={rules.length} sub={`${rules.length - enabled} off`} />
        <Tile label="Enabled" value={enabled} sub={enabled ? 'listening for events' : 'nothing will fire'} />
        <Tile label="Fired today" value={fired} sub={stats?.lastTriggerAt ? `last ${timeAgo(stats.lastTriggerAt)}` : 'not yet'} />
        <Tile label="Errors today" value={errors} tone={errors ? 'bad' : 'normal'} sub={stats?.errorsTotal ? `${stats.errorsTotal} since start` : 'none'} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Pill tone={engineTone}><span className="w-1.5 h-1.5 rounded-full bg-current" />{engineText}</Pill>
        {engine === 'running' && (
          <>
            <span className="text-hv-text-3 ml-1">Events seen:</span>
            {FEEDS.map(f => {
              const s = seen[f.key];
              return (
                <Pill key={f.key} tone={s && s.count ? 'info' : 'neutral'}
                  title={s && s.count ? `${s.count} ${f.label.toLowerCase()} events since the Pi started, last ${timeAgo(s.lastAt)}` : `No ${f.label.toLowerCase()} events since the Pi started`}>
                  {f.label} {s && s.count ? s.count : '–'}
                </Pill>
              );
            })}
          </>
        )}
      </div>
      {engine === 'running' && (
        <p className="text-[11px] text-hv-text-3">
          Opto and EOL zone changes are read only while an Aether page is open (no extra I2C traffic otherwise), so opto / zone rules fire while someone is connected.
        </p>
      )}
    </section>
  );
};

/* ───────────────────────── rule card ───────────────────────── */

const TRIGGER_ICON: Record<string, React.ReactNode> = Object.fromEntries(TRIGGERS.map(t => [t.type, t.icon]));

const RuleCard: React.FC<{
  rule: AutomationRule; names: NameCtx; busy: boolean; disabled: boolean;
  onToggle: (r: AutomationRule, on: boolean) => void; onRun: (r: AutomationRule) => void;
  onEdit: (r: AutomationRule) => void; onDuplicate: (r: AutomationRule) => void; onDelete: (r: AutomationRule) => void;
}> = ({ rule, names, busy, disabled, onToggle, onRun, onEdit, onDuplicate, onDelete }) => {
  const s = ruleSentence(rule, names);
  const st = rule.stats || {};
  const on = rule.enabled !== false;
  const tType = rule.trigger?.type || 'legacy';
  const touchesSwitch = (rule.actions || []).some(a => a?.type === 'switch_port');
  const everyWrite = firesOnEveryGpioWrite(rule);
  const legacy = !everyWrite && (tType === 'legacy' || (rule.actions || []).some(a => a?.type === 'gpio' || a?.type === 'gpio_pulse'));
  return (
    <div className={`rounded-xl border bg-hv-widget/50 transition-colors ${on ? 'border-hv-line' : 'border-hv-line opacity-70'}`}>
      <div className="flex items-start gap-3 px-4 pt-3">
        <div className="pt-1"><Toggle on={on} disabled={disabled || busy} onChange={v => onToggle(rule, v)} title={on ? 'Disable this rule' : 'Enable this rule'} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-bold text-hv-text truncate" title={rule.id}>{rule.name}</h4>
            <Pill tone="brand" title="Priority: higher runs first">P{rule.priority}</Pill>
            {on ? <Pill tone="good">On</Pill> : <Pill>Off</Pill>}
            {touchesSwitch && <Pill tone="info"><Network size={11} /> switch</Pill>}
            {everyWrite && <Pill tone="bad" title="Saved without a trigger: the original matcher runs it on every Raspberry Pi GPIO write Aether makes. Edit it and pick a trigger to change that.">
              <AlertTriangle size={11} /> fires on every Pi GPIO write (legacy)</Pill>}
            {legacy && <Pill tone="warn" title="Uses the original Pi GPIO trigger or actions">Pi GPIO</Pill>}
            {rule.disabledReason && !on && <Pill tone="bad" title={rule.disabledReason}>auto-disabled</Pill>}
          </div>
          {rule.description && <p className="text-xs text-hv-text-2 mt-0.5">{rule.description}</p>}
        </div>
        <div className="flex items-center shrink-0 -mr-1">
          <IconBtn title={on ? 'Run now (skips WHEN / IF)' : 'Enable the rule to run it'} onClick={() => onRun(rule)} disabled={disabled || busy || !on}><Play size={15} /></IconBtn>
          <IconBtn title="Edit" onClick={() => onEdit(rule)} disabled={disabled}><Pencil size={15} /></IconBtn>
          <IconBtn title="Duplicate" onClick={() => onDuplicate(rule)} disabled={disabled}><Copy size={15} /></IconBtn>
          <IconBtn title="Delete" danger onClick={() => onDelete(rule)} disabled={disabled || busy}><Trash2 size={15} /></IconBtn>
        </div>
      </div>
      <div className="px-4 py-3 text-sm leading-6">
        <div className="flex gap-2">
          <span className="w-12 shrink-0 text-[10px] font-bold tracking-wider text-hv-brand-fg pt-1">WHEN</span>
          <span className="text-hv-text flex items-center gap-1.5 min-w-0"><span className="text-hv-text-3 shrink-0">{TRIGGER_ICON[tType] || <Radio size={14} />}</span><span className="min-w-0">{s.when}</span></span>
        </div>
        {s.ifs.length > 0 && (
          <div className="flex gap-2">
            <span className="w-12 shrink-0 text-[10px] font-bold tracking-wider text-hv-info-fg pt-1">IF</span>
            <span className="text-hv-text-2">{s.ifs.join(' and ')}</span>
          </div>
        )}
        <div className="flex gap-2">
          <span className="w-12 shrink-0 text-[10px] font-bold tracking-wider text-hv-success-fg pt-1">THEN</span>
          <ol className="text-hv-text-2 min-w-0">
            {s.then.map((t, i) => (
              <li key={i} className="flex items-start gap-1.5"><ArrowRight size={12} className="mt-1.5 shrink-0 text-hv-text-3" /><span>{t}</span></li>
            ))}
          </ol>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-hv-line text-[11px] text-hv-text-3">
        <span>Last fired <span className="text-hv-text-2">{timeAgo(st.lastExecuted)}</span></span>
        <span>Runs <span className="font-mono text-hv-text-2">{st.executions || 0}</span></span>
        <span>Errors <span className={`font-mono ${st.errors ? 'text-hv-error-fg' : 'text-hv-text-2'}`}>{st.errors || 0}</span></span>
        {!!st.skipped && <span title="Skipped by the loop guard (already running, or firing too often)">Skipped <span className="font-mono text-hv-warning-fg">{st.skipped}</span></span>}
        <span className="font-mono truncate ml-auto" title="Rule ID (what the API and scenario scripts use)">{rule.id}</span>
      </div>
      {rule.disabledReason && !on && (
        <div className="px-4 pb-2 -mt-1 text-[11px] text-hv-error-fg flex items-start gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{rule.disabledReason}. Fix the rule, then turn it back on.</div>
      )}
      {st.lastError && (
        <div className="px-4 pb-2 -mt-1 text-[11px] text-hv-error-fg flex items-start gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{st.lastError}</div>
      )}
    </div>
  );
};

/* ───────────────────────── recent firings ───────────────────────── */

const FiringsLog: React.FC<{ entries: FiringEntry[]; available: boolean }> = ({ entries, available }) => (
  <section className="rounded-xl border border-hv-line bg-hv-widget/50">
    <div className="px-4 py-2.5 border-b border-hv-line flex items-center justify-between">
      <div className="text-[10px] font-bold uppercase tracking-wider text-hv-text-3">Recent firings</div>
      <span className="text-[11px] text-hv-text-3">{entries.length ? `${entries.length} shown` : ''}</span>
    </div>
    <div className="max-h-[560px] overflow-y-auto divide-y divide-hv-line/60">
      {!available ? (
        <p className="px-4 py-6 text-xs text-hv-text-3 text-center">This Pi does not report firings yet (update the backend).</p>
      ) : entries.length === 0 ? (
        <p className="px-4 py-6 text-xs text-hv-text-3 text-center">Nothing has fired since the Pi started.</p>
      ) : entries.map((e, i) => {
        const tone = e.skipped ? 'text-hv-warning-fg' : e.ok ? 'text-hv-success-fg' : 'text-hv-error-fg';
        return (
          <div key={`${e.ts}-${e.ruleId}-${i}`} className="px-4 py-2 text-[11px] leading-5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono tabular-nums text-hv-text-3 shrink-0">{clock(e.ts)}</span>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 bg-current ${tone}`} />
              <span className="font-semibold text-hv-text truncate">{e.ruleName || e.ruleId}</span>
              {typeof e.durationMs === 'number' && <span className="ml-auto shrink-0 font-mono text-hv-text-3">{fmtMs(e.durationMs)}</span>}
            </div>
            <div className="pl-[62px] text-hv-text-2 truncate" title={e.cause}>{e.cause}</div>
            {e.error && <div className={`pl-[62px] ${tone}`}>{e.error}</div>}
            {(e.messages || []).map((m, j) => <div key={j} className="pl-[62px] text-hv-text-3 truncate">“{m}”</div>)}
          </div>
        );
      })}
    </div>
  </section>
);

/* ───────────────────────── editor: WHEN ───────────────────────── */

const TriggerEditor: React.FC<{
  trigger: Draft['trigger']; onChange: (t: Draft['trigger']) => void; names: NameCtx;
  doors: any[]; readers: WiegandReaderLite[];
}> = ({ trigger: tr, onChange, names, doors, readers }) => {
  const up = (patch: any) => onChange({ ...tr, ...patch });
  const list = TRIGGERS.filter(t => !t.hidden || t.type === tr.type);
  const info = TRIGGERS.find(t => t.type === tr.type);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {tr.type === 'legacy' && (
          <button type="button" className="px-2.5 py-1.5 rounded-md text-xs font-semibold border bg-hv-warning-tint border-hv-warning text-hv-warning-fg">Original rule</button>
        )}
        {list.map(t => (
          <button key={t.type} type="button" title={t.hint} onClick={() => tr.type !== t.type && onChange(triggerDefaults(t.type))}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors ${tr.type === t.type ? 'bg-hv-brand-tint border-hv-brand text-hv-text' : 'border-hv-line text-hv-text-2 hover:bg-hv-contrast/5'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      {info && <p className="text-[11px] text-hv-text-3">{info.hint}.</p>}

      {(tr.type === 'opto_change' || tr.type === 'relay_change') && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={tr.type === 'opto_change' ? 'Input' : 'Relay'}>
            <ChannelSelect kind={tr.type === 'opto_change' ? 'opto' : 'relay'} value={tr.channel} onChange={v => up({ channel: v })} names={names} allowAny />
          </Field>
          <Field label="Changes to">
            <Seg value={tr.value ?? null} onChange={v => up({ value: v })}
              options={tr.type === 'opto_change' ? [[1, 'Active'], [0, 'Idle'], [null, 'Either']] : [[1, 'ON'], [0, 'OFF'], [null, 'Either']]} />
          </Field>
        </div>
      )}

      {tr.type === 'zone_change' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Zone"><ZoneSelect value={tr.zone} onChange={v => up({ zone: v })} names={names} allowAny /></Field>
          <Field label="Goes to">
            <Seg value={tr.state ?? null} onChange={v => up({ state: v })} options={[...ZONE_STATES.map(s => [s, s] as [string, string]), [null, 'Any change']]} />
          </Field>
        </div>
      )}

      {tr.type === 'door_event' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Door">
            <select className={sel} value={tr.doorId === null || tr.doorId === undefined ? '' : String(tr.doorId)} onChange={e => up({ doorId: anyNum(e.target.value) })}>
              <option value="">Any door</option>
              {doors.map(d => <option key={d.id} value={d.id}>{d.name || `Door ${d.id}`}{d.enabled === false ? ' (disabled)' : ''}</option>)}
              {isSet(tr.doorId) && !doors.some(d => Number(d.id) === Number(tr.doorId)) && <option value={tr.doorId}>Door {tr.doorId} (not in saved config)</option>}
            </select>
          </Field>
          <Field label="What">
            <select className={sel} value={tr.event || 'any'} onChange={e => up({ event: e.target.value, value: ['card', 'event', 'any'].includes(e.target.value) ? null : (tr.value ?? 1) })}>
              <option value="lock">Lock</option><option value="dps">DPS (door position)</option><option value="rexIn">REX</option>
              <option value="input">Custom input</option><option value="card">Card presented</option><option value="event">Event started</option><option value="any">Anything</option>
            </select>
          </Field>
          {!['card', 'event', 'any'].includes(tr.event) && (
            <Field label="Becomes">
              <Seg value={tr.value ?? null} onChange={v => up({ value: v })}
                options={[[1, DOOR_EVENT_WORDS[tr.event]?.on || 'on'], [0, DOOR_EVENT_WORDS[tr.event]?.off || 'off'], [null, 'Either'], ...(tr.event === 'lock' || tr.event === 'input' ? [['fault', 'Zone fault'] as [any, string]] : [])]} />
            </Field>
          )}
          {doors.length === 0 && <p className="sm:col-span-3 text-[11px] text-hv-warning-fg">No saved door config was found. Save doors on the Doors page to pick one by name.</p>}
        </div>
      )}

      {tr.type === 'card_read' && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Source">
            <select className={sel} value={tr.source || 'any'} onChange={e => up({ source: e.target.value })}>
              <option value="any">Any</option><option value="osdp">OSDP</option><option value="wiegand">Wiegand</option><option value="nfc">NFC</option>
            </select>
          </Field>
          <Field label="Reader (optional)">
            <select className={sel} value={tr.readerId ?? ''} onChange={e => up({ readerId: e.target.value || null })}>
              <option value="">Any reader</option>
              {readers.map(r => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
              {isSet(tr.readerId) && !readers.some(r => r.id === tr.readerId) && <option value={tr.readerId}>{tr.readerId}</option>}
            </select>
          </Field>
          <Field label="FC (optional)"><input className={inp} type="number" min={0} value={tr.facility ?? ''} onChange={e => up({ facility: anyNum(e.target.value) })} placeholder="any" /></Field>
          <Field label="Card (optional)"><input className={inp} value={tr.card ?? ''} onChange={e => up({ card: e.target.value.trim() || null })} placeholder="any" /></Field>
        </div>
      )}

      {tr.type === 'schedule' && (
        <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3 items-end">
          <Field label="Time"><input type="time" className={inp} value={tr.time || ''} onChange={e => up({ time: e.target.value })} /></Field>
          <Field label="Days (none = every day)"><DaysPicker days={Array.isArray(tr.days) ? tr.days : []} onChange={d => up({ days: d })} /></Field>
        </div>
      )}

      {tr.type === 'gpio_change' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pi GPIO pin (BCM)"><input type="number" min={0} max={27} className={inp} value={tr.pin ?? ''} onChange={e => up({ pin: e.target.value === '' ? null : parseInt(e.target.value) })} placeholder="choose" /></Field>
          <Field label="Goes"><Seg value={Number(tr.value) === 0 ? 0 : 1} onChange={v => up({ value: v })} options={[[1, 'HIGH'], [0, 'LOW']]} /></Field>
          <p className="col-span-2 text-[11px] text-hv-text-3">Fires when Aether itself writes this Raspberry Pi pin (gpioset). HAT relays and optos are the Relay / Opto triggers.</p>
        </div>
      )}

      {tr.type === 'manual' && <p className="text-[11px] text-hv-text-3">Nothing fires this automatically. Use Run now on the rule card, or POST /api/automation/rules/&lt;id&gt;/run from a script.</p>}
      {tr.type === 'legacy' && (
        <p className="text-[11px] text-hv-warning-fg">This rule was saved without a trigger and keeps its original matching (it fires on every Pi GPIO write that matches its conditions). Pick a trigger above to change that.</p>
      )}
    </div>
  );
};

/* ───────────────────────── editor: IF ───────────────────────── */

const ConditionRow: React.FC<{ c: CondDraft; names: NameCtx; onChange: (c: CondDraft) => void; onRemove: () => void }> = ({ c, names, onChange, onRemove }) => {
  const up = (patch: any) => onChange({ ...c, ...patch });
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-hv-line bg-hv-surface/40 p-2.5">
      <Field label="Check" className="w-40">
        <select className={sel} value={c.type} onChange={e => onChange({ ...newCondition(e.target.value), _k: c._k })}>
          {CONDITIONS.map(o => <option key={o.type} value={o.type}>{o.label}</option>)}
          {!CONDITIONS.some(o => o.type === c.type) && <option value={c.type}>{c.type || 'original filter'}</option>}
        </select>
      </Field>
      {(c.type === 'relay_state' || c.type === 'opto_state') && (
        <>
          <Field label={c.type === 'relay_state' ? 'Relay' : 'Input'} className="flex-1 min-w-[180px]">
            <ChannelSelect kind={c.type === 'relay_state' ? 'relay' : 'opto'} value={c.channel} onChange={v => up({ channel: v ?? 0 })} names={names} />
          </Field>
          <Field label="State"><Seg value={Number(c.value) === 0 ? 0 : 1} onChange={v => up({ value: v })} options={c.type === 'relay_state' ? [[1, 'ON'], [0, 'OFF']] : [[1, 'Active'], [0, 'Idle']]} /></Field>
        </>
      )}
      {c.type === 'zone_state' && (
        <>
          <Field label="Zone" className="flex-1 min-w-[160px]"><ZoneSelect value={c.zone} onChange={v => up({ zone: v ?? 1 })} names={names} /></Field>
          <Field label="State"><select className={sel} value={c.state} onChange={e => up({ state: e.target.value })}>{ZONE_STATES.map(s => <option key={s}>{s}</option>)}</select></Field>
        </>
      )}
      {c.type === 'time_window' && (
        <>
          <Field label="From" className="w-28"><input type="time" className={inp} value={c.from || ''} onChange={e => up({ from: e.target.value })} /></Field>
          <Field label="To" className="w-28"><input type="time" className={inp} value={c.to || ''} onChange={e => up({ to: e.target.value })} /></Field>
        </>
      )}
      {c.type === 'days' && <Field label="Days" className="flex-1"><DaysPicker days={Array.isArray(c.days) ? c.days : []} onChange={d => up({ days: d })} /></Field>}
      {c.type === 'gpio_state' && <span className="text-xs text-hv-text-2 pb-2">{describeCondition(c, names)}</span>}
      <div className="ml-auto"><IconBtn title="Remove this check" danger onClick={onRemove}><Trash2 size={14} /></IconBtn></div>
    </div>
  );
};

/* ───────────────────────── editor: THEN ───────────────────────── */

const ActionRow: React.FC<{
  a: ActionDraft; index: number; count: number; names: NameCtx; profiles: SwitchProfileLite[]; readers: WiegandReaderLite[]; relayOk: boolean;
  onChange: (a: ActionDraft) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void;
}> = ({ a, index, count, names, profiles, readers, relayOk, onChange, onRemove, onMove }) => {
  const up = (patch: any) => onChange({ ...a, ...patch });
  const known = ACTIONS.some(o => o.type === a.type);
  const prof = profiles.find(p => p.id === a.profileId);
  return (
    <div className="rounded-lg border border-hv-line bg-hv-surface/40 p-2.5 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <span className="w-6 h-6 mb-1 rounded-full bg-hv-success-tint text-hv-success-fg text-[11px] font-bold flex items-center justify-center shrink-0">{index + 1}</span>
        <Field label="Do" className="w-48">
          <select className={sel} value={a.type} onChange={e => onChange(newAction(e.target.value, { profiles, readers }, a.delay))}>
            {ACTIONS.map(o => (
              <option key={o.type} value={o.type} disabled={(o.type === 'switch_port' && !profiles.length && a.type !== 'switch_port') || (o.type === 'wiegand_send' && !readers.length && a.type !== 'wiegand_send')}>
                {o.label}{o.type === 'switch_port' && !profiles.length ? ' (no switch profiles)' : ''}{o.type === 'wiegand_send' && !readers.length ? ' (no readers)' : ''}
              </option>
            ))}
            {!known && <option value={a.type}>{a.type} (kept as saved)</option>}
          </select>
        </Field>

        {(a.type === 'relay_set' || a.type === 'relay_pulse') && (
          <Field label="Relay" className="flex-1 min-w-[180px]"><ChannelSelect kind="relay" value={a.channel} onChange={v => up({ channel: v ?? 0 })} names={names} /></Field>
        )}
        {a.type === 'relay_set' && (
          <>
            <Field label="Turn"><Seg value={Number(a.value) === 0 ? 0 : 1} onChange={v => up({ value: v })} options={[[1, 'ON'], [0, 'OFF']]} /></Field>
            <Field label="Set back after (ms, 0 = stay)" className="w-44"><input type="number" min={0} className={inp} value={a.duration ?? 0} onChange={e => up({ duration: Math.max(0, parseInt(e.target.value) || 0) })} /></Field>
          </>
        )}
        {a.type === 'relay_pulse' && (
          <Field label="For (ms)" className="w-28"><input type="number" min={1} className={inp} value={a.duration ?? 500} onChange={e => up({ duration: Math.max(1, parseInt(e.target.value) || 500) })} /></Field>
        )}

        {(a.type === 'gpio' || a.type === 'gpio_pulse') && (
          <Field label="Pi GPIO pin (BCM)" className="w-36"><input type="number" min={0} max={27} className={inp} value={a.pin ?? ''} onChange={e => up({ pin: e.target.value === '' ? null : parseInt(e.target.value) })} placeholder="choose" /></Field>
        )}
        {a.type === 'gpio' && <Field label="Level"><Seg value={Number(a.value) === 0 ? 0 : 1} onChange={v => up({ value: v })} options={[[1, 'HIGH'], [0, 'LOW']]} /></Field>}
        {a.type === 'gpio_pulse' && (
          <Field label="For (ms)" className="w-28"><input type="number" min={1} className={inp} value={a.duration ?? 300} onChange={e => up({ duration: Math.max(1, parseInt(e.target.value) || 300) })} /></Field>
        )}

        {a.type === 'switch_port' && (
          <>
            <Field label="Switch" className="w-40">
              <select className={sel} value={a.profileId} onChange={e => up({ profileId: e.target.value })}>
                {!prof && <option value={a.profileId}>{a.profileId || 'Choose…'}</option>}
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Port" className="w-40">
              <select className={sel} value={a.port} onChange={e => up({ port: parseInt(e.target.value) })}>
                {!prof && <option value={a.port}>Port {a.port}</option>}
                {Array.from({ length: prof?.portCount || 0 }, (_, i) => i + 1).map(n => {
                  const alias = prof?.portAliases?.[String(n)];
                  const denied = (prof?.denyPorts || []).includes(n);
                  // Protected ports stay listed (numbering looks right) but can't be picked; the backend refuses them anyway.
                  return <option key={n} value={n} disabled={denied}>Port {n}{alias ? ` — ${alias}` : ''}{denied ? ' (protected)' : ''}</option>;
                })}
              </select>
            </Field>
            <Field label="Make it"><Seg value={a.action === 'enable' ? 'enable' : 'disable'} onChange={v => up({ action: v })} options={[['disable', 'Down'], ['enable', 'Up']]} /></Field>
            {a.action !== 'enable' && (
              <Field label="For" className="w-44">
                <select className={sel} value={a.holdMs} onChange={e => up({ holdMs: parseInt(e.target.value) })}>
                  {SWITCH_HOLDS.map(h => <option key={h.ms} value={h.ms}>{h.label}</option>)}
                  {!SWITCH_HOLDS.some(h => h.ms === Number(a.holdMs)) && <option value={a.holdMs}>{fmtMs(Number(a.holdMs) || 0)}</option>}
                </select>
              </Field>
            )}
            <Field label="Reason" className="flex-1 min-w-[140px]"><input className={inp} value={a.reason || ''} onChange={e => up({ reason: e.target.value })} placeholder="CLC-004" /></Field>
          </>
        )}

        {a.type === 'wiegand_send' && (
          <>
            <Field label="Reader" className="w-44">
              <select className={sel} value={a.readerId} onChange={e => up({ readerId: e.target.value })}>
                {!readers.some(r => r.id === a.readerId) && <option value={a.readerId}>{a.readerId || 'Choose…'}</option>}
                {readers.map(r => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
              </select>
            </Field>
            <Field label="FC" className="w-24"><input type="number" min={0} className={inp} value={a.facility ?? ''} onChange={e => up({ facility: parseInt(e.target.value) })} /></Field>
            <Field label="Card" className="w-32"><input type="number" min={0} className={inp} value={a.card ?? ''} onChange={e => up({ card: parseInt(e.target.value) })} /></Field>
            <Field label="Format (bits / id)" className="w-32"><input className={inp} value={a.format ?? ''} placeholder="26" onChange={e => up({ format: e.target.value === '' ? null : (/^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value) })} /></Field>
          </>
        )}

        {a.type === 'delay' && (
          <Field label="Wait (ms)" className="w-32"><input type="number" min={0} className={inp} value={a.duration ?? 0} onChange={e => up({ duration: Math.max(0, parseInt(e.target.value) || 0) })} /></Field>
        )}
        {a.type === 'log' && (
          <Field label="Message" className="flex-1 min-w-[200px]"><input className={inp} value={a.message || ''} onChange={e => up({ message: e.target.value })} placeholder="Shown in Recent firings and the Pi log" /></Field>
        )}
        {!known && <span className="text-xs text-hv-text-3 pb-2">Saved as is; this page does not edit it.</span>}

        <div className="ml-auto flex items-center">
          <IconBtn title="Move up" onClick={() => onMove(-1)} disabled={index === 0}><span className="text-sm">↑</span></IconBtn>
          <IconBtn title="Move down" onClick={() => onMove(1)} disabled={index === count - 1}><span className="text-sm">↓</span></IconBtn>
          <IconBtn title="Remove this action" danger onClick={onRemove}><Trash2 size={14} /></IconBtn>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-8 text-[11px] text-hv-text-3">
        <span>Wait first</span>
        <input type="number" min={0} className="w-24 rounded-md px-2 py-1 text-xs border border-hv-line bg-hv-surface text-hv-text" value={a.delay || 0} onChange={e => up({ delay: Math.max(0, parseInt(e.target.value) || 0) })} />
        <span>ms</span>
        {a.type === 'relay_set' && Number(a.duration) > 0 && <span>Then set back to the state it had before (left alone if that was unknown or something else changed it).</span>}
        {(a.type === 'relay_set' || a.type === 'relay_pulse') && !relayOk && <span className="text-hv-warning-fg">This Pi's engine cannot drive relays yet (update the backend).</span>}
        {(a.type === 'gpio' || a.type === 'gpio_pulse') && <span className="text-hv-warning-fg">Drives a Raspberry Pi pin, not a HAT relay.</span>}
      </div>
      {a.type === 'switch_port' && a.action !== 'enable' && Number(a.holdMs) === 0 && (
        <p className="pl-8 text-[11px] text-hv-warning-fg flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          Nothing will bring this port back. A scheduled run that crashes leaves it down permanently: pick a duration unless you mean to decommission the port.
        </p>
      )}
      {a.type === 'switch_port' && a.action !== 'enable' && Number(a.holdMs) > 0 && (
        <p className="pl-8 text-[11px] text-hv-text-3">The port restores itself after the hold, even if Aether restarts. Do not add a second rule to bring it back.</p>
      )}
    </div>
  );
};

/* ───────────────────────── editor (modal) ───────────────────────── */

const Step: React.FC<{ word: string; tone: string; title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ word, tone, title, right, children }) => (
  <section className="rounded-xl border border-hv-line bg-hv-widget/50">
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-hv-line">
      <span className={`text-[11px] font-black tracking-widest ${tone}`}>{word}</span>
      <span className="text-sm font-semibold text-hv-text flex-1">{title}</span>
      {right}
    </div>
    <div className="p-4">{children}</div>
  </section>
);

const RuleEditor: React.FC<{
  draft: Draft; setDraft: (fn: (d: Draft) => Draft) => void; names: NameCtx; doors: any[]; readers: WiegandReaderLite[];
  profiles: SwitchProfileLite[]; takenIds: string[]; relayOk: boolean; saving: boolean; onSave: () => void; onClose: () => void;
}> = ({ draft: d, setDraft, names, doors, readers, profiles, takenIds, relayOk, saving, onSave, onClose }) => {
  const problems = draftProblems(d, takenIds);
  const preview = ruleSummaryText(draftToRule(d), names);
  const set = (patch: Partial<Draft>) => setDraft(x => ({ ...x, ...patch }));
  const autoId = !d.originalId && !d.id ? slugify(d.name) : d.id;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/70 overflow-y-auto" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-4xl rounded-2xl border border-hv-line-strong bg-hv-widget-panel text-hv-text shadow-hv-3">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-hv-line">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-hv-text-3">{d.originalId ? 'Edit rule' : 'New rule'}</div>
            <div className="text-base font-bold truncate">{d.name || 'Untitled rule'}</div>
          </div>
          <IconBtn title="Close" onClick={onClose}><X size={18} /></IconBtn>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
            <Field label="Name" className="sm:col-span-3">
              <input autoFocus className={inp} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="Door held: sound the buzzer" />
            </Field>
            <Field label={d.originalId ? 'Rule ID (fixed)' : 'Rule ID (from the name)'} className="sm:col-span-2">
              <input className={`${inp} font-mono`} value={autoId} disabled={!!d.originalId} onChange={e => set({ id: e.target.value })} placeholder="door-held-buzzer" />
            </Field>
            <Field label="Priority (high first)">
              <input type="number" min={0} max={100} className={inp} value={d.priority} onChange={e => set({ priority: Number.isFinite(parseInt(e.target.value)) ? parseInt(e.target.value) : 5 })} />
            </Field>
            <Field label="Description (optional)" className="sm:col-span-5">
              <input className={inp} value={d.description} onChange={e => set({ description: e.target.value })} placeholder="What this rule is for" />
            </Field>
            <div className="flex items-end pb-1.5 gap-2">
              <Toggle on={d.enabled} onChange={v => set({ enabled: v })} title="Enabled" />
              <span className="text-xs text-hv-text-2">{d.enabled ? 'Enabled' : 'Off'}</span>
            </div>
          </div>

          <Step word="WHEN" tone="text-hv-brand-fg" title="What starts the rule">
            <TriggerEditor trigger={d.trigger} onChange={t => set({ trigger: t })} names={names} doors={doors} readers={readers} />
          </Step>

          <Step word="IF" tone="text-hv-info-fg" title="Only when all of these are true (optional)"
            right={d.trigger.type !== 'legacy' && (
              <button type="button" onClick={() => setDraft(x => ({ ...x, conditions: [...x.conditions, newCondition('relay_state')] }))}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold border border-hv-line text-hv-text-2 hover:bg-hv-contrast/5"><Plus size={13} /> Add check</button>
            )}>
            {d.trigger.type === 'legacy' ? (
              <p className="text-[11px] text-hv-text-3">The original rule's conditions are kept as saved.</p>
            ) : d.conditions.length === 0 ? (
              <p className="text-[11px] text-hv-text-3">No checks: the rule runs every time the WHEN happens. Relay / opto / zone checks use the last state the Pi saw; a state it has not seen yet counts as not met.</p>
            ) : (
              <div className="space-y-2">
                {d.conditions.map(c => (
                  <ConditionRow key={c._k} c={c} names={names}
                    onChange={nc => setDraft(x => ({ ...x, conditions: x.conditions.map(y => (y._k === c._k ? nc : y)) }))}
                    onRemove={() => setDraft(x => ({ ...x, conditions: x.conditions.filter(y => y._k !== c._k) }))} />
                ))}
              </div>
            )}
          </Step>

          <Step word="THEN" tone="text-hv-success-fg" title="Do these, in order"
            right={
              <button type="button" onClick={() => setDraft(x => ({ ...x, actions: [...x.actions, newAction('relay_pulse', { profiles, readers })] }))}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold border border-hv-success/50 bg-hv-success-tint text-hv-success-fg hover:bg-hv-success-tint-strong"><Plus size={13} /> Add action</button>
            }>
            {d.actions.length === 0 ? (
              <p className="text-[11px] text-hv-error-fg">Add at least one action.</p>
            ) : (
              <div className="space-y-2">
                {d.actions.map((a, i) => (
                  <ActionRow key={a._k} a={a} index={i} count={d.actions.length} names={names} profiles={profiles} readers={readers} relayOk={relayOk}
                    onChange={na => setDraft(x => ({ ...x, actions: x.actions.map(y => (y._k === a._k ? na : y)) }))}
                    onRemove={() => setDraft(x => ({ ...x, actions: x.actions.filter(y => y._k !== a._k) }))}
                    onMove={dir => setDraft(x => {
                      const arr = x.actions.slice(); const j = i + dir;
                      if (j < 0 || j >= arr.length) return x;
                      [arr[i], arr[j]] = [arr[j], arr[i]];
                      return { ...x, actions: arr };
                    })} />
                ))}
              </div>
            )}
          </Step>

          <div className="rounded-lg border border-hv-line bg-hv-surface/55 px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-hv-text-3 mb-1">In plain words</div>
            <p className="text-sm text-hv-text-2">{preview}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-t border-hv-line">
          <div className="flex-1 min-w-0 text-[11px] text-hv-error-fg">{problems[0] || ''}</div>
          <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-md text-sm font-semibold border border-hv-line text-hv-text-2 hover:bg-hv-contrast/5">Cancel</button>
          <button type="button" onClick={onSave} disabled={saving || problems.length > 0}
            className="px-4 py-1.5 rounded-md text-sm font-semibold border border-hv-success bg-hv-success-tint-strong text-hv-success-text disabled:opacity-40">
            {saving ? 'Saving…' : d.originalId ? 'Save rule' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ───────────────────────── page ───────────────────────── */

const NO_ITEMS: any[] = [];   // stable default, so the name map is not rebuilt on every render

const AutomationSection: React.FC<AutomationSectionProps> = ({
  ipAddress, connected, inputs, outputs, controllerOutputs, doors: doorsProp = NO_ITEMS, readers: readersProp = NO_ITEMS, logSystem,
}) => {
  const base = `http://${ipAddress}:3001`;
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [firings, setFirings] = useState<FiringEntry[]>([]);
  const [logAvailable, setLogAvailable] = useState(true);
  const [engine, setEngine] = useState<Engine>('loading');
  const [profiles, setProfiles] = useState<SwitchProfileLite[]>([]);
  const [savedDoors, setSavedDoors] = useState<any[] | null>(null);
  const [wReaders, setWReaders] = useState<WiegandReaderLite[]>([]);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<'all' | 'on' | 'off'>('all');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const polling = useRef(false);   // (review fix) a slow Pi never gets overlapping polls
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try { await refreshOnce(); } finally { polling.current = false; }
  }, [base]);   // eslint-disable-line react-hooks/exhaustive-deps
  const refreshOnce = async () => {
    try {
      const data = await fetchJson(`${base}/api/automation/rules`);
      if (!alive.current) return;
      if (Array.isArray(data.rules)) setRules(data.rules);
      setEngine('running');
    } catch (e: any) {
      if (!alive.current) return;
      setEngine(e?.status === 503 ? 'unavailable' : 'offline');
      return;
    }
    await Promise.allSettled([
      fetchJson(`${base}/api/automation/stats`).then(d => alive.current && setStats(d.stats || null)).catch(() => {}),
      fetchJson(`${base}/api/automation/log?limit=60`)
        .then(d => { if (alive.current) { setFirings(Array.isArray(d.entries) ? d.entries : []); setLogAvailable(true); } })
        .catch((e: any) => { if (alive.current && e?.status === 404) setLogAvailable(false); }),
    ]);
  };

  // Pickers: switch profiles, saved doors (names + I/O), Wiegand readers. Loaded once per Pi.
  const loadPickers = useCallback(() => {
    fetchJson(`${base}/api/switch/status`).then(d => alive.current && setProfiles(Array.isArray(d.profiles) ? d.profiles : [])).catch(() => alive.current && setProfiles([]));
    fetchJson(`${base}/api/doors/config`).then(d => alive.current && setSavedDoors(Array.isArray(d?.config?.doors) ? d.config.doors : [])).catch(() => alive.current && setSavedDoors([]));
    fetchJson(`${base}/api/wiegand/readers`).then(d => alive.current && setWReaders(Array.isArray(d.readers) ? d.readers.map((r: any) => ({ id: String(r.id), name: r.name, door: r.door })) : [])).catch(() => alive.current && setWReaders([]));
  }, [base]);

  useEffect(() => {
    if (!connected) { setEngine('offline'); return; }
    setEngine('loading');
    refresh();
    loadPickers();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [connected, refresh, loadPickers]);

  const doors = savedDoors && savedDoors.length ? savedDoors : doorsProp;
  const readers: WiegandReaderLite[] = wReaders.length ? wReaders : (readersProp || []).map((r: any) => ({ id: String(r.id), name: r.name }));
  const names = useMemo(() => buildNames([inputs, outputs, controllerOutputs], doors, profiles), [inputs, outputs, controllerOutputs, doors, profiles]);
  const takenIds = useMemo(() => rules.map(r => r.id), [rules]);
  const relayOk = stats?.actionsAvailable ? !!stats.actionsAvailable.relay : true;

  const setDraft = useCallback((fn: (d: Draft) => Draft) => setDraftState(cur => (cur ? fn(cur) : cur)), []);
  const closeEditor = useCallback(() => setDraftState(null), []);
  const openNew = () => setDraftState(emptyDraft());
  const openEdit = useCallback((r: AutomationRule) => setDraftState(ruleToDraft(r)), []);
  const openDuplicate = useCallback((r: AutomationRule) => setDraftState(ruleToDraft(r, { copy: true, taken: takenIds })), [takenIds]);

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy(b => ({ ...b, [id]: true }));
    try { await fn(); } finally { if (alive.current) setBusy(b => { const n = { ...b }; delete n[id]; return n; }); }
  };

  const save = async () => {
    if (!draft) return;
    const problems = draftProblems(draft, takenIds);
    if (problems.length) { logSystem('error', problems[0]); return; }
    const rule = draftToRule(draft);
    setSaving(true);
    try {
      if (draft.originalId) await fetchJson(`${base}/api/automation/rules/${encodeURIComponent(draft.originalId)}`, jsonInit('PUT', rule));
      else await fetchJson(`${base}/api/automation/rules`, jsonInit('POST', rule));
      logSystem('success', `Rule "${rule.name}" ${draft.originalId ? 'updated' : 'created'}`);
      setDraftState(null);
      refresh();
    } catch (e: any) {
      logSystem('error', `Failed to save rule: ${e?.message || e}`);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  // The old page POSTed /rules/:id/toggle, which the backend never had. It has PATCH /enable and /disable.
  const toggle = useCallback((r: AutomationRule, on: boolean) => withBusy(r.id, async () => {
    setRules(rs => rs.map(x => (x.id === r.id ? { ...x, enabled: on } : x)));   // optimistic; the poll corrects it
    try {
      await fetchJson(`${base}/api/automation/rules/${encodeURIComponent(r.id)}/${on ? 'enable' : 'disable'}`, jsonInit('PATCH'));
      logSystem('info', `Rule "${r.name}" ${on ? 'enabled' : 'disabled'}`);
    } catch (e: any) {
      setRules(rs => rs.map(x => (x.id === r.id ? { ...x, enabled: !on } : x)));
      logSystem('error', `Failed to ${on ? 'enable' : 'disable'} rule: ${e?.message || e}`);
    }
    refresh();
  }), [base, refresh, logSystem]);

  const run = useCallback((r: AutomationRule) => withBusy(r.id, async () => {
    try {
      const res = await fetchJson(`${base}/api/automation/rules/${encodeURIComponent(r.id)}/run`, jsonInit('POST'), 20_000);
      if (res.running) logSystem('info', `Rule "${r.name}" started (still running its waits)`);
      else if (res.ok) logSystem('success', `Rule "${r.name}" ran`);
      else logSystem(res.skipped ? 'warn' : 'error', `Rule "${r.name}": ${res.error || 'failed'}`);
    } catch (e: any) {
      logSystem('error', e?.status === 404 && /Cannot POST/i.test(String(e?.message)) ? 'This Pi cannot run rules by hand yet (update the backend)' : `Run failed: ${e?.message || e}`);
    }
    refresh();
  }), [base, refresh, logSystem]);

  const remove = useCallback((r: AutomationRule) => {
    if (!window.confirm(`Delete the rule "${r.name}"? This cannot be undone.`)) return;
    withBusy(r.id, async () => {
      try {
        await fetchJson(`${base}/api/automation/rules/${encodeURIComponent(r.id)}`, jsonInit('DELETE'));
        logSystem('success', `Rule "${r.name}" deleted`);
        setRules(rs => rs.filter(x => x.id !== r.id));
      } catch (e: any) {
        logSystem('error', `Failed to delete rule: ${e?.message || e}`);
      }
      refresh();
    });
  }, [base, refresh, logSystem]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules
      .filter(r => (show === 'all' ? true : show === 'on' ? r.enabled !== false : r.enabled === false))
      .filter(r => !q || `${r.name} ${r.id} ${r.description || ''} ${ruleSummaryText(r, names)}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name));
  }, [rules, show, query, names]);

  const offline = !connected || engine === 'offline' || engine === 'unavailable';

  return (
    <div className="space-y-4">
      <SummaryStrip rules={rules} stats={stats} engine={connected ? engine : 'offline'} firings={firings} />

      {engine === 'unavailable' && (
        <div className="rounded-xl border border-hv-warning/50 bg-hv-warning-tint px-4 py-3 text-sm text-hv-warning-fg flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          The automation engine did not start on this Pi. Check the backend log for "[Automation]".
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="space-y-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-hv-text-3 mr-2">Rules</div>
            <Seg value={show} onChange={setShow} options={[['all', `All ${rules.length}`], ['on', 'On'], ['off', 'Off']]} />
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" />
              <input className={`${inp} pl-8`} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search rules" />
            </div>
            <button type="button" onClick={openNew} disabled={offline}
              className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-hv-brand hover:bg-hv-brand-hover text-hv-brand-text disabled:opacity-40">
              <Plus size={15} /> New rule
            </button>
          </div>

          {rules.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-hv-line bg-hv-widget/30 px-6 py-10 text-center">
              <div className="text-sm font-semibold text-hv-text mb-1">{offline ? 'Connect to a Pi to see its rules' : 'No rules yet'}</div>
              <p className="text-xs text-hv-text-3 max-w-md mx-auto mb-4">
                A rule watches for one thing (an opto input, a relay, an EOL zone, a door, a card or a time), checks anything else you need, then drives relays, switch ports or cards on its own.
              </p>
              {!offline && (
                <button type="button" onClick={openNew} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-hv-brand hover:bg-hv-brand-hover text-hv-brand-text">
                  <Plus size={15} /> Create the first rule
                </button>
              )}
            </div>
          ) : visible.length === 0 ? (
            <p className="text-xs text-hv-text-3 px-1 py-6 text-center">No rules match.</p>
          ) : (
            visible.map(r => (
              <RuleCard key={r.id} rule={r} names={names} busy={!!busy[r.id]} disabled={offline}
                onToggle={toggle} onRun={run} onEdit={openEdit} onDuplicate={openDuplicate} onDelete={remove} />
            ))
          )}
        </div>

        <FiringsLog entries={firings} available={logAvailable} />
      </div>

      {draft && (
        <RuleEditor draft={draft} setDraft={setDraft} names={names} doors={doors} readers={readers} profiles={profiles}
          takenIds={takenIds} relayOk={relayOk} saving={saving} onSave={save} onClose={closeEditor} />
      )}
    </div>
  );
};

// Exported for the page's tests (static render of a card and the editor).
export { RuleCard, RuleEditor };
export default AutomationSection;
