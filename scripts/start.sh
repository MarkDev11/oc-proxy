#!/usr/bin/env bash
#
# Start oc-proxy + Cloudflare Quick Tunnel in the background.
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

if [[ -z "${GATEWAY_API_KEY:-}" ]]; then
  echo "GATEWAY_API_KEY kosong. Isi dulu di .env." >&2
  exit 1
fi

if [[ ! -x "$CLOUDFLARED_BIN" ]]; then
  bash scripts/install-cloudflared.sh
fi

if [[ -f run/supervisor.pid ]] && kill -0 "$(cat run/supervisor.pid)" 2>/dev/null; then
  echo "already running (pid $(cat run/supervisor.pid))"
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

for _ in $(seq 1 60); do
  if [[ -s run/tunnel-url.txt ]]; then
    echo "public: $(cat run/tunnel-url.txt)"
    exit 0
  fi
  sleep 0.5
done

echo "tunnel belum memberi URL; cek logs/cloudflared.log" >&2
exit 1
