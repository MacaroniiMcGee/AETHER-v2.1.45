// AETHER_TRAFFIC — Traffic Inspector (Tools): see exactly what other programs (Wisenet WAVE,
// SUNAPI Test Client, phone apps…) send to Hanwha cameras and controllers. The Pi runs
// mitmproxy as a proxy / per-device relay; every call is listed here live and can be
// replayed through the SUNAPI Console with a saved login.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Search, Trash2, Download, ChevronDown, Loader2, AlertTriangle, Radio, Settings as Cog, PlugZap, ScrollText, Waypoints, Lock, ShieldX, FileSearch } from 'lucide-react';
import { trafficClient, defaultBackend, type FlowSummary, type Settings, type Status } from './api';
import { FlowDetail, modeLabel } from './FlowDetail';
import { SetupPanel, ConnectPanel, normalise } from './Setup';
import { PcapPanel } from './PcapPanel';
import { PcapReader } from './pcap/PcapReader';
import { Badge, Button, Empty, Input, Segmented, Tabs, Toggle, actionTone, cx, fmtBytes, lsGet, lsSet, statusTone } from '../sunapi/ui';

type Page = 'requests' | 'setup' | 'connect' | 'pcap' | 'reader' | 'log';
type Filter = 'all' | 'sunapi' | 'other' | 'problems';
const SHOW_MAX = 1500;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
const until = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const hostPort = (f: FlowSummary) => `${f.host}${(f.scheme === 'https' && f.port === 443) || (f.scheme === 'http' && f.port === 80) ? '' : ':' + f.port}`;

/** The "Request" cell: what happened, in one or two lines. */
const RowText: React.FC<{ f: FlowSummary }> = ({ f }) => {
  if (f.kind === 'http') return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-semibold text-hv-text-2 shrink-0">{f.method}</span>
        <span className="font-mono text-hv-text-3 shrink-0">{hostPort(f)}</span>
        {f.sunapi && <Badge tone={actionTone((f.sunapi.action || '').toLowerCase())} className="shrink-0">{f.sunapi.submenu || f.sunapi.cgi} · {f.sunapi.action || '?'}</Badge>}
        {f.ws && <Badge tone="purple" className="shrink-0">WebSocket · {f.ws.count}</Badge>}
      </div>
      <div className="font-mono text-hv-text truncate" title={f.path}>{f.path}</div>
    </>
  );
  const label = f.kind === 'tls' ? 'HTTPS' : f.method;
  return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <Badge tone="purple" className="shrink-0">{label}</Badge>
        <span className="font-mono text-hv-text-3 truncate">{f.kind === 'dns' ? 'lookup' : `${f.host}:${f.port}`}</span>
        {(f.stream?.sni || f.tls?.sni) && <span className="text-hv-text-3 inline-flex items-center gap-1 shrink-0"><Lock size={11} />{f.stream?.sni || f.tls?.sni}</span>}
      </div>
      <div className="font-mono text-hv-text truncate">
        {f.kind === 'dns' && f.dns ? <>{f.dns.question}{f.dns.answers.length ? <span className="text-hv-text-3"> → {f.dns.answers.join(', ')}</span> : null}</>
          : f.stream ? <span className="text-hv-text-2">{f.stream.count} messages · ↑ {fmtBytes(f.stream.up)} · ↓ {fmtBytes(f.stream.down)}</span>
            : f.tls ? <span className="text-hv-text-2">{f.tls.failed ? "refused the Pi's certificate" : 'encrypted, passed through'}{f.tls.alpn.length ? ` · ${f.tls.alpn.join(', ')}` : ''}</span> : null}
      </div>
    </>
  );
};

const RowStatus: React.FC<{ f: FlowSummary }> = ({ f }) => {
  if (f.kind === 'http') return f.status !== null ? <Badge tone={statusTone(f.status)}>{f.status}</Badge> : f.error ? <Badge tone="error" title={f.error}>failed</Badge> : <Loader2 size={13} className="animate-spin text-hv-warning-fg" aria-label="waiting" />;
  if (f.kind === 'tls') return f.tls?.failed ? <Badge tone="error"><ShieldX size={10} /></Badge> : <Badge tone="neutral"><Lock size={10} /></Badge>;
  if (f.kind === 'dns') return f.error ? <Badge tone="error" title={f.error}>failed</Badge> : f.pending ? <Loader2 size={13} className="animate-spin text-hv-warning-fg" /> : <Badge tone={f.dns?.rcode === 'NOERROR' ? 'success' : 'warning'}>{f.dns?.rcode === 'NOERROR' ? 'ok' : (f.dns?.rcode || '?').toLowerCase()}</Badge>;
  return f.error ? <Badge tone="error" title={f.error}>failed</Badge> : f.stream?.closed ? <Badge tone="neutral">closed</Badge> : <Badge tone="success">open</Badge>;
};

