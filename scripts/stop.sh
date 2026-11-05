#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f run/supervisor.pid ]]; then
  echo "not running (no run/supervisor.pid)"
  exit 0
fi

PID="$(cat run/supervisor.pid)"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "not running (stale pid $PID)"
  rm -f run/supervisor.pid run/tunnel-url.txt
  exit 0
fi

kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f run/supervisor.pid run/tunnel-url.txt
    echo "stopped"
    exit 0
  fi
  sleep 0.5
done

kill -KILL "$PID" 2>/dev/null || true
rm -f run/supervisor.pid run/tunnel-url.txt
echo "stopped (forced)"
