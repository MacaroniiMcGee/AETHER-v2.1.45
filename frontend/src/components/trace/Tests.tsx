// AETHER_TRACE (TRACE-4) — Event Trace › Tests: scripted test sequences on the Doors page doors, run unattended
// (once, N times, or for M minutes), graded step by step; plus the run-vs-run comparison.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Play, Square, ArrowUp, ArrowDown, X, Save, FlaskConical, Download, GitCompare, Loader2, AlertTriangle, CheckCircle2, XCircle, ListChecks } from 'lucide-react';
import { Badge, Button, Empty, Input, Select, Toggle, cx } from '../sunapi/ui';
import { fmtMs, clock, type TraceApi, type Status, type Sequence, type Step, type StepKind, type TemplateInfo, type TestReport, type TestRunMeta, type DoorRow, type Comparison, type Moved, type StepResult } from './api';
import { DoorCheckBox } from './Ready';   // TRACE-9

const KIND_WORD: Record<StepKind, string> = { card: 'Present card', rex: 'Press REX', dps: 'Door contact', command: 'OnCAFE command', wait: 'Wait' };
const blank = (): Sequence => ({ name: 'New test', note: '', steps: [], repeat: 1, minutes: 0, gapMs: 2000, sync: true });
const toneOf = (s: string) => (s === 'pass' ? 'success' : s === 'warn' ? 'warning' : s === 'fail' || s === 'error' ? 'error' : 'neutral') as 'success' | 'warning' | 'error' | 'neutral';
const secs = (ms?: number) => (ms == null ? '' : String(Math.round(ms / 100) / 10));
const fromSecs = (v: string) => Math.round(Number(v) * 1000);

