// SwitchManager.js — Ethernet switch port control (Allied Telesis / AlliedWare Plus over SSH)
//
// Purpose: give Aether a way to take a controller's network link down and bring it
// back, so offline/recovery cases (CLC-003/004/005, CLC-010, CLC-017) can run
// unattended alongside card reads and GPIO instead of someone pulling a cable.
//
// Design notes, and why:
//
//  * Commands are SERIALIZED through a queue, same reasoning as GPIOQueueManager.
//    Two SSH sessions dropping into `configure terminal` at once on the same box
//    is how you get a half-applied config. One at a time, always.
//
//  * A DENYLIST is enforced before every action and cannot be bypassed by the API.
//    Disabling the uplink, the management port, or the port this Pi is talking
//    through severs our own path and nothing can re-enable it remotely.
//
//  * Every disable records a persisted INTENT with a revertAt timestamp. A DEAD-MAN
//    timer restores the port when it expires. On startup we reconcile: read the real
//    switch state and heal anything left behind by a crash or reboot. A scale run
//    that dies at minute 10 of a 4-hour disconnect must not leave a controller dark
//    overnight and produce a clean-looking wrong result.
//
//  * Verification checks the ADMIN state, not link state. After `no shutdown` a
//    controller that is still booting shows link down — that is correct behaviour,
//    not a failed command. Oper state is reported separately for information.
//
// CLI parsing caveat: the `show` output regexes below are permissive and may need
// tuning against your actual GS970M firmware. Anything unparseable is reported as
// 'unknown' rather than guessed at, and the raw transcript is always attached so
// you can see what the switch really said. Run `verifyPort()` once by hand against
// the lab unit before trusting a long scenario to it.

const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { Client } = require('ssh2');
const AP = require('./alliedParsers');

const DEFAULT_CONFIG = {
  enabled: true,
  // Never let a command through for these, no matter who asks.
  // 'self' is resolved at startup to the port this Pi is reachable through.
  globalDenyPorts: [],
  maxHoldMs: 7 * 24 * 60 * 60 * 1000,   // 7 days — matches the longest CLC case
  defaultHoldMs: 60 * 60 * 1000,        // 1 hour if a caller forgets to set one
  commandTimeoutMs: 25000,
  minDelayBetweenCommandsMs: 250,
  // Some switches ACK a CLI command before the status table reflects it, so an
  // immediate read-back returns the OLD state and looks like a failed write.
  // Read again on this schedule and only fail if it never settles. Lifted from
  // the desktop tool's _schedule_post_action_refresh, which hit this on the
  // same hardware.
  verifyDelaysMs: [1200, 3000, 6000],
  profiles: [
    {
      id: 'lab',
      name: 'GS970M Lab Switch',
      host: '192.168.1.161',
      port: 22,
      username: 'manager',
      // Password source, in order: env var named here, then switch-credentials.json.
      // Never stored in this config file.
      credentialEnv: 'SWITCH_PASS_LAB',
      vendor: 'allied',
      interfacePrefix: 'port1.0.',
      portCount: 52,
      enablePassword: null,        // null = `enable` needs no password
      denyPorts: [1],              // uplink — CONFIRM THIS against the rack before use
      autoDetectSelfPort: true
    }
  ]
};

