// osdpTraceHub.js — the backend home of the OSDP trace.
// Raw bytes (from the emulator's own bus, or a passive sniffer) come in here,
// get reassembled into frames, decoded (osdpDecoder) and analyzed (osdpAnalyzer).
// It keeps a ring buffer of decoded frames, serves the live feed, saves/loads
// captures, exports, and runs user "expectation" rules for acceptance testing.
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { decodeFrame } = require('./osdpDecoder');
const { OsdpAnalyzer, REPLY_DEADLINE_MS } = require('./osdpAnalyzer');

const RING = 5000;
const CAP_DIR = path.join(__dirname, '..', '..', 'data', 'osdp-captures');

// Reassemble OSDP frames from a byte stream (per port+direction).
class Framer {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    const out = [];
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 6) {
      const som = this.buf.indexOf(0x53);
      if (som < 0) { this.buf = this.buf.slice(-1); break; }
      if (som > 0) this.buf = this.buf.slice(som);
      if (this.buf.length < 4) break;
      const len = this.buf[2] | (this.buf[3] << 8);
      if (len < 6 || len > 1440) { this.buf = this.buf.slice(1); continue; }   // not a real header, resync
      if (this.buf.length < len) break;
      out.push(this.buf.slice(0, len));
      this.buf = this.buf.slice(len);
    }
    return out;
  }
}

class OsdpTraceHub extends EventEmitter {
  constructor({ identifyCard } = {}) {
    super();
    this.identifyCard = identifyCard || (() => null);
    this.framers = new Map();               // key `${port}|${dir}` -> Framer
    this.frames = [];                        // decoded, with ts/direction/port
    this.analyzer = new OsdpAnalyzer();
    this.seq = 0;
    this.source = 'emulator';                // where the current live bytes come from
    this.rules = this._loadRules();
    try { fs.mkdirSync(CAP_DIR, { recursive: true }); } catch { /* */ }
  }

  // Raw bytes from a bus. direction: 'tx' (CP→PD) or 'rx' (PD→CP or observed).
  ingestRaw(direction, portPath, bytes, tsMs = Date.now(), source) {
    if (source) this.source = source;
    const key = `${portPath}|${direction}`;
    if (!this.framers.has(key)) this.framers.set(key, new Framer());
    for (const raw of this.framers.get(key).push(Buffer.from(bytes))) this._onFrame(direction, portPath, raw, tsMs);
  }

  // A frame that is already whole (e.g. our emulator hands us a built packet).
  ingestFrame(direction, portPath, bytes, tsMs = Date.now(), source) {
    if (source) this.source = source;
    this._onFrame(direction, portPath, Buffer.from(bytes), tsMs);
  }

  _onFrame(direction, portPath, raw, tsMs) {
    const decoded = decodeFrame(raw, { identifyCard: this.identifyCard });
    const rec = {
      id: ++this.seq, ts: tsMs, direction, port: portPath,
      address: decoded.address, isReply: decoded.isReply, name: decoded.name,
      code: decoded.code, sequence: decoded.sequence, length: decoded.length,
      summary: decoded.summary, hint: decoded.hint, description: decoded.description, section: decoded.section,
      hex: decoded.hex, dataHex: decoded.dataHex, checkOk: decoded.checkOk, check: decoded.check,
      errors: decoded.errors, warnings: decoded.warnings, encrypted: !!decoded.encrypted,
      secureType: decoded.secureType, mac: decoded.mac, decoded: decoded.decoded, scb: decoded.scb,
    };
    this.frames.push(rec);
    if (this.frames.length > RING) this.frames.shift();
    const events = this.analyzer.push(tsMs, decoded);
    const fired = this._checkRules(rec);
    this.emit('frame', rec);
    if (events.length) this.emit('events', events.map(rowOf));
    if (fired.length) this.emit('rules', fired);
  }

