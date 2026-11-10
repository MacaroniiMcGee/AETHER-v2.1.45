// AETHER_SUNAPI — small HV-guideline UI pieces used by the SUNAPI Console.
// Solid fills only for Brand (primary) and Error (destructive); everything else is a tint.
import React, { useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type BtnTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';
export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; size?: 'sm' | 'md'; busy?: boolean; icon?: React.ReactNode }> =
  ({ tone = 'secondary', size = 'md', busy, icon, className, children, disabled, ...p }) => (
    <button {...p} disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-hv-xs font-semibold whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-hv-info',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        tone === 'primary' && 'bg-hv-brand text-white hover:bg-hv-brand-hover',
        tone === 'danger' && 'bg-hv-error text-white hover:bg-hv-error-hover',
        tone === 'danger-soft' && 'bg-hv-error-tint text-hv-error-fg ring-1 ring-inset ring-hv-error/40 hover:bg-hv-error-tint-strong',
        tone === 'secondary' && 'bg-hv-widget text-hv-text ring-1 ring-inset ring-hv-line-strong hover:bg-hv-box',
        tone === 'ghost' && 'text-hv-text-2 hover:bg-hv-widget hover:text-hv-text',
        className,
      )}>
      {busy ? <Loader2 size={size === 'sm' ? 13 : 15} className="animate-spin" /> : icon}
      {children}
    </button>
  );

export const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }> =
  ({ label, active, className, children, ...p }) => (
    <button {...p} title={label} aria-label={label}
      className={cx('inline-flex items-center justify-center w-7 h-7 rounded-hv-xs transition-colors disabled:opacity-40',
        active ? 'text-hv-brand-fg bg-hv-brand-tint' : 'text-hv-text-3 hover:text-hv-text hover:bg-hv-widget', className)}>
      {children}
    </button>
  );

export type Tone = 'brand' | 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'purple';
const toneCls: Record<Tone, string> = {
  brand: 'bg-hv-brand-tint text-hv-brand-fg ring-hv-brand/40',
  success: 'bg-hv-success-tint text-hv-success-fg ring-hv-success/40',
  warning: 'bg-hv-warning-tint text-hv-warning-fg ring-hv-warning/40',
  error: 'bg-hv-error-tint text-hv-error-fg ring-hv-error/40',
  info: 'bg-hv-info-tint text-hv-info-fg ring-hv-info/40',
  purple: 'bg-hv-purple-tint text-hv-purple-fg ring-hv-purple/40',
  neutral: 'bg-hv-widget text-hv-text-2 ring-hv-line-strong',
};
export const Badge: React.FC<{ tone?: Tone; className?: string; title?: string; children: React.ReactNode }> = ({ tone = 'neutral', className, title, children }) => (
  <span title={title} className={cx('inline-flex items-center gap-1 h-5 px-1.5 rounded-hv-xs text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap', toneCls[tone], className)}>{children}</span>
);

export const actionTone = (a: string): Tone =>
  a === 'view' || a === 'check' || a === 'monitor' || a === 'monitordiff' ? 'info'
    : a === 'remove' || a === 'install' ? 'error'
      : a === 'control' || a === 'test' ? 'purple'
        : 'warning';

export const statusTone = (s: number): Tone => (s >= 200 && s < 300 ? 'success' : s === 0 ? 'error' : s >= 400 ? 'error' : 'warning');

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }>(
  ({ invalid, mono, className, ...p }, ref) => (
    <input ref={ref} {...p}
      className={cx('h-8 w-full rounded-hv-xs bg-hv-surface px-2.5 text-sm text-hv-text placeholder:text-hv-text-3 ring-1 ring-inset outline-none transition-shadow disabled:opacity-50',
        invalid ? 'ring-hv-error' : 'ring-hv-line-strong focus:ring-hv-info', mono && 'font-mono text-[13px]', className)} />
  ));
Input.displayName = 'Input';

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }> = ({ invalid, className, children, ...p }) => (
  <select {...p}
    className={cx('h-8 w-full rounded-hv-xs bg-hv-surface pl-2 pr-7 text-sm text-hv-text ring-1 ring-inset outline-none focus:ring-hv-info disabled:opacity-50',
      invalid ? 'ring-hv-error' : 'ring-hv-line-strong', className)}>
    {children}
  </select>
);

