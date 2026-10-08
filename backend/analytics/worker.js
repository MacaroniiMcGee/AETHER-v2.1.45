// analytics/worker.js — runs a scan off the main thread so GPIO/Wiegand timing in
// the backend is never stalled by parsing a large bundle.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const analytics = require('./index');

try {
  const { inputs, mode, journal, opts, wiring } = workerData;
  const report = mode === 'product-test'
    ? analytics.productTest(inputs, journal || [], opts, wiring || {})
    : analytics.inspect(inputs, opts);
  parentPort.postMessage({ ok: true, report });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
}