class SwitchManager extends EventEmitter {
  constructor() {
    super();
    this.configPath = path.join(__dirname, 'switch-config.json');
    this.credentialsPath = path.join(__dirname, 'switch-credentials.json');
    this.intentsPath = path.join(__dirname, 'switch-intents.json');

    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.credentials = {};
    this.intents = new Map();      // `${profileId}:${port}` -> intent
    this.portState = new Map();    // `${profileId}:${port}` -> { admin, oper, checkedAt }
    this.snapshots = new Map();    // profileId -> last full snapshot (labels, metrics, uptime)
    this.traffic = new Map();      // profileId -> [{ at, byPort: { port: {inOctets, outOctets} } }]
    this.monitors = new Map();     // profileId -> { handle, period, startedAt }
    this.events = new Map();       // profileId -> [{ at, kind, port, action, reason }]
    this.deadman = new Map();      // key -> timeout handle
    this.resolvedSelfPort = new Map(); // profileId -> port | null

    this.queue = [];
    this.processing = false;
    this.initialized = false;

    this.stats = {
      commandsRun: 0,
      commandsFailed: 0,
      portsDisabled: 0,
      portsEnabled: 0,
      deadmanReverts: 0,
      reconcileRepairs: 0,
      lastActivity: null
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async initialize() {
    console.log('[Switch] Initializing Switch Manager...');
    await this.loadConfig();
    await this.loadCredentials();
    await this.loadIntents();

    if (!this.config.enabled) {
      console.log('[Switch] Disabled by config — no connections will be made');
      this.initialized = false;
      return false;
    }

    for (const profile of this.config.profiles) {
      if (profile.autoDetectSelfPort !== false) {
        try {
          const selfPort = await this.resolveSelfPort(profile);
          this.resolvedSelfPort.set(profile.id, selfPort);
          if (selfPort) {
            console.log(`[Switch] ${profile.id}: this host appears to be on port ${selfPort} — added to denylist`);
          } else {
            console.warn(`[Switch] ${profile.id}: could not resolve this host's own port. ` +
              'Set denyPorts manually or you risk cutting your own management path.');
          }
        } catch (err) {
          console.warn(`[Switch] ${profile.id}: self-port detection failed: ${err.message}`);
          this.resolvedSelfPort.set(profile.id, null);
        }
      }
    }

    this.initialized = true;
    console.log(`[Switch] ✓ Manager initialized — ${this.config.profiles.length} profile(s)`);

    // Heal anything a crash or reboot left behind, then arm timers for live holds.
    await this.reconcile().catch(err =>
      console.error('[Switch] Startup reconcile failed:', err.message));

    return true;
  }

  async shutdown() {
    for (const handle of this.deadman.values()) clearTimeout(handle);
    this.deadman.clear();
    for (const id of Array.from(this.monitors.keys())) this.stopMonitor(id);
  }

  // ── config + credentials ─────────────────────────────────────────────────

  async loadConfig() {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const loaded = JSON.parse(raw);
      this.config = { ...this.config, ...loaded };
      console.log(`[Switch] Configuration loaded (${this.config.profiles.length} profiles)`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[Switch] No config file found, writing defaults');
        await this.saveConfig();
      } else {
        console.error('[Switch] Error loading config:', err.message);
      }
    }
  }

  async saveConfig() {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    // Write-then-rename. A direct write that is interrupted leaves a truncated
    // file, and a truncated config parses as an error and silently falls back
    // to defaults — meaning you drive a switch you did not configure.
    const tmp = `${this.configPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.config, null, 2));
    await fs.rename(tmp, this.configPath);
  }

  // Passwords come from the environment first (systemd LoadCredential / EnvironmentFile),
  // falling back to a 0600 JSON file. They are never written into switch-config.json.
  async loadCredentials() {
    try {
      const raw = await fs.readFile(this.credentialsPath, 'utf8');
      this.credentials = JSON.parse(raw);
      const stat = await fs.stat(this.credentialsPath);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        console.warn(`[Switch] ⚠ ${path.basename(this.credentialsPath)} is mode ${mode.toString(8)} ` +
          '— switch passwords are world/group readable. chmod 600 it.');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[Switch] Error loading credentials:', err.message);
      this.credentials = {};
    }
  }

  _credentialFor(profile) {
    if (profile.credentialEnv && process.env[profile.credentialEnv]) {
      return process.env[profile.credentialEnv];
    }
    if (this.credentials[profile.id]) return this.credentials[profile.id];
    throw new Error(
      `No password for profile "${profile.id}". Set env ${profile.credentialEnv || 'SWITCH_PASS_' + profile.id.toUpperCase()} ` +
      `or add an entry to ${path.basename(this.credentialsPath)}.`);
  }

  getProfile(profileId) {
    const profile = this.config.profiles.find(p => p.id === profileId);
    if (!profile) throw new Error(`Unknown switch profile "${profileId}"`);
    return profile;
  }

  // ── profile management ───────────────────────────────────────────────────
  //
  // Editable from the UI so nobody has to hand-write JSON on the Pi. Every
  // field is validated here rather than in the route, because the automation
  // engine and any future caller go through this path too.

  _validateProfile(input, { existingId = null } = {}) {
    const p = { ...input };

    p.id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!p.id) throw new Error('Profile id is required (letters, numbers, dash, underscore)');
    if (p.id !== existingId && this.config.profiles.some(x => x.id === p.id)) {
      throw new Error(`A profile with id "${p.id}" already exists`);
    }

    p.name = String(p.name || '').trim() || p.id;
    p.host = String(p.host || '').trim();
    if (!p.host) throw new Error('Switch IP or hostname is required');

    p.port = Number(p.port) || 22;
    p.username = String(p.username || '').trim();
    if (!p.username) throw new Error('Username is required');

    p.vendor = p.vendor === 'netgear' ? 'netgear' : 'allied';
    if (p.vendor === 'netgear') {
      // Be explicit rather than accepting it and failing later on connect.
      throw new Error('NETGEAR profiles need the SNMP client, which is not implemented yet');
    }

    p.interfacePrefix = String(p.interfacePrefix || 'port1.0.').trim();
    p.portCount = Number(p.portCount);
    if (!Number.isInteger(p.portCount) || p.portCount < 1 || p.portCount > 128) {
      throw new Error('Port count must be a whole number between 1 and 128');
    }

    p.enablePassword = p.enablePassword || null;
    p.autoDetectSelfPort = p.autoDetectSelfPort !== false;
    p.credentialEnv = String(p.credentialEnv || `SWITCH_PASS_${p.id.toUpperCase()}`).trim();

    // Friendly names per port, keyed by port number as a string. Empty names
    // are dropped so a cleared field removes the alias rather than storing ''.
    const aliases = {};
    for (const [k, v] of Object.entries(p.portAliases || {})) {
      const n = Number(k);
      const name = String(v || '').trim().slice(0, 40);
      if (Number.isInteger(n) && n >= 1 && n <= p.portCount && name) aliases[String(n)] = name;
    }
    p.portAliases = aliases;

    const deny = Array.isArray(p.denyPorts) ? p.denyPorts : [];
    p.denyPorts = [...new Set(deny.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= p.portCount))]
      .sort((a, b) => a - b);

    return p;
  }

  async addProfile(input) {
    const profile = this._validateProfile(input);
    this.config.profiles.push(profile);
    await this.saveConfig();
    console.log(`[Switch] Profile added: ${profile.id} (${profile.host}, ${profile.portCount} ports)`);
    this.emit('profiles-changed', { action: 'add', profileId: profile.id });
    return profile;
  }

  async updateProfile(profileId, updates) {
    const idx = this.config.profiles.findIndex(p => p.id === profileId);
    if (idx < 0) throw new Error(`Unknown switch profile "${profileId}"`);

    const merged = this._validateProfile(
      { ...this.config.profiles[idx], ...updates, id: profileId },
      { existingId: profileId });

    // Shrinking a switch can strand a hold on a port that no longer exists.
    const held = Array.from(this.intents.values())
      .filter(i => i.profileId === profileId && i.port > merged.portCount);
    if (held.length) {
      throw new Error(
        `Port ${held.map(h => h.port).join(', ')} is currently held down and would fall outside the new ` +
        `port count. Restore it first.`);
    }

    this.config.profiles[idx] = merged;
    await this.saveConfig();
    this.snapshots.delete(profileId);   // shape may have changed
    console.log(`[Switch] Profile updated: ${profileId}`);
    this.emit('profiles-changed', { action: 'update', profileId });
    return merged;
  }

  async deleteProfile(profileId) {
    const idx = this.config.profiles.findIndex(p => p.id === profileId);
    if (idx < 0) throw new Error(`Unknown switch profile "${profileId}"`);

    // Deleting a profile whose ports are down would orphan them: the dead-man
    // timer would fire against a profile that no longer exists and the ports
    // would stay down with nothing tracking them.
    const held = Array.from(this.intents.values()).filter(i => i.profileId === profileId);
    if (held.length) {
      throw new Error(
        `${held.length} port(s) on this switch are still held down. Restore them before deleting the profile.`);
    }

    this.config.profiles.splice(idx, 1);
    await this.saveConfig();
    this.snapshots.delete(profileId);
    this.resolvedSelfPort.delete(profileId);
    delete this.credentials[profileId];
    await this.saveCredentials().catch(() => {});
    console.log(`[Switch] Profile deleted: ${profileId}`);
    this.emit('profiles-changed', { action: 'delete', profileId });
    return { deleted: profileId };
  }

  /** Name a port. Stored on the profile so it survives restarts and shows up
   *  everywhere the port does — including the automation log. */
  async setPortAlias(profileId, port, alias) {
    const profile = this.getProfile(profileId);
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > profile.portCount) {
      throw new Error(`Port ${port} out of range for ${profileId} (1-${profile.portCount})`);
    }
    profile.portAliases = profile.portAliases || {};
    const name = String(alias || '').trim().slice(0, 40);
    if (name) profile.portAliases[String(n)] = name;
    else delete profile.portAliases[String(n)];

    await this.saveConfig();
    // Patch the cached snapshot so the rename shows immediately rather than
    // waiting for the next scan.
    const snap = this.snapshots.get(profileId);
    if (snap) {
      const entry = snap.byPort[n];
      if (entry) { entry.alias = name; }
      const inList = snap.ports.find(x => x.port === n);
      if (inList) inList.alias = name;
    }
    this.emit('alias-changed', { profileId, port: n, alias: name });
    return { profileId, port: n, alias: name };
  }

  /**
   * Set the per-port PoE reservation ceiling.
   *
   * This is a switch CONFIG change, not a test action — unlike setPort/setPoe
   * it has no hold, no dead-man timer and no intent. It is a setting you mean
   * to keep.
   *
   * Why it matters: in static power management the switch reserves each port's
   * advertised class maximum, not its actual draw. Five class-4 devices pulling
   * 6W each still reserve 30W apiece — 150W — and the switch starts denying
   * power while most of the budget sits unused. Capping the reservation is the
   * fix, because the device's class is negotiated by the device and cannot be
   * changed from the switch.
   *
   * @param maxMw  reservation in milliwatts, or null to remove the cap
   */
  async setPoeMax(profileId, port, maxMw) {
    const profile = this.getProfile(profileId);
    const n = this.assertAllowed(profile, port);
    const iface = `${profile.interfacePrefix}${n}`;

    let mw = null;
    if (maxMw !== null && maxMw !== undefined && maxMw !== '') {
      mw = Number(maxMw);
      if (!Number.isFinite(mw) || mw <= 0) throw new Error('Max power must be a positive number of milliwatts');
      mw = Math.round(mw);
      // 4000-30000 mW spans class 1 through class 4. Outside that the switch
      // will reject it anyway; catching it here gives a clearer message.
      if (mw < 4000 || mw > 30000) {
        throw new Error(`Max power ${mw} mW is outside the supported 4000–30000 mW range`);
      }
    }

    // A cap below what the device already draws will deny it power — trading
    // one dead port for another. Warn using the last scan rather than refusing,
    // since the draw may be stale and the operator may know better.
    const snap = this.snapshots.get(profileId);
    const drawing = snap && snap.byPort[n] ? snap.byPort[n].poePowerMw : 0;
    if (mw && drawing && mw < drawing) {
      console.warn(`[Switch] ${profileId}:${n} cap of ${mw} mW is below its measured draw of ${drawing} mW — ` +
        'the switch will likely deny this port power.');
    }

    await this._enqueue(`poe-max ${profileId}:${n}`, async () => {
      const transcript = await this._sshShell(profile, [
        ...this._enterLines(profile),
        'configure terminal',
        `interface ${iface}`,
        mw === null ? 'no power-inline max' : `power-inline max ${mw}`,
        'end',
      ]);
      const errLine = (transcript.split('\n').find(l => l.trim().startsWith('%')) || '').trim();
      if (errLine) throw new Error(`Switch rejected command: ${errLine}`);
      return { transcript };
    });

    this._patchSnapshot(profileId, n, { poeMaxMw: mw });
    console.log(`[Switch] ${profileId}:${n} PoE max ${mw === null ? 'cleared' : `${mw} mW`}`);
    const payload = { profileId, port: n, maxMw: mw, belowDraw: !!(mw && drawing && mw < drawing), drawingMw: drawing || 0 };
    this.emit('poe-max-changed', payload);
    return payload;
  }

  /**
   * Persist the running config to startup.
   *
   * Port up/down and PoE on/off deliberately do NOT save — a test change should
   * evaporate on reboot. A power reservation cap is the opposite: it is real
   * configuration and needs to survive a restart, so saving is exposed as its
   * own explicit action rather than happening silently.
   */
  async writeStartupConfig(profileId) {
    const profile = this.getProfile(profileId);
    return this._enqueue(`write ${profileId}`, async () => {
      const transcript = await this._sshShell(profile, [
        ...this._enterLines(profile), 'write',
      ]);
      const errLine = (transcript.split('\n').find(l => l.trim().startsWith('%')) || '').trim();
      if (errLine) throw new Error(`Switch rejected write: ${errLine}`);
      console.log(`[Switch] ${profileId}: running config saved to startup`);
      return { ok: true };
    });
  }

  async saveCredentials() {
    const tmp = `${this.credentialsPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.credentialsPath);
    await fs.chmod(this.credentialsPath, 0o600);
  }

  /** Store a switch password. Kept out of switch-config.json deliberately, so
   *  the config can be shared or committed without leaking credentials. */
  async setCredential(profileId, password) {
    this.getProfile(profileId);
    if (!password) throw new Error('Password cannot be empty');
    this.credentials[profileId] = String(password);
    await this.saveCredentials();
    console.log(`[Switch] Credential stored for ${profileId}`);
    return { ok: true };
  }

  hasCredential(profileId) {
    const profile = this.config.profiles.find(p => p.id === profileId);
    if (!profile) return false;
    return !!(this.credentials[profileId] ||
      (profile.credentialEnv && process.env[profile.credentialEnv]));
  }

  /**
   * Log in and read `show system`. Confirms host, credentials and privilege in
   * one round trip, and reports the model back so a wrong port count is
   * obvious before it matters.
   */
  async testConnection(profileId) {
    const profile = this.getProfile(profileId);
    return this._enqueue(`test ${profileId}`, async () => {
      const transcript = await this._sshShell(profile, [
        ...this._enterLines(profile), 'show system',
      ]);

      const model = (transcript.match(/\b(AT-[A-Z0-9/\-]+)/i) || [])[1] || null;
      const version = (transcript.match(/Software version\s*:\s*(\S+)/i) || [])[1] || null;
      const uptimeSeconds = AP.parseUptimeSeconds(transcript);

      // A prompt ending in '#' means enable succeeded; '>' means we are still in
      // user mode and shutdown/no shutdown will be rejected later.
      const privileged = /#\s*$/.test(transcript.trimEnd());

      return {
        ok: true, host: profile.host, model, version, uptimeSeconds, privileged,
        note: privileged ? null
          : 'Connected, but the session stayed in user mode — enable may need a password before ports can be changed.',
      };
    });
  }

  // ── safety: denylist ─────────────────────────────────────────────────────

  denyListFor(profile) {
    const deny = new Set([
      ...(this.config.globalDenyPorts || []),
      ...(profile.denyPorts || [])
    ]);
    const selfPort = this.resolvedSelfPort.get(profile.id);
    if (selfPort) deny.add(selfPort);
    return deny;
  }

  // Throws rather than warning. A scheduled run at 2am has nobody to read a warning.
  assertAllowed(profile, port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > profile.portCount) {
      throw new Error(`Port ${port} out of range for ${profile.id} (1-${profile.portCount})`);
    }
    const deny = this.denyListFor(profile);
    if (deny.has(n)) {
      const selfPort = this.resolvedSelfPort.get(profile.id);
      const why = n === selfPort
        ? 'this is the port this host reaches the network through'
        : 'listed in denyPorts';
      throw new Error(`Refusing to touch ${profile.id} port ${n}: ${why}.`);
    }
    return n;
  }

