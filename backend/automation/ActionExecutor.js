// backend/automation/ActionExecutor.js
// Executes actions from automation rules

class ActionExecutor {
  constructor(gpioEvents) {
    this.gpioEvents = gpioEvents;
    this.stats = {
      actionsExecuted: 0,
      errors: 0
    };
  }

  // Execute a list of actions
  async executeActions(actions, context = {}) {
    const results = [];

    for (const action of actions) {
      try {
        const result = await this.executeAction(action, context);
        results.push({ success: true, action: action.type, result });
        this.stats.actionsExecuted++;
      } catch (err) {
        console.error(`[ActionExecutor] Error executing ${action.type}:`, err.message);
        results.push({ success: false, action: action.type, error: err.message });
        this.stats.errors++;
      }
    }

    return results;
  }

  // Execute a single action
  async executeAction(action, context = {}) {
    const { type, params } = action;

    switch (type) {
      case 'gpio':
        return await this.executeGpioAction(params, context);
      
      case 'delay':
        return await this.executeDelayAction(params, context);
      
      case 'log':
        return this.executeLogAction(params, context);
      
      case 'emit':
        return this.executeEmitAction(params, context);
      
      case 'http':
        return await this.executeHttpAction(params, context);
      
      default:
        throw new Error(`Unknown action type: ${type}`);
    }
  }

  // Execute GPIO action
  async executeGpioAction(params, context) {
    const { pin, value, duration } = params;
    
    if (pin === undefined || value === undefined) {
      throw new Error('GPIO action requires pin and value');
    }

    console.log(`[Action] Setting GPIO ${pin} = ${value}`);
    
    // Emit event to trigger GPIO change
    this.gpioEvents.emit('gpio_action', { pin, value, duration });

    // If duration specified, schedule reset
    if (duration && duration > 0) {
      setTimeout(() => {
        console.log(`[Action] Resetting GPIO ${pin} = ${value === 1 ? 0 : 1} after ${duration}ms`);
        this.gpioEvents.emit('gpio_action', { pin, value: value === 1 ? 0 : 1 });
      }, duration);
    }

    return { pin, value, duration };
  }

  // Execute delay action
  async executeDelayAction(params, context) {
    const { ms } = params;
    if (!ms || ms < 0) {
      throw new Error('Delay action requires positive ms value');
    }

    console.log(`[Action] Delaying for ${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, ms));
    return { delayed: ms };
  }

  // Execute log action
  executeLogAction(params, context) {
    const { level = 'info', message } = params;
    
    if (!message) {
      throw new Error('Log action requires message');
    }

    const interpolatedMessage = this.interpolate(message, context);
    console.log(`[Action:${level.toUpperCase()}] ${interpolatedMessage}`);
    
    return { level, message: interpolatedMessage };
  }

  // Execute emit action (emit another event)
  executeEmitAction(params, context) {
    const { event, data = {} } = params;
    
    if (!event) {
      throw new Error('Emit action requires event name');
    }

    const interpolatedData = this.interpolateObject(data, context);
    console.log(`[Action] Emitting event: ${event}`, interpolatedData);
    
    this.gpioEvents.emit(event, interpolatedData);
    return { event, data: interpolatedData };
  }

  // Execute HTTP action
  async executeHttpAction(params, context) {
    const { url, method = 'GET', headers = {}, body } = params;
    
    if (!url) {
      throw new Error('HTTP action requires url');
    }

    const interpolatedUrl = this.interpolate(url, context);
    console.log(`[Action] HTTP ${method} ${interpolatedUrl}`);

    // Note: In a real implementation, you'd use fetch or axios here
    // For now, just log it
    return { url: interpolatedUrl, method, body };
  }

  // Interpolate variables in string (e.g., "{{event.data.pin}}")
  interpolate(str, context) {
    return str.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const value = this.getNestedValue(context, path.trim());
      return value !== undefined ? value : match;
    });
  }

  // Interpolate variables in object
  interpolateObject(obj, context) {
    if (typeof obj === 'string') {
      return this.interpolate(obj, context);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.interpolateObject(item, context));
    }
    
    if (typeof obj === 'object' && obj !== null) {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value, context);
      }
      return result;
    }
    
    return obj;
  }

  // Get nested value from object
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  // Get statistics
  getStats() {
    return { ...this.stats };
  }
}

module.exports = ActionExecutor;
