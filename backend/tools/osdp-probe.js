#!/usr/bin/env node
// osdp-probe.js — a standalone, sustained OSDP controller (ACU) probe for the Pi.
//
// Diagnose sends a ~1s burst; some readers (notably WaveLynx, which auto-detects
// OSDP vs Wiegand at boot) need to SEE steady OSDP polling before they switch
// into OSDP mode and start replying. This tool polls continuously for as long as
// you leave it running and prints everything both ways — so you can power-cycle
// the reader while it's polling and watch the exact moment it comes online.
//
// Usage:
//   node tools/osdp-probe.js --port /dev/ttyACM6 [--baud 9600] [--addr 0]
//                            [--rts] [--secs 0] [--no-borrow] [--raw]
//
// By default it asks the running backend to release the port from the emulator
// (borrow) and gives it back on exit. Ctrl-C to stop.
'use strict';
const { SerialPort } = require('serialport');
const http = require('http');
const OSDPPacket = require('../osdp/OSDPPacket');
const { decodeFrame } = require('../osdp/trace/osdpDecoder');

// ── args ──
const A = process.argv.slice(2);
const opt = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const has = (k) => A.includes(k);
const PORT = opt('--port');
const BAUD = parseInt(opt('--baud', '9600'), 10);
const ADDR = parseInt(opt('--addr', '0'), 10) & 0x7F;
const RTS = has('--rts');
const SECS = parseInt(opt('--secs', '0'), 10);          // 0 = until Ctrl-C
const BORROW = !has('--no-borrow');
const SHOWRAW = has('--raw');
const API = opt('--api', 'http://127.0.0.1:3001');   // 127.0.0.1, not localhost (which may resolve to ::1 and miss an IPv4-only backend)
const POLL_MS = parseInt(opt('--pollms', '120'), 10);
if (!PORT) { console.error('usage: node tools/osdp-probe.js --port /dev/ttyACMx [--baud 9600] [--addr 0] [--rts] [--secs 0] [--raw]'); process.exit(2); }

const t0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => `t+${((Date.now() - t0) / 1000).toFixed(2)}s`.padEnd(9);
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1 ');
const stats = { polls: 0, replies: 0, frames: {}, online: false, cards: 0 };

function post(path, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(API + path); const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
        (r) => { let s = ''; r.on('data', c => s += c); r.on('end', () => resolve(s)); });
      req.on('error', () => resolve(null)); req.write(data); req.end();
    } catch { resolve(null); }
  });
}

let sp, pollTimer, sumTimer, seq = 0, needId = true, needCap = true, capTries = 0, rxBuf = Buffer.alloc(0), stopping = false;
const MAX_CAP_TRIES = 4;   // ask for capabilities a few times, then poll regardless

function nextSeq() { seq = seq === 0 ? 1 : (seq % 3) + 1; return seq; }
function write(buf) {
  if (!sp || !sp.isOpen) return;
  if (RTS) { try { sp.set({ rts: true }); } catch {} }
  sp.write(buf, () => sp.drain(() => { if (RTS) setTimeout(() => { try { sp.set({ rts: false }); } catch {} }, 2); }));
}
function frames(store) {
  const out = [];
  while (store.b.length >= 6) {
    const som = store.b.indexOf(0x53);
    if (som < 0) { if (SHOWRAW && store.b.length) console.log(`${ts()} raw  ${hex(store.b.slice(0, 32))}`); store.b = Buffer.alloc(0); break; }
    if (som > 0) { if (SHOWRAW) console.log(`${ts()} raw  ${hex(store.b.slice(0, som))}`); store.b = store.b.slice(som); }
    if (store.b.length < 4) break;
    const len = store.b.readUInt16LE(2);
    if (len < 6 || len > 1440) { store.b = store.b.slice(1); continue; }
    if (store.b.length < len) break;
    out.push(store.b.slice(0, len)); store.b = store.b.slice(len);
  }
  return out;
}

function tick() {
  if (stopping || !sp || !sp.isOpen) return;
  let cmd = 0x60, data = Buffer.alloc(0), label = 'POLL';
  if (needId) { cmd = 0x61; data = Buffer.from([0]); label = 'ID'; }
  else if (needCap && capTries < MAX_CAP_TRIES) { cmd = 0x62; data = Buffer.from([0]); label = 'CAP'; capTries++; }
  else { needCap = false; }   // done learning — poll for events/cards from here on
  const s = nextSeq();
  stats.polls++;
  write(OSDPPacket.buildPacket({ address: ADDR, command: cmd, data, sequence: s }));
  if (SHOWRAW) console.log(`${ts()} TX   ${label.padEnd(4)} addr=${ADDR} seq=${s}`);
}

