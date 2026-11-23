// trace/engine.js — Event Trace: one timeline of what Aether did, what crossed the wire,   AETHER_TRACE
// what the controller logged and what the cloud received, live and after the fact.
//
// Sources
//   journal     analytics/journal.js onRecord()  (cards, keypad, relays, inputs, opto edges; Pi clock)
//   cloud       trace/cloud.js  (OnCAFE MQTT push + event-log poll; Pi clock on arrival)
//   wire        Traffic Inspector flows from the controllers' addresses (gateway mode; Pi clock),
//               or a packet capture imported on the page (Reader parses it in the browser)
//   controller  a Log Analytics report (controller clock: decision + Cloud Connector publish)
//   har         a HAR of the OnCAFE web app (browser clock)
//
// Runs live in backend/data/trace/runs/<id>/: meta.json, events.jsonl (scrubbed), vault.jsonl (originals,
// mode 600), reveals.log. Newest 40 runs kept.
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CloudFeed } = require('./cloud');
const { fromJournal, fromCloud, fromReport, newId, toMs } = require('./normalize');
const { correlate } = require('./correlate');
const { scrub, scrubString, hasSecrets, Vault } = require('./redact');
const { decodePublishes } = require('./mqtt5');
const { parseCommand, commandEvent, buildRequest, reverseOf } = require('./commands');
const { doorsFrom, doorChannels, channelOfActivity, readerChannels } = require('./doors');

const BASE = path.join(__dirname, '..', 'data', 'trace');
const RUNS = path.join(BASE, 'runs');
const SETTINGS = path.join(BASE, 'settings.json');
const REVERTS = path.join(BASE, 'pending-reverts.json');
const DOORS_CONFIG = path.join(__dirname, '..', 'data', 'doors', 'door-config.json');   // Doors page (routes-doors.js)   // commands to turn back, kept across restarts
const REPORTS = path.join(__dirname, '..', 'data', 'analytics', 'reports');
const ANALYTICS_SETTINGS = path.join(__dirname, '..', 'data', 'analytics', 'settings.json');   // wiring map shared with Product Test
const KEEP_RUNS = 40;
const LIVE_MAX = 4000;
const RUN_MAX = 50000;

const DEFAULTS = {
  cloud: { url: '', org: '', controllers: [], doors: [], zones: [], poll: true, pollMs: 2000, autoConnect: false, doorConfig: {} },
  sync: {
    channel: { kind: 'wiegand', readerId: '', address: 1, port: 0, relay: 1, input: 0 },
    format: 'w26',
    cards: [{ fc: 123, cn: 1234 }, { fc: 123, cn: 9876 }],
    gapsMs: [2000, 5000],
    atStart: true, atEnd: true, everyMin: 0,
  },
  wire: { controllerIps: [] },
  thresholds: { decisionWarn: 1000, decisionFail: 2000, pushWarn: 3000, pushFail: 10000, matchWindowMs: 30000, inputWindowMs: 10000, outputWindowMs: 10000, commandWarn: 5000, commandFail: 15000, heldToleranceMs: 1500 },
  commands: { enabled: false },
  expectations: [],     // [{ fc, cn, expect: 'grant'|'deny', note }]
  allowRaw: true,
};

const isIp = s => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(String(s));
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN_ID = /^trace-[a-z0-9]+$/;
function runDir(id) { if (!RUN_ID.test(String(id || ''))) throw err('Bad run id', 400); return path.join(RUNS, id); }

function cleanSettings(s = {}) {
  const d = DEFAULTS;
  const c = s.cloud || {}, y = s.sync || {}, ch = y.channel || {}, w = s.wire || {}, th = s.thresholds || {};
  return {
    cloud: {
      url: String(c.url || '').trim().slice(0, 200), org: /^[0-9a-f-]{36}$/i.test(c.org || '') ? c.org : '',
      controllers: (Array.isArray(c.controllers) ? c.controllers : []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 64),
      doors: (Array.isArray(c.doors) ? c.doors : []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50),
      zones: (Array.isArray(c.zones) ? c.zones : []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50),
      poll: c.poll !== false, pollMs: int(c.pollMs, 1000, 30000, d.cloud.pollMs), autoConnect: !!c.autoConnect,
      doorConfig: Object.fromEntries(Object.entries(c.doorConfig && typeof c.doorConfig === 'object' ? c.doorConfig : {}).filter(([k]) => /^[0-9a-f-]{36}$/i.test(k)).slice(0, 50)
        .map(([k, v]) => [k, { grantMs: Number.isFinite(Number(v && v.grantMs)) && v.grantMs !== null ? Number(v.grantMs) : null, extendedMs: Number.isFinite(Number(v && v.extendedMs)) && v.extendedMs !== null ? Number(v.extendedMs) : null, name: String((v && v.name) || '').slice(0, 80) }])),
    },
    sync: {
      channel: { kind: ['wiegand', 'osdp', 'emu', 'relay', 'emu-in'].includes(ch.kind) ? ch.kind : 'wiegand', readerId: String(ch.readerId ?? '').slice(0, 64), address: int(ch.address, 0, 126, 1), port: int(ch.port, 0, 7, 0), relay: int(ch.relay, 0, 63, 1), input: int(ch.input, 0, 31, 0) },
      format: String(y.format || d.sync.format).slice(0, 64),
      cards: (Array.isArray(y.cards) && y.cards.length ? y.cards : d.sync.cards).slice(0, 4).map(k => ({ fc: int(k.fc, 0, 2 ** 31 - 1, 0), cn: String(k.cn ?? '').replace(/\D/g, '').slice(0, 20) || '0' })),
      gapsMs: (Array.isArray(y.gapsMs) ? y.gapsMs : d.sync.gapsMs).slice(0, 4).map(g => int(g, 500, 60000, 2000)),
      atStart: y.atStart !== false, atEnd: y.atEnd !== false, everyMin: int(y.everyMin, 0, 240, 0),
    },
    wire: { controllerIps: (Array.isArray(w.controllerIps) ? w.controllerIps : String(w.controllerIps || '').split(/[\s,]+/)).filter(isIp).slice(0, 32) },
    thresholds: Object.fromEntries(Object.entries(d.thresholds).map(([k, v]) => [k, int(th[k], 50, 600000, v)])),
    expectations: (Array.isArray(s.expectations) ? s.expectations : []).slice(0, 200).map(x => ({ fc: x.fc === '' || x.fc == null ? '' : String(int(x.fc, 0, 2 ** 31 - 1, 0)), cn: String(x.cn ?? '').replace(/\D/g, '').slice(0, 20), expect: x.expect === 'deny' ? 'deny' : 'grant', note: String(x.note || '').slice(0, 80) })).filter(x => x.cn),
    allowRaw: s.allowRaw !== false,
    commands: { enabled: !!(s.commands && s.commands.enabled) },
  };
}

