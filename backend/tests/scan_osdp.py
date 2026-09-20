#!/usr/bin/env python3
"""
scan_osdp.py — standalone OSDP address scanner.

Sweeps a serial port across an address range, sending a raw osdp_POLL (0x60)
to each address and listening for a real PD reply (SOM + address byte with
high bit set). Doesn't use osdplib — pure pyserial + manual packet build —
so it works regardless of config.json contents.

Usage:
    python3 scan_osdp.py PORT [BAUD] [MAX_ADDR]

    PORT     e.g. ttyACM1  (with or without /dev/ prefix)
    BAUD     default 9600
    MAX_ADDR default 15 (scan 0..15). Use 126 for the full OSDP range.

Examples:
    python3 scan_osdp.py ttyACM1
    python3 scan_osdp.py ttyACM1 38400 31
    python3 scan_osdp.py /dev/ttyAMA0 115200
"""

import sys
import time
import serial


def crc16(data, poly=0x1021, init=0x1D0F):
    """OSDP CRC-16-CCITT with init 0x1D0F (per OSDP v2.2 Annex C)."""
    crc = init
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ poly) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return crc


def build_poll(addr, seq=0):
    """8-byte osdp_POLL packet: SOM + ADDR + LEN(LE2) + CTRL + CMD + CRC(LE2).

    CTRL bit 2 set = CRC mode (not checksum).  Sequence 0 is OSDP's "fresh
    start" — every PD must accept it.
    """
    pkt = bytes([
        0x53,                       # SOM
        addr & 0x7F,                # ADDR (no reply flag for CP→PD)
        0x08, 0x00,                 # LEN = 8, little-endian
        (seq & 0x03) | 0x04,        # CTRL: sequence + CRC-mode bit
        0x60,                       # CMD = osdp_POLL
    ])
    c = crc16(pkt)
    return pkt + bytes([c & 0xFF, (c >> 8) & 0xFF])


def find_reply(buf, our_tx):
    """Look in `buf` for a real PD reply: a SOM (0x53) followed by an address
    byte with the high bit set, distinct from our own transmitted packet.
    Returns (pd_addr, reply_code, raw_hex) or None.
    """
    for i in range(len(buf) - 5):
        if buf[i] != 0x53:
            continue
        if not (buf[i + 1] & 0x80):          # high bit = PD reply flag
            continue
        # Skip if this frame matches our own TX (RS485 half-duplex echo can
        # confuse us if the dongle re-presents our bytes).
        if buf[i:i + len(our_tx)] == our_tx:
            continue
        pd_addr   = buf[i + 1] & 0x7F
        reply_cmd = buf[i + 5] if i + 5 < len(buf) else 0
        snippet   = buf[i:i + min(16, len(buf) - i)].hex()
        return pd_addr, reply_cmd, snippet
    return None


REPLY_NAMES = {
    0x40: "osdp_ACK",
    0x41: "osdp_NAK",
    0x45: "osdp_PDID",
    0x46: "osdp_PDCAP",
    0x48: "osdp_LSTATR",
    0x49: "osdp_ISTATR",
    0x4A: "osdp_OSTATR",
    0x4B: "osdp_RSTATR",
    0x50: "osdp_RAW",      # card read
    0x51: "osdp_FMT",
    0x53: "osdp_KEYPAD",   # keypad data
    0x78: "osdp_CCRYPT",
    0x76: "osdp_RMAC_I",
    0x79: "osdp_BUSY",
    0x7A: "osdp_FTSTAT",
}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    port_arg = sys.argv[1]
    baud     = int(sys.argv[2]) if len(sys.argv) > 2 else 9600
    max_addr = int(sys.argv[3]) if len(sys.argv) > 3 else 15

    port = port_arg if port_arg.startswith('/dev/') else f'/dev/{port_arg}'

    print(f"Scanning {port} @ {baud} baud, addresses 0..{max_addr}")
    print("-" * 70)

    try:
        ser = serial.Serial(port, baud, timeout=0.3)
    except serial.SerialException as e:
        print(f"ERROR opening {port}: {e}")
        sys.exit(2)

    found_count = 0
    echo_only_count = 0
    silent_count = 0

    try:
        for addr in range(0, max_addr + 1):
            # Try sequence 0 first (PDs accept this regardless of state).
            our_tx = build_poll(addr, seq=0)
            ser.reset_input_buffer()
            ser.write(our_tx)
            ser.flush()
            time.sleep(0.12)                 # let the PD respond
            buf = ser.read(64)

            reply = find_reply(buf, our_tx)
            if reply:
                pd_addr, rcode, raw = reply
                name = REPLY_NAMES.get(rcode, f"unknown 0x{rcode:02X}")
                print(f"  addr {addr:3d} (0x{addr:02X}): ✓ REPLY  from PD 0x{pd_addr:02X}  "
                      f"reply=0x{rcode:02X} ({name})  raw={raw}")
                found_count += 1
            elif buf:
                # Bus had bytes but none look like a reply — probably our own
                # TX echoing on a half-duplex line, or someone else talking.
                echo_only_count += 1
            else:
                silent_count += 1

    finally:
        ser.close()

    print("-" * 70)
    print(f"Done. {found_count} reply / {echo_only_count} echo-or-noise / {silent_count} silent")
    if found_count == 0:
        print()
        print("No PD replies detected on this baud + address range.")
        print("Next things to try:")
        print("  • If you saw 'echo-or-noise' but no replies → RS485 wiring is "
              "alive but reader isn't responding.")
        print("    Check power to reader, A/B polarity, baud rate, reader's "
              "configured address.")
        print("  • Re-run at a different baud (38400 / 19200 / 57600 / 115200).")
        print("  • If you saw 'silent' on every address → no electrical activity "
              "on the bus. Check the dongle (is it really RS485, not USB-TTL?).")


if __name__ == "__main__":
    main()
