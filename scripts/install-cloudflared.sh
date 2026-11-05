#!/usr/bin/env bash
#
# Download the cloudflared binary for this architecture into bin/.
# Usage: bash scripts/install-cloudflared.sh [--force]
#
# Optional:
#   CLOUDFLARED_SHA256=<hex>  verify the downloaded binary
#
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${CLOUDFLARED_BIN:-bin/cloudflared}"

if [[ -x "$BIN" && "${1:-}" != "--force" ]]; then
  "$BIN" --version
  echo "cloudflared already installed at $BIN (use --force to reinstall)"
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  armv7l|armv7) ARCH=arm ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$BIN")"
TMP="${BIN}.tmp"
rm -f "$TMP"

ASSET="cloudflared-linux-${ARCH}"
OFFICIAL="https://github.com/cloudflare/cloudflared/releases/latest/download/${ASSET}"
MIRRORS=()
[[ -n "${CLOUDFLARED_URL:-}" ]] && MIRRORS+=("$CLOUDFLARED_URL")
MIRRORS+=(
  "$OFFICIAL"
  "https://gh-proxy.com/${OFFICIAL}"
  "https://ghproxy.net/${OFFICIAL}"
)

download() {
  local url="$1"
  local n=0
  while :; do
    n=$((n + 1))
    echo "downloading $url"
    if curl -fL -C - --connect-timeout 15 --max-time 180 --retry 2 --retry-delay 2 -o "$TMP" "$url"; then
      return 0
    fi
    if [[ "$n" -ge 6 ]]; then
      return 1
    fi
    sleep 2
  done
}

ok=0
for url in "${MIRRORS[@]}"; do
  if download "$url"; then
    ok=1
    break
  fi
  rm -f "$TMP"
done

if [[ "$ok" != 1 ]]; then
  echo "failed to download cloudflared; set CLOUDFLARED_URL or install it manually at $BIN" >&2
  exit 1
fi

if [[ -n "${CLOUDFLARED_SHA256:-}" ]]; then
  echo "${CLOUDFLARED_SHA256}  ${TMP}" | sha256sum -c -
fi

chmod +x "$TMP"
mv "$TMP" "$BIN"
"$BIN" --version
echo "installed at $BIN"
