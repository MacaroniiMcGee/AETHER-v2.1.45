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
const { scrub, hasSecrets, Vault } = require('./redact');
const { decodePublishes } = require('./mqtt5');

const BASE = path.join(__dirname, '..', 'data', 'trace');
const RUNS = path.join(BASE, 'runs');
const SETTINGS = path.join(BASE, 'settings.json');
const REPORTS = path.join(__dirname, '..', 'data', 'analytics', 'reports');
const KEEP_RUNS = 40;
const LIVE_MAX = 4000;
const RUN_MAX = 50000;

const DEFAULTS = {
  cloud: { url: '', org: '', controllers: [], doors: [], poll: true, pollMs: 2000, autoConnect: false },
  sync: {
    channel: { kind: 'wiegand', readerId: '', address: 1, port: 0 },
    format: 'w26',
    cards: [{ fc: 123, cn: 1234 }, { fc: 123, cn: 9876 }],
    gapsMs: [2000, 5000],
    atStart: true, atEnd: true, everyMin: 0,
  },
  wire: { controllerIps: [] },
  thresholds: { decisionWarn: 1000, decisionFail: 2000, pushWarn: 3000, pushFail: 10000, matchWindowMs: 30000 },
  expectations: [],     // [{ fc, cn, expect: 'grant'|'deny', note }]
  allowRaw: true,
};

