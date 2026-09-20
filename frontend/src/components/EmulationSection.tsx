// EmulationWorkflow.tsx - V2
// Enhanced Drag & Drop Workflow Builder with Advanced Features
// Horizontal = Sequential, Vertical = Simultaneous

import React, { useState, useEffect, useRef, useCallback, DragEvent } from 'react';
import {
  Zap, CreditCard, Clock, AlertCircle, RotateCw, Play, DoorOpen, Database,
  Plus, Trash2, Pause, GitBranch, StopCircle, Activity, ChevronDown, Settings,
  ScrollText, Save, FolderOpen, Download, Upload, RefreshCw, Loader2, GripVertical, Pencil,
  ArrowRight, Shuffle, Radio, ChevronRight, X, Copy, Layers, Move, Eye,
  MessageSquare, Repeat, Shield, Target, Timer, Hash, FileText, AlertTriangle,
  CheckCircle, XCircle, HelpCircle, Cpu, Binary, BarChart3, CalendarClock
} from 'lucide-react';

// ========== TYPE DEFINITIONS ==========
interface CardFormat {
  id: string;
  name: string;
  bits: number;
  facilityBits: number;
  cardBits: number;
  maxFacility: number;
  maxCard: number;
  description?: string;
  category?: string;
}

type InputType = 'None' | 'REX-Button' | 'Entry Sensor' | 'Lock Sensor' | 'Safety Beam' | 'DPS' | 'AUX' | 'General';
type OutputType = 'None' | 'Strike Follower' | 'Lock' | 'Auto Door' | 'Sounder' | 'Strobe' | 'FAI' | 'General';

type InputItem = { id: number; name: string; type: InputType; gpio: number; active: boolean };
type OutputItem = { id: number; name: string; type: OutputType; gpio: number; active: boolean };

type DoorEdgeIO = { gpio: number; active: boolean };

type Door = {
  id: number;
  name: string;
  enabled: boolean;
  lock: DoorEdgeIO & { name: string };
  dps: DoorEdgeIO & { name: string };
  rexIn: DoorEdgeIO & { name: string };
};

type Reader = {
  id: string;
  name: string;
  type: 'wiegand' | 'osdp' | 'controller-emulator' | 'none';
  enabled: boolean;
  d0?: number;
  d1?: number;
  address?: number;
  port?: number;
  model?: string;
  assignedToDoor: number | null;
  position: 'in' | 'out' | null;
  door?: number;
  pins?: { d0: number; d1: number; tx?: number; rx?: number };
};

type BlockType = 
  | 'reader' 
  | 'door' 
  | 'io' 
  | 'wait' 
  | 'control'
  | 'waitInput'
  | 'log'
  | 'supervision'
  | 'scenario'
  | 'schedule';

type KeypadFormat = '4bit' | '8bit' | '8bit-wiegand' | '26bit' | 'wiegand26';

type CardSequenceMode = 
  | 'sequential'
  | 'random'
  | 'increment_fc'
  | 'increment_cn'
  | 'increment_both'
  | 'invalid'
  | 'replay';

type SupervisionState = 'normal' | 'short' | 'open' | 'trouble';

type ScenarioType = 
  | 'valid_access'
  | 'denied_access'
  | 'forced_door'
  | 'held_door'
  | 'rex_egress'
  | 'anti_passback'
  | 'tailgating'
  | 'interlock';

interface WorkflowBlock {
  id: string;
  type: BlockType;
  readerId?: string;
  format?: string;
  mode?: 'single' | 'range';
  // ── PIN entry (new) ────────────────────────────────────────────────────
  // When readType === 'pin', the block sends a PIN instead of a card credential.
  // For Wiegand: each key encoded per keypadFormat. For OSDP: /api/osdp/keypad.
  readType?: 'card' | 'pin';          // default: 'card'
  pinValue?: string;                   // PIN to send (max 10 digits / *#)
  keypadFormat?: KeypadFormat;         // wire encoding for PIN
  // ── Standard card fields ──────────────────────────────────────────────
  facilityCode?: number;
  cardNumber?: number;
  facilityStart?: number;
  facilityEnd?: number;
  cardStart?: number;
  cardEnd?: number;
  sequenceMode?: CardSequenceMode;
  cardCount?: number;
  delayBetweenCards?: number;
  doorId?: number;
  eventType?: 'lock' | 'dps' | 'rexIn';
  ioType?: 'input' | 'output' | 'controller';
  ioId?: number;
  action?: 'activate' | 'deactivate' | 'pulse';
  pulseDuration?: number;
  // ── Wait block ─────────────────────────────────────────────────────────
  // 'until_time' waits for the wall-clock time to reach waitUntilTime (HH:MM).
  // If waitUntilDate is set (YYYY-MM-DD), waits for that exact date+time.
  // If only time set, waits for the next occurrence (today if not yet passed,
  // otherwise tomorrow).
  waitType?: 'seconds' | 'minutes' | 'random' | 'until_time';
  waitValue?: number;
  waitMin?: number;
  waitMax?: number;
  waitUntilTime?: string;              // 'HH:MM' (24-hour)
  waitUntilDate?: string;              // optional 'YYYY-MM-DD'
  controlType?: 'stop' | 'loop';
  loopToColumn?: number;
  waitInputId?: number;
  waitInputType?: 'input' | 'door_dps' | 'door_rex' | 'controller_input' | 'controller_output';
  waitInputDoorId?: number;
  waitInputState?: 'high' | 'low' | 'any_change';
  waitInputTimeout?: number;
  waitInputTimeoutAction?: 'continue' | 'stop' | 'skip';
  logMessage?: string;
  logLevel?: 'info' | 'success' | 'warning' | 'error' | 'marker';
  assertCondition?: boolean;
  assertInputId?: number;
  assertInputState?: 'high' | 'low';
  supervisionInputId?: number;
  supervisionState?: SupervisionState;
  supervisionDuration?: number;
  // ── Schedule block (new) ───────────────────────────────────────────────
  // Same semantics as wait 'until_time' but as its own block type so users
  // can place it at the start of a workflow to "schedule" it.
  scheduleTime?: string;               // 'HH:MM'
  scheduleDate?: string;               // optional 'YYYY-MM-DD'
  scenarioType?: ScenarioType;
  // Common to all scenarios
  scenarioReaderId?: string;
  scenarioFacilityCode?: number;      // valid card FC
  scenarioCardNumber?: number;        // valid card CN

  // ── I/O direction note ──────────────────────────────────────────────────
  // This device SIMULATES door peripheral hardware:
  //   RELAY OUTPUTS (0-7) = driven BY the Pi TO the panel
  //     e.g. DPS contact closure, REX button press, door bell
  //   OPTO INPUTS  (0-7) = read BY the Pi FROM the panel
  //     e.g. panel's lock/strike relay output, panel's alarm output
  // ────────────────────────────────────────────────────────────────────────

  // I/O source: 'physical' = Pi GPIO opto/relay loopback rig wired to a real
  // panel; 'emulated' = drive/monitor an emulated controller board via the
  // emulator API (the same boards the rest of the page uses).
  scenarioIoSource?: 'physical' | 'emulated';
  scenarioEmuBoard?: number;          // emulated board address (when source = emulated)
  scenarioLockInput?: number;         // physical OPTO INPUT / emulated OUTPUT index — reads panel lock
  scenarioDpsRelay?: number;          // physical RELAY OUTPUT / emulated INPUT index — drives DPS
  scenarioRexRelay?: number;          // physical RELAY OUTPUT / emulated INPUT index — drives REX
  scenarioAlarmInput?: number;        // physical OPTO INPUT / emulated OUTPUT index — reads alarm
  scenarioLock2Input?: number;        // physical OPTO INPUT / emulated OUTPUT index — Door 2 lock
  scenarioVerifyTimeoutMs?: number;   // ms to wait for panel to respond
  // Scenario-specific
  scenarioDoorId?: number;
  scenarioHeldTime?: number;
  scenarioBadFacilityCode?: number;
  scenarioBadCardNumber?: number;
  scenarioCard2FacilityCode?: number;
  scenarioCard2Number?: number;
  scenarioTailgateDelay?: number;
  scenarioApbDelay?: number;                 // ms between APB presentations (def 3000)
  scenarioCredentials?: { fc: number; cn: number }[];  // up to 5, tailgating
  scenarioReader2Id?: string;
  scenarioDoor2Board?: number;           // emulated board addr for Door 2 (0/undef = same as Door 1)
  scenarioInterlockSettleMs?: number;    // pause after Door 1 unlocks before attempting Door 2
  scenarioInterlockTimeoutMs?: number;   // per-attempt wait for Door 2 grant/deny
}

interface WorkflowColumn {
  id: string;
  blocks: WorkflowBlock[];
}

interface EmulationLogEntry {
  timestamp: string;
  column: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning' | 'marker';
}

interface EmulationWorkflowProps {
  ipAddress: string;
  connected: boolean;
  inputs: InputItem[];
  outputs: OutputItem[];
  controllerOutputs: OutputItem[];
  controllerInputs: InputItem[];
  doors: Door[];
  readerPool?: Reader[];
  isEmulating: boolean;
  setIsEmulating: (val: boolean) => void;
  logEmulation: (message: string) => void;
  logSystem: (type: string, message: string) => void;
}

const DEFAULT_FORMATS: CardFormat[] = [
  { id: '26', name: 'Standard 26-bit', bits: 26, facilityBits: 8, cardBits: 16, maxFacility: 255, maxCard: 65535, category: 'wiegand' },
  { id: '34', name: 'Wiegand 34-bit', bits: 34, facilityBits: 16, cardBits: 16, maxFacility: 65535, maxCard: 65535, category: 'wiegand' },
  { id: '35', name: 'HID Corporate 1000', bits: 35, facilityBits: 12, cardBits: 20, maxFacility: 4095, maxCard: 1048575, category: 'hid' },
  { id: '37', name: 'HID H10302 37-bit', bits: 37, facilityBits: 16, cardBits: 19, maxFacility: 65535, maxCard: 524287, category: 'hid' },
];

const BLOCK_CONFIG: Record<BlockType, { icon: React.ReactNode; color: string; bgColor: string; label: string; category: 'basic' | 'advanced' | 'test' }> = {
  reader:      { icon: <CreditCard className="w-5 h-5" />, color: 'indigo', bgColor: 'bg-[#F0A73C]', label: 'Read', category: 'basic' },
  door:        { icon: <DoorOpen className="w-5 h-5" />, color: 'blue', bgColor: 'bg-[#5E86B8]', label: 'Door', category: 'basic' },
  io:          { icon: <Zap className="w-5 h-5" />, color: 'yellow', bgColor: 'bg-[#C79A34]', label: 'I/O', category: 'basic' },
  wait:        { icon: <Clock className="w-5 h-5" />, color: 'orange', bgColor: 'bg-[#C67A3E]', label: 'Wait', category: 'basic' },
  schedule:    { icon: <Timer className="w-5 h-5" />, color: 'sage', bgColor: 'bg-[#8FB488]', label: 'Schedule', category: 'basic' },
  control:     { icon: <RotateCw className="w-5 h-5" />, color: 'red', bgColor: 'bg-[#C6604F]', label: 'Control', category: 'basic' },
  waitInput:   { icon: <Eye className="w-5 h-5" />, color: 'cyan', bgColor: 'bg-[#4F9E97]', label: 'Wait Input', category: 'advanced' },
  log:         { icon: <MessageSquare className="w-5 h-5" />, color: 'slate', bgColor: 'bg-[#322A22]', label: 'Log/Assert', category: 'advanced' },
  supervision: { icon: <Shield className="w-5 h-5" />, color: 'amber', bgColor: 'bg-[#F0A73C]', label: 'Supervision', category: 'advanced' },
  scenario:    { icon: <Target className="w-5 h-5" />, color: 'emerald', bgColor: 'bg-[#4E9E74]', label: 'Scenario', category: 'test' },
};

// Safe fallback so an unknown/legacy block type can NEVER crash the render
// (was the white-screen: BLOCK_CONFIG[badType].bgColor → undefined.bgColor).
const FALLBACK_BLOCK_CONFIG = {
  icon: <HelpCircle className="w-5 h-5" />,
  color: 'slate',
  bgColor: 'bg-[#38302A]',
  label: 'Unknown',
  category: 'basic' as const,
};
const getBlockConfig = (t: any) =>
  (t && (BLOCK_CONFIG as any)[t]) ? (BLOCK_CONFIG as any)[t] : FALLBACK_BLOCK_CONFIG;
const isKnownBlockType = (t: any): t is BlockType =>
  typeof t === 'string' && Object.prototype.hasOwnProperty.call(BLOCK_CONFIG, t);

const SCENARIO_TEMPLATES: Record<ScenarioType, { name: string; description: string; icon: React.ReactNode }> = {
  valid_access:   { name: 'Valid Access', description: 'Card → Unlock → Open → Close → Lock', icon: <CheckCircle className="w-4 h-4" /> },
  denied_access:  { name: 'Denied Access', description: 'Bad Card → Verify No Unlock', icon: <XCircle className="w-4 h-4" /> },
  forced_door:    { name: 'Forced Door', description: 'Open without card → Verify Alarm', icon: <AlertTriangle className="w-4 h-4" /> },
  held_door:      { name: 'Held Door', description: 'Open → Wait → Verify Alarm', icon: <Timer className="w-4 h-4" /> },
  rex_egress:     { name: 'REX Egress', description: 'REX → Unlock → Open → Close', icon: <DoorOpen className="w-4 h-4" /> },
  anti_passback:  { name: 'Anti-Passback', description: 'Card In → Card In again → Deny', icon: <RotateCw className="w-4 h-4" /> },
  tailgating:     { name: 'Tailgating', description: 'Two cards < X seconds apart', icon: <Copy className="w-4 h-4" /> },
  interlock:      { name: 'Interlock', description: 'Door 1 must close before Door 2', icon: <Layers className="w-4 h-4" /> },
};

