// OSDP Trace — one window on the RS-485 bus, every line in plain English.
// Backed by the single backend decoder/analyzer (backend/osdp/trace/*): live
// feed over socket, snapshot on mount, plus health, timeline, rules and captures.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Activity, Radio, Clock, ClipboardCheck, Search, Pause, Play, Trash2, Save, FolderOpen,
  Download, AlertTriangle, CheckCircle, XCircle, ChevronRight, Wifi, WifiOff, CreditCard, Circle,
} from 'lucide-react';
import { T, Card } from '../config/ui';

type Level = 'info' | 'warn' | 'crit';
interface Anom { level: Level; text: string }
interface FrameView {
  name: string; summary: string; hint?: string; section?: string; description?: string;
  hex: string; dataHex: string; sequence: number; checkOk: boolean; check: string;
  errors: string[]; warnings: string[]; encrypted?: boolean; secureType?: number; scb?: any; decoded?: any;
}
interface Row {
  id: number; kind: 'exchange' | 'reply' | 'idle'; address: number; ts?: number;
  summary: string; replyMs?: number | null; replySummary?: string; replyName?: string; timedOut?: boolean;
  anomalies?: Anom[]; command?: FrameView; reply?: FrameView | null;
  startTs?: number; lastTs?: number; acks?: number;
}
interface Health {
  address: number; online: boolean; polls: number; commands: number; replies: number; naks: number;
  retries: number; timeouts: number; busy: number; crcErrors: number; avgReplyMs: number | null; maxReplyMs: number;
  lastCard: any; lastCardAt: number | null; cardReads: number; tamper: number | null; power: number | null;
  model: number | null; firmware: string | null; secure: boolean; capabilities: any[] | null; lastSeenAgoMs: number | null;
}
interface Rule { id: string; name: string; whenName: string; expectName: string; withinMs: number; address: number | null; color?: string | null; pass: number; fail: number; armed: boolean }
interface FrameRec { id: number; ts: number; direction: 'tx' | 'rx'; address: number; isReply: boolean; name: string; summary: string; checkOk: boolean; hex: string; }

