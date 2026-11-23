// trace/normalize.js — turn whatever a source produced into Event Trace events.   AETHER_TRACE
//
// One event:
//   { id, src, lane, at, t, clock, type, label, door, controllerId, cred, clientType, eventId, topic, info, hasRaw }
//   src    journal · cloud-mqtt · cloud-api · wire · controller · har
//   lane   aether · controller · wire · cloud
//   at     Pi epoch ms when Aether saw it (null for imported, after-the-fact data)
//   t      the event's own timestamp, on `clock`
//   clock  pi · controller · cloud · browser
//   type   lower-case event type (accessgranted, accessdenied_unauthorized, unlocked, open, card, relay, egress …)
//   cred   { fc, cn, format } when the event names a credential
'use strict';

const crypto = require('crypto');

const newId = () => crypto.randomBytes(6).toString('hex');

/** 'Door.AccessDenied' → 'accessdenied'; 'AccessGranted' → 'accessgranted'; keep '_reason' suffixes. */
function normType(t) {
  let s = String(t || '').trim();
  if (!s) return '';
  if (s.includes('.')) s = s.split('.').pop();
  return s.replace(/\s+/g, '').toLowerCase();
}

const ACCESS = t => t.startsWith('accessgranted') || t.startsWith('accessdenied') || t === 'unusedaccessgrant';

/** Epoch ms from ms, s or ISO; null if it doesn't look like a time in 2001–2100. */
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) v = Number(v);
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e15) return Math.round(v / 1000);          // µs
    if (v > 978307200000 && v < 4102444800000) return Math.round(v);
    if (v > 978307200 && v < 4102444800) return Math.round(v * 1000);
    return null;
  }
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

const CTX_KEYS = {
  time: ['eventTimestamp', 'eventTime', 't', 'timestamp', 'time', 'Time', 'occurredAt'],
  doorId: ['doorId', 'accessPointId'],
  doorName: ['doorName', 'accessPointName'],
  fc: ['facilityCode', 'facility', 'fc', 'FacilityCode'],
  cn: ['cardNumber', 'card', 'cn', 'CardNumber', 'credentialNumber'],
  format: ['cardFormat', 'format', 'CardFormat', 'credentialFormat'],
  controllerId: ['controllerId', 'deviceId', 'ControllerId'],
  clientType: ['clientType'],
  eventId: ['eventId'],
  srcId: ['srcId'],
  srcType: ['srcType'],
  ioPort: ['IOPort', 'ioPort'],
  zoneName: ['zoneName'],
  areaName: ['areaName'],
  cloudCreated: ['createdDate', 'createdTime'],
  cloudModified: ['modifiedDate', 'updatedTime'],
};
function pickCtx(o, base) {
  const c = { ...base };
  for (const [k, names] of Object.entries(CTX_KEYS)) {
    for (const n of names) {
      const v = o[n];
      if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
      if (k === 'time' && toMs(v) == null) continue;
      if (c[k] === undefined || k === 'time') { c[k] = v; break; }
    }
  }
  if (o.src && typeof o.src === 'object') {
    if (o.src.srcId && !c.srcId) c.srcId = o.src.srcId;
    if (o.src.type && !c.srcType) c.srcType = o.src.type;
    if (o.src.IOPort && !c.ioPort) c.ioPort = o.src.IOPort;
  }
  if (o.eventMeta && typeof o.eventMeta === 'object') {
    if (o.eventMeta.controllerId && !c.controllerId) c.controllerId = o.eventMeta.controllerId;
    if (o.eventMeta.eventId && !c.eventId) c.eventId = o.eventMeta.eventId;
    if (o.eventMeta.triggerType && !c.triggerType) c.triggerType = o.eventMeta.triggerType;
  }
  return c;
}

/** Find every object with an eventType/eventName inside a payload, with the fields of its ancestors. */
function findEvents(root) {
  const found = [];
  const walk = (o, ctx, depth) => {
    if (depth > 10 || o == null) return;
    if (Array.isArray(o)) { for (const x of o.slice(0, 200)) walk(x, ctx, depth + 1); return; }
    if (typeof o !== 'object') return;
    const c = pickCtx(o, ctx);
    const et = o.eventType || o.EventName || o.eventName;
    let child = false;
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && k !== 'src') { const before = found.length; walk(v, c, depth + 1); if (found.length > before) child = true; }
    if (typeof et === 'string' && et && !child) found.push({ type: et, ctx: c, node: o });
  };
  walk(root, {}, 0);
  return found;
}

function credOf(c) {
  const fc = c.fc !== undefined ? String(c.fc) : undefined;
  const cn = c.cn !== undefined ? String(c.cn) : undefined;
  if (fc === undefined && cn === undefined) return null;
  return { fc, cn, format: c.format !== undefined ? String(c.format) : undefined };
}

/**
 * Cloud payload (MQTT rt-events / timeline API item / HAR body) → events.
 * @param {object} j      parsed JSON
 * @param {object} o      { src, at, topic, clock }
 */
