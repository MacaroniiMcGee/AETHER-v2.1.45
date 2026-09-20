#!/usr/bin/env python3
"""
Aether Emulator — Live Health Monitor
─────────────────────────────────────

Watches /tmp/emu-rx.log (CP→PD commands) and /tmp/emu-tx.log (PD→CP replies)
in real time. Per address it tracks:

  • POLL count + reply count + miss rate
  • Average reply latency (POLL → reply ms)
  • Time since last reply (the watchdog metric)
  • Online/Offline state (configurable threshold)
  • Number of state changes in the last 60s (FLAPPING detection)
  • Last few command codes seen

The table refreshes every second. Anomalies are color-coded:
  GREEN   = healthy        (recent reply, low latency, no flaps)
  YELLOW  = warning        (latency >50ms, OR 1-2 flaps in last 60s)
  RED     = critical       (offline, OR 3+ flaps in last 60s, OR latency >150ms)

Usage:
  python3 /tmp/emulator-health.py
  python3 /tmp/emulator-health.py --threshold 3      # 3-second offline threshold
  python3 /tmp/emulator-health.py --rx /custom/path/rx.log

Tip: split-screen this with the bus monitor for full visibility:
  Terminal 1:  python3 /tmp/emulator-health.py
  Terminal 2:  tail -F /tmp/emu-rx.log /tmp/emu-tx.log
"""

import argparse
import re
import os
import sys
import time
from collections import deque

# ──────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────
DEFAULT_OFFLINE_THRESHOLD = 3.0   # seconds without a reply → OFFLINE
LATENCY_WARN_MS = 50              # >50 ms reply latency = yellow
LATENCY_CRIT_MS = 150             # >150 ms = red
FLAP_WINDOW_SEC = 60              # window for counting flaps
FLAP_WARN = 1
FLAP_CRIT = 3
REFRESH_SEC = 1.0

# ANSI escapes
CSI = '\033['
RESET = CSI + '0m'
BOLD = CSI + '1m'
DIM = CSI + '2m'
RED = CSI + '91m'
GREEN = CSI + '92m'
YELLOW = CSI + '93m'
BLUE = CSI + '94m'
MAGENTA = CSI + '95m'
CYAN = CSI + '96m'
WHITE = CSI + '97m'
CLEAR_SCREEN = CSI + '2J' + CSI + 'H'
HIDE_CURSOR = CSI + '?25l'
SHOW_CURSOR = CSI + '?25h'

# OSDP command names
CMD_NAMES = {
    0x60: 'POLL',
    0x61: 'ID',
    0x62: 'CAP',
    0x64: 'LSTAT',
    0x65: 'ISTAT',
    0x66: 'OSTAT',
    0x67: 'RSTAT',
    0x68: 'OUT',
    0x69: 'LED',
    0x6A: 'BUZ',
    0x6B: 'TEXT',
    0x6E: 'COMSET',
    0x73: 'KEYSET',
    0x76: 'CHLNG',
    0x77: 'SCRYPT',
    # Replies
    0x40: 'ACK',
    0x41: 'NAK',
    0x45: 'PDID',
    0x46: 'PDCAP',
    0x48: 'LSTATR',
    0x49: 'ISTATR',
    0x4A: 'OSTATR',
    0x4B: 'RSTATR',
    0x50: 'RAW',
    0x53: 'KEYPAD',
    0x78: 'CCRYPT',
    0x79: 'RMAC_I',
}


# ──────────────────────────────────────────────────────────────────────
# Parsers
# ──────────────────────────────────────────────────────────────────────
RE_RX = re.compile(r'\[Emu-RX\]\s+addr=(\d+)\s+cmd=0x([0-9a-fA-F]+)')
RE_TX = re.compile(r'\[Emu-TX\]\s+addr=(\d+)\s+cmd=0x([0-9a-fA-F]+)')