const LV: Record<Level, string> = { info: T.blue, warn: T.warn, crit: T.crit };
const timeOf = (ts?: number) => ts ? new Date(ts).toLocaleTimeString('en-US', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0') : '';
const cardText = (c: any) => c ? `FC ${c.facility ?? '—'} · #${c.card}${c.parityOk === false ? ' (parity FAIL)' : ''}` : '—';

export default function OsdpTrace({ api }: { api: string }) {
  const [view, setView] = useState<'convo' | 'readers' | 'timeline' | 'rules'>('convo');
  const [rows, setRows] = useState<Row[]>([]);
  const [frames, setFrames] = useState<FrameRec[]>([]);
  const [health, setHealth] = useState<Health[]>([]);
  const [source, setSource] = useState('emulator');
  const [live, setLive] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Row | null>(null);
  const [addr, setAddr] = useState<number | 'all'>('all');
  const [hideIdle, setHideIdle] = useState(false);
  const liveRef = useRef(true); useEffect(() => { liveRef.current = live; }, [live]);
  const rowMap = useRef<Map<number, Row>>(new Map());

  // snapshot + live socket
  const applyRows = useCallback((incoming: Row[]) => {
    for (const r of incoming) rowMap.current.set(r.id, r);
    setRows([...rowMap.current.values()].sort((a, b) => a.id - b.id).slice(-4000));
  }, []);

  const loadSnapshot = useCallback(async () => {
    try {
      const j = await (await fetch(`${api}/api/osdp/trace/snapshot`)).json();
      if (!j.success) return;
      rowMap.current = new Map(j.events.map((e: Row) => [e.id, e]));
      setRows(j.events); setFrames(j.frames.slice(-4000)); setHealth(j.health); setSource(j.source);
    } catch { /* */ }
  }, [api]);

  useEffect(() => {
    loadSnapshot();
    const s: Socket = io(api || undefined, { transports: ['websocket', 'polling'] });
    s.on('osdp-trace-events', (evs: Row[]) => { if (liveRef.current) applyRows(evs); });
    s.on('osdp-trace-frame', (f: FrameRec) => { if (liveRef.current) setFrames(p => [...p, f].slice(-4000)); });
    s.on('osdp-trace-cleared', () => { rowMap.current.clear(); setRows([]); setFrames([]); setHealth([]); });
    const hb = setInterval(async () => {
      try { const j = await (await fetch(`${api}/api/osdp/trace/snapshot?since=999999999`)).json(); if (j.success) { setHealth(j.health); setSource(j.source); } } catch { /* */ }
    }, 2000);
    return () => { s.close(); clearInterval(hb); };
  }, [api, applyRows, loadSnapshot]);

  const addresses = useMemo(() => [...new Set(rows.map(r => r.address))].sort((a, b) => a - b), [rows]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      if (addr !== 'all' && r.address !== addr) return false;
      if (hideIdle && r.kind === 'idle') return false;
      if (!words.length) return true;
      const hay = `${r.summary} ${r.replySummary || ''} addr ${r.address} ${r.command?.name || ''} ${r.reply?.name || ''} ${(r.anomalies || []).map(a => a.text).join(' ')}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }, [rows, q, addr, hideIdle]);

  const clear = () => fetch(`${api}/api/osdp/trace/clear`, { method: 'POST' });
  const exportUrl = (fmt: string) => { window.open(`${api}/api/osdp/trace/export?format=${fmt}`, '_blank'); };

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2" style={{ background: 'rgb(var(--hv-widget) / 0.5)', borderColor: T.line2 }}>
        <span className="flex items-center gap-2 text-sm font-bold" style={{ color: T.text }}><Activity size={16} style={{ color: T.amber }} />OSDP Trace</span>
        <span className="text-[11px] px-2 py-0.5 rounded" style={{ background: T.input, color: T.text2 }}>{source.startsWith('capture') ? source : source === 'sniffer' ? 'Passive sniffer' : 'Emulator bus'}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 rounded-md px-2" style={{ background: T.input }}>
          <Search size={14} style={{ color: T.dim }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search plain English: card 45678, NAK, reader 2, LED red…"
            className="bg-transparent outline-none text-sm py-1.5 w-[300px] max-w-[42vw]" style={{ color: T.text }} />
        </div>
        <button onClick={() => setLive(l => !l)} className="px-2.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 border"
          style={live ? { background: 'rgb(var(--hv-success-tint-strong))', borderColor: T.green, color: 'rgb(var(--hv-success-text))' } : { background: 'rgb(var(--hv-brand-tint))', borderColor: T.amber, color: 'rgb(var(--hv-brand-text))' }}>
          {live ? <><Pause size={13} />Live</> : <><Play size={13} />Paused</>}
        </button>
        <button onClick={clear} title="Clear" className="p-1.5 rounded-md border" style={{ borderColor: T.line2, color: T.text2 }}><Trash2 size={14} /></button>
        <Sniffer api={api} />
        <Captures api={api} onLoaded={loadSnapshot} />
        <div className="inline-flex rounded-md overflow-hidden border" style={{ borderColor: T.line2 }}>
          {['csv', 'json', 'txt'].map(f => <button key={f} onClick={() => exportUrl(f)} className="px-2 py-1.5 text-xs font-semibold" style={{ color: T.text2 }} title={`Export ${f.toUpperCase()}`}>{f.toUpperCase()}</button>)}
        </div>
      </div>

      {/* view tabs + address filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex p-0.5 rounded-lg" style={{ background: T.input }}>
          {[['convo', 'Conversation', Activity], ['readers', 'Readers', Radio], ['timeline', 'Timeline', Clock], ['rules', 'Tests', ClipboardCheck]].map(([id, label, Icon]: any) => (
            <button key={id} onClick={() => setView(id)} className="px-3 py-1.5 rounded-md text-sm font-semibold inline-flex items-center gap-2"
              style={view === id ? { background: 'rgb(var(--hv-popup-panel))', color: T.text, boxShadow: `inset 0 -2px 0 ${T.amber}` } : { color: T.dim }}><Icon size={14} />{label}</button>
          ))}
        </div>
        {(view === 'convo') && <>
          <select value={String(addr)} onChange={e => setAddr(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="rounded-md px-2 py-1.5 text-xs border" style={{ background: T.input, borderColor: T.line2, color: T.text }}>
            <option value="all">All readers</option>
            {addresses.map(a => <option key={a} value={a}>Reader {a === 0x7F ? 'broadcast' : a}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: T.text2 }}><input type="checkbox" checked={hideIdle} onChange={e => setHideIdle(e.target.checked)} />Hide idle polling</label>
        </>}
      </div>

      {view === 'convo' && <Conversation rows={shown} onSelect={setSel} sel={sel} />}
      {view === 'readers' && <Readers health={health} />}
      {view === 'timeline' && <Timeline frames={frames} health={health} />}
      {view === 'rules' && <Rules api={api} />}

      {sel && <Inspector row={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

// ── Conversation ──
function Conversation({ rows, onSelect, sel }: { rows: Row[]; onSelect: (r: Row) => void; sel: Row | null }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [rows.length]);
  return (
    <Card pad={false}>
      <div className="max-h-[560px] overflow-y-auto font-mono text-[13px]">
        {rows.length === 0 && <div className="px-4 py-10 text-center" style={{ color: T.dim }}>No traffic yet. When the emulator or a sniffer is running, decoded messages appear here.</div>}
        {rows.map(r => {
          const worst = (r.anomalies || []).reduce((w, a) => a.level === 'crit' ? 'crit' : (a.level === 'warn' && w !== 'crit') ? 'warn' : w, '' as string);
          if (r.kind === 'idle') return (
            <div key={r.id} className="flex items-center gap-3 px-4 py-1.5 border-b" style={{ borderColor: T.line, color: T.faint }}>
              <span className="w-16 shrink-0" />
              <Circle size={7} /><span className="italic">{r.summary}</span>
            </div>
          );
          const isReplyOnly = r.kind === 'reply';
          return (
            <div key={r.id} onClick={() => onSelect(r)} className="px-4 py-1.5 border-b cursor-pointer hover:bg-white/[0.03]"
              style={{ borderColor: T.line, background: sel?.id === r.id ? 'rgb(var(--hv-brand) / 0.08)' : worst === 'crit' ? 'rgb(var(--hv-error) / 0.06)' : undefined }}>
              <div className="flex items-start gap-3">
                <span className="shrink-0 tabular-nums" style={{ color: T.faint, fontSize: 11, width: 92 }}>{timeOf(r.ts)}</span>
                <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: isReplyOnly ? 'rgb(var(--hv-info) / 0.15)' : 'rgb(var(--hv-brand) / 0.12)', color: isReplyOnly ? T.teal : T.amber }}>
                  {r.address === 0x7F ? 'BCAST' : `R${r.address}`}
                </span>
                <div className="min-w-0 flex-1">
                  <div style={{ color: T.text }}>
                    {!isReplyOnly && <span style={{ color: T.dim }}>▸ </span>}{r.summary}
                    {r.reply && <>
                      <span style={{ color: T.faint }}>  ⇒ {r.replyMs != null ? `${r.replyMs} ms` : ''}  </span>
                      <span style={{ color: /Refused|FAIL/.test(r.replySummary || '') ? 'rgb(var(--hv-error-text))' : T.teal }}>{r.replySummary}</span>
                    </>}
                    {r.timedOut && <span style={{ color: 'rgb(var(--hv-error-text))' }}>  ⇒ no reply</span>}
                  </div>
                  {(r.anomalies || []).filter(a => a.level !== 'info' || true).map((a, i) => (
                    <div key={i} className="text-[11px] flex items-center gap-1.5 mt-0.5" style={{ color: LV[a.level] }}>
                      {a.level === 'crit' ? <XCircle size={11} /> : a.level === 'warn' ? <AlertTriangle size={11} /> : <Circle size={7} />}{a.text}
                    </div>
                  ))}
                </div>
                <ChevronRight size={14} style={{ color: T.faint }} className="shrink-0 mt-0.5" />
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </Card>
  );
}

// ── Reader health ──
function Readers({ health }: { health: Health[] }) {
  if (!health.length) return <Card><p className="text-sm" style={{ color: T.dim }}>No readers seen yet.</p></Card>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {health.map(h => {
        const alarm = h.tamper || h.power;
        return (
          <Card key={h.address} title={<span className="flex items-center gap-2">{h.online ? <Wifi size={15} style={{ color: T.green }} /> : <WifiOff size={15} style={{ color: T.crit }} />}Reader {h.address === 0x7F ? 'BCAST' : h.address}</span>}
            right={<span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: h.online ? 'rgb(var(--hv-success) / 0.15)' : 'rgb(var(--hv-error) / 0.15)', color: h.online ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }}>{h.online ? 'ONLINE' : 'OFFLINE'}</span>}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <Stat label="Avg reply" value={h.avgReplyMs != null ? `${h.avgReplyMs} ms` : '—'} />
              <Stat label="Peak reply" value={h.maxReplyMs ? `${h.maxReplyMs} ms` : '—'} />
              <Stat label="Polls" value={h.polls.toLocaleString()} />
              <Stat label="Card reads" value={h.cardReads} />
              <Stat label="NAKs" value={h.naks} tone={h.naks ? 'warn' : undefined} />
              <Stat label="Timeouts" value={h.timeouts} tone={h.timeouts ? 'warn' : undefined} />
              <Stat label="Retries" value={h.retries} tone={h.retries ? 'warn' : undefined} />
              <Stat label="CRC errors" value={h.crcErrors} tone={h.crcErrors ? 'crit' : undefined} />
            </div>
            <div className="mt-2 pt-2 border-t text-[11px] space-y-1" style={{ borderColor: T.line, color: T.text2 }}>
              {h.model != null && <div>Model {h.model} · firmware {h.firmware}</div>}
              <div className="flex items-center gap-1.5"><CreditCard size={12} />Last card: {cardText(h.lastCard)}</div>
              <div className="flex items-center gap-3">
                <span style={{ color: h.tamper ? T.crit : T.dim }}>Tamper: {h.tamper ? 'ALARM' : h.tamper === 0 ? 'normal' : '—'}</span>
                <span style={{ color: h.power ? T.crit : T.dim }}>Power: {h.power ? 'FAIL' : h.power === 0 ? 'OK' : '—'}</span>
                {h.secure && <span style={{ color: T.teal }}>🔒 secure</span>}
              </div>
              {alarm ? <div className="flex items-center gap-1.5" style={{ color: T.crit }}><AlertTriangle size={12} />{h.tamper ? 'Check the enclosure tamper switch.' : 'Check the power supply / battery.'}</div> : null}
            </div>
            {h.capabilities && <details className="mt-2"><summary className="text-[11px] cursor-pointer" style={{ color: T.dim }}>Capabilities ({h.capabilities.length})</summary>
              <ul className="mt-1 text-[11px] space-y-0.5" style={{ color: T.text2 }}>{h.capabilities.map((c: any, i) => <li key={i}>• {c.name}{c.num > 1 ? ` ×${c.num}` : ''}{c.detail ? ` — ${String(c.detail).split('.')[0]}` : ''}</li>)}</ul>
            </details>}
          </Card>
        );
      })}
    </div>
  );
}
const Stat = ({ label, value, tone }: { label: string; value: any; tone?: 'warn' | 'crit' }) => (
  <div><div className="text-[10px]" style={{ color: T.dim }}>{label}</div><div className="font-mono font-bold" style={{ color: tone === 'crit' ? T.crit : tone === 'warn' ? T.warn : T.text }}>{value}</div></div>
);

// ── Timeline ──
function Timeline({ frames, health }: { frames: FrameRec[]; health: Health[] }) {
  const addrs = useMemo(() => [...new Set(frames.map(f => f.address))].sort((a, b) => a - b), [frames]);
  const span = useMemo(() => { if (!frames.length) return [0, 1]; const a = frames[0].ts, b = frames[frames.length - 1].ts; return [a, Math.max(b, a + 1000)]; }, [frames]);
  const kindOf = (f: FrameRec) => !f.checkOk ? 'crit' : /NAK|Refused/.test(f.summary) ? 'nak' : /Card read/.test(f.summary) ? 'card' : /LED/.test(f.summary) ? 'led' : /Buzzer/.test(f.summary) ? 'buz' : f.name === 'osdp_POLL' || f.name === 'osdp_ACK' ? 'idle' : 'other';
  const COL: Record<string, string> = { crit: T.crit, nak: T.warn, card: T.amber, led: T.teal, buz: T.blue, idle: 'rgb(var(--hv-line))', other: T.dim };
  if (!frames.length) return <Card><p className="text-sm" style={{ color: T.dim }}>Nothing to plot yet.</p></Card>;
  return (
    <Card title="Timeline" right={<div className="flex gap-3 text-[11px]" style={{ color: T.text2 }}>{[['card', 'card'], ['led', 'LED'], ['buz', 'buzzer'], ['nak', 'NAK'], ['crit', 'bad frame']].map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: COL[k] }} />{l}</span>)}</div>}>
      <div className="space-y-2">
        {addrs.map(a => {
          const fs = frames.filter(f => f.address === a);
          return (
            <div key={a} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs font-mono" style={{ color: T.text2 }}>R{a === 0x7F ? 'BC' : a}</span>
              <div className="relative flex-1 h-7 rounded" style={{ background: T.input }}>
                {fs.map(f => {
                  const k = kindOf(f); if (k === 'idle') return null;
                  const x = ((f.ts - span[0]) / (span[1] - span[0])) * 100;
                  return <span key={f.id} title={`${timeOf(f.ts)} ${f.summary}`} className="absolute top-1 bottom-1 rounded-sm" style={{ left: `${x}%`, width: 3, background: COL[k], boxShadow: `0 0 4px ${COL[k]}` }} />;
                })}
              </div>
            </div>
          );
        })}
        <div className="flex justify-between text-[10px] pl-[76px]" style={{ color: T.faint }}><span>{timeOf(span[0])}</span><span>{timeOf(span[1])}</span></div>
      </div>
    </Card>
  );
}

// ── Rules / acceptance tests ──
function Rules({ api }: { api: string }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const load = useCallback(() => fetch(`${api}/api/osdp/trace/rules`).then(r => r.json()).then(j => j.success && setRules(j.rules)).catch(() => {}), [api]);
  useEffect(() => { load(); const s: Socket = io(api || undefined, { transports: ['websocket', 'polling'] }); s.on('osdp-trace-rules', () => load()); const t = setInterval(load, 2000); return () => { s.close(); clearInterval(t); }; }, [api, load]);
  const save = (next: Rule[]) => { setRules(next); fetch(`${api}/api/osdp/trace/rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: next }) }); };
  const NAMES = ['osdp_POLL', 'osdp_ACK', 'osdp_NAK', 'osdp_RAW', 'osdp_KEYPAD', 'osdp_LED', 'osdp_BUZ', 'osdp_OUT', 'osdp_LSTATR', 'osdp_PDID', 'osdp_PDCAP', 'osdp_COM'];
  return (
    <Card title="Expectation tests" right={<button onClick={() => save([...rules, { id: `rule_${Date.now()}`, name: 'New test', whenName: 'osdp_RAW', expectName: 'osdp_LED', withinMs: 2000, address: null, color: null, pass: 0, fail: 0, armed: false }])} className="px-2.5 py-1 rounded text-xs font-semibold border" style={{ borderColor: T.line2, color: T.text2 }}>+ Add test</button>}>
      <p className="text-xs mb-3" style={{ color: T.dim }}>Each test watches for a message, then checks the expected message follows within a time limit. Useful for acceptance checks (e.g. “after a card read, the LED responds within 2 s”). Results update live.</p>
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={r.id} className="rounded-lg border px-3 py-2" style={{ background: T.well, borderColor: T.line }}>
            <div className="flex items-center gap-2 flex-wrap">
              <input value={r.name} onChange={e => { const n = [...rules]; n[i] = { ...r, name: e.target.value }; setRules(n); }} onBlur={() => save(rules)}
                className="flex-1 min-w-[160px] bg-transparent outline-none text-sm font-semibold" style={{ color: T.text }} />
              <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ background: 'rgb(var(--hv-success) / 0.15)', color: 'rgb(var(--hv-success-text))' }}>✓ {r.pass}</span>
              <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ background: r.fail ? 'rgb(var(--hv-error) / 0.15)' : 'rgba(0,0,0,0.25)', color: r.fail ? 'rgb(var(--hv-error-text))' : T.dim }}>✗ {r.fail}</span>
              {r.armed && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--hv-brand) / 0.15)', color: T.amber }}>watching…</span>}
              <button onClick={() => save(rules.filter(x => x.id !== r.id))} className="p-1 rounded" style={{ color: T.dim }}><Trash2 size={13} /></button>
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-2 text-xs" style={{ color: T.text2 }}>
              <span>When</span>
              <Sel v={r.whenName} opts={NAMES} onChange={v => { const n = [...rules]; n[i] = { ...r, whenName: v }; save(n); }} />
              <span>expect</span>
              <Sel v={r.expectName} opts={NAMES} onChange={v => { const n = [...rules]; n[i] = { ...r, expectName: v }; save(n); }} />
              <span>within</span>
              <input type="number" value={r.withinMs} onChange={e => { const n = [...rules]; n[i] = { ...r, withinMs: Number(e.target.value) }; setRules(n); }} onBlur={() => save(rules)} className="w-20 rounded px-2 py-1 border font-mono" style={{ background: T.input, borderColor: T.line2, color: T.text }} /><span>ms</span>
              <span>·</span><span>reader</span>
              <input value={r.address ?? ''} placeholder="any" onChange={e => { const n = [...rules]; n[i] = { ...r, address: e.target.value === '' ? null : Number(e.target.value) }; setRules(n); }} onBlur={() => save(rules)} className="w-16 rounded px-2 py-1 border font-mono" style={{ background: T.input, borderColor: T.line2, color: T.text }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
const Sel = ({ v, opts, onChange }: { v: string; opts: string[]; onChange: (v: string) => void }) => (
  <select value={v} onChange={e => onChange(e.target.value)} className="rounded px-2 py-1 border font-mono text-xs" style={{ background: T.input, borderColor: T.line2, color: T.text }}>
    {opts.map(o => <option key={o} value={o}>{o.replace('osdp_', '')}</option>)}
  </select>
);

// ── Captures menu ──
function Captures({ api, onLoaded }: { api: string; onLoaded: () => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<any[]>([]);
  const load = () => fetch(`${api}/api/osdp/trace/captures`).then(r => r.json()).then(j => setList(j.captures || [])).catch(() => {});
  useEffect(() => { if (open) load(); }, [open]); // eslint-disable-line
  const save = async () => { const name = prompt('Name this capture:'); if (!name) return; await fetch(`${api}/api/osdp/trace/captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); load(); };
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="p-1.5 rounded-md border inline-flex items-center gap-1" style={{ borderColor: T.line2, color: T.text2 }} title="Captures"><FolderOpen size={14} /></button>
      {open && (
        <div className="absolute right-0 mt-1 z-40 w-72 rounded-xl border p-2 shadow-2xl" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))' }}>
          <button onClick={save} className="w-full mb-2 px-3 py-1.5 rounded text-sm font-semibold inline-flex items-center justify-center gap-2" style={{ background: T.amber, color: '#101011' }}><Save size={14} />Save current</button>
          <div className="max-h-64 overflow-y-auto">
            {list.length === 0 && <div className="text-xs px-1 py-3 text-center" style={{ color: T.dim }}>No saved captures.</div>}
            {list.map(c => (
              <div key={c.name} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-hv-contrast/5">
                <button onClick={async () => { await fetch(`${api}/api/osdp/trace/captures/${encodeURIComponent(c.name)}/load`, { method: 'POST' }); onLoaded(); setOpen(false); }} className="flex-1 text-left min-w-0">
                  <div className="text-sm truncate" style={{ color: T.text }}>{c.name}</div>
                  <div className="text-[10px]" style={{ color: T.dim }}>{new Date(c.savedAt).toLocaleString()}</div>
                </button>
                <button onClick={async () => { await fetch(`${api}/api/osdp/trace/captures/${encodeURIComponent(c.name)}`, { method: 'DELETE' }); load(); }} className="p-1 rounded" style={{ color: T.dim }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Passive sniffer control ──
// Listens on a serial port for a real bus. On the shared IOplus port it also
// sees the emulator's own traffic; a separate USB RS-485 adapter gives a clean
// listen-only capture.
function Sniffer({ api }: { api: string }) {
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState<any[]>([]);
  const [status, setStatus] = useState<any>({ active: false });
  const [port, setPort] = useState('');
  const [baud, setBaud] = useState(9600);
  const refresh = () => {
    fetch(`${api}/api/osdp/sniffer/ports`).then(r => r.json()).then(j => { setPorts(j.ports || []); if (!port && j.ports?.[0]) setPort(j.ports[0].path); }).catch(() => {});
    fetch(`${api}/api/osdp/sniffer/status`).then(r => r.json()).then(setStatus).catch(() => {});
  };
  useEffect(() => { if (open) refresh(); }, [open]); // eslint-disable-line
  useEffect(() => { const t = setInterval(() => fetch(`${api}/api/osdp/sniffer/status`).then(r => r.json()).then(setStatus).catch(() => {}), 2000); return () => clearInterval(t); }, [api]);
  const start = () => fetch(`${api}/api/osdp/sniffer/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, baud }) }).then(refresh);
  const stop = () => fetch(`${api}/api/osdp/sniffer/stop`, { method: 'POST' }).then(refresh);
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="px-2.5 py-1.5 rounded-md text-xs font-semibold border inline-flex items-center gap-1.5"
        style={status.active ? { background: 'rgb(var(--hv-success-tint-strong))', borderColor: T.green, color: 'rgb(var(--hv-success-text))' } : { borderColor: T.line2, color: T.text2 }}>
        <Radio size={13} />{status.active ? 'Sniffing' : 'Passive capture'}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-40 w-80 rounded-xl border p-3 shadow-2xl" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))' }}>
          <p className="text-[11px] mb-2" style={{ color: T.dim }}>Listen to a real OSDP bus on a serial port. Use a separate USB RS-485 adapter for a clean listen-only capture; the onboard port also carries the emulator’s own traffic.</p>
          <label className="block text-xs mb-2" style={{ color: T.text2 }}>Port
            <select value={port} onChange={e => setPort(e.target.value)} className="w-full mt-1 rounded px-2 py-1.5 border text-sm" style={{ background: T.input, borderColor: T.line2, color: T.text }}>
              {ports.length === 0 && <option>No serial ports found</option>}
              {ports.map(p => <option key={p.path} value={p.path}>{p.path}{p.tappable ? ' (in use — shared)' : ''}</option>)}
            </select>
          </label>
          <label className="block text-xs mb-3" style={{ color: T.text2 }}>Baud
            <select value={baud} onChange={e => setBaud(Number(e.target.value))} className="w-full mt-1 rounded px-2 py-1.5 border text-sm" style={{ background: T.input, borderColor: T.line2, color: T.text }}>
              {[9600, 19200, 38400, 57600, 115200, 230400].map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}
            </select>
          </label>
          {status.active
            ? <button onClick={stop} className="w-full py-1.5 rounded text-sm font-bold" style={{ background: 'rgb(var(--hv-error-tint-strong))', border: `1px solid ${T.crit}`, color: 'rgb(var(--hv-error-text))' }}>Stop capture</button>
            : <button onClick={start} disabled={!port} className="w-full py-1.5 rounded text-sm font-bold disabled:opacity-40" style={{ background: T.amber, color: '#101011' }}>Start capture</button>}
          {status.active && <div className="mt-2 text-[11px] font-mono" style={{ color: T.dim }}>{status.mode} · {status.stats?.framesRx || 0} frames</div>}
        </div>
      )}
    </div>
  );
}

