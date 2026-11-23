// AETHER_SUNAPI_LIMITS — Ask box UI (answers come from ask.ts, offline).
import React, { useState } from 'react';
import { MessageCircleQuestion, CornerDownLeft, X } from 'lucide-react';
import type { Answer } from './ask';
import { cx } from './ui';

export const AskBox: React.FC<{ answer: (q: string) => Answer; examples: string[]; placeholder?: string }> = ({ answer, examples, placeholder }) => {
  const [q, setQ] = useState('');
  const [a, setA] = useState<{ q: string; a: Answer } | null>(null);
  const go = (text: string) => { const t = text.trim(); if (!t) return; setQ(t); setA({ q: t, a: answer(t) }); };
  return (
    <div className="flex flex-col gap-2">
      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); go(q); }}>
        <div className="relative flex-1 min-w-0">
          <MessageCircleQuestion size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hv-text-3" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder || 'Ask about this report, e.g. “How many Access Levels does this allow?”'}
            aria-label="Ask a question about this report"
            className="h-9 w-full rounded-hv-xs bg-hv-surface pl-8 pr-9 text-sm text-hv-text placeholder:text-hv-text-3 ring-1 ring-inset ring-hv-line-strong outline-none focus:ring-hv-info" />
          <button type="submit" className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-hv-xs text-hv-text-3 hover:text-hv-text hover:bg-hv-widget inline-flex items-center justify-center" aria-label="Ask"><CornerDownLeft size={13} /></button>
        </div>
      </form>
      {!a && (
        <div className="flex flex-wrap gap-1.5">
          {examples.slice(0, 5).map(x => <button key={x} onClick={() => go(x)} className="h-6 px-2 rounded-hv-xs text-[11.5px] font-semibold bg-hv-widget text-hv-text-2 ring-1 ring-inset ring-hv-line-strong hover:bg-hv-box">{x}</button>)}
        </div>
      )}
      {a && (
        <div className={cx('rounded-hv-xs p-3 ring-1 ring-inset flex flex-col gap-1.5', a.a.understood ? 'bg-hv-info-tint ring-hv-info/40' : 'bg-hv-widget ring-hv-line-strong')}>
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <div className="text-[11px] text-hv-text-3">“{a.q}”</div>
              <div className="text-sm font-bold text-hv-text">{a.a.title}</div>
            </div>
            <button onClick={() => { setA(null); setQ(''); }} className="ml-auto w-6 h-6 rounded-hv-xs text-hv-text-3 hover:text-hv-text hover:bg-hv-widget inline-flex items-center justify-center shrink-0" aria-label="Clear the answer"><X size={13} /></button>
          </div>
          <ul className="flex flex-col gap-1">
            {a.a.lines.map((l, i) => (
              <li key={i} className={cx('text-[13px] leading-snug', l.tone === 'bad' ? 'text-hv-error-fg' : l.tone === 'warn' ? 'text-hv-warning-fg' : l.tone === 'good' ? 'text-hv-success-fg' : 'text-hv-text')}>
                {l.strong && <b>{l.strong}</b>}{l.text}
                {l.source && <span className="ml-1.5 inline-block align-middle font-mono text-[10.5px] px-1 rounded-[3px] bg-hv-widget text-hv-text-3 ring-1 ring-inset ring-hv-line" title="Where this number comes from in the report">{l.source}</span>}
              </li>
            ))}
          </ul>
          {a.a.suggest.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {a.a.suggest.map(x => <button key={x} onClick={() => go(x)} className="h-6 px-2 rounded-hv-xs text-[11.5px] font-semibold bg-hv-widget text-hv-text-2 ring-1 ring-inset ring-hv-line-strong hover:bg-hv-box">{x}</button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
