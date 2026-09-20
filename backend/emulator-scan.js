#!/usr/bin/env node
const { io } = require('socket.io-client');
const HOST = process.env.AETHER_HOST || 'http://localhost:3001';
const DURATION_MS = parseInt(process.env.SCAN_SECONDS || '30', 10) * 1000;

const perAddrIn = new Map(), perAddrOut = new Map();
let totalIn = 0, totalOut = 0;
const sampleFrames = [];
const eventCounts = new Map();
const replyHexByAddr = new Map();   // addr → [hex strings of replies we sent]

const CMD = { 0x60:'POLL',0x61:'ID',0x62:'CAP',0x63:'LSTAT',0x65:'ISTAT',0x66:'OSTAT',0x67:'RSTAT',0x68:'OUT',0x69:'LED',0x6A:'BUZ',0x6E:'TEXT',0x6F:'COMSET',0x75:'KEYSET',0x76:'CHLNG',0x77:'SCRYPT' };
const RPL = { 0x40:'ACK',0x41:'NAK',0x45:'PDID',0x46:'PDCAP',0x48:'LSTATR',0x49:'ISTATR',0x4A:'OSTATR',0x4B:'RSTATR',0x50:'RAW',0x53:'KEYPAD' };
const cN = c => CMD[c] || '0x'+(c?.toString(16).padStart(2,'0').toUpperCase() || '?');
const rN = c => RPL[c] || '0x'+(c?.toString(16).padStart(2,'0').toUpperCase() || '?');

function bump(m, a, c) {
  if (!m.has(a)) m.set(a, { count:0, cmds: new Map() });
  const e = m.get(a); e.count++;
  if (c !== undefined) e.cmds.set(c, (e.cmds.get(c)||0)+1);
}

function onFrame(src, p) {
  if (!p) return;
  const addr = (p.address ?? p.addr) & 0x7F;
  const cmd = p.cmd ?? p.command;
  const isReply = p.isReply === true || p.direction === 'tx' || p.direction === 'out';
  const hex = ((p.hex || p.dataHex || p.fullHex) || '').toString().toUpperCase();
  
  if (isReply) {
    totalOut++; bump(perAddrOut, addr, cmd);
    if (!replyHexByAddr.has(addr)) replyHexByAddr.set(addr, []);
    if (replyHexByAddr.get(addr).length < 3) replyHexByAddr.get(addr).push(hex);
  } else {
    totalIn++; bump(perAddrIn, addr, cmd);
  }
  
  if (sampleFrames.length < 16) {
    sampleFrames.push({ src, dir: isReply ? 'TX' : 'RX', addr, cmd,
      name: isReply ? rN(cmd) : cN(cmd), hex: hex.substring(0, 40) });
  }
}

console.log(`[scan] Connecting to ${HOST} ...`);
const sock = io(HOST, { transports: ['websocket','polling'], reconnection: false });
sock.on('connect', () => console.log(`[scan] Connected. Capturing for ${DURATION_MS/1000}s ...`));
sock.on('connect_error', e => { console.error('[scan] Failed:', e.message); process.exit(1); });
sock.on('wire-frame',     p => { eventCounts.set('wire-frame', (eventCounts.get('wire-frame')||0)+1); onFrame('osdpmgr', p); });
sock.on('emulator-frame', p => { eventCounts.set('emulator-frame', (eventCounts.get('emulator-frame')||0)+1); onFrame('emulator', p); });

const startTs = Date.now();
const prog = setInterval(() => {
  const addrs = Array.from(new Set([...perAddrIn.keys(),...perAddrOut.keys()])).sort((a,b)=>a-b).map(a=>'#'+a).join(' ');
  console.log(`[scan] +${Math.round((Date.now()-startTs)/1000)}s  in=${totalIn} out=${totalOut}  addrs: ${addrs||'(none)'}`);
}, 5000);

setTimeout(() => {
  clearInterval(prog); sock.disconnect();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  EMULATOR BUS SCAN REPORT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Duration: ${DURATION_MS/1000}s   Total: ↓${totalIn} ↑${totalOut}`);
  console.log(`Events:   ${Array.from(eventCounts.entries()).map(([k,v])=>`${k}×${v}`).join(', ')||'(none)'}`);
  console.log('');
  
  const allA = Array.from(new Set([...perAddrIn.keys(),...perAddrOut.keys()])).sort((a,b)=>a-b);
  if (!allA.length) {
    console.log('NO ADDRESSES OBSERVED. Check emulator status and event emission.');
  } else {
    console.log('Addr │ Polls↓ │ Reply↑ │ Commands Received                  │ Replies Sent');
    console.log('─────┼────────┼────────┼────────────────────────────────────┼────────────');
    for (const a of allA) {
      const i = perAddrIn.get(a)||{count:0,cmds:new Map()};
      const o = perAddrOut.get(a)||{count:0,cmds:new Map()};
      const cI = Array.from(i.cmds).map(([c,n])=>`${cN(c)}×${n}`).join(',')||'-';
      const cO = Array.from(o.cmds).map(([c,n])=>`${rN(c)}×${n}`).join(',')||'-';
      console.log(`#${String(a).padStart(3)} │${String(i.count).padStart(7)} │${String(o.count).padStart(7)} │ ${cI.padEnd(34).substring(0,34)} │ ${cO}`);
    }
  }
  
  console.log('\nSample frames (first 16):');
  for (const s of sampleFrames) console.log(`  ${s.dir} #${String(s.addr).padStart(2)} ${s.name.padEnd(7)} ${s.hex}  [${s.src}]`);
  
  console.log('\nReply hex samples by address (first 3 each):');
  for (const [a, hexes] of replyHexByAddr) {
    console.log(`  #${a}:`);
    hexes.forEach(h => console.log(`    ${h}`));
  }
  
  console.log('\n── Address 11 diagnosis ──');
  const i11 = perAddrIn.get(11), o11 = perAddrOut.get(11);
  if (!i11) console.log('  ⚠ Not polled. IC2 not asking for addr 11 in this window.');
  else if (!o11 || o11.count === 0) {
    console.log(`  ✗ ${i11.count} polls received, 0 replies sent.`);
    console.log(`    Commands seen: ${Array.from(i11.cmds).map(([c,n])=>`${cN(c)}×${n}`).join(', ')}`);
  } else {
    console.log(`  ✓ ${i11.count} polls, ${o11.count} replies. Reply rate ${Math.round(100*o11.count/i11.count)}%.`);
    if (i11.cmds.has(0x61) && !i11.cmds.has(0x60)) {
      console.log('  ⚠ IC2 STILL stuck on osdp_ID — our PDID reply may be malformed or rejected.');
    }
  }
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(0);
}, DURATION_MS);
