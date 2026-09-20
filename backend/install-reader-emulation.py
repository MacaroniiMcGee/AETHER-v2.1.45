#!/usr/bin/env python3
"""
Aether Emulator — Reader Emulation (Card Swipe + PIN Entry)
────────────────────────────────────────────────────────────
Adds the ability to inject a card-read or keypad-entry event on any
emulated RI4S / RI2MS reader port. IC2 sees the event via the standard
OSDP 0x50 RAW (card) or 0x53 KEYPAD (PIN) replies when it polls.

Backend changes (auto-applied, idempotent, with .bak-reader-emu backups):

  BaseDevice.js
    + Adds `pendingCardReads` queue
    + Adds queueCardRead(readerNum, bits, formatCode) method
    + Adds queueKeypadKeys(readerNum, keys) method
    + Modifies _handlePoll() to drain the queue, replying with 0x50 RAW
      (card) or 0x53 KEYPAD (PIN) ahead of input/status reports

  OSDPDeviceEmulator.js
    + Requires lib/formatService at the top
    + Adds queueCardRead(address, port, formatId, facility, card, issueLevel)
    + Adds queueKeypadKeys(address, port, keys)

  routes-emulator.js
    + POST /api/emulator/device/:address/reader/:port/card
        body: { format, facility, card, issueLevel }
    + POST /api/emulator/device/:address/reader/:port/keys
        body: { keys: "1234#" }   ← ASCII digits + * / # / BS

Idempotent. Each file gets a .bak-reader-emu backup.
"""
from pathlib import Path
import sys

BACKEND  = Path.home() / 'Desktop/Aether/M1.2.2/backend'
BASEDEV  = BACKEND / 'osdp/devices/BaseDevice.js'
EMUFILE  = BACKEND / 'osdp/OSDPDeviceEmulator.js'
ROUTES   = BACKEND / 'routes-emulator.js'


