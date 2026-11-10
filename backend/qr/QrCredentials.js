// backend/qr/QrCredentials.js — QR credential testing for OSDP readers (AETHER_QR_CREDENTIALS)
//
// Two ways a QR reader's scans reach Aether, both OSDP:
//   aether : the reader is wired to an RS-485 adapter on the Pi and Aether polls
//            it as the controller (the existing reader enroller does the polling).
//   listen : the reader stays wired to the panel; a second adapter listens on the
//            same pair and never transmits.
// Every scan is decoded (text or card bits), checked against an armed test code
// (reader qualification), and, if it is a rotating badge code, verified. With
// the bridge on, a verified badge from an Aether-polled reader is presented to
// the panel through Aether's OSDP reader emulation as an ordinary card.
'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tok = require('./qrToken');

const MAX_EVENTS = 300;
const MAX_RESULTS = 1000;

const DEFAULT_SETTINGS = {
  windowSec: 15,           // a new code on the phone every 15 s
  skewWindows: 1,          // also accept the window before/after (clock drift, slow scan)
  oneUse: true,            // a code is accepted once; replaying it is refused
  feedback: true,          // green/red LED + beep on an Aether-polled reader
  bridge: { enabled: false, outputReaderId: '' },
};

const DEFAULT_TESTS = [
  { label: 'Card number, plain digits', content: '45678', expect: { kind: 'number', value: '45678' } },
  { label: 'FC 123 / card 45678 as text', content: '123:45678', expect: { kind: 'number', value: '123:45678' } },
  { label: 'Plain text, 16 characters', content: 'AETHER-TEST-0001', expect: { kind: 'text', value: 'AETHER-TEST-0001' } },
  { label: 'Long text, 120 characters', content: 'AETHER-LONG-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3).slice(0, 108), expect: { kind: 'text', value: 'AETHER-LONG-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3).slice(0, 108) } },
];

const clean = s => String(s == null ? '' : s).trim();
const rid = () => crypto.randomBytes(4).toString('hex');