const TrafficInspector: React.FC<{ backendUrl?: string }> = ({ backendUrl }) => {
  const api = useMemo(() => trafficClient(backendUrl || defaultBackend()), [backendUrl]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(() => lsGet('aether.traffic.page', 'requests'));
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>(() => lsGet('aether.traffic.filter', 'all'));
  const [client, setClient] = useState('');
  const [hideAuth, setHideAuth] = useState<boolean>(() => lsGet('aether.traffic.hideAuth', true));
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [exportMenu, setExportMenu] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [draft, setDraft] = useState<Settings | null>(null);   // unsaved Setup changes (kept while switching tabs)
  const [releasing, setReleasing] = useState(false);
  const [readerOn, setReaderOn] = useState(false);       // keep the Reader (and its open file) once visited
  const [readPi, setReadPi] = useState(0);
  const seq = useRef(0);
  const epoch = useRef(-1);

  useEffect(() => { lsSet('aether.traffic.page', page); if (page === 'reader') setReaderOn(true); }, [page]);
  useEffect(() => lsSet('aether.traffic.filter', filter), [filter]);
  useEffect(() => lsSet('aether.traffic.hideAuth', hideAuth), [hideAuth]);

  const loadStatus = useCallback(() => api.status().then(s => { setStatus(s); setLoadErr(null); return s; }).catch(e => { setLoadErr(e.message); return null; }), [api]);

  const pull = useCallback(async () => {
    const r = await api.flows(epoch.current === -1 ? 0 : seq.current);
    if (r.epoch !== epoch.current) {   // first load or the list was cleared
      const full = epoch.current === -1 || seq.current === 0 ? r : await api.flows(0);
      epoch.current = r.epoch; seq.current = full.seq; setFlows(full.flows);
      return;
    }
    seq.current = r.seq;
    if (!r.flows.length) return;
    setFlows(prev => {
      const byId = new Map(prev.map((f, i) => [f.id, i]));
      const next = prev.slice();
      for (const f of r.flows) { const i = byId.get(f.id); if (i === undefined) next.push(f); else next[i] = f; }
      return next.length > 3000 ? next.slice(next.length - 3000) : next;
    });
  }, [api]);

  useEffect(() => { loadStatus(); pull().catch(() => {}); }, [loadStatus, pull]);
  const running = status?.state === 'running';
  useEffect(() => {
    const t = setInterval(loadStatus, running ? 3000 : 6000);
    return () => clearInterval(t);
  }, [loadStatus, running]);
  useEffect(() => {
    if (!running && !flows.some(f => f.pending && f.kind === 'http')) return;
    const t = setInterval(() => pull().catch(() => {}), 1000);
    return () => clearInterval(t);
  }, [pull, running, flows]);
  useEffect(() => {
    if (page !== 'log') return;
    const get = () => api.log().then(r => setLog(r.lines)).catch(() => {});
    get(); const t = setInterval(get, 2000);
    return () => clearInterval(t);
  }, [api, page]);

  const start = async () => {
    setBusy('start'); setActionErr(null);
    try {
      if (draft && JSON.stringify(draft) !== JSON.stringify(status?.settings)) { await api.saveSettings(normalise(draft)); setDraft(null); }
      setStatus(await api.start()); setPage(p => (p === 'setup' ? 'requests' : p));
    } catch (e) { setActionErr((e as Error).message); loadStatus(); }
    finally { setBusy(null); }
  };
  const stop = async () => {
    setBusy('stop'); setActionErr(null);
    try { setStatus(await api.stop()); pull().catch(() => {}); } catch (e) { setActionErr((e as Error).message); }
    finally { setBusy(null); }
  };
  const release = async () => { setReleasing(true); setActionErr(null); try { setStatus(await api.releaseGateway()); } catch (e) { setActionErr((e as Error).message); } finally { setReleasing(false); } };
  const clear = async () => { await api.clear().catch(() => {}); setSelected(null); epoch.current = -1; seq.current = 0; await pull().catch(() => {}); loadStatus(); };

  const clients = useMemo(() => [...new Set(flows.map(f => f.client))].sort(), [flows]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out: FlowSummary[] = [];
    for (let i = flows.length - 1; i >= 0 && out.length < SHOW_MAX; i--) {
      const f = flows[i];
      if (hideAuth && f.challenge && f.id !== selected) continue;
      if (filter === 'sunapi' && !f.sunapi) continue;
      if (filter === 'other' && f.kind === 'http' && !f.ws) continue;
      if (filter === 'problems' && !(f.error || (f.status !== null && f.status >= 400))) continue;
      if (client && f.client !== client) continue;
      if (needle && !`${f.method} ${f.host}:${f.port}${f.path} ${f.status ?? ''} ${f.client} ${f.dns ? f.dns.question + ' ' + f.dns.answers.join(' ') : ''} ${f.stream?.sni || f.tls?.sni || ''}`.toLowerCase().includes(needle)) continue;
      out.push(f);
    }
    return out;
  }, [flows, q, filter, client, hideAuth, selected]);
  const sel = flows.find(f => f.id === selected) || null;
  const sunapiCount = useMemo(() => flows.filter(f => f.sunapi).length, [flows]);
  const challenges = useMemo(() => flows.filter(f => f.challenge).length, [flows]);
  const otherCount = useMemo(() => flows.filter(f => f.kind !== 'http' || f.ws).length, [flows]);

  if (!status && !loadErr) return <div className="h-[calc(100vh-210px)] flex items-center justify-center text-hv-text-3 text-sm gap-2"><Loader2 size={16} className="animate-spin" />Loading…</div>;
  if (!status) return <div className="rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line"><Empty icon={<AlertTriangle size={28} />} title="Can't reach the Traffic Inspector">{loadErr}</Empty></div>;

  const st = status.state;
  const dot = st === 'running' ? 'bg-hv-success animate-pulse' : st === 'starting' || st === 'stopping' ? 'bg-hv-warning animate-pulse' : st === 'error' ? 'bg-hv-error' : 'bg-hv-line-strong';
  const listening = status.listeners.map(l => (l.kind === 'proxy' ? `proxy :${l.port}` : l.kind === 'gateway' ? `gateway for ${(l.devices || []).join(', ')}${l.decrypt ? ' (decrypting)' : ''}` : `:${l.port} → ${l.name || l.target?.replace(/^https?:\/\//, '')}`)).join(' · ');
  const unsaved = !!draft && JSON.stringify(draft) !== JSON.stringify(status.settings);

  return (
    <div className="flex flex-col rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line overflow-hidden" style={{ height: 'calc(100vh - 210px)', minHeight: 560 }}>
      {/* status bar */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-hv-line shrink-0">
        <span className={cx('w-2.5 h-2.5 rounded-full shrink-0', dot)} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-hv-text">
            {st === 'running' ? 'Capturing' : st === 'starting' ? 'Starting…' : st === 'stopping' ? 'Stopping…' : st === 'error' ? 'Stopped with an error' : 'Not capturing'}
            {running && status.autoStopAt && <span className="ml-2 text-xs font-normal text-hv-text-3">stops by itself at {until(status.autoStopAt)}</span>}
          </div>
          <div className="text-[11px] text-hv-text-3 truncate font-mono">
            {running ? `${status.addresses[0]?.address || ''} ${listening}` : status.installed ? `mitmproxy ${status.version}` : 'mitmproxy is not installed on this Pi'}
          </div>
        </div>
        {(actionErr || (status.error && st !== 'running')) && (
          <span className={cx('max-w-[420px] truncate text-xs flex items-center gap-1.5', st === 'error' || actionErr ? 'text-hv-error-fg' : 'text-hv-text-3')} title={actionErr || status.error || ''}>
            <AlertTriangle size={13} className="shrink-0" />{actionErr || status.error}
          </span>
        )}
        {running || st === 'stopping'
          ? <Button tone="danger-soft" icon={<Square size={13} />} busy={busy === 'stop' || st === 'stopping'} onClick={stop}>Stop</Button>
          : <Button tone="primary" icon={<Play size={14} />} busy={busy === 'start' || st === 'starting'} disabled={!status.installed} onClick={start}>Start capture</Button>}
      </div>

      {status.forwarding.length > 0 && !running && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-hv-line bg-hv-warning-tint text-xs text-hv-warning-fg shrink-0">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">The Pi is still forwarding for <b className="font-mono">{status.forwarding.join(', ')}</b> so {status.forwarding.length > 1 ? 'they stay' : 'it stays'} online (not captured). Set {status.forwarding.length > 1 ? 'their' : 'its'} gateway back to your router, then release.</span>
          <Button size="sm" busy={releasing} onClick={release}>Release</Button>
        </div>
      )}

      <Tabs className="px-3 shrink-0" value={page} onChange={setPage} items={[
        { id: 'requests', label: <><Radio size={14} />Requests</>, count: flows.length },
        { id: 'setup', label: <><Cog size={14} />Setup{unsaved && <span className="w-1.5 h-1.5 rounded-full bg-hv-warning" title="Not saved yet" />}</> },
        { id: 'connect', label: <><PlugZap size={14} />How to connect</> },
        { id: 'pcap', label: <><Waypoints size={14} />Packet capture{status.pcap.running && <span className="w-1.5 h-1.5 rounded-full bg-hv-success animate-pulse" title="Recording" />}</> },
        { id: 'reader', label: <><FileSearch size={14} />Reader</> },
        { id: 'log', label: <><ScrollText size={14} />mitmproxy log</> },
      ]} />

      {readerOn && (
        <div className={cx('flex-1 min-h-0 flex-col', page === 'reader' ? 'flex' : 'hidden')}>
          <PcapReader loadPi={api.pcapBuffer} piBytes={status.pcap.running ? 0 : status.pcap.bytes > 24 ? status.pcap.bytes : 0} openPiSignal={readPi} piAddresses={status.addresses.map(a => a.address)} />
        </div>
      )}
      {page === 'reader' ? null : page === 'pcap' ? (
        <div className="flex-1 min-h-0 overflow-auto p-4"><PcapPanel api={api} status={status} onChange={setStatus} onRead={() => { setPage('reader'); setReadPi(Date.now()); }} /></div>
      ) : !status.installed && page !== 'log' ? (
        <Empty icon={<AlertTriangle size={28} />} title="mitmproxy is not installed on this Pi">
          The Traffic Inspector update installs it into the Aether folder. Run that update again from Tools › Device Firmware and read its output — it says why the install did not finish.
        </Empty>
      ) : page === 'requests' ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-hv-line shrink-0">
            <div className="relative w-72">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" />
              <Input className="pl-8" placeholder="Filter: host, path, status…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <Segmented value={filter} onChange={setFilter} items={[{ id: 'all', label: 'All' }, { id: 'sunapi', label: `SUNAPI ${sunapiCount}` }, { id: 'other', label: `TCP · DNS · WS ${otherCount}`, title: 'Everything that is not a plain HTTP call' }, { id: 'problems', label: 'Errors' }]} />
            {clients.length > 1 && (
              <select className="h-7 rounded-hv-xs bg-hv-surface px-2 text-xs text-hv-text ring-1 ring-inset ring-hv-line-strong" value={client} onChange={e => setClient(e.target.value)} aria-label="From">
                <option value="">From any PC</option>{clients.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            <span title="With Digest login every call is sent twice: first without a password (the device answers 401 with a challenge), then with it. This hides the first one.">
              <Toggle on={hideAuth} onChange={setHideAuth} label={`Hide login steps${challenges ? ` (${challenges})` : ''}`} />
            </span>
            <span className="ml-auto" />
            <div className="relative">
              <Button size="sm" icon={<Download size={13} />} disabled={!flows.length && !status.sessionBytes} onClick={() => setExportMenu(m => !m)}>Export <ChevronDown size={12} /></Button>
              {exportMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setExportMenu(false)} />
                  <div className="absolute right-0 z-50 mt-1 w-64 rounded-hv-xs bg-hv-popup-panel shadow-hv-2 ring-1 ring-hv-line-strong py-1 text-sm">
                    {[
                      { l: `HAR — all ${flows.length}`, f: () => api.saveHar(), d: !flows.length },
                      { l: `HAR — the ${shown.length} shown`, f: () => api.saveHar(shown.map(s => s.id)), d: !shown.length || shown.length === flows.length },
                      { l: 'mitmproxy session (.mitm)', f: () => api.saveMitm(), d: !status.sessionBytes },
                    ].map(o => (
                      <button key={o.l} disabled={o.d} onClick={() => { setExportMenu(false); o.f().catch(e => setActionErr(e.message)); }}
                        className="w-full text-left px-3 py-1.5 text-hv-text hover:bg-hv-box disabled:opacity-40">{o.l}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <Button size="sm" tone="ghost" icon={<Trash2 size={13} />} disabled={!flows.length} onClick={clear}>Clear</Button>
          </div>

          <div className="flex-1 min-h-0 flex">
            <div className={cx('min-w-0 overflow-auto', sel ? 'w-[52%] border-r border-hv-line' : 'flex-1')}>
              {!flows.length ? (
                <Empty icon={<Radio size={28} />} title={running ? 'Waiting for the first request' : 'No requests yet'}>
                  {running ? 'Use the program now. Requests show up here as they happen.' : <>Set up device ports or the proxy, press <b>Start capture</b>, then point a program at the Pi (see How to connect).</>}
                </Empty>
              ) : !shown.length ? (
                <Empty title="Nothing matches the filter" />
              ) : (
                <table className="w-full text-[12px] table-fixed">
                  <thead className="sticky top-0 bg-hv-widget-panel z-10">
                    <tr className="text-left text-[11px] text-hv-text-3 border-b border-hv-line">
                      <th className="font-semibold px-3 py-1.5 w-[104px]">Time</th>
                      {!sel && <th className="font-semibold px-2 py-1.5 w-[120px]">From</th>}
                      <th className="font-semibold px-2 py-1.5">Request</th>
                      <th className="font-semibold px-2 py-1.5 w-[64px]">Status</th>
                      {!sel && <th className="font-semibold px-2 py-1.5 text-right w-[70px]">Size</th>}
                      <th className="font-semibold px-3 py-1.5 text-right w-[72px]">Took</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(f => (
                      <tr key={f.id} onClick={() => setSelected(f.id === selected ? null : f.id)}
                        className={cx('border-b border-hv-line cursor-pointer align-top', f.id === selected ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
                        <td className="px-3 py-1.5 font-mono text-hv-text-3 whitespace-nowrap">{clock(f.ts)}</td>
                        {!sel && <td className="px-2 py-1.5 font-mono text-hv-text-3 truncate" title={modeLabel(f.mode)}>{f.client}</td>}
                        <td className="px-2 py-1.5 overflow-hidden"><RowText f={f} /></td>
                        <td className="px-2 py-1.5"><RowStatus f={f} /></td>
                        {!sel && <td className="px-2 py-1.5 text-right text-hv-text-3 whitespace-nowrap">{f.resBytes !== null ? fmtBytes(f.resBytes) : '—'}</td>}
                        <td className="px-3 py-1.5 text-right text-hv-text-3 whitespace-nowrap">{f.ms !== null ? `${f.ms} ms` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {shown.length >= SHOW_MAX && <div className="px-3 py-2 text-[11px] text-hv-text-3">Showing the newest {SHOW_MAX}. Filter or export to see the rest.</div>}
            </div>
            {sel && <div className="w-[48%] min-w-0"><FlowDetail summary={sel} api={api} onClose={() => setSelected(null)} /></div>}
          </div>
        </div>
      ) : page === 'setup' ? (
        <div className="flex-1 min-h-0 overflow-auto p-4 pb-0"><SetupPanel api={api} status={status} draft={draft} setDraft={setDraft} onSaved={loadStatus} /></div>
      ) : page === 'connect' ? (
        <div className="flex-1 min-h-0 overflow-auto p-4"><ConnectPanel api={api} status={draft ? { ...status, settings: draft } : status} /></div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {log.length ? <pre className="text-[11.5px] leading-relaxed font-mono text-hv-text-2 whitespace-pre-wrap">{log.join('\n')}</pre>
            : <Empty icon={<ScrollText size={28} />} title="Nothing yet">mitmproxy's own messages show here while it runs.{status.binary && <><br /><span className="font-mono">{status.binary}</span></>}</Empty>}
        </div>
      )}
    </div>
  );
};

export default TrafficInspector;
