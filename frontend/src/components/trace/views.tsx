// AETHER_TRACE — Event Trace pieces: verdict strip, clock card, traces table, hop waterfall, swimlane timeline
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, X, CheckCircle2, AlertTriangle, XCircle, Clock, Fingerprint, Lock, DoorOpen, Zap, Cloud } from 'lucide-react';
import { Badge, Button, Empty, cx, type Tone } from '../sunapi/ui';
import { clock, credText, fmtMs, LANES, SRC_LABEL, ROLE_LABEL, type Analysis, type Kind, type KindStats, type TEvent, type Trace, type TraceApi, type Stat } from './api';

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

const TILES: Record<Kind | 'all', [keyof KindStats, string, string][]> = {
  all: [['decision', 'Aether → controller reported', 'Corrected with the sync clock offset.'], ['push', 'Aether → cloud push (MQTT)', 'Both ends on the Pi clock.'], ['decisionToPush', 'Controller → cloud push', 'Controller + Cloud Connector + broker + cloud'], ['api', 'Aether → event log (API)', 'Resolution = poll interval.']],
  card: [['decision', 'Aether → controller decision', 'Corrected with the sync clock offset. Includes the reader transmission.'], ['reader', 'Aether → reader showed it', 'Until the controller told the reader to light up (OSDP LED command). What a person at the door sees.'], ['push', 'Aether → cloud push (MQTT)', 'Both ends on the Pi clock: this is the cloud latency.'], ['decisionToPush', 'Decision → cloud push', 'Controller + Cloud Connector + broker + cloud'], ['api', 'Aether → event log (API)', 'When the event first showed in the event log. Resolution = poll interval.']],
  input: [['decision', 'Aether change → controller event', 'DPS / REX / input change until the controller stamped its event (corrected).'], ['push', 'Aether change → cloud push', 'Both ends on the Pi clock.'], ['decisionToPush', 'Controller → cloud push', ''], ['api', 'Aether change → event log', '']],
  output: [['hardware', 'Controller event → output seen', 'From the controller stamping unlocked / output on until Aether saw the wire change.'], ['output', 'Cause → output seen', 'From the card / REX / command that asked for it until Aether saw the output.'], ['push', 'Cause → cloud push', ''], ['decision', 'Cause → controller event', '']],
  command: [['ack', 'Command → OnCAFE answered', 'HTTP round trip of the command.'], ['decision', 'Command → controller event', 'Until the controller stamped the resulting event (corrected).'], ['output', 'Command → Aether saw the output', 'Until the strike / output physically changed at Aether.'], ['push', 'Command → cloud push', '']],
};

export const Summary: React.FC<{ a: Analysis; kind?: Kind | 'all' }> = ({ a, kind = 'all' }) => {
  const s = kind === 'all' ? a.stats : a.stats.byKind[kind];
  return (
    <div className="flex flex-wrap gap-2">
      <div className="min-w-[150px] rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line px-3 py-1.5">
        <div className="text-[11px] text-hv-text-3">{kind === 'all' ? 'Everything traced' : 'Traced'}</div>
        <div className="flex items-center gap-1.5 text-sm">
          <Badge tone={statusTone(s.verdict)}>{s.verdict === 'no-data' ? 'no data' : s.verdict}</Badge>
          <span className="tabular-nums text-hv-text">{s.actions}</span>
          <span className="text-[11px] text-hv-text-3 tabular-nums">· {s.pass} pass · {s.warn} warn · {s.fail} fail</span>
        </div>
      </div>
      {TILES[kind].filter(([k]) => k !== 'reader' || ((s[k] as Stat | undefined)?.n || 0) > 0).map(([k, label, hint]) => <StatTile key={k} label={label} s={(s[k] as Stat) || { n: 0 }} hint={hint} />)}
      {((kind === 'all' || kind === 'card') && (s.credMismatch > 0 || a.stats.unexplained > 0)) && (
        <div className="rounded-hv-xs bg-hv-error-tint ring-1 ring-inset ring-hv-error/40 px-3 py-1.5 text-xs text-hv-error-fg">
          {s.credMismatch > 0 && <div><b>{s.credMismatch}</b> credential{s.credMismatch > 1 ? 's' : ''} changed on the way</div>}
          {a.stats.unexplained > 0 && <div><b>{a.stats.unexplained}</b> controller decision{a.stats.unexplained > 1 ? 's' : ''} nobody triggered</div>}
        </div>
      )}
    </div>
  );
};

