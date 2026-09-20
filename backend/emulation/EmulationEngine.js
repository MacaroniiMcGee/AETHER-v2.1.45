// EmulationEngine.js - Unified emulation execution engine with state tracking and condition evaluation
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

class EmulationEngine extends EventEmitter {
  constructor(io, gpioController, wiegandManager, osdpManager, formatService) {
    super();
    this.io = io;
    this.gpioController = gpioController;
    this.wiegandManager = wiegandManager;
    this.osdpManager = osdpManager;
    this.formatService = formatService;
    
    // State tracking
    this.ioStates = new Map();
    this.doorStates = new Map();
    this.lastCardResults = new Map();
    this.alarmStates = new Map();
    
    // Execution tracking
    this.activeExecutions = new Map();
    this.executionHistory = [];
    this.maxHistorySize = 1000;
    
    // Condition tracking
    this.conditionResults = new Map();
    
    // Initialize alarm states
    this.alarmStates.set('alarm_1', false);
    this.alarmStates.set('alarm_2', false);
    
    // History directory
    this.historyDir = path.join(__dirname, 'data', 'emulation-history');
    this.initializeHistoryDir();
  }
  
  async initializeHistoryDir() {
    try {
      await fs.mkdir(this.historyDir, { recursive: true });
    } catch (err) {
      console.error('[EmulationEngine] Failed to create history directory:', err);
    }
  }
  
  // ========== STATE MANAGEMENT ==========
  
  updateIOState(pin, value) {
    const oldValue = this.ioStates.get(pin);
    this.ioStates.set(pin, value);
    
    if (oldValue !== value) {
      this.emit('io_state_change', { pin, value, oldValue });
      this.io.emit('io_state_change', { pin, value });
    }
  }
  
  updateDoorState(doorId, state) {
    const oldState = this.doorStates.get(doorId) || {};
    const newState = { ...oldState, ...state };
    this.doorStates.set(doorId, newState);
    
    this.emit('door_state_change', { doorId, state: newState, oldState });
    this.io.emit('door_state_change', { doorId, state: newState });
  }
  
  updateCardResult(readerId, result) {
    this.lastCardResults.set(readerId, {
      result,
      timestamp: Date.now(),
      ...result
    });
    
    this.emit('card_result', { readerId, result });
    this.io.emit('card_result', { readerId, result });
  }
  
  setAlarmState(alarmId, active) {
    this.alarmStates.set(alarmId, active);
    this.emit('alarm_state_change', { alarmId, active });
    this.io.emit('alarm_state_change', { alarmId, active });
  }
  
  // ========== EXECUTION ENGINE ==========
  
  async executeSequence(sequenceId, sequence, options = {}) {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const execution = {
      id: executionId,
      sequenceId,
      sequenceName: sequence.name,
      status: 'running',
      startTime: Date.now(),
      currentStep: 0,
      currentRun: 0,
      totalRuns: (options.globalRepeatCount || 0) + 1,
      globalDelay: options.globalDelay || 1000,
      steps: sequence.steps,
      log: [],
      stats: {
        stepsExecuted: 0,
        cardsRead: 0,
        validReads: 0,
        invalidReads: 0,
        ioOperations: 0,
        errors: 0
      }
    };
    
    this.activeExecutions.set(executionId, execution);
    this.logExecution(executionId, 'info', `Starting sequence: ${sequence.name} (${execution.totalRuns} runs)`);
    
    try {
      for (let run = 0; run < execution.totalRuns; run++) {
        execution.currentRun = run;
        
        if (run > 0) {
          this.logExecution(executionId, 'info', `━━━ Run ${run + 1}/${execution.totalRuns} ━━━`);
        }
        
        for (let i = 0; i < sequence.steps.length; i++) {
          if (execution.status !== 'running') break;
          
          execution.currentStep = i;
          const step = sequence.steps[i];
          
          this.logExecution(executionId, 'info', `Step ${i + 1}/${sequence.steps.length}: ${this.getStepDescription(step)}`);
          
          try {
            // Execute the step
            const jumpTo = await this.executeStep(executionId, step);
            execution.stats.stepsExecuted++;
            
            // Handle control flow
            if (jumpTo !== null) {
              i = jumpTo - 1; // -1 because loop increments
              this.logExecution(executionId, 'info', `Jumping to step ${jumpTo}`);
              continue;
            }
            
            // Apply global delay
            if (i < sequence.steps.length - 1 || run < execution.totalRuns - 1) {
              await this.delay(execution.globalDelay);
            }
            
          } catch (err) {
            execution.stats.errors++;
            this.logExecution(executionId, 'error', `Error in step ${i + 1}: ${err.message}`);
            if (options.stopOnError) {
              throw err;
            }
          }
        }
        
        if (run < execution.totalRuns - 1 && execution.status === 'running') {
          this.logExecution(executionId, 'info', `Waiting ${execution.globalDelay}ms before next run...`);
          await this.delay(execution.globalDelay);
        }
      }
      
      execution.status = 'completed';
      this.logExecution(executionId, 'success', '✅ Sequence completed successfully');
      
    } catch (err) {
      execution.status = 'failed';
      execution.error = err.message;
      this.logExecution(executionId, 'error', `❌ Sequence failed: ${err.message}`);
      throw err;
      
    } finally {
      execution.endTime = Date.now();
      execution.duration = execution.endTime - execution.startTime;
      
      // Save to history
      await this.saveExecutionHistory(execution);
      
      // Clean up
      setTimeout(() => {
        this.activeExecutions.delete(executionId);
      }, 60000); // Keep in memory for 1 minute
    }
    
    return execution;
  }
  
