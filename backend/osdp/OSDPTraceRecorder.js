// osdp/OSDPTraceRecorder.js
//
// OSDP bus trace logger for firmware uploads.
//
// Taps the serial port the firmware uploader opens — every byte written (TX)
// and every byte received (RX) — frames and decodes it, and writes each event
// to disk the moment it happens (data/osdp-traces/<id>/events.jsonl). A crash,
// a hung reader or a pulled cable mid-upload still leaves a complete log.
//
// Nothing in the uploader's transfer logic changes: the recorder wraps the
// port's write() and adds its own 'data' listener alongside the uploader's.
//
// Exports per trace:
//   report   human-readable report (header, statistics, anomalies, timeline)
//   csv      one row per frame / note
//   osdpcap  standard OSDP capture lines {"timeSec","timeNano","io":"trace","data",...}
//            readable by common OSDP trace viewers
//   jsonl    Aether's full decoded event log
//   bundle   .zip of report + csv + osdpcap + meta.json + README for the manufacturer
//
// HTTP (mounted by store.attachRoutes(app)):
//   GET    /api/osdp/firmware-traces                 list
//   GET    /api/osdp/firmware-traces/live            { traceId } of the recording in progress
//   GET    /api/osdp/firmware-traces/:id             meta + stats
//   GET    /api/osdp/firmware-traces/:id/events      ?since=n&limit=&tail=&filter=anomalies
//   POST   /api/osdp/firmware-traces/:id/notes       { ticket, technician, notes }
//   POST   /api/osdp/firmware-traces/:id/marker      { text }
//   GET    /api/osdp/firmware-traces/:id/export      ?format=report|csv|osdpcap|jsonl|bundle
//   DELETE /api/osdp/firmware-traces/:id

const fs       = require('fs');
const fsp      = fs.promises;
const path     = require('path');
const zlib     = require('zlib');
const readline = require('readline');
const express  = require('express');
const { decodeFrame, hex, h2, NAK_REASONS } = require('./OSDPTraceDecode');

const TRACE_DIR     = path.join(__dirname, '..', 'data', 'osdp-traces');
const MAX_TRACES    = 100;          // oldest are pruned past this
const LIVE_KEEP     = 5000;         // events kept in memory for the live view
const RX_STALL_MS   = 400;          // partial frame older than this is flushed as noise
const META_FLUSH_MS = 5000;
const SOURCE        = 'Aether';

// ─── clock: wall time with sub-millisecond resolution ─────────────────────
const HR0   = process.hrtime.bigint();
const WALL0 = BigInt(Date.now()) * 1000000n;
const nowNs = () => WALL0 + (process.hrtime.bigint() - HR0);
const nsToMs = ns => Number(ns / 1000n) / 1000;            // epoch ms, µs precision
const isoMs  = ms => new Date(Math.floor(ms)).toISOString();

const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(id);
const pad = (s, n) => String(s).padEnd(n);

// ═══════════════════════════════════════════════════════════════════════════
// TraceSession — one recording
// ═══════════════════════════════════════════════════════════════════════════

class TraceSession {
  constructor(store, meta) {
    this.store = store;
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const addr = meta.address != null ? meta.address.toString(16).padStart(2, '0') : 'xx';
    this.id  = `fwt_${stamp}_a${addr}_${Math.random().toString(36).slice(2, 6)}`;
    this.dir = path.join(store.dir, this.id);
    this.t0Ns = nowNs();
    this.meta = {
      id: this.id,
      kind: meta.kind || 'firmware-upload',
      source: SOURCE,
      startedAt: isoMs(nsToMs(this.t0Ns)),
      startedAtMs: nsToMs(this.t0Ns),
      endedAt: null,
      result: 'in-progress',
      reader: meta.reader || null,
      readerId: meta.readerId || null,
      port: meta.port || null,
      baud: meta.baud || null,
      address: meta.address != null ? meta.address : null,
      firmware: meta.firmware || null,
      identity: meta.identity || null,
      host: meta.host || null,
      ticket: null, technician: null, notes: meta.notes || null,
    };
    this.stats = {
      events: 0, txFrames: 0, rxFrames: 0, txBytes: 0, rxBytes: 0,
      naks: {}, busy: 0, badCheck: 0, malformed: 0, noiseBytes: 0, echoFrames: 0,
      seqMismatch: 0, otherAddress: 0, ftErrors: 0, warnings: 0, errors: 0, markers: 0,
      ftStatus: {}, latency: { count: 0, min: null, max: null, sum: 0 },
      fragments: 0, payloadBytes: 0, finalizePolls: 0, repeatedOffsets: 0,
    };
    this.latencies = [];
    this.events = [];          // live window
    this.n = 0;
    this.port = null;
    this.rxBuf = Buffer.alloc(0);
    this.rxStartNs = null;
    this.rxTimer = null;
    this.lastTx = null;        // { tNs, len, hex, seq, addr, name }
    this.lastEventNs = this.t0Ns;
    this.lastOffset = null;
    this.lastProgressDecile = -1;
    this.finished = false;

    fs.mkdirSync(this.dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, 'events.jsonl'), { flags: 'a' });
    this.stream.on('error', e => console.warn(`[OSDP-TRACE] write error ${this.id}: ${e.message}`));
    this._writeMetaSync();
    this.metaTimer = setInterval(() => this._writeMeta().catch(() => {}), META_FLUSH_MS);
    if (this.metaTimer.unref) this.metaTimer.unref();

