// Profile management tests — no switch required.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SwitchManager = require('./switch/SwitchManager');

const dir = path.join(__dirname, 'switch');
for (const f of ['switch-config.json', 'switch-intents.json', 'switch-credentials.json']) {
  try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
}

(async () => {
  const mgr = new SwitchManager();
  await mgr.loadConfig();
  await mgr.loadCredentials();
  mgr.initialized = true;

  // 1. add a valid profile
  const p = await mgr.addProfile({
    id: 'Lab-2', name: 'Second Lab Switch', host: '192.168.1.202',
    username: 'manager', interfacePrefix: 'port1.0.', portCount: 10,
    denyPorts: [10],
  });
  assert.strictEqual(p.id, 'lab-2', 'id should be normalised to lowercase');
  assert.strictEqual(p.credentialEnv, 'SWITCH_PASS_LAB-2');
  console.log('✓ profile added and id normalised');

  // 2. duplicate ids rejected
  await assert.rejects(() => mgr.addProfile({
    id: 'lab-2', host: '10.0.0.1', username: 'x', portCount: 8,
  }), /already exists/);
  console.log('✓ duplicate profile id rejected');

  // 3. required fields
  await assert.rejects(() => mgr.addProfile({ id: 'nohost', username: 'm', portCount: 8 }), /IP or hostname/);
  await assert.rejects(() => mgr.addProfile({ id: 'nouser', host: '10.0.0.2', portCount: 8 }), /Username/);
  await assert.rejects(() => mgr.addProfile({ id: 'badcount', host: '10.0.0.3', username: 'm', portCount: 999 }),
    /between 1 and 128/);
  console.log('✓ missing host, missing username and silly port counts rejected');

  // 4. NETGEAR refused up front rather than failing at connect time
  await assert.rejects(() => mgr.addProfile({
    id: 'furnace', host: '192.168.1.3', username: 'admin', portCount: 28, vendor: 'netgear',
  }), /SNMP client, which is not implemented/);
  console.log('✓ NETGEAR profile refused with a clear reason, not a late connect error');

  // 5. denyPorts sanitised against the port count
  const p5 = await mgr.addProfile({
    id: 'deny', host: '10.0.0.4', username: 'm', portCount: 8,
    denyPorts: [1, 1, 99, -3, 'x', 8],
  });
  assert.deepStrictEqual(p5.denyPorts, [1, 8], 'out-of-range and duplicate deny ports dropped');
  console.log('✓ denyPorts de-duplicated and clamped to the port range');

  // 6. credentials are stored outside the config and never echoed
  await mgr.setCredential('lab-2', 's3cret');
  assert.strictEqual(mgr.hasCredential('lab-2'), true);
  const cfgText = fs.readFileSync(path.join(dir, 'switch-config.json'), 'utf8');
  assert.ok(!cfgText.includes('s3cret'), 'password must never land in switch-config.json');
  const mode = fs.statSync(path.join(dir, 'switch-credentials.json')).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'credentials file must be 0600');
  console.log('✓ credential stored at 0600, absent from the config file');

  // 7. status exposes whether a password exists, never the password
  const status = mgr.getStatus();
  const entry = status.profiles.find(x => x.id === 'lab-2');
  assert.strictEqual(entry.hasCredential, true);
  assert.ok(!JSON.stringify(status).includes('s3cret'), 'status must not leak the password');
  console.log('✓ status reports credential presence without exposing it');

  // 8. update
  const upd = await mgr.updateProfile('lab-2', { name: 'Renamed', portCount: 28 });
  assert.strictEqual(upd.name, 'Renamed');
  assert.strictEqual(upd.portCount, 28);
  console.log('✓ profile updated');

  // 9. a profile with ports held down cannot be deleted or shrunk out from under them
  mgr.intents.set('lab-2:12', { profileId: 'lab-2', port: 12, revertAt: Date.now() + 60000 });
  await assert.rejects(() => mgr.deleteProfile('lab-2'), /still held down/);
  await assert.rejects(() => mgr.updateProfile('lab-2', { portCount: 8 }), /held down/);
  console.log('✓ deleting or shrinking a switch with held ports is refused');

  mgr.intents.delete('lab-2:12');
  await mgr.deleteProfile('lab-2');
  assert.strictEqual(mgr.config.profiles.some(x => x.id === 'lab-2'), false);
  assert.strictEqual(mgr.hasCredential('lab-2'), false, 'credential should go with the profile');
  console.log('✓ profile deleted once released, credential removed with it');

  // 10. the config file on disk stays valid JSON throughout
  JSON.parse(fs.readFileSync(path.join(dir, 'switch-config.json'), 'utf8'));
  console.log('✓ config file remains parseable after every write');

  // 11. testConnection reports model and privilege
  mgr._sshShell = async () => `
Base       535  Base    AT-GS970M/10PS                    B-0   A10034A254200017
Uptime             : 21 days 05:25:09
Software version   : 5.5.5-0.5
awplus#`;
  const t = await mgr.testConnection('deny');
  assert.strictEqual(t.model, 'AT-GS970M/10PS');
  assert.strictEqual(t.version, '5.5.5-0.5');
  assert.strictEqual(t.privileged, true);
  assert.ok(t.uptimeSeconds > 1_800_000);
  console.log('✓ test connection reports model, version, uptime and privilege');

  // 12. a session stuck in user mode is flagged, not reported as fine
  mgr._sshShell = async () => '\nSoftware version   : 5.5.5-0.5\nawplus>';
  const t2 = await mgr.testConnection('deny');
  assert.strictEqual(t2.privileged, false);
  assert.ok(/user mode/.test(t2.note));
  console.log('✓ user-mode session flagged — ports could not be changed');

  await mgr.shutdown();
  console.log('\nAll profile checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
