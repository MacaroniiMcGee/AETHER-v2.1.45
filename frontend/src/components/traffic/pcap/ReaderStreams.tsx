// AETHER_TRAFFIC (TRAFFIC-3) — Reader › Streams: one conversation, reassembled.
// HTTP/RTSP calls (with SUNAPI tags and unpacked bodies), WebSocket frames (with RTSP/RTP inside),
// or the raw back-and-forth for anything else.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowLeft, ChevronRight, ChevronDown, AlertTriangle, Download } from 'lucide-react';
import type { Capture, Conversation } from './parse';
import { decodeBody, follow, wsInside, WS_OP, type HttpMsg } from './streams';
import { Badge, Button, Segmented, actionTone, cx, fmtBytes, statusTone } from '../../sunapi/ui';

const td = new TextDecoder('utf-8', { fatal: false });
const printable = (u: Uint8Array) => { const n = Math.min(u.length, 4096); let bad = 0; for (let i = 0; i < n; i++) { const c = u[i]; if (c < 9 || (c > 13 && c < 32) || c === 127) bad++; } return bad <= n * 0.02; };
export function hexDump(u: Uint8Array, max = 4096, hl?: [number, number]) {
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < Math.min(u.length, max); i += 16) {
    const cells: React.ReactNode[] = []; const asc: React.ReactNode[] = [];
    for (let j = i; j < Math.min(i + 16, u.length); j++) {
      const on = hl && j >= hl[0] && j < hl[1];
      cells.push(<span key={j} className={cx(on && 'bg-hv-brand-tint text-hv-text')}>{u[j].toString(16).padStart(2, '0')}{j % 16 === 7 ? '  ' : ' '}</span>);
      asc.push(<span key={j} className={cx(on && 'bg-hv-brand-tint text-hv-text')}>{u[j] >= 32 && u[j] < 127 ? String.fromCharCode(u[j]) : '.'}</span>);
    }
    rows.push(<div key={i} className="whitespace-pre"><span className="text-hv-text-3">{i.toString(16).padStart(5, '0')}  </span>{cells}{' '.repeat(Math.max(0, (16 - cells.length) * 3 + (cells.length <= 8 ? 1 : 0)))} {asc}</div>);
  }
  if (u.length > max) rows.push(<div key="more" className="text-hv-text-3">… {u.length - max} more bytes</div>);
  return rows;
}
const saveBytes = (u: Uint8Array, name: string) => { const url = URL.createObjectURL(new Blob([u as BlobPart])); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

const Bytes: React.FC<{ u: Uint8Array; name?: string; max?: number }> = ({ u, name = 'bytes.bin', max = 64 * 1024 }) => {
  const isText = printable(u);
  const [view, setView] = useState<'text' | 'hex'>(isText ? 'text' : 'hex');
  const txt = useMemo(() => {
    if (view !== 'text') return '';
    const s = td.decode(u.subarray(0, max));
    if (/^\s*[{[]/.test(s)) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { /* as is */ } }
    return s;
  }, [u, view, max]);
  if (!u.length) return <div className="text-xs text-hv-text-3">no body</div>;
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Segmented value={view} onChange={setView} items={[{ id: 'text', label: 'Text' }, { id: 'hex', label: 'Hex' }]} />
        <span className="text-[11px] text-hv-text-3">{fmtBytes(u.length)}</span>
        <span className="ml-auto" />
        <Button size="sm" tone="ghost" icon={<Download size={12} />} onClick={() => saveBytes(u, name)}>Save</Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-hv-xs bg-hv-widget px-2.5 py-2 text-[11.5px] leading-relaxed font-mono text-hv-text whitespace-pre-wrap break-all">
        {view === 'text' ? txt + (u.length > max ? `\n… ${fmtBytes(u.length - max)} more` : '') : hexDump(u)}
      </pre>
    </div>
  );
};

const Headers: React.FC<{ h: [string, string][] }> = ({ h }) => (
  <table className="w-full text-[11.5px] font-mono mb-2"><tbody>
    {h.map(([k, v], i) => <tr key={i} className="align-top border-b border-hv-line last:border-0"><td className="pr-3 py-0.5 text-hv-text-3 whitespace-nowrap">{k}</td><td className="py-0.5 text-hv-text break-all">{/^authorization$/i.test(k) && /^basic/i.test(v) ? 'Basic ••••••' : v}</td></tr>)}
  </tbody></table>
);

const Body: React.FC<{ m: HttpMsg; name: string }> = ({ m, name }) => {
  const [d, setD] = useState<{ data: Uint8Array; note?: string } | null>(null);
  useEffect(() => { let live = true; decodeBody(m).then(r => live && setD(r)); return () => { live = false; }; }, [m]);
  if (!d) return null;
  return <>{d.note && <div className="text-[11px] text-hv-text-3 mb-1">{d.note}</div>}{!m.bodyComplete && <div className="text-[11px] text-hv-warning-fg mb-1">Only part of the body is in the capture.</div>}<Bytes u={d.data} name={name} /></>;
};

const SUN = /\/([\w-]+)\/(\w+)\.cgi\?(.*)$/;
const Exchange: React.FC<{ x: { request?: HttpMsg; response?: HttpMsg }; i: number; t0: number }> = ({ x, i, t0 }) => {
  const [open, setOpen] = useState(false);
  const rq = x.request, rs = x.response;
  const sun = rq?.target ? SUN.exec(rq.target) : null;
  const q = sun ? new URLSearchParams(sun[3]) : null;
  const sm = q ? [...q].find(([k]) => k.toLowerCase() === 'msubmenu')?.[1] : '', act = q ? [...q].find(([k]) => k.toLowerCase() === 'action')?.[1] || '' : '';
  return (
    <div className="border-b border-hv-line">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-hv-widget">
        {open ? <ChevronDown size={13} className="text-hv-text-3 shrink-0" /> : <ChevronRight size={13} className="text-hv-text-3 shrink-0" />}
        <span className="text-[11px] text-hv-text-3 w-14 shrink-0 font-mono">+{((rq?.ts ?? rs?.ts ?? t0) - t0 >= 0 ? (((rq?.ts ?? rs?.ts ?? t0) - t0) / 1000).toFixed(3) : '?')}s</span>
        <span className="font-semibold text-xs text-hv-text-2 shrink-0">{rq?.method || '(no request)'}</span>
        <span className="font-mono text-xs text-hv-text truncate flex-1" title={rq?.target}>{rq?.target || '(request before the capture started)'}</span>
        {sun && <Badge tone={actionTone(act.toLowerCase())} className="shrink-0">{sm || sun[2]} · {act || '?'}</Badge>}
        {rs ? <Badge tone={statusTone(rs.status!)}>{rs.status}</Badge> : <Badge tone="neutral">no answer</Badge>}
        <span className="text-[11px] text-hv-text-3 w-16 text-right shrink-0">{rs ? fmtBytes(rs.body.length) : ''}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-3">
          <div className="min-w-0"><div className="text-[11px] font-bold uppercase tracking-wide text-hv-text-3 mb-1">Request</div>
            {rq ? <><div className="font-mono text-[11.5px] text-hv-text mb-1 break-all">{rq.first}</div><Headers h={rq.headers} /><Body m={rq} name={`request-${i + 1}.bin`} /></> : <div className="text-xs text-hv-text-3">Sent before the capture started.</div>}
          </div>
          <div className="min-w-0"><div className="text-[11px] font-bold uppercase tracking-wide text-hv-text-3 mb-1">Response</div>
            {rs ? <><div className="font-mono text-[11.5px] text-hv-text mb-1">{rs.first}</div><Headers h={rs.headers} /><Body m={rs} name={`response-${i + 1}.bin`} /></> : <div className="text-xs text-hv-text-3">No answer in the capture.</div>}
          </div>
        </div>
      )}
    </div>
  );
};

