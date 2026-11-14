#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

USQUE_DIR=${USQUE_DIR:-/workspace/usque}
USQUE_BIN=${USQUE_BIN:-$USQUE_DIR/usque-h2-v6}
CONFIG=${WARP_CONFIG:-$USQUE_DIR/config2.json}
ENDPOINT=${WARP_ENDPOINT:-162.159.198.3}
FWD_PORT=${WARP_FWD_PORT:-24443}
USQUE_PORT=${WARP_PROXY_PORT:-28090}
POLL=${WARP_POLL:-10}
COOLDOWN=${WARP_COOLDOWN:-1800}
MAX_ATTEMPTS=${WARP_MAX_ATTEMPTS:-15}
VERIFY=${WARP_VERIFY:-1}
VERIFY_MODEL=${WARP_VERIFY_MODEL:-deepseek-v4.1-flash-free}

RUN_DIR="$ROOT/run"
LOG_DIR="$ROOT/logs"
STATE="$RUN_DIR/warp-egress.txt"
EGRESS_IP_FILE="$RUN_DIR/warp-egress-ip.txt"
COOLING="$RUN_DIR/warp-cooling.txt"
OFFSET_FILE="$RUN_DIR/warp-log-offset"
PIDFILE="$RUN_DIR/warp-rotate.pid"
OC_LOG="$LOG_DIR/oc-proxy.log"
ROTATE_LOG="$LOG_DIR/warp-rotate.log"

mkdir -p "$RUN_DIR" "$LOG_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$ROTATE_LOG"; }

curl_clean() {
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
      -u ALL_PROXY -u all_proxy curl "$@"
}

load_env() {
  if [[ -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env"
    set +a
  fi
  GATEWAY_API_KEY=${GATEWAY_API_KEY:-}
  OC_PORT=${PORT:-8791}
  OC_HOST=${HOST:-127.0.0.1}
  unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
}

port_listening() {
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "127.0.0.1:${1}$"
}

start_forwarder() {
  mkdir -p "$USQUE_DIR/logs"
  if port_listening "$FWD_PORT"; then
    return 0
  fi
  (
    cd "$USQUE_DIR" || exit 1
    LPORT="$FWD_PORT" THOST="$ENDPOINT" setsid -f python3 connect_forward_multi.py \
      >logs/warp-forward.log 2>&1 </dev/null
  )
  for _ in $(seq 1 20); do
    port_listening "$FWD_PORT" && return 0
    sleep 0.5
  done
  return 1
}

stop_usque() {
  pkill -f "usque-h2-v6 http-proxy.*-p ${USQUE_PORT}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "usque-h2-v6 http-proxy.*-p ${USQUE_PORT}" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  pkill -9 -f "usque-h2-v6 http-proxy.*-p ${USQUE_PORT}" 2>/dev/null || true
}

start_usque() {
  stop_usque
  (
    cd "$USQUE_DIR" || exit 1
    env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
        -u ALL_PROXY -u all_proxy \
      setsid -f "$USQUE_BIN" http-proxy -c "$CONFIG" --http2 --always-reconnect \
        -b 127.0.0.1 -p "$USQUE_PORT" -P "$FWD_PORT" -F \
        -d 2620:fe::fe -d 2606:4700:4700::1111 \
        >logs/warp-usque.log 2>&1 </dev/null
  )
  for _ in $(seq 1 30); do
    egress_ip >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

egress_ip() {
  curl_clean -fsS --max-time 15 -x "http://127.0.0.1:${USQUE_PORT}" \
    'https://[2606:4700:4700::1111]/cdn-cgi/trace' 2>/dev/null |
    awk -F= '$1=="ip"{print $2; exit}'
}

prefix64() {
  python3 -c 'import sys,ipaddress; print(ipaddress.ip_network(sys.argv[1]+"/64", strict=False))' "$1" 2>/dev/null
}

touch "$COOLING"

purge_cooling() {
  local cutoff
  cutoff=$(( $(date +%s) - COOLDOWN ))
  awk -v cutoff="$cutoff" '$1 >= cutoff' "$COOLING" >"$COOLING.tmp" 2>/dev/null || true
  mv "$COOLING.tmp" "$COOLING" 2>/dev/null || true
}

is_cooling() {
  awk -v p="$1" '$2==p{found=1} END{exit found?0:1}' "$COOLING"
}

add_cooling() {
  [[ -n "${1:-}" ]] || return 0
  printf '%s %s\n' "$(date +%s)" "$1" >>"$COOLING"
}

verify_prefix() {
  [[ "$VERIFY" == "1" && -n "$GATEWAY_API_KEY" ]] || return 0
  local code
  code=$(curl_clean -sS -o /tmp/warp-verify.json -w '%{http_code}' --max-time 90 \
    "http://${OC_HOST}:${OC_PORT}/v1/chat/completions" \
    -H "Authorization: Bearer ${GATEWAY_API_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${VERIFY_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"stream\":false,\"max_tokens\":8}" \
    2>/dev/null) || code=000
  case "$code" in
    200) return 0 ;;
    429|403) return 2 ;;
    000) return 3 ;;
    *) return 1 ;;
  esac
}

