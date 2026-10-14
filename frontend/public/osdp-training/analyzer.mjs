// AETHER OSDP Academy — conversation coach.
//
// Walks a capture in order and checks it against the behaviour rules in the
// SIA OSDP 2.2.2 reference (spec-data.mjs → behaviors). Every finding names the
// rule it comes from so a learner can open the rule and read why.
//
// Findings are observations about the capture, not diagnoses: an RX-only tap
// can miss commands, and a missing reply can be a capture gap.

import { parse, short, BEHAVIORS, TIMING, CMD, h2, enumText, EN } from './protocol.mjs?v=79db13d7';

// expected-reply-map rule text → { COMMAND: Set(REPLIES) }
const EXPECTED = (() => {
  const map = {};
  const text = BEHAVIORS['expected-reply-map'].rule.split('. ')[0];
  for (const part of text.split(';')) {
    const [l, r] = part.split('->').map((x) => x && x.trim());
    if (!l || !r) continue;
    for (const c of l.split('/')) map[c.trim()] = new Set(r.split('/').map((x) => x.trim()));
  }
  // POLL: poll-responses rule
  map.POLL = new Set(['ACK', 'LSTATR', 'ISTATR', 'OSTATR', 'RSTATR', 'RAW', 'FMT', 'KEYPAD', 'BIOREADR', 'BIOMATCHR', 'MFGREP', 'XRD', 'MFGSTATR', 'MFGERRR']);
  return map;
})();
export const expectedReplies = (cmd) => EXPECTED[cmd] || null;

const DEADLINE = TIMING.REPLY_DELAY_max_ms; // 200
const OFFLINE_MS = TIMING.pdOfflineAfter_s * 1000; // 8000

