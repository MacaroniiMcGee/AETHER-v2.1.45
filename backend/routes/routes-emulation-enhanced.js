// routes-emulation-enhanced.js - Enhanced emulation routes with execution engine
const express = require('express');
const router = express.Router();
const EmulationEngine = require('../EmulationEngine');

let emulationEngine = null;

// Initialize the emulation engine
const initializeEngine = (io, gpioController, wiegandManager, osdpManager, formatService) => {
  if (!emulationEngine) {
    emulationEngine = new EmulationEngine(io, gpioController, wiegandManager, osdpManager, formatService);
    
    // Set up event listeners for real-time updates
    emulationEngine.on('execution_log', ({ executionId, logEntry }) => {
      console.log(`[Emulation ${executionId}] ${logEntry.message}`);
    });
    
    console.log('[EmulationRoutes] Engine initialized');
  }
  return emulationEngine;
};

// ========== EXECUTION ENDPOINTS ==========

// Execute a sequence
router.post('/execute', async (req, res) => {
  try {
    if (!emulationEngine) {
      return res.status(503).json({ 
        success: false, 
        error: 'Emulation engine not initialized' 
      });
    }
    
    const { sequence, options = {} } = req.body;
    
    if (!sequence || !sequence.steps || !Array.isArray(sequence.steps)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid sequence format' 
      });
    }
    
    // Start execution asynchronously
    const executionPromise = emulationEngine.executeSequence(
      sequence.id || 'manual',
      sequence,
      options
    );
    
    // Return execution ID immediately
    const executionId = Array.from(emulationEngine.activeExecutions.keys()).pop();
    
    res.json({
      success: true,
      executionId,
      message: 'Execution started'
    });
    
    // Handle completion in background
    executionPromise.catch(err => {
      console.error(`[EmulationRoutes] Execution ${executionId} failed:`, err);
    });
    
  } catch (err) {
    console.error('[EmulationRoutes] Execute error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// Execute a saved sequence by ID
router.post('/execute/:sequenceId', async (req, res) => {
  try {
    if (!emulationEngine) {
      return res.status(503).json({ 
        success: false, 
        error: 'Emulation engine not initialized' 
      });
    }
    
    const { sequenceId } = req.params;
    const { options = {} } = req.body;
    
    // Load sequence from disk
    const fs = require('fs').promises;
    const path = require('path');
    const sequencePath = path.join(__dirname, 'data', 'sequences', `${sequenceId}.json`);
    
    let sequence;
    try {
      const data = await fs.readFile(sequencePath, 'utf8');
      sequence = JSON.parse(data);
    } catch (err) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sequence not found' 
      });
    }
    
    // Start execution
    const executionPromise = emulationEngine.executeSequence(
      sequenceId,
      sequence,
      options
    );
    
    const executionId = Array.from(emulationEngine.activeExecutions.keys()).pop();
    
    res.json({
      success: true,
      executionId,
      sequenceName: sequence.name,
      message: 'Execution started'
    });
    
    executionPromise.catch(err => {
      console.error(`[EmulationRoutes] Execution ${executionId} failed:`, err);
    });
    
  } catch (err) {
    console.error('[EmulationRoutes] Execute saved error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ========== EXECUTION CONTROL ==========

// Pause execution
router.post('/executions/:executionId/pause', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const success = emulationEngine.pauseExecution(req.params.executionId);
  
  res.json({
    success,
    message: success ? 'Execution paused' : 'Execution not found or not running'
  });
});

// Resume execution
router.post('/executions/:executionId/resume', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const success = emulationEngine.resumeExecution(req.params.executionId);
  
  res.json({
    success,
    message: success ? 'Execution resumed' : 'Execution not found or not paused'
  });
});

// Stop execution
router.post('/executions/:executionId/stop', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const success = emulationEngine.stopExecution(req.params.executionId);
  
  res.json({
    success,
    message: success ? 'Execution stopped' : 'Execution not found'
  });
});

// ========== STATUS & MONITORING ==========

// Get emulation engine status
router.get('/status', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  res.json({
    success: true,
    status: emulationEngine.getStatus()
  });
});

// Get active executions
router.get('/executions/active', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const activeExecutions = Array.from(emulationEngine.activeExecutions.values()).map(e => ({
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
    duration: Date.now() - e.startTime,
    stats: e.stats
  }));
  
  res.json({
    success: true,
    count: activeExecutions.length,
    executions: activeExecutions
  });
});

// Get execution details
router.get('/executions/:executionId', async (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const execution = await emulationEngine.getExecutionDetails(req.params.executionId);
  
  if (!execution) {
    return res.status(404).json({ 
      success: false, 
      error: 'Execution not found' 
    });
  }
  
  res.json({
    success: true,
    execution
  });
});

// Get execution logs
router.get('/executions/:executionId/logs', async (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const execution = await emulationEngine.getExecutionDetails(req.params.executionId);
  
  if (!execution) {
    return res.status(404).json({ 
      success: false, 
      error: 'Execution not found' 
    });
  }
  
  res.json({
    success: true,
    executionId: execution.id,
    sequenceName: execution.sequenceName,
    logs: execution.log || []
  });
});

// ========== HISTORY ==========

// Get execution history
router.get('/history', async (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const { limit = 50, offset = 0, sequenceId, status } = req.query;
  
  const history = await emulationEngine.getExecutionHistory({
    limit: parseInt(limit),
    offset: parseInt(offset),
    sequenceId,
    status
  });
  
  res.json({
    success: true,
    ...history
  });
});

// ========== STATE MANAGEMENT ==========

