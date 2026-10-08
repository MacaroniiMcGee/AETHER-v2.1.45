// FirmwareTracePanel.tsx — live OSDP bus trace for firmware uploads.
//
// Used by OSDPFirmwareWizard:
//   <FirmwareTraceSection queue liveTraceId running />  live view during a batch, review after
//   <FirmwareTraceHistory />                            every past trace: view, export, delete
//
// Backend: /api/osdp/firmware-traces (backend/osdp/OSDPTraceRecorder.js)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ChevronDown, ChevronRight, Download, FileText, Flag,
  Loader2, Package, Pause, Play, ScrollText, StickyNote, Trash2,
} from 'lucide-react';

const API = '/api/osdp/firmware-traces';
const WINDOW = 3000;          // events kept in the browser for the live view
const PAGE = 300;             // rows rendered at a time
const POLL_MS = 700;

type Ev = {
  n: number; t: number; rel: number; dt: number; kind: 'frame' | 'noise' | 'note' | 'marker' | 'progress';
  dir?: 'tx' | 'rx'; addr?: number; seq?: number; code?: number; name?: string; summary?: string;
  len?: number; hex?: string; checkOk?: boolean; checkDetail?: string; flags?: string[];
  latencyMs?: number; fields?: Record<string, any>; scb?: any; mac?: string; echo?: boolean;
  level?: string; source?: string; text?: string; by?: string; redact?: boolean; inReplyTo?: string;
};

// keep in sync with isAnomaly()/isRoutine() in OSDPTraceRecorder.js
const isAnom = (e: Ev) =>
  e.kind === 'marker' || e.kind === 'noise' ||
  (e.kind === 'note' && (e.level === 'warn' || e.level === 'error')) ||
  (e.kind === 'frame' && (e.flags || []).some(f => f !== 'echo'));
const isRoutine = (e: Ev) => {
  if (e.kind !== 'frame') return false;
  if (e.echo) return (e.flags || []).every(f => f === 'echo');
  if (isAnom(e)) return false;
  if (e.dir === 'tx') return e.code === 0x7C && !!e.fields && e.fields.fragLen > 0;
  return e.code === 0x7A && !!e.fields && e.fields.status === 0;
};

