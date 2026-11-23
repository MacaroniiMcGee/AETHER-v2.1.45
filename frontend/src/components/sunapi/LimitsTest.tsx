// AETHER_SUNAPI_LIMITS — Limits test: run nhp_limits.py on the Pi against the primary device,
// watch results arrive, browse saved reports, download the Excel file.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Download, FileUp, GitCompareArrows, Loader2, Play, ShieldAlert, Square, Trash2, Gauge, FlaskConical, ListChecks } from 'lucide-react';
import { PushSequence } from './PushSequence';
import { AskBox } from './AskBox';
import { ask, EXAMPLES } from './ask';
import type { Device } from './api';
import { LEVELS, levelList, limitsClient, type Job, type Level, type MockState, type RunEvent, type RunMeta } from './limitsApi';
import { rowsOf, meta as reportMeta, type Report } from './limitsDiff';
import { Badge, Button, Dialog, Empty, Field, Input, Segmented, copyText, cx, fmtTime, lsGet, lsSet, type Tone } from './ui';
import { HBarChart, StackChart } from './charts';
import { confLabel, oncafeRows, type OncafeRow } from './oncafe';

export const resultTone = (r: string): Tone =>
  r === 'PASS' || r === 'APPLIED' || r === 'OK' ? 'success'
    : r === 'FAIL' || r === 'ERROR' || r === 'NOT APPLIED' || r === 'PARTIAL' || r === 'NG' ? 'error'
      : r === 'LIMIT' || r === 'UNVERIFIED' ? 'warning'
        : r === 'INFO' || r === 'REFUSED' ? 'info' : 'neutral';
const stateTone = (s: RunMeta['state']): Tone => (s === 'done' ? 'success' : s === 'running' ? 'brand' : s === 'stopped' ? 'warning' : 'error');
const stateLabel = (m: RunMeta) => (m.source === 'import' ? 'Imported' : m.state === 'done' ? 'Done' : m.state === 'running' ? 'Running' : m.state === 'stopped' ? 'Stopped' : 'Failed');
const RESULT_ORDER = ['FAIL', 'ERROR', 'LIMIT', 'PASS', 'INFO', 'SKIP'];

export const Counts: React.FC<{ counts: Record<string, number>; size?: 'sm' }> = ({ counts }) => (
  <span className="inline-flex flex-wrap gap-1">
    {RESULT_ORDER.filter(k => counts[k]).map(k => <Badge key={k} tone={resultTone(k)}>{counts[k]} {k}</Badge>)}
  </span>
);

const SHEET_COLS: Record<string, string[]> = {
  Results: ['ID', 'Test', 'Result', 'Measured', 'Notes'],
  Limits: ['Limit / property', 'What it means', 'Value', 'How to read the value', 'Source'],
  'Push checks': ['ID', 'Test', 'Before (inspect)', 'Pushed', 'Push reply', 'After (reinspect)', 'Verdict'],
  Features: ['Feature / capability', 'Value', 'Source'],
  Summary: ['Field', 'Value'],
};
const BADGE_COLS = new Set(['Result', 'Verdict']);
const VIEWS = ['Overview', 'OnCAFE', 'Results', 'Limits', 'Push checks', 'Features', 'Doors', 'Error codes', 'Events', 'Summary'] as const;
const BUILT_IN = new Set(['Overview', 'OnCAFE']);
const RESULT_TONES: Record<string, string> = { PASS: 'success', INFO: 'info', LIMIT: 'warning', FAIL: 'error', ERROR: 'error', SKIP: 'line-strong' };
const confTone = (c: OncafeRow['conf']): Tone => (c === 'confirmed' ? 'success' : c === 'field' ? 'brand' : 'neutral');

const Card: React.FC<{ title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode }> = ({ title, hint, children, action }) => (
  <section className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-4 flex flex-col gap-2 min-w-0">
    <div className="flex items-start gap-2"><div className="min-w-0"><h3 className="text-sm font-bold text-hv-text">{title}</h3>{hint && <p className="text-xs text-hv-text-3 mt-0.5">{hint}</p>}</div>{action && <div className="ml-auto">{action}</div>}</div>
    {children}
  </section>
);