    this.note('info', `Trace started — ${this.meta.reader || 'reader'} on ${this.meta.port} @ ${this.meta.baud} baud, address ${this.meta.address != null ? h2(this.meta.address) : '?'}`, 'trace');
    if (this.meta.firmware) {
      const fw = this.meta.firmware;
      this.note('info', `Firmware ${fw.name || '?'} — ${fw.sizeBytes} bytes, SHA-256 ${fw.sha256 || '?'}`, 'trace');
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  /** Hook an OSDPFirmwareUploader: port attach on open(), status notes, progress milestones. */
  bindUploader(uploader) {
    const origOpen  = uploader.open.bind(uploader);
    const origClose = uploader.close.bind(uploader);
    uploader.open = async (...a) => {
      try { await origOpen(...a); }
      catch (e) { this.note('error', `Port open failed: ${e.message}`, 'uploader'); throw e; }
      if (uploader.port) this.attachPort(uploader.port);
    };
    uploader.close = async (...a) => { this.detachPort(); return origClose(...a); };
    uploader.on('status', s => {
      const lvl = s.level === 'warn' ? 'warn' : s.level === 'error' ? 'error' : s.level === 'success' ? 'success' : 'info';
      this.note(lvl, s.message, 'uploader');
    });
    uploader.on('progress', p => {
      const dec = Math.floor((p.percent || 0) / 10);
      if (p.phase === 'transfer' && dec > this.lastProgressDecile) {
        this.lastProgressDecile = dec;
        this._push({ kind: 'progress', phase: p.phase, percent: p.percent, fragment: p.fragment,
                     totalFragments: p.totalFragments, bytesSent: p.bytesSent, totalBytes: p.totalBytes,
                     text: `${p.percent}% — fragment ${p.fragment}/${p.totalFragments}, ${p.bytesSent}/${p.totalBytes} bytes` });
      }
    });
  }

  attachPort(port) {
    if (this.port) this.detachPort();
    this.port = port;
    this._origWrite = port.write;
    const self = this;
    port.write = function tracedWrite(data, ...rest) {
      try { self._onTx(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch (e) { /* never break the upload */ }
      return self._origWrite.call(this, data, ...rest);
    };
    this._onData = chunk => { try { this._onRx(chunk); } catch (e) { /* ignore */ } };
    port.on('data', this._onData);
    this.note('info', `Logger attached to ${this.meta.port} (TX and RX)`, 'trace');
  }

  detachPort() {
    if (!this.port) return;
    this._flushRx('port closing');
    try { this.port.write = this._origWrite; } catch (_) {}
    try { this.port.removeListener('data', this._onData); } catch (_) {}
    this.port = null;
    this.note('info', 'Logger detached (port closed)', 'trace');
  }

  // ── capture ──────────────────────────────────────────────────────────────

  _onTx(buf) {
    const tNs = nowNs();
    // A write may carry more than one frame; split on declared lengths.
    let o = 0;
    while (o < buf.length) {
      if (buf[o] !== 0x53 || o + 4 > buf.length) { this._noise('tx', buf.slice(o), tNs, 'TX bytes outside a frame'); return; }
      const L = buf.readUInt16LE(o + 2);
      if (L < 7 || o + L > buf.length) { this._noise('tx', buf.slice(o), tNs, 'TX frame with bad length'); return; }
      this._frame('tx', buf.slice(o, o + L), tNs, tNs);
      o += L;
    }
  }

  _onRx(chunk) {
    const tNs = nowNs();
    if (!this.rxBuf.length) this.rxStartNs = tNs;
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
    this.stats.rxBytes += chunk.length;

    while (this.rxBuf.length) {
      const som = this.rxBuf.indexOf(0x53);
      if (som < 0) { this._noise('rx', this.rxBuf, this.rxStartNs, 'bytes with no start-of-message'); this.rxBuf = Buffer.alloc(0); break; }
      if (som > 0) { this._noise('rx', this.rxBuf.slice(0, som), this.rxStartNs, 'bytes before start-of-message'); this.rxBuf = this.rxBuf.slice(som); }
      if (this.rxBuf.length < 4) break;
      const L = this.rxBuf.readUInt16LE(2);
      if (L < 7 || L > 2048) { this._noise('rx', this.rxBuf.slice(0, 1), this.rxStartNs, `0x53 with impossible length ${L}`); this.rxBuf = this.rxBuf.slice(1); continue; }
      if (this.rxBuf.length < L) break;
      this._frame('rx', this.rxBuf.slice(0, L), this.rxStartNs, tNs);
      this.rxBuf = this.rxBuf.slice(L);
      this.rxStartNs = tNs;
    }

    if (this.rxTimer) clearTimeout(this.rxTimer);
    if (this.rxBuf.length) {
      this.rxTimer = setTimeout(() => this._flushRx('incomplete frame (stalled)'), RX_STALL_MS);
      if (this.rxTimer.unref) this.rxTimer.unref();
    }
  }

  _flushRx(why) {
    if (this.rxTimer) { clearTimeout(this.rxTimer); this.rxTimer = null; }
    if (this.rxBuf.length) {
      this._noise('rx', this.rxBuf, this.rxStartNs || nowNs(), why);
      this.rxBuf = Buffer.alloc(0);
    }
  }

  _noise(dir, buf, tNs, why) {
    this.stats.noiseBytes += buf.length;
    this._push({ kind: 'noise', dir, tNs, len: buf.length, hex: hex(buf), text: why, flags: ['noise'] });
  }

  _frame(dir, buf, tFirstNs, tLastNs) {
    const fr = decodeFrame(buf);
    const ev = { kind: 'frame', dir, tNs: tFirstNs, len: buf.length, hex: hex(buf), ...fr };
    if (tLastNs && tLastNs !== tFirstNs) ev.rxSpanMs = +(Number(tLastNs - tFirstNs) / 1e6).toFixed(3);
    const flags = new Set(fr.flags || []);
    const S = this.stats;

    if (dir === 'tx') {
      S.txFrames++; S.txBytes += buf.length;
      if (this.lastTx && this.lastTx.hex === ev.hex) { flags.add('retransmit'); }
      this.lastTx = { tNs: tFirstNs, len: buf.length, hex: ev.hex, seq: fr.seq, addr: fr.addr, name: fr.name };
      if (fr.code === 0x7C && fr.fields) {
        if (fr.fields.fragLen === 0) S.finalizePolls++;
        else {
          S.fragments++; S.payloadBytes += fr.fields.fragLen;
          if (this.lastOffset === fr.fields.offset) { S.repeatedOffsets++; flags.add('repeated-offset'); }
          this.lastOffset = fr.fields.offset;
        }
      }
    } else {
      S.rxFrames++;
      if (!fr.reply && this.lastTx && this.lastTx.hex === ev.hex) {
        // RS-485 adapters without echo suppression hand our own command back.
        S.echoFrames++; flags.add('echo'); ev.echo = true;
      } else if (fr.reply) {
        if (this.meta.address != null && fr.addr !== this.meta.address) { S.otherAddress++; flags.add('other-address'); }
        if (this.lastTx) {
          const wireMs = this.meta.baud ? (this.lastTx.len * 10 * 1000) / this.meta.baud : 0;
          const lat = Number(tFirstNs - this.lastTx.tNs) / 1e6 - wireMs;
          ev.latencyMs = +Math.max(0, lat).toFixed(3);
          ev.inReplyTo = this.lastTx.name;
          const L = S.latency;
          L.count++; L.sum += ev.latencyMs;
          L.min = L.min == null ? ev.latencyMs : Math.min(L.min, ev.latencyMs);
          L.max = L.max == null ? ev.latencyMs : Math.max(L.max, ev.latencyMs);
          if (this.latencies.length < 200000) this.latencies.push(ev.latencyMs);
          if (fr.seq !== this.lastTx.seq && fr.code !== 0x41) { S.seqMismatch++; flags.add('seq-mismatch'); }
        }
      }
    }
    if (flags.has('bad-check')) S.badCheck++;
    if (flags.has('malformed')) S.malformed++;
    if (fr.code === 0x41 && fr.reply) { const k = fr.fields && fr.fields.nakCode != null ? h2(fr.fields.nakCode) : 'none'; S.naks[k] = (S.naks[k] || 0) + 1; }
    if (fr.code === 0x79 && fr.reply) S.busy++;
    if (fr.code === 0x7A && fr.reply && fr.fields) {
      const k = String(fr.fields.status); S.ftStatus[k] = (S.ftStatus[k] || 0) + 1;
      if (fr.fields.status < 0) S.ftErrors++;
    }
    ev.flags = flags.size ? [...flags] : undefined;
    this._push(ev);
  }

  note(level, text, source = 'system') {
    if (level === 'warn') this.stats.warnings++;
    if (level === 'error') this.stats.errors++;
    const ev = { kind: 'note', level, source, text };
    if (level === 'warn' || level === 'error') ev.flags = [level];
    return this._push(ev);
  }

  marker(text, by) {
    this.stats.markers++;
    return this._push({ kind: 'marker', text: String(text || '').slice(0, 500), by: by || null, flags: ['marker'] });
  }

  _push(ev) {
    const tNs = ev.tNs || nowNs();
    delete ev.tNs;
    ev.n = ++this.n;
    ev.t = nsToMs(tNs);
    ev.tNs = tNs.toString();
    ev.rel = +(Number(tNs - this.t0Ns) / 1e6).toFixed(3);
    ev.dt = +(Number(tNs - this.lastEventNs) / 1e6).toFixed(3);
    this.lastEventNs = tNs;
    for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
    this.stats.events = this.n;
    if (!this.finished) this.stream.write(JSON.stringify(ev) + '\n');
    else fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    this.events.push(ev);
    if (this.events.length > LIVE_KEEP) this.events.splice(0, this.events.length - LIVE_KEEP);
    return ev;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  summaryStats() {
    const S = JSON.parse(JSON.stringify(this.stats));
    const L = S.latency;
    L.avg = L.count ? +(L.sum / L.count).toFixed(3) : null;
    if (this.latencies.length) {
      const s = [...this.latencies].sort((a, b) => a - b);
      L.p50 = s[Math.floor(s.length * 0.5)];
      L.p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    }
    delete L.sum;
    const durMs = (this.meta.endedAtMs || nsToMs(nowNs())) - this.meta.startedAtMs;
    S.durationMs = Math.round(durMs);
    S.payloadBytesPerSec = durMs > 0 ? Math.round(S.payloadBytes / (durMs / 1000)) : null;
    S.anomalies = S.badCheck + S.malformed + S.busy + S.seqMismatch + S.otherAddress + S.ftErrors +
                  S.warnings + S.errors + Object.values(S.naks).reduce((a, b) => a + b, 0) + (S.noiseBytes ? 1 : 0);
    return S;
  }

  async finish(outcome = {}) {
    if (this.finished) return this.meta;
    this.detachPort();
    const endNs = nowNs();
    this.meta.endedAtMs = nsToMs(endNs);
    this.meta.endedAt = isoMs(this.meta.endedAtMs);
    this.meta.result = outcome.result || 'unknown';
    this.meta.error = outcome.error || null;
    this.meta.finalStatus = outcome.finalStatus != null ? outcome.finalStatus : null;
    this.meta.bytesSent = outcome.bytesSent != null ? outcome.bytesSent : null;
    this.note(this.meta.result === 'success' ? 'success' : 'error',
      `Upload ${this.meta.result}${this.meta.error ? ': ' + this.meta.error : ''}`, 'trace');
    this.finished = true;
    clearInterval(this.metaTimer);
    await new Promise(r => this.stream.end(r));
    await this._writeMeta();
    this.store._ended(this);
    return this.meta;
  }

  fullMeta() { return { ...this.meta, stats: this.summaryStats(), live: !this.finished }; }
  _writeMetaSync() { fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.fullMeta(), null, 2)); }
  async _writeMeta() {
    const tmp = path.join(this.dir, 'meta.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify(this.fullMeta(), null, 2));
    await fsp.rename(tmp, path.join(this.dir, 'meta.json'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TraceStore — all recordings on disk + HTTP routes
// ═══════════════════════════════════════════════════════════════════════════

class TraceStore {
  constructor(dir = TRACE_DIR) {
    this.dir = dir;
    this.live = null;
    this._cache = null;       // { id, mtime, events } for the last completed trace read
  }

  start(meta) {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    this._prune();
    if (this.live && !this.live.finished) {
      this.live.finish({ result: 'interrupted', error: 'superseded by a new trace' }).catch(() => {});
    }
    this.live = new TraceSession(this, meta);
    console.log(`[OSDP-TRACE] recording ${this.live.id}`);
    return this.live;
  }

  _ended(session) { if (this.live === session) this.live = null; }

  _prune() {
    try {
      const ids = fs.readdirSync(this.dir).filter(n => n.startsWith('fwt_')).sort();
      while (ids.length >= MAX_TRACES) {
        const old = ids.shift();
        fs.rmSync(path.join(this.dir, old), { recursive: true, force: true });
      }
    } catch (_) {}
  }

  async readMeta(id) {
    if (this.live && this.live.id === id) return this.live.fullMeta();
    const txt = await fsp.readFile(path.join(this.dir, id, 'meta.json'), 'utf8');
    const m = JSON.parse(txt);
    // A trace left "in-progress" by a backend restart mid-upload
    if (m.result === 'in-progress') { m.result = 'interrupted'; m.live = false; m.error = m.error || 'backend stopped while recording'; }
    return m;
  }

  async list() {
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch (_) { return []; }
    const out = [];
    for (const id of names.filter(n => n.startsWith('fwt_'))) {
      try {
        const m = await this.readMeta(id);
        out.push({ id: m.id, startedAt: m.startedAt, endedAt: m.endedAt, result: m.result, error: m.error,
                   reader: m.reader, port: m.port, baud: m.baud, address: m.address,
                   firmware: m.firmware ? { name: m.firmware.name, sizeBytes: m.firmware.sizeBytes } : null,
                   ticket: m.ticket, live: !!m.live,
                   stats: m.stats ? { txFrames: m.stats.txFrames, rxFrames: m.stats.rxFrames, anomalies: m.stats.anomalies, durationMs: m.stats.durationMs } : null });
      } catch (_) {}
    }
    return out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  async *iterEvents(id) {
    const file = path.join(this.dir, id, 'events.jsonl');
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch (_) { /* torn last line after a crash */ }
    }
  }

  async readAllEvents(id) {
    const st = await fsp.stat(path.join(this.dir, id, 'events.jsonl'));
    if (this._cache && this._cache.id === id && this._cache.mtime === st.mtimeMs) return this._cache.events;
    const events = [];
    for await (const ev of this.iterEvents(id)) events.push(ev);
    this._cache = { id, mtime: st.mtimeMs, events };
    return events;
  }

  async addNotes(id, { ticket, technician, notes }) {
    if (this.live && this.live.id === id) {
      const m = this.live.meta;
      if (ticket !== undefined) m.ticket = ticket; if (technician !== undefined) m.technician = technician; if (notes !== undefined) m.notes = notes;
      await this.live._writeMeta();
      return this.live.fullMeta();
    }
    const file = path.join(this.dir, id, 'meta.json');
    const m = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (ticket !== undefined) m.ticket = ticket; if (technician !== undefined) m.technician = technician; if (notes !== undefined) m.notes = notes;
    await fsp.writeFile(file, JSON.stringify(m, null, 2));
    return m;
  }

  async addMarker(id, text, by) {
    if (this.live && this.live.id === id) return this.live.marker(text, by);
    // after the fact: append, numbered after the last event
    const events = await this.readAllEvents(id);
    const last = events[events.length - 1];
    const tMs = Date.now();
    const ev = { kind: 'marker', text: String(text || '').slice(0, 500), by: by || null, flags: ['marker', 'post-hoc'],
                 n: (last ? last.n : 0) + 1, t: tMs, tNs: (BigInt(tMs) * 1000000n).toString(),
                 rel: last ? +(last.rel + (tMs - last.t)).toFixed(3) : 0, dt: last ? +(tMs - last.t).toFixed(3) : 0 };
    await fsp.appendFile(path.join(this.dir, id, 'events.jsonl'), JSON.stringify(ev) + '\n');
    return ev;
  }

  // ── renderers ────────────────────────────────────────────────────────────

  async renderOsdpcap(id) {
    const lines = [];
    for await (const ev of this.iterEvents(id)) {
      if (ev.kind !== 'frame' || ev.echo || ev.redact || !ev.hex) continue;
      const ns = BigInt(ev.tNs);
      lines.push(JSON.stringify({
        timeSec: (ns / 1000000000n).toString(), timeNano: (ns % 1000000000n).toString(),
        io: 'trace', data: ev.hex, osdpTraceVersion: '1', osdpSource: SOURCE,
      }));
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  async renderCsv(id) {
    const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = ['n,time_utc,t_rel_ms,dt_ms,kind,dir,address,seq,code,name,length,check_ok,latency_ms,flags,summary,hex'];
    for await (const ev of this.iterEvents(id)) {
      const isF = ev.kind === 'frame';
      rows.push([
        ev.n, new Date(Math.floor(ev.t)).toISOString(), ev.rel, ev.dt, ev.kind, ev.dir || '',
        isF && ev.addr != null ? h2(ev.addr) : '', isF ? ev.seq : '', isF && ev.code != null ? h2(ev.code) : '',
        isF ? ev.name : (ev.level || ev.kind), ev.len != null ? ev.len : '', isF ? (ev.checkOk ? 'yes' : 'NO') : '',
        ev.latencyMs != null ? ev.latencyMs : '', (ev.flags || []).join(' '),
        isF ? ev.summary : ev.text, ev.redact ? '(redacted)' : (ev.hex || ''),
      ].map(q).join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  async renderReport(id) {
    const m = await this.readMeta(id);
    const S = m.stats || {};
    const L = S.latency || {};
    const out = [];
    const line = (s = '') => out.push(s);
    const kv = (k, v) => line(`  ${pad(k + ':', 22)}${v == null || v === '' ? '—' : v}`);
    const rule = c => line(c.repeat(78));

    rule('=');
    line('  OSDP FIRMWARE UPLOAD — BUS TRACE REPORT');
    line(`  Generated by ${SOURCE} on ${new Date().toISOString()}`);
    rule('=');
    line();
    line('SESSION');
    kv('Trace ID', m.id);
    kv('Result', String(m.result || '').toUpperCase() + (m.error ? ` — ${m.error}` : ''));
    if (m.finalStatus != null) kv('Final FTSTAT status', m.finalStatus);
    kv('Started (UTC)', m.startedAt);
    kv('Ended (UTC)', m.endedAt);
    kv('Duration', S.durationMs != null ? `${(S.durationMs / 1000).toFixed(1)} s` : null);
    kv('Ticket / case', m.ticket);
    kv('Technician', m.technician);
    if (m.notes) { line('  Notes:'); String(m.notes).split('\n').forEach(n => line('    ' + n)); }
    line();
    line('TARGET READER');
    kv('Name', m.reader);
    kv('Serial port', m.port);
    kv('Baud rate', m.baud);
    kv('OSDP address', m.address != null ? `${h2(m.address)} (${m.address})` : null);
    const I = m.identity || {};
    kv('Vendor', I.vendorName || I.vendor);
    kv('Model / version', I.modelNumber != null ? `${I.modelNumber} / ${I.modelVersion != null ? I.modelVersion : '?'}` : null);
    kv('Serial number', I.serialHex);
    kv('Firmware before', I.firmwareString);
    if (I.supportsSecureChannel != null) kv('Secure channel cap.', I.supportsSecureChannel ? 'yes' : 'no');
    line();
    line('FIRMWARE FILE');
    const F = m.firmware || {};
    kv('File', F.name);
    kv('Source', F.source);
    kv('Size', F.sizeBytes != null ? `${F.sizeBytes.toLocaleString('en-US')} bytes` : null);
    kv('SHA-256', F.sha256);
    line();
    line('STATISTICS');
    kv('Frames TX / RX', `${S.txFrames || 0} / ${S.rxFrames || 0}`);
    kv('Bytes TX / RX', `${S.txBytes || 0} / ${S.rxBytes || 0}`);
    kv('Fragments sent', `${S.fragments || 0} (${(S.payloadBytes || 0).toLocaleString('en-US')} payload bytes)`);
    kv('Finalize polls', S.finalizePolls);
    kv('Throughput', S.payloadBytesPerSec != null ? `${S.payloadBytesPerSec} payload bytes/s` : null);
    kv('Reply latency', L.count ? `min ${L.min} / avg ${L.avg} / p95 ${L.p95} / max ${L.max} ms (${L.count} replies)` : null);
    const naks = Object.entries(S.naks || {});
    kv('NAKs', naks.length ? naks.map(([c, n]) => `${c} ${NAK_REASONS[parseInt(c, 16)] || ''} ×${n}`).join('; ') : '0');
    kv('BUSY replies', S.busy);
    kv('FTSTAT statuses', Object.entries(S.ftStatus || {}).map(([k, v]) => `${k}×${v}`).join(', '));
    kv('CRC/checksum errors', S.badCheck);
    kv('Sequence mismatches', S.seqMismatch);
    kv('Replies, other addr', S.otherAddress);
    kv('Line noise bytes', S.noiseBytes);
    kv('Echoed TX frames', S.echoFrames ? `${S.echoFrames} (adapter echoes TX; not an error)` : 0);
    kv('Warnings / errors', `${S.warnings || 0} / ${S.errors || 0}`);
    line();
    line('  TX = controller (Aether) → reader.  RX = reader → controller.');
    line('  Latency = time from the end of our command on the wire to the first reply byte.');
    line('  TX times are when the frame was handed to the serial driver.');
    line();

    const events = await this.readAllEvents(id);
    const anomalies = events.filter(isAnomaly);
    rule('-');
    line(`ANOMALIES AND NOTES (${anomalies.length})`);
    rule('-');
    if (!anomalies.length) line('  None.');
    for (const ev of anomalies) out.push(...fmtEvent(ev, true));
    line();

    rule('-');
    line('TIMELINE');
    line('  Routine fragment/FTSTAT exchanges are collapsed; every frame is in frames.csv and trace.osdpcap.');
    rule('-');
    // Collapse runs of plain FILETRANSFER → FTSTAT(OK) exchanges, keep first/last 3 in full.
    // Progress milestones inside a run are kept as one-liners, not as run breakers.
    let run = [];
    const show = ev => out.push(...fmtEvent(ev, false));
    const flush = () => {
      if (!run.length) return;
      const frames = run.filter(e => e.kind === 'frame');
      if (frames.length <= 14) { run.forEach(show); run = []; return; }
      const headEnd = frames[2].n, tailStart = frames[frames.length - 3].n;
      const mid = frames.slice(3, -3);
      const tx = mid.filter(e => e.dir === 'tx');
      const lats = mid.filter(e => e.latencyMs != null).map(e => e.latencyMs);
      const offs = tx.map(e => e.fields && e.fields.offset).filter(v => v != null);
      run.filter(e => e.n <= headEnd).forEach(show);
      line(`             … ${mid.length} routine frames collapsed (${tx.length} fragment${tx.length === 1 ? '' : 's'}` +
           (offs.length ? `, offsets ${offs[0]}–${offs[offs.length - 1]}` : '') +
           (lats.length ? `, latency avg ${(lats.reduce((x, y) => x + y, 0) / lats.length).toFixed(1)} max ${Math.max(...lats).toFixed(1)} ms` : '') + ') …');
      run.filter(e => e.kind === 'progress' && e.n > headEnd && e.n < tailStart).forEach(show);
      run.filter(e => e.n >= tailStart).forEach(show);
      run = [];
    };
    for (const ev of events) {
      if (isRoutine(ev) || (ev.kind === 'progress' && run.length)) { run.push(ev); continue; }
      flush();
      out.push(...fmtEvent(ev, false));
    }
    flush();
    line();
    rule('=');
    line('  End of report');
    rule('=');
    return out.join('\n') + '\n';
  }

  async renderBundle(id) {
    const m = await this.readMeta(id);
    const base = bundleBase(m);
    const files = [
      { name: `${base}/README.txt`, data: Buffer.from(readmeText(m)) },
      { name: `${base}/report.txt`, data: Buffer.from(await this.renderReport(id)) },
      { name: `${base}/trace.osdpcap`, data: Buffer.from(await this.renderOsdpcap(id)) },
      { name: `${base}/frames.csv`, data: Buffer.from(await this.renderCsv(id)) },
      { name: `${base}/meta.json`, data: Buffer.from(JSON.stringify(m, null, 2)) },
    ];
    return { filename: `${base}.zip`, buffer: buildZip(files) };
  }

  // ── routes ───────────────────────────────────────────────────────────────

  attachRoutes(app) {
    const R = '/api/osdp/firmware-traces';
    const json = express.json({ limit: '256kb' });
    const guard = (req, res) => {
      if (!safeId(req.params.id)) { res.status(400).json({ success: false, error: 'bad trace id' }); return false; }
      if (!(this.live && this.live.id === req.params.id) && !fs.existsSync(path.join(this.dir, req.params.id, 'meta.json'))) {
        res.status(404).json({ success: false, error: 'trace not found' }); return false;
      }
      return true;
    };

    app.get(R, async (_req, res) => {
      try { res.json({ success: true, traces: await this.list(), liveId: this.live ? this.live.id : null }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.get(`${R}/live`, (_req, res) => {
      res.json({ success: true, traceId: this.live ? this.live.id : null });
    });

    app.get(`${R}/:id`, async (req, res) => {
      if (!guard(req, res)) return;
      try { res.json({ success: true, trace: await this.readMeta(req.params.id) }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Live view polls with ?since=<last n>. Completed traces: ?tail=N and/or ?filter=anomalies.
    app.get(`${R}/:id/events`, async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const id = req.params.id;
        const since = parseInt(req.query.since, 10) || 0;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
        const tail = parseInt(req.query.tail, 10) || 0;
        const onlyAnom = req.query.filter === 'anomalies';
        const live = this.live && this.live.id === id ? this.live : null;
        let src;
        if (live && (since >= (live.events[0] ? live.events[0].n - 1 : 0))) src = live.events;
        else src = await this.readAllEvents(id);
        let evs = src.filter(e => e.n > since && (!onlyAnom || isAnomaly(e)));
        const total = evs.length;
        evs = tail ? evs.slice(-tail) : evs.slice(0, limit);
        res.json({ success: true, live: !!live, lastN: live ? live.n : (src.length ? src[src.length - 1].n : 0),
                   total, more: !tail && total > evs.length, events: evs,
                   stats: live ? live.summaryStats() : undefined });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.post(`${R}/:id/notes`, json, async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const b = req.body || {};
        const clip = (v, n) => v == null ? undefined : String(v).slice(0, n);
        const m = await this.addNotes(req.params.id, { ticket: clip(b.ticket, 120), technician: clip(b.technician, 120), notes: clip(b.notes, 8000) });
        res.json({ success: true, trace: m });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.post(`${R}/:id/marker`, json, async (req, res) => {
      if (!guard(req, res)) return;
      const text = req.body && String(req.body.text || '').trim();
      if (!text) return res.status(400).json({ success: false, error: 'text required' });
      try { res.json({ success: true, event: await this.addMarker(req.params.id, text, req.body.by) }); }
      catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.get(`${R}/:id/export`, async (req, res) => {
      if (!guard(req, res)) return;
      const id = req.params.id;
      const fmt = String(req.query.format || 'bundle');
      try {
        const m = await this.readMeta(id);
        const base = bundleBase(m);
        const send = (body, name, type) => {
          res.setHeader('Content-Type', type);
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          res.send(body);
        };
        if (fmt === 'report')  return send(await this.renderReport(id), `${base}_report.txt`, 'text/plain; charset=utf-8');
        if (fmt === 'csv')     return send(await this.renderCsv(id), `${base}_frames.csv`, 'text/csv; charset=utf-8');
        if (fmt === 'osdpcap') return send(await this.renderOsdpcap(id), `${base}.osdpcap`, 'application/x-ndjson');
        if (fmt === 'jsonl') {
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.setHeader('Content-Disposition', `attachment; filename="${base}_events.jsonl"`);
          return fs.createReadStream(path.join(this.dir, id, 'events.jsonl')).pipe(res);
        }
        if (fmt === 'bundle') { const z = await this.renderBundle(id); return send(z.buffer, z.filename, 'application/zip'); }
        res.status(400).json({ success: false, error: 'format must be report, csv, osdpcap, jsonl or bundle' });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    app.delete(`${R}/:id`, async (req, res) => {
      if (!guard(req, res)) return;
      if (this.live && this.live.id === req.params.id) return res.status(409).json({ success: false, error: 'trace is still recording' });
      try {
        await fsp.rm(path.join(this.dir, req.params.id), { recursive: true, force: true });
        if (this._cache && this._cache.id === req.params.id) this._cache = null;
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    console.log('[OSDP-TRACE] Trace routes mounted at ' + R);
  }
}

// ─── report helpers ───────────────────────────────────────────────────────

function isAnomaly(ev) {
  if (ev.kind === 'marker' || ev.kind === 'noise') return true;
  if (ev.kind === 'note') return ev.level === 'warn' || ev.level === 'error';
  if (ev.kind !== 'frame') return false;
  return (ev.flags || []).some(f => f !== 'echo');
}

// Plain fragment → FTSTAT(OK) exchanges (and adapter echoes of them) — collapsed in the timeline.
function isRoutine(ev) {
  if (ev.kind !== 'frame') return false;
  if (ev.echo) return (ev.flags || []).every(f => f === 'echo');
  if (isAnomaly(ev)) return false;
  if (ev.dir === 'tx') return ev.code === 0x7C && !!ev.fields && ev.fields.fragLen > 0;
  return ev.code === 0x7A && !!ev.fields && ev.fields.status === 0;
}

function fmtEvent(ev, withDate) {
  const t = withDate ? new Date(Math.floor(ev.t)).toISOString().replace('T', ' ').replace('Z', '') : `+${(ev.rel / 1000).toFixed(3).padStart(9)}s`;
  const lines = [];
  if (ev.kind === 'frame') {
    const arrow = ev.dir === 'tx' ? 'TX →' : 'RX ←';
    const flags = (ev.flags || []).length ? `  [${ev.flags.join(', ')}]` : '';
    const lat = ev.latencyMs != null ? `  (${ev.latencyMs} ms)` : '';
    lines.push(`  #${String(ev.n).padEnd(6)} ${t}  ${arrow} ${h2(ev.addr || 0)} sq${ev.seq} ${pad(ev.name, 13)} ${ev.summary || ''}${lat}${flags}`);
    if (ev.checkDetail) lines.push(`${' '.repeat(12)}${ev.checkDetail}`);
    if (!ev.redact && ev.hex) lines.push(`${' '.repeat(12)}${ev.hex.length > 140 ? ev.hex.slice(0, 140) + ` … (${ev.len} bytes)` : ev.hex}`);
  } else if (ev.kind === 'noise') {
    lines.push(`  #${String(ev.n).padEnd(6)} ${t}  ${ev.dir === 'tx' ? 'TX' : 'RX'} ?? ${ev.len} stray byte(s): ${ev.text}`);
    lines.push(`${' '.repeat(12)}${ev.hex.length > 140 ? ev.hex.slice(0, 140) + ' …' : ev.hex}`);
  } else if (ev.kind === 'marker') {
    lines.push(`  #${String(ev.n).padEnd(6)} ${t}  ★ MARKER${ev.by ? ` (${ev.by})` : ''}: ${ev.text}`);
  } else if (ev.kind === 'progress') {
    lines.push(`  #${String(ev.n).padEnd(6)} ${t}  ·· progress ${ev.text}`);
  } else {
    lines.push(`  #${String(ev.n).padEnd(6)} ${t}  ${pad((ev.level || 'info').toUpperCase(), 7)} [${ev.source || ''}] ${ev.text}`);
  }
  return lines;
}

function bundleBase(m) {
  const who = String(m.reader || `addr${m.address}`).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'reader';
  const when = String(m.startedAt || '').replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `osdp-trace_${who}_${when}`;
}

function readmeText(m) {
  return [
    'OSDP firmware upload — bus trace',
    '================================',
    '',
    `Reader:   ${m.reader || '?'}  (port ${m.port}, ${m.baud} baud, OSDP address ${m.address})`,
    `Firmware: ${m.firmware ? `${m.firmware.name} (${m.firmware.sizeBytes} bytes, SHA-256 ${m.firmware.sha256})` : '?'}`,
    `Result:   ${m.result}${m.error ? ' — ' + m.error : ''}`,
    `When:     ${m.startedAt} → ${m.endedAt || '?'} (UTC)`,
    m.ticket ? `Ticket:   ${m.ticket}` : null,
    '',
    'Files',
    '-----',
    'report.txt     Human-readable summary: session, reader identity, statistics,',
    '               every anomaly (NAK, BUSY, CRC error, timeout, stray bytes),',
    '               and a timeline with routine fragment exchanges collapsed.',
    'trace.osdpcap  Every frame on the wire, raw, in the standard OSDP capture',
    '               format (one JSON object per line: timeSec, timeNano, io,',
    '               data = space-separated hex). Opens in OSDP trace viewers.',
    'frames.csv     Every frame decoded, one per row, for spreadsheets.',
    'meta.json      Session metadata and statistics, machine-readable.',
    '',
    'The controller side was Aether acting as OSDP CP, sending osdp_FILETRANSFER',
    '(0x7C) fragments and reading osdp_FTSTAT (0x7A) replies. Timestamps are UTC',
    'with microsecond resolution, taken on the controller.',
    '',
  ].filter(l => l !== null).join('\r\n');
}

// ─── minimal zip writer (deflate, no dependencies) ────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const store = new TraceStore();

module.exports = { store, TraceStore, TraceSession, buildZip, TRACE_DIR };
