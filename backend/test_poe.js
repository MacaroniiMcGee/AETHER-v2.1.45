// PoE tests. No switch required — SSH is stubbed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('./switch/alliedParsers');
const SwitchManager = require('./switch/SwitchManager');

const PREFIX = 'port1.0.';
const dir = path.join(__dirname, 'switch');
for (const f of ['switch-config.json', 'switch-intents.json', 'switch-credentials.json']) {
  try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}

// ---- parser ----

// 1. tabular output with an Admin column
const TABLE = `
Interface      Admin      Pri  Oper         Power  Device
port1.0.1      Enabled    Low  Powered      3800   IP Phone
port1.0.2      Enabled    Low  Off          0
port1.0.3      Disabled   Low  Off          0
port1.0.4      Enabled    Low  Searching    0
`;
const t = P.parsePoeStatus(TABLE, PREFIX, 10);
assert.strictEqual(t[1], 'enabled');
assert.strictEqual(t[2], 'enabled', 'oper Off with admin Enabled is still enabled');
assert.strictEqual(t[3], 'disabled');
assert.strictEqual(t[4], 'enabled', 'Searching is an operational state, not a disabled one');
console.log('✓ PoE admin state read from the table, operational states ignored');

// 1b. real GS970M output where a disabled port breaks column alignment.
// "Enabled" is padded to two spaces, "Disabled" is one character longer and
// leaves only one — so splitting on 2+ spaces silently loses the disabled row.
const REAL_MIXED = `PoE Interface:
Interface   Admin    Pri  Oper     Power Device          Class Max       
                                    (mW)                        (mW)
port1.0.1   Enabled  Crit Powered   5200 n/a                 4 15000 [U] 
port1.0.4   Enabled  Crit Powered  11800 n/a                 4 20000 [U] 
port1.0.8   Disabled High Disabled     0 n/a               n/a 15000 [U] `;
const mixed = P.parsePoeStatus(REAL_MIXED, PREFIX, 10);
assert.strictEqual(mixed[8], 'disabled', 'a disabled port must not read as unknown');
assert.strictEqual(mixed[1], 'enabled');
const mixedDetail = P.parsePoeInterfaces(REAL_MIXED, PREFIX, 10);
assert.strictEqual(mixedDetail[4].powerMw, 11800, 'a 5-digit reading must not shift the column');
assert.strictEqual(mixedDetail[8].powerMw, 0);
assert.strictEqual(mixedDetail[8].admin, mixed[8],
  'the two parsers must never disagree about the same port');
console.log('✓ disabled row parsed despite column padding, both parsers agree');

// 2. per-interface configuration form
const CONF = `
interface port1.0.5
 power inline never
interface port1.0.6
 power inline auto
`;
const c = P.parsePoeStatus(CONF, PREFIX, 10);
assert.strictEqual(c[5], 'disabled');
assert.strictEqual(c[6], 'enabled');
console.log('✓ per-interface "power inline never/auto" parsed');

// 3. a non-PoE switch yields nothing rather than guessing
assert.deepStrictEqual(P.parsePoeStatus('% Invalid input detected', PREFIX, 10), {});
console.log('✓ non-PoE switch reports no PoE state instead of assuming enabled');

