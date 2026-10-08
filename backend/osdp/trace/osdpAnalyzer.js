// osdpAnalyzer.js — turns a stream of decoded frames into a conversation:
// pairs each command with its reply and the reply time, flags anomalies against
// the SIA 2.2.2 behaviour rules, keeps per-reader health, and folds runs of idle
// polling. Pure and incremental so the same code serves the live trace, a
// re-analysis of a saved capture, and the exports. One fix here, every view gets it.
'use strict';

const REPLY_DEADLINE_MS = 200;      // spec REPLY_DELAY max
const SLOW_REPLY_MS = 20;           // typical is <3 ms; flag sluggish readers
const OFFLINE_MS = 8000;            // spec pdOfflineAfter

class OsdpAnalyzer {
  constructor() { this.reset(); }

  reset() {
    this.events = [];              // conversation rows (paired or standalone)
    this.readers = new Map();      // addr -> health
    this.pending = null;           // last command awaiting a reply
    this.seqByAddr = new Map();
    this.idleRun = null;           // folded run of poll/ack
    this.seq = 0;
  }

  _reader(addr) {
    if (!this.readers.has(addr)) this.readers.set(addr, {
      address: addr, firstSeen: null, lastSeen: null, online: false,
      polls: 0, commands: 0, replies: 0, naks: 0, retries: 0, timeouts: 0, busy: 0, crcErrors: 0,
      replyTimes: [], avgReplyMs: null, maxReplyMs: 0,
      lastCard: null, lastCardAt: null, cardReads: 0,
      tamper: null, power: null, model: null, firmware: null, secure: false,
      capabilities: null, nakCounts: {},
    });
    return this.readers.get(addr);
  }

  // ts: ms epoch. frame: output of decodeFrame. Returns the events emitted now.
  // A POLL is held provisionally: if the reply is a plain ACK it folds into the
  // idle run; if the reply is anything real (a card read, a NAK…) the exchange
  // is shown in full. So folding is decided by the pair, not by the command alone.
  push(ts, frame) {
    const emitted = [];
    const addr = frame.address;
    const r = this._reader(addr);
    if (r.firstSeen == null) r.firstSeen = ts;
    r.lastSeen = ts;

    if (frame.isReply) {
      r.replies++;
      if (frame.name === 'osdp_NAK') { r.naks++; const c = frame.decoded && frame.decoded.nak; r.nakCounts[c] = (r.nakCounts[c] || 0) + 1; }
      if (frame.name === 'osdp_BUSY') r.busy++;
      if (frame.encrypted || frame.secureType >= 0x15) r.secure = true;
      if (frame.decoded) {
        if (frame.decoded.raw && frame.decoded.raw.wieg) { r.lastCard = frame.decoded.raw.wieg; r.lastCardAt = ts; r.cardReads++; }
        if (frame.name === 'osdp_PDID') { r.model = frame.decoded.model; r.firmware = frame.decoded.firmware; }
        if (frame.name === 'osdp_PDCAP') r.capabilities = frame.decoded.capabilities;
        if (frame.name === 'osdp_LSTATR') { r.tamper = frame.decoded.tamper; r.power = frame.decoded.power; }
      }
      r.online = true;
    } else {
      r.commands++;
      if (frame.name === 'osdp_POLL') r.polls++;
    }
    if (!frame.checkOk) r.crcErrors++;

    const anomalies = this._anomalies(ts, frame, r);

    if (frame.isReply) {
      if (this.pending && this.pending.address === addr) {
        const p = this.pending; this.pending = null;
        const dt = ts - p.ts;
        const isIdle = p.command.name === 'osdp_POLL' && frame.name === 'osdp_ACK' && anomalies.length === 0;
        if (dt <= REPLY_DEADLINE_MS) { r.replyTimes.push(dt); r.maxReplyMs = Math.max(r.maxReplyMs, dt); this._recalcAvg(r); }
        if (isIdle) { this._foldIdle(addr, ts, emitted); return emitted; }
        // real exchange: fill in the reply
        p.reply = frame; p.replyMs = dt; p.replySummary = frame.summary; p.replyName = frame.name;
        if (dt > REPLY_DEADLINE_MS) p.anomalies.push({ level: 'warn', text: `Reply took ${dt} ms (over the ${REPLY_DEADLINE_MS} ms deadline)` });
        else if (dt > SLOW_REPLY_MS) p.anomalies.push({ level: 'info', text: `Slow reply (${dt} ms)` });
        p.anomalies.push(...anomalies);
        if (!p.shown) this._reveal(p, emitted);    // a held poll, now revealed
        else emitted.push(p);                       // already shown; client updates it by id
      } else {
        this.idleRun = null;
        const ev = { id: ++this.seq, kind: 'reply', ts, address: addr, frame, summary: frame.summary, anomalies: [{ level: 'warn', text: 'Unsolicited reply (no matching command)' }, ...anomalies] };
        this.events.push(ev); emitted.push(ev);
      }
    } else {
      this._flushPending(emitted);       // previous command never got its reply
      this.pending = { id: ++this.seq, kind: 'exchange', ts, address: addr, command: frame, summary: frame.summary, reply: null, replyMs: null, anomalies, shown: false };
      // a POLL is held until we see its reply; everything else shows at once
      if (frame.name !== 'osdp_POLL') this._reveal(this.pending, emitted);
    }
    return emitted;
  }

