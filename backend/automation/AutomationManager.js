// AutomationManager.js
// CommonJS module. Wires Automation rules to GPIO + optional Wiegand actions.

const fs = require('fs');
const path = require('path');
const pinRegistry = require('../lib/pinRegistry'); // ✅ ADDED: Import pinRegistry for validation

class AutomationManager {
  /**
   * @param {EventEmitter} gpioEvents - bidirectional event bus used by server.js
   * @param {object|null} wiegandManager - optional; must implement:
   *   - initialize()
   *   - sendCard(readerId:number|string, facility:number, card:number, format?:number|null)
   *   - sendRaw(readerId:string, bits:string|Buffer)
   *   - isPinReserved(pin:number) => boolean
   *   - getReaders(), getReader(id), getStatus()
   *   - reservedPins: Set<number>
   */
    constructor(gpioEvents, wiegandManager = null, switchManager = null) {
    this.gpioEvents = gpioEvents;
    this.wiegand = wiegandManager || null;
    this.switches = switchManager || null;

    // rule storage / stats
    this.rules = [];
    this.stats = {
      loadedAt: null,
      triggers: 0,
      lastTriggerAt: null,
      ruleCounts: { enabled: 0, disabled: 0 }
    };

    // scheduler handles
    this._schedules = new Map(); // ruleId -> intervalId
    this._dataDir = path.join(__dirname, '..', 'data');
    this._rulesFile = path.join(this._dataDir, 'automation-rules.json');

    // Bind event listener once
    this._onGpioChange = this._onGpioChange.bind(this);
  }

  // ---------- Public API used by server.js ----------

  async initialize() {
    await this._ensureDataDir();
    await this._loadRulesFromDisk();
    this._applySchedules();

    // Listen to GPIO change events coming from server.js
    // server.js emits: gpioEvents.emit('gpio_change', { pin, value, timestamp })
    this.gpioEvents.on('gpio_change', this._onGpioChange);
  }

  getRules() {
    return this.rules;
  }

  getStats() {
    return {
      ...this.stats,
      rulesTotal: this.rules.length
    };
  }

  addRule(rule) {
    this._validateRule(rule, { allowMissingId: false });
    if (this.rules.find(r => r.id === rule.id)) {
      throw new Error(`Rule with id "${rule.id}" already exists`);
    }
    this.rules.push(rule);
    this._persistAndReschedule();
  }

