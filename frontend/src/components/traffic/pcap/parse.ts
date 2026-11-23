// AETHER_TRAFFIC (TRAFFIC-3) — packet capture reader: pcap / pcapng → decoded packets.
// Runs in the browser (no Pi needed); also runs under Node for tests.
//
// Formats : pcap (LE/BE, µs/ns), pcapng (SHB, IDB, EPB, SPB, OPB; several interfaces).
// Links   : Ethernet (+802.1Q), Linux cooked v1/v2, raw IPv4/IPv6, BSD loopback.
// Decodes : Ethernet, VLAN, LLC/SNAP, STP, CDP, LLDP, Allied Telesis loop detection, ARP,
//           IPv4, IPv6 (+ext headers), ICMP, ICMPv6/NDP/MLD, IGMP, TCP, UDP,
//           DNS / mDNS / LLMNR / NBNS, DHCP, NTP, SSDP, WS-Discovery (ONVIF), syslog, SNMP (label),
//           TLS (record types, ClientHello SNI/ALPN, ServerHello), HTTP, RTSP, RTP/RTCP (heuristic), SSH, MQTT.

export interface Field { k: string; v: string }
export interface Layer { name: string; start: number; end: number; fields: Field[] }
export interface Packet {
  no: number; ts: number;             // ms since epoch (fractional)
  len: number; caplen: number; iface: number;
  data: Uint8Array;                   // captured bytes
  srcMac?: string; dstMac?: string;
  src: string; dst: string;           // addresses shown in the list (IP if any, else MAC)
  sport?: number; dport?: number;
  proto: string;                      // top-most protocol name
  info: string;
  layers: Layer[];
  l4?: 'tcp' | 'udp';
  stream?: number;                    // conversation index (tcp/udp)
  tcp?: { seq: number; ack: number; flags: string; win: number; payloadStart: number; payloadLen: number };
  payloadStart?: number; payloadLen?: number;
  bad?: string;                       // decode problem (truncated, etc.)
}
export interface Conversation {
  index: number; l4: 'tcp' | 'udp'; a: string; ap: number; b: string; bp: number;   // a = side that spoke first
  packets: number; bytes: number; first: number; last: number; app: string; aToB: number; bToA: number;
  pkts: number[];                     // packet indexes (0-based)
}
export interface Host {
  ip?: string; mac?: string; names: Set<string>; vendor?: string; info: Set<string>;
  packetsOut: number; packetsIn: number; bytesOut: number; bytesIn: number; protos: Set<string>;
}
export interface Capture {
  format: string; link: string; packets: Packet[]; conversations: Conversation[];
  hosts: Host[]; protocols: { name: string; packets: number; bytes: number }[];
  first: number; last: number; bytes: number; warnings: string[];
}

// ── small helpers ─────────────────────────────────────────────────────────
const hx = (n: number, w = 2) => n.toString(16).padStart(w, '0');
export const mac = (d: Uint8Array, o: number) => Array.from(d.subarray(o, o + 6), b => hx(b)).join(':');
const ip4 = (d: Uint8Array, o: number) => `${d[o]}.${d[o + 1]}.${d[o + 2]}.${d[o + 3]}`;
function ip6(d: Uint8Array, o: number) {
  const g: string[] = [];
  for (let i = 0; i < 16; i += 2) g.push(((d[o + i] << 8) | d[o + i + 1]).toString(16));
  // compress the longest run of zeros
  let bs = -1, bl = 0;
  for (let i = 0; i < 8;) { if (g[i] === '0') { let j = i; while (j < 8 && g[j] === '0') j++; if (j - i > bl) { bs = i; bl = j - i; } i = j; } else i++; }
  if (bl > 1) return `${g.slice(0, bs).join(':')}::${g.slice(bs + bl).join(':')}`;
  return g.join(':');
}
const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];
const u32 = (d: Uint8Array, o: number) => ((d[o] << 24) >>> 0) + ((d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]);
const ascii = (d: Uint8Array, o: number, n: number) => { let s = ''; for (let i = o; i < Math.min(d.length, o + n); i++) s += d[i] >= 32 && d[i] < 127 ? String.fromCharCode(d[i]) : '.'; return s; };
const text = (d: Uint8Array, o: number, n: number) => new TextDecoder('utf-8', { fatal: false }).decode(d.subarray(o, Math.min(d.length, o + n)));
const F = (k: string, v: string | number): Field => ({ k, v: String(v) });

export const VENDORS: Record<string, string> = {
  '00:09:18': 'Hanwha', '00:16:6c': 'Hanwha', 'e4:30:22': 'Hanwha', '00:1d:96': 'Hanwha', 'cc:9b:5c': 'Hanwha',
  '00:00:f4': 'Allied Telesis', 'e0:1a:ea': 'Allied Telesis', '00:1a:eb': 'Allied Telesis', 'ec:cd:6d': 'Allied Telesis', '00:15:77': 'Allied Telesis',
  'b8:27:eb': 'Raspberry Pi', 'dc:a6:32': 'Raspberry Pi', 'd8:3a:dd': 'Raspberry Pi', '2c:cf:67': 'Raspberry Pi', 'e4:5f:01': 'Raspberry Pi', '28:cd:c1': 'Raspberry Pi',
  '00:0c:29': 'VMware', '00:50:56': 'VMware', '08:00:27': 'VirtualBox', '00:15:5d': 'Hyper-V',
  '00:40:8c': 'Axis', 'ac:cc:8e': 'Axis', 'b8:a4:4f': 'Axis', 'bc:ad:28': 'Hikvision', '44:19:b6': 'Hikvision', '4c:bd:8f': 'Hikvision',
  '00:1b:21': 'Intel', '3c:52:82': 'HP', 'f8:bc:12': 'Dell', '00:14:22': 'Dell', '00:1e:c9': 'Dell',
};
export const vendorOf = (m?: string) => (m ? VENDORS[m.slice(0, 8).toLowerCase()] : undefined);

// ── file formats ──────────────────────────────────────────────────────────
interface Raw { ts: number; len: number; data: Uint8Array; link: number; iface: number }
const LINKS: Record<number, string> = { 0: 'BSD loopback', 1: 'Ethernet', 101: 'Raw IP', 113: 'Linux cooked', 228: 'Raw IPv4', 229: 'Raw IPv6', 276: 'Linux cooked v2' };

