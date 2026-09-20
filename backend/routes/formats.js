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
