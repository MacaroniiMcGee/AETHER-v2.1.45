// AETHER_SUNAPI_LIMITS — Compare: two limits reports (firmware A vs firmware B), field by field.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, ClipboardCopy, FileSpreadsheet, FileUp, GitCompareArrows, Loader2 } from 'lucide-react';
import { PairChart } from './charts';
import { confLabel, oncafeRows } from './oncafe';
import { limitsClient, runLabel, type RunMeta } from './limitsApi';
import { compare, meta as reportMeta, rowText, type Change, type Report, type Row, type Section, type Seg, type Status } from './limitsDiff';
import { Badge, Button, Empty, Input, Segmented, Select, Toggle, copyText, cx, lsGet, lsSet, type Tone } from './ui';
import { resultTone } from './LimitsTest';
import { AskBox } from './AskBox';
import { askCompare, COMPARE_EXAMPLES } from './ask';

const ST: Record<Status, [string, Tone]> = {
  worse: ['Worse', 'error'], better: ['Better', 'success'], changed: ['Changed', 'warning'],
  new: ['New in B', 'info'], removed: ['Only in A', 'info'], values: ['Numbers only', 'neutral'], same: ['Same', 'neutral'],
};
const SUMMARY_ORDER: Status[] = ['worse', 'changed', 'new', 'removed', 'better', 'values'];
const toNum = (v: string | null) => { if (v == null) return null; const n = parseFloat(String(v).replace(/^>=?/, '')); return /^\s*>?=?\s*-?[\d.]+\s*$/.test(v) && Number.isFinite(n) ? n : null; };

/** OnCAFE section: every OnCAFE term, A vs B. */
function oncafeSection(A: Report, B: Report): Section {
  const ra = oncafeRows(A), rb = oncafeRows(B);
  const terms = [...new Set([...ra.map(r => r.term), ...rb.map(r => r.term)])];
  const rows: Row[] = terms.map(t => {
    const a = ra.find(r => r.term === t), b = rb.find(r => r.term === t), r = (a || b)!;
    const na = a?.num ?? null, nb = b?.num ?? null;
    let st: Status = !a ? 'new' : !b ? 'removed' : a.value === b.value ? 'same' : 'changed';
    let head: string | undefined;
    if (st === 'changed' && na != null && nb != null) {
      const d = nb - na, lowerBetter = /delay/i.test(t);
      head = `${d > 0 ? '+' : ''}${+d.toFixed(3)}${na ? ` (${d > 0 ? '+' : ''}${((d / Math.abs(na)) * 100).toFixed(0)}%)` : ''}`;
      if (/delay/i.test(t) && Math.abs(d) < 0.25) st = 'values';
      else st = (d > 0) !== lowerBetter ? 'better' : 'worse';
    }
    return { st, key: t, label: `${r.what} · ${r.sunapi} · ${confLabel[r.conf]}`, a: a ? a.value : null, b: b ? b.value : null, head,
      changes: st === 'changed' && (na == null || nb == null) ? [{ kind: 'val', path: '', a: a!.value, b: b!.value, n: 1 }] : [],
      note: !a ? 'Only in B' : !b ? 'Only in A' : r.note };
  });
  const ORDER: Record<Status, number> = { worse: 0, changed: 1, new: 2, removed: 3, better: 4, values: 5, same: 6 };
  rows.sort((x, y) => ORDER[x.st] - ORDER[y.st]);
  return { id: 'oncafe', label: 'OnCAFE', item: 'OnCAFE term', rows, note: 'Controller limits under the names OnCAFE uses (AccessProfile = Access Level). Higher counts are better; a shorter event delay is better.' };
}

const Segs: React.FC<{ segs?: Seg[]; text: string | null }> = ({ segs, text }) =>
  text == null ? <span className="italic text-hv-text-3 font-sans">not in this report</span>
    : !segs ? <>{text}</>
      : <>{segs.map((s, i) => s.m ? <mark key={i} className={cx('rounded-[2px] px-px', s.m === 'a' ? 'bg-hv-error-tint text-hv-error-fg' : 'bg-hv-success-tint text-hv-success-fg')}>{s.t}</mark> : <React.Fragment key={i}>{s.t}</React.Fragment>)}</>;

