// AutomationManager.js
// CommonJS module. Wires Automation rules to GPIO + optional Wiegand actions.

const fs = require('fs');
const path = require('path');
const pinRegistry = require('../lib/pinRegistry'); // ✅ ADDED: Import pinRegistry for validation
// AETHER_AEGIS_AUTOMATION: event normalisation / trigger + condition matching (pure, tested) and the firing log
const aegis = require('./aegis');
const LogService = require('./LogService');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// AETHER_AEGIS_AUTOMATION (review fix): a function that runs once; later calls get the same promise
const once = (fn) => { let p = null; return () => (p || (p = Promise.resolve().then(fn))); };

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
    constructor(gpioEvents, wiegandManager = null, switchManager = null, opts = {}) {
    this.gpioEvents = gpioEvents;
    // AETHER_AEGIS_AUTOMATION: relay actions go through server.js's GPIO queue (IOplus REL 1-8);
    // the original 'gpio' actions drive Pi GPIO pins with gpioset and stay as they were.
    this.setRelay = opts && typeof opts.setRelay === 'function' ? opts.setRelay : null;
    this.log = new LogService(Number(opts && opts.logSize) || 300);
    this._ruleStats = new Map();                  // ruleId -> { executions, lastExecuted, errors, lastError, skipped, lastDurationMs }
    this._state = { relay: {}, opto: {}, zone: {}, gpio: {} };   // last known I/O, for IF conditions
    this._eventsSeen = {};                        // type -> { count, lastAt }
    this._running = new Set();                    // rules whose actions are running (loop guard)
    this._fireTimes = new Map();                  // ruleId -> recent fire times (loop guard)
    this._lastScheduleKey = new Map();            // ruleId -> 'YYYY-MM-DD HH:MM' already fired
    this._today = { date: null, fired: 0, errors: 0 };
    this.rateLimit = { max: Number(opts && opts.rateMax) || 5, windowMs: Number(opts && opts.rateWindowMs) || 2000 };
    // AETHER_AEGIS_AUTOMATION (review fix 1): loop protection that does not depend on timing.
    //  - every relay write a rule makes is marked (channel -> run), so the event it causes is
    //    attributed to that rule: a rule is never triggered by its own writes, and an
    //    automation-caused event carries its hop depth (at most maxHops hops, then nothing fires);
    //  - global caps: automation runs and relay writes per second (releases are exempt);
    //  - a rule that runs more than disableRuns times in disableWindowMs is DISABLED (saved).
    const o = opts || {};
    this.limits = {
      maxHops: Number.isInteger(o.maxHops) ? o.maxHops : 2,
      writesPerSec: Number(o.writesPerSec) || 4,
      runsPerSec: Number(o.runsPerSec) || 10,
      disableRuns: Number(o.disableRuns) || 10,
      disableWindowMs: Number(o.disableWindowMs) || 30000,
      releaseRetryMs: Number(o.releaseRetryMs) || 10000,
    };
    this._marks = new Map();        // relay channel -> [{ token, ruleId, depth, value }]
    this._gpioCause = null;         // set while a rule's Pi GPIO action is being emitted
    this._relayWriter = {};         // channel -> token of the last write (ours or 'ext-n')
    this._seq = 0;
    this._runs = new Map();         // runId -> run (cancel token)
    this._writeTimes = [];          // automation relay writes (global cap)
    this._runTimes = [];            // automation runs (global cap)
    this._attempts = new Map();     // ruleId -> fire attempts in disableWindowMs (auto-disable)
    this.hopsStopped = 0;
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
    this._dataDir = (opts && opts.dataDir) || path.join(__dirname, '..', 'data');   // AETHER_AEGIS_AUTOMATION: tests use a temp dir
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

  // AETHER_AEGIS_AUTOMATION: each rule carries its run stats (kept in memory, not in the rules file)
  getRules() {
    return this.rules.map(r => ({ ...r, stats: this._statsFor(r.id) }));
  }

  getStats() {
    this._rollToday();
    return {
      ...this.stats,
      rulesTotal: this.rules.length,
      // AETHER_AEGIS_AUTOMATION: engine summary for the page
      firedToday: this._today.fired,
      errorsToday: this._today.errors,
      errorsTotal: Array.from(this._ruleStats.values()).reduce((s, x) => s + (x.errors || 0), 0),
      eventsSeen: { ...this._eventsSeen },
      actionsAvailable: { relay: !!this.setRelay, wiegand: !!this.wiegand, switch: !!this.switches },
      logSize: this.log.all().length,
    };
  }

  /** AETHER_AEGIS_AUTOMATION: newest first. */
  getLog(limit = 50) {
    const n = Math.max(1, Math.min(300, Number(limit) || 50));
    return this.log.all().slice(-n).reverse();
  }

  _statsFor(id) {
    const s = this._ruleStats.get(id);
    return s ? { ...s } : { executions: 0, lastExecuted: null, errors: 0, lastError: null, skipped: 0 };
  }

  _rollToday() {
    const d = new Date().toDateString();
    if (this._today.date !== d) this._today = { date: d, fired: 0, errors: 0 };
  }

  addRule(rule) {
    if (rule && typeof rule === 'object') { rule = this._normalizeRule({ ...rule }); delete rule.stats; }   // AETHER_AEGIS_AUTOMATION: stats are not saved
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

    const updated = this._normalizeRule({ ...this.rules[idx], ...updates });
    delete updated.stats;   // AETHER_AEGIS_AUTOMATION: stats are not saved
    if (updated.enabled) delete updated.disabledReason;
    this._validateRule(updated, { allowMissingId: true });
    this.rules[idx] = updated;
    this._cancelRuns(id, 'rule changed');   // AETHER_AEGIS_AUTOMATION (review fix 2)
    this._persistAndReschedule();
  }

  removeRule(id) {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx < 0) throw new Error(`Rule "${id}" not found`);
    this.rules.splice(idx, 1);
    this._cancelRuns(id, 'rule deleted');   // AETHER_AEGIS_AUTOMATION (review fix 2)
    this._attempts.delete(id);
    this._ruleStats.delete(id); this._fireTimes.delete(id); this._lastScheduleKey.delete(id);   // AETHER_AEGIS_AUTOMATION: a new rule with this id starts clean
    this._persistAndReschedule();
  }

  enableRule(id) {
    const r = this.rules.find(x => x.id === id);
    if (!r) throw new Error(`Rule "${id}" not found`);
    r.enabled = true;
    delete r.disabledReason;   // AETHER_AEGIS_AUTOMATION: turned back on by hand
    this._attempts.delete(id);
    this._persistAndReschedule();
  }

  disableRule(id) {
    const r = this.rules.find(x => x.id === id);
    if (!r) throw new Error(`Rule "${id}" not found`);
    r.enabled = false;
    this._cancelRuns(id, 'rule disabled');   // AETHER_AEGIS_AUTOMATION (review fix 2)
    this._persistAndReschedule();
  }

  /**
   * Manual trigger endpoint support:
   * triggerEvent('gpio_change', { pin: 17, value: 1 })
   * triggerEvent('schedule', { ruleId: 'some-id' }) – optional direct kick
   */
  async triggerEvent(event, data) {
    if (event === 'gpio_change') {
      await this._handleEventMatch('gpio_change', aegis.normalizeEvent('gpio_change', data || {}));
      return;
    }
    if (event === 'schedule') {
      const { ruleId } = data || {};
      const rule = this.rules.find(r => r.id === ruleId);
      if (!rule) throw new Error(`Rule "${ruleId}" not found`);
      if (!rule.enabled) return;
      await this._fire(rule, { type: 'schedule', cause: 'schedule (triggered by API)', depth: 0 });
      return;
    }
    // AETHER_AEGIS_AUTOMATION: the other fed event types can be injected too (testing a rule)
    if (aegis.EVENT_TYPES.includes(event)) {
      await this.ingest(event, data || {});
      return;
    }
    throw new Error(`Unsupported event "${event}"`);
  }

  /**
   * AETHER_AEGIS_AUTOMATION: one event from server.js (relay write, opto / zone change, door
   * activity, card read, Pi GPIO). Never throws and never blocks the caller: the rules run on
   * the next tick, so a relay write inside the GPIO queue is never held up by a rule.
   * data.initial = a snapshot (first read after nobody was watching): state only, no rules.
   * Resolves once the matching rules have run (tests wait on it; server.js ignores it).
   */
  ingest(type, data = {}) {
    let ev;
    try { ev = aegis.normalizeEvent(type, data); } catch (_) { ev = null; }
    if (!ev) return Promise.resolve(false);
    const seen = this._eventsSeen[type] || (this._eventsSeen[type] = { count: 0, lastAt: null });
    seen.count++; seen.lastAt = Date.now();
    // AETHER_AEGIS_AUTOMATION (review fix 1): was this event caused by a rule's own write?
    // Attributed now, synchronously: server.js feeds relay events from inside the write.
    let cause = null;
    if (type === 'relay_change') {
      cause = this._peekMark(ev.channel, ev.value, true);   // one write explains one relay event
      this._relayWriter[ev.channel] = cause ? cause.token : `ext-${++this._seq}`;
    } else if (type === 'door_event' && Number.isInteger(ev.relayChannel)) {
      cause = this._peekMark(ev.relayChannel, null);
    } else if (type === 'gpio_change' && this._gpioCause) {
      cause = this._gpioCause;
    }
    ev.cause = cause ? { ruleId: cause.ruleId, depth: cause.depth } : null;
    this._updateState(type, ev);
    if (ev.initial) return Promise.resolve(true);
    return new Promise(resolve => setImmediate(() => {
      this._handleEventMatch(type, ev)
        .catch(e => console.error('[Automation] event handling error:', e && e.message))
        .then(() => resolve(true));
    }));
  }

  _updateState(type, ev) {
    if (type === 'relay_change') this._state.relay[ev.channel] = ev.value;
    else if (type === 'opto_change') this._state.opto[ev.channel] = ev.value;
    else if (type === 'zone_change') this._state.zone[ev.zone] = { state: ev.state, voltage: ev.voltage, at: Date.now() };
    else if (type === 'gpio_change' && Number.isInteger(ev.pin)) this._state.gpio[ev.pin] = ev.value;
  }

  /** AETHER_AEGIS_AUTOMATION (review fix 7): a monitor stopped (no browser): what it last saw is stale. */
  resetState(kind) {
    if (kind === 'opto' || kind === 'all') this._state.opto = {};
    if (kind === 'zone' || kind === 'all') this._state.zone = {};
  }

  _peekMark(ch, value, consume = false) {
    const list = this._marks.get(ch);
    if (!list || !list.length) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (consume && m.used) continue;   // a later write by someone else is not ours
      if (value === null || value === undefined || m.value === value) { if (consume) m.used = true; return m; }
    }
    return null;
  }

  /** AETHER_AEGIS_AUTOMATION: Run now (the page's button / manual-only rules). Skips WHEN and IF. */
  async runRule(id) {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) throw new Error(`Rule "${id}" not found`);
    if (!rule.enabled) { const e = new Error('Rule is disabled: enable it before running it'); e.code = 'DISABLED'; throw e; }
    return this._fire(rule, { type: 'manual', cause: 'Run now', depth: 0 });
  }

  /**
   * AETHER_AEGIS_AUTOMATION: run a rule's actions once, with its stats, the firing log and the
   * loop guard (review fix 1): not while it is already running, a short burst limit, a global
   * runs/s cap, and more than limits.disableRuns attempts in limits.disableWindowMs disables
   * the rule (saved, with the reason). Each run has a cancel token (review fix 2).
   */
  async _fire(rule, ctx = {}) {
    this._rollToday();
    const id = rule.id;
    const st = this._ruleStats.get(id) || { executions: 0, lastExecuted: null, errors: 0, lastError: null, skipped: 0 };
    this._ruleStats.set(id, st);
    const now = Date.now();
    const cause = ctx.cause || (ctx.event ? aegis.describeEvent(ctx.type, ctx.event) : String(ctx.type || 'event'));
    const skipped = (why) => {
      st.skipped = (st.skipped || 0) + 1;
      this.log.push({ ruleId: id, ruleName: rule.name, trigger: ctx.type, cause, ok: false, skipped: true, error: `Skipped: ${why}` });
      return { ok: false, skipped: true, error: why };
    };
    if (!rule.enabled) return skipped('rule is disabled');
    // long window: auto-disable
    const att = (this._attempts.get(id) || []).filter(t => now - t < this.limits.disableWindowMs);
    att.push(now);
    this._attempts.set(id, att);
    if (att.length > this.limits.disableRuns) {
      this._autoDisable(rule, `triggered ${att.length} times in ${Math.round(this.limits.disableWindowMs / 1000)} s (loop guard)`);
      return skipped('auto-disabled by the loop guard');
    }
    if (this._running.has(id)) return skipped('still running from the last time');
    const times = (this._fireTimes.get(id) || []).filter(t => now - t < this.rateLimit.windowMs);
    if (times.length >= this.rateLimit.max) return skipped(`fired ${times.length}x in ${this.rateLimit.windowMs} ms (loop guard)`);
    this._runTimes = this._runTimes.filter(t => now - t < 1000);
    if (this._runTimes.length >= this.limits.runsPerSec) return skipped(`more than ${this.limits.runsPerSec} automation runs per second (global cap)`);
    times.push(now);
    this._fireTimes.set(id, times);
    this._runTimes.push(now);

    const run = { id: ++this._seq, ruleId: id, depth: Number(ctx.depth) || 0, cancelled: false, reason: null, wake: new Set(), releases: new Set() };
    this._runs.set(run.id, run);
    this._running.add(id);
    const messages = [];
    let error = null;
    try {
      await this._executeActions(rule, ctx.event || {}, messages, run);
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      if (!run.cancelled) console.error(`[Automation] Rule "${id}" action error:`, error);
    } finally {
      // anything still pending (an error mid-pulse) is released now
      await Promise.allSettled(Array.from(run.releases).map(fn => fn()));
      this._running.delete(id);
      this._runs.delete(run.id);
    }
    if (run.cancelled) { messages.push(`Stopped: ${run.reason}`); error = null; }
    st.executions++;
    st.lastExecuted = new Date(now).toISOString();
    st.lastDurationMs = Date.now() - now;
    if (error) { st.errors++; st.lastError = error; this._today.errors++; }
    this._today.fired++;
    this.stats.triggers += 1;
    this.stats.lastTriggerAt = new Date().toISOString();
    this.log.push({ ruleId: id, ruleName: rule.name, trigger: ctx.type, cause, ok: !error, error, messages, durationMs: st.lastDurationMs, cancelled: run.cancelled || undefined });
    return { ok: !error, error, cancelled: run.cancelled };
  }

  _autoDisable(rule, why) {
    const r = this.rules.find(x => x.id === rule.id);
    if (!r || !r.enabled) return;
    r.enabled = false;
    r.disabledReason = `Auto-disabled ${new Date().toISOString()}: ${why}`;
    console.warn(`[Automation] Rule "${r.id}" ${r.disabledReason}`);
    this.log.push({ ruleId: r.id, ruleName: r.name, trigger: 'guard', cause: 'Loop guard', ok: false, error: r.disabledReason });
    this._cancelRuns(r.id, 'auto-disabled by the loop guard');
    this._persistAndReschedule();
  }

  /** AETHER_AEGIS_AUTOMATION (review fix 2): stop in-flight runs (all, or one rule's) and release what they hold now. */
  _cancelRuns(ruleId, reason) {
    for (const run of this._runs.values()) {
      if (ruleId && run.ruleId !== ruleId) continue;
      if (run.cancelled) continue;
      run.cancelled = true;
      run.reason = reason;
      for (const w of run.wake) { try { w(); } catch (_) {} }
      run.wake.clear();
      for (const fn of run.releases) fn().catch(e => console.error('[Automation] release error:', e && e.message));
    }
  }

  /** Sleep that a cancel wakes early. */
  _sleep(ms, run) {
    const d = Math.min(aegis.MAX_MS, Math.max(0, Number(ms) || 0));
    if (!d) return Promise.resolve();
    if (!run) return sleep(d);
    if (run.cancelled) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); run.wake.delete(done); resolve(); };
      const t = setTimeout(done, d);
      run.wake.add(done);
    });
  }

  /** Throws when the run was cancelled, or its rule was deleted / disabled meanwhile. */
  _checkRun(run, rule) {
    if (!run) return;
    if (!run.cancelled) {
      const cur = this.rules.find(r => r.id === rule.id);
      if (!cur) { run.cancelled = true; run.reason = 'rule deleted'; }
      else if (!cur.enabled) { run.cancelled = true; run.reason = 'rule disabled'; }
    }
    if (run.cancelled) throw new Error(`Cancelled: ${run.reason}`);
  }

  /** One automation relay write: marked (attribution), counted against the global cap unless it is a release. */
  async _relayWrite(ch, on, run, { release = false } = {}) {
    if (!this.setRelay) throw new Error('Relay control is not available');
    const now = Date.now();
    if (!release) {
      this._writeTimes = this._writeTimes.filter(t => now - t < 1000);
      if (this._writeTimes.length >= this.limits.writesPerSec) throw new Error(`Relay write refused: more than ${this.limits.writesPerSec} automation relay writes per second (global cap)`);
      this._writeTimes.push(now);
    }
    const mark = { token: `run-${run ? run.id : 0}-${++this._seq}`, ruleId: run ? run.ruleId : null, depth: (run ? run.depth : 0) + 1, value: on ? 1 : 0 };
    const list = this._marks.get(ch) || [];
    list.push(mark);
    this._marks.set(ch, list);
    const unmark = () => { const l = this._marks.get(ch) || []; const i = l.indexOf(mark); if (i >= 0) l.splice(i, 1); if (!l.length) this._marks.delete(ch); };
    try {
      await this.setRelay(ch, !!on, { release });
    } catch (e) {
      unmark();
      throw e;
    }
    this._relayWriter[ch] = mark.token;
    this._state.relay[ch] = on ? 1 : 0;
    const t = setTimeout(unmark, 150);   // the write's own event arrives inside setRelay; a little grace
    if (t.unref) t.unref();
    return mark.token;
  }

  /** AETHER_AEGIS_AUTOMATION (review fix 2): a turn-off / revert must go through: retry with backoff (~10 s). */
  async _releaseWrite(ch, on, run) {
    const until = Date.now() + this.limits.releaseRetryMs;
    let wait = 100, lastErr = null;
    for (;;) {
      try { return await this._relayWrite(ch, on, run, { release: true }); }
      catch (e) { lastErr = e; }
      if (Date.now() + wait > until) break;
      await sleep(wait);
      wait = Math.min(wait * 2, 1500);
    }
    const msg = `REL ${ch + 1} could not be turned ${on ? 'ON' : 'OFF'} after ${Math.round(this.limits.releaseRetryMs / 1000)} s of retries: ${lastErr && lastErr.message} (check the relay)`;
    console.error('[Automation]', msg);
    throw new Error(msg);
  }

  /** AETHER_AEGIS_AUTOMATION (review fix 1): a Pi GPIO write by a rule; holdLevel reports it back synchronously, attributed. */
  _emitGpio(pin, value, run) {
    this._gpioCause = { ruleId: run ? run.ruleId : null, depth: (run ? run.depth : 0) + 1 };
    try { this.gpioEvents.emit('gpio_action', { pin, value }); } finally { this._gpioCause = null; }
  }

  /** "7:05" -> "07:05" on trigger.time and conditions.schedule.time. */
  _normalizeRule(rule) {
    if (rule && rule.trigger && rule.trigger.type === 'schedule' && rule.trigger.time !== undefined) {
      const t = aegis.normTime(rule.trigger.time);
      if (t) rule.trigger = { ...rule.trigger, time: t };
    }
    if (rule && rule.conditions && rule.conditions.schedule && rule.conditions.schedule.time !== undefined) {
      const t = aegis.normTime(rule.conditions.schedule.time);
      if (t) rule.conditions = { ...rule.conditions, schedule: { ...rule.conditions.schedule, time: t } };
    }
    return rule;
  }

  // ---------- Internal: Rule I/O ----------

  async _ensureDataDir() {
    try {
      await fs.promises.mkdir(this._dataDir, { recursive: true });
    } catch (_) {}
  }

  async _loadRulesFromDisk() {
    this._cancelRuns(null, 'rules reloaded');   // AETHER_AEGIS_AUTOMATION (review fix 2)
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
    await this.ingest('gpio_change', payload);   // AETHER_AEGIS_AUTOMATION: same path as the other events
  }

  async _handleEventMatch(type, payload) {
    // Apply priority ordering
    this.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)));

    // AETHER_AEGIS_AUTOMATION (review fix 1): an event a rule caused never re-triggers that
    // rule, and a chain stops after limits.maxHops automation-caused hops.
    const cause = payload && payload.cause;
    if (cause && cause.depth >= this.limits.maxHops) { this.hopsStopped++; return; }
    const depth = cause ? cause.depth : 0;

    const matched = [];
    for (const rule of this.rules.slice()) {
      if (!rule.enabled) continue;
      if (cause && cause.ruleId === rule.id) continue;

      // AETHER_AEGIS_AUTOMATION: a rule with a trigger matches by its WHEN, then its IF list.
      // The original matcher ignored rule.trigger, so every rule saved by the page (trigger +
      // conditions: []) fired on EVERY Pi GPIO write. Rules without a trigger (saved before
      // the page, e.g. { conditions: {} }) keep the original matcher, on Pi GPIO events only.
      let hit;
      if (rule.trigger && rule.trigger.type) {
        hit = aegis.triggerMatches(rule.trigger, type, payload) && this._conditionsHold(rule);
      } else {
        hit = type === 'gpio_change' && this._conditionsMatch(rule.conditions, type, payload);
      }
      if (hit) matched.push(rule);
    }
    // AETHER_AEGIS_AUTOMATION (review fix 4): IFs were checked above; matched rules run together
    await Promise.allSettled(matched.map(rule => this._fire(rule, { type, event: payload, depth })));
  }

  /** AETHER_AEGIS_AUTOMATION: every IF condition holds (against the last known I/O state). */
  _conditionsHold(rule, now = new Date()) {
    return aegis.conditionList(rule.conditions).every(c => aegis.conditionHolds(c, this._state, now));
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
      // AETHER_AEGIS_AUTOMATION: a schedule trigger works without the conditions.schedule copy too
      // (review fix) the trigger wins when both exist; times like "7:05" are accepted
      const cs = rule.conditions && rule.conditions.schedule;
      const raw = (rule.trigger && rule.trigger.type === 'schedule' && rule.trigger.time)
        ? { time: rule.trigger.time, days: rule.trigger.days !== undefined && rule.trigger.days !== null ? rule.trigger.days : (cs && cs.days) }
        : cs;
      if (!raw) continue;
      const sched = { ...raw, time: aegis.normTime(raw.time) };
      if (!sched.time) continue;

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

          // AETHER_AEGIS_AUTOMATION: the check runs every 30 s, so it used to fire twice in the
          // same minute. Once per day + minute now, and only when the IF conditions hold.
          const key = `${now.toDateString()} ${cur}`;
          if (dayOk && this._lastScheduleKey.get(rule.id) !== key && this._conditionsHold(rule, now)) {
            this._lastScheduleKey.set(rule.id, key);
            this._fire(rule, { type: 'schedule', cause: `Schedule ${cur}`, depth: 0 }).catch(e => console.error(`[Automation] Schedule "${rule.id}" error:`, e.message));
          }
        } catch (e) {
          console.error('[Automation] Schedule tick error:', e.message);
        }
      }, 1000 * 30); // check twice per minute to be resilient
      this._schedules.set(rule.id, handle);
    }
  }

  // ---------- Internal: Action Execution ----------

  async _executeActions(rule, payload = {}, messages = null, run = null) {
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    for (const act of actions) {
      const type = act?.type;
      const params = act?.params || {};

      // AETHER_AEGIS_AUTOMATION: the page has always saved "Delay before this action" as
      // action.delay, but nothing waited for it.
      this._checkRun(run, rule);   // (review fix 2) cancelled, deleted or disabled: stop here
      const before = aegis.actionDelayMs(act);
      if (before) { await this._sleep(before, run); this._checkRun(run, rule); }

      switch (type) {
        case 'log': {
          const level = (params.level || 'info').toLowerCase();
          const msg = params.message || `[Rule:${rule.id}] log`;
          const line = `[Automation][${level.toUpperCase()}] ${msg}`;
          if (level === 'warn') console.warn(line);
          else if (level === 'error') console.error(line);
          else console.log(line);
          if (messages) messages.push(String(msg).slice(0, 200));   // AETHER_AEGIS_AUTOMATION: shown in Recent firings
          break;
        }

        case 'delay': {
          // AETHER_AEGIS_AUTOMATION: the older page saved { ms }; it was read as 0
          const ms = aegis.delayParamMs(params) || 0;
          await this._sleep(ms, run);
          break;
        }

        // AETHER_AEGIS_AUTOMATION: IOplus relays REL 1-8 (channel 0-7) through the GPIO queue
        case 'relay_set': {
          if (!this.setRelay) throw new Error('Relay control is not available');
          const ch = Number(params.channel);
          const value = Number(params.value) === 1 ? 1 : 0;
          if (!Number.isInteger(ch) || ch < 0 || ch > 7) throw new Error(`Invalid relay channel for rule "${rule.id}"`);
          const prev = this._state.relay[ch];   // (review fix 3) what "back" means
          const token = await this._relayWrite(ch, value === 1, run);
          const dur = Math.min(aegis.MAX_MS, Number(params.duration) || 0);
          if (dur > 0) {
            const revert = once(async () => {
              run && run.releases.delete(revert);
              if (prev === undefined) { if (messages) messages.push(`REL ${ch + 1} not set back: its earlier state was unknown`); return; }
              if (this._relayWriter[ch] !== token) { if (messages) messages.push(`REL ${ch + 1} not set back: changed by someone else meanwhile`); return; }
              if (prev === value) return;
              await this._releaseWrite(ch, prev === 1, run);
            });
            if (run) run.releases.add(revert);
            try { await this._sleep(dur, run); } finally { await revert(); }
          }
          break;
        }

        case 'relay_pulse': {
          if (!this.setRelay) throw new Error('Relay control is not available');
          const ch = Number(params.channel);
          if (!Number.isInteger(ch) || ch < 0 || ch > 7) throw new Error(`Invalid relay channel for rule "${rule.id}"`);
          const dur = Math.min(aegis.MAX_MS, Math.max(1, Number(params.duration) || 500));
          await this._relayWrite(ch, true, run);
          // (review fix 2) the OFF is a release: retried until it goes through, applied at once on cancel
          const release = once(async () => { run && run.releases.delete(release); await this._releaseWrite(ch, false, run); });
          if (run) run.releases.add(release);
          try { await this._sleep(dur, run); } finally { await release(); }
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
            this._emitGpio(pin, 1, run);
            try { await this._sleep(Math.min(aegis.MAX_MS, duration), run); } finally { this._emitGpio(pin, 0, run); }
          } else {
            this._emitGpio(pin, value, run);
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
          
          this._emitGpio(pin, 1, run);
          try { await this._sleep(Math.min(aegis.MAX_MS, duration), run); } finally { this._emitGpio(pin, 0, run); }
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
      // AETHER_AEGIS_AUTOMATION: the triggers the page offers now (null / missing = any)
      const tr = rule.trigger;
      const anyOr = (v, ok) => v === undefined || v === null || v === 'any' || ok(v);
      if ((tr.type === 'relay_change' || tr.type === 'opto_change')) {
        if (!anyOr(tr.channel, v => Number.isInteger(v) && v >= 0 && v <= 7)) throw new Error('Relay / opto trigger channel must be 0-7');
        if (!anyOr(tr.value, v => v === 0 || v === 1)) throw new Error('Relay / opto trigger value must be 0 or 1');
      }
      if (tr.type === 'zone_change') {
        if (!anyOr(tr.zone, v => Number.isInteger(v) && v >= 1 && v <= 8)) throw new Error('Zone trigger zone must be 1-8');
        if (!anyOr(tr.state, v => aegis.ZONE_STATES.includes(String(v).toUpperCase()))) throw new Error('Zone trigger state must be ALARM, NORMAL, TROUBLE or TAMPER');
      }
      if (tr.type === 'schedule' && aegis.normTime(tr.time) === null) {
        throw new Error('Schedule trigger needs a time (HH:MM)');
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
        // AETHER_AEGIS_AUTOMATION: params.ms (what the older page saved) is accepted too
        const ms = aegis.delayParamMs(action.params);
        if (!action.params || ms === null || !Number.isInteger(ms) || ms < 0) {
          throw new Error(`Delay action ${i + 1} must have valid duration in params`);
        }
        if (ms > aegis.MAX_MS) throw new Error(`Delay action ${i + 1} can wait at most 24 h`);   // (review fix) timers overflow past 2^31-1 ms
      }

      // AETHER_AEGIS_AUTOMATION: relay actions (IOplus REL 1-8 = channel 0-7)
      if (action.type === 'relay_set' || action.type === 'relay_pulse') {
        const p = action.params || {};
        if (!Number.isInteger(p.channel) || p.channel < 0 || p.channel > 7) {
          throw new Error(`Relay action ${i + 1} must have channel 0-7 in params`);
        }
        if (action.type === 'relay_set' && p.value !== 0 && p.value !== 1) {
          throw new Error(`Relay action ${i + 1} must have value 0 or 1 in params`);
        }
        if (p.duration !== undefined && p.duration !== null && (!Number.isInteger(p.duration) || p.duration < 0 || p.duration > aegis.MAX_MS)) {
          throw new Error(`Relay action ${i + 1} duration must be a whole number of ms, at most 24 h`);
        }
      }
      if (action.delay !== undefined && action.delay !== null && (!Number.isFinite(Number(action.delay)) || Number(action.delay) < 0 || Number(action.delay) > aegis.MAX_MS)) {
        throw new Error(`Action ${i + 1} delay must be 0 to 24 h (in ms)`);
      }
      if ((action.type === 'gpio' || action.type === 'gpio_pulse') && action.params && action.params.duration !== undefined && action.params.duration !== null
        && (!Number.isFinite(Number(action.params.duration)) || Number(action.params.duration) < 0 || Number(action.params.duration) > aegis.MAX_MS)) {
        throw new Error(`GPIO action ${i + 1} duration must be 0 to 24 h (in ms)`);
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
      const validTypes = ['gpio', 'gpio_pulse', 'delay', 'log', 'wiegand_send', 'wiegand_raw', 'emit', 'http', 'switch_port', 'relay_set', 'relay_pulse'];   // AETHER_AEGIS_AUTOMATION: + relay_set / relay_pulse
      if (!validTypes.includes(action.type)) {
        throw new Error(`Action ${i + 1} has invalid type: ${action.type}`);
      }
    }

    console.log(`[AutomationManager] Rule "${rule.id || 'new'}" validated successfully`);
  }
}

module.exports = AutomationManager;
