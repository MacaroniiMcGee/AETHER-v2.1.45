// trace/mqtt5.js — the smallest MQTT 5 client that can do what the OnCAFE web app does:   AETHER_TRACE
// connect over a WebSocket (sub-protocol "mqtt") with username + password, subscribe at QoS 0,
// receive PUBLISH packets, keep the link alive. No new npm dependency (uses `ws`, already installed).
//
//   const c = new Mqtt5({ url, username, password, clientId, origin });
//   c.on('message', ({ topic, payload, at }) => …)   payload is a Buffer, at = Pi epoch ms when received
//   c.on('state', s => …)                            connecting | connected | closed
//   await c.connect(); await c.subscribe(['d/rt-events/<id>', …]); c.close();
'use strict';

const { EventEmitter } = require('events');

let WS = null;
try { WS = require('ws'); } catch { WS = null; }

// ── encoding helpers ───────────────────────────────────────────────────────
function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function readVarint(buf, i) {
  let mul = 1, val = 0, b, n = 0;
  do {
    if (i >= buf.length) return null;
    b = buf[i++]; val += (b & 127) * mul; mul *= 128;
    if (++n > 4) throw new Error('bad MQTT length');
  } while (b & 128);
  return { val, next: i };
}
const str = s => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const packet = (first, body) => Buffer.concat([Buffer.from([first]), varint(body.length), body]);

function connectPacket({ clientId, username, password, keepalive, clean = true }) {
  let flags = clean ? 0x02 : 0;
  if (username != null) flags |= 0x80;
  if (password != null) flags |= 0x40;
  const ka = Buffer.alloc(2); ka.writeUInt16BE(keepalive);
  const vh = Buffer.concat([str('MQTT'), Buffer.from([5, flags]), ka, varint(0)]);
  const parts = [vh, str(clientId)];
  if (username != null) parts.push(str(username));
  if (password != null) parts.push(str(password));
  return packet(0x10, Buffer.concat(parts));
}
function subscribePacket(id, topics) {
  const pid = Buffer.alloc(2); pid.writeUInt16BE(id);
  const body = [pid, varint(0)];
  for (const t of topics) body.push(str(t), Buffer.from([0]));   // QoS 0, no-local off, retain-as-published off
  return packet(0x82, Buffer.concat(body));
}

/** Read MQTT 5 properties; returns { props, next }. Only the ones a client receiving PUBLISH/CONNACK needs. */
function readProps(buf, i) {
  const len = readVarint(buf, i);
  if (!len) return null;
  const end = len.next + len.val;
  const props = {};
  let p = len.next;
  try {
    while (p < end) {
      const id = buf[p++];
      switch (id) {
        case 0x01: case 0x17: case 0x19: case 0x24: case 0x25: case 0x28: case 0x29: case 0x2A: props[id] = buf[p++]; break;
        case 0x13: case 0x21: case 0x22: case 0x23: props[id] = buf.readUInt16BE(p); p += 2; break;
        case 0x02: case 0x11: case 0x18: case 0x27: props[id] = buf.readUInt32BE(p); p += 4; break;
        case 0x0B: { const v = readVarint(buf, p); props[id] = v.val; p = v.next; break; }
        case 0x03: case 0x08: case 0x12: case 0x15: case 0x1A: case 0x1C: case 0x1F: {
          const l = buf.readUInt16BE(p); props[id] = buf.toString('utf8', p + 2, p + 2 + l); p += 2 + l; break;
        }
        case 0x09: case 0x16: { const l = buf.readUInt16BE(p); props[id] = buf.subarray(p + 2, p + 2 + l); p += 2 + l; break; }
        case 0x26: {
          const l1 = buf.readUInt16BE(p); const k = buf.toString('utf8', p + 2, p + 2 + l1); p += 2 + l1;
          const l2 = buf.readUInt16BE(p); const v = buf.toString('utf8', p + 2, p + 2 + l2); p += 2 + l2;
          (props.user = props.user || []).push([k, v]); break;
        }
        default: p = end;   // unknown: skip the rest
      }
    }
  } catch { /* malformed properties: ignore them */ }
  return { props, next: end };
}

