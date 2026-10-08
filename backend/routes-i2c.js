// backend/routes-i2c.js
// I2C / HAT health and the bus flight recorder.
//
// Mount in server.js:
//   app.use('/api/i2c', require('./routes-i2c')(() => gpioQueue));
//
//   GET  /api/i2c/diag          bus stats (per source / per route), queue stats, Pi power + thermal
//   GET  /api/i2c/recent?n=200  last N bus transactions (who, what, how long, result)
//   GET  /api/i2c/dumps         saved lockup dumps
//   GET  /api/i2c/dumps/:name   one dump (JSON)
//   POST /api/i2c/dump          save a dump now (e.g. right after you notice a lock-up)

const express = require('express');
const bus = require('./lib/i2cBus');

module.exports = function (getQueue) {
  const router = express.Router();

  router.get('/diag', async (_req, res) => {
    try {
      const q = typeof getQueue === 'function' ? getQueue() : null;
      const qs = q && typeof q.getStats === 'function' ? q.getStats() : null;
      const system = await bus.systemSnapshot();
      const b = bus.stats();
      const warnings = [];
      if (system.throttleFlags && system.throttleFlags.some(f => /under-voltage/.test(f))) {
        warnings.push('Under-voltage detected. A weak 5 V supply is a common cause of HAT lock-ups; the stream adds CPU load and current draw.');
      }
      if (system.cpuTempC && system.cpuTempC >= 80) warnings.push(`CPU at ${system.cpuTempC}°C (throttling starts around 80–85°C).`);
      if (b.lastMinute.busyPct >= 50) warnings.push(`I2C bus busy ${b.lastMinute.busyPct}% of the last minute.`);
      if (b.lastMinute.maxWaitMs >= 2000) warnings.push(`Commands waited up to ${b.lastMinute.maxWaitMs} ms for the bus.`);
      if (process.env.ENABLE_PN532) warnings.push('PN532 NFC is enabled on the same I2C bus from a separate process; its traffic is not visible here.');
      res.json({ success: true, bus: b, queue: qs, system, warnings, dumps: bus.listDumps().slice(0, 10) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/recent', (req, res) => {
    const n = Math.max(1, Math.min(1000, parseInt(req.query.n, 10) || 200));
    res.json({ success: true, transactions: bus.recent(n) });
  });

  router.get('/dumps', (_req, res) => res.json({ success: true, dumps: bus.listDumps() }));

  router.get('/dumps/:name', (req, res) => {
    try { res.json({ success: true, dump: bus.readDump(req.params.name) }); }
    catch (e) { res.status(404).json({ success: false, error: e.message }); }
  });

  router.post('/dump', async (_req, res) => {
    const file = await bus.writeDump('manual');
    res.json({ success: !!file, file: file || null, note: file ? undefined : 'A dump was written less than a minute ago' });
  });

  return router;
};
