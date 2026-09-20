#!/usr/bin/env python3
"""
Aether Emulator — Tamper / Power-Fail support
──────────────────────────────────────────────
Adds the ability to trigger tamper and power-fail alarms on any emulated
OSDP board. IC2 sees these via the standard LSTATR (Local Status Report)
reply when it polls LSTAT.

Backend changes (auto-applied, idempotent, with .bak-tamper backups):

  BaseDevice.js
    + Adds tamperActive / powerFailActive / pendingLocalStatusChange state
    + Modifies _handleLStat() to read those bits instead of hardcoded 0x00
    + Adds setTamper(active) and setPowerFail(active) methods
    + Extends snapshot() to expose the new fields

  OSDPDeviceEmulator.js
    + Adds setTamper(address, active) and setPowerFail(address, active)
      methods alongside the existing setInput / setOutput
    + Extends the emit wrapper in _addDevice to broadcast tamper-changed
      and powerfail-changed events as emulator-device-update

  routes-emulator.js
    + POST /api/emulator/device/:address/tamper      body {active: bool}
    + POST /api/emulator/device/:address/powerfail   body {active: bool}

UI — paste-in JSX snippet printed at end. Place inside each device card
render block, just below the Outputs section. Buttons are LATCHING TOGGLES:
click to activate (red), click again to clear (gray).

Usage:
    python3 install-tamper-powerfail.py
"""
from pathlib import Path
import sys

BACKEND  = Path.home() / 'Desktop/Aether/M1.2.2/backend'
BASEDEV  = BACKEND / 'osdp/devices/BaseDevice.js'
EMUFILE  = BACKEND / 'osdp/OSDPDeviceEmulator.js'
ROUTES   = BACKEND / 'routes-emulator.js'


def find_balanced_close(content: str, open_pos: int) -> int:
    """Given index of an opening '{', return index just past the matching '}'."""
    depth = 0
    i = open_pos
    while i < len(content):
        if content[i] == '{':
            depth += 1
        elif content[i] == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


