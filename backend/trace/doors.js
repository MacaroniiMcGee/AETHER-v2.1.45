// trace/doors.js — pair Aether doors (Doors page) with Event Trace.   AETHER_TRACE (TRACE-3)
//
// An Aether door (backend/data/doors/door-config.json) already says what is wired where: the relays that
// drive the controller's DPS / REX, the opto or EOL input that watches its strike, its custom I/O, its
// reader, or the emulated board it lives on. Each door can also carry
//   door.trace = { oncafeDoorId, oncafeDoorName, note, updatedAt, by }
// set on the Doors page (Settings › Basic) or from Event Trace.
//
// doorChannels(door) → the wiring entries that door implies:
//   door:<id>:dps | rex | lock | io:<name>   role + OnCAFE door + note (what Event Trace traces; fed by
//                                             lib/doorActivity, which already applies reverse sense,
//                                             DAC/OD outputs, analog EOL / volts lock watches, emulated boards)
//   relay:<ch> · opto:<ch> · emu:<b>:in:<i> · emu:<b>:out:<o>   role "ignore": the same wire seen raw by
//                                             the journal, so it is not traced twice
// Both sides can be edited; whichever was saved last wins (entries carry `at`, door.trace `updatedAt`).
'use strict';

const assigned = io => { const ch = Number(io && io.channel); return !!io && Number.isInteger(ch) && ch >= 0; };
const stack0 = io => !Number(io && io.stackLevel);
const kindOf = io => { const t = io && io.hardwareType; return t === 'dac' || t === 'od' ? t : t === 'opto-in' || t === 'analog-in' ? t : 'relay'; };
const ROLE_WORD = { dps: 'DPS', rex: 'REX', lock: 'Lock', input: 'Input', output: 'Output' };

function doorsFrom(json) {
  try {
    const lib = require('../lib/doorActivity');
    if (lib && typeof lib.doorsFromConfig === 'function') return lib.doorsFromConfig(json);
  } catch { /* older Aether: no door activity module */ }
  const cfg = json && json.config ? json.config : json;
  return cfg && Array.isArray(cfg.doors) ? cfg.doors.filter(d => d && Number.isInteger(Number(d.id))) : [];
}

/** Wiring entries implied by one door. */
function doorChannels(d) {
  const out = [];
  if (!d || d.enabled === false) return out;
  const id = Number(d.id);
  const t = d.trace || {};
  const name = String(d.name || `Door ${id}`).slice(0, 60);
  const base = { src: `door:${id}`, doorName: name, ...(t.oncafeDoorId ? { door: String(t.oncafeDoorId) } : {}), ...(t.note ? { note: String(t.note).slice(0, 300) } : {}) };
  // The door entry (door:N:dps …) carries the logical level from the Doors page (reverseSense already applied, so a
  // DPS is always "on = open"). The raw wire (relay:3, opto:5, emu:11:in:2) keeps its real role and polarity, so sync
  // pulses and Log Analytics › Product Test still work on it, and points at the door entry with `via`; Event Trace
  // traces the door entry and skips the raw wire while the door is reporting, so nothing is traced twice.
  const add = (key, role, dir, raw, extra = {}) => {
    const word = extra.word || ROLE_WORD[role] || role;
    out.push({ key: `door:${id}:${key}`, entry: { role, dir, label: `${name} · ${word}`, ...base, ...(role === 'dps' ? { active: 'open' } : {}) } });
    for (const r of [].concat(raw || [])) {
      out.push({ key: r, entry: { role, dir, label: `${name} · ${word} (wire)`, ...base, via: `door:${id}:${key}`,
        ...(role === 'dps' ? { active: extra.io && extra.io.reverseSense ? 'closed' : 'open' } : {}) } });
    }
  };
  const emulated = d.ioSource === 'emulated';
  const b = Number(d.emuBoard) & 0x7F;
  if (emulated) {
    if (!b) return out;
    if (assigned(d.dps)) add('dps', 'dps', 'in', `emu:${b}:in:${d.dps.channel}`, { io: d.dps });
    if (assigned(d.rexIn)) add('rex', 'rex', 'in', `emu:${b}:in:${d.rexIn.channel}`);
    if (assigned(d.lock)) add('lock', 'lock', 'out', `emu:${b}:out:${d.lock.channel}`);
    return out;
  }
  const rawRelay = io => (assigned(io) && kindOf(io) === 'relay' && stack0(io) ? `relay:${io.channel}` : null);
  if (assigned(d.dps)) add('dps', 'dps', 'in', rawRelay(d.dps), { io: d.dps });
  if (assigned(d.rexIn)) add('rex', 'rex', 'in', rawRelay(d.rexIn));
  if (assigned(d.lock)) {
    const k = kindOf(d.lock);
    if (k === 'opto-in') add('lock', 'lock', 'out', stack0(d.lock) ? `opto:${d.lock.channel}` : null, { word: 'Lock (watched)' });
    else if (k === 'analog-in') add('lock', 'lock', 'out', null, { word: 'Lock (EOL watch)' });
    else add('lock', 'input', 'in', rawRelay(d.lock), { word: 'Lock sense (driven)' });
  }
  for (const io of d.ios || []) {
    if (!io || io.enabled === false || !assigned(io)) continue;
    const nm = String(io.id || io.name || '').replace(/[^\w.\-]/g, '_').slice(0, 40);
    if (!nm) continue;
    const word = String(io.name || io.type || 'I/O').slice(0, 30);
    if (io.hardwareType === 'relay') add(`io:${nm}`, 'input', 'in', stack0(io) ? `relay:${io.channel}` : null, { word });
    else if (io.hardwareType === 'opto') add(`io:${nm}`, 'output', 'out', `opto:${io.channel}`, { word });
    else if (io.hardwareType === 'analog') add(`io:${nm}`, 'output', 'out', null, { word });
  }
  return out;
}

/** doorActivity meta.key ('2:dps:relay:3', '2:rexIn:emu:11:4', '2:io:Strike_1:opto:5') → 'door:2:dps' etc. */
function channelOfActivity(key) {
  const p = String(key || '').split(':');
  if (p.length < 3 || !/^\d+$/.test(p[0])) return null;
  const id = p[0];
  if (p[1] === 'dps') return `door:${id}:dps`;
  if (p[1] === 'rexIn') return `door:${id}:rex`;
  if (p[1] === 'lock') return `door:${id}:lock`;
  if (p[1] === 'io') {
    // io:<name>:<hw>:<ch> — the name may itself contain ':'
    const nm = p.slice(2, -2).join(':').replace(/[^\w.\-]/g, '_').slice(0, 40);
    return nm ? `door:${id}:io:${nm}` : null;
  }
  return null;
}

/** Journal channels a door's reader produces when Aether presents a card on it. */
function readerChannels(reader) {
  const r = String(reader || '');
  if (!r) return [];
  const m = /^ctrl-emu-(\d+)-(\d+)$/.exec(r);
  if (m) return [`emu:${m[1]}:rdr:${m[2]}`];
  return [`wiegand:${r}`, `osdp:${r}`];
}

module.exports = { doorsFrom, doorChannels, channelOfActivity, readerChannels };
