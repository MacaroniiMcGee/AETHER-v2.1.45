// AETHER_TRACE — Event Trace (Tools): follow every card Aether presents through the controller, the wire and
// the cloud, live. One timeline from four vantage points: the Aether journal, the Traffic Inspector (wire),
// the controller's own logs (Log Analytics reports) and OnCAFE (MQTT push + event log). Sync cards line the
// controller clock up with the Pi; secrets are scrubbed and plain text is shown only on request.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Send, Radio, History, Settings as Cog, Loader2, AlertTriangle, Download, Trash2, Upload, FileJson, Waypoints, ScrollText, ChevronDown, Activity, Cloud, FlaskConical, Bell } from 'lucide-react';
import { Badge, Button, Empty, Input, Segmented, Tabs, Toggle, cx, lsGet, lsSet } from '../sunapi/ui';
import { traceClient, defaultBackend, clock, credText, fmtMs, SRC_LABEL, KIND_LABEL, type Analysis, type Kind, type RunMeta, type Status, type TEvent, type ReportMeta, type Alert } from './api';
import { CommandDialog } from './CommandDialog';
import { Summary, ClockCard, TraceTable, TraceDetail, Swimlanes, EventBox, IntegrityCard } from './views';
import { TestsPage, CompareView } from './Tests';
import { JiraButtons } from './Jira';
import { ClusterRuns } from './Cluster';
import { SetupPanel } from './Setup';

type Page = 'live' | 'runs' | 'tests' | 'setup';
const KindFilter: React.FC<{ a: Analysis | null; value: Kind | 'all'; onChange: (k: Kind | 'all') => void }> = ({ a, value, onChange }) => (
  <Segmented value={value} onChange={onChange} items={[{ id: 'all', label: `All${a ? ' ' + a.stats.actions : ''}` }, ...(['card', 'input', 'output', 'command'] as Kind[]).map(k => ({ id: k, label: `${KIND_LABEL[k]}${a ? ' ' + a.stats.byKind[k].actions : ''}` }))]} />
);

const WINDOWS = [{ id: '60000', label: '1 min' }, { id: '300000', label: '5 min' }, { id: '900000', label: '15 min' }] as const;

const SourceChip: React.FC<{ label: string; tone: 'success' | 'warning' | 'error' | 'neutral'; title?: string }> = ({ label, tone, title }) => (
  <span title={title} className="inline-flex items-center gap-1.5 text-[11px] text-hv-text-2">
    <span className={cx('w-2 h-2 rounded-full', tone === 'success' ? 'bg-hv-success' : tone === 'warning' ? 'bg-hv-warning' : tone === 'error' ? 'bg-hv-error' : 'bg-hv-line-strong')} />{label}
  </span>
);

