// AETHER_SUNAPI — results of one request sent to many devices
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import type { BatchItem } from './api';
import { flatBody, parseBody } from './catalog';
import { ResponseView } from './ResponseView';
import { KindIcon } from './kinds';
import { Badge, Button, Input, Segmented, Toggle, cx, download, statusTone } from './ui';

export interface FleetRun { label: string; action: string; ms: number; items: BatchItem[]; mismatches?: Record<string, [string, string, string][] | null> }

const failOf = (body?: string) => {
  if (!body) return null;
  const p = parseBody(body);
  if (p.kind === 'json' && p.data && typeof p.data === 'object' && (p.data as Record<string, unknown>).Response === 'Fail') {
    const e = (p.data as { Error?: { Code?: number; Details?: string } }).Error || {};
    return `Refused${e.Code !== undefined ? ` (${e.Code})` : ''}${e.Details ? `: ${e.Details}` : ''}`;
  }
  return null;
};

export const FleetResults: React.FC<{ run: FleetRun }> = ({ run }) => {
  const ok = run.items.filter(i => i.result && i.result.status === 200 && !failOf(i.result.body));
  const refused = run.items.filter(i => i.result && (i.result.status !== 200 || failOf(i.result.body)));
  const failed = run.items.filter(i => i.error);
  const skipped = run.items.filter(i => i.skipped);
  const canCompare = run.action === 'view' && ok.length > 1 && ok.every(i => i.result!.bodyEncoding === 'utf8');
  const [view, setView] = useState<'compare' | 'devices'>(canCompare ? 'compare' : 'devices');
  useEffect(() => { setView(canCompare ? 'compare' : 'devices'); }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  const slow = Math.max(0, ...run.items.map(i => i.result?.ms || 0));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2.5 border-b border-hv-line flex items-center gap-2 flex-wrap">
        <Badge tone="neutral">{run.items.length} devices</Badge>
        {ok.length > 0 && <Badge tone="success">{ok.length} OK</Badge>}
        {refused.length > 0 && <Badge tone="warning">{refused.length} refused</Badge>}
        {failed.length > 0 && <Badge tone="error">{failed.length} no answer</Badge>}
        {skipped.length > 0 && <Badge tone="neutral">{skipped.length} skipped</Badge>}
        <span className="text-xs text-hv-text-3 font-mono">{run.ms} ms total · slowest {slow} ms</span>
        {canCompare && <div className="ml-auto"><Segmented value={view} onChange={setView} items={[{ id: 'compare', label: 'Compare' }, { id: 'devices', label: 'Per device' }]} /></div>}
      </div>
      <div className="flex-1 min-h-0">
        {view === 'compare' && canCompare ? <Compare items={ok} label={run.label} /> : <PerDevice run={run} />}
      </div>
    </div>
  );
};

