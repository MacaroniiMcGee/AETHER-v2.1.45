#!/usr/bin/env python3
"""
Fix-up patch for BaseDevice.js — the previous install-tamper-powerfail.py
hit anchor misses on this file but successfully patched the other two files.
This script only patches BaseDevice.js with literal anchors taken from the
actual file content (we missed a comment line in _handleLStat).

Idempotent — safe to re-run.
"""
from pathlib import Path
import sys

path = Path.home() / 'Desktop/Aether/M1.2.2/backend/osdp/devices/BaseDevice.js'
if not path.exists():
    print(f"✗ NOT FOUND: {path}")
    sys.exit(1)

content = path.read_text()
original = content
backup = path.with_suffix('.js.bak-tamper2')

if 'setTamper' in content and 'tamperActive' in content:
    print("✓ BaseDevice.js already has tamper support — nothing to do")
    sys.exit(0)

applied = []

# ── A. Add tamper/powerFail state fields right after this.lastReplyAt ────
# Robust to whitespace: find 'this.lastReplyAt' anywhere, insert after its line.
idx = content.find('this.lastReplyAt')
if idx < 0:
    print("✗ Could not find this.lastReplyAt in constructor")
    sys.exit(2)
eol = content.find('\n', idx)
if eol < 0:
    print("✗ Could not find end of line after this.lastReplyAt")
    sys.exit(2)

new_state = """

    // Local status (tamper + power-fail) — surfaced via LSTATR reply bytes.
    // Toggle via setTamper(bool) / setPowerFail(bool). IC2 sees the change
    // on its next LSTAT poll.
    this.tamperActive = false;
    this.powerFailActive = false;
    this.pendingLocalStatusChange = false;"""
content = content[:eol] + new_state + content[eol:]
applied.append("constructor: tamperActive / powerFailActive / pendingLocalStatusChange added")

# ── B. Replace _handleLStat — now using exact shape from the file ────────
old_lstat = """  _handleLStat() {
    // Tamper + Power status. We're not tampered, power is good.
    return this._reply(REPLY.LSTATR, Buffer.from([0x00, 0x00]));
  }"""
new_lstat = """  _handleLStat() {
    // Tamper + Power-Fail status — sourced from instance fields.
    // Set via setTamper() / setPowerFail() on this device.
    this.pendingLocalStatusChange = false;
    return this._reply(REPLY.LSTATR, Buffer.from([
      this.tamperActive    ? 0x01 : 0x00,
      this.powerFailActive ? 0x01 : 0x00,
    ]));
  }"""
if old_lstat not in content:
    print("✗ Could not find _handleLStat anchor (literal)")
    print("  current file's _handleLStat may have changed since diagnostic")
    sys.exit(2)
content = content.replace(old_lstat, new_lstat, 1)
applied.append("_handleLStat now reads tamper/powerFail bits")

# ── C. Insert setTamper / setPowerFail before the snapshot() method ──────
old_snap_header = """  // ─── Snapshot for UI ──────────────────────────────────────────────────
  snapshot() {"""
new_methods_before_snap = """  // ─── Tamper / Power-Fail ─────────────────────────────────────────────
  // Latching toggles. Setting these flips the bit returned in the next
  // LSTATR reply. IC2 picks up the change on its next LSTAT poll.
  setTamper(active) {
    const v = !!active;
    if (this.tamperActive === v) return false;
    this.tamperActive = v;
    this.pendingLocalStatusChange = true;
    if (typeof this.emit === 'function') this.emit('tamper-changed', v);
    return true;
  }

  setPowerFail(active) {
    const v = !!active;
    if (this.powerFailActive === v) return false;
    this.powerFailActive = v;
    this.pendingLocalStatusChange = true;
    if (typeof this.emit === 'function') this.emit('powerfail-changed', v);
    return true;
  }

  // ─── Snapshot for UI ──────────────────────────────────────────────────
  snapshot() {"""
if old_snap_header not in content:
    print("✗ Could not find snapshot() header anchor")
    sys.exit(2)
content = content.replace(old_snap_header, new_methods_before_snap, 1)
applied.append("setTamper() and setPowerFail() methods added")

# ── D. Extend snapshot return object with the new fields ─────────────────
old_ret = """      outputs:    this.numOutputs ? Array.from(this.outputs) : null,
    };"""
new_ret = """      outputs:    this.numOutputs ? Array.from(this.outputs) : null,
      tamperActive:    this.tamperActive,
      powerFailActive: this.powerFailActive,
    };"""
if old_ret not in content:
    print("✗ Could not find snapshot return anchor")
    sys.exit(2)
content = content.replace(old_ret, new_ret, 1)
applied.append("snapshot() exposes tamperActive / powerFailActive")

# ── Write ────────────────────────────────────────────────────────────────
if content == original:
    print("• No changes written.")
    sys.exit(0)

backup.write_text(original)
path.write_text(content)

print(f"✓ Backup: {backup.name}")
print()
print("Applied:")
for a in applied:
    print(f"  + {a}")
print()
print("Next steps:")
print("  1. sudo systemctl restart aether-backend")
print("  2. Re-apply emulator config")
print("  3. Test:")
print("     curl -X POST http://localhost:3001/api/emulator/device/11/tamper \\")
print("          -H 'Content-Type: application/json' -d '{\"active\":true}'")
print("     Expected: {\"success\":true,\"address\":11,\"tamperActive\":true,\"changed\":true}")s