const isIp = s => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(String(s));
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanSettings(s = {}) {
  const d = DEFAULTS;
  const c = s.cloud || {}, y = s.sync || {}, ch = y.channel || {}, w = s.wire || {}, th = s.thresholds || {};
  return {
    cloud: {
      url: String(c.url || '').trim().slice(0, 200), org: /^[0-9a-f-]{36}$/i.test(c.org || '') ? c.org : '',
      controllers: (Array.isArray(c.controllers) ? c.controllers : []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 64),
      doors: (Array.isArray(c.doors) ? c.doors : []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50),
      poll: c.poll !== false, pollMs: int(c.pollMs, 1000, 30000, d.cloud.pollMs), autoConnect: !!c.autoConnect,
    },
    sync: {
      channel: { kind: ['wiegand', 'osdp', 'emu'].includes(ch.kind) ? ch.kind : 'wiegand', readerId: String(ch.readerId ?? '').slice(0, 64), address: int(ch.address, 0, 126, 1), port: int(ch.port, 0, 7, 0) },
      format: String(y.format || d.sync.format).slice(0, 64),
      cards: (Array.isArray(y.cards) && y.cards.length ? y.cards : d.sync.cards).slice(0, 4).map(k => ({ fc: int(k.fc, 0, 2 ** 31 - 1, 0), cn: String(k.cn ?? '').replace(/\D/g, '').slice(0, 20) || '0' })),
      gapsMs: (Array.isArray(y.gapsMs) ? y.gapsMs : d.sync.gapsMs).slice(0, 4).map(g => int(g, 500, 60000, 2000)),
      atStart: y.atStart !== false, atEnd: y.atEnd !== false, everyMin: int(y.everyMin, 0, 240, 0),
    },
    wire: { controllerIps: (Array.isArray(w.controllerIps) ? w.controllerIps : String(w.controllerIps || '').split(/[\s,]+/)).filter(isIp).slice(0, 32) },
    thresholds: Object.fromEntries(Object.entries(d.thresholds).map(([k, v]) => [k, int(th[k], 50, 600000, v)])),
    expectations: (Array.isArray(s.expectations) ? s.expectations : []).slice(0, 200).map(x => ({ fc: x.fc === '' || x.fc == null ? '' : String(int(x.fc, 0, 2 ** 31 - 1, 0)), cn: String(x.cn ?? '').replace(/\D/g, '').slice(0, 20), expect: x.expect === 'deny' ? 'deny' : 'grant', note: String(x.note || '').slice(0, 80) })).filter(x => x.cn),
    allowRaw: s.allowRaw !== false,
  };
}

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
    if (raw !== undefined && raw !== null) {
      e.hasRaw = true;
      e.secret = hasSecrets(raw);
      e.detail = scrub(raw);
      if (this.run) this.run.vault.put(e.id, raw); else { this.liveVault.set(e.id, raw); if (this.liveVault.size > 600) this.liveVault.delete(this.liveVault.keys().next().value); }
    }
    this.live.push(e);
    if (this.live.length > LIVE_MAX) this.live.splice(0, this.live.length - LIVE_MAX);
    if (this.run && this.run.count < RUN_MAX) {
      this.run.count++;
      this.run.lastAt = e.at || Date.now();
      try { fs.appendFileSync(path.join(this.run.dir, 'events.jsonl'), JSON.stringify(e) + '\n'); } catch { /* */ }
    }
    this.emit('event', e);
    return e;
  }

  liveSince(seq = 0, limit = 1500) {
    const out = [];
    for (let i = this.live.length - 1; i >= 0 && out.length < limit; i--) { if (this.live[i].seq <= seq) break; out.push(this.live[i]); }
    return { seq: this.seq, events: out.reverse() };
  }

  // ── settings ───────────────────────────────────────────────────────────
  saveSettings(s) {
    const merged = cleanSettings({ ...this.settings, ...s, cloud: { ...this.settings.cloud, ...(s.cloud || {}) }, sync: { ...this.settings.sync, ...(s.sync || {}), channel: { ...this.settings.sync.channel, ...((s.sync || {}).channel || {}) } } });
    this.settings = merged;
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(merged, null, 1));
    return merged;
  }

  // ── sync cards ─────────────────────────────────────────────────────────
  channels() {
    const out = { wiegand: [], osdp: [], emu: [] };
    try { const wm = this.deps.getWiegand && this.deps.getWiegand(); if (wm && wm.getReaders) out.wiegand = wm.getReaders().map(r => ({ id: String(r.id), name: r.name || r.label || String(r.id) })); } catch { /* */ }
    try { const om = this.deps.getOsdp && this.deps.getOsdp(); if (om && om.getReaders) out.osdp = [].concat(om.getReaders() || []).map(r => ({ id: String(r.id ?? r.readerId), name: r.name || `OSDP ${r.address ?? r.id}` })); } catch { /* */ }
    try { const em = this.deps.emulator; if (em && typeof em.queueCardRead === 'function') out.emu = [{ id: 'emu', name: 'Emulated board reader (address / port)' }]; } catch { /* */ }
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

  /** Send the sync pair now. set: start | end | check */
  async sendSync(set = 'check') {
    if (this.syncBusy) throw err('Sync cards are already being sent', 409);
    this.syncBusy = true;
    const s = this.settings.sync;
    const sent = [];
    try {
      if (this.journal) this.journal.record('marker', 'trace', 1, 'ui', { event: 'sync-' + set, trace: true });
      for (let i = 0; i < s.cards.length; i++) {
        const c = s.cards[i];
        const at = Date.now();
        await this._sendCard(c);
        const rec = { at, fc: c.fc, cn: String(c.cn), set, idx: i };
        sent.push(rec);
        if (this.run) { this.run.syncs.push(rec); this._patchMeta(this.run.id, { syncs: this.run.syncs }); }
        else { this.liveSyncs = (this.liveSyncs || []).concat(rec).slice(-20); }
        await sleep(s.gapsMs[i] ?? s.gapsMs[s.gapsMs.length - 1] ?? 2000);
      }
      // tag the journal card events that belong to the sync so the page can label them
      for (const e of this.live) if (e.src === 'journal' && e.type === 'card' && sent.some(x => Math.abs(x.at - e.at) < 400)) { e.info = { ...(e.info || {}), sync: set }; }
      return sent;
    } finally { this.syncBusy = false; }
  }

  // ── runs ───────────────────────────────────────────────────────────────
  _metaPath(id) { return path.join(RUNS, id, 'meta.json'); }
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
    this.run = { ...meta, dir, vault: new Vault(dir), count: 0, lastAt: meta.start };
    if (this.journal) this.journal.record('marker', 'trace', 1, 'ui', { event: 'trace-start', name: meta.name, trace: true });
    // old runs
    const all = this.listRuns();
    for (const r of all.slice(KEEP_RUNS)) { try { fs.rmSync(path.join(RUNS, r.id), { recursive: true, force: true }); } catch { /* */ } }
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
    if (!this.run) return null;
    clearInterval(this._syncTimer); this._syncTimer = null;
    if (!opt.skipSync && this.settings.sync.atEnd && opt.sync !== false) {
      try { while (this.syncBusy) await sleep(200); await this.sendSync('end'); await sleep(Math.min(8000, this.settings.thresholds.matchWindowMs)); } catch (e) { this._patchMeta(this.run.id, { syncError: e.message }); }
    }
    const r = this.run;
    this.run = null;
    if (this.journal) this.journal.record('marker', 'trace', 0, 'ui', { event: 'trace-stop', reason, trace: true });
    return this._patchMeta(r.id, { end: Date.now(), endReason: reason, count: r.count });
  }

  readEvents(id) {
    if (this.run && this.run.id === id) {
      // current run: the file is complete up to now
    }
    const out = [];
    try {
      for (const line of fs.readFileSync(path.join(RUNS, id, 'events.jsonl'), 'utf8').split('\n')) { if (line) { try { out.push(JSON.parse(line)); } catch { /* */ } } }
    } catch { /* none yet */ }
    return out;
  }

  analyze(id) {
    const meta = id ? (this.run && this.run.id === id ? { ...this.run, vault: undefined, dir: undefined } : (() => { try { return JSON.parse(fs.readFileSync(this._metaPath(id), 'utf8')); } catch { return null; } })()) : null;
    if (id && !meta) throw err('That run no longer exists', 404);
    const events = id ? this.readEvents(id) : this.live;
    const syncs = id ? (meta.syncs || []) : (this.liveSyncs || []);
    const res = correlate(events, syncs, this.settings);
    return { meta: meta ? { id: meta.id, name: meta.name, start: meta.start, end: meta.end, endReason: meta.endReason, syncError: meta.syncError, imports: meta.imports || [], count: events.length, running: !!(this.run && this.run.id === id) } : null, ...res };
  }

  deleteRun(id) {
    if (this.run && this.run.id === id) throw err('Stop the run before deleting it', 409);
    if (!/^trace-[a-z0-9]+$/.test(id)) throw err('Bad run id');
    fs.rmSync(path.join(RUNS, id), { recursive: true, force: true });
  }

  /** Plain payload of one event, if allowed. Every reveal is logged. */
  reveal(runId, eventId, who) {
    if (!this.settings.allowRaw) throw err('Showing plain text is turned off (Setup › Privacy)', 403);
    let raw;
    if (runId) {
      const v = this.run && this.run.id === runId ? this.run.vault : new Vault(path.join(RUNS, runId));
      raw = v.reveal(eventId, who);
    } else {
      raw = this.liveVault.get(eventId);
      if (this.run) raw = raw === undefined ? this.run.vault.reveal(eventId, who) : (this.run.vault.reveal(eventId, who), raw);
    }
    if (raw === undefined) throw err('The original of that event is not kept', 404);
    console.log(`[Trace] plain text of ${eventId} shown to ${who || '?'}`);
    return raw;
  }

  // ── imports (after the fact) ───────────────────────────────────────────
  _importInto(id, events, rawList, what) {
    const dir = path.join(RUNS, id);
    if (!fs.existsSync(dir)) throw err('That run no longer exists', 404);
    const vault = this.run && this.run.id === id ? this.run.vault : new Vault(dir);
    const lines = [];
    events.forEach((e, i) => {
      e.seq = ++this.seq;
      const raw = rawList ? rawList[i] : undefined;
      if (raw !== undefined && raw !== null) { e.secret = hasSecrets(raw); e.hasRaw = true; e.detail = scrub(raw); vault.put(e.id, raw); }
      lines.push(JSON.stringify(e));
    });
    if (lines.length) fs.appendFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
    const m = this._patchMeta(id, {});
    if (m) { m.imports = (m.imports || []).concat({ at: Date.now(), what, count: events.length }); fs.writeFileSync(this._metaPath(id), JSON.stringify(m)); }
    if (this.run && this.run.id === id) this.run.count += events.length;
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
    events.forEach((e, i) => { const k = `${e.harVia}|${e.eventId || ''}|${e.type}|${e.t}|${e.door && e.door.id}`; if (seen.has(k)) return; seen.add(k); ev2.push(e); raw2.push(raws[i]); });
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
    };
  }
}

module.exports = { TraceEngine, cleanSettings, DEFAULTS, toMs };