const EventTrace: React.FC<{ backendUrl?: string }> = ({ backendUrl }) => {
  const api = useMemo(() => traceClient(backendUrl || defaultBackend()), [backendUrl]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(() => lsGet('aether.trace.page', 'live'));
  const [events, setEvents] = useState<TEvent[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<TEvent | null>(null);
  const [windowMs, setWindowMs] = useState<string>(() => lsGet('aether.trace.window', '300000'));
  const [showSync, setShowSync] = useState<boolean>(() => lsGet('aether.trace.showSync', false));
  const [runName, setRunName] = useState('');
  const [startMenu, setStartMenu] = useState(false);
  const [withSync, setWithSync] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [kind, setKind] = useState<Kind | 'all'>(() => lsGet('aether.trace.kind', 'all'));
  const [cmdOpen, setCmdOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<{ runId: string; traceId?: string } | null>(null);
  const [toasts, setToasts] = useState<Alert[]>([]);
  const alertSeen = useRef<number | null>(null);
  const seq = useRef(0);
  useEffect(() => lsSet('aether.trace.kind', kind), [kind]);

  useEffect(() => lsSet('aether.trace.page', page), [page]);
  useEffect(() => lsSet('aether.trace.window', windowMs), [windowMs]);
  useEffect(() => lsSet('aether.trace.showSync', showSync), [showSync]);

  const loadStatus = useCallback(() => api.status().then(s => { setStatus(s); setLoadErr(null); return s; }).catch(e => { setLoadErr(e.message); return null; }), [api]);
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 3000); return () => clearInterval(t); }, [loadStatus]);
  // TRACE-4 live alerts: a toast for every failed (or slow, if chosen) trace since this page opened
  const alertSeq = status?.alertSeq ?? 0;
  useEffect(() => {
    if (!status || status.settings.alerts?.enabled === false) return;
    if (alertSeen.current == null || alertSeq < alertSeen.current) { alertSeen.current = alertSeq; return; }   // first look, or the backend restarted (count back to 0)
    if (alertSeq <= alertSeen.current) return;
    const since = alertSeen.current;
    alertSeen.current = alertSeq;
    api.alerts(since).then(r => { if (r.alerts.length) setToasts(t => t.concat(r.alerts).slice(-3)); }).catch(() => {});
  }, [alertSeq, api, status]);
  useEffect(() => { if (!toasts.length) return; const t = setTimeout(() => setToasts(x => x.slice(1)), 15000); return () => clearTimeout(t); }, [toasts]);

  // live events + analysis
  const runId = status?.run?.id || null;
  useEffect(() => {
    if (page !== 'live') return;
    let stop = false, busy = false;
    const tick = async () => {
      if (busy) return;   // never stack requests on a slow Pi
      busy = true;
      try {
        const r = await api.live(seq.current);
        if (r.seq < seq.current) { seq.current = 0; setEvents([]); return; }   // backend restarted
        seq.current = r.seq;
        if (r.events.length) setEvents(prev => { const n = prev.concat(r.events); return n.length > 4000 ? n.slice(n.length - 4000) : n; });
        const a = runId ? await api.run(runId) : await api.liveAnalysis();
        if (!stop) setAnalysis(a);
      } catch { /* status shows the error */ } finally { busy = false; }
      if (!stop) setNow(Date.now());
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [api, page, runId]);

  const startRun = async () => {
    setBusy('start'); setActionErr(null); setStartMenu(false);
    try { await api.start(runName || `Trace ${new Date().toLocaleString()}`, withSync); setRunName(''); await loadStatus(); }
    catch (e) { setActionErr((e as Error).message); } finally { setBusy(null); }
  };
  const stopRun = async () => {
    setBusy('stop'); setActionErr(null);
    try { await api.stop(withSync); await loadStatus(); } catch (e) { setActionErr((e as Error).message); } finally { setBusy(null); }
  };
  const sync = async () => { setBusy('sync'); setActionErr(null); try { await api.sync('check'); } catch (e) { setActionErr((e as Error).message); } finally { setBusy(null); } };

  if (!status && !loadErr) return <div className="h-[calc(100vh-210px)] flex items-center justify-center text-hv-text-3 text-sm gap-2"><Loader2 size={16} className="animate-spin" />Loading…</div>;
  if (!status) return <div className="rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line"><Empty icon={<AlertTriangle size={28} />} title="Can't reach Event Trace">{loadErr}</Empty></div>;

  const cl = status.sources.cloud;
  const run = status.run;
  const sel = analysis?.traces.find(t => t.id === selected) || null;

  return (
    <div className="flex flex-col rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line overflow-hidden" style={{ height: 'calc(100vh - 210px)', minHeight: 560 }}>
      {/* status bar */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-hv-line shrink-0">
        <span className={cx('w-2.5 h-2.5 rounded-full shrink-0', run ? 'bg-hv-error animate-pulse' : 'bg-hv-line-strong')} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-hv-text truncate">
            {run ? <>Recording <span className="font-normal">“{run.name}”</span><span className="ml-2 text-xs font-normal text-hv-text-3">since {new Date(run.start).toLocaleTimeString()} · {run.count} events</span></> : 'Watching live (not recording a run)'}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <SourceChip label="Aether journal" tone={status.sources.journal.ok ? 'success' : 'error'} />
            <SourceChip label={`Cloud push${cl.push.received ? ` · ${cl.push.received}` : ''}`} tone={cl.push.state === 'connected' ? (cl.push.error ? 'warning' : 'success') : cl.push.state === 'off' ? 'neutral' : 'warning'} title={cl.push.error || cl.push.state} />
            <SourceChip label="Event log" tone={!cl.api.enabled || cl.api.state === 'off' ? 'neutral' : cl.api.state === 'running' ? 'success' : 'error'} title={cl.api.error || ''} />
            <SourceChip label={`Wire${status.sources.wire.controllerIps.length ? ` · ${status.sources.wire.controllerIps.length} IP` : ''}`} tone={status.sources.wire.traffic?.state === 'running' && status.sources.wire.controllerIps.length ? 'success' : 'neutral'} title="Traffic Inspector flows from the controller addresses in Setup" />
          </div>
        </div>
        {actionErr && <span className="max-w-[360px] truncate text-xs text-hv-error-fg flex items-center gap-1.5" title={actionErr}><AlertTriangle size={13} className="shrink-0" />{actionErr}</span>}
        {status.settings.commands.enabled && status.me?.admin !== false && <Button size="sm" icon={<Cloud size={13} />} onClick={() => setCmdOpen(true)} title="Send a door / area / zone command to OnCAFE and trace it">Command</Button>}
        <Button size="sm" icon={<Send size={13} />} busy={busy === 'sync' || status.syncBusy} onClick={sync} title="Send the sync markers now">Sync</Button>
        {run
          ? <Button tone="danger-soft" icon={<Square size={13} />} busy={busy === 'stop'} onClick={stopRun}>{withSync && status.settings.sync.atEnd ? 'Sync and stop' : 'Stop'}</Button>
          : (
            <div className="relative">
              <Button tone="primary" icon={<Play size={14} />} busy={busy === 'start'} onClick={() => setStartMenu(m => !m)}>Start run <ChevronDown size={12} /></Button>
              {startMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setStartMenu(false)} />
                  <div className="absolute right-0 z-50 mt-1 w-80 rounded-hv-xs bg-hv-popup-panel shadow-hv-2 ring-1 ring-hv-line-strong p-3 space-y-2">
                    <Input autoFocus placeholder="Run name (e.g. NHP 26.04 latency)" value={runName} onChange={e => setRunName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') startRun(); }} />
                    <Toggle on={withSync} onChange={setWithSync} label={`Send sync cards at start${status.settings.sync.atEnd ? ' and end' : ''}`} />
                    {!cl.push.state || cl.push.state === 'off' ? <div className="text-[11px] text-hv-warning-fg">The cloud feed is not connected — only Aether and wire events will be recorded. Connect it in Setup.</div> : null}
                    <Button tone="primary" className="w-full" onClick={startRun}>Start</Button>
                  </div>
                </>
              )}
            </div>
          )}
      </div>

      <Tabs className="px-3 shrink-0" value={page} onChange={setPage} items={[
        { id: 'live', label: <><Radio size={14} />Live</>, count: analysis ? analysis.stats.actions : undefined },
        { id: 'runs', label: <><History size={14} />Runs</> },
        { id: 'tests', label: <><FlaskConical size={14} />Tests</>, count: status.test && status.test.state !== 'done' ? 1 : undefined },
        { id: 'setup', label: <><Cog size={14} />Setup</> },
      ]} />

      <CommandDialog open={cmdOpen} onClose={() => setCmdOpen(false)} api={api} status={status} onSent={m => { setNote(m); setActionErr(null); }} />
      {page === 'setup' ? (
        <div className="flex-1 min-h-0 overflow-auto p-4"><SetupPanel api={api} status={status} onSaved={loadStatus} /></div>
      ) : page === 'runs' ? (
        <RunsPage api={api} status={status} initial={openRun} backend={backendUrl || defaultBackend()} />
      ) : page === 'tests' ? (
        <TestsPage api={api} status={status} onOpenTrace={(runId, traceId) => { setOpenRun({ runId, traceId }); setPage('runs'); }} />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 pt-3 space-y-2 shrink-0">
            {(status.pendingReverts || []).map(p => (
              <div key={p.id} className="text-xs rounded-hv-xs px-2 py-1 bg-hv-warning-tint text-hv-warning-fg">Turning back {p.kind} on {String(p.target)} at {new Date(p.due).toLocaleTimeString()} (automatic)</div>
            ))}
            {note && <div className="text-xs rounded-hv-xs px-2 py-1 bg-hv-success-tint text-hv-success-fg flex items-center gap-2"><span className="flex-1">{note}</span><button className="opacity-70 hover:opacity-100" onClick={() => setNote(null)}>×</button></div>}
            {analysis && <Summary a={analysis} kind={kind} />}
            {analysis && <ClockCard a={analysis} live={status.clockCheck} onCheck={() => api.clocks().then(() => loadStatus()).catch(e => setActionErr(e.message))} />}
            {analysis && <IntegrityCard a={analysis} />}
            <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line px-2 pt-1 pb-0.5">
              <div className="flex items-center gap-2 text-[11px] text-hv-text-3"><Activity size={12} />Timeline by vantage point (controller times shifted by the clock offset)<span className="ml-auto" />
                <Segmented value={windowMs} onChange={setWindowMs} items={WINDOWS.map(w => ({ id: w.id, label: w.label }))} />
              </div>
              <Swimlanes events={events} windowMs={Number(windowMs)} now={now} offset={analysis?.clock.offset ?? null} onPick={e => { setPicked(e); setSelected(null); }} />
            </div>
          </div>
          <div className="flex items-center gap-3 px-3 py-1.5 shrink-0">
            <KindFilter a={analysis} value={kind} onChange={setKind} />
            <Toggle on={showSync} onChange={setShowSync} label="Show sync markers" />
            {analysis && analysis.unexplained.length > 0 && <Badge tone="warning">{analysis.unexplained.length} decision{analysis.unexplained.length > 1 ? 's' : ''} nobody triggered</Badge>}
          </div>
          <div className="flex-1 min-h-0 flex border-t border-hv-line">
            <div className={cx('min-w-0 overflow-auto', sel || picked ? 'w-[55%] border-r border-hv-line' : 'flex-1')}>
              {analysis ? <TraceTable traces={analysis.traces} selected={selected} onSelect={id => { setSelected(id); setPicked(null); }} showSync={showSync} compact={!!(sel || picked)} kind={kind} /> : <Empty title="Loading…" />}
            </div>
            {sel && <div className="w-[45%] min-w-0"><TraceDetail t={sel} events={events} api={api} runId={runId} allowRaw={status.settings.allowRaw} onClose={() => setSelected(null)} /></div>}
            {!sel && picked && (
              <div className="w-[45%] min-w-0 p-3 overflow-auto">
                <div className="flex items-center gap-2 mb-2"><span className="text-sm font-semibold text-hv-text">{picked.label}</span><span className="ml-auto" /><Button size="sm" tone="ghost" onClick={() => setPicked(null)}>Close</Button></div>
                <EventBox key={picked.id} e={picked} api={api} runId={runId} allowRaw={status.settings.allowRaw} />
              </div>
            )}
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 w-80 space-y-1.5" role="status" aria-live="polite">
          {toasts.map(t => (
            <div key={t.seq} className={cx('rounded-hv-xs shadow-hv-2 ring-1 px-2.5 py-1.5 text-[12px] bg-hv-popup-panel', t.status === 'fail' ? 'ring-hv-error' : 'ring-hv-warning')}>
              <div className="flex items-center gap-2">
                <Bell size={13} className={t.status === 'fail' ? 'text-hv-error-fg' : 'text-hv-warning-fg'} />
                <span className="font-semibold text-hv-text">{t.status === 'fail' ? 'Failed' : 'Slow'}: {t.label}</span>
                <span className="ml-auto" />
                <button className="text-hv-text-3 hover:text-hv-text" aria-label="Dismiss" onClick={() => setToasts(x => x.filter(y => y.seq !== t.seq))}>×</button>
              </div>
              <div className="text-hv-text-2 mt-0.5 truncate" title={t.why}>{t.why}{t.door ? ` · ${t.door}` : ''} · {new Date(t.traceAt).toLocaleTimeString()}</div>
              <button className="mt-0.5 text-hv-brand hover:underline" onClick={() => { setToasts(x => x.filter(y => y.seq !== t.seq)); if (t.runId) { setOpenRun({ runId: t.runId, traceId: t.traceId }); setPage('runs'); } else { setPage('live'); setSelected(t.traceId); } }}>Show the trace</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** Runs: pick one, see its analysis, add after-the-fact evidence, export. */
const RunsPage: React.FC<{ api: ReturnType<typeof traceClient>; status: Status; initial?: { runId: string; traceId?: string } | null; backend: string }> = ({ api, status, initial, backend }) => {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [id, setId] = useState<string | null>(initial ? initial.runId : null);
  const [a, setA] = useState<Analysis | null>(null);
  const [cmp, setCmp] = useState<string>('');
  const [multi, setMulti] = useState(false);
  const [events, setEvents] = useState<TEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showSync, setShowSync] = useState(false);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportMeta[] | null>(null);
  const harInput = useRef<HTMLInputElement>(null);
  const pcapInput = useRef<HTMLInputElement>(null);

  const list = useCallback(() => api.runs().then(r => { setRuns(r.runs); if (!id && r.runs[0]) setId(r.runs[0].id); }).catch(() => {}), [api, id]);
  useEffect(() => { list(); }, [list]);
  const load = useCallback(async (rid: string) => {
    try { const [x, ev] = await Promise.all([api.run(rid), api.events(rid)]); setA(x); setEvents(ev.events); } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
  }, [api]);
  useEffect(() => { if (id) { setSelected(initial && initial.runId === id && initial.traceId ? initial.traceId : null); setCmp(''); load(id); } }, [id, load, initial]);

  const done = async (p: Promise<{ imported: number }>, what: string) => {
    setMsg(null);
    try { const r = await p; setMsg({ tone: 'success', text: `${what}: ${r.imported} events added` }); if (id) await load(id); list(); }
    catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };
  const onHar = async (f: File) => {
    if (f.size > 60 * 1024 * 1024) { setMsg({ tone: 'error', text: `${f.name} is ${Math.round(f.size / 1048576)} MB; the limit is 60 MB. Save a HAR of just the test window.` }); return; }
    setBusy('har'); done(api.importHar(id!, await f.text()), f.name);
  };
  const onPcap = async (f: File) => {
    setBusy('pcap'); setMsg(null);
    try {
      const { parseCapture } = await import('../traffic/pcap/parse');
      const cap = await parseCapture(await f.arrayBuffer());
      const ips = status.settings.wire.controllerIps;
      if (!ips.length) throw new Error('Add the controller IP addresses in Setup › Wire first');
      const packets = cap.packets.filter(p => (ips.includes(p.src) || ips.includes(p.dst)) && (p.payloadLen || p.tcp?.payloadLen || 0) > 0).slice(0, 20000).map(p => {
        const tls = p.layers.find(l => /TLS/i.test(l.name));
        const sni = tls?.fields.find(x => /SNI|server name/i.test(x.k))?.v;
        return { ts: p.ts, src: p.src, dst: p.dst, sport: p.sport, dport: p.dport, bytes: p.payloadLen || p.tcp?.payloadLen || 0, proto: p.proto, sni };
      });
      await done(api.importWire(id!, packets), f.name);
    } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); setBusy(null); }
  };
  const sel = a?.traces.find(t => t.id === selected) || null;
  const current = runs.find(r => r.id === id);

  if (multi) return <ClusterRuns backend={backend} onClose={() => setMulti(false)} />;
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-[260px] shrink-0 border-r border-hv-line overflow-auto">
        <div className="p-2 border-b border-hv-line"><Button size="sm" tone="ghost" className="w-full" onClick={() => setMulti(true)} title="Put runs from several Aether Pis (cluster) side by side">Runs on several Pis…</Button></div>
        {!runs.length ? <Empty icon={<History size={24} />} title="No runs yet">Start a run on the Live tab.</Empty> : runs.map(r => (
          <button key={r.id} onClick={() => setId(r.id)} className={cx('w-full text-left px-3 py-2 border-b border-hv-line', r.id === id ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
            <div className="flex items-center gap-1.5 text-sm text-hv-text truncate">{!r.end && <span className="w-1.5 h-1.5 rounded-full bg-hv-error animate-pulse shrink-0" />}{r.name}</div>
            <div className="text-[11px] text-hv-text-3">{new Date(r.start).toLocaleString()}{r.end ? ` · ${fmtMs(r.end - r.start)}` : ' · recording'}{r.count != null ? ` · ${r.count} events` : ''}</div>
          </button>
        ))}
      </div>
      {!a || !current ? <div className="flex-1"><Empty title="Pick a run" /></div> : (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-3 pt-3 space-y-2 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-hv-text truncate">{current.name}</span>
              {a.meta?.syncError && <Badge tone="error" title={a.meta.syncError}>sync cards failed</Badge>}
              <span className="ml-auto" />
              <input ref={harInput} type="file" accept=".har,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onHar(f); }} />
              <input ref={pcapInput} type="file" accept=".pcap,.pcapng,.cap" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPcap(f); }} />
              <Button size="sm" icon={<FileJson size={13} />} busy={busy === 'har'} onClick={() => harInput.current?.click()} title="A HAR saved in the browser with the OnCAFE dashboard open (browser clock)">Add HAR</Button>
              <Button size="sm" icon={<Waypoints size={13} />} busy={busy === 'pcap'} onClick={() => pcapInput.current?.click()} title="A packet capture (switch mirror) — read here in the browser; only packet times and sizes from the controller addresses are sent to the Pi">Add capture</Button>
              <div className="relative">
                <Button size="sm" icon={<ScrollText size={13} />} busy={busy === 'report'} onClick={() => api.reports().then(r => setReports(r.reports)).catch(e => setMsg({ tone: 'error', text: e.message }))}>Add controller logs <ChevronDown size={12} /></Button>
                {reports && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setReports(null)} />
                    <div className="absolute right-0 z-50 mt-1 w-80 max-h-72 overflow-auto rounded-hv-xs bg-hv-popup-panel shadow-hv-2 ring-1 ring-hv-line-strong py-1 text-sm">
                      {!reports.length && <div className="px-3 py-2 text-xs text-hv-text-3">No Log Analytics reports. Scan a Cloud Connector bundle in Tools › Reports › Log Analytics first.</div>}
                      {reports.map(r => (
                        <button key={r.id} className="w-full text-left px-3 py-1.5 hover:bg-hv-box" onClick={() => { setReports(null); setBusy('report'); done(api.importReport(id!, r.id), r.name || r.id); }}>
                          <div className="text-hv-text truncate">{r.name || r.id}</div>
                          <div className="text-[11px] text-hv-text-3">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}{r.window ? ` · logs ${new Date(r.window.from).toLocaleString()} – ${new Date(r.window.to).toLocaleTimeString()}` : ''}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <select className="h-7 rounded-hv-xs bg-hv-box ring-1 ring-inset ring-hv-line text-[12px] text-hv-text px-1.5 max-w-[220px]" value={cmp} onChange={e => setCmp(e.target.value)} title="Put this run (B) next to an earlier run (A)">
                <option value="">Compare with…</option>
                {runs.filter(r => r.id !== id).map(r => <option key={r.id} value={r.id}>{r.name} · {new Date(r.start).toLocaleDateString()}</option>)}
              </select>
              <JiraButtons api={api} runId={id!} admin={status.me?.admin !== false} onImported={t => { setMsg({ tone: 'success', text: t }); load(id!); list(); }} onError={t => setMsg({ tone: 'error', text: t })} onSent={t => setMsg({ tone: 'success', text: t })} />
              <Button size="sm" icon={<Download size={13} />} onClick={() => api.saveCsv(id!).catch(e => setMsg({ tone: 'error', text: e.message }))}>CSV</Button>
              <Button size="sm" icon={<Upload size={13} className="rotate-180" />} onClick={() => api.saveJson(id!).catch(e => setMsg({ tone: 'error', text: e.message }))}>JSON</Button>
              <Button size="sm" tone="ghost" icon={<Trash2 size={13} />} disabled={!current.end} onClick={async () => { if (!window.confirm(`Delete “${current.name}”?`)) return; await api.del(id!).catch(e => setMsg({ tone: 'error', text: e.message })); setId(null); setA(null); list(); }}>Delete</Button>
            </div>
            {msg && <div className={cx('text-xs rounded-hv-xs px-2 py-1', msg.tone === 'error' ? 'bg-hv-error-tint text-hv-error-fg' : 'bg-hv-success-tint text-hv-success-fg')}>{msg.text}</div>}
            {a.meta && a.meta.imports.length > 0 && <div className="text-[11px] text-hv-text-3">Added: {a.meta.imports.map(i => i.what).join(' · ')}</div>}
            {cmp && <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-3 max-h-[50vh] overflow-auto"><CompareView api={api} a={cmp} b={id!} onClose={() => setCmp('')} /></div>}
            <Summary a={a} kind={kind} />
            <ClockCard a={a} />
            <IntegrityCard a={a} />
          </div>
          <div className="flex items-center gap-3 px-3 py-1.5 shrink-0">
            <KindFilter a={a} value={kind} onChange={setKind} />
            <Toggle on={showSync} onChange={setShowSync} label="Show sync markers" />
          </div>
          <div className="flex-1 min-h-0 flex border-t border-hv-line">
            <div className={cx('min-w-0 overflow-auto', sel ? 'w-[55%] border-r border-hv-line' : 'flex-1')}>
              <TraceTable traces={a.traces} selected={selected} onSelect={setSelected} showSync={showSync} compact={!!sel} kind={kind} />
              {a.unexplained.length > 0 && (
                <div className="p-3">
                  <div className="text-xs font-semibold text-hv-text-2 mb-1">Controller decisions nobody triggered ({a.unexplained.length})</div>
                  <table className="w-full text-[12px]"><tbody>
                    {a.unexplained.map((u, i) => (
                      <tr key={i} className="border-b border-hv-line">
                        <td className="py-1 pr-2 font-mono text-hv-text-3 w-[100px]">{clock(u.at)}</td>
                        <td className="py-1 pr-2"><Badge tone={u.type.startsWith('accessgranted') ? 'success' : 'error'}>{u.type}</Badge></td>
                        <td className="py-1 pr-2 font-mono text-hv-text">{credText(u.cred)}</td>
                        <td className="py-1 pr-2 text-hv-text-3">{u.door?.name || u.door?.id || ''}</td>
                        <td className="py-1 text-hv-text-3">{u.sources.map(s => SRC_LABEL[s] || s).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              )}
            </div>
            {sel && <div className="w-[45%] min-w-0"><TraceDetail t={sel} events={events} api={api} runId={id} allowRaw={status.settings.allowRaw} onClose={() => setSelected(null)} /></div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default EventTrace;