# ════════════════════════════════════════════════════════════════════════
def patch_basedevice() -> bool:
    print("\n[1/3] BaseDevice.js — state + LSTAT handler + methods + snapshot")
    if not BASEDEV.exists():
        print(f"  ✗ NOT FOUND: {BASEDEV}")
        return False
    content = BASEDEV.read_text()
    original = content

    if 'tamperActive' in content and 'setTamper' in content:
        print("  • Already installed — skipping")
        return True

    applied = []

    # ── A. Add state fields after lastReplyAt = 0 ──────────────────────────
    old_stats = """    this.pollCount     = 0;
    this.lastPollAt    = 0;
    this.lastCommand   = null;
    this.lastReplyAt   = 0;"""
    new_stats = old_stats + """

    // Local status (tamper + power-fail) — surfaced via LSTATR reply bytes.
    // Set via setTamper() / setPowerFail(); cleared the same way.
    this.tamperActive = false;
    this.powerFailActive = false;
    this.pendingLocalStatusChange = false;"""
    if old_stats not in content:
        print("  ✗ ANCHOR MISS: constructor stats block")
        return False
    content = content.replace(old_stats, new_stats, 1)
    applied.append("added tamper/powerFail state to constructor")

    # ── B. Replace the hardcoded _handleLStat ──────────────────────────────
    old_lstat = """  _handleLStat() {
    return this._reply(REPLY.LSTATR, Buffer.from([0x00, 0x00]));"""
    new_lstat = """  _handleLStat() {
    // Clear pending flag — IC2 just asked, we're answering with current state.
    this.pendingLocalStatusChange = false;
    return this._reply(REPLY.LSTATR, Buffer.from([
      this.tamperActive    ? 0x01 : 0x00,
      this.powerFailActive ? 0x01 : 0x00,
    ]));"""
    if old_lstat not in content:
        print("  ✗ ANCHOR MISS: _handleLStat method body")
        return False
    content = content.replace(old_lstat, new_lstat, 1)
    applied.append("_handleLStat now reads tamper/powerFail bits")

    # ── C. Insert setTamper / setPowerFail right before snapshot() ─────────
    old_snap_start = "  snapshot() {\n    return {"
    if old_snap_start not in content:
        print("  ✗ ANCHOR MISS: snapshot() start")
        return False
    new_methods_before_snap = """  // ── Tamper / Power-Fail ──────────────────────────────────────────────
  // Latching toggles. Setting these flips the bit returned in the next
  // LSTATR reply. IC2 will pick up the change on its next LSTAT poll.
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

  snapshot() {
    return {"""
    content = content.replace(old_snap_start, new_methods_before_snap, 1)
    applied.append("added setTamper() and setPowerFail() methods")

    # ── D. Add tamperActive/powerFailActive to snapshot return object ──────
    old_snap_tail = """      inputs:     this.numInputs  ? Array.from(this.inputs)  : null,
      outputs:    this.numOutputs ? Array.from(this.outputs) : null,
    };"""
    new_snap_tail = """      inputs:     this.numInputs  ? Array.from(this.inputs)  : null,
      outputs:    this.numOutputs ? Array.from(this.outputs) : null,
      tamperActive:    this.tamperActive,
      powerFailActive: this.powerFailActive,
    };"""
    if old_snap_tail not in content:
        print("  ✗ ANCHOR MISS: snapshot() return body")
        return False
    content = content.replace(old_snap_tail, new_snap_tail, 1)
    applied.append("snapshot() now exposes tamperActive / powerFailActive")

    if content == original:
        print("  • No changes written.")
        return True
    BASEDEV.with_suffix('.js.bak-tamper').write_text(original)
    BASEDEV.write_text(content)
    print(f"  ✓ Backup: BaseDevice.js.bak-tamper")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def patch_emulator() -> bool:
    print("\n[2/3] OSDPDeviceEmulator.js — setTamper/setPowerFail + emit wrapper")
    if not EMUFILE.exists():
        print(f"  ✗ NOT FOUND: {EMUFILE}")
        return False
    content = EMUFILE.read_text()
    original = content

    if 'setTamper(address' in content:
        print("  • Already installed — skipping")
        return True

    applied = []

    # ── A. Extend emit wrapper to broadcast new events ─────────────────────
    # Match the conditional that fires emulator-device-update on input/output change.
    candidates = [
        "if (evt === 'output-changed' || evt === 'input-changed')",
        "if (evt === \"output-changed\" || evt === \"input-changed\")",
    ]
    matched = None
    for c in candidates:
        if c in content:
            matched = c
            break
    if matched is None:
        print("  ⚠ Couldn't find emit-wrapper conditional — broadcasts may need manual touch")
    else:
        new_cond = "if (evt === 'output-changed' || evt === 'input-changed' || evt === 'tamper-changed' || evt === 'powerfail-changed')"
        content = content.replace(matched, new_cond, 1)
        applied.append("emit wrapper now broadcasts tamper/powerfail changes")

    # ── B. Insert setTamper / setPowerFail right after setInput ────────────
    # Find setInput method, walk to its closing brace, inject new methods there.
    sig = "setInput(address, idx, value) {"
    i = content.find(sig)
    if i < 0:
        print("  ✗ ANCHOR MISS: setInput method")
        return False
    open_brace = content.find('{', i + len(sig) - 1)
    end = find_balanced_close(content, open_brace)
    if end < 0:
        print("  ✗ couldn't balance setInput braces")
        return False

    new_methods = """

  /** Trigger or clear a tamper alarm on a specific emulated board. */
  setTamper(address, active) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.setTamper !== 'function') return { success: false, error: 'Device does not support tamper' };
    const changed = dev.setTamper(!!active);
    return { success: true, address, tamperActive: dev.tamperActive, changed };
  }

  /** Trigger or clear a power-fail alarm on a specific emulated board. */
  setPowerFail(address, active) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.setPowerFail !== 'function') return { success: false, error: 'Device does not support power-fail' };
    const changed = dev.setPowerFail(!!active);
    return { success: true, address, powerFailActive: dev.powerFailActive, changed };
  }"""

    content = content[:end] + new_methods + content[end:]
    applied.append("added setTamper() and setPowerFail() methods")

    if content == original:
        print("  • No changes written.")
        return True
    EMUFILE.with_suffix('.js.bak-tamper').write_text(original)
    EMUFILE.write_text(content)
    print(f"  ✓ Backup: OSDPDeviceEmulator.js.bak-tamper")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def patch_routes() -> bool:
    print("\n[3/3] routes-emulator.js — POST /tamper + POST /powerfail")
    if not ROUTES.exists():
        print(f"  ✗ NOT FOUND: {ROUTES}")
        return False
    content = ROUTES.read_text()
    original = content

    if "/device/:address/tamper" in content:
        print("  • Already installed — skipping")
        return True

    # Anchor: insert before the /config/list route (first route after the device routes).
    anchor = "  router.get('/config/list',"
    if anchor not in content:
        print("  ✗ ANCHOR MISS: /config/list route")
        return False

    new_routes = """  router.post('/device/:address/tamper', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const active = !!req.body.active;
    const result = emulator.setTamper(addr, active);
    res.json(result);
  });

  router.post('/device/:address/powerfail', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const active = !!req.body.active;
    const result = emulator.setPowerFail(addr, active);
    res.json(result);
  });

""" + anchor

    content = content.replace(anchor, new_routes, 1)

    ROUTES.with_suffix('.js.bak-tamper').write_text(original)
    ROUTES.write_text(content)
    print(f"  ✓ Backup: routes-emulator.js.bak-tamper")
    print(f"    + POST /api/emulator/device/:address/tamper")
    print(f"    + POST /api/emulator/device/:address/powerfail")
    return True


