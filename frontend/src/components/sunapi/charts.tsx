// AETHER_SUNAPI_LIMITS — small SVG charts in HV tokens (no chart library: the Pi may be offline).
// Colors come from CSS variables, so both themes work. Bars are drawn to one scale per chart.
import React from 'react';

const c = (name: string, a = 1) => `rgb(var(--hv-${name}) / ${a})`;
const fmt = (n: number) => (n >= 10000 ? `${+(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${+n.toFixed(n < 1 ? 3 : n < 10 ? 2 : 0)}`);

/** Log or linear position 0..1 for value v in [min,max]. */
function scale(v: number, max: number, log: boolean) {
  if (max <= 0) return 0;
  if (!log) return Math.max(0, v) / max;
  return Math.log10(Math.max(1, v)) / Math.log10(Math.max(10, max));
}
function ticks(max: number, log: boolean): number[] {
  if (log) { const t: number[] = []; for (let p = 1; p <= Math.max(10, max) * 1.0001; p *= 10) t.push(p); return t; }
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(1, max)))) / (max / Math.pow(10, Math.floor(Math.log10(Math.max(1, max)))) < 2.5 ? 2 : 1);
  const t: number[] = []; for (let v = 0; v <= max * 1.0001; v += step) t.push(v); return t;
}

export interface Bar { label: string; value: number | null; marker?: number | null; tone?: 'brand' | 'info' | 'success' | 'warning' | 'error' | 'data-blue'; note?: string }

