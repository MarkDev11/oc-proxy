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
POLL=${WARP_POLL:-5}
COOLDOWN=${WARP_COOLDOWN:-600}
FAIL_BACKOFF=${WARP_FAIL_BACKOFF:-300}
MAX_ATTEMPTS=${WARP_MAX_ATTEMPTS:-15}
VERIFY=${WARP_VERIFY:-1}
VERIFY_MODELS=${WARP_VERIFY_MODELS:-${WARP_VERIFY_MODEL:-nemotron-3.5-lightning-free,deepseek-v4.1-flash-free,mimo-v2.6-flash-free}}
BUN_BIN=${BUN_BIN:-bun}

RUN_DIR="$ROOT/run"
LOG_DIR="$ROOT/logs"
STATE="$RUN_DIR/warp-egress.txt"
EGRESS_IP_FILE="$RUN_DIR/warp-egress-ip.txt"
LIVE_IP_FILE="$RUN_DIR/warp-live-ip.txt"
LIVE_PREFIX_FILE="$RUN_DIR/warp-live-prefix.txt"
COOLING="$RUN_DIR/warp-cooling.txt"
BACKOFF_FILE="$RUN_DIR/warp-backoff-until"
OFFSET_FILE="$RUN_DIR/warp-log-offset"
PIDFILE="$RUN_DIR/warp-rotate.pid"
ONCE_PIDFILE="$RUN_DIR/warp-once.pid"
ONCE_LOCK="$RUN_DIR/warp-once.lock"
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
  if [[ ! -d "$USQUE_DIR" ]]; then
    log "usque dir missing: $USQUE_DIR"
    return 1
  fi
  if [[ ! -f "$USQUE_DIR/connect_forward_multi.py" ]]; then
    log "forwarder script missing: $USQUE_DIR/connect_forward_multi.py"
    return 1
  fi
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
  if [[ ! -x "$USQUE_BIN" ]]; then
    log "usque binary missing or not executable: $USQUE_BIN"
    return 1
  fi
  if [[ ! -f "$CONFIG" ]]; then
    log "usque config missing: $CONFIG"
    return 1
  fi
  stop_usque
  (
    cd "$USQUE_DIR" || exit 1
    env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
        -u ALL_PROXY -u all_proxy \
      setsid -f "$USQUE_BIN" http-proxy -c "$CONFIG" --http2 --always-reconnect \
        -b 127.0.0.1 -p "$USQUE_PORT" -P "$FWD_PORT" \
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

write_live() {
  [[ -n "${1:-}" ]] && printf '%s\n' "$1" >"$LIVE_IP_FILE"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" >"$LIVE_PREFIX_FILE"
}

# Automatic rotation only makes sense when upstream traffic actually goes
# through the WARP proxy. The dashboard toggle writes run/upstream-proxy.txt;
# UPSTREAM_PROXY is the static override.
upstream_is_warp() {
  local val="${UPSTREAM_PROXY:-}"
  if [[ -z "$val" && -f "$ROOT/run/upstream-proxy.txt" ]]; then
    val=$(cat "$ROOT/run/upstream-proxy.txt" 2>/dev/null || true)
  fi
  # Only rotate the usque tunnel when traffic actually uses usque. The
  # wireproxy egress has its own lifecycle and is not rotated by this script.
  [[ "$val" == *":${USQUE_PORT}"* ]]
}

backoff_active() {
  local until
  until=$(cat "$BACKOFF_FILE" 2>/dev/null || echo 0)
  [[ "$until" =~ ^[0-9]+$ ]] && [[ "$(date +%s)" -lt "$until" ]]
}

set_backoff() {
  printf '%s\n' "$(( $(date +%s) + FAIL_BACKOFF ))" >"$BACKOFF_FILE"
  log "rotation failed; backoff ${FAIL_BACKOFF}s"
}

# Serialize automatic rotations behind the failure backoff. Manual `once`
# bypasses this by calling rotate_once directly.
rotate_guarded() {
  if backoff_active; then
    log "rotation backoff active until $(cat "$BACKOFF_FILE" 2>/dev/null)"
    return 1
  fi
  if rotate_once; then
    rm -f "$BACKOFF_FILE"
    return 0
  fi
  set_backoff
  return 1
}

# Verify the new egress directly through usque (not through the proxy server).
# This keeps the proxy's own upstream path independent and prevents verify 429s
# from appearing in logs/oc-proxy.log. A 200 means the prefix can reach
# upstream. 429/403 means the prefix is rejected (rotate again). 400/404 means
# upstream answered but the model is unavailable, which still proves the egress
# works. Network/5xx errors are inconclusive, so accept the prefix.
verify_prefix() {
  [[ "$VERIFY" == "1" ]] || return 0
  local model code out
  local saw_quota=0 saw_reachable=0 saw_inconclusive=0
  local models=() clean=()
  IFS=',' read -r -a models <<<"$VERIFY_MODELS"
  for model in "${models[@]}"; do
    model="${model#"${model%%[![:space:]]*}"}"
    model="${model%"${model##*[![:space:]]}"}"
    [[ -n "$model" ]] && clean+=("$model")
  done
  [[ ${#clean[@]} -gt 0 ]] || return 0
  out=$(WARP_PROXY_URL="http://127.0.0.1:${USQUE_PORT}" \
    "$BUN_BIN" "$ROOT/scripts/warp_verify.js" "${clean[@]}" 2>/dev/null) || true
  [[ -n "$out" ]] || return 3
  while read -r model code; do
    [[ -n "$model" && -n "$code" ]] || continue
    case "$code" in
      200) return 0 ;;
      429|403) saw_quota=1 ;;
      000|5??) saw_inconclusive=1 ;;
      *) saw_reachable=1 ;;
    esac
  done <<<"$out"
  [[ "$saw_quota" == "1" ]] && return 2
  [[ "$saw_reachable" == "1" ]] && return 0
  [[ "$saw_inconclusive" == "1" ]] && return 3
  return 1
}

# usque reconnects can land on a different WARP prefix. Adopt it when it passes
# verification; rotate when it is cooling or explicitly rejected.
adopt_live_prefix() {
  local ip="$1" pfx="$2" current rc
  [[ -n "$pfx" ]] || return 1
  current=$(cat "$STATE" 2>/dev/null || true)
  [[ -n "$current" && "$pfx" == "$current" ]] && return 0
  if is_cooling "$pfx"; then
    log "live prefix ${pfx} is cooling; rotating"
    rotate_guarded
    return $?
  fi
  if [[ "$VERIFY" == "1" ]]; then
    verify_prefix
    rc=$?
    case "$rc" in
      0) ;;
      2) log "live prefix ${pfx} rejected (429/403); cooling and rotating"
         add_cooling "$pfx"
         rotate_guarded
         return $? ;;
      3) log "live prefix ${pfx} verify inconclusive; adopting" ;;
      *) log "live prefix ${pfx} verify error rc=${rc}; keeping previous"; return 1 ;;
    esac
  fi
  printf '%s\n' "$pfx" >"$STATE"
  printf '%s\n' "$ip" >"$EGRESS_IP_FILE"
  log "adopted live egress ${ip} (${pfx})"
  return 0
}