export function readFile(buf: ArrayBuffer): { format: string; frames: Raw[]; links: number[]; warnings: string[] } {
  const d = new Uint8Array(buf);
  const v = new DataView(buf);
  const warnings: string[] = [];
  if (d.length < 24) throw new Error('This file is too short to be a packet capture');
  const m = v.getUint32(0, true);
  const frames: Raw[] = [];
  // classic pcap
  const PCAP: Record<number, [boolean, number]> = { 0xa1b2c3d4: [true, 1e-3], 0xd4c3b2a1: [false, 1e-3], 0xa1b23c4d: [true, 1e-6], 0x4d3cb2a1: [false, 1e-6] };
  if (PCAP[m]) {
    const [le, scale] = PCAP[m];
    const link = v.getUint32(20, le) & 0xffff;
    let o = 24;
    while (o + 16 <= d.length) {
      const sec = v.getUint32(o, le), sub = v.getUint32(o + 4, le), incl = v.getUint32(o + 8, le), orig = v.getUint32(o + 12, le);
      if (o + 16 + incl > d.length) { warnings.push(`The file ends in the middle of packet ${frames.length + 1} (cut short)`); break; }
      frames.push({ ts: sec * 1000 + sub * scale, len: orig, data: d.subarray(o + 16, o + 16 + incl), link, iface: 0 });
      o += 16 + incl;
    }
    return { format: `pcap${scale === 1e-6 ? ' (ns)' : ''}`, frames, links: [link], warnings };
  }
  // pcapng
  if (m === 0x0a0d0d0a) {
    let o = 0; let le = true;
    let ifaces: { link: number; tsres: number }[] = [];
    while (o + 12 <= d.length) {
      let type = v.getUint32(o, le);
      if (type === 0x0a0d0d0a) {   // section header: byte order from the magic
        const bom = v.getUint32(o + 8, true);
        le = bom === 0x1a2b3c4d; if (!le && bom !== 0x4d3c2b1a) throw new Error('pcapng: bad byte-order mark');
        ifaces = []; type = 0x0a0d0d0a;
      }
      const blen = v.getUint32(o + 4, le);
      if (blen < 12 || o + blen > d.length) { warnings.push('pcapng: the file ends in the middle of a block'); break; }
      const b = o + 8;
      if (type === 1) {           // interface description
        const link = v.getUint16(b, le);
        let tsres = 1e-6;
        let p = b + 8;
        while (p + 4 <= o + blen - 4) {
          const code = v.getUint16(p, le), olen = v.getUint16(p + 2, le);
          if (code === 0) break;
          if (code === 9 && olen >= 1) { const r = d[p + 4]; tsres = r & 0x80 ? Math.pow(2, -(r & 0x7f)) : Math.pow(10, -r); }
          p += 4 + ((olen + 3) & ~3);
        }
        ifaces.push({ link, tsres });
      } else if (type === 6 || type === 3 || type === 2) {
        let iface = 0, ts = 0, cap: number, orig: number, start: number;
        if (type === 6 || type === 2) {     // enhanced / obsolete packet
          iface = type === 6 ? v.getUint32(b, le) : v.getUint16(b, le);
          const hi = v.getUint32(b + 4, le), lo = v.getUint32(b + 8, le);
          const res = (ifaces[iface] || { tsres: 1e-6 }).tsres;
          ts = (hi * 4294967296 + lo) * res * 1000;
          cap = v.getUint32(b + 12, le); orig = v.getUint32(b + 16, le); start = b + 20;
        } else {                            // simple packet
          orig = v.getUint32(b, le); cap = Math.min(orig, blen - 16); start = b + 4;
        }
        const ifc = ifaces[iface];
        if (!ifc) warnings.push(`pcapng: packet for unknown interface ${iface}`);
        else frames.push({ ts, len: orig, data: d.subarray(start, start + cap), link: ifc.link, iface });
      }
      o += blen;
    }
    return { format: 'pcapng', frames, links: [...new Set(ifaces.map(i => i.link))], warnings };
  }
  throw new Error('Not a pcap or pcapng file');
}

// ── per-packet decoding ───────────────────────────────────────────────────
const ETYPES: Record<number, string> = { 0x0800: 'IPv4', 0x0806: 'ARP', 0x86dd: 'IPv6', 0x88cc: 'LLDP', 0x8100: '802.1Q', 0x88a8: '802.1ad', 0x8809: 'Slow protocols', 0x888e: 'EAPOL', 0x8892: 'PROFINET', 0x88f7: 'PTP', 0x9000: 'Loopback' };
const IPPROTO: Record<number, string> = { 1: 'ICMP', 2: 'IGMP', 6: 'TCP', 17: 'UDP', 58: 'ICMPv6', 47: 'GRE', 50: 'ESP', 89: 'OSPF', 103: 'PIM', 112: 'VRRP' };
const UDP_APPS: Record<number, string> = { 53: 'DNS', 5353: 'mDNS', 5355: 'LLMNR', 137: 'NBNS', 138: 'NetBIOS', 67: 'DHCP', 68: 'DHCP', 546: 'DHCPv6', 547: 'DHCPv6', 123: 'NTP', 1900: 'SSDP', 3702: 'WS-Discovery', 514: 'Syslog', 161: 'SNMP', 162: 'SNMP trap', 69: 'TFTP', 17500: 'Dropbox LAN', 5004: 'RTP', 5005: 'RTCP', 4789: 'VXLAN', 6343: 'sFlow', 2055: 'NetFlow', 3478: 'STUN', 1812: 'RADIUS', 1813: 'RADIUS' };
const TCP_PORTS: Record<number, string> = { 22: 'SSH', 23: 'Telnet', 21: 'FTP', 25: 'SMTP', 554: 'RTSP', 1883: 'MQTT', 8883: 'MQTT/TLS', 445: 'SMB', 139: 'SMB', 3389: 'RDP', 5900: 'VNC', 5901: 'VNC', 502: 'Modbus', 3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 4520: 'SUNAPI event', 7681: 'ttyd' };
const HTTP_START = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE) \S+ HTTP\/1\.[01]\r?\n|^HTTP\/1\.[01] \d{3}/;
const RTSP_START = /^(OPTIONS|DESCRIBE|SETUP|PLAY|PAUSE|TEARDOWN|GET_PARAMETER|SET_PARAMETER|ANNOUNCE|RECORD) rtsp:\/\/|^RTSP\/1\.0 \d{3}/;
const TCP_FLAGS = ['FIN', 'SYN', 'RST', 'PSH', 'ACK', 'URG', 'ECE', 'CWR'];

