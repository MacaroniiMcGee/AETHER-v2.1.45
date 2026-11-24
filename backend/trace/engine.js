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
const { cleanSequence, template, TEMPLATES, stepText, grade } = require('./tests');      // TRACE-4
const { integrity } = require('./integrity');
const { compare } = require('./compare');
const { frameToEvent } = require('./readerfeedback');   // TRACE-5
const { checkControllers } = require('./clockcheck');
const { checkLinks, linkChanges } = require('./linkcheck');   // TRACE-8
const { suggestWiring } = require('./suggest');

const BASE = path.join(__dirname, '..', 'data', 'trace');
const RUNS = path.join(BASE, 'runs');
const SETTINGS = path.join(BASE, 'settings.json');
const REVERTS = path.join(BASE, 'pending-reverts.json');
const SEQUENCES = path.join(BASE, 'sequences.json');      // TRACE-4 test sequences
const TOUCHED = path.join(BASE, 'test-touched.json');     // DPS / REX / commands a running test has engaged (released after a restart)
const TEST_LOG = 'test-log.jsonl';
const DISCOVER_TOUCH = path.join(BASE, 'discover-touched.json');   // TRACE-5: the relay Discover has switched away (put back after a restart)
const DISCOVER = path.join(BASE, 'discover.json');          // TRACE-5: what the last Discover probe proved                         // per run: one line per test step
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
  alerts: { enabled: true, level: 'fail', automation: true },   // TRACE-4: live alerts (toast + Automation trigger)
  clock: { check: true, warnMs: 2000 },                            // TRACE-5: controller clocks over SUNAPI at run start
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
    clock: { check: !(s.clock && s.clock.check === false), warnMs: int(s.clock && s.clock.warnMs, 200, 600000, 2000) },
    alerts: { enabled: !(s.alerts && s.alerts.enabled === false), level: s.alerts && s.alerts.level === 'warn' ? 'warn' : 'fail', automation: !(s.alerts && s.alerts.automation === false) },
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
    this.test = null;          // TRACE-4: the test sequence running now (or the last one)
    this.alerts = [];          // TRACE-4: live alerts (newest last)
    this.alertSeq = 0;
    this._alerted = new Set();
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
    for (const r of this.listRuns()) {
      if (!r.end) this._patchMeta(r.id, { end: r.lastAt || r.start, endReason: 'backend restarted' });
      if (r.test && !r.test.endedAt) this._patchMeta(r.id, { test: { ...r.test, endedAt: r.lastAt || Date.now(), aborted: true, error: 'The backend restarted during the test' } });
    }
    setTimeout(() => this._releaseOrphans().catch(e => console.warn('[Trace] could not release what a test left engaged:', e.message)), 3000).unref();
    setTimeout(() => this._releaseDiscoverOrphan().catch(e => console.warn('[Trace] could not put back the relay Discover left switched:', e.message)), 3000).unref();
    for (const p of this._reverts()) this._armRevert(p);
    this._importIfNewer();   // Doors page saved while Event Trace was not looking: its doors win   // turn-backs that were waiting when the backend stopped
    this._alertTimer = setInterval(() => this._alertTick(), 2000);   // TRACE-4 live alerts
    if (this._alertTimer.unref) this._alertTimer.unref();
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
    const merged = cleanSettings({ ...this.settings, ...s, commands: { ...this.settings.commands, ...(s.commands || {}) }, alerts: { ...this.settings.alerts, ...(s.alerts || {}) }, clock: { ...this.settings.clock, ...(s.clock || {}) }, thresholds: { ...this.settings.thresholds, ...(s.thresholds || {}) }, cloud: { ...this.settings.cloud, ...(s.cloud || {}) }, sync: { ...this.settings.sync, ...(s.sync || {}), channel: { ...this.settings.sync.channel, ...((s.sync || {}).channel || {}) } } });
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
    if (this.discovering && this.discovering.state === 'running') throw err('Discover is running: sync markers wait until it is done', 409);
    this.syncBusy = true;
    const s = this.settings.sync;
    const sent = [];
    const batch = Date.now().toString(36);
    const keep = rec => { sent.push(rec); if (this.run) { this.run.syncs.push(rec); this._patchMeta(this.run.id, { syncs: this.run.syncs }); } this.liveSyncs = (this.liveSyncs || []).concat(rec).slice(-20); };   // the live view keeps the clock after a run too
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
    this._wiring = null; this._cache = null; this._caches = {};
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
      if (!this._reverts().some(x => x.id === p.id)) return;   // already turned back (a test sent the "off" itself)
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
    try { const p = this._metaPath(id); const m = JSON.parse(fs.readFileSync(p, 'utf8')); Object.assign(m, patch); writeAtomic(p, JSON.stringify(m)); return m; } catch { return null; }
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
    // TRACE-8: controller links at the start, then every 15 s while the run records (changes go into the run)
    this.checkLinks().then(L => { if (this.run && this.run.id === id) this._patchMeta(id, { links: L }); }).catch(() => {})
      .then(() => { if (this.settings.clock.check) return this.checkClocks().then(c => { if (c && c.available) this._patchMeta(id, { controllerClocks: c }); }); }).catch(() => {});   // TRACE-5
    clearInterval(this._linkTimer);
    this._linkTimer = setInterval(() => { if (this.run) this.checkLinks().catch(() => {}); }, 15000);
    if (this._linkTimer.unref) this._linkTimer.unref();
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
    clearInterval(this._linkTimer); this._linkTimer = null;
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

  analyze(id, slot = 'ui') {
    if (id) runDir(id);
    this._caches = this._caches || {};
    this._cache = this._caches[slot] || null;   // one cache per caller (page, alerts, compare) so they never evict each other
    const key = `${id || 'live'}|${id && this.run && this.run.id === id ? this.run.count : id ? 'done' : this.seq}|${this._wiring ? this._wiring.mtime : ''}|${this._settingsRev || 0}`;
    if (this._cache && this._cache.key === key && Date.now() - this._cache.at < (id && !(this.run && this.run.id === id) ? 60000 : 1000)) return this._cache.value;
    const meta = id ? (this.run && this.run.id === id ? { id: this.run.id, name: this.run.name, start: this.run.start, end: null, syncs: this.run.syncs, imports: this.run.imports } : (() => { try { return JSON.parse(fs.readFileSync(this._metaPath(id), 'utf8')); } catch { return null; } })()) : null;
    if (id && !meta) throw err('That run no longer exists', 404);
    const events = id ? this.readEvents(id) : this.live;
    const syncs = id ? (meta.syncs || []) : (this.liveSyncs || []);
    const res = correlate(events, syncs, { ...this.settings, doorConfig: this.settings.cloud.doorConfig }, { wiring: this.wiring() });
    res.integrity = integrity(events, { pollMs: this.settings.cloud.pollMs, apiEnabled: this.settings.cloud.poll, now: meta && meta.end ? meta.end + 60000 : Date.now() });
    const value = { meta: meta ? { id: meta.id, name: meta.name, start: meta.start, end: meta.end, endReason: meta.endReason, syncError: meta.syncError, controllerClocks: meta.controllerClocks || null, imports: meta.imports || [], count: events.length, running: !!(this.run && this.run.id === id), test: meta.test ? { sequence: meta.test.sequence, startedAt: meta.test.startedAt, endedAt: meta.test.endedAt || null } : (this.run && this.run.id === id && this.run.test ? { sequence: this.run.test.sequence, startedAt: this.run.test.startedAt, endedAt: null } : null) } : null, ...res };
    this._cache = this._caches[slot] = { key, at: Date.now(), value };
    return value;
  }

  deleteRun(id) {
    if (this.run && this.run.id === id) throw err('Stop the run before deleting it', 409);
    if (this.test && this.test.state !== 'done' && this.test.runId === id) throw err('A test is still using that run', 409);
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
    this._cache = null; this._caches = {};
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


  // ── TRACE-5: reader feedback (OSDP LED / buzzer from OSDP Trace) ────────
  async _releaseDiscoverOrphan() {
    let x = null;
    try { x = JSON.parse(fs.readFileSync(DISCOVER_TOUCH, 'utf8')); } catch { return; }
    if (!x || !Number.isInteger(x.ch) || !this.deps.gpioQueue || (this.discovering && this.discovering.state === 'running')) return;
    await this.deps.gpioQueue.enqueue('setRelay', x.ch, !!x.rest);
    try { fs.unlinkSync(DISCOVER_TOUCH); } catch { /* */ }
    console.log(`[Trace] Discover was interrupted by a restart: put REL${x.ch + 1} back ${x.rest ? 'on' : 'off'}`);
  }

  attachOsdpTrace(hub) {
    if (!hub || typeof hub.on !== 'function' || this._osdpHub === hub) return;
    this._osdpHub = hub;
    hub.on('frame', f => {
      if (!f || f.isReply || (f.name !== 'osdp_LED' && f.name !== 'osdp_BUZ')) return;   // cheap filter first: polls never get here
      try {
        const om = this.deps.getOsdp && this.deps.getOsdp();
        const readers = om && om.getReaders ? [].concat(om.getReaders() || []).map(r => ({ id: String(r.id ?? r.readerId), name: r.name, address: r.address, port: r.port || r.portPath || null })) : [];
        // the controller emulator's frames carry its serial port (e.g. /dev/ttyUSB1), not a name
        const em = this.deps.emulator, emPort = em && (em.portPath || (em.cfg && em.cfg.port));
        const e = frameToEvent(f, readers, { emuPorts: emPort ? [String(emPort)] : [] });
        if (e) this.add(e);
      } catch { /* never break OSDP Trace */ }
    });
  }

  // ── TRACE-5: controller clocks (SUNAPI) ────────────────────────────────
  // ── TRACE-8: can this Pi reach each controller (TCP to its web port; emulated Azure boards: is the IC2 polling them) ──
  async checkLinks() {
    if (this._linkP) return this._linkP;   // one check at a time; callers share it
    this._linkP = (async () => {
      const prev = this.links || null;
      const next = await checkLinks({ wireIps: this.settings.wire.controllerIps, emulator: this.deps.emulator });
      const ch = linkChanges(prev, next);
      this.links = next;
      if (ch.length) {
        this.linkLog = (this.linkLog || []).concat(ch).slice(-50);
        for (const c of ch) console.log(`[Trace] ${c.name} (${c.host}): link ${c.from} → ${c.to}`);
        if (this.run) { this.run.linkChanges = (this.run.linkChanges || []).concat(ch); this._patchMeta(this.run.id, { links: next, linkChanges: this.run.linkChanges }); }
        this.emit('link', ch);
      }
      return next;
    })().finally(() => { this._linkP = null; });
    return this._linkP;
  }

  async checkClocks(opt = {}) {
    // controllers this Pi cannot reach are not asked (no 8 s timeout); a check from the last 60 s is reused
    let L = this.links; if (!L || Date.now() - L.at > 60000) L = await this.checkLinks().catch(() => null);
    const unreachable = new Set(((L && L.controllers) || []).filter(c => c.source === 'sunapi' && c.link === 'down').map(c => c.id));
    const r = await checkControllers({ ...opt, unreachable });
    if (r && r.available) r.warnMs = this.settings.clock.warnMs;
    this.clockCheck = r;
    return r;
  }

  // ── TRACE-5: wiring suggestion + Discover probe ────────────────────────
  _probe() { try { return JSON.parse(fs.readFileSync(DISCOVER, 'utf8')); } catch { return null; } }
  suggest() {
    const chn = this.channels();
    const known = new Set([...chn.wiegand.map(r => `wiegand:${r.id}`), ...chn.osdp.map(r => `osdp:${r.id}`)]);
    let doors = [];
    try { doors = [...this._doorMap().values()].filter(x => x.enabled).map(x => ({ id: x.id, name: x.name, oncafe: x.oncafe, raw: x.raw, chs: x.chs, reader: x.d.reader || null, readerChannels: readerChannels(x.d.reader).filter(c => !/^(wiegand|osdp):/.test(c) || known.has(c)), dpsNc: !!(x.d.dps && x.d.dps.reverseSense) })); } catch { /* damaged door config: no doors page source */ }
    const inv = this.cloud.inv ? { doors: this.cloud.inv.doors || [], controllers: this.cloud.inv.controllers || [] } : null;
    return suggestWiring({ doors, wiring: this.wiring(), seen: this.channelsSeen(), probe: this._probe(), inventory: inv });
  }
  /** Take suggested rows into the wiring map (only channels a door does not own: those are set on the Doors page). */
  applySuggestion(chs, who) {
    const sug = this.suggest();
    const w = JSON.parse(JSON.stringify(this.wiring()));
    const done = [], skipped = [];
    for (const ch of [].concat(chs || [])) {
      const r = sug.rows.find(x => x.ch === ch);
      if (!r) continue;
      const cur = w[ch];
      if (cur && (cur.src || cur.via)) { skipped.push({ ch, why: 'owned by a door: change it on the Doors page' }); continue; }
      w[ch] = { ...(cur || {}), role: r.role === 'card' ? 'card' : r.role, ...(r.door ? { door: r.door } : {}), ...(r.role === 'dps' && r.active ? { active: r.active } : {}), note: (cur && cur.note) || `suggested (${r.source})` };
      done.push(ch);
    }
    if (done.length) this.saveWiring(w, `event trace suggestion (${who})`, wiringVersion(this.wiring()));
    return { applied: done, skipped };
  }

  /**
   * Discover: prove the wiring by moving it, one thing at a time, and watching what the controller reports.
   *   relays   toggle each relay away from its present state for holdMs and back; the controller's door / input event names the role
   *   readers  present the first sync card on each Wiegand / OSDP reader; the decision names the door
   *   locks    (Commands on) a short OnCAFE temporary unlock of each door under test; the Aether input that turns on watches its strike
   * Needs the cloud feed connected. Results: backend/data/trace/discover.json.
   */
  async discover(opt = {}, who = '?') {
    if (this.discovering && this.discovering.state === 'running') throw err('Discover is already running', 409);
    if (this.test && this.test.state !== 'done') throw err('A test is running', 409);
    if (this.syncBusy) throw err('Sync markers are being sent: try again in a few seconds', 409);
    if (this.cloud.status().push.state !== 'connected') throw err('Connect the cloud feed first (Setup › OnCAFE): Discover watches what the controller reports');
    const relays = (Array.isArray(opt.relays) ? opt.relays : [0, 1, 2, 3, 4, 5, 6, 7]).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 8);
    if (relays.length && !this.deps.gpioQueue) throw err('The relay board is not available on this Pi');
    const holdMs = int(opt.holdMs, 500, 10000, 2000), watchMs = int(opt.watchMs, 2000, 30000, 6000);
    const D = this.discovering = { state: 'running', at: Date.now(), who: String(who).slice(0, 60), step: '', done: 0, total: 0, relays: [], readers: [], locks: [], error: null, abort: false };
    const seenAfter = (t0, ms, f) => new Promise(resolve => {
      const got = [];
      const on = e => { if (e.lane === 'cloud' && e.type && e.src !== 'command' && f(e)) got.push(e); };
      this.on('event', on);
      const end = Date.now() + ms;
      const tick = () => { if (D.abort || Date.now() >= end) { this.off('event', on); resolve(got); } else setTimeout(tick, Math.min(200, end - Date.now())); };
      setTimeout(tick, Math.min(200, ms));
    });
    // what each relay is now (the journal's last write), so a toggle always comes back to it
    const lastRelay = ch => { for (let i = this.live.length - 1; i >= 0; i--) { const e = this.live[i]; if (e.src === 'journal' && e.info && e.info.ch === `relay:${ch}`) return e.info.v ? 1 : 0; } return 0; };
    const rolesOf = list => {
      const t = list.map(e => e.type);
      if (t.some(x => /^(open|closed|dooropen|doorclosed|doorforcedopen)$/.test(x))) return 'dps';
      if (t.some(x => /^rex/.test(x))) return 'rex';
      if (t.some(x => /^io-|input/.test(x))) return 'input';
      return null;
    };
    (async () => {
      try {
        const readers = [];
        if (opt.readers !== false) {
          try { const wm = this.deps.getWiegand && this.deps.getWiegand(); if (wm && wm.getReaders) for (const r of wm.getReaders()) readers.push({ kind: 'wiegand', id: String(r.id), name: r.name || String(r.id) }); } catch { /* */ }
          try { const om = this.deps.getOsdp && this.deps.getOsdp(); if (om && om.getReaders) for (const r of [].concat(om.getReaders() || [])) readers.push({ kind: 'osdp', id: String(r.id ?? r.readerId), name: r.name || `OSDP ${r.address}` }); } catch { /* */ }
        }
        const doorsUnderTest = opt.locks !== false && this.settings.commands.enabled ? this.settings.cloud.doors.slice(0, 16) : [];
        D.total = relays.length + readers.length + doorsUnderTest.length;
        for (const ch of relays) {
          if (D.abort) break;
          D.step = `REL${ch + 1}`;
          // the relay's real state (not what this process last wrote: it may have restarted), so it always comes back to it
          let rest = lastRelay(ch);
          try { const r = await this.deps.gpioQueue.enqueue('getRelay', ch); if (r && 'state' in r) rest = r.state ? 1 : 0; } catch { /* keep the journal's */ }
          const t0 = Date.now();
          const wA = seenAfter(t0, Math.min(holdMs, watchMs) + 200, () => true);
          try { writeAtomic(DISCOVER_TOUCH, JSON.stringify({ ch, rest, at: t0 })); } catch { /* */ }
          let away;
          try { await this.deps.gpioQueue.enqueue('setRelay', ch, !rest); away = await wA; }
          finally {
            let put = false, last = null;
            for (let i = 0; i < 4 && !put; i++) { try { await this.deps.gpioQueue.enqueue('setRelay', ch, !!rest); put = true; } catch (e) { last = e; await sleep(300); } }
            if (!put) throw err(`REL${ch + 1} could not be put back (${last && last.message}): set it by hand`);
            try { fs.unlinkSync(DISCOVER_TOUCH); } catch { /* */ }
          }
          const back = await seenAfter(Date.now(), watchMs, () => true);
          // other doors keep talking while a relay is toggled: only a (role, door) that answered while the relay was away counts,
          // and the one with the most answers (away and back) wins
          const ev = away.concat(back);
          const pair = e => { const r = rolesOf([e]); return r ? `${r}|${(e.door && e.door.id) || ''}` : null; };
          const score = new Map();
          for (const e of away) { const k = pair(e); if (k) score.set(k, 0); }
          if (!score.size) for (const e of back) { const k = pair(e); if (k) score.set(k, 0); }
          for (const e of ev) { const k = pair(e); if (k && score.has(k)) score.set(k, score.get(k) + 1); }
          const best = [...score].sort((a, b) => b[1] - a[1])[0];
          const [role, doorId] = best ? best[0].split('|') : [null, ''];
          const mine = e => pair(e) === (best && best[0]);
          const door = doorId ? (ev.find(e => mine(e) && e.door) || {}).door || null : null;
          let active;
          if (role === 'dps') { const first = away.find(e => mine(e) && /open|closed/.test(e.type)); active = first ? (/open/.test(first.type) === !rest ? 'open' : 'closed') : undefined; }
          D.relays.push({ ch: `relay:${ch}`, role: role || null, door: door ? door.id : null, doorName: door ? door.name : null, active, rest, events: ev.slice(0, 6).map(e => ({ type: e.type, door: e.door ? e.door.name || e.door.id : null })) });
          D.done++;
        }
        for (const r of readers) {
          if (D.abort) break;
          D.step = `reader ${r.name}`;
          const c = this.settings.sync.cards[0] || { fc: 123, cn: '1234' };
          const t0 = Date.now();
          const w = seenAfter(t0, watchMs, e => !!e.access);
          if (r.kind === 'wiegand') await this.deps.getWiegand().sendCard(r.id, Number(c.fc), Number(c.cn), this.settings.sync.format || null);
          else await this.deps.getOsdp().sendCardRead(r.id, { facility: Number(c.fc), card: String(c.cn) }, this.settings.sync.format || 'wiegand26');
          const got = await w;
          const g = got.find(e => e.door && e.door.id);
          D.readers.push({ ch: `${r.kind}:${r.id}`, name: r.name, door: g ? g.door.id : null, doorName: g ? g.door.name : null, type: g ? g.type : null });
          D.done++;
        }
        for (const door of doorsUnderTest) {
          if (D.abort) break;
          const name = (((this.cloud.inv || {}).doors || []).find(x => x.id === door) || {}).name || door.slice(0, 8);
          D.step = `unlock ${name}`;
          const t0 = Date.now();
          const ons = [];
          const on = e => { if (e.src === 'journal' && e.info && e.info.v === 1 && /^(opto|emu-out|door-out)$/.test(e.type)) ons.push(e); };
          this.on('event', on);
          let r = null;
          try { r = await this.command({ kind: 'override', target: door, value: 'unlock', seconds: 8 }, `${who} (Discover)`); } catch (e) { r = { ok: false, error: e.message }; }
          for (const end = Date.now() + watchMs; Date.now() < end && !D.abort;) await sleep(200);
          this.off('event', on);
          const first = ons[0];
          D.locks.push({ door, doorName: name, ok: !!(r && r.ok), error: r && !r.ok ? r.error : null, ch: first ? first.info.ch : null, ms: first ? first.at - t0 : null });
          D.done++;
        }
      } catch (e) { D.error = e.message; }
      finally {
        D.state = 'done'; D.end = Date.now(); D.step = '';
        // a probe that only covered some channels (stopped early, or relays picked) keeps the earlier proof for the rest
        const prev = this._probe() || {};
        const merge = (now, old, k) => now.concat((old || []).filter(o => !now.some(n => n[k] === o[k])));
        const keep = { at: D.at, end: D.end, who: D.who, relays: merge(D.relays, prev.relays, 'ch'), readers: merge(D.readers, prev.readers, 'ch'), locks: merge(D.locks, prev.locks, 'door'), error: D.error, aborted: D.abort };
        try { writeAtomic(DISCOVER, JSON.stringify(keep, null, 1)); } catch { /* */ }
      }
    })();
    return this.discoverStatus();
  }
  stopDiscover() { if (this.discovering && this.discovering.state === 'running') this.discovering.abort = true; return this.discoverStatus(); }
  discoverStatus() {
    const D = this.discovering;
    if (!D) { const p = this._probe(); return p ? { state: 'done', ...p, done: null, total: null } : null; }
    return { state: D.state, at: D.at, end: D.end || null, who: D.who, step: D.step, done: D.done, total: D.total, relays: D.relays, readers: D.readers, locks: D.locks, error: D.error, aborted: D.abort };
  }

  // ── TRACE-4: test sequences ─────────────────────────────────────────────
  sequences() { try { return (JSON.parse(fs.readFileSync(SEQUENCES, 'utf8')) || []).map(cleanSequence); } catch { return []; } }
  saveSequence(q) {
    const list = this.sequences();
    const s = cleanSequence({ ...q, updatedAt: Date.now() });
    const i = list.findIndex(x => x.id === s.id);
    if (i >= 0) list[i] = s; else { if (list.length >= 100) throw err('100 sequences is the limit; delete one first'); list.push(s); }
    writeAtomic(SEQUENCES, JSON.stringify(list, null, 1));
    return s;
  }
  deleteSequence(id) {
    if (this.test && this.test.state === 'running' && this.test.seqId === id) throw err('That sequence is running', 409);
    writeAtomic(SEQUENCES, JSON.stringify(this.sequences().filter(x => x.id !== id), null, 1));
  }
  templateSteps(kind, door, card, opt) { return template(kind, door, card, opt); }
  templates() { return TEMPLATES; }

  /** The Doors page doors with what a test needs: reader, OnCAFE door, traced channels, raw wires. */
  _doorMap() {
    let cfg = null;
    try { cfg = this._readDoorConfig(); } catch (e) { throw err('The Doors page config is damaged: ' + e.message, 500); }
    const doors = cfg ? doorsFrom(cfg) : [];
    const w = this.wiring();
    const m = new Map();
    for (const d of doors) {
      const id = Number(d.id);
      const chs = {}, raw = {};
      for (const { key, entry } of doorChannels(d)) {
        if (entry.via) { const r = entry.via.split(':')[2]; raw[r] = key; continue; }
        const r = key.split(':')[2];
        if (r === 'dps' || r === 'rex' || r === 'lock') chs[r] = key;
      }
      const oncafe = (d.trace && d.trace.oncafeDoorId) || (w[`door:${id}:dps`] || w[`door:${id}:lock`] || {}).door || null;
      m.set(id, { d, id, name: String(d.name || `Door ${id}`), oncafe, chs, raw, enabled: d.enabled !== false });
    }
    return m;
  }

  async _sendCardOn(d, fc, cn, format) {
    const r = String(d.reader || '');
    if (!r) throw err(`${d.name} has no reader (Doors page › Settings › Reader)`);
    const f = format || this.settings.sync.format;
    const m = /^ctrl-emu-(\d+)-(\d+)$/.exec(r);
    if (m) {
      const em = this.deps.emulator;
      if (!em || typeof em.queueCardRead !== 'function') throw err('The board emulator is not loaded');
      const x = em.queueCardRead(Number(m[1]), Number(m[2]), f || 'w26', Number(fc) || 0, Number(cn));
      if (x && x.success === false) throw err(x.error || 'The emulated board refused the card');
      return x;
    }
    const wm = this.deps.getWiegand && this.deps.getWiegand();
    if (wm && wm.getReaders && wm.getReaders().some(x => String(x.id) === r)) return wm.sendCard(r, Number(fc) || 0, Number(cn), f || null);
    const om = this.deps.getOsdp && this.deps.getOsdp();
    if (om && om.getReaders && [].concat(om.getReaders() || []).some(x => String(x.id ?? x.readerId) === r)) return om.sendCardRead(r, { facility: Number(fc) || 0, card: String(cn) }, f || 'wiegand26');
    throw err(`Reader ${r} of ${d.name} is not running on this Pi`);
  }

  /** Drive a door's DPS / REX the way the Doors page does (logical on/off, reverse sense applied). */
  async _driveDoor(d, key, on) {
    const io = d[key];
    const word = key === 'dps' ? 'DPS' : 'REX';
    if (!io || !Number.isInteger(Number(io.channel)) || Number(io.channel) < 0) throw err(`${d.name} has no ${word} assigned (Doors page › Settings)`);
    if (io.enabled === false) throw err(`${d.name} ${word} is turned off on the Doors page`);
    const ch = Number(io.channel);
    const level = io.reverseSense ? !on : !!on;
    if (d.ioSource === 'emulated') {
      const em = this.deps.emulator;
      if (!em || typeof em.setInput !== 'function') throw err('The board emulator is not loaded');
      if (em.setInput(Number(d.emuBoard), ch, level) === false) throw err(`Emulated board ${d.emuBoard} has no input ${ch}`);
      return;
    }
    const q = this.deps.gpioQueue;
    if (!q) throw err('The relay board is not available on this Pi');
    const t = io.hardwareType;
    if (t === 'opto-in' || t === 'analog-in') throw err(`${d.name} ${word} is an input Aether watches, not one it drives`);
    if (Number(io.stackLevel)) throw err(`${d.name} ${word} is on a stacked board; tests drive stack 0 only`);
    if (t === 'dac') { const v = Number(io.activeVolts) > 0 ? Math.min(10, Number(io.activeVolts)) : 10; return q.enqueue('setDAC', ch, level ? v : 0); }
    if (t === 'od') return q.enqueue('setOD', ch, level ? 100 : 0);
    return q.enqueue('setRelay', ch, level);
  }

  async _testSleep(T, ms) { const until = Date.now() + ms; while (!T.abort && Date.now() < until) await sleep(Math.min(250, until - Date.now())); }

  // what a running test has engaged, on disk too: after a restart the outputs are released and the commands turned back
  _touch(T, key, val) {
    if (val) T.touched.set(key, val); else T.touched.delete(key);
    try { writeAtomic(TOUCHED, JSON.stringify([...T.touched].map(([k, v]) => ({ k, door: v.id, cmd: v.cmd || null, revertId: v.revertId || null })))); } catch { /* */ }
  }
  async _releaseOrphans() {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(TOUCHED, 'utf8')) || []; } catch { return; }
    if (!list.length || (this.test && this.test.state !== 'done')) return;
    const doors = this._doorMap();
    for (const x of list) {
      try {
        if (x.cmd) { if (!x.revertId || this._reverts().some(r => r.id === x.revertId)) { await this._send(x.cmd, {}, 'Aether (test stopped by a restart: turned back)'); if (x.revertId) this._saveReverts(this._reverts().filter(r => r.id !== x.revertId)); } }
        else { const info = doors.get(x.door); if (info) await this._driveDoor(info.d, x.k.endsWith(':dps') ? 'dps' : 'rexIn', false); }
      } catch (e) { console.warn(`[Trace] release after restart (${x.k}):`, e.message); }
    }
    try { fs.unlinkSync(TOUCHED); } catch { /* */ }
    console.log(`[Trace] a test was interrupted by a restart: put back ${list.length} thing(s) it had engaged`);
  }
  async _release(info, key, T) {
    let last = null;
    for (let n = 0; n < 4; n++) { try { await this._driveDoor(info.d, key, false); this._touch(T, `${info.id}:${key}`, null); return true; } catch (e) { last = e; await sleep(300 * (n + 1)); } }
    T.error = `Could not put ${info.name} ${key === 'dps' ? 'DPS' : 'REX'} back: ${last && last.message}. Check it now.`;
    return false;
  }

  async _doStep(s, info, L, T, who) {
    const st = this.settings;
    if (s.kind === 'wait') return this._testSleep(T, s.ms);
    if (!info) throw err(`Step ${L.idx + 1}: pick a door`);
    const d = info.d;
    if (s.kind === 'card') {
      if (!s.cn) throw err(`Step ${L.idx + 1}: no card number`);
      L.cred = { fc: s.fc === '' ? null : s.fc, cn: s.cn };
      L.at = Date.now();
      return this._sendCardOn(d, s.fc, s.cn, s.format);
    }
    if (s.kind === 'rex') {
      L.at = Date.now();
      this._touch(T, `${info.id}:rexIn`, info);
      try { await this._driveDoor(d, 'rexIn', true); await sleep(s.holdMs); }   // never cut short
      finally { if (!(await this._release(info, 'rexIn', T))) throw err(T.error); }   // the REX is always let go, here and now
      return;
    }
    if (s.kind === 'dps') {
      L.at = Date.now();
      if (s.state === 'open') { this._touch(T, `${info.id}:dps`, info); await this._driveDoor(d, 'dps', true); }
      else { await this._driveDoor(d, 'dps', false); this._touch(T, `${info.id}:dps`, null); }
      return;
    }
    if (s.kind === 'command') {
      if (!st.commands.enabled) throw err('Commands are turned off (Setup › Commands)');
      if (!info.oncafe) throw err(`${info.name} is not paired with an OnCAFE door`);
      let target = info.oncafe;
      if (s.cmd === 'lockdown') {
        const inv = this.cloud.inv && Date.now() - this.cloud.inv.at < 10 * 60000 ? this.cloud.inv : await this.cloud.inventory(st.cloud.url, st.cloud.org);
        const od = (inv.doors || []).find(x => x.id === info.oncafe);
        target = od && od.areaIds && od.areaIds[0];
        if (!target) throw err(`${info.name}'s OnCAFE door has no area for a lockdown`);
      }
      const engaging = s.cmd !== 'override' && s.value !== false;
      const key = `cmd:${s.cmd}:${target}`;
      L.at = Date.now();
      // an "on" command carries a 10-minute automatic turn-back as a backstop; the test's own "off" (or its end) cancels it
      const r = await this.command({ kind: s.cmd, target, value: s.value, seconds: s.seconds, revertSec: engaging ? 600 : 0 }, who);
      if (!r.ok) throw err(`OnCAFE refused the command: ${r.error || 'HTTP ' + r.status}`);
      if (engaging) {
        const { reverseOf } = require('./commands');
        this._touch(T, key, { id: info.id, name: info.name, cmd: reverseOf({ kind: s.cmd, target, value: s.value, targetName: info.name }), revertId: r.event });
      } else {
        const on = T.touched.get(key);
        if (on && on.revertId) this._saveReverts(this._reverts().filter(x => x.id !== on.revertId));
        this._touch(T, key, null);
      }
      return;
    }
  }

  async runTest(seqId, opt = {}, who = '?') {
    if (this.test && this.test.state !== 'done') throw err('A test is already running', 409);
    if (this.discovering && this.discovering.state === 'running') throw err('Discover is running', 409);
    const q = this.sequences().find(x => x.id === seqId);
    if (!q) throw err('That sequence no longer exists', 404);
    const seq = cleanSequence({ ...q, ...(opt.repeat ? { repeat: opt.repeat } : {}), ...(opt.minutes != null ? { minutes: opt.minutes } : {}), ...(opt.gapMs != null ? { gapMs: opt.gapMs } : {}) });
    if (!seq.steps.length) throw err('This sequence has no steps');
    if (seq.steps.some(s => s.kind === 'command') && !this.settings.commands.enabled) throw err('This sequence sends OnCAFE commands: turn Commands on in Setup first', 403);
    const doors = this._doorMap();
    seq.steps.forEach((s, i) => {
      if (s.kind === 'wait' && s.door == null) return;
      const info = doors.get(s.door);
      if (!info) throw err(`Step ${i + 1}: door ${s.door == null ? '(none)' : s.door} is not on the Doors page`);
      if (!info.enabled) throw err(`Step ${i + 1}: ${info.name} is turned off on the Doors page`);
      if (s.kind === 'card' && !s.cn) throw err(`Step ${i + 1}: enter the card number`);
      if (s.kind === 'command' && !info.oncafe) throw err(`Step ${i + 1}: pair ${info.name} with an OnCAFE door first`);
      if (s.kind === 'command' && s.cmd !== 'lockdown' && !this.settings.cloud.doors.includes(info.oncafe)) throw err(`Step ${i + 1}: ${info.name}'s OnCAFE door is not one of the doors under test (Setup › OnCAFE)`);
    });
    const T = { state: 'running', seqId: seq.id, name: seq.name, startedAt: Date.now(), iter: 0, idx: 0, steps: seq.steps.length, repeat: seq.repeat, until: seq.minutes ? Date.now() + seq.minutes * 60000 : null,
      abort: false, who: String(who).slice(0, 60), log: [], runId: null, ownRun: !this.run, touched: new Map(), health: [], error: null, report: null };
    this.test = T;
    try {
      if (T.ownRun) await this.startRun(`Test: ${seq.name}`, { sync: seq.sync, note: `Test sequence ${seq.name}` });
    } catch (e) { T.state = 'done'; T.error = e.message; throw e; }
    T.runId = this.run.id;
    const testMeta = { sequence: { id: seq.id, name: seq.name }, steps: seq.steps, startedAt: T.startedAt, who: T.who, repeat: seq.repeat, minutes: seq.minutes, gapMs: seq.gapMs };
    this.run.test = testMeta;
    this._patchMeta(T.runId, { test: testMeta });
    (async () => {
      const healthT = setInterval(() => { try { const c = this.cloud.status(); T.health.push({ at: Date.now(), push: c.push.state, received: c.push.received, api: c.api.state }); if (T.health.length > 2000) T.health.shift(); } catch { /* */ } }, 10000);
      try {
        if (T.ownRun && seq.sync && this.settings.sync.atStart) { await sleep(300); while (this.syncBusy && !T.abort) await sleep(200); await this._testSleep(T, 1500); }
        for (let it = 1; ; it++) {
          if (T.abort || (!T.until && it > seq.repeat) || (T.until && Date.now() >= T.until)) break;
          T.iter = it;
          for (const [idx, s] of seq.steps.entries()) {
            const info = s.door != null ? doors.get(s.door) : null;
            const L = { iter: it, idx, kind: s.kind, at: Date.now(), door: s.door, doorName: info ? info.name : null, oncafe: info ? info.oncafe : null,
              chs: info ? info.chs : null, raw: info && (s.kind === 'dps' || s.kind === 'rex') ? info.raw[s.kind] || null : null, lockRaw: info ? info.raw.lock || null : null,
              text: stepText(s, info && info.name) };
            if (!T.abort && this.run && this.run.id === T.runId && this.run.count >= RUN_MAX - 200) { T.abort = true; T.error = `The run is full (${RUN_MAX} events): the test stopped. Use a shorter load run.`; }
            if (T.abort) { L.skipped = true; this._logStep(T, L); continue; }
            T.idx = idx;
            this.add({ id: newId(), src: 'test', lane: 'aether', at: L.at, t: L.at, clock: 'pi', type: 'step', label: `Test step ${idx + 1}${seq.repeat > 1 || T.until ? ` (#${it})` : ''}: ${L.text}`, door: null, controllerId: null, cred: null, clientType: null, eventId: null, topic: null, info: { test: seq.id, iter: it, idx } });
            try { await this._doStep(s, info, L, T, T.who); } catch (e) { L.error = e.message; }
            L.end = Date.now();
            this._logStep(T, L);
            await this._testSleep(T, s.afterMs);
          }
          if (seq.gapMs && !T.abort) await this._testSleep(T, seq.gapMs);
        }
      } catch (e) { T.error = e.message; }
      finally {
        clearInterval(healthT);
        for (const [k, v] of [...T.touched]) {   // put back everything the test engaged: DPS / REX, and "on" commands it did not turn off
          if (k.startsWith('cmd:')) {
            try { const { r } = await this._send(v.cmd, {}, `Aether (test ${T.abort ? 'stopped' : 'ended'}: turned back)`); if (r.ok) { if (v.revertId) this._saveReverts(this._reverts().filter(x => x.id !== v.revertId)); this._touch(T, k, null); } else T.error = `Could not turn back ${v.cmd.kind} on ${v.name}: ${r.error || 'HTTP ' + r.status} (it turns back by itself within 10 min)`; }
            catch (e) { T.error = `Could not turn back ${v.cmd.kind} on ${v.name}: ${e.message} (it turns back by itself within 10 min)`; }
          } else await this._release(v, k.endsWith(':dps') ? 'dps' : 'rexIn', T);
        }
        if (!T.touched.size) { try { fs.unlinkSync(TOUCHED); } catch { /* */ } }
        T.state = 'grading';
        try {
          // late answers (cloud push, strike off, controller events) still count: wait out the last steps' windows first
          const th = this.settings.thresholds;
          const settle = T.abort ? 5000 : Math.min(60000, Math.max(3000, ...seq.steps.map(x => ((x.expect && x.expect.withinMs) || 0) + th.pushFail)) - (seq.steps[seq.steps.length - 1].afterMs || 0));
          await sleep(Math.max(0, settle));
          if (T.ownRun && this.run && this.run.id === T.runId) await this.stopRun(T.abort ? 'test stopped' : 'test finished', { sync: seq.sync, byTest: true });
        } catch (e) { T.error = T.error || e.message; }
        T.endedAt = Date.now();
        this._patchMeta(T.runId, { test: { ...testMeta, endedAt: T.endedAt, aborted: T.abort, error: T.error, health: T.health, steps: testMeta.steps } });
        try { T.report = this.testReport(T.runId); } catch (e) { T.error = T.error || e.message; }
        T.state = 'done';
        this.emit('test-done', { runId: T.runId, name: T.name, verdict: T.report && T.report.report.totals.verdict });
      }
    })();
    return this.testStatus();
  }

  _logStep(T, L) {
    T.log.push(L);
    T.done = (T.done || 0) + 1; if (L.error) T.errors = (T.errors || 0) + 1;
    if (T.log.length > 400) T.log.shift();     // the full log is on disk (test-log.jsonl); memory keeps the latest
    try { fs.appendFileSync(path.join(runDir(T.runId), TEST_LOG), JSON.stringify(L) + '\n'); } catch { /* */ }
  }
  _readTestLog(runId, meta) {
    try { return fs.readFileSync(path.join(runDir(runId), TEST_LOG), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return (meta && meta.test && meta.test.log) || []; }   // TRACE-4 runs saved before the log moved to its own file
  }
  stopTest() { if (this.test && this.test.state === 'running') this.test.abort = true; return this.testStatus(); }
  testStatus() {
    const T = this.test;
    if (!T) return null;
    return { state: T.state, seqId: T.seqId, name: T.name, runId: T.runId, startedAt: T.startedAt, endedAt: T.endedAt || null, iter: T.iter, repeat: T.repeat, until: T.until, idx: T.idx, steps: T.steps,
      done: T.done || 0, errors: T.errors || 0, abort: T.abort, error: T.error, verdict: T.report ? T.report.report.totals.verdict : null,
      last: T.log.slice(-6).map(l => ({ iter: l.iter, idx: l.idx, text: l.text, at: l.at, error: l.error || null })) };
  }

  /** The graded result of a test run (also while it is still running). */
  testReport(runId) {
    const meta = this.run && this.run.id === runId ? { ...JSON.parse(fs.readFileSync(this._metaPath(runId), 'utf8')) } : JSON.parse(fs.readFileSync(this._metaPath(runId), 'utf8'));
    const t = meta.test;
    if (!t) throw err('That run is not a test run', 404);
    const log = this._readTestLog(runId, meta);
    const a = this.analyze(runId);
    const report = grade(a, this.readEvents(runId), log, t.steps || [], this.settings.thresholds);
    const health = t.health || (this.test && this.test.runId === runId ? this.test.health : []) || [];
    let drops = 0;
    for (let i = 1; i < health.length; i++) if (health[i - 1].push === 'connected' && health[i].push !== 'connected') drops++;
    return { runId, sequence: t.sequence, startedAt: t.startedAt, endedAt: t.endedAt || null, aborted: !!t.aborted, error: t.error || null, who: t.who, repeat: t.repeat, minutes: t.minutes, iterations: Math.max(0, ...log.map(l => l.iter)), report: { ...report, health: { samples: health.length, pushDrops: drops } } };
  }
  testRuns() { return this.listRuns().filter(r => r.test).map(r => ({ id: r.id, name: r.name, start: r.start, end: r.end, sequence: r.test.sequence, aborted: !!r.test.aborted })); }

  // ── TRACE-4: compare two runs ─────────────────────────────────────────
  compareRuns(a, b) {
    const A = this.analyze(a, 'cmpA'), B = this.analyze(b, 'cmpB');
    const tA = (() => { try { return this.testReport(a); } catch { return null; } })(), tB = (() => { try { return this.testReport(b); } catch { return null; } })();
    return compare(A, B, this.readEvents(a), this.readEvents(b), tA, tB);
  }

  // ── TRACE-4: live alerts ───────────────────────────────────────────────
  _alertTick() {
    const al = this.settings.alerts;
    if (!(al.enabled || al.automation) || this._alertBusy) return;   // the page toast and the Automation feed are separate switches
    const watching = this.run || (this.cloud.status().push.state === 'connected');
    if (!watching) return;
    // a big run is expensive to analyse on a Pi: look less often as it grows (2 s → 15 s past 5,000 events)
    const n = this.run ? this.run.count : this.live.length;
    const every = n > 20000 ? 30000 : n > 5000 ? 15000 : 2000;
    if (this._alertLast && Date.now() - this._alertLast < every) return;
    this._alertLast = Date.now();
    this._alertBusy = true;
    try {
      const a = this.analyze(this.run ? this.run.id : null, 'alerts');
      const cut = Date.now() - 10 * 60000;
      for (const t of a.traces) {
        if (t.sync || t.at < cut || this._alerted.has(t.id)) continue;
        // a trace still inside its windows may still find its answer (a slow cloud): judge it once they have passed
        const th = this.settings.thresholds;
        const age = Date.now() - t.at;
        if (t.decision && t.latency.push != null ? age < 3000 : age < Math.max(th.matchWindowMs, th.inputWindowMs, th.outputWindowMs) + th.pushFail) continue;   // final once its answer and its push are in, or every window has passed
        this._alerted.add(t.id);   // judged now, pass or fail: never raised again (also when the run ends and the live view takes over)
        if (!(t.status === 'fail' || (al.level === 'warn' && t.status === 'warn'))) continue;
        const x = { seq: ++this.alertSeq, at: Date.now(), traceAt: t.at, traceId: t.id, runId: this.run ? this.run.id : null, status: t.status, kind: t.kind, label: t.action.label,
          why: t.notes[0] || (t.status === 'fail' ? 'failed' : 'slow'), door: (t.decision && t.decision.door && (t.decision.door.name || t.decision.door.id)) || null };
        this.alerts.push(x);
        if (this.alerts.length > 200) this.alerts.shift();
        this.emit('alert', x);
      }
      if (this._alerted.size > 5000) this._alerted = new Set([...this._alerted].slice(-2000));
    } catch { /* an analysis error never stops the Pi */ } finally { this._alertBusy = false; }
  }
  alertsSince(seq = 0) { return { seq: this.alertSeq, alerts: this.alerts.filter(a => a.seq > seq) }; }

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
      test: this.testStatus(),
      clockCheck: this.clockCheck || null,
      links: this.links || null, linkLog: (this.linkLog || []).slice(-10),   // TRACE-8
      alertSeq: this.alertSeq,
      alerts: this.alerts.slice(-5),
      inventory: this.cloud.inv ? { org: this.cloud.inv.org, at: this.cloud.inv.at, doors: this.cloud.inv.doors, areas: this.cloud.inv.areas, zones: this.cloud.inv.zones, controllers: this.cloud.inv.controllers } : null,
    };
  }
}

module.exports = { TraceEngine, cleanSettings, DEFAULTS, toMs };