/** TRACE-4: did every controller event reach the cloud once, in order? */
const INTEG: { k: 'lostInPush' | 'notInLog' | 'onlyInLog' | 'duplicates' | 'outOfOrder'; label: string; tone: 'error' | 'warning'; hint: string }[] = [
  { k: 'lostInPush', label: 'never pushed', tone: 'error', hint: 'In the event log (or the controller log) but never pushed over MQTT' },
  { k: 'onlyInLog', label: 'only in the controller log', tone: 'error', hint: 'In the controller\'s own log (Log Analytics report) but never in the cloud' },
  { k: 'notInLog', label: 'not in the event log', tone: 'warning', hint: 'Pushed, but the event-log API never returned it' },
  { k: 'duplicates', label: 'pushed twice', tone: 'warning', hint: 'The same event pushed more than once' },
  { k: 'outOfOrder', label: 'out of order', tone: 'warning', hint: 'Pushed after an event the controller stamped later' },
];
export const IntegrityCard: React.FC<{ a: Analysis }> = ({ a }) => {
  const [open, setOpen] = React.useState<string | null>(null);
  const g = a.integrity;
  if (!g || g.verdict === 'no-data') return null;
  const list = open ? (g[open as keyof typeof g] as unknown as import('./api').IntegrityItem[]) : [];
  return (
    <div className="rounded-hv-xs ring-1 ring-inset ring-hv-line px-3 py-1.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-hv-text">Every event, once, in order</span>
        <Badge tone={g.verdict === 'pass' ? 'success' : g.verdict === 'fail' ? 'error' : 'warning'}>{g.verdict === 'pass' ? 'all accounted for' : `${g.issues} to look at`}</Badge>
        <span className="text-hv-text-3">{g.counts.push} pushed · {g.counts.eventLog} in the event log{g.counts.controllerLog ? ` · ${g.counts.controllerLog} in the controller log` : ''}{!g.apiOn ? ' · event-log poll off (no lost-push check)' : ''}</span>
        {INTEG.filter(x => (g[x.k] as unknown[]).length).map(x => (
          <button key={x.k} title={x.hint} onClick={() => setOpen(open === x.k ? null : x.k)} className={cx('rounded-hv-xs px-1.5 py-0.5', open === x.k ? 'ring-1 ring-hv-line-strong' : '')}>
            <Badge tone={x.tone}>{(g[x.k] as unknown[]).length} {x.label}</Badge>
          </button>
        ))}
      </div>
      {open && (
        <table className="w-full mt-1"><tbody>
          {list.slice(0, 50).map((e, i) => (
            <tr key={i} className="border-t border-hv-line">
              <td className="py-0.5 pr-2 font-mono text-hv-text-3 w-[100px]">{e.at != null ? clock(e.at) : e.t != null ? clock(e.t) : ''}</td>
              <td className="pr-2 font-mono text-hv-text">{e.type}</td><td className="pr-2 text-hv-text-3">{e.door || ''}</td>
              <td className="pr-2 text-hv-text-3">{e.copies ? `${e.copies} copies, ${fmtMs(e.gapMs)} apart` : e.byMs ? `stamped ${fmtMs(e.byMs)} before ${e.after ? e.after.type : 'an earlier push'}` : `seen in: ${e.where}`}</td>
              <td className="text-hv-text-3 font-mono">{e.eventId ? e.eventId.slice(0, 12) : ''}</td>
            </tr>))}
        </tbody></table>
      )}
    </div>
  );
};

