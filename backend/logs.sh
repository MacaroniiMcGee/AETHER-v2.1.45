#!/bin/bash
# logs.sh — View and filter access control server logs
# Usage:
#   bash logs.sh              # Live tail all logs
#   bash logs.sh error        # Filter errors only
#   bash logs.sh i2c          # Filter I2C events
#   bash logs.sh crash        # Show last 100 lines (post-crash review)
#   bash logs.sh watchdog     # Filter watchdog events
#   bash logs.sh relay        # Filter relay/IOplus events

LOG_FILE="/var/log/accesscontrol/server.log"

if [ ! -f "$LOG_FILE" ]; then
    echo "Log file not found: $LOG_FILE"
    echo "Is the service running? Try: sudo systemctl start accesscontrol"
    exit 1
fi

case "$1" in
  crash|last)
    echo "=== Last 100 lines ==="
    tail -n 100 "$LOG_FILE"
    echo ""
    echo "=== Errors & I2C failures in last 200 lines ==="
    tail -n 200 "$LOG_FILE" | grep -E --color=always "failed|error|CRITICAL|recovery|lockup|Watchdog|I2C|timeout" -i
    ;;
  "")
    echo "Watching $LOG_FILE (Ctrl+C to stop)"
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "Filtering for: $1 (Ctrl+C to stop)"
    tail -f "$LOG_FILE" | grep --color=always -i "$1"
    ;;
esac
