// AETHER_TRAFFIC (TRAFFIC-3) — Reader: open a packet capture (the Pi's, or any .pcap / .pcapng
// from this computer, Wireshark files too) and read it here. Everything runs in the browser.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, HardDriveDownload, Search, Loader2, AlertTriangle, FileSearch, X, Waypoints, ArrowRight } from 'lucide-react';
import { parseCapture, isMulti, type Capture, type Packet } from './parse';
import { enrich } from './streams';
import { StreamView, hexDump } from './ReaderStreams';
import { Badge, Button, Empty, Input, Segmented, Select, cx, fmtBytes } from '../../sunapi/ui';

type View = 'overview' | 'packets' | 'streams';
const MAX_FILE = 400 * 1024 * 1024;
const ROW = 24;
const PROTO_TONE: Record<string, 'brand' | 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'purple'> = {
  HTTP: 'success', TLS: 'info', WebSocket: 'purple', 'WebSocket (RTSP/RTP video)': 'purple', RTSP: 'purple', DNS: 'warning', mDNS: 'warning', LLMNR: 'warning', DHCP: 'warning', ARP: 'neutral', TCP: 'neutral', UDP: 'neutral',
};
const tone = (p: string) => PROTO_TONE[p] || 'neutral';
const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

export interface ReaderHandle { openBuffer: (b: ArrayBuffer, name: string) => void }

