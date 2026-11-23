// AETHER_AZURE_DEBUG — shared pieces: severity badge, finding card with checklist, stat tile.
import React, { useState } from 'react';
import { ChevronRight, ListChecks, Wrench } from 'lucide-react';
import { Badge, cx, type Tone } from '../sunapi/ui';
import { fixList, fmtAt, type Finding, type HopStatus, type Sev } from './api';
import { guideFor } from './guide';

export const sevTone = (s: Sev | string): Tone => (s === 'high' ? 'error' : s === 'medium' ? 'warning' : s === 'low' ? 'info' : 'neutral');
export const sevLabel = (s: Sev | string) => (s === 'high' ? 'High' : s === 'medium' ? 'Medium' : s === 'low' ? 'Low' : 'Info');
export const hopTone = (s: HopStatus): Tone => (s === 'bad' ? 'error' : s === 'warn' ? 'warning' : 'success');
export const hopLabel = (s: HopStatus) => (s === 'bad' ? 'Problem' : s === 'warn' ? 'Check' : 'OK');
export const SEV_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

export const Dot: React.FC<{ tone: 'success' | 'warning' | 'error' | 'neutral' | 'info' }> = ({ tone }) => (
  <span className={cx('inline-block w-2 h-2 rounded-full shrink-0',
    tone === 'success' ? 'bg-hv-success' : tone === 'warning' ? 'bg-hv-warning' : tone === 'error' ? 'bg-hv-error' : tone === 'info' ? 'bg-hv-info' : 'bg-hv-line-strong')} />
);

export const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'error' | 'warning' | 'success' }> = ({ label, value, sub, tone }) => (
  <div className="rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line px-3 py-2 min-w-0">
    <div className="text-[11px] text-hv-text-3 truncate">{label}</div>
    <div className={cx('text-base font-bold truncate', tone === 'error' ? 'text-hv-error-fg' : tone === 'warning' ? 'text-hv-warning-fg' : tone === 'success' ? 'text-hv-success-fg' : 'text-hv-text')}>{value}</div>
    {sub && <div className="text-[11px] text-hv-text-3 truncate">{sub}</div>}
  </div>
);

export const Section: React.FC<{ title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, right, children, className }) => (
  <section className={cx('rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-surface', className)}>
    <div className="flex items-center gap-2 px-3 h-10 border-b border-hv-line">
      <h3 className="text-sm font-bold text-hv-text truncate">{title}</h3>
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </div>
    <div className="p-3">{children}</div>
  </section>
);

/** One finding: title, why, what to do, the matching field checklist and the log lines behind it. */
export const FindingCard: React.FC<{ f: Finding; tz?: string; open?: boolean }> = ({ f, tz, open: open0 }) => {
  const [open, setOpen] = useState(!!open0);
  const [guide, setGuide] = useState(false);
  const g = guideFor(f);
  const fixes = fixList(f.fix);
  return (
    <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 px-3 py-2 text-left">
        <ChevronRight size={14} className={cx('mt-1 shrink-0 text-hv-text-3 transition-transform', open && 'rotate-90')} />
        <Badge tone={sevTone(f.sev)} className="shrink-0 mt-0.5">{sevLabel(f.sev)}</Badge>
        <span className="min-w-0 flex-1 text-[13px] font-semibold text-hv-text leading-snug">{f.title}</span>
        {typeof (f as { inRange?: number }).inRange === 'number' && <span className="text-[10.5px] font-semibold text-hv-info-fg shrink-0 mt-0.5" title="Times this happened inside the chosen time range">{(f as { approx?: boolean }).approx ? '≥' : ''}{(f as { inRange?: number }).inRange}× in range</span>}
        {(f as { untimed?: boolean }).untimed && <span className="text-[10.5px] text-hv-text-3 shrink-0 mt-0.5" title="A configuration check: it has no time in the log, so it is shown for any range">no time</span>}
        {f.basis && f.basis !== 'confirmed' && <span className="text-[10.5px] text-hv-text-3 shrink-0 mt-0.5" title="confirmed = seen directly in the log; derived = worked out from several lines; heuristic = a likely explanation">{f.basis}</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9 flex flex-col gap-2 text-[12.5px]">
          {f.detail && <p className="text-hv-text-2 leading-relaxed">{f.detail}</p>}
          {fixes.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-hv-text-2 mb-1"><Wrench size={12} /> What to do</div>
              <ul className="list-disc pl-5 text-hv-text space-y-0.5">{fixes.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {g && (
            <div>
              <button onClick={() => setGuide(v => !v)} className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-hv-info-fg hover:underline">
                <ListChecks size={13} /> {guide ? 'Hide' : 'Show'} field checklist: {g.title}
              </button>
              {guide && (
                <ol className="mt-1.5 list-decimal pl-5 space-y-0.5 text-hv-text-2">
                  {g.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>
          )}
          {f.samples && f.samples.length > 0 && (
            <div className="rounded-hv-xs bg-hv-surface ring-1 ring-inset ring-hv-line max-h-48 overflow-auto">
              {f.samples.slice(0, 40).map((s, i) => (
                <div key={i} className="flex gap-2 px-2 py-1 border-b border-hv-line last:border-0 font-mono text-[11px]">
                  <span className="text-hv-text-3 shrink-0 w-[118px]">{fmtAt(s.t, tz)}</span>
                  <span className="text-hv-text break-all min-w-0 flex-1">{s.text}</span>
                  {s.file && <span className="text-hv-text-3 shrink-0 truncate max-w-[180px]" title={`${s.file}:${s.line}`}>{s.file.split('/').pop()}:{s.line}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const FindingList: React.FC<{ items: Finding[]; tz?: string; empty?: string; limit?: number }> = ({ items, tz, empty, limit = 60 }) => {
  const [all, setAll] = useState(false);
  const list = [...items].sort((a, b) => (SEV_ORDER[b.sev] || 0) - (SEV_ORDER[a.sev] || 0));
  if (!list.length) return <div className="text-[13px] text-hv-text-3 px-1 py-2">{empty || 'Nothing found.'}</div>;
  return (
    <div className="flex flex-col gap-1.5">
      {(all ? list : list.slice(0, limit)).map((f, i) => <FindingCard key={f.id + i} f={f} tz={tz} />)}
      {list.length > limit && !all && <button onClick={() => setAll(true)} className="text-xs text-hv-info-fg hover:underline self-start">Show all {list.length}</button>}
    </div>
  );
};