const Old: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="font-mono text-[12px] rounded-[3px] px-1 bg-hv-error-tint text-hv-error-fg">{children}</span>;
const New: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="font-mono text-[12px] rounded-[3px] px-1 bg-hv-success-tint text-hv-success-fg">{children}</span>;
const ChangeItem: React.FC<{ c: Change }> = ({ c }) => {
  const n = 'n' in c && c.n > 1 ? <span className="text-hv-text-3 text-xs"> ({c.n}×)</span> : null;
  if (c.kind === 'val') return <li>{c.path && <code className="font-mono text-[12px] text-hv-text">{c.path}: </code>}<Old>{c.a}</Old> → <New>{c.b}</New>{n}</li>;
  if (c.kind === 'onlyA') return <li><code className="font-mono text-[12px] text-hv-text">{c.path}</code>: <Old>only in A</Old>{c.v ? <span className="text-hv-text-3 text-xs"> (was {c.v})</span> : null}{n}</li>;
  if (c.kind === 'onlyB') return <li><code className="font-mono text-[12px] text-hv-text">{c.path}</code>: <New>new in B</New>{c.v ? <span className="text-hv-text-3 text-xs"> ({c.v})</span> : null}{n}</li>;
  if (c.kind === 'add') return <li className="flex flex-wrap gap-1">{c.items.map(i => <New key={i}>+{i}</New>)}</li>;
  if (c.kind === 'rem') return <li className="flex flex-wrap gap-1">{c.items.map(i => <Old key={i}>−{i}</Old>)}</li>;
  return <li className="text-hv-text-2">{'text' in c ? c.text : ''}</li>;
};
const What: React.FC<{ r: Row }> = ({ r }) => (
  <div className="flex flex-col gap-1">
    {r.head && <div className="font-semibold text-hv-text">{r.head}</div>}
    {r.changes.length > 0 && <ul className="list-disc pl-4 flex flex-col gap-0.5">{r.changes.slice(0, 12).map((c, i) => <ChangeItem key={i} c={c} />)}{r.changes.length > 12 && <li className="text-hv-text-3 text-xs">+{r.changes.length - 12} more</li>}</ul>}
    {r.note && <div className="text-xs text-hv-text-3">{r.note}</div>}
  </div>
);