export const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }> = ({ on, onChange, label, disabled }) => (
  <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
    className="inline-flex items-center gap-2 text-sm text-hv-text-2 disabled:opacity-50">
    <span className={cx('relative inline-block w-8 h-[18px] rounded-full transition-colors', on ? 'bg-hv-brand' : 'bg-hv-line-strong')}>
      <span className={cx('absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all', on ? 'left-[16px]' : 'left-[2px]')} />
    </span>
    {label}
  </button>
);

/** One row of tabs (HV "Tab" — underline style). */
export function Tabs<T extends string>({ value, onChange, items, className, size = 'md' }: { value: T; onChange: (v: T) => void; items: { id: T; label: React.ReactNode; count?: number; disabled?: boolean }[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="tablist" className={cx('flex items-end gap-1 border-b border-hv-line', className)}>
      {items.map(it => (
        <button key={it.id} role="tab" aria-selected={value === it.id} disabled={it.disabled} onClick={() => onChange(it.id)}
          className={cx('relative -mb-px inline-flex items-center gap-1.5 border-b-2 font-semibold transition-colors disabled:opacity-40',
            size === 'sm' ? 'h-8 px-2 text-xs' : 'h-10 px-3 text-sm',
            value === it.id ? 'border-hv-brand text-hv-text' : 'border-transparent text-hv-text-3 hover:text-hv-text-2')}>
          {it.label}
          {it.count !== undefined && <span className="text-[11px] font-semibold text-hv-text-3">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Segmented control (HV "Button group"). */
export function Segmented<T extends string>({ value, onChange, items, size = 'sm' }: { value: T; onChange: (v: T) => void; items: { id: T; label: React.ReactNode; title?: string }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-hv-xs ring-1 ring-inset ring-hv-line-strong p-0.5 bg-hv-surface">
      {items.map(it => (
        <button key={it.id} title={it.title} onClick={() => onChange(it.id)} aria-pressed={value === it.id}
          className={cx('rounded-[3px] font-semibold whitespace-nowrap transition-colors', size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-sm',
            value === it.id ? 'bg-hv-box text-hv-text' : 'text-hv-text-3 hover:text-hv-text-2')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export const Dialog: React.FC<{ open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }> =
  ({ open, title, onClose, children, footer, width = 460 }) => {
    useEffect(() => {
      if (!open) return;
      const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', k);
      return () => window.removeEventListener('keydown', k);
    }, [open, onClose]);
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div role="dialog" aria-modal="true" className="w-full rounded-hv-sm bg-hv-popup-panel shadow-hv-3 ring-1 ring-hv-line-strong flex flex-col max-h-[90vh]" style={{ maxWidth: width }}>
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
            <h2 className="text-base font-bold text-hv-text">{title}</h2>
            <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
          </div>
          <div className="px-5 pb-4 overflow-auto text-sm text-hv-text-2">{children}</div>
          {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-hv-line">{footer}</div>}
        </div>
      </div>
    );
  };

export const Empty: React.FC<{ icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }> = ({ icon, title, children, action }) => (
  <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-6 py-10">
    {icon && <div className="text-hv-text-3 mb-1">{icon}</div>}
    <div className="text-sm font-semibold text-hv-text-2">{title}</div>
    {children && <div className="text-xs text-hv-text-3 max-w-sm leading-relaxed">{children}</div>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);

export const Field: React.FC<{ label: string; hint?: React.ReactNode; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block">
    <span className="block text-xs font-semibold text-hv-text-2 mb-1">{label}</span>
    {children}
    {hint && <span className="block text-[11px] text-hv-text-3 mt-1">{hint}</span>}
  </label>
);

export const fmtBytes = (n?: number) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtTime = (t: number) => {
  const d = new Date(t); const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function copyText(t: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  // Aether is usually served over plain http on the LAN, where navigator.clipboard is missing.
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  return Promise.resolve();
}

export function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const lsGet = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
export const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
