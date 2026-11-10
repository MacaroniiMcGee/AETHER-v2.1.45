// backend/automation/aegis.js — AETHER_AEGIS_AUTOMATION
//
// Pure helpers for the AEGIS automation page (Automation & Emulation for General
// Interactive Scenarios): how the events server.js already has are normalised for the
// rules, how a rule's WHEN (trigger) matches an event, and how its IF conditions are
// checked against the last known I/O state. No I/O, no timers: unit-tested directly.
//
// Event types fed by server.js (AutomationManager.ingest):
//   gpio_change   Pi GPIO written by holdLevel()            { pin, value }
//   relay_change  IOplus relay written (relayWriteHook)     { channel 0-7, value 0/1 }
//   opto_change   opto input changed (AETHER_OPTO_MONITOR)  { channel 0-7, value 0/1 }
//   zone_change   EOL zone changed (AETHER_ZONE_MONITOR)    { zone 1-8, channel, state, voltage }
//   door_event    door activity entry (doorActivity emit)   { doorId, role, value, text, source }
//   card_read     card sent / read (OSDP, Wiegand, NFC)     { source, readerId, facility, card }
//
// Trigger shapes (rule.trigger) — all fields other than type are optional filters:
//   { type:'relay_change'|'opto_change', channel, value }
//   { type:'zone_change', zone, state:'ALARM'|'NORMAL'|'TROUBLE'|'TAMPER'|'any' }
//   { type:'door_event', doorId, event:'lock'|'dps'|'rexIn'|'input'|'card'|'event'|'any', value }
//   { type:'card_read', source:'osdp'|'wiegand'|'nfc'|'any', facility, card, readerId }
//   { type:'gpio_change', pin, value }            (Pi GPIO, the original trigger)
//   { type:'reader_event', readerId }             (older page: a card on that reader)
//   { type:'schedule', time:'HH:MM', days }       (run by the scheduler, never by events)
//   { type:'manual' }                             (Run now only)
//
// Condition shapes (rule.conditions as an array, or { all: [...] }):
//   { type:'relay_state'|'opto_state', channel, value }
//   { type:'zone_state', zone, state }
//   { type:'gpio_state', pin, value }
//   { type:'time_window', from:'HH:MM', to:'HH:MM' }   (wraps midnight when from > to)
//   { type:'days', days:[0..6] }                       (0 = Sunday)

'use strict';

const EVENT_TYPES = ['gpio_change', 'relay_change', 'opto_change', 'zone_change', 'door_event', 'card_read'];
const ZONE_STATES = ['ALARM', 'NORMAL', 'TROUBLE', 'TAMPER'];
const DOOR_ROLES = ['lock', 'dps', 'rex', 'input', 'card', 'event', 'note'];

const isNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const bit = (v) => (v === true || Number(v) === 1 ? 1 : 0);
const given = (v) => v !== undefined && v !== null && v !== '' && v !== 'any';

// AETHER_AEGIS_AUTOMATION (review fix): longest wait / duration a rule may use (setTimeout overflows past 2^31-1 ms)
const MAX_MS = 24 * 3600 * 1000;

/** "7:05" / "07:05" -> "07:05"; anything else -> null. */
function normTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s === undefined || s === null ? '' : s).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** The structured value doorActivity passes with an entry (review fix 6): 0 / 1, a zone fault, or none. */
function doorValue(v) {
  if (v === 0 || v === 1) return v;
  if (v === true || v === false) return v ? 1 : 0;
  if (typeof v === 'string' && /^(TROUBLE|TAMPER)$/i.test(v)) return 'fault';
  return null;
}

/** Normalise what server.js hands over into one shape per event type. null = not an automation event. */
function normalizeEvent(type, data) {
  const d = data && typeof data === 'object' ? data : {};
  const initial = !!d.initial;
  switch (type) {
    case 'gpio_change':
      return { pin: Number(d.pin), value: bit(d.value), initial };
    case 'relay_change':
    case 'opto_change': {
      const ch = Number(d.channel ?? d.pin);
      if (!Number.isInteger(ch) || ch < 0 || ch > 7) return null;
      return { channel: ch, value: bit(d.value ?? d.state), initial };
    }
    case 'zone_change': {
      const zone = isNum(d.zone) ? Number(d.zone) : Number(d.channel ?? d.pin) + 1;
      if (!Number.isInteger(zone) || zone < 1 || zone > 8) return null;
      const state = String(d.supervisionState || d.state || 'UNKNOWN').toUpperCase();
      return { zone, channel: zone - 1, state, voltage: Number(d.voltage) || 0, initial };
    }
    case 'door_event': {
      // (review fix 6) value / initial / key come from doorActivity itself (no text parsing);
      // entries the Doors page POSTs (cards, events) carry no value.
      const doorId = Number(d.doorId);
      if (!Number.isInteger(doorId)) return null;
      const role = DOOR_ROLES.includes(d.kind) ? d.kind : (DOOR_ROLES.includes(d.role) ? d.role : 'note');
      const m = /:relay:(\d+)$/.exec(String(d.key || ''));   // a door terminal on HAT relay n (attribution)
      return { doorId, role, value: doorValue(d.value), text: String(d.text || ''), source: String(d.source || ''),
        relayChannel: m ? Number(m[1]) : null, initial };
    }
    case 'card_read':
      return {
        source: String(d.source || 'unknown').toLowerCase(),
        readerId: d.readerId !== undefined && d.readerId !== null ? String(d.readerId) : null,
        facility: isNum(d.facility) ? Number(d.facility) : null,
        card: d.card !== undefined && d.card !== null ? String(d.card) : (d.uid ? String(d.uid) : null),
        initial,
      };
    default:
      return null;
  }
}

