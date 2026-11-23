// AETHER_AZURE_DEBUG — "what's the problem?" box and the isolated log lines (AZURE-15).
import React, { useState } from 'react';
import { ChevronRight, ListChecks, Search, X } from 'lucide-react';
import { cx } from '../sunapi/ui';
import { fmtAt } from './api';
import type { CauseResult, Topic } from './cause';

const QUICK = ['offline', 'board', 'power', 'network', 'reader', 'events', 'config'];

export const CauseBar: React.FC<{ value: string; onChange: (v: string) => void; topics: Topic[]; result: CauseResult | null }> = ({ value, onChange, topics, result }) => {
  const [text, setText] = useState(value);
  React.useEffect(() => setText(value), [value]);
  const commit = (v: string) => onChange(v.trim());
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-hv-line shrink-0 text-[12px]', value ? 'bg-hv-info-tint' : 'bg-hv-widget')}>
      <span className="inline-flex items-center gap-1.5 font-semibold text-hv-text-2"><Search size={14} /> Problem</span>
      <form onSubmit={e => { e.preventDefault(); commit(text); }} className="flex items-center gap-1.5">
        <input list="azure-cause-topics" value={text} onChange={e => { setText(e.target.value); if (topics.some(t => t.label === e.target.value)) commit(e.target.value); }}
          onBlur={() => text.trim() !== value && commit(text)} placeholder="e.g. Controller offline, dns, O8 NAK"
          aria-label="Reported problem or words to look for"
          className="h-7 w-[260px] max-w-full rounded-hv-xs bg-hv-surface px-2 text-[12px] text-hv-text placeholder:text-hv-text-3 ring-1 ring-inset ring-hv-line-strong outline-none focus:ring-hv-info" />
        <datalist id="azure-cause-topics">{topics.map(t => <option key={t.id} value={t.label}>{t.desc}</option>)}</datalist>
      </form>
      <div className="flex flex-wrap gap-1">
        {topics.filter(t => QUICK.includes(t.id)).map(t => {
          const on = result?.topic?.id === t.id;
          return <button key={t.id} onClick={() => onChange(on ? '' : t.label)} title={t.desc}
            className={cx('h-6 px-2 rounded-full ring-1 ring-inset text-[11.5px]', on ? 'bg-hv-brand text-white ring-hv-brand' : 'ring-hv-line-strong text-hv-text-2 hover:bg-hv-box')}>{t.label}</button>;
        })}
      </div>
      {value && result && (
        <span className="ml-auto text-hv-text-2">
          {result.topic ? <b className="text-hv-text">{result.topic.label}</b> : <>words <b className="text-hv-text">{result.words.join(' + ') || '—'}</b></>}: {result.matched} of {result.total} alerts · {result.lines.length} log lines
        </span>
      )}
      {value && <button onClick={() => onChange('')} className={cx('inline-flex items-center gap-1 text-hv-info-fg hover:underline', !result && 'ml-auto')}><X size={12} /> Clear</button>}
    </div>
  );
};

const KIND_LABEL: Record<string, string> = { alert: '', startup: 'start-up', status: 'status' };

/** The log lines behind the chosen problem, oldest first, in one list. */
export const IsolatedLines: React.FC<{ result: CauseResult; tz?: string }> = ({ result, tz }) => {
  const [open, setOpen] = useState(true);
  const [check, setCheck] = useState(false);
  const { lines, topic } = result;
  return (
    <div className="border-b border-hv-line shrink-0 bg-hv-surface">
      <div className="flex items-center gap-2 px-4 h-9">
        <button onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-hv-text">
          <ChevronRight size={14} className={cx('transition-transform', open && 'rotate-90')} />
          Log lines for {topic ? topic.label : `"${result.words.join(' ')}"`} <span className="font-normal text-hv-text-3">({lines.length}, oldest first)</span>
        </button>
        {topic?.checklist && topic.checklist.length > 0 && (
          <button onClick={() => setCheck(v => !v)} className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-hv-info-fg hover:underline">
            <ListChecks size={13} /> {check ? 'Hide' : 'What to check'}
          </button>
        )}
      </div>
      {check && topic?.checklist && (
        <ol className="mx-4 mb-2 list-decimal pl-5 space-y-0.5 text-[12px] text-hv-text-2">{topic.checklist.map((x, i) => <li key={i}>{x}</li>)}</ol>
      )}
      {open && (
        <div className="mx-4 mb-3 rounded-hv-xs ring-1 ring-inset ring-hv-line max-h-[260px] overflow-auto bg-hv-widget">
          {!lines.length && <div className="px-3 py-2 text-[12px] text-hv-text-3">No log lines for this in the scan{result.matched ? '' : ' (no alerts match)'}. Try other words, or widen the time range.</div>}
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 px-2 py-1 border-b border-hv-line last:border-0 font-mono text-[11px]">
              <span className="text-hv-text-3 shrink-0 w-[118px]">{fmtAt(l.t, tz)}</span>
              <span className={cx('shrink-0 w-1.5 self-stretch rounded-full', l.sev === 'high' ? 'bg-hv-error' : l.sev === 'medium' ? 'bg-hv-warning' : l.kind === 'startup' ? 'bg-hv-info' : 'bg-hv-line-strong')} title={l.sev || l.kind} />
              <span className="text-hv-text break-all min-w-0 flex-1">{KIND_LABEL[l.kind] && <span className="text-hv-info-fg mr-1.5">{KIND_LABEL[l.kind]}</span>}{l.text}</span>
              <span className="text-hv-text-3 shrink-0 truncate max-w-[260px] font-sans text-[10.5px]" title={`${l.src}${l.file ? ` — ${l.file}:${l.line}` : ''}`}>{l.src}{l.file ? ` · ${l.file.split('/').pop()}:${l.line}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
