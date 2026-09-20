// Exercises getPortSnapshot end-to-end against a fake 10-port GS950 that
// answers each show command, then a second pass to check throughput deltas
// and reboot detection.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SwitchManager = require('./switch/SwitchManager');

for (const f of ['switch-config.json', 'switch-intents.json']) {
  try { fs.unlinkSync(path.join(__dirname, 'switch', f)); } catch (_) {}
}

const BRIEF = `
port1.0.1   admin up    running
port1.0.2   admin up    running
port1.0.3   admin up    running
port1.0.4   admin up    running
port1.0.5   admin up    running
port1.0.6   admin up    down
port1.0.7   admin up    down
port1.0.8   admin up    down
port1.0.9   admin up    down
port1.0.10  admin down  down
awplus#`;

const LLDP = `
Local Interface port1.0.4
  Chassis ID: 00d8.6157.05ee
  System Name: ipvideo-iot.local

Local Interface port1.0.5
  Chassis ID: 0002.ac56.1e66
  System Name: XBOXONE
awplus#`;

const MACS = `
 1  0002.ac56.1e66  dynamic  port1.0.1
 1  1063.a3d0.1047  dynamic  port1.0.2
awplus#`;

function ifaceDetail(octets) {
  return `
Interface port1.0.1
  Speed: 1000 Mbps, Full-duplex
  RX octets: ${octets}
  TX octets: ${octets}
  RX errors: 2
awplus#`;
}

(async () => {
  const mgr = new SwitchManager();
  process.env.SWITCH_PASS_LAB = 'x';
  await mgr.loadConfig();
  mgr.config.profiles[0].portCount = 10;   // Prestons is a GS950/10PS
  mgr.initialized = true;

  let octets = 1000;
  let uptime = '30 days 2 hours 37 minutes';
  // A real shell echoes each command before its output, and the batch splitter
  // relies on that. The fixture does the same so it exercises the real path.
  const answer = (cmd) => {
    if (/^show interface brief/.test(cmd)) return BRIEF;
    if (/^show lldp/.test(cmd)) return LLDP;
    if (/mac.address-table|bridge address/.test(cmd)) return MACS;
    if (/^show interfaces?$|^show interface counters/.test(cmd)) return ifaceDetail(octets);
    if (/^show system|^show version/.test(cmd)) return `Uptime: ${uptime}`;
    return '';
  };
  mgr._sshShell = async (profile, lines) => {
    let t = '\nawplus#';
    for (const l of lines) t += `${l}\n${answer(l)}\nawplus#`;
    return t;
  };

  // ---- first pass
  const s1 = await mgr.getPortSnapshot('lab');
  assert.strictEqual(s1.ports.length, 10, 'should report exactly the configured port count');
  assert.strictEqual(s1.byPort[1].status, 'up');
  assert.strictEqual(s1.byPort[6].status, 'disconnected', 'admin up + link down is disconnected');
  assert.strictEqual(s1.byPort[10].status, 'down');
  console.log('✓ five-state status: up / disconnected / admin-down');

  assert.strictEqual(s1.byPort[4].label, 'ipvideo-iot.local');
  assert.strictEqual(s1.byPort[4].labelSource, 'lldp');
  assert.strictEqual(s1.byPort[5].label, 'XBOXONE');
  console.log('✓ LLDP hostnames land on the right tiles');

  assert.strictEqual(s1.byPort[1].label, '0002.ac56.1e66');
  assert.strictEqual(s1.byPort[1].labelSource, 'mac', 'MAC is only a fallback label');
  console.log('✓ MAC used as fallback label where LLDP is silent');

  assert.strictEqual(s1.byPort[1].speedMbps, 1000);
  assert.strictEqual(s1.byPort[1].duplex, 'Full');
  assert.strictEqual(s1.byPort[1].inErrors, 2);
  assert.strictEqual(s1.lldpCount, 2);
  assert.ok(s1.uptimeSeconds > 2_500_000, 'uptime should parse');
  console.log('✓ metrics, error counters and uptime captured');

  assert.strictEqual(s1.byPort[1].rxBps, 0, 'no rate is knowable on the first read');
  console.log('✓ first pass reports no throughput rather than a fake one');

  // ---- second pass: counters advanced
  octets = 1000 + 125000;   // +125 kB
  await new Promise(r => setTimeout(r, 1100));
  const s2 = await mgr.getPortSnapshot('lab');
  assert.ok(s2.byPort[1].rxBps > 0, 'throughput should be derived from the counter delta');
  console.log(`✓ throughput derived from counter delta (${s2.byPort[1].rxBps} bps)`);

  // ---- counter reset must not produce a negative rate
  octets = 5;
  const s3 = await mgr.getPortSnapshot('lab');
  assert.strictEqual(s3.byPort[1].rxBps, 0, 'counter wrap/reset must clamp to zero, not go negative');
  console.log('✓ counter reset clamps to zero instead of a negative rate');

  // ---- reboot detection
  let rebootEvent = null;
  mgr.on('switch-rebooted', e => { rebootEvent = e; });
  uptime = '3 minutes';
  const s4 = await mgr.getPortSnapshot('lab');
  assert.strictEqual(s4.rebootSuspected, true);
  assert.ok(rebootEvent, 'a reboot should emit an event, not just log');
  console.log('✓ uptime going backwards flags a reboot (silently re-enabled ports)');

  await mgr.shutdown();
  console.log('\nAll snapshot checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
