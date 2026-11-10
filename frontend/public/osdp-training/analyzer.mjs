// AETHER OSDP Academy — conversation coach.
//
// Walks a capture in order and checks it against the behaviour rules in the
// SIA OSDP 2.2.2 reference (spec-data.mjs → behaviors). Every finding names the
// rule it comes from so a learner can open the rule and read why.
//
// Findings are observations about the capture, not diagnoses: an RX-only tap
// can miss commands, and a missing reply can be a capture gap. The Academy never
// holds session keys, so it can observe a Secure Channel exchange but never
// verify a cryptogram or MAC.
//
// Each frame is judged on three levels:
//   1. transmission integrity — do the check bytes match?
//   2. structural validity     — LEN, reserved CTRL bits (parse issues other than the check)
//   3. semantic confidence     — only frames that pass 1 and 2 feed the rule checks
// A frame that fails 1 or 2 still takes its turn on the bus (a command occupies
// the line, a reply answers the pending command), but it never changes the
// per-reader state (sequence, retries, secure channel, file transfer, expected reply).
//
// All per-reader state is keyed by port + address: the same address on two
// independent ports is two different readers.

import { parse, short, BEHAVIORS, TIMING, CMD, h2, enumText, EN } from './protocol.mjs?v=198dc99a';

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
const RMAC_ACCEPTED = 0x01, RMAC_REJECTED = 0xff; // SCS_14 SEC_BLK_DATA
const NO_MAC_CHECK = 'The Academy observed this exchange but holds no session keys, so it cannot verify the cryptograms or MACs — this is what the frames say, not a cryptographic check.';
const REJECT_CAUSES = 'A key mismatch is one possible cause; others include session/context problems (e.g. a reset between steps) or an implementation fault.';