const h2 = (n?: number) => n == null ? '' : '0x' + n.toString(16).padStart(2, '0').toUpperCase();
const fmtTime = (t: number) => {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(Math.floor(t % 1000)).padStart(3, '0');
};
const fmtDur = (ms?: number | null) => {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const RESULT_CLS: Record<string, string> = {
  success: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  failure: 'text-red-300 border-red-500/40 bg-red-500/10',
  aborted: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  interrupted: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  'in-progress': 'text-blue-300 border-blue-500/40 bg-blue-500/10',
};

// ═══════════════════════════════════════════════════════════════════════════
// Section shown on the Flash step
// ═══════════════════════════════════════════════════════════════════════════

export function FirmwareTraceSection({ queue, liveTraceId, running }: { queue: any[]; liveTraceId: string | null; running: boolean }) {
  const done = useMemo(() => queue
    .filter(q => q.uploadResult && q.uploadResult.traceId)
    .map(q => ({ id: q.uploadResult.traceId as string, label: q.target.readerName || `${q.target.port} ${h2(q.target.address)}`, status: q.status as string })),
  [queue]);
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  // follow the live upload; afterwards default to the most recent finished one
  const shown = running && liveTraceId ? liveTraceId : (picked && done.some(d => d.id === picked) ? picked : (done.length ? done[done.length - 1].id : null));
  useEffect(() => { if (running && liveTraceId) setPicked(null); }, [running, liveTraceId]);

  if (!shown && !running) return null;
  return (
    <div className="rounded-lg border border-cyan-500/30 bg-gray-950/40">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-cyan-300 text-sm font-medium">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Activity size={15} /> OSDP trace
        </button>
        {running && liveTraceId && <span className="flex items-center gap-1 text-[11px] text-red-300"><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> recording</span>}
        {!running && done.length > 1 && (
          <select value={shown || ''} onChange={e => setPicked(e.target.value)}
            className="ml-auto px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200">
            {done.map(d => <option key={d.id} value={d.id}>{d.label} — {d.status}</option>)}
          </select>
        )}
      </div>
      {open && (shown
        ? <TraceViewer key={shown} traceId={shown} />
        : <div className="px-3 py-4 text-xs text-gray-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Waiting for the upload to open the port…</div>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// History list (collapsed by default)
// ═══════════════════════════════════════════════════════════════════════════

export function FirmwareTraceHistory() {
  const [open, setOpen] = useState(false);
  const [traces, setTraces] = useState<any[] | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await (await fetch(API)).json();
      if (!j.success) throw new Error(j.error || 'failed');
      setTraces(j.traces); setErr(null);
    } catch (e: any) { setErr(e.message || String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const del = async (id: string) => {
    if (!confirm('Delete this trace log permanently?')) return;
    const j = await (await fetch(`${API}/${id}`, { method: 'DELETE' })).json();
    if (!j.success) { alert(j.error || 'Delete failed'); return; }
    if (view === id) setView(null);
    load();
  };

  return (
    <div className="mt-3 rounded border border-gray-800 bg-gray-900/30">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:text-gray-100">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<ScrollText size={13} className="text-cyan-400" />
        OSDP trace logs{traces ? ` (${traces.length})` : ''}
        <span className="ml-auto text-gray-500">every upload is recorded — open one to review or export for the manufacturer</span>
      </button>
      {open && (
        <div className="border-t border-gray-800 p-2 space-y-1.5">
          {err && <div className="text-xs text-red-300 px-1">{err}</div>}
          {traces && !traces.length && <div className="text-xs text-gray-500 px-1 py-2">No traces yet. The next firmware upload will create one.</div>}
          {traces && traces.map(t => (
            <div key={t.id}>
              <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${view === t.id ? 'bg-cyan-500/10' : 'hover:bg-gray-800/50'}`}>
                <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase ${RESULT_CLS[t.result] || 'text-gray-300 border-gray-600'}`}>{t.live ? 'live' : t.result}</span>
                <span className="text-gray-200 truncate max-w-[14rem]">{t.reader || '—'}</span>
                <span className="text-gray-500 font-mono">{t.port} {h2(t.address)}</span>
                <span className="text-gray-500">{new Date(t.startedAt).toLocaleString()}</span>
                {t.firmware && <span className="text-gray-500 truncate max-w-[10rem] font-mono">{t.firmware.name}</span>}
                {t.stats && t.stats.anomalies > 0 && <span className="text-amber-300 flex items-center gap-0.5"><AlertTriangle size={11} />{t.stats.anomalies}</span>}
                {t.ticket && <span className="text-cyan-300">#{t.ticket}</span>}
                <span className="ml-auto flex items-center gap-1">
                  <button onClick={() => setView(v => v === t.id ? null : t.id)} className="px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:text-hv-text">{view === t.id ? 'Close' : 'Open'}</button>
                  <a href={`${API}/${t.id}/export?format=bundle`} title="Manufacturer bundle (.zip)" className="p-1 text-cyan-300 hover:text-cyan-100"><Package size={13} /></a>
                  {!t.live && <button onClick={() => del(t.id)} title="Delete" className="p-1 text-gray-500 hover:text-red-300"><Trash2 size={13} /></button>}
                </span>
              </div>
              {view === t.id && <div className="mt-1 mb-2 rounded border border-gray-800"><TraceViewer traceId={t.id} onChanged={load} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Viewer: stats, filters, frame table, markers, notes, exports
// ═══════════════════════════════════════════════════════════════════════════

type Filter = 'all' | 'anomalies' | 'compact';

export function TraceViewer({ traceId, onChanged }: { traceId: string; onChanged?: () => void }) {
  const [meta, setMeta] = useState<any>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [anoms, setAnoms] = useState<Ev[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState<Filter>('compact');
  const [follow, setFollow] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [shownCount, setShownCount] = useState(PAGE);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const lastN = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  const loadMeta = useCallback(async () => {
    const j = await (await fetch(`${API}/${traceId}`)).json();
    if (j.success) { setMeta(j.trace); if (j.trace.stats) setStats(j.trace.stats); }
    return j.success ? j.trace : null;
  }, [traceId]);

  // initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await loadMeta();
        if (!alive || !m) return;
        const [tailJ, anomJ] = await Promise.all([
          fetch(`${API}/${traceId}/events?tail=${WINDOW}`).then(r => r.json()),
          fetch(`${API}/${traceId}/events?filter=anomalies&limit=5000`).then(r => r.json()),
        ]);
        if (!alive) return;
        setEvents(tailJ.events || []);
        setTruncated((tailJ.total || 0) > (tailJ.events || []).length);
        setAnoms(anomJ.events || []);
        lastN.current = tailJ.lastN || 0;
        setLive(!!tailJ.live);
        setFilter(tailJ.live ? 'all' : 'compact');   // watch every frame live; review compactly
        if (tailJ.stats) setStats(tailJ.stats);
      } catch (e: any) { if (alive) setError(e.message || String(e)); }
    })();
    return () => { alive = false; };
  }, [traceId, loadMeta]);

  // live polling
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const j = await (await fetch(`${API}/${traceId}/events?since=${lastN.current}&limit=2000`)).json();
        if (stop || !j.success) return;
        const evs: Ev[] = j.events || [];
        if (evs.length) {
          lastN.current = evs[evs.length - 1].n;
          setEvents(prev => { const next = prev.concat(evs); if (next.length > WINDOW) { setTruncated(true); return next.slice(-WINDOW); } return next; });
          const a = evs.filter(isAnom);
          if (a.length) setAnoms(prev => prev.concat(a));
        }
        if (j.stats) setStats(j.stats);
        if (!j.live && !j.more) { setLive(false); loadMeta(); onChanged && onChanged(); return; }
      } catch { /* blip */ }
      if (!stop) window.setTimeout(tick, POLL_MS);
    };
    const t = window.setTimeout(tick, POLL_MS);
    return () => { stop = true; window.clearTimeout(t); };
  }, [live, traceId, loadMeta, onChanged]);

  const filtered = useMemo(() => {
    if (filter === 'anomalies') return anoms;
    if (filter === 'all') return events;
    // compact: hide routine fragment exchanges but keep a few around the edges
    return events.filter(e => !isRoutine(e));
  }, [events, anoms, filter]);

  const [snapshot, setSnapshot] = useState<Ev[] | null>(null);
  useEffect(() => { if (!frozen) setSnapshot(null); else setSnapshot(filtered); }, [frozen]); // eslint-disable-line react-hooks/exhaustive-deps
  const source = frozen && snapshot ? snapshot : filtered;
  const rows = source.slice(-shownCount);

  useEffect(() => {
    if (follow && !frozen && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [rows.length, follow, frozen, filter]);

  const S = stats || {};
  const L = S.latency || {};
  const nakCount = Object.values(S.naks || {}).reduce((a: number, b: any) => a + (b as number), 0) as number;

  if (error) return <div className="p-3 text-xs text-red-300">Could not load trace: {error}</div>;

  return (
    <div className="text-xs">
      {/* header + stats */}
      <div className="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-800">
        {meta && (
          <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase ${RESULT_CLS[live ? 'in-progress' : meta.result] || 'text-gray-300 border-gray-600'}`}>
            {live ? 'recording' : meta.result}
          </span>
        )}
        {meta && <span className="text-gray-400 font-mono">{meta.port} @ {meta.baud} · addr {h2(meta.address)}</span>}
        <Stat label="TX" v={S.txFrames} />
        <Stat label="RX" v={S.rxFrames} />
        <Stat label="Fragments" v={S.fragments} />
        <Stat label="NAK" v={nakCount} warn={nakCount > 0} />
        <Stat label="BUSY" v={S.busy} warn={S.busy > 0} />
        <Stat label="CRC err" v={S.badCheck} warn={S.badCheck > 0} />
        <Stat label="Noise B" v={S.noiseBytes} warn={S.noiseBytes > 0} />
        <Stat label="Latency avg/max" v={L.count ? `${L.avg}/${L.max} ms` : '—'} />
        <Stat label="Duration" v={fmtDur(S.durationMs)} />
        {meta && meta.error && <span className="text-red-300 basis-full">✗ {meta.error}</span>}
      </div>

      {/* toolbar */}
      <div className="px-3 py-1.5 flex flex-wrap items-center gap-1.5 border-b border-gray-800">
        <Chip on={filter === 'compact'} onClick={() => setFilter('compact')} title="Hide routine fragment/FTSTAT exchanges">Compact</Chip>
        <Chip on={filter === 'all'} onClick={() => setFilter('all')}>All frames</Chip>
        <Chip on={filter === 'anomalies'} onClick={() => setFilter('anomalies')} warn={anoms.length > 0}>
          <AlertTriangle size={11} /> Anomalies &amp; notes ({anoms.length})
        </Chip>
        <span className="mx-1 w-px h-4 bg-gray-700" />
        <Chip on={follow} onClick={() => setFollow(f => !f)} title="Scroll to newest">Follow</Chip>
        {live && (
          <Chip on={frozen} onClick={() => setFrozen(f => !f)} title="Freeze the view; recording continues">
            {frozen ? <Play size={11} /> : <Pause size={11} />}{frozen ? 'Resume view' : 'Freeze view'}
          </Chip>
        )}
        <span className="ml-auto text-gray-500">
          {source.length > rows.length ? `showing last ${rows.length} of ${source.length}` : `${rows.length} rows`}
          {truncated && filter !== 'anomalies' ? ' · older frames are in the exports' : ''}
        </span>
      </div>

      {/* table */}
      <div ref={scroller} className="max-h-80 overflow-auto font-mono">
        {source.length > rows.length && (
          <button onClick={() => setShownCount(c => c + PAGE)} className="w-full py-1 text-[11px] text-cyan-300 hover:bg-gray-800/60">
            Show {Math.min(PAGE, source.length - rows.length)} earlier rows
          </button>
        )}
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-gray-900 text-gray-500 text-[10px] uppercase">
            <tr>
              <th className="text-left px-2 py-1 font-normal">#</th>
              <th className="text-left px-2 py-1 font-normal">Time</th>
              <th className="text-right px-2 py-1 font-normal">Δ ms</th>
              <th className="text-left px-2 py-1 font-normal">Dir</th>
              <th className="text-left px-2 py-1 font-normal">Addr</th>
              <th className="text-left px-1 py-1 font-normal">Sq</th>
              <th className="text-left px-2 py-1 font-normal">Type</th>
              <th className="text-left px-2 py-1 font-normal">Detail</th>
              <th className="text-right px-2 py-1 font-normal">Reply ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(e => <Row key={e.n} e={e} open={expanded === e.n} onToggle={() => setExpanded(x => x === e.n ? null : e.n)} />)}
            {!rows.length && <tr><td colSpan={9} className="px-3 py-4 text-gray-500 font-sans">{filter === 'anomalies' ? 'No anomalies so far.' : 'No frames yet.'}</td></tr>}
          </tbody>
        </table>
      </div>

      <MarkerBar traceId={traceId} live={live} onAdded={ev => {
        if (live) return; // the poll picks it up
        setEvents(p => p.concat(ev)); setAnoms(p => p.concat(ev));
      }} />
      <DocumentBox traceId={traceId} meta={meta} onSaved={m => { setMeta(m); onChanged && onChanged(); }} />
      <ExportBar traceId={traceId} live={live} />
    </div>
  );
}

function Row({ e, open, onToggle }: { e: Ev; open: boolean; onToggle: () => void }) {
  const anom = isAnom(e);
  let cls = 'text-gray-300';
  if (e.kind === 'frame') cls = e.echo ? 'text-gray-600' : e.dir === 'tx' ? 'text-sky-300' : 'text-emerald-300';
  if (e.kind === 'note') cls = e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-300' : e.level === 'success' ? 'text-emerald-300' : 'text-gray-400';
  if (e.kind === 'progress') cls = 'text-gray-500';
  if (e.kind === 'marker') cls = 'text-yellow-200';
  if (anom && e.kind === 'frame') cls = 'text-red-300';
  if (e.kind === 'noise') cls = 'text-orange-300';
  const bg = anom ? (e.kind === 'marker' ? 'bg-yellow-500/10' : 'bg-red-500/10') : '';

  const typeCell = e.kind === 'frame' ? e.name : e.kind === 'note' ? (e.level || 'note').toUpperCase() : e.kind === 'marker' ? '★ MARKER' : e.kind === 'noise' ? 'NOISE' : 'progress';
  const detail = e.kind === 'frame' ? e.summary : e.text;
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer hover:bg-gray-800/60 border-t border-gray-900 ${bg} ${cls}`}>
        <td className="px-2 py-0.5 text-gray-600">{e.n}</td>
        <td className="px-2 py-0.5 whitespace-nowrap text-gray-500">{fmtTime(e.t)}</td>
        <td className="px-2 py-0.5 text-right text-gray-600">{e.dt?.toFixed(1)}</td>
        <td className="px-2 py-0.5 whitespace-nowrap">{e.dir === 'tx' ? 'TX →' : e.dir === 'rx' ? 'RX ←' : ''}</td>
        <td className="px-2 py-0.5">{e.kind === 'frame' ? h2(e.addr) : ''}</td>
        <td className="px-1 py-0.5">{e.kind === 'frame' ? e.seq : ''}</td>
        <td className="px-2 py-0.5 whitespace-nowrap">{typeCell}</td>
        <td className="px-2 py-0.5 font-sans">
          {detail}
          {(e.flags || []).filter(f => f !== 'marker' && f !== 'noise' && f !== 'warn' && f !== 'error').map(f =>
            <span key={f} className="ml-1.5 px-1 rounded bg-gray-800 text-[10px] text-amber-200">{f}</span>)}
        </td>
        <td className="px-2 py-0.5 text-right">{e.latencyMs != null ? e.latencyMs.toFixed(1) : ''}</td>
      </tr>
      {open && (
        <tr className="bg-gray-900/80">
          <td colSpan={9} className="px-3 py-2">
            <div className="space-y-1 text-[11px]">
              <div className="text-gray-500 font-sans">{new Date(e.t).toISOString()} · +{(e.rel / 1000).toFixed(3)} s{e.len != null ? ` · ${e.len} bytes` : ''}{e.inReplyTo ? ` · reply to ${e.inReplyTo}` : ''}</div>
              {e.checkDetail && <div className="text-red-300">{e.checkDetail}</div>}
              {e.scb && <div className="text-gray-400">Security block: {e.scb.name} (len {e.scb.len}){e.mac ? ` · MAC ${e.mac}` : ''}</div>}
              {e.hex && !e.redact && <HexDump hex={e.hex} />}
              {e.redact && <div className="text-gray-500">Payload hidden (key material).</div>}
              {e.fields && <pre className="text-gray-400 whitespace-pre-wrap">{JSON.stringify(e.fields, null, 1).replace(/[{}"]/g, '').replace(/\n\s*\n/g, '\n').trim()}</pre>}
              {e.by && <div className="text-gray-500">by {e.by}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function HexDump({ hex }: { hex: string }) {
  const bytes = hex.split(' ');
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) lines.push(`${i.toString(16).padStart(4, '0')}  ${bytes.slice(i, i + 16).join(' ')}`);
  return (
    <div className="flex items-start gap-2">
      <pre className="text-gray-300 leading-snug">{lines.join('\n')}</pre>
      <button onClick={() => navigator.clipboard && navigator.clipboard.writeText(hex)} className="px-1.5 py-0.5 text-[10px] rounded border border-gray-700 text-gray-400 hover:text-hv-text">Copy hex</button>
    </div>
  );
}

function Stat({ label, v, warn }: { label: string; v: any; warn?: boolean }) {
  return (
    <span className="text-gray-500">
      {label} <span className={`font-mono ${warn ? 'text-amber-300' : 'text-gray-200'}`}>{v == null ? '—' : v}</span>
    </span>
  );
}

function Chip({ on, onClick, children, title, warn }: any) {
  return (
    <button onClick={onClick} title={title}
      className={`px-2 py-0.5 rounded border flex items-center gap-1 ${on
        ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
        : warn ? 'border-amber-500/40 text-amber-300 hover:bg-amber-500/10' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}>
      {children}
    </button>
  );
}

function MarkerBar({ traceId, live, onAdded }: { traceId: string; live: boolean; onAdded: (ev: Ev) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const t = text.trim(); if (!t) return;
    setBusy(true);
    try {
      const j = await (await fetch(`${API}/${traceId}/marker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) })).json();
      if (j.success) { setText(''); onAdded(j.event); } else alert(j.error || 'Could not add marker');
    } finally { setBusy(false); }
  };
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 border-t border-gray-800">
      <Flag size={12} className="text-yellow-300 shrink-0" />
      <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder={live ? 'Mark what you see right now, e.g. "reader LED went solid red"' : 'Add an observation to this trace'}
        className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 placeholder-gray-500 focus:border-yellow-500/50 focus:outline-none" />
      <button onClick={add} disabled={busy || !text.trim()} className="px-2.5 py-1 rounded border border-yellow-500/40 text-yellow-200 hover:bg-yellow-500/10 disabled:opacity-40">
        {busy ? <Loader2 size={12} className="animate-spin" /> : 'Mark'}
      </button>
    </div>
  );
}

function DocumentBox({ traceId, meta, onSaved }: { traceId: string; meta: any; onSaved: (m: any) => void }) {
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState('');
  const [tech, setTech] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  useEffect(() => {
    if (!meta) return;
    setTicket(meta.ticket || ''); setTech(meta.technician || ''); setNotes(meta.notes || '');
  }, [meta && meta.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setState('saving');
    const j = await (await fetch(`${API}/${traceId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, technician: tech, notes }) })).json();
    if (j.success) { setState('saved'); onSaved(j.trace); window.setTimeout(() => setState('idle'), 1500); }
    else { setState('idle'); alert(j.error || 'Save failed'); }
  };
  const has = meta && (meta.ticket || meta.notes || meta.technician);
  return (
    <div className="border-t border-gray-800">
      <button onClick={() => setOpen(o => !o)} className="w-full px-3 py-1.5 flex items-center gap-2 text-gray-300 hover:text-gray-100">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<StickyNote size={12} className="text-cyan-400" />
        Document for the manufacturer
        {has && !open && <span className="text-gray-500 truncate">{meta.ticket ? `#${meta.ticket} · ` : ''}{(meta.notes || '').split('\n')[0]}</span>}
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1.5">
          <div className="flex gap-2">
            <input value={ticket} onChange={e => setTicket(e.target.value)} placeholder="Ticket / case number"
              className="w-40 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 placeholder-gray-500" />
            <input value={tech} onChange={e => setTech(e.target.value)} placeholder="Technician"
              className="w-40 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 placeholder-gray-500" />
          </div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="What happened, what the reader did (LEDs, beeps, reboots), wiring, power, anything else they should know"
            className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-100 placeholder-gray-500 font-sans" />
          <div className="flex justify-end">
            <button onClick={save} disabled={state === 'saving'} className="px-3 py-1 rounded border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40">
              {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Save to trace'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExportBar({ traceId, live }: { traceId: string; live: boolean }) {
  const href = (f: string) => `${API}/${traceId}/export?format=${f}`;
  const A = ({ f, children, title, primary }: any) => (
    <a href={href(f)} title={title}
      className={`px-2.5 py-1 rounded border flex items-center gap-1.5 ${primary
        ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25'
        : 'border-gray-700 text-gray-300 hover:text-hv-text'}`}>{children}</a>
  );
  return (
    <div className="px-3 py-2 flex flex-wrap items-center gap-1.5 border-t border-gray-800">
      <Download size={12} className="text-gray-500" />
      <span className="text-gray-500 mr-1">Export{live ? ' (so far)' : ''}:</span>
      <A f="bundle" primary title="report.txt + trace.osdpcap + frames.csv + meta.json, zipped"><Package size={12} /> Manufacturer bundle (.zip)</A>
      <A f="report" title="Human-readable report"><FileText size={12} /> Report (.txt)</A>
      <A f="osdpcap" title="Standard OSDP capture, opens in OSDP trace viewers">.osdpcap</A>
      <A f="csv" title="Every frame decoded, for spreadsheets">.csv</A>
      <A f="jsonl" title="Aether's full decoded event log">.jsonl</A>
    </div>
  );
}

export default TraceViewer;
