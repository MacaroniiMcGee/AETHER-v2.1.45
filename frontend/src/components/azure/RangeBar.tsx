// AETHER_AZURE_DEBUG — the time range bar above a scan (AZURE-14).
import React from 'react';
import { CalendarClock, X } from 'lucide-react';
import { cx } from '../sunapi/ui';
import { fromWall, toWall, type TimeRange } from './timeRange';

const H = 3600000;
const PRESETS: { id: string; label: string; ms: number | null }[] = [
  { id: 'all', label: 'Whole log', ms: null },
  { id: '1h', label: 'Last hour', ms: H },
  { id: '6h', label: 'Last 6 h', ms: 6 * H },
  { id: '24h', label: 'Last 24 h', ms: 24 * H },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * H },
];

export const RangeBar: React.FC<{
  span: TimeRange; tz?: string; range: TimeRange | null; onChange: (r: TimeRange | null) => void;
  keepUntimed: boolean; onKeepUntimed: (v: boolean) => void; shown: number; total: number;
}> = ({ span, tz, range, onChange, keepUntimed, onKeepUntimed, shown, total }) => {
  const r = range || span;
  const lo = toWall(span.from, tz), hi = toWall(span.to + 60000, tz);
  const set = (from: number | null, to: number | null) => {
    if (from == null || to == null) return;
    if (from > to) [from, to] = [to, from];
    onChange(from <= span.from && to >= span.to ? null : { from, to });
  };
  const preset = (ms: number | null) => (ms == null || span.to - ms <= span.from ? onChange(null) : onChange({ from: span.to - ms, to: span.to }));
  const active = (ms: number | null) => (ms == null ? !range : !!range && range.to === span.to && range.from === span.to - ms);
  const field = 'h-7 rounded-hv-xs bg-hv-surface px-2 text-[12px] text-hv-text ring-1 ring-inset ring-hv-line-strong outline-none focus:ring-hv-info';
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-hv-line shrink-0 text-[12px]', range ? 'bg-hv-info-tint' : 'bg-hv-widget')}>
      <span className="inline-flex items-center gap-1.5 font-semibold text-hv-text-2"><CalendarClock size={14} /> Time range</span>
      <label className="inline-flex items-center gap-1.5 text-hv-text-3">From
        <input type="datetime-local" className={field} value={toWall(r.from, tz)} min={lo} max={hi}
          onChange={e => set(fromWall(e.target.value, tz), r.to)} aria-label="Show alerts from" />
      </label>
      <label className="inline-flex items-center gap-1.5 text-hv-text-3">to
        <input type="datetime-local" className={field} value={toWall(r.to, tz)} min={lo} max={hi}
          onChange={e => { const t = fromWall(e.target.value, tz); set(r.from, t == null ? null : t + 59999); }} aria-label="Show alerts until" />
      </label>
      <span className="text-hv-text-3">{tz || 'UTC'}</span>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(p => (
          <button key={p.id} onClick={() => preset(p.ms)}
            className={cx('h-6 px-2 rounded-full ring-1 ring-inset text-[11.5px]', active(p.ms) ? 'bg-hv-brand text-white ring-hv-brand' : 'ring-hv-line-strong text-hv-text-2 hover:bg-hv-box')}>{p.label}</button>
        ))}
      </div>
      <label className="inline-flex items-center gap-1.5 text-hv-text-2" title="Configuration checks (addresses, baud rates, missing settings) have no time in the log. Keep them on screen while a range is set?">
        <input type="checkbox" checked={keepUntimed} onChange={e => onKeepUntimed(e.target.checked)} /> Keep config checks
      </label>
      <span className="ml-auto text-hv-text-2">
        {range ? <>Showing <b className="text-hv-text">{shown}</b> of {total} alerts</> : <>{total} alerts in the whole log</>}
      </span>
      {range && <button onClick={() => onChange(null)} className="inline-flex items-center gap-1 text-hv-info-fg hover:underline"><X size={12} /> Clear</button>}
    </div>
  );
};