// ── run-vs-run comparison (used here and on the Runs tab) ───────────────────
const MOVE: Record<Moved, { t: string; tone: 'success' | 'error' | 'neutral' }> = { same: { t: '', tone: 'neutral' }, worse: { t: 'worse', tone: 'error' }, better: { t: 'better', tone: 'success' }, 'only-one': { t: 'one run only', tone: 'neutral' } };
const MoveTag: React.FC<{ m: Moved }> = ({ m }) => (m === 'same' ? <span className="text-hv-text-3">same</span> : <Badge tone={MOVE[m].tone}>{m === 'worse' ? '▲ ' : m === 'better' ? '▼ ' : ''}{MOVE[m].t}</Badge>);
export const CompareView: React.FC<{ api: TraceApi; a: string; b: string; onClose?: () => void }> = ({ api, a, b, onClose }) => {
  const [c, setC] = useState<Comparison | null>(null);
  const [errMsg, setErr] = useState<string | null>(null);
  useEffect(() => { setC(null); setErr(null); api.compare(a, b).then(setC).catch(e => setErr(e.message)); }, [api, a, b]);
  if (errMsg) return <div className="p-3 text-xs text-hv-error-fg">{errMsg}</div>;
  if (!c) return <div className="p-4 text-sm text-hv-text-3 flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Comparing…</div>;
  const hops = c.hops.filter(h => h.kind !== 'all' || true);
  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex items-center gap-2">
        <GitCompare size={14} className="text-hv-text-3" />
        <span className="text-sm text-hv-text"><b>A</b> {c.a.name} <span className="text-hv-text-3">({new Date(c.a.start).toLocaleString()})</span> → <b>B</b> {c.b.name} <span className="text-hv-text-3">({new Date(c.b.start).toLocaleString()})</span></span>
        <span className="ml-auto" />
        {onClose && <Button size="sm" tone="ghost" onClick={onClose}>Close</Button>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge tone={c.summary.worse ? 'error' : 'neutral'}>{c.summary.worse} worse</Badge>
        <Badge tone={c.summary.better ? 'success' : 'neutral'}>{c.summary.better} better</Badge>
        <Badge tone={c.summary.newFail ? 'error' : 'neutral'}>{c.summary.newFail} new failures</Badge>
        <Badge tone={c.summary.fixed ? 'success' : 'neutral'}>{c.summary.fixed} fixed</Badge>
        {(c.summary.onlyA + c.summary.onlyB) > 0 && <Badge tone="warning">{c.summary.onlyA + c.summary.onlyB} event names in one run only</Badge>}
        <span className="text-hv-text-3">{c.rule}</span>
      </div>
      {c.steps && (
        <Section title="Test steps (same sequence)">
          <table className="w-full"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2">Step</th><th className="pr-2">A passed</th><th className="pr-2">B passed</th><th className="pr-2">Result</th><th className="pr-2">Decision p50 A → B</th><th className="pr-2">Cloud push p50 A → B</th></tr></thead><tbody>
            {c.steps.map(s => (
              <tr key={s.idx} className="border-t border-hv-line">
                <td className="py-1 pr-2 text-hv-text">{s.idx + 1}. {s.text}</td>
                <td className="pr-2">{s.a ? `${s.a.pass}/${s.a.runs}` : '—'}</td><td className="pr-2">{s.b ? `${s.b.pass}/${s.b.runs}` : '—'}</td>
                <td className="pr-2"><MoveTag m={s.result} /></td>
                <td className="pr-2 font-mono">{fmtMs(s.a?.decision)} → {fmtMs(s.b?.decision)} <MoveTag m={s.decision} /></td>
                <td className="pr-2 font-mono">{fmtMs(s.a?.push)} → {fmtMs(s.b?.push)} <MoveTag m={s.push} /></td>
              </tr>))}
          </tbody></table>
        </Section>
      )}
      <Section title="Latency per hop (p50 / p95)">
        <table className="w-full"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2">What</th><th className="pr-2">Hop</th><th className="pr-2">A p50 / p95</th><th className="pr-2">B p50 / p95</th><th className="pr-2">p50</th><th className="pr-2">p95</th></tr></thead><tbody>
          {hops.map((h, i) => (
            <tr key={i} className="border-t border-hv-line">
              <td className="py-1 pr-2 text-hv-text-2">{h.kind === 'all' ? 'Everything' : h.kind}</td><td className="pr-2 text-hv-text">{h.label}</td>
              <td className="pr-2 font-mono">{fmtMs(h.a.p50)} / {fmtMs(h.a.p95)} <span className="text-hv-text-3">n{h.a.n}</span></td>
              <td className="pr-2 font-mono">{fmtMs(h.b.p50)} / {fmtMs(h.b.p95)} <span className="text-hv-text-3">n{h.b.n}</span></td>
              <td className="pr-2"><MoveTag m={h.p50} /></td><td className="pr-2"><MoveTag m={h.p95} /></td>
            </tr>))}
        </tbody></table>
      </Section>
      <div className="grid grid-cols-2 gap-3">
        <Section title={`New failures in B (${c.newFail.length})`}>{c.newFail.length ? c.newFail.map((f, i) => <div key={i} className="py-0.5"><Badge tone="error">{f.kind}</Badge> <span className="text-hv-text">{f.label}</span> <span className="text-hv-text-3">— {f.why}</span></div>) : <span className="text-hv-text-3">None</span>}</Section>
        <Section title={`Fixed in B (${c.fixed.length})`}>{c.fixed.length ? c.fixed.map((f, i) => <div key={i} className="py-0.5"><Badge tone="success">{f.kind}</Badge> <span className="text-hv-text">{f.label}</span> <span className="text-hv-text-3">— was: {f.why}</span></div>) : <span className="text-hv-text-3">None</span>}</Section>
        <Section title="Event names only one run saw">
          {!c.types.onlyA.length && !c.types.onlyB.length ? <span className="text-hv-text-3">Both runs saw the same event names</span> : <>
            {c.types.onlyA.map(t => <div key={'a' + t.type}><Badge>A only</Badge> <span className="font-mono">{t.type}</span> ×{t.n}</div>)}
            {c.types.onlyB.map(t => <div key={'b' + t.type}><Badge tone="info">B only</Badge> <span className="font-mono">{t.type}</span> ×{t.n}</div>)}</>}
        </Section>
        <Section title="Clock and integrity">
          <div>Controller clock offset: A {fmtMs(c.clock.a.offset)} · B {fmtMs(c.clock.b.offset)}{c.clock.b.drift != null ? ` · B drift ${fmtMs(c.clock.b.drift)}/h` : ''}</div>
          {c.integrity && Object.entries(c.integrity).map(([k, v]) => <div key={k}>{INTEG_LABEL[k] || k}: A {v.a} · B {v.b}{v.b > v.a ? <Badge tone="error" className="ml-1">more</Badge> : null}</div>)}
        </Section>
      </div>
    </div>
  );
};
const INTEG_LABEL: Record<string, string> = { lostInPush: 'Never pushed', notInLog: 'Not in the event log', onlyInLog: 'Only in the controller log', duplicates: 'Pushed twice', outOfOrder: 'Out of order' };
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-2"><div className="text-[11px] font-semibold text-hv-text-2 mb-1">{title}</div>{children}</div>
);