const Frame: React.FC<{ f: { opcode: number; payload: Uint8Array; partial: boolean }; fromClient: boolean; who: string }> = ({ f, fromClient, who }) => {
  const [open, setOpen] = useState(false);
  const inside = wsInside(f.payload);
  return (
    <div className={cx('border-b border-hv-line', fromClient && 'bg-hv-info-tint')}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-hv-widget text-xs">
        {fromClient ? <ArrowRight size={12} className="text-hv-info-fg shrink-0" /> : <ArrowLeft size={12} className="text-hv-text-3 shrink-0" />}
        <span className="text-hv-text-3 w-44 truncate shrink-0 font-mono">{who}</span>
        <Badge tone="neutral">{WS_OP[f.opcode] || f.opcode}</Badge>
        <span className={cx('font-mono truncate flex-1', /^RTSP/.test(inside) ? 'text-hv-text' : 'text-hv-text-2')}>{inside === 'text' || inside === 'JSON' ? td.decode(f.payload.subarray(0, 160)) : inside}</span>
        <span className="text-hv-text-3 shrink-0">{fmtBytes(f.payload.length)}{f.partial ? ' (cut)' : ''}</span>
      </button>
      {open && <div className="px-3 pb-2"><Bytes u={f.payload} name="frame.bin" /></div>}
    </div>
  );
};

