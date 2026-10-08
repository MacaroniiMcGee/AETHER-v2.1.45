// Combined OSDPFirmwareWizard + useFirmwareStatus.
// Drop into: frontend/src/components/OSDPFirmwareWizard.tsx
//
// 4-step wizard for OSDP firmware uploads — multi-target queue version.
// Replaces the legacy orange "Firmware Upload" section.
//
// Backend endpoints used:
//   POST /api/osdp/firmware-scan
//   POST /api/osdp/firmware-identify
//   GET  /api/osdp/firmware-library
//   POST /api/osdp/firmware-library
//   DELETE /api/osdp/firmware-library/:id
//   POST /api/osdp/firmware-upload
//   POST /api/osdp/firmware-abort
//   GET  /api/osdp/firmware-status
//   GET  /api/osdp/firmware-history

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Edit3, Check, AlertTriangle, FileText, Upload, Library,
  ChevronRight, ChevronLeft, X, Loader2, Zap, RotateCw, Radio, Clock,
} from 'lucide-react';

// ───────────────────────────────────────────────────────────────────────────
// Live-status hook
// ───────────────────────────────────────────────────────────────────────────

export interface FirmwareStatus {
  inProgress: boolean;
  readerId?: string;
  reader?: string;
  port?: string;
  baud?: number;
  address?: number;
  filename?: string;
  startedAt?: number;
  elapsedMs?: number;
  phase?: string;
  fragment?: number;
  totalFragments?: number | null;
  bytesSent?: number;
  totalBytes?: number;
  percent?: number;
  ftStatus?: number;
  ftDelay?: number;
  lastStatusMsg?: string | null;
  etaMs?: number | null;
}

export function useFirmwareStatus(active: boolean, intervalMs = 1000) {
  const [status, setStatus] = useState<FirmwareStatus>({ inProgress: false });
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/osdp/firmware-status');
        if (!res.ok) return;
        const json = (await res.json()) as FirmwareStatus;
        setStatus(json);
      } catch { /* network blip */ }
    };
    fetchStatus();
    timerRef.current = window.setInterval(fetchStatus, intervalMs);
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [active, intervalMs]);

  return status;
}

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface ReaderConfig {
  id: string;
  name: string;
  address: number;
  serialPort: string;
  enabled?: boolean;
  baudRate?: number;
}

interface FirmwareTarget {
  port: string;
  baud: number;
  address: number;
  readerName?: string;
}

interface ScanResult {
  address: number;
  replied: boolean;
  replyCode?: number;
  replyName?: string;
  error?: string;
}

interface IdentifyInfo {
  identityAvailable: boolean;
  capabilitiesAvailable: boolean;
  unavailableReason?: string;
  vendorName?: string | null;
  modelNumber?: number | null;
  modelVersion?: number | null;
  serialHex?: string | null;
  firmwareString?: string | null;
  supportsFiletransfer: boolean | null;
  supportsSecureChannel: boolean | null;
  scbkConfigured?: boolean;
}

interface LibraryEntry {
  id: string;
  filename: string;
  model?: string | null;
  version?: string | null;
  sizeBytes: number;
  sha256: string;
  addedAt: string;
  notes?: string | null;
}

type QueueStatus =
  | 'pending'
  | 'identifying'
  | 'identified'
  | 'identify-failed'
  | 'queued'
  | 'uploading'
  | 'success'
  | 'failure'
  | 'aborted'
  | 'skipped';

interface QueueItem {
  key: string;
  target: FirmwareTarget;
  identity: IdentifyInfo | null;
  identifyError: string | null;
  status: QueueStatus;
  uploadResult: any | null;
  uploadError: string | null;
}

type WizardStep = 'target' | 'identify' | 'firmware' | 'confirm';