/** DNS name with compression pointers. */
function dnsName(d: Uint8Array, o: number, base: number): [string, number] {
  const parts: string[] = []; let p = o; let next = -1; let hops = 0;
  while (p < d.length && hops < 40) {
    const n = d[p];
    if (n === 0) { p++; break; }
    if ((n & 0xc0) === 0xc0) { if (next < 0) next = p + 2; p = base + (((n & 0x3f) << 8) | d[p + 1]); hops++; continue; }
    parts.push(text(d, p + 1, n)); p += 1 + n;
  }
  return [parts.join('.') || '<root>', next >= 0 ? next : p];
}
const DNS_TYPES: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 13: 'HINFO', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 41: 'OPT', 47: 'NSEC', 255: 'ANY', 65: 'HTTPS', 64: 'SVCB' };
export interface DnsRR { name: string; type: string; ttl?: number; data: string }
function dns(d: Uint8Array, o: number, end: number, tag: string): { layer: Layer; info: string; answers: DnsRR[]; questions: DnsRR[] } {
  const fields: Field[] = [];
  const id = u16(d, o), flags = u16(d, o + 2);
  const qd = u16(d, o + 4), an = u16(d, o + 6), ns = u16(d, o + 8), ar = u16(d, o + 10);
  const isResp = !!(flags & 0x8000); const rcode = flags & 0xf;
  fields.push(F('ID', `0x${hx(id, 4)}`), F('Kind', isResp ? `response${rcode ? ` (error ${rcode})` : ''}` : 'query'), F('Counts', `${qd} question, ${an} answer, ${ns} authority, ${ar} additional`));
  let p = o + 12; const questions: DnsRR[] = []; const answers: DnsRR[] = [];
  try {
    for (let i = 0; i < qd && p < end; i++) {
      const [name, np] = dnsName(d, p, o); p = np;
      const t = u16(d, p); const cls = u16(d, p + 2); p += 4;
      questions.push({ name, type: DNS_TYPES[t] || `type ${t}`, data: cls & 0x8000 ? 'unicast reply wanted' : '' });
      fields.push(F('Question', `${DNS_TYPES[t] || t} ${name}`));
    }
    for (let i = 0; i < an + ns + ar && p < end; i++) {
      const [name, np] = dnsName(d, p, o); p = np;
      const t = u16(d, p), ttl = u32(d, p + 4), rl = u16(d, p + 8); p += 10;
      let val = '';
      if (t === 1 && rl === 4) val = ip4(d, p);
      else if (t === 28 && rl === 16) val = ip6(d, p);
      else if (t === 12 || t === 5 || t === 2) val = dnsName(d, p, o)[0];
      else if (t === 33) val = `${dnsName(d, p + 6, o)[0]}:${u16(d, p + 4)}`;
      else if (t === 16) { const xs: string[] = []; let q = p; while (q < p + rl) { const n = d[q]; xs.push(text(d, q + 1, n)); q += 1 + n; } val = xs.join(' | '); }
      else if (t === 41) val = `EDNS, udp ${u16(d, p - 8)}`;
      else val = `${rl} bytes`;
      const rr = { name, type: DNS_TYPES[t] || `type ${t}`, ttl, data: val };
      if (i < an) answers.push(rr);
      if (t !== 41) fields.push(F(i < an ? 'Answer' : i < an + ns ? 'Authority' : 'Additional', `${rr.type} ${name} → ${val}`));
      p += rl;
    }
  } catch { fields.push(F('Note', 'cut short')); }
  const q = questions.map(x => `${x.type} ${x.name}`).join(', ');
  const a = answers.slice(0, 3).map(x => `${x.type} ${x.data}`).join(', ');
  const info = isResp ? `response ${q ? q + ' ' : ''}${a ? '→ ' + a : rcode ? `error ${rcode}` : ''}${answers.length > 3 ? ` +${answers.length - 3}` : ''}` : `query ${q}`;
  return { layer: { name: tag, start: o, end, fields }, info: `${info}`.trim(), answers, questions };
}

function dhcp(d: Uint8Array, o: number, end: number) {
  const fields: Field[] = [];
  const op = d[o]; const xid = u32(d, o + 4);
  const ci = ip4(d, o + 12), yi = ip4(d, o + 16), chaddr = mac(d, o + 28);
  fields.push(F('Op', op === 1 ? 'request (client)' : 'reply (server)'), F('Transaction', `0x${hx(xid, 8)}`), F('Client MAC', chaddr));
  if (ci !== '0.0.0.0') fields.push(F('Client IP', ci));
  if (yi !== '0.0.0.0') fields.push(F('Offered IP', yi));
  const TYPES = ['', 'Discover', 'Offer', 'Request', 'Decline', 'ACK', 'NAK', 'Release', 'Inform'];
  let type = ''; let host = ''; let vendor = ''; let req = '';
  let p = o + 240;
  if (u32(d, o + 236) === 0x63825363) {
    while (p < end && d[p] !== 255) {
      const code = d[p]; if (code === 0) { p++; continue; }
      const len = d[p + 1]; const v = p + 2;
      if (code === 53) type = TYPES[d[v]] || `type ${d[v]}`;
      else if (code === 12) host = text(d, v, len);
      else if (code === 60) vendor = text(d, v, len);
      else if (code === 50) req = ip4(d, v);
      else if (code === 54) fields.push(F('Server', ip4(d, v)));
      else if (code === 1) fields.push(F('Subnet mask', ip4(d, v)));
      else if (code === 3) fields.push(F('Router', ip4(d, v)));
      else if (code === 6) { const xs = []; for (let i = 0; i + 4 <= len; i += 4) xs.push(ip4(d, v + i)); fields.push(F('DNS servers', xs.join(', '))); }
      else if (code === 51) fields.push(F('Lease', `${u32(d, v)} s`));
      p = v + len;
    }
  }
  if (type) fields.unshift(F('Message', type));
  if (host) fields.push(F('Host name', host));
  if (vendor) fields.push(F('Vendor class', vendor));
  if (req) fields.push(F('Requested IP', req));
  return { layer: { name: 'DHCP', start: o, end, fields }, info: `${type || 'DHCP'} ${xid ? `0x${hx(xid, 8)}` : ''}${host ? ` · ${host}` : ''}${yi !== '0.0.0.0' ? ` → ${yi}` : ''}${vendor ? ` · ${vendor}` : ''}`, host, chaddr, vendor };
}

function httpHead(s: string) {
  const end = s.indexOf('\r\n\r\n');
  const head = (end >= 0 ? s.slice(0, end) : s).split('\r\n');
  return { first: head[0], headers: head.slice(1).map(l => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string] : null; }).filter(Boolean) as [string, string][], bodyAt: end >= 0 ? end + 4 : -1 };
}
const hget = (h: [string, string][], k: string) => h.find(x => x[0].toLowerCase() === k)?.[1] || '';