/** Accepts ms numbers, ISO strings or '' and returns ms or null. */
export function toMs(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * analyze(frames) — frames: [{ fullHex | hex | bytes, ts?, port? }]
 * Returns { tx: [transactions], findings: [...], stats, perAddress }
 */
export function analyze(frames) {
  const findings = [], tx = [];
  const add = (idx, severity, rule, title, text) => findings.push({ idx, severity, rule, title, text });
  const ports = new Map(); // port -> { pending, addr: Map }
  const stats = { frames: frames.length, parsed: 0, bad: 0, commands: 0, replies: 0, polls: 0, acks: 0, naks: 0, busy: 0, timeouts: 0, replyMs: [] };
  const perAddress = new Map();
  const A = (addr) => {
    if (!perAddress.has(addr)) perAddress.set(addr, { address: addr, commands: 0, replies: 0, naks: 0, timeouts: 0, lastSqn: null, retries: 0, lastNak: null, lastCmd: null, sc: 'none', ftDelay: null, ftAt: null, ftNegative: false, lastFtOffset: null, lastTs: null, maxReplyMs: 0 });
    return perAddress.get(addr);
  };
  let sawCommands = false, sawReplies = false, rxOnlyNoted = false;

  frames.forEach((f, idx) => {
    let p;
    try { p = parse(f.fullHex ?? f.hex ?? f.bytes ?? ''); } catch (e) { stats.bad++; add(idx, 'error', 'frame-integrity', 'Not a complete frame', e.message); return; }
    stats.parsed++;
    if (!p.ok || p.issues.length) { stats.bad++; add(idx, 'error', 'frame-integrity', p.ok ? 'Frame structure problem' : 'Integrity check failed', p.issues.join('; ') + (p.ok ? '' : '. A reader answers bad check bytes with NAK 0x01; on a capture, also suspect noise, wrong baud or the capture point.')); }
    for (const w of p.warnings) add(idx, 'warn', /scs15-with-data/.test(w) ? 'scs15-with-data' : /belongs to the/.test(w) ? 'secure-handshake-order' : /BUSY/.test(w) ? 'busy-handling' : /broadcast/.test(w) ? 'broadcast-single-pd' : 'frame-integrity', 'Rule check', w);
    const ts = toMs(f.ts);
    const portKey = f.port || f.portPath || 'bus';
    if (!ports.has(portKey)) ports.set(portKey, { pending: null });
    const port = ports.get(portKey);
    const a = A(p.address);
    if (ts != null && a.lastTs != null && ts - a.lastTs > OFFLINE_MS) add(idx, 'info', 'offline-timeout', 'Long silence', `${((ts - a.lastTs) / 1000).toFixed(1)} s since the last frame for address ${p.address}. After 8 s a reader treats the link as off-line; expect SQN 0 and a new handshake.`);
    if (ts != null) a.lastTs = ts;
    if (!p.ok) {
      // Damaged bytes: keep the turn-taking (something was sent) but do not interpret the content.
      if (p.reply) { if (port.pending) tx.push({ cmdIdx: port.pending.idx, replyIdx: idx, address: port.pending.p.address, ms: null, timedOut: false, damaged: true }); port.pending = null; sawReplies = true; stats.replies++; }
      else { if (port.pending) { stats.timeouts++; tx.push({ cmdIdx: port.pending.idx, replyIdx: null, address: port.pending.p.address, ms: null, timedOut: true }); } port.pending = { p, idx, ts, damaged: true }; sawCommands = true; stats.commands++; }
      return;
    }

    if (!p.reply) {
      // ── command ──
      sawCommands = true; stats.commands++; a.commands++;
      if (p.name === 'POLL') stats.polls++;
      if (port.pending) {
        const q = port.pending; stats.timeouts++; A(q.p.address).timeouts++;
        tx.push({ cmdIdx: q.idx, replyIdx: null, address: q.p.address, ms: null, timedOut: true });
        add(q.idx, 'warn', 'no-reply-next-cycle', 'No reply', `${q.p.name} to address ${q.p.address} got no reply before the next command. Either the reader did not answer within ${DEADLINE} ms, or the capture missed it.`);
      }
      // sequence
      const s = p.sequence, last = a.lastSqn;
      if (last != null) {
        if (s === 0) { add(idx, 'info', 'sqn-zero-reset', 'Sequence restart', `Controller sent SQN 0 to address ${p.address}: a (re)start. The reader discards its last reply${a.sc === 'up' ? ' and the secure session ends' : ''}.`); if (p.name !== 'CHLNG') a.sc = 'none'; }
        else if (s === last && a.lastCmd) {
          const sameBytes = a.lastCmd.b.join() === p.b.join();
          if (a.lastReplyName === 'BUSY') add(idx, 'ok', 'busy-handling', 'Repeat after BUSY', 'Same command, same SQN after BUSY — exactly what the spec asks for.');
          else {
            a.retries++;
            add(idx, a.retries > 3 ? 'warn' : 'info', a.retries > 3 ? 'retry-limit' : 'same-sqn-retransmit', a.retries > 3 ? 'Too many retries' : 'Retransmission',
              `${sameBytes ? 'Same bytes' : 'Same SQN'} as the previous command to address ${p.address} (retry ${a.retries}). ${a.retries > 3 ? 'The spec recommends at most 3 resends, then a session restart with SQN 0.' : 'The reader should resend its previous reply without running the command twice.'}`);
            if (a.lastNak != null && a.lastNak !== 1) add(idx, 'warn', 'after-nak', 'Retry after NAK', `The reader refused the last attempt with NAK ${h2(a.lastNak)}. Only NAK 0x01 (bad check) is worth retrying.`);
          }
        } else {
          const want = last === 0 ? 1 : (last % 3) + 1;
          if (s !== want) add(idx, 'warn', 'sqn-increment', 'Sequence skipped', `Expected SQN ${want} after ${last} for address ${p.address}, got ${s}. Possible lost frames (capture gap) or a controller fault.`);
          a.retries = 0;
        }
      } else if (s !== 0) add(idx, 'info', 'sqn-increment', 'Joined mid-session', `First command seen for address ${p.address} uses SQN ${s}; the capture started after the session began.`);
      a.lastSqn = s;
      // secure channel
      if (p.name === 'CHLNG') { if (a.sc === 'up') add(idx, 'info', 'secure-handshake-order', 'New handshake', `A new Secure Channel handshake while a session was up (address ${p.address}). Repeated handshakes can point to MAC failures or reader resets.`); a.sc = 'chlng'; if (p.sb[2] === 0) add(idx, 'info', 'secure-handshake-order', 'Default key', 'Handshake uses SCBK-D (the default key). Outside installation mode the reader should be using its own SCBK.'); }
      else if (p.name === 'SCRYPT') { if (a.sc !== 'ccrypt') add(idx, 'warn', 'secure-handshake-order', 'Handshake out of order', 'SCRYPT without a preceding CHLNG → CCRYPT in this capture.'); a.sc = 'scrypt'; }
      else if (a.sc === 'up' && p.type == null) { add(idx, 'warn', 'secure-handshake-order', 'Plaintext inside a session', `A command without a security block was sent to address ${p.address} after the session started. That ends the secure session.`); a.sc = 'none'; }
      if (p.name === 'KEYSET' && !p.encrypted) add(idx, 'error', 'keyset-context', 'Key sent in the clear', 'KEYSET without encryption exposes the key on the wire. It belongs inside an encrypted session or physically secured installation mode.');
      if (p.name === 'COMSET') add(idx, 'info', 'comset-change', 'Reconfiguration', 'COMSET changes the reader address/baud once it answers with COM. Unexpected COMSET can be a misconfiguration or a hijack attempt.');
      // file transfer
      if (p.name === 'FILETRANSFER' && p.payload.length >= 11) {
        const off = p.payload[5] | (p.payload[6] << 8) | (p.payload[7] << 16) | (p.payload[8] << 24);
        if (off === 0) { a.lastFtOffset = null; a.ftNegative = false; a.ftDelay = null; } // a new (or restarted) transfer
        if (a.ftNegative) add(idx, 'warn', 'file-transfer-flow', 'Continuing after an error', 'The reader returned a negative FTSTAT, but the controller kept sending fragments.');
        if (a.lastFtOffset != null && off < a.lastFtOffset) add(idx, 'warn', 'file-transfer-flow', 'Offset went backwards', `Offset ${off} after ${a.lastFtOffset}; offsets must increase.`);
        if (a.ftDelay && a.ftAt != null && ts != null && ts - a.ftAt < a.ftDelay) add(idx, 'warn', 'file-transfer-flow', 'FtDelay not honoured', `Next fragment ${ts - a.ftAt} ms after FTSTAT asked for ${a.ftDelay} ms.`);
        a.lastFtOffset = off;
      }
      a.lastCmd = p; a.lastCmdIdx = idx; a.lastReplyName = null;
      port.pending = { p, idx, ts };
      return;
    }

    // ── reply ──
    sawReplies = true; stats.replies++; a.replies++;
    const q = port.pending;
    if (p.name === 'ACK') stats.acks++;
    if (p.name === 'BUSY') stats.busy++;
    if (p.name === 'NAK') { stats.naks++; a.naks++; a.lastNak = p.payload[0] ?? null; } else a.lastNak = null;
    a.lastReplyName = p.name;
    if (!q) {
      if (!sawCommands && rxOnlyNoted) return;
      if (!sawCommands) rxOnlyNoted = true;
      add(idx, sawCommands ? 'warn' : 'info', 'one-reply-per-command', 'Reply without a command', sawCommands
        ? `${p.name} from address ${p.address} with no outstanding command. Only the controller speaks first; check for a second reply or a capture gap.`
        : 'No controller commands in this capture so far — it may be an RX-only tap that hears replies but not commands.');
    } else {
      port.pending = null;
      const ms = ts != null && q.ts != null ? ts - q.ts : null;
      tx.push({ cmdIdx: q.idx, replyIdx: idx, address: p.address, ms, timedOut: false });
      if (q.damaged) { if (p.name === 'NAK' && p.payload[0] === 1) add(idx, 'ok', 'after-nak', 'NAK 0x01 for a damaged command', 'The reader saw the damaged command and asked for a resend — correct behaviour.'); return; }
      if (q.p.address !== p.address) add(idx, 'error', 'reply-address-match', 'Wrong address replied', `Command went to address ${q.p.address}, reply came from ${p.address}. Two readers may share an address, or one is answering for another.`);
      if (p.sequence === 0 && p.name !== 'BUSY') A(p.address).sc = 'none';
      if (A(p.address).sc === 'up' && p.type == null && !['BUSY', 'NAK'].includes(p.name)) { add(idx, 'warn', 'secure-handshake-order', 'Plaintext reply inside a session', `${p.name} from address ${p.address} has no security block although a session is up — that ends the session (and a card number or PIN would be readable).`); A(p.address).sc = 'none'; }
      if (p.name !== 'BUSY' && p.sequence !== q.p.sequence) add(idx, p.sequence === 0 ? 'warn' : 'error', p.sequence === 0 ? 'sqn-zero-reset' : 'nak-sqn', p.sequence === 0 ? 'Reader asked for a reset' : 'Reply sequence mismatch',
        p.sequence === 0 ? 'A reply with SQN 0 (other than BUSY) asks the controller to restart the sequence and clears any secure session — typical after a reader reboot.' : `Reply SQN ${p.sequence} does not echo command SQN ${q.p.sequence}.`);
      if (ms != null) {
        stats.replyMs.push(ms); A(p.address).maxReplyMs = Math.max(A(p.address).maxReplyMs, ms);
        if (ms > DEADLINE) add(idx, 'warn', 'reply-deadline', 'Late reply', `${ms} ms after the command was captured; a reader must start replying within ${DEADLINE} ms (typically < 3 ms). Note: capture timestamps include frame transmission time.`);
      }
      const exp = expectedReplies(q.p.name);
      if (exp && !exp.has(p.name) && !['NAK', 'BUSY'].includes(p.name)) add(idx, 'warn', q.p.name === 'POLL' ? 'poll-responses' : 'expected-reply-map', 'Unexpected reply', `${q.p.name} is answered with ${[...exp].join('/')}, NAK or BUSY — not ${p.name}.`);
      if (p.name === 'NAK') {
        const c = p.payload[0];
        add(idx, c === 1 ? 'warn' : 'info', 'after-nak', `NAK ${h2(c ?? 0)}`, `${(enumText(EN.nakErrorCode, c ?? 0) || 'Unknown').replace(/\.$/, '')} — in answer to ${q.p.name}.`);
      }
      if (p.name === 'CCRYPT') { if (A(p.address).sc !== 'chlng') add(idx, 'warn', 'secure-handshake-order', 'Handshake out of order', 'CCRYPT without a preceding CHLNG.'); A(p.address).sc = 'ccrypt'; }
      if (p.name === 'RMAC_I') {
        if (p.sb[2] === 0xff) { add(idx, 'error', 'secure-handshake-order', 'Secure Channel rejected', 'RMAC_I status 0xFF: the reader rejected the controller cryptogram — the two sides do not share the same key.'); A(p.address).sc = 'none'; }
        else { add(idx, 'ok', 'secure-handshake-order', 'Secure Channel up', 'Four-step handshake complete. From here every message should carry SCS_15–SCS_18.'); A(p.address).sc = 'up'; }
      }
      if (p.name === 'FTSTAT' && p.payload.length >= 7) {
        let st = p.payload[3] | (p.payload[4] << 8); if (st & 0x8000) st -= 65536;
        A(p.address).ftDelay = p.payload[1] | (p.payload[2] << 8); A(p.address).ftAt = ts;
        A(p.address).ftNegative = st < 0;
        if (st !== 0) A(p.address).lastFtOffset = null; // transfer finished or stopped
        if (st < 0) add(idx, 'warn', 'file-transfer-flow', 'Transfer refused', `FTSTAT status ${st}: ${enumText(EN.ftStatusDetail, st) || 'error'}.`);
        if (st === 2) add(idx, 'info', 'file-transfer-flow', 'Reader rebooting', 'Status 2: expect a full communications reset (SQN 0 and a new handshake).');
      }
    }
  });
  const replyMs = stats.replyMs;
  const out = {
    tx, findings, perAddress: [...perAddress.values()], sawCommands, sawReplies,
    stats: { ...stats, replyMs: undefined, replyAvg: replyMs.length ? Math.round(replyMs.reduce((a, x) => a + x, 0) / replyMs.length) : null, replyMax: replyMs.length ? Math.max(...replyMs) : null, timed: replyMs.length },
  };
  if (!sawCommands && sawReplies) findings.unshift({ idx: null, severity: 'info', rule: 'one-reply-per-command', title: 'Replies only', text: 'This capture contains replies but no commands. That is typical of a receive-only tap on one side of a converter, not a bus fault.' });
  if (sawCommands && !sawReplies && frames.length > 3) findings.unshift({ idx: null, severity: 'warn', rule: 'no-reply-next-cycle', title: 'No replies at all', text: 'Commands but no replies: wrong address, wrong baud, reader unpowered, A/B swapped — or the capture only hears the controller.' });
  return out;
}

export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2, ok: 3 };
export const ruleText = (id) => BEHAVIORS[id] || null;
