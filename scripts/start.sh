#!/usr/bin/env bash
#
# Start oc-proxy in the background. Also starts a Cloudflare Quick Tunnel
# unless TUNNEL_DISABLED=1 (for example when using Tailscale Funnel).
# Logs: logs/up.log, logs/oc-proxy.log, logs/cloudflared.log
# Stop: bash scripts/stop.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p run logs
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-8791}"
HOST="${HOST:-127.0.0.1}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-bin/cloudflared}"
TUNNEL_DISABLED="${TUNNEL_DISABLED:-0}"
WARP_ENGINE="${WARP_ENGINE:-wireproxy}"
WARP_ROTATE="${WARP_ROTATE:-0}"
BUN_BIN="${BUN_BIN:-bun}"

# usque keeps a long-running monitor; wireproxy is self-healing on demand.
# With WARP_ROTATE=1, verify the wireproxy egress once at startup and rotate
# only when the OpenCode fingerprint test is not 200.
start_warp_rotation() {
  if [[ "$WARP_ENGINE" == "usque" ]]; then
    if [[ "$WARP_ROTATE" == "1" ]]; then
      bash scripts/warp_rotate.sh start >> logs/up.log 2>&1 || true
    fi
    return 0
  fi
  if [[ "$WARP_ROTATE" == "1" ]]; then
    (
      if ! "$BUN_BIN" scripts/warp_register.js --test >> logs/warp-register.log 2>&1; then
        bash scripts/wireproxy_rotate.sh --max "${WARP_MAX_ATTEMPTS:-5}" \
          >> logs/up.log 2>&1 || true
      fi
    ) >> logs/up.log 2>&1 &
  fi
}

if [[ -z "${GATEWAY_API_KEY:-}" ]]; then
  echo "GATEWAY_API_KEY kosong. Isi dulu di .env." >&2
  exit 1
fi

# The free tier needs a WARP egress. Start the userspace WireGuard proxy and
# make it the default upstream unless UPSTREAM_PROXY locks something else.
if [[ "$WARP_ENGINE" != "usque" && "${WARP_WIREPROXY:-1}" == "1" ]]; then
  bash scripts/wireproxy.sh start >> logs/up.log 2>&1 || true
  if [[ -z "${UPSTREAM_PROXY:-}" ]]; then
    if [[ ! -f run/upstream-proxy.txt ]] || grep -q ":${WARP_PROXY_PORT:-28090}" run/upstream-proxy.txt 2>/dev/null; then
      printf 'http://127.0.0.1:%s\n' "${WARP_WIREPROXY_PORT:-28091}" > run/upstream-proxy.txt
      chmod 600 run/upstream-proxy.txt
    fi
  fi
elif [[ "$WARP_ENGINE" == "usque" && -z "${UPSTREAM_PROXY:-}" ]]; then
  printf 'http://127.0.0.1:%s\n' "${WARP_PROXY_PORT:-28090}" > run/upstream-proxy.txt
  chmod 600 run/upstream-proxy.txt
fi

if [[ "$TUNNEL_DISABLED" != "1" && ! -x "$CLOUDFLARED_BIN" ]]; then
  bash scripts/install-cloudflared.sh
fi

if [[ -f run/supervisor.pid ]] && kill -0 "$(cat run/supervisor.pid)" 2>/dev/null; then
  echo "already running (pid $(cat run/supervisor.pid))"
  start_warp_rotation
  bash scripts/status.sh || true
  exit 0
fi

setsid nohup node scripts/up.js >> logs/up.log 2>&1 &
echo "starting supervisor (pid $!)"

for _ in $(seq 1 60); do
  if curl -fsS "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then
  echo "server tidak sehat; cek logs/up.log" >&2
  exit 1
fi
echo "local: http://${HOST}:${PORT}"

start_warp_rotation

# Tailscale Funnel is the public endpoint when the Cloudflare tunnel is off.
# Bring the userspace daemon and serve config up in the background; the proxy
# itself stays usable if the node is not logged in yet.
if [[ "$TUNNEL_DISABLED" == "1" && "${PUBLIC_URL:-}" == https://*.ts.net* ]]; then
  ( bash scripts/tailscale.sh ensure >> logs/up.log 2>&1 || true ) &
fi

if [[ "$TUNNEL_DISABLED" == "1" ]]; then
  if [[ -n "${PUBLIC_URL:-}" ]]; then
    echo "public: ${PUBLIC_URL}"
  else
    echo "tunnel: disabled (TUNNEL_DISABLED=1)"
  fi
  exit 0
fi

for _ in $(seq 1 60); do
  if [[ -s run/tunnel-url.txt ]]; then
    echo "public: $(cat run/tunnel-url.txt)"
    exit 0
  fi
  sleep 0.5
done

echo "tunnel belum memberi URL; cek logs/cloudflared.log" >&2
exit 1
