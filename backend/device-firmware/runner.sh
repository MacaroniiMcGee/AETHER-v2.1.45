#!/bin/bash
# Device firmware job runner.  runner.sh <job folder>
#
# Started by /usr/local/sbin/aether-fw-launch in its own systemd unit (aether-fw-<id>), as the
# Aether user, so restarting aether-backend doesn't kill it. setup.sh installs a root-owned copy
# of this file to /usr/local/lib/aether-fw/runner.sh; re-run setup.sh after changing it.
#
# Reads job.env (written by routes-device-firmware.js), appends to log.txt, keeps status.json current.
# Modes: bundle (apply.sh or file overlay), file (rebuild/restart after a single-file upload),
#        restore (put a backup back), action (rebuild or restart on its own).
# Any failure after files changed, including a backend that won't come back, restores the backup.

set -u
JOB="${1:?job folder}"
cd "$JOB" || exit 1
set -a; . "$JOB/job.env"; set +a
exec >>"$JOB/log.txt" 2>&1 </dev/null

SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"
STEP="Starting"

json_str() { local s="$1"; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
status() {  # state step [result] [finishedAt]
  printf '{"state":"%s","step":"%s","result":"%s","at":%s,"finishedAt":%s}\n' \
    "$1" "$(json_str "$2")" "$(json_str "${3:-}")" "$(date +%s%3N)" "${4:-null}" > status.json.tmp && mv -f status.json.tmp status.json
}
say()    { echo "[$(date +%H:%M:%S)] $*"; }
step()   { STEP="$1"; status running "$1"; echo; say "── $1"; }
finish() { status "$1" "$STEP" "$2" "$(date +%s%3N)"; echo; say "$2"; exit 0; }

# Backend is healthy after two good /api/health answers 4 s apart, within $1 seconds
health() {
  local deadline=$(( $(date +%s) + ${1:-60} )) good=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 4 "http://127.0.0.1:${PORT:-3001}/api/health" >/dev/null 2>&1; then
      good=$((good + 1)); [ "$good" -ge 2 ] && return 0; sleep 4
    else
      good=0; sleep 2
    fi
  done
  return 1
}
restart_backend() {
  say "sudo systemctl restart $SERVICE"
  # a crash-looping service hits systemd's start limit; clear it so the restart is accepted
  sudo -n "$SYSTEMCTL" reset-failed "$SERVICE" 2>/dev/null
  sudo -n "$SYSTEMCTL" restart "$SERVICE"
}
rebuild() {
  say "npm run build (frontend)"
  ( cd "$ROOT/frontend" && npm run build 2>&1 | tail -n 40; exit "${PIPESTATUS[0]}" )
}
backup_tree() {
  tar -czf "$JOB/backup.tgz" -C "$ROOT" --exclude=./.git --exclude=node_modules \
      --exclude=./.device-firmware --exclude='*.log' .
}

ROLLBACK_RESTART=0   # set once the backend may be running changed code
rollback() {
  local why="$1"
  step "Rolling back: $why"
  if ! tar -xzf "${BACKUP:-$JOB/backup.tgz}" -C "$ROOT" --no-same-owner; then
    finish rollback_failed "$why. The backup could not be restored; nothing more was changed."
  fi
  [ -n "${REMOVE_ON_ROLLBACK:-}" ] && rm -f -- "$ROOT/$REMOVE_ON_ROLLBACK" && say "removed new file $REMOVE_ON_ROLLBACK"
  say "previous files restored"
  if [ "${REBUILD_ON_ROLLBACK:-0}" = 1 ]; then rebuild || say "rebuild after restore failed"; fi
  if [ "$ROLLBACK_RESTART" = 1 ]; then
    restart_backend
    if ! health 75; then
      finish rollback_failed "$why. Old files are back but $SERVICE still isn't answering. Check: sudo journalctl -u $SERVICE -n 60"
    fi
  fi
  finish rolled_back "$why. The previous version was put back."
}

say "Job $(basename "$JOB") · mode $MODE · Aether folder $ROOT"

case "$MODE" in
  bundle)
    step "Backing up the Aether folder"
    backup_tree || finish failed "Backup failed, so nothing was changed."
    say "backup $(du -h "$JOB/backup.tgz" | cut -f1)"
    ROLLBACK_RESTART="${NEEDS_RESTART:-0}"
    if [ "$PAYLOAD" = apply ]; then
      step "Running apply.sh"
      ( cd "$SRC" && bash ./apply.sh "$ROOT" ); rc=$?
      [ "$rc" -eq 0 ] || rollback "apply.sh stopped with exit code $rc"
    else
      step "Copying files"
      ( cd "$SRC" && tar -cf - --exclude=node_modules --exclude=.git . ) | tar -xvf - -C "$ROOT" --no-same-owner \
        || rollback "copying files failed"
      if [ "${REBUILD:-0}" = 1 ]; then step "Rebuilding web pages"; rebuild || rollback "frontend build failed"; fi
      if [ "${RESTART:-0}" = 1 ]; then step "Restarting $SERVICE"; restart_backend || rollback "restart command failed"; fi
    fi
    step "Checking the backend answers"
    health 60 || rollback "the backend didn't come back within 60 s"
    finish success "Update applied."
    ;;

  file)
    REMOVE_ON_ROLLBACK=""; [ "${EXISTED:-1}" = 0 ] && REMOVE_ON_ROLLBACK="$DEST"
    if [ "${REBUILD:-0}" = 1 ]; then
      REBUILD_ON_ROLLBACK=1
      step "Rebuilding web pages"
      rebuild || rollback "frontend build failed with the new $DEST"
    fi
    if [ "${RESTART:-0}" = 1 ]; then
      ROLLBACK_RESTART=1
      step "Restarting $SERVICE"
      restart_backend || rollback "restart command failed"
      step "Checking the backend answers"
      health 60 || rollback "the backend didn't come back within 60 s with the new $DEST"
    fi
    finish success "$DEST is in place."
    ;;

  restore)
    step "Restoring backup"
    tar -xzf "$BACKUP" -C "$ROOT" --no-same-owner || finish failed "Could not extract the backup."
    [ -n "${REMOVE:-}" ] && rm -f -- "$ROOT/$REMOVE" && say "removed $REMOVE"
    if [ "${REBUILD:-0}" = 1 ]; then step "Rebuilding web pages"; rebuild || finish failed "Files restored, but the frontend build failed."; fi
    if [ "${RESTART:-0}" = 1 ]; then
      step "Restarting $SERVICE"; restart_backend
      step "Checking the backend answers"
      health 75 || finish failed "Files restored, but $SERVICE isn't answering. Check: sudo journalctl -u $SERVICE -n 60"
    fi
    finish success "Restored."
    ;;

  action)
    if [ "${REBUILD:-0}" = 1 ]; then step "Rebuilding web pages"; rebuild || finish failed "Frontend build failed."; fi
    if [ "${RESTART:-0}" = 1 ]; then
      step "Restarting $SERVICE"; restart_backend || finish failed "Restart command failed."
      step "Checking the backend answers"
      health 75 || finish failed "$SERVICE isn't answering. Check: sudo journalctl -u $SERVICE -n 60"
    fi
    finish success "Done."
    ;;

  *) finish failed "Unknown mode $MODE" ;;
esac
