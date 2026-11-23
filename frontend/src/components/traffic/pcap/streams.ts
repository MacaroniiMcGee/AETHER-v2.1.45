// AETHER_TRAFFIC (TRAFFIC-3) — follow a conversation: TCP reassembly, HTTP/RTSP requests + responses.
import type { Capture, Conversation } from './parse';

export interface StreamMessage { fromA: boolean; ts: number; data: Uint8Array; pkts: number[]; gapBefore: number }
export interface Followed {
  conv: Conversation; messages: StreamMessage[]; aBytes: Uint8Array; bBytes: Uint8Array;
  gaps: number; retransmits: number; exchanges: Exchange[];
  ws: { client: WsFrame[]; server: WsFrame[]; clientIsA: boolean; skipped: [number, number]; afterUpgrade: boolean } | null;
}
export interface HttpMsg {
  first: string; headers: [string, string][]; body: Uint8Array; bodyComplete: boolean; ts: number;
  method?: string; target?: string; status?: number; reason?: string; proto: 'HTTP' | 'RTSP';
}
export interface Exchange { request?: HttpMsg; response?: HttpMsg }

const cat = (parts: Uint8Array[]) => { const n = parts.reduce((a, b) => a + b.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export function follow(cap: Capture, convIndex: number): Followed {
  const conv = cap.conversations[convIndex];
  const messages: StreamMessage[] = [];
  const next: Record<'a' | 'b', number | null> = { a: null, b: null };
  const aParts: Uint8Array[] = [], bParts: Uint8Array[] = [];
  const marks: Record<'a' | 'b', { off: number; ts: number }[]> = { a: [], b: [] };
  const off = { a: 0, b: 0 };
  let gaps = 0, retransmits = 0;
  for (const i of conv.pkts) {
    const pk = cap.packets[i];
    const fromA = pk.src === conv.a && pk.sport === conv.ap;
    const side = fromA ? 'a' : 'b';
    let data = pk.data.subarray(pk.payloadStart || 0, (pk.payloadStart || 0) + (pk.payloadLen || 0));
    let gap = 0;
    if (pk.tcp) {
      const { seq, flags } = pk.tcp;
      if (/SYN/.test(flags)) { next[side] = (seq + 1) >>> 0; if (!data.length) continue; }
      if (!data.length) continue;
      const exp = next[side];
      if (exp === null) next[side] = seq;
      else {
        const diff = (seq - exp) | 0;
        if (diff < 0) {                       // overlaps what we already have
          if (-diff >= data.length) { retransmits++; continue; }
          data = data.subarray(-diff);
        } else if (diff > 0) { gap = diff; gaps++; }
      }
      next[side] = ((pk.tcp.seq + (pk.payloadLen || 0)) >>> 0);
    } else if (!data.length) continue;
    marks[side].push({ off: off[side], ts: pk.ts });
    off[side] += data.length;
    (fromA ? aParts : bParts).push(data);
    const last = messages[messages.length - 1];
    if (pk.tcp && last && last.fromA === fromA && !gap) { last.data = cat([last.data, data]); last.pkts.push(pk.no); }
    else messages.push({ fromA, ts: pk.ts, data, pkts: [pk.no], gapBefore: gap });
  }
  const aBytes = cat(aParts), bBytes = cat(bParts);
  const tsAt = (side: 'a' | 'b', o: number) => { let t = marks[side][0]?.ts || conv.first; for (const m of marks[side]) { if (m.off <= o) t = m.ts; else break; } return t; };
  let exchanges: Exchange[] = [];
  if (conv.l4 === 'tcp') {
    // a = the side that opened the connection; if the capture started mid-way, try the other way round too
    let reqs = parseHttp(aBytes, false, o => tsAt('a', o)); let flip = false;
    if (!reqs.length) { const r2 = parseHttp(bBytes, false, o => tsAt('b', o)); if (r2.length) { reqs = r2; flip = true; } }
    const resps = flip ? parseHttp(aBytes, true, o => tsAt('a', o), reqs.map(r => r.method || '')) : parseHttp(bBytes, true, o => tsAt('b', o), reqs.map(r => r.method || ''));
    exchanges = pairHttp(reqs, resps);
  }
  // WebSocket: after a "101 Switching Protocols" in the capture, or recognised from the frames themselves
  let ws: Followed['ws'] = null;
  if (conv.l4 === 'tcp') {
    const up = exchanges.findIndex(x => x.response?.status === 101);
    if (up >= 0) {
      const after = (msgs: HttpMsg[], d: Uint8Array) => { let o = 0; for (const m of msgs) o = indexOf(d, CRLFCRLF, o) + 4 + m.body.length; return o; };
      const reqA = exchanges[up].request && aBytes.length && latin(aBytes.subarray(0, 8)).startsWith(exchanges[up].request!.first.slice(0, 8));
      const [cl, sv] = reqA ? [aBytes, bBytes] : [bBytes, aBytes];
      const cOff = after(exchanges.slice(0, up + 1).map(x => x.request!).filter(Boolean), cl);
      const sOff = after(exchanges.slice(0, up + 1).map(x => x.response!).filter(Boolean), sv);
      ws = { client: wsFrames(cl, cOff).frames, server: wsFrames(sv, sOff).frames, clientIsA: !!reqA, skipped: [0, 0], afterUpgrade: true };
    } else if (!exchanges.length) {
      const r = detectWs(aBytes, bBytes) || detectWs(bBytes, aBytes);
      if (r) {
        const clientIsA = !!detectWs(aBytes, bBytes);
        ws = { ...r, clientIsA, afterUpgrade: false };
      }
    }
  }
  return { conv, messages, aBytes, bBytes, gaps, retransmits, exchanges, ws };
}

const REQ = /^([A-Z_]+) (\S+) (HTTP\/1\.[01]|RTSP\/1\.0)$/;
const RESP = /^(HTTP\/1\.[01]|RTSP\/1\.0) (\d{3})(?: (.*))?$/;

function indexOf(d: Uint8Array, pat: number[], from: number) {
  outer: for (let i = from; i <= d.length - pat.length; i++) { for (let j = 0; j < pat.length; j++) if (d[i + j] !== pat[j]) continue outer; return i; }
  return -1;
}
const CRLFCRLF = [13, 10, 13, 10], CRLF = [13, 10];
const latin = (d: Uint8Array) => { let s = ''; for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]); return s; };

