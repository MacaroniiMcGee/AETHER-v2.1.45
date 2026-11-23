#!/bin/bash
# Update TRACE-2: Event Trace — cards, DPS/REX inputs, strike/outputs and OnCAFE commands, traced end to end
#
# Adds (or upgrades to) Tools › Event Trace (/api/trace). Installs fresh or over TRACE-1. New files under backend/trace, backend/routes/trace.js and
# frontend/src/components/trace; small marked inserts (AETHER_TRACE) in server.js, routes-oncafe.js,
# routes/traffic.js, analytics/journal.js and ConfigSection.tsx. Re-running is safe.
# Steps: landmark check (nothing changes if one is missing) → copy → wire in → node --check → backend
# self-test on a copy → frontend build (npm run build into dist.new, swapped in) → restart aether-backend.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HOME/Desktop/Aether/M1.2.2}"
cd "$DIR" || { echo "Not found: $DIR"; exit 1; }
OWNER="$(stat -c %U "$DIR")"
if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ]; then AS=(runuser -u "$OWNER" --); else AS=(); fi
TMP="$(mktemp -d)"
BK="$TMP/backup"; CHANGED=""
# On any failure after files were touched, put back the files this update edits (new trace files stay, unused).
EDITED="backend/server.js backend/routes-oncafe.js backend/routes/traffic.js backend/analytics/journal.js frontend/src/components/ConfigSection.tsx .gitignore"
restore() { for f in $EDITED; do [ -f "$BK/$f" ] && cat "$BK/$f" > "$DIR/$f"; done; echo "  restored     $EDITED"; }   # contents only: owners and folders stay as they were
trap 'rc=$?; if [ $rc -ne 0 ] && [ -n "$CHANGED" ]; then restore; fi; rm -rf "$TMP"' EXIT

echo "Event Trace (TRACE-2) into $DIR as $(id -un)${AS:+ (building as $OWNER)}"
for f in backend/server.js backend/routes-oncafe.js frontend/src/components/ConfigSection.tsx backend/analytics/journal.js; do
  [ -f "$f" ] || { echo "  FAILED  $f is missing — this Aether is older than Event Trace needs (Log Analytics + OnCAFE sign-in). Nothing changed."; exit 1; }
done
if ! python3 "$HERE/integrate_trace.py" "$DIR" --check > "$TMP/check.log" 2>&1; then
  echo "  FAILED  landmark check — nothing changed:"; sed 's/^/      /' "$TMP/check.log"; exit 1
fi

# 1. files (back up what gets edited first)
for f in $EDITED; do [ -f "$f" ] && { mkdir -p "$BK/$(dirname "$f")"; cp "$f" "$BK/$f"; }; done
CHANGED=1
cp -r "$HERE/files/." "$DIR/"
[ ${#AS[@]} -gt 0 ] && chown -R "$OWNER:" backend/trace backend/routes/trace.js backend/tests/trace.test.js frontend/src/components/trace 2>/dev/null
echo "  copied       backend/trace, routes/trace.js, components/trace"

# 2. wire in (idempotent: says "ok … already there" on a re-run)
python3 "$HERE/integrate_trace.py" "$DIR" | sed 's/^/  /' || { echo "  FAILED  wiring in"; exit 1; }
grep -q '^backend/data/trace/' .gitignore 2>/dev/null || { printf '\n# Event Trace runs (original payloads in vault.jsonl)\nbackend/data/trace/\n' >> .gitignore; echo "  .gitignore   backend/data/trace/"; }

# 3. syntax
for f in backend/server.js backend/routes-oncafe.js backend/routes/trace.js backend/analytics/journal.js backend/trace/*.js; do
  node --check "$f" 2>"$TMP/node.log" || { echo "  FAILED  node --check $f"; sed 's/^/      /' "$TMP/node.log"; exit 1; }
done
[ -f backend/routes/traffic.js ] && { node --check backend/routes/traffic.js || { echo "  FAILED  node --check backend/routes/traffic.js"; exit 1; }; }
echo "  syntax       ok"

# 4. backend self-test on a copy (mock OnCAFE + MQTT broker on 127.0.0.1; writes nothing in the Aether folder)
T="$TMP/selftest"; mkdir -p "$T/data"
cp -r backend/trace backend/routes backend/analytics backend/tests backend/routes-oncafe.js "$T/"
if (cd "$T" && NODE_PATH="$DIR/backend/node_modules" timeout 120 node tests/trace.test.js > "$TMP/test.log" 2>&1); then
  echo "  self-test    $(tail -1 "$TMP/test.log")"
else
  echo "  FAILED  backend self-test:"; tail -25 "$TMP/test.log" | sed 's/^/      /'; exit 1
fi

# 5. pages: npm run build into dist.new as the folder owner, then swap (a root-owned dist is moved aside, not deleted)
cd frontend
[ ${#AS[@]} -gt 0 ] && chown -R "$OWNER:" node_modules/.vite node_modules/.vite-temp 2>/dev/null   # left root-owned by an earlier root build
"${AS[@]}" npx vite build --outDir dist.new --emptyOutDir > "$TMP/build.log" 2>&1 || { echo "  FAILED  frontend build:"; tail -20 "$TMP/build.log" | sed 's/^/      /'; rm -rf dist.new; exit 1; }
if [ -d dist ]; then
  OLD=dist.old
  if [ -e "$OLD" ] && ! rm -rf "$OLD" 2>/dev/null; then OLD="dist.old.$(date +%s)"; fi
  mv -T dist "$OLD" || { echo "  FAILED  could not move frontend/dist aside (pages unchanged)"; rm -rf dist.new; exit 1; }
  rm -rf "$OLD" 2>/dev/null || echo "  note         left frontend/$OLD (owned by another user; delete it as root when convenient)"
fi
mv -T dist.new dist || { echo "  FAILED  could not put the new pages in place"; exit 1; }
cd "$DIR"
echo "  pages        built"

# 6. backend
sudo -n systemctl restart aether-backend && echo "  restarted    aether-backend" || echo "  note         restart aether-backend yourself (sudo systemctl restart aether-backend)"
echo "Done. Open Tools › Event Trace (Ctrl+Shift+R first). Setup: OnCAFE (controllers + doors), Wiring (relays / opto inputs), Sync markers; Commands stay off until an admin turns them on."