rotate_once() {
  local current ip pfx rc attempt
  current=$(cat "$STATE" 2>/dev/null || true)
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    log "rotate attempt ${attempt}/${MAX_ATTEMPTS} endpoint=${ENDPOINT}"
    if ! start_usque; then
      log "usque start failed"
      sleep 2
      continue
    fi
    ip=$(egress_ip) || { log "egress trace failed"; sleep 1; continue; }
    pfx=$(prefix64 "$ip") || { log "invalid egress ${ip}"; continue; }
    if is_cooling "$pfx"; then
      log "egress ${ip} (${pfx}) is cooling; retry"
      continue
    fi
    if [[ -n "$current" && "$pfx" == "$current" && "$attempt" -lt 8 ]]; then
      log "egress ${pfx} unchanged; retry"
      continue
    fi
    if [[ "$VERIFY" == "1" && -n "$GATEWAY_API_KEY" ]]; then
      verify_prefix
      rc=$?
      case "$rc" in
        0) ;;
        2) log "verify hit quota on ${pfx}; cooling and retry"; add_cooling "$pfx"; continue ;;
        3) log "verify unavailable; accepting ${pfx}" ;;
        *) log "verify error rc=${rc} on ${pfx}; retry"; sleep 1; continue ;;
      esac
    fi
    printf '%s\n' "$pfx" >"$STATE"
    printf '%s\n' "$ip" >"$EGRESS_IP_FILE"
    log "active egress ${ip} (${pfx})"
    return 0
  done
  return 1
}

monitor() {
  load_env
  echo $$ >"$PIDFILE"
  start_forwarder || log "forwarder failed to start"
  if ! egress_ip >/dev/null 2>&1; then
    start_usque || log "initial usque start failed"
  fi
  if [[ ! -s "$STATE" ]]; then
    local ip
    ip=$(egress_ip 2>/dev/null || true)
    [[ -n "$ip" ]] && prefix64 "$ip" >"$STATE"
  fi
  local size offset new current
  size=$(stat -c %s "$OC_LOG" 2>/dev/null || echo 0)
  offset=$size
  log "monitor started offset=${offset} state=$(cat "$STATE" 2>/dev/null || echo none)"
  while true; do
    sleep "$POLL"
    start_forwarder >/dev/null 2>&1 || true
    if ! egress_ip >/dev/null 2>&1; then
      log "tunnel unhealthy; restarting"
      start_usque || log "tunnel restart failed"
    fi
    size=$(stat -c %s "$OC_LOG" 2>/dev/null || echo 0)
    if [[ "$size" -lt "$offset" ]]; then
      offset=0
    fi
    if [[ "$size" -gt "$offset" ]]; then
      new=$(tail -c +$((offset + 1)) "$OC_LOG" 2>/dev/null || true)
      if printf '%s' "$new" | grep -qE 'upstream (429|403)|FreeUsageLimitError'; then
        current=$(cat "$STATE" 2>/dev/null || true)
        log "limit detected on ${current:-unknown}; rotating"
        [[ -n "$current" ]] && add_cooling "$current"
        if rotate_once; then
          log "rotation ok: $(cat "$STATE")"
        else
          log "rotation failed after ${MAX_ATTEMPTS} attempts"
        fi
        size=$(stat -c %s "$OC_LOG" 2>/dev/null || echo 0)
      fi
    fi
    offset=$size
    printf '%s\n' "$offset" >"$OFFSET_FILE"
    purge_cooling
  done
}

status_cmd() {
  load_env
  local pid="" ip="" pfx=""
  [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "rotation: running (pid ${pid})"
  else
    echo "rotation: stopped"
  fi
  echo "endpoint: ${ENDPOINT}  forward: 127.0.0.1:${FWD_PORT}  usque: 127.0.0.1:${USQUE_PORT}"
  echo "state: $(cat "$STATE" 2>/dev/null || echo none)"
  ip=$(egress_ip 2>/dev/null || true)
  if [[ -n "$ip" ]]; then
    pfx=$(prefix64 "$ip" 2>/dev/null || true)
    echo "live egress: ${ip} (${pfx})"
  else
    echo "live egress: unavailable"
  fi
  echo "cooling: $(wc -l <"$COOLING" 2>/dev/null || echo 0) prefix(es)"
  if [[ -f "$ROTATE_LOG" ]]; then
    echo "recent:"
    tail -n 5 "$ROTATE_LOG" | sed 's/^/  /'
  fi
}

start_cmd() {
  load_env
  local pid=""
  [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "already running (pid ${pid})"
    return 0
  fi
  rm -f "$PIDFILE"
  setsid -f bash -c 'echo $$ > "$1"; exec "$2" run' _ "$PIDFILE" "$0" \
    >>"$ROTATE_LOG" 2>&1 </dev/null
  sleep 1
  status_cmd
}

stop_cmd() {
  local pid=""
  [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "stopped"
}

case "${1:-run}" in
  run) monitor ;;
  start) start_cmd ;;
  stop) stop_cmd ;;
  status) status_cmd ;;
  once)
    stop_cmd >/dev/null
    load_env
    start_forwarder
    rotate_once
    start_cmd
    ;;
  *) echo "usage: $0 {start|stop|status|once|run}" >&2; exit 2 ;;
esac