const WIRING_ROLES = ['dps', 'rex', 'card', 'keypad', 'lock', 'input', 'output', 'ignore'];
function readAnalyticsSettings() { try { return JSON.parse(fs.readFileSync(ANALYTICS_SETTINGS, 'utf8')) || {}; } catch { return {}; } }
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
function cleanEntry(v, nested = false) {
  if (!v || typeof v !== 'object' || !WIRING_ROLES.includes(v.role)) return null;
  const was = !nested && v.was ? cleanEntry(v.was, true) : null;
  return { role: v.role, ...(v.door ? { door: String(v.door).slice(0, 64) } : {}), ...(v.active ? { active: v.active === 'closed' ? 'closed' : 'open' } : {}), ...(v.ioId ? { ioId: String(v.ioId).slice(0, 120) } : {}), ...(v.label ? { label: String(v.label).slice(0, 80) } : {}),
    ...(v.note ? { note: String(v.note).slice(0, 300) } : {}), ...(/^door:\d+$/.test(String(v.src || '')) ? { src: String(v.src) } : {}), ...(Number(v.at) > 0 ? { at: Number(v.at) } : {}),
    ...(v.dir === 'in' || v.dir === 'out' ? { dir: v.dir } : {}), ...(v.doorName ? { doorName: String(v.doorName).slice(0, 60) } : {}),
    ...(/^door:\d+:[\w:.\-]{1,70}$/.test(String(v.via || '')) ? { via: String(v.via) } : {}),
    ...(v.pin === true ? { pin: true } : {}),      // edited in Event Trace: door imports leave it alone until reset
    ...(was ? { was } : {}) };                     // the manual mapping a door took over; put back when the door lets go
}
function cleanWiring(wiring) {
  const w = {};
  for (const [ch, v] of Object.entries(wiring && typeof wiring === 'object' ? wiring : {})) {
    if (!/^[\w:.\-]{1,80}$/.test(ch)) continue;
    const e = cleanEntry(v);
    if (e) w[ch] = e;
  }
  return w;
}
/** Version of the wiring map a client edited: the newest entry time. */
function wiringVersion(w) { return Math.max(0, ...Object.values(w || {}).map(e => Number(e.at) || 0)); }