/** Accepts ms numbers, ISO strings or '' and returns ms or null. */
export function toMs(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => String(r2(x));
const isCheckIssue = (s) => /^(CRC|Checksum) mismatch/.test(s);

/**
 * analyze(frames, opts?) — frames: [{ fullHex | hex | bytes, ts?, port? | portPath? }]
 *
 * opts:
 *   baud         line speed used to estimate frame transmission time (default 9600)
 *   bitsPerChar  bits per character on the wire (default 10 = 8N1)
 *   tsMode       what a frame timestamp marks: 'start' (first byte), 'end' (last byte)
 *                or 'unknown' (default) — decides how the reply turnaround is estimated
 *   captureEndMs when the capture stopped; timing evidence for a final unanswered command
 *
 * Returns { tx, findings, perAddress, stats, sawCommands, sawReplies }.
 *   tx[]: { port, cmdIdx, replyIdx, address, state: 'answered'|'no-reply'|'pending'|'damaged',
 *           integrity: 'ok'|'bad-check'|'bad-structure', cmdIntegrity, replyIntegrity,
 *           timedOut, ms (= measuredDeltaMs), measuredDeltaMs, cmdTxMs, replyTxMs,
 *           turnaroundLoMs, turnaroundHiMs, tsMode }
 *   perAddress[]: one entry per port + address { port, address, commands, replies, naks,
 *           timeouts, maxReplyMs (measured delta), maxTurnaroundMs (lower-bound estimate), retries, secure }
 *   stats.replyAvg / replyMax are measured timestamp deltas (command ts → reply ts) of fully
 *   valid transactions; stats.turnaroundMax is the largest lower-bound wire-turnaround estimate.
 */
export function analyze(frames, opts = {}) {
  const baud = opts.baud > 0 ? opts.baud : 9600;
  const bitsPerChar = opts.bitsPerChar > 0 ? opts.bitsPerChar : 10;
  const tsMode = ['start', 'end'].includes(opts.tsMode) ? opts.tsMode : 'unknown';
  const captureEndMs = toMs(opts.captureEndMs);
  const txMs = (n) => (n * bitsPerChar * 1000) / baud;
  const frameLen = (p) => p.b.length + (p.marked ? 1 : 0);

  const findings = [], tx = [];
  const add = (idx, severity, rule, title, text) => findings.push({ idx, severity, rule, title, text });
  const ports = new Map(); // port -> { pending, sawCommands, rxOnlyNoted }
  const stats = { frames: frames.length, parsed: 0, bad: 0, commands: 0, replies: 0, polls: 0, acks: 0, naks: 0, busy: 0, timeouts: 0, replyMs: [], turnaround: [] };
  const perAddress = new Map(); // `${port}\u0000${address}` -> state
  const A = (port, addr) => {
    const k = `${port}\u0000${addr}`;
    if (!perAddress.has(k)) perAddress.set(k, { port, address: addr, commands: 0, replies: 0, naks: 0, timeouts: 0, maxReplyMs: 0, maxTurnaroundMs: 0,
      lastSqn: null, retries: 0, lastNak: null, lastCmd: null, lastReplyName: null, sc: 'none', scPartial: false, hsSteps: [],
      ftDelay: null, ftAt: null, ftNegative: false, lastFtOffset: null, lastTs: null });
    return perAddress.get(k);
  };
  const P = (key) => { if (!ports.has(key)) ports.set(key, { pending: null, sawCommands: false, rxOnlyNoted: false }); return ports.get(key); };
  let sawCommands = false, sawReplies = false, lastTsAny = null;
  const where = (portKey, addr) => `address ${addr}${ports.size > 1 ? ` on ${portKey}` : ''}`;

  /** Close a pending command that got no reply (the controller moved on). */
  const closeNoReply = (portKey, q, reason) => {
    if (q.integrity !== 'ok') { tx.push(mkTx(portKey, q, null, 'damaged')); return; }
    stats.timeouts++; A(portKey, q.p.address).timeouts++;
    tx.push(mkTx(portKey, q, null, 'no-reply'));
    add(q.idx, 'warn', 'no-reply-next-cycle', 'No reply', `${q.p.name} to ${where(portKey, q.p.address)} got no reply ${reason}. Either the reader did not answer within ${DEADLINE} ms, or the capture missed it.`);
  };
  const worst = (...xs) => (xs.includes('bad-check') ? 'bad-check' : xs.includes('bad-structure') ? 'bad-structure' : 'ok');
  function mkTx(portKey, q, r, state) {
    const t = { port: portKey, cmdIdx: q.idx, replyIdx: r ? r.idx : null, address: q.p.address, state, timedOut: state === 'no-reply',
      integrity: worst(q.integrity, r ? r.integrity : 'ok'), cmdIntegrity: q.integrity, replyIntegrity: r ? r.integrity : null,
      ms: null, measuredDeltaMs: null, cmdTxMs: r2(txMs(frameLen(q.p))), replyTxMs: null, turnaroundLoMs: null, turnaroundHiMs: null, tsMode };
    if (r) {
      t.replyTxMs = r2(txMs(frameLen(r.p)));
      if (r.ts != null && q.ts != null) {
        const d = r.ts - q.ts, c = txMs(frameLen(q.p)), rp = txMs(frameLen(r.p));
        const lo = tsMode === 'start' ? d - c : tsMode === 'end' ? d - rp : d - c - rp;
        const hi = tsMode === 'unknown' ? d : lo;
        t.ms = t.measuredDeltaMs = d;
        t.turnaroundLoMs = r2(Math.max(0, lo)); t.turnaroundHiMs = r2(Math.max(0, hi));
        t._lo = Math.max(0, lo); t._hi = Math.max(0, hi); t._c = c; t._r = rp;
      }
    }
    return t;
  }

  frames.forEach((f, idx) => {
    let p;
    try { p = parse(f.fullHex ?? f.hex ?? f.bytes ?? ''); } catch (e) { stats.bad++; add(idx, 'error', 'frame-integrity', 'Not a complete frame', e.message); return; }
    stats.parsed++;
    const ts = toMs(f.ts);
    if (ts != null) lastTsAny = lastTsAny == null ? ts : Math.max(lastTsAny, ts);
    const portKey = f.port || f.portPath || 'bus';
    const port = P(portKey);

    // ── levels 1 + 2: integrity and structure ──
    const structural = p.issues.filter((s) => !isCheckIssue(s));
    const integrity = !p.ok ? 'bad-check' : structural.length ? 'bad-structure' : 'ok';
    if (integrity !== 'ok') {
      stats.bad++;
      if (integrity === 'bad-check') add(idx, 'error', 'frame-integrity', 'Integrity check failed', `${p.issues.join('; ')}. A reader answers bad check bytes with NAK 0x01; on a capture, also suspect noise, wrong baud or the capture point. The coach does not interpret the content of a damaged frame.`);
      else add(idx, 'error', 'frame-integrity', 'Frame structure problem', `${structural.join('; ')}. The check bytes match, so these bytes most likely left the sender like this: the frame itself is malformed. A reader should discard it; the coach does not interpret its content or let it change the sequence or session state.`);
      // Keep the turn-taking (something was sent) but do not interpret the content.
      if (p.reply) {
        sawReplies = true; stats.replies++;
        if (port.pending) tx.push(mkTx(portKey, port.pending, { idx, p, ts, integrity }, 'damaged'));
        port.pending = null;
      } else {
        sawCommands = true; port.sawCommands = true; stats.commands++;
        if (port.pending) closeNoReply(portKey, port.pending, 'before the next (damaged) command');
        port.pending = { p, idx, ts, integrity };
      }
      return;
    }

    // ── level 3: semantics ──
    for (const w of p.warnings) add(idx, 'warn', /scs15-with-data/.test(w) ? 'scs15-with-data' : /belongs to the/.test(w) ? 'secure-handshake-order' : /BUSY/.test(w) ? 'busy-handling' : /broadcast/.test(w) ? 'broadcast-single-pd' : 'frame-integrity', 'Rule check', w);
    const a = A(portKey, p.address);
    if (ts != null && a.lastTs != null && ts - a.lastTs > OFFLINE_MS) add(idx, 'info', 'offline-timeout', 'Long silence', `${((ts - a.lastTs) / 1000).toFixed(1)} s since the last frame for ${where(portKey, p.address)}. After 8 s a reader treats the link as off-line; expect SQN 0 and a new handshake.`);
    if (ts != null) a.lastTs = ts;
    const sessionNote = (s) => (s.scPartial ? ' (The session was inferred from an accepted RMAC_I; the start of the handshake is not in this capture.)' : '');

    if (!p.reply) {
      // ── command ──
      sawCommands = true; port.sawCommands = true; stats.commands++; a.commands++;
      if (p.name === 'POLL') stats.polls++;
      if (port.pending) closeNoReply(portKey, port.pending, 'before the next command');
      // sequence
      const s = p.sequence, last = a.lastSqn;
      if (last != null) {
        if (s === 0) { add(idx, 'info', 'sqn-zero-reset', 'Sequence restart', `Controller sent SQN 0 to ${where(portKey, p.address)}: a (re)start. The reader discards its last reply${a.sc === 'up' ? ' and the secure session ends' : ''}.`); if (p.name !== 'CHLNG') { a.sc = 'none'; a.scPartial = false; } a.retries = 0; }
        else if (s === last && a.lastCmd) {
          const sameBytes = a.lastCmd.b.join() === p.b.join();
          if (a.lastReplyName === 'BUSY') add(idx, 'ok', 'busy-handling', 'Repeat after BUSY', 'Same command, same SQN after BUSY — exactly what the spec asks for.');
          else if (!sameBytes) {
            add(idx, 'warn', 'same-sqn-retransmit', 'Same sequence, different request', `SQN ${s} again for ${where(portKey, p.address)}, but the bytes differ from the previous command (${a.lastCmd.name} → ${p.name}). A retransmission must repeat the request unchanged; a reader treats a repeated SQN as a retransmission and resends its previous reply without running this new request. Flag for investigation: a controller fault, or a capture that lost or merged frames.`);
          } else {
            a.retries++;
            add(idx, a.retries > 3 ? 'warn' : 'info', a.retries > 3 ? 'retry-limit' : 'same-sqn-retransmit', a.retries > 3 ? 'Too many retries' : 'Retransmission',
              `Same bytes as the previous command to ${where(portKey, p.address)} (retry ${a.retries}). ${a.retries > 3 ? 'The spec recommends at most 3 resends, then a session restart with SQN 0.' : 'The reader should resend its previous reply without running the command twice.'}`);
            if (a.lastNak != null && a.lastNak !== 1) add(idx, 'warn', 'after-nak', 'Retry after NAK', `The reader refused the last attempt with NAK ${h2(a.lastNak)}. Only NAK 0x01 (bad check) is worth retrying.`);
          }
        } else {
          const want = last === 0 ? 1 : (last % 3) + 1;
          if (s !== want) add(idx, 'warn', 'sqn-increment', 'Sequence skipped', `Expected SQN ${want} after ${last} for ${where(portKey, p.address)}, got ${s}. Possible lost frames (capture gap) or a controller fault.`);
          a.retries = 0;
        }
      } else if (s !== 0) add(idx, 'info', 'sqn-increment', 'Joined mid-session', `First command seen for ${where(portKey, p.address)} uses SQN ${s}; the capture started after the session began.`);
      a.lastSqn = s;
      // secure channel
      if (a.sc === 'ccrypt' && p.name !== 'SCRYPT') add(idx, 'info', 'secure-handshake-order', 'Handshake abandoned after CCRYPT', `The controller did not continue with SCRYPT after the reader's CCRYPT (${where(portKey, p.address)}). It may have rejected the reader's cryptogram. ${REJECT_CAUSES} ${NO_MAC_CHECK}`);
      if (p.name === 'CHLNG') {
        if (a.sc === 'up') add(idx, 'info', 'secure-handshake-order', 'New handshake', `A new Secure Channel handshake while a session was up (${where(portKey, p.address)}). Repeated handshakes can point to MAC failures or reader resets.`);
        a.sc = 'chlng'; a.scPartial = false; a.hsSteps = ['CHLNG'];
        if (p.sb[2] === 0) add(idx, 'info', 'secure-handshake-order', 'Default key', 'Handshake uses SCBK-D (the default key). Outside installation mode the reader should be using its own SCBK.');
      } else if (p.name === 'SCRYPT') {
        if (a.sc !== 'ccrypt') { add(idx, 'warn', 'secure-handshake-order', 'Handshake out of order', 'SCRYPT without a preceding CHLNG → CCRYPT in this capture.'); a.hsSteps = []; }
        else a.hsSteps.push('SCRYPT');
        a.sc = 'scrypt'; a.scPartial = false;
      } else if (a.sc === 'up' && p.type == null) { add(idx, 'warn', 'secure-handshake-order', 'Plaintext inside a session', `A command without a security block was sent to ${where(portKey, p.address)} after the session started. That ends the secure session.${sessionNote(a)}`); a.sc = 'none'; a.scPartial = false; }
      else if (a.sc !== 'up' && a.sc !== 'none') { a.sc = 'none'; a.hsSteps = []; } // handshake interrupted
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
      a.lastCmd = p; a.lastReplyName = null;
      port.pending = { p, idx, ts, integrity };
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
      if (!port.sawCommands && port.rxOnlyNoted) return;
      if (!port.sawCommands) port.rxOnlyNoted = true;
      add(idx, port.sawCommands ? 'warn' : 'info', 'one-reply-per-command', 'Reply without a command', port.sawCommands
        ? `${p.name} from ${where(portKey, p.address)} with no outstanding command. Only the controller speaks first; check for a second reply or a capture gap.`
        : 'No controller commands in this capture so far — it may be an RX-only tap that hears replies but not commands.');
      return;
    }
    port.pending = null;
    const r = { idx, p, ts, integrity };
    if (q.integrity !== 'ok') {
      tx.push(mkTx(portKey, q, r, 'damaged'));
      if (q.integrity === 'bad-check' && p.name === 'NAK' && p.payload[0] === 1) add(idx, 'ok', 'after-nak', 'NAK 0x01 for a damaged command', 'The reader saw the damaged command and asked for a resend — correct behaviour.');
      return;
    }
    const t = mkTx(portKey, q, r, 'answered');
    tx.push(t);
    const s = A(portKey, p.address);
    if (q.p.address !== p.address) add(idx, 'error', 'reply-address-match', 'Wrong address replied', `Command went to address ${q.p.address}, reply came from ${p.address}. Two readers may share an address, or one is answering for another.`);
    if (p.sequence === 0 && p.name !== 'BUSY') { s.sc = 'none'; s.scPartial = false; }
    if (s.sc === 'up' && p.type == null && !['BUSY', 'NAK'].includes(p.name)) { add(idx, 'warn', 'secure-handshake-order', 'Plaintext reply inside a session', `${p.name} from ${where(portKey, p.address)} has no security block although a session is up — that ends the session (and a card number or PIN would be readable).${sessionNote(s)}`); s.sc = 'none'; s.scPartial = false; }
    if (p.name !== 'BUSY' && p.sequence !== q.p.sequence) add(idx, p.sequence === 0 ? 'warn' : 'error', p.sequence === 0 ? 'sqn-zero-reset' : 'nak-sqn', p.sequence === 0 ? 'Reader asked for a reset' : 'Reply sequence mismatch',
      p.sequence === 0 ? 'A reply with SQN 0 (other than BUSY) asks the controller to restart the sequence and clears any secure session — typical after a reader reboot.' : `Reply SQN ${p.sequence} does not echo command SQN ${q.p.sequence}.`);
    // timing
    if (t.measuredDeltaMs != null) {
      stats.replyMs.push(t.measuredDeltaMs); stats.turnaround.push(t._lo);
      s.maxReplyMs = Math.max(s.maxReplyMs, t.measuredDeltaMs); s.maxTurnaroundMs = Math.max(s.maxTurnaroundMs, t.turnaroundLoMs);
      if (t._hi > DEADLINE) {
        const basis = tsMode === 'start' ? 'timestamps mark the first byte of each frame, so turnaround = delta − command transmission time'
          : tsMode === 'end' ? 'timestamps mark the last byte of each frame, so turnaround = delta − reply transmission time'
          : 'it is unknown whether timestamps mark the first or last byte, so turnaround lies between delta − both transmission times and delta';
        const est = t._lo === t._hi ? `${fmt(t._lo)} ms` : `${fmt(t._lo)}–${fmt(t._hi)} ms`;
        const nums = `Timestamps are ${fmt(t.measuredDeltaMs)} ms apart. At ${baud} baud (${bitsPerChar} bits per character) the ${frameLen(q.p)}-byte command takes ${fmt(t._c)} ms and the ${frameLen(p)}-byte reply ${fmt(t._r)} ms on the wire; ${basis}: estimated turnaround ${est}. A reader must start replying within ${DEADLINE} ms of the command's last byte (typically < 3 ms).`;
        if (t._lo > DEADLINE) add(idx, 'warn', 'reply-deadline', 'Late reply', nums);
        else add(idx, 'info', 'reply-deadline', 'Possibly late — depends on what the timestamps mark', `${nums} Only the upper end of that range exceeds ${DEADLINE} ms; capture-tool buffering can also add delay.`);
      }
    }
    const exp = expectedReplies(q.p.name);
    if (exp && !exp.has(p.name) && !['NAK', 'BUSY'].includes(p.name)) add(idx, 'warn', q.p.name === 'POLL' ? 'poll-responses' : 'expected-reply-map', 'Unexpected reply', `${q.p.name} is answered with ${[...exp].join('/')}, NAK or BUSY — not ${p.name}.`);
    if (p.name === 'NAK') {
      const c = p.payload[0];
      const security = c === 5 || c === 6;
      add(idx, c === 1 || security ? 'warn' : 'info', 'after-nak', `NAK ${h2(c ?? 0)}`, `${(enumText(EN.nakErrorCode, c ?? 0) || 'Unknown').replace(/\.$/, '')} — in answer to ${q.p.name}.${security ? ' The reader refused the command for a security reason: the two sides disagree about whether or how the conversation is secured.' : ''}`);
    }
    if (p.name === 'CCRYPT') {
      if (s.sc !== 'chlng') { add(idx, 'warn', 'secure-handshake-order', 'Handshake out of order', 'CCRYPT without a preceding CHLNG.'); s.hsSteps = []; }
      else s.hsSteps.push('CCRYPT');
      s.sc = 'ccrypt'; s.scPartial = false;
    }
    if (p.name === 'RMAC_I') {
      const st = p.sb.length >= 3 ? p.sb[2] : null;
      const full = s.sc === 'scrypt' && s.hsSteps.join() === 'CHLNG,CCRYPT,SCRYPT';
      s.hsSteps = [];
      if (st === RMAC_ACCEPTED) {
        if (full) { add(idx, 'ok', 'secure-handshake-order', 'Secure Channel up', `The capture shows CHLNG → CCRYPT → SCRYPT → RMAC_I for ${where(portKey, p.address)}, and the reader reported the controller's cryptogram as accepted (RMAC_I 0x01). ${NO_MAC_CHECK} From here every message should carry SCS_15–SCS_18.`); s.scPartial = false; }
        else { add(idx, 'info', 'secure-handshake-order', 'Secure Channel accepted — partial capture', `RMAC_I 0x01: accepted by the reader; earlier handshake steps not in this capture (${where(portKey, p.address)}). The coach treats the session as started for later checks. ${NO_MAC_CHECK}`); s.scPartial = true; }
        s.sc = 'up';
      } else if (st === RMAC_REJECTED) {
        add(idx, 'error', 'secure-handshake-order', 'Secure Channel rejected', `The reader rejected the controller's cryptogram (RMAC_I 0xFF). ${REJECT_CAUSES}`);
        s.sc = 'none'; s.scPartial = false;
      } else {
        add(idx, 'warn', 'secure-handshake-order', 'Unsupported RMAC_I status', `RMAC_I carries status ${st == null ? '(missing)' : h2(st)}. OSDP 2.2.2 defines only 0x01 (cryptogram accepted) and 0xFF (rejected); any other value is not defined, so the coach does not treat the Secure Channel as established. Check the reader's firmware against the spec.`);
        s.sc = 'none'; s.scPartial = false;
      }
    }
    if (p.name === 'FTSTAT' && p.payload.length >= 7) {
      let st = p.payload[3] | (p.payload[4] << 8); if (st & 0x8000) st -= 65536;
      s.ftDelay = p.payload[1] | (p.payload[2] << 8); s.ftAt = ts;
      s.ftNegative = st < 0;
      if (st !== 0) s.lastFtOffset = null; // transfer finished or stopped
      if (st < 0) add(idx, 'warn', 'file-transfer-flow', 'Transfer refused', `FTSTAT status ${st}: ${enumText(EN.ftStatusDetail, st) || 'error'}.`);
      if (st === 2) add(idx, 'info', 'file-transfer-flow', 'Reader rebooting', 'Status 2: expect a full communications reset (SQN 0 and a new handshake).');
    }
  });

  // ── capture end: every port's pending command becomes a transaction ──
  const endTs = captureEndMs != null ? Math.max(captureEndMs, lastTsAny ?? captureEndMs) : lastTsAny;
  for (const [portKey, port] of ports) {
    const q = port.pending; if (!q) continue;
    port.pending = null;
    if (q.integrity !== 'ok') { tx.push(mkTx(portKey, q, null, 'damaged')); continue; }
    // Conservative: measure from the command's last byte unless timestamps are known to mark the end.
    const cmdEnd = q.ts == null ? null : q.ts + (tsMode === 'end' ? 0 : txMs(frameLen(q.p)));
    const elapsed = cmdEnd != null && endTs != null ? endTs - cmdEnd : null;
    if (elapsed != null && elapsed >= DEADLINE) closeNoReply(portKey, q, `in the ${fmt(elapsed)} ms the capture continued after it`);
    else {
      tx.push(mkTx(portKey, q, null, 'pending'));
      add(q.idx, 'info', 'no-reply-next-cycle', 'Capture ended before a reply', `${q.p.name} to ${where(portKey, q.p.address)} is the last command on ${portKey}, and the capture ended ${elapsed != null && endTs > q.ts ? `${fmt(Math.max(0, endTs - q.ts))} ms after its timestamp` : 'with no later timestamp'} — too soon to say whether the reader answered (it has up to ${DEADLINE} ms). Not counted as a missing reply.`);
    }
  }
  for (const t of tx) { delete t._lo; delete t._hi; delete t._c; delete t._r; }

  const replyMs = stats.replyMs, ta = stats.turnaround;
  const out = {
    tx, findings, sawCommands, sawReplies,
    perAddress: [...perAddress.values()].map((a) => ({ port: a.port, address: a.address, commands: a.commands, replies: a.replies, naks: a.naks, timeouts: a.timeouts,
      maxReplyMs: a.maxReplyMs, maxTurnaroundMs: a.maxTurnaroundMs, retries: a.retries, secure: a.sc === 'up' ? (a.scPartial ? 'up-partial' : 'up') : a.sc })),
    stats: { ...stats, replyMs: undefined, turnaround: undefined,
      replyAvg: replyMs.length ? Math.round(replyMs.reduce((s, x) => s + x, 0) / replyMs.length) : null,
      replyMax: replyMs.length ? Math.max(...replyMs) : null,
      turnaroundMax: ta.length ? r2(Math.max(...ta)) : null,
      timed: replyMs.length, baud, bitsPerChar, tsMode },
  };
  if (!sawCommands && sawReplies) findings.unshift({ idx: null, severity: 'info', rule: 'one-reply-per-command', title: 'Replies only', text: 'This capture contains replies but no commands. That is typical of a receive-only tap on one side of a converter, not a bus fault.' });
  if (sawCommands && !sawReplies && frames.length > 3) findings.unshift({ idx: null, severity: 'warn', rule: 'no-reply-next-cycle', title: 'No replies at all', text: 'Commands but no replies: wrong address, wrong baud, reader unpowered, A/B swapped — or the capture only hears the controller.' });
  return out;
}

export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2, ok: 3 };
export const ruleText = (id) => BEHAVIORS[id] || null;
