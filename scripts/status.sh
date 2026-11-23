#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
PORT="${PORT:-8791}"
HOST="${HOST:-127.0.0.1}"

if [[ -f run/supervisor.pid ]] && kill -0 "$(cat run/supervisor.pid)" 2>/dev/null; then
  echo "supervisor: running (pid $(cat run/supervisor.pid))"
else
  echo "supervisor: not running"
fi

if curl -fsS "http://${HOST}:${PORT}/api/health" 2>/dev/null; then
  echo
else
  echo "health: unreachable"
fi

if [[ "${WARP_ENGINE:-wireproxy}" == "usque" ]]; then
  if [[ -f run/warp-rotate.pid || -f run/warp-once.pid ]]; then
    bash scripts/warp_rotate.sh status 2>/dev/null |
      awk 'NR==1{print "warp: "$0} NR==3{print "warp "$0} NR==7{print "warp "$0} NR==8{print "warp "$0} NR==9{print "warp "$0}'
  else
    echo "warp: stopped"
  fi
else
  bash scripts/wireproxy.sh status 2>/dev/null | sed 's/^/warp: /'
  echo "warp upstream: $(cat run/upstream-proxy.txt 2>/dev/null || echo direct)"
fi

if [[ -s run/tunnel-url.txt ]]; then
  echo "public: $(cat run/tunnel-url.txt)"
elif [[ "${TUNNEL_DISABLED:-0}" == "1" ]]; then
  echo "tunnel: disabled (TUNNEL_DISABLED=1)"
else
  echo "public: tunnel URL not available"
fi