// ---- manager ----
(async () => {
  const mgr = new SwitchManager();
  await mgr.loadConfig();
  mgr.config.profiles[0].portCount = 10;
  mgr.config.profiles[0].denyPorts = [10];
  mgr.config.verifyDelaysMs = [10];
  mgr.initialized = true;

  const sent = [];
  let poeState = 'auto';
  mgr._sshShell = async (profile, lines) => {
    const j = lines.join('\n');
    // Real GS970M firmware: hyphenated form only, Cisco-style is rejected.
    if (/power inline (?:auto|never)/.test(j)) return '\n% Unrecognized command\nawplus#';
    if (/no power-inline enable/.test(j)) { poeState = 'never'; sent.push('never'); return 'awplus#'; }
    if (/power-inline enable/.test(j)) { poeState = 'auto'; sent.push('auto'); return 'awplus#'; }
    if (/show power-inline|show power inline/.test(j)) {
      return `Interface      Admin\nport1.0.4      ${poeState === 'never' ? 'Disabled' : 'Enabled'}\nawplus#`;
    }
    return 'awplus#';
  };

  // 4. disable PoE records an intent under its own key
  const r = await mgr.setPoe('lab', 4, false, { holdMs: 300, reason: 'CLC-017' });
  assert.strictEqual(r.poe, 'disabled');
  assert.strictEqual(sent.at(-1), 'never');
  assert.ok(mgr.intents.has('lab:4:poe'), 'PoE intent keyed separately from the link intent');
  console.log('✓ PoE disabled, intent stored under its own key');

  // 5. link and PoE holds coexist on the same port without clobbering each other
  mgr.intents.set('lab:4', { profileId: 'lab', port: 4, revertAt: Date.now() + 60000 });
  assert.strictEqual(mgr.intents.size, 2);
  assert.strictEqual(mgr.intents.get('lab:4:poe').kind, 'poe');
  assert.strictEqual(mgr.intents.get('lab:4').kind, undefined);
  console.log('✓ a link hold and a PoE hold can exist on the same port at once');
  mgr.intents.delete('lab:4');

  // 6. dead-man restores POWER, not the link
  await new Promise(res => setTimeout(res, 700));
  assert.strictEqual(sent.at(-1), 'auto', 'dead-man must issue power inline auto, not no shutdown');
  assert.ok(!mgr.intents.has('lab:4:poe'));
  console.log('✓ dead-man timer restored PoE (not the link) and cleared the intent');

  // 6b. the cached snapshot reflects the change immediately, without a rescan
  const mgrS = new SwitchManager();
  await mgrS.loadConfig();
  mgrS.config.profiles[0].portCount = 10;
  mgrS.config.profiles[0].denyPorts = [10];
  mgrS.initialized = true;
  mgrS._sshShell = async (p, lines) => {
    const j = lines.join('\n');
    if (/show interface brief/.test(j)) return 'port1.0.5   admin up  running\nawplus#';
    if (/show power-inline/.test(j)) {
      return 'Interface   Admin    Pri  Oper     Power\nport1.0.5   Enabled  Low  Powered   6300\nawplus#';
    }
    return 'awplus#';
  };
  const before = await mgrS.getPortSnapshot('lab');
  assert.strictEqual(before.byPort[5].poe, 'enabled');
  assert.strictEqual(before.byPort[5].poePowerMw, 6300);

  await mgrS.setPoe('lab', 5, false, { holdMs: 0, reason: 'cache test' });
  const cached = mgrS.getCachedSnapshot('lab');
  assert.strictEqual(cached.byPort[5].poe, 'disabled',
    'the tile must show PoE off straight away, not after a rescan');
  assert.strictEqual(cached.byPort[5].poePowerMw, 0,
    'a stale wattage next to a "no power" badge contradicts itself');
  assert.strictEqual(cached.ports.find(x => x.port === 5).poe, 'disabled',
    'both views of the snapshot must agree');
  console.log('✓ cached snapshot updates on a PoE change without waiting for a rescan');
  await mgrS.shutdown();

  // 7. the denylist covers PoE too
  await assert.rejects(() => mgr.setPoe('lab', 10, false), /Refusing to touch/);
  console.log('✓ denylist blocks PoE changes as well as link changes');

  // 8. a switch that rejects the command says why
  const mgr2 = new SwitchManager();
  await mgr2.loadConfig();
  mgr2.initialized = true;
  mgr2._sshShell = async () => '\n% Invalid input detected at marker.\nawplus#';
  await assert.rejects(() => mgr2.setPoe('lab', 3, false, { holdMs: 0 }), /did not accept any known PoE command/);
  console.log('✓ non-PoE port rejection explains itself after trying every syntax');

  // 8b. real GS970M `show power-inline` output
  const REAL_POE = `PoE Status:
 Nominal Power: 124W
 Operational Status: On
PoE Interface:
Interface   Admin    Pri  Oper     Power Device          Class Max       
                                    (mW)                        (mW)
port1.0.1   Enabled  Low  Powered   5300 n/a                 4 30000 [C] 
port1.0.2   Enabled  Low  Off          0 n/a               n/a   n/a     
port1.0.8   Enabled  Low  Denied       0 n/a                 4 30000 [C] `;
  const real = P.parsePoeStatus(REAL_POE, PREFIX, 10);
  assert.strictEqual(real[1], 'enabled');
  assert.strictEqual(real[2], 'enabled', 'Oper Off is not an admin disable');
  assert.strictEqual(real[8], 'enabled', 'Denied means over power budget, not disabled');
  console.log('✓ real GS970M PoE table parsed, Off/Denied not mistaken for disabled');

  // 9. revert-all restores each hold with the right command
  const mgr3 = new SwitchManager();
  await mgr3.loadConfig();
  mgr3.config.verifyDelaysMs = [10];
  mgr3.initialized = true;
  const cmds = [];
  mgr3._sshShell = async (p, lines) => {
    const j = lines.join('\n');
    if (/no shutdown/.test(j)) cmds.push('no shutdown');
    if (/power-inline enable/.test(j) && !/no power-inline/.test(j)) cmds.push('power-inline enable');
    if (/show interface/.test(j)) return '\nport1.0.2 is up, line protocol is up\nawplus#';
    return 'awplus#';
  };
  mgr3.intents.set('lab:2', { profileId: 'lab', port: 2, revertAt: Date.now() + 9e6 });
  mgr3.intents.set('lab:3:poe', { profileId: 'lab', port: 3, kind: 'poe', revertAt: Date.now() + 9e6 });
  const results = await mgr3.revertAll('test');
  assert.ok(cmds.includes('no shutdown'), 'link hold restored with no shutdown');
  assert.ok(cmds.includes('power-inline enable'), 'PoE hold restored with power-inline enable');
  assert.strictEqual(results.filter(x => x.ok).length, 2);
  console.log('✓ revert-all restores each hold with the matching command');

  await mgr.shutdown();
  await mgr3.shutdown();
  console.log('\nAll PoE checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
