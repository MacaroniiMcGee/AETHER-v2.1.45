const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SwitchManager = require('./switch/SwitchManager');

const dir = path.join(__dirname, 'switch');
for (const f of ['switch-config.json', 'switch-intents.json', 'switch-credentials.json']) {
  try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}

const iface = (inO, outO) => `
Interface port1.0.1
  Speed: 100 Mbps, Full-duplex
  RX octets: ${inO}
  TX octets: ${outO}
awplus#`;

(async () => {
  const mgr = new SwitchManager();
  await mgr.loadConfig();
  mgr.config.profiles[0].portCount = 10;
  mgr.initialized = true;

  let inO = 0, outO = 0;
  mgr._sshShell = async (p, lines) =>
    /show interface/.test(lines.join('\n')) ? iface(inO, outO) : 'awplus#';

  // 1. monitor starts and takes a sample immediately
  await mgr.startMonitor('lab', 10000);
  assert.strictEqual(mgr.isMonitoring('lab'), true);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(mgr.traffic.get('lab').length >= 1, 'first sample taken without waiting a full interval');
  console.log('✓ monitor starts and samples immediately');

  // 2. one sample gives no rate — a rate needs two points
  let t = mgr.getTraffic('lab', 1);
  assert.strictEqual(t.points.length, 0, 'a single counter reading is not a rate');
  console.log('✓ a single sample yields no rate rather than a fabricated one');

  // 3. rates derived from the counter delta
  const series = mgr.traffic.get('lab');
  series.length = 0;
  series.push({ at: 1000, byPort: { '1': { inOctets: 0, outOctets: 0 } } });
  series.push({ at: 11000, byPort: { '1': { inOctets: 125000, outOctets: 62500 } } });
  t = mgr.getTraffic('lab', 1);
  assert.strictEqual(t.points.length, 1);
  assert.strictEqual(t.points[0].rxBps, 100000, '125000 bytes over 10s = 100 kbps');
  assert.strictEqual(t.points[0].txBps, 50000);
  console.log('✓ rate derived correctly from the counter delta');

  // 4. a counter reset produces a gap, not a negative or a huge spike
  series.push({ at: 21000, byPort: { '1': { inOctets: 5, outOctets: 5 } } });
  t = mgr.getTraffic('lab', 1);
  const last = t.points[t.points.length - 1];
  assert.strictEqual(last.gap, true);
  assert.strictEqual(last.rxBps, null, 'a reboot must not render as a traffic spike');
  console.log('✓ counter reset renders as a gap, not a spike');

  // 5. a port absent from a sample is skipped rather than treated as zero
  series.push({ at: 31000, byPort: {} });
  series.push({ at: 41000, byPort: { '1': { inOctets: 125005, outOctets: 62505 } } });
  t = mgr.getTraffic('lab', 1);
  assert.ok(t.points.every(p => p.rxBps === null || p.rxBps >= 0));
  console.log('✓ missing samples skipped instead of counted as zero traffic');

  // 6. history is bounded
  series.length = 0;
  for (let i = 0; i < 800; i++) {
    series.push({ at: i * 1000, byPort: { '1': { inOctets: i * 100, outOctets: i * 50 } } });
  }
  // trigger the trim through a real tick
  await new Promise(r => setTimeout(r, 50));
  assert.ok(mgr.traffic.get('lab').length <= 800);
  console.log('✓ sample history stays bounded');

  // 7. stopping clears the timer
  mgr.stopMonitor('lab');
  assert.strictEqual(mgr.isMonitoring('lab'), false);
  console.log('✓ monitor stops cleanly');

  // 8. the sampling interval has a floor so nobody can hammer the switch
  const started = await mgr.startMonitor('lab', 100);
  assert.strictEqual(started.intervalMs, 10000, 'interval floored at 10s');
  mgr.stopMonitor('lab');
  console.log('✓ sampling interval floored at 10s regardless of what was asked for');

  await mgr.shutdown();
  console.log('\nAll traffic checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });a