/** TLS records in one segment (best effort: a record split across segments is labelled as continuation). */
function tls(d: Uint8Array, o: number, end: number): { layer: Layer; info: string; sni?: string } | null {
  const ct = d[o];
  if (!(ct >= 20 && ct <= 23 && d[o + 1] === 3 && d[o + 2] <= 4)) return null;
  const fields: Field[] = []; const kinds: string[] = []; let sni: string | undefined;
  const VER: Record<number, string> = { 0x0300: 'SSL 3.0', 0x0301: 'TLS 1.0', 0x0302: 'TLS 1.1', 0x0303: 'TLS 1.2', 0x0304: 'TLS 1.3' };
  const HS: Record<number, string> = { 1: 'Client Hello', 2: 'Server Hello', 4: 'New Session Ticket', 11: 'Certificate', 12: 'Server Key Exchange', 13: 'Certificate Request', 14: 'Server Hello Done', 15: 'Certificate Verify', 16: 'Client Key Exchange', 20: 'Finished' };
  let p = o;
  while (p + 5 <= end) {
    const t = d[p], ver = u16(d, p + 1), len = u16(d, p + 3);
    if (!(t >= 20 && t <= 23 && d[p + 1] === 3)) { kinds.push('(continued)'); break; }
    const body = p + 5;
    if (t === 22 && body + 4 <= end) {
      const hs = d[body]; const name = HS[hs] || `Handshake ${hs}`;
      kinds.push(name); fields.push(F('Record', `${name} · ${VER[ver] || hx(ver, 4)} · ${len} B`));
      if ((hs === 1 || hs === 2) && body + 38 < end) {
        let q = body + 4 + 2 + 32;           // type,len(3) ver(2) random(32)
        const sidl = d[q]; q += 1 + sidl;
        if (hs === 1) { const csl = u16(d, q); q += 2 + csl; const cml = d[q]; q += 1 + cml; }
        else { fields.push(F('Cipher', `0x${hx(u16(d, q), 4)}`)); q += 3; }
        if (q + 2 <= end) {
          const extEnd = Math.min(end, q + 2 + u16(d, q)); q += 2;
          while (q + 4 <= extEnd) {
            const et = u16(d, q), el = u16(d, q + 2); const ev = q + 4;
            if (et === 0 && hs === 1) { sni = text(d, ev + 5, u16(d, ev + 3)); fields.push(F('Server name (SNI)', sni)); }
            if (et === 16) { const xs: string[] = []; let r = ev + 2; while (r < ev + el) { const n = d[r]; xs.push(text(d, r + 1, n)); r += 1 + n; } fields.push(F('ALPN', xs.join(', '))); }
            if (et === 43) { if (hs === 2) fields.push(F('Version chosen', VER[u16(d, ev)] || hx(u16(d, ev), 4))); else { const xs = []; for (let r = ev + 1; r < ev + 1 + d[ev]; r += 2) xs.push(VER[u16(d, r)] || ''); fields.push(F('Versions offered', xs.filter(Boolean).join(', '))); } }
            q = ev + el;
          }
        }
      }
    } else {
      const name = t === 23 ? 'Application Data' : t === 21 ? 'Alert' : 'Change Cipher Spec';
      kinds.push(name); fields.push(F('Record', `${name} · ${len} B${t === 23 ? ' (encrypted)' : ''}`));
    }
    p = body + len;
  }
  const uniq = [...new Set(kinds)];
  return { layer: { name: 'TLS', start: o, end, fields }, info: `${uniq.join(', ')}${sni ? ` · ${sni}` : ''}`, sni };
}

function lldp(d: Uint8Array, o: number, end: number) {
  const fields: Field[] = []; let name = ''; let mgmt = ''; let p = o;
  const CH = ['', 'chassis component', 'interface alias', 'port component', 'MAC', 'network address', 'interface name', 'local'];
  while (p + 2 <= end) {
    const t = d[p] >> 1, l = ((d[p] & 1) << 8) | d[p + 1]; const v = p + 2;
    if (t === 0) break;
    if (t === 1) fields.push(F('Chassis', d[v] === 4 ? mac(d, v + 1) : `${CH[d[v]] || ''} ${ascii(d, v + 1, l - 1)}`));
    else if (t === 2) fields.push(F('Port', d[v] === 3 ? mac(d, v + 1) : ascii(d, v + 1, l - 1)));
    else if (t === 3) fields.push(F('TTL', `${u16(d, v)} s`));
    else if (t === 4) fields.push(F('Port description', text(d, v, l)));
    else if (t === 5) { name = text(d, v, l); fields.push(F('System name', name)); }
    else if (t === 6) fields.push(F('System description', text(d, v, l)));
    else if (t === 7) fields.push(F('Capabilities', `0x${hx(u16(d, v), 4)}`));
    else if (t === 8 && d[v + 1] === 1) { mgmt = ip4(d, v + 2); fields.push(F('Management address', mgmt)); }
    p = v + l;
  }
  return { layer: { name: 'LLDP', start: o, end, fields }, name, mgmt };
}

function cdp(d: Uint8Array, o: number, end: number) {
  const fields: Field[] = [F('Version', d[o]), F('TTL', `${d[o + 1]} s`)]; let name = ''; let addr = '';
  let p = o + 4;
  const T: Record<number, string> = { 1: 'Device ID', 3: 'Port ID', 5: 'Software version', 6: 'Platform', 10: 'Native VLAN', 11: 'Duplex' };
  while (p + 4 <= end) {
    const t = u16(d, p), l = u16(d, p + 2); if (l < 4) break; const v = p + 4, n = l - 4;
    if (t === 1) name = text(d, v, n);
    if (t === 2 && n >= 13 && d[v + 4] === 1 && d[v + 6] === 0xcc) { addr = ip4(d, v + 9); fields.push(F('Address', addr)); }
    else if (T[t]) fields.push(F(T[t], t === 10 ? String(u16(d, v)) : t === 11 ? (d[v] ? 'full' : 'half') : text(d, v, n).replace(/\s+/g, ' ').trim()));
    p += l;
  }
  return { layer: { name: 'CDP', start: o, end, fields }, name, addr };
}