/** Overview: OnCAFE capacity, results per level, timings. */
const Overview: React.FC<{ report: Report; steps?: RunMeta['steps'] }> = ({ report, steps }) => {
  const oc = oncafeRows(report).filter(r => r.num != null && !/\(measured\)$|length|delay/.test(r.term));
  const perId = oncafeRows(report).find(r => r.term === 'Access Levels per identity');
  const levels: Record<string, Record<string, number>> = {};
  rowsOf(report, 'Results').forEach(r => { const l = String(r.Level || '?'), k = String(r.Result || ''); levels[l] = levels[l] || {}; levels[l][k] = (levels[l][k] || 0) + 1; });
  const lim = rowsOf(report, 'Limits');
  const timing = lim.filter(r => /latency \(ms\)|p95 latency/.test(String(r['Limit / property']))).map(r => ({ label: String(r['Limit / property']).replace(/ p95 latency \(ms\)/, ' (p95)'), value: parseFloat(String(r.Value)) || null, tone: 'info' as const }));
  const secs = lim.filter(r => /\(s\)$/.test(String(r['Limit / property'])) && !/lockout/i.test(String(r['Limit / property']))).map(r => ({ label: String(r['Limit / property']).replace(/ \(s\)$/, ''), value: parseFloat(String(r.Value)) || null, tone: 'data-blue' as const }));
  return (
    <div className="p-4 grid gap-4 xl:grid-cols-2">
      {steps && steps.length > 0 && <div className="xl:col-span-2"><PushSequence steps={steps} /></div>}
      <div className="xl:col-span-2">
        <Card title="Controller capacity in OnCAFE terms" hint="Declared by the firmware (bar, log scale). A black tick is what the capacity test actually stored.">
          {oc.length ? <HBarChart log bars={oc.map(r => ({ label: r.term, value: r.num, marker: r.measuredNum ?? null, tone: r.conf === 'confirmed' ? 'brand' : r.conf === 'field' ? 'warning' : 'info', note: r.sunapi }))} markerLabel="measured" />
            : <p className="text-xs text-hv-text-3">This report has no capabilities. Run the Discovery level.</p>}
          {perId && <div className="text-xs rounded-hv-xs px-2.5 py-2 bg-hv-brand-tint text-hv-text ring-1 ring-inset ring-hv-brand/40"><b>{perId.value} Access Levels per identity</b> ({perId.sunapi}). {perId.note}.</div>}
        </Card>
      </div>
      <Card title="Results by test level" hint="How many tests in each level passed, hit a limit or failed.">
        <StackChart groups={Object.entries(levels).map(([label, parts]) => ({ label, parts }))} order={['PASS', 'INFO', 'LIMIT', 'FAIL', 'ERROR', 'SKIP']} tones={RESULT_TONES} width={540} />
      </Card>
      <Card title="Timings" hint="Response time (ms, p95) and event / release times (s).">
        {timing.length > 0 && <HBarChart bars={timing} unit=" ms" width={540} />}
        {secs.length > 0 && <HBarChart bars={secs} unit=" s" width={540} />}
        {!timing.length && !secs.length && <p className="text-xs text-hv-text-3">Run the Load, Connector or Door levels to see timings.</p>}
      </Card>
    </div>
  );
};