export const Compare: React.FC<{ backend: string; preset?: { a?: string; b?: string } | null }> = ({ backend, preset }) => {
  const api = useMemo(() => limitsClient(backend), [backend]);
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [aId, setA] = useState<string>(() => preset?.a || lsGet('aether.sunapi.cmp.a', ''));
  const [bId, setB] = useState<string>(() => preset?.b || lsGet('aether.sunapi.cmp.b', ''));
  const [reps, setReps] = useState<Record<string, Report | null>>({});
  const [err, setErr] = useState<string | null>(null);
  const [sec, setSec] = useState<string>(() => lsGet('aether.sunapi.cmp.sec', 'oncafe'));
  const [only, setOnly] = useState(true);
  const [vals, setVals] = useState(false);
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const importTo = useRef<'a' | 'b'>('b');

  const load = () => api.runs().then(r => { const done = r.filter(x => x.state !== 'running'); setRuns(done); return done; }).catch(e => { setErr(e.message); setRuns([]); return [] as RunMeta[]; });
  useEffect(() => {
    load().then(r => {
      // sensible defaults: B = newest, A = newest other firmware from the same model
      if (preset?.a && !preset.b) { const other = r.find(x => x.id !== preset.a && x.firmware !== r.find(y => y.id === preset.a)?.firmware); setA(preset.a); setB(other?.id || ''); }
      else if (!r.some(x => x.id === bId) || !r.some(x => x.id === aId)) {
        const b = r[0]; const a = b && r.find(x => x.id !== b.id && x.model === b.model && x.firmware !== b.firmware);
        if (b) setB(b.id); if (a) setA(a.id);
      }
    });
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lsSet('aether.sunapi.cmp.a', aId); lsSet('aether.sunapi.cmp.b', bId); }, [aId, bId]);
  useEffect(() => lsSet('aether.sunapi.cmp.sec', sec), [sec]);
  useEffect(() => {
    for (const id of [aId, bId]) if (id && !(id in reps)) {
      setReps(r => ({ ...r, [id]: null }));
      api.run(id).then(x => setReps(r => ({ ...r, [id]: x.report }))).catch(e => setErr(e.message));
    }
  }, [aId, bId]); // eslint-disable-line react-hooks/exhaustive-deps

  const A = aId ? reps[aId] : null, B = bId ? reps[bId] : null;
  const sections: Section[] = useMemo(() => (A && B ? [oncafeSection(A, B), ...compare(A, B)] : []), [A, B]);
  const cur = sections.find(s => s.id === sec) || sections[0];
  const mA = reportMeta(A), mB = reportMeta(B);
  const tally = (rows: Row[]) => rows.reduce((c, r) => ({ ...c, [r.st]: (c[r.st] || 0) + 1 }), {} as Record<string, number>);
  const total = tally(sections.flatMap(s => s.rows));
  const visible = (cur?.rows || []).filter(r => (!only || (r.st !== 'same' && (r.st !== 'values' || vals))) && (!q || `${r.key} ${r.label} ${r.a} ${r.b} ${rowText(r)}`.toLowerCase().includes(q.toLowerCase())));

  const warnings: string[] = [];
  if (A && B) {
    if (mA.Model && mB.Model && mA.Model !== mB.Model) warnings.push(`Different models (${mA.Model} vs ${mB.Model}): differences may come from the hardware, not the firmware.`);
    if (mA.Firmware && mA.Firmware === mB.Firmware) warnings.push('Both reports show the same firmware.');
    if (mA['Levels run'] !== mB['Levels run']) warnings.push(`Different test levels were run (A: ${mA['Levels run'] || '?'}; B: ${mB['Levels run'] || '?'}). Tests from a level run only once show as New in B / Only in A.`);
    if (mA.Tool && mB.Tool && mA.Tool !== mB.Tool) warnings.push(`Reports come from different script versions (${mA.Tool} / ${mB.Tool}).`);
  }
  const worse = sections.filter(s => s.id === 'results' || s.id === 'push').flatMap(s => s.rows).filter(r => r.st === 'worse').length;
  const api_ = sections.find(s => s.id === 'api')?.rows || [];

  const copy = (what: 'csv' | 'summary') => {
    let t = '';
    if (what === 'csv' && cur) {
      const esc = (v: unknown) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
      t = [['Status', cur.item, 'Detail', `A ${mA.Firmware || ''}`, `B ${mB.Firmware || ''}`, 'What changed'].map(esc).join(',')]
        .concat(visible.map(r => [ST[r.st][0], r.key, r.label, `${r.ra ? r.ra + ': ' : ''}${r.a ?? ''}`, `${r.rb ? r.rb + ': ' : ''}${r.b ?? ''}`, rowText(r)].map(esc).join(','))).join('\n');
    } else {
      const out = [`NHP firmware comparison: ${mA.Firmware || 'A'} -> ${mB.Firmware || 'B'} (${mB.Model || mA.Model || ''})`, ''];
      for (const s of sections) {
        const rows = s.rows.filter(r => r.st !== 'same' && r.st !== 'values');
        if (!rows.length) continue;
        out.push(`${s.label}:`);
        rows.forEach(r => out.push(`  [${ST[r.st][0]}] ${r.key}: ${rowText(r)}`));
        out.push('');
      }
      t = out.join('\n');
    }
    copyText(t).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1600); });
  };
  const [xl, setXl] = useState(false);
  const excel = async () => {
    setXl(true); setErr(null);
    try {
      const head = ['Status', 'Item', 'Detail', `A ${mA.Firmware || ''}`, `B ${mB.Firmware || ''}`, 'What changed'];
      const sheets: Record<string, unknown[][]> = {
        Summary: [['Field', 'A', 'B'], ...['Firmware', 'Model', 'Controller', 'Started', 'Levels run', 'Tool'].map(k => [k, mA[k] || '', mB[k] || '']),
          [], ['Status', 'Rows', ''], ...SUMMARY_ORDER.map(k => [ST[k][0], total[k] || 0, ''])],
      };
      for (const s of sections) sheets[s.label] = [head, ...s.rows.filter(r => r.st !== 'same').map(r => [ST[r.st][0], r.key, r.label, `${r.ra ? r.ra + ': ' : ''}${r.a ?? ''}`, `${r.rb ? r.rb + ': ' : ''}${r.b ?? ''}`, rowText(r)])];
      const blob = await api.exportXlsx(`compare ${mA.Firmware} vs ${mB.Firmware}`, sheets);
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `nhp-compare-${(mA.Firmware || 'A').replace(/[^\w.-]/g, '_')}-vs-${(mB.Firmware || 'B').replace(/[^\w.-]/g, '_')}.xlsx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setErr((e as Error).message); }
    setXl(false);
  };
  const importFile = (f: File) => { setErr(null); api.importXlsx(f).then(m => load().then(() => (importTo.current === 'a' ? setA(m.id) : setB(m.id)))).catch(e => setErr(e.message)); };

  const Slot: React.FC<{ side: 'A' | 'B'; id: string; set: (v: string) => void; m: Record<string, string> }> = ({ side, id, set, m }) => (
    <div className={cx('flex-1 min-w-[260px] rounded-hv-xs ring-1 ring-inset ring-hv-line p-3 flex flex-col gap-2 bg-hv-widget border-t-[3px]', side === 'A' ? 'border-hv-info' : 'border-hv-brand')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cx('text-[11px] font-bold uppercase tracking-wide', side === 'A' ? 'text-hv-info-fg' : 'text-hv-brand-fg')}>{side === 'A' ? 'A · baseline' : 'B · new firmware'}</span>
        <Button size="sm" tone="ghost" icon={<FileUp size={12} />} onClick={() => { importTo.current = side === 'A' ? 'a' : 'b'; fileRef.current?.click(); }}>Import .xlsx</Button>
      </div>
      <Select value={id} onChange={e => set(e.target.value)}>
        <option value="">Choose a saved run…</option>
        {(runs || []).map(r => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}
      </Select>
      <div className="font-mono text-[15px] font-bold text-hv-text truncate">{m.Firmware || (id ? '…' : '—')}</div>
      <div className="text-[11.5px] text-hv-text-3 truncate">{[m.Model, m.Controller, m.Started, m['Levels run'] && `levels: ${m['Levels run']}`].filter(Boolean).join(' · ')}</div>
    </div>
  );

  if (runs === null) return <div className="h-full flex items-center justify-center gap-2 text-sm text-hv-text-3"><Loader2 size={15} className="animate-spin" />Loading saved runs…</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 flex flex-col gap-3">
        <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
        <div className="flex gap-3 items-stretch flex-wrap">
          <Slot side="A" id={aId} set={setA} m={mA} />
          <button className="self-center w-9 h-9 rounded-full ring-1 ring-inset ring-hv-line-strong bg-hv-widget text-hv-text-3 hover:text-hv-text flex items-center justify-center" title="Swap A and B" aria-label="Swap A and B" onClick={() => { setA(bId); setB(aId); }}><ArrowLeftRight size={15} /></button>
          <Slot side="B" id={bId} set={setB} m={mB} />
        </div>
        {err && <div className="flex gap-2 text-xs text-hv-error-fg bg-hv-error-tint rounded-hv-xs p-2 ring-1 ring-inset ring-hv-error/40"><AlertTriangle size={14} className="shrink-0" />{err}</div>}

        {!runs.length ? (
          <Empty icon={<GitCompareArrows size={30} />} title="No saved runs yet">Run a limits test on each firmware (Limits test tab), or import reports made with the PC script, then pick them here.</Empty>
        ) : !aId || !bId ? (
          <Empty icon={<GitCompareArrows size={30} />} title="Pick two runs to compare">A is the baseline firmware, B the new one. Rows are matched by test name, and each change lists exactly which fields moved.</Empty>
        ) : !A || !B ? (
          <div className="p-8 flex items-center justify-center gap-2 text-sm text-hv-text-3"><Loader2 size={15} className="animate-spin" />Loading reports…</div>
        ) : (
          <>
            <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-3 flex flex-col gap-2.5">
              <div className="text-sm text-hv-text">
                <b className="font-mono">{mA.Firmware || 'A'}</b> → <b className="font-mono">{mB.Firmware || 'B'}</b>:{' '}
                {worse ? <b className="text-hv-error-fg">{worse} test{worse > 1 ? 's' : ''} got worse</b> : 'no test got worse'}, {total.better || 0} better, {total.changed || 0} changed.
                {' '}API spec: {api_.filter(r => r.st === 'new').length} added, {api_.filter(r => r.st === 'removed').length} removed.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SUMMARY_ORDER.filter(k => total[k]).map(k => <Badge key={k} tone={ST[k][1]} className="!h-6 !text-xs">{total[k]} {ST[k][0]}</Badge>)}
                {!SUMMARY_ORDER.some(k => total[k]) && <Badge tone="success">No differences</Badge>}
              </div>
              {warnings.map(w => <div key={w} className="text-xs text-hv-warning-fg bg-hv-warning-tint rounded-hv-xs px-2 py-1.5 ring-1 ring-inset ring-hv-warning/40">{w}</div>)}
              <AskBox key={`${aId}-${bId}`} answer={qq => askCompare(qq, A, B)} examples={COMPARE_EXAMPLES} placeholder="Ask about the two firmwares, e.g. “What changed for access levels?”" />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Segmented value={cur?.id || 'results'} onChange={setSec} items={sections.map(s => {
                const c = tally(s.rows), n = (c.worse || 0) + (c.changed || 0) + (c.new || 0) + (c.removed || 0) + (c.better || 0);
                return { id: s.id, label: <span className="inline-flex items-center gap-1">{s.label}<span className={cx('text-[10.5px] px-1 rounded-[3px]', c.worse ? 'bg-hv-error-tint text-hv-error-fg' : n ? 'bg-hv-warning-tint text-hv-warning-fg' : 'text-hv-text-3')}>{n}</span></span> };
              })} />
              <Input className="!w-52" placeholder="Filter rows…" value={q} onChange={e => setQ(e.target.value)} />
              <Toggle on={only} onChange={setOnly} label="Changes only" />
              <Toggle on={vals} onChange={setVals} disabled={!only} label="Number-only changes" />
              <span className="ml-auto flex gap-2">
                <Button size="sm" icon={<ClipboardCopy size={13} />} onClick={() => copy('csv')}>{copied === 'csv' ? 'Copied' : 'Copy table (CSV)'}</Button>
                <Button size="sm" icon={<ClipboardCopy size={13} />} onClick={() => copy('summary')}>{copied === 'summary' ? 'Copied' : 'Copy summary'}</Button>
                <Button size="sm" tone="primary" icon={<FileSpreadsheet size={13} />} busy={xl} onClick={excel}>Excel</Button>
              </span>
            </div>
            {cur && <p className="text-xs text-hv-text-3 -mt-1">{cur.note}</p>}
            {cur && (cur.id === 'oncafe' || cur.id === 'limits') && (() => {
              const pr = cur.rows.filter(r => ['better', 'worse', 'changed'].includes(r.st) && toNum(r.a) != null && toNum(r.b) != null)
                .map(r => ({ label: r.key, a: toNum(r.a), b: toNum(r.b), better: r.st === 'better' ? 'up' as const : r.st === 'worse' ? 'down' as const : null }));
              if (!pr.length) return null;
              const vals = pr.flatMap(r => [r.a!, r.b!]).filter(v => v > 0);
              const log = vals.length > 1 && Math.max(...vals) / Math.max(1e-9, Math.min(...vals)) > 50;
              return (
                <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-4">
                  <div className="text-sm font-bold text-hv-text">What moved{log ? ' (log scale)' : ''}</div>
                  <div className="text-xs text-hv-text-3 mb-2">Every number that changed between the two firmwares. Green difference = better, red = worse.</div>
                  <PairChart rows={pr} log={log} aName={mA.Firmware || 'A'} bName={mB.Firmware || 'B'} />
                </div>
              );
            })()}

            <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-x-auto">
              <table className="w-full text-[13px] border-separate border-spacing-0 min-w-[900px]">
                <thead>
                  <tr>
                    {['Status', cur?.item || 'Item', `A · ${mA.Firmware || ''}`, `B · ${mB.Firmware || ''}`, 'What changed'].map((h, i) => (
                      <th key={i} className={cx('text-left text-[11px] font-semibold uppercase tracking-wide bg-hv-box px-3 h-9 border-b border-hv-line whitespace-nowrap', i === 2 ? 'text-hv-info-fg' : i === 3 ? 'text-hv-brand-fg' : 'text-hv-text-3')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r, i) => (
                    <tr key={`${r.key}-${i}`} className="hover:bg-hv-widget">
                      <td className="px-3 py-2.5 border-b border-hv-line align-top"><Badge tone={ST[r.st][1]}>{ST[r.st][0]}</Badge></td>
                      <td className="px-3 py-2.5 border-b border-hv-line align-top min-w-[200px] max-w-[300px]">
                        <div className="font-mono text-[12.5px] text-hv-text break-words">{r.key}</div>
                        {r.label && <div className="text-xs text-hv-text-3 mt-0.5 break-words">{r.label}</div>}
                      </td>
                      {(['a', 'b'] as const).map(side => (
                        <td key={side} className="px-3 py-2.5 border-b border-hv-line align-top font-mono text-[12px] text-hv-text-2 break-words max-w-[300px]">
                          {(side === 'a' ? r.ra : r.rb) && <Badge tone={resultTone(String(side === 'a' ? r.ra : r.rb))} className="mr-1.5 font-sans">{side === 'a' ? r.ra : r.rb}</Badge>}
                          <Segs segs={side === 'a' ? r.segA : r.segB} text={side === 'a' ? r.a : r.b} />
                        </td>
                      ))}
                      <td className="px-3 py-2.5 border-b border-hv-line align-top min-w-[280px] max-w-[380px] text-hv-text-2 break-words"><What r={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visible.length && <div className="p-6 text-center text-sm text-hv-text-3">No differences in {cur?.label.toLowerCase()}{only ? '. Turn off “Changes only” to see every row.' : '.'}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