export const StreamView: React.FC<{ cap: Capture; conv: Conversation; onPacket: (no: number) => void }> = ({ cap, conv, onPacket }) => {
  const fl = useMemo(() => follow(cap, conv.index), [cap, conv]);
  const ws = fl.ws;
  const [view, setView] = useState<'calls' | 'ws' | 'raw'>(fl.exchanges.length ? 'calls' : ws ? 'ws' : 'raw');
  const [frameFilter, setFrameFilter] = useState<'all' | 'control'>('control');
  useEffect(() => { setView(fl.exchanges.length ? 'calls' : fl.ws ? 'ws' : 'raw'); }, [fl]);
  const A = `${conv.a}:${conv.ap}`, B = `${conv.b}:${conv.bp}`;
  const wsFrames = useMemo(() => {
    if (!ws) return [];
    const c = ws.client.map((f, i) => ({ f, fromClient: true, k: `c${i}` })), s = ws.server.map((f, i) => ({ f, fromClient: false, k: `s${i}` }));
    // keep each side in order; interleave by position (no per-frame times inside one segment)
    const out: typeof c = []; let i = 0, j = 0;
    while (i < c.length || j < s.length) { if (j >= s.length || (i < c.length && i * s.length <= j * c.length)) out.push(c[i++]); else out.push(s[j++]); }
    return out;
  }, [ws]);
  const media = wsFrames.filter(x => /^(RTP|RTCP|interleaved)/.test(wsInside(x.f.payload))).length;
  const shownFrames = frameFilter === 'control' ? wsFrames.filter(x => !/^(RTP|RTCP|interleaved)/.test(wsInside(x.f.payload))) : wsFrames;
  const t0 = cap.packets[conv.pkts[0]].ts;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2.5 border-b border-hv-line shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone="purple">{conv.l4.toUpperCase()}</Badge><Badge tone="info">{conv.app}</Badge>
          <span className="font-mono text-xs text-hv-text">{A} → {B}</span>
        </div>
        <div className="mt-1 text-[11px] text-hv-text-3">
          {conv.packets} packets · {A.split(':')[0]} sent {fmtBytes(conv.aToB)} · {B.split(':')[0]} sent {fmtBytes(conv.bToA)} · {((conv.last - conv.first) / 1000).toFixed(2)} s
          {fl.gaps > 0 && <span className="text-hv-warning-fg"> · {fl.gaps} gap{fl.gaps > 1 ? 's' : ''} (packets missing from the capture)</span>}
          {fl.retransmits > 0 && <> · {fl.retransmits} resent</>}
          {' · '}<button className="underline hover:text-hv-text" onClick={() => onPacket(cap.packets[conv.pkts[0]].no)}>show packets</button>
        </div>
        <div className="mt-2">
          <Segmented value={view} onChange={setView} items={[
            ...(fl.exchanges.length ? [{ id: 'calls' as const, label: `${fl.exchanges[0].request?.proto || fl.exchanges[0].response?.proto || 'HTTP'} calls ${fl.exchanges.length}` }] : []),
            ...(ws ? [{ id: 'ws' as const, label: `WebSocket ${wsFrames.length}` }] : []),
            { id: 'raw' as const, label: 'Raw conversation' },
          ]} />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {view === 'calls' && fl.exchanges.map((x, i) => <Exchange key={i} x={x} i={i} t0={t0} />)}
        {view === 'ws' && ws && (
          <>
            <div className="px-3 py-2 flex items-center gap-3 text-[11.5px] text-hv-text-2 border-b border-hv-line">
              {!ws.afterUpgrade && <span className="inline-flex items-center gap-1 text-hv-text-3"><AlertTriangle size={12} />The capture started after this WebSocket opened; recognised from its frames.</span>}
              {media > 0 && (
                <span className="ml-auto inline-flex items-center gap-2">{media} video/audio frames (RTP)
                  <Segmented value={frameFilter} onChange={setFrameFilter} items={[{ id: 'control', label: 'Hide video' }, { id: 'all', label: 'Show all' }]} />
                </span>
              )}
            </div>
            {shownFrames.slice(0, 3000).map(x => <Frame key={x.k} f={x.f} fromClient={x.fromClient} who={x.fromClient ? `${ws.clientIsA ? A : B}` : `${ws.clientIsA ? B : A}`} />)}
            {!shownFrames.length && <div className="p-3 text-xs text-hv-text-3">Only video frames — press Show all.</div>}
            {shownFrames.length > 3000 && <div className="p-3 text-xs text-hv-text-3">Showing the first 3000 frames.</div>}
          </>
        )}
        {view === 'raw' && (
          <div className="p-3 space-y-2">
            {fl.messages.slice(0, 2000).map((m, i) => (
              <div key={i} className={cx('rounded-hv-xs ring-1 ring-inset', m.fromA ? 'ring-hv-info/40 bg-hv-info-tint' : 'ring-hv-line bg-hv-surface')}>
                {m.gapBefore > 0 && <div className="px-2.5 py-1 text-[11px] text-hv-warning-fg border-b border-hv-line">{fmtBytes(m.gapBefore)} missing from the capture before this</div>}
                <div className="flex items-center gap-2 px-2.5 h-7 text-[11px] text-hv-text-3 border-b border-hv-line">
                  {m.fromA ? <ArrowRight size={12} className="text-hv-info-fg" /> : <ArrowLeft size={12} />}
                  <span className="font-semibold text-hv-text-2">{m.fromA ? A : B}</span>
                  <span>+{((m.ts - t0) / 1000).toFixed(3)} s</span><span>{fmtBytes(m.data.length)}</span>
                  <button className="ml-auto underline hover:text-hv-text" onClick={() => onPacket(m.pkts[0])}>packet {m.pkts[0]}</button>
                </div>
                <div className="px-2.5 py-1.5"><Bytes u={m.data} name={`part-${i + 1}.bin`} max={16 * 1024} /></div>
              </div>
            ))}
            {!fl.messages.length && <div className="text-xs text-hv-text-3">No data in this conversation (only connection set-up / acknowledgements).</div>}
          </div>
        )}
      </div>
    </div>
  );
};
