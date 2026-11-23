// AETHER_SUNAPI_LIMITS — Push sequence: each limit in turn, Inspect → Push → Validate → result → next.
import React from 'react';
import { CheckCircle2, CircleDashed, Loader2, XCircle, MinusCircle } from 'lucide-react';
import type { Step } from './limitsApi';
import { menuTerm } from './oncafe';
import { Badge, cx, type Tone } from './ui';

const PHASES: { id: 'inspect' | 'push' | 'validate' | 'result'; label: string }[] = [
  { id: 'inspect', label: 'Inspect' }, { id: 'push', label: 'Push' }, { id: 'validate', label: 'Validate' }, { id: 'result', label: 'Result' },
];
const order = (p: Step['phase']) => ({ pending: -1, inspect: 0, push: 1, validate: 2, done: 3, cleanup: 3, finished: 4 }[p] ?? -1);

function verdict(s: Step): { tone: Tone; text: string } | null {
  if (!s.result) return null;
  if (s.result === 'LIMIT' && s.readbackOk !== false) return { tone: 'success', text: s.declared != null ? `Limit = declared ${s.declared}` : `Limit ${s.stored}` };
  if (s.result === 'LIMIT') return { tone: 'error', text: 'Readback disagrees' };
  if (s.result === 'FAIL') return { tone: 'error', text: s.declared != null && s.stored != null && s.stored !== s.declared ? `Stored ${s.stored}, declared ${s.declared}` : 'Failed' };
  if (s.result === 'INFO') return { tone: 'warning', text: 'Test cap reached first' };
  if (s.result === 'ERROR') return { tone: 'error', text: 'Could not push' };
  return { tone: 'neutral', text: 'Skipped' };
}

export const PushSequence: React.FC<{ steps: Step[]; live?: boolean }> = ({ steps, live }) => {
  if (!steps.length) return null;
  const done = steps.filter(s => s.result).length;
  return (
    <section className="rounded-hv-xs ring-1 ring-inset ring-hv-line bg-hv-widget p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-bold text-hv-text">Push sequence</h3>
        <span className="text-xs text-hv-text-3">{done} of {steps.length} limits checked · each step pushes objects up to the limit, reads the controller back, then cleans up before the next</span>
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const cur = live && !s.result && s.phase !== 'pending';
          const v = verdict(s);
          const ph = order(s.phase);
          const pct = s.target ? Math.min(100, ((s.pushed || 0) / Math.max(1, (s.declared ?? s.target) - (s.existing || 0))) * 100) : 0;
          return (
            <li key={s.menu} className={cx('rounded-hv-xs p-3 ring-1 ring-inset flex flex-col gap-2', cur ? 'ring-hv-brand/60 bg-hv-brand-tint' : 'ring-hv-line bg-hv-widget-panel')}>
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className={cx('w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ring-1 ring-inset shrink-0',
                  v ? (v.tone === 'success' ? 'bg-hv-success-tint text-hv-success-fg ring-hv-success/40' : v.tone === 'error' ? 'bg-hv-error-tint text-hv-error-fg ring-hv-error/40' : 'bg-hv-warning-tint text-hv-warning-fg ring-hv-warning/40')
                    : cur ? 'bg-hv-brand-tint text-hv-brand-fg ring-hv-brand/40' : 'bg-hv-widget text-hv-text-3 ring-hv-line-strong')}>{i + 1}</span>
                <span className="text-sm font-semibold text-hv-text">{menuTerm(s.menu)}</span>
                <span className="font-mono text-[11.5px] text-hv-text-3">{s.menu}</span>
                <span className="text-xs text-hv-text-3">{s.declared != null ? `declared max ${s.declared}` : 'no declared max'}</span>
                <span className="ml-auto">{v ? <Badge tone={v.tone}>{v.text}</Badge> : s.phase === 'pending' ? <Badge>Waiting</Badge> : <Badge tone="brand"><Loader2 size={10} className="animate-spin" />Working</Badge>}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {PHASES.map((p, k) => {
                  const st = ph > k || (k === 3 && !!s.result) ? 'done' : ph === k && !s.result ? 'now' : 'todo';
                  const bad = k === 3 && v && v.tone === 'error';
                  return (
                    <React.Fragment key={p.id}>
                      {k > 0 && <span className={cx('h-px w-5', st === 'todo' ? 'bg-hv-line-strong' : 'bg-hv-brand/60')} />}
                      <span className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-hv-xs text-[11.5px] font-semibold ring-1 ring-inset',
                        bad ? 'bg-hv-error-tint text-hv-error-fg ring-hv-error/40'
                          : st === 'done' ? 'bg-hv-success-tint text-hv-success-fg ring-hv-success/40'
                            : st === 'now' ? 'bg-hv-brand-tint text-hv-brand-fg ring-hv-brand/40' : 'bg-hv-widget text-hv-text-3 ring-hv-line-strong')}>
                        {bad ? <XCircle size={11} /> : st === 'done' ? <CheckCircle2 size={11} /> : st === 'now' ? <Loader2 size={11} className="animate-spin" /> : <CircleDashed size={11} />}
                        {p.label}
                      </span>
                    </React.Fragment>
                  );
                })}
                {(s.phase === 'finished' || s.removed != null) && <span className="ml-2 inline-flex items-center gap-1 text-[11.5px] text-hv-text-3"><MinusCircle size={11} />cleaned up: {s.removed ?? 0} removed{s.left ? `, ${s.left} LEFT` : ''}</span>}
              </div>
              {(s.phase === 'push' || s.pushed != null) && s.target != null && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-hv-line overflow-hidden"><div className={cx('h-full rounded-full transition-all', v?.tone === 'error' ? 'bg-hv-error' : 'bg-hv-brand')} style={{ width: `${pct}%` }} /></div>
                  <span className="text-[11.5px] font-mono text-hv-text-2 tabular-nums whitespace-nowrap">pushed {s.pushed ?? 0}{s.declared != null ? ` / ${s.declared - (s.existing || 0)}` : ''}{s.existing ? ` (+${s.existing} already there)` : ''}</span>
                </div>
              )}
              {(s.result || s.message) && (
                <div className="text-xs text-hv-text-2">
                  {s.stored != null && <>Read back <b className="font-mono">{s.stored}</b> stored (expected {s.expected}){s.readbackOk === false ? ' – MISMATCH' : ''}. </>}
                  {s.refused && <>Next add refused: <span className="font-mono">{s.refused}</span>. </>}
                  {!s.stored && s.message && <span>{s.message}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