/** Does a rule's WHEN match this (normalised) event? Schedule / manual never match events. */
function triggerMatches(trigger, type, ev) {
  if (!trigger || !trigger.type || !ev) return false;
  const tr = trigger;
  switch (tr.type) {
    case 'gpio_change':
      return type === 'gpio_change' && Number(tr.pin) === ev.pin && (!isNum(tr.value) || Number(tr.value) === ev.value);
    case 'relay_change':
    case 'opto_change':
      if (type !== tr.type) return false;
      if (isNum(tr.channel) && Number(tr.channel) !== ev.channel) return false;
      return !isNum(tr.value) || Number(tr.value) === ev.value;
    case 'zone_change':
      if (type !== 'zone_change') return false;
      if (isNum(tr.zone) && Number(tr.zone) !== ev.zone) return false;
      return !given(tr.state) || String(tr.state).toUpperCase() === ev.state;
    case 'door_event': {
      if (type !== 'door_event') return false;
      if (isNum(tr.doorId) && Number(tr.doorId) !== ev.doorId) return false;
      const role = tr.event === 'rexIn' ? 'rex' : (tr.event || tr.role);
      if (given(role) && role !== ev.role) return false;
      if (tr.value === 'fault') return ev.value === 'fault';
      return !isNum(tr.value) || Number(tr.value) === ev.value;
    }
    case 'card_read':
      if (type !== 'card_read') return false;
      if (given(tr.source) && String(tr.source).toLowerCase() !== ev.source) return false;
      if (given(tr.readerId) && String(tr.readerId) !== ev.readerId) return false;
      if (isNum(tr.facility) && Number(tr.facility) !== ev.facility) return false;
      return !given(tr.card) || String(tr.card) === ev.card;
    case 'reader_event':
      return type === 'card_read' && (!given(tr.readerId) || String(tr.readerId) === ev.readerId);
    default:
      return false;      // schedule, manual, unknown
  }
}

const hhmm = (s) => {
  const t = normTime(s);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null;
};

/** One IF condition against the last known state. Unknown state = not met (never guess). */
function conditionHolds(cond, state, now = new Date()) {
  if (!cond || typeof cond !== 'object') return false;
  if (!cond.type) return true;      // untyped entries are old-style event filters; the trigger already matched
  const st = state || {};
  switch (cond.type) {
    case 'relay_state':
    case 'opto_state': {
      const map = (cond.type === 'relay_state' ? st.relay : st.opto) || {};
      const v = map[Number(cond.channel)];
      return v !== undefined && v === bit(cond.value);
    }
    case 'gpio_state': {
      const v = (st.gpio || {})[Number(cond.pin)];
      return v !== undefined && v === bit(cond.value);
    }
    case 'zone_state': {
      const z = (st.zone || {})[Number(cond.zone)];
      return !!z && (!given(cond.state) || String(cond.state).toUpperCase() === z.state);
    }
    case 'time_window': {
      const from = hhmm(cond.from), to = hhmm(cond.to);
      if (from === null || to === null) return false;
      const cur = now.getHours() * 60 + now.getMinutes();
      return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
    }
    case 'days':
      return Array.isArray(cond.days) && cond.days.map(Number).map(d => (d === 7 ? 0 : d)).includes(now.getDay());
    default:
      return false;
  }
}

/** The IF list of a rule (array or { all: [...] }); schedule data and legacy objects give none. */
function conditionList(conditions) {
  if (Array.isArray(conditions)) return conditions;
  if (conditions && Array.isArray(conditions.all)) return conditions.all;
  return [];
}

/** Short text for the firing log: what happened. */
function describeEvent(type, ev) {
  if (!ev) return type;
  switch (type) {
    case 'gpio_change': return `Pi GPIO ${ev.pin} = ${ev.value}`;
    case 'relay_change': return `REL ${ev.channel + 1} ${ev.value ? 'ON' : 'OFF'}`;
    case 'opto_change': return `OPTO ${ev.channel + 1} ${ev.value ? 'ACTIVE' : 'idle'}`;
    case 'zone_change': return `ADC ${ev.zone} ${ev.state}`;
    case 'door_event': return `Door ${ev.doorId}: ${ev.text || ev.role}`;
    case 'card_read': return `Card ${ev.facility !== null ? `${ev.facility}:` : ''}${ev.card || '?'} (${ev.source}${ev.readerId ? ` ${ev.readerId}` : ''})`;
    default: return type;
  }
}

/** Wait (ms) before an action: the per-action "delay" field. */
function actionDelayMs(action) {
  const v = Number(action && action.delay);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_MS) : 0;
}

/** A delay action's length: params.duration (backend), .ms (older page), .msec. */
function delayParamMs(params) {
  const p = params || {};
  const v = p.duration ?? p.ms ?? p.msec;
  return isNum(v) ? Math.max(0, Number(v)) : null;
}

module.exports = {
  EVENT_TYPES, ZONE_STATES, DOOR_ROLES,
  MAX_MS, normTime, doorValue, normalizeEvent, triggerMatches, conditionHolds, conditionList,
  describeEvent, actionDelayMs, delayParamMs, hhmm,
};
