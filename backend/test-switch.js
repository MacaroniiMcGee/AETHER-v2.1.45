// Offline exercise of SwitchManager with the SSH transport stubbed out.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SwitchManager = require('./switch/SwitchManager');

const dir = path.join(__dirname, 'switch');
for (const f of ['switch-config.json', 'switch-intents.json', 'switch-credentials.json']) {
  try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}

// Fake switch: tracks admin state per port, renders plausible AlliedWare Plus output.
function makeFake(mgr, adminState) {
  mgr._sshShell = async (profile, lines) => {
    const joined = lines.join('\n');
    const ifm = joined.match(/interface port1\.0\.(\d+)/);
    if (ifm && /(?:^|\n)shutdown/.test(joined)) adminState[ifm[1]] = 'down';
    if (ifm && /no shutdown/.test(joined)) adminState[ifm[1]] = 'up';

    const showm = joined.match(/show interface port1\.0\.(\d+)/);
    if (showm) {
      const p = showm[1];
      const st = adminState[p] || 'up';
      return st === 'down'
        ? `\nInterface port1.0.${p}\n  port1.0.${p} is administratively down, line protocol is down\n  Link is DOWN\nawplus#`
        : `\nInterface port1.0.${p}\n  port1.0.${p} is up, line protocol is up\n  Link is UP\nawplus#`;
    }
    if (/show mac address-table/.test(joined)) {
      return `\n  1   0011.2233.4455   dynamic   port1.0.7\nawplus#`;
    }
    return 'awplus#';
  };
}

