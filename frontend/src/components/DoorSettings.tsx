import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, Plus, Trash2, Play, RefreshCw, Copy, ExternalLink, Wand2, Workflow } from 'lucide-react';
// AETHER_DOOR_WORKFLOWS: Custom Events run Emulation workflows (shared on the Pi)
import { requestEditWorkflow, navigateToEmulation, onWorkflowSaved, convertDoorStepsToWorkflow, uniqueWorkflowName, nodeScope } from '../lib/workflowBridge';
import { DoorOutputKind, DOOR_OUTPUT_CHANNELS, DOOR_OUTPUT_ROLES, doorOutputKind, doorOutputChannelLabel, isValidActiveVolts, LOCK_WATCH_TYPE, isLockWatch, lockWatchLabel,
  // AETHER_ANALOG_IN (Update 72): Lock watched on an EOL zone; custom input ios
  LOCK_WATCH_ANALOG_TYPE, isAnalogLockWatch, isValidLockWatchThreshold, DEFAULT_LOCK_WATCH_THRESHOLD, customIOLabel } from '../lib/doorOutputs';

type InputType =
  | 'None' | 'REX-Button' | 'Entry Sensor' | 'Lock Sensor'
  | 'Safety Beam' | 'DPS' | 'AUX' | 'General';

type OutputType =
  | 'None' | 'Strike Follower' | 'Lock'
  | 'Auto Door' | 'Sounder' | 'Strobe' | 'FAI' | 'General';

// AETHER_DOOR_OUTPUTS (Update 69): Lock, DPS and REX are all OUTPUTS Aether
// drives into the controller's inputs ('relay' REL 1-8, 'dac' DAC 1-4,
// 'od' O.D. 1-4 — open-drain shown only when already saved). Helpers live in
// ../lib/doorOutputs. channel -1 = not assigned.
const OUTPUT_CHANNELS = DOOR_OUTPUT_CHANNELS;
const outputKind = doorOutputKind;
const outputChannelLabel = (kind: DoorOutputKind, ch: number) => doorOutputChannelLabel(kind, ch);

type DoorEdgeIO = {
  channel: number;
  active: boolean;
  reverseSense?: boolean;
  hardwareType?: string;     // 'relay' | 'dac' | 'od' (legacy 'opto'/'analog' = relay); Lock only: 'opto-in' (AETHER_LOCK_WATCH), 'analog-in' (AETHER_ANALOG_IN)
  stackLevel?: number;
  activeVolts?: number;      // 'dac' only, 0-10 V (default 10)
  analogMode?: 'eol' | 'volts';   // AETHER_ANALOG_IN: 'analog-in' only (default 'eol')
  thresholdVolts?: number;        // AETHER_ANALOG_IN: 'analog-in' volts mode, 0.5-10 V (default 5)
  inputType?: 'opto' | 'analog';   // legacy, unused
};

type DoorIO = {
  id: string;
  name: string;
  type: InputType | OutputType;
  hardwareType?: string;     // AETHER_ANALOG_IN: 'relay' (REL n, driven) | 'opto' (OPTO n) | 'analog' (ADC n) — inputs follow the panel
  channel: number;
  active: boolean;
  enabled: boolean;
  reverseSense?: boolean;
  direction?: 'input' | 'output';
};

type CustomEventStep = {
  id: number;
  // #3: added 'wait' (pure delay step) and 'pulse' (momentary
  // activate->hold->release on lock/DPS/REX) — mirrors the Emulation
  // page's block model and consolidates 3 steps (activate+wait+deactivate)
  // into 1.
  action: 'lock' | 'unlock' | 'open-dps' | 'close-dps' | 'activate-rex' | 'deactivate-rex' | 'toggle-io' | 'send-card' | 'wait' | 'pulse';
  ioId?: string;
  readerId?: string;
  cardFormat?: '26' | '34' | '35' | '37' | '48';
  facilityCode?: string;
  cardNumber?: string;
  delay: number;
  // #3 wait-step config (when action === 'wait')
  waitType?: 'seconds' | 'minutes' | 'random';
  waitValue?: number;          // seconds or minutes (per waitType)
  waitMin?: number;            // random lower bound (seconds)
  waitMax?: number;            // random upper bound (seconds)
  // #3 pulse-step config (when action === 'pulse')
  pulseTarget?: 'lock' | 'dps' | 'rex';
  pulseDuration?: number;      // ms held active before auto-release
};

type CustomEvent = {
  name: string;
  enabled: boolean;
  steps: CustomEventStep[];   // legacy step list — runs only while no workflow is linked
  // AETHER_DOOR_WORKFLOWS: Emulation workflow (/api/emulations id) this event runs
  workflowId?: string;
  workflowName?: string;
};

type Door = {
  id: number;
  name: string;
  enabled: boolean;
  ioSource?: 'physical' | 'emulated';
  lock: DoorEdgeIO & { name: string };
  dps: DoorEdgeIO & { name: string };
  rexIn: DoorEdgeIO & { name: string };
  ios: DoorIO[];
  reader: string | null;   // #3: single reader per door
  customEvents?: CustomEvent[];
};

// AETHER_READER_DIR (Update 71): enrolled readers (ids 'wg-<n>' / 'osdp-<id>',
// with `label`) plus legacy pool readers no enrolled reader replaces (`legacy`).
type Reader = {
  id: string;
  name: string;
  type: 'wiegand' | 'osdp' | 'none';
  enabled: boolean;
  d0?: number;
  d1?: number;
  address?: number;
  label?: string;
  legacy?: boolean;
};

const readerOptionLabel = (r: Reader) =>
  r.label || `${r.name} ${r.type === 'wiegand' ? `(D0:${r.d0}, D1:${r.d1})` : `(OSDP ${r.address ?? ''})`}`;

interface EmuBoardLite {
  address: number;
  model: string;
  numInputs: number;
  numOutputs: number;
  numReaders?: number;
}

interface DoorSettingsProps {
  door: Door;
  readers: Reader[];
  emuBoard?: EmuBoardLite | null;   // #2: when set, channels are board-derived
  onClose: () => void;
  // Returns false when the parent refused the save (e.g. shared outputs);
  // the modal then stays open. void/true = saved.
  onSave: (updatedDoor: Door) => boolean | void;
  // AETHER_DOOR_OUTPUTS: outputs this door would share. `blocking` = the
  // parent will refuse Save (an unchanged pre-existing clash only warns).
  checkOutputConflicts?: (door: Door) => { problems: string[]; blocking: boolean };
  // #feat: inline Test Run. DoorSection owns the executor; it reports
  // per-step progress via the hooks and resolves with a summary.
  onTestRun?: (
    doorId: number,
    steps: CustomEventStep[],
    hooks: {
      onStepStart: (index: number) => void;
      onStepEnd: (index: number, ok: boolean) => void;
    }
  ) => Promise<{ ran: number; failed: number; total: number }>;
  // #1: copy the event currently being edited to the SAME slot on every
  // door (mass-assign). Implemented in DoorSection (it owns all doors).
  // AETHER_DOOR_WORKFLOWS: 3rd arg = this door as just saved (so the parent copies onto current data)
  onApplyEventToAllDoors?: (eventIndex: number, event: CustomEventStep extends never ? never : any, updatedDoor?: Door) => void;
  // AETHER_DOOR_WORKFLOWS
  ipAddress?: string;                                  // for the Pi's workflow library (/api/emulations)
  nodeId?: string;                                     // AETHER_DOOR_IO_WORKFLOWS: cluster node id (bridge scope)
  onPersistDoor?: (updatedDoor: Door) => boolean;      // save WITHOUT closing (false = refused)
  onRunWorkflow?: (doorId: number, event: CustomEvent) => Promise<{ ok: boolean; error?: string }>;
}

