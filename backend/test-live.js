const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SwitchManager = require('./switch/SwitchManager');

const dir = path.join(__dirname, 'switch');
for (const f of ['switch-config.json', 'switch-intents.json', 'switch-credentials.json']) {
  try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}

const BRIEF_UP = `port1.0.1   admin up    running
port1.0.2   admin up    down
port1.0.3   admin down  down
awplus#`;
const BRIEF_DOWN2 = `port1.0.1   admin up    running
port1.0.2   admin up    running
port1.0.3   admin down  down
awplus#`;
const POE = `Interface   Admin    Pri  Oper     Power
port1.0.1   Enabled  Crit Powered   5200
port1.0.2   Enabled  Crit Off          0
port1.0.3   Disabled High Disabled     0
awplus#`;

(async () => {
  const mgr = new SwitchManager();
  await mgr.loadConfig();
  mgr.config.profiles[0].portCount = 10;
  mgr.config.profiles[0].denyPorts = [10];
  mgr.config.verifyDelaysMs = [10];
  mgr.initialized = true;

  let brief = BRIEF_UP;
  const sent = [];
  const answer = (cmd) => {
    if (/^show interface brief/.test(cmd)) return brief;
    if (/^show power-inline|^show power inline/.test(cmd)) return POE;
    if (/^show interface/.test(cmd)) return 'port1.0.1 is up, line protocol is up';
    if (/^show system|^show version/.test(cmd)) return 'Uptime : 3 days 01:00:00';
    return '';
  };
  mgr._sshShell = async (p, lines) => {
    const j = lines.join('\n');
    if (/no shutdown/.test(j)) { sent.push('up'); brief = BRIEF_DOWN2; return 'awplus#'; }
    if (/\bshutdown/.test(j)) { sent.push('down'); return 'awplus#'; }
    if (/power-inline enable/.test(j)) return 'awplus#';
    let t = '\nawplus#';
    for (const l of lines) t += `${l}\n${answer(l)}\nawplus#`;
    return t;
  };

  // 1. live state is cheap — brief + poe only
  const shells = [];
  const realShell = mgr._sshShell;
  mgr._sshShell = async (p, lines) => { shells.push(lines.join('\n')); return realShell(p, lines); };

  const live = await mgr.getLiveState('lab');
  const shows = shells.filter(x => /show /.test(x));
  assert.ok(shows.length <= 2, `live poll should issue at most 2 reads, issued ${shows.length}`);
  assert.strictEqual(live.ports.length, 10);
  assert.strictEqual(live.ports[0].status, 'up');
  assert.strictEqual(live.ports[1].status, 'disconnected');
  assert.strictEqual(live.ports[2].status, 'down');
  assert.strictEqual(live.ports[2].poe, 'disabled');
  console.log('✓ live state reads only link and PoE (2 commands, not 6)');

  // 1b. a live poll costs ONE ssh session, not one per command
  let sessions = 0;
  const prev = mgr._sshShell;
  mgr._sshShell = async (p, lines) => { sessions++; return prev(p, lines); };
  await mgr.getLiveState('lab');
  assert.strictEqual(sessions, 1, `live poll should open 1 session, opened ${sessions}`);
  console.log('✓ live poll opens a single SSH session');
  mgr._sshShell = prev;

  // 2. live state merges into the cached snapshot rather than replacing it
  await mgr.getPortSnapshot('lab');
  mgr._patchSnapshot('lab', 1, { label: 'IC20 Controller', ip: '192.168.1.50' });
  await mgr.getLiveState('lab');
  const cached = mgr.getCachedSnapshot('lab');
  assert.strictEqual(cached.byPort[1].label, 'IC20 Controller',
    'a live poll must not wipe labels discovered by a full scan');
  assert.strictEqual(cached.byPort[1].ip, '192.168.1.50');
  console.log('✓ live poll updates state without discarding labels or IPs');

  // 3. events are recorded for link and PoE changes
  mgr.events.set('lab', []);
  await mgr.setPort('lab', 2, false, { holdMs: 0, reason: 'CLC-004' });
  await mgr.setPoe('lab', 3, false, { holdMs: 0, reason: 'CLC-017' });
  const events = mgr.getEvents('lab');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].kind, 'link');
  assert.strictEqual(events[0].action, 'disable');
  assert.strictEqual(events[0].reason, 'CLC-004');
  assert.strictEqual(events[1].kind, 'poe');
  assert.strictEqual(events[1].port, 3);
  console.log('✓ link and PoE changes recorded as events with their reasons');

  // 4. events can be filtered by time, for chart windows
  const cutoff = Date.now() + 1000;
  assert.strictEqual(mgr.getEvents('lab', cutoff).length, 0);
  assert.strictEqual(mgr.getEvents('lab', 0).length, 2);
  console.log('✓ events filterable by time window');

  // 5. history is bounded
  for (let i = 0; i < 600; i++) mgr._recordEvent('lab', { kind: 'link', port: 1, action: 'test' });
  assert.ok(mgr.getEvents('lab').length <= 500, 'event history must stay bounded');
  console.log('✓ event history capped');

  // 6. all-port traffic returns a short tail per port
  const series = mgr.traffic.get('lab') || [];
  mgr.traffic.set('lab', series);
  for (let i = 0; i < 60; i++) {
    series.push({ at: 1000 + i * 10000, byPort: { '1': { inOctets: i * 12500, outOctets: i * 6250 } } });
  }
  const all = mgr.getAllTraffic('lab', 20);
  assert.strictEqual(Object.keys(all.byPort).length, 10, 'one entry per port, even empty ones');
  assert.ok(all.byPort[1].length <= 20, 'sparkline tail is capped');
  assert.ok(all.byPort[1].every(p => p.rxBps === null || p.rxBps >= 0));
  assert.strictEqual(all.byPort[5].length, 0, 'a port with no samples returns an empty series');
  console.log('✓ all-port traffic returns a capped tail per port');

  await mgr.shutdown();
  console.log('\nAll live / event / sparkline checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
