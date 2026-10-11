# Aether VMS Stream (RTSP)

Puts the Aether **Stream View** (doors, elevator, I/O, OSDP traffic, events) into a
VMS as an ordinary camera. RTSP only; no ONVIF, HLS or WebRTC.

```
VMS ──RTSP──▶ mediamtx :8554/aether ──(on first viewer)──▶ capture.sh
                                                            Xvfb → Chromium /stream → ffmpeg H.264
```

- **On demand.** Nothing runs until a VMS connects. 30 s after the last viewer
  leaves, the capture stops and the browser is closed.
- **Small stream.** 1920×1080, 2 fps, keyframe every 2 s, H.264 Constrained
  Baseline, no B-frames, ≤400 kbps. Opens fast in a VMS tile.
- **Low priority.** The service runs at `nice 10` with idle I/O, so access-control
  I/O always wins.

Measured in testing while streaming (x86, 2 cores): ~14 % of one core in total
(Chromium ~11 %, ffmpeg ~3 %) and ~580 MB RAM, almost all Chromium. Expect
roughly 2–4× the CPU on a Pi 4. Idle cost: mediamtx only (~20 MB, ~0 % CPU).

## Install (on the Pi)

From the Aether folder the backend runs from (the one containing `backend/` and `frontend/`):

```bash
cd streaming
sudo ./install.sh
sudo systemctl restart aether-backend     # backend now serves /stream and /api/vms
```

The installer:
1. installs `xvfb ffmpeg chromium`
2. downloads mediamtx v1.21.1 for this CPU (or reuses an existing binary if offline)
3. builds the frontend so the backend can serve `http://127.0.0.1:3001/stream`
4. stops the old `onvif_server.py` / `stream_dashboard.py` if they're running
5. installs and starts the `aether-stream` systemd service

Check it: `ffprobe rtsp://<pi-ip>:8554/aether` (first connect takes ~8 s while Chromium loads).

The old URL `rtsp://<pi-ip>:8554/live` still works, so existing VMS entries keep going.

## Add it to a VMS

URL: **`rtsp://<pi-ip>:8554/aether`**, no username/password, TCP transport.

| VMS | How |
|---|---|
| **Hanwha Wave** | Add Device → paste the RTSP URL in the address field → leave credentials blank. |
| **Genetec Security Center** | Config Tool → add a Video unit → manufacturer *RTSP* (generic) → IP of the Pi, port 8554, path `/aether`. |
| **Milestone XProtect** | Management Client → Add hardware → Manual → driver *Universal 1 channel* → IP of the Pi; on the camera, set RTSP port 8554 and path `aether`, transport RTP/RTSP/TCP. |

Menu names vary slightly between VMS versions. If a VMS insists on a frame rate
above 2 fps for its generic driver, raise `FPS` (see below).

In the Aether UI, **Tools → VMS Stream** shows the URL, whether the stream is
running, how many viewers are connected, and a live preview.

## Settings

`/etc/aether-stream.conf`, then `sudo systemctl restart aether-stream`:

| Setting | Default | Notes |
|---|---|---|
| `FPS` | `2` | 1–5. CPU scales with it. |
| `BITRATE` | `400k` | Ceiling. Static frames use much less. |
| `WIDTH` / `HEIGHT` | `1920` / `1080` | The page is laid out for 1920×1080 and scales to fit. |
| `ENCODER` | `x264` | `hw` uses the Pi 4 hardware encoder (h264_v4l2m2m). Pi 5 has none. |
| `STREAM_PAGE` | `http://127.0.0.1:3001/stream` | Add `?backend=<ip>` to show another unit. |
| `WARMUP_SECONDS` | `6` | Page load time before the first frame. |

## Troubleshooting

```bash
journalctl -u aether-stream -f            # mediamtx + capture log
curl -s localhost:3001/api/vms/stream-status
curl -sI localhost:3001/stream            # 200 = backend is serving the built page
```

- **VMS connects but shows black:** the page didn't load. Check `/stream` above;
  rebuild with `cd frontend && npm run build`, then `sudo systemctl restart aether-backend`.
- **"Backend offline" on the stream:** the page loaded but can't reach `:3001`.
- **Nothing on port 8554:** `systemctl status aether-stream`.

Preview the page without hardware: `http://<pi-ip>:3001/stream?demo=8` (4, 8, 12, 16).

Uninstall: `sudo ./install.sh --uninstall`.