# ──────────────────────────────────────────────────────────────────────
# Per-address state
# ──────────────────────────────────────────────────────────────────────
class AddrState:
    __slots__ = (
        'addr', 'rx_count', 'tx_count', 'last_rx_ts', 'last_tx_ts',
        'last_rx_cmd', 'last_tx_cmd', 'recent_latencies', 'state',
        'state_change_times', 'recent_cmds', 'pending_poll_ts',
    )

    def __init__(self, addr):
        self.addr = addr
        self.rx_count = 0
        self.tx_count = 0
        self.last_rx_ts = 0.0
        self.last_tx_ts = 0.0
        self.last_rx_cmd = 0
        self.last_tx_cmd = 0
        self.recent_latencies = deque(maxlen=20)
        self.state = 'UNKNOWN'
        self.state_change_times = deque(maxlen=64)
        self.recent_cmds = deque(maxlen=6)
        self.pending_poll_ts = 0.0

    def on_rx(self, ts, cmd):
        self.rx_count += 1
        self.last_rx_ts = ts
        self.last_rx_cmd = cmd
        # Remember POLL time so we can compute reply latency when TX comes through
        if cmd == 0x60:
            self.pending_poll_ts = ts
        self.recent_cmds.append(f"<{CMD_NAMES.get(cmd, f'{cmd:#04x}')}")

    def on_tx(self, ts, cmd):
        self.tx_count += 1
        self.last_tx_ts = ts
        self.last_tx_cmd = cmd
        if self.pending_poll_ts > 0:
            latency_ms = (ts - self.pending_poll_ts) * 1000.0
            if 0 < latency_ms < 10000:  # sanity bound
                self.recent_latencies.append(latency_ms)
            self.pending_poll_ts = 0.0
        self.recent_cmds.append(f">{CMD_NAMES.get(cmd, f'{cmd:#04x}')}")

    def update_state(self, now, threshold):
        if self.last_tx_ts == 0:
            new_state = 'UNKNOWN'
        elif (now - self.last_tx_ts) > threshold:
            new_state = 'OFFLINE'
        else:
            new_state = 'ONLINE'
        if new_state != self.state and self.state != 'UNKNOWN':
            self.state_change_times.append(now)
        self.state = new_state

    def flap_count(self, now):
        return sum(1 for t in self.state_change_times
                   if (now - t) <= FLAP_WINDOW_SEC)

    def avg_latency(self):
        if not self.recent_latencies:
            return None
        return sum(self.recent_latencies) / len(self.recent_latencies)

    def p95_latency(self):
        if not self.recent_latencies:
            return None
        s = sorted(self.recent_latencies)
        idx = int(len(s) * 0.95)
        return s[min(idx, len(s) - 1)]

    def miss_rate(self):
        if self.rx_count == 0:
            return 0.0
        return max(0, (self.rx_count - self.tx_count) / self.rx_count)


# ──────────────────────────────────────────────────────────────────────
# Log tailer
# ──────────────────────────────────────────────────────────────────────
def open_tail(path):
    """Open file for tailing — seek to end. Returns file handle or None."""
    try:
        f = open(path, 'r')
        f.seek(0, 2)  # end
        return f
    except FileNotFoundError:
        return None


# ──────────────────────────────────────────────────────────────────────
# Rendering
# ──────────────────────────────────────────────────────────────────────
def colorize_state(state):
    if state == 'ONLINE':   return f"{GREEN}● ONLINE {RESET}"
    if state == 'OFFLINE':  return f"{RED}○ OFFLINE{RESET}"
    return f"{DIM}? UNKNOWN{RESET}"


def colorize_latency(ms):
    if ms is None:
        return f"{DIM}    —    {RESET}"
    if ms >= LATENCY_CRIT_MS:  return f"{RED}{ms:6.1f}ms{RESET}"
    if ms >= LATENCY_WARN_MS:  return f"{YELLOW}{ms:6.1f}ms{RESET}"
    return f"{GREEN}{ms:6.1f}ms{RESET}"


def colorize_flaps(n):
    if n >= FLAP_CRIT: return f"{RED}{BOLD}{n:>3}{RESET}"
    if n >= FLAP_WARN: return f"{YELLOW}{n:>3}{RESET}"
    return f"{DIM}{n:>3}{RESET}"


def fmt_since(ts, now):
    if ts == 0: return f"{DIM}   —  {RESET}"
    d = now - ts
    if d < 1.0:    return f"{GREEN}{d*1000:5.0f}ms{RESET}"
    if d < 5.0:    return f"{YELLOW}{d:5.1f}s {RESET}"
    return f"{RED}{d:5.1f}s {RESET}"