const DoorSettings: React.FC<DoorSettingsProps> = ({ door, readers, emuBoard, onClose, onSave, checkOutputConflicts, onTestRun, onApplyEventToAllDoors, ipAddress, nodeId, onPersistDoor, onRunWorkflow }) => {
  const [editedDoor, setEditedDoor] = useState<Door>(JSON.parse(JSON.stringify(door)));
  // #feat 1/5/6: inline Test Run state
  const [testRunning, setTestRunning] = useState(false);
  const [testStepIdx, setTestStepIdx] = useState<number>(-1);          // 5: which step is executing
  const [testSummary, setTestSummary] = useState<{ ran: number; failed: number; total: number } | null>(null); // 6
  const [testLog, setTestLog] = useState<string[]>([]);

  const runTestNow = async () => {
    if (testRunning) return;
    // AETHER_DOOR_WORKFLOWS: a linked workflow runs in Emulation with this door as "This door"
    const ev = editedDoor.customEvents?.[editingEventIndex];
    if (ev?.workflowId) {
      if (!onRunWorkflow) return;
      setTestRunning(true); setTestSummary(null); setTestStepIdx(-1);
      setTestLog([`▶ Test Run — workflow "${ev.workflowName || ev.workflowId}" on "${editedDoor.name}" (uses the SAVED door settings)`]);
      try {
        const r = await onRunWorkflow(editedDoor.id, ev);
        setTestLog(prev => [...prev, r.ok ? '■ Started in Emulation — follow it in the Emulation log' : `  ✗ Not started: ${r.error}`]);
      } catch (e: any) {
        setTestLog(prev => [...prev, `  ✗ Test run error: ${e?.message || e}`]);
      } finally { setTestRunning(false); }
      return;
    }
    if (!onTestRun) return;
    const steps = editedDoor.customEvents?.[editingEventIndex]?.steps || [];
    if (steps.length === 0) { setTestLog(['No steps to run.']); return; }
    setTestRunning(true);
    setTestSummary(null);
    setTestStepIdx(-1);
    setTestLog([`▶ Test Run — ${steps.length} step(s) on "${editedDoor.name}" (uses current editor steps, no save needed)`]);
    try {
      const result = await onTestRun(editedDoor.id, steps, {
        onStepStart: (idx) => {
          setTestStepIdx(idx);
          setTestLog(prev => [...prev, `  → Step ${idx + 1} (${steps[idx]?.action}) running…`]);
        },
        onStepEnd: (idx, ok) => {
          setTestLog(prev => [...prev, `  ${ok ? '✓' : '✗'} Step ${idx + 1} ${ok ? 'done' : 'FAILED'}`]);
        },
      });
      setTestSummary(result);
      setTestLog(prev => [...prev, `■ Complete — ${result.ran}/${result.total} ran, ${result.failed} failed`]);
    } catch (e: any) {
      setTestLog(prev => [...prev, `✗ Test run error: ${e?.message || e}`]);
    } finally {
      setTestRunning(false);
      setTestStepIdx(-1);
    }
  };
  const [activeSection, setActiveSection] = useState<'basic' | 'mandatory' | 'custom' | 'events'>('basic');
  const [editingEventIndex, setEditingEventIndex] = useState(0);

  // Initialize custom events if they don't exist
  useEffect(() => {
    if (!editedDoor.customEvents || editedDoor.customEvents.length !== 6) {
      const defaultEvents: CustomEvent[] = Array.from({ length: 6 }, (_, i) => ({
        name: `Custom Event ${i + 1}`,
        enabled: true,
        steps: []
      }));
      setEditedDoor({ ...editedDoor, customEvents: defaultEvents });
    }
  }, []);

  const [saveRefused, setSaveRefused] = useState(false);
  const outputCheck = checkOutputConflicts ? checkOutputConflicts(editedDoor) : { problems: [], blocking: false };
  const outputProblems = outputCheck.problems;
  const physicalOutputs = !emuBoard && editedDoor.ioSource !== 'emulated';
  // Analog outputs need a real active voltage (0 < V <= 10).
  const badVolts = physicalOutputs
    ? DOOR_OUTPUT_ROLES.filter(({ key }) => outputKind(editedDoor[key]) === 'dac' && !isValidActiveVolts(editedDoor[key].activeVolts))
    : [];
  // AETHER_ANALOG_IN: a volts-mode watched lock needs a threshold of 0.5-10 V.
  const badThreshold = physicalOutputs && isAnalogLockWatch(editedDoor.lock) && editedDoor.lock.analogMode === 'volts'
    && !isValidLockWatchThreshold(editedDoor.lock.thresholdVolts ?? DEFAULT_LOCK_WATCH_THRESHOLD);

  const handleSave = () => {
    if (badVolts.length || badThreshold) {   // AETHER_ANALOG_IN: + badThreshold
      setSaveRefused(true);
      setActiveSection('mandatory');
      return;
    }
    if (onSave(editedDoor) === false) {
      // Refused: keep the modal open and show why on the Mandatory I/O tab.
      setSaveRefused(true);
      setActiveSection('mandatory');
      return;
    }
    setSaveRefused(false);
    onClose();
  };

  // ── AETHER_DOOR_WORKFLOWS: Custom Event → Emulation workflow ──────────────
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [wfLoading, setWfLoading] = useState(false);
  const [wfError, setWfError] = useState('');
  const [wfBusy, setWfBusy] = useState(false);
  const [wfMsg, setWfMsg] = useState('');
  const apiBase = ipAddress ? `http://${ipAddress}:3001` : '';
  const loadWorkflows = async (): Promise<{ id: string; name: string }[]> => {
    if (!apiBase) { setWfError('Not connected to the Pi'); return workflows; }
    setWfLoading(true); setWfError('');
    try {
      const r = await fetch(`${apiBase}/api/emulations`);
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      const list = (Array.isArray(j.items) ? j.items : [])
        .filter((w: any) => w && w.id)
        .map((w: any) => ({ id: String(w.id), name: String(w.name || w.id) }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      setWorkflows(list);
      return list;
    } catch (e: any) {
      setWfError(`Workflows not loaded: ${e?.message || e}`);
      return workflows;
    } finally { setWfLoading(false); }
  };
  useEffect(() => { if (activeSection === 'events') loadWorkflows(); }, [activeSection, ipAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // Patch one event slot (immutable).
  const withEvent = (d: Door, index: number, patch: Partial<CustomEvent>): Door => {
    const events = (d.customEvents || []).map(e => ({ ...e }));
    if (!events[index]) return d;
    events[index] = { ...events[index], ...patch };
    return { ...d, customEvents: events };
  };
  const setEventWorkflow = (index: number, id: string) => {
    const w = workflows.find(x => x.id === id);
    setEditedDoor(prev => withEvent(prev, index, id ? { workflowId: id, workflowName: w?.name || id } : { workflowId: undefined, workflowName: undefined }));
  };
  // Save this door WITHOUT closing (falls back to the normal Save, which closes).
  const persistDoor = (d: Door): boolean => {
    if (badVolts.length || badThreshold) { setSaveRefused(true); setActiveSection('mandatory'); return false; }
    const ok = onPersistDoor ? onPersistDoor(d) : onSave(d) !== false;
    if (ok === false) { setSaveRefused(true); setActiveSection('mandatory'); return false; }
    setSaveRefused(false);
    return true;
  };
  // "Edit in builder" / "New workflow": save the door, hand the event to the
  // Emulation builder, switch to it.
  const openInBuilder = (index: number, mode: 'edit' | 'new') => {
    const ev = editedDoor.customEvents?.[index];
    if (!ev) return;
    if (!persistDoor(editedDoor)) return;
    const common = { doorId: editedDoor.id, doorName: editedDoor.name, eventIndex: index, eventName: ev.name || `Event ${index + 1}` };
    const scope = nodeScope(nodeId, ipAddress);   // AETHER_DOOR_IO_WORKFLOWS: this node's Emulation only
    if (mode === 'edit' && ev.workflowId) requestEditWorkflow({ ...common, scope, workflowId: ev.workflowId });
    else requestEditWorkflow({ ...common, scope, newName: uniqueWorkflowName(`${editedDoor.name} · ${ev.name || `Event ${index + 1}`}`, workflows) });
    navigateToEmulation(scope);
    onClose();
  };
  // Old step list → saved workflow, linked to the event; the steps are cleared.
  const convertEvent = async (index: number) => {
    const ev = editedDoor.customEvents?.[index];
    if (!ev || !ev.steps?.length || wfBusy) return;
    if (!apiBase) { setWfMsg('Not connected to the Pi — cannot save a workflow'); return; }
    setWfBusy(true); setWfMsg('');
    try {
      const { columns, globalDelay } = convertDoorStepsToWorkflow(ev.steps, ev.name, { doorReaderId: editedDoor.reader, doorIos: editedDoor.ios });
      const list = await loadWorkflows();   // fresh list: a name whose id exists would OVERWRITE that workflow
      const name = uniqueWorkflowName(`${editedDoor.name} · ${ev.name || `Event ${index + 1}`}`, list);
      const r = await fetch(`${apiBase}/api/emulations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, steps: columns, globalDelay, repeatCount: 0, version: 'workflow-v2' }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.success || !j.id) throw new Error(j?.error || `HTTP ${r.status}`);
      const next = withEvent(editedDoor, index, { workflowId: String(j.id), workflowName: name, steps: [] });
      setEditedDoor(next);
      setWorkflows(prev => [...prev.filter(w => w.id !== String(j.id)), { id: String(j.id), name }].sort((a, b) => a.name.localeCompare(b.name)));
      setWfMsg(persistDoor(next)
        ? `Converted to workflow "${name}" (${columns.length} column${columns.length === 1 ? '' : 's'}) and saved.`
        : `Converted to workflow "${name}" — press Save to keep the link.`);
    } catch (e: any) {
      setWfMsg(`Convert failed: ${e?.message || e}`);
    } finally { setWfBusy(false); }
  };
  // The builder saved a new workflow for one of this door's events (if this modal is open).
  useEffect(() => onWorkflowSaved(nodeScope(nodeId, ipAddress), d => {   // AETHER_DOOR_IO_WORKFLOWS: scoped
    if (!d || Number(d.doorId) !== Number(editedDoor.id)) return;
    setEditedDoor(prev => withEvent(prev, d.eventIndex, { workflowId: d.id, workflowName: d.name }));
  }), [editedDoor.id, ipAddress, nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // AETHER_DOOR_OUTPUTS: output type / channel / active-voltage fields for one
  // of Lock, DPS, REX on a physical (Sequent) door.
  const setEdge = (key: 'lock' | 'dps' | 'rexIn', patch: Partial<DoorEdgeIO> | Record<string, any>) =>
    setEditedDoor(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const fieldCls = 'w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text';
  const renderOutputFields = (key: 'lock' | 'dps' | 'rexIn') => {
    const io = editedDoor[key];
    const kind = outputKind(io);
    // AETHER_LOCK_WATCH: the Lock may instead be an INPUT watching the controller's lock relay
    const watched = key === 'lock' && isLockWatch(io);
    const analogWatch = watched && isAnalogLockWatch(io);   // AETHER_ANALOG_IN: ... or an EOL zone (ADC n)
    const thr = io.thresholdVolts ?? DEFAULT_LOCK_WATCH_THRESHOLD;
    return (
      <>
        <div>
          <label className="block text-sm font-semibold text-slate-300 mb-2">{key === 'lock' ? 'Lock Signal' : 'Output Type'}</label>
          <select
            value={watched ? io.hardwareType : kind}
            onChange={(e) => {
              if (e.target.value === LOCK_WATCH_TYPE || e.target.value === LOCK_WATCH_ANALOG_TYPE) {   // AETHER_ANALOG_IN: + analog
                const c = Number(io.channel);
                setEdge(key, {
                  hardwareType: e.target.value, channel: c >= 0 && c < 8 ? c : 0,
                  ...(e.target.value === LOCK_WATCH_ANALOG_TYPE ? { analogMode: io.analogMode || 'eol', thresholdVolts: thr } : {}),
                });
                return;
              }
              const k = e.target.value as DoorOutputKind;
              const ch = Number(io.channel) >= -1 && Number(io.channel) < OUTPUT_CHANNELS[k] ? Number(io.channel) : 0;
              setEdge(key, { hardwareType: k, channel: ch, ...(k === 'dac' && io.activeVolts === undefined ? { activeVolts: 10 } : {}) });
            }}
            className={fieldCls}
          >
            <option value="relay">{key === 'lock' ? 'Output: ' : ''}Relay (REL 1–8)</option>
            <option value="dac">{key === 'lock' ? 'Output: ' : ''}Analog output (DAC 1–4)</option>
            {kind === 'od' && !watched && <option value="od">Open-drain ({outputChannelLabel('od', io.channel)})</option>}
            {key === 'lock' && (
              <option value={LOCK_WATCH_TYPE}>Watched input: controller's lock relay → {watched && !analogWatch ? lockWatchLabel(io) : 'OPTO n'}</option>
            )}
            {key === 'lock' && (   /* AETHER_ANALOG_IN */
              <option value={LOCK_WATCH_ANALOG_TYPE}>Watched input: EOL zone → {analogWatch ? lockWatchLabel(io) : 'ADC n'}</option>
            )}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-300 mb-2">{watched ? 'Input' : 'Channel'}</label>
          <select
            value={io.channel}
            onChange={(e) => { const v = parseInt(e.target.value, 10); setEdge(key, { channel: Number.isFinite(v) ? v : -1 }); }}
            className={fieldCls}
          >
            <option value={-1}>Not assigned</option>
            {watched
              ? Array.from({ length: 8 }, (_, ch) => <option key={ch} value={ch}>{analogWatch ? 'ADC' : 'OPTO'} {ch + 1}</option>)   /* AETHER_ANALOG_IN */
              : Array.from({ length: OUTPUT_CHANNELS[kind] }, (_, ch) => (
              <option key={ch} value={ch}>{outputChannelLabel(kind, ch)}</option>
            ))}
          </select>
        </div>
        {analogWatch && (   /* AETHER_ANALOG_IN: how the zone reads as unlocked */
          <div>
            <label className="block text-sm font-semibold text-slate-300 mb-2">Mode</label>
            <select value={io.analogMode || 'eol'} onChange={(e) => setEdge(key, { analogMode: e.target.value })} className={fieldCls}>
              <option value="eol">EOL supervision</option>
              <option value="volts">Voltage threshold</option>
            </select>
          </div>
        )}
        {analogWatch && io.analogMode === 'volts' && (   /* AETHER_ANALOG_IN */
          <div>
            <label className="block text-sm font-semibold text-slate-300 mb-2">Unlocked at or above (V)</label>
            <input
              type="number" min={0.5} max={10} step={0.1}
              value={thr}
              onChange={(e) => {
                // keep the raw entry while typing; validated on Save (0.5-10 V)
                const raw = e.target.value;
                const v = parseFloat(raw);
                setEdge(key, { thresholdVolts: raw === '' ? ('' as any) : Number.isFinite(v) ? v : ('' as any) });
              }}
              className={fieldCls}
              aria-invalid={!isValidLockWatchThreshold(thr)}
              style={!isValidLockWatchThreshold(thr) ? { borderColor: 'rgb(var(--hv-error))' } : undefined}
            />
            <p className="text-xs mt-1" style={{ color: isValidLockWatchThreshold(thr) ? undefined : 'rgb(var(--hv-error-text))' }}>
              {isValidLockWatchThreshold(thr) ? <span className="text-slate-500">0–10 V zone input.</span> : 'Enter 0.5 to 10 V.'}
            </p>
          </div>
        )}
        {kind === 'dac' && !watched && (
          <div>
            <label className="block text-sm font-semibold text-slate-300 mb-2">Active voltage (V)</label>
            <input
              type="number" min={0.1} max={10} step={0.1}
              value={io.activeVolts ?? 10}
              onChange={(e) => {
                // keep the raw entry while typing; validated on Save (0 < V <= 10)
                const raw = e.target.value;
                const v = parseFloat(raw);
                setEdge(key, { activeVolts: raw === '' ? ('' as any) : Number.isFinite(v) ? Math.min(10, v) : ('' as any) });
              }}
              className={fieldCls}
              aria-invalid={!isValidActiveVolts(io.activeVolts ?? 10)}
              style={!isValidActiveVolts(io.activeVolts ?? 10) ? { borderColor: 'rgb(var(--hv-error))' } : undefined}
            />
            <p className="text-xs mt-1" style={{ color: isValidActiveVolts(io.activeVolts ?? 10) ? undefined : 'rgb(var(--hv-error-text))' }}>
              {isValidActiveVolts(io.activeVolts ?? 10) ? <span className="text-slate-500">Inactive is 0 V.</span> : 'Enter a voltage above 0 and up to 10 V.'}
            </p>
          </div>
        )}
      </>
    );
  };

  const updateDoorName = (name: string) => {
    setEditedDoor({ ...editedDoor, name });
  };

  const updateMandatoryIO = (
    ioType: 'lock' | 'dps' | 'rexIn',
    field: 'name' | 'channel' | 'reverseSense',
    value: string | number | boolean
  ) => {
    setEditedDoor({
      ...editedDoor,
      [ioType]: {
        ...editedDoor[ioType],
        [field]: value
      }
    });
  };

  const updateCustomIO = (
    ioId: string,
    field: keyof DoorIO,
    value: any
  ) => {
    setEditedDoor({
      ...editedDoor,
      ios: editedDoor.ios.map(io =>
        io.id === ioId ? { ...io, [field]: value } : io
      )
    });
  };

  const toggleIODirection = (ioId: string) => {
    setEditedDoor({
      ...editedDoor,
      ios: editedDoor.ios.map(io => {
        if (io.id === ioId) {
          const newDirection = io.direction === 'input' ? 'output' : 'input';
          return { ...io, direction: newDirection };
        }
        return io;
      })
    });
  };

  // Custom Event Management
  const updateCustomEventName = (index: number, name: string) => {
    const events = [...(editedDoor.customEvents || [])];
    events[index].name = name;
    setEditedDoor({ ...editedDoor, customEvents: events });
  };

  const toggleCustomEventEnabled = (index: number) => {
    const events = [...(editedDoor.customEvents || [])];
    events[index].enabled = !events[index].enabled;
    setEditedDoor({ ...editedDoor, customEvents: events });
  };

  const addEventStep = (eventIndex: number) => {
    const events = [...(editedDoor.customEvents || [])];
    const newStep: CustomEventStep = {
      id: Date.now(),
      action: 'lock',
      delay: 1000
    };
    events[eventIndex].steps.push(newStep);
    setEditedDoor({ ...editedDoor, customEvents: events });
  };

  const removeEventStep = (eventIndex: number, stepId: number) => {
    const events = [...(editedDoor.customEvents || [])];
    events[eventIndex].steps = events[eventIndex].steps.filter(s => s.id !== stepId);
    setEditedDoor({ ...editedDoor, customEvents: events });
  };

  const updateEventStep = (eventIndex: number, stepId: number, field: keyof CustomEventStep, value: any) => {
    const events = [...(editedDoor.customEvents || [])];
    events[eventIndex].steps = events[eventIndex].steps.map(step =>
      step.id === stepId ? { ...step, [field]: value } : step
    );
    setEditedDoor({ ...editedDoor, customEvents: events });
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div className="bg-hv-widget-panel rounded-xl max-w-6xl w-full max-h-[90vh] overflow-hidden border-2 border-hv-line-strong shadow-2xl">
        {/* Header */}
        <div className="bg-hv-widget/60 p-6 border-b border-hv-line-strong">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-hv-text flex items-center gap-3">
                <span className="text-3xl">⚙️</span>
                Door Settings
              </h2>
              <p className="text-sm text-slate-400 mt-1">
                Configure {door.name} properties, I/O settings, reverse sense, and custom event sequences
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-hv-text transition-colors"
            >
              <X size={28} />
            </button>
          </div>
        </div>

        {/* Section Tabs */}
        <div className="flex gap-2 p-4 bg-hv-widget/60 border-b border-hv-line-strong">
          {[
            { id: 'basic', label: ' Basic', desc: 'Door Name' },
            { id: 'mandatory', label: ' Mandatory I/O', desc: 'Lock, DPS, REX' },
            { id: 'custom', label: ' Custom I/O', desc: 'Additional I/O' },
            { id: 'events', label: ' Custom Events', desc: 'Event Sequences' }
          ].map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id as any)}
              className={`flex-1 px-4 py-3 rounded-lg font-semibold text-sm transition-all relative ${
                activeSection === section.id
                  ? 'bg-emerald-800/50 text-emerald-100 border border-emerald-700/40 shadow-lg'
                  : 'bg-hv-widget/60 text-slate-400 hover:bg-hv-line hover:text-slate-200'
              }`}
            >
              <div>{section.label}</div>
              <div className="text-xs opacity-70">{section.desc}</div>
              {activeSection === section.id && (
                <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent border-t-slate-500" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-280px)]">
          {/* Basic Settings */}
          {activeSection === 'basic' && (
            <div className="space-y-4">
              <div className="bg-hv-widget/60 rounded-lg p-6 border border-hv-line-strong">
                <label className="block text-sm font-semibold text-slate-300 mb-2">
                  Door Name
                </label>
                <input
                  type="text"
                  value={editedDoor.name}
                  onChange={(e) => updateDoorName(e.target.value)}
                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-4 py-3 text-hv-text text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-hv-text-3"
                  placeholder="Enter door name"
                />
                <p className="text-xs text-slate-500 mt-2">
                  This name will be displayed throughout the interface
                </p>
              </div>

              {/* #3: single reader assignment (the reader used by this door) */}
              <div className="bg-hv-widget/60 rounded-lg p-6 border border-hv-line-strong">
                <label className="block text-sm font-semibold text-slate-300 mb-2">
                  Reader
                </label>
                <select
                  value={editedDoor.reader || ''}
                  onChange={(e) => setEditedDoor({ ...editedDoor, reader: e.target.value || null })}
                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-4 py-3 text-hv-text focus:outline-none focus:ring-2 focus:ring-hv-text-3"
                >
                  <option value="">-- No Reader --</option>
                  {/* AETHER_READER_DIR: every enrolled reader (legacy pool: enabled ones, or the one this door already uses) */}
                  {(['wiegand', 'osdp'] as const).map(t => {
                    const list = readers.filter(r => r.type === t && (!r.legacy || r.enabled || r.id === editedDoor.reader));
                    return list.length > 0 && (
                      <optgroup key={t} label={t === 'wiegand' ? 'Wiegand readers' : 'OSDP readers'}>
                        {list.map(r => (
                          <option key={r.id} value={r.id}>
                            {readerOptionLabel(r)}{r.enabled === false && !r.label ? ' — disabled' : ''}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                  {emuBoard && (
                    <optgroup label={`Emulated Controller #${emuBoard.address} ${emuBoard.model}`}>
                      {Array.from({ length: Math.max(1, emuBoard.numReaders ?? 1) }, (_, port) => (
                        <option key={`ctrl-emu-${emuBoard.address}-${port}`} value={`ctrl-emu-${emuBoard.address}-${port}`}>
                          #{emuBoard.address} {emuBoard.model} — Reader {port}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="text-xs text-slate-500 mt-2">
                  This reader is used for presenting credentials to this door (single reader per door).
                </p>
              </div>

              <div className="bg-hv-widget/40 rounded-lg p-4 border border-hv-line-strong/60">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-slate-400 flex-shrink-0 mt-1" size={20} />
                  <div className="text-sm text-slate-300">
                    <strong>Tip:</strong> Use descriptive names like "Main Entrance", "Server Room", or "Emergency Exit" to easily identify doors in your system.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Mandatory I/O Settings */}
          {activeSection === 'mandatory' && (
            <div className="space-y-4">
              {/* AETHER_DOOR_OUTPUTS: outputs this door would share */}
              {saveRefused && badVolts.length > 0 && (
                <div role="alert" className="rounded-lg p-4 border text-sm"
                  style={{ background: 'rgb(var(--hv-error) / 0.12)', borderColor: 'rgb(var(--hv-error) / 0.55)', color: 'rgb(var(--hv-error-text))' }}>
                  <strong>Not saved:</strong> {badVolts.map(r => r.role).join(', ')} {badVolts.length > 1 ? 'need' : 'needs'} an active voltage above 0 V (up to 10 V).
                </div>
              )}
              {saveRefused && badThreshold && (   /* AETHER_ANALOG_IN */
                <div role="alert" className="rounded-lg p-4 border text-sm"
                  style={{ background: 'rgb(var(--hv-error) / 0.12)', borderColor: 'rgb(var(--hv-error) / 0.55)', color: 'rgb(var(--hv-error-text))' }}>
                  <strong>Not saved:</strong> the Lock's unlock threshold must be 0.5–10 V.
                </div>
              )}
              {outputProblems.length > 0 && (
                <div role="alert" className="rounded-lg p-4 border"
                  style={{ background: 'rgb(var(--hv-warning-tint))', borderColor: 'rgb(var(--hv-warning) / 0.55)', color: 'rgb(var(--hv-warning-text))' }}>
                  <div className="flex items-start gap-3">
                    <AlertCircle className="flex-shrink-0 mt-0.5" size={20} style={{ color: 'rgb(var(--hv-warning))' }} />
                    <div className="text-sm min-w-0">
                      <div className="font-bold">{saveRefused && outputCheck.blocking ? 'Not saved: ' : ''}this door shares {outputProblems.length === 1 ? 'an output' : 'outputs'}</div>
                      <ul className="mt-1 space-y-0.5">
                        {outputProblems.map(m => <li key={m}>{m}</li>)}
                      </ul>
                      <div className="text-xs mt-1" style={{ color: 'rgb(var(--hv-text-2))' }}>
                        {outputCheck.blocking
                          ? 'Give each output its own channel, or disable the door, then save.'
                          : 'These outputs are unchanged, so you can still save other changes. Give each output its own channel to fix it.'}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="bg-hv-widget/40 rounded-lg p-4 border border-hv-line-strong/60">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-slate-400 flex-shrink-0 mt-1" size={20} />
                  <div className="text-sm text-slate-300">
                    {emuBoard ? (
                      <><strong>Emulated board #{emuBoard.address} ({emuBoard.model}):</strong> Lock = OUTPUT 0-{Math.max(0, emuBoard.numOutputs - 1)}, DPS/REX = INPUT 0-{Math.max(0, emuBoard.numInputs - 1)}. Channels below are limited to this board's real I/O count.</>
                    ) : (
                      <><strong>Aether outputs:</strong> Lock, DPS and REX are all outputs Aether drives into the controller's inputs. Pick a relay (REL 1–8) or an analog output (DAC 1–4, with the voltage to drive when active) for each. Every enabled door needs its own outputs. The Lock can instead be a <em>watched input</em>: wire the controller's lock relay to an opto input (OPTO 1–8), or an EOL zone to an analog input (ADC 1–8), and Aether follows it without driving anything.</>
                    )}
                  </div>
                </div>
              </div>

              {/* Lock */}
              <div className="bg-hv-widget/60 rounded-lg p-5 border border-hv-line-strong">
                <h3 className="text-lg font-bold text-slate-300 mb-4 flex items-center gap-2">
                  <span></span> Door Lock
                </h3>
                <div className={`grid grid-cols-1 gap-4 ${physicalOutputs && (isAnalogLockWatch(editedDoor.lock) || (!isLockWatch(editedDoor.lock) && outputKind(editedDoor.lock) === 'dac')) ? 'sm:grid-cols-4' : physicalOutputs ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Name
                    </label>
                    <input
                      type="text"
                      value={editedDoor.lock.name}
                      onChange={(e) => updateMandatoryIO('lock', 'name', e.target.value)}
                      className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                    />
                  </div>
                  {physicalOutputs ? renderOutputFields('lock') : (
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Output Channel
                    </label>
                    <select
                      value={editedDoor.lock.channel}
                      onChange={(e) => updateMandatoryIO('lock', 'channel', parseInt(e.target.value))}
                      className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                    >
                      {Array.from({ length: emuBoard ? emuBoard.numOutputs : 8 }, (_, ch) => (
                        <option key={ch} value={ch}>OUTPUT {ch}{emuBoard ? ` (#${emuBoard.address})` : ''}</option>
                      ))}
                    </select>
                  </div>
                  )}
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.lock.reverseSense || false}
                      onChange={(e) => updateMandatoryIO('lock', 'reverseSense', e.target.checked)}
                      className="w-5 h-5 rounded bg-hv-line border-hv-line-strong/60 accent-hv-text-3"
                    />
                    <div>
                      <span className="text-sm font-semibold text-hv-text">Reverse Sense (Active at Rest)</span>
                      <p className="text-xs text-slate-400">
                        {physicalOutputs && isAnalogLockWatch(editedDoor.lock)
                          // AETHER_ANALOG_IN: reverseSense inverts the zone's unlocked reading
                          ? (editedDoor.lock.analogMode === 'volts'
                            ? (editedDoor.lock.reverseSense
                              ? `${lockWatchLabel(editedDoor.lock)} below ${editedDoor.lock.thresholdVolts ?? DEFAULT_LOCK_WATCH_THRESHOLD} V = Unlocked`
                              : `${lockWatchLabel(editedDoor.lock)} at/above ${editedDoor.lock.thresholdVolts ?? DEFAULT_LOCK_WATCH_THRESHOLD} V = Unlocked`)
                            : (editedDoor.lock.reverseSense
                              ? `${lockWatchLabel(editedDoor.lock)} NORMAL = Unlocked, ALARM = Locked (trouble / tamper stay locked)`
                              : `${lockWatchLabel(editedDoor.lock)} ALARM = Unlocked, NORMAL = Locked (trouble / tamper stay locked)`))
                          : physicalOutputs && isLockWatch(editedDoor.lock)
                          // AETHER_LOCK_WATCH: reverseSense = unlocked when the input is OFF
                          ? (editedDoor.lock.reverseSense
                            ? `${lockWatchLabel(editedDoor.lock)} OFF = Unlocked (controller relay energised at rest)`
                            : `${lockWatchLabel(editedDoor.lock)} ON = Unlocked`)
                          : editedDoor.lock.reverseSense
                          ? ' GPIO HIGH = Locked (Active at Rest)'
                          : 'GPIO HIGH = Unlocked (Inactive at Rest)'}
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* DPS */}
              <div className="bg-hv-widget/60 rounded-lg p-5 border border-hv-line-strong">
                <h3 className="text-lg font-bold text-slate-300 mb-4 flex items-center gap-2">
                  <span></span> Door Position Switch (output to controller DPS input)
                </h3>
                <div className={`grid grid-cols-1 gap-4 ${physicalOutputs && outputKind(editedDoor.dps) === 'dac' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Name
                    </label>
                    <input
                      type="text"
                      value={editedDoor.dps.name}
                      onChange={(e) => updateMandatoryIO('dps', 'name', e.target.value)}
                      className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                    />
                  </div>
                  {physicalOutputs ? renderOutputFields('dps') : (
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Input Channel
                    </label>
                    <select
                      value={editedDoor.dps.channel}
                      onChange={(e) => updateMandatoryIO('dps', 'channel', parseInt(e.target.value))}
                      className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                    >
                      {Array.from({ length: emuBoard ? emuBoard.numInputs : 8 }, (_, ch) => (
                        <option key={ch} value={ch}>INPUT {ch}{emuBoard ? ` (#${emuBoard.address})` : ''}</option>
                      ))}
                    </select>
                  </div>
                  )}
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.dps.reverseSense || false}
                      onChange={(e) => updateMandatoryIO('dps', 'reverseSense', e.target.checked)}
                      className="w-5 h-5 rounded bg-hv-line border-hv-line-strong/60 accent-hv-text-3"
                    />
                    <div>
                      <span className="text-sm font-semibold text-hv-text">Reverse Sense (Active at Rest)</span>
                      <p className="text-xs text-slate-400">
                        {editedDoor.dps.reverseSense
                          ? 'GPIO HIGH = Door Closed (Active at Rest)'
                          : 'GPIO HIGH = Door Open (Inactive at Rest)'}
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* REX */}
              <div className="bg-hv-widget/60 rounded-lg p-5 border border-hv-line-strong">
                <h3 className="text-lg font-bold text-slate-300 mb-4 flex items-center gap-2">
                  <span></span> Request to Exit (output to controller REX input)
                </h3>
                <div className={`grid grid-cols-1 gap-4 ${physicalOutputs && outputKind(editedDoor.rexIn) === 'dac' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Name
                    </label>
                    <input
                      type="text"
                      value={editedDoor.rexIn.name}
                      onChange={(e) => updateMandatoryIO('rexIn', 'name', e.target.value)}
                      className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                    />
                  </div>
                  {physicalOutputs ? renderOutputFields('rexIn') : (
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Input Channel
                    </label>
                    <select
                      value={editedDoor.rexIn.channel}
                      onChange={(e) => updateMandatoryIO('rexIn', 'channel', parseInt(e.target.value))}
                      className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                    >
                      {Array.from({ length: emuBoard ? emuBoard.numInputs : 8 }, (_, ch) => (
                        <option key={ch} value={ch}>INPUT {ch}{emuBoard ? ` (#${emuBoard.address})` : ''}</option>
                      ))}
                    </select>
                  </div>
                  )}
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.rexIn.reverseSense || false}
                      onChange={(e) => updateMandatoryIO('rexIn', 'reverseSense', e.target.checked)}
                      className="w-5 h-5 rounded bg-hv-line border-hv-line-strong/60 accent-hv-text-3"
                    />
                    <div>
                      <span className="text-sm font-semibold text-hv-text">Reverse Sense (Active at Rest)</span>
                      <p className="text-xs text-slate-400">
                        {editedDoor.rexIn.reverseSense
                          ? '⚠️ GPIO HIGH = Idle (Active at Rest)'
                          : '✓ GPIO HIGH = Pressed (Inactive at Rest)'}
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Custom I/O Settings */}
          {activeSection === 'custom' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">Custom I/O for this door ({editedDoor.ios.length}/6)</p>
                <button
                  onClick={() => {
                    if (editedDoor.ios.length >= 6) return;
                    const newIO: any = {
                      id: `door${editedDoor.id}-io-${Date.now()}`,
                      name: `I/O ${editedDoor.ios.length + 1}`,
                      type: 'General',
                      hardwareType: 'relay',
                      channel: 0,
                      active: false,
                      enabled: true,
                    };
                    setEditedDoor({ ...editedDoor, ios: [...editedDoor.ios, newIO] });
                  }}
                  disabled={editedDoor.ios.length >= 6}
                  className="px-3 py-1.5 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-30 border border-hv-line-strong/60"
                >
                  <Plus size={16} /> Add I/O
                </button>
              </div>
              {editedDoor.ios.length === 0 ? (
                <div className="text-center py-12 bg-hv-widget/40 rounded-lg border border-dashed border-hv-line-strong">
                  <p className="text-slate-500 mb-2">No custom I/O configured</p>
                  <p className="text-xs text-slate-600">Click "Add I/O" above to add inputs or outputs</p>
                </div>
              ) : (
                editedDoor.ios.map((io) => (
                  <div key={io.id} className="bg-hv-widget/60 rounded-lg p-5 border border-hv-line-strong">
                    <div className="flex justify-end -mb-2">
                      <button
                        onClick={() => setEditedDoor({ ...editedDoor, ios: editedDoor.ios.filter(x => x.id !== io.id) })}
                        className="text-slate-500 hover:text-red-400 p-1"
                        title="Remove this I/O"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-4 mb-3">
                      <div className="col-span-2">
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          I/O Name
                        </label>
                        <input
                          type="text"
                          value={io.name}
                          onChange={(e) => updateCustomIO(io.id, 'name', e.target.value)}
                          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                        />
                      </div>
                      <div>
                        {/* AETHER_ANALOG_IN: channel picker follows the signal type (0-7 for all three) */}
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          Channel
                        </label>
                        <select
                          value={io.channel}
                          onChange={(e) => updateCustomIO(io.id, 'channel', parseInt(e.target.value, 10))}
                          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                        >
                          {!(io.channel >= 0 && io.channel <= 7) && <option value={io.channel}>{io.channel < 0 ? 'Not assigned' : `Channel ${io.channel}`}</option>}
                          {Array.from({ length: 8 }, (_, ch) => (
                            <option key={ch} value={ch}>{customIOLabel({ hardwareType: io.hardwareType, channel: ch })}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4 mb-3">
                      <div>
                        {/* AETHER_ANALOG_IN: what the entry is wired to. 'opto' / 'analog' are Aether
                            INPUTS (follow the panel, never driven); 'relay' is driven by toggle-io. */}
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          Signal
                        </label>
                        <select
                          value={io.hardwareType || ''}
                          onChange={(e) => {
                            const t = e.target.value;
                            setEditedDoor({
                              ...editedDoor,
                              ios: editedDoor.ios.map(x => x.id !== io.id ? x : {
                                ...x, hardwareType: t, channel: x.channel >= 0 && x.channel <= 7 ? x.channel : 0,
                                direction: t === 'relay' ? 'output' : 'input', active: false,
                              }),
                            });
                          }}
                          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                        >
                          <option value="relay">Relay output (REL 1–8)</option>
                          <option value="opto">Opto input (OPTO 1–8)</option>
                          <option value="analog">Analog input (ADC 1–8)</option>
                          {!['relay', 'opto', 'analog'].includes(io.hardwareType || '') && (
                            <option value={io.hardwareType || ''}>{io.hardwareType || 'Not set'} (legacy, not driven)</option>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          I/O Type
                        </label>
                        <select
                          value={io.type}
                          onChange={(e) => updateCustomIO(io.id, 'type', e.target.value)}
                          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                        >
                          <option value="General">General</option>
                          <option value="REX-Button">REX Button</option>
                          <option value="Entry Sensor">Entry Sensor</option>
                          <option value="Lock Sensor">Lock Sensor</option>
                          <option value="Safety Beam">Safety Beam</option>
                          <option value="Strike Follower">Strike Follower</option>
                          <option value="Lock">Lock</option>
                          <option value="Auto Door">Auto Door</option>
                          <option value="Sounder">Sounder</option>
                          <option value="Strobe">Strobe</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          Direction
                        </label>
                        {/* AETHER_ANALOG_IN: an opto / analog signal is always an input */}
                        <button
                          onClick={() => toggleIODirection(io.id)}
                          disabled={io.hardwareType === 'opto' || io.hardwareType === 'analog'}
                          className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text hover:bg-slate-700 transition-colors font-semibold disabled:opacity-60 disabled:hover:bg-hv-widget"
                        >
                          {io.direction === 'input' || io.hardwareType === 'opto' || io.hardwareType === 'analog' ? '📥 INPUT' : '📤 OUTPUT'}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={io.reverseSense || false}
                          onChange={(e) => updateCustomIO(io.id, 'reverseSense', e.target.checked)}
                          className="w-5 h-5 rounded bg-hv-line border-hv-line-strong/60 accent-hv-text-3"
                        />
                        <div>
                          <span className="text-sm font-semibold text-hv-text">Reverse Sense (Active at Rest)</span>
                          <p className="text-xs text-slate-400">
                            {io.hardwareType === 'opto' || io.hardwareType === 'analog'
                              // AETHER_ANALOG_IN: inputs follow the panel; reverseSense inverts what reads as active
                              ? (io.hardwareType === 'opto'
                                ? (io.reverseSense ? `${customIOLabel(io)} OFF = Active` : `${customIOLabel(io)} ON = Active`)
                                : (io.reverseSense ? `${customIOLabel(io)} NORMAL / TROUBLE = Active` : `${customIOLabel(io)} ALARM / TAMPER = Active`))
                              : io.reverseSense
                              ? '⚠️ GPIO HIGH when inactive (Active at Rest)'
                              : '✓ GPIO HIGH when active (Inactive at Rest)'}
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Custom Events Configuration */}
          {activeSection === 'events' && editedDoor.customEvents && (
            <div className="space-y-4">
              <div className="bg-hv-widget/40 rounded-lg p-4 border border-hv-line-strong/60 mb-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-slate-400 flex-shrink-0 mt-1" size={20} />
                  <div className="text-sm text-slate-300">
                    {/* AETHER_DOOR_WORKFLOWS */}
                    <strong>Custom Events:</strong> Each event button on the door card runs a workflow from the Emulation builder — every block type, columns in parallel, loops, waits and checks.
                    <div className="text-xs text-slate-400 mt-1">Workflows are saved on the Pi and shared by every door; blocks set to 'This door' act on whichever door runs the event.</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-6 gap-2 mb-6">
                {editedDoor.customEvents.map((event, index) => (
                  <button
                    key={index}
                    onClick={() => setEditingEventIndex(index)}
                    className={`px-4 py-3 rounded-lg font-semibold text-sm transition-all ${
                      editingEventIndex === index
                        ? 'bg-emerald-800/50 text-emerald-100 border border-emerald-700/40 shadow-lg'
                        : 'bg-hv-widget/60 text-slate-300 hover:bg-hv-line'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-2">
                      <Play size={14} />
                      Event {index + 1}
                    </div>
                    <div className="text-xs mt-1 opacity-70 truncate">
                      {event.workflowId ? 'Workflow' : event.steps.length > 0 ? `${event.steps.length} old steps` : 'Not set'}{/* AETHER_DOOR_WORKFLOWS */}
                    </div>
                  </button>
                ))}
              </div>

              <div className="bg-hv-widget/60 rounded-lg p-6 border-2 border-hv-line-strong">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-hv-text">Configure Event {editingEventIndex + 1}</h3>
                    <p className="text-sm text-slate-400 mt-1">Pick the workflow this event runs</p>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.customEvents[editingEventIndex].enabled}
                      onChange={() => toggleCustomEventEnabled(editingEventIndex)}
                      className="w-5 h-5 rounded accent-hv-text-3"
                    />
                    <span className="text-sm font-semibold">Enabled</span>
                  </label>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-semibold text-slate-300 mb-2">
                    Event Name
                  </label>
                  <input
                    type="text"
                    value={editedDoor.customEvents[editingEventIndex].name}
                    onChange={(e) => updateCustomEventName(editingEventIndex, e.target.value)}
                    className="w-full bg-hv-widget border border-hv-line-strong/60 rounded-lg px-4 py-2 text-hv-text font-semibold"
                    placeholder={`Custom Event ${editingEventIndex + 1}`}
                  />
                </div>

                {/* AETHER_DOOR_WORKFLOWS: the event's workflow (from the Pi's shared library) */}
                {(() => {
                  const ev = editedDoor.customEvents[editingEventIndex];
                  const known = !ev.workflowId || workflows.some(w => w.id === ev.workflowId);
                  return (
                    <div className="mb-4 space-y-2">
                      <label className="block text-sm font-semibold text-slate-300">Workflow</label>
                      <div className="flex items-center gap-2">
                        <select
                          value={ev.workflowId || ''}
                          onChange={(e) => setEventWorkflow(editingEventIndex, e.target.value)}
                          className="flex-1 min-w-0 bg-hv-widget border border-hv-line-strong/60 rounded-lg px-3 py-2 text-hv-text"
                        >
                          <option value="">{ev.steps.length > 0 ? '— None (runs the old step list below) —' : '— None —'}</option>
                          {!known && <option value={ev.workflowId}>{ev.workflowName || ev.workflowId} (not found on the Pi)</option>}
                          {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                        <button onClick={() => loadWorkflows()} disabled={wfLoading} title="Reload the workflow list from the Pi"
                          className="p-2 bg-hv-line hover:bg-hv-line-strong rounded-lg border border-hv-line-strong/60 disabled:opacity-40">
                          <RefreshCw size={16} className={wfLoading ? 'animate-spin' : ''} />
                        </button>
                      </div>
                      {wfError && <p className="text-xs" style={{ color: 'rgb(var(--hv-error-text))' }}>{wfError}</p>}
                      {!known && !wfLoading && !wfError && <p className="text-xs" style={{ color: 'rgb(var(--hv-warning-text))' }}>This workflow is not on the Pi any more — pick another or create a new one.</p>}
                      <div className="flex flex-wrap items-center gap-2">
                        <button onClick={() => openInBuilder(editingEventIndex, 'edit')} disabled={!ev.workflowId}
                          title="Save this door, then open the workflow in the Emulation builder"
                          className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong disabled:opacity-40">
                          <ExternalLink size={16} /> Edit in builder
                        </button>
                        <button onClick={() => openInBuilder(editingEventIndex, 'new')}
                          title="Save this door, then start a new workflow for this event in the Emulation builder"
                          className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong">
                          <Plus size={16} /> New workflow
                        </button>
                        {onApplyEventToAllDoors && (
                          <button
                            onClick={() => {
                              const what = ev.workflowId ? `workflow "${ev.workflowName || ev.workflowId}"` : `${ev.steps?.length || 0} old step(s)`;
                              if (!window.confirm(
                                `Copy this event (slot ${editingEventIndex + 1}, "${ev.name}", ${what}) to the SAME slot on EVERY door?\n\n` +
                                `This overwrites only event slot ${editingEventIndex + 1} on all other doors. Their other events are untouched.` +
                                (ev.workflowId ? `\n\nEvery door runs the same workflow; blocks set to 'This door' act on the door that runs it.` : '')
                              )) return;
                              // Save THIS door first so its current edits are included.
                              if (onSave(editedDoor) === false) { setSaveRefused(true); setActiveSection('mandatory'); return; }
                              onApplyEventToAllDoors(editingEventIndex, JSON.parse(JSON.stringify(ev)), editedDoor);
                            }}
                            className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong"
                            title="Use this event (its workflow link) in the same event slot on all doors"
                          >
                            <Copy size={16} />
                            Apply to All Doors
                          </button>
                        )}
                        {(ev.workflowId ? onRunWorkflow : onTestRun) && (
                          <button
                            onClick={runTestNow}
                            disabled={testRunning || (!ev.workflowId && (ev.steps?.length || 0) === 0)}
                            className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong disabled:opacity-40"
                            title={ev.workflowId ? 'Run the workflow now for this door (uses the saved door settings)' : 'Run these steps now against this door (uses the current editor steps — no save needed)'}
                          >
                            {testRunning ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                            {testRunning ? 'Running…' : 'Test Run'}
                          </button>
                        )}
                      </div>
                      {ev.steps.length > 0 && !ev.workflowId && (
                        <div className="rounded-lg px-3 py-2 border flex flex-wrap items-center gap-2 text-sm"
                          style={{ background: 'rgb(var(--hv-warning-tint))', borderColor: 'rgb(var(--hv-warning) / 0.55)', color: 'rgb(var(--hv-warning-text))' }}>
                          <Workflow size={16} className="shrink-0" />
                          <span className="flex-1 min-w-0">This event uses the old step list. Convert it to a workflow to edit it in the builder.</span>
                          <button onClick={() => convertEvent(editingEventIndex)} disabled={wfBusy || !apiBase}
                            className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong text-hv-text disabled:opacity-40">
                            {wfBusy ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />} Convert to workflow
                          </button>
                        </div>
                      )}
                      {wfMsg && <p className="text-xs text-slate-400">{wfMsg}</p>}
                    </div>
                  );
                })()}

                <div className="space-y-3">
                  {/* #feat 6: Test Run result + inline log */}
                  {(testRunning || testSummary || testLog.length > 0) && (
                    <div className="bg-hv-widget-panel/70 rounded-lg border border-hv-line-strong/60 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-slate-300 uppercase tracking-wide">Test Run</div>
                        {testSummary && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="px-2 py-0.5 rounded bg-hv-line text-slate-200 border border-hv-line-strong/60">{testSummary.ran}/{testSummary.total} ran</span>
                            <span className={`px-2 py-0.5 rounded border ${testSummary.failed > 0 ? 'bg-red-950/60 text-red-300 border-red-800' : 'bg-slate-700 text-slate-300 border-hv-line-strong/60'}`}>{testSummary.failed} failed</span>
                            <button onClick={() => { setTestLog([]); setTestSummary(null); }} className="text-slate-500 hover:text-slate-300 text-[11px] underline">clear</button>
                          </div>
                        )}
                      </div>
                      <div className="max-h-40 overflow-y-auto font-mono text-[11px] leading-relaxed text-slate-400 space-y-0.5">
                        {testLog.map((line, i) => (
                          <div key={i} className={line.startsWith('  ✗') || line.includes('FAILED') ? 'text-red-400' : line.startsWith('■') || line.startsWith('▶') ? 'text-slate-200' : ''}>{line}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {editedDoor.customEvents[editingEventIndex].steps.length > 0 && (
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-semibold text-slate-300">
                        Old step list{editedDoor.customEvents[editingEventIndex].workflowId ? ' (not used — a workflow is linked)' : ''}
                      </label>
                      {editedDoor.customEvents[editingEventIndex].workflowId ? (
                        <button
                          onClick={() => setEditedDoor(prev => withEvent(prev, editingEventIndex, { steps: [] }))}
                          className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong/60"
                        >
                          <Trash2 size={16} /> Delete old steps
                        </button>
                      ) : (
                        <button
                          onClick={() => addEventStep(editingEventIndex)}
                          className="px-3 py-1 bg-hv-line hover:bg-hv-line-strong rounded-lg text-sm font-semibold flex items-center gap-2 border border-hv-line-strong/60"
                        >
                          <Plus size={16} />
                          Add Step
                        </button>
                      )}
                    </div>
                  )}

                  {editedDoor.customEvents[editingEventIndex].steps.length === 0 || editedDoor.customEvents[editingEventIndex].workflowId ? (
                    null
                  ) : (
                    editedDoor.customEvents[editingEventIndex].steps.map((step, stepIndex) => (
                      <div key={step.id} className={`rounded-lg p-4 border transition-all ${testStepIdx === stepIndex ? 'bg-slate-700/70 border-slate-300 ring-2 ring-slate-300/60' : 'bg-hv-widget/50 border-hv-line-strong/60'}`}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="text-sm font-bold text-slate-300 flex items-center gap-2">
                            Step {stepIndex + 1}
                            {testStepIdx === stepIndex && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-900 font-bold">RUNNING</span>}
                          </div>
                          <button
                            onClick={() => removeEventStep(editingEventIndex, step.id)}
                            className="text-red-400 hover:text-red-300"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-semibold text-slate-400 mb-1">
                              Action
                            </label>
                            <select
                              value={step.action}
                              onChange={(e) => updateEventStep(editingEventIndex, step.id, 'action', e.target.value)}
                              className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                            >
                              <option value="lock"> Lock Door</option>
                              <option value="unlock"> Unlock Door</option>
                              <option value="open-dps"> Open DPS</option>
                              <option value="close-dps"> Close DPS</option>
                              <option value="activate-rex"> Activate REX</option>
                              <option value="deactivate-rex"> Deactivate REX</option>
                              <option value="toggle-io"> Toggle Custom I/O</option>
                              <option value="send-card"> Send Card Credential</option>
                              <option value="pulse"> Pulse (auto activate→release)</option>
                              <option value="wait"> Wait / Delay</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-xs font-semibold text-slate-400 mb-1">
                              Delay (ms)
                            </label>
                            <input
                              type="number"
                              value={step.delay}
                              onChange={(e) => updateEventStep(editingEventIndex, step.id, 'delay', parseInt(e.target.value) || 0)}
                              className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                              placeholder="1000"
                            />
                          </div>
                        </div>

                        {step.action === 'toggle-io' && (
                          <div className="mt-3">
                            <label className="block text-xs font-semibold text-slate-400 mb-1">
                              Select I/O
                            </label>
                            <select
                              value={step.ioId || ''}
                              onChange={(e) => updateEventStep(editingEventIndex, step.id, 'ioId', e.target.value)}
                              className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                            >
                              <option value="">-- Select I/O --</option>
                              {editedDoor.ios.map(io => (
                                <option key={io.id} value={io.id}>{io.name} ({io.hardwareType === 'opto' || io.hardwareType === 'analog' ? `${customIOLabel(io)}, input: not driven` : `Channel ${io.channel}`})</option>   /* AETHER_ANALOG_IN */
                              ))}
                            </select>
                          </div>
                        )}

                        {step.action === 'pulse' && (
                          <div className="mt-3 space-y-3 p-3 bg-hv-widget/40 rounded-lg border border-hv-line-strong/60">
                            <div className="text-xs font-bold text-slate-400 uppercase">Pulse Configuration</div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Target</label>
                                <select
                                  value={step.pulseTarget || 'lock'}
                                  onChange={(e) => updateEventStep(editingEventIndex, step.id, 'pulseTarget', e.target.value)}
                                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                >
                                  <option value="lock"> Lock (unlock→relock)</option>
                                  <option value="dps"> DPS (open→close)</option>
                                  <option value="rex"> REX (activate→release)</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Hold (ms)</label>
                                <input
                                  type="number"
                                  value={step.pulseDuration ?? 1000}
                                  onChange={(e) => updateEventStep(editingEventIndex, step.id, 'pulseDuration', parseInt(e.target.value) || 0)}
                                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                  placeholder="1000"
                                />
                              </div>
                            </div>
                            <p className="text-[11px] text-slate-500">One step that activates the target, holds for the duration, then auto-releases — replaces the old activate + wait + deactivate trio.</p>
                          </div>
                        )}

                        {step.action === 'wait' && (
                          <div className="mt-3 space-y-3 p-3 bg-hv-widget/40 rounded-lg border border-hv-line-strong/60">
                            <div className="text-xs font-bold text-slate-400 uppercase">Wait Configuration</div>
                            <div>
                              <label className="block text-xs font-semibold text-slate-400 mb-1">Wait Type</label>
                              <select
                                value={step.waitType || 'seconds'}
                                onChange={(e) => updateEventStep(editingEventIndex, step.id, 'waitType', e.target.value)}
                                className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                              >
                                <option value="seconds">Seconds</option>
                                <option value="minutes">Minutes</option>
                                <option value="random">Random range (seconds)</option>
                              </select>
                            </div>
                            {step.waitType === 'random' ? (
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs font-semibold text-slate-400 mb-1">Min (sec)</label>
                                  <input
                                    type="number"
                                    value={step.waitMin ?? 1}
                                    onChange={(e) => updateEventStep(editingEventIndex, step.id, 'waitMin', parseInt(e.target.value) || 0)}
                                    className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-slate-400 mb-1">Max (sec)</label>
                                  <input
                                    type="number"
                                    value={step.waitMax ?? 5}
                                    onChange={(e) => updateEventStep(editingEventIndex, step.id, 'waitMax', parseInt(e.target.value) || 0)}
                                    className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                  />
                                </div>
                              </div>
                            ) : (
                              <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Duration ({step.waitType === 'minutes' ? 'minutes' : 'seconds'})</label>
                                <input
                                  type="number"
                                  value={step.waitValue ?? (step.waitType === 'minutes' ? 1 : 5)}
                                  onChange={(e) => updateEventStep(editingEventIndex, step.id, 'waitValue', parseInt(e.target.value) || 0)}
                                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                />
                              </div>
                            )}
                            <p className="text-[11px] text-slate-500">A dedicated pause between steps — no action, just waits. The per-step "Delay (ms)" above still applies before this runs.</p>
                          </div>
                        )}

                        {step.action === 'send-card' && (
                          <div className="mt-3 space-y-3 p-3 bg-hv-widget/40 rounded-lg border border-hv-line-strong/60">
                            <div className="text-xs font-bold text-slate-400 uppercase">Card Credential Configuration</div>

                            <div>
                              <label className="block text-xs font-semibold text-slate-400 mb-1">
                                Select Reader
                              </label>
                              <select
                                value={step.readerId || ''}
                                onChange={(e) => updateEventStep(editingEventIndex, step.id, 'readerId', e.target.value)}
                                className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                              >
                                <option value="">
                                  {editedDoor.reader ? '— Use this door\'s assigned reader —' : '-- Select Reader --'}
                                </option>
                                {/* #3: the door's own assigned reader, surfaced explicitly */}
                                {editedDoor.reader && (
                                  <optgroup label="This Door">
                                    <option value={editedDoor.reader}>
                                      {(() => {
                                        const rid = editedDoor.reader!;
                                        if (rid.startsWith('ctrl-emu-')) {
                                          const m = rid.match(/^ctrl-emu-(\d+)-(\d+)$/);
                                          if (m) return `Assigned: Emulated #${m[1]} — Reader ${m[2]}`;
                                        }
                                        const rr = readers.find(x => x.id === rid);
                                        return `Assigned: ${rr ? readerOptionLabel(rr) : rid}`;
                                      })()}
                                    </option>
                                  </optgroup>
                                )}
                                {/* AETHER_READER_DIR: ALL readers by type (disabled ones labeled, still selectable) */}
                                {(['wiegand', 'osdp'] as const).map(t => {
                                  const list = readers.filter(r => r.type === t);
                                  return list.length > 0 && (
                                    <optgroup key={t} label={t === 'wiegand' ? 'Wiegand readers' : 'OSDP readers'}>
                                      {list.map(reader => (
                                        <option key={reader.id} value={reader.id}>
                                          {reader.name} ({reader.type.toUpperCase()}){reader.enabled === false ? ' — disabled' : ''}
                                        </option>
                                      ))}
                                    </optgroup>
                                  );
                                })}
                                {/* AETHER_READER_DIR: an older saved step reader that is no longer listed (resolved when the step runs) */}
                                {step.readerId && step.readerId !== editedDoor.reader && !step.readerId.startsWith('ctrl-emu-') && !readers.some(r => r.id === step.readerId) && (
                                  <option value={step.readerId}>Saved: {step.readerId}</option>
                                )}
                                {/* #3: emulated controller on-board readers */}
                                {emuBoard && (
                                  <optgroup label={`Emulated Controller #${emuBoard.address} ${emuBoard.model}`}>
                                    {Array.from({ length: Math.max(1, emuBoard.numReaders ?? 1) }, (_, port) => (
                                      <option key={`ctrl-emu-${emuBoard.address}-${port}`} value={`ctrl-emu-${emuBoard.address}-${port}`}>
                                        #{emuBoard.address} {emuBoard.model} — Reader {port}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                              </select>
                              <p className="text-[10px] text-slate-500 mt-1">
                                Leave unset to use the door's assigned reader at run time.
                              </p>
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-slate-400 mb-1">
                                Card Format
                              </label>
                              <select
                                value={step.cardFormat || '26'}
                                onChange={(e) => updateEventStep(editingEventIndex, step.id, 'cardFormat', e.target.value)}
                                className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                              >
                                <option value="26">26-bit (Standard)</option>
                                <option value="34">34-bit (Corporate)</option>
                                <option value="35">35-bit</option>
                                <option value="37">37-bit (HID H10304)</option>
                                <option value="48">48-bit (HID Mobile)</option>
                              </select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">
                                  Facility Code
                                </label>
                                <input
                                  type="text"
                                  value={step.facilityCode || ''}
                                  onChange={(e) => updateEventStep(editingEventIndex, step.id, 'facilityCode', e.target.value)}
                                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                  placeholder="123"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">
                                  Card Number
                                </label>
                                <input
                                  type="text"
                                  value={step.cardNumber || ''}
                                  onChange={(e) => updateEventStep(editingEventIndex, step.id, 'cardNumber', e.target.value)}
                                  className="w-full bg-hv-widget border border-hv-line-strong/60 rounded px-3 py-2 text-sm text-hv-text"
                                  placeholder="12345"
                                />
                              </div>
                            </div>

                            <div className="text-xs text-slate-500 mt-2">
                              Tip: This will present the configured card credential to the selected reader as if someone swiped their badge
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-hv-widget/60 p-6 border-t border-hv-line-strong flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-6 py-3 bg-hv-line hover:bg-hv-line-strong rounded-lg font-semibold transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-6 py-3 bg-hv-line hover:bg-hv-line-strong border border-hv-line-strong rounded-lg font-semibold transition-colors flex items-center justify-center gap-2"
          >
            <Save size={20} />
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
};

export default DoorSettings;