/** Requests (client side) or responses (server side) one after another in a byte stream. */
export function parseHttp(d: Uint8Array, responses: boolean, tsAt: (off: number) => number, reqMethods: string[] = []): HttpMsg[] {
  const out: HttpMsg[] = [];
  let p = 0;
  while (p < d.length) {
    const he = indexOf(d, CRLFCRLF, p);
    if (he < 0 || he - p > 64 * 1024) break;
    const lines = latin(d.subarray(p, he)).split('\r\n');
    const m = responses ? RESP.exec(lines[0]) : REQ.exec(lines[0]);
    if (!m) break;
    const headers = lines.slice(1).map(l => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string] : null; }).filter(Boolean) as [string, string][];
    const h = (k: string) => headers.find(x => x[0].toLowerCase() === k)?.[1];
    const msg: HttpMsg = { first: lines[0], headers, body: new Uint8Array(), bodyComplete: true, ts: tsAt(p), proto: lines[0].includes('RTSP') ? 'RTSP' : 'HTTP' };
    if (responses) { msg.status = Number(m[2]); msg.reason = m[3] || ''; } else { msg.method = m[1]; msg.target = m[2]; }
    let b = he + 4;
    const cl = h('content-length');
    const noBody = responses && (msg.status! < 200 || msg.status === 204 || msg.status === 304 || reqMethods[out.length] === 'HEAD');
    if (noBody) { /* none */ }
    else if (/chunked/i.test(h('transfer-encoding') || '')) {
      const parts: Uint8Array[] = [];
      for (;;) {
        const le = indexOf(d, CRLF, b); if (le < 0) { msg.bodyComplete = false; b = d.length; break; }
        const n = parseInt(latin(d.subarray(b, le)).split(';')[0], 16);
        if (!Number.isFinite(n)) { msg.bodyComplete = false; b = d.length; break; }
        b = le + 2;
        if (n === 0) { const te = indexOf(d, CRLFCRLF, b - 2); b = te >= 0 ? te + 4 : d.length; break; }
        if (b + n > d.length) { parts.push(d.subarray(b)); msg.bodyComplete = false; b = d.length; break; }
        parts.push(d.subarray(b, b + n)); b += n + 2;
      }
      msg.body = cat(parts);
    } else if (cl !== undefined) {
      const n = Number(cl) || 0;
      msg.body = d.subarray(b, Math.min(d.length, b + n)); msg.bodyComplete = b + n <= d.length; b = Math.min(d.length, b + n);
    } else if (responses && msg.proto === 'HTTP') { msg.body = d.subarray(b); b = d.length; }   // until the connection closed
    out.push(msg);
    p = b;
  }
  return out;
}

