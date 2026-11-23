#!/bin/bash
# One-time root setup for the Traffic Inspector's gateway mode and packet capture (TRAFFIC-2).
# Run it in a terminal on the Pi, from the Aether folder:
#     sudo bash backend/traffic/setup-root.sh
# It installs tcpdump, copies the small helper backend/traffic/aether-traffic-net to
# /usr/local/sbin, and lets the Aether user run that one file (and nothing else) as root.
# Run it again after an update that changes the helper. Undo: sudo bash setup-root.sh --remove
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ADIR="$(cd "$HERE/../.." && pwd)"
AUSER="${SUDO_USER:-$(stat -c %U "$ADIR")}"

if [ "${1:-}" = "--remove" ]; then
  /usr/local/sbin/aether-traffic-net gw-off 2>/dev/null || true
  /usr/local/sbin/aether-traffic-net pcap-stop 2>/dev/null || true
  rm -f /usr/local/sbin/aether-traffic-net /etc/sudoers.d/aether-traffic /etc/aether-traffic.conf
  echo "Removed the Traffic Inspector root helper."; exit 0
fi

[[ "$AUSER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$AUSER" != root ] || { echo "Could not tell which user runs Aether (got \"$AUSER\"). Run with sudo from that user."; exit 1; }
[[ "$ADIR" =~ ^/[A-Za-z0-9._/\ -]*$ ]] || { echo "Unusual Aether folder path: $ADIR"; exit 1; }
[ -f "$ADIR/backend/server.js" ] || { echo "Not an Aether folder: $ADIR"; exit 1; }

if ! command -v tcpdump >/dev/null; then
  echo "Installing tcpdump…"; apt-get install -y -q tcpdump >/dev/null
fi
command -v iptables >/dev/null || { echo "Installing iptables…"; apt-get install -y -q iptables >/dev/null; }

install -o root -g root -m 0755 "$HERE/aether-traffic-net" /usr/local/sbin/aether-traffic-net
printf 'AETHER_USER=%s\nAETHER_DIR=%s\n' "$AUSER" "$ADIR" > /etc/aether-traffic.conf
chmod 0644 /etc/aether-traffic.conf
TMP="$(mktemp)"
echo "$AUSER ALL=(root) NOPASSWD: /usr/local/sbin/aether-traffic-net" > "$TMP"
visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; echo "sudoers check failed — nothing changed"; exit 1; }
install -o root -g root -m 0440 "$TMP" /etc/sudoers.d/aether-traffic; rm -f "$TMP"
mkdir -p "$ADIR/backend/data/traffic" && chown "$AUSER" "$ADIR/backend/data/traffic"

echo "Done: $AUSER can now use gateway mode and packet capture in Tools › Traffic Inspector."
/usr/local/sbin/aether-traffic-net status
