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

const POE = `PoE Status:
 Nominal Power: 124W
 Power Allocated: 120W
 Power Requested: 150W
 Actual Power Consumption: 30W
 Operational Status: On
 Power Usage Threshold: 80% (99W)
 Power Source: PSU
 Power management mode: Static
PoE Interface:
Interface   Admin    Pri  Oper     Power Device          Class Max       
                                    (mW)                        (mW)
port1.0.1   Enabled  Low  Powered   5300 n/a                 4 30000 [C] 
port1.0.2   Enabled  Low  Off          0 n/a               n/a   n/a     
port1.0.4   Enabled  Low  Powered  10300 n/a                 4 30000 [C] 
port1.0.8   Enabled  Low  Denied       0 n/a                 4 30000 [C] `;

const ARP = `IP Address      MAC Address     Interface  Port        Type
192.168.1.201   e01a.ea9b.c3cd  vlan1      ----        static
192.168.1.50    e430.22f2.c2b9  vlan1      port1.0.4   dynamic
192.168.1.51    e430.22f2.ed0c  vlan1      port1.0.1   dynamic`;

// ---- PoE budget ----
const b = P.parsePoeBudget(POE);
assert.strictEqual(b.nominalW, 124);
assert.strictEqual(b.allocatedW, 120);
assert.strictEqual(b.requestedW, 150);
assert.strictEqual(b.consumptionW, 30);
assert.strictEqual(b.thresholdW, 99);
assert.strictEqual(b.overSubscribed, true, '150W requested against 120W allocated is over budget');
console.log('✓ PoE budget parsed and over-subscription detected');

// ---- per-port PoE ----
const d = P.parsePoeInterfaces(POE, PREFIX, 10);
assert.strictEqual(d[4].powerMw, 10300);
assert.strictEqual(d[4].class, 4);
assert.strictEqual(d[4].maxMw, 30000);
assert.strictEqual(d[1].powerMw, 5300);
assert.strictEqual(d[2].powerMw, 0);
assert.strictEqual(d[8].denied, true);
assert.strictEqual(d[8].admin, 'enabled', 'Denied is a budget refusal, not an admin disable');
console.log('✓ per-port PoE draw, class and denial parsed');

// ---- ARP ----
const a = P.parseArpTable(ARP, PREFIX, 10);
assert.strictEqual(a.byPort[4], '192.168.1.50');
assert.strictEqual(a.byPort[1], '192.168.1.51');
assert.strictEqual(a.byMac[P.normaliseMac('e430.22f2.c2b9')], '192.168.1.50');
assert.ok(!(10 in a.byPort), 'a vlan-only entry has no port and must not be attributed to one');
console.log('✓ ARP table maps IPs to ports and MACs');

// ---- MAC notation is normalised across tables ----
assert.strictEqual(
  P.normaliseMac('e430.22f2.c2b9'),
  P.normaliseMac('E4:30:22:F2:C2:B9'),
  'dotted and colon MAC notations must compare equal');
console.log('✓ MAC notations normalise to the same key across tables');

(async () => {
  const mgr = new SwitchManager();
  await mgr.loadConfig();
  mgr.config.profiles[0].portCount = 10;
  mgr.initialized = true;

  mgr._sshShell = async (p, lines) => {
    const j = lines.join('\n');
    if (/show interface brief/.test(j)) {
      return 'port1.0.1   admin up  running\nport1.0.4   admin up  running\nport1.0.8   admin up  running\nawplus#';
    }
    if (/show power-inline|show power inline/.test(j)) return POE;
    if (/show arp|show ip arp/.test(j)) return ARP;
    if (/mac.address-table/.test(j)) return ' 1  e430.22f2.c2b9  dynamic  port1.0.4\nawplus#';
    if (/show system|show version/.test(j)) return 'Uptime : 21 days 05:25:09\nawplus#';
    return 'awplus#';
  };

  const snap = await mgr.getPortSnapshot('lab');
  assert.strictEqual(snap.poeBudget.overSubscribed, true);
  assert.strictEqual(snap.byPort[4].poePowerMw, 10300);
  assert.strictEqual(snap.byPort[4].ip, '192.168.1.50');
  assert.strictEqual(snap.byPort[8].poeDenied, true);
  assert.ok(snap.arpCount >= 3);
  console.log('✓ snapshot carries PoE budget, per-port watts, denial and IPs');

  // ---- aliases ----
  await mgr.setPortAlias('lab', 4, 'IC20 Controller');
  assert.strictEqual(mgr.getProfile('lab').portAliases['4'], 'IC20 Controller');
  // Applied to the cached snapshot too, so the UI updates without a rescan.
  assert.strictEqual(mgr.getCachedSnapshot('lab').byPort[4].alias, 'IC20 Controller');
  console.log('✓ port alias saved and reflected in the cached snapshot immediately');

  await mgr.setPortAlias('lab', 4, '   ');
  assert.strictEqual(mgr.getProfile('lab').portAliases['4'], undefined,
    'clearing the field removes the alias rather than storing blank');
  console.log('✓ blank alias clears the name instead of storing an empty string');

  await assert.rejects(() => mgr.setPortAlias('lab', 99, 'nope'), /out of range/);
  console.log('✓ alias on a non-existent port rejected');

  // survives a reload from disk
  const mgr2 = new SwitchManager();
  await mgr.setPortAlias('lab', 6, 'Door 3 Reader');
  await mgr2.loadConfig();
  assert.strictEqual(mgr2.getProfile('lab').portAliases['6'], 'Door 3 Reader');
  console.log('✓ aliases persist across a restart');

  const snap2 = await mgr.getPortSnapshot('lab');
  assert.strictEqual(snap2.byPort[6].alias, 'Door 3 Reader');
  console.log('✓ a rescan carries the alias through');

  await mgr.shutdown();
  console.log('\nAll ARP / PoE detail / alias checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
