// analytics/aspsdk.js — decoder for the ASP SDK trace (aspsdk_*.log).
//
// The Cloud Connector talks to the ASP controller firmware through the ASP SDK
// (sdk_Execute = Command, Reply, sdk_GetEvents = Event). With trace logging on,
// every frame is written as hex:  "<time> <trace> [ip] S|R|E: xx xx ..."
//
// No wire spec was available, so the layout below was inferred from traffic and
// cross-checked against CloudConnector log lines at the same instants. Every name
// carries a confidence: 'high' (structure proven by the data), 'medium' (strong
// timing correlation), 'low' (guess). Unknown codes decode to their raw hex.
//
// Frame header (16 bytes, little-endian):
//   [0:4]  sequence  — 0 on host Commands; controller counter on Replies/Events
//   [4:8]  channel   — 1 for Command/Reply, 0 for Events
//   [8]    group     [9] command   (a Reply is command+1, or 08/00 generic ack)
//   [10]   protocol  — always 0x14 in observed traffic
//   [11]   flags     — 0x21 on queued events, else 0
//   [12:16] total frame length
// Event body (frame bytes 16..): 0xFFFFFFFF, then 1..n records, each:
//   [0:4] record length (incl. this field)  [4:8] event serial (u32)
//   [8:12] controller time, epoch seconds UTC  [12] 0x01  [13] category  [14] subtype
//   [20] address type (0x02 reader, 0x03 access point)  [21..23] panel-board-point
//   [24..] event data (raw)
// The controller numbers every event, including classes this host is not subscribed
// to, so serial skips are normal; a rewind means events are being replayed. The
// host acks the LAST serial of each frame with Command 07/05.
'use strict';

const DIR = { S: 'Command', R: 'Reply', E: 'Event' };

// group/command → [name, confidence]
const CMD = {
  '0101': ['Session hello (carries controller hostname)', 'high'],
  '0102': ['Session query', 'low'], '0103': ['Session query reply', 'low'],
  '0106': ['Controller parameters', 'low'],
  '0108': ['Controller configuration', 'low'],
  '010f': ['Controller sync begin', 'medium'], '0110': ['Controller sync begin reply', 'medium'],
  '0120': ['Controller info request', 'low'], '0121': ['Controller info reply', 'low'],
  '0201': ['Configure input points', 'medium'],
  '0203': ['Configure reader', 'medium'],
  '0205': ['Configure reader mode', 'low'],
  '0208': ['Configuration query', 'low'],
  '020d': ['Configuration sync status', 'low'], '020e': ['Configuration sync status reply', 'low'],
  '0215': ['Configure door control mode', 'low'],
  '0216': ['Configure door parameters', 'low'],
  '0301': ['Configure access point / door', 'medium'],
  '0305': ['Schedule configuration', 'low'],
  '0306': ['Door / relay command', 'medium'],
  '0308': ['Access profile sync query', 'medium'], '0309': ['Access profile sync reply', 'medium'],
  '030a': ['Access profile sync check', 'medium'], '030b': ['Access profile sync check reply', 'medium'],
  '0404': ['Set controller date/time', 'low'],
  '0408': ['Point status poll', 'medium'], '0409': ['Point status reply', 'medium'],
  '0501': ['Schedule / holiday definition', 'low'],
  '0603': ['Card database definition (sdk_DefineCardDatabase)', 'medium'],
  '0604': ['Card custom/dynamic field definition', 'medium'],
  '0609': ['Card add / modify', 'medium'],
  '0704': ['Event retrieval cursor', 'medium'],
  '0705': ['Event acknowledge', 'high'],
  '0707': ['Event notification', 'high'],
  '0708': ['Event subscription filter', 'medium'],
  '0800': ['Generic reply (ack)', 'high'],
  '0801': ['Controller sync step', 'low'],
};

// event category/subtype → [name, confidence, controllerEventTypes[]]
const EVT = {
  '0607': ['Access point state changed (open/closed/unlock/relock)', 'high', ['open', 'closed', 'unlocked', 'locked']],
  '0609': ['REX changed (activated/deactivated)', 'high', ['rexactivated', 'rexdeactivated']],
  '0602': ['Door held open too long', 'high', ['dooropentoolong']],
  '0601': ['Door forced open', 'high', ['doorforcedopen']],
  '0605': ['Door opened on valid unlock', 'medium', ['open', 'unlocked']],
  '0606': ['Door closed / held-open cleared', 'medium', ['closed', 'doorheldcleared']],
  '0600': ['Door relocked', 'medium', ['locked']],
  '0604': ['Door held-open warning cleared', 'low', ['doorheldcleared']],
  '0400': ['Access granted', 'high', ['accessgranted']],
  '0303': ['Access denied — invalid PIN', 'high', ['accessdenied_invalidpin']],
  '0a01': ['Strike/relay energized (unlock)', 'medium', ['unlocked']],
  '0a02': ['Strike/relay released (lock)', 'medium', ['locked']],
  '0d00': ['Output / schedule state change', 'low', []],
  '0800': ['Daily rollover / timer', 'low', []],
  '0100': ['Controller startup report', 'low', []],
  '0101': ['Controller status report', 'low', []],
};

const LINE = /^(\w{3} \d\d \d\d:\d\d:\d\d(?:\.\d+)?) <(\w+)> (?:\[([^\]]+)\] )?(?:([SRE]): ((?:[0-9A-Fa-f]{2} ?)+)|(.*))$/;

function u32(b, o) { return b.length >= o + 4 ? b.readUInt32LE(o) : null; }