/** Horizontal bars, one per row. `marker` = second value drawn as a tick (e.g. measured vs declared). */
export const HBarChart: React.FC<{ bars: Bar[]; log?: boolean; unit?: string; markerLabel?: string; barLabel?: string; width?: number }> =
  ({ bars, log, unit = '', markerLabel, barLabel, width = 720 }) => {
    const rows = bars.filter(b => b.value != null || b.marker != null);
    if (!rows.length) return null;
    const max = Math.max(...rows.map(b => Math.max(b.value || 0, b.marker || 0)), 1);
    const labelW = Math.min(210, Math.round(width * 0.36)), valW = 92, rowH = 26, top = 22, W = width, plot = W - labelW - valW - 8;
    const H = top + rows.length * rowH + 8;
    const tk = ticks(max, !!log);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} className="max-w-full h-auto block" role="img" aria-label={barLabel || 'bar chart'} style={{ fontFamily: 'inherit' }}>
        {tk.map(t => { const x = labelW + scale(t, log ? Math.max(10, max) : tk[tk.length - 1], !!log) * plot; return (
          <g key={t}><line x1={x} x2={x} y1={top - 4} y2={H - 6} stroke={c('line')} strokeWidth={1} />
            <text x={x} y={12} textAnchor="middle" fontSize={10} fill={c('text-3')}>{fmt(t)}</text></g>); })}
        {rows.map((b, i) => {
          const y = top + i * rowH, m = log ? Math.max(10, max) : tk[tk.length - 1];
          const w = b.value != null ? Math.max(2, scale(b.value, m, !!log) * plot) : 0;
          const mx = b.marker != null ? labelW + scale(b.marker, m, !!log) * plot : null;
          const tone = b.tone || 'brand';
          return (
            <g key={i}>
              <text x={labelW - 8} y={y + rowH / 2 + 4} textAnchor="end" fontSize={12} fill={c('text-2')}>{b.label.length > 30 ? b.label.slice(0, 29) + '…' : b.label}<title>{b.label}{b.note ? ` — ${b.note}` : ''}</title></text>
              {b.value != null && <rect x={labelW} y={y + 5} width={w} height={rowH - 10} rx={3} fill={c(`${tone}`, 0.75)}><title>{`${b.label}: ${b.value}${unit}`}</title></rect>}
              {mx != null && <g><line x1={mx} x2={mx} y1={y + 2} y2={y + rowH - 2} stroke={c('text')} strokeWidth={2.5} /><title>{`${markerLabel || 'marker'}: ${b.marker}${unit}`}</title></g>}
              <text x={W - valW + 4} y={y + rowH / 2 + 4} fontSize={11.5} fill={c('text')} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {b.value != null ? fmt(b.value) : '—'}{b.marker != null ? ` / ${fmt(b.marker)}` : ''}{unit}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

/** A vs B paired bars for each label. */
export const PairChart: React.FC<{ rows: { label: string; a: number | null; b: number | null; better?: 'up' | 'down' | null }[]; log?: boolean; aName: string; bName: string; width?: number }> =
  ({ rows, log, aName, bName, width = 760 }) => {
    if (!rows.length) return null;
    const max = Math.max(...rows.map(r => Math.max(r.a || 0, r.b || 0)), 1);
    const m = log ? Math.max(10, max) : max * 1.08;
    const labelW = 230, valW = 120, rowH = 34, top = 24, W = width, plot = W - labelW - valW - 8, H = top + rows.length * rowH + 6;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} className="max-w-full h-auto block" role="img" aria-label="A versus B">
        <g fontSize={11}>
          <rect x={labelW} y={4} width={10} height={10} rx={2} fill={c('info', 0.8)} /><text x={labelW + 14} y={13} fill={c('text-2')}>A · {aName}</text>
          <rect x={labelW + 200} y={4} width={10} height={10} rx={2} fill={c('brand', 0.85)} /><text x={labelW + 214} y={13} fill={c('text-2')}>B · {bName}</text>
        </g>
        {rows.map((r, i) => {
          const y = top + i * rowH;
          const wa = r.a != null ? Math.max(2, scale(r.a, m, !!log) * plot) : 0, wb = r.b != null ? Math.max(2, scale(r.b, m, !!log) * plot) : 0;
          const d = r.a != null && r.b != null ? r.b - r.a : null;
          const col = r.better === 'up' ? 'success-fg' : r.better === 'down' ? 'error-fg' : 'text-2';
          return (
            <g key={i}>
              <text x={labelW - 8} y={y + rowH / 2 + 3} textAnchor="end" fontSize={12} fill={c('text-2')}>{r.label.length > 32 ? r.label.slice(0, 31) + '…' : r.label}<title>{r.label}</title></text>
              <rect x={labelW} y={y + 4} width={wa} height={11} rx={2} fill={c('info', 0.8)}><title>{`A: ${r.a}`}</title></rect>
              <rect x={labelW} y={y + 17} width={wb} height={11} rx={2} fill={c('brand', 0.85)}><title>{`B: ${r.b}`}</title></rect>
              <text x={W - valW + 4} y={y + 13} fontSize={11} fill={c('text-3')}>{r.a != null ? fmt(r.a) : '—'} → {r.b != null ? fmt(r.b) : '—'}</text>
              {d != null && d !== 0 && <text x={W - valW + 4} y={y + 27} fontSize={11} fontWeight={600} fill={c(col)}>{d > 0 ? '+' : ''}{fmt(d)}</text>}
            </g>
          );
        })}
      </svg>
    );
  };

/** One stacked bar per group (e.g. results per test level). */
export const StackChart: React.FC<{ groups: { label: string; parts: Record<string, number> }[]; order: string[]; tones: Record<string, string>; width?: number }> =
  ({ groups, order, tones, width = 720 }) => {
    if (!groups.length) return null;
    const max = Math.max(...groups.map(g => Object.values(g.parts).reduce((a, b) => a + b, 0)), 1);
    const labelW = 120, valW = 50, rowH = 24, top = 22, W = width, plot = W - labelW - valW - 8, H = top + groups.length * rowH + 4;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} className="max-w-full h-auto block" role="img" aria-label="Results per level">
        <g fontSize={10.5}>{order.map((k, i) => (
          <g key={k}><rect x={labelW + i * 74} y={4} width={9} height={9} rx={2} fill={c(tones[k], 0.8)} /><text x={labelW + i * 74 + 13} y={12} fill={c('text-2')}>{k}</text></g>))}
        </g>
        {groups.map((g, i) => {
          const y = top + i * rowH; let x = labelW;
          const total = Object.values(g.parts).reduce((a, b) => a + b, 0);
          return (
            <g key={g.label}>
              <text x={labelW - 8} y={y + rowH / 2 + 4} textAnchor="end" fontSize={12} fill={c('text-2')}>{g.label}</text>
              {order.filter(k => g.parts[k]).map(k => {
                const w = (g.parts[k] / max) * plot; const el = <rect key={k} x={x} y={y + 4} width={Math.max(1, w - 1)} height={rowH - 8} rx={2} fill={c(tones[k], 0.8)}><title>{`${g.label}: ${g.parts[k]} ${k}`}</title></rect>; x += w; return el;
              })}
              <text x={W - valW + 4} y={y + rowH / 2 + 4} fontSize={11.5} fill={c('text')}>{total}</text>
            </g>
          );
        })}
      </svg>
    );
  };
