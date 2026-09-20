import React, { useState, useEffect } from 'react';
import { Activity, Plus, Trash2, Edit, Power, PowerOff, ChevronDown, ChevronUp, Network, AlertTriangle } from 'lucide-react';
/** ---------- Types ---------- */
// IOAccessEmulator's items use `channel`, not `gpio`. The old declaration here
// said `gpio`, so every dropdown rendered "GPIO undefined" and saved rules with
// an undefined pin. Both names are accepted now, with channel preferred.
type IOItem = {
  id: number;
  name: string;
  type: string;
  channel?: number;
  gpio?: number;
  active: boolean;
};
const pinOf = (io: IOItem): number => (io.channel ?? io.gpio ?? 0);

type SwitchProfileLite = {
  id: string;
  name: string;
  host: string;
  portCount: number;
  denyPorts: number[];
  portAliases?: Record<string, string>;
};

type AutomationRule = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  trigger: any;
  conditions: any[];
  actions: any[];
  stats?: { 
    executions?: number;
    lastExecuted?: string;
    errors?: number;
  };
};
/** ---------- Props ---------- */
// doors and readers are optional: IOAccessEmulator does not pass them, and the
// previous signature required them — so `doors.map` threw the moment anyone
// picked a door trigger. Defaulted to empty arrays and the affected options are
// hidden when there is nothing to choose from.
interface AutomationSectionProps {
  ipAddress: string;
  connected: boolean;
  inputs: IOItem[];
  outputs: IOItem[];
  controllerOutputs: IOItem[];
  doors?: any[];
  readers?: any[];
  logSystem: (type: string, message: string) => void;
}
/** ---------- Helper ---------- */
async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok || (body && body.success === false)) {
      // The validator explains exactly what is wrong with a rule. Throwing a
      // bare "HTTP 400" threw that away and left "Failed to save rule".
      throw new Error((body && (body.error || body.message)) || `HTTP ${r.status}`);
    }
    return body;
  } catch (e) {
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Hold durations for a switch_port action, mirroring the Switch Ports tab.
 *  0 means no auto-revert — deliberately last and spelled out, because a
 *  scheduled rule that crashes mid-run would leave the port down for good. */
const SWITCH_HOLDS = [
  { label: '30 seconds', ms: 30_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '4 hours (CLC-004)', ms: 14_400_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days (CLC-005)', ms: 604_800_000 },
  { label: 'Until turned back on', ms: 0 },
];

/** The backend requires an explicit rule id and will not generate one.
 *  Derived from the name so nobody has to think about it, but left editable
 *  because the id is what an API caller or a scenario script refers to. */
const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

const AutomationSection: React.FC<AutomationSectionProps> = ({
  ipAddress,
  connected,
  inputs,
  outputs,
  controllerOutputs,
  doors = [],
  readers = [],
  logSystem,
}) => {
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [showRuleBuilder, setShowRuleBuilder] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [switchProfiles, setSwitchProfiles] = useState<SwitchProfileLite[]>([]);
  
  const [ruleId, setRuleId] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [ruleDescription, setRuleDescription] = useState('');
  const [rulePriority, setRulePriority] = useState(5);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  
  const [triggerType, setTriggerType] = useState('gpio_change');
  const [triggerPin, setTriggerPin] = useState(0);
  const [triggerValue, setTriggerValue] = useState<0 | 1>(1);
  const [triggerDoorId, setTriggerDoorId] = useState(1);
  const [triggerDoorEvent, setTriggerDoorEvent] = useState('lock');
  const [triggerReaderId, setTriggerReaderId] = useState('reader-1');
  const [triggerTime, setTriggerTime] = useState('02:00');
  
  const [actions, setActions] = useState<any[]>([]);
  useEffect(() => {
    if (connected) {
      fetchAutomationRules();
      fetchSwitchProfiles();
      const interval = setInterval(fetchAutomationRules, 5000);
      return () => clearInterval(interval);
    }
  }, [connected, ipAddress]);

  const fetchAutomationRules = async () => {
    try {
      const data = await fetchJson(`http://${ipAddress}:3001/api/automation/rules`);
      if (data.success && Array.isArray(data.rules)) {
        setAutomationRules(data.rules);
      }
    } catch (e) {
      console.error('Failed to load automation rules', e);
    }
  };

  /** Switch profiles feed the switch_port action's dropdowns, so a rule names a
   *  real profile and a port that exists rather than free text. */
  const fetchSwitchProfiles = async () => {
    try {
      const data = await fetchJson(`http://${ipAddress}:3001/api/switch/status`);
      if (data.success && Array.isArray(data.profiles)) setSwitchProfiles(data.profiles);
    } catch {
      // Switch manager may not be initialized — the action is simply unavailable.
      setSwitchProfiles([]);
    }
  };

  const saveRule = async () => {
    if (!ruleName.trim()) {
      logSystem('error', 'Rule name is required');
      return;
    }
    const id = (ruleId.trim() || slugify(ruleName));
    if (!id) {
      logSystem('error', 'Rule ID is required — give the rule a name with letters or numbers in it');
      return;
    }
    if (!editingRule && automationRules.some(r => r.id === id)) {
      logSystem('error', `A rule with ID "${id}" already exists`);
      return;
    }
    if (actions.length === 0) {
      logSystem('error', 'At least one action is required');
      return;
    }
    try {
      let trigger: any = {};
      if (triggerType === 'gpio_change') {
        trigger = { type: 'gpio_change', pin: triggerPin, value: triggerValue };
      } else if (triggerType === 'door_event') {
        trigger = { type: 'door_event', doorId: triggerDoorId, event: triggerDoorEvent, value: triggerValue };
      } else if (triggerType === 'reader_event') {
        trigger = { type: 'reader_event', readerId: triggerReaderId };
      } else if (triggerType === 'schedule') {
        trigger = { type: 'schedule', time: triggerTime };
      } else if (triggerType === 'manual') {
        trigger = { type: 'manual' };
      }

      // The backend stores every action's fields under `params` and validates
      // them there — action.params.profileId, action.params.message and so on.
      // The builder keeps them flat because that is easier to edit, so they are
      // nested on the way out. Writing them flat is why saving failed silently.
      const cleanActions = actions.map(({ id, type, delay, ...fields }) => {
        const out: any = { type, params: fields };
        if (delay) out.delay = delay;
        return out;
      });

      const ruleData = {
        id,
        name: ruleName,
        description: ruleDescription,
        enabled: ruleEnabled,
        priority: rulePriority,
        trigger,
        conditions: triggerType === 'schedule' ? { schedule: { time: triggerTime } } : [],
        actions: cleanActions,
      };
      const endpoint = editingRule
        ? `http://${ipAddress}:3001/api/automation/rules/${editingRule.id}`
        : `http://${ipAddress}:3001/api/automation/rules`;
      const method = editingRule ? 'PUT' : 'POST';
      const response = await fetchJson(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ruleData)
      });
      if (response.success) {
        logSystem('success', editingRule ? 'Rule updated' : 'Rule created');
        fetchAutomationRules();
        resetRuleBuilder();
      }
    } catch (e: any) {
      logSystem('error', `Failed to save rule: ${e.message || e}`);
    }
  };
  const deleteRule = async (id: string) => {
    if (!confirm('Delete this rule?')) return;
    try {
      const response = await fetchJson(`http://${ipAddress}:3001/api/automation/rules/${id}`, {
        method: 'DELETE'
      });
      if (response.success) {
        logSystem('success', 'Rule deleted');
        fetchAutomationRules();
      }
    } catch (e) {
      logSystem('error', `Failed to delete rule`);
    }
  };
  const toggleRule = async (id: string, enabled: boolean) => {
    try {
      const response = await fetchJson(`http://${ipAddress}:3001/api/automation/rules/${id}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (response.success) {
        logSystem('info', `Rule ${enabled ? 'enabled' : 'disabled'}`);
        fetchAutomationRules();
      }
    } catch (e) {
      logSystem('error', `Failed to toggle rule`);
    }
  };
  const editRule = (rule: AutomationRule) => {
    setEditingRule(rule);
    setRuleId(rule.id);
    setRuleName(rule.name);
    setRuleDescription(rule.description || '');
    setRulePriority(rule.priority);
    setRuleEnabled(rule.enabled);
    
    if (rule.trigger?.type === 'gpio_change') {
      setTriggerType('gpio_change');
      setTriggerPin(rule.trigger.pin ?? 0);
      setTriggerValue(rule.trigger.value ?? 1);
    } else if (rule.trigger?.type === 'door_event') {
      setTriggerType('door_event');
      setTriggerDoorId(rule.trigger.doorId || 1);
      setTriggerDoorEvent(rule.trigger.event || 'lock');
      setTriggerValue(rule.trigger.value ?? 1);
    } else if (rule.trigger?.type === 'reader_event') {
      setTriggerType('reader_event');
      setTriggerReaderId(rule.trigger.readerId || 'reader-1');
    } else if (rule.trigger?.type === 'schedule') {
      setTriggerType('schedule');
      setTriggerTime(rule.trigger.time || '02:00');
    } else if (rule.trigger?.type === 'manual') {
      setTriggerType('manual');
    }
    
    // Flatten params back into the action so the form controls can bind to
    // them, and re-attach a builder-local id for a stable React key.
    setActions((rule.actions || []).map((a: any, i: number) => ({
      id: Date.now() + i,
      type: a.type,
      delay: a.delay || 0,
      ...(a.params || {}),
    })));
    setShowRuleBuilder(true);
  };
  const resetRuleBuilder = () => {
    setRuleId('');
    setRuleName('');
    setRuleDescription('');
    setRulePriority(5);
    setRuleEnabled(true);
    setTriggerType('gpio_change');
    setTriggerPin(0);
    setTriggerValue(1);
    setTriggerDoorId(1);
    setTriggerDoorEvent('lock');
    setTriggerReaderId('reader-1');
    setTriggerTime('02:00');
    setActions([]);
    setEditingRule(null);
    setShowRuleBuilder(false);
  };
  const addAction = () => {
    setActions([...actions, {
      id: Date.now(),
      type: 'gpio',
      pin: pinOf(outputs[0] || { id: 0, name: '', type: '', active: false }),
      value: 1,
      delay: 0
    }]);
  };
  const removeAction = (id: number) => {
    setActions(actions.filter(a => a.id !== id));
  };
  const updateAction = (id: number, field: string, value: any) => {
    setActions(actions.map(a => a.id === id ? { ...a, [field]: value } : a));
  };

  /** Switching an action's type has to bring that type's required fields with
   *  it — otherwise a switch_port action saves with no profileId and the
   *  backend rejects it with a message nobody can act on. */
  const changeActionType = (id: number, type: string) => {
    setActions(actions.map(a => {
      if (a.id !== id) return a;
      const base = { id: a.id, type, delay: a.delay || 0 };
      if (type === 'gpio' || type === 'gpio_pulse') {
        return { ...base, pin: pinOf(outputs[0] || ({} as IOItem)), value: 1, duration: 500 };
      }
      if (type === 'switch_port') {
        const p = switchProfiles[0];
        return {
          ...base,
          profileId: p?.id || '',
          port: 1,
          action: 'disable',
          holdMs: 900_000,
          reason: '',
        };
      }
      if (type === 'log') return { ...base, message: '' };
      if (type === 'delay') return { ...base, ms: 1000 };
      return base;
    }));
  };

  const renderTriggerDescription = (trigger: any): string => {
    if (!trigger?.type) return 'Unknown trigger';
    if (trigger.type === 'gpio_change') {
      return `Channel ${trigger.pin} → ${trigger.value === 1 ? 'HIGH' : 'LOW'}`;
    } else if (trigger.type === 'door_event') {
      const door = doors.find((d: any) => d.id === trigger.doorId);
      return `${door?.name || `Door ${trigger.doorId}`} ${trigger.event}`;
    } else if (trigger.type === 'reader_event') {
      return `Reader: ${trigger.readerId}`;
    } else if (trigger.type === 'schedule') {
      return `Daily at ${trigger.time}`;
    } else if (trigger.type === 'manual') {
      return 'Manual run only';
    }
    return 'Unknown';
  };

  const renderActionDescription = (raw: any): string => {
    if (!raw?.type) return 'Unknown action';
    // Rules from the API are nested; actions mid-edit in the builder are flat.
    const action = { type: raw.type, ...(raw.params || raw) };
    if (action.type === 'gpio') {
      return `Channel ${action.pin} → ${action.value === 1 ? 'HIGH' : 'LOW'}`;
    } else if (action.type === 'gpio_pulse') {
      return `Pulse channel ${action.pin} (${action.duration || 500}ms)`;
    } else if (action.type === 'switch_port') {
      const prof = switchProfiles.find(p => p.id === action.profileId);
      const alias = prof?.portAliases?.[String(action.port)];
      const where = `${prof?.name || action.profileId} port ${action.port}${alias ? ` (${alias})` : ''}`;
      if (action.action === 'enable') return `Bring up ${where}`;
      const hold = action.holdMs === 0
        ? 'until manually restored'
        : `for ${Math.round((action.holdMs || 0) / 1000)}s`;
      return `Take down ${where} ${hold}`;
    } else if (action.type === 'log') {
      return `Log: ${action.message || ''}`;
    } else if (action.type === 'delay') {
      return `Wait ${action.ms || 0}ms`;
    }
    return action.type;
  };

  const toggleExpanded = (id: string) => {
    const newExpanded = new Set(expandedRules);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedRules(newExpanded);
  };

  const allOutputs = [...outputs, ...controllerOutputs];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-[#2E2410]/20 to-[#2E2410]/20 backdrop-blur rounded-xl p-6 border border-[#C9862E]/50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold mb-2 flex items-center gap-3">
              <Activity className="w-8 h-8 text-[#F0A73C]" />
              Automation Rules
            </h2>
            <p className="text-[#C4B9AB]">
              Create conditional automation rules for doors, readers, I/O and switch ports
            </p>
          </div>
          <button
            onClick={() => {
              resetRuleBuilder();
              setShowRuleBuilder(!showRuleBuilder);
            }}
            className="px-6 py-3 bg-[#F0A73C] hover:bg-[#C9862E] rounded-lg font-semibold flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            New Rule
          </button>
        </div>
        
        {/* Stats */}
        <div className="mt-4 grid grid-cols-4 gap-4">
          <div className="bg-[#241E19]/50 rounded-lg p-3 border border-[#4A3F36]">
            <div className="text-xs text-[#ADA294]">Total Rules</div>
            <div className="text-2xl font-bold text-[#F0A73C]">{automationRules.length}</div>
          </div>
          <div className="bg-[#241E19]/50 rounded-lg p-3 border border-[#4A3F36]">
            <div className="text-xs text-[#ADA294]">Active Rules</div>
            <div className="text-2xl font-bold text-[#7BD497]">
              {automationRules.filter(r => r.enabled).length}
            </div>
          </div>
          <div className="bg-[#241E19]/50 rounded-lg p-3 border border-[#4A3F36]">
            <div className="text-xs text-[#ADA294]">Total Executions</div>
            <div className="text-2xl font-bold text-[#5FB7B0]">
              {automationRules.reduce((sum, r) => sum + (r.stats?.executions || 0), 0)}
            </div>
          </div>
          <div className="bg-[#241E19]/50 rounded-lg p-3 border border-[#4A3F36]">
            <div className="text-xs text-[#ADA294]">Errors</div>
            <div className="text-2xl font-bold text-[#E0705F]">
              {automationRules.reduce((sum, r) => sum + (r.stats?.errors || 0), 0)}
            </div>
          </div>
        </div>
      </div>
      {/* Rule Builder */}
      {showRuleBuilder && (
        <div className="bg-[#241E19]/50 backdrop-blur rounded-xl p-6 border border-[#38302A]">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Edit className="w-6 h-6 text-[#F0A73C]" />
            {editingRule ? 'Edit Rule' : 'Create New Rule'}
          </h3>
          <div className="space-y-4 mb-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-[#ADA294] block mb-2">Rule Name *</label>
                <input
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  className="w-full bg-[#15110B] border border-[#4A3F36] rounded-lg px-4 py-2"
                  placeholder="CLC-004 medium disconnect"
                />
              </div>
              <div>
                <label className="text-sm text-[#ADA294] block mb-2">
                  Rule ID *
                  <span className="text-xs text-[#786D60] ml-2">
                    {editingRule ? 'cannot be changed' : 'auto-filled from the name'}
                  </span>
                </label>
                <input
                  type="text"
                  value={ruleId || (editingRule ? '' : slugify(ruleName))}
                  disabled={!!editingRule}
                  onChange={(e) => setRuleId(e.target.value)}
                  className="w-full bg-[#15110B] border border-[#4A3F36] rounded-lg px-4 py-2 disabled:opacity-60"
                  placeholder="clc-004-medium-disconnect"
                />
              </div>
              <div>
                <label className="text-sm text-[#ADA294] block mb-2">Priority (1-10)</label>
                <input
                  type="number"
                  value={rulePriority}
                  onChange={(e) => setRulePriority(parseInt(e.target.value) || 5)}
                  className="w-full bg-[#15110B] border border-[#4A3F36] rounded-lg px-4 py-2"
                  min={1}
                  max={10}
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-[#ADA294] block mb-2">Description</label>
              <textarea
                value={ruleDescription}
                onChange={(e) => setRuleDescription(e.target.value)}
                className="w-full bg-[#15110B] border border-[#4A3F36] rounded-lg px-4 py-2 h-20"
                placeholder="What does this rule do?"
              />
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={ruleEnabled}
                onChange={(e) => setRuleEnabled(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm text-[#C4B9AB]">Enable immediately</span>
            </label>
          </div>
          {/* Trigger */}
          <div className="bg-[#15110B]/50 rounded-lg p-4 border border-[#F0A73C]/30 mb-4">
            <h4 className="text-lg font-semibold mb-3 text-[#F0A73C]">Trigger (WHEN)</h4>
            <div className="space-y-3">
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full bg-[#241E19] border border-[#4A3F36] rounded-lg px-4 py-2"
              >
                <option value="gpio_change">I/O Change</option>
                {doors.length > 0 && <option value="door_event">Door Event</option>}
                {readers.length > 0 && <option value="reader_event">Reader Event</option>}
                <option value="schedule">Schedule (daily)</option>
                <option value="manual">Manual only</option>
              </select>
              {triggerType === 'gpio_change' && (
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={triggerPin}
                    onChange={(e) => setTriggerPin(parseInt(e.target.value))}
                    className="w-full bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                  >
                    {inputs.map(i => (
                      <option key={i.id} value={pinOf(i)}>Channel {pinOf(i)} — {i.name}</option>
                    ))}
                  </select>
                  <select
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(parseInt(e.target.value) as 0 | 1)}
                    className="w-full bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                  >
                    <option value={1}>HIGH (1)</option>
                    <option value={0}>LOW (0)</option>
                  </select>
                </div>
              )}
              {triggerType === 'door_event' && doors.length > 0 && (
                <div className="grid grid-cols-3 gap-3">
                  <select
                    value={triggerDoorId}
                    onChange={(e) => setTriggerDoorId(parseInt(e.target.value))}
                    className="w-full bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                  >
                    {doors.map((d: any) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <select
                    value={triggerDoorEvent}
                    onChange={(e) => setTriggerDoorEvent(e.target.value)}
                    className="w-full bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                  >
                    <option value="lock">Lock</option>
                    <option value="dps">DPS</option>
                    <option value="rexIn">REX</option>
                  </select>
                  <select
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(parseInt(e.target.value) as 0 | 1)}
                    className="w-full bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                  >
                    <option value={1}>ACTIVE</option>
                    <option value={0}>INACTIVE</option>
                  </select>
                </div>
              )}
              {triggerType === 'reader_event' && readers.length > 0 && (
                <select
                  value={triggerReaderId}
                  onChange={(e) => setTriggerReaderId(e.target.value)}
                  className="w-full bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                >
                  {readers.filter((r: any) => r.enabled).map((r: any) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              )}
              {triggerType === 'schedule' && (
                <div className="flex items-center gap-3">
                  <input
                    type="time"
                    value={triggerTime}
                    onChange={(e) => setTriggerTime(e.target.value)}
                    className="bg-[#241E19] border border-[#4A3F36] rounded px-3 py-2"
                  />
                  <span className="text-xs text-[#786D60]">
                    Runs every day at this time. Long disconnects should use the action's own
                    hold duration rather than a second rule to bring the port back.
                  </span>
                </div>
              )}
              {triggerType === 'manual' && (
                <p className="text-xs text-[#786D60]">
                  Nothing fires this automatically — useful for a scenario you start by hand.
                </p>
              )}
            </div>
          </div>
          {/* Actions */}
          <div className="bg-[#15110B]/50 rounded-lg p-4 border border-[#4F8B5C]/30 mb-4">
            <div className="flex justify-between mb-3">
              <h4 className="text-lg font-semibold text-[#7BD497]">Actions (THEN) *</h4>
              <button
                onClick={addAction}
                className="px-3 py-1 bg-[#4F8B5C] hover:bg-[#3E6E48] rounded text-sm font-semibold"
              >
                + Add
              </button>
            </div>
            {actions.length === 0 ? (
              <div className="text-sm text-[#E0705F] text-center py-3">
                At least one action required
              </div>
            ) : (
              <div className="space-y-2">
                {actions.map((action) => (
                  <div key={action.id} className="bg-[#241E19]/50 rounded-lg p-3">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <select
                        value={action.type}
                        onChange={(e) => changeActionType(action.id, e.target.value)}
                        className="bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                      >
                        <option value="gpio">I/O Set</option>
                        <option value="gpio_pulse">I/O Pulse</option>
                        {switchProfiles.length > 0 && <option value="switch_port">Switch Port</option>}
                        <option value="delay">Delay</option>
                        <option value="log">Log</option>
                      </select>
                      {(action.type === 'gpio' || action.type === 'gpio_pulse') && (
                        <select
                          value={action.pin}
                          onChange={(e) => updateAction(action.id, 'pin', parseInt(e.target.value))}
                          className="flex-1 bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                        >
                          {allOutputs.map(o => (
                            <option key={o.id} value={pinOf(o)}>Channel {pinOf(o)} — {o.name}</option>
                          ))}
                        </select>
                      )}
                      {action.type === 'gpio' && (
                        <select
                          value={action.value}
                          onChange={(e) => updateAction(action.id, 'value', parseInt(e.target.value))}
                          className="bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                        >
                          <option value={1}>HIGH</option>
                          <option value={0}>LOW</option>
                        </select>
                      )}
                      {action.type === 'gpio_pulse' && (
                        <>
                          <input
                            type="number"
                            value={action.duration || 500}
                            onChange={(e) => updateAction(action.id, 'duration', parseInt(e.target.value) || 500)}
                            className="w-20 bg-[#38302A] border border-[#4A3F36] rounded px-2 py-2"
                          />
                          <span className="text-xs">ms</span>
                        </>
                      )}

                      {/* Switch port — the CLC disconnect cases live here */}
                      {action.type === 'switch_port' && (
                        <>
                          <select
                            value={action.profileId}
                            onChange={(e) => updateAction(action.id, 'profileId', e.target.value)}
                            className="bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                          >
                            {switchProfiles.map(p => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                          <select
                            value={action.port}
                            onChange={(e) => updateAction(action.id, 'port', parseInt(e.target.value))}
                            className="bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                          >
                            {(() => {
                              const prof = switchProfiles.find(p => p.id === action.profileId);
                              const count = prof?.portCount || 0;
                              const deny = prof?.denyPorts || [];
                              return Array.from({ length: count }, (_, i) => i + 1).map(n => {
                                const alias = prof?.portAliases?.[String(n)];
                                const denied = deny.includes(n);
                                return (
                                  // Protected ports are listed but unselectable —
                                  // hiding them entirely makes the numbering look
                                  // wrong, and the backend refuses them anyway.
                                  <option key={n} value={n} disabled={denied}>
                                    Port {n}{alias ? ` — ${alias}` : ''}{denied ? ' (protected)' : ''}
                                  </option>
                                );
                              });
                            })()}
                          </select>
                          <select
                            value={action.action}
                            onChange={(e) => updateAction(action.id, 'action', e.target.value)}
                            className="bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                          >
                            <option value="disable">Disable</option>
                            <option value="enable">Enable</option>
                          </select>
                          {action.action === 'disable' && (
                            <select
                              value={action.holdMs}
                              onChange={(e) => updateAction(action.id, 'holdMs', parseInt(e.target.value))}
                              className="bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                            >
                              {SWITCH_HOLDS.map(h => (
                                <option key={h.ms} value={h.ms}>{h.label}</option>
                              ))}
                            </select>
                          )}
                          <input
                            type="text"
                            value={action.reason || ''}
                            onChange={(e) => updateAction(action.id, 'reason', e.target.value)}
                            placeholder="Reason (CLC-004)"
                            className="flex-1 min-w-[140px] bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                          />
                        </>
                      )}

                      {action.type === 'delay' && (
                        <>
                          <input
                            type="number"
                            value={action.ms || 1000}
                            onChange={(e) => updateAction(action.id, 'ms', parseInt(e.target.value) || 0)}
                            className="w-28 bg-[#38302A] border border-[#4A3F36] rounded px-2 py-2"
                          />
                          <span className="text-xs">ms</span>
                        </>
                      )}
                      {action.type === 'log' && (
                        <input
                          type="text"
                          value={action.message || ''}
                          onChange={(e) => updateAction(action.id, 'message', e.target.value)}
                          placeholder="Message to write to the log"
                          className="flex-1 bg-[#38302A] border border-[#4A3F36] rounded px-3 py-2"
                        />
                      )}
                      <button
                        onClick={() => removeAction(action.id)}
                        className="px-2 py-1 bg-[#C6604F] hover:bg-[#A84E3F] rounded"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {action.type === 'switch_port' && action.action === 'disable' && action.holdMs === 0 && (
                      <p className="text-xs text-[#E6C766] flex items-start gap-2 mb-2">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        Nothing will bring this port back. A scheduled run that crashes leaves it down
                        permanently — pick a duration unless you mean to decommission the port.
                      </p>
                    )}
                    {action.type === 'switch_port' && action.action === 'disable' && action.holdMs > 0 && (
                      <p className="text-xs text-[#786D60] mb-2">
                        The port restores itself after the hold, even if Aether restarts. Do not add a second
                        rule to bring it back.
                      </p>
                    )}

                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[#ADA294]">Delay before this action:</span>
                      <input
                        type="number"
                        value={action.delay || 0}
                        onChange={(e) => updateAction(action.id, 'delay', parseInt(e.target.value) || 0)}
                        className="w-20 bg-[#38302A] border border-[#4A3F36] rounded px-2 py-1"
                      />
                      <span className="text-[#ADA294]">ms</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={saveRule}
              className="flex-1 px-6 py-3 bg-[#4F8B5C] hover:bg-[#3E6E48] rounded-lg font-semibold"
            >
              {editingRule ? 'Update' : 'Create'}
            </button>
            <button
              onClick={resetRuleBuilder}
              className="px-6 py-3 bg-[#4A3F36] hover:bg-[#38302A] rounded-lg font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {/* Rules List */}
      <div className="bg-[#241E19]/50 backdrop-blur rounded-xl p-6 border border-[#38302A]">
        <h3 className="text-xl font-bold mb-4">Active Rules</h3>
        {automationRules.length === 0 ? (
          <div className="bg-[#15110B]/50 rounded-lg p-8 text-center text-[#ADA294] border-2 border-dashed border-[#4A3F36]">
            <p>No rules yet. Click "New Rule" to create one.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {automationRules.sort((a, b) => b.priority - a.priority).map((rule) => {
              const isExpanded = expandedRules.has(rule.id);
              const touchesSwitch = (rule.actions || []).some((a: any) => a.type === 'switch_port');
              return (
                <div
                  key={rule.id}
                  className={`bg-[#15110B]/50 rounded-lg border ${
                    rule.enabled ? 'border-[#4F8B5C]/30' : 'border-[#4A3F36]'
                  }`}
                >
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1">
                      <button
                        onClick={() => toggleRule(rule.id, !rule.enabled)}
                        className={`p-2 rounded ${
                          rule.enabled ? 'bg-[#4F8B5C] hover:bg-[#3E6E48]' : 'bg-[#4A3F36] hover:bg-[#38302A]'
                        }`}
                      >
                        {rule.enabled ? <Power className="w-5 h-5" /> : <PowerOff className="w-5 h-5" />}
                      </button>
                      
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h4 className="font-semibold text-lg">{rule.name}</h4>
                          <span className="px-2 py-1 bg-[#F0A73C]/20 text-[#F0A73C] rounded text-xs font-semibold">
                            P{rule.priority}
                          </span>
                          {touchesSwitch && (
                            <span className="px-2 py-1 bg-[#5FB7B0]/20 text-[#8FD3CD] rounded text-xs flex items-center gap-1">
                              <Network size={12} /> switch
                            </span>
                          )}
                          {rule.stats?.executions && rule.stats.executions > 0 && (
                            <span className="px-2 py-1 bg-[#5FB7B0]/20 text-[#5FB7B0] rounded text-xs">
                              {rule.stats.executions}x
                            </span>
                          )}
                        </div>
                        {rule.description && (
                          <p className="text-sm text-[#ADA294] mt-1">{rule.description}</p>
                        )}
                        <div className="text-xs text-[#786D60] mt-2">
                          <span className="font-semibold">Trigger:</span> {renderTriggerDescription(rule.trigger)}
                        </div>
                      </div>
                      <button onClick={() => toggleExpanded(rule.id)} className="p-2 hover:bg-[#38302A] rounded">
                        {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => editRule(rule)}
                        className="px-3 py-2 bg-[#F0A73C] hover:bg-[#C9862E] rounded text-sm"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="px-3 py-2 bg-[#C6604F] hover:bg-[#A84E3F] rounded text-sm"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-[#38302A] pt-3">
                      <div className="text-sm font-semibold text-[#7BD497] mb-2">Actions:</div>
                      <div className="space-y-1">
                        {rule.actions?.map((action: any, idx: number) => (
                          <div key={idx} className="text-sm text-[#C4B9AB] pl-4">
                            {idx + 1}. {renderActionDescription(action)}
                            {action.delay > 0 && <span className="text-[#ADA294] ml-2">(+{action.delay}ms)</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
export default AutomationSection;
