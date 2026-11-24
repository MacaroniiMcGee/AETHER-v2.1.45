// trace/suggest.js — suggest the wiring between Aether and the controller.   AETHER_TRACE (TRACE-5)
//
// Three sources, strongest first:
//   probe       Discover (Setup › Wiring): Aether pulsed each relay / presented a card on each reader / unlocked each
//               door through OnCAFE, and saw which controller door and event answered        → "proved"
//   doors page  the Doors page says which relay is a door's DPS / REX, which input watches its lock → "configured"
//   seen        what normal testing showed: a channel's edges agreed with one kind of controller
//               event on one door ≥ 50 % of the time (correlate's role inference)           → "seen"
// The result is one row per Aether channel (role, door, how sure, why) plus a per-door picture that the
// Hydra drawing uses: reader, DPS, REX and lock watch of each controller door.
'use strict';

const RANK = { probe: 3, 'doors page': 2, seen: 1 };
const terminalOf = ch => {
  let m;
  if ((m = /^relay:(\d+)$/.exec(ch))) return { kind: 'relay', n: +m[1] + 1, label: `REL${+m[1] + 1}` };
  if ((m = /^opto:(\d+)$/.exec(ch))) return { kind: 'opto', n: +m[1] + 1, label: `OPTO${+m[1] + 1}` };
  if ((m = /^adc:(\d+)$/.exec(ch))) return { kind: 'adc', n: +m[1] + 1, label: `ADC${+m[1] + 1}` };
  if ((m = /^wiegand:(.+)$/.exec(ch))) return { kind: 'wiegand', id: m[1], label: `Wiegand ${m[1]}` };
  if ((m = /^osdp:(.+)$/.exec(ch))) return { kind: 'osdp', id: m[1], label: `OSDP ${m[1]}` };
  if ((m = /^emu:(\d+):(in|out|rdr):(\d+)$/.exec(ch))) return { kind: `emu-${m[2]}`, board: +m[1], n: +m[3], label: `Board ${m[1]} ${m[2] === 'rdr' ? 'reader' : m[2]} ${+m[3] + 1}` };
  return { kind: 'other', label: ch };
};

/**
 * @param {object} x { doors: [{ id, name, oncafe, reader, chs:{dps,rex,lock}, raw:{dps,rex,lock}, lockKind }], wiring, seen: [{ch, inferred}],
 *                     probe: { relays:[{ch, role, door, active, events}], readers:[{ch, door, type}], locks:[{door, ch}] } | null,
 *                     inventory: { doors:[{id,name,controllerId}], controllers:[{id,name,model}] } | null }
 */
