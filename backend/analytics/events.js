// analytics/events.js — pull structured controller activity out of parsed records.
'use strict';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function jsonAfter(msg, marker) {
  const i = msg.indexOf(marker);
  if (i < 0) return null;
  const s = msg.slice(i + marker.length).trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const end = s.lastIndexOf('}');
  if (end > 0) { try { return JSON.parse(s.slice(0, end + 1)); } catch { /* */ } }
  return null;
}

/**
 * @returns {{
 *   rt: object[],          // RealTime events published to the cloud
 *   settings: object[],    // DeviceSetting broadcasts
 *   ap: object[],          // access-point state transitions (handleAccessPointEvent)
 *   io: object[],          // input/output status reports
 *   relay: object[],       // relay online-status changes
 *   offlineRows: object[], // offline DB row counter samples
 *   incoming: object[],    // cloud → controller messages (remote commands, settings)
 * }}
 */
function extract(cc) {
  const out = { rt: [], settings: [], ap: [], io: [], relay: [], offlineRows: [], incoming: [] };
  for (const r of cc) {
    const m = r.msg;
    if (r.fn === 'send_event_over_mqtt') {
      if (m.includes('RealTime Event')) {
        const j = jsonAfter(m, 'payload ::');
        if (!j) continue;
        const evs = (((j.eventMeta || {}).events || [])[0] || {}).event || [];
        for (const e of evs) {
          const tEv = Number(j.t);
          out.rt.push({
            t: r.t, tEvent: Number.isFinite(tEv) ? tEv : r.t, lagMs: Number.isFinite(tEv) ? r.t - tEv : null,
            type: String(e.eventType || '').toLowerCase(), cls: e.eventClass || '', props: e.eventProps || {},
            srcId: (j.src || {}).srcId || '', srcType: (j.src || {}).type || '', ioPort: (j.src || {}).IOPort || '',
            eventId: (j.eventMeta || {}).eventId || '', file: r.file, line: r.line,
          });
        }
      } else if (m.includes('DeviceSetting Event')) {
        const j = jsonAfter(m, 'payload ::');
        if (j) out.settings.push({ t: r.t, resource: (j.msg || {}).resource || '', props: (j.msg || {}).properties || {}, file: r.file, line: r.line });
      }
    } else if (r.fn === 'handleAccessPointEvent') {
      const x = /Source: \[([^\]]+)\]AccessControl\.AccessPoint-(\S+) \| Strike: (\d+) \| State: (\w+) -> (\w+) \| Relay: (\w+)/.exec(m);
      if (x) out.ap.push({ t: r.t, ap: x[1], event: x[2].replace(/^AccessControl\./, ''), strike: +x[3], from: x[4], to: x[5], relay: x[6], file: r.file, line: r.line });
    } else if (r.fn === 'processIOStateSync') {
      const x = /IoId: (\S+) IoStatus: (.+?) and ioType: (\S+) reason: (\w+)/.exec(m);
      if (x) out.io.push({ t: r.t, id: x[1], status: x[2], ioType: x[3], reason: x[4], kind: 'sync', file: r.file, line: r.line });
      const y = /Physical state for IOId: \S*#(?:input_|output_)?(\S+) is (\d+)/.exec(m);
      if (y) out.io.push({ t: r.t, id: y[1], status: `physical=${y[2]}`, reason: 'physical', kind: 'physical', file: r.file, line: r.line });
    } else if (r.fn === 'doPrepareInputEventResponse') {
      const x = /source: (\S+), input reason: (\w+)/.exec(m);
      if (x) out.io.push({ t: r.t, id: x[1], status: '', reason: x[2], kind: 'event', file: r.file, line: r.line });
    } else if (r.fn === 'handleRelayEvent') {
      const x = /RelayEvent \[(\S+)\] Online Status: (\w+) -> (\w+)/.exec(m);
      if (x) out.relay.push({ t: r.t, id: x[1], from: x[2], to: x[3], file: r.file, line: r.line });
    } else if (r.fn === 'saveEvntToOfflineDB') {
      const x = /Number of rows in DB: (\d+)/.exec(m);
      if (x) out.offlineRows.push({ t: r.t, rows: +x[1], file: r.file, line: r.line });
    } else if (/on_message|message_callback|processIncoming|handleNotify/i.test(r.fn)) {
      out.incoming.push({ t: r.t, msg: m.slice(0, 300), file: r.file, line: r.line });
    }
  }
  return out;
}

/** Normalize a message into a signature for grouping. */
function signature(r) {
  const msg = String(r.msg).split('\n')[0]
    .replace(UUID, '<id>')
    .replace(/"[^"]{0,200}"/g, '"…"')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .slice(0, 180);
  return `${r.mod}:${r.fn}: ${msg}`;
}

module.exports = { extract, signature, UUID };
