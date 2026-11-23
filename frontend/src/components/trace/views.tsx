// AETHER_TRACE — Event Trace pieces: verdict strip, clock card, traces table, hop waterfall, swimlane timeline
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, X, CheckCircle2, AlertTriangle, XCircle, Clock, Fingerprint, Lock } from 'lucide-react';
import { Badge, Button, Empty, cx, type Tone } from '../sunapi/ui';
import { clock, credText, fmtMs, LANES, SRC_LABEL, type Analysis, type TEvent, type Trace, type TraceApi, type Stat } from './api';

export const statusTone = (s: string): Tone => (s === 'pass' ? 'success' : s === 'warn' ? 'warning' : s === 'fail' ? 'error' : 'neutral');
const StatusIcon: React.FC<{ s: string }> = ({ s }) => s === 'pass' ? <CheckCircle2 size={14} className="text-hv-success-fg" /> : s === 'warn' ? <AlertTriangle size={14} className="text-hv-warning-fg" /> : <XCircle size={14} className="text-hv-error-fg" />;

const StatTile: React.FC<{ label: string; s: Stat; hint?: string }> = ({ label, s, hint }) => (
  <div className="min-w-[160px] flex-1 rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line px-3 py-1.5" title={hint}>
    <div className="text-[11px] text-hv-text-3 truncate">{label}</div>
    {s.n ? (
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-base font-semibold text-hv-text tabular-nums whitespace-nowrap">{fmtMs(s.p50)}</span>
        <span className="text-[11px] text-hv-text-3 tabular-nums whitespace-nowrap truncate">p95 {fmtMs(s.p95)} · max {fmtMs(s.max)} · n {s.n}</span>
      </div>
    ) : <div className="text-sm text-hv-text-3">no data</div>}
  </div>
);

export const Summary: React.FC<{ a: Analysis }> = ({ a }) => {
  const s = a.stats;
  return (
    <div className="flex flex-wrap gap-2">
      <div className="min-w-[150px] rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line px-3 py-1.5">
        <div className="text-[11px] text-hv-text-3">Actions</div>
        <div className="flex items-center gap-1.5 text-sm">
          <Badge tone={statusTone(s.verdict)}>{s.verdict === 'no-data' ? 'no data' : s.verdict}</Badge>
          <span className="tabular-nums text-hv-text">{s.actions}</span>
          <span className="text-[11px] text-hv-text-3 tabular-nums">· {s.pass} pass · {s.warn} warn · {s.fail} fail</span>
        </div>
      </div>
      <StatTile label="Aether → controller decision" s={s.decision} hint="Corrected with the sync-card clock offset. Includes the reader's transmission time." />
      <StatTile label="Aether → cloud push (MQTT)" s={s.push} hint="Both ends on the Pi's clock: no correction needed. This is the cloud latency." />
      <StatTile label="Decision → cloud push" s={s.decisionToPush} hint="Controller + Cloud Connector + broker + cloud processing" />
      <StatTile label="Aether → event log (API)" s={s.api} hint="When the event first showed in the OnCAFE event log. Resolution = poll interval." />
      {(s.credMismatch > 0 || s.unexplained > 0) && (
        <div className="rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 px-3 py-1.5 text-xs text-hv-error-fg">
          {s.credMismatch > 0 && <div><b>{s.credMismatch}</b> credential{s.credMismatch > 1 ? 's' : ''} changed on the way</div>}
          {s.unexplained > 0 && <div><b>{s.unexplained}</b> controller decision{s.unexplained > 1 ? 's' : ''} nobody triggered</div>}
        </div>
      )}
    </div>
  );
};

