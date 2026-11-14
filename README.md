# oc-proxy

OpenAI-compatible proxy for the **opencode.ai free tier**. Runs on this machine
and is exposed to the internet through a **Tailscale Funnel** (public HTTPS).
A Cloudflare Quick Tunnel remains available as an optional alternative — no
Vercel, no proxy pool, zero npm dependencies.

Current free models (2026-11): `beam-free`, `flint-40b-free`,
`mimo-v2.6-flash-free`, `nemotron-3.5-super-vl-free`,
`nemotron-3.5-lightning-free`, `deepseek-v4.1-flash-free`,
`glm-5.3-flash-free`, `pulse-alpha-free`, `crouton-alpha-free` (plus `oc/`
aliases). The list is fetched live from upstream and cached for 5 minutes.

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
https://opencode.ai/inference/openai/v1/chat/completions
```

The proxy reproduces the current OpenCode CLI request closely enough for the
free tier to accept it:

* **Bun runtime** — the upstream fingerprints the TLS/HTTP client. The proxy
  and supervisor run under Bun (same runtime as OpenCode 1.19.5). Bare
  Node/curl requests can be rejected with `429` and are not valid health
  checks for the upstream.
* **Client headers** — `authorization: Bearer public`, OpenCode UA
  (`opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/<ver>`),
  `x-opencode-client: cli`, `x-opencode-project: global`,
  `x-opencode-request: msg_...`, `x-opencode-session` + `x-opencode-session-id:
  ses_...`.
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
  (`UPSTREAM_MAX_WAIT_MS`, default 120s). A 429 is normally a composition or
  fingerprint rejection with a misleading "until midnight" `retry-after`, not
  a real quota. A 429 with `retry-after > 300s` gets one short retry with a
  fresh session, then is surfaced instead of stalling; bisect tool names,
  alias them, and replay.

## Documentation

Detailed notes live in [`docs/`](docs/README.md): current status and known
issues, the 429/tool-budget investigation, harness notes, operations runbook,
architecture, and history.

## Requirements

* Linux (tested on Ubuntu under proot/Termux, aarch64)
* Node.js >= 20.12 (supervisor, dashboard)
* **Bun** (upstream fingerprint) — `npm i -g bun`
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
`/dev/net/tun` or root:

```bash
tailscaled --tun=userspace-networking \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --socks5-server=127.0.0.1:1055 \
  --outbound-http-proxy-listen=127.0.0.1:1055 &

tailscale --socket=/var/run/tailscale/tailscaled.sock up \
  --hostname=<node> --accept-dns=false --accept-routes=false --netfilter-mode=off
tailscale --socket=/var/run/tailscale/tailscaled.sock funnel --bg 8791
```

Set these in `.env`, then `npm run stop && npm run bg`:

```bash
TUNNEL_DISABLED=1
PUBLIC_URL=https://<node>.<tailnet>.ts.net
```

Funnel is public; the gateway key still protects `/v1/*`. For tailnet-only
access, use `tailscale serve --bg 8791` instead of `funnel`.

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
  -d '{"model":"glm-5.3-flash-free",
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
| `SOFT_DEADLINE_MS` | `0` (off) | Graceful `finish_reason: "length"` cutoff |
| `ABSOLUTE_DEADLINE_MS` | `0` (off) | Hard request deadline |
| `REQUEST_LOG_ENABLED` | `0` | Enable per-request body logging; off by default |
| `TUNNEL_DISABLED` | `0` | Skip the built-in Cloudflare Quick Tunnel |
| `PUBLIC_URL` | — | External URL written to `run/tunnel-url.txt` |
| `CLOUDFLARED_BIN` | `bin/cloudflared` | Cloudflare tunnel binary |
| `TUNNEL_PROTOCOL` | auto | Force `http2` / `quic` |
| `TUNNEL_URL_FILE` | `run/tunnel-url.txt` | Where the supervisor writes the URL |

## Troubleshooting

* **`429 FreeUsageLimitError` on every request** — make sure the server runs
  under Bun (`npm run bg` logs `starting oc-proxy ... (bun)`), and that the
  request reached the proxy (the `<env>` shim is injected automatically). This
  429 is a composition/fingerprint rejection, not a quota: capture the request,
  bisect tool names, alias the trigger, and replay. The proxy retries up to
  `UPSTREAM_MAX_WAIT_MS`.
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
* **Empty completion from `mimo`/`crouton`** — reasoning/upstream flakiness; retry
  or raise `max_tokens`.
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
