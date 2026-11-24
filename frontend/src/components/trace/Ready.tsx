// AETHER_TRACE (TRACE-9) — the easy way in.
//   ReadyPanel     "Ready to trace?": what is set up and what is not, each with one Fix button. Folds to a line once ready.
//   DoorCheckBox   "Test this door": pick a door, press Test; runs the standard checks and answers in words.
//   DoorCheckView  the answer: a headline, one line per check (✓ / ✕) with what happened and, for problems, the likely cause.
import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronRight, Loader2, Play, Square, DoorOpen, Wrench } from 'lucide-react';
import { Badge, Button, Input, Toggle, cx } from '../sunapi/ui';
import { type DoorCheckPlan, type DoorCheckResult, type Readiness, type ReadyAction, type Status, type TestCard, type TraceApi } from './api';
import { ProblemList } from './views';

const Icon: React.FC<{ s: 'ok' | 'warn' | 'todo' }> = ({ s }) => s === 'ok' ? <CheckCircle2 size={15} className="text-hv-success shrink-0" /> : s === 'warn' ? <AlertTriangle size={15} className="text-hv-warning shrink-0" /> : <XCircle size={15} className="text-hv-error shrink-0" />;
const cardText = (c: TestCard) => (c ? `${c.fc !== '' ? c.fc + '-' : ''}${c.cn}` : '');
const parseCard = (t: string): TestCard => { const m = /^\s*(?:(\d+)\s*[-/ ]\s*)?(\d+)\s*$/.exec(t); return m ? { fc: m[1] || '', cn: m[2] } : null; };

