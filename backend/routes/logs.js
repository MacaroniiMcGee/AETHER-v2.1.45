// routes/logs.js - System logging API
const express = require('express');
const router = express.Router();

// In-memory log storage
const logs = {
  system: [],
  access: [],
  security: []
};

const MAX_LOGS = 1000;

// Helper to add log entry
function addLog(type, entry) {
  if (!logs[type]) logs[type] = [];
  logs[type].unshift({
    id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    ...entry
  });
  if (logs[type].length > MAX_LOGS) logs[type].pop();
}

// Exported helper functions
function logSystemEvent(message, level = 'info', data = {}) {
  addLog('system', { message, level, ...data });
}

function logAccessEvent(message, data = {}) {
  addLog('access', { message, ...data });
}

function logSecurityEvent(message, severity = 'medium', data = {}) {
  addLog('security', { message, severity, ...data });
}

// GET /api/logs/system
router.get('/system', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  const level = req.query.level;
  let results = logs.system;
  if (level) results = results.filter(l => l.level === level);
  res.json({
    success: true,
    type: 'system',
    count: results.slice(0, limit).length,
    total: results.length,
    logs: results.slice(0, limit)
  });
});

// GET /api/logs/access
router.get('/access', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  res.json({
    success: true,
    type: 'access',
    count: logs.access.slice(0, limit).length,
    total: logs.access.length,
    logs: logs.access.slice(0, limit)
  });
});

// GET /api/logs/security
router.get('/security', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  const severity = req.query.severity;
  let results = logs.security;
  if (severity) results = results.filter(l => l.severity === severity);
  res.json({
    success: true,
    type: 'security',
    count: results.slice(0, limit).length,
    total: results.length,
    logs: results.slice(0, limit)
  });
});

// GET /api/logs/all
router.get('/all', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100);
  const combined = [
    ...logs.system.map(l => ({ ...l, type: 'system' })),
    ...logs.access.map(l => ({ ...l, type: 'access' })),
    ...logs.security.map(l => ({ ...l, type: 'security' }))
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  res.json({
    success: true,
    count: combined.slice(0, limit).length,
    total: combined.length,
    logs: combined.slice(0, limit)
  });
});

// GET /api/logs/stats
router.get('/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      system: logs.system.length,
      access: logs.access.length,
      security: logs.security.length,
      total: logs.system.length + logs.access.length + logs.security.length,
      maxPerType: MAX_LOGS
    }
  });
});

// GET /api/logs/export
router.get('/export', (req, res) => {
  const { type } = req.query;
  const exportData = type && logs[type] ? { [type]: logs[type] } : logs;
  res.setHeader('Content-Disposition', `attachment; filename=logs-${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ exported: new Date().toISOString(), logs: exportData });
});

// POST /api/logs
router.post('/', (req, res) => {
  const { type = 'system', message, level, severity, ...data } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });
  if (!logs[type]) return res.status(400).json({ success: false, error: 'Invalid log type' });
  addLog(type, { message, level, severity, ...data });
  res.json({ success: true, message: 'Log entry added' });
});

// DELETE /api/logs
router.delete('/', (req, res) => {
  const { type } = req.query;
  if (type && logs[type]) {
    const count = logs[type].length;
    logs[type] = [];
    res.json({ success: true, message: `Cleared ${count} ${type} logs` });
  } else {
    const counts = { system: logs.system.length, access: logs.access.length, security: logs.security.length };
    logs.system = []; logs.access = []; logs.security = [];
    res.json({ success: true, message: 'All logs cleared', cleared: counts });
  }
});

module.exports = {
  router,
  logSystemEvent,
  logAccessEvent,
  logSecurityEvent
};