export const PcapReader: React.FC<{ loadPi?: () => Promise<ArrayBuffer>; piBytes: number; openPiSignal?: number; piAddresses?: string[] }> = ({ loadPi, piBytes, openPiSignal, piAddresses = [] }) => {
  const [cap, setCap] = useState<Capture | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<View>('overview');
  const [drag, setDrag] = useState(false);
  // packets view state
  const [q, setQ] = useState(''); const [proto, setProto] = useState(''); const [host, setHost] = useState(''); const [streamF, setStreamF] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);      // packet number
  const [layer, setLayer] = useState<number | null>(null);
  const [conv, setConv] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const open = useCallback(async (buf: ArrayBuffer, nm: string) => {
    setErr(null); setBusy('Reading…');
    try {
      if (buf.byteLength > MAX_FILE) throw new Error(`This file is ${fmtBytes(buf.byteLength)}; the reader opens up to ${fmtBytes(MAX_FILE)}. Use Wireshark for bigger ones.`);
      const c = enrich(await parseCapture(buf, (d, t) => setBusy(`Reading… ${Math.round((d / t) * 100)}%`)));
      for (const h of c.hosts) if (h.ip && piAddresses.includes(h.ip)) h.names.add('this Pi (Aether)');
      setCap(c); setName(nm); setView('overview'); setSel(null); setLayer(null); setConv(null); setQ(''); setProto(''); setHost(''); setStreamF(null);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }, [piAddresses]);
  const openPi = useCallback(async () => {
    if (!loadPi) return;
    setBusy('Downloading from the Pi…'); setErr(null);
    try { await open(await loadPi(), "Pi's last packet capture"); } catch (e) { setErr((e as Error).message); setBusy(null); }
  }, [loadPi, open]);
  useEffect(() => { if (openPiSignal) openPi(); }, [openPiSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const openFile = async (f: File) => open(await f.arrayBuffer(), f.name);

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDrag(true); },
    onDragLeave: () => setDrag(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) openFile(f); },
  };

  const toolbar = (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-hv-line shrink-0">
      <Button size="sm" tone={cap ? 'secondary' : 'primary'} icon={<HardDriveDownload size={13} />} disabled={!piBytes || !!busy} onClick={openPi} title={piBytes ? '' : 'Record a packet capture first (Packet capture tab)'}>
        Open the Pi's capture{piBytes ? ` · ${fmtBytes(piBytes)}` : ''}
      </Button>
      <Button size="sm" icon={<FolderOpen size={13} />} disabled={!!busy} onClick={() => fileRef.current?.click()}>Open a file…</Button>
      <input ref={fileRef} type="file" accept=".pcap,.pcapng,.cap,.dmp,application/vnd.tcpdump.pcap" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
      {cap && (
        <>
          <span className="mx-1 h-5 w-px bg-hv-line" />
          <span className="text-xs text-hv-text truncate max-w-[280px]" title={name}>{name}</span>
          <span className="text-[11px] text-hv-text-3">{cap.format} · {cap.packets.length.toLocaleString()} packets · {fmtBytes(cap.bytes)} · {dur(cap.last - cap.first)}</span>
          <span className="ml-auto" />
          <Segmented value={view} onChange={v => { setView(v); }} items={[{ id: 'overview', label: 'Overview' }, { id: 'packets', label: 'Packets' }, { id: 'streams', label: `Conversations ${cap.conversations.length}` }]} />
        </>
      )}
      {busy && <span className="text-xs text-hv-text-2 inline-flex items-center gap-1.5 ml-2"><Loader2 size={13} className="animate-spin" />{busy}</span>}
    </div>
  );

  if (!cap) {
    return (
      <div className="flex-1 min-h-0 flex flex-col" {...dropProps}>
        {toolbar}
        {err && <div className="m-3 rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 px-3 py-2 text-sm text-hv-error-fg flex gap-2"><AlertTriangle size={15} className="shrink-0 mt-0.5" />{err}</div>}
        <div className={cx('flex-1 m-3 rounded-hv-sm border-2 border-dashed flex items-center justify-center', drag ? 'border-hv-brand bg-hv-brand-tint' : 'border-hv-line')}>
          <Empty icon={<FileSearch size={30} />} title="Read a packet capture">
            Open the Pi's last recording, or drop a <b>.pcap</b> / <b>.pcapng</b> file here (Wireshark and tcpdump files work).<br />
            Reading happens in this browser — the file isn't uploaded anywhere.
          </Empty>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col" {...dropProps}>
      {toolbar}
      {err && <div className="mx-3 mt-2 rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 px-3 py-1.5 text-xs text-hv-error-fg flex items-center gap-2"><AlertTriangle size={13} />{err}<button className="ml-auto" onClick={() => setErr(null)}><X size={13} /></button></div>}
      {cap.warnings.map((w, i) => <div key={i} className="mx-3 mt-2 rounded-hv-xs bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 px-3 py-1.5 text-xs text-hv-warning-fg">{w}</div>)}
      {view === 'overview' && (
        <Overview cap={cap}
          onHost={h => { setHost(h); setProto(''); setStreamF(null); setView('packets'); }}
          onProto={p => { setProto(p); setHost(''); setStreamF(null); setView('packets'); }}
          onConv={c => { setConv(c); setView('streams'); }} />
      )}
      {view === 'packets' && (
        <Packets cap={cap} q={q} setQ={setQ} proto={proto} setProto={setProto} host={host} setHost={setHost} streamF={streamF} setStreamF={setStreamF}
          sel={sel} setSel={n => { setSel(n); setLayer(null); }} layer={layer} setLayer={setLayer}
          onFollow={s => { setConv(s); setView('streams'); }} />
      )}
      {view === 'streams' && (
        <Conversations cap={cap} conv={conv} setConv={setConv}
          onPacket={no => { const pk = cap.packets[no - 1]; setStreamF(pk.stream ?? null); setProto(''); setHost(''); setQ(''); setSel(no); setView('packets'); }} />
      )}
    </div>
  );
};