function pairHttp(reqs: HttpMsg[], resps: HttpMsg[]): Exchange[] {
  const out: Exchange[] = [];
  const rs = resps.filter(r => !(r.status === 100));
  const n = Math.max(reqs.length, rs.length);
  for (let i = 0; i < n; i++) out.push({ request: reqs[i], response: rs[i] });
  return out.filter(x => x.request || x.response);
}

/** gzip / deflate / br bodies → bytes (browser + Node 18). */
export async function decodeBody(m: HttpMsg): Promise<{ data: Uint8Array; note?: string }> {
  const enc = (m.headers.find(x => x[0].toLowerCase() === 'content-encoding')?.[1] || '').toLowerCase();
  if (!enc || enc === 'identity' || !m.body.length) return { data: m.body };
  if (!m.bodyComplete) return { data: m.body, note: `compressed (${enc}) and not complete in the capture` };
  const fmt = enc === 'gzip' || enc === 'x-gzip' ? 'gzip' : enc === 'deflate' ? 'deflate' : null;
  if (!fmt || typeof DecompressionStream === 'undefined') return { data: m.body, note: `compressed (${enc}) — not unpacked here` };
  try {
    const s = new Blob([m.body as BlobPart]).stream().pipeThrough(new DecompressionStream(fmt as CompressionFormat));
    return { data: new Uint8Array(await new Response(s).arrayBuffer()), note: `unpacked from ${enc}` };
  } catch { return { data: m.body, note: `compressed (${enc}) — could not unpack` }; }
}