function decode(raw: Raw, no: number): Packet {
  const d = raw.data;
  const pk: Packet = { no, ts: raw.ts, len: raw.len, caplen: d.length, iface: raw.iface, data: d, src: '', dst: '', proto: '?', info: '', layers: [] };
  const L = (name: string, start: number, end: number, fields: Field[]) => { pk.layers.push({ name, start, end: Math.min(end, d.length), fields }); };
  try {
    let o = 0; let etype = -1;
    const link = raw.link;
    if (link === 1) {
      if (d.length < 14) throw new Error('short Ethernet frame');
      pk.dstMac = mac(d, 0); pk.srcMac = mac(d, 6); etype = u16(d, 12); o = 14;
      const f = [F('Destination', `${pk.dstMac}${vendorOf(pk.dstMac) ? ` (${vendorOf(pk.dstMac)})` : ''}`), F('Source', `${pk.srcMac}${vendorOf(pk.srcMac) ? ` (${vendorOf(pk.srcMac)})` : ''}`)];
      while (etype === 0x8100 || etype === 0x88a8) { f.push(F('VLAN', `${u16(d, o) & 0xfff} (priority ${d[o] >> 5})`)); etype = u16(d, o + 2); o += 4; }
      f.push(F('Type', etype <= 1500 ? `802.3 length ${etype}` : `${ETYPES[etype] || '0x' + hx(etype, 4)}`));
      L('Ethernet', 0, o, f);
      pk.src = pk.srcMac; pk.dst = pk.dstMac; pk.proto = 'Ethernet'; pk.info = etype <= 1500 ? '802.3' : ETYPES[etype] || `type 0x${hx(etype, 4)}`;
    } else if (link === 113) { etype = u16(d, 14); o = 16; pk.srcMac = mac(d, 6); L('Linux cooked', 0, 16, [F('Type', ETYPES[etype] || hx(etype, 4))]); }
    else if (link === 276) { etype = u16(d, 0); o = 20; pk.srcMac = mac(d, 12); L('Linux cooked v2', 0, 20, [F('Type', ETYPES[etype] || hx(etype, 4))]); }
    else if (link === 101 || link === 228 || link === 229) etype = (d[0] >> 4) === 6 ? 0x86dd : 0x0800;
    else if (link === 0) { const fam = new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true); etype = fam === 2 ? 0x0800 : 0x86dd; o = 4; L('Loopback', 0, 4, [F('Family', fam)]); }
    else { pk.proto = LINKS[link] || `link ${link}`; pk.info = 'link type not decoded'; return pk; }

    // ── below Ethernet: 802.3 / LLC ─────────────────────────────────
    if (etype >= 0 && etype <= 1500) {
      const dsap = d[o], ssap = d[o + 1], ctl = d[o + 2];
      const end = Math.min(d.length, o + etype);
      L('LLC', o, o + 3, [F('DSAP', `0x${hx(dsap)}`), F('SSAP', `0x${hx(ssap)}`), F('Control', `0x${hx(ctl)}`)]);
      if (dsap === 0x42) {
        const ver = d[o + 5], type = d[o + 6], flags = d[o + 7];
        const root = `${u16(d, o + 8) & 0xf000 ? (u16(d, o + 8) >> 12) * 4096 : u16(d, o + 8)}/${mac(d, o + 10)}`;
        L('STP', o + 3, end, [F('Version', ver === 2 ? 'RSTP' : ver === 3 ? 'MSTP' : 'STP'), F('Type', type === 0x80 ? 'TCN' : 'BPDU'), F('Root', root), F('Root path cost', u32(d, o + 16)), F('Bridge', `${u16(d, o + 20)}/${mac(d, o + 22)}`), F('Port', `0x${hx(u16(d, o + 28), 4)}`), F('Flags', `0x${hx(flags)}${flags & 1 ? ' topology change' : ''}`)]);
        pk.proto = ver === 2 ? 'RSTP' : 'STP'; pk.info = `Root ${root}  Cost ${u32(d, o + 16)}  Port 0x${hx(u16(d, o + 28), 4)}`;
      } else if (dsap === 0xaa && ctl === 3) {
        const oui = (d[o + 3] << 16) | (d[o + 4] << 8) | d[o + 5]; const pid = u16(d, o + 6);
        if (oui === 0x00000c && pid === 0x2000) { const c = cdp(d, o + 8, end); pk.layers.push(c.layer); pk.proto = 'CDP'; pk.info = `Device ${c.name}${c.addr ? ` · ${c.addr}` : ''}`; (pk as Packet & { _name?: string })._name = c.name; }
        else { pk.proto = 'SNAP'; pk.info = `OUI ${hx(oui, 6)} PID 0x${hx(pid, 4)}`; }
      } else {
        const t = ascii(d, o + 3, end - o - 3);
        if (/LDF for Allied Telesis/.test(t)) {
          const sentBy = /sent by ([\w/.-]+)/.exec(t)?.[1] || '';
          L('Allied Telesis loop detection', o + 3, end, [F('Meaning', 'The switch sends these to find loops; harmless'), F('Sent by', sentBy)]);
          pk.proto = 'AT-LDF'; pk.info = `Loop detection frame from ${sentBy || 'Allied Telesis switch'}`;
        } else { pk.proto = 'LLC'; pk.info = `DSAP 0x${hx(dsap)} SSAP 0x${hx(ssap)}`; }
      }
      return pk;
    }
    if (etype === 0x88cc) { const l = lldp(d, o, d.length); pk.layers.push(l.layer); pk.proto = 'LLDP'; pk.info = `${l.name || 'neighbour'}${l.mgmt ? ` · ${l.mgmt}` : ''}`; (pk as Packet & { _name?: string })._name = l.name; return pk; }
    if (etype === 0x0806) {
      const op = u16(d, o + 6); const sha = mac(d, o + 8), spa = ip4(d, o + 14), tha = mac(d, o + 18), tpa = ip4(d, o + 24);
      L('ARP', o, o + 28, [F('Operation', op === 1 ? 'request' : op === 2 ? 'reply' : op), F('Sender', `${spa} at ${sha}`), F('Target', `${tpa}${op === 2 ? ` at ${tha}` : ''}`)]);
      pk.proto = 'ARP';
      pk.info = op === 1 ? (spa === tpa ? `Gratuitous ARP for ${spa}` : spa === '0.0.0.0' ? `Probe: is ${tpa} in use?` : `Who has ${tpa}? Tell ${spa}`) : `${spa} is at ${sha}`;
      return pk;
    }

    // ── IP ───────────────────────────────────────────────────────────
    let proto = -1; let ipEnd = d.length; let src = '', dst = '';
    if (etype === 0x0800) {
      const ihl = (d[o] & 15) * 4, tot = u16(d, o + 2), ttl = d[o + 8]; proto = d[o + 9];
      const frag = u16(d, o + 6); src = ip4(d, o + 12); dst = ip4(d, o + 16);
      ipEnd = Math.min(d.length, o + tot);
      L('IPv4', o, o + ihl, [F('Source', src), F('Destination', dst), F('Protocol', IPPROTO[proto] || proto), F('TTL', ttl), F('Length', tot), F('ID', `0x${hx(u16(d, o + 4), 4)}`), ...(frag & 0x3fff ? [F('Fragment', `offset ${(frag & 0x1fff) * 8}${frag & 0x2000 ? ', more' : ''}`)] : []), F('DSCP', d[o + 1] >> 2)]);
      if (frag & 0x1fff) { pk.src = src; pk.dst = dst; pk.proto = 'IPv4'; pk.info = `Fragment (${IPPROTO[proto] || proto})`; return pk; }
      o += ihl;
    } else if (etype === 0x86dd) {
      const plen = u16(d, o + 4); proto = d[o + 6]; src = ip6(d, o + 8); dst = ip6(d, o + 24);
      ipEnd = Math.min(d.length, o + 40 + plen);
      const f = [F('Source', src), F('Destination', dst), F('Hop limit', d[o + 7])];
      let p = o + 40;
      while ([0, 43, 60, 44].includes(proto) && p + 8 <= ipEnd) { f.push(F('Extension', { 0: 'hop-by-hop', 43: 'routing', 60: 'destination options', 44: 'fragment' }[proto] as string)); const nh = d[p]; p += proto === 44 ? 8 : (d[p + 1] + 1) * 8; proto = nh; }
      f.push(F('Next header', IPPROTO[proto] || proto));
      L('IPv6', o, p, f); o = p;
    } else { pk.proto = ETYPES[etype] || `0x${hx(etype, 4)}`; return pk; }
    pk.src = src; pk.dst = dst; pk.proto = IPPROTO[proto] || `IP ${proto}`; pk.info = '';

    if (proto === 1 || proto === 58) {
      const t = d[o], c = d[o + 1];
      const V4: Record<number, string> = { 0: 'Echo reply', 3: 'Destination unreachable', 5: 'Redirect', 8: 'Echo request', 11: 'Time exceeded' };
      const V6: Record<number, string> = { 1: 'Destination unreachable', 128: 'Echo request', 129: 'Echo reply', 133: 'Router solicitation', 134: 'Router advertisement', 135: 'Neighbor solicitation', 136: 'Neighbor advertisement', 143: 'Multicast listener report v2', 130: 'Multicast listener query', 131: 'Multicast listener report' };
      let name = (proto === 1 ? V4 : V6)[t] || `type ${t}`;
      if (proto === 58 && (t === 135 || t === 136) && o + 24 <= ipEnd) name += ` for ${ip6(d, o + 8)}`;
      if (proto === 1 && (t === 0 || t === 8)) name += ` id 0x${hx(u16(d, o + 4), 4)} seq ${u16(d, o + 6)}`;
      L(proto === 1 ? 'ICMP' : 'ICMPv6', o, ipEnd, [F('Type', `${t} ${name}`), F('Code', c)]);
      pk.info = name; return pk;
    }
    if (proto === 2) { const T: Record<number, string> = { 0x11: 'Membership query', 0x16: 'Join (v2)', 0x17: 'Leave', 0x22: 'Report (v3)' }; pk.info = `${T[d[o]] || `type 0x${hx(d[o])}`}${d[o] === 0x16 || d[o] === 0x17 ? ` ${ip4(d, o + 4)}` : ''}`; L('IGMP', o, ipEnd, [F('Type', pk.info)]); return pk; }

    if (proto === 17) {
      const sp = u16(d, o), dp = u16(d, o + 2), ulen = u16(d, o + 4);
      const ps = o + 8, pe = Math.min(ipEnd, o + Math.max(8, ulen));
      pk.sport = sp; pk.dport = dp; pk.l4 = 'udp'; pk.payloadStart = ps; pk.payloadLen = pe - ps;
      L('UDP', o, ps, [F('Source port', sp), F('Destination port', dp), F('Length', ulen)]);
      const port = UDP_APPS[dp] ? dp : UDP_APPS[sp] ? sp : 0;
      const app = UDP_APPS[port] || '';
      pk.info = `${sp} → ${dp} · ${pe - ps} B`;
      if (app === 'DNS' || app === 'mDNS' || app === 'LLMNR') { const r = dns(d, ps, pe, app); pk.layers.push(r.layer); pk.proto = app; pk.info = r.info; (pk as Packet & { _dns?: unknown })._dns = r; }
      else if (app === 'NBNS') { const [n] = dnsName(d, ps + 12, ps); pk.proto = 'NBNS'; pk.info = `NetBIOS name ${n.length === 32 ? decodeNb(n) : n}`; L('NBNS', ps, pe, [F('Name', pk.info)]); }
      else if (app === 'DHCP') { const r = dhcp(d, ps, pe); pk.layers.push(r.layer); pk.proto = 'DHCP'; pk.info = r.info; (pk as Packet & { _dhcp?: unknown })._dhcp = r; }
      else if (app === 'NTP') { const mode = d[ps] & 7; const M = ['', 'symmetric active', 'symmetric passive', 'client', 'server', 'broadcast']; pk.proto = 'NTP'; pk.info = `NTP v${(d[ps] >> 3) & 7} ${M[mode] || mode}${mode === 4 ? ` · stratum ${d[ps + 1]}` : ''}`; L('NTP', ps, pe, [F('Mode', M[mode] || mode), F('Stratum', d[ps + 1])]); }
      else if (app === 'SSDP') {
        const h = httpHead(text(d, ps, pe - ps)); pk.proto = 'SSDP';
        const st = hget(h.headers, 'st') || hget(h.headers, 'nt'); const loc = hget(h.headers, 'location'); const srv = hget(h.headers, 'server');
        pk.info = `${h.first.replace(/ \* HTTP\/1\.1| HTTP\/1\.1/, '')}${st ? ` · ${st}` : ''}${loc ? ` · ${loc}` : ''}`;
        L('SSDP', ps, pe, [F('Line', h.first), ...h.headers.map(([k, v]) => F(k, v))]);
        if (srv) (pk as Packet & { _server?: string })._server = srv;
      } else if (app === 'WS-Discovery') {
        const x = text(d, ps, pe - ps); pk.proto = 'WS-Discovery';
        const kind = /ProbeMatches/.test(x) ? 'ProbeMatches' : /<[\w:]*Probe[\s>]/.test(x) ? 'Probe' : /<[\w:]*Hello[\s>]/.test(x) ? 'Hello' : /<[\w:]*Bye[\s>]/.test(x) ? 'Bye' : /ResolveMatches/.test(x) ? 'ResolveMatches' : 'message';
        const types = /<[\w:]*Types[^>]*>([^<]+)</.exec(x)?.[1]?.trim() || ''; const xa = /<[\w:]*XAddrs[^>]*>([^<]+)</.exec(x)?.[1]?.trim() || '';
        const scopes = /<[\w:]*Scopes[^>]*>([^<]+)</.exec(x)?.[1] || '';
        const nm = /onvif:\/\/www\.onvif\.org\/name\/([^\s<]+)/.exec(scopes)?.[1]; const hw = /onvif:\/\/www\.onvif\.org\/hardware\/([^\s<]+)/.exec(scopes)?.[1];
        pk.info = `ONVIF ${kind}${types ? ` · ${types}` : ''}${xa ? ` · ${xa}` : ''}`;
        L('WS-Discovery (ONVIF)', ps, pe, [F('Message', kind), ...(types ? [F('Types', types)] : []), ...(xa ? [F('Addresses', xa)] : []), ...(nm ? [F('Name', decodeURIComponent(nm))] : []), ...(hw ? [F('Hardware', decodeURIComponent(hw))] : [])]);
        if (nm || hw) (pk as Packet & { _name?: string })._name = decodeURIComponent(hw || nm || '');
      } else if (app === 'Syslog') { pk.proto = 'Syslog'; pk.info = text(d, ps, Math.min(160, pe - ps)); L('Syslog', ps, pe, [F('Message', text(d, ps, pe - ps))]); }
      else if (app === 'Dropbox LAN') { pk.proto = 'Dropbox LAN'; pk.info = 'Dropbox LAN sync discovery'; }
      else if (app) { pk.proto = app; L(app, ps, pe, [F('Bytes', pe - ps)]); }
      else if (pe - ps >= 12 && (d[ps] >> 6) === 2) {                   // RTP / RTCP heuristic
        const pt = d[ps + 1] & 0x7f;
        if (d[ps + 1] >= 200 && d[ps + 1] <= 204) { pk.proto = 'RTCP'; pk.info = `RTCP ${['Sender report', 'Receiver report', 'SDES', 'Bye', 'App'][d[ps + 1] - 200]}`; }
        else if (pt >= 96 || pt <= 34) { pk.proto = 'RTP?'; pk.info = `RTP? payload type ${pt} · seq ${u16(d, ps + 2)} · SSRC 0x${hx(u32(d, ps + 8), 8)}`; }
      }
      return pk;
    }

    if (proto === 6) {
      const sp = u16(d, o), dp = u16(d, o + 2), seq = u32(d, o + 4), ack = u32(d, o + 8);
      const off = (d[o + 12] >> 4) * 4, fl = d[o + 13], win = u16(d, o + 14);
      const flags = TCP_FLAGS.filter((_, i) => fl & (1 << i)).join(',');
      const ps = o + off, pe = ipEnd; const plen = Math.max(0, pe - ps);
      pk.sport = sp; pk.dport = dp; pk.l4 = 'tcp'; pk.payloadStart = ps; pk.payloadLen = plen;
      pk.tcp = { seq, ack, flags, win, payloadStart: ps, payloadLen: plen };
      L('TCP', o, ps, [F('Source port', sp), F('Destination port', dp), F('Flags', flags || 'none'), F('Sequence', seq), F('Acknowledgment', ack), F('Window', win), F('Payload', `${plen} B`)]);
      pk.info = `${sp} → ${dp} [${flags.replace('ACK', '.').replace(/,\./, '.')}] ${plen ? `${plen} B` : ''}`.trim();
      if (fl & 2) pk.info = `${sp} → ${dp} ${fl & 16 ? 'SYN-ACK (accepting)' : 'SYN (opening)'}`;
      else if (fl & 4) pk.info = `${sp} → ${dp} RST (refused / reset)`;
      else if (fl & 1 && !plen) pk.info = `${sp} → ${dp} FIN (closing)`;
      if (plen > 0) {
        const head = text(d, ps, Math.min(plen, 2048));
        const t = tls(d, ps, pe);
        if (HTTP_START.test(head)) {
          const h = httpHead(head); pk.proto = 'HTTP';
          const sun = /\/([\w-]+)\/(\w+)\.cgi\?[^ ]*msubmenu=(\w+)/i.exec(h.first);
          pk.info = h.first.replace(/ HTTP\/1\.[01]$/, '') + (sun ? `  [SUNAPI ${sun[3]}]` : '');
          L('HTTP', ps, pe, [F('Line', h.first), ...h.headers.map(([k, v]) => F(k, /^authorization$/i.test(k) && /^basic/i.test(v) ? 'Basic ••••••' : v.length > 200 ? v.slice(0, 200) + '…' : v))]);
        } else if (RTSP_START.test(head)) {
          const h = httpHead(head); pk.proto = 'RTSP'; pk.info = h.first.replace(/ RTSP\/1\.0$/, '');
          L('RTSP', ps, pe, [F('Line', h.first), ...h.headers.map(([k, v]) => F(k, v))]);
        } else if (t) { pk.layers.push(t.layer); pk.proto = 'TLS'; pk.info = t.info; }
        else if (d[ps] === 0x24 && plen >= 4 && (sp === 554 || dp === 554)) { pk.proto = 'RTSP'; pk.info = `Interleaved RTP/RTCP channel ${d[ps + 1]} · ${u16(d, ps + 2)} B`; }
        else if (/^SSH-\d/.test(head)) { pk.proto = 'SSH'; pk.info = head.split('\r\n')[0]; }
        else {
          const known = TCP_PORTS[dp] || TCP_PORTS[sp];
          if (known) pk.proto = known;
          pk.info += ` · ${ascii(d, ps, Math.min(plen, 40))}`;
        }
      }
      return pk;
    }
    pk.info = `${IPPROTO[proto] || 'protocol ' + proto}`;
  } catch (e) {
    pk.bad = (e as Error).message || 'could not decode'; pk.info = pk.info || 'malformed';
  }
  return pk;
}

