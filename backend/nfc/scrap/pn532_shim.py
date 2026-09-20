#!/usr/bin/env python3
import os
os.environ['BLINKA_FORCE'] = '1'  # force Blinka to use smbus backend
os.environ.setdefault('PYTHONUNBUFFERED','1')  # ensure realtime stdout

# pn532_shim.py - diagnostic-friendly PN532 shim
# FIXED VERSION - Added polling delays to prevent I2C bus contention
#
# Emits JSON lines to stdout:
# {"type":"info","msg":"..."}
# {"type":"uid","uid":"04a3ff1b921680"}
# Exit codes:
#  0 normal
#  2 import / module missing
#  3 device permission / runtime error

import time, sys, json, os, stat, errno

# === CONFIGURABLE DELAYS (prevents I2C bus saturation) ===
POLL_INTERVAL = float(os.environ.get('PN532_POLL_INTERVAL', '0.5'))    # Delay between polls when no card
CARD_COOLDOWN = float(os.environ.get('PN532_CARD_COOLDOWN', '1.0'))    # Delay after successful read
READ_TIMEOUT = float(os.environ.get('PN532_READ_TIMEOUT', '0.5'))      # Timeout for each read attempt
PAUSE_FLAG_FILE = os.environ.get('PN532_PAUSE_FLAG', '/tmp/pn532_pause')