// Get door status
router.get('/doors/:doorId/status', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  const status = emulationEngine.getDoorStatus(parseInt(req.params.doorId));
  
  res.json({
    success: true,
    doorId: parseInt(req.params.doorId),
    status
  });
});

// Get all I/O states
router.get('/io/states', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  res.json({
    success: true,
    ioStates: Object.fromEntries(emulationEngine.ioStates),
    doorStates: Object.fromEntries(emulationEngine.doorStates),
    alarmStates: Object.fromEntries(emulationEngine.alarmStates)
  });
});

// Trigger alarm (for testing)
router.post('/alarms/:alarmId/trigger', (req, res) => {
  if (!emulationEngine) {
    return res.status(503).json({ 
      success: false, 
      error: 'Emulation engine not initialized' 
    });
  }
  
  emulationEngine.triggerAlarm(req.params.alarmId);
  
  res.json({
    success: true,
    message: `Alarm ${req.params.alarmId} triggered`
  });
});

// ========== VALIDATION ==========

// Validate sequence before execution
router.post('/validate', async (req, res) => {
  try {
    if (!emulationEngine) {
      return res.status(503).json({ 
        success: false, 
        error: 'Emulation engine not initialized' 
      });
    }
    
    const { sequence } = req.body;
    const errors = [];
    const warnings = [];
    
    if (!sequence || !sequence.steps) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid sequence format' 
      });
    }
    
    // Validate each step
    sequence.steps.forEach((step, index) => {
      // Validate reader steps
      if (step.type === 'reader') {
        if (!step.readerId) {
          errors.push(`Step ${index + 1}: Missing reader ID`);
        }
        
        if (!step.format) {
          errors.push(`Step ${index + 1}: Missing format`);
        } else if (emulationEngine.formatService) {
          const format = emulationEngine.formatService.getFormatById(step.format);
          if (!format) {
            errors.push(`Step ${index + 1}: Invalid format '${step.format}'`);
          } else {
            // Validate facility/card ranges
            if (step.mode === 'single') {
              if (step.facilityCode > format.maxFacility) {
                errors.push(`Step ${index + 1}: Facility ${step.facilityCode} exceeds format limit ${format.maxFacility}`);
              }
              if (step.cardNumber > format.maxCard) {
                errors.push(`Step ${index + 1}: Card ${step.cardNumber} exceeds format limit ${format.maxCard}`);
              }
            } else if (step.mode === 'range') {
              if (step.facilityEnd > format.maxFacility) {
                errors.push(`Step ${index + 1}: Facility end ${step.facilityEnd} exceeds format limit ${format.maxFacility}`);
              }
              if (step.cardEnd > format.maxCard) {
                errors.push(`Step ${index + 1}: Card end ${step.cardEnd} exceeds format limit ${format.maxCard}`);
              }
              
              const totalCards = ((step.facilityEnd || 0) - (step.facilityStart || 0) + 1) *
                                ((step.cardEnd || 0) - (step.cardStart || 0) + 1);
              if (totalCards > 1000) {
                warnings.push(`Step ${index + 1}: Large card range (${totalCards} cards) may take a long time`);
              }
            }
          }
        }
      }
      
      // Validate door steps
      if (step.type === 'door') {
        if (!step.doorId) {
          errors.push(`Step ${index + 1}: Missing door ID`);
        }
        if (!step.eventType) {
          errors.push(`Step ${index + 1}: Missing event type`);
        }
        if (!step.action) {
          errors.push(`Step ${index + 1}: Missing action`);
        }
      }
      
      // Validate I/O steps
      if (step.type === 'io') {
        if (!step.ioType) {
          errors.push(`Step ${index + 1}: Missing I/O type`);
        }
        if (step.ioId === undefined) {
          errors.push(`Step ${index + 1}: Missing I/O ID`);
        }
        if (!step.action) {
          errors.push(`Step ${index + 1}: Missing action`);
        }
      }
      
      // Validate wait steps
      if (step.type === 'wait') {
        if (!step.waitType) {
          errors.push(`Step ${index + 1}: Missing wait type`);
        }
        if ((step.waitType === 'seconds' || step.waitType === 'minutes') && !step.waitValue) {
          errors.push(`Step ${index + 1}: Missing wait value`);
        }
      }
      
      // Validate control steps
      if (step.type === 'control') {
        if (!step.controlType) {
          errors.push(`Step ${index + 1}: Missing control type`);
        }
        if (step.controlType === 'loop' && step.loopToStep === undefined) {
          errors.push(`Step ${index + 1}: Missing loop target step`);
        }
        if (step.controlType === 'loop' && step.loopToStep >= index) {
          errors.push(`Step ${index + 1}: Loop can only go to previous steps`);
        }
      }
      
      // Validate conditions
      if (step.conditions && step.conditions.length > 0) {
        step.conditions.forEach((condition, condIndex) => {
          if (condition.action === 'jump' && condition.targetStep === undefined) {
            errors.push(`Step ${index + 1}, Condition ${condIndex + 1}: Missing jump target`);
          }
          if ((condition.action === 'activate_output' || condition.action === 'deactivate_output' || 
               condition.action === 'pulse_output') && !condition.outputId) {
            errors.push(`Step ${index + 1}, Condition ${condIndex + 1}: Missing output ID`);
          }
        });
      }
    });
    
    res.json({
      success: errors.length === 0,
      valid: errors.length === 0,
      errors,
      warnings,
      summary: {
        totalSteps: sequence.steps.length,
        errorCount: errors.length,
        warningCount: warnings.length
      }
    });
    
  } catch (err) {
    console.error('[EmulationRoutes] Validate error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

module.exports = { router, initializeEngine };