export const ClockCard: React.FC<{ a: Analysis; live?: import('./api').ClockCheck | null; onCheck?: () => void }> = ({ a, live, onCheck }) => {
  const c = a.clock;
  const cc = a.meta?.controllerClocks || live || null;
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
        <div className="text-hv-text-3">No sync markers in this run. Start a run with sync markers (Setup › Sync markers) so controller timestamps line up with the Pi.</div>
      ) : sets.map(({ set, rows }) => (
        <div key={set} className="flex flex-wrap items-center gap-1.5 mt-1">
          <span className="w-10 text-hv-text-3">{set}</span>
          {rows.map((r, i) => (
            <Badge key={i} tone={r.matched ? 'success' : 'error'} title={r.matched ? `${r.type} at controller ${clock(r.eventT!)}${r.byPattern ? ' — matched by the gap between the cards (the cloud did not report card numbers)' : ''}` : 'Not found in the controller/cloud events'}>
              {r.ch ? `${r.ch} ${r.v ? 'on' : 'off'}` : `${r.fc}-${r.cn}`} {r.matched ? `${r.offset! >= 0 ? '+' : ''}${fmtMs(r.offset)}` : 'missing'}{r.byPattern ? ' ≈' : ''}
            </Badge>
          ))}
        </div>
      ))}
      {c.gaps.length > 0 && <div className="mt-1 text-hv-text-3">Gaps sent / seen: {c.gaps.map(g => `${fmtMs(g.sent)} / ${fmtMs(g.seen)}`).join(' · ')}</div>}
      {/* TRACE-5: each controller's own clock (SUNAPI), read at the start of the run */}
      {(cc || onCheck) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          <span className="text-hv-text-3">Controller clocks{cc && cc.at ? ` (${new Date(cc.at).toLocaleTimeString()})` : ''}:</span>
          {cc && !cc.available && <span className="text-hv-text-3">{cc.reason}</span>}
          {cc && cc.available && !cc.controllers.length && <span className="text-hv-text-3">no access controllers saved in Tools › SUNAPI Console</span>}
          {cc && cc.controllers.map(x => (
            <Badge key={x.id} tone={x.error ? 'neutral' : Math.abs(x.offsetMs || 0) > (cc.warnMs || 2000) ? 'warning' : 'success'}
              title={x.error ? x.error : `SUNAPI date view · round trip ${fmtMs(x.rttMs)} · ±${fmtMs(x.resolutionMs)}${x.sync ? ` · time sync: ${x.sync}` : ''}${x.ntp ? ` (${x.ntp})` : ''}${x.tz ? ` · ${x.tz}` : ''}`}>
              {x.name}: {x.error ? 'not read' : `${(x.offsetMs || 0) >= 0 ? '+' : '−'}${fmtMs(Math.abs(x.offsetMs || 0))}`}{x.sync ? ` · ${x.sync}` : ''}
            </Badge>
          ))}
          {onCheck && <button className="text-hv-brand hover:underline" onClick={onCheck}>Check now</button>}
        </div>
      )}
    </div>
  );
};

const HOP_TONE: Record<string, string> = { cause: 'bg-hv-brand', ack: 'bg-hv-info', state: 'bg-hv-success', sent: 'bg-hv-brand', decided: 'bg-hv-purple', published: 'bg-hv-purple', wire: 'bg-hv-info', push: 'bg-hv-success', stored: 'bg-hv-success', api: 'bg-hv-warning', browser: 'bg-hv-warning', lock: 'bg-hv-text-3', reader: 'bg-hv-success', beep: 'bg-hv-success' };

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

const KindIcon: React.FC<{ t: Trace }> = ({ t }) => {
  const c = 'text-hv-text-3 shrink-0';
  return t.kind === 'card' ? <Fingerprint size={13} className={c} /> : t.kind === 'input' ? <DoorOpen size={13} className={c} /> : t.kind === 'output' ? <Zap size={13} className={c} /> : <Cloud size={13} className={c} />;
};
const mainLatency = (t: Trace) => (t.kind === 'output' ? t.latency.hardware ?? t.latency.output : t.kind === 'command' ? t.latency.output ?? t.latency.push ?? t.latency.decision : t.latency.push);
const latencyHead = (k: Kind | 'all') => (k === 'output' ? 'Controller → output' : k === 'command' ? 'To the door' : 'Cloud push');