/** Decode one frame buffer. */
function decodeFrame(dir, buf) {
  const f = { dir, dirName: DIR[dir] || dir, len: buf.length, ok: buf.length >= 16 };
  if (!f.ok) return f;
  f.seq = u32(buf, 0); f.channel = u32(buf, 4);
  f.group = buf[8]; f.cmd = buf[9]; f.proto = buf[10]; f.flags = buf[11];
  f.declaredLen = u32(buf, 12);
  f.lenOk = f.declaredLen === buf.length;
  f.code = buf.subarray(8, 10).toString('hex');
  const c = CMD[f.code];
  f.name = c ? c[0] : `Unknown ${f.code.slice(0, 2)}/${f.code.slice(2)}`;
  f.conf = c ? c[1] : 'unknown';
  if (dir === 'R' && f.code === '0800' && buf.length >= 24) {
    f.ackOf = buf.subarray(22, 24).toString('hex');       // generic ack echoes the command it answers
  }
  if (dir === 'E' && buf.length >= 35) {
    // One frame carries 1..n event records: [len u32][serial u32][epoch u32][01][cat][sub][00][4 × 00][addr 4]...
    f.events = [];
    let o = 20;
    while (o + 16 <= buf.length) {
      const rl = u32(buf, o);
      if (!rl || rl < 16 || o + rl > buf.length) break;
      const rec = buf.subarray(o, o + rl);
      const code = Buffer.from([rec[13], rec[14]]).toString('hex');
      const e = EVT[code];
      const at = rec[20], a1 = rec[21], a2 = rec[22], a3 = rec[23];
      const point = at === 0x03 ? `AccessPoint${a1}-${a2}-${a3}` : at === 0x02 ? `reader${a1}-${a2}-${a3}` : (rl >= 24 && at ? `type${at.toString(16)}:${a1}-${a2}-${a3}` : '');
      f.events.push({
        serial: u32(rec, 4), ctrlTime: u32(rec, 8) * 1000, code,
        name: e ? e[0] : `Unknown event ${code.slice(0, 2)}/${code.slice(2)}`, conf: e ? e[1] : 'unknown', types: e ? e[2] : [],
        point, data: rec.subarray(24).toString('hex'),
      });
      o += rl;
    }
    const first = f.events[0], last = f.events[f.events.length - 1];
    if (first) {
      f.serial = first.serial; f.lastSerial = last.serial; f.ctrlTime = first.ctrlTime;
      f.evCode = first.code; f.evName = f.events.length > 1 ? `${first.name} (+${f.events.length - 1} more)` : first.name;
      f.evConf = first.conf; f.evTypes = first.types; f.point = first.point;
    }
  }
  if (dir === 'S' && f.code === '0705' && buf.length >= 28) f.ackSerial = u32(buf, 24);
  if (dir === 'S' && f.code === '0101') {
    const s = buf.subarray(24).toString('latin1').replace(/\0.*$/s, '');
    if (/^[\x20-\x7e]{3,}$/.test(s)) f.hostname = s;
  }
  return f;
}

/**
 * Parse an aspsdk log file's text.
 * @returns {{frames:object[], notes:object[]}} frames have t (epoch ms) and decoded fields
 */
function parseText(text, file, opts) {
  const { parseSyslog } = require('./time');
  const m = /(\d{4})-(\d\d)-\d\d/.exec(file);
  const year = m ? +m[1] : new Date().getFullYear();
  const month = m ? +m[2] : 0;
  const frames = [], notes = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const x = LINE.exec(l);
    if (!x) continue;
    const t = parseSyslog(x[1], year, month, opts.tz);
    if (x[4]) {
      const buf = Buffer.from(x[5].replace(/\s+/g, ''), 'hex');
      const f = decodeFrame(x[4], buf);
      f.t = t; f.peer = x[3] || ''; f.file = file; f.line = i + 1; f.hex = x[5].trim();
      frames.push(f);
    } else {
      notes.push({ t, level: x[2], peer: x[3] || '', msg: (x[6] || '').trim(), file, line: i + 1 });
    }
  }
  return { frames, notes };
}

/** Is reply r an answer to command c? (generic ack echoes the code; specific reply is cmd+1) */
function answers(r, c) {
  if (r.code === '0800') return !r.ackOf || r.ackOf === c.code;
  return r.group === c.group && r.cmd === ((c.cmd + 1) & 0xff);
}

/** Pair commands with replies. Commands are pipelined; replies come back in order. */
function pairCommands(frames, timeoutMs = 5000) {
  const out = { pairs: [], unanswered: [], orphanReplies: 0 };
  const pending = new Map();      // peer → [command frames]
  const flushStale = (peer, now) => {
    const q = pending.get(peer) || [];
    while (q.length && now - q[0].t > 60000) out.unanswered.push({ cmd: q.shift(), reason: 'no reply within 60 s' });
  };
  for (const f of frames) {
    if (f.dir === 'S') {
      flushStale(f.peer, f.t);
      if (!pending.has(f.peer)) pending.set(f.peer, []);
      pending.get(f.peer).push(f);
    } else if (f.dir === 'R') {
      const q = pending.get(f.peer) || [];
      const i = q.findIndex(c => answers(f, c));
      if (i < 0) { out.orphanReplies++; continue; }
      const c = q.splice(i, 1)[0];
      const lat = f.t - c.t;
      if (lat > timeoutMs) out.unanswered.push({ cmd: c, reason: `reply after ${lat} ms` });
      out.pairs.push({ cmd: c, rpl: f, latency: lat });
    } else if (f.dir === '' || f.reconnect) {
      pending.delete(f.peer);
    }
  }
  for (const q of pending.values()) for (const c of q) out.unanswered.push({ cmd: c, reason: 'no reply before end of trace' });
  return out;
}

module.exports = { parseText, decodeFrame, pairCommands, CMD, EVT };
