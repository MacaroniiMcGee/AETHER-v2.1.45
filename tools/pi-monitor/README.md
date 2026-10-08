# I2C / HAT lock-up monitoring

The IOplus HAT is a microcontroller on the Pi's I2C bus. It can wedge (and need
a power cycle) when two I2C transactions overlap, when it's hammered with
commands, or when the Pi's 5 V supply sags.

## What changed in the backend

- **One gate for the bus** (`backend/lib/i2cBus.js`). Every `ioplus` call in the
  backend (GPIO queue, supervision/EOL zone reads) goes through it, one at a
  time, with a short settle gap and a hard timeout. Before this, supervision
  ADC reads ran the CLI directly and could overlap relay/input commands; in a
  simulation that happened on 22 of 40 calls.
- **Less bus traffic from the VMS stream.** Supervision status and the full
  relay/input scan are now shared between viewers (one scan serves everyone for
  5 s / 3 s). The Stream View reads zones every 15 s and does the full I/O scan
  every 2 min.
- **Flight recorder.** The last 1000 bus calls are kept in memory with who made
  them (source + HTTP route + whether it came from the stream), how long they
  waited, how long they took, and the result. After 3 failures in a row, or
  when the GPIO queue declares a lock-up, it writes
  `backend/logs/i2c/lockup-<time>.json` with those calls plus a Pi snapshot
  (under-voltage/throttle flags, temperature, load, memory, kernel I2C messages).

API:

| | |
|---|---|
| `GET /api/i2c/diag` | bus stats by source and by route, queue state, Pi power/thermal, warnings |
| `GET /api/i2c/recent?n=200` | last N bus calls |
| `GET /api/i2c/dumps` / `/api/i2c/dumps/<name>` | saved lock-up dumps |
| `POST /api/i2c/dump` | save one now |

## Root cause found (Sept 2026): HAT firmware

The lock-ups (bus stuck with SDA and SCL both held low, only a power cycle
recovers it) were a **firmware problem on the IOplus HAT**. They were fixed by
updating from **01.36 to 01.38**. Tested on hw 04.00 and a Pi 5:

| Test | 01.36 | 01.38 |
|---|---|---|
| back-to-back `optrd` reads | hung after 740 | — |
| real use, relay clicking, 100 ms gap enforced | hung on `relwr 2 0` after 438 ms idle | — |
| `relwr` ramp, 200 ms down to no gap (5,400 writes) | — | no failures |
| random mix of `relwr`/`relrd`/`optrd`/`adcrd`, no gap, 5 min (~30,000 ops) | — | no failures |

**Every IOplus HAT must be on 01.38 or later.** Check with `ioplus 0 board`.
To update, stop the backend and disconnect the relay outputs, then:

```bash
git clone https://github.com/SequentMicrosystems/ioplus-rpi.git   # or: git pull
cd ioplus-rpi/update && sudo ./update64 0     # 64-bit OS; type yes (no quotes)
```

Don't power off until it prints `Done`.

The backend still keeps a gap between HAT calls as a safety margin. The default
is 100 ms; on 01.38, 30 ms is plenty:
`/etc/systemd/system/aether-backend.service.d/i2c-gap.conf` →
`[Service]` / `Environment=I2C_MIN_GAP_MS=30`. It also reads all 8 inputs, or all
8 relays, in one call (`optrd` / `relrd` with no channel) and shares the result.
`GET /api/i2c/bulk` shows that state, and `I2C_BULK=0` turns it off.

Anything that runs `ioplus` by hand while the backend is up should go through
the same lock: `flock /tmp/aether-i2c.lock ioplus 0 optrd`.

Also: with the VMS stream running, the Pi 5 reached 84 °C. Fit the active
cooler or a heatsink.

## Pi monitor (independent of the backend)

```bash
cd tools/pi-monitor
sudo ./install.sh
```

Every 30 s it records: under-voltage/throttle flags, CPU temp, load, memory, top
CPU processes, whether the VMS capture is running, the backend's I2C stats, and
new kernel I2C / under-voltage messages. Logs: `/var/log/aether-monitor/` (14 days).
It never touches the I2C bus.

```bash
aether-diag            # report, last 24 h
aether-diag 2          # last 2 h
aether-diag --lockups  # every saved lock-up: first failing command, what hit the bus in the minute before, Pi state
```

## When it locks up

1. Before power cycling, if you can still reach the Pi:
   `curl -s -X POST localhost:3001/api/i2c/dump` then `aether-diag 1`
2. Power cycle.
3. `aether-diag --lockups` and `aether-diag 6`. Things to look for:
   - **under-voltage** in the samples or dump → power supply. Use the official
     5.1 V / 3 A (Pi 4) or 5 A (Pi 5) supply; the stream adds current draw.
   - **busy % / calls per min** climbing before the failure, and which route → too much polling.
   - **stream capture running** every time it fails → try `FPS=2`, or stop the stream to compare.
   - a **single command that times out** first → note it; it may be a specific operation the HAT dislikes.

`PN532` NFC (`ENABLE_PN532=1`) runs on the same I2C bus from a separate Python
process and can't be gated here. If it's enabled, `/api/i2c/diag` warns about it.