  // ── command queue (one SSH session at a time, per the GPIO queue rationale) ──

  _enqueue(label, fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ label, fn, resolve, reject });
      if (!this.processing) this._drain();
    });
  }

  async _drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        const result = await Promise.race([
          job.fn(),
          new Promise((_, rej) => {
            const t = setTimeout(
              () => rej(new Error(`Switch command timed out: ${job.label}`)),
              this.config.commandTimeoutMs);
            if (t.unref) t.unref();
          })
        ]);
        this.stats.commandsRun++;
        this.stats.lastActivity = new Date().toISOString();
        job.resolve(result);
      } catch (err) {
        this.stats.commandsFailed++;
        console.error(`[Switch] ${job.label} failed:`, err.message);
        job.reject(err);
      }
      if (this.queue.length) {
        await new Promise(r => {
          const t = setTimeout(r, this.config.minDelayBetweenCommandsMs);
          if (t.unref) t.unref();
        });
      }
    }
    this.processing = false;
  }

  // ── SSH transport ────────────────────────────────────────────────────────
  //
  // AlliedWare Plus needs an interactive shell — `configure terminal` and
  // `interface ...` are shell modes, and an `exec` channel typically will not
  // carry you into them. So: open a shell, feed lines, read to the prompt.

  _sshShell(profile, lines) {
    const password = this._credentialFor(profile);
    const promptRe = /(?:^|\n)[\w.\-@()/]+[>#]\s*$/;

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const finish = (err, out) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch (_) {}
        err ? reject(err) : resolve(out);
      };

      conn.on('ready', () => {
        conn.shell({ term: 'vt100' }, (err, stream) => {
          if (err) return finish(err);
          let transcript = '';
          let idx = 0;
          let waiting = false;

          let settleTimer = null;
          const pump = () => {
            if (waiting) return;
            if (idx >= lines.length) {
              // Give the last command a moment to echo before closing.
              const t = setTimeout(() => finish(null, transcript), 400);
              if (t.unref) t.unref();
              return;
            }
            const line = lines[idx++];
            waiting = true;
            stream.write(line + '\n');
            settleTimer = setTimeout(() => { settleTimer = null; waiting = false; pump(); }, 700);
            if (settleTimer.unref) settleTimer.unref();
          };

          stream.on('data', chunk => {
            transcript += chunk.toString('utf8');
            if (promptRe.test(transcript.slice(-200))) {
              if (waiting) {
                // Cancel the fallback timer. Leaving it armed meant it fired
                // later and advanced the queue a SECOND time, so commands could
                // be skipped entirely — and every line still cost the full
                // 700ms even when the switch had already answered.
                if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
                waiting = false;
                pump();
              }
            }
          });
          stream.on('close', () => finish(null, transcript));
          stream.stderr.on('data', d => { transcript += d.toString('utf8'); });

          pump();
        });
      });

      conn.on('error', err => finish(new Error(`SSH to ${profile.host}: ${err.message}`)));
      conn.on('keyboard-interactive', (n, i, il, prompts, cb) => cb(prompts.map(() => password)));

      conn.connect({
        host: profile.host,
        port: profile.port || 22,
        username: profile.username,
        password,
        tryKeyboard: true,
        readyTimeout: 15000,
        // Lab switches often run older KEX/cipher sets than Node's defaults allow.
        // If a connection fails on algorithm negotiation, widen this list.
        algorithms: {
          kex: [
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1'
          ],
          serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
        }
      });
    });
  }

  _enterLines(profile) {
    const lines = ['enable'];
    if (profile.enablePassword) lines.push(profile.enablePassword);
    lines.push('terminal length 0');   // suppress paging; harmless if unsupported
    return lines;
  }

  // ── port actions ─────────────────────────────────────────────────────────

  /**
   * Set a port's admin state.
   *
   * @param {string}  profileId
   * @param {number}  port
   * @param {boolean} enabled   true = `no shutdown`, false = `shutdown`
   * @param {object}  opts
   *   holdMs  - for a disable, auto re-enable after this long. Defaults to
   *             config.defaultHoldMs. Pass holdMs: 0 for an indefinite hold —
   *             only do that if something else is guaranteed to clean up.
   *   reason  - free text, stored on the intent and emitted with events
   *   verify  - default true; read back the admin state after the write
   */
  async setPort(profileId, port, enabled, opts = {}) {
    const profile = this.getProfile(profileId);
    const n = this.assertAllowed(profile, port);
    const key = `${profileId}:${n}`;
    const iface = `${profile.interfacePrefix}${n}`;
    const reason = opts.reason || null;

    const holdMs = enabled
      ? 0
      : (opts.holdMs === undefined ? this.config.defaultHoldMs : Number(opts.holdMs));

    if (!enabled && holdMs > this.config.maxHoldMs) {
      throw new Error(`holdMs ${holdMs} exceeds maxHoldMs ${this.config.maxHoldMs}`);
    }

    const result = await this._enqueue(`${enabled ? 'enable' : 'disable'} ${key}`, async () => {
      const lines = [
        ...this._enterLines(profile),
        'configure terminal',
        `interface ${iface}`,
        enabled ? 'no shutdown' : 'shutdown',
        'end'
      ];
      const transcript = await this._sshShell(profile, lines);

      // AlliedWare Plus rejects with a '%' line. Catch it rather than reporting success.
      const errLine = (transcript.split('\n').find(l => l.trim().startsWith('%')) || '').trim();
      if (errLine) throw new Error(`Switch rejected command: ${errLine}`);

      return { transcript };
    });

    // Note the change to the STARTUP CONFIG caveat: this deliberately does not
    // `write` / `copy running-config startup-config`. A power blip on the switch
    // therefore silently re-enables every port. On a 7-day disconnect test that
    // ends the run early and looks like a pass — see switchUptime in getStatus().

    let verify = null;
    if (opts.verify !== false) {
      const want = enabled ? 'up' : 'down';
      const delays = this.config.verifyDelaysMs || [1200, 3000, 6000];

      for (let attempt = 0; attempt < delays.length; attempt++) {
        // Deliberately NOT unref'd: an await depends on this firing. An unref'd
        // timer lets Node exit the event loop mid-verification.
        await new Promise(r => setTimeout(r, delays[attempt]));

        verify = await this.verifyPort(profileId, n).catch(err => ({
          admin: 'unknown', oper: 'unknown', error: err.message
        }));

        if (verify.admin === want) break;

        // 'unknown' means the parse failed, not that the write failed. Retrying
        // won't fix a bad regex, so stop and let it through with a warning
        // rather than throwing on every single command.
        if (verify.admin === 'unknown') {
          console.warn(`[Switch] ${key}: could not read admin state back ` +
            `(attempt ${attempt + 1}/${delays.length}). Check the show-interface parse.`);
          if (attempt === delays.length - 1) break;
          continue;
        }

        // Read a real state, but the wrong one — still settling, or the write
        // genuinely didn't take. Only the last attempt decides.
        if (attempt === delays.length - 1) {
          this.emit('port-verify-failed', { profileId, port: n, expected: want, got: verify.admin });
          throw new Error(
            `Port ${key}: wrote ${enabled ? 'no shutdown' : 'shutdown'} but admin state still reads ` +
            `"${verify.admin}" after ${delays.length} reads over ${delays.reduce((a, b) => a + b, 0)}ms`);
        }
        console.warn(`[Switch] ${key}: reads "${verify.admin}", expected "${want}" — re-reading`);
      }
    }

    if (enabled) {
      this.stats.portsEnabled++;
      this._clearDeadman(key);
      this.intents.delete(key);
    } else {
      this.stats.portsDisabled++;
      const now = Date.now();
      const intent = {
        profileId, port: n, reason,
        disabledAt: now,
        revertAt: holdMs > 0 ? now + holdMs : null,
        holdMs
      };
      this.intents.set(key, intent);
      if (holdMs > 0) this._armDeadman(key, intent.revertAt);
      else console.warn(`[Switch] ${key} disabled INDEFINITELY — it stays down until someone re-enables it`);
    }
    await this.saveIntents();

    this._patchSnapshot(profileId, n, {
      admin: enabled ? 'up' : 'down',
      // A port we just shut is 'down'; one we just brought up has no link yet
      // as far as we know, so it reads disconnected until the next read.
      status: enabled ? (verify && verify.oper === 'up' ? 'up' : 'disconnected') : 'down',
      oper: verify ? verify.oper : 'unknown',
      held: !enabled,
      revertAt: enabled ? null : (this.intents.get(key) || {}).revertAt || null,
    });

    const payload = {
      profileId, port: n, iface,
      admin: enabled ? 'up' : 'down',
      oper: verify ? verify.oper : 'unknown',
      reason, holdMs,
      revertAt: enabled ? null : (this.intents.get(key) || {}).revertAt || null,
      timestamp: Date.now()
    };
    this._recordEvent(profileId, {
      kind: 'link', port: n, action: enabled ? 'enable' : 'disable',
      reason, holdMs: enabled ? null : holdMs,
    });
    this.emit('port-change', payload);
    console.log(`[Switch] ${key} → ${enabled ? 'ENABLED' : 'DISABLED'}` +
      (reason ? ` (${reason})` : '') +
      (!enabled && holdMs > 0 ? ` — auto-revert in ${Math.round(holdMs / 1000)}s` : ''));

    return payload;
  }

  disablePort(profileId, port, opts = {}) { return this.setPort(profileId, port, false, opts); }
  enablePort(profileId, port, opts = {})  { return this.setPort(profileId, port, true, opts); }

  /**
   * Apply the same change to several ports.
   *
   * Runs them through the same queue one at a time rather than in parallel —
   * concurrent `configure terminal` sessions on one switch is how you get a
   * half-applied config. One failure does not abort the rest: a partial result
   * with per-port outcomes is more useful than stopping halfway with no record
   * of what did apply.
   */
  async setPorts(profileId, ports, enabled, opts = {}) {
    const list = [...new Set((ports || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
    if (!list.length) throw new Error('No ports given');

    const results = [];
    for (const port of list) {
      try {
        const r = await this.setPort(profileId, port, enabled, opts);
        results.push({ port, ok: true, admin: r.admin });
      } catch (err) {
        results.push({ port, ok: false, error: err.message });
      }
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`[Switch] Bulk ${enabled ? 'enable' : 'disable'} on ${profileId}: ` +
      `${results.length - failed}/${results.length} succeeded`);
    return { profileId, action: enabled ? 'enable' : 'disable', results };
  }

  async setPoeBulk(profileId, ports, enabled, opts = {}) {
    const list = [...new Set((ports || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
    if (!list.length) throw new Error('No ports given');

    const results = [];
    for (const port of list) {
      try {
        const r = await this.setPoe(profileId, port, enabled, opts);
        results.push({ port, ok: true, poe: r.poe });
      } catch (err) {
        results.push({ port, ok: false, error: err.message });
      }
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`[Switch] Bulk PoE ${enabled ? 'on' : 'off'} on ${profileId}: ` +
      `${results.length - failed}/${results.length} succeeded`);
    return { profileId, action: enabled ? 'poe-enable' : 'poe-disable', results };
  }

  /**
   * Switch PoE on or off for a port.
   *
   * This is a genuinely different failure from `shutdown`, which is why it
   * exists rather than being folded into setPort. Disabling the link leaves the
   * controller powered and holding its RAM state; cutting PoE cold-boots it.
   * CLC-017 is exactly the comparison between those two.
   *
   * Same guarantees as a link change: denylist enforced, intent persisted,
   * dead-man revert armed. A device left unpowered for a week because a run
   * crashed is worse than one left unplugged.
   *
   * NOTE on the denylist: if this Pi is itself PoE-powered from this switch,
   * cutting PoE on its port kills Aether mid-scenario — harder to recover from
   * than a dropped link, because nothing is left running to restore it.
   */
  async setPoe(profileId, port, enabled, opts = {}) {
    const profile = this.getProfile(profileId);
    const n = this.assertAllowed(profile, port);
    const key = `${profileId}:${n}:poe`;
    const iface = `${profile.interfacePrefix}${n}`;
    const reason = opts.reason || null;

    const holdMs = enabled
      ? 0
      : (opts.holdMs === undefined ? this.config.defaultHoldMs : Number(opts.holdMs));

    if (!enabled && holdMs > this.config.maxHoldMs) {
      throw new Error(`holdMs ${holdMs} exceeds maxHoldMs ${this.config.maxHoldMs}`);
    }

    await this._enqueue(`${enabled ? 'poe-on' : 'poe-off'} ${profileId}:${n}`, async () => {
      // AlliedWare Plus spells this `power-inline enable` (hyphenated), negated
      // with `no`. Older/other firmware uses the Cisco-style `power inline
      // auto|never`. Try each and keep the first the switch accepts, rather
      // than hard-coding one and failing on half the estate.
      const candidates = enabled
        ? ['power-inline enable', 'power inline auto']
        : ['no power-inline enable', 'power inline never'];

      let lastError = null;
      for (const cmd of candidates) {
        const transcript = await this._sshShell(profile, [
          ...this._enterLines(profile),
          'configure terminal',
          `interface ${iface}`,
          cmd,
          'end',
        ]);
        const errLine = (transcript.split('\n').find(l => l.trim().startsWith('%')) || '').trim();
        if (!errLine) return { transcript, command: cmd };

        lastError = errLine;
        // A rejection of the syntax is worth retrying with the next spelling;
        // anything else is a real failure and retrying would just repeat it.
        if (!/Unrecognized|Invalid input/i.test(errLine)) break;
      }

      throw new Error(/Unrecognized|Invalid input/i.test(lastError || '')
        ? `Switch did not accept any known PoE command for ${iface} — it may not be a PoE port: ${lastError}`
        : `Switch rejected command: ${lastError}`);
    });

    if (enabled) {
      this.stats.poeEnabled = (this.stats.poeEnabled || 0) + 1;
      this._clearDeadman(key);
      this.intents.delete(key);
    } else {
      this.stats.poeDisabled = (this.stats.poeDisabled || 0) + 1;
      const now = Date.now();
      const intent = {
        profileId, port: n, kind: 'poe', reason,
        disabledAt: now,
        revertAt: holdMs > 0 ? now + holdMs : null,
        holdMs,
      };
      this.intents.set(key, intent);
      if (holdMs > 0) this._armDeadman(key, intent.revertAt);
      else console.warn(`[Switch] ${key} PoE off INDEFINITELY — the device stays unpowered until re-enabled`);
    }
    await this.saveIntents();

    this._patchSnapshot(profileId, n, {
      poe: enabled ? 'enabled' : 'disabled',
      poeHeld: !enabled,
      poeRevertAt: enabled ? null : (this.intents.get(key) || {}).revertAt || null,
      // A port with PoE off draws nothing, and the stale figure would otherwise
      // sit next to the "no power" badge contradicting it.
      ...(enabled ? {} : { poePowerMw: 0, poeOper: 'off', poeDenied: false }),
    });

    const payload = {
      profileId, port: n, iface, kind: 'poe',
      poe: enabled ? 'enabled' : 'disabled',
      reason, holdMs,
      revertAt: enabled ? null : (this.intents.get(key) || {}).revertAt || null,
      timestamp: Date.now(),
    };
    this._recordEvent(profileId, {
      kind: 'poe', port: n, action: enabled ? 'enable' : 'disable',
      reason, holdMs: enabled ? null : holdMs,
    });
    this.emit('poe-change', payload);
    console.log(`[Switch] ${profileId}:${n} PoE ${enabled ? 'ON' : 'OFF'}` +
      (reason ? ` (${reason})` : '') +
      (!enabled && holdMs > 0 ? ` — auto-revert in ${Math.round(holdMs / 1000)}s` : ''));

    return payload;
  }

  /**
   * Read a port's state back off the switch.
   *
   * admin: what we commanded — this is what verification checks.
   * oper:  whether there is link. A freshly re-enabled port whose controller is
   *        still booting reads admin up / oper down, which is CORRECT and must
   *        not be treated as a failure.
   */
  async verifyPort(profileId, port) {
    const profile = this.getProfile(profileId);
    const n = Number(port);
    const iface = `${profile.interfacePrefix}${n}`;

    const { transcript } = await this._enqueue(`status ${profileId}:${n}`, async () => ({
      transcript: await this._sshShell(profile, [
        ...this._enterLines(profile),
        `show interface ${iface}`
      ])
    }));

    const state = this._parseInterfaceState(transcript, iface);
    this.portState.set(`${profileId}:${n}`, { ...state, checkedAt: Date.now() });
    return { profileId, port: n, iface, ...state, raw: transcript };
  }

  // Permissive on purpose — firmware wording varies. Unrecognised output yields
  // 'unknown', never a guess, and the caller still gets the raw transcript.
  _parseInterfaceState(transcript, iface) {
    const text = transcript.replace(/\r/g, '');
    let admin = 'unknown';
    let oper = 'unknown';

    if (/administratively\s+down/i.test(text)) admin = 'down';
    else if (/admin(?:istrative)?\s+state[:\s]+(up|enabled)/i.test(text)) admin = 'up';
    else if (/admin(?:istrative)?\s+state[:\s]+(down|disabled)/i.test(text)) admin = 'down';

    const line = new RegExp(`${iface.replace(/\./g, '\\.')}\\s+is\\s+([\\w\\s]+?),\\s*line\\s+protocol\\s+is\\s+(\\w+)`, 'i');
    const m = text.match(line);
    if (m) {
      const ifState = m[1].trim().toLowerCase();
      if (/administratively down/.test(ifState)) admin = 'down';
      else if (/^up/.test(ifState)) { admin = 'up'; }
      else if (/^down/.test(ifState)) { if (admin === 'unknown') admin = 'up'; } // link down, not admin down
      oper = /up/i.test(m[2]) ? 'up' : 'down';
    }
    return { admin, oper };
  }

  async refreshProfile(profileId) {
    const profile = this.getProfile(profileId);
    const out = [];
    for (let p = 1; p <= profile.portCount; p++) {
      const cached = this.portState.get(`${profileId}:${p}`) || {};
      out.push({ port: p, admin: cached.admin || 'unknown', oper: cached.oper || 'unknown',
                 checkedAt: cached.checkedAt || null, denied: this.denyListFor(profile).has(p) });
    }
    return out;
  }

  /**
   * Run several show commands down ONE SSH session and split the results.
   *
   * This is where scan time went. Every _runShowFirst call opened a fresh
   * connection: TCP, key exchange, auth, shell, `enable`, `terminal length 0`,
   * then the command, then teardown. A full scan issued six of those back to
   * back — most of the wait was handshakes, not the switch answering.
   *
   * The shell echoes each command before its output, so the transcript can be
   * split on those echoes in order.
   */
  async _runShowBatch(profile, commands) {
    const transcript = await this._sshShell(profile, [
      ...this._enterLines(profile),
      ...commands,
    ]);

    const text = transcript.replace(/\r/g, '');
    const out = {};
    // Find where each command was echoed, in the order they were sent.
    const marks = [];
    let cursor = 0;
    for (const cmd of commands) {
      const at = text.indexOf(cmd, cursor);
      if (at < 0) { marks.push(null); continue; }
      marks.push({ cmd, start: at + cmd.length });
      cursor = at + cmd.length;
    }

    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (!m) { out[commands[i]] = ''; continue; }
      const nextStart = marks.slice(i + 1).find(Boolean);
      const raw = text.slice(m.start, nextStart ? nextStart.start - nextStart.cmd.length : undefined);

      const body = raw.split('\n').filter(l => {
        const t = l.trim();
        if (!t || t.startsWith('%')) return false;
        return !/^[\w.\-@()/]+[>#]\s*$/.test(t);
      }).join('\n');

      out[commands[i]] = body.trim();
    }
    return out;
  }

  /** Run the first of several candidate commands that returns anything.
   *  Firmware differs across the GS950/GS970 range, so each capability is
   *  attempted under every spelling the desktop tool learned to try. */
  async _runShowFirst(profile, commands) {
    for (const cmd of commands) {
      const transcript = await this._sshShell(profile, [...this._enterLines(profile), cmd]);
      const body = transcript
        .split('\n')
        // Drop firmware rejections ('%'), the echoed command, and prompt-only lines.
        .filter(l => {
          const t = l.trim();
          if (!t || t.startsWith('%')) return false;
          if (t === cmd || t.endsWith(cmd)) return false;
          return !/^[\w.\-@()/]+[>#]\s*$/.test(t);
        })
        .join('\n');
      // Any real content wins. An earlier length threshold here silently ate
      // short-but-valid replies like "Uptime: 3 minutes".
      if (body.trim()) return body;
    }
    return '';
  }

  /**
   * Full operator-console view of a profile: per-port state, device labels,
   * interface counters, and switch uptime.
   *
   * Distinct from verifyPort, which reads one port to confirm a write. This is
   * the "what's out there" read and it is deliberately NOT run automatically —
   * it costs several SSH round trips.
   *
   * Five states, not three. 'disconnected' (admin up, link down) is separated
   * from 'up' because a scenario run against an empty port would otherwise look
   * like a clean pass.
   */
  async getPortSnapshot(profileId) {
    const profile = this.getProfile(profileId);
    const prefix = profile.interfacePrefix;
    const count = profile.portCount;
    const deny = this.denyListFor(profile);

    const raw = await this._enqueue(`snapshot ${profileId}`, async () => {
      // One session for the common case. Each capability's first-choice command
      // is sent together; only the ones that come back empty fall back to the
      // alternate spellings, and only then at the cost of another connection.
      const FIRST = {
        brief: 'show interface brief',
        lldp: 'show lldp neighbors detail',
        mac: 'show mac address-table',
        iface: 'show interface',
        poe: 'show power-inline',
        arp: 'show arp',
        sys: 'show system',
      };
      const batch = await this._runShowBatch(profile, Object.values(FIRST));
      const result = {};
      for (const [key, cmd] of Object.entries(FIRST)) result[key] = batch[cmd] || '';

      const FALLBACKS = {
        lldp: ['show lldp neighbor detail', 'show lldp neighbors'],
        mac: ['show mac-address-table', 'show bridge address-table'],
        iface: ['show interfaces', 'show interface counters'],
        poe: ['show power inline', 'show power-inline interface'],
        arp: ['show ip arp'],
        sys: ['show version'],
      };
      for (const [key, alts] of Object.entries(FALLBACKS)) {
        if (result[key]) continue;
        result[key] = await this._runShowFirst(profile, alts);
      }
      return result;
    });

    const statuses = AP.parseBriefStatus(raw.brief, prefix, count);
    const neighbours = AP.parseLldpNeighbors(raw.lldp, prefix, count);
    const macs = AP.parseMacTable(raw.mac, prefix, count);
    const metrics = AP.parseInterfaceMetrics(raw.iface, prefix, count);
    const poeStates = AP.parsePoeStatus(raw.poe, prefix, count);
    const poeDetail = AP.parsePoeInterfaces(raw.poe, prefix, count);
    const poeBudget = AP.parsePoeBudget(raw.poe);
    const poeCapable = Object.keys(poeStates).length > 0;
    const arp = AP.parseArpTable(raw.arp, prefix, count);
    const aliases = profile.portAliases || {};
    const uptimeSeconds = AP.parseUptimeSeconds(raw.sys);

    const prev = this.snapshots.get(profileId);
    const now = Date.now();
    const elapsedSec = prev ? Math.max(1, (now - prev.at) / 1000) : 0;

    const ports = [];
    for (let p = 1; p <= count; p++) {
      const status = statuses[p] || 'unknown';
      const nbr = neighbours[p] || {};
      const met = metrics[p] || {};
      const held = this.intents.get(`${profileId}:${p}`) || null;
      const poeHeld = this.intents.get(`${profileId}:${p}:poe`) || null;

      // Throughput is derived from the counter delta between refreshes — the
      // switch reports totals, not rates. Counter resets (reboot, wrap) would
      // show as negative, so those are clamped to zero rather than shown wrong.
      let rxBps = 0, txBps = 0;
      if (prev && elapsedSec > 0) {
        const before = prev.byPort[p];
        if (before) {
          rxBps = Math.max(0, ((met.inOctets || 0) - (before.inOctets || 0)) * 8 / elapsedSec);
          txBps = Math.max(0, ((met.outOctets || 0) - (before.outOctets || 0)) * 8 / elapsedSec);
        }
      }

      ports.push({
        port: p,
        status,
        admin: status === 'down' ? 'down' : status === 'unknown' ? 'unknown' : 'up',
        oper: status === 'up' ? 'up' : status === 'disconnected' ? 'down' : 'unknown',
        denied: deny.has(p),
        held: !!held,
        heldReason: held ? held.reason : null,
        revertAt: held ? held.revertAt : null,
        // 'unknown' where the switch reports no admin state for this port —
        // distinct from 'disabled', which means somebody turned it off.
        poe: poeStates[p] || 'unknown',
        poeHeld: !!poeHeld,
        poeRevertAt: poeHeld ? poeHeld.revertAt : null,
        poeOper: (poeDetail[p] || {}).oper || 'unknown',
        poePowerMw: (poeDetail[p] || {}).powerMw || 0,
        poeClass: (poeDetail[p] || {}).class ?? null,
        poeMaxMw: (poeDetail[p] || {}).maxMw ?? null,
        poePriority: (poeDetail[p] || {}).priority || null,
        // The switch refused power here because it is over budget. Looks like a
        // dead device but isn't, and it makes PoE test results unreliable.
        poeDenied: !!(poeDetail[p] || {}).denied,
        // Prefer the port's ARP entry; fall back to looking up its learned MAC.
        ip: arp.byPort[p] || arp.byMac[AP.normaliseMac(macs[p] || '')] || '',
        alias: aliases[String(p)] || '',
        // LLDP hostname is the good label; a learned MAC is only a fallback.
        label: nbr.hostname || macs[p] || '',
        labelSource: nbr.hostname ? 'lldp' : (macs[p] ? 'mac' : ''),
        mac: macs[p] || nbr.chassisId || '',
        description: nbr.description || '',
        remotePort: nbr.remotePort || '',
        speedMbps: met.speedMbps || 0,
        duplex: met.duplex || 'Unknown',
        inOctets: met.inOctets || 0,
        outOctets: met.outOctets || 0,
        inErrors: met.inErrors || 0,
        outErrors: met.outErrors || 0,
        inDiscards: met.inDiscards || 0,
        outDiscards: met.outDiscards || 0,
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
      });

      this.portState.set(`${profileId}:${p}`, {
        admin: ports[p - 1].admin, oper: ports[p - 1].oper, checkedAt: now,
      });
    }

    // Uptime going BACKWARDS means the switch rebooted. Because port changes are
    // never written to startup-config, a reboot silently re-enables everything —
    // any hold that spans it is void, and the test result with it.
    let rebootSuspected = false;
    if (prev && uptimeSeconds > 0 && prev.uptimeSeconds > 0 && uptimeSeconds < prev.uptimeSeconds) {
      rebootSuspected = true;
      console.warn(`[Switch] ${profileId}: uptime went backwards (${prev.uptimeSeconds}s → ${uptimeSeconds}s) — ` +
        'the switch rebooted. Ports were silently re-enabled; any in-flight scenario is void.');
      this._recordEvent(profileId, { kind: 'reboot', port: null, action: 'switch rebooted', reason: null });
      this.emit('switch-rebooted', { profileId, previousUptime: prev.uptimeSeconds, uptimeSeconds });
    }

    const snapshot = {
      profileId, at: now, uptimeSeconds, rebootSuspected, poeCapable,
      poeBudget,
      arpCount: Object.keys(arp.byMac).length,
      lldpCount: Object.values(neighbours).filter(n => n.hostname).length,
      byPort: Object.fromEntries(ports.map(p => [p.port, p])),
      ports,
    };
    this.snapshots.set(profileId, snapshot);
    this.emit('snapshot', { profileId, at: now, uptimeSeconds, rebootSuspected });
    return snapshot;
  }

  /**
   * Patch the cached snapshot after a change.
   *
   * Without this the tile keeps showing the state from the last full scan: cut
   * PoE and the port is correctly marked held, but still reports the old power
   * reading until someone rescans. Two sources of truth, one of them wrong.
   */
  _patchSnapshot(profileId, port, fields) {
    const snap = this.snapshots.get(profileId);
    if (!snap) return;
    const entry = snap.byPort[port];
    if (entry) Object.assign(entry, fields);
    const inList = snap.ports.find(x => x.port === port);
    if (inList) Object.assign(inList, fields);
  }

  getCachedSnapshot(profileId) {
    return this.snapshots.get(profileId) || null;
  }

  /**
   * Cheap state-only refresh: link status and PoE, nothing else.
   *
   * getPortSnapshot costs five or six SSH round trips because it also reads
   * LLDP, the MAC table, ARP and counters — far too much to run every few
   * seconds. Device labels and IPs change rarely, so a live poll only needs the
   * two things that actually move, and merges them into the cached snapshot.
   */
  async getLiveState(profileId) {
    const profile = this.getProfile(profileId);
    const prefix = profile.interfacePrefix;
    const count = profile.portCount;

    const raw = await this._enqueue(`live ${profileId}`, async () => {
      // Both reads in one session — two connections every 15 seconds would be
      // most of the cost of polling.
      const batch = await this._runShowBatch(profile, ['show interface brief', 'show power-inline']);
      let poe = batch['show power-inline'] || '';
      if (!poe) poe = await this._runShowFirst(profile, ['show power inline']);
      return { brief: batch['show interface brief'] || '', poe };
    });

    const statuses = AP.parseBriefStatus(raw.brief, prefix, count);
    const poeStates = AP.parsePoeStatus(raw.poe, prefix, count);
    const poeDetail = AP.parsePoeInterfaces(raw.poe, prefix, count);
    const poeBudget = AP.parsePoeBudget(raw.poe);

    const now = Date.now();
    const ports = [];
    for (let p = 1; p <= count; p++) {
      const status = statuses[p] || 'unknown';
      const d = poeDetail[p] || {};
      const fields = {
        status,
        admin: status === 'down' ? 'down' : status === 'unknown' ? 'unknown' : 'up',
        oper: status === 'up' ? 'up' : status === 'disconnected' ? 'down' : 'unknown',
        poe: poeStates[p] || 'unknown',
        poeOper: d.oper || 'unknown',
        poePowerMw: d.powerMw || 0,
        poeDenied: !!d.denied,
        held: this.intents.has(`${profileId}:${p}`),
        poeHeld: this.intents.has(`${profileId}:${p}:poe`),
      };
      this._patchSnapshot(profileId, p, fields);
      this.portState.set(`${profileId}:${p}`, { ...fields, checkedAt: now });
      ports.push({ port: p, ...fields });
    }

    const snap = this.snapshots.get(profileId);
    if (snap) {
      snap.poeBudget = poeBudget;
      snap.at = now;
    }

    return { profileId, at: now, ports, poeBudget };
  }

  // ── event history ────────────────────────────────────────────────────────
  //
  // Every state change Aether makes, kept per profile. This is what turns the
  // traffic chart from "the line went flat" into "Aether disabled this at
  // 14:32 for CLC-004" — the difference between a graph and a test artifact.

  _recordEvent(profileId, event) {
    if (!this.events.has(profileId)) this.events.set(profileId, []);
    const list = this.events.get(profileId);
    list.push({ at: Date.now(), ...event });
    // Bounded so a long-running rig cannot grow this without limit.
    if (list.length > 500) list.splice(0, list.length - 500);
  }

  getEvents(profileId, sinceMs = null) {
    const list = this.events.get(profileId) || [];
    if (!sinceMs) return list.slice();
    return list.filter(e => e.at >= sinceMs);
  }

  /** Traffic for every port at once, for tile sparklines. */
  getAllTraffic(profileId, maxPoints = 40) {
    const profile = this.getProfile(profileId);
    const out = {};
    for (let p = 1; p <= profile.portCount; p++) {
      const t = this.getTraffic(profileId, p);
      // Sparklines only need the recent tail; sending the full window for every
      // port would be a large payload for a few pixels of line.
      out[p] = t.points.slice(-maxPoints);
    }
    return { profileId, byPort: out, monitoring: this.isMonitoring(profileId) };
  }

  // ── traffic history ──────────────────────────────────────────────────────
  //
  // The switch reports cumulative octet counters, not rates, so a graph needs
  // repeated samples. This runs ONE `show interface` per tick for the whole
  // switch rather than per port, and goes through the same serialised queue as
  // everything else so it can never collide with a port command.
  //
  // Opt-in and off by default: it is continuous SSH load on a lab switch, and
  // it is only worth paying for while someone is watching a graph or a
  // scenario is running.

  /** @param intervalMs sampling period; floored at 10s to stay off the switch's back */
  async startMonitor(profileId, intervalMs = 30000) {
    const profile = this.getProfile(profileId);
    this.stopMonitor(profileId);

    const period = Math.max(10000, Number(intervalMs) || 30000);
    if (!this.traffic) this.traffic = new Map();
    if (!this.monitors) this.monitors = new Map();
    if (!this.traffic.has(profileId)) this.traffic.set(profileId, []);

    const tick = async () => {
      try {
        const text = await this._enqueue(`traffic ${profileId}`, () =>
          this._runShowFirst(profile, ['show interface', 'show interfaces']));
        const metrics = AP.parseInterfaceMetrics(text, profile.interfacePrefix, profile.portCount);

        const sample = { at: Date.now(), byPort: {} };
        for (const [port, m] of Object.entries(metrics)) {
          sample.byPort[port] = { inOctets: m.inOctets || 0, outOctets: m.outOctets || 0 };
        }

        const series = this.traffic.get(profileId);
        series.push(sample);
        // Keep a bounded window — 720 samples is 6 hours at 30s, and prevents a
        // monitor left running for days from growing without limit.
        if (series.length > 720) series.splice(0, series.length - 720);

        this.emit('traffic-sample', { profileId, at: sample.at });
      } catch (err) {
        // A failed poll is expected during a disconnect test. Log once per run
        // rather than every tick, and keep sampling.
        if (!this._trafficWarned || this._trafficWarned !== profileId) {
          console.warn(`[Switch] Traffic poll for ${profileId} failed: ${err.message}`);
          this._trafficWarned = profileId;
        }
      }
    };

    const handle = setInterval(tick, period);
    if (handle.unref) handle.unref();
    this.monitors.set(profileId, { handle, period, startedAt: Date.now() });
    tick();   // first sample immediately so the graph isn't blank for 30s

    console.log(`[Switch] Traffic monitor started for ${profileId} every ${period / 1000}s`);
    return { profileId, intervalMs: period };
  }

  stopMonitor(profileId) {
    if (!this.monitors) return { profileId, running: false };
    const m = this.monitors.get(profileId);
    if (m) {
      clearInterval(m.handle);
      this.monitors.delete(profileId);
      console.log(`[Switch] Traffic monitor stopped for ${profileId}`);
    }
    this._trafficWarned = null;
    return { profileId, running: false };
  }

  isMonitoring(profileId) {
    return !!(this.monitors && this.monitors.has(profileId));
  }

  /**
   * Rates for one port, derived from consecutive counter samples.
   *
   * Two things are deliberately NOT smoothed over: a counter that goes
   * backwards (switch reboot, or the counter wrapping) yields a gap rather than
   * a negative or an absurd spike, and a sample interval of zero is skipped.
   * A fake spike on a traffic graph is worse than a missing point, because it
   * looks like real activity.
   */
  getTraffic(profileId, port) {
    const series = (this.traffic && this.traffic.get(profileId)) || [];
    const key = String(port);
    const points = [];

    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const cur = series[i];
      const a = prev.byPort[key];
      const b = cur.byPort[key];
      if (!a || !b) continue;

      const secs = (cur.at - prev.at) / 1000;
      if (secs <= 0) continue;

      const dIn = b.inOctets - a.inOctets;
      const dOut = b.outOctets - a.outOctets;
      if (dIn < 0 || dOut < 0) {
        points.push({ at: cur.at, rxBps: null, txBps: null, gap: true });
        continue;
      }
      points.push({
        at: cur.at,
        rxBps: Math.round((dIn * 8) / secs),
        txBps: Math.round((dOut * 8) / secs),
      });
    }

    return {
      profileId, port: Number(port), points,
      monitoring: this.isMonitoring(profileId),
      intervalMs: this.monitors && this.monitors.get(profileId)
        ? this.monitors.get(profileId).period : null,
      samples: series.length,
    };
  }

  // ── intents + dead-man ───────────────────────────────────────────────────

  async loadIntents() {
    try {
      const raw = await fs.readFile(this.intentsPath, 'utf8');
      const arr = JSON.parse(raw);
      this.intents = new Map(arr.map(i => [`${i.profileId}:${i.port}`, i]));
      console.log(`[Switch] Loaded ${this.intents.size} outstanding port intent(s)`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[Switch] Error loading intents:', err.message);
      this.intents = new Map();
    }
  }

  async saveIntents() {
    try {
      await fs.writeFile(this.intentsPath,
        JSON.stringify(Array.from(this.intents.values()), null, 2));
    } catch (err) {
      console.error('[Switch] Error saving intents:', err.message);
    }
  }

  _clearDeadman(key) {
    const handle = this.deadman.get(key);
    if (handle) clearTimeout(handle);
    this.deadman.delete(key);
  }

  _armDeadman(key, revertAt) {
    this._clearDeadman(key);
    const delay = Math.max(0, revertAt - Date.now());

    // setTimeout tops out around 24.8 days; chain for anything longer.
    const MAX = 2 ** 31 - 1;
    const wait = Math.min(delay, MAX);
    const handle = setTimeout(() => {
      if (Date.now() < revertAt) return this._armDeadman(key, revertAt);
      const [profileId, portStr, kind] = key.split(':');
      const port = Number(portStr);
      const isPoe = kind === 'poe';
      console.warn(`[Switch] Dead-man timer expired for ${key} — restoring ${isPoe ? 'PoE' : 'port'}`);
      this.stats.deadmanReverts++;
      // Restore the same thing that was taken away. Calling enablePort on a PoE
      // hold would issue `no shutdown` on a port that was never shut down, and
      // leave the device unpowered indefinitely.
      const restore = isPoe
        ? this.setPoe(profileId, port, true, { reason: 'dead-man auto-revert' })
        : this.enablePort(profileId, port, { reason: 'dead-man auto-revert' });
      restore
        .then(() => this.emit('deadman-revert', { profileId, port, kind: isPoe ? 'poe' : 'link' }))
        .catch(err => console.error(`[Switch] Dead-man revert FAILED for ${key}:`, err.message));
    }, wait);
    if (handle.unref) handle.unref();
    this.deadman.set(key, handle);
  }

  /**
   * Reconcile persisted intent against real switch state.
   *
   * Run at startup. Aether must never resume trusting what it *meant* to do —
   * a reboot mid-scenario has to re-read the hardware. Three cases:
   *   expired intent      -> restore the port now
   *   live intent         -> re-arm the timer for the remaining time
   *   port down, no intent-> flag it; someone disabled it by hand or we lost state
   */
  async reconcile() {
    const repairs = [];
    for (const [key, intent] of Array.from(this.intents.entries())) {
      const { profileId, port } = intent;
      const isPoe = intent.kind === 'poe';

      // verifyPort reads the LINK admin state, which says nothing about PoE.
      // Reading it for a PoE intent would compare the wrong two things, so PoE
      // holds are reconciled on their timer alone and drift detection is skipped.
      let live = null;
      if (!isPoe) {
        try {
          live = await this.verifyPort(profileId, port);
        } catch (err) {
          console.error(`[Switch] Reconcile: cannot read ${key}: ${err.message}`);
          continue;
        }
      }

      const expired = intent.revertAt && Date.now() >= intent.revertAt;
      if (expired) {
        console.warn(`[Switch] Reconcile: ${key} hold expired while we were down — restoring`);
        try {
          if (isPoe) await this.setPoe(profileId, port, true, { reason: 'reconcile: expired hold' });
          else await this.enablePort(profileId, port, { reason: 'reconcile: expired hold' });
          this.stats.reconcileRepairs++;
          repairs.push({ key, action: 'restored', kind: isPoe ? 'poe' : 'link',
                         wasAdmin: live ? live.admin : null });
        } catch (err) {
          console.error(`[Switch] Reconcile: restore of ${key} FAILED:`, err.message);
        }
      } else if (intent.revertAt) {
        this._armDeadman(key, intent.revertAt);
        repairs.push({ key, action: 're-armed', revertAt: intent.revertAt });
      } else {
        // An indefinite hold has no timer to re-arm, but the intent is kept so
        // the port stays listed as deliberately down rather than looking like
        // an unexplained outage months later.
        repairs.push({ key, action: 'indefinite-hold-retained' });
      }

      if (live && live.admin === 'up' && !expired) {
        console.warn(`[Switch] Reconcile: ${key} was expected DOWN but reads admin up — ` +
          'switch may have rebooted (running-config is not saved). Scenario timing is suspect.');
        repairs.push({ key, action: 'drift-detected', expected: 'down', got: 'up' });
      }
    }
    if (repairs.length) this.emit('reconcile', { repairs });
    return repairs;
  }

  /** Panic button: restore every port we hold an intent for. */
  async revertAll(reason = 'manual revert-all') {
    const done = [];
    for (const intent of Array.from(this.intents.values())) {
      const isPoe = intent.kind === 'poe';
      try {
        if (isPoe) await this.setPoe(intent.profileId, intent.port, true, { reason });
        else await this.enablePort(intent.profileId, intent.port, { reason });
        done.push({ profileId: intent.profileId, port: intent.port, kind: isPoe ? 'poe' : 'link', ok: true });
      } catch (err) {
        done.push({ profileId: intent.profileId, port: intent.port, kind: isPoe ? 'poe' : 'link',
                    ok: false, error: err.message });
      }
    }
    return done;
  }

  // ── self-port detection ──────────────────────────────────────────────────
  //
  // Best effort: find this host's MAC, then look it up in the switch's MAC
  // address table. If it resolves, that port goes on the denylist permanently.
  // Failure here is non-fatal but noisy — it is the difference between a bad
  // scenario config costing you a test run and costing you a drive to the lab.

  async resolveSelfPort(profile) {
    const macs = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.internal || !a.mac || a.mac === '00:00:00:00:00:00') continue;
        if (a.family === 'IPv4') macs.push({ name, mac: a.mac.toLowerCase() });
      }
    }
    if (!macs.length) return null;

    const transcript = await this._enqueue(`mac-table ${profile.id}`, async () =>
      this._sshShell(profile, [...this._enterLines(profile), 'show mac address-table']));

    const norm = s => s.replace(/[^a-f0-9]/gi, '').toLowerCase();
    const wanted = new Set(macs.map(m => norm(m.mac)));
    const ifaceRe = new RegExp(`${profile.interfacePrefix.replace(/\./g, '\\.')}(\\d+)`);

    for (const line of transcript.replace(/\r/g, '').split('\n')) {
      const macMatch = line.match(/([0-9a-f]{4}[.\-:][0-9a-f]{4}[.\-:][0-9a-f]{4}|(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2})/i);
      if (!macMatch || !wanted.has(norm(macMatch[1]))) continue;
      const portMatch = line.match(ifaceRe);
      if (portMatch) return Number(portMatch[1]);
    }
    return null;
  }

  // ── status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      initialized: this.initialized,
      profiles: this.config.profiles.map(p => ({
        id: p.id, name: p.name, host: p.host,
        port: p.port || 22,
        username: p.username,
        vendor: p.vendor || 'allied',
        interfacePrefix: p.interfacePrefix,
        portCount: p.portCount,
        autoDetectSelfPort: p.autoDetectSelfPort !== false,
        credentialEnv: p.credentialEnv || null,
        // Never the password itself — only whether one is available.
        hasCredential: this.hasCredential(p.id),
        // What the user set, kept separate from the resolved list below so the
        // editor doesn't show the auto-detected self port as a saved value.
        configuredDenyPorts: Array.isArray(p.denyPorts) ? p.denyPorts : [],
        portAliases: p.portAliases || {},
        denyPorts: Array.from(this.denyListFor(p)).sort((a, b) => a - b),
        selfPort: this.resolvedSelfPort.get(p.id) || null
      })),
      heldPorts: Array.from(this.intents.values()).map(i => ({
        ...i,
        msRemaining: i.revertAt ? Math.max(0, i.revertAt - Date.now()) : null
      })),
      queueLength: this.queue.length,
      processing: this.processing,
      stats: this.stats
    };
  }
}

module.exports = SwitchManager;
