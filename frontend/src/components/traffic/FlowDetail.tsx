// AETHER_TRAFFIC — one captured request: request, response, and replay through the SUNAPI Console
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Check, Download, RotateCcw, X, Loader2, AlertTriangle, Lock, Unlock } from 'lucide-react';
import type { AnyFlow, DnsFlow, Flow, FlowSummary, StreamFlow, TlsFlow, TrafficClient } from './api';
import { DnsDetail, Messages, StreamDetail, TlsDetail } from './OtherDetail';
import { client as sunapiClient, defaultBackend, type Device, type SunapiResult } from '../sunapi/api';
import { ResponseView } from '../sunapi/ResponseView';
import { Badge, Button, Dialog, IconButton, Tabs, actionTone, copyText, cx, download, fmtBytes, fmtTime, statusTone } from '../sunapi/ui';

const SAFE = new Set(['view', 'check', 'monitor', 'monitordiff']);

export const modeLabel = (m: string) => {
  const port = /@(\d+)$/.exec(m)?.[1];
  if (m.startsWith('reverse:')) return `Device · Pi :${port || '?'}`;
  if (m.startsWith('regular')) return `Proxy · Pi :${port || '8080'}`;
  if (m.startsWith('transparent')) return 'Gateway';
  if (m.startsWith('dns')) return 'Gateway DNS';
  return m || '—';
};

export const flowUrl = (f: { scheme: string; host: string; port: number; path: string }) =>
  `${f.scheme}://${f.host.includes(':') ? `[${f.host}]` : f.host}${(f.scheme === 'https' && f.port === 443) || (f.scheme === 'http' && f.port === 80) ? '' : ':' + f.port}${f.path}`;

const hdr = (h: [string, string][], name: string) => h.find(([k]) => k.toLowerCase() === name)?.[1] || '';
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function curlOf(f: Flow) {
  const rq = f.request;
  const parts = ['curl -k', rq.method !== 'GET' ? `-X ${rq.method}` : '', sq(flowUrl(rq))];
  const auth = hdr(rq.headers, 'authorization');
  const user = /username="([^"]*)"/.exec(auth)?.[1] || /\(user: ([^)]*)\)/.exec(auth)?.[1];
  if (user) parts.push(/^digest/i.test(auth) ? '--digest' : '', `-u ${sq(user)}`);
  for (const [k, v] of rq.headers) {
    if (/^(host|content-length|authorization|proxy-authorization|connection|accept-encoding)$/i.test(k)) continue;
    parts.push(`-H ${sq(`${k}: ${v}`)}`);
  }
  if (rq.body && rq.bytes) parts.push(rq.bodyEncoding === 'utf8' ? `--data-binary ${sq(rq.body)}` : '--data-binary @body.bin   # binary body: use "Save body" first');
  return parts.filter(Boolean).join(' \\\n  ');
}

