#!/usr/bin/env bash
# Rotate the oc-proxy-owned WARP device and rebuild the wireproxy config.
#
# lib/warp.js reserves run/warp-once.lock before spawning this wrapper and
# passes WARP_ONCE_LOCK_HELD=1. When invoked manually the wrapper takes the
# same lock, so a startup self-heal and a dashboard rotation cannot overlap.
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

RUN="run"
LOG="logs/warp-register.log"
PIDFILE="$RUN/warp-once.pid"
LOCK="$RUN/warp-once.lock"
BUN_BIN="${BUN_BIN:-bun}"

mkdir -p "$RUN" logs

LOCK_HELD=0
if [[ "${WARP_ONCE_LOCK_HELD:-}" == "1" ]]; then
  mkdir -p "$LOCK" 2>/dev/null || true
  LOCK_HELD=1
elif mkdir "$LOCK" 2>/dev/null; then
  LOCK_HELD=1
else
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    echo "rotation already in progress (pid $(cat "$PIDFILE"))" >&2
    exit 3
  fi
  now=$(date +%s)
  mtime=$(stat -c %Y "$LOCK" 2>/dev/null || echo "$now")
  if (( now - mtime < 300 )); then
    echo "rotation lock is fresh but has no live pid; refusing to race" >&2
    exit 3
  fi
  rm -f "$PIDFILE"
  rmdir "$LOCK" 2>/dev/null || true
  if mkdir "$LOCK" 2>/dev/null; then
    LOCK_HELD=1
  else
    echo "rotation already in progress" >&2
    exit 3
  fi
fi

echo $$ >"$PIDFILE"

cleanup() {
  rm -f "$PIDFILE"
  if [[ "$LOCK_HELD" == "1" ]]; then
    rmdir "$LOCK" 2>/dev/null || true
  fi
}
trap cleanup EXIT

"$BUN_BIN" scripts/warp_register.js --rotate "$@" >>"$LOG" 2>&1
rc=$?
exit "$rc"
