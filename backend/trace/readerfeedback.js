// trace/readerfeedback.js — what the controller told the reader to show: the last hop a person at the door sees.
//                                                                                           AETHER_TRACE (TRACE-5)
// OSDP Trace (osdp/trace/osdpTraceHub) decodes every frame on Aether's buses (the reader emulator, the controller
// emulator and the passive sniffer). The controller's osdp_LED and osdp_BUZ commands to a reader become Event Trace
// events on the reader's channel, so a card trace ends with "Reader showed green · beeped" and its time.
//   colour: the temporary LED colour if one is set (that is what a grant / deny shows), else the permanent one
//   tone  : beep / silent, count, on-time
// Reader channel: osdp:<readerId> when the address is one of Aether's OSDP readers, else osdp-addr:<port>:<address>.
'use strict';

const { newId } = require('./normalize');

const COLORS = ['black', 'red', 'green', 'amber', 'blue', 'magenta', 'cyan', 'white'];

/** Raw osdp_LED data → records { reader, led, colour, temporary, timerMs, flash }. */
function parseLed(hex) {
  const d = Buffer.from(String(hex || ''), 'hex');
  const out = [];
  for (let o = 0; o + 14 <= d.length; o += 14) {
    const tmp = d[o + 2], tOn = d[o + 3], tOff = d[o + 4], tOnC = d[o + 5], tOffC = d[o + 6], timer = d[o + 7] | (d[o + 8] << 8);
    const perm = d[o + 9], pOnC = d[o + 12];
    const temporary = tmp === 0x02;
    out.push({ reader: d[o], led: d[o + 1], temporary, colour: COLORS[(temporary ? tOnC : perm === 0x01 ? pOnC : tOnC) & 7] || 'unknown',
      timerMs: temporary ? timer * 100 : null, flash: !!(temporary && tOn && tOff && tOnC !== tOffC) });
  }
  return out;
}

/** Raw osdp_BUZ data → { reader, tone, onMs, offMs, count }. */
function parseBuz(hex) {
  const d = Buffer.from(String(hex || ''), 'hex');
  if (d.length < 5) return null;
  return { reader: d[0], tone: d[2] ? (d[1] === 0x02 ? 'beep' : d[1] <= 0x01 ? 'silent' : `tone ${d[1]}`) : 'silent', onMs: d[2] * 100, offMs: d[3] * 100, count: d[4] };
}

/** One OSDP Trace frame → an Event Trace event, or null (only commands to a reader count, never replies). */
function frameToEvent(f, readers = [], opt = {}) {
  if (!f || f.isReply) return null;
  const name = String(f.name || '');
  if (name !== 'osdp_LED' && name !== 'osdp_BUZ') return null;
  const rd = readers.find(r => Number(r.address) === Number(f.address) && (!r.port || !f.port || r.port === f.port)) || null;
  // a reader on an emulated board (the panel polls Aether's emulated RI4S / RI2MS): emu:<board>:rdr:<reader on that board>
  const onBoard = !rd && (/controller-emulator/.test(String(f.port || '')) || (!!f.port && (opt.emuPorts || []).includes(f.port)));
  const chFor = readerNo => (rd ? `osdp:${rd.id}` : onBoard ? `emu:${Number(f.address) & 0x7F}:rdr:${readerNo}` : `osdp-addr:${f.port || '?'}:${f.address}`);
  const at = Number(f.ts) || Date.now();
  const base = { id: newId(), src: 'reader', lane: 'aether', at, t: at, clock: 'pi', door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null };
  if (name === 'osdp_LED') {
    const recs = parseLed(f.dataHex);
    if (!recs.length) return null;
    const r = recs.find(x => x.temporary) || recs[0];
    const ch = chFor(r.reader);
    return { ...base, type: 'reader-led', label: `Reader ${rd ? rd.name || rd.id : 'addr ' + f.address}: LED ${r.colour}${r.flash ? ' (flashing)' : ''}${r.timerMs ? ` for ${r.timerMs / 1000} s` : r.temporary ? '' : ' (steady)'}`,
      info: { ch, colour: r.colour, temporary: r.temporary, timerMs: r.timerMs, flash: r.flash, address: f.address, port: f.port || null } };
  }
  const b = parseBuz(f.dataHex);
  if (!b) return null;
  const ch = chFor(b.reader);
  return { ...base, type: 'reader-buzzer', label: `Reader ${rd ? rd.name || rd.id : 'addr ' + f.address}: ${b.tone === 'silent' ? 'buzzer off' : `${b.tone}${b.count > 1 ? ` ×${b.count}` : ''}`}`,
    info: { ch, tone: b.tone, count: b.count, onMs: b.onMs, address: f.address, port: f.port || null } };
}

/** What a reader should show for a decision. */
const expectedColour = result => (result === 'grant' ? 'green' : result === 'deny' ? 'red' : null);

module.exports = { parseLed, parseBuz, frameToEvent, expectedColour, COLORS };