function hexDump(b64: string, max = 4096) {
  let bin: string;
  try { bin = atob(b64); } catch { return '(not valid base64)'; }
  const rows: string[] = [];
  for (let i = 0; i < Math.min(bin.length, max); i += 16) {
    const chunk = bin.slice(i, i + 16);
    const hex = [...chunk].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
    const asc = [...chunk].map(c => { const n = c.charCodeAt(0); return n >= 32 && n < 127 ? c : '.'; }).join('');
    rows.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${asc}`);
  }
  if (bin.length > max) rows.push(`… ${bin.length - max} more bytes — use Save body`);
  return rows.join('\n');
}

function saveBody(m: { body: string | null; bodyEncoding: 'utf8' | 'base64' }, name: string, type: string) {
  if (m.body == null) return;
  if (m.bodyEncoding === 'utf8') return download(name, m.body, type || 'text/plain');
  const bin = atob(m.body); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([u8], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const Headers: React.FC<{ h: [string, string][] }> = ({ h }) => (
  <table className="w-full text-[12px] font-mono">
    <tbody>
      {h.map(([k, v], i) => (
        <tr key={i} className="border-b border-hv-line last:border-0 align-top">
          <td className="py-1 pr-3 text-hv-text-3 whitespace-nowrap">{k}</td>
          <td className="py-1 text-hv-text break-all">{v}</td>
        </tr>
      ))}
      {!h.length && <tr><td className="py-1 text-hv-text-3">No headers</td></tr>}
    </tbody>
  </table>
);

const Section: React.FC<{ title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-surface">
    <div className="flex items-center justify-between gap-2 px-3 h-8 border-b border-hv-line">
      <span className="text-[11px] font-bold uppercase tracking-wide text-hv-text-3">{title}</span>{right}
    </div>
    <div className="px-3 py-2">{children}</div>
  </div>
);

const RequestBody: React.FC<{ f: Flow }> = ({ f }) => {
  const rq = f.request;
  const ct = hdr(rq.headers, 'content-type');
  const text = useMemo(() => {
    if (rq.body == null || rq.bodyEncoding !== 'utf8') return null;
    if (/json/i.test(ct) || /^\s*[{[]/.test(rq.body)) { try { return JSON.stringify(JSON.parse(rq.body), null, 2); } catch { /* as is */ } }
    if (/x-www-form-urlencoded/i.test(ct)) { try { return [...new URLSearchParams(rq.body)].map(([k, v]) => `${k} = ${v}`).join('\n'); } catch { /* */ } }
    return rq.body;
  }, [rq.body, rq.bodyEncoding, ct]);
  if (!rq.bytes) return <div className="text-xs text-hv-text-3">No body</div>;
  return (
    <>
      {rq.truncated && <div className="mb-2 text-[11px] text-hv-warning-fg">Only the first part is kept ({fmtBytes(rq.body ? (rq.bodyEncoding === 'base64' ? Math.floor(rq.body.length * 0.75) : rq.body.length) : 0)} of {fmtBytes(rq.bytes)}). Change the limit in Setup.</div>}
      <pre className="max-h-[320px] overflow-auto text-[12px] leading-relaxed font-mono text-hv-text whitespace-pre-wrap break-all">{text ?? hexDump(rq.body || '')}</pre>
    </>
  );
};

export const FlowDetail: React.FC<{ summary: FlowSummary; api: TrafficClient; onClose: () => void }> = ({ summary, api, onClose }) => {
  const [any, setFlow] = useState<AnyFlow | null>(null);
  const flow = any && (any.kind || 'http') === 'http' ? (any as Flow) : null;
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'request' | 'response' | 'ws' | 'replay'>('response');
  const [copied, setCopied] = useState<string | null>(null);
  const sunapi = useMemo(() => sunapiClient(defaultBackend()), []);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [replay, setReplay] = useState<{ busy?: boolean; result?: SunapiResult; error?: string; device?: Device } | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { setReplay(null); setTab(summary.ws ? 'ws' : summary.pending ? 'request' : 'response'); }, [summary.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    api.flow(summary.id).then(f => { if (live) { setFlow(f); setErr(null); } }).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [api, summary.id, summary.seq]);
  useEffect(() => { sunapi.devices().then(setDevices).catch(() => setDevices([])); }, [sunapi]);

  const match = useMemo(() => {
    if (!flow?.sunapi || !devices) return null;
    const h = flow.request.host;
    return devices.find(d => d.host === h && d.port === flow.request.port) || devices.find(d => d.host === h) || null;
  }, [flow, devices]);

  const flash = (k: string) => { setCopied(k); setTimeout(() => setCopied(null), 1200); };

  const doReplay = async () => {
    if (!flow || !match) return;
    setConfirm(false); setTab('replay'); setReplay({ busy: true, device: match });
    const [p, q = ''] = flow.request.path.split('?');
    try {
      const result = await sunapi.request(match.id, {
        path: p, query: q, method: flow.request.method === 'POST' ? 'POST' : 'GET',
        body: flow.request.method === 'POST' && flow.request.bodyEncoding === 'utf8' ? flow.request.body || undefined : undefined,
        accept: 'text', confirmed: true, origin: 'traffic',
      });
      setReplay({ result, device: match });
    } catch (e) { setReplay({ error: (e as Error).message, device: match }); }
  };

  if (err) return <div className="p-4 text-sm text-hv-error-fg flex items-center gap-2"><AlertTriangle size={15} />{err}</div>;
  if (!any || any.id !== summary.id) return <div className="p-4 text-sm text-hv-text-3 flex items-center gap-2"><Loader2 size={15} className="animate-spin" />Loading…</div>;
  if (any.kind === 'tcp' || any.kind === 'udp') return <StreamDetail f={any as StreamFlow} onClose={onClose} />;
  if (any.kind === 'dns') return <DnsDetail f={any as DnsFlow} onClose={onClose} />;
  if (any.kind === 'tls') return <TlsDetail f={any as TlsFlow} onClose={onClose} />;
  if (!flow) return null;

  const rq = flow.request, rs = flow.response;
  const url = flowUrl(rq);
  const action = flow.sunapi?.action?.toLowerCase() || '';
  const unsafe = !!action && !SAFE.has(action);
  const replayable = flow.sunapi && (rq.method === 'GET' || (rq.method === 'POST' && (rq.bodyEncoding === 'utf8' || !rq.bytes)));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 pt-3 pb-2 border-b border-hv-line shrink-0">
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{rq.method}</Badge>
          {rs ? <Badge tone={statusTone(rs.status)}>{rs.status} {rs.reason}</Badge> : flow.error ? <Badge tone="error">failed</Badge> : <Badge tone="warning"><Loader2 size={11} className="animate-spin" />waiting</Badge>}
          {flow.sunapi && <Badge tone={actionTone(action)} title="SUNAPI call">{flow.sunapi.cgi} › {flow.sunapi.submenu || '—'} · {flow.sunapi.action || '—'}</Badge>}
          <span className="ml-auto" />
          <IconButton label="Close" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="mt-1.5 font-mono text-[12px] text-hv-text break-all leading-snug">{url}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="sm" icon={copied === 'url' ? <Check size={13} /> : <Copy size={13} />} onClick={() => copyText(url).then(() => flash('url'))}>Copy URL</Button>
          <Button size="sm" icon={copied === 'curl' ? <Check size={13} /> : <Copy size={13} />} onClick={() => copyText(curlOf(flow)).then(() => flash('curl'))} title="Passwords are never included — curl asks for it">Copy as curl</Button>
          {rq.bytes > 0 && <Button size="sm" tone="ghost" icon={<Download size={13} />} onClick={() => saveBody(rq, `request-body${rq.bodyEncoding === 'base64' ? '.bin' : '.txt'}`, hdr(rq.headers, 'content-type'))}>Save body</Button>}
          <Button size="sm" tone="ghost" icon={<Download size={13} />} onClick={() => api.saveHar([flow.id]).catch(e => alert(e.message))}>HAR</Button>
          {replayable && (
            <Button size="sm" tone={match ? 'primary' : 'secondary'} disabled={!match || replay?.busy} busy={replay?.busy} icon={<RotateCcw size={13} />}
              title={match ? `Send the same call to ${match.name} with the login saved in the SUNAPI Console` : 'Add this device to the SUNAPI Console to replay its calls with a saved login'}
              onClick={() => (unsafe ? setConfirm(true) : doReplay())}>
              {match ? `Replay with ${match.name}` : 'Replay (device not in SUNAPI Console)'}
            </Button>
          )}
        </div>
      </div>

      <Tabs size="sm" className="px-3 shrink-0" value={tab} onChange={setTab}
        items={[{ id: 'request', label: 'Request' }, { id: 'response', label: 'Response' },
          ...(flow.ws ? [{ id: 'ws' as const, label: 'WebSocket', count: flow.ws.count }] : []),
          ...(replay ? [{ id: 'replay' as const, label: 'Replay' }] : [])]} />

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {tab === 'request' && (
          <>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-hv-text-3">From</span><span className="font-mono text-hv-text">{flow.client}</span>
              <span className="text-hv-text-3">Through</span><span className="text-hv-text">{modeLabel(flow.mode)}</span>
              <span className="text-hv-text-3">Client link</span><span className="text-hv-text inline-flex items-center gap-1">{flow.clientTls ? <><Lock size={12} />HTTPS</> : <><Unlock size={12} />plain HTTP</>} · {rq.httpVersion}</span>
              <span className="text-hv-text-3">Sent</span><span className="text-hv-text">{fmtTime(flow.ts)}{rs?.tsEnd ? ` · answered in ${Math.round(rs.tsEnd * 1000 - flow.ts)} ms` : ''}</span>
            </div>
            <Section title="Headers"><Headers h={rq.headers} /></Section>
            <Section title={<>Body · {fmtBytes(rq.bytes)}</>}><RequestBody f={flow} /></Section>
          </>
        )}
        {tab === 'ws' && flow.ws && (
          <>
            <div className="text-xs text-hv-text-3">{flow.ws.count} messages · ↑ {fmtBytes(flow.ws.up)} · ↓ {fmtBytes(flow.ws.down)}{flow.ws.closed ? ` · closed${flow.ws.closeCode != null ? ` (${flow.ws.closeCode})` : ''}` : ' · open'}</div>
            <Messages msgs={flow.ws.messages} t0={flow.ts} clientLabel={`${flow.client} sent`} serverLabel={`${rq.host} sent`} dropped={flow.ws.dropped} />
          </>
        )}
        {tab === 'response' && rs?.locationWas && (
          <div className="mb-2 rounded-hv-xs bg-hv-info-tint ring-1 ring-inset ring-hv-info/40 px-3 py-2 text-[11.5px] text-hv-info-fg">
            The device redirected to <span className="font-mono">{rs.locationWas}</span> — its own address. The Pi changed that to its own port so the program stays inside the capture.
          </div>
        )}
        {tab === 'response' && (
          rs ? (
            <div className="h-[calc(100%-4px)] min-h-[360px]">
              <ResponseView fileBase="captured-response" r={{
                status: rs.status, statusText: rs.reason, bytes: rs.bytes, truncated: rs.truncated, contentType: hdr(rs.headers, 'content-type'),
                ms: rs.tsEnd ? Math.round(rs.tsEnd * 1000 - flow.ts) : undefined, body: rs.body || '', bodyEncoding: rs.bodyEncoding,
                headers: Object.fromEntries(rs.headers), label: flow.sunapi ? `${flow.sunapi.cgi}.cgi › ${flow.sunapi.submenu} · ${flow.sunapi.action}` : undefined,
              }} />
            </div>
          ) : flow.error ? (
            <div className="rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 p-3 text-sm text-hv-error-fg flex gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" /><div><div className="font-semibold">No answer</div><div className="text-xs mt-0.5 break-all">{flow.error}</div></div>
            </div>
          ) : (
            <div className="text-sm text-hv-text-3 flex items-center gap-2"><Loader2 size={15} className="animate-spin" />The device has not answered yet — it shows here as soon as it does.</div>
          )
        )}
        {tab === 'replay' && replay && (
          replay.busy ? <div className="text-sm text-hv-text-3 flex items-center gap-2"><Loader2 size={15} className="animate-spin" />Sending to {replay.device?.name}…</div>
            : replay.error ? <div className="rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 p-3 text-sm text-hv-error-fg">{replay.error}</div>
              : replay.result && (
                <>
                  <div className="text-xs text-hv-text-2">
                    Sent by Aether with <b>{replay.device?.name}</b>'s saved login.
                    {rs && <> Captured answer: <Badge tone={statusTone(rs.status)}>{rs.status}</Badge> {fmtBytes(rs.bytes)} → replay: <Badge tone={statusTone(replay.result.status)}>{replay.result.status}</Badge> {fmtBytes(replay.result.bytes)}{rs.bytes !== replay.result.bytes ? <span className="text-hv-warning-fg"> · size differs</span> : <span className="text-hv-success-fg"> · same size</span>}</>}
                    {' '}It is also in that device's History in the SUNAPI Console.
                  </div>
                  <div className="h-[calc(100%-40px)] min-h-[360px]"><ResponseView fileBase="replay-response" r={{ ...replay.result, label: 'Replay' }} /></div>
                </>
              )
        )}
      </div>

      <Dialog open={confirm} title={`Send "${action}" again?`} onClose={() => setConfirm(false)}
        footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button tone="danger" onClick={doReplay}>Send to {match?.name}</Button></>}>
        <p>This call <b>changes the device</b> ({flow.sunapi?.cgi} › {flow.sunapi?.submenu}). Replaying it sends exactly the same change to <b>{match?.name}</b> ({match?.host}) now.</p>
        {/door|output|relay|alarm|reader/i.test(`${flow.sunapi?.submenu}`) && <p className={cx('mt-2 text-hv-warning-fg')}>This can move real hardware (doors, outputs, readers).</p>}
      </Dialog>
    </div>
  );
};