export const ClockCard: React.FC<{ a: Analysis }> = ({ a }) => {
  const c = a.clock;
  const sets = ['start', 'check', 'end'].map(set => ({ set, rows: c.sync.filter(x => x.set === set) })).filter(x => x.rows.length);
  return (
    <div className="rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line px-3 py-2 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <Clock size={13} className="text-hv-text-3" />
        <span className="font-semibold text-hv-text">Controller clock</span>
        {c.offset == null
          ? <Badge tone="warning">offset unknown</Badge>
          : <Badge tone="info">{c.offset >= 0 ? 'ahead of' : 'behind'} the Pi by {fmtMs(Math.abs(c.offset))}</Badge>}
        {c.drift && <Badge tone={Math.abs(c.drift.changeMs) > 500 ? 'warning' : 'neutral'}>drift {c.drift.changeMs >= 0 ? '+' : ''}{fmtMs(c.drift.changeMs)}{c.drift.perHourMs != null ? ` (${Math.round(c.drift.perHourMs)} ms/h)` : ''}</Badge>}
      </div>
      {!sets.length ? (
        <div className="text-hv-text-3">No sync cards in this run. Start a run with sync cards (Setup › Sync cards) so controller timestamps can be lined up with the Pi.</div>
      ) : sets.map(({ set, rows }) => (
        <div key={set} className="flex flex-wrap items-center gap-1.5 mt-1">
          <span className="w-10 text-hv-text-3">{set}</span>
          {rows.map((r, i) => (
            <Badge key={i} tone={r.matched ? 'success' : 'error'} title={r.matched ? `${r.type} at controller ${clock(r.eventT!)}${r.byPattern ? ' — matched by the gap between the cards (the cloud did not report card numbers)' : ''}` : 'Not found in the controller/cloud events'}>
              {r.fc}-{r.cn} {r.matched ? `${r.offset! >= 0 ? '+' : ''}${fmtMs(r.offset)}` : 'missing'}{r.byPattern ? ' ≈' : ''}
            </Badge>
          ))}
        </div>
      ))}
      {c.gaps.length > 0 && <div className="mt-1 text-hv-text-3">Gaps sent / seen: {c.gaps.map(g => `${fmtMs(g.sent)} / ${fmtMs(g.seen)}`).join(' · ')}</div>}
    </div>
  );
};

const HOP_TONE: Record<string, string> = { sent: 'bg-hv-brand', decided: 'bg-hv-purple', published: 'bg-hv-purple', wire: 'bg-hv-info', push: 'bg-hv-success', stored: 'bg-hv-success', api: 'bg-hv-warning', browser: 'bg-hv-warning', lock: 'bg-hv-text-3' };

export const HopChips: React.FC<{ t: Trace }> = ({ t }) => (
  <div className="flex flex-wrap gap-1">
    {t.hops.filter(h => h.id !== 'sent').map(h => (
      <span key={h.id} title={`${h.label}${h.clock === 'controller' && !h.corrected ? ' (controller clock, uncorrected)' : ''}`}
        className="inline-flex items-center gap-1 h-5 px-1.5 rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line text-[11px] text-hv-text-2 tabular-nums">
        <span className={cx('w-1.5 h-1.5 rounded-full', HOP_TONE[h.id] || 'bg-hv-line-strong')} />{h.id} {fmtMs(h.ms)}{h.clock === 'controller' && !h.corrected ? '*' : ''}
      </span>
    ))}
  </div>
);

