#!/usr/bin/env bash
# present-card.sh -- CMD credential injector for the Aether OSDP emulator.
# Talks to the running server's HTTP API; does NOT open the serial port,
# so it never contends with the server.
set -euo pipefail
API="${OSDP_API:-http://localhost:3001}"
GOOD_FC=123 ; GOOD_CARD=45678
BAD_FC=123  ; BAD_CARD=45679
DEFAULT_TARGETS=( "/dev/ttyAMA0|0" "/dev/ttyACM1|0" )
die(){ echo "ERROR: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "missing dependency: curl"

resolve_reader_id(){
  local want_port="$1" want_addr="$2" json
  json="$(curl -fsS "$API/api/osdp/readers" 2>/dev/null)" || die "cannot reach server at $API (is it running?)"
  if command -v jq >/dev/null 2>&1; then
    local rid
    rid="$(jq -r --arg p "$want_port" --argjson a "$want_addr" '
      (.readers // .data // .) as $r
      | ($r[]? | select(((.port // .serialPort // "")==$p) and ((.address // .addr // -1)==$a)) | (.id // .readerId))' <<<"$json" 2>/dev/null | head -1)"
    [ -n "${rid:-}" ] && [ "$rid" != "null" ] && { echo "$rid"; return 0; }
    rid="$(jq -r --argjson a "$want_addr" '
      (.readers // .data // .) as $r
      | ($r[]? | select((.address // .addr // -1)==$a) | (.id // .readerId))' <<<"$json" 2>/dev/null | head -1)"
    [ -n "${rid:-}" ] && [ "$rid" != "null" ] && { echo "$rid"; return 0; }
  fi
  echo "osdp-reader-$((want_addr + 1))"
}
send_one(){
  local rid="$1" fc="$2" card="$3" payload resp
  payload=$(printf '{"readerId":"%s","format":"wiegand26","facility":%s,"card":%s}' "$rid" "$fc" "$card")
  resp="$(curl -fsS -X POST "$API/api/osdp/card-read" -H 'Content-Type: application/json' -d "$payload" 2>/dev/null)" || die "card-read request failed for reader '$rid'"
  echo "  -> reader='$rid'  FC=$fc card=$card  :: $resp"
}
cmd_list(){ curl -fsS "$API/api/osdp/readers" | { command -v jq >/dev/null 2>&1 && jq . || cat; }; }

[ $# -ge 1 ] || { echo "usage: $0 good|bad|card <fc> <num>|list  [--port DEV] [--addr N]"; exit 1; }
ACTION="$1"; shift || true
CLI_PORT="" ; CLI_ADDR="" ; FC="" ; CARD=""
case "$ACTION" in
  good) FC=$GOOD_FC ; CARD=$GOOD_CARD ;;
  bad)  FC=$BAD_FC  ; CARD=$BAD_CARD ;;
  card) FC="${1:?usage: card <fc> <num>}"; CARD="${2:?usage: card <fc> <num>}"; shift 2 || true ;;
  list) cmd_list; exit 0 ;;
  -h|--help|help) echo "usage: $0 good|bad|card <fc> <num>|list [--port DEV] [--addr N]"; exit 0 ;;
  *) die "unknown action '$ACTION'" ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --port) CLI_PORT="${2:?}"; shift 2 ;;
    --addr) CLI_ADDR="${2:?}"; shift 2 ;;
    *) die "unknown option '$1'" ;;
  esac
done
echo "[present-card] action=$ACTION FC=$FC card=$CARD api=$API"
if [ -n "$CLI_PORT" ] || [ -n "$CLI_ADDR" ]; then
  P="${CLI_PORT:-/dev/ttyAMA0}" ; A="${CLI_ADDR:-0}"
  RID="$(resolve_reader_id "$P" "$A")" ; echo "[present-card] target port=$P addr=$A"
  send_one "$RID" "$FC" "$CARD"
else
  for t in "${DEFAULT_TARGETS[@]}"; do
    P="${t%%|*}" ; A="${t##*|}"
    RID="$(resolve_reader_id "$P" "$A")" ; echo "[present-card] target port=$P addr=$A"
    send_one "$RID" "$FC" "$CARD"
  done
fi
echo "[present-card] done."
