/**
 * AnalyticsTool — Cloud Connector log analytics (Tools › Log Analytics).
 *
 * Two modes, one page:
 *   Inspection   — upload a controller log bundle, get every anomaly (cloud/MQTT, door
 *                  behavior, delivery & timing, panel SDK link, config/sync, security).
 *   Product Test — the same bundle plus Aether's action journal (a recorded test run,
 *                  a time window or an uploaded journal file); every action Aether
 *                  triggered is graded against what the controller logged.
 *
 * Talks to backend/routes-analytics.js (/api/analytics). Colors are HV tokens only.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  UploadCloud, FileArchive, Play, Square, Loader2, ScanSearch, FlaskConical, AlertOctagon, AlertTriangle,
  AlertCircle, Info, CheckCircle2, XCircle, ChevronRight, ChevronDown, Download, Trash2, RefreshCw, Search,
  Cloud, DoorOpen, Timer, Cpu, Settings2, ShieldAlert, FileText, Clock, Radio, X, Save, MinusCircle, HelpCircle, Eye, EyeOff, Copy, Lightbulb, Wrench, Users,
} from 'lucide-react';

// ── tokens ──────────────────────────────────────────────────────────────────
const C = {
  text: 'rgb(var(--hv-text))', text2: 'rgb(var(--hv-text-2))', text3: 'rgb(var(--hv-text-3))',
  surface: 'rgb(var(--hv-surface))', panel: 'rgb(var(--hv-widget))', panel2: 'rgb(var(--hv-widget-panel))', pop: 'rgb(var(--hv-popup-panel))',
  line: 'rgb(var(--hv-line))', lineStrong: 'rgb(var(--hv-line-strong))', brand: 'rgb(var(--hv-brand))',
};
const tint = (s: string) => ({ background: `rgb(var(--hv-${s}-tint))`, color: `rgb(var(--hv-${s}-text))`, boxShadow: `inset 0 0 0 1px rgb(var(--hv-${s}) / 0.4)` });
const neutral = { background: 'rgb(var(--hv-box))', color: C.text2, boxShadow: `inset 0 0 0 1px ${C.line}` };

type Sev = 'critical' | 'high' | 'medium' | 'low' | 'info';
const SEV: Record<Sev, { label: string; tone: string | null; icon: React.ReactNode; strong?: boolean }> = {
  critical: { label: 'Critical', tone: 'error', icon: <AlertOctagon size={13} />, strong: true },
  high: { label: 'High', tone: 'error', icon: <AlertTriangle size={13} /> },
  medium: { label: 'Medium', tone: 'warning', icon: <AlertCircle size={13} /> },
  low: { label: 'Low', tone: 'info', icon: <Info size={13} /> },
  info: { label: 'Info', tone: null, icon: <HelpCircle size={13} /> },
};
const SEV_ORDER: Sev[] = ['critical', 'high', 'medium', 'low', 'info'];
const CAT: Record<string, { label: string; icon: React.ReactNode }> = {
  cloud: { label: 'Cloud / MQTT', icon: <Cloud size={14} /> },
  door: { label: 'Door behavior', icon: <DoorOpen size={14} /> },
  delivery: { label: 'Delivery & timing', icon: <Timer size={14} /> },
  panel: { label: 'Panel SDK link', icon: <Cpu size={14} /> },
  config: { label: 'Config / sync', icon: <Settings2 size={14} /> },
  security: { label: 'Security', icon: <ShieldAlert size={14} /> },
};
const STATUS: Record<string, { label: string; tone: string | null; icon: React.ReactNode }> = {
  pass: { label: 'Pass', tone: 'success', icon: <CheckCircle2 size={13} /> },
  warn: { label: 'Warn', tone: 'warning', icon: <AlertTriangle size={13} /> },
  fail: { label: 'Fail', tone: 'error', icon: <XCircle size={13} /> },
  unmapped: { label: 'Unmapped', tone: 'info', icon: <HelpCircle size={13} /> },
  'no-data': { label: 'No data', tone: null, icon: <MinusCircle size={13} /> },
  skip: { label: 'Skipped', tone: null, icon: <MinusCircle size={13} /> },
};
const ROLES = ['dps', 'rex', 'card', 'keypad', 'lock', 'input', 'output', 'ignore'] as const;
const ROLE_LABEL: Record<string, string> = {
  dps: 'Door contact (DPS)', rex: 'REX', card: 'Card read', keypad: 'Keypad', lock: 'Lock sense (panel → Aether)',
  input: 'Generic input', output: 'Generic output', ignore: 'Ignore', unmapped: 'Unmapped',
};

// ── helpers ─────────────────────────────────────────────────────────────────
const fmtDur = (ms?: number | null) => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (a < 3600000) return `${Math.floor(a / 60000)}m ${Math.round((a % 60000) / 1000)}s`;
  if (a < 86400000) return `${Math.floor(a / 3600000)}h ${Math.round((a % 3600000) / 60000)}m`;
  return `${Math.floor(a / 86400000)}d ${Math.round((a % 86400000) / 3600000)}h`;
};
const fmtSize = (n = 0) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const mkFmt = (tz: string) => {
  let f: Intl.DateTimeFormat;
  try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  return (t?: number | null, ms = false) => {
    if (t == null || !Number.isFinite(t)) return '—';
    const s = f.format(new Date(t)).replace(',', '');
    return ms ? `${s}.${String(((t % 1000) + 1000) % 1000).padStart(3, '0')}` : s;
  };
};
const toLocalInput = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

// ── small UI pieces ─────────────────────────────────────────────────────────
function Pill({ tone, strong, icon, children, title }: { tone: string | null; strong?: boolean; icon?: React.ReactNode; children: React.ReactNode; title?: string }) {
  const st = tone ? (strong ? { ...tint(tone), background: `rgb(var(--hv-${tone}-tint-strong))` } : tint(tone)) : neutral;
  return <span title={title} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap" style={st}>{icon}{children}</span>;
}
const SevPill = ({ s }: { s: Sev }) => <Pill tone={SEV[s].tone} strong={SEV[s].strong} icon={SEV[s].icon}>{SEV[s].label}</Pill>;
const StatusPill = ({ s }: { s: string }) => { const m = STATUS[s] || STATUS.skip; return <Pill tone={m.tone} icon={m.icon}>{m.label}</Pill>; };
const BasisPill = ({ b }: { b: string }) => (
  <Pill tone={null} title={b === 'confirmed' ? 'Stated directly by the log' : b === 'derived' ? 'Computed from timing / sequence' : 'Pattern that usually indicates trouble — verify'}>
    {b === 'confirmed' ? 'Logged' : b === 'derived' ? 'Derived' : 'Heuristic'}
  </Pill>
);

function Card({ title, icon, right, children, pad = true }: { title?: React.ReactNode; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; pad?: boolean }) {
  return (
    <section className="rounded-xl border" style={{ background: C.panel, borderColor: C.line }}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: C.line }}>
          <h3 className="text-sm font-bold flex items-center gap-2" style={{ color: C.text }}>{icon}{title}</h3>
          {right}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

function Btn({ kind = 'secondary', className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const st: React.CSSProperties = kind === 'primary' ? { background: C.brand, color: '#fff', borderColor: C.brand }
    : kind === 'danger' ? { ...tint('error'), borderColor: 'transparent' }
      : kind === 'ghost' ? { background: 'transparent', color: C.text2, borderColor: 'transparent' }
        : { background: 'rgb(var(--hv-box))', color: C.text, borderColor: C.line };
  return <button {...p} className={`inline-flex items-center justify-center gap-1.5 px-3 h-8 rounded-md text-sm font-semibold border transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed ${className}`} style={{ ...st, ...(p.style || {}) }} />;
}

const inputCls = 'h-8 rounded-md px-2.5 text-sm border outline-none focus:ring-1 focus:ring-hv-info';
const inputSt: React.CSSProperties = { background: C.surface, borderColor: C.line, color: C.text };

function Seg<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: React.ReactNode }[] }) {
  return (
    <div className="inline-flex p-0.5 rounded-lg" style={{ background: C.surface, boxShadow: `inset 0 0 0 1px ${C.line}` }} role="radiogroup">
      {items.map(it => (
        <button key={it.id} role="radio" aria-checked={value === it.id} onClick={() => onChange(it.id)}
          className="px-3 h-8 rounded-md text-sm font-semibold inline-flex items-center gap-1.5"
          style={value === it.id ? tint('brand') : { color: C.text3 }}>{it.label}</button>
      ))}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string | null }) {
  return (
    <div className="rounded-lg px-3 py-2.5 min-w-[110px]" style={{ background: C.panel2, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.text3 }}>{label}</div>
      <div className="text-xl font-bold leading-tight mt-0.5" style={{ color: tone ? `rgb(var(--hv-${tone}-text))` : C.text }}>{value}</div>
      {sub && <div className="text-xs mt-0.5" style={{ color: C.text3 }}>{sub}</div>}
    </div>
  );
}

function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-4" style={{ color: C.text3 }}>
      <div className="mb-3 opacity-70">{icon}</div>
      <div className="text-sm font-semibold" style={{ color: C.text2 }}>{title}</div>
      {children && <div className="text-sm mt-1 max-w-md">{children}</div>}
    </div>
  );
}

// ── charts (single series → one hue; status lines carry labels) ─────────────
function HourlyBars({ data, fmt }: { data: { t: number; n: number }[]; fmt: (t: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return null;
  const W = 900, H = 120, pad = 22;
  const t0 = data[0].t, t1 = data[data.length - 1].t + 3600000;
  const max = Math.max(...data.map(d => d.n));
  const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (W - pad * 2);
  const bw = Math.max(2, (W - pad * 2) / ((t1 - t0) / 3600000) - 2);
  const h = data[hover ?? -1];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label="Controller events per hour" onMouseLeave={() => setHover(null)}>
        <line x1={pad} x2={W - pad} y1={H} y2={H} stroke={C.line} />
        <text x={pad} y={10} fontSize="10" fill={C.text3}>{max}/h</text>
        <line x1={pad} x2={W - pad} y1={14} y2={14} stroke={C.line} strokeDasharray="2 4" />
        {data.map((d, i) => {
          const bh = Math.max(2, (d.n / max) * (H - 16));
          return (
            <g key={d.t} onMouseEnter={() => setHover(i)}>
              <rect x={x(d.t) - 1} y={0} width={bw + 2} height={H} fill="transparent" />
              <rect x={x(d.t)} y={H - bh} width={bw} height={bh} rx={Math.min(2, bw / 2)} fill="rgb(var(--hv-data-blue))" opacity={hover == null || hover === i ? 1 : 0.45} />
            </g>
          );
        })}
        <text x={pad} y={H + 14} fontSize="10" fill={C.text3}>{fmt(t0).slice(0, 16)}</text>
        <text x={W - pad} y={H + 14} fontSize="10" fill={C.text3} textAnchor="end">{fmt(t1).slice(0, 16)}</text>
      </svg>
      {h && (
        <div className="absolute top-0 pointer-events-none px-2 py-1 rounded-md text-xs shadow-hv-2"
          style={{ left: `${(x(h.t) / W) * 100}%`, transform: 'translateX(-50%)', background: C.pop, color: C.text, boxShadow: `0 0 0 1px ${C.line}` }}>
          <b>{h.n}</b> events · {fmt(h.t).slice(0, 13)}:00
        </div>
      )}
    </div>
  );
}

function LatencyHist({ values, warn, fail }: { values: number[]; warn: number; fail: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!values.length) return null;
  const maxV = Math.max(fail * 1.25, ...values);
  const bins = 30, step = maxV / bins;
  const counts = Array.from({ length: bins }, (_, i) => values.filter(v => v >= i * step && (i === bins - 1 ? v <= maxV : v < (i + 1) * step)).length);
  const W = 900, H = 120, pad = 22, top = Math.max(...counts);
  const x = (v: number) => pad + (v / maxV) * (W - pad * 2);
  const bw = (W - pad * 2) / bins - 2;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label="Action to controller event latency" onMouseLeave={() => setHover(null)}>
        <line x1={pad} x2={W - pad} y1={H} y2={H} stroke={C.line} />
        {counts.map((n, i) => {
          const bh = n ? Math.max(2, (n / top) * (H - 18)) : 0;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={x(i * step)} y={0} width={bw + 2} height={H} fill="transparent" />
              {bh > 0 && <rect x={x(i * step) + 1} y={H - bh} width={bw} height={bh} rx={2} fill="rgb(var(--hv-data-blue))" opacity={hover == null || hover === i ? 1 : 0.45} />}
            </g>
          );
        })}
        {[[warn, 'warning', 'warn'], [fail, 'error', 'fail']].map(([v, tone, l]) => (
          <g key={l as string}>
            <line x1={x(v as number)} x2={x(v as number)} y1={8} y2={H} stroke={`rgb(var(--hv-${tone}))`} strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={x(v as number) + 4} y={14} fontSize="10" fill={`rgb(var(--hv-${tone}-text))`}>{l} {fmtDur(v as number)}</text>
          </g>
        ))}
        <text x={pad} y={H + 14} fontSize="10" fill={C.text3}>0</text>
        <text x={W - pad} y={H + 14} fontSize="10" fill={C.text3} textAnchor="end">{fmtDur(maxV)}</text>
      </svg>
      {hover != null && counts[hover] > 0 && (
        <div className="absolute top-0 pointer-events-none px-2 py-1 rounded-md text-xs"
          style={{ left: `${(x((hover + 0.5) * step) / W) * 100}%`, transform: 'translateX(-50%)', background: C.pop, color: C.text, boxShadow: `0 0 0 1px ${C.line}` }}>
          <b>{counts[hover]}</b> actions · {fmtDur(hover * step)}–{fmtDur((hover + 1) * step)}
        </div>
      )}
    </div>
  );
}

// ── table primitives ────────────────────────────────────────────────────────
const Th = ({ children, className = '' }: { children?: React.ReactNode; className?: string }) =>
  <th className={`text-left text-[11px] font-semibold uppercase tracking-wide px-3 py-2 sticky top-0 ${className}`} style={{ color: C.text3, background: C.panel2 }}>{children}</th>;
const Td = ({ children, className = '', mono = false, title }: { children?: React.ReactNode; className?: string; mono?: boolean; title?: string }) =>
  <td title={title} className={`px-3 py-2 align-top text-sm ${mono ? 'font-mono text-xs' : ''} ${className}`} style={{ color: C.text2 }}>{children}</td>;

function Pager({ page, pages, setPage, total }: { page: number; pages: number; setPage: (n: number) => void; total: number }) {
  if (pages <= 1) return <div className="text-xs px-3 py-2" style={{ color: C.text3 }}>{total} rows</div>;
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs" style={{ color: C.text3 }}>
      <span>{total} rows</span>
      <span className="flex items-center gap-2">
        <Btn kind="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Btn>
        {page + 1} / {pages}
        <Btn kind="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Btn>
      </span>
    </div>
  );
}
function usePaged<T>(rows: T[], size = 100) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  useEffect(() => { if (page >= pages) setPage(0); }, [pages, page]);
  return { slice: rows.slice(page * size, page * size + size), page, pages, setPage, total: rows.length };
}

// ═════════════════════════════════════════════════════════════════════════════
export default function AnalyticsTool({ backendUrl }: { backendUrl: string }) {
  const API = `${backendUrl.replace(/\/$/, '')}/api/analytics`;
  const [mode, setMode] = useState<'inspection' | 'product-test'>(() => { try { return (sessionStorage.getItem('aether.analytics.mode') as any) || 'inspection'; } catch { return 'inspection'; } });
  const [bundles, setBundles] = useState<File[]>([]);
  const [journalFile, setJournalFile] = useState<File | null>(null);
  const [jSource, setJSource] = useState<'run' | 'window' | 'auto' | 'upload'>('run');
  const [runId, setRunId] = useState('');
  const [winFrom, setWinFrom] = useState(() => toLocalInput(Date.now() - 3600000));
  const [winTo, setWinTo] = useState(() => toLocalInput(Date.now()));
  const [jstat, setJstat] = useState<any>(null);
  const [runName, setRunName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [reports, setReports] = useState<any[]>([]);
  const [report, setReport] = useState<any>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const dropRef = useRef<HTMLInputElement>(null);
  const jRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => { try { sessionStorage.setItem('aether.analytics.mode', mode); } catch { /* */ } }, [mode]);

  const getJSON = useCallback(async (p: string, init?: RequestInit) => {
    const r = await fetch(`${API}${p}`, init);
    const j = await r.json().catch(() => ({ success: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.success === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }, [API]);

  const refreshReports = useCallback(() => getJSON('/reports').then(j => setReports(j.reports || [])).catch(() => { /* backend may be older */ }), [getJSON]);
  const refreshJournal = useCallback(() => getJSON('/journal/status').then(j => {
    setJstat(j);
    if (!runId && j.runs && j.runs[0]) setRunId(j.runs[0].id);
  }).catch(() => { /* */ }), [getJSON, runId]);
  const refreshSettings = useCallback(() => getJSON('/settings').then(setSettings).catch(() => { /* */ }), [getJSON]);

  useEffect(() => { refreshReports(); refreshJournal(); refreshSettings(); }, [refreshReports, refreshJournal, refreshSettings]);
  useEffect(() => {
    if (!jstat || !jstat.currentRun) return;
    const t = setInterval(refreshJournal, 2000);
    return () => clearInterval(t);
  }, [jstat && jstat.currentRun && jstat.currentRun.id, refreshJournal]);

  const openReport = useCallback(async (id: string) => {
    setLoadingReport(true); setError('');
    try { const r = await fetch(`${API}/reports/${id}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); setReport(await r.json()); }
    catch (e: any) { setError(`Could not open report: ${e.message}`); }
    finally { setLoadingReport(false); }
  }, [API]);

  const addBundles = (fl: FileList | null) => { if (fl && fl.length) setBundles(prev => [...prev, ...Array.from(fl)].slice(0, 16)); };

  const scan = async () => {
    if (!bundles.length) { setError('Add the Cloud Connector log bundle first.'); return; }
    setScanning(true); setError('');
    const fd = new FormData();
    bundles.forEach(f => fd.append('bundle', f, f.name));
    fd.append('mode', mode);
    if (mode === 'product-test') {
      if (jSource === 'upload') { if (!journalFile) { setScanning(false); setError('Choose the emulator journal file.'); return; } fd.append('journalSource', 'upload'); fd.append('journal', journalFile, journalFile.name); }
      else if (jSource === 'run') { if (!runId) { setScanning(false); setError('Pick a recorded test run (or record one first).'); return; } fd.append('runId', runId); }
      else if (jSource === 'window') { fd.append('from', String(new Date(winFrom).getTime())); fd.append('to', String(new Date(winTo).getTime())); }
    }
    try {
      const r = await fetch(`${API}/scan`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({ success: false, error: `HTTP ${r.status}` }));
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      await refreshReports();
      await openReport(j.id);
    } catch (e: any) { setError(e.message); }
    finally { setScanning(false); }
  };

  const startRun = async () => { try { await getJSON('/journal/run/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: runName || `Test ${new Date().toLocaleString()}` }) }); setRunName(''); refreshJournal(); } catch (e: any) { setError(e.message); } };
  const stopRun = async () => { try { const j = await getJSON('/journal/run/stop', { method: 'POST' }); if (j.run) setRunId(j.run.id); refreshJournal(); } catch (e: any) { setError(e.message); } };
  const delReport = async (id: string) => { try { await getJSON(`/reports/${id}`, { method: 'DELETE' }); if (report && report.id === id) setReport(null); refreshReports(); } catch { /* */ } };

  const running = jstat && jstat.currentRun;

  return (
    <div className="space-y-4" style={{ color: C.text }}>
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Log Analytics</h2>
          <p className="text-sm mt-0.5" style={{ color: C.text3 }}>Scan Cloud Connector logs for anomalies, or grade a test run: what Aether triggered vs. what the controller logged.</p>
        </div>
        <Seg value={mode} onChange={setMode} items={[
          { id: 'inspection', label: <><ScanSearch size={15} />Inspection</> },
          { id: 'product-test', label: <><FlaskConical size={15} />Product Test</> },
        ]} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        {/* ── left column: new scan, recorder, history ─────────────────── */}
        <div className="space-y-4">
          <Card title="New scan" icon={<UploadCloud size={16} />}>
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); addBundles(e.dataTransfer.files); }}
              onClick={() => dropRef.current?.click()}
              className="rounded-lg border border-dashed px-4 py-6 text-center cursor-pointer transition-colors"
              style={{ borderColor: drag ? C.brand : C.lineStrong, background: drag ? 'rgb(var(--hv-brand-tint))' : C.panel2 }}>
              <FileArchive size={26} className="mx-auto mb-2" style={{ color: C.text3 }} />
              <div className="text-sm font-semibold">Drop the controller log bundle</div>
              <div className="text-xs mt-1" style={{ color: C.text3 }}>.tar.gz / .tgz / .zip exported from the controller, or individual CloudConnector / aspsdk / audit logs</div>
              <input ref={dropRef} type="file" multiple className="hidden" accept=".gz,.tgz,.tar,.zip,.log,.csv,.txt,.json,.conf,.01,.02,.03,.04,.05,.06,.07,.08,.09,.10"
                onChange={e => { addBundles(e.target.files); e.target.value = ''; }} />
            </div>
            {bundles.length > 0 && (
              <ul className="mt-3 space-y-1">
                {bundles.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm rounded-md px-2 py-1.5" style={{ background: C.panel2 }}>
                    <FileText size={14} style={{ color: C.text3 }} />
                    <span className="truncate flex-1" title={f.name}>{f.name}</span>
                    <span className="text-xs" style={{ color: C.text3 }}>{fmtSize(f.size)}</span>
                    <button aria-label="Remove" onClick={() => setBundles(b => b.filter((_, k) => k !== i))} style={{ color: C.text3 }}><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}

            {mode === 'product-test' && (
              <div className="mt-4 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: C.text3 }}>Emulator journal — what Aether triggered</div>
                {([
                  ['run', 'Recorded test run'], ['window', 'Time window'], ['auto', 'Whatever the controller logs cover'], ['upload', 'Upload a journal file'],
                ] as const).map(([id, label]) => (
                  <label key={id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="jsrc" checked={jSource === id} onChange={() => setJSource(id)} className="accent-hv-brand" />{label}
                  </label>
                ))}
                {jSource === 'run' && (
                  <select className={`${inputCls} w-full`} style={inputSt} value={runId} onChange={e => setRunId(e.target.value)}>
                    {!(jstat && jstat.runs && jstat.runs.length) && <option value="">No runs recorded yet</option>}
                    {jstat && jstat.runs && jstat.runs.map((r: any) => (
                      <option key={r.id} value={r.id}>{r.name} — {new Date(r.start).toLocaleString()}{r.end ? ` (${fmtDur(r.end - r.start)})` : ' (recording)'}</option>
                    ))}
                  </select>
                )}
                {jSource === 'window' && (
                  <div className="grid grid-cols-2 gap-2">
                    <input type="datetime-local" className={inputCls} style={inputSt} value={winFrom} onChange={e => setWinFrom(e.target.value)} aria-label="From" />
                    <input type="datetime-local" className={inputCls} style={inputSt} value={winTo} onChange={e => setWinTo(e.target.value)} aria-label="To" />
                  </div>
                )}
                {jSource === 'upload' && (
                  <div className="flex items-center gap-2">
                    <Btn onClick={() => jRef.current?.click()}><UploadCloud size={14} />Choose journal</Btn>
                    <span className="text-sm truncate" style={{ color: C.text2 }}>{journalFile ? journalFile.name : 'aether-journal-*.jsonl'}</span>
                    <input ref={jRef} type="file" className="hidden" accept=".jsonl,.json,.ndjson,.txt" onChange={e => { setJournalFile(e.target.files?.[0] || null); e.target.value = ''; }} />
                  </div>
                )}
              </div>
            )}

            {error && <div className="mt-3 text-sm rounded-md px-3 py-2 flex gap-2" style={tint('error')}><AlertTriangle size={15} className="shrink-0 mt-0.5" />{error}</div>}
            <Btn kind="primary" className="w-full mt-4 h-9" disabled={scanning || !bundles.length} onClick={scan}>
              {scanning ? <><Loader2 size={15} className="animate-spin" />Scanning…</> : <><ScanSearch size={15} />{mode === 'product-test' ? 'Run Product Test' : 'Scan for anomalies'}</>}
            </Btn>
          </Card>

          {mode === 'product-test' && (
            <Card title="Test recorder" icon={<Radio size={16} />}
              right={running ? <Pill tone="error" icon={<span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'rgb(var(--hv-error))' }} />}>Recording</Pill> : null}>
              <p className="text-xs mb-3" style={{ color: C.text3 }}>
                Aether always journals relay/opto changes, emulated board I/O and card sends. Start a run to group a test, run your workflow, stop, then export the controller logs and scan.
              </p>
              {running ? (
                <div className="space-y-2">
                  <div className="text-sm"><b>{jstat.currentRun.name}</b></div>
                  <div className="text-xs" style={{ color: C.text3 }}>Started {new Date(jstat.currentRun.start).toLocaleTimeString()} · {fmtDur(Date.now() - jstat.currentRun.start)} · {jstat.stats ? jstat.stats.recorded : 0} entries since backend start</div>
                  <Btn kind="danger" className="w-full" onClick={stopRun}><Square size={14} />Stop run</Btn>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input className={`${inputCls} flex-1 min-w-0`} style={inputSt} placeholder="Run name (e.g. FW 1.23.3 door regression)" value={runName} onChange={e => setRunName(e.target.value)} />
                  <Btn onClick={startRun}><Play size={14} />Start</Btn>
                </div>
              )}
              {jstat && jstat.runs && jstat.runs[0] && (
                <a className="mt-3 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: 'rgb(var(--hv-info-text))' }}
                  href={`${API}/journal/export?run=${encodeURIComponent(runId || jstat.runs[0].id)}`}><Download size={13} />Export selected run journal</a>
              )}
            </Card>
          )}

          <Card title="Reports" icon={<FileText size={16} />} right={<button aria-label="Refresh" onClick={refreshReports} style={{ color: C.text3 }}><RefreshCw size={14} /></button>} pad={false}>
            {!reports.length ? <Empty icon={<FileText size={24} />} title="No reports yet">Scan a bundle to see results here.</Empty> : (
              <ul className="max-h-[420px] overflow-auto divide-y" style={{ borderColor: C.line }}>
                {reports.map(r => {
                  const active = report && report.id === r.id;
                  const worst = SEV_ORDER.find(s => (r.bySeverity || {})[s]);
                  return (
                    <li key={r.id} className="flex items-start gap-2 px-4 py-2.5 cursor-pointer" onClick={() => openReport(r.id)}
                      style={{ background: active ? 'rgb(var(--hv-brand-tint))' : undefined, borderColor: C.line }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{r.name}</div>
                        <div className="text-xs mt-0.5 flex flex-wrap gap-1.5 items-center" style={{ color: C.text3 }}>
                          {r.mode === 'product-test' ? <FlaskConical size={12} /> : <ScanSearch size={12} />}
                          {new Date(r.createdAt).toLocaleString()} · {r.findings} findings
                        </div>
                        <div className="mt-1 flex gap-1">
                          {r.verdict && <Pill tone={r.verdict === 'FAIL' ? 'error' : r.verdict === 'PASS' ? 'success' : r.verdict === 'NO RESULT' ? null : 'warning'}>{r.verdict}</Pill>}
                          {worst && <SevPill s={worst} />}
                        </div>
                      </div>
                      <button aria-label="Delete report" onClick={e => { e.stopPropagation(); delReport(r.id); }} style={{ color: C.text3 }}><Trash2 size={14} /></button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        {/* ── right column: report ─────────────────────────────────────── */}
        <div className="min-w-0">
          {loadingReport ? <Card><Empty icon={<Loader2 size={24} className="animate-spin" />} title="Loading report…" /></Card>
            : report ? <ReportView report={report} api={API} settings={settings} onSettings={setSettings} />
              : <Card><Empty icon={<ScanSearch size={28} />} title="No report open">
                {mode === 'product-test'
                  ? 'Record a test run (or pick a time window), export the controller logs right after the test, then drop the bundle here.'
                  : 'Drop a Cloud Connector log bundle and press Scan. Every finding links back to the file and line it came from.'}
              </Empty></Card>}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
type Tab = 'findings' | 'test' | 'timeline' | 'panel' | 'files' | 'settings';

function ReportView({ report, api, settings, onSettings }: { report: any; api: string; settings: any; onSettings: (s: any) => void }) {
  const tz = (report.zone && report.zone.tz) || 'UTC';
  const fmt = useMemo(() => mkFmt(tz), [tz]);
  const pt = report.productTest;
  const [tab, setTab] = useState<Tab>(pt ? 'test' : 'findings');
  useEffect(() => { setTab(report.productTest ? 'test' : 'findings'); }, [report.id]);
  const s = report.summary || {};
  const dev = s.device || {};
  const bySev = s.bySeverity || {};

  const tabs: { id: Tab; label: string; n?: number }[] = [
    ...(pt ? [{ id: 'test' as Tab, label: 'Product Test', n: pt.results.length }] : []),
    { id: 'findings', label: 'Findings', n: report.findings.length },
    { id: 'timeline', label: 'Timeline', n: report.events.length },
    { id: 'panel', label: 'Panel link', n: (report.frames || []).length || (report.panelEvents || []).length },
    { id: 'files', label: 'Files & coverage', n: report.files.length },
    { id: 'settings', label: 'Thresholds & wiring' },
  ];

  return (
    <div className="space-y-4">
      <Card pad={false}>
        <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-3 border-b" style={{ borderColor: C.line }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-bold truncate">{report.name}</h3>
              <Pill tone={null} icon={report.mode === 'product-test' ? <FlaskConical size={12} /> : <ScanSearch size={12} />}>{report.mode === 'product-test' ? 'Product Test' : 'Inspection'}</Pill>
            </div>
            <div className="text-xs mt-1 flex flex-wrap gap-x-3 gap-y-1" style={{ color: C.text3 }}>
              {dev.model && <span>{dev.family ? `${dev.family} ` : ''}{dev.model} · S/N {dev.serial}</span>}
              {dev.firmware && <span>FW {dev.firmware} · Cloud Connector {dev.edgeapp}</span>}
              {dev.hostname && <span>{dev.hostname}</span>}
              <span className="inline-flex items-center gap-1" title="CloudConnector log span — see Files & coverage for every source"><Clock size={12} />{fmt((report.coverage.cloudconnector || report.window).from)} → {fmt((report.coverage.cloudconnector || report.window).to)} ({tz}, from {report.zone.from})</span>
              {report.journalLabel && <span>Journal: {report.journalLabel}</span>}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <a href={`${api}/reports/${report.id}/findings.csv`}><Btn><Download size={14} />Findings CSV</Btn></a>
            {pt && <a href={`${api}/reports/${report.id}/results.csv`}><Btn><Download size={14} />Results CSV</Btn></a>}
          </div>
        </div>
        <div className="p-4 flex flex-wrap gap-2">
          {pt && (
            <Stat label="Verdict" value={pt.summary.verdict} tone={pt.summary.verdict === 'FAIL' ? 'error' : pt.summary.verdict === 'PASS' ? 'success' : pt.summary.verdict === 'NO RESULT' ? null : 'warning'}
              sub={`${pt.summary.pass} pass · ${pt.summary.warn} warn · ${pt.summary.fail} fail`} />
          )}
          {pt && <Stat label="Latency p50 / p95" value={`${fmtDur(pt.summary.latencyP50)}`} sub={`p95 ${fmtDur(pt.summary.latencyP95)} · max ${fmtDur(pt.summary.latencyMax)}`} />}
          {SEV_ORDER.map(k => <Stat key={k} label={SEV[k].label} value={bySev[k] || 0} tone={bySev[k] && SEV[k].tone ? SEV[k].tone : null} />)}
          {s.publishLag && <Stat label="Event → cloud" value={fmtDur(s.publishLag.p50)} sub={`p95 ${fmtDur(s.publishLag.p95)} · ${s.publishLag.n} events`} />}
          {s.sdk && <Stat label="SDK reply" value={fmtDur(s.sdk.replyP50)} sub={`p95 ${fmtDur(s.sdk.replyP95)} · ${s.sdk.frames} frames`} />}
          {s.panelToCloud && <Stat label="Panel → cloud" value={fmtDur(s.panelToCloud.p50)} sub={`p95 ${fmtDur(s.panelToCloud.p95)} · ${s.panelToCloud.n} events`} />}
        </div>
        <nav className="flex flex-wrap gap-1 px-3 border-t" style={{ borderColor: C.line }} role="tablist">
          {tabs.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className="px-3 py-2.5 text-sm font-semibold inline-flex items-center gap-1.5"
              style={tab === t.id ? { color: C.text, boxShadow: `inset 0 -2px 0 ${C.brand}` } : { color: C.text3 }}>
              {t.label}{t.n != null && <span className="text-xs font-normal" style={{ color: C.text3 }}>{t.n}</span>}
            </button>
          ))}
        </nav>
      </Card>

      {tab === 'findings' && <FindingsTab report={report} fmt={fmt} api={api} />}
      {tab === 'test' && pt && <TestTab report={report} fmt={fmt} api={api} settings={settings} onSettings={onSettings} />}
      {tab === 'timeline' && <TimelineTab report={report} fmt={fmt} />}
      {tab === 'panel' && <PanelTab report={report} fmt={fmt} api={api} />}
      {tab === 'files' && <FilesTab report={report} fmt={fmt} />}
      {tab === 'settings' && <SettingsTab api={api} settings={settings} onSettings={onSettings} report={report} />}
    </div>
  );
}

// ── Findings ────────────────────────────────────────────────────────────────
// archived snapshots: show which snapshot, not just the file name
const srcLabel = (file: string, line?: number) => {
  const m = /([^/]+?)\.(?:tar\.gz|tgz|tar)\.d\//.exec(String(file));
  const base = String(file).split('/').pop();
  return `${m ? m[1] + ' › ' : ''}${base}${line ? ':' + line : ''}`;
};

// One sample. "Show raw" fetches the original log line (+3 lines of context) from the Pi on demand.
function SampleRow({ x, fid, i, report, fmt, api }: { x: any; fid: string; i: number; report: any; fmt: (t?: number | null, ms?: boolean) => string; api: string }) {
  const [raw, setRaw] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // lines carrying secrets hide themselves again after a minute
  useEffect(() => { if (!raw || !raw.secret) return; const t = setTimeout(() => setRaw(null), 60000); return () => clearTimeout(t); }, [raw]);
  const reveal = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${api}/reports/${report.id}/raw?f=${encodeURIComponent(fid)}&i=${i}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({ success: false, error: `HTTP ${r.status}` }));
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      setRaw(j);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(raw.line); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } };
  const first = raw ? Math.max(1, (raw.n || 1) - (raw.before || []).length) : 1;
  const nLines = raw ? String(raw.line).split('\n').length : 0;
  return (
    <tr className="border-t" style={{ borderColor: C.line }}>
      <Td mono className="whitespace-nowrap">{fmt(x.t, true)}</Td>
      <Td mono className="whitespace-nowrap" title={x.file}>{x.file ? srcLabel(x.file, x.line) : '—'}</Td>
      <Td mono className="break-all">
        {x.text}
        {raw && (
          <div className="mt-2 rounded-md overflow-hidden" style={{ boxShadow: `inset 0 0 0 1px ${raw.secret ? 'rgb(var(--hv-warning) / 0.5)' : C.line}`, background: C.surface }}>
            <div className="flex items-center justify-between gap-2 px-2 py-1 font-sans text-[11px] font-semibold" style={raw.secret ? tint('warning') : { color: C.text3, background: C.panel2 }}>
              <span className="inline-flex items-center gap-1 truncate">{raw.secret ? <><AlertTriangle size={12} />Raw — contains secrets, hides in 60 s</> : <>Raw · {srcLabel(raw.file)}</>}</span>
              <span className="inline-flex items-center gap-3 shrink-0">
                <button onClick={copy} className="inline-flex items-center gap-1">{copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy line'}</button>
                <button onClick={() => setRaw(null)} className="inline-flex items-center gap-1"><EyeOff size={12} />Hide</button>
              </span>
            </div>
            <pre className="text-xs leading-5 px-2 py-1.5 whitespace-pre-wrap break-all m-0">
              {(raw.before || []).map((l: string, k: number) => <div key={`b${k}`} style={{ color: C.text3 }}><span className="select-none inline-block w-12 text-right pr-2 opacity-70">{first + k}</span>{l}</div>)}
              <div style={{ color: C.text, background: 'rgb(var(--hv-brand-tint))' }}><span className="select-none inline-block w-12 text-right pr-2 opacity-70">{raw.n || ''}</span>{raw.line}</div>
              {(raw.after || []).map((l: string, k: number) => <div key={`a${k}`} style={{ color: C.text3 }}><span className="select-none inline-block w-12 text-right pr-2 opacity-70">{(raw.n || 0) + nLines + k}</span>{l}</div>)}
            </pre>
          </div>
        )}
        {err && <div className="text-xs mt-1 font-sans" style={{ color: 'rgb(var(--hv-error-text))' }}>{err}</div>}
      </Td>
      <Td className="whitespace-nowrap text-right">
        {x.hasRaw && !raw && (
          <Btn kind="ghost" onClick={reveal} disabled={busy} title="Show the original log line with context" aria-label="Show raw line">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}Show raw
          </Btn>
        )}
      </Td>
    </tr>
  );
}

// "Likely cause" banner shown when a finding is opened — for T/S and Engineering
const ownerTone = (o: string) => /^Engineering$/.test(o) ? 'purple' : /→/.test(o) ? 'warning' : 'info';
function CauseBanner({ pb, fix }: { pb: any; fix?: string }) {
  if (!pb) return fix ? <div className="text-sm rounded-md px-3 py-2" style={tint('info')}><b>What to check:</b> {fix}</div> : null;
  return (
    <div className="rounded-lg overflow-hidden" style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--hv-info) / 0.45)' }}>
      <div className="px-3 py-2.5" style={{ background: 'rgb(var(--hv-info-tint))' }}>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide" style={{ color: 'rgb(var(--hv-info-text))' }}><Lightbulb size={14} />Likely cause</span>
          <Pill tone={pb.confidence === 'likely' ? 'success' : null} title={pb.confidence === 'likely' ? 'Evidence in this bundle points here' : 'Common cause — not proven by this bundle'}>{pb.confidence === 'likely' ? 'Likely' : 'Possible'}</Pill>
          <Pill tone={ownerTone(pb.owner)} icon={<Users size={12} />} title="Who usually resolves this">{pb.owner}</Pill>
        </div>
        <p className="text-sm" style={{ color: C.text }}>{pb.cause}</p>
      </div>
      {pb.steps && pb.steps.length > 0 && (
        <div className="px-3 py-2.5" style={{ background: C.panel2 }}>
          <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide mb-1.5" style={{ color: C.text3 }}><Wrench size={13} />Troubleshooting</div>
          <ol className="space-y-1">
            {pb.steps.map((st: string, k: number) => (
              <li key={k} className="flex gap-2 text-sm" style={{ color: C.text2 }}>
                <span className="shrink-0 w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] font-bold" style={tint('info')}>{k + 1}</span>
                <span>{st}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function FindingsTab({ report, fmt, api }: { report: any; fmt: (t?: number | null, ms?: boolean) => string; api: string }) {
  const [sevs, setSevs] = useState<Set<Sev>>(new Set(['critical', 'high', 'medium', 'low']));
  const [cat, setCat] = useState<string>('all');
  const [owner, setOwner] = useState<string>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const list = report.findings.filter((f: any) => sevs.has(f.sev) && (cat === 'all' || f.cat === cat)
    && (owner === 'all' || (f.playbook && (owner === 'ts' ? /T\/S/.test(f.playbook.owner) : /Engineering/.test(f.playbook.owner))))
    && (!q || `${f.title} ${f.detail} ${f.samples.map((x: any) => x.text).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const toggle = (id: string) => setOpen(o => { const n = new Set(o); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const cats = Object.keys(CAT).filter(c => report.findings.some((f: any) => f.cat === c));

  return (
    <Card pad={false}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b" style={{ borderColor: C.line }}>
        {SEV_ORDER.map(k => {
          const on = sevs.has(k); const n = report.findings.filter((f: any) => f.sev === k).length;
          return (
            <button key={k} onClick={() => setSevs(s => { const x = new Set(s); x.has(k) ? x.delete(k) : x.add(k); return x; })}
              className="inline-flex items-center gap-1 px-2.5 h-7 rounded-full text-xs font-semibold"
              style={on ? (SEV[k].tone ? tint(SEV[k].tone as string) : neutral) : { color: C.text3, boxShadow: `inset 0 0 0 1px ${C.line}` }}
              aria-pressed={on}>{SEV[k].icon}{SEV[k].label} {n}</button>
          );
        })}
        <span className="w-px h-6 mx-1" style={{ background: C.line }} />
        <select className={inputCls} style={inputSt} value={cat} onChange={e => setCat(e.target.value)} aria-label="Category">
          <option value="all">All categories</option>
          {cats.map(c => <option key={c} value={c}>{CAT[c].label}</option>)}
        </select>
        <select className={inputCls} style={inputSt} value={owner} onChange={e => setOwner(e.target.value)} aria-label="Owner">
          <option value="all">Everyone</option><option value="ts">Field / T/S</option><option value="eng">Engineering</option>
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: C.text3 }} />
          <input className={`${inputCls} w-full pl-8`} style={inputSt} placeholder="Search findings and log lines" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      {!list.length ? <Empty icon={<CheckCircle2 size={26} />} title="Nothing matches these filters" /> : (
        <ul>
          {list.map((f: any) => {
            const isOpen = open.has(f.id);
            return (
              <li key={f.id} className="border-b last:border-b-0" style={{ borderColor: C.line }}>
                <button className="w-full text-left flex items-start gap-3 px-4 py-3" onClick={() => toggle(f.id)} aria-expanded={isOpen}>
                  <span className="mt-0.5" style={{ color: C.text3 }}>{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <SevPill s={f.sev} />
                      <span className="text-sm font-semibold" style={{ color: C.text }}>{f.title}</span>
                    </div>
                    <div className="text-xs mt-1 flex flex-wrap gap-x-3 gap-y-1 items-center" style={{ color: C.text3 }}>
                      <span className="inline-flex items-center gap-1">{(CAT[f.cat] || CAT.config).icon}{(CAT[f.cat] || CAT.config).label}</span>
                      <BasisPill b={f.basis} />
                      {f.playbook && <span className="inline-flex items-center gap-1"><Users size={12} />{f.playbook.owner}</span>}
                      {f.first && <span>{fmt(f.first)}{f.last && f.last !== f.first ? ` → ${fmt(f.last)}` : ''}</span>}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 pl-11 space-y-3">
                    {f.detail && <p className="text-sm" style={{ color: C.text2 }}>{f.detail}</p>}
                    <CauseBanner pb={f.playbook} fix={f.fix} />
                    {f.samples.length > 0 && (
                      <div className="rounded-lg overflow-hidden" style={{ boxShadow: `inset 0 0 0 1px ${C.line}` }}>
                        <table className="w-full">
                          <thead><tr><Th>Time ({report.zone.tz})</Th><Th>Source</Th><Th>Log</Th><Th /></tr></thead>
                          <tbody>
                            {f.samples.map((x: any, i: number) => <SampleRow key={i} x={x} fid={f.id} i={i} report={report} fmt={fmt} api={api} />)}
                          </tbody>
                        </table>
                        {f.count > f.samples.length && <div className="text-xs px-3 py-2" style={{ color: C.text3 }}>Showing {f.samples.length} of {f.count}. Export the findings CSV or open the log for the rest.</div>}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ── Product Test ────────────────────────────────────────────────────────────
function TestTab({ report, fmt, api, settings, onSettings }: { report: any; fmt: (t?: number | null, ms?: boolean) => string; api: string; settings: any; onSettings: (s: any) => void }) {
  const pt = report.productTest;
  const [status, setStatus] = useState<string>('problems');
  const [chan, setChan] = useState('all');
  const [runF, setRunF] = useState('all');
  const rows = pt.results.filter((r: any) =>
    (status === 'all' || (status === 'problems' ? ['fail', 'warn', 'unmapped'].includes(r.status) : r.status === status))
    && (chan === 'all' || r.ch === chan) && (runF === 'all' || r.run === runF));
  const pg = usePaged(rows, 100);
  const lats = pt.results.map((r: any) => r.latency).filter((x: any) => x != null);
  const chans = Object.keys(pt.roles);
  const unsol = pt.unsolicited.filter((u: any) => !u.explained);

  return (
    <div className="space-y-4">
      {pt.notes && pt.notes.length > 0 && (
        <div className="rounded-lg px-4 py-3 text-sm flex gap-2" style={tint('warning')}><AlertTriangle size={16} className="shrink-0 mt-0.5" /><div>{pt.notes.map((n: string, i: number) => <div key={i}>{n}</div>)}</div></div>
      )}
      {pt.coverage === 'partial' && (
        <div className="rounded-lg px-4 py-3 text-sm flex gap-2" style={tint('info')}><Info size={16} className="shrink-0 mt-0.5" />Part of the test happened outside the controller log window; those actions are marked “No data”.</div>
      )}

      {pt.runs && pt.runs.length > 1 && (
        <Card title="Runs" icon={<FlaskConical size={16} />} pad={false}>
          <table className="w-full"><thead><tr><Th>Run</Th><Th>Verdict</Th><Th>Pass</Th><Th>Warn</Th><Th>Fail</Th><Th>p50</Th><Th>p95</Th></tr></thead>
            <tbody>{pt.runs.map((r: any) => (
              <tr key={r.id} className="border-t cursor-pointer" style={{ borderColor: C.line }} onClick={() => setRunF(r.id)}>
                <Td>{r.name}</Td><Td><Pill tone={r.verdict === 'FAIL' ? 'error' : r.verdict === 'PASS' ? 'success' : 'warning'}>{r.verdict}</Pill></Td>
                <Td>{r.pass}</Td><Td>{r.warn}</Td><Td>{r.fail}</Td><Td>{fmtDur(r.latencyP50)}</Td><Td>{fmtDur(r.latencyP95)}</Td>
              </tr>))}</tbody></table>
        </Card>
      )}

      <Card title="Latency — Aether action → controller event" icon={<Timer size={16} />}
        right={<span className="text-xs" style={{ color: C.text3 }}>{lats.length} matched · warn {fmtDur(pt.thresholds.latencyWarnMs)} · fail {fmtDur(pt.thresholds.latencyFailMs)}</span>}>
        {lats.length ? <LatencyHist values={lats} warn={pt.thresholds.latencyWarnMs} fail={pt.thresholds.latencyFailMs} /> : <Empty icon={<Timer size={22} />} title="No matched actions yet" />}
      </Card>

      <RolesCard pt={pt} api={api} settings={settings} onSettings={onSettings} />

      <Card title="Actions" icon={<Play size={16} />} pad={false}
        right={<div className="flex flex-wrap gap-2">
          <select className={inputCls} style={inputSt} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status filter">
            <option value="problems">Problems only</option><option value="all">All</option>
            {Object.keys(STATUS).map(k => <option key={k} value={k}>{STATUS[k].label}</option>)}
          </select>
          <select className={inputCls} style={inputSt} value={chan} onChange={e => setChan(e.target.value)} aria-label="Channel filter">
            <option value="all">All channels</option>{chans.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {pt.runs && pt.runs.length > 1 && <select className={inputCls} style={inputSt} value={runF} onChange={e => setRunF(e.target.value)}><option value="all">All runs</option>{pt.runs.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
        </div>}>
        {!rows.length ? <Empty icon={<CheckCircle2 size={26} />} title={status === 'problems' ? 'No failures, warnings or unmapped channels' : 'No actions match'} /> : (
          <div className="overflow-auto max-h-[560px]">
            <table className="w-full">
              <thead><tr><Th>Time</Th><Th>Status</Th><Th>Aether did</Th><Th>Expected</Th><Th>Controller logged</Th><Th className="text-right">Latency</Th></tr></thead>
              <tbody>
                {pg.slice.map((r: any, i: number) => (
                  <tr key={i} className="border-t" style={{ borderColor: C.line }}>
                    <Td mono className="whitespace-nowrap">{fmt(r.t, true)}</Td>
                    <Td><StatusPill s={r.status} /></Td>
                    <Td><div className="font-mono text-xs" style={{ color: C.text }}>{r.ch} = {String(r.v)}</div>
                      <div className="text-xs" style={{ color: C.text3 }}>{ROLE_LABEL[r.role] || r.role}{r.auto ? ' (auto)' : ''}{r.m && (r.m.fc != null) ? ` · FC ${r.m.fc} CN ${r.m.cn}` : ''}</div></Td>
                    <Td>{r.expect || '—'}</Td>
                    <Td>{r.matched ? <><div style={{ color: C.text }}>{r.matched.type}</div><div className="text-xs font-mono" style={{ color: C.text3 }}>{fmt(r.matched.t, true).slice(11)} · {String(r.matched.file || '').split('/').pop()}:{r.matched.line}</div></> : <span style={{ color: C.text3 }}>—</span>}
                      {r.note && <div className="text-xs mt-0.5" style={{ color: r.status === 'fail' ? 'rgb(var(--hv-error-text))' : r.status === 'warn' ? 'rgb(var(--hv-warning-text))' : C.text3 }}>{r.note}</div>}</Td>
                    <Td className="text-right whitespace-nowrap">{r.latency != null ? fmtDur(r.latency) : '—'}{r.matched && r.matched.publishLag != null && <div className="text-xs" style={{ color: C.text3 }}>cloud +{fmtDur(r.matched.publishLag)}</div>}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager {...pg} />
          </div>
        )}
      </Card>

      <Card title="Controller events nobody triggered" icon={<AlertCircle size={16} />} pad={false}
        right={<span className="text-xs" style={{ color: C.text3 }}>{unsol.length} unexplained · {pt.unsolicited.length - unsol.length} follow-on</span>}>
        {!unsol.length ? <Empty icon={<CheckCircle2 size={24} />} title="Every controller event in the test window is explained by an Aether action" /> : (
          <div className="overflow-auto max-h-[360px]">
            <table className="w-full"><thead><tr><Th>Time</Th><Th>Severity</Th><Th>Event</Th><Th>Source</Th></tr></thead>
              <tbody>{unsol.map((u: any, i: number) => (
                <tr key={i} className="border-t" style={{ borderColor: C.line }}>
                  <Td mono>{fmt(u.t, true)}</Td><Td><SevPill s={u.sev} /></Td><Td>{u.type}</Td>
                  <Td mono>{(pt.doorNames && pt.doorNames[u.src]) || u.port || u.src} · {String(u.file || '').split('/').pop()}:{u.line}</Td>
                </tr>))}</tbody></table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RolesCard({ pt, api, settings, onSettings }: { pt: any; api: string; settings: any; onSettings: (s: any) => void }) {
  const [edit, setEdit] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const doors = pt.doorNames || {};
  const val = (ch: string, k: string) => (edit[ch] && edit[ch][k] !== undefined) ? edit[ch][k] : (pt.roles[ch] || {})[k];
  const set = (ch: string, k: string, v: any) => { setSaved(false); setEdit(e => ({ ...e, [ch]: { ...(e[ch] || {}), [k]: v } })); };
  const save = async () => {
    setSaving(true);
    const wiring = { ...((settings && settings.wiring) || {}) };
    for (const ch of Object.keys(pt.roles)) {
      const role = val(ch, 'role');
      if (!role || role === 'unmapped') continue;
      wiring[ch] = { role, ...(val(ch, 'door') ? { door: val(ch, 'door') } : {}), ...(role === 'dps' ? { active: val(ch, 'active') || 'open' } : {}), ...(val(ch, 'ioId') ? { ioId: val(ch, 'ioId') } : {}) };
    }
    try {
      const r = await fetch(`${api}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wiring }) });
      const j = await r.json(); if (j.success) { onSettings({ ...(settings || {}), wiring: j.wiring, thresholds: j.thresholds }); setSaved(true); setEdit({}); }
    } finally { setSaving(false); }
  };
  return (
    <Card title="Channel roles" icon={<Settings2 size={16} />} pad={false}
      right={<Btn onClick={save} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <CheckCircle2 size={14} /> : <Save size={14} />}{saved ? 'Saved — rescan to apply' : 'Save as wiring map'}</Btn>}>
      <div className="px-4 pt-3 text-xs" style={{ color: C.text3 }}>Roles marked “auto” were inferred from which controller events followed each channel. Fix any that are wrong, save, and rescan.</div>
      <div className="overflow-auto">
        <table className="w-full mt-2">
          <thead><tr><Th>Channel</Th><Th>Kind</Th><Th>Actions</Th><Th>Role</Th><Th>Options</Th><Th>Match</Th></tr></thead>
          <tbody>
            {Object.entries(pt.roles).map(([ch, r]: [string, any]) => (
              <tr key={ch} className="border-t" style={{ borderColor: C.line }}>
                <Td mono>{ch}</Td><Td>{r.kind}</Td><Td>{r.count}</Td>
                <Td>
                  <select className={inputCls} style={inputSt} value={val(ch, 'role')} onChange={e => set(ch, 'role', e.target.value)} aria-label={`Role for ${ch}`}>
                    {r.role === 'unmapped' && <option value="unmapped">Unmapped</option>}
                    {ROLES.map(x => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
                  </select>
                  {r.auto && !edit[ch] && <span className="ml-2 text-xs" style={{ color: C.text3 }}>auto</span>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    {val(ch, 'role') === 'dps' && (
                      <select className={inputCls} style={inputSt} value={val(ch, 'active') || 'open'} onChange={e => set(ch, 'active', e.target.value)} aria-label="Active means">
                        <option value="open">Active = door open</option><option value="closed">Active = door closed</option>
                      </select>
                    )}
                    {Object.keys(doors).length > 0 && ['dps', 'rex', 'card', 'keypad', 'lock'].includes(val(ch, 'role')) && (
                      <select className={inputCls} style={inputSt} value={val(ch, 'door') || ''} onChange={e => set(ch, 'door', e.target.value)} aria-label="Door">
                        <option value="">Any door</option>{Object.entries(doors).map(([id, n]: any) => <option key={id} value={id}>{n || id.slice(0, 8)}</option>)}
                      </select>
                    )}
                    {['input', 'output'].includes(val(ch, 'role')) && (
                      <input className={inputCls} style={inputSt} placeholder="Controller I/O, e.g. input1-1-4" value={val(ch, 'ioId') || ''} onChange={e => set(ch, 'ioId', e.target.value)} />
                    )}
                  </div>
                </Td>
                <Td>{r.score != null ? `${Math.round(r.score * 100)}%` : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────
function TimelineTab({ report, fmt }: { report: any; fmt: (t?: number | null, ms?: boolean) => string }) {
  const [type, setType] = useState('all');
  const types = useMemo(() => [...new Set<string>(report.events.map((e: any) => e.type))].sort(), [report.id]);
  const rows = useMemo(() => report.events.filter((e: any) => type === 'all' || e.type === type).slice().reverse(), [report.id, type]);
  const pg = usePaged(rows, 150);
  const doors = report.doors || {};
  const ALERT = /forced|toolong|denied/;
  return (
    <div className="space-y-4">
      <Card title="Controller events per hour" icon={<Timer size={16} />} right={<span className="text-xs" style={{ color: C.text3 }}>{report.events.length} events published to the cloud</span>}>
        {(report.summary.hourly || []).length ? <HourlyBars data={report.summary.hourly} fmt={t => fmt(t)} /> : <Empty icon={<Timer size={22} />} title="No RealTime events in this bundle" />}
      </Card>
      <Card title="Event log" icon={<DoorOpen size={16} />} pad={false}
        right={<select className={inputCls} style={inputSt} value={type} onChange={e => setType(e.target.value)} aria-label="Event type"><option value="all">All types</option>{types.map(t => <option key={t} value={t}>{t}</option>)}</select>}>
        <div className="overflow-auto max-h-[600px]">
          <table className="w-full">
            <thead><tr><Th>Event time</Th><Th>Event</Th><Th>Door / port</Th><Th className="text-right">To cloud</Th><Th>Source</Th></tr></thead>
            <tbody>{pg.slice.map((e: any, i: number) => (
              <tr key={i} className="border-t" style={{ borderColor: C.line }}>
                <Td mono className="whitespace-nowrap">{fmt(e.t, true)}</Td>
                <Td>{ALERT.test(e.type) ? <Pill tone={/forced|denied/.test(e.type) ? 'error' : 'warning'} icon={<AlertTriangle size={12} />}>{e.type}</Pill> : <span style={{ color: C.text }}>{e.type}</span>}</Td>
                <Td>{(doors[e.src] && doors[e.src].name) || (e.src || '').slice(0, 8)} <span className="text-xs font-mono" style={{ color: C.text3 }}>{e.port}</span></Td>
                <Td className="text-right whitespace-nowrap">{fmtDur(e.lag)}</Td>
                <Td mono>{String(e.file).split('/').pop()}:{e.line}</Td>
              </tr>))}</tbody>
          </table>
          <Pager {...pg} />
        </div>
      </Card>
    </div>
  );
}

// ── Panel SDK ───────────────────────────────────────────────────────────────
function PanelTab({ report, fmt, api }: { report: any; fmt: (t?: number | null, ms?: boolean) => string; api: string }) {
  const [dir, setDir] = useState('all');
  const [code, setCode] = useState('all');
  const [hideAcks, setHideAcks] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const frames = report.frames || [];
  const codes = useMemo(() => {
    const m = new Map<string, { name: string; n: number; conf: string }>();
    for (const f of frames) { const k = f.code; const x = m.get(k) || { name: f.name, n: 0, conf: f.conf }; x.n++; m.set(k, x); }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [report.id]);
  const rows = useMemo(() => frames.filter((f: any) => (dir === 'all' || f.dir === dir) && (code === 'all' || f.code === code)
    && (!hideAcks || !(f.code === '0800' || f.code === '0705'))).slice().reverse(), [report.id, dir, code, hideAcks]);
  const pg = usePaged(rows, 150);
  const sdk = report.summary.sdk;
  const confTone = (c: string) => c === 'high' ? 'success' : c === 'medium' ? 'info' : c === 'low' ? 'warning' : null;
  if (!frames.length && (report.panelEvents || []).length) return <NhpFeed report={report} fmt={fmt} />;
  if (!frames.length) return <Card><Empty icon={<Cpu size={26} />} title="No controller link trace in this bundle">Azure controllers write aspsdk_*.log when SDK trace logging is on; NHP controllers log their event feed in the CloudConnector log.</Empty></Card>;
  return (
    <div className="space-y-4">
      <Card title="Cloud Connector ⇄ controller firmware (ASP SDK)" icon={<Cpu size={16} />}
        right={<a href={`${api}/reports/${report.id}/frames.csv`}><Btn><Download size={14} />Frames CSV</Btn></a>}>
        <div className="flex flex-wrap gap-2">
          <Stat label="Frames" value={sdk.frames} sub={`${sdk.commands} commands · ${sdk.events} event frames`} />
          <Stat label="Reply p50 / p95" value={fmtDur(sdk.replyP50)} sub={`p95 ${fmtDur(sdk.replyP95)} · max ${fmtDur(sdk.replyMax)}`} />
          {report.summary.sdkAck && <Stat label="Event ack" value={fmtDur(report.summary.sdkAck.p50)} sub={`p95 ${fmtDur(report.summary.sdkAck.p95)}`} />}
          {report.summary.sdkSerial && <Stat label="Event records" value={report.summary.sdkSerial.records} sub={`${report.summary.sdkSerial.skipped} serials skipped · ${report.summary.sdkSerial.replayed || 0} replayed`} />}
          {report.summary.panelToCloud && <Stat label="Panel → cloud" value={fmtDur(report.summary.panelToCloud.p50)} sub={`p95 ${fmtDur(report.summary.panelToCloud.p95)}`} />}
          <Stat label="Controller IP" value={<span className="text-base">{(sdk.peers || []).slice(-1)[0] || '—'}</span>} sub={(sdk.peers || []).length > 1 ? `was ${sdk.peers.slice(0, -1).join(', ')}` : undefined} />
        </div>
        <p className="text-xs mt-3" style={{ color: C.text3 }}>
          Decoded without a wire spec: names are inferred from traffic and cross-checked against CloudConnector activity at the same instant. The confidence tag on each code says how sure the decoder is; unknown codes show raw hex.
        </p>
      </Card>
      <Card title="Command / event codes" icon={<Settings2 size={16} />} pad={false}>
        <div className="overflow-auto max-h-[300px]"><table className="w-full"><thead><tr><Th>Code</Th><Th>Meaning</Th><Th>Confidence</Th><Th className="text-right">Frames</Th></tr></thead>
          <tbody>{codes.map(([k, x]) => (
            <tr key={k} className="border-t cursor-pointer" style={{ borderColor: C.line }} onClick={() => { setCode(k); setHideAcks(false); }}>
              <Td mono>{k.slice(0, 2)}/{k.slice(2)}</Td><Td>{x.name}</Td><Td><Pill tone={confTone(x.conf)}>{x.conf}</Pill></Td><Td className="text-right">{x.n}</Td>
            </tr>))}</tbody></table></div>
      </Card>
      <Card title="Frames" icon={<Radio size={16} />} pad={false}
        right={<div className="flex flex-wrap gap-2 items-center">
          <Seg value={dir as any} onChange={setDir as any} items={[{ id: 'all', label: 'All' }, { id: 'S', label: 'Commands' }, { id: 'R', label: 'Replies' }, { id: 'E', label: 'Events' }]} />
          {code !== 'all' && <Btn kind="ghost" onClick={() => setCode('all')}><X size={13} />{code}</Btn>}
          <label className="text-xs inline-flex items-center gap-1.5" style={{ color: C.text2 }}><input type="checkbox" checked={hideAcks} onChange={e => setHideAcks(e.target.checked)} />Hide acks</label>
        </div>}>
        <div className="overflow-auto max-h-[600px]">
          <table className="w-full">
            <thead><tr><Th>Time</Th><Th>Dir</Th><Th>Code</Th><Th>Decoded</Th><Th>Seq / serial</Th></tr></thead>
            <tbody>{pg.slice.map((f: any, i: number) => {
              const k = pg.page * 150 + i;
              return (
                <React.Fragment key={k}>
                  <tr className="border-t cursor-pointer" style={{ borderColor: C.line }} onClick={() => setOpen(open === k ? null : k)}>
                    <Td mono className="whitespace-nowrap">{fmt(f.t, true)}</Td>
                    <Td><Pill tone={f.dir === 'E' ? 'info' : null}>{f.dir === 'S' ? 'Cmd' : f.dir === 'R' ? 'Reply' : 'Event'}</Pill></Td>
                    <Td mono>{f.code.slice(0, 2)}/{f.code.slice(2)}</Td>
                    <Td><span style={{ color: C.text }}>{f.dir === 'E' ? f.evName : f.name}</span>{f.point && <span className="ml-1.5 text-xs font-mono" style={{ color: C.text3 }}>@ {f.point}</span>}
                      {f.hostname && <span className="ml-1.5 text-xs" style={{ color: C.text3 }}>host “{f.hostname}”</span>}
                      {!f.lenOk && <span className="ml-1.5"><Pill tone="error">length mismatch</Pill></span>}</Td>
                    <Td mono>{f.dir === 'E' ? `#${f.serial}${f.lastSerial !== f.serial ? `–${f.lastSerial}` : ''}` : f.ackSerial != null ? `ack #${f.ackSerial}` : f.seq}</Td>
                  </tr>
                  {open === k && (
                    <tr style={{ background: C.panel2 }}><td colSpan={5} className="px-4 py-3">
                      {f.events && f.events.length > 0 && (
                        <table className="w-full mb-2"><thead><tr><Th>Serial</Th><Th>Controller time</Th><Th>Event</Th><Th>Point</Th><Th>Data</Th></tr></thead>
                          <tbody>{f.events.map((e: any, j: number) => (
                            <tr key={j}><Td mono>{e.serial}</Td><Td mono>{fmt(e.ctrlTime)}</Td><Td>{e.name} <Pill tone={confTone(e.conf)}>{e.conf}</Pill></Td><Td mono>{e.point}</Td><Td mono className="break-all">{e.data}</Td></tr>
                          ))}</tbody></table>
                      )}
                      <div className="font-mono text-xs break-all" style={{ color: C.text2 }}>{f.hex}</div>
                      <div className="text-xs mt-1" style={{ color: C.text3 }}>{f.peer} · {String(f.file).split('/').pop()}:{f.line} · {f.len} bytes</div>
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}</tbody>
          </table>
          <Pager {...pg} />
        </div>
      </Card>
    </div>
  );
}

// ── NHP controller event feed ───────────────────────────────────────────────
function NhpFeed({ report, fmt }: { report: any; fmt: (t?: number | null, ms?: boolean) => string }) {
  const [name, setName] = useState('all');
  const pe = report.panelEvents || [];
  const mix = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of pe) m[e.name] = (m[e.name] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [report.id]);
  const rows = useMemo(() => pe.filter((e: any) => name === 'all' || e.name === name).slice().reverse(), [report.id, name]);
  const pg = usePaged(rows, 150);
  const f = report.summary.nhpFeed || {};
  const p2c = report.summary.panelToCloud;
  const ALERT = /Forced|Offline|Tamper|Denied|Held/;
  return (
    <div className="space-y-4">
      <Card title="Controller event feed (NHP Monitor Diff)" icon={<Cpu size={16} />}>
        <div className="flex flex-wrap gap-2">
          <Stat label="Controller events" value={f.events ?? pe.length} sub={`${mix.length} event types`} />
          <Stat label="Controller → connector" value={fmtDur(f.recvP50)} sub={`p95 ${fmtDur(f.recvP95)} · max ${fmtDur(f.recvMax)}`} />
          {p2c && <Stat label="Controller → cloud" value={fmtDur(p2c.p50)} sub={`p95 ${fmtDur(p2c.p95)} · ${p2c.n} published`} />}
        </div>
        <p className="text-xs mt-3" style={{ color: C.text3 }}>
          The NHP pushes its events to the Cloud Connector with its own UTC timestamps; each one that maps to a cloud event type is checked for a matching RealTime MQTT publish.
        </p>
      </Card>
      <Card title="Event types" icon={<Settings2 size={16} />} pad={false}>
        <div className="overflow-auto max-h-[300px]"><table className="w-full"><thead><tr><Th>Event</Th><Th className="text-right">Count</Th></tr></thead>
          <tbody>{mix.map(([k, n]) => (
            <tr key={k} className="border-t cursor-pointer" style={{ borderColor: C.line }} onClick={() => setName(k)}><Td>{k}</Td><Td className="text-right">{n}</Td></tr>
          ))}</tbody></table></div>
      </Card>
      <Card title="Events" icon={<Radio size={16} />} pad={false}
        right={<select className={inputCls} style={inputSt} value={name} onChange={e => setName(e.target.value)} aria-label="Event type"><option value="all">All events</option>{mix.map(([k]) => <option key={k} value={k}>{k}</option>)}</select>}>
        <div className="overflow-auto max-h-[600px]">
          <table className="w-full">
            <thead><tr><Th>Controller time</Th><Th>Event</Th><Th>Source</Th><Th>Data</Th><Th className="text-right">Received after</Th><Th>Log</Th></tr></thead>
            <tbody>{pg.slice.map((e: any, i: number) => {
              const txt = JSON.stringify(e.data);
              return (
                <tr key={i} className="border-t" style={{ borderColor: C.line }}>
                  <Td mono className="whitespace-nowrap">{fmt(e.t, true)}</Td>
                  <Td>{ALERT.test(e.name + txt) ? <Pill tone={/Forced|Tamper|Denied/.test(e.name + txt) ? 'error' : 'warning'} icon={<AlertTriangle size={12} />}>{e.name}</Pill> : <span style={{ color: C.text }}>{e.name}</span>}</Td>
                  <Td>{e.src || '—'}</Td>
                  <Td mono className="break-all">{txt}</Td>
                  <Td className="text-right whitespace-nowrap">{e.logT - e.t > 600000 ? 'state snapshot' : fmtDur(e.logT - e.t)}</Td>
                  <Td mono>{String(e.file).split('/').pop()}:{e.line}</Td>
                </tr>);
            })}</tbody>
          </table>
          <Pager {...pg} />
        </div>
      </Card>
    </div>
  );
}

// ── Files & coverage ────────────────────────────────────────────────────────
function FilesTab({ report, fmt }: { report: any; fmt: (t?: number | null, ms?: boolean) => string }) {
  const cov = report.coverage || {};
  const names: Record<string, string> = { cloudconnector: 'CloudConnector log', health: 'HealthMonitor', sync: 'SyncTiming', audit: 'Audit log', aspsdk: 'ASP SDK trace', other: 'Other logs', archived: 'Archived snapshots' };
  return (
    <div className="space-y-4">
      <Card title="Coverage" icon={<Clock size={16} />} pad={false}>
        <table className="w-full"><thead><tr><Th>Source</Th><Th>From</Th><Th>To</Th><Th>Span</Th><Th className="text-right">Records</Th></tr></thead>
          <tbody>{Object.entries(names).map(([k, n]) => {
            const c = cov[k];
            return (
              <tr key={k} className="border-t" style={{ borderColor: C.line }}>
                <Td>{n}</Td><Td mono>{c ? fmt(c.from) : '—'}</Td><Td mono>{c ? fmt(c.to) : '—'}</Td><Td>{c ? fmtDur(c.to - c.from) : <span style={{ color: C.text3 }}>not in bundle</span>}</Td><Td className="text-right">{c ? c.n : 0}</Td>
              </tr>);
          })}</tbody></table>
        <p className="text-xs px-4 py-3" style={{ color: C.text3 }}>The CloudConnector log rotates (10 files). For Product Test, export the controller logs soon after the run so the test window is still inside this range.</p>
      </Card>
      {(report.archives || []).length > 0 && (
        <Card title="Archived log snapshots" icon={<FileArchive size={16} />} pad={false}>
          <table className="w-full"><thead><tr><Th>Snapshot</Th><Th>From</Th><Th>To</Th><Th className="text-right">Files</Th><Th className="text-right">Lines</Th></tr></thead>
            <tbody>{report.archives.map((a: any) => (
              <tr key={a.name} className="border-t" style={{ borderColor: C.line }}>
                <Td mono>{a.name}</Td><Td mono>{fmt(a.from)}</Td><Td mono>{fmt(a.to)}</Td><Td className="text-right">{a.files}</Td><Td className="text-right">{a.records}</Td>
              </tr>))}</tbody></table>
          <p className="text-xs px-4 py-3" style={{ color: C.text3 }}>Scanned for errors and leaked secrets (findings tagged “archived logs”); kept out of the live timeline.</p>
        </Card>
      )}
      <Card title="Files in the bundle" icon={<FileArchive size={16} />} pad={false}>
        <div className="overflow-auto max-h-[500px]"><table className="w-full"><thead><tr><Th>Path</Th><Th>Type</Th><Th className="text-right">Size</Th><Th className="text-right">Records</Th></tr></thead>
          <tbody>{report.files.map((f: any) => (
            <tr key={f.rel} className="border-t" style={{ borderColor: C.line }}>
              <Td mono className="break-all">{f.rel}</Td><Td>{f.type}{f.skipped && <span className="ml-1"><Pill tone="warning">too large, skipped</Pill></span>}</Td>
              <Td className="text-right whitespace-nowrap">{fmtSize(f.size)}</Td><Td className="text-right">{f.records || '—'}</Td>
            </tr>))}</tbody></table></div>
      </Card>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────
function SettingsTab({ api, settings, onSettings, report }: { api: string; settings: any; onSettings: (s: any) => void; report: any }) {
  const [t, setT] = useState<any>(() => ({ ...((settings && settings.thresholds) || {}) }));
  const [saved, setSaved] = useState(false);
  useEffect(() => { setT({ ...((settings && settings.thresholds) || {}) }); }, [settings]);
  const FIELDS: [string, string, string][] = [
    ['latencyWarnMs', 'Product Test — warn above', 'Aether action → controller event'],
    ['latencyFailMs', 'Product Test — fail above', 'Also fails when the event never appears'],
    ['earlyToleranceMs', 'Early tolerance', 'Controller event may be stamped slightly before the journal (clock resolution)'],
    ['publishWarnMs', 'Event → cloud publish warn', 'Controller event time → MQTT RealTime send'],
    ['sdkReplyTimeoutMs', 'SDK reply timeout', 'Command without a reply after this is flagged'],
    ['logGapMs', 'Log silence', 'No CloudConnector lines at all for this long'],
  ];
  const save = async () => {
    const r = await fetch(`${api}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thresholds: t }) });
    const j = await r.json(); if (j.success) { onSettings({ ...(settings || {}), thresholds: j.thresholds, wiring: j.wiring }); setSaved(true); setTimeout(() => setSaved(false), 2500); }
  };
  const wiring = (settings && settings.wiring) || {};
  const removeWire = async (ch: string) => {
    const w = { ...wiring }; delete w[ch];
    const r = await fetch(`${api}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wiring: w }) });
    const j = await r.json(); if (j.success) onSettings({ ...(settings || {}), wiring: j.wiring, thresholds: j.thresholds });
  };
  if (!settings) return <Card><Empty icon={<Settings2 size={24} />} title="Settings unavailable" /></Card>;
  return (
    <div className="space-y-4">
      <Card title="Thresholds" icon={<Timer size={16} />} right={<Btn kind="primary" onClick={save}>{saved ? <CheckCircle2 size={14} /> : <Save size={14} />}{saved ? 'Saved' : 'Save'}</Btn>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map(([k, label, hint]) => (
            <label key={k} className="block">
              <div className="text-sm font-semibold" style={{ color: C.text }}>{label}</div>
              <div className="flex items-center gap-2 mt-1">
                <input type="number" min={0} step={k === 'logGapMs' ? 60000 : 50} className={`${inputCls} w-36`} style={inputSt} value={t[k] ?? ''} onChange={e => setT({ ...t, [k]: Number(e.target.value) })} />
                <span className="text-xs" style={{ color: C.text3 }}>ms · {fmtDur(t[k])}{settings.defaults && settings.defaults[k] !== t[k] ? ` (default ${fmtDur(settings.defaults[k])})` : ''}</span>
              </div>
              <div className="text-xs mt-1" style={{ color: C.text3 }}>{hint}</div>
            </label>
          ))}
        </div>
        <p className="text-xs mt-3" style={{ color: C.text3 }}>Applies to new scans. This report used: fail {fmtDur(report.opts && report.opts.latencyFailMs)}, warn {fmtDur(report.opts && report.opts.latencyWarnMs)}. Time conversion uses the controller's timezone.json ({report.zone.tz}).</p>
      </Card>
      <Card title="Raw log lines" icon={<Eye size={16} />}>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-1" checked={settings.allowRaw !== false} onChange={async e => {
            const r = await fetch(`${api}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowRaw: e.target.checked }) });
            const j = await r.json(); if (j.success) onSettings({ ...(settings || {}), allowRaw: j.allowRaw, thresholds: j.thresholds, wiring: j.wiring });
          }} />
          <span>
            <span className="text-sm font-semibold" style={{ color: C.text }}>Allow “Show raw” on finding samples</span>
            <span className="block text-xs mt-0.5" style={{ color: C.text3 }}>Shows the original log line behind each sample, with 3 lines of context — unredacted. Reports and CSV exports always keep the redacted text; the raw lines stay in a separate owner-only file on the Pi, are sent only when someone clicks, and every reveal is logged by the backend.</span>
          </span>
        </label>
      </Card>
      <Card title="Wiring map" icon={<Settings2 size={16} />} pad={false}>
        {!Object.keys(wiring).length ? <Empty icon={<Settings2 size={22} />} title="No saved wiring">Roles are inferred automatically. Save them from a Product Test report's “Channel roles” card to pin them.</Empty> : (
          <table className="w-full"><thead><tr><Th>Channel</Th><Th>Role</Th><Th>Options</Th><Th /></tr></thead>
            <tbody>{Object.entries(wiring).map(([ch, w]: [string, any]) => (
              <tr key={ch} className="border-t" style={{ borderColor: C.line }}>
                <Td mono>{ch}</Td><Td>{ROLE_LABEL[w.role] || w.role}</Td>
                <Td>{[w.active && `active = ${w.active}`, w.door && `door ${(report.doors && report.doors[w.door] && report.doors[w.door].name) || w.door.slice(0, 8)}`, w.ioId].filter(Boolean).join(' · ') || '—'}</Td>
                <Td className="text-right"><Btn kind="ghost" onClick={() => removeWire(ch)} aria-label={`Remove ${ch}`}><Trash2 size={14} /></Btn></Td>
              </tr>))}</tbody></table>
        )}
      </Card>
    </div>
  );
}
