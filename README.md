# oc-proxy

OpenAI-compatible proxy for the **opencode.ai free tier**. Runs on this machine
and is exposed to the internet through a **Tailscale Funnel** (public HTTPS).
A Cloudflare Quick Tunnel remains available as an optional alternative — no
Vercel, no proxy pool, zero npm dependencies.

Current free models (2026-11): `mimo-v2.6-flash-free`,
`deepseek-v4.1-flash-free`, `iceman-free`, `beam-free`, `flint-40b-free`,
`nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`,
`hy4-flash-free`, `tidepool-alpha-free`, and `jev-1.13-free` (System One
decision model, plus `oc/` aliases). The list is fetched live from upstream and
cached for 5 minutes.

## Architecture

```
client (OpenAI SDK / curl / opencode)
        |
        v
https://<node>.<tailnet>.ts.net   Tailscale Funnel (public HTTPS)
        |
        v
127.0.0.1:8791  serve-local.js (Bun)
        |
        v
127.0.0.1:28091  wireproxy (Cloudflare WARP, userspace WireGuard)
        |
        v
https://opencode.ai/inference/openai/v1/chat/completions
```

The proxy reproduces the current OpenCode CLI request closely enough for the
free tier to accept it:

* **Bun runtime** — the upstream fingerprints the TLS/HTTP client. The proxy
  server runs under Bun (same runtime as OpenCode 1.19.5); the supervisor is
  Node. Bare Node/curl requests can be rejected with `429` and are not valid
  health checks for the upstream.
* **Client headers** — `authorization: Bearer <OpenCode Console key>`, OpenCode
  UA (`opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/<ver>`),
  `x-opencode-client: cli`, `x-opencode-project: global`,
  `x-opencode-request: msg_...`, `x-opencode-session` + `x-opencode-session-id:
  ses_...`. The key is read from `run/opencode-console.key` (mode 600) or
  `OPENCODE_CONSOLE_KEY`; `Bearer public` remains the fallback but some WARP
  egresses answer 429 until the real key is used.
* **Tool budget** — the free tier rejects requests with more than 33
  non-OpenCode tools using a misleading `429 FreeUsageLimitError`. Callers with
  more than 33 tools are reduced to a verified-safe 33-tool core; the 11 exact
  OpenCode fingerprint tools are appended, for 44 total. Hermes/desktop
  toolsets use a separate tested-safe 33 (MCP setup, skill manage/list, and TTS
  excluded).
* **Tool fingerprint** — the 11 exact OpenCode tool definitions are appended as
  decoys. Caller tools with the same name but a different definition are
  aliased (`read_client`) and restored in the response; appended fingerprint
  tools that have no caller equivalent are marked unavailable in the prompt.
* **Environment metadata** — OpenCode sends an `<env>` block in the system
  prompt. The proxy prepends the same inert block for fingerprint fidelity; it
  is not sufficient alone.
* **Retry** — 429/5xx are retried with capped exponential backoff
  (`UPSTREAM_MAX_WAIT_MS`, default 120s). A 429 whose body contains
  `FreeUsageLimitError` is a real per-model, per-egress quota: the request is
  held while WARP is rotated (no cooldown, up to `WARP_QUOTA_ROTATE_ROUNDS`
  rounds, 5s between failed rounds) and retried on the new address. Other long
  429s are usually a composition/fingerprint rejection with a misleading
  "until midnight" `retry-after`: they get one short fresh-session retry, then
  are surfaced; bisect tool names, alias them, and replay.

### WARP egress (default)

The working free-tier egress is a userspace WireGuard `wireproxy` instance at
`127.0.0.1:28091`, backed by a WARP device that oc-proxy owns
(`run/warp-device.json`). `scripts/warp_register.js` registers/rotates the
device, rebuilds `run/warp-wireproxy.conf`, restarts wireproxy, and verifies the
new egress with the exact OpenCode fingerprint request. A 429 burns the prefix
and rotates again until a model returns 200.