  snapshot(sinceId = 0) {
    return {
      source: this.source,
      frames: this.frames.filter(f => f.id > sinceId),
      events: this.analyzer.events.map(rowOf),
      health: this.analyzer.health(),
      stats: this.analyzer.stats(),
      replyDeadlineMs: REPLY_DEADLINE_MS,
      lastId: this.seq,
    };
  }

  clear() { this.frames = []; this.analyzer.reset(); this.seq = 0; this.framers.clear(); this._resetRuleState(); this.emit('cleared'); }

  // ── capture files ──
  saveCapture(name) {
    const safe = String(name || `capture-${Date.now()}`).replace(/[^\w.-]+/g, '_').slice(0, 60);
    const file = path.join(CAP_DIR, `${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), source: this.source, frames: this.frames.map(f => ({ ts: f.ts, direction: f.direction, port: f.port, hex: f.hex })) }, null, 0));
    return { name: safe, frames: this.frames.length };
  }
  listCaptures() {
    try {
      return fs.readdirSync(CAP_DIR).filter(f => f.endsWith('.json')).map(f => {
        const st = fs.statSync(path.join(CAP_DIR, f));
        return { name: f.replace(/\.json$/, ''), bytes: st.size, savedAt: st.mtime.toISOString() };
      }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } catch { return []; }
  }
  loadCapture(name) {
    const safe = String(name).replace(/[^\w.-]+/g, '_');
    const file = path.join(CAP_DIR, `${safe}.json`);
    if (!fs.existsSync(file)) { const e = new Error('Capture not found'); e.status = 404; throw e; }
    const cap = JSON.parse(fs.readFileSync(file, 'utf8'));
    // re-decode with the CURRENT decoder, so old captures benefit from fixes
    this.clear();
    this.source = `capture: ${safe}`;
    for (const f of cap.frames) this._onFrame(f.direction, f.port, Buffer.from(f.hex, 'hex'), f.ts);
    return { name: safe, frames: cap.frames.length };
  }
  deleteCapture(name) {
    const safe = String(name).replace(/[^\w.-]+/g, '_');
    const file = path.join(CAP_DIR, `${safe}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
  }

  exportText(kind) {
    const rows = this.frames;
    if (kind === 'csv') {
      const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
      const head = 'Time,Direction,Address,Reader/CP,Sequence,Name,Plain English,Integrity,Length,Hex';
      const lines = rows.map(f => [new Date(f.ts).toISOString(), f.direction, f.address, f.isReply ? 'PD→CP' : 'CP→PD', f.sequence, f.name, f.summary, f.checkOk ? 'OK' : (f.errors[0] || 'bad'), f.length, f.hex].map(esc).join(','));
      return [head, ...lines].join('\n');
    }
    if (kind === 'txt') {
      return rows.map(f => `${new Date(f.ts).toLocaleTimeString()}  ${f.isReply ? 'PD→CP' : 'CP→PD'}  addr ${f.address}  ${f.summary}${f.checkOk ? '' : '  [' + (f.errors[0] || 'bad frame') + ']'}`).join('\n');
    }
    return JSON.stringify({ exportedAt: new Date().toISOString(), source: this.source, health: this.analyzer.health(), stats: this.analyzer.stats(), frames: rows }, null, 1);
  }

  // ── expectation rules (acceptance testing) ──
  // A rule: { id, name, when:{name}, expect:{name, withinMs}, address? }
  // e.g. after osdp_RAW, expect an osdp_LED that turns green within 2000 ms.
  _loadRules() {
    try { const f = path.join(CAP_DIR, '..', 'osdp-trace-rules.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).rules || [] : DEFAULT_RULES(); }
    catch { return DEFAULT_RULES(); }
  }
  getRules() { return this.rules.map(r => ({ ...r, ...(this.ruleState && this.ruleState[r.id] ? this.ruleState[r.id] : { pass: 0, fail: 0, armed: false }) })); }
  setRules(rules) {
    this.rules = (rules || []).slice(0, 40).map((r, i) => ({ id: r.id || `rule_${i}_${Date.now()}`, name: String(r.name || 'Rule').slice(0, 80), whenName: r.whenName, expectName: r.expectName, withinMs: Math.max(1, Math.min(60000, Number(r.withinMs) || 2000)), address: r.address == null ? null : Number(r.address), color: r.color || null }));
    try { fs.writeFileSync(path.join(CAP_DIR, '..', 'osdp-trace-rules.json'), JSON.stringify({ version: 1, rules: this.rules }, null, 2)); } catch { /* */ }
    this._resetRuleState();
    return this.rules;
  }
  _resetRuleState() { this.ruleState = {}; this.armedRules = []; for (const r of this.rules) this.ruleState[r.id] = { pass: 0, fail: 0, armed: false }; }
  _checkRules(rec) {
    if (!this.ruleState) this._resetRuleState();
    const fired = [];
    // expire armed rules whose window passed
    this.armedRules = (this.armedRules || []).filter(a => {
      if (rec.ts - a.ts > a.rule.withinMs) {
        this.ruleState[a.rule.id].fail++; this.ruleState[a.rule.id].armed = false;
        fired.push({ ruleId: a.rule.id, name: a.rule.name, result: 'fail', reason: `No ${a.rule.expectName} within ${a.rule.withinMs} ms`, ts: rec.ts });
        return false;
      }
      return true;
    });
    for (const a of this.armedRules) {
      if (rec.name === a.rule.expectName && (a.rule.address == null || rec.address === a.rule.address)) {
        const ok = !a.rule.color || (rec.decoded && rec.decoded.led && rec.decoded.led.some(l => new RegExp(a.rule.color, 'i').test(l.text)));
        if (ok) { this.ruleState[a.rule.id].pass++; a.done = true; fired.push({ ruleId: a.rule.id, name: a.rule.name, result: 'pass', reason: `${rec.name} in ${rec.ts - a.ts} ms`, ts: rec.ts }); }
      }
    }
    this.armedRules = this.armedRules.filter(a => !a.done);
    for (const rule of this.rules) {
      if (rec.name === rule.whenName && (rule.address == null || rec.address === rule.address)) {
        this.armedRules.push({ rule, ts: rec.ts });
        this.ruleState[rule.id].armed = true;
      }
    }
    return fired;
  }
}

// Trim an analyzer event to what the UI needs (small, JSON-safe).
function frameView(f) {
  if (!f) return null;
  return { name: f.name, summary: f.summary, hint: f.hint, section: f.section, description: f.description,
    hex: f.hex, dataHex: f.dataHex, sequence: f.sequence, checkOk: f.checkOk, check: f.check,
    errors: f.errors, warnings: f.warnings, encrypted: !!f.encrypted, secureType: f.secureType,
    scb: f.scb, decoded: f.decoded };
}
function rowOf(ev) {
  if (ev.kind === 'idle') return { id: ev.id, kind: 'idle', address: ev.address, startTs: ev.startTs, lastTs: ev.lastTs, acks: ev.acks, summary: ev.summary };
  if (ev.kind === 'reply') return { id: ev.id, kind: 'reply', ts: ev.ts, address: ev.address, summary: ev.summary, anomalies: ev.anomalies, reply: frameView(ev.frame) };
  return { id: ev.id, kind: 'exchange', ts: ev.ts, address: ev.address, summary: ev.summary,
    replyMs: ev.replyMs, replySummary: ev.replySummary, replyName: ev.replyName, timedOut: !!ev.timedOut,
    anomalies: ev.anomalies, command: frameView(ev.command), reply: frameView(ev.reply) };
}

function DEFAULT_RULES() {
  return [
    { id: 'card_then_led', name: 'LED responds within 2 s of a card read', whenName: 'osdp_RAW', expectName: 'osdp_LED', withinMs: 2000, address: null, color: null },
    { id: 'poll_answered', name: 'Poll answered within deadline', whenName: 'osdp_POLL', expectName: 'osdp_ACK', withinMs: 200, address: null, color: null },
  ];
}

module.exports = { OsdpTraceHub };
