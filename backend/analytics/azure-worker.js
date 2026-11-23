// analytics/azure-worker.js — runs one Azure Debugger scan off the main thread (AETHER_AZURE_DEBUG).
// workerData: { inputs: [{path,name}], opts }
// Posts { ok, report, azure } — report is the normal Log Analytics inspection, azure is analytics/azure.js.
'use strict';
const { parentPort, workerData } = require('worker_threads');

try {
  const bundle = require('./bundle');
  const { parseBundle } = require('./parsers');
  const azure = require('./azure');
  const analytics = require('./index');

  const o = { ...analytics.DEFAULTS, ...(workerData.opts || {}) };
  const m = bundle.open(workerData.inputs);
  let az;
  try {
    const parsed = parseBundle(m, o);
    az = azure.extract(m, parsed);
    az.zone = parsed.zone;
  } finally { m.cleanup(); }

  const report = analytics.inspect(workerData.inputs, o);
  report.mode = 'inspection';
  az.hops = azure.hops(report, az);
  parentPort.postMessage({ ok: true, report, azure: az });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e && e.stack ? String(e.message) : String(e) });
}