const EmulationWorkflow: React.FC<EmulationWorkflowProps> = ({
  ipAddress, connected, inputs, outputs, controllerOutputs, controllerInputs, doors,
  readerPool: propReaderPool, isEmulating, setIsEmulating, logEmulation, logSystem,
}) => {
  const [workflow, setWorkflow] = useState<WorkflowColumn[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [quickAddPosition, setQuickAddPosition] = useState<number | null>(null);
  const [paletteCategory, setPaletteCategory] = useState<'basic' | 'advanced' | 'test' | 'all'>('all');
  const [draggedBlock, setDraggedBlock] = useState<{ type: BlockType; fromColumn?: string; blockId?: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; position: 'before' | 'after' | 'into' } | null>(null);
  const [currentColumnIndex, setCurrentColumnIndex] = useState(-1);
  const [executingBlockIds, setExecutingBlockIds] = useState<Set<string>>(new Set());
  const [isPaused, setIsPaused] = useState(false);
  const executionControlRef = useRef({ shouldStop: false, isPaused: false });
  const [testResults, setTestResults] = useState<{ passed: number; failed: number; assertions: string[] }>({ passed: 0, failed: 0, assertions: [] });
  const [readerPool, setReaderPool] = useState<Reader[]>([]);
  const [cardFormats, setCardFormats] = useState<CardFormat[]>(DEFAULT_FORMATS);
  const [loadingReaders, setLoadingReaders] = useState(false);
  const [emulationLog, setEmulationLog] = useState<EmulationLogEntry[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [globalDelay, setGlobalDelay] = useState(1000);
  const [repeatCount, setRepeatCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [savedWorkflows, setSavedWorkflows] = useState<any[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  // Import/Export wizard + autosave-restore
  const [showIoWizard, setShowIoWizard] = useState(false);
  const [ioWizardTab, setIoWizardTab] = useState<'export' | 'import'>('export');
  const [ioError, setIoError] = useState<string>('');
  const [restoreAvailable, setRestoreAvailable] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const AUTOSAVE_KEY = 'aether-workflow-autosave-v2';
  const SCENARIOS_KEY = 'aether-custom-scenarios-v1';   // dedicated, reload-proof
  const [showScenarioWizard, setShowScenarioWizard] = useState(false);
  const [scenarioWizTab, setScenarioWizTab] = useState<'save' | 'manage'>('save');
  const [customScenarios, setCustomScenarios] = useState<{ id: string; name: string; steps: any; globalDelay: number; repeatCount: number; savedAt: number }[]>([]);
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioWizError, setScenarioWizError] = useState('');
  // ── Schedule whole workflow (Option B) ─────────────────────────────────
  // scheduledRunAt: timestamp (ms) when the workflow should auto-start.
  // Picker state controls the schedule dialog. Timer ref ensures unmount cleanup.
  const [scheduledRunAt, setScheduledRunAt] = useState<number | null>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleDialogTime, setScheduleDialogTime] = useState('');
  const [scheduleDialogDate, setScheduleDialogDate] = useState('');
  const [scheduleCountdownTick, setScheduleCountdownTick] = useState(0);   // forces re-render for countdown
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((column: number, message: string, type: EmulationLogEntry['type'] = 'info') => {
    const entry: EmulationLogEntry = { timestamp: new Date().toLocaleTimeString(), column, message, type };
    setEmulationLog(prev => [entry, ...prev].slice(0, 500));
    logEmulationRef.current(message);
  }, []); // stable — logEmulation accessed via ref

  // Store logSystem in a ref so useCallback doesn't re-create on every parent render
  const logSystemRef = useRef(logSystem);
  useEffect(() => { logSystemRef.current = logSystem; }, [logSystem]);
  const logEmulationRef = useRef(logEmulation);
  useEffect(() => { logEmulationRef.current = logEmulation; }, [logEmulation]);

  const loadReadersFromBackend = useCallback(async () => {
    if (!connected || !ipAddress) return;
    setLoadingReaders(true);
    const readers: Reader[] = [];
    try {
      const wiegandResponse = await fetch(`http://${ipAddress}:3001/api/wiegand/readers`);
      if (wiegandResponse.ok) {
        const data = await wiegandResponse.json();
        if (data.success && data.readers) {
          data.readers.forEach((r: any) => {
            readers.push({ id: r.id || r.readerId, name: r.name || `Wiegand ${r.id}`, type: 'wiegand', enabled: r.enabled !== false, d0: r.pins?.d0 ?? r.d0, d1: r.pins?.d1 ?? r.d1, assignedToDoor: r.door || null, position: 'in' });
          });
        }
      }
    } catch (e) { console.warn('Wiegand load failed:', e); }
    try {
      const osdpResponse = await fetch(`http://${ipAddress}:3001/api/osdp/readers`);
      if (osdpResponse.ok) {
        const data = await osdpResponse.json();
        if (data.success && data.readers) {
          const osdpReaders = Array.isArray(data.readers) ? data.readers : Object.values(data.readers);
          osdpReaders.forEach((r: any) => {
            readers.push({ id: r.id || `osdp-${r.address}`, name: r.name || `OSDP ${r.address}`, type: 'osdp', enabled: r.enabled !== false, address: r.address, assignedToDoor: r.door || null, position: 'in' });
          });
        }
      }
    } catch (e) { console.warn('OSDP load failed:', e); }
    // Emulated controller reader ports — each board's readerState[] becomes
    // selectable readers. Fires via the IC2-verified card endpoint.
    try {
      const emuRes = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
      if (emuRes.ok) {
        const ed = await emuRes.json();
        const devices = ed?.status?.devices || [];
        devices.forEach((d: any) => {
          const ports = Array.isArray(d.readerState) ? d.readerState.length : 0;
          for (let port = 0; port < ports; port++) {
            readers.push({
              id: `ctrl-emu-${d.address}-${port}`,
              name: `#${d.address} ${d.model} — Reader ${port}`,
              type: 'controller-emulator',
              enabled: d.online !== false,
              address: d.address,
              port,
              model: d.model,
              assignedToDoor: null,
              position: 'in',
            });
          }
        });
      }
    } catch (e) { console.warn('Controller-emulator reader load failed:', e); }
    if (readers.length === 0) {
      try {
        const configResponse = await fetch(`http://${ipAddress}:3001/api/wiegand/config`);
        if (configResponse.ok) {
          const config = await configResponse.json();
          if (config.doors) {
            config.doors.forEach((d: any) => {
              readers.push({ id: d.readerId || `reader${d.door}`, name: d.name || `Door ${d.door}`, type: 'wiegand', enabled: true, d0: d.d0, d1: d.d1, assignedToDoor: d.door, position: 'in' });
            });
          }
        }
      } catch (e) { console.warn('Config load failed:', e); }
    }
    if (readers.length === 0 && propReaderPool) readers.push(...propReaderPool);
    setReaderPool(readers);
    setLoadingReaders(false);
    if (readers.length > 0) logSystemRef.current('info', `Loaded ${readers.length} readers`);
  }, [connected, ipAddress, propReaderPool]); // logSystem via ref — not a dep

  const loadCardFormats = useCallback(async () => {
    try {
      const response = await fetch(`http://${ipAddress}:3001/api/credential-formats`);
      if (response.ok) {
        const data = await response.json();
        if (data.formats?.length > 0) setCardFormats(data.formats);
      }
    } catch (e) { console.warn('Format load failed:', e); }
  }, [ipAddress]);

  const loadSavedWorkflows = useCallback(async () => {
    try {
      const response = await fetch(`http://${ipAddress}:3001/api/emulations`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.items) setSavedWorkflows(data.items);
      }
    } catch (e) { console.warn('Workflows load failed:', e); }
  }, [ipAddress]);

  // Load once when connected — deps are intentionally minimal.
  // Callbacks are stable (useCallback with stable deps) so listing them
  // would cause re-fires if parent re-renders with new prop references.
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    if (connected && ipAddress) {
      // Always reload when connection state changes
      hasLoadedRef.current = false;
    }
    if (connected && ipAddress && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadReadersFromBackend();
      loadCardFormats();
      loadSavedWorkflows();
    }
    if (!connected) {
      hasLoadedRef.current = false;
    }
  }, [connected, ipAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const createBlock = (type: BlockType): WorkflowBlock => {
    const block: WorkflowBlock = { id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, type };
    // For schedule/wait-until-time defaults: nearest 5-minute increment ~10 min from now
    const nowPlus10 = new Date(Date.now() + 10 * 60_000);
    const hh = String(nowPlus10.getHours()).padStart(2, '0');
    const mm = String(Math.ceil(nowPlus10.getMinutes() / 5) * 5 % 60).padStart(2, '0');
    const defaultTime = `${hh}:${mm}`;
    switch (type) {
      case 'reader':
        block.readerId = readerPool[0]?.id || '';
        block.format = cardFormats[0]?.id || '26';
        block.mode = 'single';
        block.readType = 'card';             // default to card behavior
        block.facilityCode = 100;
        block.cardNumber = 1234;
        block.sequenceMode = 'sequential';
        block.delayBetweenCards = 500;
        // PIN defaults (used only if user switches to readType: 'pin')
        block.pinValue = '1234';
        block.keypadFormat = '4bit';
        break;
      case 'door': block.doorId = doors[0]?.id || 1; block.eventType = 'lock'; block.action = 'pulse'; block.pulseDuration = 500; break;
      case 'io': block.ioType = 'output'; block.ioId = outputs[0]?.id || 1; block.action = 'pulse'; block.pulseDuration = 500; break;
      case 'wait':
        block.waitType = 'seconds'; block.waitValue = 3;
        block.waitMin = 1; block.waitMax = 5;
        block.waitUntilTime = defaultTime;   // ready if user switches to 'until_time'
        break;
      case 'schedule':
        block.scheduleTime = defaultTime;
        // scheduleDate intentionally left undefined → "next occurrence"
        break;
      case 'control': block.controlType = 'stop'; break;
      case 'waitInput': block.waitInputType = 'input'; block.waitInputId = inputs[0]?.id || 1; block.waitInputState = 'high'; block.waitInputTimeout = 10000; block.waitInputTimeoutAction = 'continue'; break;
      case 'log': block.logMessage = 'Test marker'; block.logLevel = 'info'; block.assertCondition = false; break;
      case 'supervision': block.supervisionInputId = inputs[0]?.id || 1; block.supervisionState = 'normal'; block.supervisionDuration = 2000; break;
      case 'scenario':
        block.scenarioType = 'valid_access';
        block.scenarioDoorId = doors[0]?.id || 1;
        block.scenarioReaderId = readerPool[0]?.id || '';
        block.scenarioFacilityCode = 100;
        block.scenarioCardNumber = 1234;
        // OPTO INPUTS — reading FROM the panel
        block.scenarioLockInput = 0;       // opto 0 reads panel lock relay
        block.scenarioAlarmInput = 1;      // opto 1 reads panel alarm output
        block.scenarioLock2Input = 2;      // opto 2 reads panel Door 2 lock (interlock)
        // RELAY OUTPUTS — driving TO the panel
        block.scenarioDpsRelay = 6;        // relay 6 drives panel DPS input
        block.scenarioRexRelay = 7;        // relay 7 drives panel REX input
        // Common
        block.scenarioVerifyTimeoutMs = 3000;
        block.scenarioHeldTime = 31000;
        block.scenarioBadFacilityCode = 999;
        block.scenarioBadCardNumber = 99999;
        block.scenarioCard2FacilityCode = 100;
        block.scenarioCard2Number = 5678;
        block.scenarioTailgateDelay = 2000;
        block.scenarioApbDelay = 3000;
        block.scenarioCredentials = [{ fc: 100, cn: 1234 }, { fc: 100, cn: 5678 }];
        block.scenarioReader2Id = readerPool[1]?.id || readerPool[0]?.id || '';
        block.scenarioDoor2Board = 0;
        block.scenarioInterlockSettleMs = 1000;
        block.scenarioInterlockTimeoutMs = 3000;
        break;
    }
    return block;
  };

  const addColumnWithBlock = (type: BlockType, position?: number) => {
    const block = createBlock(type);
    const column: WorkflowColumn = { id: `col-${Date.now()}`, blocks: [block] };
    setWorkflow(prev => { if (position !== undefined) { const n = [...prev]; n.splice(position, 0, column); return n; } return [...prev, column]; });
    setSelectedBlockId(block.id); setSelectedColumnId(column.id);
  };

  const addBlockToColumn = (columnId: string, type: BlockType) => {
    const block = createBlock(type);
    setWorkflow(prev => prev.map(col => col.id === columnId ? { ...col, blocks: [...col.blocks, block] } : col));
    setSelectedBlockId(block.id);
  };

  const updateBlock = (blockId: string, updates: Partial<WorkflowBlock>) => {
    setWorkflow(prev => prev.map(col => ({ ...col, blocks: col.blocks.map(b => b.id === blockId ? { ...b, ...updates } : b) })));
  };

  const deleteBlock = (columnId: string, blockId: string) => {
    setWorkflow(prev => prev.map(col => { if (col.id !== columnId) return col; return { ...col, blocks: col.blocks.filter(b => b.id !== blockId) }; }).filter(col => col.blocks.length > 0));
    if (selectedBlockId === blockId) setSelectedBlockId(null);
  };

  const deleteColumn = (columnId: string) => {
    setWorkflow(prev => prev.filter(col => col.id !== columnId));
    if (selectedColumnId === columnId) { setSelectedColumnId(null); setSelectedBlockId(null); }
  };

  const duplicateBlock = (columnId: string, block: WorkflowBlock) => {
    const newBlock = { ...block, id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` };
    setWorkflow(prev => prev.map(col => col.id === columnId ? { ...col, blocks: [...col.blocks, newBlock] } : col));
  };

  const handleDragStart = (e: DragEvent, type: BlockType, fromColumn?: string, blockId?: string) => {
    setDraggedBlock({ type, fromColumn, blockId }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', type);
    setTimeout(() => document.body.classList.add('dragging-block'), 0);
  };
  const handleDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; };
  const handleDragEnterColumn = (e: DragEvent, columnId: string, position: 'before' | 'after' | 'into') => { e.preventDefault(); e.stopPropagation(); setDropTarget({ columnId, position }); };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      setTimeout(() => { if (!document.querySelector('[data-drop-zone]:hover')) setDropTarget(null); }, 50);
    }
  };
  const handleDropOnColumn = (e: DragEvent, columnId: string) => {
    e.preventDefault(); if (!draggedBlock) return;
    if (draggedBlock.fromColumn && draggedBlock.blockId) {
      const sourceColumn = workflow.find(c => c.id === draggedBlock.fromColumn);
      const block = sourceColumn?.blocks.find(b => b.id === draggedBlock.blockId);
      if (block && draggedBlock.fromColumn !== columnId) {
        setWorkflow(prev => prev.map(col => {
          if (col.id === draggedBlock.fromColumn) return { ...col, blocks: col.blocks.filter(b => b.id !== draggedBlock.blockId) };
          if (col.id === columnId) return { ...col, blocks: [...col.blocks, { ...block }] };
          return col;
        }).filter(col => col.blocks.length > 0));
      }
    } else { addBlockToColumn(columnId, draggedBlock.type); }
    setDraggedBlock(null); setDropTarget(null);
  };
  const handleDropNewColumn = (e: DragEvent, position: number) => {
    e.preventDefault(); if (!draggedBlock) return;
    if (draggedBlock.fromColumn && draggedBlock.blockId) {
      const sourceColumn = workflow.find(c => c.id === draggedBlock.fromColumn);
      const block = sourceColumn?.blocks.find(b => b.id === draggedBlock.blockId);
      if (block) {
        const newColumn: WorkflowColumn = { id: `col-${Date.now()}`, blocks: [{ ...block }] };
        setWorkflow(prev => {
          const nw = prev.map(col => { if (col.id === draggedBlock.fromColumn) return { ...col, blocks: col.blocks.filter(b => b.id !== draggedBlock.blockId) }; return col; }).filter(col => col.blocks.length > 0);
          nw.splice(position, 0, newColumn); return nw;
        });
      }
    } else { addColumnWithBlock(draggedBlock.type, position); }
    setDraggedBlock(null); setDropTarget(null);
  };
  const handleDragEnd = () => { setDraggedBlock(null); setDropTarget(null); document.body.classList.remove('dragging-block'); };

  // ── Controller Emulator I/O helpers (direction-corrected) ──────────
  //
  // The Controller Emulator pretends to be a downstream OSDP board:
  //   inputs[]  = SIMULATED contact/sensor states  → workflow TRIGGERS these
  //   outputs[] = relays driven by the IC2          → workflow READS only
  //
  // Live items use id = address*100 + ioIndex. Static fallback ids 1..4
  // decode to address 0 and are skipped by the live-API helpers.
  const controllerIoFromId = (id: number): { address: number; index: number } => ({
    address: Math.floor(id / 100),
    index:   id % 100,
  });

  // TRIGGER a simulated input on an emulated board.
  // Workflow drives these to simulate DPS, REX, alarm contacts, etc.
  const setControllerInput = async (address: number, index: number, active: boolean) => {
    if (address < 1) throw new Error('Not a live controller board (emulator may be stopped)');
    const r = await fetch(
      `http://${ipAddress}:3001/api/emulator/device/${address}/input/${index}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }) }
    );
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'controller input trigger failed');
    return j;
  };

  // READ a simulated input's current state from the emulator status snapshot.
  const readControllerInput = async (address: number, index: number): Promise<boolean> => {
    try {
      const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
      const j = await r.json();
      if (!j.success || !j.status) return false;
      const dev = (j.status.devices || []).find((d: any) => d.address === address);
      return !!(dev && dev.inputs && dev.inputs[index]);
    } catch (e) { return false; }
  };

  // READ an IC2-driven output's current state. Use this in Assert blocks to
  // verify "IC2 drove output N high after X happened".
  const readControllerOutput = async (address: number, index: number): Promise<boolean> => {
    try {
      const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
      const j = await r.json();
      if (!j.success || !j.status) return false;
      const dev = (j.status.devices || []).find((d: any) => d.address === address);
      return !!(dev && dev.outputs && dev.outputs[index]);
    } catch (e) { return false; }
  };

  // Does this input-id reference a live controller-emulator input?
  const isControllerInputId = (id: number): boolean =>
    controllerInputs.some(ci => ci.id === id);

  // Does this output-id reference a live controller-emulator output?
  const isControllerOutputId = (id: number): boolean =>
    controllerOutputs.some(co => co.id === id && co.id >= 100);  // exclude static 1..4

  // Two-step picker helpers — derived board list from live items.
  const controllerBoards = React.useMemo(() => {
    const map = new Map<number, string>();
    const harvest = (items: { id: number; name: string }[]) => {
      for (const item of items) {
        const address = Math.floor(item.id / 100);
        if (address < 1) continue;
        if (!map.has(address)) {
          const m = item.name.match(/^#\d+\s+\S+/);
          map.set(address, m ? m[0] : `#${address}`);
        }
      }
    };
    harvest(controllerOutputs);
    harvest(controllerInputs);
    return Array.from(map.entries())
      .map(([address, label]) => ({ address, label }))
      .sort((a, b) => a.address - b.address);
  }, [controllerOutputs, controllerInputs]);

  const controllerItemsForBoard = (address: number, kind: 'output' | 'input') => {
    const src = kind === 'output' ? controllerOutputs : controllerInputs;
    return src
      .filter(i => Math.floor(i.id / 100) === address)
      .sort((a, b) => (a.id % 100) - (b.id % 100));
  };

    const controlRelay = async (relayIndex: number, value: 0 | 1) => {
    if (relayIndex < 0 || relayIndex > 7) throw new Error(`Invalid relay index ${relayIndex}`);
    const response = await fetch(`http://${ipAddress}:3001/api/gpio/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: relayIndex, value }) });
    const result = await response.json();
    if (!result.success) throw new Error(result.error);
    return result;
  };

  const readInput = async (inputId: number): Promise<boolean> => {
    try {
      // Controller emulator input?
      if (isControllerInputId(inputId)) {
        const { address, index } = controllerIoFromId(inputId);
        return await readControllerInput(address, index);
      }
      // Controller emulator OUTPUT? (Assert blocks can read IC2-driven outputs)
      if (isControllerOutputId(inputId)) {
        const { address, index } = controllerIoFromId(inputId);
        return await readControllerOutput(address, index);
      }
      // Pi GPIO input
      const input = inputs.find(i => i.id === inputId); if (!input) return false;
      const response = await fetch(`http://${ipAddress}:3001/api/gpio/read/${(input as any).gpio}`);
      const result = await response.json();
      return result.success ? result.value === 1 : false;
    } catch (e) { return false; }
  };

  const readDoorInput = async (doorId: number, inputType: 'dps' | 'rex'): Promise<boolean> => {
    try {
      const door = doors.find(d => d.id === doorId); if (!door) return false;
      const gpio = inputType === 'dps' ? door.dps.gpio : door.rexIn.gpio;
      const response = await fetch(`http://${ipAddress}:3001/api/gpio/read/${gpio}`);
      const result = await response.json();
      return result.success ? result.value === 1 : false;
    } catch (e) { return false; }
  };

  // ── I/O helpers for scenario execution ─────────────────────────────────
  // Read a specific opto input channel (0-7) directly by channel index.
  // These are INPUTS TO the Pi FROM the panel (lock relay, alarm output, etc.)
  const readOptoByChannel = async (channel: number): Promise<boolean> => {
    try {
      // Try direct opto endpoint first
      const r = await fetch(`http://${ipAddress}:3001/api/gpio/opto/${channel}`);
      if (r.ok) {
        const d = await r.json();
        if (d.success !== undefined) return !!(d.state ?? d.value);
      }
      // Fallback: full status object
      const r2 = await fetch(`http://${ipAddress}:3001/api/gpio/status`);
      const d2 = await r2.json();
      if (d2.success && d2.inputs) return !!(d2.inputs[channel]?.state ?? d2.inputs[channel]?.value);
      return false;
    } catch (e) { return false; }
  };

  // Poll an OPTO INPUT (panel output) until it reaches targetState or times out.
  // Use this to verify the panel responded (e.g. lock relay went active).
  const waitForOptoState = async (
    channel: number,
    targetState: boolean,
    timeoutMs: number,
    pollMs = 100
  ): Promise<{ reached: boolean; elapsedMs: number }> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (executionControlRef.current.shouldStop) return { reached: false, elapsedMs: Date.now() - start };
      const state = await readOptoByChannel(channel);
      if (state === targetState) return { reached: true, elapsedMs: Date.now() - start };
      await new Promise(r => setTimeout(r, pollMs));
    }
    return { reached: false, elapsedMs: timeoutMs };
  };

  // Poll a configured INPUT ITEM (by item ID, for waitInput blocks)
  const waitForInputState = async (
    inputId: number,
    targetState: boolean,
    timeoutMs: number,
    pollMs = 100
  ): Promise<{ reached: boolean; elapsedMs: number }> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (executionControlRef.current.shouldStop) return { reached: false, elapsedMs: Date.now() - start };
      const state = await readInput(inputId);
      if (state === targetState) return { reached: true, elapsedMs: Date.now() - start };
      await new Promise(r => setTimeout(r, pollMs));
    }
    return { reached: false, elapsedMs: timeoutMs };
  };

  // ── Scenario I/O abstraction ─────────────────────────────────────────────
  // The scenario engine calls driveToPanel()/readFromPanel() instead of GPIO
  // directly. These branch on the block's scenarioIoSource so one engine
  // serves BOTH a physical opto/relay rig AND an emulated controller board.
  //
  //   driveToPanel  : Pi → panel  (physical relay close  OR emulated input set)
  //   readFromPanel : panel → Pi  (physical opto read    OR emulated output read)
  const scenarioDriveToPanel = async (
    block: WorkflowBlock, channel: number, active: boolean
  ): Promise<void> => {
    if (block.scenarioIoSource === 'emulated') {
      const addr = block.scenarioEmuBoard ?? 0;
      if (!addr) throw new Error('Scenario I/O source is Emulated but no board selected');
      // setControllerInput already throws on {success:false}; the most common
      // cause is an INPUT index beyond the board's numInputs (e.g. index 6 on
      // a RI2MS which only has 6 inputs 0-5). Make that explicit.
      try {
        await setControllerInput(addr, channel, active);
      } catch (e: any) {
        throw new Error(`Drive INPUT ${channel} on #${addr} failed: ${e?.message || e}. ` +
          `Check the channel is within this board's input count.`);
      }
    } else {
      await controlRelay(channel, active ? 1 : 0);
    }
  };
  const scenarioReadFromPanel = async (
    block: WorkflowBlock, channel: number
  ): Promise<boolean> => {
    if (block.scenarioIoSource === 'emulated') {
      const addr = block.scenarioEmuBoard ?? 0;
      if (!addr) throw new Error('Scenario I/O source is Emulated but no board selected');
      return await readControllerOutput(addr, channel);
    }
    return await readOptoByChannel(channel);
  };
  const scenarioWaitFor = async (
    block: WorkflowBlock, channel: number, target: boolean, timeoutMs: number, pollMs = 100
  ): Promise<{ reached: boolean; elapsedMs: number }> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (executionControlRef.current.shouldStop) return { reached: false, elapsedMs: Date.now() - start };
      const s = await scenarioReadFromPanel(block, channel);
      if (s === target) return { reached: true, elapsedMs: Date.now() - start };
      await new Promise(r => setTimeout(r, pollMs));
    }
    return { reached: false, elapsedMs: timeoutMs };
  };
  // Read a channel for Door 2, honoring an optional board override. If
  // scenarioDoor2Board is set (and source is emulated), Door 2's lock output
  // lives on THAT board; otherwise it falls back to Door 1's board/source.
  const scenarioReadDoor2 = async (block: WorkflowBlock, channel: number): Promise<boolean> => {
    if (block.scenarioIoSource === 'emulated') {
      const d2 = block.scenarioDoor2Board ?? 0;
      const addr = d2 || (block.scenarioEmuBoard ?? 0);
      if (!addr) throw new Error('Interlock: emulated source but no board for Door 2');
      return await readControllerOutput(addr, channel);
    }
    return await readOptoByChannel(channel);
  };
  const scenarioWaitDoor2 = async (
    block: WorkflowBlock, channel: number, target: boolean, timeoutMs: number, pollMs = 100
  ): Promise<{ reached: boolean; elapsedMs: number }> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (executionControlRef.current.shouldStop) return { reached: false, elapsedMs: Date.now() - start };
      if (await scenarioReadDoor2(block, channel) === target) return { reached: true, elapsedMs: Date.now() - start };
      await new Promise(r => setTimeout(r, pollMs));
    }
    return { reached: false, elapsedMs: timeoutMs };
  };
  // ─────────────────────────────────────────────────────────────────────────

  const sendCard = async (reader: Reader, fc: number, cn: number, bits: number) => {
    if (reader.type === 'wiegand') {
      const d0Pin = reader.d0 ?? reader.pins?.d0; const d1Pin = reader.d1 ?? reader.pins?.d1;
      const response = await fetch(`http://${ipAddress}:3001/api/wiegand/transmit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d0Pin, d1Pin, facility: fc, card: cn, bits, pulseWidth: 50 }) });
      return response.json();
    } else if (reader.type === 'osdp') {
      const response = await fetch(`http://${ipAddress}:3001/api/osdp/card-read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readerId: reader.id, facility: fc, card: cn, format: `wiegand${bits}` }) });
      return response.json();
    } else if (reader.type === 'controller-emulator') {
      const response = await fetch(`http://${ipAddress}:3001/api/emulator/device/${reader.address}/reader/${reader.port}/card`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: `w${bits}`, facility: fc, card: cn }) });
      return response.json();
    }
    return { success: false, error: 'Unknown reader type' };
  };

  const generateCardSequence = (block: WorkflowBlock, format: CardFormat): { fc: number; cn: number }[] => {
    const cards: { fc: number; cn: number }[] = [];
    if (block.mode === 'single') { cards.push({ fc: block.facilityCode || 0, cn: block.cardNumber || 0 }); }
    else {
      const fcStart = block.facilityStart || 0; const fcEnd = block.facilityEnd || fcStart;
      const cnStart = block.cardStart || 0; const cnEnd = block.cardEnd || cnStart;
      switch (block.sequenceMode) {
        case 'sequential': for (let fc = fcStart; fc <= fcEnd; fc++) for (let cn = cnStart; cn <= cnEnd; cn++) cards.push({ fc, cn }); break;
        case 'increment_fc': for (let fc = fcStart; fc <= fcEnd; fc++) cards.push({ fc, cn: cnStart }); break;
        case 'increment_cn': for (let cn = cnStart; cn <= cnEnd; cn++) cards.push({ fc: fcStart, cn }); break;
        case 'increment_both': { const count = Math.max(fcEnd - fcStart, cnEnd - cnStart) + 1; for (let i = 0; i < count; i++) cards.push({ fc: Math.min(fcStart + i, fcEnd), cn: Math.min(cnStart + i, cnEnd) }); break; }
        case 'random': { const numCards = Math.min((fcEnd-fcStart+1)*(cnEnd-cnStart+1), block.cardCount || 10); for (let i = 0; i < numCards; i++) cards.push({ fc: fcStart + Math.floor(Math.random()*(fcEnd-fcStart+1)), cn: cnStart + Math.floor(Math.random()*(cnEnd-cnStart+1)) }); break; }
        case 'invalid': cards.push({ fc: format.maxFacility+1, cn: block.cardNumber||0 }); cards.push({ fc: block.facilityCode||0, cn: format.maxCard+1 }); cards.push({ fc: -1, cn: block.cardNumber||0 }); break;
        case 'replay': { const n = block.cardCount || 5; for (let i = 0; i < n; i++) cards.push({ fc: block.facilityCode||0, cn: block.cardNumber||0 }); break; }
        default: cards.push({ fc: block.facilityCode||0, cn: block.cardNumber||0 });
      }
    }
    return cards;
  };

  // ── PIN sending ──────────────────────────────────────────────────────
  // Wiegand: each key encoded per keypadFormat → one /api/wiegand/transmit per key.
  // OSDP: single /api/osdp/keypad call with full string. Mirrors InteractiveWiegandReader
  // and InteractiveReader logic so the executor behaves identically to manual entry.
  const sendPin = async (
    reader: Reader,
    pin: string,
    keypadFormat: KeypadFormat,
    facilityCode: number,
    onProgress?: (msg: string) => void
  ): Promise<{ success: boolean; error?: string }> => {
    if (!pin) return { success: false, error: 'PIN is empty' };

    // OSDP path — single backend call regardless of format
    if (reader.type === 'osdp') {
      const osdpFormat = keypadFormat === '26bit' ? 'wiegand26' : keypadFormat;
      const body: any = { readerId: reader.id, data: pin, format: osdpFormat };
      if (osdpFormat === 'wiegand26') body.facilityCode = facilityCode;
      try {
        const res = await fetch(`http://${ipAddress}:3001/api/osdp/keypad`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const json = await res.json();
        return json?.success ? { success: true } : { success: false, error: json?.error || 'osdp keypad failed' };
      } catch (e: any) { return { success: false, error: e?.message || 'osdp request failed' }; }
    }

    // Wiegand path
    if (reader.type === 'wiegand') {
      const d0Pin = reader.d0 ?? reader.pins?.d0;
      const d1Pin = reader.d1 ?? reader.pins?.d1;
      const pulseWidth = 50;
      if (d0Pin === undefined || d1Pin === undefined) return { success: false, error: 'D0/D1 pins not configured' };

      // 26-bit single packet: send whole PIN as a "card"
      if (keypadFormat === '26bit' || keypadFormat === 'wiegand26') {
        const pinNum = parseInt(pin.replace(/[^0-9]/g, ''), 10);
        if (!Number.isFinite(pinNum)) return { success: false, error: 'Invalid PIN for 26-bit single packet' };
        try {
          const res = await fetch(`http://${ipAddress}:3001/api/wiegand/transmit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ d0Pin, d1Pin, pulseWidth, facility: facilityCode || 0, card: pinNum, bits: 26 }),
          });
          const json = await res.json();
          return json?.success ? { success: true } : { success: false, error: json?.error || 'transmit failed' };
        } catch (e: any) { return { success: false, error: e?.message || 'request failed' }; }
      }

      // Burst formats (4bit / 8bit / 8bit-wiegand): one transmit per key, terminate with '#'
      const bitLen = keypadFormat === '4bit' ? 4 : 8;
      const getKeyValue = (key: string): number => {
        if (key >= '0' && key <= '9') return parseInt(key, 10);
        if (key === '*') return 0x0A;
        if (key === '#') return 0x0B;
        return key.charCodeAt(0);
      };
      const keys = pin + '#';
      for (let i = 0; i < keys.length; i++) {
        if (executionControlRef.current.shouldStop) return { success: false, error: 'stopped' };
        const k = keys[i];
        const cardVal = getKeyValue(k);
        try {
          const res = await fetch(`http://${ipAddress}:3001/api/wiegand/transmit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ d0Pin, d1Pin, pulseWidth, facility: 0, card: cardVal, bits: bitLen }),
          });
          const json = await res.json();
          if (!json?.success) return { success: false, error: `key '${k}': ${json?.error || 'failed'}` };
          onProgress?.(`  ✓ Key '${k}' sent (${bitLen}-bit)`);
        } catch (e: any) { return { success: false, error: `key '${k}': ${e?.message}` }; }
        if (i < keys.length - 1) await new Promise(r => setTimeout(r, 50));
      }
      return { success: true };
    }

    return { success: false, error: `Unknown reader type: ${reader.type}` };
  };

  // ── Wait until clock time ────────────────────────────────────────────
  // Computes ms until the target wall-clock time. If date omitted, uses the next
  // occurrence (today if not yet passed, otherwise tomorrow). Honors shouldStop
  // via short poll intervals.
  const computeMsUntilTime = (timeStr?: string, dateStr?: string): number => {
    if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr)) return 0;
    const [hh, mm] = timeStr.split(':').map(Number);
    const target = new Date();
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [y, mo, d] = dateStr.split('-').map(Number);
      target.setFullYear(y, mo - 1, d);
    }
    target.setHours(hh, mm, 0, 0);
    // If no explicit date and target already past → roll to tomorrow
    if (!dateStr && target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    return Math.max(0, target.getTime() - Date.now());
  };
  const sleepUntilTime = async (
    timeStr?: string,
    dateStr?: string,
    onTick?: (remainingMs: number) => void
  ): Promise<{ reached: boolean }> => {
    const totalMs = computeMsUntilTime(timeStr, dateStr);
    if (totalMs <= 0) return { reached: true };
    const start = Date.now();
    const deadline = start + totalMs;
    let lastTick = 0;
    while (Date.now() < deadline) {
      if (executionControlRef.current.shouldStop) return { reached: false };
      while (executionControlRef.current.isPaused) {
        if (executionControlRef.current.shouldStop) return { reached: false };
        await new Promise(r => setTimeout(r, 250));
      }
      const remaining = deadline - Date.now();
      if (onTick && Date.now() - lastTick > 1000) { onTick(remaining); lastTick = Date.now(); }
      await new Promise(r => setTimeout(r, Math.min(500, remaining)));
    }
    return { reached: true };
  };

  const executeBlock = async (block: WorkflowBlock, columnIndex: number): Promise<void> => {
    setExecutingBlockIds(prev => new Set(prev).add(block.id));
    try {
      switch (block.type) {
        case 'reader': {
          const reader = readerPool.find(r => r.id === block.readerId);
          if (!reader) { addLog(columnIndex, `❌ Reader not found: ${block.readerId}`, 'error'); return; }
          // PIN branch
          if (block.readType === 'pin') {
            const pin = (block.pinValue || '').trim();
            const fmt: KeypadFormat = block.keypadFormat || '4bit';
            const fc  = block.facilityCode || 0;
            if (!pin) { addLog(columnIndex, `❌ PIN is empty`, 'error'); return; }
            addLog(columnIndex, `🔢 Sending PIN '${pin}' (${fmt}) → ${reader.name}`, 'info');
            const result = await sendPin(reader, pin, fmt, fc, msg => addLog(columnIndex, msg, 'info'));
            if (result.success) addLog(columnIndex, `  ✓ PIN sent`, 'success');
            else addLog(columnIndex, `  ✗ PIN send failed: ${result.error}`, 'error');
            break;
          }
          // CARD branch (existing behavior)
          const format = cardFormats.find(f => f.id === block.format) || DEFAULT_FORMATS[0];
          const cards = generateCardSequence(block, format);
          addLog(columnIndex, `💳 Sending ${cards.length} card(s) to ${reader.name}`, 'info');
          for (let i = 0; i < cards.length; i++) {
            if (executionControlRef.current.shouldStop) break;
            const { fc, cn } = cards[i];
            const result = await sendCard(reader, fc, cn, format.bits);
            if (result.success) { addLog(columnIndex, `  ✓ Card ${i+1}/${cards.length}: FC:${fc} CN:${cn}`, 'success'); }
            else { addLog(columnIndex, `  ✗ Card ${i+1} failed: ${result.error}`, 'error'); }
            if (i < cards.length - 1 && block.delayBetweenCards) await new Promise(r => setTimeout(r, block.delayBetweenCards));
          }
          break;
        }
        case 'door': {
          const door = doors.find(d => d.id === block.doorId);
          const relayIndex = (block.doorId || 1) - 1;
          if (block.action === 'pulse') {
            addLog(columnIndex, `🚪 Pulse ${door?.name || `Door ${block.doorId}`} (${block.pulseDuration}ms)`, 'info');
            await controlRelay(relayIndex, 1);
            await new Promise(r => setTimeout(r, block.pulseDuration || 500));
            await controlRelay(relayIndex, 0);
            addLog(columnIndex, `  ✓ Pulse complete`, 'success');
          } else {
            const value: 0 | 1 = block.action === 'activate' ? 1 : 0;
            await controlRelay(relayIndex, value);
            addLog(columnIndex, `${value ? '🟢' : '🔴'} ${door?.name || `Door ${block.doorId}`} ${value ? 'ON' : 'OFF'}`, 'success');
          }
          break;
        }
        case 'io': {
          if (block.ioType === 'input') { const state = await readInput(block.ioId || 1); addLog(columnIndex, `📥 Input ${block.ioId} state: ${state ? 'HIGH' : 'LOW'}`, 'info'); return; }

          // Controller Emulator INPUT trigger — simulate a contact/sensor.
          // We DRIVE inputs (outputs are owned by the IC2 and read-only).
          if (block.ioType === 'controller') {
            const io = controllerInputs.find(i => i.id === block.ioId);
            const { address, index } = controllerIoFromId(block.ioId || 0);
            const label = io?.name || `Controller Input ${block.ioId}`;
            if (address < 1) {
              addLog(columnIndex, `⚠️ ${label}: emulator not running — skipped`, 'warning');
              break;
            }
            if (block.action === 'pulse') {
              addLog(columnIndex, `⚡ Pulse ${label} (${block.pulseDuration}ms)`, 'info');
              await setControllerInput(address, index, true);
              await new Promise(r => setTimeout(r, block.pulseDuration || 500));
              await setControllerInput(address, index, false);
              addLog(columnIndex, `  ✓ Pulse complete`, 'success');
            } else if (block.action === 'toggle') {
              const current = await readControllerInput(address, index);
              await setControllerInput(address, index, !current);
              addLog(columnIndex, `🔄 ${label} toggled → ${!current ? 'ON' : 'OFF'}`, 'success');
            } else {
              const on = block.action === 'activate';
              await setControllerInput(address, index, on);
              addLog(columnIndex, `${on ? '🟢' : '🔴'} ${label} ${on ? 'ON' : 'OFF'}`, 'success');
            }
            break;
          }

          // Pi GPIO output (unchanged)
          const ioList = outputs;
          const io = ioList.find(i => i.id === block.ioId);
          const relayIndex = (block.ioId || 1) - 1;
          if (block.action === 'pulse') {
            addLog(columnIndex, `⚡ Pulse ${io?.name || `Output ${block.ioId}`} (${block.pulseDuration}ms)`, 'info');
            await controlRelay(relayIndex, 1);
            await new Promise(r => setTimeout(r, block.pulseDuration || 500));
            await controlRelay(relayIndex, 0);
            addLog(columnIndex, `  ✓ Pulse complete`, 'success');
          } else if (block.action === 'toggle') {
            const cur = await readInput(block.ioId || 1);
            await controlRelay(relayIndex, cur ? 0 : 1);
            addLog(columnIndex, `🔄 ${io?.name || `Output ${block.ioId}`} toggled → ${!cur ? 'ON' : 'OFF'}`, 'success');
          } else {
            const value: 0 | 1 = block.action === 'activate' ? 1 : 0;
            await controlRelay(relayIndex, value);
            addLog(columnIndex, `${value ? '🟢' : '🔴'} ${io?.name || `Output ${block.ioId}`} ${value ? 'ON' : 'OFF'}`, 'success');
          }
          break;
        }
        case 'wait': {
          // New: 'until_time' mode — sleeps until wall-clock target.
          if (block.waitType === 'until_time') {
            const totalMs = computeMsUntilTime(block.waitUntilTime, block.waitUntilDate);
            const target = new Date(Date.now() + totalMs);
            addLog(columnIndex, `⏰ Waiting until ${target.toLocaleString()} (${Math.round(totalMs/1000)}s)...`, 'info');
            const r = await sleepUntilTime(block.waitUntilTime, block.waitUntilDate);
            if (r.reached) addLog(columnIndex, `  ✓ Reached target time`, 'success');
            break;
          }
          let ms: number;
          if (block.waitType === 'random') {
            const min = (block.waitMin || 1) * 1000; const max = (block.waitMax || 5) * 1000;
            ms = min + Math.random() * (max - min);
            addLog(columnIndex, `⏱️ Random wait: ${Math.round(ms)}ms (${block.waitMin}-${block.waitMax}s range)`, 'info');
          } else {
            ms = block.waitType === 'minutes' ? (block.waitValue || 1) * 60000 : (block.waitValue || 5) * 1000;
            addLog(columnIndex, `⏱️ Waiting ${block.waitValue} ${block.waitType}...`, 'info');
          }
          await new Promise(r => setTimeout(r, ms));
          addLog(columnIndex, `  ✓ Wait complete`, 'success');
          break;
        }
        case 'schedule': {
          const totalMs = computeMsUntilTime(block.scheduleTime, block.scheduleDate);
          const target  = new Date(Date.now() + totalMs);
          addLog(columnIndex, `📅 Scheduled hold until ${target.toLocaleString()} (${Math.round(totalMs/1000)}s)...`, 'marker');
          const r = await sleepUntilTime(block.scheduleTime, block.scheduleDate);
          if (r.reached) addLog(columnIndex, `  ✓ Schedule reached — proceeding`, 'success');
          break;
        }
        case 'control': {
          if (block.controlType === 'stop') {
            addLog(columnIndex, `🛑 Stop command`, 'warning');
            executionControlRef.current.shouldStop = true;
          } else if (block.controlType === 'loop') {
            // Logging only — actual jump happens in runWorkflow after Promise.all
            const targetCol = block.loopToColumn ?? 0;
            addLog(columnIndex, `🔁 Loop → column ${targetCol + 1}`, 'info');
          }
          break;
        }
        case 'waitInput': {
          const timeout = block.waitInputTimeout || 0;
          const startTime = Date.now();
          addLog(columnIndex, `👁️ Waiting for input ${block.waitInputId} to be ${block.waitInputState}...`, 'info');
          while (!executionControlRef.current.shouldStop) {
            let currentState: boolean;
            if (block.waitInputType === 'controller_output') {
              const { address, index } = controllerIoFromId(block.waitInputId || 0);
              currentState = await readControllerOutput(address, index);
            }
            else if (block.waitInputType === 'controller_input') currentState = await readInput(block.waitInputId || 1);
            else if (block.waitInputType === 'input') currentState = await readInput(block.waitInputId || 1);
            else if (block.waitInputType === 'door_dps') currentState = await readDoorInput(block.waitInputDoorId || 1, 'dps');
            else currentState = await readDoorInput(block.waitInputDoorId || 1, 'rex');
            if (block.waitInputState === 'any_change') { if (currentState) { addLog(columnIndex, `  ✓ Input changed`, 'success'); break; } }
            else if (currentState === (block.waitInputState === 'high')) { addLog(columnIndex, `  ✓ Input is ${currentState ? 'HIGH' : 'LOW'}`, 'success'); break; }
            if (timeout > 0 && (Date.now() - startTime) >= timeout) {
              addLog(columnIndex, `  ⚠️ Timeout after ${timeout}ms`, 'warning');
              if (block.waitInputTimeoutAction === 'stop') executionControlRef.current.shouldStop = true;
              break;
            }
            await new Promise(r => setTimeout(r, 100));
          }
          break;
        }
        case 'log': {
          if (block.assertCondition) {
            const state = await readInput(block.assertInputId || 1);
            const expected = block.assertInputState === 'high';
            const passed = state === expected;
            if (passed) { addLog(columnIndex, `✅ ASSERT PASS: Input ${block.assertInputId} is ${state ? 'HIGH' : 'LOW'}`, 'success'); setTestResults(prev => ({ ...prev, passed: prev.passed + 1, assertions: [...prev.assertions, `✅ ${block.logMessage || 'Assertion'}`] })); }
            else { addLog(columnIndex, `❌ ASSERT FAIL: Input ${block.assertInputId} expected ${expected ? 'HIGH' : 'LOW'}, got ${state ? 'HIGH' : 'LOW'}`, 'error'); setTestResults(prev => ({ ...prev, failed: prev.failed + 1, assertions: [...prev.assertions, `❌ ${block.logMessage || 'Assertion'}`] })); }
          } else {
            const icon = block.logLevel === 'marker' ? '📍' : block.logLevel === 'success' ? '✅' : block.logLevel === 'warning' ? '⚠️' : block.logLevel === 'error' ? '❌' : '📝';
            addLog(columnIndex, `${icon} ${block.logMessage || 'Log entry'}`, block.logLevel === 'marker' ? 'info' : block.logLevel || 'info');
          }
          break;
        }
        case 'supervision': {
          const input = inputs.find(i => i.id === block.supervisionInputId);
          addLog(columnIndex, `🛡️ Simulating ${block.supervisionState} state on ${input?.name || `Input ${block.supervisionInputId}`}`, 'info');
          const relayIndex = (block.supervisionInputId || 1) - 1;
          switch (block.supervisionState) {
            case 'normal': addLog(columnIndex, `  Setting NORMAL state`, 'info'); await controlRelay(relayIndex, 0); break;
            case 'short': addLog(columnIndex, `  Setting SHORT (tamper) state`, 'warning'); await controlRelay(relayIndex, 1); break;
            case 'open': addLog(columnIndex, `  Setting OPEN (cut wire) state`, 'warning'); await controlRelay(relayIndex, 0); break;
            case 'trouble': addLog(columnIndex, `  Setting TROUBLE state`, 'warning'); break;
          }
          if (block.supervisionDuration) { await new Promise(r => setTimeout(r, block.supervisionDuration)); addLog(columnIndex, `  Reverting to normal`, 'info'); await controlRelay(relayIndex, 0); }
          break;
        }
        case 'scenario': {
          const scenarioInfo = SCENARIO_TEMPLATES[block.scenarioType || 'valid_access'];
          const reader  = readerPool.find(r => r.id === block.scenarioReaderId);
          const reader2 = readerPool.find(r => r.id === block.scenarioReader2Id);
          const format  = cardFormats.find(f => f.id === '26') || DEFAULT_FORMATS[0];

          // ── Resolved I/O channels ────────────────────────────────────────────
          // OPTO INPUTS  (reads FROM panel — panel drives these)
          const lockInput   = block.scenarioLockInput   ?? 0; // opto reading panel's lock relay
          const lock2Input  = block.scenarioLock2Input  ?? 2; // opto reading panel's Door 2 lock
          const alarmInput  = block.scenarioAlarmInput  ?? 1; // opto reading panel's alarm output
          // RELAY OUTPUTS (Pi drives TO panel — panel reads these as inputs)
          const dpsRelay    = block.scenarioDpsRelay    ?? 6; // relay driving panel's DPS terminal
          const rexRelay    = block.scenarioRexRelay    ?? 7; // relay driving panel's REX terminal
          const timeout     = block.scenarioVerifyTimeoutMs ?? 3000;
          const fc          = block.scenarioFacilityCode ?? 100;
          const cn          = block.scenarioCardNumber  ?? 1234;
          const badFc       = block.scenarioBadFacilityCode ?? 999;
          const badCn       = block.scenarioBadCardNumber   ?? 99999;
          const fc2         = block.scenarioCard2FacilityCode ?? 100;
          const cn2         = block.scenarioCard2Number  ?? 5678;

          const PASS = (msg: string) => { addLog(columnIndex, `  ✅ PASS: ${msg}`, 'success'); setTestResults(p => ({ ...p, passed: p.passed + 1, assertions: [...p.assertions, `✅ ${msg}`] })); };
          const FAIL = (msg: string) => { addLog(columnIndex, `  ❌ FAIL: ${msg}`, 'error');   setTestResults(p => ({ ...p, failed: p.failed + 1, assertions: [...p.assertions, `❌ ${msg}`] })); };
          const INFO = (msg: string) => addLog(columnIndex, `  ${msg}`, 'info');
          const WARN = (msg: string) => addLog(columnIndex, `  ⚠️  ${msg}`, 'warning');

          // Source-aware channel labels so the log matches what's actually
          // happening: emulated = OUTPUT (monitor) / INPUT (trigger), exactly
          // like the Wait Input "Controller Output (monitor)" block; physical
          // = Opto (read) / Relay (drive).
          const isEmu = block.scenarioIoSource === 'emulated';
          const RD = (ch: number) => isEmu ? `OUTPUT ${ch} (#${block.scenarioEmuBoard ?? '?'})` : `Opto I${ch}`;
          const DR = (ch: number) => isEmu ? `INPUT ${ch} (#${block.scenarioEmuBoard ?? '?'})` : `Relay R${ch}`;
          const GRANT = isEmu ? 'output went ACTIVE' : 'opto closed';
          addLog(columnIndex, `🎯 Scenario: ${scenarioInfo.name}`, 'marker');
          addLog(columnIndex, `  I/O: ${block.scenarioIoSource === 'emulated' ? `Emulated #${block.scenarioEmuBoard ?? '?'}` : 'Physical GPIO'} | lock ch ${lockInput} ◀ | DPS ch ${dpsRelay} ▶ | timeout ${timeout}ms`, 'info');

          switch (block.scenarioType) {

            // ── VALID ACCESS ────────────────────────────────────────────────
            // ── VALID ACCESS — Card → Unlock → Open → Close → Lock ──────────
            case 'valid_access': {
              if (!reader) { FAIL('No reader configured'); break; }
              INFO(`Step 1 — Send card FC:${fc} CN:${cn} → ${reader.name}`);
              await sendCard(reader, fc, cn, format.bits);

              INFO(`Step 2 — Monitoring ${RD(lockInput)} for grant (up to ${timeout}ms)...`);
              const unlock = await scenarioWaitFor(block, lockInput, true, timeout);
              if (!unlock.reached) { FAIL(`Panel did not grant — ${RD(lockInput)} did not activate within ${timeout}ms`); break; }
              PASS(`Panel granted — ${RD(lockInput)} active in ${unlock.elapsedMs}ms (${GRANT})`);

              INFO(`Step 3 — Open: asserting ${DR(dpsRelay)} (door opened)`);
              await scenarioDriveToPanel(block, dpsRelay, true);
              await new Promise(r => setTimeout(r, 500));

              INFO(`Step 4 — Close: releasing ${DR(dpsRelay)} (door closed)`);
              await scenarioDriveToPanel(block, dpsRelay, false);

              INFO(`Step 5 — Monitoring ${RD(lockInput)} for re-lock...`);
              const relock = await scenarioWaitFor(block, lockInput, false, 15000);
              if (relock.reached) PASS(`Panel re-locked (${RD(lockInput)} inactive) in ${relock.elapsedMs}ms`);
              else WARN(`${RD(lockInput)} still active after 15s — panel may require manual re-lock`);
              break;
            }

            // ── DENIED ACCESS — Bad Card → Verify No Unlock ─────────────────
            case 'denied_access': {
              if (!reader) { FAIL('No reader configured'); break; }
              INFO(`Step 1 — Send invalid card FC:${badFc} CN:${badCn} → ${reader.name}`);
              await sendCard(reader, badFc, badCn, format.bits);

              INFO(`Step 2 — Monitoring ${RD(lockInput)} — must stay inactive for ${timeout}ms (no grant)...`);
              const granted = await scenarioWaitFor(block, lockInput, true, timeout);
              if (granted.reached) FAIL(`Panel GRANTED an invalid card — ${RD(lockInput)} went active`);
              else PASS(`Panel correctly DENIED — ${RD(lockInput)} stayed inactive for ${timeout}ms`);
              break;
            }

            // ── FORCED DOOR — Open without card → hold → verify no unlock ────
            // No alarm output in this model: PASS = lock NEVER went active AND
            // DPS stayed asserted the full hold duration.
            case 'forced_door': {
              const holdMs = block.scenarioHeldTime || 3000;
              INFO(`Step 1 — Forced open: asserting ${DR(dpsRelay)} with NO card`);
              await scenarioDriveToPanel(block, dpsRelay, true);

              INFO(`Step 2 — Holding ${DR(dpsRelay)} asserted for ${holdMs}ms while watching ${RD(lockInput)}...`);
              // Poll the lock output across the whole hold; any activation = fail.
              const holdStart = Date.now();
              let lockEverActive = false;
              while (Date.now() - holdStart < holdMs) {
                if (executionControlRef.current.shouldStop) break;
                if (await scenarioReadFromPanel(block, lockInput)) { lockEverActive = true; break; }
                await new Promise(r => setTimeout(r, 100));
              }
              const heldFull = (Date.now() - holdStart) >= holdMs - 150; // tolerance

              INFO(`Step 3 — Releasing ${DR(dpsRelay)} (door closed)`);
              await scenarioDriveToPanel(block, dpsRelay, false);

              if (lockEverActive) {
                FAIL(`Forced door wrongly UNLOCKED — ${RD(lockInput)} went active with no card`);
              } else if (!heldFull) {
                FAIL(`Hold interrupted before ${holdMs}ms — inconclusive`);
              } else {
                PASS(`Forced door correct — ${RD(lockInput)} never activated while ${DR(dpsRelay)} held ${holdMs}ms`);
              }
              break;
            }

            // ── HELD DOOR — Card → grant → open → hold → verify re-lock ──────
            // No alarm output: infer from lock returning inactive despite the
            // door being held open the full heldTime.
            // ── HELD DOOR — Card → grant → REX → open → hold → close ────────
            // Sequence driver only: this scenario performs the I/O choreography
            // and logs each step. It does NOT assert a programmatic PASS/FAIL on
            // the hold — the operator judges the result from the IC2 event log
            // (where "Door Held"/"Door Forced" events actually appear). No alarm
            // output exists in this I/O model, so inference would be unreliable.
            case 'held_door': {
              const heldTime = block.scenarioHeldTime || 31000;
              if (!reader) { FAIL('No reader configured'); break; }

              INFO(`Step 1 — Send credential FC:${fc} CN:${cn} → ${reader.name}`);
              await sendCard(reader, fc, cn, format.bits);

              INFO(`Step 2 — Monitoring ${RD(lockInput)} for grant (up to ${timeout}ms)...`);
              const grant = await scenarioWaitFor(block, lockInput, true, timeout);
              if (!grant.reached) { FAIL(`Panel did not grant — ${RD(lockInput)} did not activate; cannot run held-door sequence`); break; }
              PASS(`Panel granted — ${RD(lockInput)} active in ${grant.elapsedMs}ms`);

              INFO(`Step 3 — Trigger REX: pulsing ${DR(rexRelay)} (egress request)`);
              await scenarioDriveToPanel(block, rexRelay, true);
              await new Promise(r => setTimeout(r, 300));
              await scenarioDriveToPanel(block, rexRelay, false);

              INFO(`Step 4 — Open: asserting ${DR(dpsRelay)} (door opened)`);
              await scenarioDriveToPanel(block, dpsRelay, true);

              INFO(`Step 5 — Holding door open for ${heldTime}ms (${(heldTime/1000).toFixed(0)}s)...`);
              const holdStart = Date.now();
              while (Date.now() - holdStart < heldTime) {
                if (executionControlRef.current.shouldStop) break;
                await new Promise(r => setTimeout(r, 250));
              }
              const heldActual = Date.now() - holdStart;
              INFO(`Held for ${heldActual}ms — see IC2 event log for Door Held / Forced events`);

              INFO(`Step 6 — Close: releasing ${DR(dpsRelay)} (door closed)`);
              await scenarioDriveToPanel(block, dpsRelay, false);
              PASS(`Held-door sequence completed — verify result in the IC2 event log`);
              break;
            }

            // ── REX EGRESS — REX → Unlock → Open → Close ────────────────────
            case 'rex_egress': {
              INFO(`Step 1 — REX: pulsing ${DR(rexRelay)} (egress request)`);
              await scenarioDriveToPanel(block, rexRelay, true);
              await new Promise(r => setTimeout(r, 300));
              await scenarioDriveToPanel(block, rexRelay, false);

              INFO(`Step 2 — Monitoring ${RD(lockInput)} for unlock within ${timeout}ms...`);
              const unlocked = await scenarioWaitFor(block, lockInput, true, timeout);
              if (!unlocked.reached) { FAIL(`Panel did not respond to REX — ${RD(lockInput)} stayed inactive`); break; }
              PASS(`Panel unlocked ${RD(lockInput)} in ${unlocked.elapsedMs}ms after REX`);

              INFO(`Step 3 — Open: asserting ${DR(dpsRelay)} (door opened)`);
              await scenarioDriveToPanel(block, dpsRelay, true);
              await new Promise(r => setTimeout(r, 500));
              INFO(`Step 4 — Close: releasing ${DR(dpsRelay)} (door closed)`);
              await scenarioDriveToPanel(block, dpsRelay, false);

              INFO(`Step 5 — Monitoring ${RD(lockInput)} for re-lock...`);
              const relocked = await scenarioWaitFor(block, lockInput, false, 15000);
              if (relocked.reached) PASS(`Panel re-locked in ${relocked.elapsedMs}ms`);
              else WARN(`${RD(lockInput)} still active — panel may require door close to re-lock`);
              break;
            }

            // ── ANTI-PASSBACK — Card In → Card In again → Deny ──────────────
            case 'anti_passback': {
              if (!reader) { FAIL('No reader configured'); break; }
              INFO(`Step 1 — First presentation: FC:${fc} CN:${cn} → ${reader.name}`);
              await sendCard(reader, fc, cn, format.bits);
              const firstGrant = await scenarioWaitFor(block, lockInput, true, timeout);
              if (!firstGrant.reached) { FAIL(`First card denied — can't test anti-passback`); break; }
              PASS(`First card granted — ${RD(lockInput)} active in ${firstGrant.elapsedMs}ms`);

              const apbDelay = block.scenarioApbDelay ?? 3000;
              INFO(`Step 2 — Monitoring ${RD(lockInput)} for re-lock, then waiting ${apbDelay}ms before 2nd presentation...`);
              await scenarioWaitFor(block, lockInput, false, 10000);
              await new Promise(r => setTimeout(r, apbDelay));

              INFO(`Step 3 — Second presentation of same card (anti-passback should deny)...`);
              await sendCard(reader, fc, cn, format.bits);
              const secondGrant = await scenarioWaitFor(block, lockInput, true, timeout);
              if (secondGrant.reached) FAIL(`Anti-passback NOT enforced — ${RD(lockInput)} went active on 2nd presentation`);
              else PASS(`Anti-passback ENFORCED — 2nd presentation denied (${RD(lockInput)} stayed inactive)`);
              break;
            }

            // ── TAILGATING — Two cards < X seconds apart (informational) ─────
            case 'tailgating': {
              const tailgateDelay = block.scenarioTailgateDelay || 2000;
              if (!reader) { FAIL('No reader configured'); break; }
              // Up to 5 credentials presented in sequence, `tailgateDelay`ms
              // apart. Falls back to the legacy 2-card fields if no list set.
              const creds = (Array.isArray(block.scenarioCredentials) && block.scenarioCredentials.length > 0)
                ? block.scenarioCredentials.slice(0, 5)
                : [{ fc, cn }, { fc: fc2, cn: cn2 }];
              INFO(`Tailgating: presenting ${creds.length} credential(s), ${tailgateDelay}ms apart`);
              let granted = 0;
              for (let i = 0; i < creds.length; i++) {
                if (executionControlRef.current.shouldStop) break;
                const cr = creds[i];
                INFO(`Person ${i + 1} — FC:${cr.fc} CN:${cr.cn} → ${reader.name}`);
                await sendCard(reader, cr.fc, cr.cn, format.bits);
                const g = await scenarioWaitFor(block, lockInput, true, timeout);
                if (g.reached) {
                  granted++;
                  PASS(`Person ${i + 1} granted — ${RD(lockInput)} active in ${g.elapsedMs}ms`);
                  // wait for re-lock so the next presentation is clean
                  await scenarioWaitFor(block, lockInput, false, 10000);
                } else {
                  WARN(`Person ${i + 1} not granted within ${timeout}ms (panel config dependent)`);
                }
                if (i < creds.length - 1) {
                  INFO(`Waiting ${tailgateDelay}ms before next presentation...`);
                  await new Promise(r => setTimeout(r, tailgateDelay));
                }
              }
              INFO(`Tailgating sequence done — ${granted}/${creds.length} granted. Tailgate detection is panel-side; verify in the IC2 event log.`);
              break;
            }

            // ── INTERLOCK — Door 1 must close before Door 2 ─────────────────
            // ── INTERLOCK — Door 1 must close before Door 2 unlocks ─────────
            case 'interlock': {
              if (!reader) { FAIL('No reader configured for Door 1'); break; }
              const settleMs   = block.scenarioInterlockSettleMs ?? 1000;
              const ilkTimeout = block.scenarioInterlockTimeoutMs ?? 3000;
              const d2Board    = block.scenarioDoor2Board ?? 0;
              // Door 2 label — reflects override board if set.
              const D2 = (ch: number) => isEmu
                ? `OUTPUT ${ch} (#${d2Board || block.scenarioEmuBoard || '?'})`
                : `Opto I${ch}`;

              INFO(`Step 1 — Unlock Door 1: FC:${fc} CN:${cn} → ${reader.name}`);
              await sendCard(reader, fc, cn, format.bits);
              const door1unlock = await scenarioWaitFor(block, lockInput, true, timeout);
              if (!door1unlock.reached) { FAIL(`Door 1 did not unlock — ${RD(lockInput)} did not activate; cannot test interlock`); break; }
              PASS(`Door 1 unlocked — ${RD(lockInput)} active in ${door1unlock.elapsedMs}ms`);

              if (!reader2) { WARN(`No Door 2 reader configured — skipping interlock attempt`); break; }

              INFO(`Step 2 — Open Door 1: assert ${DR(dpsRelay)} (door 1 ajar)`);
              await scenarioDriveToPanel(block, dpsRelay, true);

              if (settleMs > 0) { INFO(`Settle: waiting ${settleMs}ms before attempting Door 2...`); await new Promise(r => setTimeout(r, settleMs)); }

              INFO(`Step 3 — While Door 1 is open, attempt Door 2: ${reader2.name}${d2Board ? ` (board #${d2Board})` : ''}`);
              await sendCard(reader2, fc, cn, format.bits);
              const door2blocked = await scenarioWaitDoor2(block, lock2Input, true, ilkTimeout);
              if (door2blocked.reached) FAIL(`Interlock NOT enforced — Door 2 ${D2(lock2Input)} went active while Door 1 open`);
              else PASS(`Interlock ENFORCED — Door 2 ${D2(lock2Input)} stayed inactive for ${ilkTimeout}ms while Door 1 open`);

              INFO(`Step 4 — Close Door 1: release ${DR(dpsRelay)}, wait for re-lock...`);
              await scenarioDriveToPanel(block, dpsRelay, false);
              const door1relock = await scenarioWaitFor(block, lockInput, false, 15000);
              if (!door1relock.reached) { WARN(`Door 1 ${RD(lockInput)} still active after 15s — cannot complete interlock test`); break; }
              INFO(`Door 1 re-locked after ${door1relock.elapsedMs}ms`);

              if (settleMs > 0) { INFO(`Settle: waiting ${settleMs}ms before retrying Door 2...`); await new Promise(r => setTimeout(r, settleMs)); }

              INFO(`Step 5 — Door 1 closed. Retry Door 2: ${reader2.name}`);
              await sendCard(reader2, fc, cn, format.bits);
              const door2now = await scenarioWaitDoor2(block, lock2Input, true, ilkTimeout);
              if (door2now.reached) PASS(`Door 2 ${D2(lock2Input)} unlocked after Door 1 closed (${door2now.elapsedMs}ms) — interlock correct`);
              else FAIL(`Door 2 ${D2(lock2Input)} still locked after Door 1 closed — check panel interlock config`);
              break;
            }
          }

          const passed = testResults.passed; // snapshot for log
          addLog(columnIndex, `  🏁 Scenario complete`, 'success');
          break;
        }
      }
    } catch (err: any) {
      addLog(columnIndex, `❌ Error: ${err.message}`, 'error');
    } finally {
      setExecutingBlockIds(prev => { const s = new Set(prev); s.delete(block.id); return s; });
    }
  };

  const runWorkflow = async () => {
    if (!connected) { alert('Not connected!'); return; }
    if (workflow.length === 0) { alert('No steps in workflow!'); return; }

    executionControlRef.current.shouldStop = false;
    executionControlRef.current.isPaused = false;
    setIsEmulating(true); setIsPaused(false); setEmulationLog([]); setCurrentColumnIndex(0);
    setTestResults({ passed: 0, failed: 0, assertions: [] });

    const totalRuns = repeatCount + 1;
    addLog(0, `🚀 Starting workflow: ${workflow.length} columns × ${totalRuns} runs`, 'info');

    // Hard safety cap on loop-back jumps so a misconfigured/unbounded loop
    // can never run forever. ~10k iterations is far beyond any real test;
    // hitting it means the workflow has no exit condition.
    const MAX_LOOP_ITERATIONS = 10000;
    let loopIterations = 0;

    try {
      for (let run = 0; run < totalRuns; run++) {
        if (executionControlRef.current.shouldStop) break;
        if (run > 0) addLog(0, `━━━ Run ${run + 1}/${totalRuns} ━━━`, 'info');

        for (let colIdx = 0; colIdx < workflow.length; colIdx++) {
          if (executionControlRef.current.shouldStop) break;
          while (executionControlRef.current.isPaused) {
            if (executionControlRef.current.shouldStop) break;
            await new Promise(r => setTimeout(r, 100));
          }
          if (executionControlRef.current.shouldStop) break;

          const column = workflow[colIdx];
          setCurrentColumnIndex(colIdx);
          addLog(colIdx + 1, `▶ Column ${colIdx + 1} (${column.blocks.length} blocks)`, 'info');

          await Promise.all(column.blocks.map(block => executeBlock(block, colIdx + 1)));

          if (executionControlRef.current.shouldStop) break;

          // ── LOOP CONTROL — guarded ───────────────────────────────────────────
          const loopBlock = column.blocks.find(b => b.type === 'control' && b.controlType === 'loop');
          if (loopBlock) {
            const targetCol = loopBlock.loopToColumn ?? 0;
            if (targetCol >= 0 && targetCol <= colIdx) {
              loopIterations++;
              if (loopIterations > MAX_LOOP_ITERATIONS) {
                addLog(0, `⛔ Loop safety limit reached (${MAX_LOOP_ITERATIONS} iterations) — stopping. Add an exit/timeout condition to the loop.`, 'error');
                executionControlRef.current.shouldStop = true;
                break;
              }
              if (loopIterations % 50 === 0) {
                addLog(colIdx + 1, `🔁 Loop iteration ${loopIterations} → column ${targetCol + 1}`, 'info');
              } else {
                addLog(colIdx + 1, `🔁 Looping back to column ${targetCol + 1}`, 'info');
              }
              // Yield to the event loop EVERY loop-back so: (a) React can paint
              // the log, (b) the Stop button's state change is observed, (c) a
              // tight loop can't starve the UI thread.
              await new Promise(r => setTimeout(r, Math.max(globalDelay, 50)));
              if (executionControlRef.current.shouldStop) break;
              colIdx = targetCol - 1; // for-loop ++ lands on targetCol
              continue;
            }
          }
          // ─────────────────────────────────────────────────────────────────────

          if (colIdx < workflow.length - 1) await new Promise(r => setTimeout(r, globalDelay));
        }
        if (executionControlRef.current.shouldStop) break;
      }

      if (!executionControlRef.current.shouldStop) {
        addLog(0, '✅ Workflow complete!', 'success');
        if (testResults.passed > 0 || testResults.failed > 0) {
          addLog(0, `📊 Results: ${testResults.passed} passed, ${testResults.failed} failed`, testResults.failed > 0 ? 'warning' : 'success');
        }
      }
    } catch (err: any) {
      addLog(0, `❌ Workflow error: ${err.message}`, 'error');
    } finally {
      setIsEmulating(false); setCurrentColumnIndex(-1); setExecutingBlockIds(new Set());
    }
  };

  const stopWorkflow = () => {
    executionControlRef.current.shouldStop = true;
    executionControlRef.current.isPaused = false;   // unstick a paused loop so it can observe shouldStop
    setIsEmulating(false); setCurrentColumnIndex(-1); setIsPaused(false);
    addLog(0, '⏹️ Workflow stopped by user', 'warning');
  };

  // ── Schedule whole workflow ──────────────────────────────────────────
  // Computes the next run time from picker fields (HH:MM + optional date).
  // If date omitted, uses next occurrence rule (same logic as wait/schedule blocks).
  const scheduleRunAt = (timeStr: string, dateStr?: string) => {
    if (!timeStr) return;
    const ms = computeMsUntilTime(timeStr, dateStr || undefined);
    if (ms <= 0) { addLog(0, '⚠️ Cannot schedule: time is invalid or in the past', 'warning'); return; }
    const fireAt = Date.now() + ms;
    setScheduledRunAt(fireAt);
    setShowScheduleDialog(false);
    addLog(0, `📅 Workflow scheduled for ${new Date(fireAt).toLocaleString()}`, 'marker');
    if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
    scheduleTimerRef.current = setTimeout(() => {
      setScheduledRunAt(null);
      scheduleTimerRef.current = null;
      addLog(0, '⏰ Scheduled time reached — starting workflow', 'success');
      runWorkflow();
    }, ms);
  };
  const cancelScheduledRun = () => {
    if (scheduleTimerRef.current) { clearTimeout(scheduleTimerRef.current); scheduleTimerRef.current = null; }
    setScheduledRunAt(null);
    addLog(0, '🚫 Scheduled run cancelled', 'warning');
  };
  // Cleanup on unmount
  useEffect(() => () => { if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current); }, []);

  // Warn on browser-level navigation (refresh / close / external link) ONLY
  // while a workflow is running. Execution is client-side: leaving this page
  // ends the run and you cannot reattach monitoring afterward.
  useEffect(() => {
    if (!isEmulating) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // browsers show their own generic confirm text
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isEmulating]);
  // 1Hz tick to refresh countdown display while scheduled
  useEffect(() => {
    if (scheduledRunAt === null) return;
    const t = setInterval(() => setScheduleCountdownTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [scheduledRunAt]);
  // Helper to format the remaining countdown
  const formatCountdown = (targetMs: number): string => {
    const remaining = Math.max(0, targetMs - Date.now());
    const days = Math.floor(remaining / 86_400_000);
    const hrs  = Math.floor((remaining % 86_400_000) / 3_600_000);
    const mins = Math.floor((remaining % 3_600_000) / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    if (days > 0) return `${days}d ${hrs}h ${mins}m`;
    if (hrs > 0)  return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };
  // Opens the dialog pre-filled with "now + 10 min" rounded to 5
  const openScheduleDialog = () => {
    const nowPlus10 = new Date(Date.now() + 10 * 60_000);
    const hh = String(nowPlus10.getHours()).padStart(2, '0');
    const mm = String(Math.ceil(nowPlus10.getMinutes() / 5) * 5 % 60).padStart(2, '0');
    setScheduleDialogTime(`${hh}:${mm}`);
    setScheduleDialogDate('');
    setShowScheduleDialog(true);
  };


  // ── Robust workflow normalizer ────────────────────────────────────────
  // Coerces ANY incoming structure into a safe WorkflowColumn[]. Malformed
  // columns/blocks are dropped (logged) rather than crashing the render path
  // (the white-screen bug: workflow.flatMap(c => c.blocks) on bad data).
  const normalizeWorkflow = (raw: any): WorkflowColumn[] => {
    if (!raw) return [];
    // Accept either WorkflowColumn[] (v2) or a flat step[] (legacy).
    let cols: any[];
    if (Array.isArray(raw)) {
      // v2 columns look like { id, blocks:[...] }; legacy steps are flat block objects.
      const looksLikeColumns = raw.length === 0 || (raw[0] && typeof raw[0] === 'object' && Array.isArray(raw[0].blocks));
      cols = looksLikeColumns
        ? raw
        : raw.map((step: any, idx: number) => ({ id: `col-imported-${idx}`, blocks: [step] }));
    } else if (raw && Array.isArray(raw.steps)) {
      return normalizeWorkflow(raw.steps);
    } else {
      return [];
    }
    const safe: WorkflowColumn[] = [];
    cols.forEach((col: any, ci: number) => {
      if (!col || typeof col !== 'object') return;
      const blocksArr = Array.isArray(col.blocks) ? col.blocks : [];
      const blocks = blocksArr
        .filter((b: any) => b && typeof b === 'object' && isKnownBlockType(b.type))
        .map((b: any, bi: number) => ({ ...b, id: b.id || `block-imported-${ci}-${bi}` }));
      if (blocks.length === 0) return;       // drop empty/invalid columns
      safe.push({ id: col.id || `col-imported-${ci}`, blocks });
    });
    return safe;
  };

  // Apply a loaded/imported payload safely. Never throws to the render path.
  const applyLoadedSequence = (seq: any): { ok: boolean; error?: string } => {
    try {
      const cols = normalizeWorkflow(seq?.steps ?? seq);
      if (cols.length === 0) return { ok: false, error: 'No valid workflow columns found in the file.' };
      setWorkflow(cols);
      if (seq && typeof seq === 'object') {
        if (typeof seq.globalDelay === 'number') setGlobalDelay(seq.globalDelay);
        if (typeof seq.repeatCount === 'number') setRepeatCount(seq.repeatCount);
        if (typeof seq.name === 'string') setWorkflowName(seq.name);
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Failed to parse workflow.' };
    }
  };

  // ── File Export — download a .json the user keeps on their machine ─────
  const exportWorkflowFile = () => {
    try {
      const payload = {
        name: workflowName || 'workflow',
        version: 'workflow-v2',
        steps: workflow,
        globalDelay,
        repeatCount,
        exportedAt: new Date().toISOString(),
        app: 'aether-emulator',
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (workflowName || 'workflow').replace(/[^a-zA-Z0-9_-]+/g, '_');
      a.href = url;
      a.download = `${safeName}.aether-workflow.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      logSystemRef.current('success', `Exported workflow to ${a.download}`);
      setShowIoWizard(false);
    } catch (e: any) {
      setIoError(e?.message || 'Export failed');
    }
  };

  // ── File Import — read a .json, validate, load (no white screen) ───────
  const importWorkflowFile = (file: File) => {
    setIoError('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const parsed = JSON.parse(text);   // throws on bad JSON → caught below
        const res = applyLoadedSequence(parsed);
        if (res.ok) {
          logSystemRef.current('success', `Imported workflow from ${file.name}`);
          setShowIoWizard(false);
        } else {
          setIoError(res.error || 'Invalid workflow file.');
        }
      } catch (e: any) {
        setIoError(`Could not parse "${file.name}": ${e?.message || 'invalid JSON'}`);
      }
    };
    reader.onerror = () => setIoError(`Could not read "${file.name}".`);
    reader.readAsText(file);
  };

  // ── Browser autosave (debounced) + Restore Last ──────────────────────
  useEffect(() => {
    if (workflow.length === 0) return;
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
          steps: workflow, globalDelay, repeatCount,
          name: workflowName, savedAt: Date.now(),
        }));
      } catch { /* storage full / disabled — non-fatal */ }
    }, 800);
    return () => clearTimeout(t);
  }, [workflow, globalDelay, repeatCount, workflowName]);

  // On mount, surface the Restore button if an autosave exists and canvas is empty.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          setRestoreAvailable(true);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // ── Custom Scenarios (dedicated localStorage namespace, reload-proof) ──
  const loadCustomScenarios = () => {
    try {
      const raw = window.localStorage.getItem(SCENARIOS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setCustomScenarios(Array.isArray(arr) ? arr : []);
    } catch { setCustomScenarios([]); }
  };
  useEffect(() => { loadCustomScenarios(); }, []);

  const persistScenarios = (list: any[]) => {
    try { window.localStorage.setItem(SCENARIOS_KEY, JSON.stringify(list)); return true; }
    catch (e: any) { setScenarioWizError(`Storage failed: ${e?.message || e}`); return false; }
  };

  const saveAsScenario = () => {
    setScenarioWizError('');
    const name = scenarioName.trim();
    if (!name) { setScenarioWizError('Enter a scenario name.'); return; }
    if (workflow.length === 0) { setScenarioWizError('Canvas is empty — nothing to save.'); return; }
    const list = [...customScenarios];
    const existingIdx = list.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
    const entry = {
      id: existingIdx >= 0 ? list[existingIdx].id : `scn-${Date.now()}`,
      name,
      steps: workflow,
      globalDelay,
      repeatCount,
      savedAt: Date.now(),
    };
    if (existingIdx >= 0) {
      if (!window.confirm(`A scenario named "${name}" exists. Overwrite it?`)) return;
      list[existingIdx] = entry;
    } else {
      list.push(entry);
    }
    if (persistScenarios(list)) {
      setCustomScenarios(list);
      logSystemRef.current('success', `Saved scenario: ${name}`);
      setShowScenarioWizard(false);
      setScenarioName('');
    }
  };

  const applyScenario = (id: string) => {
    const s = customScenarios.find(x => x.id === id);
    if (!s) { setScenarioWizError('Scenario not found.'); return; }
    const res = applyLoadedSequence({ steps: s.steps, globalDelay: s.globalDelay, repeatCount: s.repeatCount, name: s.name });
    if (res.ok) {
      logSystemRef.current('success', `Loaded scenario: ${s.name}`);
      setShowScenarioWizard(false);
    } else {
      setScenarioWizError(res.error || 'Failed to load scenario.');
    }
  };

  const deleteScenario = (id: string, name: string) => {
    if (!window.confirm(`Delete scenario "${name}"? This cannot be undone.`)) return;
    const list = customScenarios.filter(s => s.id !== id);
    if (persistScenarios(list)) {
      setCustomScenarios(list);
      logSystemRef.current('success', `Deleted scenario: ${name}`);
    }
  };

  const renameScenario = (id: string, currentName: string) => {
    const next = window.prompt('Rename scenario:', currentName);
    if (next == null) return;
    const nm = next.trim();
    if (!nm) return;
    const list = customScenarios.map(s => s.id === id ? { ...s, name: nm } : s);
    if (persistScenarios(list)) { setCustomScenarios(list); logSystemRef.current('success', `Renamed to: ${nm}`); }
  };

  const restoreLastWorkflow = () => {
    try {
      const raw = window.localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) { setRestoreAvailable(false); return; }
      const parsed = JSON.parse(raw);
      const res = applyLoadedSequence(parsed);
      if (res.ok) {
        logSystemRef.current('success', 'Restored last unsaved workflow');
        setRestoreAvailable(false);
      } else {
        logSystemRef.current('error', `Restore failed: ${res.error}`);
      }
    } catch (e: any) {
      logSystemRef.current('error', `Restore failed: ${e?.message || 'bad autosave'}`);
    }
  };

  const saveWorkflow = async () => {
    if (!workflowName.trim()) { alert('Enter a name'); return; }
    try {
      const response = await fetch(`http://${ipAddress}:3001/api/emulations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: workflowName, steps: workflow, globalDelay, repeatCount, version: 'workflow-v2' }) });
      if (response.ok) { logSystemRef.current('success', `Saved: ${workflowName}`); setShowSaveDialog(false); setWorkflowName(''); loadSavedWorkflows(); }
    } catch (e) { logSystemRef.current('error', `Save failed: ${e}`); }
  };

  const loadWorkflow = async (id: string) => {
    try {
      const response = await fetch(`http://${ipAddress}:3001/api/emulations/${id}`);
      if (!response.ok) { logSystemRef.current('error', `Load failed: HTTP ${response.status}`); return; }
      const data = await response.json();
      if (!data.success || !data.sequence) { logSystemRef.current('error', 'Load failed: empty response'); return; }
      const res = applyLoadedSequence(data.sequence);
      if (res.ok) {
        logSystemRef.current('success', `Loaded: ${data.sequence.name || id}`);
        setShowLoadDialog(false);
      } else {
        logSystemRef.current('error', `Load failed: ${res.error}`);
      }
    } catch (e: any) {
      logSystemRef.current('error', `Load failed: ${e?.message || e}`);
    }
  };

  const deleteWorkflow = async (id: string, name: string) => {
    if (!window.confirm(`Delete saved workflow "${name}"? This cannot be undone.`)) return;
    try {
      const response = await fetch(`http://${ipAddress}:3001/api/emulations/${id}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success !== false) {
        logSystemRef.current('success', `Deleted: ${name}`);
        setSavedWorkflows(prev => prev.filter(w => w.id !== id));
      } else {
        logSystemRef.current('error', `Delete failed: ${data.error || `HTTP ${response.status}`}`);
      }
    } catch (e: any) {
      logSystemRef.current('error', `Delete failed: ${e?.message || e}`);
    }
  };

  const getBlockDescription = (block: WorkflowBlock): string => {
    switch (block.type) {
      case 'reader': {
        const reader = readerPool.find(r => r.id === block.readerId);
        if (block.readType === 'pin') return `PIN '${block.pinValue || ''}' (${block.keypadFormat || '4bit'}) → ${reader?.name || 'Unknown'}`;
        if (block.mode === 'range') return `${block.sequenceMode} FC:${block.facilityStart}-${block.facilityEnd} → ${reader?.name || 'Unknown'}`;
        return `FC:${block.facilityCode} CN:${block.cardNumber} → ${reader?.name || 'Unknown'}`;
      }
      case 'door': { const door = doors.find(d => d.id === block.doorId); return `${door?.name || `Door ${block.doorId}`} ${block.eventType} ${block.action}`; }
      case 'io': { const ioList = block.ioType === 'output' ? outputs : controllerOutputs; const io = ioList.find(i => i.id === block.ioId); return `${io?.name || `${block.ioType} ${block.ioId}`} ${block.action}`; }
      case 'wait':
        if (block.waitType === 'until_time') return `Until ${block.waitUntilDate ? block.waitUntilDate + ' ' : ''}${block.waitUntilTime || '--:--'}`;
        return block.waitType === 'random' ? `Random ${block.waitMin}-${block.waitMax}s` : `${block.waitValue} ${block.waitType}`;
      case 'schedule': return `Hold until ${block.scheduleDate ? block.scheduleDate + ' ' : ''}${block.scheduleTime || '--:--'}`;
      case 'control': return block.controlType === 'stop' ? 'Stop' : `Loop → Col ${(block.loopToColumn ?? 0) + 1}`;
      case 'waitInput': return `Wait ${block.waitInputType} ${block.waitInputId} = ${block.waitInputState}`;
      case 'log': return block.assertCondition ? `Assert: Input ${block.assertInputId} = ${block.assertInputState}` : (block.logMessage || 'Log');
      case 'supervision': return `Input ${block.supervisionInputId} → ${block.supervisionState}`;
      case 'scenario': return SCENARIO_TEMPLATES[block.scenarioType || 'valid_access'].name;
      default: return 'Unknown';
    }
  };

  const selectedBlock = workflow.flatMap(c => c.blocks).find(b => b.id === selectedBlockId);
  const selectedColumn = workflow.find(c => c.blocks.some(b => b.id === selectedBlockId));

  const renderBlockEditor = () => {
    if (!selectedBlock) return null;
    return (
      <div className="space-y-4">
        {selectedBlock.type === 'reader' && (
          <>
            {(() => {
              const emuReaders = readerPool.filter(r => r.type === 'controller-emulator');
              const otherReaders = readerPool.filter(r => r.type !== 'controller-emulator');
              const selected = readerPool.find(r => r.id === selectedBlock.readerId);
              const selIsEmu = selected?.type === 'controller-emulator';
              const emuBoards = Array.from(new Map(emuReaders.map(r => [r.address, { address: r.address, model: r.model }])).values()).sort((a, b) => (a.address ?? 0) - (b.address ?? 0));
              const topVal = selIsEmu ? `emu:${selected?.address}` : (selectedBlock.readerId || '');
              const onTop = (v: string) => {
                if (v.startsWith('emu:')) {
                  const addr = parseInt(v.slice(4), 10);
                  const first = emuReaders.filter(r => r.address === addr).sort((a, b) => (a.port ?? 0) - (b.port ?? 0))[0];
                  if (first) updateBlock(selectedBlock.id, { readerId: first.id });
                } else updateBlock(selectedBlock.id, { readerId: v });
              };
              const ports = selIsEmu ? emuReaders.filter(r => r.address === selected?.address).sort((a, b) => (a.port ?? 0) - (b.port ?? 0)) : [];
              return (
                <>
                  <div><label className="text-xs text-[#786D60] block mb-1">Reader</label>
                    <select value={topVal} onChange={e => onTop(e.target.value)} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">
                      {otherReaders.length > 0 && <optgroup label="Physical / OSDP">{otherReaders.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}</optgroup>}
                      {emuBoards.length > 0 && <optgroup label="Emulated Controllers">{emuBoards.map(b => <option key={`emu:${b.address}`} value={`emu:${b.address}`}>#{b.address} {b.model}</option>)}</optgroup>}
                    </select>
                  </div>
                  {selIsEmu && ports.length > 0 && (
                    <div><label className="text-xs text-[#786D60] block mb-1">Reader Port <span className="text-[#786D60]">— #{selected?.address} {selected?.model}</span></label>
                      <select value={selectedBlock.readerId || ''} onChange={e => updateBlock(selectedBlock.id, { readerId: e.target.value })} className="w-full bg-[#15110B] border border-[#F0A73C]/40 rounded px-3 py-2 text-sm">
                        {ports.map(r => <option key={r.id} value={r.id}>Reader {r.port}</option>)}
                      </select>
                    </div>
                  )}
                </>
              );
            })()}
            {/* Read Type toggle — card vs PIN */}
            <div>
              <label className="text-xs text-[#786D60] block mb-1">Read Type</label>
              <div className="grid grid-cols-2 gap-1">
                <button onClick={() => updateBlock(selectedBlock.id, { readType: 'card' })} className={`px-2 py-1.5 rounded text-xs flex items-center justify-center gap-1.5 ${(selectedBlock.readType || 'card') === 'card' ? 'bg-[#F0A73C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}><CreditCard className="w-3.5 h-3.5" />Card</button>
                <button onClick={() => updateBlock(selectedBlock.id, { readType: 'pin' })} className={`px-2 py-1.5 rounded text-xs flex items-center justify-center gap-1.5 ${selectedBlock.readType === 'pin' ? 'bg-[#F0A73C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}><Hash className="w-3.5 h-3.5" />PIN</button>
              </div>
            </div>
            {selectedBlock.readType === 'pin' ? (
              <>
                <div>
                  <label className="text-xs text-[#786D60] block mb-1">PIN Value</label>
                  <input type="text" maxLength={16} value={selectedBlock.pinValue || ''} onChange={e => updateBlock(selectedBlock.id, { pinValue: e.target.value.replace(/[^0-9*#]/g, '') })} placeholder="1234" className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm font-mono tracking-widest" />
                  <p className="text-[10px] text-[#786D60] mt-1">Digits, * and # only. Terminator (#) appended automatically for burst formats.</p>
                </div>
                <div>
                  <label className="text-xs text-[#786D60] block mb-1">Keypad Format</label>
                  <select value={selectedBlock.keypadFormat || '4bit'} onChange={e => updateBlock(selectedBlock.id, { keypadFormat: e.target.value as KeypadFormat })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">
                    <option value="4bit">4-bit Packed (burst)</option>
                    <option value="8bit">8-bit ASCII (burst)</option>
                    <option value="8bit-wiegand">8-bit Wiegand / Farpointe (burst)</option>
                    <option value="26bit">26-bit Single Packet (whole PIN as card)</option>
                  </select>
                </div>
                {selectedBlock.keypadFormat === '26bit' && (
                  <div>
                    <label className="text-xs text-[#786D60] block mb-1">Facility Code (for 26-bit)</label>
                    <input type="number" value={selectedBlock.facilityCode || 0} onChange={e => updateBlock(selectedBlock.id, { facilityCode: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                  </div>
                )}
              </>
            ) : (
              <>
                <div><label className="text-xs text-[#786D60] block mb-1">Mode</label><div className="grid grid-cols-2 gap-1">{['single','range'].map(mode => <button key={mode} onClick={() => updateBlock(selectedBlock.id, { mode: mode as any })} className={`px-2 py-1.5 rounded text-xs capitalize ${selectedBlock.mode === mode ? 'bg-[#F0A73C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{mode}</button>)}</div></div>
                <div><label className="text-xs text-[#786D60] block mb-1">Format</label><select value={selectedBlock.format || '26'} onChange={e => updateBlock(selectedBlock.id, { format: e.target.value })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{cardFormats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
                {selectedBlock.mode === 'single' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="text-xs text-[#786D60] block mb-1">Facility Code</label><input type="number" value={selectedBlock.facilityCode || 0} onChange={e => updateBlock(selectedBlock.id, { facilityCode: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                    <div><label className="text-xs text-[#786D60] block mb-1">Card Number</label><input type="number" value={selectedBlock.cardNumber || 0} onChange={e => updateBlock(selectedBlock.id, { cardNumber: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                  </div>
                ) : (
                  <>
                    <div><label className="text-xs text-[#786D60] block mb-1">Sequence Mode</label><select value={selectedBlock.sequenceMode || 'sequential'} onChange={e => updateBlock(selectedBlock.id, { sequenceMode: e.target.value as CardSequenceMode })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"><option value="sequential">Sequential</option><option value="increment_cn">Increment CN only</option><option value="increment_fc">Increment FC only</option><option value="increment_both">Increment both</option><option value="random">Random from range</option><option value="replay">Replay same card N times</option><option value="invalid">Invalid/Out of range</option></select></div>
                    <div className="grid grid-cols-2 gap-2">
                      <div><label className="text-xs text-[#786D60] block mb-1">FC Start</label><input type="number" value={selectedBlock.facilityStart || 0} onChange={e => updateBlock(selectedBlock.id, { facilityStart: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                      <div><label className="text-xs text-[#786D60] block mb-1">FC End</label><input type="number" value={selectedBlock.facilityEnd || 0} onChange={e => updateBlock(selectedBlock.id, { facilityEnd: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div><label className="text-xs text-[#786D60] block mb-1">CN Start</label><input type="number" value={selectedBlock.cardStart || 0} onChange={e => updateBlock(selectedBlock.id, { cardStart: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                      <div><label className="text-xs text-[#786D60] block mb-1">CN End</label><input type="number" value={selectedBlock.cardEnd || 0} onChange={e => updateBlock(selectedBlock.id, { cardEnd: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                    </div>
                    {(selectedBlock.sequenceMode === 'random' || selectedBlock.sequenceMode === 'replay') && <div><label className="text-xs text-[#786D60] block mb-1">Card Count</label><input type="number" value={selectedBlock.cardCount || 10} onChange={e => updateBlock(selectedBlock.id, { cardCount: parseInt(e.target.value) || 10 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>}
                    <div><label className="text-xs text-[#786D60] block mb-1">Delay Between Cards (ms)</label><input type="number" value={selectedBlock.delayBetweenCards || 500} onChange={e => updateBlock(selectedBlock.id, { delayBetweenCards: parseInt(e.target.value) || 500 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {selectedBlock.type === 'door' && (
          <>
            <div><label className="text-xs text-[#786D60] block mb-1">Door</label><select value={selectedBlock.doorId || 1} onChange={e => updateBlock(selectedBlock.id, { doorId: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{doors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div><label className="text-xs text-[#786D60] block mb-1">Event</label><select value={selectedBlock.eventType || 'lock'} onChange={e => updateBlock(selectedBlock.id, { eventType: e.target.value as any })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"><option value="lock">Lock</option><option value="dps">DPS</option><option value="rexIn">REX</option></select></div>
            <div><label className="text-xs text-[#786D60] block mb-1">Action</label><div className="grid grid-cols-3 gap-1">{['activate','deactivate','pulse'].map(action => <button key={action} onClick={() => updateBlock(selectedBlock.id, { action: action as any })} className={`px-2 py-1.5 rounded text-xs capitalize ${selectedBlock.action === action ? action === 'activate' ? 'bg-[#4F8B5C]' : action === 'deactivate' ? 'bg-[#C6604F]' : 'bg-[#5E86B8]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{action}</button>)}</div></div>
            {selectedBlock.action === 'pulse' && <div><label className="text-xs text-[#786D60] block mb-1">Pulse Duration (ms)</label><input type="number" value={selectedBlock.pulseDuration || 500} onChange={e => updateBlock(selectedBlock.id, { pulseDuration: parseInt(e.target.value) || 500 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>}
          </>
        )}

        {selectedBlock.type === 'io' && (
          <>
            <div><label className="text-xs text-[#786D60] block mb-1">Type</label><select value={selectedBlock.ioType || 'output'} onChange={e => updateBlock(selectedBlock.id, { ioType: e.target.value as any, ioId: 1 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"><option value="output">Pi GPIO Output</option><option value="controller">Controller Input (simulate)</option><option value="input">Pi GPIO Input (read)</option></select></div>
            {selectedBlock.ioType === 'controller' ? (
              (() => {
                const currentAddr = Math.floor((selectedBlock.ioId || 0) / 100);
                const items = controllerItemsForBoard(currentAddr, 'input');
                return (
                  <>
                    <div>
                      <label className="text-xs text-[#786D60] block mb-1">Board</label>
                      <select
                        value={currentAddr || ''}
                        onChange={e => {
                          const addr = parseInt(e.target.value) || 0;
                          const first = controllerItemsForBoard(addr, 'input')[0];
                          updateBlock(selectedBlock.id, { ioId: first ? first.id : addr * 100 });
                        }}
                        className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"
                      >
                        {controllerBoards.length === 0 && <option value="">— no boards (start Controller Emulator) —</option>}
                        {controllerBoards.length > 0 && !currentAddr && <option value="">— pick a board —</option>}
                        {controllerBoards.map(b => (
                          <option key={b.address} value={b.address}>{b.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-[#786D60] block mb-1">Input (simulated)</label>
                      <select
                        value={currentAddr ? (selectedBlock.ioId || items[0]?.id || '') : ''}
                        onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })}
                        disabled={!currentAddr || items.length === 0}
                        className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm disabled:opacity-50"
                      >
                        {items.length === 0 && <option value="">— no inputs on this board —</option>}
                        {items.map(io => (
                          <option key={io.id} value={io.id}>
                            Input {io.id % 100}{io.active ? '  ●' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                );
              })()
            ) : (
              <div><label className="text-xs text-[#786D60] block mb-1">Select</label><select value={selectedBlock.ioId || 1} onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{(selectedBlock.ioType === 'output' ? outputs : inputs).map(io => <option key={io.id} value={io.id}>{io.name}</option>)}</select></div>
            )}
            {selectedBlock.ioType !== 'input' && (
              <>
                <div><label className="text-xs text-[#786D60] block mb-1">Action</label><div className="grid grid-cols-3 gap-1">{['activate','deactivate','pulse'].map(action => <button key={action} onClick={() => updateBlock(selectedBlock.id, { action: action as any })} className={`px-2 py-1.5 rounded text-xs capitalize ${selectedBlock.action === action ? action === 'activate' ? 'bg-[#4F8B5C]' : action === 'deactivate' ? 'bg-[#C6604F]' : 'bg-[#5E86B8]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{action}</button>)}</div></div>
                {selectedBlock.action === 'pulse' && <div><label className="text-xs text-[#786D60] block mb-1">Pulse Duration (ms)</label><input type="number" value={selectedBlock.pulseDuration || 500} onChange={e => updateBlock(selectedBlock.id, { pulseDuration: parseInt(e.target.value) || 500 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>}
              </>
            )}
          </>
        )}

        {selectedBlock.type === 'wait' && (
          <>
            <div>
              <label className="text-xs text-[#786D60] block mb-1">Wait Type</label>
              <select value={selectedBlock.waitType || 'seconds'} onChange={e => updateBlock(selectedBlock.id, { waitType: e.target.value as any })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
                <option value="random">Random (seconds)</option>
                <option value="until_time">Until Clock Time</option>
              </select>
            </div>
            {selectedBlock.waitType === 'until_time' ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-[#786D60] block mb-1">Time (24h)</label>
                    <input type="time" value={selectedBlock.waitUntilTime || ''} onChange={e => updateBlock(selectedBlock.id, { waitUntilTime: e.target.value })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-[#786D60] block mb-1">Date (optional)</label>
                    <input type="date" value={selectedBlock.waitUntilDate || ''} onChange={e => updateBlock(selectedBlock.id, { waitUntilDate: e.target.value || undefined })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                  </div>
                </div>
                <p className="text-[10px] text-[#786D60] -mt-2">Leave date blank to wait for the next occurrence of this time (today, or tomorrow if already past).</p>
              </>
            ) : selectedBlock.waitType === 'random' ? (
              <div className="grid grid-cols-2 gap-2">
                <div><label className="text-xs text-[#786D60] block mb-1">Min (sec)</label><input type="number" value={selectedBlock.waitMin || 1} onChange={e => updateBlock(selectedBlock.id, { waitMin: parseInt(e.target.value) || 1 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
                <div><label className="text-xs text-[#786D60] block mb-1">Max (sec)</label><input type="number" value={selectedBlock.waitMax || 5} onChange={e => updateBlock(selectedBlock.id, { waitMax: parseInt(e.target.value) || 5 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
              </div>
            ) : (
              <div><label className="text-xs text-[#786D60] block mb-1">Duration</label><input type="number" value={selectedBlock.waitValue || 5} onChange={e => updateBlock(selectedBlock.id, { waitValue: parseInt(e.target.value) || 5 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
            )}
          </>
        )}

        {selectedBlock.type === 'schedule' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-[#786D60] block mb-1">Time (24h)</label>
                <input type="time" value={selectedBlock.scheduleTime || ''} onChange={e => updateBlock(selectedBlock.id, { scheduleTime: e.target.value })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-[#786D60] block mb-1">Date (optional)</label>
                <input type="date" value={selectedBlock.scheduleDate || ''} onChange={e => updateBlock(selectedBlock.id, { scheduleDate: e.target.value || undefined })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
              </div>
            </div>
            <p className="text-[10px] text-[#786D60]">Holds workflow execution until the scheduled time. Place at the start of a workflow to schedule when it runs. Leave date blank for next occurrence.</p>
            <div className="bg-[#F0A73C]/15 border border-[#F0A73C]/40 rounded p-2 text-[11px] text-[#F3ECE3]">
              💡 Schedules can be paused, resumed, and stopped like any other block. Workflow runs in foreground while waiting.
            </div>
          </>
        )}

        {selectedBlock.type === 'control' && (
          <>
            <div>
              <label className="text-xs text-[#786D60] block mb-1">Control Type</label>
              <select
                value={selectedBlock.controlType || 'stop'}
                onChange={e => {
                  const ct = e.target.value;
                  const updates: Partial<WorkflowBlock> = { controlType: ct as any };
                  // FIX: initialize loopToColumn to 0 when first switching to 'loop'
                  // so the runtime ?? 0 fallback isn't needed and the block label shows correctly
                  if (ct === 'loop' && selectedBlock.loopToColumn === undefined) {
                    updates.loopToColumn = 0;
                  }
                  updateBlock(selectedBlock.id, updates);
                }}
                className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"
              >
                <option value="stop">Stop Workflow</option>
                <option value="loop">Loop to Column</option>
              </select>
            </div>
            {selectedBlock.controlType === 'loop' && (
              <div>
                <label className="text-xs text-[#786D60] block mb-1">Loop to Column</label>
                <select
                  value={selectedBlock.loopToColumn ?? 0}
                  onChange={e => updateBlock(selectedBlock.id, { loopToColumn: parseInt(e.target.value) })}
                  className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"
                >
                  {workflow.slice(0, workflow.findIndex(c => c.blocks.some(b => b.id === selectedBlock.id))).map((_, idx) => (
                    <option key={idx} value={idx}>Column {idx + 1}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        {selectedBlock.type === 'waitInput' && (
          <>
            <div><label className="text-xs text-[#786D60] block mb-1">Input Type</label><select value={selectedBlock.waitInputType || 'input'} onChange={e => updateBlock(selectedBlock.id, { waitInputType: e.target.value as any, waitInputId: 1 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"><option value="input">General Input (local)</option><option value="controller_input">Controller Input (emulated)</option><option value="controller_output">Controller Output (emulated, monitor)</option><option value="door_dps">Door DPS</option><option value="door_rex">Door REX</option></select></div>
            {(selectedBlock.waitInputType === 'controller_input' || selectedBlock.waitInputType === 'controller_output') ? (() => {
              const kind: 'input' | 'output' = selectedBlock.waitInputType === 'controller_output' ? 'output' : 'input';
              const currentAddr = Math.floor((selectedBlock.waitInputId || 0) / 100);
              const items = controllerItemsForBoard(currentAddr, kind);
              return (
                <>
                  <div>
                    <label className="text-xs text-[#786D60] block mb-1">Board</label>
                    <select
                      value={currentAddr || ''}
                      onChange={e => {
                        const addr = parseInt(e.target.value) || 0;
                        const first = controllerItemsForBoard(addr, kind)[0];
                        updateBlock(selectedBlock.id, { waitInputId: first ? first.id : addr * 100 });
                      }}
                      className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"
                    >
                      {controllerBoards.length === 0 && <option value="">— no boards (start Controller Emulator) —</option>}
                      {controllerBoards.length > 0 && !currentAddr && <option value="">— pick a board —</option>}
                      {controllerBoards.map(b => (
                        <option key={b.address} value={b.address}>{b.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#786D60] block mb-1">
                      {kind === 'output' ? 'Output' : 'Input'} <span className="text-[#786D60]">{kind === 'output' ? '— IC2-driven, read-only' : '— settable'}</span>
                    </label>
                    <select
                      value={currentAddr ? (selectedBlock.waitInputId || items[0]?.id || '') : ''}
                      onChange={e => updateBlock(selectedBlock.id, { waitInputId: parseInt(e.target.value) })}
                      disabled={!currentAddr || items.length === 0}
                      className={`w-full bg-[#15110B] border rounded px-3 py-2 text-sm disabled:opacity-50 ${kind === 'output' ? 'border-[#F0A73C]/40' : 'border-[#5FB7B0]/40'}`}
                    >
                      {items.length === 0 && <option value="">— none on this board —</option>}
                      {items.map(io => (
                        <option key={io.id} value={io.id}>{kind === 'output' ? 'Output' : 'Input'} {io.id % 100}</option>
                      ))}
                    </select>
                  </div>
                </>
              );
            })()
            : selectedBlock.waitInputType === 'input' ? <div><label className="text-xs text-[#786D60] block mb-1">Input</label><select value={selectedBlock.waitInputId || 1} onChange={e => updateBlock(selectedBlock.id, { waitInputId: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{inputs.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
            : <div><label className="text-xs text-[#786D60] block mb-1">Door</label><select value={selectedBlock.waitInputDoorId || 1} onChange={e => updateBlock(selectedBlock.id, { waitInputDoorId: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{doors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>}
            <div><label className="text-xs text-[#786D60] block mb-1">Wait For State</label><div className="grid grid-cols-3 gap-1">{['high','low','any_change'].map(state => <button key={state} onClick={() => updateBlock(selectedBlock.id, { waitInputState: state as any })} className={`px-2 py-1.5 rounded text-xs ${selectedBlock.waitInputState === state ? 'bg-[#4F9E97]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{state === 'any_change' ? 'Change' : state.toUpperCase()}</button>)}</div></div>
            <div><label className="text-xs text-[#786D60] block mb-1">Timeout (ms, 0=infinite)</label><input type="number" value={selectedBlock.waitInputTimeout || 0} onChange={e => updateBlock(selectedBlock.id, { waitInputTimeout: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-[#786D60] block mb-1">On Timeout</label><select value={selectedBlock.waitInputTimeoutAction || 'continue'} onChange={e => updateBlock(selectedBlock.id, { waitInputTimeoutAction: e.target.value as any })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm"><option value="continue">Continue</option><option value="stop">Stop Workflow</option><option value="skip">Skip to Next Column</option></select></div>
          </>
        )}

        {selectedBlock.type === 'log' && (
          <>
            <div><label className="text-xs text-[#786D60] block mb-1">Type</label><div className="grid grid-cols-2 gap-1"><button onClick={() => updateBlock(selectedBlock.id, { assertCondition: false })} className={`px-2 py-1.5 rounded text-xs ${!selectedBlock.assertCondition ? 'bg-[#322A22]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>📝 Log/Marker</button><button onClick={() => updateBlock(selectedBlock.id, { assertCondition: true })} className={`px-2 py-1.5 rounded text-xs ${selectedBlock.assertCondition ? 'bg-[#4F8B5C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>✓ Assertion</button></div></div>
            <div><label className="text-xs text-[#786D60] block mb-1">Message</label><input type="text" value={selectedBlock.logMessage || ''} onChange={e => updateBlock(selectedBlock.id, { logMessage: e.target.value })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" placeholder="Enter message..." /></div>
            {!selectedBlock.assertCondition ? (
              <div><label className="text-xs text-[#786D60] block mb-1">Level</label><div className="grid grid-cols-5 gap-1">{['info','success','warning','error','marker'].map(level => <button key={level} onClick={() => updateBlock(selectedBlock.id, { logLevel: level as any })} className={`px-1 py-1.5 rounded text-xs ${selectedBlock.logLevel === level ? level === 'success' ? 'bg-[#4F8B5C]' : level === 'warning' ? 'bg-[#C79A34]' : level === 'error' ? 'bg-[#C6604F]' : level === 'marker' ? 'bg-[#F0A73C]' : 'bg-[#5E86B8]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{level === 'info' ? '📝' : level === 'success' ? '✅' : level === 'warning' ? '⚠️' : level === 'error' ? '❌' : '📍'}</button>)}</div></div>
            ) : (
              <>
                <div><label className="text-xs text-[#786D60] block mb-1">Assert Input</label><select value={selectedBlock.assertInputId || 1} onChange={e => updateBlock(selectedBlock.id, { assertInputId: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{[...inputs, ...controllerInputs, ...controllerOutputs.filter(o => o.id >= 100)].map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
                <div><label className="text-xs text-[#786D60] block mb-1">Expected State</label><div className="grid grid-cols-2 gap-1">{['high','low'].map(state => <button key={state} onClick={() => updateBlock(selectedBlock.id, { assertInputState: state as any })} className={`px-2 py-1.5 rounded text-xs ${selectedBlock.assertInputState === state ? 'bg-[#4F8B5C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{state.toUpperCase()}</button>)}</div></div>
              </>
            )}
          </>
        )}

        {selectedBlock.type === 'supervision' && (
          <>
            <div><label className="text-xs text-[#786D60] block mb-1">Input</label><select value={selectedBlock.supervisionInputId || 1} onChange={e => updateBlock(selectedBlock.id, { supervisionInputId: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">{[...inputs, ...controllerInputs, ...controllerOutputs.filter(o => o.id >= 100)].map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
            <div><label className="text-xs text-[#786D60] block mb-1">Supervision State</label><div className="grid grid-cols-2 gap-1">{(['normal','short','open','trouble'] as SupervisionState[]).map(state => <button key={state} onClick={() => updateBlock(selectedBlock.id, { supervisionState: state })} className={`px-2 py-1.5 rounded text-xs capitalize ${selectedBlock.supervisionState === state ? state === 'normal' ? 'bg-[#4F8B5C]' : 'bg-[#F0A73C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{state === 'normal' ? '✓ Normal' : state === 'short' ? '⚡ Short' : state === 'open' ? '✂️ Open' : '⚠️ Trouble'}</button>)}</div></div>
            <div><label className="text-xs text-[#786D60] block mb-1">Duration (ms, 0=permanent)</label><input type="number" value={selectedBlock.supervisionDuration || 0} onChange={e => updateBlock(selectedBlock.id, { supervisionDuration: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div>
          </>
        )}

        {selectedBlock.type === 'scenario' && (
          <>
            {/* ── Scenario selector ── */}
            <div><label className="text-xs text-[#786D60] block mb-1">Scenario Type</label>
              <div className="space-y-1">{(Object.entries(SCENARIO_TEMPLATES) as [ScenarioType, typeof SCENARIO_TEMPLATES[ScenarioType]][]).map(([type, info]) => (
                <button key={type} onClick={() => updateBlock(selectedBlock.id, { scenarioType: type })}
                  className={`w-full px-3 py-2 rounded text-left text-xs ${selectedBlock.scenarioType === type ? 'bg-[#4E9E74]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>
                  <div className="flex items-center gap-2">{info.icon}<span className="font-medium">{info.name}</span></div>
                  <div className="text-[#786D60] mt-0.5 pl-6">{info.description}</div>
                </button>
              ))}</div>
            </div>

            {/* ── Common I/O ── */}
            <div className="pt-2 border-t border-[#38302A]">
              <div className="text-[10px] text-[#786D60] uppercase tracking-wider mb-2">Card / Reader</div>
              <div><label className="text-xs text-[#786D60] block mb-1">Reader</label>
{(() => {
                  const emuR = readerPool.filter(r => r.type === 'controller-emulator');
                  const otherR = readerPool.filter(r => r.type !== 'controller-emulator');
                  const sel = readerPool.find(r => r.id === selectedBlock.scenarioReaderId);
                  const selEmu = sel?.type === 'controller-emulator';
                  const boards = Array.from(new Map(emuR.map(r => [r.address, { address: r.address, model: r.model }])).values()).sort((a,b)=>(a.address??0)-(b.address??0));
                  const topV = selEmu ? `emu:${sel?.address}` : (selectedBlock.scenarioReaderId || '');
                  const onTop = (v) => { if (v.startsWith('emu:')) { const a = parseInt(v.slice(4),10); const f = emuR.filter(r=>r.address===a).sort((x,y)=>(x.port??0)-(y.port??0))[0]; if (f) updateBlock(selectedBlock.id, { scenarioReaderId: f.id }); } else updateBlock(selectedBlock.id, { scenarioReaderId: v }); };
                  const ports = selEmu ? emuR.filter(r=>r.address===sel?.address).sort((x,y)=>(x.port??0)-(y.port??0)) : [];
                  return (<>
                    <select value={topV} onChange={e=>onTop(e.target.value)} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">
                      {otherR.length>0 && <optgroup label="Physical / OSDP">{otherR.map(r=><option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}</optgroup>}
                      {boards.length>0 && <optgroup label="Emulated Controllers">{boards.map(b=><option key={`emu:${b.address}`} value={`emu:${b.address}`}>#{b.address} {b.model}</option>)}</optgroup>}
                    </select>
                    {selEmu && ports.length>0 && (
                      <select value={selectedBlock.scenarioReaderId || ''} onChange={e=>updateBlock(selectedBlock.id,{ scenarioReaderId: e.target.value })} className="w-full mt-1.5 bg-[#15110B] border border-[#F0A73C]/40 rounded px-3 py-2 text-sm">
                        {ports.map(r=><option key={r.id} value={r.id}>Reader {r.port}</option>)}
                      </select>
                    )}
                  </>);
                })()}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div><label className="text-xs text-[#786D60] block mb-1">Facility Code</label>
                  <input type="number" value={selectedBlock.scenarioFacilityCode ?? 100} onChange={e => updateBlock(selectedBlock.id, { scenarioFacilityCode: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                </div>
                <div><label className="text-xs text-[#786D60] block mb-1">Card Number</label>
                  <input type="number" value={selectedBlock.scenarioCardNumber ?? 1234} onChange={e => updateBlock(selectedBlock.id, { scenarioCardNumber: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-[#38302A]">
              <div className="text-[10px] text-[#786D60] uppercase tracking-wider mb-1">I/O Mapping</div>
              <div className="text-[10px] text-[#5E5449] mb-2">
                <span className="text-[#5FB7B0]">◀ Inputs</span> = Triggers from ACS Panel &nbsp;|&nbsp;
                <span className="text-[#D9B24E]">▶ Outputs</span> = Triggers TO ACS Panel
              </div>

              {/* I/O Source toggle — physical GPIO rig OR emulated controller */}
              <div className="mb-2">
                <label className="text-xs text-[#786D60] block mb-1">I/O Source</label>
                <div className="grid grid-cols-2 gap-1">
                  {(['physical','emulated'] as const).map(src => (
                    <button key={src} onClick={() => updateBlock(selectedBlock.id, { scenarioIoSource: src })}
                      className={`px-2 py-1.5 rounded text-xs ${ (selectedBlock.scenarioIoSource || 'physical') === src ? 'bg-[#4E9E74]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>
                      {src === 'physical' ? 'Physical GPIO rig' : 'Emulated controller'}
                    </button>
                  ))}
                </div>
              </div>

              {(selectedBlock.scenarioIoSource || 'physical') === 'emulated' && (
                <div className="bg-[#4E9E74]/15 border border-[#4E9E74]/40 rounded p-2 mb-2">
                  <div className="text-[10px] text-[#63B98F] mb-1.5">Emulated board — channels map to that board\'s inputs (drive) / outputs (read)</div>
                  <div><label className="text-xs text-[#786D60] block mb-1">Board</label>
                    <select value={selectedBlock.scenarioEmuBoard ?? ''} onChange={e => updateBlock(selectedBlock.id, { scenarioEmuBoard: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#4E9E74]/60 rounded px-2 py-1.5 text-xs">
                      {controllerBoards.length === 0 && <option value="">— no boards (start Controller Emulator) —</option>}
                      {controllerBoards.length > 0 && <option value="">— pick a board —</option>}
                      {controllerBoards.map(b => <option key={b.address} value={b.address}>{b.label}</option>)}
                    </select>
                  </div>
                </div>
              )}

              {(() => {
                // Ranges must match REALITY. Physical rig = fixed 8 opto/8 relay.
                // Emulated = the SELECTED board's actual numInputs/numOutputs
                // (RI2MS=6in/4out, RI4S=12in/8out, IO168S=16in/8out). Using a
                // hardcoded 0-11 was the bug: e.g. DPS default index 6 on a
                // RI2MS (inputs 0-5) silently failed — input never changed.
                const emu = (selectedBlock.scenarioIoSource || 'physical') === 'emulated';
                const addr = selectedBlock.scenarioEmuBoard ?? 0;
                const outItems = emu ? controllerItemsForBoard(addr, 'output') : [];
                const inItems  = emu ? controllerItemsForBoard(addr, 'input')  : [];
                const readOpts = emu
                  ? outItems.map(io => ({ v: io.id % 100, label: `Output ${io.id % 100}` }))
                  : [0,1,2,3,4,5,6,7].map(i => ({ v: i, label: `Opto ${i}` }));
                const driveOpts = emu
                  ? inItems.map(io => ({ v: io.id % 100, label: `Input ${io.id % 100}` }))
                  : [0,1,2,3,4,5,6,7].map(i => ({ v: i, label: `Relay ${i}` }));
                const noBoard = emu && !addr;
                const noRead = emu && addr && readOpts.length === 0;
                const noDrive = emu && addr && driveOpts.length === 0;
                return (
                  <>
                    <div className="bg-[#4F9E97]/15 border border-[#4F9E97]/40 rounded p-2 mb-2">
                      <div className="text-[10px] text-[#5FB7B0] mb-1.5">◀ READS FROM PANEL ({emu ? `board Outputs${addr ? ` · ${readOpts.length} available` : ''}` : 'Opto Inputs'})</div>
                      {noBoard ? <div className="text-[11px] text-[#F0A73C]">Select an emulated board above first.</div>
                       : noRead ? <div className="text-[11px] text-[#F0A73C]">This board has no outputs.</div>
                       : <div className="grid grid-cols-2 gap-2">
                          <div><label className="text-xs text-[#786D60] block mb-1">Lock Signal</label>
                            <select value={selectedBlock.scenarioLockInput ?? readOpts[0]?.v ?? 0} onChange={e => updateBlock(selectedBlock.id, { scenarioLockInput: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#4F9E97]/60 rounded px-2 py-1.5 text-xs">
                              {readOpts.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                            </select>
                          </div>
                          <div><label className="text-xs text-[#786D60] block mb-1">Alarm Signal</label>
                            <select value={selectedBlock.scenarioAlarmInput ?? readOpts[1]?.v ?? readOpts[0]?.v ?? 0} onChange={e => updateBlock(selectedBlock.id, { scenarioAlarmInput: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#4F9E97]/60 rounded px-2 py-1.5 text-xs">
                              {readOpts.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                            </select>
                          </div>
                        </div>}
                    </div>
                    <div className="bg-[#C79A34]/15 border border-[#C79A34]/40 rounded p-2 mb-2">
                      <div className="text-[10px] text-[#D9B24E] mb-1.5">▶ DRIVES TO PANEL ({emu ? `board Inputs${addr ? ` · ${driveOpts.length} available` : ''}` : 'Relay Outputs'})</div>
                      {noBoard ? <div className="text-[11px] text-[#F0A73C]">Select an emulated board above first.</div>
                       : noDrive ? <div className="text-[11px] text-[#F0A73C]">This board has no inputs.</div>
                       : <div className="grid grid-cols-2 gap-2">
                          <div><label className="text-xs text-[#786D60] block mb-1">DPS Contact</label>
                            <select value={selectedBlock.scenarioDpsRelay ?? driveOpts[0]?.v ?? 0} onChange={e => updateBlock(selectedBlock.id, { scenarioDpsRelay: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#C79A34]/60 rounded px-2 py-1.5 text-xs">
                              {driveOpts.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                            </select>
                          </div>
                          <div><label className="text-xs text-[#786D60] block mb-1">REX Contact</label>
                            <select value={selectedBlock.scenarioRexRelay ?? driveOpts[1]?.v ?? driveOpts[0]?.v ?? 0} onChange={e => updateBlock(selectedBlock.id, { scenarioRexRelay: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#C79A34]/60 rounded px-2 py-1.5 text-xs">
                              {driveOpts.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                            </select>
                          </div>
                        </div>}
                    </div>
                  </>
                );
              })()}

              <div><label className="text-xs text-[#786D60] block mb-1">Panel Response Timeout (ms)</label>
                <input type="number" value={selectedBlock.scenarioVerifyTimeoutMs ?? 3000} onChange={e => updateBlock(selectedBlock.id, { scenarioVerifyTimeoutMs: parseInt(e.target.value) || 3000 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
              </div>
            </div>

            {/* ── Denied access: bad card config ── */}
            {(selectedBlock.scenarioType === 'denied_access') && (
              <div className="pt-2 border-t border-[#38302A]">
                <div className="text-[10px] text-[#786D60] uppercase tracking-wider mb-2">Invalid Card</div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="text-xs text-[#786D60] block mb-1">Bad FC</label>
                    <input type="number" value={selectedBlock.scenarioBadFacilityCode ?? 999} onChange={e => updateBlock(selectedBlock.id, { scenarioBadFacilityCode: parseInt(e.target.value) || 999 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                  </div>
                  <div><label className="text-xs text-[#786D60] block mb-1">Bad CN</label>
                    <input type="number" value={selectedBlock.scenarioBadCardNumber ?? 99999} onChange={e => updateBlock(selectedBlock.id, { scenarioBadCardNumber: parseInt(e.target.value) || 99999 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                  </div>
                </div>
              </div>
            )}

            {/* Held door: additional held time config */}
            {selectedBlock.scenarioType === 'held_door' && (
              <div className="pt-2 border-t border-[#38302A]">
                <div><label className="text-xs text-[#786D60] block mb-1">Held Time (ms)</label>
                  <input type="number" value={selectedBlock.scenarioHeldTime || 31000} onChange={e => updateBlock(selectedBlock.id, { scenarioHeldTime: parseInt(e.target.value) || 31000 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                </div>
              </div>
            )}

            {/* ── Tailgating: up to 5 credentials + delay ── */}
            {selectedBlock.scenarioType === 'tailgating' && (() => {
              const creds = Array.isArray(selectedBlock.scenarioCredentials) && selectedBlock.scenarioCredentials.length > 0
                ? selectedBlock.scenarioCredentials
                : [{ fc: 100, cn: 1234 }, { fc: 100, cn: 5678 }];
              const setCreds = (next: { fc: number; cn: number }[]) =>
                updateBlock(selectedBlock.id, { scenarioCredentials: next });
              return (
                <div className="pt-2 border-t border-[#38302A]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] text-[#786D60] uppercase tracking-wider">Credentials ({creds.length}/5)</span>
                    {creds.length < 5 && (
                      <button onClick={() => setCreds([...creds, { fc: 100, cn: 1000 + creds.length }])}
                        className="text-[11px] px-2 py-0.5 bg-[#3E7E5C]/50 hover:bg-[#4E9E74]/60 rounded">+ Add</button>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {creds.map((cr, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="text-[10px] text-[#786D60] w-4">{i + 1}</span>
                        <input type="number" value={cr.fc} placeholder="FC"
                          onChange={e => { const n = creds.slice(); n[i] = { ...n[i], fc: parseInt(e.target.value) || 0 }; setCreds(n); }}
                          className="flex-1 bg-[#15110B] border border-[#38302A] rounded px-2 py-1 text-xs" />
                        <input type="number" value={cr.cn} placeholder="CN"
                          onChange={e => { const n = creds.slice(); n[i] = { ...n[i], cn: parseInt(e.target.value) || 0 }; setCreds(n); }}
                          className="flex-1 bg-[#15110B] border border-[#38302A] rounded px-2 py-1 text-xs" />
                        {creds.length > 1 && (
                          <button onClick={() => setCreds(creds.filter((_, j) => j !== i))}
                            className="px-1.5 py-1 text-[#786D60] hover:text-[#F07A6C] hover:bg-[#C6604F]/15 rounded" title="Remove">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2"><label className="text-xs text-[#786D60] block mb-1">Delay Between Presentations (ms)</label>
                    <input type="number" value={selectedBlock.scenarioTailgateDelay || 2000} onChange={e => updateBlock(selectedBlock.id, { scenarioTailgateDelay: parseInt(e.target.value) || 2000 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                  </div>
                </div>
              );
            })()}

            {/* ── Anti-passback: second card ── */}
            {selectedBlock.scenarioType === 'anti_passback' && (
              <div className="pt-2 border-t border-[#38302A]">
                <div className="text-[10px] text-[#F0A73C] mb-2">⚠️ Anti-passback must be enabled on the panel</div>
                <div><label className="text-xs text-[#786D60] block mb-1">Delay Between Presentations (ms)</label>
                  <input type="number" value={selectedBlock.scenarioApbDelay ?? 3000} onChange={e => updateBlock(selectedBlock.id, { scenarioApbDelay: parseInt(e.target.value) || 3000 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
                </div>
              </div>
            )}

            {/* ── Interlock: second door/reader ── */}
            {selectedBlock.scenarioType === 'interlock' && (
              <div className="pt-2 border-t border-[#38302A]">
                <div className="text-[10px] text-[#786D60] uppercase tracking-wider mb-2">Door 2 Config</div>
                <div><label className="text-xs text-[#786D60] block mb-1">Reader 2</label>
{(() => {
                  const emuR = readerPool.filter(r => r.type === 'controller-emulator');
                  const otherR = readerPool.filter(r => r.type !== 'controller-emulator');
                  const sel = readerPool.find(r => r.id === selectedBlock.scenarioReader2Id);
                  const selEmu = sel?.type === 'controller-emulator';
                  const boards = Array.from(new Map(emuR.map(r => [r.address, { address: r.address, model: r.model }])).values()).sort((a,b)=>(a.address??0)-(b.address??0));
                  const topV = selEmu ? `emu:${sel?.address}` : (selectedBlock.scenarioReader2Id || '');
                  const onTop = (v) => { if (v.startsWith('emu:')) { const a = parseInt(v.slice(4),10); const f = emuR.filter(r=>r.address===a).sort((x,y)=>(x.port??0)-(y.port??0))[0]; if (f) updateBlock(selectedBlock.id, { scenarioReader2Id: f.id }); } else updateBlock(selectedBlock.id, { scenarioReader2Id: v }); };
                  const ports = selEmu ? emuR.filter(r=>r.address===sel?.address).sort((x,y)=>(x.port??0)-(y.port??0)) : [];
                  return (<>
                    <select value={topV} onChange={e=>onTop(e.target.value)} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm">
                      {otherR.length>0 && <optgroup label="Physical / OSDP">{otherR.map(r=><option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}</optgroup>}
                      {boards.length>0 && <optgroup label="Emulated Controllers">{boards.map(b=><option key={`emu:${b.address}`} value={`emu:${b.address}`}>#{b.address} {b.model}</option>)}</optgroup>}
                    </select>
                    {selEmu && ports.length>0 && (
                      <select value={selectedBlock.scenarioReader2Id || ''} onChange={e=>updateBlock(selectedBlock.id,{ scenarioReader2Id: e.target.value })} className="w-full mt-1.5 bg-[#15110B] border border-[#F0A73C]/40 rounded px-3 py-2 text-sm">
                        {ports.map(r=><option key={r.id} value={r.id}>Reader {r.port}</option>)}
                      </select>
                    )}
                  </>);
                })()}
                </div>
                {(() => {
                  const emu = (selectedBlock.scenarioIoSource || 'physical') === 'emulated';
                  const d1Board = selectedBlock.scenarioEmuBoard ?? 0;
                  const d2Board = selectedBlock.scenarioDoor2Board ?? 0;
                  const effBoard = d2Board || d1Board;
                  const out2 = emu ? controllerItemsForBoard(effBoard, 'output') : [];
                  const lockOpts = emu
                    ? out2.map(io => ({ v: io.id % 100, label: `Output ${io.id % 100}` }))
                    : [0,1,2,3,4,5,6,7].map(i => ({ v: i, label: `Opto ${i}` }));
                  return (
                    <>
                      {emu && (
                        <div className="mt-2">
                          <label className="text-xs text-[#786D60] block mb-1">Door 2 Board <span className="text-[#786D60]">(default: same as Door 1)</span></label>
                          <select value={selectedBlock.scenarioDoor2Board ?? 0} onChange={e => updateBlock(selectedBlock.id, { scenarioDoor2Board: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-2 py-1.5 text-xs">
                            <option value={0}>Same as Door 1 (#{d1Board || '?'})</option>
                            {controllerBoards.map(b => <option key={b.address} value={b.address}>{b.label}</option>)}
                          </select>
                        </div>
                      )}
                      <div className="mt-2">
                        <label className="text-xs text-[#6FC7C0] block mb-1">◀ Door 2 Lock {emu ? `Output (#${effBoard || '?'})` : 'Signal (Opto)'}</label>
                        <select value={selectedBlock.scenarioLock2Input ?? lockOpts[0]?.v ?? 0} onChange={e => updateBlock(selectedBlock.id, { scenarioLock2Input: parseInt(e.target.value) })} className="w-full bg-[#15110B] border border-[#4F9E97]/60 rounded px-2 py-1.5 text-xs">
                          {lockOpts.length === 0 && <option value="">— no outputs on this board —</option>}
                          {lockOpts.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                        </select>
                      </div>
                    </>
                  );
                })()}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div><label className="text-xs text-[#786D60] block mb-1">Settle Delay (ms)</label>
                    <input type="number" value={selectedBlock.scenarioInterlockSettleMs ?? 1000} onChange={e => updateBlock(selectedBlock.id, { scenarioInterlockSettleMs: parseInt(e.target.value) || 0 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-2 py-1.5 text-xs" />
                  </div>
                  <div><label className="text-xs text-[#786D60] block mb-1">Door 2 Timeout (ms)</label>
                    <input type="number" value={selectedBlock.scenarioInterlockTimeoutMs ?? 3000} onChange={e => updateBlock(selectedBlock.id, { scenarioInterlockTimeoutMs: parseInt(e.target.value) || 3000 })} className="w-full bg-[#15110B] border border-[#38302A] rounded px-2 py-1.5 text-xs" />
                  </div>
                </div>
                <div className="text-[10px] text-[#786D60] mt-1">Settle = pause after Door 1 unlock/relock before each Door 2 attempt. Timeout = how long to wait confirming Door 2 grant/deny.</div>
                <div className="text-[10px] text-[#F0A73C] mt-2">⚠️ Interlock logic must be configured on the panel</div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const filteredBlocks = Object.entries(BLOCK_CONFIG).filter(([_, config]) => paletteCategory === 'all' || config.category === paletteCategory);

  return (
    <div className="h-full flex flex-col text-[#F3ECE3]" style={{ fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif", background: 'radial-gradient(900px 520px at 88% -8%, rgba(240,167,60,.10) 0%, transparent 60%), radial-gradient(700px 500px at 6% 2%, rgba(240,167,60,.045) 0%, transparent 55%), #1B1613' }}>
      <div className="flex-shrink-0 bg-gradient-to-r from-[#241E19] to-[#1B1613] border-b border-[#38302A] px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3"><Database className="w-7 h-7 text-[#F0A73C]" /><div><h2 className="text-xl font-bold">Workflow Builder V2</h2><p className="text-xs text-[#786D60]">9 block types • Horizontal = Sequential • Vertical = Simultaneous</p></div></div>
          <div className="flex items-center gap-3">
            {(testResults.passed > 0 || testResults.failed > 0) && <div className="flex items-center gap-2 px-3 py-1.5 bg-[#15110B] border border-[#38302A] rounded text-sm"><CheckCircle className="w-4 h-4 text-[#6FBF7E]" /><span className="text-[#7BD497]">{testResults.passed}</span><XCircle className="w-4 h-4 text-[#E0705F] ml-2" /><span className="text-[#F07A6C]">{testResults.failed}</span></div>}
            <div className="flex items-center gap-2 text-sm text-[#786D60]">{loadingReaders ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4 text-[#6FBF7E]" />}{readerPool.length} readers<button onClick={loadReadersFromBackend} className="p-1 hover:bg-[#2A231C] rounded"><RefreshCw className="w-3 h-3" /></button></div>
            <button onClick={() => setShowSettings(!showSettings)} className={`p-2 rounded ${showSettings ? 'bg-[#F0A73C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}><Settings className="w-4 h-4" /></button>
            <button onClick={() => setShowSaveDialog(true)} disabled={workflow.length === 0} className="px-3 py-1.5 bg-[#4F8B5C] hover:bg-[#3E6E48] disabled:opacity-50 rounded text-sm flex items-center gap-1"><Save className="w-4 h-4" /> Save</button>
            <button onClick={() => setShowLoadDialog(true)} className="px-3 py-1.5 bg-[#5E86B8] hover:bg-[#4E719C] rounded text-sm flex items-center gap-1"><FolderOpen className="w-4 h-4" /> Load</button>
            <button onClick={() => { setIoError(''); setIoWizardTab(workflow.length > 0 ? 'export' : 'import'); setShowIoWizard(true); }} className="px-3 py-1.5 bg-[#241E19] hover:bg-[#322A22] rounded text-sm flex items-center gap-1" title="Import / Export workflow file"><Download className="w-4 h-4" /> File</button>
            {restoreAvailable && workflow.length === 0 && (
              <button onClick={restoreLastWorkflow} className="px-3 py-1.5 bg-[#F0A73C] hover:bg-[#C9862E] rounded text-sm flex items-center gap-1" title="Restore your last unsaved workflow"><RotateCw className="w-4 h-4" /> Restore Last</button>
            )}
            {isEmulating && <div className="flex items-center gap-2 px-3 py-1.5 bg-[#4F8B5C]/20 border border-[#6FBF7E] rounded"><div className="w-2 h-2 bg-[#6FBF7E] rounded-full animate-pulse" /><span className="text-sm text-[#7BD497]">Column {currentColumnIndex + 1}/{workflow.length}</span></div>}
          </div>
        </div>
        {isEmulating && (
          <div className="mt-3 px-4 py-2.5 bg-[#F0A73C]/15 border border-[#F0A73C]/60 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#F0A73C] flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <span className="font-semibold text-[#FFC66E]">Workflow running — do not leave this page.</span>
              <span className="text-[#FFD9A0]/90"> Execution runs in this browser tab. If you switch pages, refresh, or close the tab, the workflow will continue its current step but the run is lost — you cannot reattach or monitor it again. Click </span>
              <span className="font-semibold text-[#FFE8C8]">Stop</span>
              <span className="text-[#FFD9A0]/90"> before navigating away if you need to leave.</span>
            </div>
          </div>
        )}
        {showSettings && <div className="mt-4 p-4 bg-black/50 rounded-lg border border-[#38302A] flex items-center gap-6"><div className="flex-1"><label className="text-xs text-[#786D60] block mb-1">Delay Between Columns (ms)</label><input type="number" value={globalDelay} onChange={e => setGlobalDelay(Math.max(0, parseInt(e.target.value) || 0))} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" /></div><div className="text-xs text-[#786D60]"><p>💡 Delay added between each column.</p><p>Use <span className="text-[#F0A73C]">Repeat</span> for multiple runs.</p></div></div>}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-52 flex-shrink-0 bg-black/50 border-r border-[#38302A] p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-[#786D60] uppercase tracking-wider">Blocks</h3></div>
          <div className="flex flex-wrap gap-1 mb-3">{(['all','basic','advanced','test'] as const).map(cat => <button key={cat} onClick={() => setPaletteCategory(cat)} className={`px-2 py-1 rounded text-xs capitalize ${paletteCategory === cat ? 'bg-[#F0A73C]' : 'bg-[#2A231C] hover:bg-[#322A22]'}`}>{cat}</button>)}</div>
          <div className="space-y-2">{filteredBlocks.map(([type, config]) => <div key={type} draggable onDragStart={(e) => handleDragStart(e, type as BlockType)} onDragEnd={handleDragEnd} className={`${config.bgColor} rounded-lg p-2.5 cursor-grab active:cursor-grabbing flex items-center gap-2 hover:brightness-110 transition-all shadow-lg`}><div className="bg-[#15110B] rounded p-1">{config.icon}</div><div><span className="font-medium text-sm block">{config.label}</span><span className="text-[10px] opacity-60 capitalize">{config.category}</span></div></div>)}</div>
          <div className="pt-4 border-t border-[#38302A] mt-4"><div className="text-xs text-[#786D60] space-y-1"><p>📌 Drag blocks to canvas</p><p>→ Horizontal = Sequential</p><p>↓ Vertical = Simultaneous</p></div></div>
        </div>

        <div className="flex-1 overflow-auto bg-transparent p-6" ref={canvasRef} onClick={() => setQuickAddPosition(null)}>
          <div className="flex items-start gap-1 min-h-full">
            {workflow.length > 0 && (
              <div className="flex flex-col items-center self-stretch justify-center min-h-[200px] relative">
                <div data-drop-zone onDragOver={handleDragOver} onDragEnter={(e) => handleDragEnterColumn(e, 'new-0', 'before')} onDragLeave={handleDragLeave} onDrop={(e) => handleDropNewColumn(e, 0)} className={`w-16 flex-1 rounded-lg border-2 border-dashed flex items-center justify-center transition-all ${dropTarget?.columnId === 'new-0' ? 'bg-[#F0A73C]/30 border-[#F0A73C] w-32' : 'border-[#38302A] hover:border-[#F0A73C]/50 hover:bg-[#15110B]'}`}>
                  <button onClick={(e) => { e.stopPropagation(); setQuickAddPosition(quickAddPosition === 0 ? null : 0); }} className={`p-2 rounded-lg transition-all ${quickAddPosition === 0 ? 'bg-[#F0A73C] text-[#F3ECE3]' : 'text-[#786D60] hover:text-[#F0A73C] hover:bg-[#F0A73C]/20'}`}><Plus className="w-5 h-5" /></button>
                </div>
                {quickAddPosition === 0 && <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 bg-[#15110B] border border-[#38302A] rounded-lg p-2 shadow-xl" onClick={(e) => e.stopPropagation()}><div className="text-xs text-[#786D60] mb-2 text-center">Add Column</div><div className="grid grid-cols-5 gap-1">{filteredBlocks.map(([type, config]) => <button key={type} onClick={() => { addColumnWithBlock(type as BlockType, 0); setQuickAddPosition(null); }} className={`${config.bgColor} rounded p-2 hover:brightness-125`} title={config.label}>{React.cloneElement(config.icon as React.ReactElement, { className: 'w-4 h-4' })}</button>)}</div></div>}
              </div>
            )}

            {workflow.map((column, colIdx) => (
              <React.Fragment key={column.id}>
                <div data-drop-zone onDragOver={handleDragOver} onDragEnter={(e) => handleDragEnterColumn(e, column.id, 'into')} onDragLeave={handleDragLeave} onDrop={(e) => handleDropOnColumn(e, column.id)} className={`relative flex flex-col gap-2 p-3 rounded-xl border-2 transition-all min-w-[200px] max-w-[280px] ${currentColumnIndex === colIdx ? 'border-[#6FBF7E] bg-[#7BD497]/10 shadow-lg shadow-[#7BD497]/20' : dropTarget?.columnId === column.id && dropTarget.position === 'into' ? 'border-[#F0A73C] bg-[#F0A73C]/15' : selectedColumnId === column.id ? 'border-[#F0A73C]/50 bg-black/50' : 'border-[#38302A] bg-[#15110B] hover:border-[#38302A]'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="bg-[#2A231C] text-[#ADA294] text-xs font-bold px-2 py-0.5 rounded">{colIdx + 1}</span>
                      {column.blocks.length > 1 && <span className="bg-[#F0A73C] text-[#F3ECE3] text-[10px] px-1.5 py-0.5 rounded font-bold">SYNC ×{column.blocks.length}</span>}
                    </div>
                    <button onClick={() => deleteColumn(column.id)} className="p-1 text-[#E0705F] hover:text-[#F07A6C] hover:bg-[#E0705F]/20 rounded"><X className="w-3 h-3" /></button>
                  </div>
                  {column.blocks.map((block) => {
                    const config = getBlockConfig(block.type);
                    const isExecuting = executingBlockIds.has(block.id);
                    const isSelected = selectedBlockId === block.id;
                    return (
                      <div key={block.id} draggable onDragStart={(e) => handleDragStart(e, block.type, column.id, block.id)} onDragEnd={handleDragEnd} onClick={(e) => { e.stopPropagation(); setSelectedBlockId(block.id); setSelectedColumnId(column.id); }} className={`${config.bgColor} rounded-lg p-3 cursor-pointer transition-all ${isExecuting ? 'ring-2 ring-[#7BD497] animate-pulse' : ''} ${isSelected ? 'ring-2 ring-[#F3ECE3] shadow-lg' : ''} hover:brightness-110`}>
                        <div className="flex items-center gap-2 mb-1"><GripVertical className="w-3 h-3 opacity-50 cursor-grab active:cursor-grabbing" />{config.icon}<span className="font-semibold text-sm">{config.label}</span></div>
                        <div className="text-xs opacity-80 truncate pl-5">{getBlockDescription(block)}</div>
                        <div className="flex items-center gap-1 mt-2 pt-2 border-t border-[#F3ECE3]/20">
                          <button onClick={(e) => { e.stopPropagation(); duplicateBlock(column.id, block); }} className="p-1 hover:bg-[#F3ECE3]/20 rounded text-[#F3ECE3]/70 hover:text-[#F3ECE3]"><Copy className="w-3 h-3" /></button>
                          <button onClick={(e) => { e.stopPropagation(); deleteBlock(column.id, block.id); }} className="p-1 hover:bg-[#E0705F]/50 rounded text-[#F3ECE3]/70 hover:text-[#F3ECE3]"><Trash2 className="w-3 h-3" /></button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="mt-1 p-1 border-2 border-dashed border-[#38302A] rounded-lg hover:border-[#F0A73C]">
                    <div className="text-[10px] text-[#786D60] text-center mb-1">+ Simultaneous</div>
                    <div className="flex flex-wrap gap-1 justify-center">{filteredBlocks.slice(0, 5).map(([type, config]) => <button key={type} onClick={() => addBlockToColumn(column.id, type as BlockType)} className={`${config.bgColor} rounded p-1.5 hover:brightness-125 transition-all`} title={`Add ${config.label}`}>{React.cloneElement(config.icon as React.ReactElement, { className: 'w-3 h-3' })}</button>)}</div>
                  </div>
                </div>
                <div className="flex flex-col items-center self-stretch justify-center min-h-[200px] relative">
                  <ChevronRight className="w-6 h-6 text-[#F0A73C] mb-1" />
                  <div data-drop-zone onDragOver={handleDragOver} onDragEnter={(e) => handleDragEnterColumn(e, `new-${colIdx + 1}`, 'after')} onDragLeave={handleDragLeave} onDrop={(e) => handleDropNewColumn(e, colIdx + 1)} className={`w-16 flex-1 rounded-lg border-2 border-dashed flex items-center justify-center transition-all ${dropTarget?.columnId === `new-${colIdx + 1}` ? 'bg-[#F0A73C]/30 border-[#F0A73C] w-32' : 'border-[#38302A] hover:border-[#F0A73C]/50 hover:bg-[#15110B]'}`}>
                    <button onClick={(e) => { e.stopPropagation(); setQuickAddPosition(quickAddPosition === colIdx + 1 ? null : colIdx + 1); }} className={`p-2 rounded-lg transition-all ${quickAddPosition === colIdx + 1 ? 'bg-[#F0A73C] text-[#F3ECE3]' : 'text-[#786D60] hover:text-[#F0A73C] hover:bg-[#F0A73C]/20'}`}><Plus className="w-5 h-5" /></button>
                  </div>
                  {quickAddPosition === colIdx + 1 && <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 bg-[#15110B] border border-[#38302A] rounded-lg p-2 shadow-xl" onClick={(e) => e.stopPropagation()}><div className="text-xs text-[#786D60] mb-2 text-center">Add Column</div><div className="grid grid-cols-5 gap-1">{filteredBlocks.map(([type, config]) => <button key={type} onClick={() => { addColumnWithBlock(type as BlockType, colIdx + 1); setQuickAddPosition(null); }} className={`${config.bgColor} rounded p-2 hover:brightness-125`} title={config.label}>{React.cloneElement(config.icon as React.ReactElement, { className: 'w-4 h-4' })}</button>)}</div></div>}
                </div>
              </React.Fragment>
            ))}

            {workflow.length === 0 && (
              <div data-drop-zone onDragOver={handleDragOver} onDragEnter={(e) => handleDragEnterColumn(e, 'new-0', 'into')} onDragLeave={handleDragLeave} onDrop={(e) => handleDropNewColumn(e, 0)} className={`flex-1 min-h-[400px] border-2 border-dashed rounded-xl flex flex-col items-center justify-center transition-all ${dropTarget ? 'border-[#F0A73C] bg-[#F0A73C]/15' : 'border-[#38302A] hover:border-[#38302A]'}`}>
                <Database className="w-16 h-16 text-[#5E5449] mb-4" />
                <p className="text-[#786D60] text-lg mb-2">Drag blocks here to start</p>
                <p className="text-[#5E5449] text-sm mb-6">or click a block type below</p>
                <div className="flex flex-wrap gap-2 justify-center max-w-lg">{filteredBlocks.map(([type, config]) => <button key={type} onClick={() => addColumnWithBlock(type as BlockType)} className={`${config.bgColor} rounded-lg p-3 hover:brightness-110 flex flex-col items-center gap-1 min-w-[70px]`}>{config.icon}<span className="text-xs font-medium">{config.label}</span></button>)}</div>
                <div className="mt-8 text-xs text-[#5E5449] max-w-md text-center"><p className="mb-2">💡 Horizontal = <span className="text-[#F0A73C]">sequential</span> • Vertical = <span className="text-[#F0A73C]">simultaneous</span></p></div>
              </div>
            )}
          </div>
        </div>

        <div className="w-72 flex-shrink-0 bg-black/50 border-l border-[#38302A] overflow-y-auto">
          {selectedBlock ? (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4"><h3 className="text-sm font-semibold text-[#ADA294] uppercase tracking-wider">{getBlockConfig(selectedBlock.type).label}</h3><button onClick={() => { setSelectedBlockId(null); setSelectedColumnId(null); }} className="p-1 hover:bg-[#2A231C] rounded"><X className="w-4 h-4" /></button></div>
              <div className={`${getBlockConfig(selectedBlock.type).bgColor} rounded-lg p-2 mb-4 flex items-center gap-2`}>{getBlockConfig(selectedBlock.type).icon}<span className="font-medium">{getBlockConfig(selectedBlock.type).label}</span></div>
              {renderBlockEditor()}
              {selectedColumn && <div className="mt-4 pt-4 border-t border-[#38302A]"><button onClick={() => deleteBlock(selectedColumn.id, selectedBlock.id)} className="w-full px-3 py-2 bg-[#C6604F] hover:bg-[#A84E3F] rounded text-sm flex items-center justify-center gap-2"><Trash2 className="w-4 h-4" /> Delete Block</button></div>}
            </div>
          ) : <div className="p-4 text-center text-[#786D60]"><Settings className="w-12 h-12 mx-auto mb-3 opacity-30" /><p>Select a block to edit</p></div>}
        </div>
      </div>

      <div className="flex-shrink-0 bg-black/80 border-t border-[#38302A]">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#38302A]">
          <div className="flex items-center gap-2"><ScrollText className="w-4 h-4 text-[#5FB7B0]" /><span className="text-sm font-semibold">Execution Log</span><span className="text-xs text-[#786D60]">({emulationLog.length})</span></div>
          <div className="flex items-center gap-2"><button onClick={() => setShowLog(!showLog)} className="text-xs text-[#786D60] hover:text-[#F3ECE3]">{showLog ? 'Hide' : 'Show'}</button>{emulationLog.length > 0 && <button onClick={() => setEmulationLog([])} className="text-xs text-[#F07A6C] hover:text-[#F5988A]">Clear</button>}</div>
        </div>
        {showLog && <div className="h-32 overflow-y-auto p-2 font-mono text-xs space-y-0.5">{emulationLog.length === 0 ? <div className="text-[#786D60] text-center py-4">No log entries</div> : emulationLog.map((entry, idx) => <div key={idx} className={`flex gap-2 ${entry.type === 'success' ? 'text-[#7BD497]' : entry.type === 'error' ? 'text-[#F07A6C]' : entry.type === 'warning' ? 'text-[#E6C766]' : entry.type === 'marker' ? 'text-[#F0A73C] font-bold' : 'text-[#ADA294]'}`}><span className="text-[#786D60]">[{entry.timestamp}]</span>{entry.column > 0 && <span className="text-[#786D60]">Col {entry.column}:</span>}<span>{entry.message}</span></div>)}</div>}
      </div>

      <div className="flex-shrink-0 bg-[#15110B] border-t border-[#38302A] px-6 py-4">
        <div className="flex items-center justify-center gap-4 flex-wrap">
          {!isEmulating && scheduledRunAt === null && (
            <>
              <button onClick={runWorkflow} disabled={!connected || workflow.length === 0} className="px-8 py-3 bg-gradient-to-r from-[#FFC66E] to-[#F0A73C] text-[#241503] hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-bold text-lg flex items-center gap-3 shadow-[0_8px_22px_-8px_rgba(240,167,60,.65)]"><Play className="w-6 h-6" />Run Workflow</button>
              <button onClick={openScheduleDialog} disabled={!connected || workflow.length === 0} className="px-6 py-3 bg-[#2A231C] hover:bg-[#322A22] text-[#F3ECE3] border border-[#38302A] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-bold flex items-center gap-2"><CalendarClock className="w-5 h-5" />Schedule Run</button>
              <div className="flex items-center bg-[#15110B] rounded-lg border border-[#38302A] overflow-hidden">
                <div className="px-3 py-2 bg-[#2A231C] flex items-center gap-2 border-r border-[#38302A]"><Repeat className="w-5 h-5 text-[#F0A73C]" /><span className="text-sm font-medium text-[#ADA294]">Repeat</span></div>
                <button onClick={() => setRepeatCount(Math.max(0, repeatCount - 1))} className="px-3 py-2 hover:bg-[#2A231C] text-[#786D60] hover:text-[#F3ECE3] transition-colors">-</button>
                <div className="px-4 py-2 min-w-[60px] text-center"><span className="text-xl font-bold text-[#F0A73C]">{repeatCount}</span></div>
                <button onClick={() => setRepeatCount(repeatCount + 1)} className="px-3 py-2 hover:bg-[#2A231C] text-[#786D60] hover:text-[#F3ECE3] transition-colors">+</button>
                <div className="px-3 py-2 border-l border-[#38302A] text-xs text-[#786D60]">{repeatCount === 0 ? '1 run' : `${repeatCount + 1} runs`}</div>
              </div>
            </>
          )}
          {!isEmulating && scheduledRunAt !== null && (
            <>
              <div className="flex items-center gap-3 px-4 py-2 bg-[#F0A73C]/20 border border-[#F0A73C] rounded-lg">
                <CalendarClock className="w-5 h-5 text-[#F0A73C] animate-pulse" />
                <div className="flex flex-col">
                  <span className="text-[#F3ECE3] font-medium text-sm">Scheduled: {new Date(scheduledRunAt).toLocaleString()}</span>
                  <span className="text-[#F0A73C] text-xs">Starts in <span className="font-bold text-[#F3ECE3]">{formatCountdown(scheduledRunAt)}</span></span>
                </div>
              </div>
              <button onClick={() => { cancelScheduledRun(); runWorkflow(); }} className="px-5 py-3 bg-[#4F8B5C] hover:bg-[#3E6E48] rounded-lg font-bold flex items-center gap-2"><Play className="w-5 h-5" />Run Now</button>
              <button onClick={cancelScheduledRun} className="px-5 py-3 bg-[#C6604F] hover:bg-[#A84E3F] rounded-lg font-bold flex items-center gap-2"><X className="w-5 h-5" />Cancel</button>
            </>
          )}
          {isEmulating && (
            <>
              <div className="flex items-center gap-3 px-4 py-2 bg-[#4F8B5C]/15 border border-[#4F8B5C] rounded-lg"><div className="w-3 h-3 bg-[#6FBF7E] rounded-full animate-pulse" /><span className="text-[#7BD497] font-medium">Running: Column {currentColumnIndex + 1}/{workflow.length}{repeatCount > 0 && ` (${repeatCount + 1} total runs)`}</span></div>
              <button onClick={() => { setIsPaused(!isPaused); executionControlRef.current.isPaused = !isPaused; }} className="px-6 py-3 bg-[#C79A34] hover:bg-[#A9812A] rounded-lg font-bold flex items-center gap-2">{isPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}{isPaused ? 'Resume' : 'Pause'}</button>
              <button onClick={stopWorkflow} className="px-6 py-3 bg-[#C6604F] hover:bg-[#A84E3F] rounded-lg font-bold flex items-center gap-2"><StopCircle className="w-5 h-5" />Stop</button>
            </>
          )}
          {!connected && <span className="text-sm text-[#F07A6C]">⚠️ Not connected</span>}
        </div>
      </div>

      {showScheduleDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#15110B] rounded-xl p-6 w-[420px] border border-[#38302A]">
            <h3 className="text-lg font-bold mb-1 flex items-center gap-2"><CalendarClock className="w-5 h-5 text-[#F0A73C]" />Schedule Workflow Run</h3>
            <p className="text-xs text-[#786D60] mb-4">Workflow will start automatically at the selected time.</p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs text-[#786D60] block mb-1">Time (24h)</label>
                <input type="time" value={scheduleDialogTime} onChange={e => setScheduleDialogTime(e.target.value)} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" autoFocus />
              </div>
              <div>
                <label className="text-xs text-[#786D60] block mb-1">Date (optional)</label>
                <input type="date" value={scheduleDialogDate} onChange={e => setScheduleDialogDate(e.target.value)} className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" />
              </div>
            </div>
            <p className="text-[10px] text-[#786D60] mb-4">Leave date blank for next occurrence (today if not passed, tomorrow if passed).</p>
            {scheduleDialogTime && (() => {
              const previewMs = computeMsUntilTime(scheduleDialogTime, scheduleDialogDate || undefined);
              if (previewMs <= 0) return <div className="text-xs text-[#F07A6C] mb-3">⚠️ Invalid or past time</div>;
              const previewTarget = new Date(Date.now() + previewMs);
              return <div className="bg-[#F0A73C]/15 border border-[#F0A73C]/40 rounded p-2 mb-4 text-xs text-[#F3ECE3]">Will start at <span className="font-bold">{previewTarget.toLocaleString()}</span> — in {formatCountdown(Date.now() + previewMs)}</div>;
            })()}
            <div className="flex gap-3">
              <button onClick={() => setShowScheduleDialog(false)} className="flex-1 px-4 py-2 bg-[#2A231C] hover:bg-[#322A22] rounded">Cancel</button>
              <button onClick={() => scheduleRunAt(scheduleDialogTime, scheduleDialogDate || undefined)} disabled={!scheduleDialogTime || computeMsUntilTime(scheduleDialogTime, scheduleDialogDate || undefined) <= 0} className="flex-1 px-4 py-2 bg-[#F0A73C] hover:bg-[#8FB488] disabled:opacity-50 disabled:cursor-not-allowed rounded font-semibold">Schedule</button>
            </div>
          </div>
        </div>
      )}

      {showSaveDialog && <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"><div className="bg-[#15110B] rounded-xl p-6 w-96 border border-[#38302A]"><h3 className="text-lg font-bold mb-4">Save Workflow</h3><input type="text" value={workflowName} onChange={e => setWorkflowName(e.target.value)} placeholder="Workflow name..." className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 mb-4" autoFocus /><div className="flex gap-3"><button onClick={() => setShowSaveDialog(false)} className="flex-1 px-4 py-2 bg-[#2A231C] hover:bg-[#322A22] rounded">Cancel</button><button onClick={saveWorkflow} className="flex-1 px-4 py-2 bg-[#4F8B5C] hover:bg-[#3E6E48] rounded">Save</button></div></div></div>}
      {showIoWizard && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#15110B] rounded-xl p-6 w-[440px] border border-[#38302A]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">Workflow File</h3>
              <button onClick={() => setShowIoWizard(false)} className="p-1 hover:bg-[#241E19] rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-1 mb-4 bg-[#15110B] p-1 rounded">
              <button onClick={() => { setIoWizardTab('export'); setIoError(''); }} className={`px-3 py-1.5 rounded text-sm flex items-center justify-center gap-1.5 ${ioWizardTab === 'export' ? 'bg-[#F0A73C] text-[#241503]' : 'hover:bg-[#2A231C]'}`}><Download className="w-4 h-4" /> Export</button>
              <button onClick={() => { setIoWizardTab('import'); setIoError(''); }} className={`px-3 py-1.5 rounded text-sm flex items-center justify-center gap-1.5 ${ioWizardTab === 'import' ? 'bg-[#F0A73C] text-[#241503]' : 'hover:bg-[#2A231C]'}`}><Upload className="w-4 h-4" /> Import</button>
            </div>

            {ioWizardTab === 'export' ? (
              <div className="space-y-3">
                <p className="text-sm text-[#786D60]">Download the current workflow as a <code className="text-[#ADA294]">.aether-workflow.json</code> file you can keep on this machine and re-import later.</p>
                <div className="bg-[#15110B] rounded p-3 text-xs text-[#786D60] space-y-1">
                  <div>Name: <span className="text-[#F3ECE3]">{workflowName || '(unnamed)'}</span></div>
                  <div>Columns: <span className="text-[#F3ECE3]">{workflow.length}</span></div>
                  <div>Blocks: <span className="text-[#F3ECE3]">{workflow.reduce((n, col) => n + col.blocks.length, 0)}</span></div>
                </div>
                <button onClick={exportWorkflowFile} disabled={workflow.length === 0} className="w-full px-4 py-2 bg-[#F0A73C] hover:bg-[#8FB488] disabled:opacity-50 disabled:cursor-not-allowed text-[#241503] font-semibold rounded flex items-center justify-center gap-2"><Download className="w-4 h-4" /> Download Workflow File</button>
                {workflow.length === 0 && <p className="text-xs text-[#F0A73C]">Nothing to export — the canvas is empty.</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-[#786D60]">Select a previously exported <code className="text-[#ADA294]">.json</code> workflow file. It is validated before loading — a bad file shows an error here instead of breaking the page.</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) importWorkflowFile(f); e.currentTarget.value = ''; }}
                />
                <button onClick={() => fileInputRef.current?.click()} className="w-full px-4 py-2 bg-[#F0A73C] hover:bg-[#8FB488] text-[#241503] font-semibold rounded flex items-center justify-center gap-2"><Upload className="w-4 h-4" /> Choose Workflow File…</button>
                <p className="text-xs text-[#786D60]">Importing replaces the current canvas. Export first if you want to keep it.</p>
              </div>
            )}

            {ioError && (
              <div className="mt-4 px-3 py-2 bg-[#C6604F]/20 border border-[#E0705F]/50 rounded text-xs text-[#F5988A] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{ioError}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {/* ── Bottom Scenario Bar ─────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-[#38302A] bg-[#1B1613] px-6 py-2.5 flex items-center gap-3">
        <span className="text-xs text-[#786D60] uppercase tracking-wider">Scenarios</span>
        <button
          onClick={() => { setScenarioWizError(''); setScenarioName(workflowName || ''); setScenarioWizTab('save'); setShowScenarioWizard(true); }}
          className="px-3 py-1.5 bg-[#3E7E5C]/60 hover:bg-[#4E9E74]/70 rounded text-sm flex items-center gap-1.5"
          title="Save the current canvas as a reusable scenario">
          <Save className="w-4 h-4" /> Save as Scenario
        </button>
        <button
          onClick={() => { setScenarioWizError(''); loadCustomScenarios(); setScenarioWizTab('manage'); setShowScenarioWizard(true); }}
          className="px-3 py-1.5 bg-[#241E19] hover:bg-[#322A22] rounded text-sm flex items-center gap-1.5"
          title="Load, rename, or delete saved scenarios">
          <FolderOpen className="w-4 h-4" /> Manage Scenarios
        </button>
        <span className="text-[11px] text-[#5E5449] ml-auto">{customScenarios.length} saved · persists across reloads</span>
      </div>

      {/* ── Scenario Wizard ─────────────────────────────────────────────── */}
      {showScenarioWizard && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#15110B] rounded-xl p-6 w-[460px] border border-[#38302A]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">Scenarios</h3>
              <button onClick={() => setShowScenarioWizard(false)} className="p-1 hover:bg-[#241E19] rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-1 mb-4 bg-[#15110B] p-1 rounded">
              <button onClick={() => { setScenarioWizTab('save'); setScenarioWizError(''); }} className={`px-3 py-1.5 rounded text-sm flex items-center justify-center gap-1.5 ${scenarioWizTab === 'save' ? 'bg-[#F0A73C] text-[#241503]' : 'hover:bg-[#2A231C]'}`}><Save className="w-4 h-4" /> Save as Scenario</button>
              <button onClick={() => { setScenarioWizTab('manage'); setScenarioWizError(''); loadCustomScenarios(); }} className={`px-3 py-1.5 rounded text-sm flex items-center justify-center gap-1.5 ${scenarioWizTab === 'manage' ? 'bg-[#F0A73C] text-[#241503]' : 'hover:bg-[#2A231C]'}`}><FolderOpen className="w-4 h-4" /> Manage</button>
            </div>

            {scenarioWizTab === 'save' ? (
              <div className="space-y-3">
                <p className="text-sm text-[#786D60]">Save the current canvas ({workflow.length} column{workflow.length === 1 ? '' : 's'}, {workflow.reduce((n, col) => n + col.blocks.length, 0)} block{workflow.reduce((n, col) => n + col.blocks.length, 0) === 1 ? '' : 's'}) as a reusable scenario. It persists across reloads and can be loaded back onto the canvas any time.</p>
                <div>
                  <label className="text-xs text-[#786D60] block mb-1">Scenario name</label>
                  <input type="text" value={scenarioName} onChange={e => setScenarioName(e.target.value)} placeholder="e.g. Interlock — Door1/Door2 cross-board" className="w-full bg-[#15110B] border border-[#38302A] rounded px-3 py-2 text-sm" autoFocus />
                </div>
                <button onClick={saveAsScenario} disabled={workflow.length === 0} className="w-full px-4 py-2 bg-[#F0A73C] hover:bg-[#8FB488] disabled:opacity-50 disabled:cursor-not-allowed text-[#241503] font-semibold rounded flex items-center justify-center gap-2"><Save className="w-4 h-4" /> Save Scenario</button>
                {workflow.length === 0 && <p className="text-xs text-[#F0A73C]">Canvas is empty — build a sequence first.</p>}
              </div>
            ) : (
              <div className="space-y-2">
                {customScenarios.length === 0 ? (
                  <p className="text-[#786D60] text-center py-6 text-sm">No saved scenarios yet. Build a sequence and use "Save as Scenario".</p>
                ) : (
                  <div className="max-h-80 overflow-y-auto space-y-1.5">
                    {customScenarios.slice().sort((a, b) => b.savedAt - a.savedAt).map(s => (
                      <div key={s.id} className="flex items-stretch gap-1">
                        <button onClick={() => applyScenario(s.id)} className="flex-1 px-3 py-2.5 bg-[#2A231C] hover:bg-[#322A22] rounded text-left min-w-0" title="Load onto canvas">
                          <div className="font-semibold truncate">{s.name}</div>
                          <div className="text-[11px] text-[#786D60]">{Array.isArray(s.steps) ? s.steps.length : 0} cols · {new Date(s.savedAt).toLocaleString()}</div>
                        </button>
                        <button onClick={() => renameScenario(s.id, s.name)} title="Rename" className="px-2.5 bg-[#2A231C] hover:bg-[#322A22] rounded flex items-center text-[#786D60] hover:text-[#F3ECE3]"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => deleteScenario(s.id, s.name)} title="Delete" className="px-2.5 bg-[#2A231C] hover:bg-[#A84E3F]/70 rounded flex items-center text-[#786D60] hover:text-[#F3ECE3]"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-[#786D60] pt-1">Loading a scenario replaces the current canvas. Save the current one first if needed.</p>
              </div>
            )}

            {scenarioWizError && (
              <div className="mt-4 px-3 py-2 bg-[#C6604F]/20 border border-[#E0705F]/50 rounded text-xs text-[#F5988A] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{scenarioWizError}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {showLoadDialog && <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"><div className="bg-[#15110B] rounded-xl p-6 w-96 border border-[#38302A]"><h3 className="text-lg font-bold mb-4">Load Workflow</h3><div className="max-h-80 overflow-y-auto space-y-2 mb-4">{savedWorkflows.length === 0 ? <p className="text-[#786D60] text-center py-4">No saved workflows</p> : savedWorkflows.map(w => <div key={w.id} className="flex items-stretch gap-1 group"><button onClick={() => loadWorkflow(w.id)} className="flex-1 px-4 py-3 bg-[#2A231C] hover:bg-[#322A22] rounded text-left min-w-0"><div className="font-semibold truncate">{w.name}</div><div className="text-xs text-[#786D60]">{new Date(w.created || w.createdAt).toLocaleDateString()}</div></button><button onClick={() => deleteWorkflow(w.id, w.name)} title={`Delete "${w.name}"`} className="px-3 bg-[#2A231C] hover:bg-[#A84E3F]/70 rounded flex items-center justify-center text-[#786D60] hover:text-[#F3ECE3] transition-colors"><Trash2 className="w-4 h-4" /></button></div>)}</div><button onClick={() => setShowLoadDialog(false)} className="w-full px-4 py-2 bg-[#2A231C] hover:bg-[#322A22] rounded">Close</button></div></div>}
    </div>
  );
};

export default EmulationWorkflow;