// ── Overview ──────────────────────────────────────────────────────────────
const Overview: React.FC<{ cap: Capture; onHost: (h: string) => void; onProto: (p: string) => void; onConv: (c: number) => void }> = ({ cap, onHost, onProto, onConv }) => {
  const max = cap.protocols[0]?.packets || 1;
  const convs = useMemo(() => [...cap.conversations].sort((a, b) => b.bytes - a.bytes).slice(0, 40), [cap]);
  const hosts = cap.hosts.filter(h => h.ip !== '0.0.0.0' || h.names.size);
  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[['Packets', cap.packets.length.toLocaleString()], ['Duration', dur(cap.last - cap.first)], ['Data', fmtBytes(cap.bytes)], ['Devices seen', String(hosts.length)]].map(([k, v]) => (
          <div key={k} className="rounded-hv-sm bg-hv-surface ring-1 ring-inset ring-hv-line px-4 py-3">
            <div className="text-[11px] text-hv-text-3 uppercase tracking-wide font-bold">{k}</div><div className="text-xl font-semibold text-hv-text mt-0.5">{v}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-hv-text-3">{new Date(cap.first).toLocaleString()} → {new Date(cap.last).toLocaleTimeString()} · {cap.link}</div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-4 items-start">
        <section className="rounded-hv-sm bg-hv-surface ring-1 ring-inset ring-hv-line">
          <h3 className="px-4 pt-3 pb-2 text-sm font-bold text-hv-text">Devices <span className="font-normal text-hv-text-3 text-xs">— click one to see its packets</span></h3>
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-[11px] text-hv-text-3 border-b border-hv-line"><th className="px-4 py-1 font-semibold">Address</th><th className="px-2 py-1 font-semibold">Name / maker</th><th className="px-2 py-1 font-semibold text-right">Sent</th><th className="px-2 py-1 font-semibold text-right">Received</th><th className="px-4 py-1 font-semibold">Speaks</th></tr></thead>
            <tbody>
              {hosts.slice(0, 80).map((h, i) => (
                <tr key={i} onClick={() => onHost(h.ip || h.mac || '')} className="border-b border-hv-line last:border-0 hover:bg-hv-widget cursor-pointer align-top">
                  <td className="px-4 py-1.5 font-mono"><div className="text-hv-text">{h.ip || h.mac}</div>{h.ip && h.mac && <div className="text-[10.5px] text-hv-text-3">{h.mac}</div>}</td>
                  <td className="px-2 py-1.5">
                    <div className="text-hv-text">{[...h.names].slice(0, 2).join(', ') || <span className="text-hv-text-3">—</span>}</div>
                    <div className="text-[10.5px] text-hv-text-3">{[h.vendor, ...[...h.info].slice(0, 1)].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right text-hv-text-2 whitespace-nowrap">{h.packetsOut ? `${h.packetsOut} · ${fmtBytes(h.bytesOut)}` : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-hv-text-2 whitespace-nowrap">{h.packetsIn ? `${h.packetsIn} · ${fmtBytes(h.bytesIn)}` : '—'}</td>
                  <td className="px-4 py-1.5"><div className="flex flex-wrap gap-1">{[...h.protos].slice(0, 5).map(p => <Badge key={p} tone={tone(p)}>{p}</Badge>)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="rounded-hv-sm bg-hv-surface ring-1 ring-inset ring-hv-line pb-2">
          <h3 className="px-4 pt-3 pb-2 text-sm font-bold text-hv-text">Protocols</h3>
          {cap.protocols.map(p => (
            <button key={p.name} onClick={() => onProto(p.name)} className="w-full px-4 py-1 flex items-center gap-2 text-xs hover:bg-hv-widget text-left">
              <span className="w-36 truncate text-hv-text">{p.name}</span>
              <span className="flex-1 h-2 rounded bg-hv-widget overflow-hidden"><span className="block h-full bg-hv-brand" style={{ width: `${Math.max(2, (p.packets / max) * 100)}%` }} /></span>
              <span className="w-14 text-right text-hv-text-2">{p.packets.toLocaleString()}</span><span className="w-16 text-right text-hv-text-3">{fmtBytes(p.bytes)}</span>
            </button>
          ))}
        </section>
      </div>

      <section className="rounded-hv-sm bg-hv-surface ring-1 ring-inset ring-hv-line">
        <h3 className="px-4 pt-3 pb-2 text-sm font-bold text-hv-text">Biggest conversations <span className="font-normal text-hv-text-3 text-xs">— click one to read it</span></h3>
        <ConvTable cap={cap} rows={convs} onPick={onConv} />
      </section>
    </div>
  );
};

const ConvTable: React.FC<{ cap: Capture; rows: Capture['conversations']; onPick: (c: number) => void; active?: number | null; compact?: boolean }> = ({ cap, rows, onPick, active, compact }) => {
  const nm = (ip: string) => { const h = cap.hosts.find(x => x.ip === ip); const n = h && [...h.names][0]; return n ? `${n}` : ''; };
  return (
    <table className="w-full text-[12px]">
      {!compact && <thead><tr className="text-left text-[11px] text-hv-text-3 border-b border-hv-line"><th className="px-4 py-1 font-semibold">What</th><th className="px-2 py-1 font-semibold">From</th><th className="px-2 py-1 font-semibold">To</th><th className="px-2 py-1 font-semibold text-right">Packets</th><th className="px-2 py-1 font-semibold text-right">Data</th><th className="px-4 py-1 font-semibold text-right">Time</th></tr></thead>}
      <tbody>
        {rows.map(c => (
          <tr key={c.index} onClick={() => onPick(c.index)} className={cx('border-b border-hv-line last:border-0 cursor-pointer align-top', active === c.index ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
            <td className={cx(compact ? 'px-3' : 'px-4', 'py-1.5')}><Badge tone={tone(c.app)}>{c.app}</Badge>{compact && <div className="mt-1 font-mono text-[11px] text-hv-text truncate">{c.a}:{c.ap} → {c.b}:{c.bp}</div>}{compact && <div className="text-[10.5px] text-hv-text-3">{c.packets} pk · {fmtBytes(c.bytes)}</div>}</td>
            {!compact && <>
              <td className="px-2 py-1.5 font-mono text-hv-text">{c.a}:{c.ap}{nm(c.a) && <div className="text-[10.5px] text-hv-text-3 font-sans">{nm(c.a)}</div>}</td>
              <td className="px-2 py-1.5 font-mono text-hv-text">{c.b}:{c.bp}{nm(c.b) && <div className="text-[10.5px] text-hv-text-3 font-sans">{nm(c.b)}</div>}</td>
              <td className="px-2 py-1.5 text-right text-hv-text-2">{c.packets}</td>
              <td className="px-2 py-1.5 text-right text-hv-text-2 whitespace-nowrap">↑ {fmtBytes(c.aToB)} ↓ {fmtBytes(c.bToA)}</td>
              <td className="px-4 py-1.5 text-right text-hv-text-3">{dur(c.last - c.first)}</td>
            </>}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── Packets ───────────────────────────────────────────────────────────────
const Packets: React.FC<{
  cap: Capture; q: string; setQ: (v: string) => void; proto: string; setProto: (v: string) => void; host: string; setHost: (v: string) => void;
  streamF: number | null; setStreamF: (v: number | null) => void; sel: number | null; setSel: (n: number | null) => void; layer: number | null; setLayer: (n: number | null) => void; onFollow: (s: number) => void;
}> = ({ cap, q, setQ, proto, setProto, host, setHost, streamF, setStreamF, sel, setSel, layer, setLayer, onFollow }) => {
  const [hideNoise, setHideNoise] = useState(false);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cap.packets.filter(p => {
      if (proto && p.proto !== proto) return false;
      if (host && p.src !== host && p.dst !== host && p.srcMac !== host && p.dstMac !== host) return false;
      if (streamF !== null && p.stream !== streamF) return false;
      if (hideNoise && (['ARP', 'AT-LDF', 'RSTP', 'STP', 'CDP', 'LLDP', 'mDNS', 'SSDP', 'ICMPv6', 'LLMNR', 'NBNS', 'Dropbox LAN', 'IGMP'].includes(p.proto) || (p.l4 === 'tcp' && !p.payloadLen && !/SYN|FIN|RST/.test(p.tcp?.flags || '')))) return false;
      if (needle && !`${p.no} ${p.src} ${p.dst} ${p.sport ?? ''} ${p.dport ?? ''} ${p.proto} ${p.info}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [cap, q, proto, host, streamF, hideNoise]);
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0); const [h, setH] = useState(600);
  useEffect(() => { const el = scroller.current; if (!el) return; const ro = new ResizeObserver(() => setH(el.clientHeight)); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => { // keep the selected packet in view when arriving from elsewhere
    if (sel == null || !scroller.current) return; const i = rows.findIndex(r => r.no === sel); if (i < 0) return;
    const y = i * ROW; const el = scroller.current; if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW * 2) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  }, [sel, rows]);
  const first = Math.max(0, Math.floor(top / ROW) - 10), last = Math.min(rows.length, Math.ceil((top + h) / ROW) + 10);
  const t0 = cap.first;
  const pk = sel != null ? cap.packets[sel - 1] : null;
  const protos = cap.protocols.map(p => p.name);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); const i = rows.findIndex(r => r.no === sel); const n = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) setSel(n.no);
  };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hv-line shrink-0 flex-wrap">
        <div className="relative w-72"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" /><Input className="pl-8" placeholder="Filter: address, port, text in the info…" value={q} onChange={e => setQ(e.target.value)} /></div>
        <Select className="!w-auto" value={proto} onChange={e => setProto(e.target.value)} aria-label="Protocol"><option value="">All protocols</option>{protos.map(p => <option key={p} value={p}>{p}</option>)}</Select>
        {host && <Badge tone="info">device {host} <button onClick={() => setHost('')} aria-label="Clear"><X size={11} /></button></Badge>}
        {streamF !== null && <Badge tone="purple">conversation {streamF} <button onClick={() => setStreamF(null)} aria-label="Clear"><X size={11} /></button></Badge>}
        <label className="text-xs text-hv-text-2 inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={hideNoise} onChange={e => setHideNoise(e.target.checked)} />Hide network chatter (ARP, discovery, switch frames, empty ACKs)</label>
        <span className="ml-auto text-[11px] text-hv-text-3">{rows.length.toLocaleString()} of {cap.packets.length.toLocaleString()}</span>
      </div>
      <div className={cx('min-h-0 flex flex-col', pk ? 'h-[46%]' : 'flex-1')}>
        <div className="grid grid-cols-[64px_84px_200px_200px_150px_60px_1fr] text-[11px] font-semibold text-hv-text-3 border-b border-hv-line px-2 h-7 items-center shrink-0">
          <span>No.</span><span>Time</span><span>Source</span><span>Destination</span><span>Protocol</span><span className="text-right pr-2">Length</span><span>Info</span>
        </div>
        <div ref={scroller} tabIndex={0} onKeyDown={keys} className="flex-1 min-h-0 overflow-auto outline-none" onScroll={e => setTop((e.target as HTMLDivElement).scrollTop)}>
          <div style={{ height: rows.length * ROW, position: 'relative' }}>
            {rows.slice(first, last).map((p, i) => (
              <div key={p.no} onClick={() => setSel(p.no === sel ? null : p.no)} style={{ position: 'absolute', top: (first + i) * ROW, height: ROW, left: 0, right: 0 }}
                className={cx('grid grid-cols-[64px_84px_200px_200px_150px_60px_1fr] px-2 items-center text-[12px] font-mono cursor-pointer border-b border-hv-line/60', p.no === sel ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget', p.bad && 'text-hv-error-fg')}>
                <span className="text-hv-text-3">{p.no}</span>
                <span className="text-hv-text-3">{((p.ts - t0) / 1000).toFixed(3)}</span>
                <span className="truncate text-hv-text" title={p.src}>{p.src}{p.sport !== undefined ? <span className="text-hv-text-3">:{p.sport}</span> : null}</span>
                <span className="truncate text-hv-text" title={p.dst}>{p.dst}{p.dport !== undefined ? <span className="text-hv-text-3">:{p.dport}</span> : null}</span>
                <span className="truncate font-sans"><Badge tone={tone(p.proto)}>{p.proto}</Badge></span>
                <span className="text-right pr-2 text-hv-text-3">{p.len}</span>
                <span className="truncate text-hv-text-2" title={p.info}>{p.info}</span>
              </div>
            ))}
          </div>
          {!rows.length && <div className="p-4 text-sm text-hv-text-3">Nothing matches the filter.</div>}
        </div>
      </div>
      {pk && <PacketDetail pk={pk} cap={cap} layer={layer} setLayer={setLayer} onClose={() => setSel(null)} onFollow={onFollow} />}
    </div>
  );
};

const PacketDetail: React.FC<{ pk: Packet; cap: Capture; layer: number | null; setLayer: (n: number | null) => void; onClose: () => void; onFollow: (s: number) => void }> = ({ pk, cap, layer, setLayer, onClose, onFollow }) => {
  const hl: [number, number] | undefined = layer != null && pk.layers[layer] ? [pk.layers[layer].start, pk.layers[layer].end] : undefined;
  const conv = pk.stream !== undefined ? cap.conversations[pk.stream] : null;
  return (
    <div className="flex-1 min-h-0 border-t-2 border-hv-line flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-hv-line shrink-0 text-xs">
        <span className="font-semibold text-hv-text">Packet {pk.no}</span>
        <span className="text-hv-text-3">{new Date(pk.ts).toLocaleTimeString([], { hour12: false })}.{String(Math.floor(pk.ts % 1000)).padStart(3, '0')} · {pk.len} bytes on the wire{pk.caplen < pk.len ? ` (${pk.caplen} kept)` : ''}{cap.packets.some(p => p.iface) ? ` · interface ${pk.iface}` : ''}</span>
        {pk.bad && <Badge tone="error">{pk.bad}</Badge>}
        <span className="ml-auto" />
        {conv && <Button size="sm" icon={<Waypoints size={12} />} onClick={() => onFollow(conv.index)}>Read the whole conversation <ArrowRight size={12} /></Button>}
        <button onClick={onClose} className="text-hv-text-3 hover:text-hv-text" aria-label="Close"><X size={15} /></button>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_minmax(0,560px)]">
        <div className="min-h-0 overflow-auto p-2 space-y-1">
          {pk.layers.map((l, i) => (
            <div key={i} className={cx('rounded-hv-xs ring-1 ring-inset', layer === i ? 'ring-hv-brand bg-hv-brand-tint' : 'ring-hv-line')}>
              <button onClick={() => setLayer(layer === i ? null : i)} className="w-full text-left px-2.5 py-1 text-xs font-semibold text-hv-text flex items-center gap-2">
                {l.name}<span className="font-normal text-hv-text-3 text-[11px]">bytes {l.start}–{l.end - 1}</span>
              </button>
              <table className="w-full text-[11.5px] mb-1"><tbody>
                {l.fields.map((f, j) => <tr key={j} className="align-top"><td className="pl-6 pr-3 py-0.5 text-hv-text-3 whitespace-nowrap">{f.k}</td><td className="py-0.5 font-mono text-hv-text break-all">{f.v}</td></tr>)}
              </tbody></table>
            </div>
          ))}
          {!pk.layers.length && <div className="text-xs text-hv-text-3">Not decoded.</div>}
        </div>
        <div className="min-h-0 overflow-auto border-l border-hv-line p-2">
          <pre className="text-[11.5px] leading-relaxed font-mono text-hv-text-2">{hexDump(pk.data, 64 * 1024, hl)}</pre>
        </div>
      </div>
    </div>
  );
};

// ── Conversations ─────────────────────────────────────────────────────────
const Conversations: React.FC<{ cap: Capture; conv: number | null; setConv: (c: number) => void; onPacket: (no: number) => void }> = ({ cap, conv, setConv, onPacket }) => {
  const [kind, setKind] = useState<'all' | 'tcp' | 'udp'>('all');
  const [hideMulti, setHideMulti] = useState(true);
  const rows = useMemo(() => [...cap.conversations].filter(c => (kind === 'all' || c.l4 === kind) && !(hideMulti && (isMulti(c.b) || isMulti(c.a)))).sort((a, b) => b.bytes - a.bytes), [cap, kind, hideMulti]);
  const c = conv != null ? cap.conversations[conv] : null;
  return (
    <div className="flex-1 min-h-0 grid grid-cols-[320px_1fr]">
      <div className="min-h-0 flex flex-col border-r border-hv-line">
        <div className="px-3 py-2 border-b border-hv-line flex items-center gap-2 shrink-0">
          <Segmented value={kind} onChange={setKind} items={[{ id: 'all', label: 'All' }, { id: 'tcp', label: 'TCP' }, { id: 'udp', label: 'UDP' }]} />
          <label className="text-[11px] text-hv-text-2 inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={hideMulti} onChange={e => setHideMulti(e.target.checked)} />hide broadcasts</label>
        </div>
        <div className="flex-1 min-h-0 overflow-auto"><ConvTable cap={cap} rows={rows} onPick={setConv} active={conv} compact /></div>
      </div>
      <div className="min-h-0">
        {c ? <StreamView key={c.index} cap={cap} conv={c} onPacket={onPacket} /> : <Empty icon={<Waypoints size={28} />} title="Pick a conversation">The calls, WebSocket messages or raw bytes sent back and forth show here, put back in order.</Empty>}
      </div>
    </div>
  );
};
