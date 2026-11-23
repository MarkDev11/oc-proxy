#!/usr/bin/env bash
# Manage the userspace Tailscale daemon and the Funnel that publishes oc-proxy.
#
# The daemon runs without a TUN device (--tun=userspace-networking) because the
# container has no /dev/net/tun. Funnel terminates TLS on Tailscale's edge and
# proxies to http://127.0.0.1:$PORT, so no local certificate is needed.
#
# Usage: scripts/tailscale.sh {ensure|start|stop|status|url|funnel|funnel-off}
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

TS_DIR="run/tailscale"
SOCKET="$TS_DIR/socket"
PORT="${PORT:-8791}"
TS=(bin/tailscale --socket="$SOCKET")

# tailscaled calls `sudo` for the operator check; the shim makes the local
# user (uid 995) count as the operator even though we cannot setuid.
export PATH="$PWD/$TS_DIR/bin:$PATH"

daemon_running() {
  pgrep -f "bin/tailscaled .*--socket=$SOCKET" >/dev/null 2>&1
}

backend_state() {
  "${TS[@]}" status --json 2>/dev/null |
    python3 -c 'import sys,json; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null
}

wait_running() {
  local i
  for i in $(seq 1 90); do
    if [[ "$(backend_state)" == "Running" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_daemon() {
  if daemon_running; then
    return 0
  fi
  mkdir -p "$TS_DIR"
  setsid nohup bin/tailscaled \
    --tun=userspace-networking \
    --state="$TS_DIR/state" \
    --statedir="$TS_DIR" \
    --socket="$SOCKET" \
    --config="$TS_DIR/config.json" \
    --port=0 \
    >>"$TS_DIR/tailscaled.log" 2>&1 </dev/null &
  echo $! >"$TS_DIR/tailscaled.pid"
  local i
  for i in $(seq 1 60); do
    if [[ -S "$SOCKET" ]] && daemon_running; then
      return 0
    fi
    sleep 0.5
  done
  echo "tailscaled did not come up; see $TS_DIR/tailscaled.log" >&2
  return 1
}

funnel_on() {
  # Returns non-zero (with the admin-console URL) until Funnel is enabled for
  # the tailnet; the serve config is still stored and applies afterwards.
  timeout 60 "${TS[@]}" funnel --bg --yes "$PORT"
}

case "${1:-status}" in
  start)
    start_daemon
    ;;
  stop)
    if [[ -f "$TS_DIR/tailscaled.pid" ]]; then
      kill "$(cat "$TS_DIR/tailscaled.pid")" 2>/dev/null || true
      rm -f "$TS_DIR/tailscaled.pid"
      echo "tailscaled stopped"
    else
      echo "tailscaled not running"
    fi
    ;;
  ensure)
    start_daemon || exit 1
    if ! wait_running; then
      echo "tailscale is not logged in; run: bin/tailscale --socket=$SOCKET up" >&2
      exit 1
    fi
    funnel_on
    ;;
  funnel)
    funnel_on
    ;;
  funnel-off)
    "${TS[@]}" funnel --https=443 off 2>&1 || true
    ;;
  url)
    "${TS[@]}" status --json 2>/dev/null |
      python3 -c 'import sys,json; d=json.load(sys.stdin); print("https://" + d.get("Self",{}).get("DNSName","").rstrip("."))'
    ;;
  status)
    if daemon_running; then
      echo "tailscaled: running ($(backend_state))"
      "${TS[@]}" funnel status 2>&1
    else
      echo "tailscaled: not running"
    fi
    ;;
  *)
    echo "usage: $0 {ensure|start|stop|status|url|funnel|funnel-off}" >&2
    exit 2
    ;;
esac
