#!/bin/bash
API=http://localhost:3001
PORT=ttyACM0
ADDR=0
BAUD=9600
BIN=/home/aether/Desktop/Aether/M1.2.2/backend/osdp_console-stable/fw/4-2-3/CWL1_V_04_02_03_0_app_update.bin

hr() { printf '\n\033[1;36m── %s ───────────────────────\033[0m\n' "$1"; }

hr "1. Scan ${PORT} addresses 0-15"
curl -s -X POST "$API/api/osdp/firmware-scan" \
  -H 'Content-Type: application/json' \
  -d "{\"port\":\"$PORT\",\"baud\":$BAUD,\"fromAddr\":0,\"toAddr\":15}" \
  | jq '{success, port, baud, replyCount, replies: [.results[] | select(.replied) | {address, replyCode, replyName}]}'

hr "2. Identify reader at addr ${ADDR}"
curl -s -X POST "$API/api/osdp/firmware-identify" \
  -H 'Content-Type: application/json' \
  -d "{\"port\":\"$PORT\",\"baud\":$BAUD,\"address\":$ADDR}" \
  | jq '{success, vendorName, modelNumber, firmwareString, serialHex, supportsFiletransfer, supportsSecureChannel, scbkConfigured, error}'

hr "3. List firmware library (before upload)"
curl -s "$API/api/osdp/firmware-library" | jq '{success, count: (.entries | length), entries: [.entries[] | {id, filename, model, version, sizeBytes}]}'

hr "4. Add a .bin to the library"
if [ -f "$BIN" ]; then
  curl -s -X POST "$API/api/osdp/firmware-library" \
    -F "firmware=@${BIN}" \
    -F 'metadata={"model":"WaveLynx CWL1","version":"v04.02.03","notes":"sample bin"}' \
    | jq '{success, entry: (.entry // null), error}'
else
  echo "  Skipping — file not found: $BIN"
fi

hr "5. List library again"
curl -s "$API/api/osdp/firmware-library" | jq '{count: (.entries | length), entries: [.entries[] | {id, filename, model, version, sizeBytes}]}'

hr "6. View upload history"
curl -s "$API/api/osdp/firmware-history?limit=5" | jq '{success, total, entries: [.entries[] | {result, ts, reader, port, address, filename}]}'

echo
echo "Done."