def find_balanced_close(content: str, open_pos: int) -> int:
    """Given the index of an opening '{', return the index just past its matching '}'."""
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
    print("\n[1/3] BaseDevice.js — card-read queue + POLL drain")
    if not BASEDEV.exists():
        print(f"  ✗ NOT FOUND: {BASEDEV}"); return False
    content = BASEDEV.read_text()
    original = content

    if 'pendingCardReads' in content and 'queueCardRead' in content:
        print("  • Already installed — skipping"); return True

    applied = []

    # ── A. Add queue field to constructor (after pendingLocalStatusChange) ──
    state_anchor = "    this.pendingLocalStatusChange = false;"
    if state_anchor not in content:
        print("  ✗ ANCHOR MISS: pendingLocalStatusChange (tamper patch missing?)"); return False
    new_state = state_anchor + """

    // Card / keypad event queue for reader ports — drained on POLL.
    // Pushed by queueCardRead() / queueKeypadKeys() (subclasses with readers only).
    this.pendingCardReads = [];"""
    content = content.replace(state_anchor, new_state, 1)
    applied.append("constructor: pendingCardReads queue field")

    # ── B. Modify _handlePoll to drain the queue BEFORE other pending checks ──
    # Anchor on the existing pendingLocalStatusChange check that we added in installer #1.
    poll_anchor = """    // Local status change (tamper or power-fail) — push LSTATR on next POLL.
    // Triggered by setTamper() / setPowerFail() setting pendingLocalStatusChange.
    if (this.pendingLocalStatusChange) {"""
    if poll_anchor not in content:
        print("  ✗ ANCHOR MISS: pendingLocalStatusChange check in _handlePoll")
        print("    (the LSTATR-push patch from earlier may be missing)")
        return False

    drain_block = """    // Card-read / keypad queue — drain ONE entry per POLL, highest priority.
    // Subclasses with readers (RI4S, RI2MS) populate this via queueCardRead/Keys.
    if (this.pendingCardReads && this.pendingCardReads.length > 0) {
      const entry = this.pendingCardReads.shift();
      if (entry.type === 'card') {
        // OSDP 0x50 RAW reply: [readerNum, formatCode, bitCountLSB, bitCountMSB, ...bit data MSB-first]
        const bitCount = entry.bits.length;
        const byteCount = Math.ceil(bitCount / 8);
        const payload = Buffer.alloc(4 + byteCount);
        payload[0] = entry.readerNum & 0xFF;
        payload[1] = (entry.formatCode || 0) & 0xFF;
        payload[2] = bitCount & 0xFF;
        payload[3] = (bitCount >> 8) & 0xFF;
        for (let i = 0; i < bitCount; i++) {
          if (entry.bits[i]) payload[4 + (i >> 3)] |= (0x80 >> (i & 7));
        }
        return this._reply(0x50, payload);
      }
      if (entry.type === 'keys') {
        // OSDP 0x53 KEYPAD reply: [readerNum, count, ...key bytes]
        const count = entry.keys.length;
        const payload = Buffer.alloc(2 + count);
        payload[0] = entry.readerNum & 0xFF;
        payload[1] = count & 0xFF;
        for (let i = 0; i < count; i++) payload[2 + i] = entry.keys[i] & 0xFF;
        return this._reply(0x53, payload);
      }
    }

""" + poll_anchor
    content = content.replace(poll_anchor, drain_block, 1)
    applied.append("_handlePoll: drains card/keypad queue ahead of other status replies")

    # ── C. Add queueCardRead / queueKeypadKeys methods before snapshot ──
    methods_anchor = """  // ─── Snapshot for UI ──────────────────────────────────────────────────
  snapshot() {"""
    if methods_anchor not in content:
        print("  ✗ ANCHOR MISS: snapshot() header"); return False

    new_methods = """  // ─── Reader event queue ──────────────────────────────────────────────
  // Subclasses with readers (numReaders > 0) accept queued card and keypad
  // events. The next POLL drains one entry and surfaces it to IC2 via
  // 0x50 RAW (card) or 0x53 KEYPAD (PIN).
  queueCardRead(readerNum, bits, formatCode = 0) {
    if (!this.numReaders || readerNum >= this.numReaders) return false;
    if (!Array.isArray(bits) || bits.length === 0) return false;
    this.pendingCardReads.push({
      type: 'card',
      readerNum: readerNum | 0,
      formatCode: formatCode | 0,
      bits: bits.map(b => b ? 1 : 0),
    });
    if (typeof this.emit === 'function') {
      this.emit('reader-card-queued', { readerNum, bitCount: bits.length });
    }
    return true;
  }

  queueKeypadKeys(readerNum, keys) {
    if (!this.numReaders || readerNum >= this.numReaders) return false;
    if (!Array.isArray(keys) || keys.length === 0) return false;
    this.pendingCardReads.push({
      type: 'keys',
      readerNum: readerNum | 0,
      keys: keys.map(k => k & 0xFF),
    });
    if (typeof this.emit === 'function') {
      this.emit('reader-keys-queued', { readerNum, count: keys.length });
    }
    return true;
  }

  // ─── Snapshot for UI ──────────────────────────────────────────────────
  snapshot() {"""
    content = content.replace(methods_anchor, new_methods, 1)
    applied.append("queueCardRead() + queueKeypadKeys() methods added")

    if content == original:
        print("  • No changes written.")
        return True

    BASEDEV.with_suffix('.js.bak-reader-emu').write_text(original)
    BASEDEV.write_text(content)
    print(f"  ✓ Backup: BaseDevice.js.bak-reader-emu")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def patch_emulator() -> bool:
    print("\n[2/3] OSDPDeviceEmulator.js — formatService require + queue methods")
    if not EMUFILE.exists():
        print(f"  ✗ NOT FOUND: {EMUFILE}"); return False
    content = EMUFILE.read_text()
    original = content

    if 'queueCardRead' in content:
        print("  • Already installed — skipping"); return True

    applied = []

    # ── A. Require formatService at top (after the last existing top-level require) ──
    # Find the last 'require(' line near the top of the file
    if "require('../lib/formatService')" not in content:
        # Inject require near the top — find any 'const X = require(' line in first 30 lines
        lines = content.split('\n')
        inject_at = -1
        for i in range(min(30, len(lines))):
            if 'require(' in lines[i] and lines[i].lstrip().startswith('const'):
                inject_at = i
        if inject_at == -1:
            # Fallback: inject after the file header comment, before class
            for i in range(len(lines)):
                if lines[i].startswith('class ') or lines[i].startswith('const ') and i > 5:
                    inject_at = i - 1
                    break
        if inject_at >= 0:
            lines.insert(inject_at + 1, "const formatService = require('../lib/formatService');")
            content = '\n'.join(lines)
            applied.append("require('../lib/formatService') added")
        else:
            print("  ⚠ Couldn't auto-inject formatService require — add it manually")

    # ── B. Find setTamper method and insert reader-queue methods after it ──
    # setTamper exists from installer #1; use it as the literal anchor.
    sig = "setTamper(address, active) {"
    i = content.find(sig)
    if i < 0:
        print("  ✗ ANCHOR MISS: setTamper method (tamper patch missing?)")
        return False
    open_brace = content.find('{', i + len(sig) - 1)
    end_set_tamper = find_balanced_close(content, open_brace)
    if end_set_tamper < 0:
        print("  ✗ couldn't balance setTamper braces"); return False

    # Walk forward to find setPowerFail's close too — insert after BOTH.
    sig2 = "setPowerFail(address, active) {"
    j = content.find(sig2, end_set_tamper)
    if j < 0:
        print("  ✗ ANCHOR MISS: setPowerFail method"); return False
    open2 = content.find('{', j + len(sig2) - 1)
    end_set_powerfail = find_balanced_close(content, open2)
    if end_set_powerfail < 0:
        print("  ✗ couldn't balance setPowerFail braces"); return False

    new_methods = """

  /** Queue a card swipe on a specific reader port of an emulated board. */
  queueCardRead(address, port, formatId, facility, card, issueLevel = 0) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.queueCardRead !== 'function') {
      return { success: false, error: `Device at ${address} does not have readers` };
    }
    if (port < 0 || port >= (dev.numReaders || 0)) {
      return { success: false, error: `Reader port ${port} out of range (0..${(dev.numReaders||1)-1})` };
    }

    // Encode credential to a bit array using the shared FormatService.
    // encodeCredential() may return: array of 0/1, BigInt, or Buffer — normalize.
    let bits;
    try {
      const raw = formatService.encodeCredential(formatId, facility, card, issueLevel);
      const fmt = formatService.getFormatById(formatId);
      const totalBits = fmt?.bits || (Array.isArray(raw) ? raw.length : 26);
      if (Array.isArray(raw)) {
        bits = raw.map(b => b ? 1 : 0);
      } else if (typeof raw === 'bigint') {
        bits = [];
        for (let k = totalBits - 1; k >= 0; k--) {
          bits.push(Number((raw >> BigInt(k)) & 1n));
        }
      } else if (Buffer.isBuffer(raw)) {
        bits = [];
        for (const byte of raw) {
          for (let k = 7; k >= 0 && bits.length < totalBits; k--) bits.push((byte >> k) & 1);
        }
      } else {
        return { success: false, error: `formatService returned unexpected type ${typeof raw}` };
      }
    } catch (e) {
      return { success: false, error: `Encode failed: ${e.message}` };
    }

    const ok = dev.queueCardRead(port, bits, 0);
    return {
      success: ok,
      address, port,
      format: formatId,
      facility, card, issueLevel,
      bitCount: bits.length,
    };
  }

  /** Queue a PIN / keypad entry on a specific reader port. keys: "1234#" or array of byte values. */
  queueKeypadKeys(address, port, keys) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.queueKeypadKeys !== 'function') {
      return { success: false, error: `Device at ${address} does not have readers` };
    }
    if (port < 0 || port >= (dev.numReaders || 0)) {
      return { success: false, error: `Reader port ${port} out of range` };
    }

    // Accept either a string ("1234#") or an array of byte values.
    // For strings, send ASCII bytes ('0'..'9'=0x30..0x39, '*'=0x2A, '#'=0x23, BS=0x7F).
    const keyBytes = typeof keys === 'string'
      ? Array.from(keys).map(c => c.charCodeAt(0) & 0xFF)
      : (Array.isArray(keys) ? keys.map(k => k & 0xFF) : []);

    if (keyBytes.length === 0) {
      return { success: false, error: 'No keys to send' };
    }

    const ok = dev.queueKeypadKeys(port, keyBytes);
    return { success: ok, address, port, count: keyBytes.length };
  }"""

    content = content[:end_set_powerfail] + new_methods + content[end_set_powerfail:]
    applied.append("queueCardRead() + queueKeypadKeys() methods added")

    if content == original:
        print("  • No changes written.")
        return True
    EMUFILE.with_suffix('.js.bak-reader-emu').write_text(original)
    EMUFILE.write_text(content)
    print(f"  ✓ Backup: OSDPDeviceEmulator.js.bak-reader-emu")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def patch_routes() -> bool:
    print("\n[3/3] routes-emulator.js — POST /reader/:port/card + /keys")
    if not ROUTES.exists():
        print(f"  ✗ NOT FOUND: {ROUTES}"); return False
    content = ROUTES.read_text()
    original = content

    if "/reader/:port/card" in content:
        print("  • Already installed — skipping"); return True

    # Anchor: insert before /config/list (same anchor as the tamper installer)
    anchor = "  router.get('/config/list',"
    if anchor not in content:
        print("  ✗ ANCHOR MISS: /config/list route"); return False

    new_routes = """  router.post('/device/:address/reader/:port/card', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const port = parseInt(req.params.port, 10);
    const { format, facility, card, issueLevel } = req.body || {};
    if (!format) {
      return res.status(400).json({ success: false, error: 'format (formatId) required' });
    }
    const result = emulator.queueCardRead(
      addr, port,
      String(format),
      Number(facility) || 0,
      Number(card) || 0,
      Number(issueLevel) || 0,
    );
    res.json(result);
  });

  router.post('/device/:address/reader/:port/keys', (req, res) => {
    const addr = parseInt(req.params.address, 10);
    const port = parseInt(req.params.port, 10);
    const { keys } = req.body || {};
    if (!keys && keys !== 0) {
      return res.status(400).json({ success: false, error: 'keys required (string or array)' });
    }
    const result = emulator.queueKeypadKeys(addr, port, keys);
    res.json(result);
  });

""" + anchor
    content = content.replace(anchor, new_routes, 1)

    ROUTES.with_suffix('.js.bak-reader-emu').write_text(original)
    ROUTES.write_text(content)
    print(f"  ✓ Backup: routes-emulator.js.bak-reader-emu")
    print(f"    + POST /api/emulator/device/:address/reader/:port/card")
    print(f"    + POST /api/emulator/device/:address/reader/:port/keys")
    return True


