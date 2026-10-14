// backend/lib/zoneFastRead.js — AETHER_ZONE_FAST (Update 73)
//
// All 8 EOL zone voltages in ONE bus call instead of 8. The ioplus CLI has no
// all-channels ADC read (`adcrd` needs a channel), so this reads the board's
// ADC millivolt registers directly: 8 x uint16 LE at 0x18 (I2C_MEM_ADC_VAL_MV_ADD
// in Sequent's ioplus-rpi src/ioplus.h), address 0x28 + stack, bus 1, using the
// same write-register-then-read the CLI uses.
//
// Safety:
//   - every read runs through lib/i2cBus (same cross-process lock + 100 ms settle
//     gap as every ioplus call), so it never overlaps another bus call;
//   - a method is only used after it VERIFIES: all 8 channels must match the
//     normal one-channel CLI reads taken just before and after it;
//   - re-checked against one CLI read every few minutes; a mismatch twice in a row,
//     or 3 failed reads in a row, turns it off and the page goes back to CLI scans.
//     After failures it stays off for 30 min (and is remembered across restarts).
// Methods, tried in order: i2ctransfer (i2c-tools), then a small node helper
// using the i2c-bus module (tools/ioplus-adc-bulk.js). ZONE_FAST=0 disables it.

const fs = require('fs');
const path = require('path');

const TOL_MV = 40;                 // allowed difference vs a CLI read
const RECHECK_MS = 5 * 60 * 1000;  // spot-check one channel this often
const OFF_AFTER_FAIL_MS = 30 * 60 * 1000;
const STATE_FILE = path.join(__dirname, '..', 'data', 'zone-fast.json');

// `timeout 2` (coreutils) kills a hung i2ctransfer itself, so a stuck read can't
// outlive the gate's own timeout and overlap the next call.
const I2CT_SCRIPT = 'T="$1"; B="$2"; A="$3"; TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout 2"; ' +
  'r() { $TO "$T" -y "$B" w1@"$A" 0x18 >/dev/null && $TO "$T" -y "$B" r16@"$A"; }; ' +
  'a=$(r) || exit 1; c=$(r) || exit 1; echo "$a"; echo "$c"';