// ── WebSocket frames (also when the upgrade happened before the capture started) ──
export interface WsFrame { fin: boolean; opcode: number; masked: boolean; payload: Uint8Array; offset: number; partial: boolean }
const OPS = new Set([0, 1, 2, 8, 9, 10]);
export const WS_OP: Record<number, string> = { 0: 'continuation', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

/** Frames one after another from `start`; stops at the first thing that isn't a frame. */
export function wsFrames(d: Uint8Array, start = 0, max = 100000): { frames: WsFrame[]; end: number } {
  const frames: WsFrame[] = []; let p = start;
  while (p + 2 <= d.length && frames.length < max) {
    const b0 = d[p], b1 = d[p + 1];
    const op = b0 & 15;
    if ((b0 & 0x70) || !OPS.has(op)) break;
    let len = b1 & 127, h = 2;
    if (len === 126) { if (p + 4 > d.length) break; len = (d[p + 2] << 8) | d[p + 3]; h = 4; }
    else if (len === 127) { if (p + 10 > d.length) break; len = Number(new DataView(d.buffer, d.byteOffset + p + 2, 8).getBigUint64(0)); h = 10; if (len > 1 << 30) break; }
    if (op >= 8 && (len > 125 || !(b0 & 0x80))) break;          // control frames are short and final
    const masked = !!(b1 & 0x80);
    const ks = p + h; const ps = ks + (masked ? 4 : 0);
    const pe = Math.min(d.length, ps + len);
    const payload = new Uint8Array(Math.max(0, pe - ps));
    for (let i = 0; i < payload.length; i++) payload[i] = masked ? d[ps + i] ^ d[ks + (i & 3)] : d[ps + i];
    frames.push({ fin: !!(b0 & 0x80), opcode: op, masked, payload, offset: p, partial: ps + len > d.length });
    p = ps + len;
  }
  return { frames, end: Math.min(p, d.length) };
}

/** Find where frames start (a capture can begin in the middle of one) and check it really is WebSocket. */
export function detectWs(client: Uint8Array, server: Uint8Array): { client: WsFrame[]; server: WsFrame[]; skipped: [number, number] } | null {
  const tryFrom = (d: Uint8Array, wantMask: boolean) => {
    for (let s = 0; s < Math.min(d.length, 64 * 1024); s++) {
      const r = wsFrames(d, s, 6);
      const ok = r.frames.length >= Math.min(3, r.frames.length + (r.end >= d.length ? 0 : 3)) && r.frames.length > 0 && r.frames.every(f => f.masked === wantMask);
      if (ok && (r.frames.length >= 3 || r.end >= d.length)) return s;
    }
    return -1;
  };
  if (server.length < 2 && client.length < 2) return null;
  const cs = client.length ? tryFrom(client, true) : 0, ss = server.length ? tryFrom(server, false) : 0;
  if (cs < 0 || ss < 0) return null;
  const c = client.length ? wsFrames(client, cs).frames : [], s = server.length ? wsFrames(server, ss).frames : [];
  if (!c.length && !s.length) return null;
  return { client: c, server: s, skipped: [cs, ss] };
}

/** What is inside a WebSocket message: RTSP text, interleaved RTP ($), JSON, text or binary. */
export function wsInside(p: Uint8Array): string {
  if (!p.length) return 'empty';
  const head = latin(p.subarray(0, 200));
  if (/^(OPTIONS|DESCRIBE|SETUP|PLAY|PAUSE|TEARDOWN|GET_PARAMETER|SET_PARAMETER) rtsp:\/\//.test(head) || /^RTSP\/1\.0 \d{3}/.test(head)) return 'RTSP ' + head.split('\r\n')[0];
  if (p[0] === 0x24 && p.length >= 4) {
    const ch = p[1], n = (p[2] << 8) | p[3];
    if (p.length >= 16 && (p[4] >> 6) === 2) {
      const pt = p[5] & 0x7f;
      if (p[5] >= 200 && p[5] <= 204) return `RTCP (channel ${ch})`;
      return `RTP channel ${ch} · payload type ${pt} · seq ${(p[6] << 8) | p[7]}${p[5] & 0x80 ? ' · end of frame' : ''} · ${n} B`;
    }
    return `interleaved channel ${ch} · ${n} B`;
  }
  if (/^\s*[{[]/.test(head)) return 'JSON';
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(head)) return 'text';
  return 'binary';
}

/** After parsing: recognise WebSocket connections (also mid-stream) and label their packets. */
export function enrich(cap: Capture, maxBytes = 20 * 1024 * 1024) {
  for (const c of cap.conversations) {
    if (c.l4 !== 'tcp' || c.bytes > maxBytes) continue;
    if (!['TCP', 'HTTP'].includes(c.app) && !/^\d/.test(c.app)) continue;
    const fl = follow(cap, c.index);
    if (!fl.ws || (!fl.ws.client.length && !fl.ws.server.length)) continue;
    const all = [...fl.ws.client, ...fl.ws.server];
    const rtsp = all.some(f => /^(RTSP|RTP|RTCP)/.test(wsInside(f.payload)));
    const label = rtsp ? 'WebSocket (RTSP/RTP video)' : 'WebSocket';
    const old = c.app; c.app = label;
    for (const ip of [c.a, c.b]) { const h = cap.hosts.find(x => x.ip === ip); if (h) h.protos.add(label); }
    for (const i of c.pkts) {
      const pk = cap.packets[i];
      if (!pk.payloadLen || (pk.proto === 'HTTP' && fl.ws.afterUpgrade)) continue;
      const pr = cap.protocols.find(p => p.name === pk.proto); if (pr) { pr.packets--; pr.bytes -= pk.len; }
      let np = cap.protocols.find(p => p.name === 'WebSocket'); if (!np) { np = { name: 'WebSocket', packets: 0, bytes: 0 }; cap.protocols.push(np); }
      np.packets++; np.bytes += pk.len;
      pk.proto = 'WebSocket'; pk.info = `${pk.sport} → ${pk.dport} · ${label} · ${pk.payloadLen} B`;
    }
    void old;
  }
  cap.protocols = cap.protocols.filter(p => p.packets > 0).sort((a, b) => b.packets - a.packets);
  return cap;
}
