#!/usr/bin/env bash
# Aether VMS stream capture.
#
# Started by mediamtx (runOnDemand) when a VMS connects; mediamtx sends SIGINT
# when the last viewer has been gone for runOnDemandCloseAfter.
#
#   Xvfb (virtual screen) -> Chromium kiosk on the Stream View -> ffmpeg x11grab
#   -> H.264 -> rtsp://127.0.0.1:8554/<path>
#
# Settings come from /etc/aether-stream.conf (see install.sh); env vars win.

set -u
[ -f /etc/aether-stream.conf ] && . /etc/aether-stream.conf

STREAM_PAGE="${STREAM_PAGE:-http://127.0.0.1:3001/stream}"
WIDTH="${WIDTH:-1920}"
HEIGHT="${HEIGHT:-1080}"
FPS="${FPS:-2}"                 # status wall: 2 fps is plenty and keeps CPU low
BITRATE="${BITRATE:-400k}"      # ceiling; mostly-static frames come in well under
ENCODER="${ENCODER:-x264}"      # x264 | hw (Pi 4 h264_v4l2m2m)
DISPLAY_NUM="${DISPLAY_NUM:-99}"
TARGET="rtsp://127.0.0.1:${RTSP_PORT:-8554}/${MTX_PATH:-aether}"
PROFILE_DIR="${PROFILE_DIR:-/tmp/aether-stream-chromium}"

log() { echo "[aether-stream] $*" >&2; }

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null; done
  # Chromium helpers (renderer, zygote) outlive a killed parent; they all carry the profile dir
  pkill -9 -f -- "--user-data-dir=$PROFILE_DIR" 2>/dev/null
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# ---- browser binary ----
BROWSER=""
for b in chromium chromium-browser google-chrome; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
[ -z "$BROWSER" ] && { log "Chromium not found (apt install chromium)"; exit 1; }

# ---- virtual screen ----
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null
Xvfb ":${DISPLAY_NUM}" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp -nocursor >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break; sleep 0.1; done
export DISPLAY=":${DISPLAY_NUM}"

# ---- browser (flags trimmed for a small, single-page renderer) ----
mkdir -p "$PROFILE_DIR"
EXTRA=()
[ "$(id -u)" = 0 ] && EXTRA+=(--no-sandbox)   # Chromium refuses to run as root otherwise
# capture=<fps> tells the page to step its animations at the capture rate
case "$STREAM_PAGE" in *\?*) PAGE_URL="${STREAM_PAGE}&capture=${FPS}" ;; *) PAGE_URL="${STREAM_PAGE}?capture=${FPS}" ;; esac
"$BROWSER" "${EXTRA[@]}" \
  --kiosk --app="$PAGE_URL" \
  --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 --force-device-scale-factor=1 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run --no-default-browser-check --noerrdialogs --disable-infobars \
  --disable-gpu \
  --disable-extensions --disable-sync --disable-translate --disable-default-apps \
  --disable-background-networking --disable-component-update --disable-client-side-phishing-detection \
  --disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,SafeBrowsing,SignInProfileCreation,ChromeWhatsNewUI,PrivacySandboxSettings4 \
  --disable-dev-shm-usage --renderer-process-limit=1 --mute-audio \
  --in-process-gpu --disable-site-isolation-trials --js-flags=--max-old-space-size=128 \
  --no-pings --disable-domain-reliability --disable-breakpad --disable-crash-reporter \
  --metrics-recording-only --safebrowsing-disable-auto-update --disable-sync-preferences \
  --password-store=basic --hide-scrollbars \
  >/dev/null 2>&1 &
PIDS+=($!)

# Give the page time to load and paint real data before the first frame goes out
sleep "${WARMUP_SECONDS:-6}"

# ---- encoder ----
GOP=$(( FPS * 2 ))                       # keyframe every 2 s so VMS tiles open quickly
[ "$GOP" -lt 2 ] && GOP=2
if [ "$ENCODER" = "hw" ] && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_v4l2m2m; then
  VCODEC=(-c:v h264_v4l2m2m -b:v "$BITRATE" -g "$GOP" -pix_fmt yuv420p)
  log "encoder: h264_v4l2m2m (hardware)"
else
  VCODEC=(-c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -bf 0
          -g "$GOP" -keyint_min "$GOP" -sc_threshold 0
          -crf 30 -maxrate "$BITRATE" -bufsize "$BITRATE" -pix_fmt yuv420p -threads 1)
  log "encoder: libx264"
fi

log "capturing $PAGE_URL at ${WIDTH}x${HEIGHT} ${FPS}fps -> $TARGET"
ffmpeg -hide_banner -loglevel warning -nostdin \
  -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i "${DISPLAY}.0" \
  "${VCODEC[@]}" -an \
  -f rtsp -rtsp_transport tcp "$TARGET" &
FFMPEG_PID=$!
PIDS+=($FFMPEG_PID)
wait "$FFMPEG_PID"
log "ffmpeg exited ($?)"
