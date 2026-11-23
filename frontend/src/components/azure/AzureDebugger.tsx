// AETHER_AZURE_DEBUG — Tools › Azure Debugger.
// Drop in an Azure BLU-IC2 log bundle (or paste an IC2 syslog) and see where along the path
// OnCAFE cloud → Cloud Connector → IC2 firmware → RS-485 boards → doors it goes wrong, why,
// and the field checklist for it. Live checks an IC2 on the network and the RS-485 bus.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, ClipboardPaste, Trash2, Loader2, Cpu, AlertTriangle } from 'lucide-react';
import { Badge, Button, Dialog, Empty, Segmented, cx } from '../sunapi/ui';
import { azureClient, defaultBackend, type Meta, type Scan } from './api';
import { Dot } from './parts';
import { Boards, CloudView, CompareView, Overview, SdkLink } from './views';
import { Live } from './Live';
import { BoardFirmware } from './BoardFirmware';   // AETHER_AZURE_FW
import { RangeBar } from './RangeBar';             // AZURE-14
import { alertCount, clipScan, scanSpan, type TimeRange } from './timeRange';
import { applyCause, topics as causeTopics } from './cause';   // AZURE-15
import { CauseBar, IsolatedLines } from './CausePanel';

type Tab = 'overview' | 'boards' | 'sdk' | 'cloud' | 'live' | 'firmware' | 'compare';
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