  updateRule(id, updates) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx < 0) throw new Error(`Rule "${id}" not found`);

    const updated = { ...this.rules[idx], ...updates };
    this._validateRule(updated, { allowMissingId: true });
    this.rules[idx] = updated;
    this._persistAndReschedule();
  }

  removeRule(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx < 0) throw new Error(`Rule "${id}" not found`);
    this.rules.splice(idx, 1);
    this._persistAndReschedule();
  }

  enableRule(id) {
    const r = this.rules.find(x => x.id === id);
    if (!r) throw new Error(`Rule "${id}" not found`);
    r.enabled = true;
    this._persistAndReschedule();
  }

  disableRule(id) {
    const r = this.rules.find(x => x.id === id);
    if (!r) throw new Error(`Rule "${id}" not found`);
    r.enabled = false;
    this._persistAndReschedule();
  }

  /**
   * Manual trigger endpoint support:
   * triggerEvent('gpio_change', { pin: 17, value: 1 })
   * triggerEvent('schedule', { ruleId: 'some-id' }) – optional direct kick
   */
  async triggerEvent(event, data) {
    if (event === 'gpio_change') {
      await this._handleEventMatch('gpio_change', data || {});
      return;
    }
    if (event === 'schedule') {
      const { ruleId } = data || {};
      const rule = this.rules.find(r => r.id === ruleId);
      if (!rule) throw new Error(`Rule "${ruleId}" not found`);
      if (!rule.enabled) return;
      await this._executeActions(rule);
      return;
    }
    throw new Error(`Unsupported event "${event}"`);
  }

  // ---------- Internal: Rule I/O ----------

  async _ensureDataDir() {
    try {
      await fs.promises.mkdir(this._dataDir, { recursive: true });
    } catch (_) {}
  }

  async _loadRulesFromDisk() {
    try {
      const txt = await fs.promises.readFile(this._rulesFile, 'utf8');
      const data = JSON.parse(txt);
      if (Array.isArray(data.rules)) {
        this.rules = data.rules;
      } else if (Array.isArray(data)) {
        // backwards compat: a bare array
        this.rules = data;
      } else {
        this.rules = [];
      }
      this._recount();
      this.stats.loadedAt = new Date().toISOString();
      // Sort by priority DESC, then id for stability
      this.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)));
      console.log(`[Automation] Loaded ${this.rules.length} rules from ${path.basename(this._rulesFile)}`);
    } catch (err) {
      console.warn('[Automation] No rules file found or failed to parse; starting empty:', err.message);
      this.rules = [];
      this._recount();
    }
  }

  async _saveRulesToDisk() {
    const json = JSON.stringify({ version: 'managed', savedAt: new Date().toISOString(), rules: this.rules }, null, 2);
    await fs.promises.writeFile(this._rulesFile, json, 'utf8');
  }

  _persistAndReschedule() {
    // Persist
    this._saveRulesToDisk().catch(e => console.error('[Automation] Save error:', e.message));
    // Recompute schedule timers
    this._clearSchedules();
    this._applySchedules();
    this._recount();
  }

  _recount() {
    const enabled = this.rules.filter(r => r.enabled !== false).length;
    this.stats.ruleCounts = {
      enabled,
      disabled: this.rules.length - enabled
    };
  }

  // ---------- Internal: Event Matching ----------

  async _onGpioChange(payload) {
    await this._handleEventMatch('gpio_change', payload);
  }

  async _handleEventMatch(type, payload) {
    // Apply priority ordering
    this.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)));

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (this._conditionsMatch(rule.conditions, type, payload)) {
        await this._executeActions(rule, payload).catch(err => {
          console.error(`[Automation] Rule "${rule.id}" action error:`, err.message);
        });
        this.stats.triggers += 1;
        this.stats.lastTriggerAt = new Date().toISOString();
      }
    }
  }

  _conditionsMatch(conditions, incomingType, payload) {
    if (!conditions || typeof conditions !== 'object') return false;

    // schedule-only rules are handled by scheduler
    if (conditions.schedule) return false;

    const checks = Array.isArray(conditions.all) ? conditions.all : [conditions.all || conditions];

    for (const c of checks) {
      if (!c || typeof c !== 'object') return false;
      if (c.event && c.event !== incomingType) return false;

      // GPIO condition matching
      if (incomingType === 'gpio_change') {
        if (typeof c.pin === 'number' && c.pin !== payload.pin) return false;
        if (typeof c.value === 'number' && c.value !== payload.value) return false;
      }
    }
    return true;
  }

  // ---------- Internal: Schedules ----------

  _clearSchedules() {
    for (const [, handle] of this._schedules) {
      clearInterval(handle);
    }
    this._schedules.clear();
  }

  _applySchedules() {
    // Expect: conditions.schedule = { time: "HH:MM", days: [1..5], etc. }
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const sched = rule.conditions && rule.conditions.schedule;
      if (!sched) continue;

      const handle = setInterval(() => {
        try {
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, '0');
          const mm = String(now.getMinutes()).padStart(2, '0');
          const cur = `${hh}:${mm}`;

          const timeOk = (sched.time && sched.time === cur);
          if (!timeOk) return;

          let dayOk = true;
          if (Array.isArray(sched.days) && sched.days.length) {
            // Normalize to JS 0-6 (Sun..Sat); accept 1-7 (Mon..Sun) in input
            const dow0_6 = now.getDay(); // 0..6
            const normalized = sched.days.map(d => {
              if (d === 7) return 0; // Sun
              if (d >= 1 && d <= 6) return d; // Mon..Sat mapped to 1..6
              return d; // already 0..6?
            });
            dayOk = normalized.includes(dow0_6);
          }

          if (dayOk) {
            this._executeActions(rule).catch(e => console.error(`[Automation] Schedule "${rule.id}" error:`, e.message));
            this.stats.triggers += 1;
            this.stats.lastTriggerAt = new Date().toISOString();
          }
        } catch (e) {
          console.error('[Automation] Schedule tick error:', e.message);
        }
      }, 1000 * 30); // check twice per minute to be resilient
      this._schedules.set(rule.id, handle);
    }
  }

  // ---------- Internal: Action Execution ----------

  async _executeActions(rule, payload = {}) {
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    for (const act of actions) {
      const type = act?.type;
      const params = act?.params || {};

      switch (type) {
        case 'log': {
          const level = (params.level || 'info').toLowerCase();
          const msg = params.message || `[Rule:${rule.id}] log`;
          const line = `[Automation][${level.toUpperCase()}] ${msg}`;
          if (level === 'warn') console.warn(line);
          else if (level === 'error') console.error(line);
          else console.log(line);
          break;
        }

        case 'delay': {
          const ms = Math.max(0, Number(params.duration || params.msec || 0));
          await new Promise(r => setTimeout(r, ms));
          break;
        }

        case 'gpio': {
          const pin = Number(params.pin);
          const value = Number(params.value);
          const duration = params.duration != null ? Number(params.duration) : null;

          if (!Number.isInteger(pin) || !(value === 0 || value === 1)) {
            throw new Error(`Invalid gpio params for rule "${rule.id}"`);
          }

          // ✅ ADDED: Validate pin is not reserved (hardware or Wiegand)
          const validation = pinRegistry.validatePinForIO(pin);
          if (!validation.valid) {
            throw new Error(`GPIO ${pin} cannot be used: ${validation.reason}`);
          }

          // ✅ ENHANCED: Double-check Wiegand pins
          if (this.wiegand && typeof this.wiegand.isPinReserved === 'function' && this.wiegand.isPinReserved(pin)) {
            throw new Error(`GPIO ${pin} is RESERVED for Wiegand transmission`);
          }

          if (Number.isInteger(duration) && duration > 0) {
            this.gpioEvents.emit('gpio_action', { pin, value: 1 });
            await new Promise(r => setTimeout(r, duration));
            this.gpioEvents.emit('gpio_action', { pin, value: 0 });
          } else {
            this.gpioEvents.emit('gpio_action', { pin, value });
          }
          break;
        }

        case 'gpio_pulse': {
          const pin = Number(params.pin);
          const duration = Math.max(1, Number(params.duration || params.msec || 300));
          
          if (!Number.isInteger(pin)) {
            throw new Error(`Invalid gpio_pulse pin for rule "${rule.id}"`);
          }
          
          // ✅ ADDED: Validate pin is not reserved (hardware or Wiegand)
          const validation = pinRegistry.validatePinForIO(pin);
          if (!validation.valid) {
            throw new Error(`GPIO ${pin} cannot be used: ${validation.reason}`);
          }
          
          // ✅ ENHANCED: Double-check Wiegand pins
          if (this.wiegand && typeof this.wiegand.isPinReserved === 'function' && this.wiegand.isPinReserved(pin)) {
            throw new Error(`GPIO ${pin} is RESERVED for Wiegand transmission`);
          }
          
          this.gpioEvents.emit('gpio_action', { pin, value: 1 });
          await new Promise(r => setTimeout(r, duration));
          this.gpioEvents.emit('gpio_action', { pin, value: 0 });
          break;
        }

        case 'wiegand_send': {
          if (!this.wiegand) throw new Error('Wiegand system not initialized');
          const { readerId, facility, card, format = null } = params;
          if (!readerId || facility === undefined || card === undefined) {
            throw new Error(`wiegand_send requires readerId, facility, card`);
          }
          await this.wiegand.sendCard(
            String(readerId),
            Number(facility),
            Number(card),
            format !== null ? Number(format) : null
          );
          break;
        }

                case 'wiegand_raw': {
          if (!this.wiegand) throw new Error('Wiegand system not initialized');
          const { readerId, bits } = params;
          if (!readerId || !bits) throw new Error('wiegand_raw requires readerId and bits');
          await this.wiegand.sendRaw(String(readerId), bits);
          break;
        }

        case 'switch_port': {
          if (!this.switches) throw new Error('Switch system not initialized');
          const { profileId, port, action, holdMs, reason } = params;
          if (!profileId || port === undefined || !action) {
            throw new Error(`switch_port requires profileId, port and action`);
          }
          if (action !== 'enable' && action !== 'disable') {
            throw new Error(`switch_port action must be "enable" or "disable"`);
          }
          await this.switches.setPort(String(profileId), Number(port), action === 'enable', {
            holdMs: holdMs === undefined ? undefined : Number(holdMs),
            reason: reason || `automation:${rule.id}`
          });
          break;
        }

        default:
          console.warn(`[Automation] Unknown action type "${type}" in rule "${rule.id}" — skipping`);
      }
    }
  }

  // ---------- Validation ----------

  /**
   * ✅ ENHANCED: Complete validation with GPIO pin and parameter checking
   */
  _validateRule(rule, { allowMissingId = false } = {}) {
    if (!rule || typeof rule !== 'object') {
      throw new Error('Rule must be an object');
    }
    
    if (!allowMissingId && !rule.id) {
      throw new Error('Rule.id is required');
    }
    
    if (!rule.name) {
      throw new Error('Rule.name is required');
    }
    
    if (rule.enabled === undefined) {
      throw new Error('Rule.enabled field is required');
    }
    
    if (rule.priority === undefined) {
      throw new Error('Rule.priority field is required');
    }
    
    if (!rule.actions || !Array.isArray(rule.actions)) {
      throw new Error('Rule.actions must be an array');
    }
    
    if (rule.actions.length === 0) {
      throw new Error('Rule must have at least one action');
    }
    
    if (rule.conditions && typeof rule.conditions !== 'object') {
      throw new Error('Rule.conditions must be an object if provided');
    }

    // ✅ ADDED: Validate trigger if present (new-style rules)
    if (rule.trigger) {
      if (!rule.trigger.type) {
        throw new Error('Trigger must have a type');
      }
      if (rule.trigger.type === 'gpio_change') {
        if (!Number.isInteger(rule.trigger.pin)) {
          throw new Error('GPIO trigger must have valid pin number');
        }
        if (rule.trigger.value !== 0 && rule.trigger.value !== 1) {
          throw new Error('GPIO trigger value must be 0 or 1');
        }
      }
    }

    // ✅ ADDED: Validate conditions array
    if (rule.conditions) {
      const conditionsArray = Array.isArray(rule.conditions) 
        ? rule.conditions 
        : (rule.conditions.all || []);

      for (let i = 0; i < conditionsArray.length; i++) {
        const condition = conditionsArray[i];
        if (condition.type === 'gpio_state') {
          if (!Number.isInteger(condition.pin)) {
            throw new Error(`Condition ${i + 1}: GPIO state must have valid pin number`);
          }
          if (condition.value !== 0 && condition.value !== 1) {
            throw new Error(`Condition ${i + 1}: GPIO state value must be 0 or 1`);
          }
        }
      }
    }

    // ✅ ENHANCED: Detailed action validation
    for (let i = 0; i < rule.actions.length; i++) {
      const action = rule.actions[i];
      
      if (!action || typeof action !== 'object') {
        throw new Error(`Action ${i + 1} must be an object`);
      }
      
      if (!action.type) {
        throw new Error(`Action ${i + 1} must have a type`);
      }

      // Validate GPIO actions
      if (action.type === 'gpio') {
        if (!action.params) {
          throw new Error(`GPIO action ${i + 1} must have params object`);
        }
        if (!Number.isInteger(action.params.pin)) {
          throw new Error(`GPIO action ${i + 1} must have valid pin number in params`);
        }
        if (action.params.value !== 0 && action.params.value !== 1) {
          throw new Error(`GPIO action ${i + 1} must have value 0 or 1 in params`);
        }
        
        // ✅ ADDED: Validate the pin is not reserved
        const validation = pinRegistry.validatePinForIO(action.params.pin);
        if (!validation.valid) {
          throw new Error(`GPIO action ${i + 1}: ${validation.reason}`);
        }
      }

      // Validate GPIO pulse actions
      if (action.type === 'gpio_pulse') {
        if (!action.params) {
          throw new Error(`GPIO pulse action ${i + 1} must have params object`);
        }
        if (!Number.isInteger(action.params.pin)) {
          throw new Error(`GPIO pulse action ${i + 1} must have valid pin number in params`);
        }
        
        // ✅ ADDED: Validate the pin is not reserved
        const validation = pinRegistry.validatePinForIO(action.params.pin);
        if (!validation.valid) {
          throw new Error(`GPIO pulse action ${i + 1}: ${validation.reason}`);
        }
      }

      // Validate delay actions
      if (action.type === 'delay') {
        if (!action.params || !Number.isInteger(action.params.duration) || action.params.duration < 0) {
          throw new Error(`Delay action ${i + 1} must have valid duration in params`);
        }
      }

      // Validate wiegand_send actions
      if (action.type === 'wiegand_send') {
        if (!action.params) {
          throw new Error(`Wiegand send action ${i + 1} must have params object`);
        }
        if (!action.params.readerId) {
          throw new Error(`Wiegand send action ${i + 1} must have readerId in params`);
        }
        if (!Number.isInteger(action.params.facility)) {
          throw new Error(`Wiegand send action ${i + 1} must have facility code in params`);
        }
        if (!Number.isInteger(action.params.card)) {
          throw new Error(`Wiegand send action ${i + 1} must have card number in params`);
        }
      }

      // ✅ ADDED: Validate log actions
      if (action.type === 'log') {
        if (!action.params) {
          throw new Error(`Log action ${i + 1} must have params object`);
        }
      }

            if (action.type === 'switch_port') {
        if (!action.params) {
          throw new Error(`switch_port action ${i + 1} must have params object`);
        }
        if (!action.params.profileId) {
          throw new Error(`switch_port action ${i + 1} must have profileId in params`);
        }
        if (!Number.isInteger(action.params.port)) {
          throw new Error(`switch_port action ${i + 1} must have valid port number in params`);
        }
        if (!['enable', 'disable'].includes(action.params.action)) {
          throw new Error(`switch_port action ${i + 1} must have action "enable" or "disable"`);
        }
      }

      // ✅ ADDED: Reject invalid action types
      const validTypes = ['gpio', 'gpio_pulse', 'delay', 'log', 'wiegand_send', 'wiegand_raw', 'emit', 'http', 'switch_port'];
      if (!validTypes.includes(action.type)) {
        throw new Error(`Action ${i + 1} has invalid type: ${action.type}`);
      }
    }

    console.log(`[AutomationManager] Rule "${rule.id || 'new'}" validated successfully`);
  }
}

module.exports = AutomationManager;
