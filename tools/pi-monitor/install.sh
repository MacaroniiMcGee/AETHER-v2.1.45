#!/usr/bin/env bash
# Install the Aether Pi monitor (samples every 30 s, independent of the backend).
#   sudo ./install.sh              install / update
#   sudo ./install.sh --uninstall
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST=/opt/aether-monitor
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found"; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now aether-monitor.timer 2>/dev/null || true
  rm -f /etc/systemd/system/aether-monitor.{service,timer} /usr/local/bin/aether-diag /usr/local/bin/aether-monitor
  systemctl daemon-reload; rm -rf "$DEST"
  echo "Removed. Logs kept in /var/log/aether-monitor"; exit 0
fi

mkdir -p "$DEST" /var/log/aether-monitor
install -m 0755 "$HERE/aether-monitor.js" "$DEST/aether-monitor.js"
DUMPS="$REPO/backend/logs/i2c"

cat > "$DEST/env" <<EOF
AETHER_BACKEND=http://127.0.0.1:3001
AETHER_I2C_DUMPS=$DUMPS
EOF

# command wrappers
cat > /usr/local/bin/aether-monitor <<EOF
#!/usr/bin/env bash
set -a; . $DEST/env; set +a
exec $NODE_BIN $DEST/aether-monitor.js "\$@"
EOF
cat > /usr/local/bin/aether-diag <<EOF
#!/usr/bin/env bash
set -a; . $DEST/env; set +a
exec $NODE_BIN $DEST/aether-monitor.js report "\$@"
EOF
chmod 0755 /usr/local/bin/aether-monitor /usr/local/bin/aether-diag

cat > /etc/systemd/system/aether-monitor.service <<EOF
[Unit]
Description=Aether Pi monitor sample

[Service]
Type=oneshot
EnvironmentFile=$DEST/env
ExecStart=$NODE_BIN $DEST/aether-monitor.js sample
Nice=15
IOSchedulingClass=idle
EOF

cat > /etc/systemd/system/aether-monitor.timer <<EOF
[Unit]
Description=Aether Pi monitor every 30 s

[Timer]
OnBootSec=20s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now aether-monitor.timer >/dev/null
systemctl start aether-monitor.service
echo "Aether monitor installed. Samples every 30 s to /var/log/aether-monitor/"
echo "  Report:   aether-diag            (last 24 h)   aether-diag 2   (last 2 h)"
echo "  Lock-ups: aether-diag --lockups"
