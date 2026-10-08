#!/usr/bin/env bash
# Install the Aether VMS stream on this Pi.
#
#   sudo ./install.sh              install / update
#   sudo ./install.sh --skip-build don't rebuild the frontend
#   sudo ./install.sh --uninstall  remove the service (keeps /etc/aether-stream.conf)
#
# Result: rtsp://<this-pi>:8554/aether, captured on demand only.

set -euo pipefail

MTX_VERSION="${MTX_VERSION:-v1.21.1}"
INSTALL_DIR=/opt/aether-stream
CONF=/etc/aether-stream.conf
UNIT=/etc/systemd/system/aether-stream.service
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$HERE/.." && pwd)"
SKIP_BUILD=0

say()  { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0"; exit 1; }

for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    --uninstall)
      systemctl disable --now aether-stream 2>/dev/null || true
      rm -f "$UNIT"; systemctl daemon-reload
      rm -rf "$INSTALL_DIR"
      say "Removed aether-stream service. $CONF left in place."
      exit 0 ;;
  esac
done

# ---- packages ----
say "Installing Xvfb, ffmpeg, Chromium"
apt-get update -qq
apt-get install -y -qq --no-install-recommends xvfb ffmpeg fonts-dejavu-core >/dev/null
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  apt-get install -y -qq --no-install-recommends chromium >/dev/null 2>&1 \
    || apt-get install -y -qq --no-install-recommends chromium-browser >/dev/null
fi

# ---- mediamtx ----
mkdir -p "$INSTALL_DIR"
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  armv7l)        ARCH=armv7 ;;
  armv6l)        ARCH=armv6 ;;
  x86_64)        ARCH=amd64 ;;
  *) echo "Unsupported CPU $(uname -m)"; exit 1 ;;
esac
if [ ! -x "$INSTALL_DIR/mediamtx" ] || [ "${MTX_UPGRADE:-0}" = 1 ]; then
  URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_${ARCH}.tar.gz"
  say "Downloading mediamtx ${MTX_VERSION} (${ARCH})"
  TMP="$(mktemp -d)"
  if curl -fsSL "$URL" -o "$TMP/mtx.tgz" && tar -xzf "$TMP/mtx.tgz" -C "$TMP" mediamtx; then
    install -m 0755 "$TMP/mediamtx" "$INSTALL_DIR/mediamtx"
  else
    # Offline: reuse a binary already on the Pi (e.g. the old onvif-streaming folder)
    OLD="$(find "$RUN_HOME" -maxdepth 5 -type f -name mediamtx -perm -u+x 2>/dev/null | head -1 || true)"
    [ -n "$OLD" ] || { echo "Could not download mediamtx and none found under $RUN_HOME"; exit 1; }
    warn "Download failed; using existing $OLD"
    install -m 0755 "$OLD" "$INSTALL_DIR/mediamtx"
  fi
  rm -rf "$TMP"
fi
install -m 0644 "$HERE/mediamtx.yml" "$INSTALL_DIR/mediamtx.yml"
install -m 0755 "$HERE/capture.sh" "$INSTALL_DIR/capture.sh"

# ---- settings (kept across updates) ----
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<'EOF'
# Aether VMS stream settings. Restart after editing: sudo systemctl restart aether-stream
STREAM_PAGE=http://127.0.0.1:3001/stream   # served by the Aether backend from frontend/dist
WIDTH=1920
HEIGHT=1080
FPS=2            # 1-5. Each step up costs CPU; 2 is enough for door/alarm status
BITRATE=400k     # ceiling. Static frames use far less
ENCODER=x264     # x264, or hw on a Pi 4 (h264_v4l2m2m). Pi 5 has no H.264 encoder
WARMUP_SECONDS=6 # page load time before the first frame
EOF
  say "Wrote $CONF"
fi

# ---- frontend build (the page Chromium captures) ----
if [ "$SKIP_BUILD" = 0 ] && [ -f "$REPO_DIR/frontend/package.json" ]; then
  say "Building frontend (served by the backend at /stream)"
  sudo -u "$RUN_USER" bash -c "cd '$REPO_DIR/frontend' && npm install --no-audit --no-fund --silent && npm run build --silent" \
    || warn "Frontend build failed; the stream will show an error page until it's built"
fi

# ---- retire the old onvif-streaming processes ----
pkill -f onvif_server.py 2>/dev/null || true
pkill -f stream_dashboard.py 2>/dev/null || true

# ---- service ----
cat > "$UNIT" <<EOF
[Unit]
Description=Aether VMS RTSP stream (captures on demand)
After=network-online.target aether-backend.service accesscontrol.service
Wants=network-online.target

[Service]
User=$RUN_USER
Environment=HOME=$RUN_HOME
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/mediamtx $INSTALL_DIR/mediamtx.yml
Restart=on-failure
RestartSec=5
# Access control I/O always wins over the video stream
Nice=10
IOSchedulingClass=idle
CPUWeight=20

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now aether-stream >/dev/null
systemctl restart aether-stream

IP="$(hostname -I | awk '{print $1}')"
say "Done."
echo
echo "  RTSP URL:  rtsp://${IP}:8554/aether"
echo "  (old URL rtsp://${IP}:8554/live still works)"
echo
echo "  Nothing is captured until a VMS connects. First connect takes ~8 s."
echo "  Test:      ffprobe rtsp://${IP}:8554/aether"
echo "  Logs:      journalctl -u aether-stream -f"
echo "  Settings:  $CONF"
echo
echo "  Also restart the backend so it serves /stream and /api/vms:"
echo "             sudo systemctl restart aether-backend"
