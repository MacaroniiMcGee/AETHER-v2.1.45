// OSDP Credential Enrollment — plug a reader into a USB-RS485 adapter, present a
// credential, and the Pi (acting as the controller) captures the exact bit
// structure and saves it as an enrolled format. Standard (non-secure) readers.
//
// A guided wizard runs after Start: it asks whether you know the numbers printed
// on the cards. If you do, you log each credential (card #, optional FC) and it
// walks you through presenting each one 3 times — several known values make the
// facility / card / parity positions DETERMINISTIC. If you don't, it just
// captures a few cards and derives the layout by diffing them.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Usb, Radio, CreditCard, Loader2, CheckCircle, AlertTriangle, Save, Trash2, Search, Wifi, WifiOff, Play, Square,
  HelpCircle, ListChecks, ArrowRight, RotateCcw, Plus, Minus, Stethoscope,
} from 'lucide-react';
import BitStrip from './BitStrip';
import { StatusDot } from './FormatPicker';
import { Fmt } from './formatLib';
import { T, Card } from '../config/ui';

interface Read { id: number; ts: number; bits: number; binary: string; count?: number; match?: any }
interface Reader { online?: boolean; model?: number; version?: number; firmware?: string; serial?: number; vendor?: string; capabilities?: any[] }
interface Analysis { bits: number; reads: number; credentials?: number; error?: string; best?: any; matches?: any[]; derived?: any; solved?: any }
interface Target { card: string; fc: string }
type Wizard = 'off' | 'ask' | 'enter' | 'capture' | 'build';
const REPEATS = 3;   // present each known credential this many times

// How each diagnosed line class reads in the UI.
const LINE_INFO: Record<string, { label: string; color: string; bg: string }> = {
  reply: { label: 'READER ✓', color: 'rgb(var(--hv-success-text))', bg: 'rgb(var(--hv-success) / 0.15)' },
  low:   { label: 'LINE LOW · SWAP A/B', color: 'rgb(var(--hv-error-text))', bg: 'rgb(var(--hv-brand) / 0.20)' },
  noise: { label: 'UNFRAMABLE · BAUD/AB', color: 'rgb(var(--hv-brand-text))', bg: 'rgb(var(--hv-brand) / 0.15)' },
  echo:  { label: 'OUR TX ECHO', color: 'rgb(var(--hv-text-2))', bg: 'rgb(var(--hv-text-3) / 0.15)' },
  high:  { label: 'IDLE · FLOATING', color: 'rgb(var(--hv-text-2))', bg: 'rgb(var(--hv-text-3) / 0.15)' },
  idle:  { label: 'SILENT', color: 'rgb(var(--hv-text-2))', bg: 'rgb(var(--hv-text-3) / 0.15)' },
};

