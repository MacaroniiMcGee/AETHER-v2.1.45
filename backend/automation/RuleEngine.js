// backend/automation/RuleEngine.js
// Evaluates automation rules against events

class RuleEngine {
  constructor() {
    this.rules = new Map();
  }

  // Add a rule
  addRule(rule) {
    if (!rule.id) {
      throw new Error('Rule must have an id');
    }
    if (!rule.conditions) {
      throw new Error('Rule must have conditions');
    }
    if (!rule.actions) {
      throw new Error('Rule must have actions');
    }

    this.rules.set(rule.id, {
      ...rule,
      enabled: rule.enabled !== false,
      priority: rule.priority || 0,
      stats: {
        executions: 0,
        lastExecuted: null,
        errors: 0
      }
    });
  }

  // Remove a rule
  removeRule(ruleId) {
    return this.rules.delete(ruleId);
  }

  // Update a rule
  updateRule(ruleId, updates) {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule ${ruleId} not found`);
    }

    const updatedRule = { ...rule, ...updates };
    this.rules.set(ruleId, updatedRule);
    return updatedRule;
  }

  // Enable/disable a rule
  setRuleEnabled(ruleId, enabled) {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule ${ruleId} not found`);
    }
    rule.enabled = enabled;
  }

  // Get all rules
  getRules() {
    return Array.from(this.rules.values());
  }

  // Get a specific rule
  getRule(ruleId) {
    return this.rules.get(ruleId);
  }

  // Evaluate an event against all rules
  async evaluateEvent(event) {
    const matchedRules = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      try {
        const matches = await this.evaluateConditions(rule.conditions, event);
        if (matches) {
          matchedRules.push(rule);
        }
      } catch (err) {
        console.error(`[RuleEngine] Error evaluating rule ${rule.id}:`, err.message);
        rule.stats.errors++;
      }
    }

    // Sort by priority (higher first)
    return matchedRules.sort((a, b) => b.priority - a.priority);
  }

  // Evaluate conditions
  async evaluateConditions(conditions, event) {
    if (!conditions) return false;

    // Handle 'all' (AND logic)
    if (conditions.all) {
      for (const condition of conditions.all) {
        const result = await this.evaluateSingleCondition(condition, event);
        if (!result) return false;
      }
      return true;
    }

    // Handle 'any' (OR logic)
    if (conditions.any) {
      for (const condition of conditions.any) {
        const result = await this.evaluateSingleCondition(condition, event);
        if (result) return true;
      }
      return false;
    }

    // Handle single condition
    return this.evaluateSingleCondition(conditions, event);
  }

  // Evaluate a single condition
  async evaluateSingleCondition(condition, event) {
    // Event name matching
    if (condition.event) {
      if (event.name !== condition.event) return false;
    }

    // Data field matching
    for (const [key, expectedValue] of Object.entries(condition)) {
      if (key === 'event') continue;

      const actualValue = this.getNestedValue(event.data, key);
      
      if (!this.compareValues(actualValue, expectedValue)) {
        return false;
      }
    }

    return true;
  }

  // Get nested value from object (e.g., 'data.pin' from event)
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  // Compare values with operators
  compareValues(actual, expected) {
    // Direct equality
    if (actual === expected) return true;

    // Handle operator objects
    if (typeof expected === 'object' && expected !== null) {
      if (expected.$eq !== undefined) return actual === expected.$eq;
      if (expected.$ne !== undefined) return actual !== expected.$ne;
      if (expected.$gt !== undefined) return actual > expected.$gt;
      if (expected.$gte !== undefined) return actual >= expected.$gte;
      if (expected.$lt !== undefined) return actual < expected.$lt;
      if (expected.$lte !== undefined) return actual <= expected.$lte;
      if (expected.$in !== undefined) return expected.$in.includes(actual);
      if (expected.$nin !== undefined) return !expected.$nin.includes(actual);
    }

    return false;
  }

  // Update rule statistics
  updateRuleStats(ruleId, success = true) {
    const rule = this.rules.get(ruleId);
    if (!rule) return;

    rule.stats.executions++;
    rule.stats.lastExecuted = new Date().toISOString();
    if (!success) {
      rule.stats.errors++;
    }
  }

  // Get engine statistics
  getStats() {
    const rules = Array.from(this.rules.values());
    return {
      totalRules: rules.length,
      enabledRules: rules.filter(r => r.enabled).length,
      totalExecutions: rules.reduce((sum, r) => sum + r.stats.executions, 0),
      totalErrors: rules.reduce((sum, r) => sum + r.stats.errors, 0)
    };
  }
}

module.exports = RuleEngine;
