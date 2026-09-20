#!/bin/bash
# install-service.sh
# Run from your backend directory: sudo bash install-service.sh

set -e

BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="/etc/systemd/system/accesscontrol.service"
LOGROTATE_FILE="/etc/logrotate.d/accesscontrol"
LOG_DIR="/var/log/accesscontrol"

echo "========================================"
echo "Aether Access Control — Service Installer"
echo "========================================"
echo "Backend dir : $BACKEND_DIR"
echo "Node path   : $(which node)"
echo ""

# 1. Create log directory
mkdir -p "$LOG_DIR"
chmod 755 "$LOG_DIR"
echo "✓ Log directory: $LOG_DIR"

# 2. Write the systemd service file
cat > "$SERVICE_FILE" << SVCEOF
[Unit]
Description=Aether Access Control Server (M1.2.2)
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=root
WorkingDirectory=$BACKEND_DIR
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/server.log
StandardError=append:$LOG_DIR/server.log
SyslogIdentifier=accesscontrol
ExecStartPre=/bin/mkdir -p $LOG_DIR

[Install]
WantedBy=multi-user.target
SVCEOF

echo "✓ Service file: $SERVICE_FILE"

# 3. Write logrotate config (keeps 7 days, compresses old logs)
cat > "$LOGROTATE_FILE" << ROTEOF
$LOG_DIR/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
ROTEOF

echo "✓ Log rotation: $LOGROTATE_FILE (7 days)"

# 4. Reload systemd and enable/start
systemctl daemon-reload
systemctl enable accesscontrol
echo "✓ Service enabled (auto-starts on boot)"

# 5. Stop any existing node server.js processes
pkill -f "node server.js" 2>/dev/null && echo "✓ Stopped existing server" || true
sleep 1

# 6. Start the service
systemctl start accesscontrol
sleep 2

# 7. Show status
echo ""
echo "========================================"
STATUS=$(systemctl is-active accesscontrol)
if [ "$STATUS" = "active" ]; then
    echo "✓ Service is RUNNING"
else
    echo "✗ Service status: $STATUS"
    systemctl status accesscontrol --no-pager
fi
echo ""
echo "Useful commands:"
echo "  sudo systemctl status accesscontrol    # Check status"
echo "  sudo systemctl restart accesscontrol   # Restart"
echo "  sudo systemctl stop accesscontrol      # Stop"
echo "  tail -f $LOG_DIR/server.log            # Watch live logs"
echo "  sudo journalctl -u accesscontrol -f    # Systemd journal"
echo "========================================"