class TraceEngine extends EventEmitter {
  constructor() {
    super();
    fs.mkdirSync(RUNS, { recursive: true });
    this.settings = cleanSettings(DEFAULTS);
    try { this.settings = cleanSettings(JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch { /* defaults */ }
    this.live = [];            // recent events (scrubbed), any run
    this.seq = 0;
    this.run = null;           // { id, name, start, end, syncs[], dir, vault, count }
    this.liveVault = new Map();
    this.cloud = new CloudFeed((m) => console.log(m));
    this.cloud.on('event', (e, raw) => this.add(e, raw));
    this.deps = {};
    this.syncBusy = false;
    this._syncTimer = null;
    this.wireSeen = new Map();
    this.liveLog = { reveal: (id, who) => new Vault(path.join(BASE, 'live')).reveal(id, who) };
    this._cache = null;
  }

  // ── wiring into the backend ────────────────────────────────────────────
  attach(d = {}) {
    this.deps = d;
    try {
      const journal = require('../analytics/journal');
      journal.onRecord(e => { if (e.k === 'marker' && e.m && e.m.trace) return; this.add(fromJournal(e)); });
      this.journal = journal;
    } catch (e) { console.warn('[Trace] journal not available:', e.message); }
    this._hookTraffic();
    this._trafficTimer = setInterval(() => this._hookTraffic(), 5000);
    if (this._trafficTimer.unref) this._trafficTimer.unref();
    if (this.settings.cloud.autoConnect && this.settings.cloud.url && this.settings.cloud.org) {
      setTimeout(() => this.cloud.start(this.settings.cloud).catch(e => console.warn('[Trace] cloud auto-connect:', e.message)), 4000).unref();
    }
    // a run left open by a restart is closed, not resumed
    for (const r of this.listRuns()) if (!r.end) this._patchMeta(r.id, { end: r.lastAt || r.start, endReason: 'backend restarted' });
    for (const p of this._reverts()) this._armRevert(p);
    this._importIfNewer();   // Doors page saved while Event Trace was not looking: its doors win   // turn-backs that were waiting when the backend stopped
  }

  _hookTraffic() {
    let mgr = null;
    try { mgr = require('../routes/traffic').current; } catch { mgr = null; }
    if (!mgr || mgr.__trace) return;
    const orig = mgr._ingest;
    if (typeof orig !== 'function') return;
    const self = this;
    mgr._ingest = function (r) {
      const res = orig.apply(this, arguments);
      try { self._fromTraffic(r); } catch { /* never break the Traffic Inspector */ }
      return res;
    };
    mgr.__trace = true;
  }

  _fromTraffic(r) {
    if (r && r.kind === 'http' && r.request && r.response && /hanwhavision\.cloud$/i.test(String(r.request.host || '')) && !(this._cmdFlows || (this._cmdFlows = new Set())).has(r.id)) {
      const rq = r.request;
      let body = rq.body;
      if (body && rq.bodyEncoding === 'base64') { try { body = Buffer.from(body, 'base64').toString('utf8'); } catch { body = null; } }
      const cmd = parseCommand(rq.method, `https://${rq.host}${rq.path}`, body);
      if (cmd) {
        this._cmdFlows.add(r.id); if (this._cmdFlows.size > 500) this._cmdFlows.delete(this._cmdFlows.values().next().value);
        const at = Math.round((r.ts || Date.now() / 1000) * 1000);
        const end = r.response.tsEnd ? Math.round(r.response.tsEnd * 1000) : null;
        cmd.targetName = this._nameOf(cmd);
        this.add(commandEvent(cmd, { src: 'wire', at, by: `PC ${String(r.client || '')}`, ackMs: end ? end - at : undefined, status: r.response.status, error: r.response.status >= 400 ? `HTTP ${r.response.status}` : undefined, via: 'Traffic Inspector' }));
      }
    }
    const ips = this.settings.wire.controllerIps;
    if (!r || !ips.length) return;
    const client = String(r.client || '').replace(/^::ffff:/, '').split(':')[0];
    if (!ips.includes(client)) return;
    const server = Array.isArray(r.server) ? `${r.server[0]}:${r.server[1]}` : '';
    const base = { id: newId(), src: 'wire', lane: 'wire', clock: 'pi', door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null, access: false };
    if (r.kind === 'tls' && r.phase === 'start') {
      const at = Math.round((r.ts || Date.now() / 1000) * 1000);
      this.add({ ...base, at, t: at, type: 'egress-tls', label: `TLS hello → ${r.sni || server}`, info: { client, server, sni: r.sni } });
    } else if ((r.kind === 'tcp' || r.kind === 'udp') && r.phase === 'msg' && r.msg && r.msg.bytes) {
      const at = Math.round((r.msg.ts || r.ts || Date.now() / 1000) * 1000);
      const dir = r.msg.fromClient ? 'out' : 'in';
      // one row per burst: collapse messages on the same connection within 150 ms
      const k = `${r.id}|${dir}`, last = this.wireSeen.get(k);
      if (last && at - last.at < 150) { last.bytes += r.msg.bytes; return; }
      const e = { ...base, at, t: at, type: dir === 'out' ? 'egress' : 'ingress', dir, label: `${dir === 'out' ? '↑' : '↓'} ${r.msg.bytes} B ${dir === 'out' ? '→' : '←'} ${server || r.sni || ''}`, info: { client, server, sni: r.sni, bytes: r.msg.bytes } };
      this.wireSeen.set(k, { at, bytes: r.msg.bytes });
      if (this.wireSeen.size > 2000) this.wireSeen.delete(this.wireSeen.keys().next().value);
      this.add(e);
    } else if (r.kind === 'http' && r.request && r.phase !== 'msg') {
      const at = Math.round((r.ts || Date.now() / 1000) * 1000);
      if (r.response) return;   // only the request
      this.add({ ...base, at, t: at, type: 'egress-http', label: `${r.request.method} ${r.request.host}${String(r.request.path || '').slice(0, 80)}`, info: { client, host: r.request.host } }, r.request);
    } else if (r.kind === 'dns' && r.request && !r.response) {
      const at = Math.round((r.ts || Date.now() / 1000) * 1000);
      const q = (r.request.questions || [])[0];
      this.add({ ...base, at, t: at, type: 'dns', label: `DNS ${q ? q.name : ''}`, info: { client } });
    }
  }

  // ── events ─────────────────────────────────────────────────────────────
  add(e, raw) {
    e.seq = ++this.seq;
    if (typeof e.label === 'string') e.label = scrubString(e.label);
    if (e.info) e.info = scrub(e.info);
    const room = !this.run || this.run.count < RUN_MAX;
    if (raw !== undefined && raw !== null) {
      e.hasRaw = true;
      e.detail = scrub(raw);
      e.secret = hasSecrets(raw, e.detail);
      if (this.run) { if (room) this.run.vault.put(e.id, raw); }
      else { this.liveVault.set(e.id, raw); if (this.liveVault.size > 600) this.liveVault.delete(this.liveVault.keys().next().value); }
    }
    this.live.push(e);
    if (this.live.length > LIVE_MAX) this.live.splice(0, this.live.length - LIVE_MAX);
    if (this.run && room) {
      this.run.count++;
      this.run.lastAt = e.at || Date.now();
      this.run.events.push(e);
      this._queueWrite(this.run, JSON.stringify(e));
    }
    this.emit('event', e);
    return e;
  }

  // events.jsonl is written in the background (never blocks the GPIO/Wiegand loop)
  _queueWrite(run, line) {
    run.wbuf.push(line);
    if (run.wtimer) return;
    run.wtimer = setTimeout(() => this._flushRun(run), 300);
  }
  _flushRun(run, sync = false) {
    clearTimeout(run.wtimer); run.wtimer = null;
    if (!run.wbuf.length) return Promise.resolve();
    const data = run.wbuf.join('\n') + '\n'; run.wbuf = [];
    const f = path.join(run.dir, 'events.jsonl');
    if (sync) { try { fs.appendFileSync(f, data); } catch { /* */ } return Promise.resolve(); }
    run.wq = (run.wq || Promise.resolve()).then(() => fs.promises.appendFile(f, data).catch(() => {}));
    return run.wq;
  }

  liveSince(seq = 0, limit = 1500) {
    const out = [];
    for (let i = this.live.length - 1; i >= 0 && out.length < limit; i--) { if (this.live[i].seq <= seq) break; out.push(this.live[i]); }
    return { seq: this.seq, events: out.reverse() };
  }

  // ── settings ───────────────────────────────────────────────────────────
  saveSettings(s) {
    const merged = cleanSettings({ ...this.settings, ...s, commands: { ...this.settings.commands, ...(s.commands || {}) }, thresholds: { ...this.settings.thresholds, ...(s.thresholds || {}) }, cloud: { ...this.settings.cloud, ...(s.cloud || {}) }, sync: { ...this.settings.sync, ...(s.sync || {}), channel: { ...this.settings.sync.channel, ...((s.sync || {}).channel || {}) } } });
    this.settings = merged;
    this._settingsRev = (this._settingsRev || 0) + 1;
    writeAtomic(SETTINGS, JSON.stringify(merged, null, 1));
    return merged;
  }

  // ── sync cards ─────────────────────────────────────────────────────────
  channels() {
    const out = { wiegand: [], osdp: [], emu: [] };
    try { const wm = this.deps.getWiegand && this.deps.getWiegand(); if (wm && wm.getReaders) out.wiegand = wm.getReaders().map(r => ({ id: String(r.id), name: r.name || r.label || String(r.id) })); } catch { /* */ }
    try { const om = this.deps.getOsdp && this.deps.getOsdp(); if (om && om.getReaders) out.osdp = [].concat(om.getReaders() || []).map(r => ({ id: String(r.id ?? r.readerId), name: r.name || `OSDP ${r.address ?? r.id}` })); } catch { /* */ }
    try { const em = this.deps.emulator; if (em && typeof em.queueCardRead === 'function') out.emu = [{ id: 'emu', name: 'Emulated board reader (address / port)' }]; } catch { /* */ }
    out.relay = !!this.deps.gpioQueue;
    return out;
  }

  async _sendCard(card) {
    const s = this.settings.sync, ch = s.channel;
    if (ch.kind === 'wiegand') {
      const wm = this.deps.getWiegand && this.deps.getWiegand();
      if (!wm) throw err('Wiegand output is not running on this Pi');
      const id = ch.readerId || (wm.getReaders && (wm.getReaders()[0] || {}).id);
      if (!id) throw err('Pick the Wiegand reader for sync cards (Setup › Sync cards)');
      return wm.sendCard(id, Number(card.fc), Number(card.cn), s.format || null);
    }
    if (ch.kind === 'osdp') {
      const om = this.deps.getOsdp && this.deps.getOsdp();
      if (!om) throw err('OSDP is not running on this Pi');
      if (!ch.readerId) throw err('Pick the OSDP reader for sync cards (Setup › Sync cards)');
      return om.sendCardRead(ch.readerId, { facility: Number(card.fc), card: String(card.cn) }, s.format || 'wiegand26');
    }
    const em = this.deps.emulator;
    if (!em) throw err('The board emulator is not loaded');
    const r = em.queueCardRead(ch.address, ch.port, s.format || 'w26', Number(card.fc), Number(card.cn));
    if (r && r.success === false) throw err(r.error || 'The emulated board refused the card');
    return r;
  }

  /** The channel key and expected controller events of a pulse sync (relay / emulated input). */
  _pulseSync() {
    const c = this.settings.sync.channel;
    const ch = c.kind === 'relay' ? `relay:${c.relay}` : `emu:${c.address}:in:${c.input}`;
    const w = this.wiring()[ch];
    if (!w || !['dps', 'rex', 'input'].includes(w.role)) throw err(`Map ${ch} as a DPS, REX or input in Setup › Wiring before using it for sync`);
    const { expectFor } = require('./correlate');
    const on = expectFor({ journal: { v: 1 } }, w.role, w), off = expectFor({ journal: { v: 0 } }, w.role, w);
    // drive away from the resting state and back: a normally-closed DPS rests ON, so it pulses OFF then ON
    const rest = w.role === 'dps' && w.active === 'closed' ? 1 : 0;
    const first = { journal: { v: rest ? 0 : 1 } }, second = { journal: { v: rest } };
    return { ch, door: w.door || null, rest, first: expectFor(first, w.role, w).types, second: expectFor(second, w.role, w).types };
  }
  async _drive(v) {
    const c = this.settings.sync.channel;
    if (c.kind === 'relay') {
      const q = this.deps.gpioQueue;
      if (!q) throw err('The relay board is not available on this Pi');
      return q.enqueue('setRelay', c.relay, !!v);
    }
    const em = this.deps.emulator;
    if (!em || typeof em.setInput !== 'function') throw err('The board emulator is not loaded');
    if (em.setInput(c.address, c.input, !!v) === false) throw err(`Emulated board ${c.address} has no input ${c.input}`);
  }

  /** Send the sync markers now (two cards, or one DPS/input pulse). set: start | end | check */
  async sendSync(set = 'check') {
    if (this.syncBusy) throw err('Sync markers are already being sent', 409);
    this.syncBusy = true;
    const s = this.settings.sync;
    const sent = [];
    const batch = Date.now().toString(36);
    const keep = rec => { sent.push(rec); if (this.run) { this.run.syncs.push(rec); this._patchMeta(this.run.id, { syncs: this.run.syncs }); } else { this.liveSyncs = (this.liveSyncs || []).concat(rec).slice(-20); } };
    try {
      if (this.journal) this.journal.record('marker', 'trace', 1, 'ui', { event: 'sync-' + set, trace: true });
      if (s.channel.kind === 'relay' || s.channel.kind === 'emu-in') {
        const p = this._pulseSync();
        let away = false;
        try {
          const at = Date.now();
          away = true;
          await this._drive(p.rest ? 0 : 1);
          keep({ at, set, idx: 0, batch, ch: p.ch, v: p.rest ? 0 : 1, types: p.first, door: p.door });
          await sleep(s.gapsMs[0] ?? 2000);
        } finally {
          if (away) {   // always put the input back, even if the first step failed half-way
            let ok = false, last = null;
            for (let k = 0; k < 3 && !ok; k++) { try { const at = Date.now(); await this._drive(p.rest); ok = true; keep({ at, set, idx: 1, batch, ch: p.ch, v: p.rest, types: p.second, door: p.door }); } catch (e) { last = e; await sleep(300); } }
            if (!ok) {
              const m = `Sync pulse could not put ${p.ch} back to ${p.rest ? 'on' : 'off'}: ${last && last.message}. Check the relay now.`;
              console.error('[Trace] ' + m);
              if (this.run) this._patchMeta(this.run.id, { syncError: m });
              throw err(m, 500);
            }
          }
        }
        await sleep(s.gapsMs[1] ?? 2000);
        return sent;
      }
      for (let i = 0; i < s.cards.length; i++) {
        const c = s.cards[i];
        const at = Date.now();
        await this._sendCard(c);
        keep({ at, fc: c.fc, cn: String(c.cn), set, idx: i, batch });
        await sleep(s.gapsMs[i] ?? s.gapsMs[s.gapsMs.length - 1] ?? 2000);
      }
      for (const e of this.live) if (e.src === 'journal' && e.type === 'card' && sent.some(x => Math.abs(x.at - e.at) < 400)) { e.info = { ...(e.info || {}), sync: set }; }
      return sent;
    } finally { this.syncBusy = false; }
  }

  // ── wiring map (shared with Log Analytics › Product Test) ─────────────
  wiring() {
    try {
      const st = fs.statSync(ANALYTICS_SETTINGS);
      if (this._wiring && this._wiring.mtime === st.mtimeMs) return this._wiring.value;
      const value = cleanWiring(readAnalyticsSettings().wiring);
      this._wiring = { mtime: st.mtimeMs, value };
      return value;
    } catch { return {}; }
  }
  _readAnalytics() {
    if (!fs.existsSync(ANALYTICS_SETTINGS)) return {};
    try { return JSON.parse(fs.readFileSync(ANALYTICS_SETTINGS, 'utf8')) || {}; }
    catch { throw err('Log Analytics settings.json is damaged; fix or remove it before saving the wiring (it also holds thresholds and the Show raw switch)', 409); }
  }
  _writeWiring(wiring, doorsAt) {
    const s = this._readAnalytics();
    s.wiring = wiring;
    if (doorsAt) s.wiringDoorsAt = doorsAt;   // door config version last imported (start-up check)
    writeAtomic(ANALYTICS_SETTINGS, JSON.stringify(s, null, 1));
    this._wiring = null; this._cache = null;
    return s.wiring;
  }
  _readDoorConfig() {
    let raw;
    try { raw = fs.readFileSync(DOORS_CONFIG, 'utf8'); } catch { return null; }
    try { return JSON.parse(raw); } catch { throw err('The Doors page config (door-config.json) is damaged; open the Doors page and save it again', 409); }
  }

  /**
   * Save the wiring map. Entries that came from a door (src "door:N") push their OnCAFE door, description
   * and DPS sense back to that door on the Doors page, so the two stay paired. Last save wins.
   */
  saveWiring(w, by = 'event trace', base = null) {
    const prev = this.wiring();
    // a Setup tab opened before a door was saved would push its older copy back: refuse, ask for a reload
    if (base != null && Number.isFinite(Number(base)) && wiringVersion(prev) > Number(base)) {
      throw err('The wiring changed since you opened it (a door was saved on the Doors page, or another tab saved). Press Refresh, then make your change again.', 409);
    }
    const resets = Object.entries(w && typeof w === 'object' ? w : {}).filter(([, e]) => e && e.reset).map(([k]) => k);
    const next = cleanWiring(w);
    const now = Date.now();
    let cfg = null, damaged = false;
    try { cfg = this._readDoorConfig(); } catch { damaged = true; }   // a damaged door config: wiring still saves, nothing goes back to doors
    const owned = new Map();   // key -> door entry, from the door config as it is now
    if (cfg) for (const d of doorsFrom(cfg)) for (const { key, entry } of doorChannels(d)) owned.set(key, entry);
    const owns = k => damaged || owned.has(k);
    // door entries the client still has but no door owns any more (door deleted / moved): gone, or back to the manual mapping
    for (const [k, e] of Object.entries(next)) {
      if (!/^door:\d+$/.test(e.src || '') || owns(k)) continue;
      if (e.was) next[k] = e.was; else delete next[k];
    }
    // door entries the client did not send are kept as they are (a partial save never switches doors off;
    // Setup turns a door row off explicitly by setting it to "ignore", which pins it)
    for (const [k, e] of Object.entries(prev)) {
      if (/^door:\d+$/.test(e.src || '') && owns(k) && !next[k]) next[k] = e;
    }
    const patch = new Map();   // door id -> { oncafeDoorId, note, flipDps }
    for (const [k, e] of Object.entries(next)) {
      const m = /^door:(\d+)$/.exec(e.src || '');
      if (!m) continue;
      const before = prev[k] || {};
      const doorDps = /^door:\d+:dps$/.test(k);
      // anything other than pairing / description / door DPS sense is an override: imports keep it until reset
      if ((e.role !== before.role && before.role) || ((e.label || '') !== (before.label || '') && before.label) || (!doorDps && (e.active || 'open') !== (before.active || 'open') && before.role)) e.pin = true;
      const p = patch.get(m[1]) || {};
      if ((e.door || '') !== (before.door || '')) p.oncafeDoorId = e.door || '';
      if ((e.note || '') !== (before.note || '')) p.note = e.note || '';
      if (e.role === 'dps' && doorDps && (e.active || 'open') !== (before.active || 'open')) { p.flipDps = true; e.active = 'open'; }   // the door keeps the sense
      if (Object.keys(p).length) patch.set(m[1], p);
    }
    for (const k of resets) if (next[k]) delete next[k].pin;
    if (patch.size && cfg) {
      const list = cfg.config && cfg.config.doors ? cfg.config.doors : cfg.doors;
      if (Array.isArray(list)) {
        const inv = this.cloud.inv || {};
        for (const d of list) {
          const p = patch.get(String(d.id));
          if (!p) continue;
          const t = { ...(d.trace || {}) };
          if ('oncafeDoorId' in p) { t.oncafeDoorId = p.oncafeDoorId || undefined; t.oncafeDoorName = ((inv.doors || []).find(x => x.id === p.oncafeDoorId) || {}).name || undefined; }
          if ('note' in p) t.note = p.note || undefined;
          if (p.flipDps && d.dps) { d.dps = { ...d.dps, reverseSense: !d.dps.reverseSense }; t.dpsSense = d.dps.reverseSense; }
          t.updatedAt = new Date(now).toISOString(); t.by = by;
          d.trace = t;
          // every entry of that door follows (one door = one OnCAFE door, one description)
          for (const [k, e] of Object.entries(next)) {
            if (e.src !== `door:${d.id}`) continue;
            if ('oncafeDoorId' in p) { if (p.oncafeDoorId) e.door = p.oncafeDoorId; else delete e.door; }
            if ('note' in p) { if (p.note) e.note = p.note; else delete e.note; }
            if (p.flipDps && e.via === `door:${d.id}:dps` && !e.pin) e.active = d.dps.reverseSense ? 'closed' : 'open';   // the raw wire's polarity follows
            void k;
          }
        }
        cfg.savedAt = new Date(now).toISOString();
        writeAtomic(DOORS_CONFIG, JSON.stringify(cfg, null, 2));
        this.doorSync = { by, at: now, doors: [...patch.keys()].map(Number) };
      }
    }
    for (const [k, e] of Object.entries(next)) if (JSON.stringify(e) !== JSON.stringify(prev[k] || null)) e.at = now;
    const saved = this._writeWiring(next);
    if (resets.length) { this.importDoors(by); return this.wiring(); }   // reset entries are rebuilt from their door
    return saved;
  }

  /**
   * A Doors page save is about to overwrite door-config.json. A page opened before Event Trace changed a door's
   * pairing would post its older copy; keep the newer pairing (and the DPS sense it set) instead. Last save wins.
   */
  mergeDoorSave(body) {
    const list = body && Array.isArray(body.doors) ? body.doors : null;
    if (!list) return 0;
    let disk;
    try { disk = this._readDoorConfig(); } catch { return 0; }
    const dl = disk && (disk.config && disk.config.doors ? disk.config.doors : disk.doors);
    if (!Array.isArray(dl)) return 0;
    const byId = new Map(dl.filter(d => d && d.id != null).map(d => [String(d.id), d]));
    let n = 0;
    for (const d of list) {
      if (!d || typeof d !== 'object') continue;
      const old = byId.get(String(d.id));
      const dt = old && old.trace;
      if (!dt || !dt.updatedAt) continue;
      const it = d.trace;
      const newer = !it || !it.updatedAt || Date.parse(dt.updatedAt) > Date.parse(it.updatedAt);
      if (!newer) continue;
      d.trace = dt;
      if (typeof dt.dpsSense === 'boolean' && d.dps && typeof d.dps === 'object' && /event trace/.test(dt.by || '')) d.dps = { ...d.dps, reverseSense: dt.dpsSense };
      n++;
    }
    return n;
  }

  /**
   * Doors page → wiring map: every door's channels replace what an earlier import (or edit) left for it.
   * Called after the Doors page saves, and at start-up when the door config is newer than the wiring.
   */
  importDoors(by = 'doors page') {
    const cfg = this._readDoorConfig();              // throws on a damaged file: the wiring is left as it is
    const at = cfg ? Date.parse(cfg.savedAt || cfg.timestamp || '') || Date.now() : Date.now();
    const doors = cfg ? doorsFrom(cfg) : [];          // no file (config deleted): every door entry goes
    const owned = new Map();
    for (const d of doors) for (const { key, entry } of doorChannels(d)) owned.set(key, entry);
    const prev = this.wiring();
    const next = {};
    for (const [k, e] of Object.entries(prev)) {
      if (!/^door:\d+$/.test(e.src || '')) { next[k] = e; continue; }
      if (owned.has(k) && e.pin) { next[k] = e; continue; }        // edited in Event Trace: kept until reset
      if (!owned.has(k) && e.was) next[k] = e.was;                 // the door let go: the manual mapping comes back
    }
    let n = 0;
    for (const [k, entry] of owned) {
      const cur = next[k];
      if (cur && cur.pin && /^door:\d+$/.test(cur.src || '')) continue;
      const p = prev[k];
      const was = p && !/^door:\d+$/.test(p.src || '') ? p : p && p.was ? p.was : null;
      const keep = p && p.src === entry.src && JSON.stringify({ ...p, at: 0 }) === JSON.stringify({ ...entry, ...(was ? { was } : {}), at: 0 });
      next[k] = { ...entry, ...(was ? { was } : {}), at: keep ? p.at : at };
      n++;
    }
    this._writeWiring(cleanWiring(next), at);
    this.doorSync = { by, at: Date.now(), doors: doors.map(d => d.id) };
    return { doors: doors.length, entries: n };
  }
  _importIfNewer() {
    try {
      const cfg = this._readDoorConfig();
      if (!cfg) return;
      const at = Date.parse(cfg.savedAt || cfg.timestamp || '') || 0;
      const latest = Math.max(Number(this._readAnalytics().wiringDoorsAt) || 0, ...Object.values(this.wiring()).filter(e => /^door:/.test(e.src || '')).map(e => e.at || 0));
      if (at > latest + 1000) this.importDoors('doors page (newer at start-up)');
    } catch (e) { console.warn('[Trace] door import at start-up:', e.message); }
  }

  /** lib/doorActivity entries (Doors page I/O, already resolved per door) → Event Trace journal events. */
  onDoorActivity(entry, meta) {
    if (!entry || !meta || meta.initial) return;
    if (!['lock', 'dps', 'rex', 'input'].includes(entry.kind)) return;
    const ch = channelOfActivity(meta.key);
    if (!ch) return;
    const v = meta.value === 1 || meta.value === 0 ? meta.value : null;
    const w = this.wiring()[ch] || {};
    const type = w.dir === 'out' ? 'door-out' : w.dir === 'in' ? 'door-in' : entry.source === 'panel' ? 'door-out' : 'door-in';
    const doorName = w.doorName || `Door ${entry.doorId}`;
    if (v === null) {   // a zone fault (TROUBLE / TAMPER): show it, but it is not an edge
      this.add({ id: newId(), src: 'journal', lane: 'aether', at: entry.t, t: entry.t, clock: 'pi', type: 'door-fault', label: `${doorName}: ${entry.text}`, door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null, access: false, info: { doorId: entry.doorId, ch } });
      return;
    }
    this.add({ id: newId(), src: 'journal', lane: 'aether', at: entry.t, t: entry.t, clock: 'pi', type, label: `${doorName}: ${entry.text}`,
      door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null, access: false,
      info: { ch, v, doorId: entry.doorId, source: entry.source }, journal: { ch, v, k: type } });
  }

  /** What Event Trace knows about each Aether door (for the Doors page). */
  doorsSummary() {
    let cfg = null;
    try { cfg = this._readDoorConfig(); } catch (e) { return { error: e.message, doors: [] }; }
    const doors = cfg ? doorsFrom(cfg) : [];
    const wiring = this.wiring();
    let a = null;
    try { a = this.analyze(this.run ? this.run.id : null); } catch { a = null; }
    const traces = a ? a.traces.filter(t => !t.sync) : [];
    const inv = this.cloud.inv || {};
    const dcfg = this.settings.cloud.doorConfig || {};
    const out = doors.map(d => {
      const t = d.trace || {};
      const own = doorChannels(d).map(x => x.key);
      const readers = readerChannels(d.reader);
      const oc = t.oncafeDoorId || null;
      const mine = traces.filter(x => (x.action.ch && (own.includes(x.action.ch) || readers.includes(x.action.ch)))
        || (oc && x.decision && x.decision.door && x.decision.door.id === oc && x.kind === 'card')
        || (oc && x.kind === 'command' && [].concat((x.action.cmd || {}).target || []).includes(oc)));
      const last = k => { const r = mine.filter(x => x.kind === k).sort((p, q) => q.at - p.at)[0]; return r || null; };
      const brief = x => x && { at: x.at, status: x.status, label: x.kind === 'card' ? `${x.action.cred ? `${x.action.cred.fc ?? '?'}-${x.action.cred.cn ?? '?'}` : 'card'}` : x.action.label, result: x.result, notes: x.notes.slice(0, 2),
        push: x.latency.push, decision: x.latency.decision, output: x.latency.output, hardware: x.latency.hardware, held: x.held ?? null, cause: x.cause ? x.cause.label : null };
      return {
        id: d.id, name: d.name, enabled: d.enabled !== false, ioSource: d.ioSource || 'physical',
        oncafe: oc ? { id: oc, name: t.oncafeDoorName || ((inv.doors || []).find(x => x.id === oc) || {}).name || null } : null,
        note: t.note || '', updatedAt: t.updatedAt || null, by: t.by || null,
        channels: own.filter(k => /^door:/.test(k)).map(k => ({ key: k, role: (wiring[k] || {}).role || null, label: (wiring[k] || {}).label || k, overridden: !!(wiring[k] && wiring[k].pin) })),
        grantMs: oc && dcfg[oc] ? dcfg[oc].grantMs : null,
        counts: { pass: mine.filter(x => x.status === 'pass').length, warn: mine.filter(x => x.status === 'warn').length, fail: mine.filter(x => x.status === 'fail').length },
        last: { card: brief(last('card')), input: brief(last('input')), output: brief(last('output')), command: brief(last('command')) },
      };
    });
    return { doors: out, run: this.run ? { id: this.run.id, name: this.run.name } : null, sync: this.doorSync || null, configSavedAt: cfg ? cfg.savedAt || null : null };
  }

  /** Channels Aether drove or saw in the last 24 h (for the wiring editor). */
  channelsSeen() {
    const out = new Map();
    let list = [];
    try { list = this.journal ? this.journal.read({ from: Date.now() - 86400000 }) : []; } catch { list = []; }
    for (const e of list) {
      if (!['relay', 'gpio', 'emu-in', 'opto', 'emu-out'].includes(e.k)) continue;
      const c = out.get(e.ch) || { ch: e.ch, kind: e.k, count: 0, last: 0 };
      c.count++; c.last = Math.max(c.last, e.t);
      out.set(e.ch, c);
    }
    let roles = {};
    try { roles = this.analyze(this.run ? this.run.id : null).roles || {}; } catch { roles = {}; }
    for (const [k, e] of Object.entries(this.wiring())) if (/^door:/.test(k) && !out.has(k)) out.set(k, { ch: k, kind: e.dir === 'out' ? 'door-out' : 'door-in', count: 0, last: 0 });
    return [...out.values()].sort((a, b) => a.ch.localeCompare(b.ch, undefined, { numeric: true })).map(c => ({ ...c, inferred: roles[c.ch] && roles[c.ch].auto ? roles[c.ch] : null }));
  }

  /** Strike times of the doors under test (for the "strike held" check). */
  async refreshDoorConfig() {
    const c = this.settings.cloud;
    if (!c.url || !c.org || !c.doors.length) return c.doorConfig;
    const cfg = await this.cloud.doorConfig(c.url, c.org, c.doors).catch(() => null);
    if (cfg && Object.keys(cfg).length) this.saveSettings({ cloud: { doorConfig: cfg } });
    return this.settings.cloud.doorConfig;
  }

  // ── commands to OnCAFE (sent by Aether) ───────────────────────────────
  _nameOf(cmd) {
    const inv = this.cloud.inv || {};
    const t = [].concat(cmd.target || [])[0];
    const hit = [...(inv.doors || []), ...(inv.areas || []), ...(inv.zones || [])].find(x => x.id === t);
    return hit ? hit.name : null;
  }
  async command(c, who) {
    const st = this.settings;
    if (!st.commands.enabled) throw err('Sending commands is turned off (Setup › Commands)', 403);
    if (!st.cloud.url || !st.cloud.org) throw err('Set up OnCAFE first (Setup › OnCAFE)', 400);
    const inv = this.cloud.inv && this.cloud.inv.org === st.cloud.org && Date.now() - this.cloud.inv.at < 10 * 60000 ? this.cloud.inv : await this.cloud.inventory(st.cloud.url, st.cloud.org);
    const kind = String(c.kind || '');
    const target = String(c.target || '');
    const doors = st.cloud.doors;
    let cmd;
    if (['override', 'maintenance', 'shunt'].includes(kind)) {
      if (!doors.includes(target)) throw err('Commands only go to the doors under test (Setup › OnCAFE)', 403);
      const d = inv.doors.find(x => x.id === target);
      cmd = { kind, target, value: kind === 'override' ? (c.value === 'lock' ? 'lock' : 'unlock') : !!c.value, area: d && d.areaIds[0], seconds: c.seconds, targetName: d && d.name };
    } else if (kind === 'lockdown') {
      const allowed = new Set(inv.doors.filter(d => doors.includes(d.id)).flatMap(d => d.areaIds));
      if (!allowed.has(target)) throw err('Lockdown only goes to an area that holds a door under test', 403);
      cmd = { kind, target, value: !!c.value, targetName: (inv.areas.find(a => a.id === target) || {}).name };
    } else if (kind === 'outputzone' || kind === 'inputzone') {
      const z = inv.zones.find(x => x.id === target);
      if (!z) throw err('Unknown zone', 400);
      if (!st.cloud.zones.includes(target)) throw err('Commands only go to the zones under test (Setup › OnCAFE)', 403);
      cmd = { kind, target, value: kind === 'outputzone' ? (c.value === 'activate' ? 'activate' : 'deactivate') : (c.value === 'arm' ? 'arm' : 'disarm'), targetName: z.name };
    } else throw err('Unknown command', 400);
    const area = cmd.area && inv.areas.find(a => a.id === cmd.area);
    const { r, e } = await this._send(cmd, { tz: area && area.tz }, `Aether (${String(who || '?').slice(0, 40)})`);
    // only an "on" command is turned back (lockdown on, maintenance on, shunt, activate, arm) — never an "off"
    const engaging = (cmd.kind === 'lockdown' || cmd.kind === 'maintenance' || cmd.kind === 'shunt') ? cmd.value === true : cmd.kind === 'outputzone' ? cmd.value === 'activate' : cmd.kind === 'inputzone' ? cmd.value === 'arm' : false;
    const back = engaging ? reverseOf(cmd) : null;
    const revertSec = Math.max(0, Math.min(3600, Number(c.revertSec) || 0));
    if (r.ok && back && revertSec) this._scheduleRevert({ id: e.id, due: Date.now() + revertSec * 1000, cmd: back, who: String(who || '?').slice(0, 40), url: st.cloud.url, org: st.cloud.org });
    return { ok: r.ok, status: r.status, ackMs: r.ackMs, error: r.error || null, event: e.id, revertIn: r.ok && back && revertSec ? revertSec : null };
  }

  /** Send a command and record it (used by command() and by reverts, which skip the on/off and scope checks on purpose). */
  async _send(cmd, ctx, by, target = this.settings.cloud) {
    const req = buildRequest(cmd, ctx);
    const at = Date.now();
    let r;
    try { r = await this.cloud.command(target.url, target.org, req); } catch (x) { r = { ok: false, status: 0, ackMs: Date.now() - at, error: x.message }; }
    const e = this.add(commandEvent(cmd, { src: 'command', at, by, ackMs: r.ackMs, status: r.status, error: r.ok ? undefined : r.error, via: 'Aether' }), { request: req, response: r.data !== undefined ? r.data : r.error });
    return { r, e };
  }

  // pending reverts survive a backend restart; an overdue one runs as soon as Aether is back
  _reverts() { try { return JSON.parse(fs.readFileSync(REVERTS, 'utf8')) || []; } catch { return []; } }
  _saveReverts(list) { try { writeAtomic(REVERTS, JSON.stringify(list)); } catch { /* */ } }
  _scheduleRevert(p) {
    const list = this._reverts().filter(x => x.id !== p.id).concat(p);
    this._saveReverts(list);
    this._armRevert(p);
  }
  _armRevert(p) {
    const t = setTimeout(async () => {
      const { r } = await this._send(p.cmd, {}, `Aether (${p.who}, automatic turn-back)`, { url: p.url, org: p.org });
      this._saveReverts(this._reverts().filter(x => x.id !== p.id));
      if (!r.ok) console.error(`[Trace] automatic turn-back failed (${p.cmd.kind} ${p.cmd.targetName || p.cmd.target}): ${r.error}`);
    }, Math.max(0, p.due - Date.now()));
    if (t.unref) t.unref();
  }
  pendingReverts() { return this._reverts().map(p => ({ id: p.id, due: p.due, kind: p.cmd.kind, value: p.cmd.value, target: p.cmd.targetName || p.cmd.target })); }

  // ── runs ───────────────────────────────────────────────────────────────
  _metaPath(id) { return path.join(runDir(id), 'meta.json'); }
  _patchMeta(id, patch) {
    try { const p = this._metaPath(id); const m = JSON.parse(fs.readFileSync(p, 'utf8')); Object.assign(m, patch); fs.writeFileSync(p, JSON.stringify(m)); return m; } catch { return null; }
  }
  listRuns() {
    try {
      return fs.readdirSync(RUNS).map(id => { try { return JSON.parse(fs.readFileSync(this._metaPath(id), 'utf8')); } catch { return null; } })
        .filter(Boolean).sort((a, b) => b.start - a.start);
    } catch { return []; }
  }

  async startRun(name, opt = {}) {
    if (this.run) await this.stopRun('superseded', { skipSync: true });
    const id = `trace-${Date.now().toString(36)}`;
    const dir = path.join(RUNS, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = { id, name: String(name || 'Trace run').slice(0, 120), start: Date.now(), end: null, syncs: [], settings: scrub(this.settings), imports: [], note: String(opt.note || '').slice(0, 500) };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    this.run = { ...meta, dir, vault: new Vault(dir), count: 0, lastAt: meta.start, events: [], wbuf: [], wtimer: null };
    if (this.journal) this.journal.record('marker', 'trace', 1, 'ui', { event: 'trace-start', name: meta.name, trace: true });
    // old runs
    const all = this.listRuns();
    for (const r of all.slice(KEEP_RUNS)) { try { fs.rmSync(runDir(r.id), { recursive: true, force: true }); } catch { /* */ } }
    const doSync = opt.sync !== false && this.settings.sync.atStart;
    if (doSync) this.sendSync('start').catch(e => this._patchMeta(id, { syncError: e.message }));
    clearInterval(this._syncTimer);
    if (this.settings.sync.everyMin > 0) {
      this._syncTimer = setInterval(() => this.sendSync('check').catch(() => {}), this.settings.sync.everyMin * 60000);
      if (this._syncTimer.unref) this._syncTimer.unref();
    }
    return meta;
  }

  async stopRun(reason = 'stopped', opt = {}) {
    const r = this.run;
    if (!r || r.stopping) return null;
    r.stopping = true;
    clearInterval(this._syncTimer); this._syncTimer = null;
    if (!opt.skipSync && this.settings.sync.atEnd && opt.sync !== false) {
      try { while (this.syncBusy) await sleep(200); if (this.run === r) await this.sendSync('end'); await sleep(Math.min(8000, this.settings.thresholds.matchWindowMs)); } catch (e) { this._patchMeta(r.id, { syncError: e.message }); }
    }
    if (this.run === r) this.run = null;
    this._flushRun(r, true);
    if (this.journal) this.journal.record('marker', 'trace', 0, 'ui', { event: 'trace-stop', reason, trace: true });
    return this._patchMeta(r.id, { end: Date.now(), endReason: reason, count: r.count });
  }

  readEvents(id) {
    const dir = runDir(id);
    if (this.run && this.run.id === id) return this.run.events.slice();
    const out = [];
    try {
      for (const line of fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n')) { if (line) { try { out.push(JSON.parse(line)); } catch { /* */ } } }
    } catch { /* none yet */ }
    return out;
  }

  analyze(id) {
    if (id) runDir(id);
    const key = `${id || 'live'}|${id && this.run && this.run.id === id ? this.run.count : id ? 'done' : this.seq}|${this._wiring ? this._wiring.mtime : ''}|${this._settingsRev || 0}`;
    if (this._cache && this._cache.key === key && Date.now() - this._cache.at < (id && !(this.run && this.run.id === id) ? 60000 : 1000)) return this._cache.value;
    const meta = id ? (this.run && this.run.id === id ? { id: this.run.id, name: this.run.name, start: this.run.start, end: null, syncs: this.run.syncs, imports: this.run.imports } : (() => { try { return JSON.parse(fs.readFileSync(this._metaPath(id), 'utf8')); } catch { return null; } })()) : null;
    if (id && !meta) throw err('That run no longer exists', 404);
    const events = id ? this.readEvents(id) : this.live;
    const syncs = id ? (meta.syncs || []) : (this.liveSyncs || []);
    const res = correlate(events, syncs, { ...this.settings, doorConfig: this.settings.cloud.doorConfig }, { wiring: this.wiring() });
    const value = { meta: meta ? { id: meta.id, name: meta.name, start: meta.start, end: meta.end, endReason: meta.endReason, syncError: meta.syncError, imports: meta.imports || [], count: events.length, running: !!(this.run && this.run.id === id) } : null, ...res };
    this._cache = { key, at: Date.now(), value };
    return value;
  }

  deleteRun(id) {
    if (this.run && this.run.id === id) throw err('Stop the run before deleting it', 409);
    fs.rmSync(runDir(id), { recursive: true, force: true });
  }

  /** Plain payload of one event, if allowed. Every reveal is logged. */
  reveal(runId, eventId, who) {
    if (!this.settings.allowRaw) throw err('Showing plain text is turned off (Setup › Privacy)', 403);
    let raw;
    if (runId) {
      const v = this.run && this.run.id === runId ? this.run.vault : new Vault(runDir(runId));
      raw = v.reveal(eventId, who);
      if (raw === undefined && this.liveVault.has(eventId)) raw = this.liveVault.get(eventId);   // seen before the run started
    } else {
      raw = this.liveVault.get(eventId);
      if (raw === undefined && this.run) raw = this.run.vault.get(eventId);
      this.liveLog.reveal(eventId, who);
    }
    if (raw === undefined) throw err('The original of that event is not kept', 404);
    console.log(`[Trace] plain text of an event shown to ${String(who || '?').replace(/[\r\n]/g, ' ').slice(0, 60)}`);
    return raw;
  }

  // ── imports (after the fact) ───────────────────────────────────────────
  _importInto(id, events, rawList, what) {
    const dir = runDir(id);
    if (!fs.existsSync(dir)) throw err('That run no longer exists', 404);
    const vault = this.run && this.run.id === id ? this.run.vault : new Vault(dir);
    const lines = [];
    events.forEach((e, i) => {
      e.seq = ++this.seq;
      const raw = rawList ? rawList[i] : undefined;
      if (typeof e.label === 'string') e.label = scrubString(e.label);
      if (e.info) e.info = scrub(e.info);
      if (raw !== undefined && raw !== null) { e.hasRaw = true; e.detail = scrub(raw); e.secret = hasSecrets(raw, e.detail); vault.put(e.id, raw); }
      lines.push(JSON.stringify(e));
    });
    const cur = this.run && this.run.id === id ? this.run : null;
    if (cur) { cur.events.push(...events); for (const l of lines) this._queueWrite(cur, l); }
    else if (lines.length) fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
    this._cache = null;
    const m = this._patchMeta(id, {});
    if (m) { m.imports = (m.imports || []).concat({ at: Date.now(), what, count: events.length }); fs.writeFileSync(this._metaPath(id), JSON.stringify(m)); }
    if (cur) { cur.count += events.length; if (m) cur.imports = m.imports; }
    return { imported: events.length };
  }

  importReport(id, reportId) {
    if (!/^[\w.-]+$/.test(String(reportId))) throw err('Bad report id');
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(REPORTS, reportId + '.json'), 'utf8')); } catch { throw err('That Log Analytics report was not found', 404); }
    const ev = fromReport(report);
    return this._importInto(id, ev, null, `Log Analytics report ${reportId} (${ev.length} controller events)`);
  }

  listReports() {
    try {
      return fs.readdirSync(REPORTS).filter(f => f.endsWith('.meta.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf8')); } catch { return null; } })
        .filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30);
    } catch { return []; }
  }

  /** Packets the page pulled out of a capture: [{ ts, src, dst, sport, dport, bytes, sni?, proto }] */
  importWire(id, packets) {
    const ips = this.settings.wire.controllerIps;
    const list = (Array.isArray(packets) ? packets : []).slice(0, 20000).filter(p => Number.isFinite(p.ts) && (!ips.length || ips.includes(p.src) || ips.includes(p.dst)));
    const events = list.map(p => {
      const out = !ips.length || ips.includes(p.src);
      const at = Math.round(p.ts);
      return { id: newId(), src: 'wire', lane: 'wire', at, t: at, clock: 'pi', dir: out ? 'out' : 'in', type: out ? (p.sni ? 'egress-tls' : 'egress') : 'ingress',
        label: `${out ? '↑' : '↓'} ${p.bytes || 0} B ${out ? '→' : '←'} ${(out ? p.dst : p.src)}:${out ? p.dport : p.sport}${p.sni ? ' · ' + p.sni : ''}`,
        door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null, access: false,
        info: { src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, bytes: p.bytes, sni: p.sni, proto: p.proto } };
    });
    return this._importInto(id, events, null, `packet capture (${events.length} packets from the controllers)`);
  }

  /** HAR of the OnCAFE web app: event-log responses and MQTT frames, browser clock. */
  importHar(id, text) {
    runDir(id);
    if (String(text).length > 60 * 1024 * 1024) throw err('That HAR is over 60 MB. Save a shorter one (just the test window) and add it again.', 413);
    let har;
    try { har = JSON.parse(text); } catch { throw err('That file is not a HAR (JSON)'); }
    const entries = (har.log && har.log.entries) || [];
    const events = [], raws = [];
    for (const e of entries) {
      const url = String((e.request || {}).url || '');
      const started = Date.parse(e.startedDateTime);
      if (/\/acstimeline\/.*events/.test(url) && e.response && e.response.content && e.response.content.text) {
        let j; try { j = JSON.parse(e.response.content.encoding === 'base64' ? Buffer.from(e.response.content.text, 'base64').toString('utf8') : e.response.content.text); } catch { j = null; }
        const items = j && j.data && (j.data.events || (Array.isArray(j.data) ? j.data : null));
        const at = Number.isFinite(started) ? Math.round(started + (e.time || 0)) : null;
        for (const it of items || []) for (const ev of fromCloud(it, { src: 'har', at })) { ev.clock = 'controller'; ev.harVia = 'event-log'; events.push(ev); raws.push(it); }
      }
      const rq = e.request || {};
      if (rq.method && rq.method !== 'GET' && rq.method !== 'OPTIONS') {
        const cmd = parseCommand(rq.method, url, rq.postData && rq.postData.text);
        if (cmd && Number.isFinite(started)) {
          cmd.targetName = this._nameOf(cmd);
          const st = e.response && e.response.status;
          events.push(commandEvent(cmd, { src: 'har', at: Math.round(started), clock: 'browser', by: 'browser (HAR)', ackMs: Math.round(e.time || 0), status: st, error: st >= 400 ? `HTTP ${st}` : undefined, via: 'HAR' }));
          raws.push({ request: { method: rq.method, url, body: rq.postData && rq.postData.text }, status: st });
        }
      }
      const msgs = e._webSocketMessages;
      if (msgs && /\/mqtt/.test(url)) {
        for (const m of msgs) {
          if (m.type !== 'receive' || m.opcode !== 2 || !m.data) continue;
          let pubs; try { pubs = decodePublishes(Buffer.from(m.data, 'base64')); } catch { continue; }
          for (const p of pubs) {
            if (p.type !== 3) continue;
            let j; try { j = JSON.parse(p.payload.toString('utf8')); } catch { continue; }
            const at = Math.round(m.time * 1000);
            for (const ev of fromCloud(j, { src: 'har', at, topic: p.topic })) { ev.harVia = 'mqtt'; events.push(ev); raws.push(j); }
          }
        }
      }
    }
    // dedupe the event log (the page re-reads it many times): keep the first sighting
    const seen = new Set(), ev2 = [], raw2 = [];
    events.forEach((e, i) => { const k = e.type === 'command' ? `cmd|${e.id}` : `${e.harVia}|${e.eventId || ''}|${e.type}|${e.t}|${e.door && e.door.id}`; if (seen.has(k)) return; seen.add(k); ev2.push(e); raw2.push(raws[i]); });
    return this._importInto(id, ev2, raw2, `HAR (${ev2.length} cloud events, browser clock)`);
  }

  status() {
    return {
      run: this.run ? { id: this.run.id, name: this.run.name, start: this.run.start, count: this.run.count, syncs: this.run.syncs } : null,
      syncBusy: this.syncBusy, seq: this.seq,
      sources: {
        journal: { ok: !!this.journal },
        cloud: this.cloud.status(),
        wire: { controllerIps: this.settings.wire.controllerIps, traffic: (() => { try { const m = require('../routes/traffic').current; return m ? { state: m.state, gateway: !!(m.running && m.running.gateway && m.running.gateway.enabled) } : null; } catch { return null; } })() },
      },
      channels: this.channels(),
      settings: this.settings,
      wiring: this.wiring(),
      pendingReverts: this.pendingReverts(),
      doorSync: this.doorSync || null,
      inventory: this.cloud.inv ? { org: this.cloud.inv.org, at: this.cloud.inv.at, doors: this.cloud.inv.doors, areas: this.cloud.inv.areas, zones: this.cloud.inv.zones, controllers: this.cloud.inv.controllers } : null,
    };
  }
}

module.exports = { TraceEngine, cleanSettings, DEFAULTS, toMs };