  _reveal(ev, emitted) {
    if (ev.shown) return;
    this.idleRun = null;
    ev.shown = true; this.events.push(ev); emitted.push(ev);
    if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
  }

  _foldIdle(addr, ts, emitted) {
    if (this.idleRun && this.idleRun.address === addr) {
      this.idleRun.count++; this.idleRun.acks++; this.idleRun.lastTs = ts;
      this.idleRun.summary = `Polled ${this.idleRun.acks} times, all normal`;
      emitted.push(this.idleRun);
    } else {
      this.idleRun = { id: ++this.seq, kind: 'idle', address: addr, startTs: ts, lastTs: ts, count: 1, acks: 1, summary: 'Polled 1 time, all normal' };
      this.events.push(this.idleRun); emitted.push(this.idleRun);
    }
  }

  _flushPending(emitted) {
    if (this.pending && !this.pending.reply) {
      const r = this._reader(this.pending.address);
      this.pending.timedOut = true;
      r.timeouts++;
      this.pending.anomalies.push({ level: this.pending.command.name === 'osdp_POLL' ? 'warn' : 'crit', text: 'No reply' });
      this._reveal(this.pending, emitted);   // a held poll that timed out still gets shown
    }
    this.pending = null;
  }

  _recalcAvg(r) {
    if (!r.replyTimes.length) return;
    const recent = r.replyTimes.slice(-50);
    r.avgReplyMs = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length * 10) / 10;
  }

  _anomalies(ts, frame, r) {
    const out = [];
    if (!frame.checkOk && frame.errors.length) out.push({ level: 'crit', text: frame.errors[0] });
    for (const w of frame.warnings || []) out.push({ level: 'warn', text: w });
    // reply address must match the command
    if (frame.isReply && this.pending && this.pending.address !== frame.address)
      out.push({ level: 'warn', text: `Reply from ${frame.address} but ${this.pending.address} was addressed` });
    // sequence tracking
    if (!frame.isReply) {
      const prev = this.seqByAddr.get(frame.address);
      if (prev != null && frame.sequence === prev && frame.name !== 'osdp_POLL') { r.retries++; out.push({ level: 'info', text: 'Retransmission (same sequence number)' }); }
      else if (prev != null && frame.sequence === 0 && prev !== 0) out.push({ level: 'warn', text: 'Sequence reset to 0 (reader restart or session reset)' });
      this.seqByAddr.set(frame.address, frame.sequence);
    }
    if (frame.name === 'osdp_NAK') out.push({ level: 'warn', text: (frame.hint || 'Command refused') });
    if (frame.name === 'osdp_LSTATR' && frame.decoded && (frame.decoded.tamper || frame.decoded.power))
      out.push({ level: 'crit', text: frame.decoded.tamper ? 'Tamper reported' : 'Power failure reported' });
    return out;
  }

  // rollups for the UI
  health() {
    const now = Date.now();
    return [...this.readers.values()].map(r => ({
      ...r, replyTimes: undefined,
      online: r.lastSeen != null && (now - r.lastSeen) < OFFLINE_MS && r.replies > 0,
      lastSeenAgoMs: r.lastSeen ? now - r.lastSeen : null,
    })).sort((a, b) => a.address - b.address);
  }

  stats() {
    let cmds = 0, replies = 0, naks = 0, timeouts = 0, crc = 0, cards = 0;
    for (const r of this.readers.values()) { cmds += r.commands; replies += r.replies; naks += r.naks; timeouts += r.timeouts; crc += r.crcErrors; cards += r.cardReads; }
    return { events: this.events.length, readers: this.readers.size, commands: cmds, replies, naks, timeouts, crcErrors: crc, cardReads: cards };
  }
}

module.exports = { OsdpAnalyzer, REPLY_DEADLINE_MS, SLOW_REPLY_MS, OFFLINE_MS };