const CONNACK_REASONS = {
  0x80: 'unspecified error', 0x81: 'malformed packet', 0x84: 'unsupported protocol version', 0x85: 'client id not valid',
  0x86: 'bad username or password', 0x87: 'not authorized', 0x88: 'server unavailable', 0x89: 'server busy', 0x8A: 'banned',
  0x8C: 'bad authentication method', 0x95: 'packet too large', 0x9F: 'connection rate exceeded',
};

class Mqtt5 extends EventEmitter {
  constructor(o) {
    super();
    this.o = { keepalive: 60, connectTimeoutMs: 15000, ...o };
    this.ws = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();   // packet id -> {resolve, reject}
    this.aliases = new Map();
    this.state = 'closed';
    this.stats = { received: 0, bytes: 0, connectedAt: null, lastMessageAt: null };
    this._ping = null;
  }
  _set(s, why) { this.state = s; this.emit('state', s, why); }

  connect() {
    if (!WS) return Promise.reject(new Error('The "ws" package is missing from backend/node_modules'));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(this); };
      const timer = setTimeout(() => { finish(new Error('MQTT connect timed out')); this.close(); }, this.o.connectTimeoutMs);
      this._set('connecting');
      const ws = new WS(this.o.url, ['mqtt'], { headers: this.o.origin ? { Origin: this.o.origin } : {}, handshakeTimeout: this.o.connectTimeoutMs, perMessageDeflate: true });
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      ws.on('open', () => ws.send(connectPacket({ clientId: this.o.clientId, username: this.o.username, password: this.o.password, keepalive: this.o.keepalive })));
      ws.on('message', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.stats.bytes += chunk.length;
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        try { this._drain(finish); } catch (e) { this.emit('error', e); }
      });
      ws.on('error', (e) => { this.emit('error', e); finish(e); });
      ws.on('unexpected-response', (_req, res) => finish(new Error(`MQTT WebSocket refused: HTTP ${res.statusCode}`)));
      ws.on('close', (code, reason) => {
        clearInterval(this._ping); this._ping = null;
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        const why = `closed (${code}${reason && reason.length ? ' ' + reason.toString() : ''})`;
        this._set('closed', why);
        finish(new Error('MQTT ' + why));
      });
    });
  }

  _drain(onConnack) {
    for (;;) {
      if (this.buf.length < 2) return;
      const len = readVarint(this.buf, 1);
      if (!len) return;
      const total = len.next + len.val;
      if (this.buf.length < total) return;
      const first = this.buf[0];
      const body = this.buf.subarray(len.next, total);
      this.buf = this.buf.subarray(total);
      this._packet(first, body, onConnack);
    }
  }

  _packet(first, body, onConnack) {
    const type = first >> 4;
    if (type === 2) {           // CONNACK
      const reason = body[1];
      if (reason !== 0) { onConnack(new Error(`MQTT broker refused the connection: ${CONNACK_REASONS[reason] || '0x' + reason.toString(16)}`)); this.close(); return; }
      const pr = readProps(body, 2);
      this.connack = pr ? pr.props : {};
      const ka = this.connack[0x13] || this.o.keepalive;   // server keep-alive overrides ours
      this._ping = setInterval(() => this._send(Buffer.from([0xC0, 0])), Math.max(5, ka * 0.75) * 1000);
      if (this._ping.unref) this._ping.unref();
      this.stats.connectedAt = Date.now();
      this._set('connected');
      onConnack(null);
    } else if (type === 3) {    // PUBLISH
      const at = Date.now();
      const qos = (first >> 1) & 3;
      const tl = body.readUInt16BE(0);
      let topic = body.toString('utf8', 2, 2 + tl);
      let i = 2 + tl, pid = null;
      if (qos > 0) { pid = body.readUInt16BE(i); i += 2; }
      const pr = readProps(body, i) || { props: {}, next: i };
      const alias = pr.props[0x23];
      if (alias) { if (topic) this.aliases.set(alias, topic); else topic = this.aliases.get(alias) || ''; }
      const payload = body.subarray(pr.next);
      if (qos === 1 && pid != null) { const b = Buffer.alloc(2); b.writeUInt16BE(pid); this._send(packet(0x40, b)); }
      if (qos === 2 && pid != null) { const b = Buffer.alloc(2); b.writeUInt16BE(pid); this._send(packet(0x50, b)); }
      this.stats.received++; this.stats.lastMessageAt = at;
      this.emit('message', { topic, payload: Buffer.from(payload), at, retain: !!(first & 1), props: pr.props });
    } else if (type === 6) {    // PUBREL (QoS 2) -> PUBCOMP
      this._send(packet(0x70, body.subarray(0, 2)));
    } else if (type === 9) {    // SUBACK
      const id = body.readUInt16BE(0);
      const pr = readProps(body, 2) || { next: 3 };
      const codes = [...body.subarray(pr.next)];
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.resolve(codes); }
    } else if (type === 14) {   // DISCONNECT from server
      const reason = body.length ? body[0] : 0;
      this.emit('error', new Error(`MQTT broker disconnected us (reason 0x${reason.toString(16)})`));
    }
    // PINGRESP (13) and anything else: nothing to do
  }

  _send(b) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(b); } catch { /* */ } }

  /** Subscribe at QoS 0. Resolves to [{topic, ok, code}]. Sends in batches the broker accepts. */
  async subscribe(topics) {
    const out = [];
    for (let i = 0; i < topics.length; i += 16) {
      const batch = topics.slice(i, i + 16);
      const id = this.nextId++; if (this.nextId > 65535) this.nextId = 1;
      const codes = await new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.pending.delete(id); reject(new Error('MQTT subscribe timed out')); }, 10000);
        this.pending.set(id, { resolve: c => { clearTimeout(t); resolve(c); }, reject: e => { clearTimeout(t); reject(e); } });
        this._send(subscribePacket(id, batch));
      });
      batch.forEach((topic, k) => out.push({ topic, ok: codes[k] !== undefined && codes[k] < 0x80, code: codes[k] }));
    }
    return out;
  }

  close() {
    clearInterval(this._ping); this._ping = null;
    if (!this.ws) return;
    try { if (this.ws.readyState === 1) this.ws.send(Buffer.from([0xE0, 0])); } catch { /* */ }
    try { this.ws.close(); } catch { /* */ }
    try { this.ws.terminate && setTimeout(() => { try { this.ws && this.ws.terminate(); } catch { /* */ } }, 1500).unref(); } catch { /* */ }
  }
}

/** Decode one MQTT packet from a captured WebSocket/TCP payload (used for HAR import). */
function decodePublishes(buf) {
  const out = [];
  let b = Buffer.from(buf);
  const aliases = new Map();
  while (b.length >= 2) {
    const len = readVarint(b, 1);
    if (!len) break;
    const total = len.next + len.val;
    if (b.length < total) break;
    const first = b[0];
    const body = b.subarray(len.next, total);
    b = b.subarray(total);
    if ((first >> 4) !== 3) { out.push({ type: first >> 4 }); continue; }
    const qos = (first >> 1) & 3;
    const tl = body.readUInt16BE(0);
    let topic = body.toString('utf8', 2, 2 + tl);
    let i = 2 + tl;
    if (qos > 0) i += 2;
    const pr = readProps(body, i) || { props: {}, next: i };
    const alias = pr.props[0x23];
    if (alias) { if (topic) aliases.set(alias, topic); else topic = aliases.get(alias) || ''; }
    out.push({ type: 3, topic, payload: Buffer.from(body.subarray(pr.next)) });
  }
  return out;
}

module.exports = { Mqtt5, decodePublishes, _internal: { varint, readVarint, connectPacket, subscribePacket, readProps, packet, str } };