class QrCredentials extends EventEmitter {
  constructor({ file, formatService = null, getOsdpManager = () => null, now = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.formatService = formatService;
    this.getOsdpManager = getOsdpManager;
    this.now = now;
    this.events = []; this.seq = 0;
    this.armed = null;                 // { testId, until }
    this.poller = null;                // hook for LED/buzzer feedback: (cmd, data) => void
    this.pollerPort = () => null;
    this._load();
  }

  // ── persistence ─────────────────────────────────────────────────────────────
  _load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    d = d && typeof d === 'object' ? d : {};
    this.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}), bridge: { ...DEFAULT_SETTINGS.bridge, ...((d.settings || {}).bridge || {}) } };
    this.badges = Array.isArray(d.badges) ? d.badges : [];
    this.tests = Array.isArray(d.tests) ? d.tests : DEFAULT_TESTS.map(t => ({ id: rid(), ...t }));
    this.results = Array.isArray(d.results) ? d.results : [];
    if (!Array.isArray(d.tests)) this._save();
  }

  _save() {
    const body = JSON.stringify({ version: 1, settings: this.settings, badges: this.badges, tests: this.tests, results: this.results.slice(-MAX_RESULTS) }, null, 1);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn('[QR] Could not save', this.file, e.message); }
  }

  // ── settings ───────────────────────────────────────────────────────────────
  setSettings(p = {}) {
    const s = this.settings;
    if (p.windowSec != null) { const v = Number(p.windowSec); if (!(v >= 5 && v <= 300)) throw new Error('Code lifetime must be 5–300 seconds.'); s.windowSec = Math.round(v); }
    if (p.skewWindows != null) { const v = Number(p.skewWindows); if (!(v >= 0 && v <= 4)) throw new Error('Allowed drift must be 0–4 windows.'); s.skewWindows = Math.round(v); }
    if (p.oneUse != null) s.oneUse = !!p.oneUse;
    if (p.feedback != null) s.feedback = !!p.feedback;
    if (p.bridge) {
      if (p.bridge.enabled != null) s.bridge.enabled = !!p.bridge.enabled;
      if (p.bridge.outputReaderId != null) s.bridge.outputReaderId = clean(p.bridge.outputReaderId);
    }
    this._save();
    return s;
  }

  // ── formats / output readers ───────────────────────────────────────────────
  formats() {
    try {
      return (this.formatService ? this.formatService.getAllFormats() : [])
        .map(f => ({ id: f.id, name: f.name, bits: f.bits, maxFacility: f.maxFacility, maxCard: f.maxCard, hasFacility: (f.facilityBits || 0) > 0 || f.maxFacility > 0 }));
    } catch { return []; }
  }
  _format(id) { return this.formats().find(f => f.id === id) || null; }

  outputReaders() {
    const m = this.getOsdpManager();
    if (!m || typeof m.getReaders !== 'function') return [];
    try { return m.getReaders().map(r => ({ id: r.id, name: r.name, address: r.address, serialPort: r.serialPort, enabled: r.enabled !== false })); } catch { return []; }
  }

  // ── badges ─────────────────────────────────────────────────────────────────
  publicBadge(b) {
    const { secret, enrollCode, ...rest } = b;
    return { ...rest, enrollPending: !!enrollCode, enrollCode: enrollCode || null, state: this._badgeState(b) };
  }
  _badgeState(b) { return b.revoked ? 'revoked' : (b.expiresAt && b.expiresAt < this.now() ? 'expired' : 'active'); }

  issueBadge({ name, dept, fc, card, format, days } = {}) {
    name = clean(name); dept = clean(dept);
    if (!name) throw new Error('Enter a name for the badge.');
    const f = this._format(clean(format) || 'w26');
    if (!f) throw new Error(`Unknown card format "${format}".`);
    const fcN = Number(fc || 0), cardN = Number(card);
    if (!Number.isInteger(fcN) || fcN < 0 || (f.maxFacility != null && fcN > f.maxFacility)) throw new Error(`Facility code must be 0–${f.maxFacility} for ${f.name}.`);
    if (!Number.isInteger(cardN) || cardN < 0 || (f.maxCard != null && cardN > f.maxCard)) throw new Error(`Card number must be 0–${f.maxCard} for ${f.name}.`);
    if (this.badges.some(b => !b.revoked && b.format === f.id && b.fc === fcN && b.card === cardN)) throw new Error(`Another active badge already uses ${f.name} FC ${fcN} card ${cardN}.`);
    const d = Number(days || 365);
    if (!(d >= 1 && d <= 3650)) throw new Error('Validity must be 1–3650 days.');
    let id; do { id = crypto.randomBytes(4).readUInt32BE(0) || 1; } while (this.badges.some(b => b.id === id));
    const b = {
      id, name, dept, fc: fcN, card: cardN, format: f.id, formatName: f.name,
      secret: crypto.randomBytes(32).toString('hex'),
      enrollCode: crypto.randomBytes(9).toString('base64url'),
      createdAt: this.now(), expiresAt: this.now() + d * 86400000, revoked: false, enrolledAt: null, lastWindow: -1,
    };
    this.badges.push(b); this._save();
    return this.publicBadge(b);
  }

  _badge(id) { const b = this.badges.find(x => String(x.id) === String(id)); if (!b) { const e = new Error('No such badge.'); e.status = 404; throw e; } return b; }
  revoke(id, yes = true) { const b = this._badge(id); b.revoked = !!yes; this._save(); return this.publicBadge(b); }
  remove(id) { const b = this._badge(id); this.badges = this.badges.filter(x => x !== b); this._save(); return { removed: true }; }
  // New secret + new enrollment link; the phone that had the old one stops working.
  relink(id) { const b = this._badge(id); b.secret = crypto.randomBytes(32).toString('hex'); b.enrollCode = crypto.randomBytes(9).toString('base64url'); b.enrolledAt = null; b.lastWindow = -1; this._save(); return this.publicBadge(b); }

  // One-time: the phone fetches its secret once; the link stops working after that.
  claimEnrollment(code) {
    const b = this.badges.find(x => x.enrollCode && x.enrollCode === clean(code));
    if (!b) { const e = new Error('This badge link was already used or replaced. Ask for a new link from Tools › QR Credentials.'); e.status = 410; throw e; }
    if (b.revoked) { const e = new Error('This badge has been revoked.'); e.status = 410; throw e; }
    b.enrollCode = null; b.enrolledAt = this.now(); this._save();
    return { id: b.id, name: b.name, dept: b.dept, secret: b.secret, windowSec: this.settings.windowSec, fc: b.fc, card: b.card, formatName: b.formatName, expiresAt: b.expiresAt, serverTime: this.now() };
  }

  // Current code for a badge, so a tester can scan from the Aether screen without a phone.
  currentCode(id) {
    const b = this._badge(id);
    const win = tok.windowOf(this.settings.windowSec, this.now());
    const left = this.settings.windowSec - Math.floor((this.now() / 1000) % this.settings.windowSec);
    return { token: tok.makeToken(b.id, b.secret, win), window: win, secondsLeft: left, windowSec: this.settings.windowSec };
  }

  // ── verification ───────────────────────────────────────────────────────────
  verifyText(text, { consume = true } = {}) {
    const checks = [];
    const add = (label, pass, detail) => { checks.push({ label, pass, detail }); return pass; };
    const p = tok.parseToken(text);
    if (!add('Badge code found', !!p, p ? 'AQ1 rotating code' : 'Not a badge code')) return { ok: false, checks, badge: null };
    const b = this.badges.find(x => x.id === p.id);
    if (!add('Issued by this Aether', !!b, b ? `${b.name} (#${b.id})` : `Badge #${p.id} is not in this Aether's list`)) return { ok: false, checks, badge: null };
    const okMac = tok.tagOk(b.secret, p);
    add('Code signature', okMac, okMac ? 'Matches the badge secret' : 'Does not match: made by another phone, edited, or the badge was re-linked');
    add('Not revoked', !b.revoked, b.revoked ? 'Badge is revoked' : 'Active');
    const exp = b.expiresAt && b.expiresAt < this.now();
    add('Not expired', !exp, `Valid until ${new Date(b.expiresAt).toISOString().slice(0, 10)}`);
    const nowWin = tok.windowOf(this.settings.windowSec, this.now());
    const age = Math.round(this.now() / 1000 - p.win * this.settings.windowSec);
    const drift = nowWin - p.win;
    const fresh = Math.abs(drift) <= this.settings.skewWindows;
    const limit = (this.settings.skewWindows + 1) * this.settings.windowSec;
    add('Fresh code', fresh, fresh ? `Made ${Math.max(0, age)} s ago (limit about ${limit} s)` : drift > 0 ? `Made ${age} s ago: a screenshot or photo` : `Made in the future: check the phone's clock`);
    if (this.settings.oneUse) {
      const unused = p.win > (b.lastWindow ?? -1);
      add('Not used before', unused, unused ? 'First use of this code' : 'This code (or a newer one) was already accepted; wait for the next code');
    }
    const ok = checks.every(c => c.pass);
    if (ok && consume) { b.lastWindow = p.win; b.lastUsedAt = this.now(); this._save(); }
    return { ok, checks, badge: { id: b.id, name: b.name, dept: b.dept, fc: b.fc, card: b.card, format: b.format, formatName: b.formatName } };
  }

  // ── decoding a scan ────────────────────────────────────────────────────────
  static bitsToText(binary) {
    if (!binary || binary.length % 8 || binary.length < 16) return null;
    const bytes = [];
    for (let i = 0; i < binary.length; i += 8) bytes.push(parseInt(binary.slice(i, i + 8), 2));
    let end = bytes.length; while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x0D || bytes[end - 1] === 0x0A)) end--;
    const body = bytes.slice(0, end);
    if (body.length < 2 || !body.every(b => b >= 0x20 && b <= 0x7E)) return null;
    return String.fromCharCode(...body);
  }

  _decodeBits(binary) {
    let wieg = null;
    try {
      const m = this.formatService && this.formatService.getFormatByBits(binary.length);
      const { decodeBits } = require('../lib/credentialMap');
      if (m && m.map && decodeBits) wieg = decodeBits(m.map, binary);
      if (wieg && m) wieg.formatName = m.name;
    } catch { /* unknown length */ }
    return wieg;
  }

  decode(read) {
    const out = { source: read.source, address: read.address ?? null, osdpFormat: read.osdpFormat ?? null };
    if (read.text != null) return { ...out, kind: 'text', text: String(read.text).replace(/[\r\n]+$/, ''), via: 'osdp_FMT' };
    const binary = String(read.binary || '');
    out.bitCount = binary.length; out.binary = binary;
    out.hex = binary.length ? BigInt('0b' + binary).toString(16).toUpperCase() : '';
    const text = QrCredentials.bitsToText(binary);
    if (text != null) return { ...out, kind: 'text', text, via: 'osdp_RAW' };
    const w = read.wieg || this._decodeBits(binary);
    return {
      ...out, kind: 'bits', via: 'osdp_RAW',
      facility: w && w.facility != null ? Number(w.facility) : null,
      card: w && w.card != null ? String(w.card) : null,
      parityOk: w ? w.parityOk ?? null : null,
      formatName: w && w.formatName ? w.formatName : null,
      value: binary.length ? BigInt('0b' + binary).toString() : '',
      valueNoParity: binary.length > 2 ? BigInt('0b' + binary.slice(1, -1)).toString() : '',
    };
  }

  // Candidates a "number" expectation can match, with what each one is.
  static numberCandidates(d) {
    if (d.kind === 'text') {
      const t = d.text.trim(); const c = [{ v: t, how: 'text' }];
      const m = /^(\d+)\s*[:,/ ]\s*(\d+)$/.exec(t);
      if (m) c.push({ v: `${Number(m[1])}:${Number(m[2])}`, how: 'FC:card in text' });
      if (/^\d+$/.test(t)) c.push({ v: String(BigInt(t)), how: 'number in text' });
      return c;
    }
    const c = [];
    if (d.card != null) c.push({ v: String(BigInt(d.card)), how: 'card number' });
    if (d.card != null && d.facility != null) c.push({ v: `${d.facility}:${BigInt(d.card)}`, how: 'FC:card' });
    if (d.valueNoParity) c.push({ v: d.valueNoParity, how: 'bits without parity' });
    if (d.value) c.push({ v: d.value, how: 'all bits' });
    return c;
  }

  static normalizeExpected(v) {
    const t = clean(v); const m = /^(\d+)\s*[:,/ ]\s*(\d+)$/.exec(t);
    if (m) return `${Number(m[1])}:${BigInt(m[2])}`;
    return /^\d+$/.test(t) ? String(BigInt(t)) : t;
  }

  // ── reader qualification tests ─────────────────────────────────────────────
  addTest({ label, content, expect } = {}) {
    content = String(content == null ? '' : content);
    if (!content.trim()) throw new Error('Enter what the QR code should contain.');
    if (content.length > 1000) throw new Error('Keep test codes under 1000 characters.');
    const kind = expect && ['text', 'number', 'any'].includes(expect.kind) ? expect.kind : 'text';
    const value = kind === 'any' ? '' : clean(expect && expect.value != null ? expect.value : content);
    const t = { id: rid(), label: clean(label) || content.slice(0, 40), content, expect: { kind, value } };
    this.tests.push(t); this._save(); return t;
  }
  removeTest(id) { this.tests = this.tests.filter(t => t.id !== id); if (this.armed && this.armed.testId === id) this.armed = null; this._save(); return { removed: true }; }

  arm(testId, seconds = 30) {
    if (!testId) { this.armed = null; this.emit('armed', null); return null; }
    if (testId !== 'badge' && !this.tests.some(t => t.id === testId)) throw new Error('No such test code.');
    const s = Math.min(600, Math.max(5, Number(seconds) || 30));
    this.armed = { testId, since: this.now(), until: this.now() + s * 1000 };
    this.emit('armed', this.armed);
    return this.armed;
  }
  armedState() { if (this.armed && this.armed.until < this.now()) this.armed = null; return this.armed; }

  _grade(test, d, verdict) {
    if (test === 'badge') return verdict ? { pass: verdict.ok, why: verdict.ok ? 'Badge verified' : (verdict.checks.find(c => !c.pass) || {}).detail } : { pass: false, why: 'Not a badge code' };
    const e = test.expect;
    if (e.kind === 'any') return { pass: true, why: 'Any read accepted' };
    if (e.kind === 'text') {
      if (d.kind !== 'text') return { pass: false, why: `Reader sent ${d.bitCount}-bit card data, not text` };
      if (d.text === e.value) return { pass: true, why: 'Text matches exactly' };
      if (d.text.trim() === e.value.trim()) return { pass: true, why: 'Text matches (spaces trimmed)' };
      if (e.value.startsWith(d.text)) return { pass: false, why: `Cut short: got ${d.text.length} of ${e.value.length} characters` };
      return { pass: false, why: 'Text differs' };
    }
    const want = QrCredentials.normalizeExpected(e.value);
    const hit = QrCredentials.numberCandidates(d).find(c => c.v === want);
    return hit ? { pass: true, why: `Matches as ${hit.how}` } : { pass: false, why: `Expected ${want}` };
  }

  // ── the pipeline ───────────────────────────────────────────────────────────
  async ingest(read) {
    const d = this.decode(read);
    const ev = { id: ++this.seq, ts: this.now(), ...d, verdict: null, output: null, test: null };
    if (d.kind === 'text' && tok.TOKEN_RE.test(d.text)) {
      ev.verdict = this.verifyText(d.text);
      ev.badge = ev.verdict.badge;
    }
    // Reader qualification: the armed code grades the next read.
    const armed = this.armedState();
    if (armed) {
      const test = armed.testId === 'badge' ? 'badge' : this.tests.find(t => t.id === armed.testId);
      if (test) {
        const g = this._grade(test, d, ev.verdict);
        const shown = d.kind === 'text' ? d.text : (d.card != null ? `${d.bitCount}-bit FC ${d.facility} card ${d.card}` : `${d.bitCount}-bit 0x${d.hex}`);
        ev.test = { id: armed.testId, label: test === 'badge' ? 'Rotating badge' : test.label, pass: g.pass, why: g.why };
        this.results.push({ ts: ev.ts, testId: ev.test.id, label: ev.test.label, pass: g.pass, why: g.why, got: shown, source: d.source, address: d.address, bits: d.bitCount ?? null, via: d.via, msSinceArmed: ev.ts - armed.since });
        if (this.results.length > MAX_RESULTS) this.results.splice(0, this.results.length - MAX_RESULTS);
        this._save();
        // One armed code grades one scan; "Scan again" re-arms it, so stray scans don't count.
        this.armed = null; this.emit('armed', null);
      }
    }
    // Bridge: a verified badge from an Aether-polled reader goes to the panel.
    if (ev.verdict) {
      if (ev.verdict.ok && this.settings.bridge.enabled && d.source === 'aether') ev.output = await this._present(ev.verdict.badge);
      else if (ev.verdict.ok && this.settings.bridge.enabled && d.source !== 'aether') ev.output = { sent: false, why: 'Listen-only scans are never forwarded (the reader already talks to the panel).' };
      if (d.source === 'aether') this._feedback(ev.verdict.ok);
    }
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit('event', ev);
    return ev;
  }

  async _present(badge) {
    const m = this.getOsdpManager();
    const rid0 = this.settings.bridge.outputReaderId;
    if (!m || typeof m.sendCardRead !== 'function') return { sent: false, why: 'OSDP reader emulation is not running.' };
    if (!rid0) return { sent: false, why: 'Pick the emulated reader that should present the card.' };
    const r = this.outputReaders().find(x => String(x.id) === String(rid0));
    if (!r) return { sent: false, why: `Emulated reader "${rid0}" not found.` };
    const qrPort = this.pollerPort();
    if (qrPort && r.serialPort && qrPort === r.serialPort) return { sent: false, why: `The QR reader and ${r.name} share ${qrPort}. Put the QR reader on its own RS-485 adapter.` };
    try {
      await m.sendCardRead(String(r.id), { facility: badge.fc, card: String(badge.card) }, badge.format);
      return { sent: true, reader: r.name, address: r.address, format: badge.formatName, facility: badge.fc, card: badge.card };
    } catch (e) { return { sent: false, why: e.message }; }
  }

  _feedback(ok) {
    if (!this.settings.feedback || typeof this.poller !== 'function') return;
    // osdp_LED (0x69): reader 0, LED 0, temporary: on 300 ms × 1, timer 1.5 s; green or red.
    const color = ok ? 2 : 1;
    const led = Buffer.from([0, 0, 2, 3, 0, color, 0, 15, 0, 0, 0, 0, 0, 0]);
    // osdp_BUZ (0x6A): reader 0, tone 2, on 1 / off 1 (×100 ms), count 1 grant / 3 deny.
    const buz = Buffer.from([0, 2, 1, 1, ok ? 1 : 3]);
    try { this.poller(0x69, led); this.poller(0x6A, buz); } catch { /* best effort */ }
  }

  snapshot(since = 0) {
    return {
      settings: this.settings,
      badges: this.badges.map(b => this.publicBadge(b)),
      tests: this.tests,
      armed: this.armedState(),
      events: this.events.filter(e => e.id > since).slice(-150),
      lastEventId: this.seq,
      results: this.results.slice(-300),
      outputs: this.outputReaders(),
    };
  }

  resultsCsv() {
    const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['time', 'test', 'pass', 'why', 'got', 'source', 'reader address', 'bits', 'via', 'ms since armed']];
    for (const r of this.results) rows.push([new Date(r.ts).toISOString(), r.label, r.pass ? 'PASS' : 'FAIL', r.why, r.got, r.source, r.address, r.bits, r.via, r.msSinceArmed]);
    return rows.map(r => r.map(q).join(',')).join('\n') + '\n';
  }
  clearResults() { this.results = []; this._save(); }
}

module.exports = { QrCredentials, DEFAULT_SETTINGS };
