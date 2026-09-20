#!/bin/bash
# flash-with-progress.sh — upload OSDP firmware with a live ASCII progress bar.
#
# Usage:
#   ./flash-with-progress.sh <path/to/firmware.bin> [port] [baud] [address]
#
# Examples:
#   ./flash-with-progress.sh "/home/aether/Desktop/Bin Files/5.3.1/CHAN1_531_FIRMWARE.bin"
#   ./flash-with-progress.sh ~/fw/v5.bin ttyACM1 9600 1
#
# Requires: curl, jq, an OSDP backend running on $API (default http://localhost:3001)

set -eo pipefail

if [ -z "$1" ]; then
  echo "Usage: $0 <firmware.bin> [port] [baud] [address]"
  echo "Defaults: port=ttyACM0  baud=9600  address=0"
  exit 1
fi

BIN="$1"
PORT="${2:-ttyACM0}"
BAUD="${3:-9600}"
ADDR="${4:-0}"
API="${API:-http://localhost:3001}"
WIDTH=50          # progress-bar width in chars

if [ ! -f "$BIN" ]; then
  echo "Error: file not found: $BIN"
  exit 1
fi

SIZE_BYTES=$(stat -c%s "$BIN")
echo "Source:    $BIN"
echo "Size:      $((SIZE_BYTES / 1024)) KB"
echo "Target:    $PORT @ $BAUD baud, address $ADDR"
echo "Backend:   $API"
echo

# Fire the upload in the background. Curl writes the final JSON response to a
# tempfile so we can show it after the progress bar finishes.
RESP_FILE=$(mktemp)
trap 'rm -f "$RESP_FILE"' EXIT

curl --no-buffer -s -X POST "$API/api/osdp/firmware-upload" \
  -F "firmware=@${BIN}" \
  -F "port=$PORT" \
  -F "baud=$BAUD" \
  -F "address=$ADDR" \
  -o "$RESP_FILE" &
UPLOAD_PID=$!

# Give the server a moment to register the upload before we start polling
sleep 2

# Poll status until the curl process exits
last_line=""
while kill -0 "$UPLOAD_PID" 2>/dev/null; do
  resp=$(curl -s "$API/api/osdp/firmware-status" 2>/dev/null || echo '{}')
  inprog=$(echo "$resp" | jq -r '.inProgress // false' 2>/dev/null || echo "false")

  if [ "$inprog" = "true" ]; then
    pct=$(echo "$resp" | jq -r '.percent // 0')
    frag=$(echo "$resp" | jq -r '.fragment // 0')
    tfrag=$(echo "$resp" | jq -r '.totalFragments // "?"')
    sent=$(echo "$resp" | jq -r '.bytesSent // 0')
    tot=$(echo "$resp" | jq -r '.totalBytes // 0')
    elapsed=$(echo "$resp" | jq -r '.elapsedMs // 0')
    eta=$(echo "$resp" | jq -r '.etaMs // 0')
    phase=$(echo "$resp" | jq -r '.phase // "starting"')
    ftdelay=$(echo "$resp" | jq -r '.ftDelay // 0')

    # Build the bar
    filled=$((pct * WIDTH / 100))
    [ "$filled" -gt "$WIDTH" ] && filled=$WIDTH
    [ "$filled" -lt 0 ] && filled=0
    empty=$((WIDTH - filled))
    bar=""
    [ "$filled" -gt 0 ] && bar=$(printf '%*s' "$filled" '' | tr ' ' '#')
    [ "$empty"  -gt 0 ] && bar+=$(printf '%*s' "$empty"  '' | tr ' ' '-')

    # Times
    es=$((elapsed / 1000)); ee=$((eta / 1000))
    elapsed_str=$(printf "%02d:%02d" $((es / 60)) $((es % 60)))
    if [ "$ee" -gt 0 ]; then
      eta_str=$(printf "%02d:%02d" $((ee / 60)) $((ee % 60)))
    else
      eta_str="--:--"
    fi

    line=$(printf "[%s] %3d%% frag %s/%s  %d/%dKB  elapsed %s  ETA %s  %s(d=%sms)" \
      "$bar" "$pct" "$frag" "$tfrag" "$((sent/1024))" "$((tot/1024))" \
      "$elapsed_str" "$eta_str" "$phase" "$ftdelay")
  else
    line="[Waiting for upload to register on server...] (this is normal for a few seconds)"
  fi

  # Print on a single line, clearing any leftover chars
  printf "\r\033[K%s" "$line"
  last_line="$line"
  sleep 1
done

# curl exited — final result
wait "$UPLOAD_PID" 2>/dev/null || true
echo
echo
echo "=== Result ==="

if [ ! -s "$RESP_FILE" ]; then
  echo "(no response body from server — connection may have dropped)"
  exit 2
fi

# Pretty-print the JSON response
jq '.' < "$RESP_FILE"

# Exit non-zero if the upload failed
success=$(jq -r '.success' < "$RESP_FILE" 2>/dev/null || echo "false")
[ "$success" = "true" ] && exit 0 || exit 1
