// Shared look for the Config pages.
import React from 'react';

export const T = {
  text: 'rgb(var(--hv-text))', text2: 'rgb(var(--hv-text-2))', dim: 'rgb(var(--hv-text-3))', faint: 'rgb(var(--hv-text-3))',
  line: 'rgb(var(--hv-popup-panel))', line2: 'rgb(var(--hv-line))', panel: 'rgb(var(--hv-widget) / 0.5)', well: 'rgb(var(--hv-surface) / 0.55)', input: 'rgb(var(--hv-surface))',
  amber: 'rgb(var(--hv-brand))', teal: 'rgb(var(--hv-info))', green: 'rgb(var(--hv-success))', warn: 'rgb(var(--hv-warning))', crit: 'rgb(var(--hv-error))', blue: 'rgb(var(--hv-info-text))',
};

export const Card: React.FC<{ title?: React.ReactNode; right?: React.ReactNode; className?: string; children: React.ReactNode; pad?: boolean }> =
  ({ title, right, className = '', children, pad = true }) => (
    <section className={`rounded-xl border ${className}`} style={{ background: T.panel, borderColor: T.line2 }}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b" style={{ borderColor: T.line }}>
          <h3 className="text-sm font-bold" style={{ color: T.text }}>{title}</h3>
          {right}
        </div>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );

export const inputCls = 'w-full rounded-md px-2.5 py-1.5 text-sm border outline-none focus:border-hv-info disabled:opacity-50';
export const inputStyle: React.CSSProperties = { background: T.input, borderColor: T.line2, color: T.text };

export const Btn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'danger' }> =
  ({ tone = 'default', className = '', style, ...p }) => (
    <button {...p}
      className={`px-3 py-1.5 rounded-md text-sm font-semibold border transition-colors disabled:opacity-40 inline-flex items-center justify-center gap-1.5 ${className}`}
      style={{
        ...(tone === 'primary' ? { background: 'rgb(var(--hv-success-tint-strong))', borderColor: T.green, color: 'rgb(var(--hv-success-text))' }
          : tone === 'danger' ? { background: 'rgb(var(--hv-error-strong) / 0.15)', borderColor: 'rgb(var(--hv-error-hover))', color: 'rgb(var(--hv-error-text))' }
          : { background: 'rgb(var(--hv-widget-panel))', borderColor: T.line2, color: T.text2 }),
        ...style,
      }} />
  );

export const Dot: React.FC<{ on: boolean; color?: string; title?: string }> = ({ on, color = T.green, title }) => (
  <span title={title} className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
    style={{ background: on ? color : 'rgb(var(--hv-line))', boxShadow: on ? `0 0 8px color-mix(in srgb, ${color} 60%, transparent)` : 'none' }} />
);

/** A labelled meter: value is always printed; the bar only reinforces it. */
export const Meter: React.FC<{ label: string; pct: number | null; value: string; tone?: 'normal' | 'warn' | 'crit'; note?: string }> =
  ({ label, pct, value, tone = 'normal', note }) => {
    const c = tone === 'crit' ? T.crit : tone === 'warn' ? T.warn : T.teal;
    return (
      <div>
        <div className="flex items-baseline justify-between text-xs mb-1">
          <span style={{ color: T.text2 }}>{label}</span>
          <span className="font-mono" style={{ color: T.text }}>{value}{note && <span className="ml-1.5 font-sans font-semibold" style={{ color: c }}>{note}</span>}</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgb(var(--hv-popup-panel))' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: c }} />
        </div>
      </div>
    );
  };

export const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'normal' | 'warn' | 'crit' }> =
  ({ label, value, sub, tone = 'normal' }) => (
    <div className="rounded-lg border px-4 py-3" style={{ background: T.well, borderColor: tone === 'crit' ? 'rgb(var(--hv-error-hover))' : tone === 'warn' ? 'rgb(var(--hv-text-3))' : T.line }}>
      <div className="text-[11px]" style={{ color: T.dim }}>{label}</div>
      <div className="text-2xl font-bold font-mono mt-0.5" style={{ color: T.text }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: tone === 'crit' ? T.crit : tone === 'warn' ? T.warn : T.dim }}>{sub}</div>}
    </div>
  );

export const KV: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
    {rows.map(([k, v]) => (
      <React.Fragment key={k}>
        <dt style={{ color: T.dim }}>{k}</dt>
        <dd className="truncate" style={{ color: T.text }} title={typeof v === 'string' ? v : undefined}>{v ?? '—'}</dd>
      </React.Fragment>
    ))}
  </dl>
);

export const fmtBytes = (n?: number | null) => {
  if (n == null || !isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
};
export const fmtDur = (s?: number | null) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