(async () => {
  const admin = {};
  const mgr = new SwitchManager();
  process.env.SWITCH_PASS_LAB = 'test';
  await mgr.loadConfig();
  makeFake(mgr, admin);
  mgr.config.defaultHoldMs = 400;
  mgr.config.verifyDelaysMs = [10, 20, 40];
  mgr.initialized = true;

  // 1. denylist blocks configured uplink
  await assert.rejects(() => mgr.setPort('lab', 1, false), /Refusing to touch/);
  console.log('✓ denylist blocks configured uplink port');

  // 2. denylist blocks the self port once resolved
  mgr.resolvedSelfPort.set('lab', 7);
  await assert.rejects(() => mgr.setPort('lab', 7, false), /own port|reaches the network/i);
  console.log('✓ denylist blocks auto-resolved self port');

  // 3. range check
  await assert.rejects(() => mgr.setPort('lab', 99, false), /out of range/);
  console.log('✓ out-of-range port rejected');

  // 4. disable + verify + intent recorded
  const r = await mgr.setPort('lab', 12, false, { holdMs: 400, reason: 'CLC-004' });
  assert.strictEqual(r.admin, 'down');
  assert.strictEqual(admin['12'], 'down');
  assert.ok(mgr.intents.has('lab:12'), 'intent recorded');
  console.log('✓ disable applied, verified, intent persisted');

  // 5. admin-state parse (link down on an enabled port is NOT a failure)
  const st = mgr._parseInterfaceState(
    'port1.0.3 is up, line protocol is down\n', 'port1.0.3');
  assert.strictEqual(st.admin, 'up');
  assert.strictEqual(st.oper, 'down');
  console.log('✓ admin up / link down parsed correctly (booting controller case)');

  // 6. dead-man timer restores the port on its own
  await new Promise(r2 => setTimeout(r2, 1400));
  assert.strictEqual(admin['12'], 'up', 'dead-man should have re-enabled port 12');
  assert.ok(!mgr.intents.has('lab:12'), 'intent cleared after revert');
  console.log('✓ dead-man timer auto-restored the port');

  // 7. reconcile heals an expired hold left behind by a "crash"
  admin['20'] = 'down';
  mgr.intents.set('lab:20', {
    profileId: 'lab', port: 20, reason: 'crashed run',
    disabledAt: Date.now() - 10000, revertAt: Date.now() - 5000, holdMs: 5000
  });
  const repairs = await mgr.reconcile();
  assert.strictEqual(admin['20'], 'up', 'reconcile should restore expired hold');
  assert.ok(repairs.some(x => x.action === 'restored'));
  console.log('✓ reconcile restored a port orphaned by a crash');

  // 8. revertAll panic button
  admin['30'] = 'down';
  mgr.intents.set('lab:30', { profileId: 'lab', port: 30, revertAt: Date.now() + 999999 });
  await mgr.revertAll('panic');
  assert.strictEqual(admin['30'], 'up');
  console.log('✓ revert-all restored held ports');

  // 9. switch rejection surfaces as an error, not a silent success
  const mgr2 = new SwitchManager();
  await mgr2.loadConfig();
  mgr2.initialized = true;
  mgr2.config.verifyDelaysMs = [10,20,40];
  mgr2._sshShell = async () => '\n% Invalid input detected at marker.\nawplus#';
  await assert.rejects(() => mgr2.setPort('lab', 12, false), /Switch rejected command/);
  console.log('✓ "%" error line from switch surfaces as a failure');

  // 10. settling switch: first read-back still reports the OLD state
  const admin3 = { '15': 'up' };
  const mgr3 = new SwitchManager();
  await mgr3.loadConfig();
  mgr3.initialized = true;
  mgr3.config.verifyDelaysMs = [20, 40, 80];
  let reads = 0;
  makeFake(mgr3, admin3);
  const realShell = mgr3._sshShell;
  mgr3._sshShell = async (profile, lines) => {
    const joined = lines.join('\n');
    if (/show interface/.test(joined) && ++reads === 1) {
      // Switch ACKed the shutdown but still reports the pre-command state.
      return '\nport1.0.15 is up, line protocol is up\nawplus#';
    }
    return realShell(profile, lines);
  };
  const settled = await mgr3.disablePort('lab', 15, { holdMs: 0, reason: 'settling test' });
  assert.strictEqual(settled.admin, 'down');
  assert.ok(reads >= 2, 'should have re-read after the stale first response');
  console.log('\u2713 stale first read-back retried instead of failing (' + reads + ' reads)');
  await mgr3.shutdown();

  // 11. a port that genuinely never changes still fails
  const mgr4 = new SwitchManager();
  await mgr4.loadConfig();
  mgr4.initialized = true;
  mgr4.config.verifyDelaysMs = [10, 20];
  mgr4._sshShell = async (p, lines) =>
    /show interface/.test(lines.join('\n'))
      ? '\nport1.0.16 is up, line protocol is up\nawplus#'
      : 'awplus#';
  await assert.rejects(() => mgr4.disablePort('lab', 16, { holdMs: 0 }), /still reads/);
  console.log('\u2713 port that never settles still reports a failure');
  await mgr4.shutdown();

  // 12. bulk operations report per-port outcomes and do not abort on one failure
  const mgr5 = new SwitchManager();
  await mgr5.loadConfig();
  mgr5.config.profiles[0].portCount = 10;
  mgr5.config.profiles[0].denyPorts = [1];
  mgr5.config.verifyDelaysMs = [10];
  mgr5.initialized = true;
  const admin5 = {};
  makeFake(mgr5, admin5);
  const bulk = await mgr5.setPorts('lab', [1, 2, 3], false, { holdMs: 0 });
  assert.strictEqual(bulk.results.length, 3);
  assert.strictEqual(bulk.results.find(r => r.port === 1).ok, false, 'denied port fails');
  assert.strictEqual(bulk.results.find(r => r.port === 2).ok, true, 'others still applied');
  assert.strictEqual(bulk.results.find(r => r.port === 3).ok, true);
  console.log('✓ bulk disable applies the rest when one port is denied');

  // 13. an indefinite hold records an intent with no revert time
  const indef = mgr5.intents.get('lab:2');
  assert.ok(indef, 'indefinite hold still recorded');
  assert.strictEqual(indef.revertAt, null, 'no revert time means nothing will restore it');
  assert.strictEqual(mgr5.deadman.has('lab:2'), false, 'and no timer is armed');
  console.log('✓ indefinite hold tracked with no timer, so it stays visible');

  await mgr5.shutdown();
  await mgr.shutdown();
  console.log('\nAll checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