function findFile(cands) { for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) { /* next */ } } return null; }
function words(line) {
  const bytes = String(line || '').trim().split(/\s+/).filter(Boolean).map(x => parseInt(x, 16));
  if (bytes.length !== 16 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return Array.from({ length: 8 }, (_, i) => bytes[2 * i] | (bytes[2 * i + 1] << 8));
}
/** Parse i2ctransfer's two 16-byte reads -> {mv, stable} (pure; exported for tests). */
function parseI2ctransfer(out) {
  const lines = String(out || '').trim().split(/\n+/).filter(l => /0x/i.test(l));
  if (lines.length < 2) return null;
  const a = words(lines[lines.length - 2]), c = words(lines[lines.length - 1]);
  if (!a || !c) return null;
  return { mv: c, stable: c.map((v, i) => (v & 0xfffc) === (a[i] & 0xfffc) || Math.abs(v - a[i]) <= 20) };
}
/** Do bulk readings match the CLI readings taken before and after? Channels that moved
 *  between the two CLI reads (noisy / changing) are not judged; at least 4 must be. (pure; exported for tests) */
function matchesCli(bulk, before, after, tol = TOL_MV) {
  if (!Array.isArray(bulk) || bulk.length !== 8) return false;
  let judged = 0;
  for (let i = 0; i < 8; i++) {
    if (Math.abs(before[i] - after[i]) > tol) continue;          // input moving: can't judge this channel
    judged++;
    const lo = Math.min(before[i], after[i]) - tol, hi = Math.max(before[i], after[i]) + tol;
    if (!Number.isFinite(bulk[i]) || bulk[i] < lo || bulk[i] > hi) return false;
  }
  return judged >= 4;
}
const isLockBusy = (e) => /lock busy/i.test(String(e && e.message || e));

class ZoneFastRead {
  /**
   * @param {object} o
   * @param {{run: Function}} o.i2cBus   backend/lib/i2cBus
   * @param {(ch: number) => Promise<number>} o.readCliMv  one channel (1-8) via the ioplus CLI, in mV
   */
  constructor({ i2cBus, readCliMv, stack = 0, busNo = 1, log = console }) {
    this.bus = i2cBus; this.readCliMv = readCliMv; this.stack = stack; this.busNo = busNo; this.log = log;
    this.enabled = process.env.ZONE_FAST !== '0';
    this.method = null; this.verifiedAt = null; this.lastCheckAt = 0; this.checkCh = 0;
    this.fails = 0; this.mismatches = 0; this.offUntil = 0; this.lastError = null; this.lastTryAt = 0; this.reads = 0;
    this.verifyFails = 0; this.nullStreak = new Array(8).fill(0);
    try { const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (st && st.offUntil > Date.now()) { this.offUntil = st.offUntil; this.lastError = st.reason || null; } } catch (_) { /* none */ }
  }

  _save() { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ offUntil: this.offUntil, reason: this.lastError, at: Date.now() })); } catch (_) { /* best effort */ } }
  _turnOff(reason) {
    this.log.warn(`[ZoneFast] off for ${OFF_AFTER_FAIL_MS / 60000} min: ${reason} (EOL zones go back to one-channel scans)`);
    this.method = null; this.verifiedAt = null; this.lastError = reason; this.offUntil = Date.now() + OFF_AFTER_FAIL_MS; this.fails = 0; this.mismatches = 0;
    this._save();
  }

  methods() {
    const out = [];
    const i2ct = findFile(['/usr/sbin/i2ctransfer', '/usr/bin/i2ctransfer', '/sbin/i2ctransfer', '/bin/i2ctransfer']);
    if (i2ct) out.push({ name: 'i2ctransfer', program: '/bin/sh', args: ['-c', I2CT_SCRIPT, 'aether-adc', i2ct, String(this.busNo), '0x' + (0x28 + this.stack).toString(16)], parse: parseI2ctransfer });
    const helper = path.join(__dirname, '..', 'tools', 'ioplus-adc-bulk.js');
    if (fs.existsSync(helper)) out.push({ name: 'i2c-bus', program: process.execPath, args: [helper, String(this.stack), String(this.busNo)], parse: (s) => { try { const j = JSON.parse(String(s).trim().split('\n').pop()); return Array.isArray(j.mv) && j.mv.length === 8 && Array.isArray(j.stable) && j.stable.length === 8 ? j : null; } catch (_) { return null; } } });
    return out;
  }

  async _bulk(m) {
    const out = await this.bus.run(m.args, { program: m.program, source: 'zone-fast', label: `adc bulk 0x18 x16 (${m.name})`, timeoutMs: 3000 });
    const r = m.parse(out);
    if (!r) throw new Error(`unexpected ${m.name} output: ${String(out).slice(0, 80)}`);
    return r;
  }
  async _cliAll() { const mv = []; for (let ch = 1; ch <= 8; ch++) mv.push(await this.readCliMv(ch)); return mv; }

  /** True when a verified one-call method is ready (verifies one on first use; retries every 2 min). */
  async ready() {
    if (!this.enabled || Date.now() < this.offUntil) return false;
    if (this.method) return true;
    // retry backoff after failed verifications: 2, 4, 8 ... up to 60 min
    const backoff = Math.min(60, 2 * 2 ** Math.max(0, this.verifyFails - 1)) * 60000;
    if (this.verifyFails && Date.now() - this.lastTryAt < backoff) return false;
    this.lastTryAt = Date.now();
    const methods = this.methods();
    if (!methods.length) { this.lastError = 'no i2ctransfer and no i2c-bus helper'; this.verifyFails++; return false; }
    for (const m of methods) {
      let before;
      try { before = await this._cliAll(); }
      catch (e) { this.lastError = `CLI reads failed: ${e.message}`; this.verifyFails++; return false; }   // board busy/unwell: try later
      try {
        const bulk = await this._bulk(m);
        const after = await this._cliAll();
        if (matchesCli(bulk.mv, before, after)) {
          this.method = m; this.verifiedAt = Date.now(); this.lastCheckAt = Date.now(); this.lastError = null; this.verifyFails = 0;
          this.log.log(`[ZoneFast] one-call EOL zone read verified (${m.name}); it matches the CLI`);
          return true;
        }
        this.lastError = `${m.name}: readings did not match the CLI (bulk ${bulk.mv.join(',')} vs ${before.join(',')})`;
        this.log.warn(`[ZoneFast] ${this.lastError}`);
      } catch (e) {
        this.lastError = `${m.name}: ${e.message}`;
        this.log.warn(`[ZoneFast] ${this.lastError}`);
        // a bulk read that timed out may have upset the board: don't try again for a while (remembered across restarts)
        if (/timeout/i.test(e.message)) { this._turnOff(`${m.name} timed out during verification`); return false; }
      }
    }
    if (++this.verifyFails >= 4) this._turnOff(`no one-call method verified after ${this.verifyFails} tries: ${this.lastError}`);
    return false;
  }

  /** Read all 8 zones (mV; null where the two reads disagreed). Throws if not ready. */
  async read() {
    if (!this.method) throw new Error('not ready');
    let r;
    try { r = await this._bulk(this.method); this.fails = 0; this.reads++; }
    catch (e) {
      this.lastError = e.message;
      if (!isLockBusy(e) && ++this.fails >= 3) this._turnOff(`3 failed reads: ${e.message}`);   // another process holding the lock is not a fault
      throw e;
    }
    // A channel whose two reads disagreed is skipped once; if it keeps moving, take the latest value.
    const mv = r.mv.map((v, i) => {
      if (r.stable[i]) { this.nullStreak[i] = 0; return v; }
      return ++this.nullStreak[i] >= 2 ? v : null;
    });
    if (this.mismatches > 0 || Date.now() - this.lastCheckAt > RECHECK_MS) {   // spot-check one channel against the CLI (again next tick after a mismatch)
      this.lastCheckAt = Date.now();
      const ch = this.checkCh;
      try {
        const cli = await this.readCliMv(ch + 1);
        const again = (await this._bulk(this.method)).mv[ch];
        const ok = Math.abs(again - cli) <= TOL_MV || (r.mv[ch] !== null && Math.abs(r.mv[ch] - cli) <= TOL_MV);
        if (ok) { this.mismatches = 0; this.checkCh = (ch + 1) % 8; }
        else {
          this.checkCh = ch;                                      // re-check the same channel next tick
          if (++this.mismatches >= 2) { this._turnOff(`ADC ${ch + 1} bulk ${again} mV vs CLI ${cli} mV`); throw new Error('fast read turned off'); }
        }
      } catch (e) { if (!this.method) throw e; /* a failed spot check is not a mismatch */ }
    }
    return mv;
  }

  status() {
    return { enabled: this.enabled, method: this.method ? this.method.name : null, verifiedAt: this.verifiedAt, reads: this.reads,
      offUntil: this.offUntil > Date.now() ? this.offUntil : null, lastError: this.lastError };
  }
}

module.exports = { ZoneFastRead, parseI2ctransfer, matchesCli };