function fromCloud(j, o = {}) {
  const out = [];
  const topicId = o.topic ? (String(o.topic).split('/')[2] || '') : '';
  for (const f of findEvents(j)) {
    const c = f.ctx;
    const type = normType(f.type);
    if (!type) continue;
    out.push({
      id: newId(), src: o.src || 'cloud-mqtt', lane: 'cloud', at: o.at ?? null,
      t: toMs(c.time), clock: 'controller',     // event timestamps are stamped by the controller
      cloudAt: toMs(c.cloudCreated) ?? toMs(c.cloudModified) ?? null,
      type, label: f.type,
      door: (c.doorId || c.doorName) ? { id: c.doorId || null, name: c.doorName || null } : (c.srcId ? { id: c.srcId, name: null } : null),
      controllerId: c.controllerId || (/rt-events|settings/.test(o.topic || '') ? topicId : null) || null,
      cred: credOf(c), clientType: c.clientType || null, eventId: c.eventId || null, topic: o.topic || null,
      info: { srcType: c.srcType, ioPort: c.ioPort, zone: c.zoneName, area: Array.isArray(c.areaName) ? c.areaName.join(', ') : c.areaName, trigger: c.triggerType },
      access: ACCESS(type),
    });
  }
  // d/settings/<controller>: { msg: { resource: 'controller/<id>', properties: { ioId, ioState } }, tid }
  if (!out.length && j && j.msg && j.msg.properties && (j.msg.properties.ioId || j.msg.properties.ioState)) {
    const p = j.msg.properties;
    out.push({
      id: newId(), src: o.src || 'cloud-mqtt', lane: 'cloud', at: o.at ?? null, t: toMs(j.tid), clock: 'cloud', cloudAt: toMs(j.tid),
      type: 'io-' + String(p.ioState || 'change').toLowerCase(), label: `${String(p.ioId || '').split('#').pop()} ${p.ioState || ''}`.trim(),
      door: null, controllerId: String(j.msg.resource || '').split('/')[1] || topicId || null, cred: null, clientType: null, eventId: null,
      topic: o.topic || null, info: { ioId: p.ioId }, access: false,
    });
  }
  // b/notify/<org>: { msgs: [{ msg: { action: 'update', resource: 'door/<id>', propertyDetails: { state, modifiedDate … } } }] }
  if (!out.length && j && Array.isArray(j.msgs)) {
    for (const m of j.msgs) {
      const d = m && m.msg && m.msg.propertyDetails;
      if (!d || !/^door\//.test(String(m.msg.resource || ''))) continue;
      const st = d.state || {};
      out.push({
        id: newId(), src: o.src || 'cloud-mqtt', lane: 'cloud', at: o.at ?? null, t: toMs(d.modifiedDate), clock: 'cloud', cloudAt: toMs(d.modifiedDate),
        type: 'door-state', label: `door ${st.DoorPhysicalState || st.doorPhysicalState || '?'} · lock ${st.LockPhysicalState || st.lockPhysicalState || '?'}`,
        door: { id: d.doorId || String(m.msg.resource).split('/')[1], name: d.doorName || null }, controllerId: d.controllerId || null,
        cred: null, clientType: null, eventId: null, topic: o.topic || null,
        info: { door: st.DoorPhysicalState || st.doorPhysicalState, lock: st.LockPhysicalState || st.lockPhysicalState, connection: st.connectionStatus, lockdown: st.lockdownState, forced: st.DoorForcedOpen, held: st.DoorOpenTooLong },
        access: false,
      });
    }
  }
  return out;
}

/** Journal entry (analytics/journal.js) → event. */
function fromJournal(e) {
  const m = e.m || {};
  const kind = e.k;
  let cred = null;
  if (kind === 'card' && (m.fc !== undefined || m.cn !== undefined)) cred = { fc: m.fc != null ? String(m.fc) : undefined, cn: m.cn != null ? String(m.cn) : undefined, format: m.format != null ? String(m.format) : undefined };
  const label = kind === 'card' ? `card ${cred ? `${cred.fc ?? '?'}-${cred.cn ?? '?'}` : ''}${m.format ? ' · ' + m.format : ''} on ${e.ch}`
    : kind === 'keypad' ? `keypad ${m.count || ''} keys on ${e.ch}`
      : kind === 'marker' ? (m.event || 'marker') + (m.name ? ' · ' + m.name : '')
        : `${e.ch} → ${e.v}`;
  return {
    id: newId(), src: 'journal', lane: 'aether', at: e.t, t: e.t, clock: 'pi', type: kind, label, door: null, controllerId: null,
    cred, clientType: null, eventId: null, topic: null, info: { ch: e.ch, v: e.v, src: e.src, ...(m.sync ? { sync: m.sync } : {}), ...(m.expect ? { expect: m.expect } : {}) },
    access: false, journal: { ch: e.ch, k: e.k, v: e.v, run: e.run },
  };
}

/** Log Analytics report → controller events (decision time and Cloud Connector publish time, both controller clock). */
function fromReport(report) {
  const out = [];
  for (const e of report.events || []) {
    const props = e.props || {};
    const c = pickCtx(props, {});
    out.push({
      id: newId(), src: 'controller', lane: 'controller', at: null, t: e.t, clock: 'controller', publishAt: e.logT ?? null,
      type: normType(e.type), label: e.type, door: e.src ? { id: e.src, name: (report.doors && report.doors[e.src] && report.doors[e.src].name) || null } : null,
      controllerId: null, cred: credOf(c), clientType: null, eventId: null, topic: null,
      info: { port: e.port, lag: e.lag, file: e.file, line: e.line }, access: ACCESS(normType(e.type)),
    });
  }
  for (const e of report.panelEvents || []) {
    for (const type of e.types || []) {
      out.push({
        id: newId(), src: 'controller', lane: 'controller', at: null, t: e.t, clock: 'controller', publishAt: null,
        type: normType(type), label: `${e.name} (panel)`, door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null,
        info: { panel: e.name, data: e.data, file: e.file, line: e.line }, access: ACCESS(normType(type)),
      });
    }
  }
  return out;
}

module.exports = { fromCloud, fromJournal, fromReport, findEvents, normType, toMs, newId, ACCESS };
