import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, Plus, Trash2, Play, RefreshCw, Copy } from 'lucide-react';

type InputType =
  | 'None' | 'REX-Button' | 'Entry Sensor' | 'Lock Sensor'
  | 'Safety Beam' | 'DPS' | 'AUX' | 'General';

type OutputType =
  | 'None' | 'Strike Follower' | 'Lock'
  | 'Auto Door' | 'Sounder' | 'Strobe' | 'FAI' | 'General';

type DoorEdgeIO = {
  channel: number;
  active: boolean;
  reverseSense?: boolean;
  inputType?: 'opto' | 'analog';
};

type DoorIO = {
  id: string;
  name: string;
  type: InputType | OutputType;
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
  steps: CustomEventStep[];
};

type Door = {
  id: number;
  name: string;
  enabled: boolean;
  lock: DoorEdgeIO & { name: string };
  dps: DoorEdgeIO & { name: string };
  rexIn: DoorEdgeIO & { name: string };
  ios: DoorIO[];
  reader: string | null;   // #3: single reader per door
  customEvents?: CustomEvent[];
};

type Reader = {
  id: string;
  name: string;
  type: 'wiegand' | 'osdp';
  enabled: boolean;
};

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
  onSave: (updatedDoor: Door) => void;
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
  onApplyEventToAllDoors?: (eventIndex: number, event: CustomEventStep extends never ? never : any) => void;
}