export const TraceTable: React.FC<{ traces: Trace[]; selected: string | null; onSelect: (id: string | null) => void; showSync: boolean; compact?: boolean; kind?: Kind | 'all' }> = ({ traces, selected, onSelect, showSync, compact, kind = 'all' }) => {
  const rows = useMemo(() => traces.filter(t => (showSync || !t.sync) && (kind === 'all' || t.kind === kind)).slice().reverse(), [traces, showSync, kind]);
  if (!rows.length) return (
    <Empty icon={<Fingerprint size={28} />} title="Nothing traced yet">
      {kind === 'output' ? 'Outputs show up when Aether sees a controller output change (opto inputs or emulated board outputs). Map them in Setup › Wiring.'
        : kind === 'command' ? 'Send a command from here (Commands), or capture the OnCAFE web app with the Traffic Inspector or a HAR.'
          : kind === 'input' ? 'Drive a DPS, REX or input from Aether (relays or emulated board inputs). Map the channels in Setup › Wiring.'
            : 'Present a card, open a door or send a command from Aether. Each one is followed through the controller to the cloud.'}
    </Empty>
  );
  return (
    <table className="w-full text-[12px] table-fixed">
      <thead className="sticky top-0 bg-hv-widget-panel z-10">
        <tr className="text-left text-[11px] text-hv-text-3 border-b border-hv-line">
          <th className="font-semibold px-3 py-1.5 w-[100px]">Time</th>
          <th className="font-semibold px-2 py-1.5 w-[30px]" />
          <th className="font-semibold px-2 py-1.5">What happened</th>
          <th className="font-semibold px-2 py-1.5 w-[180px]">Controller</th>
          {!compact && <th className="font-semibold px-2 py-1.5">Hops</th>}
          <th className="font-semibold px-3 py-1.5 text-right w-[96px]">{latencyHead(kind)}</th>
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
                <KindIcon t={t} />
                {t.kind === 'card' ? <span className="font-mono text-hv-text">{credText(t.action.cred)}</span> : <span className="text-hv-text truncate">{t.action.label}</span>}
                {t.sync && <Badge tone="info">sync</Badge>}
                {t.credCheck === 'mismatch' && <Badge tone="error">decoded {credText(t.decision?.cred)}</Badge>}
                {t.kind === 'card' && t.expect && <Badge tone="neutral">expect {t.expect}</Badge>}
                {t.held != null && <Badge tone="neutral">held {(t.held / 1000).toFixed(1)} s</Badge>}
              </div>
              <div className="text-[11px] text-hv-text-3 truncate">
                {t.kind === 'output' ? (t.cause ? `asked by ${t.cause.label}` : t.action.v ? 'nothing asked for it' : '') : t.action.ch || ''}{t.notes[0] ? ` · ${t.notes[0]}` : ''}
              </div>
            </td>
            <td className="px-2 py-1.5 overflow-hidden">
              {t.decision ? <>
                <Badge tone={/denied|forced|held|alarm|tamper/.test(t.decision.type) ? 'error' : 'success'}>{t.decision.type}</Badge>
                <div className="text-[11px] text-hv-text-3 truncate">{t.decision.door?.name || t.decision.door?.id || ''}{t.decision.clientType ? ` · ${t.decision.clientType}` : ''}</div>
              </> : <span className="text-hv-text-3">{t.expect ? `no ${t.expect}` : '—'}</span>}
            </td>
            {!compact && <td className="px-2 py-1.5"><HopChips t={t} /></td>}
            <td className="px-3 py-1.5 text-right tabular-nums text-hv-text">{fmtMs(mainLatency(t))}</td>
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
        {t.kind !== 'card' && (
          <div className="rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line p-2 space-y-0.5">
            {t.role && <div><span className="text-hv-text-3">Channel role: </span><span className="text-hv-text">{ROLE_LABEL[t.role] || t.role}</span></div>}
            {t.expect && <div><span className="text-hv-text-3">Expected from the controller: </span><span className="text-hv-text">{t.expect}</span>{t.result ? <span className="text-hv-text-3"> · got {t.result}</span> : null}</div>}
            {t.kind === 'output' && <div><span className="text-hv-text-3">Asked by: </span><span className="text-hv-text">{t.cause ? `${t.cause.label} at ${clock(t.cause.at)}` : t.action.v ? 'nothing Aether saw' : '—'}</span></div>}
            {t.held != null && <div><span className="text-hv-text-3">On for: </span><span className="text-hv-text">{(t.held / 1000).toFixed(2)} s</span></div>}
            {t.kind === 'command' && t.action.cmd && <div><span className="text-hv-text-3">Target: </span><span className="text-hv-text">{t.action.cmd.targetName || [].concat(t.action.cmd.target as never).join(', ')}</span></div>}
          </div>
        )}
        {t.kind === 'card' && <div className="grid grid-cols-2 gap-2">
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
        </div>}
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