def render(states, threshold, start_ts):
    now = time.time()
    lines = []
    lines.append(CLEAR_SCREEN)
    uptime = now - start_ts
    lines.append(f"{BOLD}Aether Emulator — Health Monitor{RESET}  "
                 f"{DIM}{time.strftime('%H:%M:%S')}  "
                 f"uptime {uptime:.0f}s  "
                 f"threshold {threshold}s  "
                 f"flap window {FLAP_WINDOW_SEC}s{RESET}")
    lines.append('─' * 110)
    lines.append(
        f"{BOLD}{'Addr':>4} │ {'Polls':>6} │ {'Replies':>7} │ "
        f"{'Miss%':>5} │ {'Latency avg/p95':>17} │ "
        f"{'Since last RX':>13} │ {'Since last TX':>13} │ "
        f"{'State':<10} │ {'Flaps/min':>9}{RESET}"
    )
    lines.append('─' * 110)

    if not states:
        lines.append(f"{YELLOW}  Waiting for traffic on /tmp/emu-rx.log and /tmp/emu-tx.log…{RESET}")
        lines.append("")
        lines.append(f"{DIM}  Tip: the backend must be running with logging enabled.")
        lines.append(f"  Check: ls -la /tmp/emu-rx.log /tmp/emu-tx.log{RESET}")
    else:
        # Sort by address
        for addr in sorted(states.keys()):
            s = states[addr]
            s.update_state(now, threshold)
            avg_lat = s.avg_latency()
            p95_lat = s.p95_latency()
            lat_str = (f"{colorize_latency(avg_lat)} / "
                       f"{colorize_latency(p95_lat) if p95_lat else f'{DIM}    —    {RESET}'}")
            flaps = s.flap_count(now)
            line = (
                f"{addr:>4} │ "
                f"{s.rx_count:>6} │ "
                f"{s.tx_count:>7} │ "
                f"{s.miss_rate()*100:>4.1f}% │ "
                f"{lat_str} │ "
                f"{fmt_since(s.last_rx_ts, now):>13} │ "
                f"{fmt_since(s.last_tx_ts, now):>13} │ "
                f"{colorize_state(s.state)} │ "
                f"{colorize_flaps(flaps)}"
            )
            lines.append(line)

    # Summary footer
    lines.append('─' * 110)
    if states:
        total_addrs = len(states)
        online = sum(1 for s in states.values() if s.state == 'ONLINE')
        offline = sum(1 for s in states.values() if s.state == 'OFFLINE')
        unknown = total_addrs - online - offline
        flapping = sum(1 for s in states.values() if s.flap_count(now) >= FLAP_WARN)
        total_rx = sum(s.rx_count for s in states.values())
        total_tx = sum(s.tx_count for s in states.values())
        overall_miss = (1 - total_tx / max(1, total_rx)) * 100
        lines.append(
            f"  Total: {total_addrs} addresses   "
            f"{GREEN}online: {online}{RESET}   "
            f"{RED}offline: {offline}{RESET}   "
            f"{DIM}unknown: {unknown}{RESET}   "
            f"{YELLOW}flapping (≥{FLAP_WARN}/min): {flapping}{RESET}   "
            f"miss rate: {overall_miss:.2f}%"
        )

    lines.append("")
    lines.append(f"{DIM}  Press Ctrl+C to exit.{RESET}")
    sys.stdout.write('\n'.join(lines) + '\n')
    sys.stdout.flush()


# ──────────────────────────────────────────────────────────────────────
# Main loop
# ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rx', default='/tmp/emu-rx.log')
    ap.add_argument('--tx', default='/tmp/emu-tx.log')
    ap.add_argument('--threshold', type=float, default=DEFAULT_OFFLINE_THRESHOLD,
                    help='Seconds without a TX reply before address is OFFLINE')
    args = ap.parse_args()

    states = {}
    rx_fh = open_tail(args.rx)
    tx_fh = open_tail(args.tx)
    start_ts = time.time()
    last_render = 0.0

    sys.stdout.write(HIDE_CURSOR)
    try:
        while True:
            # Try to reopen if missing
            if rx_fh is None and os.path.exists(args.rx):
                rx_fh = open_tail(args.rx)
            if tx_fh is None and os.path.exists(args.tx):
                tx_fh = open_tail(args.tx)

            # Drain available lines
            saw_new = False
            if rx_fh:
                while True:
                    line = rx_fh.readline()
                    if not line: break
                    saw_new = True
                    m = RE_RX.search(line)
                    if m:
                        addr = int(m.group(1))
                        cmd = int(m.group(2), 16)
                        if addr not in states: states[addr] = AddrState(addr)
                        states[addr].on_rx(time.time(), cmd)

            if tx_fh:
                while True:
                    line = tx_fh.readline()
                    if not line: break
                    saw_new = True
                    m = RE_TX.search(line)
                    if m:
                        addr = int(m.group(1))
                        cmd = int(m.group(2), 16)
                        if addr not in states: states[addr] = AddrState(addr)
                        states[addr].on_tx(time.time(), cmd)

            # Render at most every REFRESH_SEC
            now = time.time()
            if now - last_render >= REFRESH_SEC:
                render(states, args.threshold, start_ts)
                last_render = now

            time.sleep(0.05)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW_CURSOR + '\n')


if __name__ == '__main__':
    main()