def stderr(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()

def jsout(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def should_pause():
    """Check if pause is requested via flag file (for I2C bus coordination)"""
    return os.path.exists(PAUSE_FLAG_FILE)

# ---- guarded imports with helpful messages ----
missing = []
try:
    import board
except Exception as e:
    missing.append(("board", str(e)))
try:
    import busio
except Exception as e:
    missing.append(("busio", str(e)))
try:
    # PN532 I2C wrapper from adafruit circuitpython
    from adafruit_pn532.i2c import PN532_I2C
except Exception as e:
    missing.append(("adafruit_pn532", str(e)))

if missing:
    stderr("IMPORT_ERROR: missing required python modules or broken environment")
    for name, err in missing:
        stderr(f" - {name}: {err}")
    stderr("")
    stderr("Common fixes:")
    stderr("  * Activate the virtualenv where you installed dependencies:")
    stderr("      source ./ .venv-pn532/bin/activate   # (adjust path)")
    stderr("  * Then install required packages inside that venv:")
    stderr("      pip install adafruit-blinka adafruit-circuitpython-pn532")
    stderr("  * If lgpio was attempted and failed, you can still use blinka's I2C backend (smbus) as long as adafruit-blinka is installed.")
    stderr("")
    stderr("Exiting with code 2.")
    sys.exit(2)

# ---- helper: check i2c device file(s) and permissions ----
def check_i2c_devices():
    devices = []
    for i in range(0, 4):
        path = f"/dev/i2c-{i}"
        if os.path.exists(path):
            st = os.stat(path)
            mode = stat.filemode(st.st_mode)
            devices.append({
                "path": path,
                "mode": mode,
                "uid": st.st_uid,
                "gid": st.st_gid
            })
    return devices

# print system-level info to stderr (useful for Node logs)
devs = check_i2c_devices()
stderr("I2C device scan results:")
if not devs:
    stderr("  No /dev/i2c-* devices found.")
else:
    for d in devs:
        stderr(f"  {d['path']}  mode={d['mode']}  uid={d['uid']}  gid={d['gid']}")

stderr(f"Effective UID={os.geteuid()}  GID={os.getegid()}")
# if started via sudo, print original SUDO_UID/GID
if os.environ.get("SUDO_UID"):
    stderr(f"SUDO_UID={os.environ.get('SUDO_UID')}  SUDO_GID={os.environ.get('SUDO_GID')}")

# Print polling configuration
stderr(f"[PN532] Polling config: interval={POLL_INTERVAL}s, cooldown={CARD_COOLDOWN}s, timeout={READ_TIMEOUT}s")

# ---- main reader (with extra permission-aware messages) ----
def main():
    try:
        i2c = busio.I2C(board.SCL, board.SDA)
    except PermissionError as e:
        # common on systems where process lacks access to /dev/i2c-1
        stderr("PermissionError opening I2C device: " + str(e))
        stderr("Check that the running user is in the 'i2c' group and that /dev/i2c-1 is readable/writable by that group.")
        stderr("If running Node under sudo, the spawned Python process may not have the expected group membership.")
        stderr("Quick checks / fixes:")
        stderr("  * Ensure your user is in the i2c group:  id <username>")
        stderr("  * If you added the user to the i2c group recently, re-login or run: newgrp i2c")
        stderr("  * Run the shim manually from your user (no sudo) to verify group permissions:")
        stderr("      source .venv-pn532/bin/activate")
        stderr("      python3 pn532_shim.py")
        stderr("Exiting with code 3.")
        sys.exit(3)
    except Exception as e:
        stderr("Error creating busio.I2C: " + str(e))
        stderr("This can happen if adafruit_blinka is misconfigured or the I2C backend is unavailable.")
        stderr("Try running in a venv with adafruit-blinka installed and check that /dev/i2c-1 exists.")
        stderr("Exiting with code 3.")
        sys.exit(3)

    try:
        pn532 = PN532_I2C(i2c)
    except Exception as e:
        stderr("PN532_I2C init error: " + str(e))
        stderr("If the device is physically absent or on a different address, check wiring and address.")
        sys.exit(3)

    # firmware/version info
    try:
        ic, ver, rev, support = pn532.firmware_version
        jsout({"type":"info","msg":f"PN532 firmware {ver}.{rev}, support=0x{support:02x}"})
    except Exception as e:
        stderr("FW_ERROR: " + str(e))

    # SAM configuration
    try:
        if hasattr(pn532, "SAM_configuration"):
            pn532.SAM_configuration()
        elif hasattr(pn532, "sam"):
            pn532.sam()
        jsout({"type":"info","msg":"SAM configured"})
    except Exception as e:
        stderr("SAM_ERROR: " + str(e))

    jsout({"type":"info","msg":"Starting NFC polling loop with I2C-safe delays"})
    
    consecutive_errors = 0
    max_consecutive_errors = 10
    
    try:
        while True:
            # === PAUSE CHECK (allows other I2C devices to use bus) ===
            if should_pause():
                stderr("[PN532] PAUSED: Yielding I2C bus...")
                while should_pause():
                    time.sleep(0.1)
                stderr("[PN532] RESUMED")
                time.sleep(0.2)  # Extra delay after resume
            
            try:
                # === CARD READ ===
                uid = pn532.read_passive_target(timeout=READ_TIMEOUT)
                consecutive_errors = 0  # Reset on successful I2C communication
                
                if uid is None:
                    # No card present - MUST wait before next poll
                    # This is CRITICAL for I2C bus stability
                    time.sleep(POLL_INTERVAL)
                    continue
                
                # Card found!
                uidhex = ''.join('{:02x}'.format(x) for x in uid)
                jsout({"type":"uid","uid":uidhex})
                
                # Longer delay after read to prevent duplicate reads
                # and give I2C bus time for other operations
                time.sleep(CARD_COOLDOWN)
                
            except OSError as e:
                # I2C communication error
                consecutive_errors += 1
                stderr(f"[PN532] I2C_ERROR ({consecutive_errors}/{max_consecutive_errors}): {e}")
                
                if consecutive_errors >= max_consecutive_errors:
                    stderr("[PN532] Too many I2C errors - backing off 10 seconds...")
                    time.sleep(10.0)
                    consecutive_errors = 0
                else:
                    # Backoff on transient errors
                    time.sleep(2.0)
                    
    except KeyboardInterrupt:
        stderr("Shutting down (keyboard interrupt).")
        pass
    except Exception as e:
        stderr("RUNTIME_ERROR: " + str(e))
        if isinstance(e, OSError) and e.errno == errno.EACCES:
            stderr("Permission denied during runtime I2C access (EACCES). Check device permissions and group membership.")
        sys.exit(3)

if __name__ == '__main__':
    main()
