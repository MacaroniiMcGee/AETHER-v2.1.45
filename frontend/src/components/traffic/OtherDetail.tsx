// AETHER_TRAFFIC (TRAFFIC-2) — detail views for what isn't plain HTTP:
// raw TCP / UDP conversations, DNS lookups, HTTPS passed through in gateway mode, WebSocket messages.
import React, { useMemo, useState } from 'react';
import { X, ArrowRight, ArrowLeft, Copy, Check, Lock, ShieldX, Download } from 'lucide-react';
import type { DnsFlow, StreamFlow, StreamMsg, TlsFlow } from './api';
import { Badge, Button, IconButton, Segmented, copyText, cx, fmtBytes, fmtTime } from '../sunapi/ui';

const toBytes = (m: StreamMsg): Uint8Array => {
  if (m.data == null) return new Uint8Array();
  if (m.encoding === 'utf8') return new TextEncoder().encode(m.data);
  const bin = atob(m.data); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const hex = (u: Uint8Array, max = 2048) => {
  const rows: string[] = [];
  for (let i = 0; i < Math.min(u.length, max); i += 16) {
    const c = u.slice(i, i + 16);
    rows.push(`${i.toString(16).padStart(5, '0')}  ${[...c].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${[...c].map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
  }
  if (u.length > max) rows.push(`… ${u.length - max} more bytes`);
  return rows.join('\n');
};
const printable = (m: StreamMsg) => m.encoding === 'utf8' && m.data != null && !/[\x00-\x08\x0e-\x1f]/.test(m.data);

/** One conversation: what the client sent (→) and what came back (←). */
export const Messages: React.FC<{ msgs: StreamMsg[]; t0: number; clientLabel: string; serverLabel: string; dropped?: number }> = ({ msgs, t0, clientLabel, serverLabel, dropped }) => {
  const [view, setView] = useState<'auto' | 'hex'>('auto');
  const [copied, setCopied] = useState<number | null>(null);
  if (!msgs.length) return <div className="text-xs text-hv-text-3">No data yet.</div>;
  const all = () => {
    const parts = msgs.map(toBytes); const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    const url = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = 'conversation.bin'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Segmented value={view} onChange={setView} items={[{ id: 'auto', label: 'Text where possible' }, { id: 'hex', label: 'Hex' }]} />
        <span className="ml-auto" />
        <Button size="sm" tone="ghost" icon={<Download size={13} />} onClick={all} title="Both directions in order, joined">Save bytes</Button>
      </div>
      {!!dropped && <div className="text-[11px] text-hv-warning-fg">The first {dropped} messages are no longer kept (only the newest are); the counters above still include them.</div>}
      {msgs.map((m, i) => {
        const u = toBytes(m);
        const text = view === 'auto' && printable(m);
        return (
          <div key={i} className={cx('rounded-hv-xs ring-1 ring-inset', m.fromClient ? 'ring-hv-info/40 bg-hv-info-tint' : 'ring-hv-line bg-hv-surface')}>
            <div className="flex items-center gap-2 px-2.5 h-7 text-[11px] text-hv-text-3 border-b border-hv-line">
              {m.fromClient ? <ArrowRight size={12} className="text-hv-info-fg" /> : <ArrowLeft size={12} />}
              <span className="font-semibold text-hv-text-2">{m.fromClient ? clientLabel : serverLabel}</span>
              <span>+{Math.max(0, Math.round(m.ts * 1000 - t0))} ms</span>
              <span>{fmtBytes(m.bytes)}{m.truncated ? ' (cut)' : ''}</span>
              <span className="ml-auto" />
              <IconButton label="Copy as hex" onClick={() => copyText([...u].map(b => b.toString(16).padStart(2, '0')).join('')).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1000); })}>
                {copied === i ? <Check size={12} /> : <Copy size={12} />}
              </IconButton>
            </div>
            <pre className="px-2.5 py-1.5 max-h-56 overflow-auto text-[11.5px] leading-relaxed font-mono text-hv-text whitespace-pre-wrap break-all">{text ? m.data : hex(u)}</pre>
          </div>
        );
      })}
    </div>
  );
};

const Head: React.FC<{ badge: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; onClose: () => void }> = ({ badge, title, sub, onClose }) => (
  <div className="px-4 pt-3 pb-2 border-b border-hv-line shrink-0">
    <div className="flex items-center gap-2">{badge}<span className="ml-auto" /><IconButton label="Close" onClick={onClose}><X size={15} /></IconButton></div>
    <div className="mt-1.5 font-mono text-[12px] text-hv-text break-all">{title}</div>
    {sub && <div className="mt-1 text-xs text-hv-text-3">{sub}</div>}
  </div>
);

export const StreamDetail: React.FC<{ f: StreamFlow; onClose: () => void }> = ({ f, onClose }) => (
  <div className="flex flex-col h-full min-h-0">
    <Head onClose={onClose}
      badge={<><Badge tone="purple">{f.kind.toUpperCase()}</Badge>{f.closed ? <Badge tone={f.error ? 'error' : 'neutral'}>{f.error ? 'failed' : 'closed'}</Badge> : <Badge tone="success">open</Badge>}{f.sni && <Badge tone="info"><Lock size={10} />{f.sni}</Badge>}</>}
      title={<>{f.client} → {f.server[0]}:{f.server[1]}</>}
      sub={<>{f.count} messages · ↑ {fmtBytes(f.up)} sent · ↓ {fmtBytes(f.down)} received · started {fmtTime(f.ts)}{f.error ? ` · ${f.error}` : ''}</>} />
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <Messages msgs={f.messages} t0={f.ts} clientLabel={`${f.client} sent`} serverLabel={`${f.server[0]} answered`} dropped={f.dropped} />
    </div>
  </div>
);

const RecTable: React.FC<{ title: string; rows?: { name: string; type: string; ttl?: number; data: string }[] }> = ({ title, rows }) => (
  !rows || !rows.length ? null : (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-hv-text-3 mb-1">{title}</div>
      <table className="w-full text-[12px] font-mono">
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-b border-hv-line last:border-0">
            <td className="py-1 pr-3 text-hv-text-2">{r.name}</td><td className="py-1 pr-3 text-hv-text-3">{r.type}</td>
            <td className="py-1 pr-3 text-hv-text-3">{r.ttl != null ? `${r.ttl}s` : ''}</td><td className="py-1 text-hv-text break-all">{r.data}</td>
          </tr>))}</tbody>
      </table>
    </div>
  )
);

export const DnsDetail: React.FC<{ f: DnsFlow; onClose: () => void }> = ({ f, onClose }) => {
  const q = f.request?.questions?.[0];
  const rc = (f.response?.response_code as string) || '';
  return (
    <div className="flex flex-col h-full min-h-0">
      <Head onClose={onClose}
        badge={<><Badge tone="purple">DNS</Badge>{f.error ? <Badge tone="error">failed</Badge> : f.response ? <Badge tone={rc === 'NOERROR' ? 'success' : 'warning'}>{rc || 'answered'}</Badge> : <Badge tone="warning">waiting</Badge>}</>}
        title={<>{q ? `${q.type} ${q.name}` : 'lookup'}</>}
        sub={<>asked by {f.client} · {fmtTime(f.ts)}{f.error ? ` · ${f.error}` : ''}</>} />
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        <RecTable title="Question" rows={(f.request?.questions || []).map(x => ({ name: x.name, type: x.type, data: x.class || '' }))} />
        <RecTable title="Answers" rows={f.response?.answers} />
        <RecTable title="Authority" rows={f.response?.authorities} />
        <RecTable title="Additional" rows={f.response?.additionals} />
        {f.response && !f.response.answers?.length && <div className="text-xs text-hv-text-3">No answers ({rc}).</div>}
        <p className="text-[11px] text-hv-text-3">The Pi answers the device's DNS itself (using the Pi's own DNS servers), so lookups show here even when the device asks a server on the internet.</p>
      </div>
    </div>
  );
};

export const TlsDetail: React.FC<{ f: TlsFlow; onClose: () => void }> = ({ f, onClose }) => (
  <div className="flex flex-col h-full min-h-0">
    <Head onClose={onClose}
      badge={<><Badge tone="purple">HTTPS</Badge>{f.failed ? <Badge tone="error"><ShieldX size={10} />refused the Pi's certificate</Badge> : <Badge tone="neutral"><Lock size={10} />passed through</Badge>}</>}
      title={<>{f.client} → {f.sni || f.server[0]}{f.sni && f.sni !== f.server[0] ? ` (${f.server[0]})` : ''}:{f.server[1]}</>}
      sub={<>{fmtTime(f.ts)}{f.alpn.length ? ` · offers ${f.alpn.join(', ')}` : ''}</>} />
    <div className="flex-1 min-h-0 overflow-auto p-3 text-sm text-hv-text-2 space-y-2">
      {f.failed ? (
        <>
          <p>The device checks certificates, so it would not talk to the Pi while decrypting was on — this connection failed.</p>
          <p className="text-xs text-hv-text-3">Turn off "Try to decrypt HTTPS" in Setup to let it through again. Only a device that can be told to trust the Pi's certificate can be read.</p>
        </>
      ) : (
        <>
          <p>The device opened an encrypted connection to <b className="font-mono">{f.sni || f.server[0]}</b>. It was passed through without decrypting, so the device keeps working; what was sent inside isn't visible.</p>
          <p className="text-xs text-hv-text-3">To try to see inside, turn on "Try to decrypt HTTPS" in Setup. Many devices refuse the Pi's certificate — those connections then fail and show here as refused. A packet capture shows the encrypted bytes and timing.</p>
        </>
      )}
    </div>
  </div>
);

export const wsText = (m: StreamMsg) => (m.encoding === 'utf8' ? m.data || '' : `(${fmtBytes(m.bytes)} binary)`);
export const useT0 = (msgs: StreamMsg[]) => useMemo(() => (msgs[0] ? msgs[0].ts * 1000 : 0), [msgs]);