export default function OsdpEnroll({ api, formats, reload }: { api: string; formats: Fmt[]; reload: () => any }) {
  // connection
  const [ports, setPorts] = useState<any[]>([]);
  const [port, setPort] = useState('');
  const [baud, setBaud] = useState(9600);
  const [address, setAddress] = useState(0);
  const [useRTS, setUseRTS] = useState(false);
  const [status, setStatus] = useState<any>({ active: false });
  const [reader, setReader] = useState<Reader | null>(null);
  const [reads, setReads] = useState<Read[]>([]);
  const [notes, setNotes] = useState<{ level: string; text: string }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<any>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  // wizard
  const [wizard, setWizard] = useState<Wizard>('off');
  const [known, setKnown] = useState<boolean | null>(null);
  const [targets, setTargets] = useState<Target[]>([{ card: '', fc: '' }]);
  const [curIdx, setCurIdx] = useState(0);
  const [stepBase, setStepBase] = useState(0);
  const [groups, setGroups] = useState<{ facility?: string; card: string; binaries: string[] }[]>([]);
  // results
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [name, setName] = useState('');
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pick, setPick] = useState<'derived' | 'solved' | string>('solved');

  const refreshPorts = useCallback(() => fetch(`${api}/api/osdp/enroll/ports`).then(r => r.json()).then(j => { setPorts(j.ports || []); if (!port && j.ports?.[0]) setPort(j.ports[0].path); }).catch(() => {}), [api, port]);
  useEffect(() => { refreshPorts(); fetch(`${api}/api/osdp/enroll/status`).then(r => r.json()).then(s => { setStatus(s); setReader(s.reader || null); if (s.active && s.readsList) setReads([...s.readsList]); if (s.active) setWizard(w => w === 'off' ? 'ask' : w); }).catch(() => {}); }, [api, refreshPorts]);

  useEffect(() => {
    const s: Socket = io(api || undefined, { transports: ['websocket', 'polling'] });
    s.on('osdp-enroll-status', (st: any) => { setStatus(st); if (st.reader) setReader(st.reader); });
    s.on('osdp-enroll-reader', (r: Reader) => setReader(r));
    s.on('osdp-enroll-reads', (r: Read[]) => setReads([...r]));
    s.on('osdp-enroll-note', (n: any) => setNotes(p => [n, ...p].slice(0, 4)));
    return () => { s.close(); };
  }, [api]);

  // ── connection actions ──
  const start = async () => {
    setBusy(true); setNotes([]); setSaveMsg(null); setAnalysis(null);
    try {
      await fetch(`${api}/api/osdp/enroll/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, baud, address, useRTS }) });
      setReads([]); setGroups([]); setCurIdx(0); setStepBase(0); setKnown(null); setTargets([{ card: '', fc: '' }]); setWizard('ask');
    } catch { /* */ }
    setBusy(false);
  };
  const stop = async () => { await fetch(`${api}/api/osdp/enroll/stop`, { method: 'POST' }); setWizard('off'); };
  const scan = async () => {
    setScanning(true); setNotes([]);
    try {
      const j = await (await fetch(`${api}/api/osdp/enroll/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, useRTS }) })).json();
      if (j.found) { setBaud(j.baud); setAddress(j.address); setNotes([{ level: 'info', text: `Found a reader at address ${j.address}, ${j.baud.toLocaleString()} baud${j.reply && j.reply.model != null ? ` (model ${j.reply.model})` : ''}. Press Start.` }]); }
      else setNotes([{ level: 'warn', text: 'No reader answered. Check wiring (A/B), power, and try RTS toggling.' }]);
    } catch (e: any) { setNotes([{ level: 'crit', text: e.message }]); }
    setScanning(false);
  };
  const clearReads = async () => { await fetch(`${api}/api/osdp/enroll/clear`, { method: 'POST' }); setReads([]); setStepBase(0); };
  const diagnose = async (allPorts = false) => {
    setDiagBusy(true); setDiag(null); setNotes([]);
    try {
      const body: any = {}; if (!allPorts && port) body.port = port;
      const j = await (await fetch(`${api}/api/osdp/enroll/diagnose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (j.success) { setDiag(j); if (j.found) { setBaud(j.found.baud); setAddress(j.found.address); setUseRTS(j.found.useRTS); if (j.found.port !== port) setPort(j.found.port); } }
      else setNotes([{ level: 'crit', text: j.error }]);
    } catch (e: any) { setNotes([{ level: 'crit', text: e.message }]); }
    setDiagBusy(false);
  };

  // ── build (analysis) ──
  const applyAnalysis = (j: Analysis) => {
    setAnalysis(j);
    const confirmed = (j.matches || []).find((m: any) => m.confirmed);
    if (confirmed) { setPick(confirmed.id); setName(`${confirmed.name} (enrolled)`); }
    else if (j.solved && j.solved.ok) { setPick('solved'); setName(`Enrolled ${j.bits}-bit`); }
    else if (j.best) { setPick(j.best.id); setName(`${j.best.name} (enrolled)`); }
    else { setPick('derived'); setName(`Enrolled ${j.bits}-bit`); }
  };
  const buildKnown = useCallback(async (grps: typeof groups) => {
    setBusy(true); setWizard('build');
    try {
      const j = await (await fetch(`${api}/api/osdp/enroll/analyze-guided`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: grps }) })).json();
      if (j.success) applyAnalysis(j); else setAnalysis({ bits: 0, reads: 0, error: j.error });
    } catch (e: any) { setAnalysis({ bits: 0, reads: 0, error: String(e?.message || e) }); }
    setBusy(false);
  }, [api]);
  const buildUnknown = async () => {
    setBusy(true); setWizard('build');
    try {
      const j = await (await fetch(`${api}/api/osdp/enroll/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
      if (j.success) applyAnalysis(j); else setAnalysis({ bits: 0, reads: 0, error: j.error });
    } catch (e: any) { setAnalysis({ bits: 0, reads: 0, error: String(e?.message || e) }); }
    setBusy(false);
  };

  // ── guided capture: auto-advance after REPEATS reads for the current target ──
  const curReads = reads.slice(stepBase);
  useEffect(() => {
    if (wizard !== 'capture' || known !== true) return;
    const cur = reads.slice(stepBase);
    if (cur.length >= REPEATS) {
      const t = targets[curIdx];
      const grp = { facility: t.fc.trim() || undefined, card: t.card.trim(), binaries: cur.map(r => r.binary) };
      const nextGroups = [...groups, grp];
      setGroups(nextGroups); setStepBase(reads.length);
      if (curIdx + 1 >= targets.length) buildKnown(nextGroups);
      else setCurIdx(curIdx + 1);
    }
  }, [reads, wizard, known, curIdx, stepBase, targets, groups, buildKnown]);

  // wizard step helpers
  const setCount = (n: number) => {
    const c = Math.max(1, Math.min(5, n));
    setTargets(prev => { const next = [...prev]; while (next.length < c) next.push({ card: '', fc: '' }); return next.slice(0, c); });
  };
  const setTarget = (i: number, k: keyof Target) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTargets(prev => prev.map((t, j) => j === i ? { ...t, [k]: e.target.value.replace(/\D/g, '') } : t));
  const beginCapture = () => { setGroups([]); setCurIdx(0); setStepBase(reads.length); setKnown(true); setWizard('capture'); };
  const beginUnknown = () => { setKnown(false); setStepBase(reads.length); setWizard('capture'); };
  const redoCurrent = () => setStepBase(reads.length);                 // ignore taps so far for this credential
  const advanceNow = () => {                                           // accept fewer than 3 and move on
    const cur = reads.slice(stepBase); if (!cur.length) return;
    const t = targets[curIdx];
    const nextGroups = [...groups, { facility: t.fc.trim() || undefined, card: t.card.trim(), binaries: cur.map(r => r.binary) }];
    setGroups(nextGroups); setStepBase(reads.length);
    if (curIdx + 1 >= targets.length) buildKnown(nextGroups); else setCurIdx(curIdx + 1);
  };
  const restart = () => { clearReads(); setGroups([]); setCurIdx(0); setKnown(null); setTargets([{ card: '', fc: '' }]); setAnalysis(null); setSaveMsg(null); setWizard('ask'); };

  const targetsValid = targets.every(t => t.card.trim().length > 0);

  const mapForPick = (): any => {
    if (!analysis) return null;
    if (pick === 'derived') return analysis.derived;
    if (pick === 'solved') return analysis.solved ? analysis.solved.map : analysis.derived;
    const f = formats.find(x => x.id === pick); return f ? f.map : analysis.derived;
  };
  const save = async () => {
    setBusy(true); setSaveMsg(null);
    try {
      const j = await (await fetch(`${api}/api/osdp/enroll/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, map: mapForPick() }) })).json();
      if (!j.success) throw new Error(j.error);
      await reload();
      setSaveMsg({ ok: true, text: `Saved “${j.format.name}”. It’s now in the format list (tagged MINE) on the composer, trace and builder.` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const active = status.active;
  const inputSt = { background: T.input, borderColor: T.line2, color: T.text };
  const input = 'rounded-lg px-3 py-2 text-sm border outline-none focus:border-hv-brand';
  const btnGhost = 'px-3 py-2 rounded-lg border text-sm font-semibold inline-flex items-center gap-2';
  const btnAmber = 'px-4 py-2 rounded-lg text-sm font-bold inline-flex items-center gap-2 disabled:opacity-40';

  return (
    <div className="space-y-4">
      {/* connection */}
      <Card title={<span className="flex items-center gap-2"><Usb size={16} style={{ color: T.amber }} />Reader connection</span>}
        right={active ? <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: 'rgb(var(--hv-success) / 0.15)', color: 'rgb(var(--hv-success-text))' }}>CONTROLLER RUNNING</span> : null}>
        <div className="grid gap-3 md:grid-cols-[1.4fr_0.8fr_0.7fr_auto] items-end">
          <label className="block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>USB-RS485 port</span>
            <div className="flex gap-1">
              <select className={`${input} flex-1`} style={inputSt} value={port} onChange={e => { const p = ports.find(x => x.path === e.target.value); setPort(e.target.value); if (p && p.onboard) setUseRTS(false); }}>
                {ports.length === 0 && <option value="">No serial ports found</option>}
                {ports.map(p => <option key={p.path} value={p.path}>{p.path}{p.manufacturer ? ` — ${p.manufacturer}` : ''}</option>)}
              </select>
              <button onClick={refreshPorts} className="px-2 rounded-lg border" style={{ borderColor: T.line2, color: T.text2 }} title="Refresh ports">↻</button>
            </div>
          </label>
          <label className="block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>Baud</span>
            <select className={`${input} w-full`} style={inputSt} value={baud} onChange={e => setBaud(Number(e.target.value))}>{[9600, 19200, 38400, 57600, 115200, 230400].map(b => <option key={b} value={b}>{b.toLocaleString()}</option>)}</select>
          </label>
          <label className="block"><span className="block text-xs mb-1" style={{ color: T.text2 }}>Address</span>
            <input type="number" min={0} max={127} className={`${input} w-full font-mono`} style={inputSt} value={address} onChange={e => setAddress(Number(e.target.value))} /></label>
          <div className="flex flex-wrap gap-2">
            {!active
              ? <>
                <button onClick={scan} disabled={!port || scanning || diagBusy} className={`${btnGhost} disabled:opacity-40`} style={{ borderColor: T.line2, color: T.text2 }}>{scanning ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}Scan</button>
                <button onClick={() => diagnose(false)} disabled={!port || diagBusy || scanning} className={`${btnGhost} disabled:opacity-40`} style={{ borderColor: T.line2, color: T.text2 }} title="Deep sweep: every baud × RTS, shows the raw bytes">{diagBusy ? <Loader2 size={14} className="animate-spin" /> : <Stethoscope size={14} />}Diagnose</button>
                <button onClick={start} disabled={!port || busy} className={btnAmber} style={{ background: T.amber, color: '#101011' }}><Play size={15} />Start</button>
              </>
              : <button onClick={stop} className={btnAmber} style={{ background: 'rgb(var(--hv-error-tint-strong))', border: `1px solid ${T.crit}`, color: 'rgb(var(--hv-error-text))' }}><Square size={15} />Stop</button>}
          </div>
        </div>
        <label className="flex items-center gap-2 mt-2 text-xs" style={{ color: T.text2 }}><input type="checkbox" checked={useRTS} onChange={e => setUseRTS(e.target.checked)} disabled={ports.find(p => p.path === port)?.onboard} />Toggle RTS for direction control (needed on some adapters)</label>
        {ports.find(p => p.path === port)?.onboard && <p className="text-[11px] mt-1" style={{ color: T.dim }}>Onboard RS-485 (e.g. the HAT bus) handles transmit direction in hardware — RTS is left off. Starting here temporarily takes the bus from the emulator and returns it on Stop.</p>}
        {notes.map((n, i) => <div key={i} className="mt-2 text-xs flex items-center gap-2" style={{ color: n.level === 'crit' ? 'rgb(var(--hv-error-text))' : n.level === 'warn' ? T.warn : T.teal }}>{n.level === 'info' ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}{n.text}</div>)}
      </Card>

      {/* diagnostics report */}
      {diag && !active && (
        <Card title={<span className="flex items-center gap-2"><Stethoscope size={16} style={{ color: T.amber }} />Diagnostics</span>}
          right={<button onClick={() => setDiag(null)} className="text-xs" style={{ color: T.dim }}>Dismiss</button>}>
          <div className="rounded-lg border p-3 mb-3" style={{ background: diag.found ? 'rgb(var(--hv-success) / 0.08)' : 'rgb(var(--hv-brand) / 0.06)', borderColor: diag.found ? T.green : T.amber }}>
            <div className="flex items-start gap-2 text-sm" style={{ color: T.text }}>
              {diag.found ? <CheckCircle size={16} style={{ color: T.green }} className="mt-px shrink-0" /> : <AlertTriangle size={16} style={{ color: T.warn }} className="mt-px shrink-0" />}
              <span>{diag.verdict}</span>
            </div>
          </div>
          {diag.portSummary && diag.portSummary.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] font-bold tracking-wider mb-1" style={{ color: T.dim }}>PER PORT</div>
              <div className="space-y-1">
                {diag.portSummary.map((s: any) => {
                  const info = LINE_INFO[s.class] || LINE_INFO.idle;
                  return (
                    <div key={s.port} className="flex items-center gap-2">
                      <span className="font-mono text-[12px] w-24" style={{ color: T.text2 }}>{s.port.replace('/dev/', '')}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ color: info.color, background: info.bg }}>{info.label}</span>
                      {s.reply && <span className="text-[11px]" style={{ color: 'rgb(var(--hv-success-text))' }}>{s.reply.name}{s.reply.model != null ? ` · model ${s.reply.model}` : ''}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="text-[10px] font-bold tracking-wider mb-1" style={{ color: T.dim }}>WHAT CAME BACK · {diag.ports.length} port{diag.ports.length === 1 ? '' : 's'} × baud × RTS</div>
          <div className="space-y-1">
            {diag.attempts.filter((a: any) => a.bytes > 0 || a.reply || a.error).length === 0 && <p className="text-[11px]" style={{ color: T.dim }}>No bytes came back on any port / baud / RTS combination.</p>}
            {diag.attempts.map((a: any, i: number) => (a.bytes > 0 || a.reply || a.error) ? (
              <div key={i} className="rounded border px-2 py-1 text-[11px]" style={{ background: a.reply ? 'rgb(var(--hv-success) / 0.08)' : T.well, borderColor: a.reply ? T.green : T.line }}>
                <div className="flex items-center gap-2 font-mono" style={{ color: T.text2 }}>
                  <span>{a.port.replace('/dev/', '')}</span><span>·</span><span>{a.baud.toLocaleString()}</span><span>·</span><span>RTS {a.useRTS ? 'on' : 'off'}</span>
                  <span className="ml-auto" style={{ color: a.reply ? 'rgb(var(--hv-success-text))' : a.error ? 'rgb(var(--hv-error-text))' : T.dim }}>
                    {a.reply ? `✓ ${a.reply.name}${a.reply.model != null ? ` · model ${a.reply.model}` : ''}` : a.error ? `error: ${a.error}` : `${a.bytes} bytes · ${(a.frames || []).length} frame${(a.frames || []).length === 1 ? '' : 's'}`}
                  </span>
                </div>
                {a.hex && <div className="mt-0.5 break-all font-mono" style={{ color: T.dim }}>{a.hex}{a.bytes > 48 ? ' …' : ''}</div>}
              </div>
            ) : null)}
          </div>
          {!diag.found && diag.ports.length === 1 && (
            <button onClick={() => diagnose(true)} disabled={diagBusy} className={`${btnGhost} mt-3 disabled:opacity-40`} style={{ borderColor: T.line2, color: T.text2 }}>{diagBusy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}Sweep every port instead</button>
          )}
        </Card>
      )}

      {active && (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* reader identity */}
          <Card title={<span className="flex items-center gap-2">{reader && reader.online ? <Wifi size={15} style={{ color: T.green }} /> : <WifiOff size={15} style={{ color: T.crit }} />}Reader</span>}>
            {!reader || !reader.online ? <p className="text-sm" style={{ color: T.dim }}>Waiting for the reader to answer… check wiring and baud.</p> : (
              <div className="space-y-1.5 text-sm">
                {reader.model != null && <div style={{ color: T.text }}>Model {reader.model} · v{reader.version} · fw {reader.firmware}</div>}
                {reader.serial != null && <div className="font-mono text-xs" style={{ color: T.dim }}>Serial {reader.serial}{reader.vendor ? ` · vendor ${reader.vendor}` : ''}</div>}
                {reader.capabilities && <details><summary className="text-xs cursor-pointer" style={{ color: T.dim }}>Capabilities ({reader.capabilities.length})</summary>
                  <ul className="mt-1 text-[11px] space-y-0.5" style={{ color: T.text2 }}>{reader.capabilities.map((c: any, i: number) => <li key={i}>• {c.name}{c.num > 1 ? ` ×${c.num}` : ''}</li>)}</ul></details>}
                <div className="pt-1 text-xs" style={{ color: T.dim }}>Polls {status.stats?.polls ?? 0} · replies {status.stats?.replies ?? 0}</div>
              </div>
            )}
          </Card>

          {/* wizard body */}
          <div className="space-y-4">
            {/* ── step: ask ── */}
            {wizard === 'ask' && (
              <Card title={<span className="flex items-center gap-2"><HelpCircle size={16} style={{ color: T.amber }} />Enrollment</span>}>
                <p className="text-sm mb-3" style={{ color: T.text }}>Do you know the card numbers printed on the credentials you’ll present?</p>
                <p className="text-[12px] mb-4" style={{ color: T.dim }}>If you do, logging them lets the platform pin the facility, card and parity positions exactly. If not, present a few different cards and we’ll work the layout out by comparing them.</p>
                <div className="flex gap-2">
                  <button onClick={() => { setKnown(true); setCount(1); setWizard('enter'); }} className={btnAmber} style={{ background: T.amber, color: '#101011' }}><ListChecks size={15} />Yes, I have the numbers</button>
                  <button onClick={beginUnknown} className={btnGhost} style={{ borderColor: T.line2, color: T.text2 }}>No — figure it out from the cards</button>
                </div>
              </Card>
            )}

            {/* ── step: enter known numbers ── */}
            {wizard === 'enter' && (
              <Card title={<span className="flex items-center gap-2"><ListChecks size={16} style={{ color: T.amber }} />Log the credentials</span>}>
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-sm" style={{ color: T.text2 }}>How many credentials will you present?</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setCount(targets.length - 1)} disabled={targets.length <= 1} className="w-7 h-7 rounded border inline-flex items-center justify-center disabled:opacity-30" style={{ borderColor: T.line2, color: T.text2 }}><Minus size={13} /></button>
                    <span className="w-8 text-center font-mono text-lg" style={{ color: T.text }}>{targets.length}</span>
                    <button onClick={() => setCount(targets.length + 1)} disabled={targets.length >= 5} className="w-7 h-7 rounded border inline-flex items-center justify-center disabled:opacity-30" style={{ borderColor: T.line2, color: T.text2 }}><Plus size={13} /></button>
                  </div>
                  <span className="text-[11px]" style={{ color: T.dim }}>up to 5 — more distinct numbers = sharper result</span>
                </div>
                <div className="space-y-2">
                  {targets.map((t, i) => (
                    <div key={i} className="grid grid-cols-[auto_1.2fr_1fr] items-end gap-3 rounded-lg border px-3 py-2" style={{ background: T.well, borderColor: T.line }}>
                      <span className="text-xs font-bold pb-2" style={{ color: T.dim }}>#{i + 1}</span>
                      <label className="block"><span className="block text-[11px] mb-1" style={{ color: T.text2 }}>Card number <span style={{ color: T.amber }}>◂ required</span></span>
                        <input className={`${input} w-full font-mono`} style={inputSt} value={t.card} onChange={setTarget(i, 'card')} placeholder="e.g. 45678" /></label>
                      <label className="block"><span className="block text-[11px] mb-1" style={{ color: T.text2 }}>Facility code <span style={{ color: T.dim }}>(optional)</span></span>
                        <input className={`${input} w-full font-mono`} style={inputSt} value={t.fc} onChange={setTarget(i, 'fc')} placeholder="e.g. 123" /></label>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-4">
                  <button onClick={beginCapture} disabled={!targetsValid} className={btnAmber} style={{ background: T.amber, color: '#101011' }}><ArrowRight size={15} />Start presenting cards</button>
                  <button onClick={() => setWizard('ask')} className={btnGhost} style={{ borderColor: T.line2, color: T.text2 }}>Back</button>
                </div>
              </Card>
            )}

            {/* ── step: guided capture ── */}
            {wizard === 'capture' && known === true && (
              <Card title={<span className="flex items-center gap-2"><CreditCard size={16} style={{ color: T.amber }} />Credential {curIdx + 1} of {targets.length}</span>}
                right={<span className="text-[11px]" style={{ color: T.dim }}>{groups.length} of {targets.length} done</span>}>
                <div className="rounded-lg border p-3 mb-3" style={{ background: 'rgb(var(--hv-brand) / 0.06)', borderColor: T.amber }}>
                  <div className="text-sm" style={{ color: T.text }}>Present card <b style={{ color: T.amber }}>#{targets[curIdx].card}</b>{targets[curIdx].fc ? <> · FC <b style={{ color: T.amber }}>{targets[curIdx].fc}</b></> : null} — tap it <b>{REPEATS} times</b>.</div>
                  <div className="flex items-center gap-2 mt-2">
                    {Array.from({ length: REPEATS }).map((_, i) => (
                      <span key={i} className="w-8 h-8 rounded-full inline-flex items-center justify-center text-xs font-bold border"
                        style={i < curReads.length ? { background: 'rgb(var(--hv-success-tint))', borderColor: 'rgb(var(--hv-success) / 0.5)', color: 'rgb(var(--hv-success-fg))' } : { borderColor: T.line2, color: T.dim }}>
                        {i < curReads.length ? '✓' : i + 1}
                      </span>
                    ))}
                    <span className="text-xs ml-1" style={{ color: T.dim }}>{Math.min(curReads.length, REPEATS)} / {REPEATS} reads</span>
                    <Radio size={16} className="ml-auto animate-pulse" style={{ color: T.amber }} />
                  </div>
                </div>
                {curReads.length > 0 && (
                  <div className="space-y-1 mb-3">
                    {curReads.map(r => (
                      <div key={r.id} className="font-mono text-[11px] break-all rounded border px-2 py-1" style={{ background: T.well, borderColor: T.line, color: T.text2 }}>
                        {r.binary}{r.match && r.match.card != null ? <span style={{ color: T.dim }}>  → #{r.match.card}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={redoCurrent} disabled={!curReads.length} className={`${btnGhost} disabled:opacity-40`} style={{ borderColor: T.line2, color: T.text2 }}><RotateCcw size={14} />Redo this one</button>
                  <button onClick={advanceNow} disabled={!curReads.length} className={`${btnGhost} disabled:opacity-40`} style={{ borderColor: T.line2, color: T.text2 }}>{curIdx + 1 >= targets.length ? 'Build now' : 'Next credential'}<ArrowRight size={14} /></button>
                </div>
              </Card>
            )}

            {wizard === 'capture' && known === false && (
              <Card title={<span className="flex items-center gap-2"><CreditCard size={16} style={{ color: T.amber }} />Present the cards</span>}
                right={reads.length ? <button onClick={clearReads} className="text-xs inline-flex items-center gap-1" style={{ color: T.dim }}><Trash2 size={12} />Clear</button> : null}>
                <p className="text-[12px] mb-3" style={{ color: T.dim }}>Tap each card once (a few <b>different</b> cards works best — the bits that change between them are the card number). Present the same card twice to confirm it’s stable.</p>
                {reads.length === 0 ? (
                  <div className="py-6 text-center text-sm" style={{ color: T.dim }}><Radio size={22} className="mx-auto mb-2 animate-pulse" style={{ color: T.amber }} />Waiting for the first card…</div>
                ) : (
                  <div className="space-y-2 mb-3">
                    {reads.map(r => (
                      <div key={r.id} className="rounded-lg border px-3 py-2" style={{ background: T.well, borderColor: T.line }}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold" style={{ color: T.text }}>Card {r.id} · {r.bits}-bit{r.count && r.count > 1 ? ` ×${r.count}` : ''}</span>
                          {r.match && r.match.card != null && <span className="text-[11px] font-mono" style={{ color: T.text2 }}>FC {r.match.facility ?? '—'} · #{r.match.card}{r.match.parityOk === false ? ' (parity?)' : ''}</span>}
                        </div>
                        <div className="font-mono text-[11px] break-all" style={{ color: T.text2 }}>{r.binary}</div>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={buildUnknown} disabled={reads.length < 2 || busy} className={btnAmber} style={{ background: T.amber, color: '#101011' }}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}Build from these {reads.length} card{reads.length === 1 ? '' : 's'}</button>
              </Card>
            )}

            {/* ── step: build / results ── */}
            {wizard === 'build' && (
              <Card title="What this credential is"
                right={<button onClick={restart} className="text-xs inline-flex items-center gap-1" style={{ color: T.dim }}><RotateCcw size={12} />Enroll another</button>}>
                {busy && !analysis ? (
                  <div className="py-6 text-center text-sm" style={{ color: T.dim }}><Loader2 size={20} className="animate-spin mx-auto mb-2" style={{ color: T.amber }} />Working out the layout…</div>
                ) : analysis?.error ? <p className="text-sm" style={{ color: 'rgb(var(--hv-error-text))' }}>{analysis.error}</p> : analysis ? (
                  <div className="space-y-4">
                    {analysis.credentials ? <p className="text-[12px]" style={{ color: T.dim }}>From <b style={{ color: T.text2 }}>{analysis.credentials}</b> logged credential{analysis.credentials === 1 ? '' : 's'} · {analysis.reads} reads · {analysis.bits}-bit.</p>
                      : <p className="text-[12px]" style={{ color: T.dim }}>{analysis.reads} card{analysis.reads === 1 ? '' : 's'} · {analysis.bits}-bit.</p>}

                    <div>
                      <div className="text-[10px] font-bold tracking-wider mb-2" style={{ color: T.dim }}>WHAT TO SAVE</div>
                      <div className="space-y-1.5">
                        {analysis.solved && analysis.solved.ok && (
                          <label className="flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer" style={{ background: pick === 'solved' ? 'rgb(var(--hv-brand) / 0.08)' : T.well, borderColor: pick === 'solved' ? T.amber : T.line }}>
                            <input type="radio" className="mt-1" checked={pick === 'solved'} onChange={() => setPick('solved')} />
                            <span className="flex-1">
                              <span className="flex items-center gap-2"><span className="text-sm font-semibold" style={{ color: T.text }}>Identified from your numbers</span>
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--hv-success) / 0.15)', color: 'rgb(var(--hv-success-text))' }}>{analysis.solved.confidence.toUpperCase()} CONFIDENCE</span></span>
                              <span className="block text-[11px] mt-0.5" style={{ color: T.dim }}>Pinned the {analysis.solved.fromCardOnly ? 'card number' : 'facility & card'} across every read · {analysis.solved.fields.filter((k: string) => k !== 'fixed').join('/')} · parity {analysis.solved.parityOk ? 'OK' : 'not detected'}</span>
                              {analysis.solved.note && <span className="block text-[11px] mt-1" style={{ color: T.warn }}>{analysis.solved.note}</span>}
                            </span>
                          </label>
                        )}
                        <label className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer" style={{ background: pick === 'derived' ? 'rgb(var(--hv-brand) / 0.08)' : T.well, borderColor: pick === 'derived' ? T.amber : T.line }}>
                          <input type="radio" checked={pick === 'derived'} onChange={() => setPick('derived')} />
                          <span className="flex-1"><span className="text-sm font-semibold" style={{ color: T.text }}>New format from these cards</span>
                            <span className="text-[11px] ml-2" style={{ color: T.dim }}>derived by diffing · {analysis.derived.confidence} confidence · {analysis.derived.fields.map((f: any) => f.key).join('/')}</span></span>
                        </label>
                        {(analysis.matches || []).slice(0, 6).map((mth: any) => {
                          const f = formats.find(x => x.id === mth.id);
                          return (
                            <label key={mth.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer" style={{ background: pick === mth.id ? 'rgb(var(--hv-brand) / 0.08)' : T.well, borderColor: pick === mth.id ? T.amber : T.line }}>
                              <input type="radio" checked={pick === mth.id} onChange={() => setPick(mth.id)} />
                              <span className="flex-1 flex items-center gap-2"><span className="text-sm" style={{ color: T.text }}>{mth.name}</span>{f && <StatusDot f={f} />}
                                {mth.confirmed && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--hv-success) / 0.15)', color: 'rgb(var(--hv-success-text))' }}>MATCHES {analysis.credentials && analysis.credentials > 1 ? 'ALL CARDS' : 'CARD #'}</span>}</span>
                              <span className="text-[11px]" style={{ color: mth.parityOk ? T.teal : T.warn }}>{mth.parityOk ? 'parity OK' : 'parity mismatch'}</span>
                            </label>
                          );
                        })}
                        {(analysis.matches || []).length === 0 && <p className="text-[11px]" style={{ color: T.dim }}>No known format of this length — save the identified/derived format above.</p>}
                      </div>
                    </div>

                    {mapForPick() && (
                      <div className="rounded-lg border p-3" style={{ background: T.well, borderColor: T.line }}>
                        <div className="text-[10px] font-bold tracking-wider mb-2" style={{ color: T.dim }}>BIT MAP TO SAVE</div>
                        <BitStrip map={mapForPick()} binary={groups[0]?.binaries[0] || reads[0]?.binary} />
                      </div>
                    )}

                    <div className="flex flex-wrap items-end gap-3">
                      <label className="block flex-1 min-w-[220px]"><span className="block text-[11px] mb-1" style={{ color: T.dim }}>Save as</span>
                        <input className={`${input} w-full`} style={inputSt} value={name} onChange={e => setName(e.target.value)} /></label>
                      <button onClick={save} disabled={busy || !name.trim()} className={btnAmber} style={{ background: T.amber, color: '#101011' }}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}Enroll format</button>
                    </div>
                    {saveMsg && <p className="text-sm flex items-start gap-2" style={{ color: saveMsg.ok ? 'rgb(var(--hv-success-text))' : 'rgb(var(--hv-error-text))' }}>{saveMsg.ok ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}{saveMsg.text}</p>}
                  </div>
                ) : null}
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
