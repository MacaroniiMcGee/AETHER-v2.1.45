// routes/formats.js - Format API endpoints (FIXED route order)
const express = require('express');
const router = express.Router();
const formatService = require('../lib/formatService');

// GET /api/formats - Get all formats
router.get('/', (req, res) => {
  res.json({
    success: true,
    count: formatService.getAllFormats().length,
    formats: formatService.getAllFormats()
  });
});

// GET /api/formats/categories - MUST be before /:id
router.get('/categories', (req, res) => {
  res.json({
    success: true,
    categories: formatService.getCategories()
  });
});

// GET /api/formats/popular - MUST be before /:id
router.get('/popular', (req, res) => {
  res.json({
    success: true,
    formats: formatService.getMostCommon()
  });
});

// GET /api/formats/category/:category - MUST be before /:id
router.get('/category/:category', (req, res) => {
  const formats = formatService.getFormatsByCategory(req.params.category);
  res.json({
    success: true,
    category: req.params.category,
    count: formats.length,
    formats
  });
});

// GET /api/formats/search/:query - MUST be before /:id
router.get('/search/:query', (req, res) => {
  const formats = formatService.searchFormats(req.params.query);
  res.json({
    success: true,
    query: req.params.query,
    count: formats.length,
    formats
  });
});

// ── Encoder preview and user formats (MUST be before /:id) ──────────────────
const cmap = require('../lib/credentialMap');
const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v));

// POST /api/formats/encode  { formatId | map, facility, card, issue }
router.post('/encode', (req, res) => {
  try {
    const { formatId, map, facility = 0, card = 0, issue = 0 } = req.body || {};
    if (map) return res.json({ success: true, ...formatService.encodeMap(map, { facility, card, issue }) });
    const r = formatService.encodeCredential(formatId, facility, card, issue);
    res.json({ success: true, ...jsonSafe({ ...r, bytes: undefined, value: undefined }) });
  } catch (e) {
    res.status(e.status || 400).json({ success: false, error: e.message });
  }
});

// POST /api/formats/pin-preview  { pin, mode, terminator }
router.post('/pin-preview', (req, res) => {
  try {
    const { pin = '', mode = 'combined', terminator = '#' } = req.body || {};
    res.json({ success: true, frames: cmap.pinFrames(pin, { mode, terminator }) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// POST /api/formats/confirm { id, confirmed: true|false }
router.post('/confirm', (req, res) => {
  try {
    const { id, confirmed = true } = req.body || {};
    const f = formatService.setConfirmed(String(id || ''), !!confirmed);
    res.json({ success: true, id: f.id, status: f.status });
  } catch (e) { res.status(e.status || 400).json({ success: false, error: e.message }); }
});

router.get('/custom/list', (req, res) => {
  res.json({ success: true, formats: formatService.getUserFormats() });
});

router.post('/custom', (req, res) => {
  try {
    const entry = formatService.saveUserFormat(req.body || {});
    res.json({ success: true, format: entry });
  } catch (e) { res.status(e.status || 400).json({ success: false, error: e.message }); }
});

router.delete('/custom/:id', (req, res) => {
  const ok = formatService.deleteUserFormat(req.params.id);
  res.status(ok ? 200 : 404).json({ success: ok, ...(ok ? {} : { error: 'Format not found' }) });
});

// GET /api/formats/:id - MUST be LAST (catches everything)
router.get('/:id', (req, res) => {
  const format = formatService.getFormatById(req.params.id);
  if (format) {
    res.json({ success: true, format });
  } else {
    res.status(404).json({ success: false, error: 'Format not found' });
  }
});

module.exports = router;