`run/upstream-proxy.txt` points at `http://127.0.0.1:28091`, so upstream
traffic uses WARP by default. The dashboard Console tab has the same
**route upstream through WARP** toggle, plus Rotate / Start / Stop controls.
The legacy usque MASQUE engine (`127.0.0.1:28090`, `scripts/warp_rotate.sh`)
remains available with `WARP_ENGINE=usque`. Full runbook:
[`docs/WARP.md`](docs/WARP.md).

## Documentation

Detailed notes live in [`docs/`](docs/README.md): current status and known
issues, the 429/tool-budget investigation, harness notes, operations runbook,
architecture, and history.

## Requirements

* Linux (tested on Ubuntu under proot/Termux, aarch64)
* Node.js >= 20.12 (supervisor, dashboard)
* **Bun** (upstream fingerprint) — `npm i -g bun`
* **wireproxy** — vendored at `vendor/wireproxy`; `scripts/wireproxy.sh` copies
  it to `/tmp/opencode/wireproxy` because the root overlay is `noexec`
* **Tailscale** (userspace `tailscaled`, no TUN/root) for Funnel
* `cloudflared` — only for the optional Cloudflare Quick Tunnel

## Quick start

```bash
cd ~/oc-proxy
cp .env.example .env                 # if .env does not exist yet
# edit .env and set GATEWAY_API_KEY (openssl rand -hex 24)
npm run bg                           # supervisor + server (+ Cloudflare if enabled)
npm run status
```

`npm run bg` prints the local and public URLs. With Tailscale Funnel the
hostname is stable and comes from `PUBLIC_URL`; a Quick Tunnel URL (if enabled)
is random and changes after every restart. Both are written to
`run/tunnel-url.txt`.

Stop / inspect:

```bash
npm run stop
npm run status
tail -f logs/up.log logs/oc-proxy.log logs/cloudflared.log
```

Run in the foreground (no tunnel):

```bash
npm run server        # bun serve-local.js
```

## Public access

### Tailscale Funnel (current setup)

Tailscale runs in userspace mode, so it works under proot without
`/dev/net/tun` or root. `scripts/tailscale.sh` owns the daemon and serve config:

```bash
npm run ts:ensure     # start tailscaled (if needed) + funnel --bg 8791
npm run ts:status     # daemon state + funnel status
npm run ts:url        # print https://<node>.<tailnet>.ts.net
```

First-time login (prints an AuthURL to open):

```bash
bin/tailscale --socket=run/tailscale/socket up \
  --operator=container --hostname=oc-proxy \
  --accept-dns=false --accept-routes=false --netfilter-mode=off
```

If Funnel is not enabled for the tailnet, the first `ensure` prints the
admin-console URL (`https://login.tailscale.com/f/funnel?node=...`).

Set these in `.env`, then `npm run stop && npm run bg`:

```bash
TUNNEL_DISABLED=1
PUBLIC_URL=https://<node>.<tailnet>.ts.net
```

`start.sh` calls `ts:ensure` in the background when `PUBLIC_URL` is a `*.ts.net`
host, and `stop.sh` turns the funnel off. Funnel is public; the gateway key
still protects `/v1/*`. For tailnet-only access, use `tailscale serve --bg 8791`
instead of `funnel`.

### Cloudflare Quick Tunnel (optional)

Keep `TUNNEL_DISABLED=0` (the default), run `npm run install:tunnel` once, then
`npm run bg`. Use `TUNNEL_PROTOCOL=http2` if QUIC/UDP is unreliable on your
network.

## Endpoints

All `/v1/*` endpoints require `Authorization: Bearer $GATEWAY_API_KEY` when the
key is set. `GET /api/health`, `GET /api/tunnel`, `GET /api/stats` and the
dashboard are unauthenticated (the server binds to 127.0.0.1 and the tunnel is
the only public path).