rotate_once() {
  local current ip pfx rc attempt cooling_hits=0
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
    write_live "$ip" "$pfx"
    if is_cooling "$pfx"; then
      log "egress ${ip} (${pfx}) is cooling; retry"
      cooling_hits=$((cooling_hits + 1))
      continue
    fi
    if [[ -n "$current" && "$pfx" == "$current" && "$attempt" -lt 8 ]]; then
      log "egress ${pfx} unchanged; retry"
      continue
    fi
    if [[ "$VERIFY" == "1" ]]; then
      verify_prefix
      rc=$?
      case "$rc" in
        0) ;;
        2) log "verify rejected ${pfx} (429/403); cooling and retry"; add_cooling "$pfx"; continue ;;
        3) log "verify inconclusive on ${pfx}; accepting egress" ;;
        *) log "verify error rc=${rc} on ${pfx}; retry"; sleep 1; continue ;;
      esac
    fi
    printf '%s\n' "$pfx" >"$STATE"
    printf '%s\n' "$ip" >"$EGRESS_IP_FILE"
    write_live "$ip" "$pfx"
    log "active egress ${ip} (${pfx})"
    return 0
  done
  if [[ "$cooling_hits" -gt 0 ]]; then
    log "rotation exhausted after ${cooling_hits} cooling hit(s); clearing cooling list for a fresh pass"
    : >"$COOLING"
  fi
  return 1
}