export const TraceTable: React.FC<{ traces: Trace[]; selected: string | null; onSelect: (id: string | null) => void; showSync: boolean; compact?: boolean }> = ({ traces, selected, onSelect, showSync, compact }) => {
  const rows = useMemo(() => traces.filter(t => showSync || !t.sync).slice().reverse(), [traces, showSync]);
  if (!rows.length) return <Empty icon={<Fingerprint size={28} />} title="No actions yet">Present a card from Aether (Readers, Wiegand, OSDP or an emulated board). Every card becomes a row here, followed through the controller to the cloud.</Empty>;
  return (
    <table className="w-full text-[12px] table-fixed">
      <thead className="sticky top-0 bg-hv-widget-panel z-10">
        <tr className="text-left text-[11px] text-hv-text-3 border-b border-hv-line">
          <th className="font-semibold px-3 py-1.5 w-[100px]">Time</th>
          <th className="font-semibold px-2 py-1.5 w-[30px]" />
          <th className="font-semibold px-2 py-1.5">Card</th>
          <th className="font-semibold px-2 py-1.5 w-[170px]">Controller</th>
          {!compact && <th className="font-semibold px-2 py-1.5">Hops (from the card)</th>}
          <th className="font-semibold px-3 py-1.5 text-right w-[84px]">Cloud push</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(t => (
          <tr key={t.id} onClick={() => onSelect(t.id === selected ? null : t.id)}
            className={cx('border-b border-hv-line cursor-pointer align-top', t.id === selected ? 'bg-hv-brand-tint' : 'hover:bg-hv-widget')}>
            <td className="px-3 py-1.5 font-mono text-hv-text-3 whitespace-nowrap">{clock(t.at)}</td>
            <td className="px-2 py-1.5"><StatusIcon s={t.status} /></td>
            <td className="px-2 py-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-hv-text">{credText(t.action.cred)}</span>
                {t.sync && <Badge tone="info">sync</Badge>}
                {t.credCheck === 'mismatch' && <Badge tone="error">decoded {credText(t.decision?.cred)}</Badge>}
                {t.expect && <Badge tone="neutral">expect {t.expect}</Badge>}
              </div>
              <div className="text-[11px] text-hv-text-3 truncate">{t.action.ch}{t.notes[0] ? ` · ${t.notes[0]}` : ''}</div>
            </td>
            <td className="px-2 py-1.5 overflow-hidden">
              {t.decision ? <>
                <Badge tone={t.decision.type.startsWith('accessgranted') ? 'success' : 'error'}>{t.decision.type}</Badge>
                <div className="text-[11px] text-hv-text-3 truncate">{t.decision.door?.name || t.decision.door?.id || ''}{t.decision.clientType ? ` · ${t.decision.clientType}` : ''}</div>
              </> : <span className="text-hv-text-3">—</span>}
            </td>
            {!compact && <td className="px-2 py-1.5"><HopChips t={t} /></td>}
            <td className="px-3 py-1.5 text-right tabular-nums text-hv-text">{fmtMs(t.latency.push)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Waterfall of one trace + the events behind it, with plain text on request. */
export const TraceDetail: React.FC<{ t: Trace; events: TEvent[]; api: TraceApi; runId: string | null; allowRaw: boolean; onClose: () => void }> = ({ t, events, api, runId, allowRaw, onClose }) => {
  const span = Math.max(1, ...t.hops.map(h => h.ms));
  const behind = events.filter(e => t.decision?.eventIds.includes(e.id));
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-hv-line shrink-0">
        <StatusIcon s={t.status} />
        <span className="text-sm font-semibold text-hv-text truncate">{t.action.label}</span>
        <span className="ml-auto" />
        <button onClick={onClose} className="text-hv-text-3 hover:text-hv-text" aria-label="Close"><X size={16} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-xs">
        {t.notes.length > 0 && (
          <div className={cx('rounded-hv-xs px-3 py-2 ring-1 ring-inset', t.status === 'fail' ? 'bg-hv-error-tint text-hv-error-fg ring-hv-error/40' : 'bg-hv-warning-tint text-hv-warning-fg ring-hv-warning/40')}>
            {t.notes.map((n, i) => <div key={i}>{n}</div>)}
          </div>
        )}
        <div>
          <div className="text-[11px] font-semibold text-hv-text-3 mb-1">Hops</div>
          <div className="space-y-1">
            {t.hops.map(h => (
              <div key={h.id} className="flex items-center gap-2">
                <span className="w-[190px] shrink-0 truncate text-hv-text-2" title={h.label}>{h.label}</span>
                <div className="flex-1 h-3 relative rounded-sm bg-hv-widget">
                  <div className={cx('absolute top-0 h-3 rounded-sm', HOP_TONE[h.id] || 'bg-hv-line-strong')} style={{ left: `${Math.max(0, Math.min(100, (h.ms / span) * 100))}%`, width: 4 }} />
                </div>
                <span className="w-[86px] text-right tabular-nums text-hv-text">{fmtMs(h.ms)}{h.clock === 'controller' && !h.corrected ? '*' : ''}</span>
                <span className="w-[70px] text-[10px] text-hv-text-3">{h.clock}{h.resolution ? ` ±${fmtMs(h.resolution)}` : ''}</span>
              </div>
            ))}
          </div>
          {t.hops.some(h => h.clock === 'controller' && !h.corrected) && <div className="mt-1 text-[11px] text-hv-text-3">* controller clock, not corrected (no sync cards matched)</div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line p-2">
            <div className="text-[11px] text-hv-text-3">Aether sent</div>
            <div className="font-mono text-hv-text">{credText(t.action.cred)}{t.action.cred?.format ? ` · ${t.action.cred.format}` : ''}</div>
            <div className="text-[11px] text-hv-text-3">{t.action.ch} · {clock(t.at)}</div>
          </div>
          <div className={cx('rounded-hv-xs p-2 ring-1 ring-inset', t.credCheck === 'mismatch' ? 'bg-hv-error-tint ring-hv-error/40' : 'bg-hv-widget ring-hv-line')}>
            <div className="text-[11px] text-hv-text-3">Controller reported</div>
            <div className="font-mono text-hv-text">{t.decision ? `${credText(t.decision.cred)}${t.decision.cred?.format ? ` · ${t.decision.cred.format}` : ''}` : '—'}</div>
            <div className="text-[11px] text-hv-text-3">{t.credCheck === 'match' ? 'same credential' : t.credCheck === 'mismatch' ? 'different credential' : t.credCheck === 'not-reported' ? 'the event has no card number' : ''}{t.decision ? ` · matched by ${t.decision.matchedBy}` : ''}</div>
          </div>
        </div>
        {t.decision && <div className="text-hv-text-3">Seen by: {t.decision.sources.map(s => SRC_LABEL[s] || s).join(' · ')}</div>}
        {behind.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-hv-text-3 mb-1">Events behind this decision</div>
            <div className="space-y-2">{behind.map(e => <EventBox key={e.id} e={e} api={api} runId={runId} allowRaw={allowRaw} />)}</div>
          </div>
        )}
      </div>
    </div>
  );
};

/** One event's payload: scrubbed by default, plain text on request for 60 s (logged on the Pi). */
export const EventBox: React.FC<{ e: TEvent; api: TraceApi; runId: string | null; allowRaw: boolean }> = ({ e, api, runId, allowRaw }) => {
  const [plain, setPlain] = useState<unknown>(undefined);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const show = async () => {
    setErr(null);
    try {
      const r = await api.reveal(runId, e.id);
      setPlain(r.raw); setLeft(60);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => setLeft(s => { if (s <= 1) { setPlain(undefined); if (timer.current) clearInterval(timer.current); return 0; } return s - 1; }), 1000);
    } catch (x) { setErr((x as Error).message); }
  };
  const hide = () => { setPlain(undefined); setLeft(0); if (timer.current) clearInterval(timer.current); };
  return (
    <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line overflow-hidden">
      <div className="flex items-center gap-2 px-2 h-7 bg-hv-widget">
        <Badge tone="purple">{SRC_LABEL[e.src] || e.src}</Badge>
        <span className="font-mono text-hv-text-2 truncate">{e.type}</span>
        {e.topic && <span className="font-mono text-[10px] text-hv-text-3 truncate">{e.topic}</span>}
        <span className="ml-auto text-[10px] text-hv-text-3 tabular-nums">{e.at ? clock(e.at) : ''}</span>
        {e.secret && (plain === undefined
          ? <Button size="sm" tone="ghost" icon={<Eye size={12} />} disabled={!allowRaw} title={allowRaw ? 'Show the original, unredacted payload for 60 s. Recorded on the Pi.' : 'Turned off in Setup › Privacy'} onClick={show}>Show plain text</Button>
          : <Button size="sm" tone="danger-soft" icon={<EyeOff size={12} />} onClick={hide}>Hide ({left}s)</Button>)}
        {!e.secret && e.hasRaw && <span className="text-[10px] text-hv-text-3 inline-flex items-center gap-1"><Lock size={10} />nothing secret</span>}
      </div>
      {err && <div className="px-2 py-1 text-hv-error-fg">{err}</div>}
      <pre className={cx('px-2 py-1.5 max-h-72 overflow-auto text-[11px] leading-snug font-mono whitespace-pre-wrap break-all', plain !== undefined ? 'bg-hv-error-tint text-hv-text' : 'text-hv-text-2')}>
        {JSON.stringify(plain !== undefined ? plain : (e.detail ?? { label: e.label, cred: e.cred, door: e.door, info: e.info }), null, 2)}
      </pre>
    </div>
  );
};

/** Swimlanes: every event of the last `windowMs`, one lane per vantage point. */
export const Swimlanes: React.FC<{ events: TEvent[]; windowMs: number; now: number; offset: number | null; onPick?: (e: TEvent) => void }> = ({ events, windowMs, now, offset, onPick }) => {
  const W = 1400, laneH = 22, top = 16, left = 84;
  const from = now - windowMs;
  const x = (t: number) => left + ((t - from) / windowMs) * (W - left - 8);
  const tOf = (e: TEvent) => (e.at != null ? e.at : e.t == null ? null : e.clock === 'controller' && offset != null ? e.t - offset : e.t);
  const shown = events.map(e => ({ e, t: tOf(e) })).filter(p => p.t != null && p.t >= from && p.t <= now + 1000) as { e: TEvent; t: number }[];
  const ticks = Array.from({ length: 7 }, (_, i) => from + (i * windowMs) / 6);
  const color = (e: TEvent) => e.lane === 'aether' ? 'rgb(var(--hv-brand))' : e.access ? (e.type.startsWith('accessgranted') ? 'rgb(var(--hv-success))' : 'rgb(var(--hv-error))') : e.lane === 'wire' ? 'rgb(var(--hv-info))' : 'rgb(var(--hv-text-3))';
  return (
    <svg viewBox={`0 0 ${W} ${top + laneH * LANES.length + 4}`} className="w-full h-auto select-none" role="img" aria-label="Event timeline by vantage point">
      {LANES.map((l, i) => (
        <g key={l.id}>
          <rect x={0} y={top + i * laneH} width={W} height={laneH} fill={i % 2 ? 'transparent' : 'rgb(var(--hv-widget))'} />
          <text x={8} y={top + i * laneH + laneH / 2 + 3.5} fontSize={10.5} fill="rgb(var(--hv-text-2))">{l.label}</text>
        </g>
      ))}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={x(t)} x2={x(t)} y1={top - 4} y2={top + laneH * LANES.length} stroke="rgb(var(--hv-line))" />
          <text x={x(t)} y={11} fontSize={9.5} textAnchor="middle" fill="rgb(var(--hv-text-3))">{i === 6 ? 'now' : `-${Math.round((now - t) / 1000)} s`}</text>
        </g>
      ))}
      {shown.map(({ e, t }) => {
        const li = LANES.findIndex(l => l.id === e.lane);
        const cy = top + li * laneH + laneH / 2;
        const r = e.lane === 'aether' || e.access ? 4.5 : 2.5;
        return (
          <circle key={e.id} cx={x(t)} cy={cy} r={r} fill={color(e)} opacity={e.lane === 'wire' ? 0.6 : 0.95} className="cursor-pointer" onClick={() => onPick && onPick(e)}>
            <title>{`${clock(t)} ${SRC_LABEL[e.src] || e.src}: ${e.label}${e.cred ? ` · ${credText(e.cred)}` : ''}${e.clock === 'controller' && offset == null && e.at == null ? ' (controller clock)' : ''}`}</title>
          </circle>
        );
      })}
    </svg>
  );
};