// ── the test cards (valid / without access) ───────────────────────────────
const CardsEditor: React.FC<{ api: TraceApi; status: Status; onSaved: () => void }> = ({ api, status, onSaved }) => {
  const q = status.settings.quick || { valid: null, invalid: null, held: false, heldMs: 30000 };
  const [v, setV] = useState(cardText(q.valid)), [x, setX] = useState(cardText(q.invalid));
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const valid = v.trim() ? parseCard(v) : null, invalid = x.trim() ? parseCard(x) : null;
    if ((v.trim() && !valid) || (x.trim() && !invalid)) return setErr('Write cards as facility-number, e.g. 55-1001 (or just the number)');
    setBusy(true); setErr(null);
    try { await api.saveSettings({ quick: { ...q, valid, invalid } }); onSaved(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 max-w-[520px]">
      <span className="text-hv-text-3">Card with access</span>
      <Input value={v} onChange={e => setV(e.target.value)} placeholder={`e.g. 55-1001 (empty: sync card ${status.settings.sync.cards[0] ? `${status.settings.sync.cards[0].fc}-${status.settings.sync.cards[0].cn}` : ''})`} />
      <span className="text-hv-text-3">Card without access</span>
      <Input value={x} onChange={e => setX(e.target.value)} placeholder="a number nobody has, e.g. 55-65001" />
      <span />
      <div className="flex items-center gap-2"><Button size="sm" tone="primary" busy={busy} onClick={save}>Save cards</Button>{err && <span className="text-hv-error-fg">{err}</span>}</div>
    </div>
  );
};

// ── Ready to trace? ───────────────────────────────────────────────────────
export const ReadyPanel: React.FC<{ api: TraceApi; status: Status; onGo: (anchor: string) => void; onChanged: () => void; onOpenRun: (runId: string) => void }> = ({ api, status, onGo, onChanged, onOpenRun }) => {
  const [R, setR] = useState<Readiness | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);   // null = decide from readiness
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editCards, setEditCards] = useState(false);
  const load = useCallback(() => api.ready().then(setR).catch(e => setErr((e as Error).message)), [api]);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const fix = async (a: ReadyAction) => {
    setErr(null);
    if (a.startsWith('setup:')) return onGo(`trace-${a.replace(':', '-')}`);
    if (a === 'cards') return setEditCards(x => !x);
    if (a === 'open:doors') return setErr('Open the Doors page from the main menu, add or pair the doors there, then come back.');
    setBusy(a);
    try {
      if (a === 'connect') await api.connect();
      else if (a === 'adopt') await api.adopt();
      else if (a === 'sync') await api.sync('check');
      else if (a === 'links') await api.links(true);
      onChanged(); await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  if (!R) return null;
  const isOpen = open ?? !R.ready;
  return (
    <div className={cx('rounded-hv-xs ring-1 ring-inset', R.ready ? 'ring-hv-line' : 'ring-hv-warning/50 bg-hv-warning-tint/30')}>
      <button className="w-full flex items-center gap-2 px-3 py-1.5 text-left" onClick={() => setOpen(!isOpen)}>
        {isOpen ? <ChevronDown size={14} className="text-hv-text-3" /> : <ChevronRight size={14} className="text-hv-text-3" />}
        <Icon s={R.ready ? (R.warn ? 'warn' : 'ok') : 'todo'} />
        <span className="text-sm font-semibold text-hv-text">{R.ready ? 'Ready to trace' : `Ready to trace? ${R.todo} thing${R.todo === 1 ? '' : 's'} to set up`}</span>
        {R.ready && R.warn > 0 && <span className="text-[11px] text-hv-warning-fg">{R.warn} to look at</span>}
        <span className="ml-auto text-[11px] text-hv-text-3">{isOpen ? 'hide' : 'show'}</span>
      </button>
      {isOpen && (
        <div className="px-3 pb-3 space-y-1.5 text-xs">
          {R.items.map(i => (
            <div key={i.id}>
              <div className="flex items-start gap-2">
                <Icon s={i.state} />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-hv-text">{i.title}</span>
                  <span className="text-hv-text-3"> — {i.detail}</span>
                </div>
                {i.fix && <Button size="sm" tone={i.state === 'ok' ? 'ghost' : 'primary'} busy={busy === i.fix.action} icon={<Wrench size={12} />} onClick={() => fix(i.fix!.action)}>{i.fix.label}</Button>}
              </div>
              {i.id === 'cards' && editCards && <div className="pl-6"><CardsEditor api={api} status={status} onSaved={() => { setEditCards(false); onChanged(); load(); }} /></div>}
            </div>
          ))}
          {err && <div className="text-hv-error-fg">{err}</div>}
        </div>
      )}
      <div className="border-t border-hv-line px-3 py-2"><DoorCheckBox api={api} status={status} onOpenRun={onOpenRun} compact /></div>
    </div>
  );
};

// ── Test this door ────────────────────────────────────────────────────────
export const DoorCheckBox: React.FC<{ api: TraceApi; status: Status; onOpenRun: (runId: string) => void; fixedDoor?: number; compact?: boolean }> = ({ api, status, onOpenRun, fixedDoor, compact }) => {
  const [doors, setDoors] = useState<{ id: number; name: string }[]>([]);
  const [door, setDoor] = useState<number | null>(fixedDoor ?? null);
  const [held, setHeld] = useState<boolean>(!!status.settings.quick?.held);
  const [plan, setPlan] = useState<DoorCheckPlan | null>(null);
  const [res, setRes] = useState<DoorCheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dc = status.doorCheck;
  const running = !!(door != null && dc && dc.door === door && dc.state !== 'done');
  useEffect(() => { api.doors().then(r => { const list = (r.doors || []).filter(d => d.enabled !== false).map(d => ({ id: d.id, name: d.name })); setDoors(list); setDoor(x => x ?? (list[0] ? list[0].id : null)); }).catch(() => {}); }, [api]);
  useEffect(() => { if (door == null) return; setPlan(null); api.doorCheckPlan(door, held).then(setPlan).catch(e => setPlan({ door, name: '', steps: [], skipped: [(e as Error).message] })); }, [api, door, held]);
  // the newest check of this door; while one runs, follow it, and read it once more when it ends (late answers, final grading)
  const runId = door != null && dc && dc.door === door ? dc.runId : null;
  useEffect(() => {
    setRes(null);
    if (door == null) return;
    let gone = false;
    const show = (id: string) => api.doorCheckResult(id).then(r => { if (!gone && r.door === door) setRes(r); }).catch(() => {});
    let t: ReturnType<typeof setInterval> | null = null;
    if (runId) { show(runId); if (running) t = setInterval(() => show(runId), 2000); }
    else api.doorChecks().then(m => { const x = m[String(door)]; if (x && !gone) show(x.runId); }).catch(() => {});
    return () => { gone = true; if (t) clearInterval(t); };
  }, [api, door, runId, running]);
  const otherTest = !!(status.test && status.test.state !== 'done' && !running);
  const start = async () => {
    if (door == null) return;
    setBusy(true); setErr(null);
    try { await api.doorCheck(door, held); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const t = status.test;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <DoorOpen size={15} className="text-hv-text-3" />
        <span className="text-sm font-semibold text-hv-text">Test this door</span>
        {fixedDoor == null && (
          <select className="h-7 rounded-hv-xs bg-hv-widget ring-1 ring-inset ring-hv-line px-2 text-xs text-hv-text" value={door ?? ''} onChange={e => setDoor(Number(e.target.value))}>
            {!doors.length && <option value="">no doors on the Doors page</option>}
            {doors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        <Toggle on={held} onChange={setHeld} label="include held open (slow)" />
        <span className="ml-auto" />
        {running ? <Button size="sm" tone="danger" icon={<Square size={12} />} onClick={() => api.stopTest().catch(e => setErr((e as Error).message))}>Stop</Button>
          : <Button size="sm" tone="primary" icon={<Play size={12} />} busy={busy} disabled={door == null || otherTest || !plan || !plan.steps.length} onClick={start}
              title={otherTest ? 'Another test is running' : 'Moves this door\'s real inputs and presents real cards (admins only)'}>Test</Button>}
      </div>
      {plan && !running && (
        <div className="text-hv-text-3">
          {plan.steps.length ? <>Checks: {plan.steps.join(' · ')}</> : 'Nothing this door can be checked with yet.'}
          {plan.skipped.length > 0 && <span className="text-hv-warning-fg"> · Not checked: {plan.skipped.join('; ')}</span>}
        </div>
      )}
      {running && t && <div className="flex items-center gap-2 text-hv-text-2"><Loader2 size={13} className="animate-spin" />{t.state === 'grading' ? 'Waiting for late answers, then grading…' : `Step ${Math.min(t.done + 1, t.steps)} of ${t.steps}${t.last && t.last.length ? `: ${t.last[t.last.length - 1].text}` : ''}`}</div>}
      {err && <div className="text-hv-error-fg">{err}</div>}
      {res && !running && <DoorCheckView r={res} onOpenRun={onOpenRun} compact={compact} />}
    </div>
  );
};

export const DoorCheckView: React.FC<{ r: DoorCheckResult; onOpenRun?: (runId: string) => void; compact?: boolean }> = ({ r, onOpenRun, compact }) => {
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [more, setMore] = useState(!compact || !r.ok);   // on the Live tab a passing check is one line
  useEffect(() => { setMore(!compact || !r.ok); }, [r.runId, r.ok, compact]);
  return (
    <div className={cx('rounded-hv-xs ring-1 ring-inset p-2.5 space-y-1.5', r.ok ? 'ring-hv-success/40 bg-hv-success-tint/40' : 'ring-hv-error/40 bg-hv-error-tint/40')}>
      <div className="flex items-center gap-2">
        {r.ok ? <CheckCircle2 size={16} className="text-hv-success" /> : <XCircle size={16} className="text-hv-error" />}
        <span className="text-[13px] font-semibold text-hv-text">{r.headline}</span>
        <span className="ml-auto text-[11px] text-hv-text-3">{new Date(r.startedAt).toLocaleString()}</span>
        {compact && <button className="text-[11px] text-hv-brand hover:underline" onClick={() => setMore(x => !x)}>{more ? 'less' : 'details'}</button>}
        {onOpenRun && <button className="text-[11px] text-hv-brand hover:underline" onClick={() => onOpenRun(r.runId)}>full report</button>}
      </div>
      {r.error && !r.headline.includes(r.error) && <div className="text-hv-error-fg">{r.error}</div>}
      {more && <>
      <div className="space-y-0.5">
        {r.lines.map((l, i) => (
          <div key={i}>
            <button className="w-full flex items-start gap-2 text-left" onClick={() => setOpenLine(openLine === i ? null : i)}>
              {l.ok ? (l.warn && l.problems.length ? <AlertTriangle size={14} className="text-hv-warning shrink-0 mt-px" /> : <CheckCircle2 size={14} className="text-hv-success shrink-0 mt-px" />) : <XCircle size={14} className="text-hv-error shrink-0 mt-px" />}
              <span className="font-semibold text-hv-text w-[150px] shrink-0">{l.label}</span>
              <span className="text-hv-text-2 flex-1">{!l.ok && l.problems[0] ? l.problems[0].plain : l.say || (l.ok ? 'as expected' : 'failed')}</span>
              {l.problems.length > 0 && <span className="text-[11px] text-hv-brand shrink-0">{openLine === i ? 'less' : 'why?'}</span>}
            </button>
            {openLine === i && l.problems.length > 0 && <div className="pl-6 pt-1 pb-1.5">{l.say && <div className="text-hv-text-2 mb-1">{l.say}</div>}<ProblemList problems={l.problems} fail={!l.ok} /></div>}
          </div>
        ))}
      </div>
      {r.notChecked.length > 0 && <div className="text-[11px] text-hv-text-3">Not checked: {r.notChecked.join('; ')}</div>}
      <Badge tone="neutral">{r.lines.filter(l => l.ok).length} of {r.lines.length} as expected</Badge>
      </>}
    </div>
  );
};
