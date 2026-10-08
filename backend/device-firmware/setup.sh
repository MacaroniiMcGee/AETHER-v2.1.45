#!/bin/bash
# One-time setup for Device firmware (run again after an update changes runner.sh).
#
#   sudo bash backend/device-firmware/setup.sh [service-name]
#
# Installs, all root-owned:
#   /usr/local/lib/aether-fw/runner.sh    the job runner
#   /usr/local/sbin/aether-fw-launch      starts one job in its own systemd unit, as the Aether user
#   /etc/sudoers.d/aether-device-firmware lets the Aether user, without a password, run only that
#                                         launcher and "systemctl restart" for aether-backend and aether-stream
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash $0"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
USERN="$(stat -c %U "$ROOT")"
SERVICE="${1:-aether-backend}"
SYSTEMCTL="$(command -v systemctl)"
command -v systemd-run >/dev/null || { echo "systemd-run not found"; exit 1; }
[ "$USERN" != root ] || { echo "$ROOT is owned by root; expected the Aether user"; exit 1; }
systemctl cat "$SERVICE" >/dev/null 2>&1 || echo "Note: no service named $SERVICE found; restarts will fail until it exists."

echo "Aether folder: $ROOT"
echo "Runs as:       $USERN"
echo "Service:       $SERVICE"

install -d -m 755 /usr/local/lib/aether-fw
install -m 755 -o root -g root "$HERE/runner.sh" /usr/local/lib/aether-fw/runner.sh

cat > /usr/local/sbin/aether-fw-launch.new <<EOF
#!/bin/bash
# Starts one Device firmware job (installed by $HERE/setup.sh)
set -eu
ROOT='$ROOT'
USERN='$USERN'
ID="\${1:-}"
[ "\$ID" = "--check" ] && { echo ok; exit 0; }
[[ "\$ID" =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}\$ ]] || { echo "bad job id" >&2; exit 2; }
JOB="\$ROOT/.device-firmware/jobs/\$ID"
[ -d "\$JOB" ] && [ ! -L "\$JOB" ] || { echo "no such job" >&2; exit 3; }
HOMEDIR="\$(getent passwd "\$USERN" | cut -d: -f6)"
exec systemd-run --quiet --collect --unit="aether-fw-\$ID" \\
  --uid="\$USERN" --gid="\$(id -gn "\$USERN")" \\
  --setenv=HOME="\$HOMEDIR" --setenv=USER="\$USERN" \\
  --setenv=PATH="\$HOMEDIR/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \\
  --property=WorkingDirectory="\$JOB" \\
  /bin/bash /usr/local/lib/aether-fw/runner.sh "\$JOB"
EOF
install -m 755 -o root -g root /usr/local/sbin/aether-fw-launch.new /usr/local/sbin/aether-fw-launch
rm -f /usr/local/sbin/aether-fw-launch.new

S=/etc/sudoers.d/aether-device-firmware
cat > "$S.tmp" <<EOF
# Device firmware page (installed by $HERE/setup.sh)
$USERN ALL=(root) NOPASSWD: /usr/local/sbin/aether-fw-launch, \\
  $SYSTEMCTL restart $SERVICE, $SYSTEMCTL restart $SERVICE.service, $SYSTEMCTL reset-failed $SERVICE, \\
  $SYSTEMCTL restart aether-stream, $SYSTEMCTL restart aether-stream.service
EOF
chmod 440 "$S.tmp"
visudo -cf "$S.tmp" >/dev/null || { rm -f "$S.tmp"; echo "sudoers check failed; nothing installed for sudo"; exit 1; }
mv -f "$S.tmp" "$S"

install -d -o "$USERN" -g "$(id -gn "$USERN")" "$ROOT/.device-firmware" "$ROOT/.device-firmware/jobs" "$ROOT/.device-firmware/incoming"
sudo -u "$USERN" sudo -n /usr/local/sbin/aether-fw-launch --check >/dev/null && echo "Device firmware setup done."