function decodeNb(n: string) { let s = ''; for (let i = 0; i < 30; i += 2) s += String.fromCharCode(((n.charCodeAt(i) - 65) << 4) | (n.charCodeAt(i + 1) - 65)); return s.trim(); }

// ── whole capture ─────────────────────────────────────────────────────────
const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fd|fc)/i.test(ip);
const isMulti = (a: string) => /^(22[4-9]|23\d)\./.test(a) || /^ff/i.test(a) || a === '255.255.255.255' || /^(01:00:5e|33:33|ff:ff:ff:ff:ff:ff|01:80:c2|01:00:0c|00:00:f4:27:71:01)/i.test(a);
export { isMulti, isPrivate };

export async function parseCapture(buf: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<Capture> {
  const f = readFile(buf);
  const packets: Packet[] = [];
  const convs = new Map<string, Conversation>(); const convList: Conversation[] = [];
  const hosts = new Map<string, Host>();
  const protos = new Map<string, { packets: number; bytes: number }>();
  const ipMac = new Map<string, string>();
  const host = (key: string): Host => { let h = hosts.get(key); if (!h) { h = { names: new Set(), info: new Set(), packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0, protos: new Set() }; hosts.set(key, h); } return h; };

  for (let i = 0; i < f.frames.length; i++) {
    const pk = decode(f.frames[i], i + 1);
    packets.push(pk);
    const pr = protos.get(pk.proto) || { packets: 0, bytes: 0 }; pr.packets++; pr.bytes += pk.len; protos.set(pk.proto, pr);
    // hosts: IP hosts keyed by IP; L2-only talkers by MAC
    const ipPkt = pk.layers.some(l => l.name === 'IPv4' || l.name === 'IPv6');
    if (ipPkt) {
      if (pk.srcMac && !isMulti(pk.src)) ipMac.set(pk.src, pk.srcMac);
      if (!isMulti(pk.src)) { const h = host(pk.src); h.ip = pk.src; h.packetsOut++; h.bytesOut += pk.len; h.protos.add(pk.proto); }
      if (!isMulti(pk.dst)) { const h = host(pk.dst); h.ip = pk.dst; h.packetsIn++; h.bytesIn += pk.len; h.protos.add(pk.proto); }
    } else if (pk.srcMac) {
      const arp = pk.proto === 'ARP' ? /Tell ([\d.]+)|^([\d.]+) is at|Gratuitous ARP for ([\d.]+)/.exec(pk.info) : null;
      const ip = arp ? (arp[1] || arp[2] || arp[3]) : '';
      const key = ip && ip !== '0.0.0.0' ? ip : pk.srcMac;
      if (ip && ip !== '0.0.0.0') ipMac.set(ip, pk.srcMac);
      const h = host(key); if (ip) h.ip = ip; h.mac = pk.srcMac; h.packetsOut++; h.bytesOut += pk.len; h.protos.add(pk.proto);
    }
    // names learned from the traffic
    const x = pk as Packet & { _name?: string; _server?: string; _dns?: { answers: DnsRR[] }; _dhcp?: { host: string; chaddr: string; vendor: string } };
    if (x._name) { const k = pk.src && !pk.src.includes(':') ? pk.src : pk.srcMac || ''; if (k) host(k).names.add(x._name); }
    if (x._server && pk.src) host(pk.src).info.add(x._server);
    if (x._dns && pk.proto === 'mDNS') for (const a of x._dns.answers) if ((a.type === 'A' || a.type === 'AAAA') && /\.local$/.test(a.name)) host(a.data).names.add(a.name.replace(/\.local$/, ''));
    if (x._dhcp) { const k = pk.srcMac || x._dhcp.chaddr; if (x._dhcp.host || x._dhcp.vendor) { const hk = [...hosts.entries()].find(([, h]) => h.mac === x._dhcp!.chaddr)?.[0] || x._dhcp.chaddr || k; const h = host(hk); h.mac = x._dhcp.chaddr; if (x._dhcp.host) h.names.add(x._dhcp.host); if (x._dhcp.vendor) h.info.add(x._dhcp.vendor); } }
    // conversations
    if (pk.l4 && pk.sport !== undefined && pk.dport !== undefined) {
      const a = `${pk.src}|${pk.sport}`, b = `${pk.dst}|${pk.dport}`;
      const key = `${pk.l4}|${a < b ? a + '|' + b : b + '|' + a}`;
      let c = convs.get(key);
      if (!c) {
        // the side that opened it: SYN sender, else the higher (ephemeral) port
        let [ca, cap, cb, cbp] = [pk.src, pk.sport, pk.dst, pk.dport];
        if (!(pk.tcp && pk.tcp.flags === 'SYN') && pk.sport < pk.dport && !(pk.tcp && /SYN/.test(pk.tcp.flags))) [ca, cap, cb, cbp] = [pk.dst, pk.dport, pk.src, pk.sport];
        if (pk.tcp && pk.tcp.flags === 'SYN,ACK') [ca, cap, cb, cbp] = [pk.dst, pk.dport, pk.src, pk.sport];
        c = { index: convList.length, l4: pk.l4, a: ca, ap: cap, b: cb, bp: cbp, packets: 0, bytes: 0, first: pk.ts, last: pk.ts, app: '', aToB: 0, bToA: 0, pkts: [] };
        convs.set(key, c); convList.push(c);
      }
      c.packets++; c.bytes += pk.len; c.last = pk.ts; c.pkts.push(i);
      if (pk.src === c.a && pk.sport === c.ap) c.aToB += pk.payloadLen || 0; else c.bToA += pk.payloadLen || 0;
      if (!c.app || c.app === 'TCP' || c.app === 'UDP') c.app = pk.proto;
      pk.stream = c.index;
    }
    if (onProgress && i % 5000 === 4999) { onProgress(i + 1, f.frames.length); await new Promise(r => setTimeout(r, 0)); }
  }
  for (const [ip, m] of ipMac) { const h = hosts.get(ip); if (h && !h.mac) h.mac = m; }
  // merge MAC-only hosts into the IP host with that MAC
  for (const [k, h] of [...hosts]) {
    if (!h.ip && h.mac) { const owner = [...hosts.values()].find(o => o !== h && o.ip && o.mac === h.mac); if (owner) { h.names.forEach(n => owner.names.add(n)); h.info.forEach(n => owner.info.add(n)); h.protos.forEach(p => owner.protos.add(p)); owner.packetsOut += h.packetsOut; owner.bytesOut += h.bytesOut; hosts.delete(k); } }
  }
  for (const h of hosts.values()) h.vendor = vendorOf(h.mac);
  const first = packets.length ? packets[0].ts : 0, last = packets.length ? packets[packets.length - 1].ts : 0;
  const linkNames = f.links.map(l => LINKS[l] || `link ${l}`).join(', ');
  return {
    format: f.format, link: linkNames, packets, conversations: convList,
    hosts: [...hosts.values()].sort((a, b) => (b.packetsIn + b.packetsOut) - (a.packetsIn + a.packetsOut)),
    protocols: [...protos].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.packets - a.packets),
    first, last, bytes: packets.reduce((s, p) => s + p.len, 0), warnings: f.warnings,
  };
}