# ════════════════════════════════════════════════════════════════════════
def main():
    print("═" * 65)
    print("  Reader Emulation — Card Swipe + PIN Entry Installer")
    print("═" * 65)
    if not BACKEND.exists():
        print(f"  ✗ Backend not found at {BACKEND}"); sys.exit(1)

    ok = True
    ok &= patch_basedevice()
    ok &= patch_emulator()
    ok &= patch_routes()

    print("\n" + "═" * 65)
    if ok:
        print("  ✓ Backend install complete.")
        print()
        print("  Next:")
        print("    sudo systemctl restart aether-backend")
        print("    # (re-apply your emulator config after restart)")
        print()
        print("  Test card swipe on slot 12 (RI4S) reader port 0:")
        print()
        print("    curl -X POST http://localhost:3001/api/emulator/device/12/reader/0/card \\")
        print("         -H 'Content-Type: application/json' \\")
        print('         -d \'{"format":"w26","facility":123,"card":45678}\'')
        print()
        print("  Expected: {\"success\":true,\"address\":12,\"port\":0,\"format\":\"w26\",")
        print("             \"facility\":123,\"card\":45678,\"bitCount\":26}")
        print()
        print("  IC2 should see the card swipe on its next POLL (~30-500ms).")
        print()
        print("  Test PIN entry:")
        print()
        print("    curl -X POST http://localhost:3001/api/emulator/device/12/reader/0/keys \\")
        print("         -H 'Content-Type: application/json' \\")
        print('         -d \'{"keys":"1234#"}\'')
        print()
        print("  On the bus monitor, watch for:")
        print("    PD→CP  0x50 RAW   data=<reader#><fmt><bits LSB><bits MSB><bit data>")
        print("    PD→CP  0x53 KEYPAD data=<reader#><count><keys...>")
    else:
        print("  ⚠ One or more steps failed — see warnings above.")
        sys.exit(2)


if __name__ == '__main__':
    main()