monitor() {
  load_env
  echo $$ >"$PIDFILE"
  start_forwarder || log "forwarder failed to start"
  local ip pfx
  ip=$(egress_ip 2>/dev/null || true)
  if [[ -z "$ip" ]]; then
    start_usque || log "initial usque start failed"
    ip=$(egress_ip 2>/dev/null || true)
  fi
  if [[ -n "$ip" ]]; then
    pfx=$(prefix64 "$ip" 2>/dev/null || true)
    write_live "$ip" "$pfx"
    if [[ ! -s "$STATE" && -n "$pfx" ]]; then
      printf '%s\n' "$pfx" >"$STATE"
    elif [[ -n "$pfx" ]] && upstream_is_warp && ! backoff_active; then
      adopt_live_prefix "$ip" "$pfx" || true
    fi
  fi
  local size offset new current
  size=$(stat -c %s "$OC_LOG" 2>/dev/null || echo 0)
  offset=$size
  log "monitor started offset=${offset} state=$(cat "$STATE" 2>/dev/null || echo none)"
  while true; do
    sleep "$POLL"
    start_forwarder >/dev/null 2>&1 || true
    local live_ip live_pfx
    live_ip=$(egress_ip 2>/dev/null || true)
    if [[ -n "$live_ip" ]]; then
      live_pfx=$(prefix64 "$live_ip" 2>/dev/null || true)
      write_live "$live_ip" "$live_pfx"
      if upstream_is_warp && ! backoff_active; then
        adopt_live_prefix "$live_ip" "$live_pfx" || true
      fi
    else
      log "tunnel unhealthy; restarting"
      start_usque || log "tunnel restart failed"
      live_ip=$(egress_ip 2>/dev/null || true)
      if [[ -n "$live_ip" ]]; then
        live_pfx=$(prefix64 "$live_ip" 2>/dev/null || true)
        write_live "$live_ip" "$live_pfx"
        if upstream_is_warp && ! backoff_active; then
          adopt_live_prefix "$live_ip" "$live_pfx" || true
        fi
      fi
    fi
    size=$(stat -c %s "$OC_LOG" 2>/dev/null || echo 0)
    if [[ "$size" -lt "$offset" ]]; then
      offset=0
    fi
    if [[ "$size" -gt "$offset" ]]; then
      new=$(tail -c +$((offset + 1)) "$OC_LOG" 2>/dev/null || true)
      if upstream_is_warp && printf '%s' "$new" | grep -qE 'upstream (429|403)|FreeUsageLimitError'; then
        current=$(cat "$STATE" 2>/dev/null || true)
        if backoff_active; then
          log "limit detected on ${current:-unknown}; rotation backoff active until $(cat "$BACKOFF_FILE" 2>/dev/null)"
        else
          log "limit detected on ${current:-unknown}; rotating"
          rotate_guarded && log "rotation ok: $(cat "$STATE")"
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
  local pid="" opid="" ip="" pfx=""
  [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ -f "$ONCE_PIDFILE" ]] && opid=$(cat "$ONCE_PIDFILE" 2>/dev/null || true)
  if [[ -n "$opid" ]] && kill -0 "$opid" 2>/dev/null; then
    echo "rotation: once (pid ${opid})"
  elif [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "rotation: running (pid ${pid})"
  else
    echo "rotation: stopped"
  fi
  echo "endpoint: ${ENDPOINT}  forward: 127.0.0.1:${FWD_PORT}  usque: 127.0.0.1:${USQUE_PORT}"
  echo "upstream proxy: ${UPSTREAM_PROXY:-direct}"
  if port_listening "$FWD_PORT"; then echo "relay: listening (127.0.0.1:${FWD_PORT})"; else echo "relay: down"; fi
  if port_listening "$USQUE_PORT"; then echo "usque: listening (127.0.0.1:${USQUE_PORT})"; else echo "usque: down"; fi
  echo "state: $(cat "$STATE" 2>/dev/null || echo none)"
  ip=$(egress_ip 2>/dev/null || true)
  if [[ -n "$ip" ]]; then
    pfx=$(prefix64 "$ip" 2>/dev/null || true)
    echo "live egress: ${ip} (${pfx})"
  else
    echo "live egress: unavailable"
  fi
  echo "cooling: $(wc -l <"$COOLING" 2>/dev/null || echo 0) prefix(es)"
  local until
  until=$(cat "$BACKOFF_FILE" 2>/dev/null || echo 0)
  if [[ "$until" =~ ^[0-9]+$ ]] && [[ "$(date +%s)" -lt "$until" ]]; then
    echo "backoff: $((until - $(date +%s)))s"
  else
    echo "backoff: none"
  fi
  if [[ -f "$ROTATE_LOG" ]]; then
    echo "recent:"
    tail -n 5 "$ROTATE_LOG" | sed 's/^/  /'
  fi
}