interface Props {
  readers?: ReaderConfig[];
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const fmtBytes = (n?: number) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
const fmtDuration = (ms?: number | null) => {
  if (!ms || ms < 0) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtAddr = (a?: number) =>
  a == null ? '?' : `0x${a.toString(16).padStart(2, '0').toUpperCase()}`;

const targetKey = (t: FirmwareTarget) => `${t.port}:${t.address}@${t.baud}`;

const makeItem = (target: FirmwareTarget): QueueItem => ({
  key: targetKey(target),
  target,
  identity: null,
  identifyError: null,
  status: 'pending',
  uploadResult: null,
  uploadError: null,
});

// ───────────────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────────────

export default function OSDPFirmwareWizard({ readers = [] }: Props) {
  const [step, setStep] = useState<WizardStep>('target');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [chosenFile, setChosenFile] = useState<{ file?: File; libraryId?: string; label: string; sizeBytes: number } | null>(null);

  const [batchRunning, setBatchRunning] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const liveStatus = useFirmwareStatus(batchRunning);

  const resetAll = useCallback(() => {
    setQueue([]); setChosenFile(null); setBatchRunning(false); setActiveKey(null); setStep('target');
  }, []);

  const allBatchDone = queue.length > 0 && queue.every(q =>
    q.status === 'success' || q.status === 'failure' ||
    q.status === 'aborted' || q.status === 'skipped'
  );

  return (
    <div className="border border-orange-500/30 rounded-lg p-5 bg-gradient-to-br from-orange-500/5 to-amber-500/5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-orange-400">
          <Zap size={18} />
          <span className="text-base font-medium">Firmware Upload</span>
          <span className="text-xs text-gray-400 ml-2">
            Push firmware to one or more readers. Multi-reader uploads run sequentially.
          </span>
        </div>
        {queue.length > 0 && (
          <button onClick={resetAll} disabled={batchRunning}
            className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1 disabled:opacity-40">
            <RotateCw size={12} /> Start over
          </button>
        )}
      </div>

      <StepBar step={step} />

      <div className="mt-4 space-y-3">
        {step === 'target' && (
          <StepTarget
            readers={readers}
            existingQueue={queue}
            onContinue={(targets) => { setQueue(targets.map(makeItem)); setStep('identify'); }}
          />
        )}

        {step === 'identify' && (
          <StepIdentify
            queue={queue}
            setQueue={setQueue}
            onContinue={() => setStep('firmware')}
            onBack={() => setStep('target')}
          />
        )}

        {step === 'firmware' && (
          <StepFirmware
            current={chosenFile}
            onPicked={(c) => { setChosenFile(c); setStep('confirm'); }}
            onBack={() => setStep('identify')}
          />
        )}

        {step === 'confirm' && chosenFile && (
          <StepConfirmFlash
            queue={queue}
            setQueue={setQueue}
            chosen={chosenFile}
            batchRunning={batchRunning}
            setBatchRunning={setBatchRunning}
            activeKey={activeKey}
            setActiveKey={setActiveKey}
            liveStatus={liveStatus}
            allBatchDone={allBatchDone}
            onBack={() => setStep('firmware')}
            onReset={resetAll}
          />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Step bar
// ───────────────────────────────────────────────────────────────────────────

const STEPS: { id: WizardStep; label: string }[] = [
  { id: 'target',   label: 'Targets' },
  { id: 'identify', label: 'Identify' },
  { id: 'firmware', label: 'Firmware' },
  { id: 'confirm',  label: 'Confirm & flash' },
];

function StepBar({ step }: { step: WizardStep }) {
  const idx = STEPS.findIndex(s => s.id === step);
  return (
    <div className="flex items-center gap-2 text-xs">
      {STEPS.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'todo';
        return (
          <React.Fragment key={s.id}>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded ${
              state === 'done' ? 'bg-emerald-500/15 text-emerald-300'
                : state === 'now'  ? 'bg-orange-500/15 text-orange-300 font-medium'
                : 'text-gray-500'
            }`}>
              <span className={`inline-flex w-5 h-5 rounded-full items-center justify-center text-[10px] ${
                state === 'done' ? 'bg-emerald-500 text-white'
                  : state === 'now'  ? 'bg-orange-500 text-white'
                  : 'bg-gray-700 text-gray-400'
              }`}>
                {state === 'done' ? <Check size={11}/> : i + 1}
              </span>
              <span>{s.label}</span>
            </div>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-700 max-w-[20px]" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// STEP 1 — Target selection (multi-select)
// ───────────────────────────────────────────────────────────────────────────

function StepTarget({
  readers, existingQueue, onContinue,
}: {
  readers: ReaderConfig[];
  existingQueue: QueueItem[];
  onContinue: (targets: FirmwareTarget[]) => void;
}) {
  type Tab = 'configured' | 'scan' | 'direct';
  const [tab, setTab] = useState<Tab>('configured');
  const [selected, setSelected] = useState<FirmwareTarget[]>(existingQueue.map(q => q.target));

  const toggle = (t: FirmwareTarget) => {
    setSelected(prev => {
      const k = targetKey(t);
      const exists = prev.find(x => targetKey(x) === k);
      return exists ? prev.filter(x => targetKey(x) !== k) : [...prev, t];
    });
  };
  const isSelected = (t: FirmwareTarget) => selected.some(x => targetKey(x) === targetKey(t));

  return (
    <div className="bg-gray-900/40 border border-gray-700 rounded-lg p-4">
      <div className="flex gap-1 border-b border-gray-700 mb-4">
        <TabButton active={tab === 'configured'} onClick={() => setTab('configured')} icon={<Library size={14}/>}>Configured readers</TabButton>
        <TabButton active={tab === 'scan'}       onClick={() => setTab('scan')}       icon={<Search size={14}/>}>Scan the bus</TabButton>
        <TabButton active={tab === 'direct'}     onClick={() => setTab('direct')}     icon={<Edit3 size={14}/>}>Direct entry</TabButton>
      </div>

      {tab === 'configured' && <TargetConfigured readers={readers} isSelected={isSelected} onToggle={toggle} />}
      {tab === 'scan'       && <TargetScan isSelected={isSelected} onToggle={toggle} />}
      {tab === 'direct'     && <TargetDirect onAdd={(t) => !isSelected(t) && toggle(t)} />}

      <div className="mt-4 pt-3 border-t border-gray-800 flex items-center justify-between">
        <div className="text-xs text-gray-400">
          {selected.length === 0
            ? 'Select one or more readers to continue'
            : <>Selected {selected.length}: <span className="font-mono text-gray-300">{selected.map(t => `${t.port.replace('/dev/','')}@${t.address}`).join(', ')}</span></>}
        </div>
        <button
          onClick={() => onContinue(selected)}
          disabled={selected.length === 0}
          className="px-4 py-1.5 text-sm bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 border border-orange-500/40 rounded disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          Continue with {selected.length || ''} <ChevronRight size={14}/>
        </button>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-xs flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
        active ? 'border-orange-500 text-orange-300 font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'
      }`}
    >
      {icon} {children}
    </button>
  );
}

function TargetConfigured({
  readers, isSelected, onToggle,
}: {
  readers: ReaderConfig[];
  isSelected: (t: FirmwareTarget) => boolean;
  onToggle: (t: FirmwareTarget) => void;
}) {
  if (!readers.length) {
    return <div className="text-sm text-gray-400 py-6 text-center">No readers configured. Use "Scan the bus" or "Direct entry" instead.</div>;
  }
  return (
    <div className="space-y-1.5">
      {readers.map(r => {
        const t: FirmwareTarget = { port: r.serialPort, baud: r.baudRate ?? 9600, address: r.address, readerName: r.name };
        const sel = isSelected(t);
        return (
          <label
            key={r.id}
            className={`flex items-center gap-3 px-3 py-2.5 rounded border cursor-pointer transition-colors ${
              sel ? 'border-orange-500/60 bg-orange-500/10'
                  : 'border-gray-700 hover:border-orange-500/30 hover:bg-orange-500/5'
            }`}
          >
            <input type="checkbox" checked={sel} onChange={() => onToggle(t)} className="accent-orange-500" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-100 truncate">{r.name}</div>
              <div className="text-xs text-gray-500 font-mono">{r.serialPort} · addr {fmtAddr(r.address)} · {r.baudRate ?? 9600} baud</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function TargetScan({
  isSelected, onToggle,
}: {
  isSelected: (t: FirmwareTarget) => boolean;
  onToggle: (t: FirmwareTarget) => void;
}) {
  const [port, setPort] = useState('ttyACM0');
  const [baud, setBaud] = useState(9600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ScanResult[] | null>(null);

  const runScan = async () => {
    setBusy(true); setError(null); setResults(null);
    try {
      const res = await fetch('/api/osdp/firmware-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, baud, fromAddr: 0, toAddr: 15 }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Scan failed');
      setResults(json.results || []);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const portFull = port.startsWith('/dev/') ? port : `/dev/${port}`;

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-end">
        <Field label="Port">
          <input value={port} onChange={e => setPort(e.target.value)} className={INPUT_CLS} placeholder="ttyACM0" />
        </Field>
        <Field label="Baud" small>
          <select value={baud} onChange={e => setBaud(Number(e.target.value))} className={INPUT_CLS}>
            <option value={9600}>9600</option><option value={19200}>19200</option>
            <option value={38400}>38400</option><option value={115200}>115200</option>
          </select>
        </Field>
        <button type="button" disabled={busy || !port} onClick={runScan}
          className="px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-orange-200 text-sm rounded border border-orange-500/40 flex items-center gap-1.5">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {busy ? 'Scanning…' : 'Scan addresses 0–15'}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {results && (
        <div className="border border-gray-700 rounded divide-y divide-gray-800 max-h-72 overflow-y-auto">
          {results.filter(r => r.replied).length === 0 && (
            <div className="p-6 text-center text-sm text-gray-500">No replies. Reader off, wrong baud, or different port.</div>
          )}
          {results.filter(r => r.replied).map(r => {
            const t: FirmwareTarget = { port: portFull, baud, address: r.address };
            const sel = isSelected(t);
            return (
              <label key={r.address} className="w-full p-3 hover:bg-orange-500/5 flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={sel} onChange={() => onToggle(t)} className="accent-orange-500" />
                <Radio size={14} className="text-emerald-400 shrink-0" />
                <div className="flex-1">
                  <div className="text-sm font-mono text-gray-100">Address {fmtAddr(r.address)}</div>
                  <div className="text-xs text-gray-500">{r.replyName || `reply 0x${r.replyCode?.toString(16)}`}</div>
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TargetDirect({ onAdd }: { onAdd: (t: FirmwareTarget) => void }) {
  const [port, setPort] = useState('ttyACM0');
  const [baud, setBaud] = useState(9600);
  const [address, setAddress] = useState(0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Port"><input value={port} onChange={e => setPort(e.target.value)} className={INPUT_CLS} placeholder="ttyACM0" /></Field>
        <Field label="Baud">
          <select value={baud} onChange={e => setBaud(Number(e.target.value))} className={INPUT_CLS}>
            <option value={9600}>9600</option><option value={19200}>19200</option>
            <option value={38400}>38400</option><option value={115200}>115200</option>
          </select>
        </Field>
        <Field label="Address (0–126)">
          <input type="number" min={0} max={126} value={address} onChange={e => setAddress(Number(e.target.value))} className={INPUT_CLS} />
        </Field>
      </div>
      <button type="button" disabled={!port}
        onClick={() => onAdd({ port: port.startsWith('/dev/') ? port : `/dev/${port}`, baud, address })}
        className="w-full px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 disabled:opacity-40 text-orange-200 text-sm rounded border border-orange-500/40 flex items-center justify-center gap-2">
        Add this target to the selection <ChevronRight size={14} />
      </button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// STEP 2 — Identify each target (sequential)
// ───────────────────────────────────────────────────────────────────────────

function StepIdentify({
  queue, setQueue, onContinue, onBack,
}: {
  queue: QueueItem[];
  setQueue: React.Dispatch<React.SetStateAction<QueueItem[]>>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [running, setRunning] = useState(false);
  const startedOnce = useRef(false);

  const runIdentifyAll = useCallback(async () => {
    setRunning(true);
    for (const item of queue) {
      setQueue(q => q.map(x => x.key === item.key ? { ...x, status: 'identifying', identifyError: null } : x));
      try {
        const res = await fetch('/api/osdp/firmware-identify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: item.target.port, baud: item.target.baud, address: item.target.address }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Identify failed');
        setQueue(q => q.map(x => x.key === item.key
          ? { ...x, status: 'identified', identity: json as IdentifyInfo, identifyError: null }
          : x));
      } catch (e: any) {
        setQueue(q => q.map(x => x.key === item.key
          ? { ...x, status: 'identify-failed', identifyError: e.message || String(e) }
          : x));
      }
    }
    setRunning(false);
  }, [queue, setQueue]);

  useEffect(() => {
    if (startedOnce.current) return;
    startedOnce.current = true;
    runIdentifyAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = (key: string) => setQueue(q => q.filter(x => x.key !== key));

  const anyReady = queue.some(q => q.status === 'identified' || q.status === 'identify-failed');
  const allDone = !running && queue.every(q => q.status === 'identified' || q.status === 'identify-failed');

  return (
    <div className="bg-gray-900/40 border border-gray-700 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-300">
          {running
            ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin"/> Identifying readers…</span>
            : `${queue.filter(q => q.status === 'identified').length} of ${queue.length} identified`}
        </div>
        {!running && (
          <button onClick={runIdentifyAll} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1">
            <RotateCw size={12}/> Re-run all
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {queue.map(item => <IdentifyRow key={item.key} item={item} onRemove={() => remove(item.key)} />)}
      </div>

      <div className="flex justify-between pt-2">
        <BtnGhost onClick={onBack}><ChevronLeft size={14}/> Back</BtnGhost>
        <BtnPrimary disabled={!allDone || !anyReady} onClick={onContinue}>
          Continue <ChevronRight size={14}/>
        </BtnPrimary>
      </div>
    </div>
  );
}

function IdentifyRow({ item, onRemove }: { item: QueueItem; onRemove: () => void }) {
  const t = item.target;
  return (
    <div className="flex items-start gap-3 p-2.5 rounded border border-gray-800 bg-gray-900/40">
      <IdentifyStatusBadge status={item.status} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-100 truncate">{t.readerName || `${t.port} addr ${fmtAddr(t.address)}`}</div>
        <div className="text-xs text-gray-500 font-mono">{t.port} · {fmtAddr(t.address)} · {t.baud} baud</div>
        {item.identity?.firmwareString && (
          <div className="text-xs text-emerald-300 mt-0.5">
            {item.identity.vendorName} · fw <span className="font-mono">{item.identity.firmwareString}</span>
            {item.identity.serialHex && <span className="text-gray-500"> · sn {item.identity.serialHex}</span>}
            {item.identity.supportsFiletransfer === false && <span className="text-red-300"> · no FILETRANSFER</span>}
          </div>
        )}
        {item.identity && !item.identity.identityAvailable && (
          <div className="text-xs text-amber-300 mt-0.5">Reader alive but identity unavailable</div>
        )}
        {item.identifyError && (
          <div className="text-xs text-red-300 mt-0.5 font-mono">{item.identifyError}</div>
        )}
      </div>
      <button onClick={onRemove} className="p-1 text-gray-500 hover:text-red-400" title="Remove from queue">
        <X size={14}/>
      </button>
    </div>
  );
}

function IdentifyStatusBadge({ status }: { status: QueueStatus }) {
  const map: Record<string, { icon: any; cls: string }> = {
    'pending':         { icon: <Clock size={14}/>,        cls: 'text-gray-400 bg-gray-700/40' },
    'identifying':     { icon: <Loader2 size={14} className="animate-spin"/>, cls: 'text-blue-300 bg-blue-500/15' },
    'identified':      { icon: <Check size={14}/>,        cls: 'text-emerald-300 bg-emerald-500/15' },
    'identify-failed': { icon: <AlertTriangle size={14}/>, cls: 'text-amber-300 bg-amber-500/15' },
    'queued':          { icon: <Clock size={14}/>,        cls: 'text-gray-400 bg-gray-700/40' },
    'uploading':       { icon: <Loader2 size={14} className="animate-spin"/>, cls: 'text-orange-300 bg-orange-500/15' },
    'success':         { icon: <Check size={14}/>,        cls: 'text-emerald-300 bg-emerald-500/15' },
    'failure':         { icon: <AlertTriangle size={14}/>, cls: 'text-red-300 bg-red-500/15' },
    'aborted':         { icon: <X size={14}/>,             cls: 'text-gray-400 bg-gray-700/40' },
    'skipped':         { icon: <ChevronRight size={14}/>, cls: 'text-gray-400 bg-gray-700/40' },
  };
  const v = map[status] || map['pending'];
  return <div className={`w-7 h-7 rounded flex items-center justify-center ${v.cls}`}>{v.icon}</div>;
}

// ───────────────────────────────────────────────────────────────────────────
// STEP 3 — Choose firmware
// ───────────────────────────────────────────────────────────────────────────

function StepFirmware({
  current, onPicked, onBack,
}: {
  current: { file?: File; libraryId?: string; label: string; sizeBytes: number } | null;
  onPicked: (c: { file?: File; libraryId?: string; label: string; sizeBytes: number }) => void;
  onBack: () => void;
}) {
  type Tab = 'library' | 'upload';
  const [tab, setTab] = useState<Tab>('library');

  return (
    <div className="bg-gray-900/40 border border-gray-700 rounded-lg p-4">
      <div className="text-xs text-gray-400 mb-3">
        The selected firmware will be applied to <strong className="text-gray-200">all targets in the queue</strong>.
      </div>
      <div className="flex gap-1 border-b border-gray-700 mb-4">
        <TabButton active={tab === 'library'} onClick={() => setTab('library')} icon={<Library size={14}/>}>Firmware library</TabButton>
        <TabButton active={tab === 'upload'}  onClick={() => setTab('upload')}  icon={<Upload size={14}/>}>Upload .bin</TabButton>
      </div>

      {tab === 'library' && <FirmwareLibraryPicker onPick={onPicked} />}
      {tab === 'upload'  && <FirmwareFilePicker onPick={onPicked} />}

      <div className="flex justify-between pt-4 border-t border-gray-800 mt-4">
        <BtnGhost onClick={onBack}><ChevronLeft size={14}/> Back</BtnGhost>
      </div>
    </div>
  );
}

function FirmwareLibraryPicker({ onPick }: { onPick: (c: { libraryId: string; label: string; sizeBytes: number }) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [refreshIdx, setRefreshIdx] = useState(0);

  useEffect(() => {
    fetch('/api/osdp/firmware-library')
      .then(r => r.json())
      .then(j => { if (j.success) setEntries(j.entries || []); else setError(j.error); })
      .catch(e => setError(e.message));
  }, [refreshIdx]);

  const remove = async (id: string) => {
    if (!confirm('Remove this firmware from the library?')) return;
    await fetch(`/api/osdp/firmware-library/${id}`, { method: 'DELETE' });
    setRefreshIdx(i => i + 1);
  };

  if (error) return <div className="text-red-300 text-sm">{error}</div>;
  if (!entries) return <div className="text-gray-400 text-sm py-4 flex items-center gap-2"><Loader2 size={14} className="animate-spin"/>Loading library…</div>;
  if (entries.length === 0) {
    return <div className="text-center text-sm text-gray-400 py-6">Library is empty. Switch to the "Upload .bin" tab to add a firmware file.</div>;
  }

  return (
    <div className="space-y-1.5 max-h-80 overflow-y-auto">
      {entries.map(e => (
        <div key={e.id} className="flex items-center gap-2 p-3 rounded border border-gray-700 hover:border-orange-500/40">
          <FileText size={16} className="text-orange-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-100 font-mono truncate">{e.filename}</div>
            <div className="text-xs text-gray-500">
              {e.model ? e.model : 'no model'} · {e.version ? e.version : 'no version'} · {fmtBytes(e.sizeBytes)} · sha {e.sha256.slice(0, 8)}…
            </div>
          </div>
          <button
            onClick={() => onPick({ libraryId: e.id, label: e.filename, sizeBytes: e.sizeBytes })}
            className="px-3 py-1.5 bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 text-xs rounded border border-orange-500/40"
          >
            Select
          </button>
          <button onClick={() => remove(e.id)} className="p-1.5 text-gray-500 hover:text-red-400" title="Remove from library">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function FirmwareFilePicker({ onPick }: { onPick: (c: { file: File; label: string; sizeBytes: number }) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [saveToLib, setSaveToLib] = useState(false);
  const [meta, setMeta] = useState({ model: '', version: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = (f: File | null) => {
    setError(null);
    if (!f) { setFile(null); return; }
    if (!f.name.toLowerCase().endsWith('.bin')) {
      setError('Firmware must be a .bin file'); setFile(null); return;
    }
    setFile(f);
  };

  const continueWithFile = async () => {
    if (!file) return;
    if (!saveToLib) { onPick({ file, label: file.name, sizeBytes: file.size }); return; }
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append('firmware', file);
      form.append('metadata', JSON.stringify(meta));
      const res = await fetch('/api/osdp/firmware-library', { method: 'POST', body: form });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      onPick({ libraryId: j.entry.id, label: j.entry.filename, sizeBytes: j.entry.sizeBytes });
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block border-2 border-dashed border-gray-700 rounded-lg p-6 text-center cursor-pointer hover:border-orange-500/40">
        <input type="file" accept=".bin" onChange={e => onFile(e.target.files?.[0] || null)} className="hidden" />
        <FileText size={28} className="mx-auto text-gray-500 mb-2" />
        {file ? (
          <>
            <div className="text-sm text-orange-300 font-mono">{file.name}</div>
            <div className="text-xs text-gray-500 mt-1">{fmtBytes(file.size)}</div>
          </>
        ) : (
          <>
            <div className="text-sm text-gray-300">Click to choose a firmware .bin file</div>
            <div className="text-xs text-gray-500 mt-1">Or drag and drop here</div>
          </>
        )}
      </label>

      {file && (
        <>
          <label className="flex items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={saveToLib} onChange={e => setSaveToLib(e.target.checked)} />
            Also save this firmware to the library
          </label>
          {saveToLib && (
            <div className="grid grid-cols-2 gap-2 pl-6">
              <input placeholder="Model (e.g. Hanwha CHAN1)" value={meta.model}  onChange={e => setMeta(m => ({ ...m, model:   e.target.value }))} className={INPUT_CLS} />
              <input placeholder="Version (e.g. 5.4.1)"      value={meta.version} onChange={e => setMeta(m => ({ ...m, version: e.target.value }))} className={INPUT_CLS} />
              <input placeholder="Notes (optional)" value={meta.notes} onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))} className={`${INPUT_CLS} col-span-2`} />
            </div>
          )}
          {error && <div className="text-red-300 text-xs">{error}</div>}
          <button onClick={continueWithFile} disabled={busy}
            className="w-full px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 disabled:opacity-40 text-orange-200 text-sm rounded border border-orange-500/40 flex items-center justify-center gap-2">
            {busy ? <><Loader2 size={14} className="animate-spin"/>Uploading to library…</> : <>Continue <ChevronRight size={14} /></>}
          </button>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// STEP 4 — Confirm & flash (sequential queue execution)
// ───────────────────────────────────────────────────────────────────────────

function StepConfirmFlash({
  queue, setQueue, chosen, batchRunning, setBatchRunning,
  activeKey, setActiveKey, liveStatus, allBatchDone, onBack, onReset,
}: {
  queue: QueueItem[];
  setQueue: React.Dispatch<React.SetStateAction<QueueItem[]>>;
  chosen: { file?: File; libraryId?: string; label: string; sizeBytes: number };
  batchRunning: boolean;
  setBatchRunning: (v: boolean) => void;
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
  liveStatus: any;
  allBatchDone: boolean;
  onBack: () => void;
  onReset: () => void;
}) {
  const eligibleCount = queue.length;
  const confirmationPhrase = useMemo(
    () => `FLASH ${eligibleCount} READER${eligibleCount === 1 ? '' : 'S'}`,
    [eligibleCount]
  );
  const [phraseInput, setPhraseInput] = useState('');
  const phraseOk = phraseInput.trim() === confirmationPhrase;

  useEffect(() => {
    if (!batchRunning) return;
    let cancelled = false;

    const runQueue = async () => {
      // Mark all eligible items as queued
      setQueue(q => q.map(x =>
        (x.status === 'identified' || x.status === 'identify-failed') ? { ...x, status: 'queued' } : x
      ));

      for (const item of queue) {
        if (cancelled) break;
        if (item.status !== 'identified' && item.status !== 'identify-failed') continue;

        setActiveKey(item.key);
        setQueue(q => q.map(x => x.key === item.key ? { ...x, status: 'uploading' } : x));

        try {
          const form = new FormData();
          if (chosen.file)      form.append('firmware', chosen.file);
          if (chosen.libraryId) form.append('libraryId', chosen.libraryId);
          form.append('port',    item.target.port);
          form.append('baud',    String(item.target.baud));
          form.append('address', String(item.target.address));

          const res = await fetch('/api/osdp/firmware-upload', { method: 'POST', body: form });
          const json = await res.json();
          if (cancelled) break;

          if (json.success) {
            setQueue(q => q.map(x => x.key === item.key
              ? { ...x, status: 'success', uploadResult: json } : x));
          } else {
            setQueue(q => q.map(x => x.key === item.key
              ? { ...x, status: 'failure', uploadError: json.error || 'Upload failed' } : x));
          }
        } catch (e: any) {
          if (!cancelled) {
            setQueue(q => q.map(x => x.key === item.key
              ? { ...x, status: 'failure', uploadError: e.message || String(e) } : x));
          }
        }
      }

      if (!cancelled) { setActiveKey(null); setBatchRunning(false); }
    };

    runQueue();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchRunning]);

  const abortBatch = async () => {
    if (!confirm('Abort the running flash and stop the queue? The current reader may be left in an inconsistent state.')) return;
    await fetch('/api/osdp/firmware-abort', { method: 'POST' });
    setQueue(q => q.map(x => {
      if (x.status === 'uploading') return { ...x, status: 'aborted' };
      if (x.status === 'queued')    return { ...x, status: 'skipped' };
      return x;
    }));
    setBatchRunning(false);
  };

  return (
    <div className="bg-gray-900/40 border border-orange-500/40 rounded-lg p-4 space-y-3">
      <div className="px-3 py-2 rounded bg-amber-500/10 border-l-4 border-amber-500 text-amber-200 text-xs">
        About to flash <strong>{eligibleCount}</strong> reader{eligibleCount === 1 ? '' : 's'} with
        {' '}<span className="font-mono">{chosen.label}</span> ({fmtBytes(chosen.sizeBytes)}).
        Each takes ~15 minutes. Readers will reboot. <strong>Do not unplug.</strong>
      </div>

      <div className="space-y-1.5">
        {queue.map(item => (
          <FlashRow key={item.key} item={item} live={item.key === activeKey ? liveStatus : null} />
        ))}
      </div>

      {!batchRunning && !allBatchDone && (
        <>
          <div className="pt-3 border-t border-gray-800">
            <div className="text-xs text-gray-400 mb-1.5">
              Type <span className="font-mono text-red-300">{confirmationPhrase}</span> to confirm:
            </div>
            <input value={phraseInput} onChange={e => setPhraseInput(e.target.value)}
              className={`${INPUT_CLS} w-full font-mono`} placeholder="Type the phrase above"
              autoComplete="off" spellCheck={false} />
          </div>
          <div className="flex justify-between pt-2">
            <BtnGhost onClick={onBack}><ChevronLeft size={14}/> Back</BtnGhost>
            <button onClick={() => phraseOk && setBatchRunning(true)} disabled={!phraseOk}
              className="px-5 py-2 bg-orange-500 hover:bg-orange-400 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded flex items-center gap-2">
              <Zap size={14} /> Begin batch flash
            </button>
          </div>
        </>
      )}

      {batchRunning && (
        <div className="flex justify-end pt-2">
          <button onClick={abortBatch}
            className="px-4 py-1.5 text-xs text-red-300 border border-red-500/40 rounded hover:bg-red-500/10 flex items-center gap-1.5">
            <X size={12}/> Abort batch
          </button>
        </div>
      )}

      {allBatchDone && <BatchSummary queue={queue} onReset={onReset} />}
    </div>
  );
}

function FlashRow({ item, live }: { item: QueueItem; live: any | null }) {
  const t = item.target;
  const pct = (live && live.percent) ?? 0;
  const isActive = item.status === 'uploading';
  const failed   = item.status === 'failure' || item.status === 'aborted';
  const ok       = item.status === 'success';

  return (
    <div className={`rounded border p-2.5 ${
      isActive ? 'border-blue-500/40 bg-blue-500/5'
        : ok ? 'border-emerald-500/30 bg-emerald-500/5'
        : failed ? 'border-red-500/30 bg-red-500/5'
        : 'border-gray-800 bg-gray-900/40'
    }`}>
      <div className="flex items-center gap-3">
        <IdentifyStatusBadge status={item.status} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-100 truncate">
            {t.readerName || `${t.port} addr ${fmtAddr(t.address)}`}
          </div>
          <div className="text-xs text-gray-500 font-mono">
            {t.port} · {fmtAddr(t.address)} · {t.baud} baud
            {item.identity?.firmwareString && <span className="text-emerald-300 ml-2">v{item.identity.firmwareString}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          {ok && <span className="text-xs text-emerald-300">✓ Flashed</span>}
          {failed && <span className="text-xs text-red-300">✗ {item.uploadError?.slice(0, 30) || item.status}</span>}
          {item.status === 'queued' && <span className="text-xs text-gray-500">Queued</span>}
          {item.status === 'skipped' && <span className="text-xs text-gray-500">Skipped</span>}
          {isActive && live && <span className="text-xs text-blue-300 font-mono">{pct}%</span>}
        </div>
      </div>

      {isActive && live && (
        <>
          <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden mt-2">
            <div className="h-full bg-gradient-to-r from-orange-500 to-amber-400 transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mt-1 font-mono">
            <span>frag {live.fragment ?? '?'}/{live.totalFragments ?? '?'}</span>
            <span>{fmtBytes(live.bytesSent)} / {fmtBytes(live.totalBytes)}</span>
            <span>elapsed {fmtDuration(live.elapsedMs)} · ETA {fmtDuration(live.etaMs)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function BatchSummary({ queue, onReset }: { queue: QueueItem[]; onReset: () => void }) {
  const ok    = queue.filter(q => q.status === 'success').length;
  const fail  = queue.filter(q => q.status === 'failure' || q.status === 'aborted').length;
  const skip  = queue.filter(q => q.status === 'skipped').length;
  return (
    <div className="pt-3 border-t border-gray-800">
      <div className="flex items-center gap-3">
        <Check size={18} className={ok > 0 ? 'text-emerald-400' : 'text-gray-500'} />
        <div className="text-sm">
          <span className="text-emerald-300 font-medium">{ok} succeeded</span>
          {fail > 0 && <span className="text-red-300 ml-3">{fail} failed</span>}
          {skip > 0 && <span className="text-gray-400 ml-3">{skip} skipped</span>}
        </div>
        <button onClick={onReset} className="ml-auto px-3 py-1.5 text-xs bg-orange-500/20 text-orange-200 border border-orange-500/40 rounded">
          New batch
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Shared bits
// ───────────────────────────────────────────────────────────────────────────

const INPUT_CLS = 'px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100 placeholder-gray-500 focus:border-orange-500/50 focus:outline-none';

function Field({ label, small, children }: any) {
  return (
    <div className={small ? 'w-24' : 'flex-1'}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function BtnGhost({ onClick, children, disabled }: any) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-3 py-1.5 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-40 flex items-center gap-1">
      {children}
    </button>
  );
}

function BtnPrimary({ onClick, children, disabled }: any) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-4 py-1.5 text-sm bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 border border-orange-500/40 rounded disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
      {children}
    </button>
  );
}