const AzureDebugger: React.FC<{ backendUrl?: string }> = ({ backendUrl }) => {
  const api = useMemo(() => azureClient(backendUrl || defaultBackend()), [backendUrl]);
  const [reports, setReports] = useState<Meta[] | null>(null);
  const [sel, setSel] = useState<string | null>(() => lsGet('aether.azure.report', '') || null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [tab, setTabRaw] = useState<Tab>(() => lsGet('aether.azure.tab', 'overview') as Tab);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState('');
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [cause, setCause] = useState('');
  const [keepUntimed, setKeepUntimed] = useState(() => lsGet('aether.azure.keepUntimed', '1') === '1');
  const fileRef = useRef<HTMLInputElement>(null);
  const setTab = (t: Tab) => { setTabRaw(t); lsSet('aether.azure.tab', t); };

  const load = useCallback(() => api.reports().then(r => { setReports(r); return r; }).catch(e => { setErr(e.message); setReports([]); return [] as Meta[]; }), [api]);
  useEffect(() => { load().then(r => { if (r.length && (!sel || !r.some(x => x.id === sel))) setSel(r[0].id); }); }, [load]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setRange(null);
    if (!sel) { setScan(null); return; }
    lsSet('aether.azure.report', sel);
    let live = true; setBusy('Opening the report…'); setErr('');
    api.report(sel).then(s => { if (live) setScan(s); }).catch(e => live && setErr(e.message)).finally(() => live && setBusy(''));
    return () => { live = false; };
  }, [sel, api]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(`Scanning ${files.map(f => f.name).join(', ')}…`); setErr('');
    try { const m = await api.scan(files); await load(); setSel(m.id); setTab('overview'); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const scanText = async () => {
    setPaste(false); setBusy('Reading the pasted IC2 log…'); setErr('');
    try { const m = await api.scanText(text); setText(''); await load(); setSel(m.id); setTab('boards'); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const remove = async (id: string) => {
    await api.remove(id).catch(() => null);
    const r = await load();
    if (id === sel) setSel(r[0]?.id || null);
  };

  // AZURE-14: everything below the bar shows only what happened in the chosen time range
  const span = useMemo(() => (scan ? scanSpan(scan) : null), [scan]);
  const clipped = useMemo(() => (scan && range ? clipScan(scan, range, keepUntimed) : scan), [scan, range, keepUntimed]);
  // AZURE-15: then only the alerts behind the reported problem, and their log lines in one list
  const topicList = useMemo(() => (scan ? causeTopics(scan) : []), [scan]);
  const causeRes = useMemo(() => (clipped && cause ? applyCause(clipped, cause) : null), [clipped, cause]);
  const view = causeRes ? causeRes.scan : clipped;
  const ranged = !!scan && !!span && tab !== 'live' && tab !== 'firmware' && tab !== 'compare';

  const a = view?.azure;
  const tabs: { id: Tab; label: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'boards', label: <>Boards{a && a.boards.some(b => b.status === 'offline' || !b.status) ? <span aria-hidden="true" className="ml-1 text-hv-error-fg" title="A board is offline or never reported">•</span> : null}</> },
    { id: 'sdk', label: 'SDK link' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'live', label: 'Live' },
    { id: 'firmware', label: 'Firmware' },
    { id: 'compare', label: 'Compare' },
  ];

  return (
    <div className="flex rounded-hv-sm bg-hv-widget-panel ring-1 ring-hv-line overflow-hidden" style={{ height: 'calc(100vh - 210px)', minHeight: 560 }}
      onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={e => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}>
      {/* scans */}
      <aside className="w-[272px] shrink-0 border-r border-hv-line flex flex-col min-h-0 max-md:hidden">
        <div className="p-3 border-b border-hv-line flex flex-col gap-2">
          <div className="text-sm font-bold text-hv-text">Azure Debugger</div>
          <div className="text-[11px] text-hv-text-3 leading-snug">BLU-IC2 log bundles (.tar, .tar.gz), CloudConnectorLog files, or an IC2 syslog. Drop them anywhere on this page.</div>
          <div className="flex gap-1.5">
            <Button tone="primary" size="sm" icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()} disabled={!!busy} className="flex-1">Add logs</Button>
            <Button size="sm" icon={<ClipboardPaste size={13} />} onClick={() => setPaste(true)} disabled={!!busy} title="Paste lines from the IC2 system log (OSDPDriver…)">Paste</Button>
          </div>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { upload([...(e.target.files || [])]); e.target.value = ''; }} />
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {reports === null && <div className="p-3 text-xs text-hv-text-3">Loading…</div>}
          {reports && !reports.length && <div className="p-3 text-xs text-hv-text-3">No scans yet.</div>}
          {(reports || []).map(r => (
            <div key={r.id} className={cx('group flex items-start gap-2 px-3 py-2 border-b border-hv-line cursor-pointer hover:bg-hv-box', r.id === sel && 'bg-hv-brand-tint')} onClick={() => setSel(r.id)}>
              <div className="pt-1.5"><Dot tone={(r.hops || []).some(h => h.status === 'bad') ? 'error' : (r.hops || []).some(h => h.status === 'warn') ? 'warning' : 'success'} /></div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold text-hv-text truncate" title={r.name}>{r.name}</div>
                <div className="text-[11px] text-hv-text-3 truncate">{r.controller?.hostname || r.controller?.model || 'IC2 log'}{r.controller?.firmware ? ` · fw ${r.controller.firmware}` : ''}{r.controller?.connector ? ` · CC ${r.controller.connector}` : ''}</div>
                <div className="flex gap-1 mt-1">
                  {(r.hops || []).map(h => <span key={h.id} title={h.id} className={cx('h-1 flex-1 rounded-full', h.status === 'bad' ? 'bg-hv-error' : h.status === 'warn' ? 'bg-hv-warning' : 'bg-hv-success')} />)}
                </div>
                <div className="text-[10.5px] text-hv-text-3 mt-0.5">{new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <button onClick={e => { e.stopPropagation(); remove(r.id); }} className="opacity-0 group-hover:opacity-100 text-hv-text-3 hover:text-hv-error-fg" aria-label={`Delete ${r.name}`}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </aside>

      {/* report */}
      <main className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 min-h-[56px] border-b border-hv-line shrink-0">
          <Cpu size={18} className="text-hv-text-3 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-hv-text truncate">{scan ? scan.meta.name : 'No report open'}</div>
            <div className="text-[11px] text-hv-text-3 truncate font-mono">
              {a ? [a.controller.model, a.controller.hostname, a.controller.mac, a.controller.serialNo && `SN ${a.controller.serialNo}`].filter(Boolean).join(' · ') || 'IC2 syslog only' : ''}
            </div>
          </div>
          {a && !a.controller.isAzure && a.boards.length === 0 && !a.osdp.frames && <Badge tone="warning">not an Azure bundle</Badge>}
          <div className="ml-auto flex items-center gap-2 max-w-full min-w-0">
            <button className="md:hidden text-xs text-hv-info-fg shrink-0" onClick={() => fileRef.current?.click()}>Add logs</button>
            {reports && reports.length > 1 && (
              <select value={sel || ''} onChange={e => setSel(e.target.value)} aria-label="Open another scan"
                className="md:hidden h-7 max-w-[120px] rounded-hv-xs bg-hv-surface text-xs text-hv-text ring-1 ring-inset ring-hv-line-strong">
                {reports.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
            <div className="overflow-x-auto max-w-full"><Segmented value={tab} onChange={setTab} items={tabs} /></div>
          </div>
        </div>
        {(busy || err) && (
          <div className={cx('px-4 py-2 text-xs border-b border-hv-line flex items-center gap-2', err ? 'text-hv-error-fg bg-hv-error-tint' : 'text-hv-text-2 bg-hv-info-tint')}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <AlertTriangle size={13} />} {busy || err}
          </div>
        )}
        {ranged && view && span && (
          <RangeBar span={span} tz={scan!.report.zone?.tz} range={range} onChange={setRange}
            keepUntimed={keepUntimed} onKeepUntimed={v => { setKeepUntimed(v); lsSet('aether.azure.keepUntimed', v ? '1' : '0'); }}
            shown={alertCount(clipped!)} total={alertCount(scan!)} />
        )}
        {ranged && scan && <CauseBar value={cause} onChange={setCause} topics={topicList} result={causeRes} />}
        {ranged && causeRes && <IsolatedLines result={causeRes} tz={scan!.report.zone?.tz} />}
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {tab === 'live' ? <Live api={api} /> : tab === 'firmware' ? <BoardFirmware api={api} /> : !scan ? (
            <Empty icon={<FileUp size={28} />} title={drag ? 'Drop to scan' : 'Add an Azure controller log bundle'}
              action={<Button tone="primary" icon={<FileUp size={14} />} onClick={() => fileRef.current?.click()}>Add logs</Button>}>
              Export the logs from the IC2 web page (or from OnCAFE), then add the .tar / .tar.gz here. The scan runs on this Pi; nothing is uploaded anywhere else.
            </Empty>
          ) : tab === 'overview' ? <Overview scan={view!} />
            : tab === 'boards' ? <Boards scan={view!} />
              : tab === 'sdk' ? <SdkLink scan={view!} />
                : tab === 'cloud' ? <CloudView scan={view!} />
                  : <CompareView scan={scan} reports={reports || []} api={api} />}
        </div>
      </main>

      {drag && <div className="pointer-events-none fixed inset-0 z-[55] bg-hv-info/10 ring-4 ring-inset ring-hv-info" />}

      <Dialog open={paste} onClose={() => setPaste(false)} title="Paste an IC2 log" width={640}
        footer={<><Button onClick={() => setPaste(false)}>Cancel</Button><Button tone="primary" disabled={!text.trim()} onClick={scanText}>Scan</Button></>}>
        <p className="mb-2">Paste lines from the IC2 system log. Lines like <code className="font-mono text-[11.5px]">OSDPDriver[6]: &lt;&lt; 53 83 18 00 …</code> are decoded into board inputs and replies.</p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12} spellCheck={false} aria-label="IC2 log text"
          className="w-full rounded-hv-xs bg-hv-surface p-2 font-mono text-[11.5px] text-hv-text ring-1 ring-inset ring-hv-line-strong outline-none focus:ring-hv-info" />
      </Dialog>
    </div>
  );
};

export default AzureDebugger;