function onData(chunk) {
  const store = { b: Buffer.concat([rxBuf, chunk]) };
  const fr = frames(store);
  rxBuf = store.b;
  for (const raw of fr) {
    const f = decodeFrame(raw);
    const nm = f.name || (f.isReply ? 'reply' : 'cmd');
    if (f.isReply) {
      stats.replies++; stats.frames[nm] = (stats.frames[nm] || 0) + 1;
      if (f.name === 'osdp_PDID') needId = false;      // learned identity → stop asking
      if (f.name === 'osdp_PDCAP') needCap = false;    // learned capabilities → move to POLL
      const chk = f.checkOk ? '' : ' [BAD CRC]';
      // Plain idle ACKs repeat forever; fold them (counted in the summary) unless --raw.
      const idleAck = f.name === 'osdp_ACK' && f.checkOk;
      if (!idleAck || SHOWRAW) console.log(`${ts()} RX   ${nm}${chk}  addr=${f.address}  ${f.summary || ''}`);
      if (!stats.online && f.name === 'osdp_PDID') {
        stats.online = true;
        console.log(`\n★ ${ts()} READER ONLINE — ${f.summary}\n`);
      }
      if (f.name === 'osdp_RAW' && f.decoded && f.decoded.raw) {
        stats.cards++;
        console.log(`   ↳ CARD: ${f.decoded.raw.bitCount}-bit  ${f.decoded.raw.binary}`);
      }
      if (f.name === 'osdp_NAK' && f.decoded && f.decoded.nak === 0x06) {
        console.log(`   ↳ NAK: reader requires SECURE CHANNEL — it will not talk in clear mode.`);
      }
    } else if (SHOWRAW) {
      console.log(`${ts()} echo ${nm} (our own TX seen on the bus)`);
    }
  }
}

function summary(final) {
  const fr = Object.entries(stats.frames).map(([k, v]) => `${k}×${v}`).join(' ') || 'none';
  console.log(`${final ? '===' : '---'} ${ts()} ${stats.polls} polls · ${stats.replies} replies · frames: ${fr}${stats.online ? ' · ONLINE' : ' · (no reader yet)'} ${final ? '===' : '---'}`);
}

async function main() {
  console.log(`osdp-probe: ${PORT} @ ${BAUD} addr ${ADDR}${RTS ? ' RTS' : ''} — sustained polling every ${POLL_MS}ms. Ctrl-C to stop.`);
  if (BORROW) {
    const r = await post('/api/osdp/enroll/release', { port: PORT });
    if (r == null) console.log(`borrow: could not reach the backend at ${API} — will try to open the port directly.`);
    else { console.log(`borrow: ${r}`); await sleep(300); }   // let the OS release the lock
  }
  sp = new SerialPort({ path: PORT, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
  sp.on('error', e => console.log(`${ts()} port error: ${e.message}`));
  await new Promise((res, rej) => sp.open(e => e ? rej(e) : res())).catch(async (e) => {
    console.error(`\nCannot open ${PORT}: ${e.message}`);
    if (/lock|resource temporarily|ebusy|in use/i.test(e.message)) {
      console.error('\nThe port is still held by another process — the OSDP emulator inside the backend.');
      console.error('Free it and retry. Either:');
      console.error(`  • confirm the backend is reachable (this tool used ${API}); override with --api http://127.0.0.1:3001`);
      console.error('  • or free it manually, then re-run this probe:');
      console.error(`      curl -sX POST ${API}/api/osdp/enroll/release  -H 'Content-Type: application/json' -d '{"port":"${PORT}"}'`);
      console.error('    and when you\'re done, hand it back to the emulator:');
      console.error(`      curl -sX POST ${API}/api/osdp/enroll/reclaim  -H 'Content-Type: application/json' -d '{"port":"${PORT}"}'`);
    }
    process.exit(1);
  });
  if (RTS) { try { sp.set({ rts: false }); } catch {} }
  sp.on('data', onData);
  seq = 0; needId = true; needCap = true;
  // first message at SQN 0 = ask the PD to reset its sequence (clean takeover)
  write(OSDPPacket.buildPacket({ address: ADDR, command: 0x61, data: Buffer.from([0]), sequence: 0 }));
  stats.polls++;
  pollTimer = setInterval(tick, POLL_MS);
  sumTimer = setInterval(() => summary(false), 5000);
  if (SECS > 0) setTimeout(() => shutdown(0), SECS * 1000);
}

async function shutdown(code) {
  if (stopping) return; stopping = true;
  if (pollTimer) clearInterval(pollTimer); if (sumTimer) clearInterval(sumTimer);
  try { if (sp && sp.isOpen) await new Promise(r => sp.close(() => r())); } catch {}
  if (BORROW) { await post('/api/osdp/enroll/reclaim', { port: PORT }); }
  console.log('');
  summary(true);
  process.exit(code || 0);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
main().catch(e => { console.error(e); process.exit(1); });
