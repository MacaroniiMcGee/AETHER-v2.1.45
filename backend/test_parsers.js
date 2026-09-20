const assert = require('assert');
const P = require('./switch/alliedParsers');

const PREFIX = 'port1.0.';
const N = 10;

// 1. brief status — the three-way split
const brief = `
port1.0.1       admin up     running
port1.0.2       admin up     running
port1.0.3       admin up     down
port1.0.4       admin down   down
port1.0.5       admin up     running
`;
const st = P.parseBriefStatus(brief, PREFIX, N);
assert.strictEqual(st[1], 'up');
assert.strictEqual(st[3], 'disconnected', 'admin up + link down must be disconnected, not up');
assert.strictEqual(st[4], 'down');
console.log('✓ brief status splits up / disconnected / admin-down');

// 2. LLDP detail blocks
const lldpDetail = `
Local Interface port1.0.4
  Chassis ID: 00:d8:61:57:05:ee
  System Name: ipvideo-iot.local
  System Description: IP Video IoT Bridge
  Port Description: eth0

Local Interface port1.0.5
  Chassis ID: 0002.ac56.1e66
  System Name: XBOXONE
`;
const nbrs = P.parseLldpNeighbors(lldpDetail, PREFIX, N);
assert.strictEqual(nbrs[4].hostname, 'ipvideo-iot.local');
assert.strictEqual(nbrs[4].remotePort, 'eth0');
assert.strictEqual(nbrs[5].hostname, 'XBOXONE');
console.log('✓ LLDP detail blocks parsed (hostname, chassis, port desc)');

// 3. LLDP compact table
const lldpTable = `
Local Port  Chassis ID         Port ID    System Name
port1.0.2   1063.a3d0.1047     gi1        switch-b
`;
const compact = P.parseLldpNeighbors(lldpTable, PREFIX, N);
assert.strictEqual(compact[2].hostname, 'switch-b');
console.log('✓ LLDP compact table parsed');

// 4. MAC table, both notations
const macTable = `
 1   0002.ac56.1e66   dynamic   port1.0.1
 1   00:d8:61:57:05:ee dynamic  port1.0.3
`;
const macs = P.parseMacTable(macTable, PREFIX, N);
assert.strictEqual(macs[1], '0002.ac56.1e66');
assert.strictEqual(macs[3], '00:d8:61:57:05:ee');
console.log('✓ MAC table parsed in both dotted and colon notation');

// 5. interface metrics — label:value form
const ifDetail = `
Interface port1.0.1
  Speed: 1000 Mbps, Full-duplex
  RX octets: 1,234,567
  RX errors: 3
  RX discards: 1
  TX octets: 7,654,321
  TX errors: 0
  TX discards: 2

Interface port1.0.2
  Speed: 100 Mbps, Half-duplex
  RX: 120 packets, 98543 bytes
  TX: 90 packets, 45000 bytes
`;
const m = P.parseInterfaceMetrics(ifDetail, PREFIX, N);
assert.strictEqual(m[1].speedMbps, 1000);
assert.strictEqual(m[1].duplex, 'Full');
assert.strictEqual(m[1].inOctets, 1234567);
assert.strictEqual(m[1].outOctets, 7654321);
assert.strictEqual(m[1].inErrors, 3);
assert.strictEqual(m[1].outDiscards, 2);
assert.strictEqual(m[2].duplex, 'Half');
assert.strictEqual(m[2].inOctets, 98543, 'combined "N bytes" form should parse');
console.log('✓ interface metrics parsed in both label and combined forms');

// 6. unparseable output degrades to zeros, never throws
const junk = P.parseInterfaceMetrics('%% Unknown command\n', PREFIX, N);
assert.deepStrictEqual(junk, {});
assert.deepStrictEqual(P.parseBriefStatus('', PREFIX, N), {});
assert.deepStrictEqual(P.parseLldpNeighbors('', PREFIX, N), {});
console.log('✓ unrecognised output returns empty rather than throwing');

// 7a. real AT-GS970M/10PS output, captured from AlliedWare Plus 5.5.5
const REAL_BRIEF = `Interface             Status          Protocol
port1.0.1             admin up        running    
port1.0.9             admin up        down       
port1.0.10            admin up        running    
lo                    admin up        running    
vlan1                 admin up        running    `;
const rb = P.parseBriefStatus(REAL_BRIEF, PREFIX, 10);
assert.strictEqual(rb[1], 'up');
assert.strictEqual(rb[9], 'disconnected');
assert.strictEqual(rb[10], 'up');
assert.ok(!('lo' in rb) && Object.keys(rb).length === 3, 'lo and vlan1 must be ignored');
console.log('✓ real AWPlus 5.5.5 brief output parsed, logical interfaces ignored');

// 7b. `show system` puts the current clock ABOVE the uptime line
const REAL_SYS = `System Status                                           Wed Sep 02 03:31:07 2026
Base       535  Base    AT-GS970M/10PS                    B-0   A10034A254200017
Environment Status : Normal
Uptime             : 21 days 05:25:09
Software version   : 5.5.5-0.5`;
assert.strictEqual(P.parseUptimeSeconds(REAL_SYS), 21 * 86400 + 5 * 3600 + 25 * 60 + 9,
  'must read the Uptime line, not the header timestamp');
console.log('✓ uptime taken from the labelled line, not the header clock');

// 7. uptime, both wordy and h:mm:ss
assert.strictEqual(P.parseUptimeSeconds('30 days 2 hours 37 minutes'), 30 * 86400 + 2 * 3600 + 37 * 60);
assert.strictEqual(P.parseUptimeSeconds('uptime is 5 days, 04:03:02'), 5 * 86400 + 4 * 3600 + 3 * 60 + 2);
console.log('✓ uptime parsed in both formats');

// 8. human counters
assert.strictEqual(P.parseHumanCounter('1.5 K'), 1500);
assert.strictEqual(P.parseHumanCounter('2,340'), 2340);
assert.strictEqual(P.parseHumanCounter('3M'), 3000000);
console.log('✓ human-readable counters normalised');

// 9. port numbers outside the switch's range are ignored
const oob = P.parseBriefStatus('port1.0.48   admin up   running\n', PREFIX, 10);
assert.deepStrictEqual(oob, {}, 'port 48 on a 10-port switch must be dropped');
console.log('✓ out-of-range ports ignored (10-port switch rejects port 48)');

console.log('\nAll parser checks passed.');
