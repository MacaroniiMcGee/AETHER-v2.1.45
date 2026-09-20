// backend/automation/EventBus.js
// Central event management system for automation

class EventBus {
  constructor() {
    this.listeners = new Map();
    this.history = [];
    this.historyLimit = 1000;
    this.stats = {
      eventsEmitted: 0,
      eventsProcessed: 0,
      errors: 0
    };
  }

  // Subscribe to events with pattern matching
  on(eventPattern, handler, options = {}) {
    const {
      priority = 0,
      once = false,
      id = this.generateId()
    } = options;

    const listener = {
      id,
      pattern: eventPattern,
      handler,
      priority,
      once,
      created: new Date()
    };

    if (!this.listeners.has(eventPattern)) {
      this.listeners.set(eventPattern, []);
    }

    const handlers = this.listeners.get(eventPattern);
    handlers.push(listener);
    
    // Sort by priority (higher first)
    handlers.sort((a, b) => b.priority - a.priority);

    return id;
  }

  // One-time event listener
  once(eventPattern, handler, options = {}) {
    return this.on(eventPattern, handler, { ...options, once: true });
  }

  // Remove listener
  off(eventPattern, id) {
    const handlers = this.listeners.get(eventPattern);
    if (!handlers) return false;

    const index = handlers.findIndex(h => h.id === id);
    if (index === -1) return false;

    handlers.splice(index, 1);
    if (handlers.length === 0) {
      this.listeners.delete(eventPattern);
    }

    return true;
  }

  // Emit event to all matching listeners
  async emit(eventName, data = {}) {
    this.stats.eventsEmitted++;

    const event = {
      name: eventName,
      data,
      timestamp: Date.now(),
      id: this.generateId()
    };

    // Add to history
    this.history.unshift(event);
    if (this.history.length > this.historyLimit) {
      this.history.pop();
    }

    const handlers = this.listeners.get(eventName) || [];
    const toRemove = [];

    for (const listener of handlers) {
      try {
        await listener.handler(event);
        this.stats.eventsProcessed++;

        if (listener.once) {
          toRemove.push(listener.id);
        }
      } catch (err) {
        this.stats.errors++;
        console.error(`[EventBus] Error in handler for ${eventName}:`, err.message);
      }
    }

    // Remove one-time listeners
    toRemove.forEach(id => this.off(eventName, id));
  }

  // Get event history
  getHistory(limit = 100) {
    return this.history.slice(0, limit);
  }

  // Get statistics
  getStats() {
    return {
      ...this.stats,
      activeListeners: Array.from(this.listeners.values()).reduce((sum, arr) => sum + arr.length, 0),
      eventTypes: this.listeners.size
    };
  }

  // Clear all listeners
  clear() {
    this.listeners.clear();
  }

  // Generate unique ID
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = EventBus;
