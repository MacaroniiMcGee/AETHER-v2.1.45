import React, { useState, useEffect } from 'react';
import { Activity, Plus, Trash2, Edit, Power, PowerOff, ChevronDown, ChevronUp } from 'lucide-react';

/** ---------- Types ---------- */
type InputItem = { id: number; name: string; type: string; gpio: number; active: boolean };
type OutputItem = { id: number; name: string; type: string; gpio: number; active: boolean };

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
interface AutomationSectionProps {
  ipAddress: string;
  connected: boolean;
  inputs: InputItem[];
  outputs: OutputItem[];
  controllerOutputs: OutputItem[];
  doors: any[];
  readers: any[];
  logSystem: (type: string, message: string) => void;
}

/** ---------- Helper ---------- */
async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await r.json();
    return await r.text();
  } catch (e) {
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const AutomationSection: React.FC<AutomationSectionProps> = ({
  ipAddress,
  connected,
  inputs,
  outputs,
  controllerOutputs,
  doors,
  readers,
  logSystem,
}) => {
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [showRuleBuilder, setShowRuleBuilder] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  
  const [ruleName, setRuleName] = useState('');
  const [ruleDescription, setRuleDescription] = useState('');
  const [rulePriority, setRulePriority] = useState(5);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  
  const [triggerType, setTriggerType] = useState('gpio_change');
  const [triggerPin, setTriggerPin] = useState(17);
  const [triggerValue, setTriggerValue] = useState<0 | 1>(1);
  const [triggerDoorId, setTriggerDoorId] = useState(1);
  const [triggerDoorEvent, setTriggerDoorEvent] = useState('lock');
  const [triggerReaderId, setTriggerReaderId] = useState('reader-1');
  
  const [actions, setActions] = useState<any[]>([]);

  useEffect(() => {
    if (connected) {
      fetchAutomationRules();
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

  const saveRule = async () => {
    if (!ruleName.trim()) {
      logSystem('error', 'Rule name is required');
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
      }

      const ruleData = {
        name: ruleName,
        description: ruleDescription,
        enabled: ruleEnabled,
        priority: rulePriority,
        trigger,
        conditions: [],
        actions
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
    } catch (e) {
      logSystem('error', `Failed to save rule: ${e}`);
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
    setRuleName(rule.name);
    setRuleDescription(rule.description || '');
    setRulePriority(rule.priority);
    setRuleEnabled(rule.enabled);
    
    if (rule.trigger?.type === 'gpio_change') {
      setTriggerType('gpio_change');
      setTriggerPin(rule.trigger.pin || 17);
      setTriggerValue(rule.trigger.value || 1);
    } else if (rule.trigger?.type === 'door_event') {
      setTriggerType('door_event');
      setTriggerDoorId(rule.trigger.doorId || 1);
      setTriggerDoorEvent(rule.trigger.event || 'lock');
      setTriggerValue(rule.trigger.value || 1);
    } else if (rule.trigger?.type === 'reader_event') {
      setTriggerType('reader_event');
      setTriggerReaderId(rule.trigger.readerId || 'reader-1');
    }
    
    setActions(rule.actions || []);
    setShowRuleBuilder(true);
  };

  const resetRuleBuilder = () => {
    setRuleName('');
    setRuleDescription('');
    setRulePriority(5);
    setRuleEnabled(true);
    setTriggerType('gpio_change');
    setTriggerPin(17);
    setTriggerValue(1);
    setTriggerDoorId(1);
    setTriggerDoorEvent('lock');
    setTriggerReaderId('reader-1');
    setActions([]);
    setEditingRule(null);
    setShowRuleBuilder(false);
  };

  const addAction = () => {
    setActions([...actions, {
      id: Date.now(),
      type: 'gpio',
      pin: 6,
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

  const renderTriggerDescription = (trigger: any): string => {
    if (!trigger?.type) return 'Unknown trigger';
    if (trigger.type === 'gpio_change') {
      return `GPIO ${trigger.pin} → ${trigger.value === 1 ? 'HIGH' : 'LOW'}`;
    } else if (trigger.type === 'door_event') {
      const door = doors.find((d: any) => d.id === trigger.doorId);
      return `${door?.name || 'Door'} ${trigger.event}`;
    } else if (trigger.type === 'reader_event') {
      return `Reader: ${trigger.readerId}`;
    }
    return 'Unknown';
  };

  const renderActionDescription = (action: any): string => {
    if (!action?.type) return 'Unknown action';
    if (action.type === 'gpio') {
      return `GPIO ${action.pin} → ${action.value === 1 ? 'HIGH' : 'LOW'}`;
    } else if (action.type === 'gpio_pulse') {
      return `Pulse GPIO ${action.pin} (${action.duration || 500}ms)`;
    } else if (action.type === 'door_action') {
      return `Door ${action.doorId}: ${action.action}`;
    }
    return 'Unknown';
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-900/20 to-indigo-900/20 backdrop-blur rounded-xl p-6 border border-blue-700/50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold mb-2 flex items-center gap-3">
              <Activity className="w-8 h-8 text-blue-400" />
              Automation Rules
            </h2>
            <p className="text-slate-300">
              Create conditional automation rules for doors, readers, and I/O
            </p>
          </div>
          <button
            onClick={() => {
              resetRuleBuilder();
              setShowRuleBuilder(!showRuleBuilder);
            }}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            New Rule
          </button>
        </div>
        
        {/* Stats */}
        <div className="mt-4 grid grid-cols-4 gap-4">
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-600">
            <div className="text-xs text-slate-400">Total Rules</div>
            <div className="text-2xl font-bold text-blue-400">{automationRules.length}</div>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-600">
            <div className="text-xs text-slate-400">Active Rules</div>
            <div className="text-2xl font-bold text-green-400">
              {automationRules.filter(r => r.enabled).length}
            </div>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-600">
            <div className="text-xs text-slate-400">Total Executions</div>
            <div className="text-2xl font-bold text-purple-400">
              {automationRules.reduce((sum, r) => sum + (r.stats?.executions || 0), 0)}
            </div>
          </div>
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-600">
            <div className="text-xs text-slate-400">Errors</div>
            <div className="text-2xl font-bold text-red-400">
              {automationRules.reduce((sum, r) => sum + (r.stats?.errors || 0), 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Rule Builder */}
      {showRuleBuilder && (
        <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Edit className="w-6 h-6 text-blue-400" />
            {editingRule ? 'Edit Rule' : 'Create New Rule'}
          </h3>

          <div className="space-y-4 mb-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-slate-400 block mb-2">Rule Name *</label>
                <input
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                  placeholder="Door unlock on card"
                />
              </div>
              <div>
                <label className="text-sm text-slate-400 block mb-2">Priority (1-10)</label>
                <input
                  type="number"
                  value={rulePriority}
                  onChange={(e) => setRulePriority(parseInt(e.target.value) || 5)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2"
                  min={1}
                  max={10}
                />
              </div>
            </div>
            <div>
              <label className="text-sm text-slate-400 block mb-2">Description</label>
              <textarea
                value={ruleDescription}
                onChange={(e) => setRuleDescription(e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-4 py-2 h-20"
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
              <span className="text-sm text-slate-300">Enable immediately</span>
            </label>
          </div>

          {/* Trigger */}
          <div className="bg-slate-900/50 rounded-lg p-4 border border-blue-600/30 mb-4">
            <h4 className="text-lg font-semibold mb-3 text-blue-400">Trigger (WHEN)</h4>
            <div className="space-y-3">
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2"
              >
                <option value="gpio_change">GPIO Change</option>
                <option value="door_event">Door Event</option>
                <option value="reader_event">Reader Event</option>
              </select>

              {triggerType === 'gpio_change' && (
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={triggerPin}
                    onChange={(e) => setTriggerPin(parseInt(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2"
                  >
                    {inputs.map(i => (
                      <option key={i.id} value={i.gpio}>GPIO {i.gpio} - {i.name}</option>
                    ))}
                  </select>
                  <select
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(parseInt(e.target.value) as 0 | 1)}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2"
                  >
                    <option value={1}>HIGH (1)</option>
                    <option value={0}>LOW (0)</option>
                  </select>
                </div>
              )}

              {triggerType === 'door_event' && (
                <div className="grid grid-cols-3 gap-3">
                  <select
                    value={triggerDoorId}
                    onChange={(e) => setTriggerDoorId(parseInt(e.target.value))}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2"
                  >
                    {doors.map((d: any) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <select
                    value={triggerDoorEvent}
                    onChange={(e) => setTriggerDoorEvent(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2"
                  >
                    <option value="lock">Lock</option>
                    <option value="dps">DPS</option>
                    <option value="rexIn">REX</option>
                  </select>
                  <select
                    value={triggerValue}
                    onChange={(e) => setTriggerValue(parseInt(e.target.value) as 0 | 1)}
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2"
                  >
                    <option value={1}>ACTIVE</option>
                    <option value={0}>INACTIVE</option>
                  </select>
                </div>
              )}

              {triggerType === 'reader_event' && (
                <select
                  value={triggerReaderId}
                  onChange={(e) => setTriggerReaderId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2"
                >
                  {readers.filter((r: any) => r.enabled).map((r: any) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="bg-slate-900/50 rounded-lg p-4 border border-green-600/30 mb-4">
            <div className="flex justify-between mb-3">
              <h4 className="text-lg font-semibold text-green-400">Actions (THEN) *</h4>
              <button
                onClick={addAction}
                className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-sm font-semibold"
              >
                + Add
              </button>
            </div>

            {actions.length === 0 ? (
              <div className="text-sm text-red-400 text-center py-3">
                At least one action required
              </div>
            ) : (
              <div className="space-y-2">
                {actions.map((action) => (
                  <div key={action.id} className="bg-slate-800/50 rounded-lg p-3">
                    <div className="flex items-center gap-3 mb-2">
                      <select
                        value={action.type}
                        onChange={(e) => updateAction(action.id, 'type', e.target.value)}
                        className="bg-slate-700 border border-slate-600 rounded px-3 py-2"
                      >
                        <option value="gpio">GPIO</option>
                        <option value="gpio_pulse">Pulse</option>
                        <option value="door_action">Door</option>
                      </select>

                      {action.type === 'gpio' && (
                        <>
                          <select
                            value={action.pin}
                            onChange={(e) => updateAction(action.id, 'pin', parseInt(e.target.value))}
                            className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2"
                          >
                            {[...outputs, ...controllerOutputs].map(o => (
                              <option key={o.id} value={o.gpio}>GPIO {o.gpio} - {o.name}</option>
                            ))}
                          </select>
                          <select
                            value={action.value}
                            onChange={(e) => updateAction(action.id, 'value', parseInt(e.target.value))}
                            className="bg-slate-700 border border-slate-600 rounded px-3 py-2"
                          >
                            <option value={1}>HIGH</option>
                            <option value={0}>LOW</option>
                          </select>
                        </>
                      )}

                      {action.type === 'gpio_pulse' && (
                        <>
                          <select
                            value={action.pin}
                            onChange={(e) => updateAction(action.id, 'pin', parseInt(e.target.value))}
                            className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2"
                          >
                            {[...outputs, ...controllerOutputs].map(o => (
                              <option key={o.id} value={o.gpio}>GPIO {o.gpio} - {o.name}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            value={action.duration || 500}
                            onChange={(e) => updateAction(action.id, 'duration', parseInt(e.target.value) || 500)}
                            className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-2"
                          />
                          <span className="text-xs">ms</span>
                        </>
                      )}

                      {action.type === 'door_action' && (
                        <>
                          <select
                            value={action.doorId || 1}
                            onChange={(e) => updateAction(action.id, 'doorId', parseInt(e.target.value))}
                            className="bg-slate-700 border border-slate-600 rounded px-3 py-2"
                          >
                            {doors.map((d: any) => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </select>
                          <select
                            value={action.action || 'unlock'}
                            onChange={(e) => updateAction(action.id, 'action', e.target.value)}
                            className="bg-slate-700 border border-slate-600 rounded px-3 py-2"
                          >
                            <option value="unlock">Unlock</option>
                            <option value="lock">Lock</option>
                            <option value="momentary">Momentary</option>
                          </select>
                        </>
                      )}

                      <button
                        onClick={() => removeAction(action.id)}
                        className="px-2 py-1 bg-red-600 hover:bg-red-700 rounded"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-slate-400">Delay:</span>
                      <input
                        type="number"
                        value={action.delay || 0}
                        onChange={(e) => updateAction(action.id, 'delay', parseInt(e.target.value) || 0)}
                        className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1"
                      />
                      <span className="text-slate-400">ms</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={saveRule}
              className="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-semibold"
            >
              {editingRule ? 'Update' : 'Create'}
            </button>
            <button
              onClick={resetRuleBuilder}
              className="px-6 py-3 bg-slate-600 hover:bg-slate-700 rounded-lg font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Rules List */}
      <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
        <h3 className="text-xl font-bold mb-4">Active Rules</h3>
        {automationRules.length === 0 ? (
          <div className="bg-slate-900/50 rounded-lg p-8 text-center text-slate-400 border-2 border-dashed border-slate-600">
            <p>No rules yet. Click "New Rule" to create one.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {automationRules.sort((a, b) => b.priority - a.priority).map((rule) => {
              const isExpanded = expandedRules.has(rule.id);
              return (
                <div
                  key={rule.id}
                  className={`bg-slate-900/50 rounded-lg border ${
                    rule.enabled ? 'border-green-600/30' : 'border-slate-600'
                  }`}
                >
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1">
                      <button
                        onClick={() => toggleRule(rule.id, !rule.enabled)}
                        className={`p-2 rounded ${
                          rule.enabled ? 'bg-green-600 hover:bg-green-700' : 'bg-slate-600 hover:bg-slate-700'
                        }`}
                      >
                        {rule.enabled ? <Power className="w-5 h-5" /> : <PowerOff className="w-5 h-5" />}
                      </button>
                      
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h4 className="font-semibold text-lg">{rule.name}</h4>
                          <span className="px-2 py-1 bg-blue-600/20 text-blue-400 rounded text-xs font-semibold">
                            P{rule.priority}
                          </span>
                          {rule.stats?.executions && rule.stats.executions > 0 && (
                            <span className="px-2 py-1 bg-purple-600/20 text-purple-400 rounded text-xs">
                              {rule.stats.executions}x
                            </span>
                          )}
                        </div>
                        {rule.description && (
                          <p className="text-sm text-slate-400 mt-1">{rule.description}</p>
                        )}
                        <div className="text-xs text-slate-500 mt-2">
                          <span className="font-semibold">Trigger:</span> {renderTriggerDescription(rule.trigger)}
                        </div>
                      </div>

                      <button onClick={() => toggleExpanded(rule.id)} className="p-2 hover:bg-slate-700 rounded">
                        {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      </button>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => editRule(rule)}
                        className="px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="px-3 py-2 bg-red-600 hover:bg-red-700 rounded text-sm"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-slate-700 pt-3">
                      <div className="text-sm font-semibold text-green-400 mb-2">Actions:</div>
                      <div className="space-y-1">
                        {rule.actions?.map((action: any, idx: number) => (
                          <div key={idx} className="text-sm text-slate-300 pl-4">
                            {idx + 1}. {renderActionDescription(action)}
                            {action.delay > 0 && <span className="text-slate-400 ml-2">(+{action.delay}ms)</span>}
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