function suggestWiring(x) {
  const rows = new Map();   // ch -> { ch, role, door, active, source, confidence, why[] }
  const put = (ch, r) => {
    const cur = rows.get(ch);
    if (!cur || RANK[r.source] > RANK[cur.source] || (RANK[r.source] === RANK[cur.source] && (r.confidence || 0) > (cur.confidence || 0))) rows.set(ch, { ...r, ch, why: [r.why].concat(cur ? cur.why : []).filter(Boolean) });
    else cur.why.push(r.why);
  };
  // seen
  for (const s of x.seen || []) {
    const f = s.inferred;
    if (!f || !f.role || f.role === 'ignore' || !/^(relay|opto|gpio|emu|wiegand|osdp)/.test(s.ch)) continue;
    put(s.ch, { role: f.role, door: f.door || null, active: f.active || undefined, source: 'seen', confidence: Math.round((f.score || 0.5) * 100) / 100, why: `seen: ${Math.round((f.score || 0) * 100)} % of ${s.count} changes matched ${f.role} events` });
  }
  // doors page
  for (const d of x.doors || []) {
    const raw = d.raw || {};
    for (const role of ['dps', 'rex', 'lock']) {
      const ch = raw[role];
      if (!ch) continue;
      put(ch, { role, door: d.oncafe || null, active: role === 'dps' ? (d.dpsNc ? 'closed' : 'open') : undefined, source: 'doors page', confidence: 0.9, why: `doors page: ${d.name} ${role.toUpperCase()}`, aetherDoor: d.id });
    }
    if (d.reader) for (const ch of [].concat(d.readerChannels || [])) put(ch, { role: 'card', door: d.oncafe || null, source: 'doors page', confidence: 0.9, why: `doors page: ${d.name} reader`, aetherDoor: d.id });
  }
  // probe
  const p = x.probe || {};
  for (const r of p.relays || []) if (r.role) put(r.ch, { role: r.role, door: r.door || null, active: r.active, source: 'probe', confidence: 1, why: `probe: pulsing it made the controller report ${r.events.map(e => e.type).join(', ')}` });
  for (const r of p.readers || []) if (r.door) put(r.ch, { role: 'card', door: r.door, source: 'probe', confidence: 1, why: `probe: a card on it was decided at that door (${r.type})` });
  for (const l of p.locks || []) if (l.ch) put(l.ch, { role: 'lock', door: l.door, source: 'probe', confidence: 1, why: `probe: unlocking the door through OnCAFE turned this input on after ${l.ms} ms` });

  const w = x.wiring || {};
  const list = [...rows.values()].map(r => {
    const cur = w[r.ch] || (r.ch.startsWith('door:') ? null : null);
    const same = cur && cur.role === r.role && (!r.door || cur.door === r.door) && (r.role !== 'dps' || !r.active || (cur.active || 'open') === r.active);
    return { ...r, terminal: terminalOf(r.ch), current: cur ? { role: cur.role, door: cur.door || null, active: cur.active || null } : null, differs: !same };
  }).sort((a, b) => (b.differs - a.differs) || String(a.ch).localeCompare(String(b.ch), undefined, { numeric: true }));

  // per controller door: the picture the Hydra drawing uses
  const inv = x.inventory || {};
  const ctrlOf = id => (inv.controllers || []).find(c => c.id === id) || null;
  // a door's name: OnCAFE inventory, else the Doors page door paired with it, else what the wiring map remembers, else its id
  const doorNameOf = id => ((inv.doors || []).find(o => o.id === id) || {}).name
    || ((x.doors || []).find(o => o.oncafe === id) || {}).name
    || (Object.values(x.wiring || {}).find(w => w && w.door === id && (w.oncafeDoorName || w.doorName)) || {}).oncafeDoorName
    || (Object.values(x.wiring || {}).find(w => w && w.door === id && w.doorName) || {}).doorName
    || `Door ${String(id).slice(0, 8)}`;
  const byDoor = new Map();
  for (const r of list) {
    if (!r.door) continue;
    const d = byDoor.get(r.door) || { door: r.door, name: doorNameOf(r.door), controllerId: ((inv.doors || []).find(o => o.id === r.door) || {}).controllerId || null, reader: null, dps: null, rex: null, lock: null, inputs: [], outputs: [] };
    const slot = r.role === 'card' ? 'reader' : r.role === 'dps' || r.role === 'rex' || r.role === 'lock' ? r.role : null;
    const v = { ch: r.ch, terminal: r.terminal, source: r.source, active: r.active || null };
    if (slot) { if (!d[slot] || RANK[r.source] > RANK[d[slot].source]) d[slot] = v; }
    else if (r.role === 'input') d.inputs.push(v); else if (r.role === 'output') d.outputs.push(v);
    byDoor.set(r.door, d);
  }
  const controllers = new Map();
  for (const d of byDoor.values()) {
    const c = ctrlOf(d.controllerId) || { id: d.controllerId || 'unknown', name: d.controllerId ? `Controller ${d.controllerId.slice(0, 8)}` : 'Unknown controller', model: '' };
    const e = controllers.get(c.id) || { id: c.id, name: c.name, model: c.model || '', doors: [] };
    e.doors.push(d); controllers.set(c.id, e);
  }
  for (const c of controllers.values()) c.doors.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { at: Date.now(), rows: list, controllers: [...controllers.values()], differs: list.filter(r => r.differs).length, probeAt: p.at || null };
}

module.exports = { suggestWiring, terminalOf };