* `GET /v1/models` — every `*-free` model plus `oc/` aliases.
* `POST /v1/chat/completions` — OpenAI shape: `messages`, `tools`,
  `tool_choice`, `stream`, `max_tokens`, `temperature`, `top_p`. Any `*-free`
  model is accepted (400 otherwise).
* `POST /v1/messages` — Anthropic Messages facade (used by Claude-style
  clients).
* `POST /v1/responses` — Codex CLI Responses facade; bridged to Chat
  Completions upstream and translated back to Responses SSE.
* `GET /api/health` — health check.
* `GET /api/tunnel` — `{ "url": "https://<public-host>" }`.
* `GET /api/warp` — WARP rotation status (requires the gateway key).
* `POST /api/warp/{rotate,start,stop}` — control the active WARP engine
  (`wireproxy` by default, legacy `usque` when `WARP_ENGINE=usque`; requires the
  gateway key; `rotate` returns `409` if one is already running).
* `POST /api/warp/upstream` — `{ "enabled": true|false }` toggles routing
  upstream through the local WARP proxy (requires the gateway key; `409` when
  locked by `UPSTREAM_PROXY`).
* `GET /` — live dashboard (model, speed, context fill, recent requests,
  per-model totals; in-memory only, resets on restart).

Examples:

```bash
URL=$(cat run/tunnel-url.txt)

curl "$URL/v1/models" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl "$URL/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash-free",
       "messages":[{"role":"user","content":"Reply with exactly OK"}]}'

curl -N "$URL/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free",
       "messages":[{"role":"user","content":"Weather in Jakarta?"}],
       "tools":[{"type":"function","function":{
         "name":"get_weather",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
       "tool_choice":"auto","stream":true}'
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8791` / `127.0.0.1` | Local listen address |
| `GATEWAY_API_KEY` | — | Required gateway key; comma-separated multi-key allowed |
| `UPSTREAM_BASE_URL` | `https://opencode.ai` | Upstream origin |
| `OPENCODE_UA` | current OpenCode UA | Override the spoofed user agent |
| `BUN_BIN` | `bun` | Bun binary used by the supervisor |
| `UPSTREAM_MAX_WAIT_MS` | `120000` | Max time spent retrying upstream 429/5xx |
| `UPSTREAM_RETRY_DELAY_MS` | `2000` | Initial retry backoff |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `20000` | Per-attempt connect timeout; not retried |
| `UPSTREAM_PROXY` | — | Lock upstream calls to this HTTP proxy (overrides the Console toggle) |
| `OPENCODE_CONSOLE_KEY` | — | OpenCode Console key; falls back to `run/opencode-console.key`, then `public` |
| `OPENCODE_KEY_FILE` | `run/opencode-console.key` | Key file read by `lib/opencode.js` |
| `WARP_ENGINE` | `wireproxy` | Egress engine: `wireproxy` (default) or legacy `usque` |
| `WARP_WIREPROXY_PORT` / `WARP_WIREPROXY_INFO_PORT` | `28091` / `28092` | wireproxy HTTP proxy / info ports |
| `WARP_MAX_ATTEMPTS` | `5` | Max WARP device rotations per `warp_register.js` run |
| `WARP_ROTATE` | `0` | With `start.sh`, verify the egress at startup and rotate if it is not 200 |
| `WARP_FAIL_BACKOFF` | `300` | Seconds to pause usque rotation after a failure |
| `WARP_VERIFY_MODELS` | deepseek, mimo, tidepool | Models that must all return 200 before a WARP egress is accepted |
| `WARP_QUOTA_ROTATE_ROUNDS` | `6` | Max rotation rounds per request while holding for quota |
| `WARP_AUTO_ROTATE_TIMEOUT_MS` | `180000` | Max time for one rotation round |
| `WARP_COOLDOWN` | `600` | Seconds before a rejected prefix may be reused |
| `WARP_POLL` | `5` | usque monitor log/health poll interval (seconds) |
| `WARP_PROXY_PORT` / `WARP_FWD_PORT` | `28090` / `24443` | Legacy usque HTTP proxy / TCP relay ports |
| `SOFT_DEADLINE_MS` | `0` (off) | Graceful `finish_reason: "length"` cutoff |
| `ABSOLUTE_DEADLINE_MS` | `0` (off) | Hard request deadline |
| `REQUEST_LOG_ENABLED` | `0` | Enable per-request body logging; off by default |
| `TUNNEL_DISABLED` | `0` | Skip the built-in Cloudflare Quick Tunnel |
| `PUBLIC_URL` | — | External URL written to `run/tunnel-url.txt` |
| `CLOUDFLARED_BIN` | `bin/cloudflared` | Cloudflare tunnel binary |
| `TUNNEL_PROTOCOL` | auto | Force `http2` / `quic` |
| `TUNNEL_URL_FILE` | `run/tunnel-url.txt` | Where the supervisor writes the URL |