const Compare: React.FC<{ items: BatchItem[]; label: string }> = ({ items, label }) => {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [q, setQ] = useState('');
  const flats = useMemo(() => items.map(i => flatBody(i.result!.body)), [items]);
  const fields = useMemo(() => { const s: string[] = []; for (const f of flats) for (const k of Object.keys(f)) if (!s.includes(k)) s.push(k); return s; }, [flats]);
  const rows = useMemo(() => fields.map(k => {
    const vals = flats.map(f => f[k]);
    const counts = new Map<string, number>(); for (const v of vals) counts.set(v ?? '∅', (counts.get(v ?? '∅') || 0) + 1);
    const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { k, vals, differs: counts.size > 1, majority };
  }), [fields, flats]);
  const diffCount = rows.filter(r => r.differs).length;
  const f = q.toLowerCase();
  const shown = rows.filter(r => (!onlyDiff || r.differs) && (!f || r.k.toLowerCase().includes(f) || r.vals.some(v => (v || '').toLowerCase().includes(f))));
  const outliers = items.map((_, i) => rows.filter(r => r.differs && (r.vals[i] ?? '∅') !== r.majority).length);

  const csv = () => {
    const esc = (s?: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [['Field', ...items.map(i => `${i.name} (${i.host})`)].map(esc).join(',')];
    for (const r of rows) lines.push([r.k, ...r.vals].map(esc).join(','));
    download(`sunapi-${label}-${items.length}-devices.csv`.replace(/[^\w.-]+/g, '_'), lines.join('\r\n'), 'text/csv');
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
        <span className={cx('text-sm', diffCount ? 'text-hv-text' : 'text-hv-success-fg')}>
          {diffCount ? <><b>{diffCount}</b> of {rows.length} fields differ between devices</> : <>All {items.length} devices agree on all {rows.length} fields.</>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-40"><Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-hv-text-3" /><Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter" className="h-7 pl-7 text-xs" /></div>
          <Toggle on={onlyDiff} onChange={setOnlyDiff} label="Only differences" />
          <Button size="sm" icon={<Download size={13} />} onClick={csv}>CSV</Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
        <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-auto">
          <table className="text-[12.5px] border-separate border-spacing-0 min-w-full">
            <thead><tr className="bg-hv-widget">
              <th className="sticky left-0 top-0 z-10 bg-hv-widget text-left font-semibold text-hv-text-3 px-3 py-1.5 border-b border-hv-line">Field</th>
              {items.map((i, n) => (
                <th key={i.deviceId} className="sticky top-0 bg-hv-widget text-left px-3 py-1.5 border-b border-hv-line whitespace-nowrap min-w-[120px]">
                  <span className="flex items-center gap-1.5 font-semibold text-hv-text-2"><KindIcon kind={i.kind} size={13} className="text-hv-text-3" />{i.name}</span>
                  <span className="block text-[10.5px] font-normal text-hv-text-3 font-mono">{i.host}{outliers[n] ? <span className="text-hv-warning-fg font-sans"> · {outliers[n]} odd</span> : ''}</span>
                </th>
              ))}
            </tr></thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.k}>
                  <td className="sticky left-0 bg-hv-widget-panel font-mono text-[12px] text-hv-text-3 px-3 py-1 border-b border-hv-line/60 whitespace-nowrap max-w-[220px] truncate" title={r.k}>{r.k.replace(/^[A-Za-z]+\[(\d+)\]\./, '[$1] ')}</td>
                  {r.vals.map((v, n) => {
                    const odd = r.differs && (v ?? '∅') !== r.majority;
                    return <td key={n} className={cx('px-3 py-1 border-b border-hv-line/60 whitespace-nowrap font-mono', odd ? 'bg-hv-warning-tint text-hv-warning-fg font-semibold' : r.differs ? 'text-hv-text' : 'text-hv-text-2')}>{v ?? <span className="text-hv-text-disabled">missing</span>}</td>;
                  })}
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={items.length + 1} className="px-3 py-6 text-center text-xs text-hv-text-3">{onlyDiff ? 'No differences — turn off “Only differences” to see every field.' : 'Nothing matches.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-hv-text-3 mt-2">Highlighted values differ from what most devices report.</p>
      </div>
    </div>
  );
};

const PerDevice: React.FC<{ run: FleetRun }> = ({ run }) => {
  const [open, setOpen] = useState<string | null>(run.items.length === 1 ? run.items[0].deviceId : null);
  return (
    <div className="h-full overflow-auto">
      {run.items.map(i => {
        const r = i.result;
        const fail = failOf(r?.body);
        const mm = run.mismatches?.[i.deviceId];
        const isOpen = open === i.deviceId;
        return (
          <div key={i.deviceId} className="border-b border-hv-line/60">
            <button onClick={() => setOpen(isOpen ? null : i.deviceId)} disabled={!r} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-hv-widget disabled:hover:bg-transparent">
              {r ? (isOpen ? <ChevronDown size={14} className="text-hv-text-3" /> : <ChevronRight size={14} className="text-hv-text-3" />) : <span className="w-[14px]" />}
              <KindIcon kind={i.kind} size={15} className="text-hv-text-3" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-hv-text truncate">{i.name} <span className="text-hv-text-3 font-mono text-[11px]">{i.host}{i.model ? ` · ${i.model}` : ''}</span></span>
                <span className={cx('block text-[11px]', i.error ? 'text-hv-error-fg' : fail ? 'text-hv-warning-fg' : 'text-hv-text-3')}>
                  {i.skipped ? `Skipped — ${i.skipped}` : i.error ? i.error : fail ? fail
                    : mm === undefined ? `${r!.ms} ms` : mm === null ? `${r!.ms} ms · could not read back`
                      : mm.length === 0 ? `${r!.ms} ms · read back: every value stuck`
                        : `Read back: ${mm.map(([n, want, got]) => `${n} sent ${want}, has ${got}`).join('; ')}`}
                </span>
              </span>
              {i.skipped ? <Badge>skipped</Badge> : r ? <Badge tone={fail ? 'warning' : mm && mm.length ? 'warning' : statusTone(r.status)}>{r.status}</Badge> : <Badge tone="error">ERR</Badge>}
            </button>
            {isOpen && r && <div className="h-[380px] border-t border-hv-line/60 bg-hv-surface/40"><ResponseView r={r} fileBase={`${i.name}-${run.label}`.replace(/[^\w.-]+/g, '_')} /></div>}
          </div>
        );
      })}
    </div>
  );
};
