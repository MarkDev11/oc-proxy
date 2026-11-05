# oc-proxy

OpenAI-compatible proxy for the **opencode.ai free tier**. Runs on this machine
and is exposed to the internet through a **Cloudflare Quick Tunnel** — no Vercel,
no proxy pool, zero npm dependencies.

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
https://<random>.trycloudflare.com   Cloudflare Quick Tunnel
        |
        v
127.0.0.1:8791  serve-local.js (Bun)
        |
        v
https://opencode.ai/inference/openai/v1/chat/completions
```

The proxy reproduces the current OpenCode CLI request closely enough for the
free tier to accept it:

* **Bun runtime** — the upstream fingerprints the TLS/HTTP client. Node and curl
  get `429 FreeUsageLimitError` even with identical headers/body; Bun (same
  runtime as OpenCode 1.19.5) passes. `serve-local.js` is therefore started with
  Bun by the supervisor.
* **Client headers** — `authorization: Bearer public`, OpenCode UA
  (`opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/<ver>`),
  `x-opencode-client: cli`, `x-opencode-project: global`,
  `x-opencode-request: msg_...`, `x-opencode-session` + `x-opencode-session-id:
  ses_...`.
* **Tool fingerprint** — the 11 exact OpenCode tool definitions are appended as
  decoys. Caller tools with the same name but a different definition are
  aliased (`read_client`) and restored in the response.
* **System prompt gate** — the free tier also requires an OpenCode-style
  `<env>` block in the system prompt. The proxy prepends a small, inert
  environment block as the first system message; the caller's messages follow
  unchanged.
* **Retry** — 429/5xx are retried with capped exponential backoff
  (`UPSTREAM_MAX_WAIT_MS`, default 120s) because the free tier rate-limits
  bursts and reports a misleading "until midnight" `retry-after`.

## Requirements

* Linux (tested on Ubuntu under proot/Termux, aarch64)
* Node.js >= 20.12 (supervisor, dashboard)
* **Bun** (upstream fingerprint) — `npm i -g bun`
* `cloudflared` — installed automatically by `npm run install:tunnel`

## Quick start

```bash
cd ~/oc-proxy
cp .env.example .env                 # if .env does not exist yet
# edit .env and set GATEWAY_API_KEY (openssl rand -hex 24)
npm run install:tunnel               # downloads bin/cloudflared (SHA256 verified)
npm run bg                           # supervisor + server + tunnel
npm run status
```

`npm run bg` prints the local and public URLs. The Quick Tunnel URL is random
and changes after every restart; it is written to `run/tunnel-url.txt`.

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
* `GET /api/health` — health check.
* `GET /api/tunnel` — `{ "url": "https://...trycloudflare.com" }`.
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
| `SOFT_DEADLINE_MS` | `0` (off) | Graceful `finish_reason: "length"` cutoff |
| `ABSOLUTE_DEADLINE_MS` | `0` (off) | Hard request deadline |
| `CLOUDFLARED_BIN` | `bin/cloudflared` | Tunnel binary |
| `TUNNEL_PROTOCOL` | auto | Force `http2` / `quic` |
| `TUNNEL_URL_FILE` | `run/tunnel-url.txt` | Where the supervisor writes the URL |

## Troubleshooting

* **`429 FreeUsageLimitError` on every request** — make sure the server runs
  under Bun (`npm run bg` logs `starting oc-proxy ... (bun)`), and that the
  request reached the proxy (the `<env>` shim is injected automatically). The
  free tier still has genuine rate limits; the proxy retries for up to
  `UPSTREAM_MAX_WAIT_MS`.
* **`cloudflared` missing** — `npm run install:tunnel`.
* **Tunnel URL changed** — Quick Tunnels are ephemeral. Read
  `run/tunnel-url.txt` or `npm run status`. Use a named tunnel if you need a
  stable hostname.
* **Tunnel returns 530 / stalls at "Registered tunnel connection"** — QUIC/UDP
  is unreliable on some networks. Set `TUNNEL_PROTOCOL=http2` in `.env` and
  restart (`npm run stop && npm run bg`).
* **Empty completion from `mimo`/`crouton`** — reasoning/upstream flakiness; retry
  or raise `max_tokens`.
* **Check syntax** — `npm run check`.

## Caveats

* The proxy spoofs OpenCode's client fingerprint to use the free tier outside
  the official CLI. This may violate the provider's terms and can be blocked at
  any time; upstream changes may require updating the tools, headers, or the
  `<env>` shim.
* Always set `GATEWAY_API_KEY`. The Quick Tunnel URL is public; without a key
  anyone who finds it can consume the free quota.
* No proxy pool, no Vercel: one host, one upstream identity. If the upstream
  rate-limits this host, requests wait and then fail.