start_cmd() {
  load_env
  local pid="" opid=""
  [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [[ -f "$ONCE_PIDFILE" ]] && opid=$(cat "$ONCE_PIDFILE" 2>/dev/null || true)
  # `once` calls start_cmd from its own process; allow that, but do not start a
  # second monitor while a different rotation is in progress.
  if [[ -n "$opid" && "$opid" != "$$" ]] && kill -0 "$opid" 2>/dev/null; then
    echo "rotation in progress (pid ${opid})"
    return 0
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "already running (pid ${pid})"
    return 0
  fi
  rm -f "$PIDFILE"
  setsid -f bash -c 'echo $$ > "$1"; exec bash "$2" run' _ "$PIDFILE" "$0" \
    >>"$ROTATE_LOG" 2>&1 </dev/null
  sleep 1
  status_cmd
}

stop_monitor() {
  local pid=""
  [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  stop_usque
  pkill -f "python3 connect_forward_multi.py" 2>/dev/null || true
}

# Reject a concurrent `once`. A lock without a live pid is stale after 5 min.
# The dashboard reserves this lock before spawning and passes
# WARP_ONCE_LOCK_HELD=1 so the shell does not reject its own reservation.
acquire_once_lock() {
  if [[ "${WARP_ONCE_LOCK_HELD:-}" == "1" ]]; then
    mkdir -p "$ONCE_LOCK" 2>/dev/null || true
    return 0
  fi
  if [[ -d "$ONCE_LOCK" ]]; then
    local opid="" age now mtime
    [[ -f "$ONCE_PIDFILE" ]] && opid=$(cat "$ONCE_PIDFILE" 2>/dev/null || true)
    if [[ -n "$opid" ]] && kill -0 "$opid" 2>/dev/null; then
      return 1
    fi
    now=$(date +%s)
    mtime=$(stat -c %Y "$ONCE_LOCK" 2>/dev/null || echo "$now")
    age=$((now - mtime))
    if [[ -z "$opid" && "$age" -lt 300 ]]; then
      return 1
    fi
    rm -f "$ONCE_PIDFILE"
    rmdir "$ONCE_LOCK" 2>/dev/null || true
  fi
  mkdir "$ONCE_LOCK" 2>/dev/null
}

stop_cmd() {
  local opid=""
  [[ -f "$ONCE_PIDFILE" ]] && opid=$(cat "$ONCE_PIDFILE" 2>/dev/null || true)
  if [[ -n "$opid" ]] && kill -0 "$opid" 2>/dev/null; then
    kill -TERM "$opid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$opid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$opid" 2>/dev/null || true
  fi
  if [[ -f "$ONCE_PIDFILE" ]]; then
    rm -f "$ONCE_PIDFILE"
    rmdir "$ONCE_LOCK" 2>/dev/null || true
  fi
  # A rotation whose PID file was overwritten by a racing spawn would survive
  # the pid-file kill; sweep any remaining once process too.
  pkill -f '[w]arp_rotate.sh once' 2>/dev/null || true
  stop_monitor
  echo "stopped"
}

case "${1:-run}" in
  run) monitor ;;
  start) start_cmd ;;
  stop) stop_cmd ;;
  status) status_cmd ;;
  once)
    if ! acquire_once_lock; then
      echo "rotation already in progress" >&2
      exit 3
    fi
    trap 'rm -f "$ONCE_PIDFILE"; rmdir "$ONCE_LOCK" 2>/dev/null || true' EXIT
    echo $$ >"$ONCE_PIDFILE"
    stop_monitor >/dev/null
    load_env
    start_forwarder
    rotate_once
    rc=$?
    if [[ "$rc" -eq 0 ]]; then
      rm -f "$BACKOFF_FILE"
    else
      set_backoff
    fi
    start_cmd
    exit "$rc"
    ;;
  *) echo "usage: $0 {start|stop|status|once|run}" >&2; exit 2 ;;
esac