## Troubleshooting

* **`429 FreeUsageLimitError` on every request** — the free tier quotas are
  per model per egress address. The proxy holds the request, rotates WARP, and
  retries like opencode-hop: one shared rotation at a time, no cooldown, up to
  `WARP_QUOTA_ROTATE_ROUNDS` rounds. It only returns 429 after every round
  failed; check `npm run warp:status` and `logs/warp-register.log`. A 429
  without that error type is usually a composition/fingerprint rejection:
  capture the request, bisect tool names, alias the trigger, and replay. The
  proxy retries up to `UPSTREAM_MAX_WAIT_MS`.
* **`cloudflared` missing** — only needed for the Quick Tunnel:
  `npm run install:tunnel`.
* **Funnel returns 502** — the local server or `tailscaled` is down. Check
  `npm run status` and `tailscale funnel status`; restart `tailscaled` if
  needed.
* **Quick Tunnel URL changed** — Quick Tunnels are ephemeral. Read
  `run/tunnel-url.txt` or `npm run status`. Use Funnel or a named tunnel for a
  stable hostname.
* **Cloudflare tunnel returns 530 / stalls at "Registered tunnel connection"** —
  QUIC/UDP is unreliable on some networks. Set `TUNNEL_PROTOCOL=http2` in
  `.env` and restart (`npm run stop && npm run bg`).
* **Empty completion from `mimo`/`hy4`** — reasoning/upstream flakiness; retry
  or raise `max_tokens`.
* **WARP rotation fails or 429 persists** — read `logs/warp-register.log` for
  the default wireproxy engine (`logs/warp-rotate.log` and `logs/warp-usque.log`
  for legacy usque). The 429 is usually composition-based, not quota; rotation
  only helps when the egress prefix itself is rejected. Run
  `bash scripts/wireproxy.sh test` and `bash scripts/wireproxy.sh rotate` to
  verify/rotate manually. If every WARP prefix is rejected but direct egress
  works, turn the upstream WARP toggle off.
* **wireproxy config missing** — `bash scripts/wireproxy.sh start` rebuilds
  `run/warp-wireproxy.conf` from `run/warp-device.json`; if the device is also
  missing, run `bun scripts/warp_register.js --register`.
* **`usque` binary/config missing** — only needed for `WARP_ENGINE=usque`; set
  `USQUE_DIR`, `USQUE_BIN`, and `WARP_CONFIG`; see
  [`docs/WARP.md`](docs/WARP.md).
* **Check syntax** — `npm run check`.

## Caveats

* The proxy spoofs OpenCode's client fingerprint to use the free tier outside
  the official CLI. This may violate the provider's terms and can be blocked at
  any time; upstream changes may require updating the tools, headers, or the
  `<env>` shim.
* Always set `GATEWAY_API_KEY`. Funnel and Quick Tunnel URLs are public; without
  a key anyone who finds them can consume the free quota.
* No proxy pool, no Vercel: one host, one upstream identity. If upstream
  rejects a request composition or fingerprint, inspect and fix the request
  shape; do not treat the misleading 429 as exhausted quota.