const DoorSettings: React.FC<DoorSettingsProps> = ({ door, readers, emuBoard, onClose, onSave, onTestRun, onApplyEventToAllDoors }) => {
  const [editedDoor, setEditedDoor] = useState<Door>(JSON.parse(JSON.stringify(door)));
  // #feat 1/5/6: inline Test Run state
  const [testRunning, setTestRunning] = useState(false);
  const [testStepIdx, setTestStepIdx] = useState<number>(-1);          // 5: which step is executing
  const [testSummary, setTestSummary] = useState<{ ran: number; failed: number; total: number } | null>(null); // 6
  const [testLog, setTestLog] = useState<string[]>([]);

  const runTestNow = async () => {
    if (!onTestRun || testRunning) return;
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

  const handleSave = () => {
    onSave(editedDoor);
    onClose();
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
      <div className="bg-[#1F1719] rounded-xl max-w-6xl w-full max-h-[90vh] overflow-hidden border-2 border-[#4A3538] shadow-2xl">
        {/* Header */}
        <div className="bg-[#2A1F22]/60 p-6 border-b border-[#4A3538]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                <span className="text-3xl">⚙️</span>
                Door Settings
              </h2>
              <p className="text-sm text-slate-400 mt-1">
                Configure {door.name} properties, I/O settings, reverse sense, and custom event sequences
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <X size={28} />
            </button>
          </div>
        </div>

        {/* Section Tabs */}
        <div className="flex gap-2 p-4 bg-[#231A1D]/60 border-b border-[#4A3538]">
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
                  : 'bg-[#2A1F22]/60 text-slate-400 hover:bg-[#3D2F33] hover:text-slate-200'
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
              <div className="bg-[#231A1D]/60 rounded-lg p-6 border border-[#4A3538]">
                <label className="block text-sm font-semibold text-slate-300 mb-2">
                  Door Name
                </label>
                <input
                  type="text"
                  value={editedDoor.name}
                  onChange={(e) => updateDoorName(e.target.value)}
                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-4 py-3 text-white text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-[#7a5560]"
                  placeholder="Enter door name"
                />
                <p className="text-xs text-slate-500 mt-2">
                  This name will be displayed throughout the interface
                </p>
              </div>

              {/* #3: single reader assignment (the reader used by this door) */}
              <div className="bg-[#231A1D]/60 rounded-lg p-6 border border-[#4A3538]">
                <label className="block text-sm font-semibold text-slate-300 mb-2">
                  Reader
                </label>
                <select
                  value={editedDoor.reader || ''}
                  onChange={(e) => setEditedDoor({ ...editedDoor, reader: e.target.value || null })}
                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-[#7a5560]"
                >
                  <option value="">-- No Reader --</option>
                  <optgroup label="Physical / Wiegand">
                    {readers.filter(r => r.enabled).map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name} {(r as any).type === 'wiegand' ? `(D0:${(r as any).d0}, D1:${(r as any).d1})` : `(OSDP ${(r as any).address ?? ''})`}
                      </option>
                    ))}
                  </optgroup>
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

              <div className="bg-[#2A1F22]/40 rounded-lg p-4 border border-[#5C4449]/60">
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
              <div className="bg-[#2A1F22]/40 rounded-lg p-4 border border-[#5C4449]/60">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-slate-400 flex-shrink-0 mt-1" size={20} />
                  <div className="text-sm text-slate-300">
                    {emuBoard ? (
                      <><strong>Emulated board #{emuBoard.address} ({emuBoard.model}):</strong> Lock = OUTPUT 0-{Math.max(0, emuBoard.numOutputs - 1)}, DPS/REX = INPUT 0-{Math.max(0, emuBoard.numInputs - 1)}. Channels below are limited to this board's real I/O count.</>
                    ) : (
                      <><strong>Sequent IOplus Channels:</strong> Configure which Sequent IOplus channels (0-7) control this door. Outputs use relays 0-7, Inputs use digital/analog inputs 0-7. Select input type (Opto-Isolated or Analog 0-10V) for each input.</>
                    )}
                  </div>
                </div>
              </div>

              {/* Lock */}
              <div className="bg-[#231A1D]/60 rounded-lg p-5 border border-[#4A3538]">
                <h3 className="text-lg font-bold text-slate-300 mb-4 flex items-center gap-2">
                  <span></span> Door Lock
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Name
                    </label>
                    <input
                      type="text"
                      value={editedDoor.lock.name}
                      onChange={(e) => updateMandatoryIO('lock', 'name', e.target.value)}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Sequent Relay Channel (0-7)
                    </label>
                    <select
                      value={editedDoor.lock.channel}
                      onChange={(e) => updateMandatoryIO('lock', 'channel', parseInt(e.target.value))}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    >
                      {emuBoard
                        ? Array.from({ length: emuBoard.numOutputs }, (_, ch) => (
                            <option key={ch} value={ch}>OUTPUT {ch} (#{emuBoard.address})</option>
                          ))
                        : [0,1,2,3,4,5,6,7].map(ch => (
                            <option key={ch} value={ch}>Relay {ch}</option>
                          ))}
                    </select>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.lock.reverseSense || false}
                      onChange={(e) => updateMandatoryIO('lock', 'reverseSense', e.target.checked)}
                      className="w-5 h-5 rounded bg-[#3D2F33] border-[#5C4449]/60 accent-[#7a5560]"
                    />
                    <div>
                      <span className="text-sm font-semibold text-white">Reverse Sense (Active at Rest)</span>
                      <p className="text-xs text-slate-400">
                        {editedDoor.lock.reverseSense
                          ? ' GPIO HIGH = Locked (Active at Rest)'
                          : 'GPIO HIGH = Unlocked (Inactive at Rest)'}
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* DPS */}
              <div className="bg-[#231A1D]/60 rounded-lg p-5 border border-[#4A3538]">
                <h3 className="text-lg font-bold text-slate-300 mb-4 flex items-center gap-2">
                  <span></span> Door Position Switch (INPUT)
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Name
                    </label>
                    <input
                      type="text"
                      value={editedDoor.dps.name}
                      onChange={(e) => updateMandatoryIO('dps', 'name', e.target.value)}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Sequent Input Channel (0-7)
                    </label>
                    <select
                      value={editedDoor.dps.channel}
                      onChange={(e) => updateMandatoryIO('dps', 'channel', parseInt(e.target.value))}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    >
                      {emuBoard
                        ? Array.from({ length: emuBoard.numInputs }, (_, ch) => (
                            <option key={ch} value={ch}>INPUT {ch} (#{emuBoard.address})</option>
                          ))
                        : [0,1,2,3,4,5,6,7].map(ch => (
                            <option key={ch} value={ch}>Input {ch}</option>
                          ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Input Type
                    </label>
                    <select
                      value={(editedDoor.dps as any).inputType || 'opto'}
                      onChange={(e) => {
                        setEditedDoor({
                          ...editedDoor,
                          dps: { ...editedDoor.dps, inputType: e.target.value as 'opto' | 'analog' } as any
                        });
                      }}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    >
                      <option value="opto">Opto-Isolated (Digital)</option>
                      <option value="analog">Analog (0-10V)</option>
                    </select>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.dps.reverseSense || false}
                      onChange={(e) => updateMandatoryIO('dps', 'reverseSense', e.target.checked)}
                      className="w-5 h-5 rounded bg-[#3D2F33] border-[#5C4449]/60 accent-[#7a5560]"
                    />
                    <div>
                      <span className="text-sm font-semibold text-white">Reverse Sense (Active at Rest)</span>
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
              <div className="bg-[#231A1D]/60 rounded-lg p-5 border border-[#4A3538]">
                <h3 className="text-lg font-bold text-slate-300 mb-4 flex items-center gap-2">
                  <span></span> Request to Exit (INPUT)
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Name
                    </label>
                    <input
                      type="text"
                      value={editedDoor.rexIn.name}
                      onChange={(e) => updateMandatoryIO('rexIn', 'name', e.target.value)}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Sequent Input Channel (0-7)
                    </label>
                    <select
                      value={editedDoor.rexIn.channel}
                      onChange={(e) => updateMandatoryIO('rexIn', 'channel', parseInt(e.target.value))}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    >
                      {emuBoard
                        ? Array.from({ length: emuBoard.numInputs }, (_, ch) => (
                            <option key={ch} value={ch}>INPUT {ch} (#{emuBoard.address})</option>
                          ))
                        : [0,1,2,3,4,5,6,7].map(ch => (
                            <option key={ch} value={ch}>Input {ch}</option>
                          ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-300 mb-2">
                      Input Type
                    </label>
                    <select
                      value={(editedDoor.rexIn as any).inputType || 'opto'}
                      onChange={(e) => {
                        setEditedDoor({
                          ...editedDoor,
                          rexIn: { ...editedDoor.rexIn, inputType: e.target.value as 'opto' | 'analog' } as any
                        });
                      }}
                      className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                    >
                      <option value="opto">Opto-Isolated (Digital)</option>
                      <option value="analog">Analog (0-10V)</option>
                    </select>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.rexIn.reverseSense || false}
                      onChange={(e) => updateMandatoryIO('rexIn', 'reverseSense', e.target.checked)}
                      className="w-5 h-5 rounded bg-[#3D2F33] border-[#5C4449]/60 accent-[#7a5560]"
                    />
                    <div>
                      <span className="text-sm font-semibold text-white">Reverse Sense (Active at Rest)</span>
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
                  className="px-3 py-1.5 bg-[#3D2F33] hover:bg-[#4A3538] rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-30 border border-[#5C4449]/60"
                >
                  <Plus size={16} /> Add I/O
                </button>
              </div>
              {editedDoor.ios.length === 0 ? (
                <div className="text-center py-12 bg-[#231A1D]/40 rounded-lg border border-dashed border-[#4A3538]">
                  <p className="text-slate-500 mb-2">No custom I/O configured</p>
                  <p className="text-xs text-slate-600">Click "Add I/O" above to add inputs or outputs</p>
                </div>
              ) : (
                editedDoor.ios.map((io) => (
                  <div key={io.id} className="bg-[#231A1D]/60 rounded-lg p-5 border border-[#4A3538]">
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
                          className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          Channel
                        </label>
                        <input
                          type="number"
                          value={io.channel}
                          onChange={(e) => updateCustomIO(io.id, 'channel', parseInt(e.target.value) || 0)}
                          className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <label className="block text-sm font-semibold text-slate-300 mb-2">
                          I/O Type
                        </label>
                        <select
                          value={io.type}
                          onChange={(e) => updateCustomIO(io.id, 'type', e.target.value)}
                          className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white"
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
                        <button
                          onClick={() => toggleIODirection(io.id)}
                          className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-3 py-2 text-white hover:bg-slate-700 transition-colors font-semibold"
                        >
                          {io.direction === 'input' ? '📥 INPUT' : '📤 OUTPUT'}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={io.reverseSense || false}
                          onChange={(e) => updateCustomIO(io.id, 'reverseSense', e.target.checked)}
                          className="w-5 h-5 rounded bg-[#3D2F33] border-[#5C4449]/60 accent-[#7a5560]"
                        />
                        <div>
                          <span className="text-sm font-semibold text-white">Reverse Sense (Active at Rest)</span>
                          <p className="text-xs text-slate-400">
                            {io.reverseSense
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
              <div className="bg-[#2A1F22]/40 rounded-lg p-4 border border-[#5C4449]/60 mb-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-slate-400 flex-shrink-0 mt-1" size={20} />
                  <div className="text-sm text-slate-300">
                    <strong>Custom Events:</strong> Create automated sequences that execute when you click the event buttons on the door screen. Each event can perform multiple actions with configurable delays.
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
                        : 'bg-[#2A1F22]/60 text-slate-300 hover:bg-[#3D2F33]'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-2">
                      <Play size={14} />
                      Event {index + 1}
                    </div>
                    <div className="text-xs mt-1 opacity-70">
                      {event.steps.length} steps
                    </div>
                  </button>
                ))}
              </div>

              <div className="bg-[#231A1D]/60 rounded-lg p-6 border-2 border-[#4A3538]">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-white">Configure Event {editingEventIndex + 1}</h3>
                    <p className="text-sm text-slate-400 mt-1">Build a sequence of actions for this event</p>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editedDoor.customEvents[editingEventIndex].enabled}
                      onChange={() => toggleCustomEventEnabled(editingEventIndex)}
                      className="w-5 h-5 rounded accent-[#7a5560]"
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
                    className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded-lg px-4 py-2 text-white font-semibold"
                    placeholder={`Custom Event ${editingEventIndex + 1}`}
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-semibold text-slate-300">
                      Action Steps
                    </label>
                    <div className="flex items-center gap-2">
                      {onApplyEventToAllDoors && (
                        <button
                          onClick={() => {
                            const ev = editedDoor.customEvents?.[editingEventIndex];
                            if (!ev) return;
                            const stepCount = ev.steps?.length || 0;
                            if (!window.confirm(
                              `Copy this event (slot ${editingEventIndex + 1}, "${ev.name}", ${stepCount} step(s)) to the SAME slot on EVERY door?\n\n` +
                              `This overwrites only event slot ${editingEventIndex + 1} on all other doors. Their other events are untouched.`
                            )) return;
                            // Save THIS door first so its current edits are included.
                            onSave(editedDoor);
                            onApplyEventToAllDoors(editingEventIndex, JSON.parse(JSON.stringify(ev)));
                          }}
                          className="px-3 py-1 bg-[#3D2F33] hover:bg-[#4A3538] rounded-lg text-sm font-semibold flex items-center gap-2 border border-[#5C4449]"
                          title="Copy this event sequence to the same event slot on all doors"
                        >
                          <Copy size={16} />
                          Apply to All Doors
                        </button>
                      )}
                      {onTestRun && (
                        <button
                          onClick={runTestNow}
                          disabled={testRunning || (editedDoor.customEvents?.[editingEventIndex]?.steps?.length || 0) === 0}
                          className="px-3 py-1 bg-[#3D2F33] hover:bg-[#4A3538] rounded-lg text-sm font-semibold flex items-center gap-2 border border-[#5C4449] disabled:opacity-40"
                          title="Run these steps now against this door (uses the current editor steps — no save needed)"
                        >
                          {testRunning ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                          {testRunning ? 'Running…' : 'Test Run'}
                        </button>
                      )}
                      <button
                        onClick={() => addEventStep(editingEventIndex)}
                        className="px-3 py-1 bg-[#3D2F33] hover:bg-[#4A3538] rounded-lg text-sm font-semibold flex items-center gap-2 border border-[#5C4449]/60"
                      >
                        <Plus size={16} />
                        Add Step
                      </button>
                    </div>
                  </div>

                  {/* #feat 6: Test Run result + inline log */}
                  {(testRunning || testSummary || testLog.length > 0) && (
                    <div className="bg-[#1C1416]/70 rounded-lg border border-[#5C4449]/60 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-slate-300 uppercase tracking-wide">Test Run</div>
                        {testSummary && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="px-2 py-0.5 rounded bg-[#3D2F33] text-slate-200 border border-[#5C4449]/60">{testSummary.ran}/{testSummary.total} ran</span>
                            <span className={`px-2 py-0.5 rounded border ${testSummary.failed > 0 ? 'bg-red-950/60 text-red-300 border-red-800' : 'bg-slate-700 text-slate-300 border-[#5C4449]/60'}`}>{testSummary.failed} failed</span>
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

                  {editedDoor.customEvents[editingEventIndex].steps.length === 0 ? (
                    <div className="text-center py-8 bg-[#2A1F22]/30 rounded-lg border border-dashed border-[#4A3538]">
                      <p className="text-slate-500 mb-2">No steps configured</p>
                      <p className="text-xs text-slate-600">Click "Add Step" to create an action sequence</p>
                    </div>
                  ) : (
                    editedDoor.customEvents[editingEventIndex].steps.map((step, stepIndex) => (
                      <div key={step.id} className={`rounded-lg p-4 border transition-all ${testStepIdx === stepIndex ? 'bg-slate-700/70 border-slate-300 ring-2 ring-slate-300/60' : 'bg-[#2A1F22]/50 border-[#5C4449]/60'}`}>
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
                              className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                              className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                              className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
                            >
                              <option value="">-- Select I/O --</option>
                              {editedDoor.ios.map(io => (
                                <option key={io.id} value={io.id}>{io.name} (Channel {io.channel})</option>
                              ))}
                            </select>
                          </div>
                        )}

                        {step.action === 'pulse' && (
                          <div className="mt-3 space-y-3 p-3 bg-[#2A1F22]/40 rounded-lg border border-[#5C4449]/60">
                            <div className="text-xs font-bold text-slate-400 uppercase">Pulse Configuration</div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Target</label>
                                <select
                                  value={step.pulseTarget || 'lock'}
                                  onChange={(e) => updateEventStep(editingEventIndex, step.id, 'pulseTarget', e.target.value)}
                                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
                                  placeholder="1000"
                                />
                              </div>
                            </div>
                            <p className="text-[11px] text-slate-500">One step that activates the target, holds for the duration, then auto-releases — replaces the old activate + wait + deactivate trio.</p>
                          </div>
                        )}

                        {step.action === 'wait' && (
                          <div className="mt-3 space-y-3 p-3 bg-[#2A1F22]/40 rounded-lg border border-[#5C4449]/60">
                            <div className="text-xs font-bold text-slate-400 uppercase">Wait Configuration</div>
                            <div>
                              <label className="block text-xs font-semibold text-slate-400 mb-1">Wait Type</label>
                              <select
                                value={step.waitType || 'seconds'}
                                onChange={(e) => updateEventStep(editingEventIndex, step.id, 'waitType', e.target.value)}
                                className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                                    className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-semibold text-slate-400 mb-1">Max (sec)</label>
                                  <input
                                    type="number"
                                    value={step.waitMax ?? 5}
                                    onChange={(e) => updateEventStep(editingEventIndex, step.id, 'waitMax', parseInt(e.target.value) || 0)}
                                    className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
                                />
                              </div>
                            )}
                            <p className="text-[11px] text-slate-500">A dedicated pause between steps — no action, just waits. The per-step "Delay (ms)" above still applies before this runs.</p>
                          </div>
                        )}

                        {step.action === 'send-card' && (
                          <div className="mt-3 space-y-3 p-3 bg-[#2A1F22]/40 rounded-lg border border-[#5C4449]/60">
                            <div className="text-xs font-bold text-slate-400 uppercase">Card Credential Configuration</div>

                            <div>
                              <label className="block text-xs font-semibold text-slate-400 mb-1">
                                Select Reader
                              </label>
                              <select
                                value={step.readerId || ''}
                                onChange={(e) => updateEventStep(editingEventIndex, step.id, 'readerId', e.target.value)}
                                className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                                        return `Assigned: ${rr ? rr.name : rid}`;
                                      })()}
                                    </option>
                                  </optgroup>
                                )}
                                {/* #3: ALL Wiegand/pool readers (not just enabled — disabled are labeled) */}
                                <optgroup label="Physical / Wiegand Readers">
                                  {readers.map(reader => (
                                    <option key={reader.id} value={reader.id}>
                                      {reader.name} ({(reader as any).type ? (reader as any).type.toUpperCase() : 'READER'}){reader.enabled === false ? ' — disabled' : ''}
                                    </option>
                                  ))}
                                </optgroup>
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
                                className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
                                  className="w-full bg-[#231A1D] border border-[#5C4449]/60 rounded px-3 py-2 text-sm text-white"
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
        <div className="bg-[#231A1D]/60 p-6 border-t border-[#4A3538] flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-6 py-3 bg-[#3D2F33] hover:bg-[#4A3538] rounded-lg font-semibold transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-6 py-3 bg-[#3D2F33] hover:bg-[#4A3538] border border-[#5C4449] rounded-lg font-semibold transition-colors flex items-center justify-center gap-2"
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