// ── latency over time (load runs) ───────────────────────────────────────────
// Two series, one axis (both are milliseconds from the step). Slots 1–2 of the validated categorical palette
// (blue / orange, checked for both themes on the Aether surfaces); failed steps are a separate ✕ mark with a label.
const VIZ_CSS = `.trace-viz{--s1:#3987e5;--s2:#d95926;--bad:rgb(var(--hv-error))}:root[data-theme="light"] .trace-viz{--s1:#2a78d6;--s2:#eb6834}`;
export const LatencyChart: React.FC<{ series: TestReport['report']['series'] }> = ({ series }) => {
  const [hover, setHover] = useState<number | null>(null);
  const W = 900, H = 190, L = 52, R = 70, T = 14, B = 26;
  const pts = useMemo(() => [...series].sort((a, b) => a.at - b.at), [series]);
  if (pts.length < 2) return <div className="text-xs text-hv-text-3 p-2">The chart needs at least two graded steps with a latency.</div>;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at || t0 + 1;
  const vals = pts.flatMap(p => [p.decision, p.push]).filter((v): v is number => v != null);
  const vmax = Math.max(1, ...vals), vmin = Math.min(0, ...vals);   // an uncorrected clock can make a hop slightly negative
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 30000, 60000].find(s => (vmax - vmin) / s <= 4) || 60000;
  const top = Math.ceil(vmax / step) * step, bottom = Math.floor(vmin / step) * step;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - bottom) / (top - bottom)) * (H - T - B);
  const line = (k: 'decision' | 'push') => pts.filter(p => p[k] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p[k] as number).toFixed(1)}`).join('');
  const lastOf = (k: 'decision' | 'push') => [...pts].reverse().find(p => p[k] != null);
  const ticks = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, i) => bottom + i * step);
  const h = hover != null ? pts[hover] : null;
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * (W - L - R) + L;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(x(p.at) - px); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };
  const ld = lastOf('decision'), lp = lastOf('push');
  return (
    <div className="trace-viz relative">
      <style>{VIZ_CSS}</style>
      <div className="flex items-center gap-4 text-[11px] text-hv-text-2 mb-1">
        <span className="font-semibold text-hv-text">Latency over the run</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded" style={{ background: 'var(--s1)' }} />Aether → controller decision</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded" style={{ background: 'var(--s2)' }} />Aether → cloud push</span>
        <span className="flex items-center gap-1.5"><span style={{ color: 'var(--bad)' }}>✕</span>Failed step</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Decision and cloud push latency per step over the run">
        {ticks.map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgb(var(--hv-line))" strokeWidth={1} /><text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="rgb(var(--hv-text-3))">{fmtMs(v)}</text></g>)}
        <text x={L} y={H - 6} fontSize={10} fill="rgb(var(--hv-text-3))">{clock(t0).slice(0, 8)}</text>
        <text x={W - R} y={H - 6} fontSize={10} textAnchor="end" fill="rgb(var(--hv-text-3))">{clock(t1).slice(0, 8)}</text>
        <path d={line('decision')} fill="none" stroke="var(--s1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={line('push')} fill="none" stroke="var(--s2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {ld && <text x={x(ld.at) + 6} y={y(ld.decision as number) + 3} fontSize={10} fill="rgb(var(--hv-text-2))">decision</text>}
        {lp && <text x={x(lp.at) + 6} y={y(lp.push as number) + 3} fontSize={10} fill="rgb(var(--hv-text-2))">push</text>}
        {pts.filter(p => p.status === 'fail' || p.status === 'error').map((p, i) => { const v = p.push ?? p.decision ?? 0; const cx2 = x(p.at), cy = y(v);
          return <g key={i} stroke="var(--bad)" strokeWidth={2} strokeLinecap="round"><line x1={cx2 - 4} y1={cy - 4} x2={cx2 + 4} y2={cy + 4} /><line x1={cx2 - 4} y1={cy + 4} x2={cx2 + 4} y2={cy - 4} /></g>; })}
        {h && <>
          <line x1={x(h.at)} x2={x(h.at)} y1={T} y2={H - B} stroke="rgb(var(--hv-text-3))" strokeDasharray="3 3" strokeWidth={1} />
          {h.decision != null && <circle cx={x(h.at)} cy={y(h.decision)} r={4} fill="var(--s1)" stroke="rgb(var(--hv-widget-panel))" strokeWidth={2} />}
          {h.push != null && <circle cx={x(h.at)} cy={y(h.push)} r={4} fill="var(--s2)" stroke="rgb(var(--hv-widget-panel))" strokeWidth={2} />}
        </>}
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {h && (
        <div className="absolute top-6 pointer-events-none rounded-hv-xs bg-hv-popup-panel shadow-hv-2 ring-1 ring-hv-line-strong px-2 py-1 text-[11px] text-hv-text"
          style={{ left: `calc(${(x(h.at) / W) * 100}% + 10px)`, transform: x(h.at) > W * 0.7 ? 'translateX(calc(-100% - 20px))' : undefined }}>
          <div className="text-hv-text-3">{clock(h.at)} · repeat {h.iter} · step {h.idx + 1}</div>
          <div>Decision <b>{fmtMs(h.decision)}</b> · cloud push <b>{fmtMs(h.push)}</b></div>
          <div className={cx(h.status === 'fail' || h.status === 'error' ? 'text-hv-error-fg' : 'text-hv-text-2')}>{h.status}</div>
        </div>
      )}
    </div>
  );
};

// ── graded report ───────────────────────────────────────────────────────────
export const TestReportView: React.FC<{ api: TraceApi; runId: string; others: TestRunMeta[]; onOpenTrace?: (runId: string, traceId: string) => void }> = ({ api, runId, others, onOpenTrace }) => {
  const [r, setR] = useState<TestReport | null>(null);
  const [errMsg, setErr] = useState<string | null>(null);
  const [onlyBad, setOnlyBad] = useState(false);
  const [cmpWith, setCmpWith] = useState<string>('');
  useEffect(() => { setR(null); setErr(null); api.testReport(runId).then(setR).catch(e => setErr(e.message)); }, [api, runId]);
  if (errMsg) return <div className="p-3 text-xs text-hv-error-fg">{errMsg}</div>;
  if (!r) return <div className="p-4 text-sm text-hv-text-3 flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Grading…</div>;
  const t = r.report.totals;
  const rows: StepResult[] = r.report.steps.filter(s => !onlyBad || s.status !== 'pass');
  const same = others.filter(o => o.sequence.id === r.sequence.id && o.id !== runId);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-hv-text">{r.sequence.name}</span>
        <Badge tone={toneOf(t.verdict)}>{t.verdict === 'pass' ? 'passed' : t.verdict === 'fail' ? 'failed' : t.verdict}</Badge>
        <span className="text-xs text-hv-text-3">{new Date(r.startedAt).toLocaleString()}{r.endedAt ? ` · ${fmtMs(r.endedAt - r.startedAt)}` : ' · running'} · {r.iterations} repeat{r.iterations === 1 ? '' : 's'} · by {r.who}{r.aborted ? ' · stopped early' : ''}</span>
        <span className="ml-auto" />
        <Button size="sm" icon={<Download size={13} />} onClick={() => api.saveTestCsv(runId).catch(() => {})}>CSV</Button>
        {same.length > 0 && (
          <Select value={cmpWith} onChange={e => setCmpWith(e.target.value)} className="!w-64" title="Compare this run (B) with an earlier run of the same test (A)">
            <option value="">Compare with an earlier run…</option>
            {same.map(o => <option key={o.id} value={o.id}>{new Date(o.start).toLocaleString()}{o.aborted ? ' (stopped)' : ''}</option>)}
          </Select>
        )}
      </div>
      {r.error && <div className="text-xs rounded-hv-xs px-2 py-1 bg-hv-error-tint text-hv-error-fg">{r.error}</div>}
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="success">{t.pass} passed</Badge><Badge tone="warning">{t.warn} slow / warnings</Badge><Badge tone="error">{t.fail} failed</Badge>
        {t.skipped > 0 && <Badge>{t.skipped} skipped</Badge>}
        {r.report.health.samples > 0 && <Badge tone={r.report.health.pushDrops ? 'error' : 'neutral'}>cloud push dropped {r.report.health.pushDrops}×</Badge>}
      </div>
      {cmpWith && <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-3"><CompareView api={api} a={cmpWith} b={runId} onClose={() => setCmpWith('')} /></div>}
      {r.report.series.length > 1 && <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-2"><LatencyChart series={r.report.series} /></div>}
      <Section title="Per step">
        <table className="w-full text-[12px]"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2">Step</th><th className="pr-2">Passed</th><th className="pr-2">Failed</th><th className="pr-2">Decision p50 / p95</th><th className="pr-2">Cloud push p50 / p95</th><th className="pr-2">Strike p50</th></tr></thead><tbody>
          {r.report.byStep.map(s => (
            <tr key={s.idx} className="border-t border-hv-line">
              <td className="py-1 pr-2 text-hv-text">{s.idx + 1}. {s.text}</td>
              <td className="pr-2">{s.pass + s.warn}/{s.runs}</td><td className={cx('pr-2', s.fail ? 'text-hv-error-fg font-semibold' : 'text-hv-text-3')}>{s.fail}</td>
              <td className="pr-2 font-mono">{fmtMs(s.decision.p50)} / {fmtMs(s.decision.p95)}</td>
              <td className="pr-2 font-mono">{fmtMs(s.push.p50)} / {fmtMs(s.push.p95)}</td>
              <td className="pr-2 font-mono">{fmtMs(s.output.p50)}</td>
            </tr>))}
        </tbody></table>
      </Section>
      <div className="flex items-center gap-3"><span className="text-xs font-semibold text-hv-text-2">Every step</span><Toggle on={onlyBad} onChange={setOnlyBad} label="Only problems" /></div>
      <table className="w-full text-[12px]"><thead><tr className="text-left text-hv-text-3"><th className="py-1 pr-2 w-[90px]">Time</th><th className="pr-2">#</th><th className="pr-2">Step</th><th className="pr-2">Result</th><th className="pr-2">Decision</th><th className="pr-2">Push</th><th className="pr-2">Why</th></tr></thead><tbody>
        {rows.map((s, i) => (
          <tr key={i} className={cx('border-t border-hv-line', s.traceId && onOpenTrace ? 'cursor-pointer hover:bg-hv-widget' : '')} onClick={() => s.traceId && onOpenTrace && onOpenTrace(r.runId, s.traceId)}>
            <td className="py-1 pr-2 font-mono text-hv-text-3">{clock(s.at)}</td>
            <td className="pr-2 text-hv-text-3">{s.iter}.{s.idx + 1}</td>
            <td className="pr-2 text-hv-text">{s.text}</td>
            <td className="pr-2"><span className="inline-flex items-center gap-1"><StatusIcon s={s.status} />{s.result ? <span className="font-mono text-hv-text-2">{s.result}</span> : null}</span></td>
            <td className="pr-2 font-mono">{fmtMs(s.latency.decision)}</td><td className="pr-2 font-mono">{fmtMs(s.latency.push)}</td>
            <td className="pr-2 text-hv-text-3">{s.why.join(' · ')}</td>
          </tr>))}
      </tbody></table>
    </div>
  );
};
const StatusIcon: React.FC<{ s: string }> = ({ s }) => s === 'pass' ? <CheckCircle2 size={13} className="text-hv-success-fg" aria-label="passed" /> : s === 'warn' ? <AlertTriangle size={13} className="text-hv-warning-fg" aria-label="warning" /> : s === 'skipped' ? <span className="text-hv-text-3 text-[11px]">skipped</span> : <XCircle size={13} className="text-hv-error-fg" aria-label="failed" />;

// ── one step in the editor ──────────────────────────────────────────────────
const StepEditor: React.FC<{ s: Step; i: number; n: number; doors: DoorRow[]; onChange: (s: Step) => void; onMove: (d: -1 | 1) => void; onDelete: () => void }> = ({ s, i, n, doors, onChange, onMove, onDelete }) => {
  const up = (p: Partial<Step>) => onChange({ ...s, ...p });
  const ex = s.expect || {};
  const upX = (p: Partial<NonNullable<Step['expect']>>) => onChange({ ...s, expect: { ...ex, ...p } });
  return (
    <div className="grid grid-cols-[28px_140px_150px_minmax(0,1.3fr)_minmax(0,1.3fr)_70px_70px] gap-2 items-start py-1.5 border-t border-hv-line text-[12px]">
      <div className="pt-1.5 text-hv-text-3 text-right">{i + 1}</div>
      <Select value={s.kind} onChange={e => onChange({ kind: e.target.value as StepKind, door: s.door ?? null, label: '', expect: {} })}>
        {(Object.keys(KIND_WORD) as StepKind[]).map(k => <option key={k} value={k}>{KIND_WORD[k]}</option>)}
      </Select>
      <Select value={s.door ?? ''} onChange={e => up({ door: e.target.value === '' ? null : Number(e.target.value) })}>
        <option value="">{s.kind === 'wait' ? 'Any door' : 'Pick a door…'}</option>
        {doors.map(d => <option key={d.id} value={d.id}>{d.name}{d.oncafe ? '' : ' (not paired)'}</option>)}
      </Select>
      <div className="flex flex-wrap gap-1.5 items-center">
        {s.kind === 'card' && <><Input className="!w-16" placeholder="FC" value={s.fc ?? ''} onChange={e => up({ fc: e.target.value.replace(/\D/g, '') })} /><Input className="!w-28" placeholder="Card number" value={s.cn ?? ''} onChange={e => up({ cn: e.target.value.replace(/\D/g, '') })} /></>}
        {s.kind === 'rex' && <><span className="text-hv-text-3">hold</span><Input className="!w-16" value={secs(s.holdMs ?? 500)} onChange={e => up({ holdMs: fromSecs(e.target.value) })} /><span className="text-hv-text-3">s</span></>}
        {s.kind === 'dps' && <Select value={s.state || 'open'} onChange={e => up({ state: e.target.value as 'open' | 'close' })}><option value="open">Open the door</option><option value="close">Close the door</option></Select>}
        {s.kind === 'command' && <>
          <Select className="!w-36" value={s.cmd || 'override'} onChange={e => up({ cmd: e.target.value as Step['cmd'], value: e.target.value === 'override' ? 'unlock' : true })}>
            <option value="override">Temporary override</option><option value="lockdown">Lockdown (its area)</option><option value="maintenance">Maintenance</option><option value="shunt">Shunt reader</option>
          </Select>
          {s.cmd === 'override' || !s.cmd
            ? <><Select className="!w-24" value={String(s.value ?? 'unlock')} onChange={e => up({ value: e.target.value })}><option value="unlock">unlock</option><option value="lock">lock</option></Select><Input className="!w-14" value={String(s.seconds ?? 30)} onChange={e => up({ seconds: Number(e.target.value) || 30 })} /><span className="text-hv-text-3">s</span></>
            : <Select className="!w-20" value={s.value === false ? 'off' : 'on'} onChange={e => up({ value: e.target.value === 'on' })}><option value="on">on</option><option value="off">off</option></Select>}
        </>}
        {s.kind === 'wait' && <><Input className="!w-20" value={secs(s.ms ?? 2000)} onChange={e => up({ ms: fromSecs(e.target.value) })} /><span className="text-hv-text-3">s</span></>}
        <Input className="!w-full" placeholder="Label (optional)" value={s.label || ''} onChange={e => up({ label: e.target.value })} />
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {s.kind === 'card' && <Select className="!w-28" value={ex.result || 'any'} onChange={e => upX({ result: e.target.value as 'grant' | 'deny' | 'any' })}><option value="grant">Granted</option><option value="deny">Denied</option><option value="any">Any decision</option></Select>}
        {(s.kind === 'card' || s.kind === 'command') && <Select className="!w-32" value={ex.strike || 'any'} onChange={e => upX({ strike: e.target.value as 'on' | 'off' | 'stays-on' | 'any' })}><option value="any">Strike: don't check</option><option value="on">Strike turns on</option><option value="off">Strike stays off</option><option value="stays-on">Strike stays on</option></Select>}
        {ex.strike === 'stays-on' && <><span className="text-hv-text-3">≥</span><Input className="!w-14" value={secs(ex.minMs)} onChange={e => upX({ minMs: fromSecs(e.target.value) })} /><span className="text-hv-text-3">s</span></>}
        <Input className="!w-full" placeholder={s.kind === 'card' ? 'Controller events (optional, e.g. *passback*)' : 'Controller events, e.g. doorforcedopen, held*'} value={(ex.events || []).join(', ')} onChange={e => upX({ events: e.target.value.split(/[\s,]+/).filter(Boolean) })} title="Event names the controller must report: exact, prefix* or *suffix" />
        <span className="text-hv-text-3">within</span><Input className="!w-14" value={secs(ex.withinMs ?? 10000)} onChange={e => upX({ withinMs: fromSecs(e.target.value) })} /><span className="text-hv-text-3">s</span>
      </div>
      <div className="flex items-center gap-1"><Input className="!w-14" value={secs(s.afterMs ?? (s.kind === 'card' ? 3000 : s.kind === 'wait' ? 0 : 1500))} onChange={e => up({ afterMs: fromSecs(e.target.value) })} title="Pause after this step, seconds" /><span className="text-hv-text-3">s</span></div>
      <div className="flex items-center gap-0.5 pt-1">
        <button className="p-1 text-hv-text-3 hover:text-hv-text disabled:opacity-30" disabled={i === 0} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp size={13} /></button>
        <button className="p-1 text-hv-text-3 hover:text-hv-text disabled:opacity-30" disabled={i === n - 1} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown size={13} /></button>
        <button className="p-1 text-hv-text-3 hover:text-hv-error-fg" onClick={onDelete} aria-label="Delete step"><X size={13} /></button>
      </div>
    </div>
  );
};

// ── the Tests tab ───────────────────────────────────────────────────────────
export const TestsPage: React.FC<{ api: TraceApi; status: Status; onOpenTrace?: (runId: string, traceId: string) => void }> = ({ api, status, onOpenTrace }) => {
  const [seqs, setSeqs] = useState<Sequence[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [runs, setRuns] = useState<TestRunMeta[]>([]);
  const [doors, setDoors] = useState<DoorRow[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Sequence | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tpl, setTpl] = useState({ kind: 'valid', door: '', fc: '', cn: '', badCn: '', heldS: '30' });
  const cur = status.test || null;
  const running = !!cur && cur.state !== 'done';
  const admin = status.me?.admin !== false;
  const lastState = useRef<string | null>(null);

  const load = useCallback(async (keep?: string | null) => {
    try {
      const [t, d] = await Promise.all([api.tests(), api.doors().catch(() => ({ doors: [] as DoorRow[] }))]);
      setSeqs(t.sequences); setTemplates(t.templates); setRuns(t.runs); setDoors(d.doors || []);
      const id = keep !== undefined ? keep : selId;
      const pick = t.sequences.find(q => q.id === id) || t.sequences[0] || null;
      if (!dirty || keep !== undefined) { setSelId(pick ? pick.id! : null); setDraft(pick ? JSON.parse(JSON.stringify(pick)) : null); setDirty(false); }
    } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
  }, [api, selId, dirty]);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // a test that just finished: refresh the runs and open its report
  useEffect(() => {
    const st = cur?.state || null;
    if (lastState.current && lastState.current !== 'done' && st === 'done' && cur?.runId) { api.tests().then(t => setRuns(t.runs)).catch(() => {}); setReportId(cur.runId); }
    lastState.current = st;
  }, [cur?.state, cur?.runId, api]);

  const change = (q: Sequence) => { setDraft(q); setDirty(true); };
  const pick = (q: Sequence) => { if (dirty && !window.confirm('Discard the changes to this test?')) return; setSelId(q.id!); setDraft(JSON.parse(JSON.stringify(q))); setDirty(false); setReportId(null); };
  const save = async () => {
    if (!draft) return null;
    setBusy('save'); setMsg(null);
    try { const s = await api.saveTest(draft); await load(s.id!); setMsg({ tone: 'success', text: 'Saved' }); return s; }
    catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); return null; } finally { setBusy(null); }
  };
  const addTemplate = async () => {
    if (!draft) return;
    setMsg(null);
    try {
      const door = tpl.door === '' ? null : Number(tpl.door);
      const r = await api.template({ kind: tpl.kind, door, fc: tpl.fc, cn: tpl.cn, badCn: tpl.badCn, heldMs: Number(tpl.heldS) * 1000 || 30000 });
      change({ ...draft, steps: draft.steps.concat(r.steps) });
    } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
  };
  const run = async () => {
    let q = draft;
    if (!q) return;
    if (dirty || !q.id) { q = await save(); if (!q) return; }
    setBusy('run'); setMsg(null); setReportId(null);
    try { await api.runTest(q.id!, { repeat: q.repeat, minutes: q.minutes, gapMs: q.gapMs }); }
    catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };
  const myRuns = runs.filter(r => r.sequence.id === selId);
  const needsCommands = !!draft?.steps.some(s => s.kind === 'command') && !status.settings.commands.enabled;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
    {/* TRACE-9: the quick way — one door, the standard checks, an answer in words */}
    <div className="px-3 py-2 border-b border-hv-line shrink-0"><DoorCheckBox api={api} status={status} onOpenRun={runId => setReportId(runId)} /></div>
    <div className="flex-1 min-h-0 flex">
      <div className="w-[260px] shrink-0 border-r border-hv-line overflow-auto flex flex-col">
        <div className="p-2 border-b border-hv-line"><Button size="sm" className="w-full" icon={<Plus size={13} />} disabled={!admin} onClick={() => { if (dirty && !window.confirm('Discard the changes to this test?')) return; setSelId(null); setDraft(blank()); setDirty(true); setReportId(null); }}>New test</Button></div>
        {!seqs.length && !draft ? <Empty icon={<FlaskConical size={24} />} title="No tests yet">Make one from the door templates: valid card, denied card, REX, forced, held open…</Empty> : seqs.map(q => (
          <button key={q.id} onClick={() => pick(q)} className={cx('w-full text-left px-3 py-2 border-b border-hv-line', q.id === selId ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
            <div className="text-sm text-hv-text truncate flex items-center gap-1.5">{running && cur?.seqId === q.id && <span className="w-1.5 h-1.5 rounded-full bg-hv-error animate-pulse" />}{q.name}</div>
            <div className="text-[11px] text-hv-text-3">{q.steps.length} steps{q.minutes ? ` · ${q.minutes} min` : q.repeat > 1 ? ` · ×${q.repeat}` : ''}</div>
          </button>))}
        {myRuns.length > 0 && <>
          <div className="px-3 pt-3 pb-1 text-[11px] font-semibold text-hv-text-3 uppercase tracking-wide">Results</div>
          {myRuns.map(r => (
            <button key={r.id} onClick={() => setReportId(r.id)} className={cx('w-full text-left px-3 py-1.5 border-b border-hv-line text-[12px]', r.id === reportId ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
              <span className="text-hv-text">{new Date(r.start).toLocaleString()}</span>{!r.end && <span className="ml-1 text-hv-error-fg">running</span>}{r.aborted && <span className="ml-1 text-hv-text-3">stopped</span>}
            </button>))}
        </>}
      </div>
      <div className="flex-1 min-w-0 overflow-auto p-4 space-y-3">
        {running && cur && (
          <div className="rounded-hv-xs ring-1 ring-inset ring-hv-brand/40 bg-hv-brand-tint p-3 text-[12px] space-y-1.5">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-hv-brand" />
              <span className="text-sm font-semibold text-hv-text">Running “{cur.name}”</span>
              <span className="text-hv-text-2">{cur.state === 'grading' ? 'grading…' : `repeat ${cur.iter}${cur.until ? ` · until ${new Date(cur.until).toLocaleTimeString()}` : ` of ${cur.repeat}`} · step ${cur.idx + 1} of ${cur.steps}`}</span>
              {cur.errors > 0 && <Badge tone="error">{cur.errors} step errors</Badge>}
              <span className="ml-auto" />
              <Button size="sm" tone="danger-soft" icon={<Square size={12} />} disabled={cur.abort || cur.state !== 'running'} onClick={() => api.stopTest().catch(e => setMsg({ tone: 'error', text: e.message }))}>{cur.abort ? 'Stopping…' : 'Stop'}</Button>
            </div>
            <div className="h-1.5 rounded-full bg-hv-line overflow-hidden"><div className="h-full bg-hv-brand" style={{ width: `${Math.min(100, cur.until ? ((Date.now() - cur.startedAt) / (cur.until - cur.startedAt)) * 100 : (((cur.iter - 1) * cur.steps + cur.idx + 1) / Math.max(1, cur.repeat * cur.steps)) * 100)}%` }} /></div>
            {cur.last.map((l, i) => <div key={i} className={cx('font-mono', l.error ? 'text-hv-error-fg' : 'text-hv-text-2')}>{clock(l.at)} #{l.iter}.{l.idx + 1} {l.text}{l.error ? ` — ${l.error}` : ''}</div>)}
          </div>
        )}
        {msg && <div className={cx('text-xs rounded-hv-xs px-2 py-1', msg.tone === 'error' ? 'bg-hv-error-tint text-hv-error-fg' : 'bg-hv-success-tint text-hv-success-fg')}>{msg.text}</div>}
        {reportId ? (
          <>
            <Button size="sm" tone="ghost" onClick={() => setReportId(null)}>← Back to the test</Button>
            <TestReportView api={api} runId={reportId} others={runs} onOpenTrace={onOpenTrace} />
          </>
        ) : !draft ? <Empty icon={<ListChecks size={24} />} title="Pick or make a test" /> : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="!w-72 font-semibold" value={draft.name} onChange={e => change({ ...draft, name: e.target.value })} disabled={!admin} />
              {dirty && <Badge tone="warning">not saved</Badge>}
              <span className="ml-auto" />
              <Button size="sm" icon={<Save size={13} />} busy={busy === 'save'} disabled={!admin || !dirty} onClick={save}>Save</Button>
              {draft.id && <Button size="sm" tone="ghost" icon={<Trash2 size={13} />} disabled={!admin || running} onClick={async () => { if (!window.confirm(`Delete “${draft.name}”? Its results stay under Runs.`)) return; try { await api.delTest(draft.id!); setDraft(null); setDirty(false); load(null); } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } }}>Delete</Button>}
            </div>
            <Input placeholder="Note (what this test is for, firmware under test…)" value={draft.note || ''} onChange={e => change({ ...draft, note: e.target.value })} disabled={!admin} />
            {!doors.length && <div className="text-xs rounded-hv-xs px-2 py-1 bg-hv-warning-tint text-hv-warning-fg">No doors found. Tests run on the Doors page doors: set up a door (reader, DPS, REX, lock) and pair it with its OnCAFE door first.</div>}

            <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-2 flex flex-wrap items-end gap-2 text-[12px]">
              <div className="text-[11px] font-semibold text-hv-text-2 w-full">Add a door behaviour</div>
              <Select className="!w-48" value={tpl.kind} onChange={e => setTpl({ ...tpl, kind: e.target.value })}>{templates.map(t => <option key={t.id} value={t.id} title={t.hint}>{t.label}</option>)}</Select>
              <Select className="!w-48" value={tpl.door} onChange={e => setTpl({ ...tpl, door: e.target.value })}><option value="">Door…</option>{doors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
              {!['rex', 'forced', 'override'].includes(tpl.kind) && <Input className="!w-16" placeholder="FC" value={tpl.fc} onChange={e => setTpl({ ...tpl, fc: e.target.value.replace(/\D/g, '') })} />}
              {!['rex', 'forced', 'override', 'invalid'].includes(tpl.kind) && <Input className="!w-28" placeholder="Card with access" value={tpl.cn} onChange={e => setTpl({ ...tpl, cn: e.target.value.replace(/\D/g, '') })} />}
              {tpl.kind === 'invalid' && <Input className="!w-32" placeholder="Card without access" value={tpl.badCn} onChange={e => setTpl({ ...tpl, badCn: e.target.value.replace(/\D/g, '') })} />}
              {tpl.kind === 'held' && <><span className="text-hv-text-3">held-open time</span><Input className="!w-14" value={tpl.heldS} onChange={e => setTpl({ ...tpl, heldS: e.target.value })} /><span className="text-hv-text-3">s</span></>}
              <Button size="sm" icon={<Plus size={13} />} disabled={!admin || !tpl.door} onClick={addTemplate}>Add steps</Button>
              <span className="text-hv-text-3">{templates.find(t => t.id === tpl.kind)?.hint}</span>
            </div>

            <div>
              <div className="grid grid-cols-[28px_140px_150px_minmax(0,1.3fr)_minmax(0,1.3fr)_70px_70px] gap-2 text-[11px] text-hv-text-3 pb-1">
                <span /><span>Step</span><span>Door</span><span>Details</span><span>Should happen</span><span>Pause</span><span />
              </div>
              {draft.steps.map((s, i) => (
                <StepEditor key={i} s={s} i={i} n={draft.steps.length} doors={doors}
                  onChange={ns => change({ ...draft, steps: draft.steps.map((x, j) => (j === i ? ns : x)) })}
                  onMove={d => { const st = draft.steps.slice(); const [m] = st.splice(i, 1); st.splice(i + d, 0, m); change({ ...draft, steps: st }); }}
                  onDelete={() => change({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })} />
              ))}
              <Button size="sm" tone="ghost" icon={<Plus size={13} />} disabled={!admin} onClick={() => change({ ...draft, steps: draft.steps.concat({ kind: 'wait', ms: 2000, door: null }) })}>Add a step</Button>
            </div>

            <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-3 flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-hv-text-2">Run it</span>
              <Input className="!w-16" value={String(draft.repeat)} disabled={!admin || !!draft.minutes} onChange={e => change({ ...draft, repeat: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) })} />
              <span className="text-hv-text-3">times, or keep going for</span>
              <Input className="!w-16" value={String(draft.minutes || '')} placeholder="0" disabled={!admin} onChange={e => change({ ...draft, minutes: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
              <span className="text-hv-text-3">minutes (load run) · pause between repeats</span>
              <Input className="!w-14" value={secs(draft.gapMs)} disabled={!admin} onChange={e => change({ ...draft, gapMs: fromSecs(e.target.value) })} /><span className="text-hv-text-3">s</span>
              <Toggle on={draft.sync} onChange={v => change({ ...draft, sync: v })} label="Sync markers at start and end" />
              <span className="ml-auto" />
              {needsCommands && <span className="text-hv-warning-fg">This test sends OnCAFE commands: turn Commands on in Setup.</span>}
              <Button tone="primary" icon={<Play size={14} />} busy={busy === 'run'} disabled={!admin || running || !draft.steps.length || needsCommands} onClick={run}
                title={!admin ? 'Only an Aether admin can run tests (they move real hardware)' : running ? 'A test is already running' : 'Run on the real doors; a trace run is recorded and every step graded'}>{dirty ? 'Save and run' : 'Run'}</Button>
            </div>
            <div className="text-[11px] text-hv-text-3">A test drives the real doors (cards on the door's reader, its DPS and REX relays or emulated inputs) and is recorded as a trace run named “Test: {draft.name}”. When it stops, every DPS / REX it moved is put back.</div>
          </>
        )}
      </div>
    </div>
    </div>
  );
};