/** OnCAFE view: spreadsheet of every limit under its OnCAFE name; sortable, copyable. */
const OncafeSheet: React.FC<{ report: Report; q: string }> = ({ report, q }) => {
  const [sort, setSort] = useState<{ k: keyof OncafeRow; d: 1 | -1 }>({ k: 'group', d: 1 });
  const [copied, setCopied] = useState(false);
  const rows = oncafeRows(report).filter(r => !q || `${r.term} ${r.what} ${r.sunapi} ${r.note || ''}`.toLowerCase().includes(q))
    .sort((a, b) => { const x = a[sort.k], y = b[sort.k]; const nx = typeof x === 'number' ? x : null, ny = typeof y === 'number' ? y : null;
      return (nx != null && ny != null ? nx - ny : String(x ?? '').localeCompare(String(y ?? ''))) * sort.d; });
  const cols: [keyof OncafeRow, string][] = [['group', 'Area'], ['term', 'OnCAFE term'], ['what', 'What it limits'], ['num', 'Value'], ['measured', 'Measured'], ['source', 'Source'], ['sunapi', 'SUNAPI name'], ['conf', 'Mapping']];
  const csv = () => {
    const e = (v: unknown) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    copyText([['Area', 'OnCAFE term', 'What it limits', 'Value', 'Measured', 'Source', 'SUNAPI name', 'Mapping', 'Notes'].join(',')]
      .concat(rows.map(r => [r.group, r.term, r.what, r.value, r.measured || '', r.source, r.sunapi, confLabel[r.conf], r.note || ''].map(e).join(','))).join('\n'))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  if (!rows.length && !q) return <Empty title="No OnCAFE-relevant limits in this report">Run the Discovery level (capabilities) and the Capacity level to fill this view.</Empty>;
  return (
    <div className="p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-hv-text-3">
        <span>SUNAPI uses the ONVIF access-control names; this sheet shows each one under the name OnCAFE uses. Click a column to sort.</span>
        <Button size="sm" className="ml-auto" onClick={csv}>{copied ? 'Copied' : 'Copy as CSV'}</Button>
      </div>
      <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-x-auto">
        <table className="w-full text-[13px] border-separate border-spacing-0 min-w-[900px]">
          <thead><tr>{cols.map(([k, h]) => (
            <th key={k} onClick={() => setSort(s => ({ k, d: s.k === k ? (s.d === 1 ? -1 : 1) : 1 }))}
              className="text-left text-[11px] font-semibold uppercase tracking-wide text-hv-text-3 bg-hv-box px-3 h-9 border-b border-hv-line whitespace-nowrap cursor-pointer select-none hover:text-hv-text">
              {h}{sort.k === k ? (sort.d === 1 ? ' ▲' : ' ▼') : ''}</th>))}</tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.term} className={cx('hover:bg-hv-widget', r.conf === 'field' && 'bg-hv-brand-tint')}>
              <td className="px-3 py-2 border-b border-hv-line text-hv-text-3 text-xs">{r.group}</td>
              <td className="px-3 py-2 border-b border-hv-line font-semibold text-hv-text whitespace-nowrap">{r.term}</td>
              <td className="px-3 py-2 border-b border-hv-line text-hv-text-2 min-w-[220px]">{r.what}{r.note && <div className="text-[11.5px] text-hv-text-3">{r.note}</div>}</td>
              <td className="px-3 py-2 border-b border-hv-line font-mono font-semibold text-hv-text text-right">{r.value}</td>
              <td className="px-3 py-2 border-b border-hv-line font-mono text-hv-text-2 text-right">{r.measured ?? ''}</td>
              <td className="px-3 py-2 border-b border-hv-line text-xs text-hv-text-3">{r.source}</td>
              <td className="px-3 py-2 border-b border-hv-line font-mono text-[11.5px] text-hv-text-3">{r.sunapi}</td>
              <td className="px-3 py-2 border-b border-hv-line"><Badge tone={confTone(r.conf)}>{confLabel[r.conf]}</Badge></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
};

const SheetTable: React.FC<{ report: Report; sheet: string; q: string; all: boolean }> = ({ report, sheet, q, all }) => {
  const raw = report.sheets[sheet] || [];
  const head = (raw[0] || []).map(h => String(h ?? ''));
  const cols = all || !SHEET_COLS[sheet] ? head : SHEET_COLS[sheet].filter(c => head.includes(c));
  const rows = rowsOf(report, sheet).filter(r => !q || cols.some(c => String(r[c] ?? '').toLowerCase().includes(q)));
  if (!raw.length) return <Empty title={`No ${sheet.toLowerCase()} in this report`}>This sheet is empty, or the report comes from an older script version.</Empty>;
  return (
    <div className="overflow-auto">
      <table className="w-full text-[13px] border-separate border-spacing-0">
        <thead className="sticky top-0 z-10">
          <tr>{cols.map(c => <th key={c} className="text-left font-semibold text-[11px] uppercase tracking-wide text-hv-text-3 bg-hv-box px-3 h-9 border-b border-hv-line whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-hv-widget">
              {cols.map(c => {
                const v = String(r[c] ?? '');
                return (
                  <td key={c} className={cx('px-3 py-2 border-b border-hv-line align-top text-hv-text', /ID|Value|Measured|Before|After|Pushed|reply/.test(c) && 'font-mono text-[12px]', /Measured|Notes|What|Before|After|Pushed|reply|How to/.test(c) ? 'min-w-[220px] max-w-[460px] break-words' : 'whitespace-nowrap')}>
                    {BADGE_COLS.has(c) && v ? <Badge tone={resultTone(v)}>{v}</Badge> : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="p-6 text-center text-sm text-hv-text-3">Nothing matches “{q}”.</div>}
    </div>
  );
};

export const LimitsTest: React.FC<{ backend: string; device: Device | null; onCompare: (a: string, b?: string) => void; onUseDevice?: (id: string) => void }> = ({ backend, device, onCompare, onUseDevice }) => {
  const api = useMemo(() => limitsClient(backend), [backend]);
  const [levels, setLevels] = useState<Level[]>(() => lsGet('aether.sunapi.limits.levels', ['discovery', 'protocol', 'validation', 'load', 'connector']));
  const [opts, setOpts] = useState(() => lsGet('aether.sunapi.limits.opts', { doorToken: '1', doorCommands: '', capacityMenus: '', capacityCap: 1000, lockoutUser: '' }));
  const [lockPw, setLockPw] = useState('');
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [scope, setScope] = useState<'device' | 'all'>(() => lsGet('aether.sunapi.limits.scope', 'device'));
  const [sel, setSel] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const seen = useRef(0);
  const [mock, setMock] = useState<MockState | null>(null);
  const [mockBusy, setMockBusy] = useState(false);
  const [pendingSeq, setPendingSeq] = useState(false);
  useEffect(() => { api.mock().then(setMock).catch(() => setMock(null)); }, [api]);
  const startMock = async () => {
    setMockBusy(true); setErr(null);
    try { const m = await api.mockStart(); setMock(m); onUseDevice?.(m.deviceId); }
    catch (e) { setErr((e as Error).message); }
    setMockBusy(false);
  };
  const stopMock = () => api.mockStop().then(setMock).catch(e => setErr(e.message));
  const isMock = device?.id === mock?.deviceId;
  // "Push sequence" preset: discovery (for the declared limits) + capacity over every object menu
  const pushSequence = () => { setLevels(['discovery', 'capacity']); setOpts(o => ({ ...o, capacityMenus: '' })); setPendingSeq(true); };
  useEffect(() => { if (pendingSeq && levels.length === 2 && levels.includes('capacity')) { setPendingSeq(false); setConfirm(true); } }, [pendingSeq, levels]);

  useEffect(() => lsSet('aether.sunapi.limits.levels', levels), [levels]);
  useEffect(() => lsSet('aether.sunapi.limits.opts', opts), [opts]);
  useEffect(() => lsSet('aether.sunapi.limits.scope', scope), [scope]);

  const loadRuns = useCallback(() => api.runs().then(setRuns).catch(e => { setErr(e.message); setRuns([]); }), [api]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  // live job polling
  const running = job?.state === 'running';
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await api.job(seen.current);
        if (stop) return;
        if (j) {
          if (j.events.length) { seen.current = j.eventCount; setEvents(ev => [...ev, ...j.events]); }
          setJob(j);
          if (j.state !== 'running') loadRuns();
        }
      } catch { /* backend restarting */ }
    };
    tick();
    const t = setInterval(() => { if (running) tick(); }, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [api, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (runs || []).filter(r => scope === 'all' || r.deviceId === device?.id), [runs, scope, device]);
  const risky = LEVELS.filter(l => l.risk && levels.includes(l.id));
  const toggle = (id: Level) => setLevels(l => (l.includes(id) ? l.filter(x => x !== id) : [...l, id]));
  const needDoor = levels.includes('door') && !/^[\w.-]{1,32}$/.test(opts.doorToken || '');

  const start = async () => {
    if (!device) return;
    setErr(null); setBusy(true);
    try {
      const m = await api.start({
        deviceId: device.id, levels, doorToken: levels.includes('door') ? opts.doorToken : undefined,
        doorCommands: levels.includes('door') && opts.doorCommands ? ['Access', ...opts.doorCommands.split(/\s*,\s*/).filter(Boolean)].join(',') : undefined,
        capacityMenus: levels.includes('capacity') && opts.capacityMenus ? opts.capacityMenus : undefined,
        capacityCap: levels.includes('capacity') ? Number(opts.capacityCap) || 1000 : undefined,
        lockoutUser: levels.includes('lockout') && opts.lockoutUser ? opts.lockoutUser : undefined,
        lockoutPassword: levels.includes('lockout') && opts.lockoutUser ? lockPw : undefined,
        confirmed: { door: !!ack.door, capacity: !!ack.capacity, lockout: !!ack.lockout },
      });
      seen.current = 0; setEvents([]); setSel(m.id); setConfirm(false); setAck({});
      setJob({ ...m, events: [], eventCount: 0, outputTail: [], steps: [] });
      loadRuns();
    } catch (e) { setErr((e as Error).message); setConfirm(false); }
    setBusy(false);
  };
  const begin = () => (risky.length ? setConfirm(true) : start());

  const importFile = (f: File) => { setErr(null); api.importXlsx(f).then(m => { loadRuns(); setScope('all'); setSel(m.id); }).catch(e => setErr(e.message)); };
  const liveSel = job && running && (sel === job.id || !sel);

  return (
    <div className="h-full flex min-h-0">
      {/* left: new run + saved runs */}
      <div className="w-[320px] shrink-0 border-r border-hv-line overflow-y-auto">
        <div className="p-4 flex flex-col gap-3 border-b border-hv-line">
          <div>
            <div className="text-sm font-bold text-hv-text">New limits test</div>
            <div className="text-xs text-hv-text-3 mt-0.5 truncate">{device ? `${device.name} · ${device.host}` : 'Pick a device in the bar above'}</div>
          </div>
          <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line p-2.5 flex flex-col gap-2 bg-hv-widget">
            <div className="flex items-center gap-2">
              <FlaskConical size={14} className="text-hv-text-3" />
              <span className="text-[12.5px] font-semibold text-hv-text">Built-in mock controller</span>
              <span className={cx('ml-auto w-2 h-2 rounded-full', mock?.running ? 'bg-hv-success' : 'bg-hv-line-strong')} title={mock?.running ? 'Running' : 'Stopped'} />
            </div>
            <div className="text-[11.5px] text-hv-text-3 leading-snug">An NHP simulator on this Pi (127.0.0.1) with the real P400 limit layout, scaled down. Rehearse every test, including door, capacity and lockout, without touching hardware.</div>
            <div className="flex gap-2">
              {mock?.running
                ? <><Button size="sm" tone="secondary" onClick={() => onUseDevice?.(mock.deviceId)} disabled={isMock}>{isMock ? 'In use' : 'Use it'}</Button><Button size="sm" tone="ghost" onClick={stopMock} disabled={running && isMock}>Stop</Button></>
                : <Button size="sm" tone="secondary" busy={mockBusy} onClick={startMock}>Start the mock</Button>}
            </div>
          </div>
          <Button tone="secondary" icon={<ListChecks size={14} />} disabled={!device || running} onClick={pushSequence} title="Discovery + capacity: push each limit, validate it, then move to the next">
            Push sequence (every limit)
          </Button>
          <div className="flex flex-col gap-1">
            {LEVELS.map(l => (
              <label key={l.id} className={cx('flex gap-2.5 items-start rounded-hv-xs px-2 py-1.5 cursor-pointer hover:bg-hv-widget', levels.includes(l.id) && 'bg-hv-widget')}>
                <input type="checkbox" className="mt-0.5 accent-hv-brand" checked={levels.includes(l.id)} onChange={() => toggle(l.id)} disabled={running} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-hv-text">
                    {l.label}
                    {l.risk === 'door' && <Badge tone="warning">Releases door</Badge>}
                    {l.risk === 'capacity' && <Badge tone="warning">Writes</Badge>}
                    {l.risk === 'lockout' && <Badge tone="error">Locks login</Badge>}
                    {l.busy && <Badge tone="neutral">Busy</Badge>}
                  </span>
                  <span className="block text-[11.5px] leading-snug text-hv-text-3">{l.what}</span>
                </span>
              </label>
            ))}
          </div>
          {levels.includes('door') && (
            <div className="grid grid-cols-[90px_1fr] gap-2">
              <Field label="Door token"><Input mono value={opts.doorToken} invalid={needDoor} onChange={e => setOpts({ ...opts, doorToken: e.target.value })} /></Field>
              <Field label="Also test commands"><Input mono placeholder="Unlock,LockDown" value={opts.doorCommands} onChange={e => setOpts({ ...opts, doorCommands: e.target.value })} /></Field>
            </div>
          )}
          {levels.includes('capacity') && (
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <Field label="Object menus" hint="Empty = every add/remove menu"><Input mono placeholder="accessschedule,…" value={opts.capacityMenus} onChange={e => setOpts({ ...opts, capacityMenus: e.target.value })} /></Field>
              <Field label="Max adds"><Input mono type="number" min={1} value={opts.capacityCap} onChange={e => setOpts({ ...opts, capacityCap: Number(e.target.value) })} /></Field>
            </div>
          )}
          {levels.includes('lockout') && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Spare user" hint="Empty = the device login"><Input value={opts.lockoutUser} onChange={e => setOpts({ ...opts, lockoutUser: e.target.value })} /></Field>
              <Field label="Its password"><Input type="password" value={lockPw} disabled={!opts.lockoutUser} onChange={e => setLockPw(e.target.value)} /></Field>
            </div>
          )}
          {err && <div className="flex gap-2 text-xs text-hv-error-fg bg-hv-error-tint rounded-hv-xs p-2 ring-1 ring-inset ring-hv-error/40"><AlertTriangle size={14} className="shrink-0 mt-px" />{err}</div>}
          <div className="flex gap-2">
            {running ? (
              <Button tone="danger-soft" icon={<Square size={13} />} disabled={!!(job as { stopping?: boolean })?.stopping} onClick={() => api.stop().catch(e => setErr(e.message))} className="flex-1">Stop and clean up</Button>
            ) : (
              <Button tone="primary" icon={<Play size={14} />} busy={busy} disabled={!device || !levels.length || needDoor || (levels.includes('lockout') && !!opts.lockoutUser && !lockPw)} onClick={begin} className="flex-1">Run test</Button>
            )}
          </div>
        </div>

        <div className="p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-bold uppercase tracking-wide text-hv-text-3">Saved runs</span>
            <Segmented value={scope} onChange={setScope} items={[{ id: 'device', label: 'This device' }, { id: 'all', label: 'All' }]} />
          </div>
          <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
          <Button size="sm" tone="ghost" icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()} className="justify-start">Import a report (.xlsx) from the PC script</Button>
          {runs === null ? <div className="text-xs text-hv-text-3 p-2 flex gap-2"><Loader2 size={13} className="animate-spin" />Loading…</div>
            : !shown.length ? <div className="text-xs text-hv-text-3 p-2">No runs {scope === 'device' ? 'for this device ' : ''}yet.</div>
              : shown.map(r => (
                <button key={r.id} onClick={() => setSel(r.id)}
                  className={cx('text-left rounded-hv-xs px-2.5 py-2 ring-1 ring-inset transition-colors', sel === r.id ? 'bg-hv-brand-tint ring-hv-brand/40' : 'ring-transparent hover:bg-hv-widget')}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-semibold text-hv-text truncate flex-1">{r.firmware || '—'}</span>
                    <Badge tone={r.source === 'import' ? 'info' : stateTone(r.state)}>{r.state === 'running' && <Loader2 size={10} className="animate-spin" />}{stateLabel(r)}</Badge>
                  </div>
                  <div className="text-[11px] text-hv-text-3 truncate mt-0.5">{fmtTime(r.startedAt)} · {r.model || '?'}{scope === 'all' ? ` · ${r.deviceName}` : ''}</div>
                  <div className="mt-1"><Counts counts={r.counts || {}} /></div>
                </button>
              ))}
        </div>
      </div>

      {/* right: live progress or the selected report */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {liveSel && job ? <LiveView job={job} events={events} />
          : sel ? <RunView key={sel} api={api} id={sel} onDeleted={() => { setSel(null); loadRuns(); }} onCompare={onCompare} />
            : <Empty icon={<Gauge size={30} />} title="Find out what this controller can really do"
              action={device && <Button tone="primary" icon={<Play size={14} />} disabled={!levels.length} onClick={begin}>Run the read-only tests</Button>}>
              The Pi runs nhp_limits.py against the selected device: declared limits from its own spec, measured limits by pushing each area,
              and every change checked by reading it back. Reports are saved here, with an Excel download, and two runs can be compared on the Compare tab.
            </Empty>}
      </div>

      <Dialog open={confirm} title="These tests change the controller" onClose={() => setConfirm(false)} width={500}
        footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button tone="primary" busy={busy} disabled={risky.some(r => !ack[r.risk!])} onClick={start}>Start</Button></>}>
        <div className="flex flex-col gap-3">
          {isMock
            ? <p className="rounded-hv-xs p-2 bg-hv-info-tint text-hv-text ring-1 ring-inset ring-hv-info/40">This is the built-in mock controller: nothing real moves and nothing reaches the cloud. Confirm to rehearse.</p>
            : <p>Run these only on a lab controller that is not claimed in the cloud: a connected Cloud Connector publishes door tests as real events, and its sync can remove or fight the test objects.</p>}
          {risky.map(r => (
            <label key={r.id} className="flex gap-2.5 items-start rounded-hv-xs p-2.5 bg-hv-warning-tint ring-1 ring-inset ring-hv-warning/40 cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-hv-brand" checked={!!ack[r.risk!]} onChange={e => setAck({ ...ack, [r.risk!]: e.target.checked })} />
              <span className="text-[13px] text-hv-text">
                <b>{r.label}:</b>{' '}
                {r.risk === 'door' ? `door ${opts.doorToken} will be released for real (Access${opts.doorCommands ? `, ${opts.doorCommands}` : ''}), then restored with Lock. Someone should watch the door.`
                  : r.risk === 'capacity' ? `test objects named ZZT… are added until the controller refuses${opts.capacityMenus ? ` (${opts.capacityMenus})` : ' in every object menu'}, then removed. Up to ${opts.capacityCap} adds per menu.`
                    : `wrong passwords are sent for ${opts.lockoutUser || device?.user || 'the device login'} until it locks. That login may be locked for minutes.`}
                <span className="block text-hv-text-3 text-xs mt-0.5">I understand.</span>
              </span>
            </label>
          ))}
        </div>
      </Dialog>
    </div>
  );
};

const LiveView: React.FC<{ job: Job; events: RunEvent[] }> = ({ job, events }) => {
  const lv = levelList(job.levels);
  const done = new Set(events.map(e => e.level));
  const list = [...events].reverse();
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-5 py-4 border-b border-hv-line flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={stateTone(job.state)}>{job.state === 'running' && <Loader2 size={10} className="animate-spin" />}{stateLabel(job)}</Badge>
          <span className="text-sm font-semibold text-hv-text">{job.deviceName}</span>
          <span className="text-xs text-hv-text-3 font-mono">{job.host}</span>
          <span className="text-xs text-hv-text-3">· started {fmtTime(job.startedAt)}</span>
          <span className="ml-auto"><Counts counts={job.counts || {}} /></span>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {lv.map(l => {
            const cur = job.level === l && job.state === 'running';
            const fin = done.has(l) && !cur;
            return (
              <span key={l} className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-hv-xs text-xs font-semibold ring-1 ring-inset',
                cur ? 'bg-hv-brand-tint text-hv-brand-fg ring-hv-brand/40' : fin ? 'bg-hv-success-tint text-hv-success-fg ring-hv-success/40' : 'bg-hv-widget text-hv-text-3 ring-hv-line-strong')}>
                {cur ? <Loader2 size={11} className="animate-spin" /> : fin ? <CheckCircle2 size={11} /> : <CircleSlash size={11} className="opacity-50" />}
                {LEVELS.find(x => x.id === l)?.label || l}
              </span>
            );
          })}
        </div>
        {job.error && <div className="text-xs text-hv-error-fg bg-hv-error-tint rounded-hv-xs p-2 ring-1 ring-inset ring-hv-error/40">{job.error}</div>}
        {job.state === 'running' && job.outputTail?.length > 0 && <div className="font-mono text-[11px] text-hv-text-3 truncate">{job.outputTail[job.outputTail.length - 1]}</div>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {job.steps && job.steps.length > 0 && <div className="p-4 pb-0"><PushSequence steps={job.steps} live={job.state === 'running'} /></div>}
        {!list.length ? <div className="p-8 text-center text-sm text-hv-text-3 flex items-center justify-center gap-2"><Loader2 size={15} className="animate-spin" />Logging in and reading the controller…</div> : (
          <table className="w-full text-[13px] border-separate border-spacing-0">
            <thead className="sticky top-0"><tr>{['Result', 'ID', 'Test', 'Measured'].map(h => <th key={h} className="text-left text-[11px] font-semibold uppercase tracking-wide text-hv-text-3 bg-hv-box px-3 h-9 border-b border-hv-line">{h}</th>)}</tr></thead>
            <tbody>{list.map((e, i) => (
              <tr key={`${e.id}-${i}`} className="hover:bg-hv-widget">
                <td className="px-3 py-2 border-b border-hv-line"><Badge tone={resultTone(e.result)}>{e.result}</Badge></td>
                <td className="px-3 py-2 border-b border-hv-line font-mono text-[12px] text-hv-text-2 whitespace-nowrap">{e.id}</td>
                <td className="px-3 py-2 border-b border-hv-line text-hv-text whitespace-nowrap">{e.test}</td>
                <td className="px-3 py-2 border-b border-hv-line font-mono text-[12px] text-hv-text-2 break-words max-w-[640px]">{e.measured}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const RunView: React.FC<{ api: ReturnType<typeof limitsClient>; id: string; onDeleted: () => void; onCompare: (a: string, b?: string) => void }> = ({ api, id, onDeleted, onCompare }) => {
  const [run, setRun] = useState<(RunMeta & { report: Report | null }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<(typeof VIEWS)[number]>(() => lsGet('aether.sunapi.limits.view', 'Overview'));
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [askDel, setAskDel] = useState(false);
  useEffect(() => { api.run(id).then(setRun).catch(e => setErr(e.message)); }, [api, id]);
  useEffect(() => lsSet('aether.sunapi.limits.view', view), [view]);
  if (err) return <Empty icon={<AlertTriangle size={26} />} title="Could not open this run">{err}</Empty>;
  if (!run) return <div className="h-full flex items-center justify-center gap-2 text-sm text-hv-text-3"><Loader2 size={15} className="animate-spin" />Loading report…</div>;
  const rep = run.report;
  const m = reportMeta(rep);
  const findings = rowsOf(rep, 'Results').filter(r => ['FAIL', 'ERROR', 'LIMIT'].includes(String(r.Result)));
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-5 py-4 border-b border-hv-line flex flex-col gap-2.5">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-base font-bold text-hv-text">{run.firmware || m.Firmware || 'Firmware unknown'}</span>
              <Badge tone={run.source === 'import' ? 'info' : stateTone(run.state)}>{stateLabel(run)}</Badge>
            </div>
            <div className="text-xs text-hv-text-3 mt-1">
              {[run.model || m.Model, run.source === 'import' ? run.fileName : run.deviceName, m.Controller, m.Started || fmtTime(run.startedAt), m['Duration (s)'] && `${m['Duration (s)']} s`, m.Tool].filter(Boolean).join(' · ')}
            </div>
            <div className="text-xs text-hv-text-3 mt-0.5">Levels: {levelList(run.levels).join(', ') || m['Levels run']}</div>
          </div>
          <div className="ml-auto flex gap-2 flex-wrap">
            <Button size="sm" icon={<GitCompareArrows size={13} />} onClick={() => onCompare(run.id)}>Compare…</Button>
            <a href={api.xlsxUrl(run.id)} className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-semibold rounded-hv-xs bg-hv-widget text-hv-text ring-1 ring-inset ring-hv-line-strong hover:bg-hv-box"><Download size={13} />Excel report</a>
            <Button size="sm" tone="ghost" icon={<Trash2 size={13} />} onClick={() => setAskDel(true)}>Delete</Button>
          </div>
        </div>
        {run.error && <div className="text-xs text-hv-error-fg bg-hv-error-tint rounded-hv-xs p-2 ring-1 ring-inset ring-hv-error/40">{run.error}</div>}
        {rep && (
          <div className="flex items-center gap-2 flex-wrap">
            <Counts counts={run.counts || {}} />
            {findings.length > 0 && <span className="text-xs text-hv-text-3 inline-flex items-center gap-1"><ShieldAlert size={13} />{findings.length} findings: the FAIL / ERROR / LIMIT rows</span>}
          </div>
        )}
        {rep && <AskBox key={run.id} answer={qq => ask(qq, rep)} examples={EXAMPLES} />}
      </div>
      {!rep ? <Empty icon={<AlertTriangle size={26} />} title="This run left no report">{run.state === 'error' ? 'The test stopped before it could write one. The error is above.' : 'Nothing was saved.'}</Empty> : (
        <>
          <div className="px-5 py-2.5 flex items-center gap-3 flex-wrap border-b border-hv-line">
            <Segmented value={view} onChange={setView} items={VIEWS.filter(v => BUILT_IN.has(v) || rep.sheets[v]).map(v => ({ id: v, label: v }))} />
            {view !== 'Overview' && <Input className="!w-56" placeholder="Filter rows…" value={q} onChange={e => setQ(e.target.value)} />}
            {SHEET_COLS[view] && <label className="text-xs text-hv-text-3 inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-hv-brand" checked={all} onChange={e => setAll(e.target.checked)} />All columns</label>}
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {view === 'Overview' ? <Overview report={rep} steps={run.steps} /> : view === 'OnCAFE' ? <OncafeSheet report={rep} q={q.trim().toLowerCase()} /> : <SheetTable report={rep} sheet={view} q={q.trim().toLowerCase()} all={all} />}
          </div>
        </>
      )}
      <Dialog open={askDel} title="Delete this run?" onClose={() => setAskDel(false)}
        footer={<><Button onClick={() => setAskDel(false)}>Cancel</Button><Button tone="danger" onClick={() => api.remove(run.id).then(onDeleted).catch(e => setErr(e.message))}>Delete</Button></>}>
        The saved report and its Excel file are removed from the Pi. This cannot be undone.
      </Dialog>
    </div>
  );
};