# ════════════════════════════════════════════════════════════════════════
UI_SNIPPET = '''
{/* ── Status: Tamper + Power Fail (paste below the Outputs block) ────── */}
<div className="mt-4 pt-3 border-t border-slate-700/40">
  <div className="flex items-center justify-between mb-2">
    <span className="text-xs text-slate-400 uppercase tracking-wide">Status</span>
    <span className="text-[10px] text-slate-500">Latching — click to toggle</span>
  </div>
  <div className="flex gap-2">
    {/* Tamper */}
    <button
      onClick={async () => {
        const next = !dev.tamperActive;
        try {
          await fetch(`http://${ipAddress}:3001/api/emulator/device/${dev.address}/tamper`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: next }),
          });
        } catch (e) { console.error('tamper toggle failed', e); }
      }}
      className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-2 ${
        dev.tamperActive
          ? 'bg-red-600/30 border-red-500 text-red-300 shadow-[0_0_10px_rgba(239,68,68,0.3)]'
          : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:border-slate-600'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dev.tamperActive ? 'bg-red-400 animate-pulse' : 'bg-slate-600'}`} />
      TAMPER
    </button>

    {/* Power Fail */}
    <button
      onClick={async () => {
        const next = !dev.powerFailActive;
        try {
          await fetch(`http://${ipAddress}:3001/api/emulator/device/${dev.address}/powerfail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: next }),
          });
        } catch (e) { console.error('powerfail toggle failed', e); }
      }}
      className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-2 ${
        dev.powerFailActive
          ? 'bg-orange-600/30 border-orange-500 text-orange-300 shadow-[0_0_10px_rgba(249,115,22,0.3)]'
          : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:border-slate-600'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dev.powerFailActive ? 'bg-orange-400 animate-pulse' : 'bg-slate-600'}`} />
      POWER FAIL
    </button>
  </div>
</div>
'''


def main():
    print("═" * 65)
    print("  Tamper / Power-Fail Installer")
    print("═" * 65)
    if not BACKEND.exists():
        print(f"  ✗ Backend not found at {BACKEND}")
        sys.exit(1)

    ok = True
    ok &= patch_basedevice()
    ok &= patch_emulator()
    ok &= patch_routes()

    print("\n" + "═" * 65)
    if ok:
        print("  ✓ Backend install complete.")
        print()
        print("  Test with curl (substitute the address of one of your boards):")
        print()
        print("    # Trigger tamper on board 11")
        print("    curl -X POST http://localhost:3001/api/emulator/device/11/tamper \\")
        print("         -H 'Content-Type: application/json' -d '{\"active\":true}'")
        print()
        print("    # Clear it")
        print("    curl -X POST http://localhost:3001/api/emulator/device/11/tamper \\")
        print("         -H 'Content-Type: application/json' -d '{\"active\":false}'")
        print()
        print("    # Same for power fail:")
        print("    curl -X POST http://localhost:3001/api/emulator/device/11/powerfail \\")
        print("         -H 'Content-Type: application/json' -d '{\"active\":true}'")
        print()
        print("  Verify on the bus: within ~1 LSTAT poll cycle, IC2 should see")
        print("  the LSTATR bits update. Real-time view:")
        print("      python3 /tmp/ri4s-monitor.py 11  | grep -A1 LSTAT")
        print()
        print("─" * 65)
        print("  UI snippet — paste this JSX into the device card render")
        print("  in ControllerEmulatorSection.tsx (after the Outputs block,")
        print("  inside the device card's outer container):")
        print("─" * 65)
        print(UI_SNIPPET)
        print("─" * 65)
        print("  REQUIRED: restart the backend so the new code is loaded:")
        print("      sudo systemctl restart aether-backend")
    else:
        print("  ⚠ One or more steps failed — see warnings above.")
        sys.exit(2)


if __name__ == '__main__':
    main()