// ── Byte inspector ──
function Inspector({ row, onClose }: { row: Row; onClose: () => void }) {
  const f = row.command || row.reply;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border max-h-[85vh] overflow-y-auto" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: 'rgb(var(--hv-line-strong))' }} onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b" style={{ background: 'rgb(var(--hv-widget-panel))', borderColor: T.line }}>
          <h3 className="font-bold" style={{ color: T.text }}>{row.summary}</h3>
          <button onClick={onClose} style={{ color: T.dim }}>✕</button>
        </div>
        <div className="p-4 space-y-4">
          {row.command && <FramePanel title="Command · CP → PD" f={row.command} />}
          {row.reply && <FramePanel title={`Reply · PD → CP${row.replyMs != null ? ` · ${row.replyMs} ms` : ''}`} f={row.reply} />}
          {(row.anomalies || []).length > 0 && (
            <div className="rounded-lg border p-3" style={{ borderColor: T.line, background: T.well }}>
              <div className="text-[10px] font-bold tracking-wider mb-2" style={{ color: T.dim }}>NOTES</div>
              {(row.anomalies || []).map((a, i) => <div key={i} className="text-sm flex items-start gap-2" style={{ color: LV[a.level] }}>{a.level === 'crit' ? <XCircle size={14} className="mt-0.5" /> : a.level === 'warn' ? <AlertTriangle size={14} className="mt-0.5" /> : <Circle size={8} className="mt-1.5" />}{a.text}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FramePanel({ title, f }: { title: string; f: FrameView }) {
  const bytes = (f.hex.match(/.{2}/g) || []);
  // structural byte annotation: SOM ADDR LEN LEN CTRL [SCB..] CODE [DATA..] CHECK
  const ann: string[] = new Array(bytes.length).fill('data');
  ann[0] = 'som'; ann[1] = 'addr'; ann[2] = 'len'; ann[3] = 'len'; ann[4] = 'ctrl';
  let p = 5;
  if (f.scb && f.scb.length) { for (let i = 0; i < f.scb.length && p < bytes.length; i++) ann[p++] = 'scb'; }
  if (p < bytes.length) ann[p++] = 'code';
  const checkN = (parseInt(bytes[4] || '0', 16) & 0x04) ? 2 : 1;
  for (let i = bytes.length - checkN; i < bytes.length; i++) if (i >= 0) ann[i] = 'check';
  const COL: Record<string, string> = { som: T.faint, addr: T.blue, len: T.dim, ctrl: 'rgb(var(--hv-purple-text))', scb: T.teal, code: T.amber, data: T.text2, check: f.checkOk ? T.green : T.crit };
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: T.line, background: T.well }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold tracking-wider" style={{ color: T.dim }}>{title}</span>
        <span className="text-xs font-mono flex items-center gap-1" style={{ color: f.checkOk ? T.green : T.crit }}>{f.checkOk ? <CheckCircle size={12} /> : <XCircle size={12} />}{f.check} {f.checkOk ? 'OK' : 'FAIL'}</span>
      </div>
      <div className="text-sm mb-2" style={{ color: T.text }}>{f.name} {f.section && <span style={{ color: T.faint }}>· SIA §{f.section}</span>}</div>
      {f.description && <div className="text-[11px] mb-2" style={{ color: T.text2 }}>{f.description}</div>}
      <div className="flex flex-wrap gap-1 mb-2">
        {bytes.map((b, i) => <span key={i} title={ann[i]} className="font-mono text-[11px] px-1 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.3)', color: COL[ann[i]], boxShadow: `inset 0 -2px 0 color-mix(in srgb, ${COL[ann[i]]} 40%, transparent)` }}>{b}</span>)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]" style={{ color: T.dim }}>
        {[['som', 'start'], ['addr', 'address'], ['len', 'length'], ['ctrl', 'control'], ['scb', 'secure'], ['code', 'command'], ['data', 'data'], ['check', 'integrity']].filter(([k]) => ann.includes(k)).map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: COL[k] }} />{l}</span>)}
      </div>
      {f.encrypted && <div className="mt-2 text-[11px]" style={{ color: T.teal }}>🔒 Payload is encrypted (secure channel). The header, addressing and MAC are visible; the data is not.</div>}
      {f.decoded && f.decoded.capabilities && <div className="mt-2 text-[11px]" style={{ color: T.text2 }}>{f.decoded.capabilities.length} capabilities reported.</div>}
    </div>
  );
}