  async executeStep(executionId, step) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) throw new Error('Execution not found');
    
    let result = null;
    
    // Execute main step action
    switch (step.type) {
      case 'reader':
        result = await this.executeReaderStep(executionId, step);
        break;
      case 'door':
        await this.executeDoorStep(executionId, step);
        break;
      case 'io':
        await this.executeIOStep(executionId, step);
        break;
      case 'wait':
        await this.executeWaitStep(executionId, step);
        break;
      case 'control':
        if (step.controlType === 'stop') {
          execution.status = 'stopped';
          return null;
        } else if (step.controlType === 'loop' && step.loopToStep !== undefined) {
          return step.loopToStep;
        }
        break;
    }
    
    // Execute conditions
    if (step.conditions && step.conditions.length > 0) {
      // Execute AND conditions simultaneously
      const andConditions = step.conditions.filter(c => c.type === 'and');
      if (andConditions.length > 0) {
        await Promise.all(andConditions.map(c => this.executeCondition(executionId, c)));
      }
      
      // Check IF/THEN conditions
      for (const condition of step.conditions.filter(c => c.type === 'if_then')) {
        const conditionMet = await this.checkCondition(executionId, condition, result);
        if (conditionMet) {
          const jumpTo = await this.executeCondition(executionId, condition);
          if (jumpTo !== null) return jumpTo;
        }
      }
    }
    
    return null;
  }
  
  // ========== STEP EXECUTION ==========
  
  async executeReaderStep(executionId, step) {
    const execution = this.activeExecutions.get(executionId);
    
    // Validate format
    const format = this.formatService.getFormatById(step.format);
    if (!format) {
      throw new Error(`Invalid format: ${step.format}`);
    }
    
    let cards = [];
    
    if (step.mode === 'range') {
      // Generate card range
      const fcStart = step.facilityStart || 0;
      const fcEnd = step.facilityEnd || fcStart;
      const cnStart = step.cardStart || 0;
      const cnEnd = step.cardEnd || cnStart;
      
      // Validate against format limits
      if (fcEnd > format.maxFacility) {
        throw new Error(`Facility code ${fcEnd} exceeds format limit of ${format.maxFacility}`);
      }
      if (cnEnd > format.maxCard) {
        throw new Error(`Card number ${cnEnd} exceeds format limit of ${format.maxCard}`);
      }
      
      for (let fc = fcStart; fc <= fcEnd; fc++) {
        for (let cn = cnStart; cn <= cnEnd; cn++) {
          cards.push({ fc, cn });
        }
      }
      
      // Handle random ordering
      if (step.sequenceMode === 'random') {
        for (let i = cards.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [cards[i], cards[j]] = [cards[j], cards[i]];
        }
      }
    } else {
      // Single card
      const fc = step.facilityCode || 0;
      const cn = step.cardNumber || 0;
      
      // Validate against format limits
      if (fc > format.maxFacility) {
        throw new Error(`Facility code ${fc} exceeds format limit of ${format.maxFacility}`);
      }
      if (cn > format.maxCard) {
        throw new Error(`Card number ${cn} exceeds format limit of ${format.maxCard}`);
      }
      
      cards.push({ fc, cn });
    }
    
    let lastResult = 'invalid';
    
    for (const card of cards) {
      if (execution.status !== 'running') break;
      
      execution.stats.cardsRead++;
      this.logExecution(executionId, 'info', `💳 ${format.name} FC:${card.fc} CN:${card.cn} → Reader ${step.readerId}`);
      
      try {
        // Determine if this is OSDP or Wiegand
        const isOSDP = step.readerId && step.readerId.toString().toLowerCase().includes('osdp');
        let result;
        
        if (isOSDP && this.osdpManager) {
          // OSDP card send (if implemented)
          result = { success: false }; // Placeholder - implement OSDP send if needed
        } else if (this.wiegandManager) {
          // Wiegand send
          result = await this.wiegandManager.sendCard(step.readerId, card.fc, card.cn, format.bits);
        } else {
          result = { success: false, error: 'No card manager available' };
        }
        
        lastResult = result.success ? 'valid' : 'invalid';
        
        if (result.success) {
          execution.stats.validReads++;
        } else {
          execution.stats.invalidReads++;
        }
        
        // Update card result for condition checking
        this.updateCardResult(step.readerId, {
          success: result.success,
          facility: card.fc,
          card: card.cn,
          format: format.id,
          result: lastResult
        });
        
      } catch (err) {
        this.logExecution(executionId, 'error', `Card send error: ${err.message}`);
        lastResult = 'invalid';
        execution.stats.invalidReads++;
      }
      
      // Small delay between cards in a range
      if (cards.length > 1 && cards.indexOf(card) < cards.length - 1) {
        await this.delay(200);
      }
    }
    
    return lastResult;
  }
  
  async executeDoorStep(executionId, step) {
    const execution = this.activeExecutions.get(executionId);
    execution.stats.ioOperations++;
    
    // Map door components to GPIO pins (you'll need to configure this)
    const doorPinMap = {
      lock: { 1: 18, 2: 26 },     // Example: door 1 lock on GPIO 18, door 2 on GPIO 26
      dps: { 1: 19, 2: 27 },      // Door position sensors
      rexIn: { 1: 21, 2: 4 }      // Request to exit
    };
    
    const pin = doorPinMap[step.eventType]?.[step.doorId];
    if (!pin) {
      throw new Error(`No GPIO pin configured for door ${step.doorId} ${step.eventType}`);
    }
    
    if (step.action === 'pulse') {
      await this.gpioController.write(pin, 1);
      this.updateIOState(pin, 1);
      this.logExecution(executionId, 'info', `⚡ PULSE Door ${step.doorId} ${step.eventType} (${step.pulseDuration}ms)`);
      
      await this.delay(step.pulseDuration || 500);
      
      await this.gpioController.write(pin, 0);
      this.updateIOState(pin, 0);
    } else {
      const value = step.action === 'activate' ? 1 : 0;
      await this.gpioController.write(pin, value);
      this.updateIOState(pin, value);
      this.logExecution(executionId, 'info', `${value ? '🟢' : '🔴'} Door ${step.doorId} ${step.eventType} ${value ? 'ON' : 'OFF'}`);
      
      // Update door state
      this.updateDoorState(step.doorId, {
        [step.eventType]: value === 1
      });
    }
  }
  
  async executeIOStep(executionId, step) {
    const execution = this.activeExecutions.get(executionId);
    execution.stats.ioOperations++;
    
    // This assumes the frontend provides the actual GPIO pin in the ioId
    // You may need to map ioId to actual pins based on your configuration
    const pin = step.ioId;
    
    if (step.action === 'pulse') {
      await this.gpioController.write(pin, 1);
      this.updateIOState(pin, 1);
      this.logExecution(executionId, 'info', `⚡ PULSE ${step.ioType} ${pin} (${step.pulseDuration}ms)`);
      
      await this.delay(step.pulseDuration || 500);
      
      await this.gpioController.write(pin, 0);
      this.updateIOState(pin, 0);
    } else {
      const value = step.action === 'activate' ? 1 : 0;
      await this.gpioController.write(pin, value);
      this.updateIOState(pin, value);
      this.logExecution(executionId, 'info', `${value ? '🟢' : '🔴'} ${step.ioType} ${pin} ${value ? 'ON' : 'OFF'}`);
    }
  }
  
  async executeWaitStep(executionId, step) {
    if (step.waitType === 'alarm_1' || step.waitType === 'alarm_2') {
      this.logExecution(executionId, 'info', `🔔 Waiting for ${step.waitType}...`);
      
      // Wait for alarm with timeout
      const timeout = 60000; // 1 minute timeout
      const startTime = Date.now();
      
      while (!this.alarmStates.get(step.waitType) && Date.now() - startTime < timeout) {
        if (this.activeExecutions.get(executionId).status !== 'running') break;
        await this.delay(100);
      }
      
      if (this.alarmStates.get(step.waitType)) {
        this.logExecution(executionId, 'info', `✓ ${step.waitType} triggered`);
      } else {
        this.logExecution(executionId, 'warning', `⚠️ ${step.waitType} timeout after ${timeout}ms`);
      }
    } else {
      const ms = step.waitType === 'minutes' 
        ? (step.waitValue || 1) * 60000 
        : (step.waitValue || 5) * 1000;
      this.logExecution(executionId, 'info', `⏱️ Waiting ${step.waitValue} ${step.waitType}...`);
      await this.delay(ms);
    }
  }
  
  // ========== CONDITION EVALUATION ==========
  
  async checkCondition(executionId, condition, stepResult) {
    switch (condition.condition) {
      case 'valid_read':
        return stepResult === 'valid';
        
      case 'invalid_read':
        return stepResult === 'invalid';
        
      case 'door_open':
        const doorOpenState = this.doorStates.get(condition.doorId || 1);
        return doorOpenState?.dps === true;
        
      case 'door_closed':
        const doorClosedState = this.doorStates.get(condition.doorId || 1);
        return doorClosedState?.dps === false;
        
      case 'timeout':
        // This would require tracking step start times
        return false;
        
      case 'always':
      default:
        return true;
    }
  }
  
  async executeCondition(executionId, condition) {
    this.logExecution(executionId, 'info', `  ${condition.type === 'and' ? '&' : '→'} ${condition.action}`);
    
    switch (condition.action) {
      case 'stop':
        const execution = this.activeExecutions.get(executionId);
        if (execution) execution.status = 'stopped';
        return null;
        
      case 'jump':
        return condition.targetStep;
        
      case 'activate_output':
      case 'deactivate_output':
      case 'pulse_output':
        const pin = condition.outputId; // Assumes outputId is GPIO pin
        if (condition.action === 'pulse_output') {
          await this.gpioController.write(pin, 1);
          await this.delay(condition.pulseTime || 500);
          await this.gpioController.write(pin, 0);
        } else {
          await this.gpioController.write(pin, condition.action === 'activate_output' ? 1 : 0);
        }
        break;
        
      case 'wait':
        if (condition.waitTime) {
          await this.delay(condition.waitTime * 1000);
        }
        break;
    }
    
    return null;
  }
  
  // ========== HELPER METHODS ==========
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getStepDescription(step) {
    switch (step.type) {
      case 'reader':
        if (step.mode === 'range') {
          const total = ((step.facilityEnd || 0) - (step.facilityStart || 0) + 1) *
                       ((step.cardEnd || 0) - (step.cardStart || 0) + 1);
          return `Reader ${step.readerId} - ${total} cards (${step.format})`;
        }
        return `Reader ${step.readerId} - FC:${step.facilityCode} CN:${step.cardNumber} (${step.format})`;
        
      case 'door':
        return `Door ${step.doorId} - ${step.eventType} ${step.action}`;
        
      case 'io':
        return `${step.ioType} ${step.ioId} - ${step.action}`;
        
      case 'wait':
        if (step.waitType === 'alarm_1' || step.waitType === 'alarm_2') {
          return `Wait for ${step.waitType}`;
        }
        return `Wait ${step.waitValue} ${step.waitType}`;
        
      case 'control':
        return step.controlType === 'stop' ? 'Stop' : `Loop to step ${step.loopToStep + 1}`;
        
      default:
        return 'Unknown step';
    }
  }
  
  logExecution(executionId, level, message) {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) return;
    
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      step: execution.currentStep,
      run: execution.currentRun
    };
    
    execution.log.push(logEntry);
    
    // Emit for real-time monitoring
    this.emit('execution_log', { executionId, logEntry });
    this.io.emit('emulation_log', {
      executionId,
      sequenceName: execution.sequenceName,
      ...logEntry
    });
  }
  
  // ========== EXECUTION CONTROL ==========
  
  pauseExecution(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (execution && execution.status === 'running') {
      execution.status = 'paused';
      this.logExecution(executionId, 'info', '⏸️ Execution paused');
      return true;
    }
    return false;
  }
  
  resumeExecution(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (execution && execution.status === 'paused') {
      execution.status = 'running';
      this.logExecution(executionId, 'info', '▶️ Execution resumed');
      return true;
    }
    return false;
  }
  
  stopExecution(executionId) {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.status = 'stopped';
      this.logExecution(executionId, 'warning', '⏹️ Execution stopped by user');
      return true;
    }
    return false;
  }
  
  // ========== HISTORY & PERSISTENCE ==========
  
  async saveExecutionHistory(execution) {
    try {
      // Add to in-memory history
      this.executionHistory.unshift({
        id: execution.id,
        sequenceId: execution.sequenceId,
        sequenceName: execution.sequenceName,
        status: execution.status,
        startTime: execution.startTime,
        endTime: execution.endTime,
        duration: execution.duration,
        stats: execution.stats,
        error: execution.error
      });
      
      // Trim history
      if (this.executionHistory.length > this.maxHistorySize) {
        this.executionHistory = this.executionHistory.slice(0, this.maxHistorySize);
      }
      
      // Save full execution to disk
      const filename = `${execution.id}.json`;
      const filepath = path.join(this.historyDir, filename);
      await fs.writeFile(filepath, JSON.stringify(execution, null, 2));
      
      // Clean old files (keep last 30 days)
      await this.cleanOldHistory();
      
    } catch (err) {
      console.error('[EmulationEngine] Failed to save execution history:', err);
    }
  }
  
  async cleanOldHistory() {
    try {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const files = await fs.readdir(this.historyDir);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filepath = path.join(this.historyDir, file);
          const stat = await fs.stat(filepath);
          
          if (stat.mtime.getTime() < thirtyDaysAgo) {
            await fs.unlink(filepath);
          }
        }
      }
    } catch (err) {
      console.error('[EmulationEngine] Failed to clean old history:', err);
    }
  }
  
  async getExecutionHistory(options = {}) {
    const { limit = 50, offset = 0, sequenceId, status } = options;
    
    let filtered = this.executionHistory;
    
    if (sequenceId) {
      filtered = filtered.filter(h => h.sequenceId === sequenceId);
    }
    
    if (status) {
      filtered = filtered.filter(h => h.status === status);
    }
    
    return {
      total: filtered.length,
      items: filtered.slice(offset, offset + limit)
    };
  }
  
  async getExecutionDetails(executionId) {
    // First check active executions
    const active = this.activeExecutions.get(executionId);
    if (active) return active;
    
    // Then check disk
    try {
      const filepath = path.join(this.historyDir, `${executionId}.json`);
      const data = await fs.readFile(filepath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      return null;
    }
  }
  
  // ========== STATUS & MONITORING ==========
  
  getStatus() {
    return {
      activeExecutions: Array.from(this.activeExecutions.values()).map(e => ({
        id: e.id,
        sequenceName: e.sequenceName,
        status: e.status,
        progress: {
          currentStep: e.currentStep + 1,
          totalSteps: e.steps.length,
          currentRun: e.currentRun + 1,
          totalRuns: e.totalRuns
        },
        startTime: e.startTime,
        duration: Date.now() - e.startTime
      })),
      ioStates: Object.fromEntries(this.ioStates),
      doorStates: Object.fromEntries(this.doorStates),
      alarmStates: Object.fromEntries(this.alarmStates),
      lastCardResults: Object.fromEntries(this.lastCardResults)
    };
  }
  
  getDoorStatus(doorId) {
    return this.doorStates.get(doorId) || {
      lock: false,
      dps: false,
      rexIn: false
    };
  }
  
  triggerAlarm(alarmId) {
    this.setAlarmState(alarmId, true);
    
    // Auto-clear after 5 seconds
    setTimeout(() => {
      this.setAlarmState(alarmId, false);
    }, 5000);
  }
}

module.exports = EmulationEngine;
