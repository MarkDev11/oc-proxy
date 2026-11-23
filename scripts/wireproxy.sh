#!/usr/bin/env bash
# Userspace WireGuard (wireproxy) egress for the free-tier upstream.
#
# The usque/MASQUE WARP path is kept for rotation experiments, but the working
# egress is this wireproxy instance: a WARP WireGuard peer exposed as a local
# HTTP proxy. It is intentionally separate from opencode-hop's own wireproxy so
# oc-proxy does not depend on that process.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

PORT="${WARP_WIREPROXY_PORT:-28091}"
INFO_PORT="${WARP_WIREPROXY_INFO_PORT:-28092}"
RUN="run"
LOGS="logs"
CONF="${WARP_WIREPROXY_CONF:-$RUN/warp-wireproxy.conf}"
PID_FILE="$RUN/wireproxy.pid"
LOG="$LOGS/wireproxy.log"
BIN="${WARP_WIREPROXY_BIN:-/tmp/opencode/wireproxy}"
SRC_BIN="${WARP_WIREPROXY_SRC_BIN:-/root/.local/share/opencode/tjk-warp/wireproxy}"
VENDOR_BIN="$ROOT/vendor/wireproxy"
SRC_CONF="${WARP_WIREPROXY_SRC_CONF:-/root/.local/share/opencode/tjk-warp/warp-proxy-41443.conf}"
BUN_BIN="${BUN_BIN:-bun}"

mkdir -p "$RUN" "$LOGS" /tmp/opencode

ensure_bin() {
  if [[ -x "$BIN" ]]; then return 0; fi
  local src
  for src in "$SRC_BIN" "$VENDOR_BIN"; do
    if [[ -r "$src" ]]; then
      cp "$src" "$BIN"
      chmod 755 "$BIN"
      return 0
    fi
  done
  echo "wireproxy binary missing: $SRC_BIN (vendor fallback: $VENDOR_BIN)" >&2
  return 1
}

ensure_conf() {
  # Prefer the device oc-proxy owns (run/warp-device.json). The old
  # opencode-hop config is only a last-resort seed and may be rotated away.
  if [[ ! -f "$CONF" && -f "$RUN/warp-device.json" ]]; then
    "$BUN_BIN" scripts/warp_register.js --write-conf >/dev/null 2>&1 || true
  fi
  if [[ ! -f "$CONF" ]]; then
    if [[ ! -r "$SRC_CONF" ]]; then
      echo "wireproxy config missing: $CONF (run: bun scripts/warp_register.js --register)" >&2
      return 1
    fi
    cp "$SRC_CONF" "$CONF"
    chmod 600 "$CONF"
  fi
  if grep -q '^BindAddress[[:space:]]*=' "$CONF"; then
    sed -i "s#^BindAddress[[:space:]]*=.*#BindAddress = 127.0.0.1:${PORT}#" "$CONF"
  else
    printf '\n[http]\nBindAddress = 127.0.0.1:%s\n' "$PORT" >>"$CONF"
  fi
}

is_up() {
  ss -ltn 2>/dev/null | grep -q "127.0.0.1:${PORT} "
}

egress() {
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
      -u ALL_PROXY -u all_proxy \
    curl -sS --max-time 15 -x "http://127.0.0.1:${PORT}" \
      'https://[2606:4700:4700::1111]/cdn-cgi/trace' 2>/dev/null || true
}

start() {
  ensure_bin
  ensure_conf
  if is_up; then
    echo "wireproxy already up on 127.0.0.1:${PORT}"
    return 0
  fi
  : >"$LOG"
  nohup "$BIN" -c "$CONF" -s -i "127.0.0.1:${INFO_PORT}" >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 40); do
    if is_up; then
      local trace ip warp
      trace="$(egress)"
      ip="$(printf '%s\n' "$trace" | sed -n 's/^ip=//p' | head -1)"
      warp="$(printf '%s\n' "$trace" | sed -n 's/^warp=//p' | head -1)"
      echo "wireproxy up on 127.0.0.1:${PORT}${ip:+ (ip $ip, warp ${warp:-?})}"
      return 0
    fi
    sleep 0.25
  done
  echo "wireproxy failed to start; see $LOG" >&2
  tail -5 "$LOG" >&2 || true
  return 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  echo "wireproxy stopped"
}

status() {
  if is_up; then
    echo "wireproxy: listening on 127.0.0.1:${PORT}"
    local trace
    trace="$(egress)"
    printf '%s\n' "$trace" | grep -E '^(ip|warp|colo)=' || true
  else
    echo "wireproxy: down"
    return 1
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  rotate)
    shift
    exec bash scripts/wireproxy_rotate.sh "$@"
    ;;
  test)
    shift
    exec "$BUN_BIN" scripts/warp_register.js --test "$@"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|rotate|test}" >&2
    exit 2
    ;;
esac
