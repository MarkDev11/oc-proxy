# oc-proxy

Thin OpenAI-compatible proxy for the **opencode.ai free tier** (every `*-free`
model: `muse-spark-1.3-contributor-free`, `deepseek-v4.1-flash-free`,
`mimo-v2.6-flash-free`, ...). Vercel-ready, zero dependencies. Logic ported
from 9Router (PR #4842 opencode v2 fingerprint).

## Why this exists

Since 2026-10-14, OpenCode v2 moved free inference off `/zen/v1` onto
`/inference/v1` and every free request returns
`403 FreeTierError (...only be used from within OpenCode)` unless it carries
OpenCode's own client fingerprint. This proxy reproduces that fingerprint
unconditionally, then translates back to OpenAI `chat.completions`:

* Endpoint `/inference/v1/responses` (muse-spark) or
  `/inference/v1/chat/completions` (all other `*-free` models).
* v2 UA `opencode/latest/2.0.26/cli` + `x-opencode-session` **and**
  `x-opencode-session-id` (a session id whose prefix encodes a small counter).
* OpenCode's exact `read` + `shell` tool definitions (description + schema are
  compared verbatim upstream) as decoys, with `tool_choice` forced to `auto`.
  A caller tool already named `read`/`shell` with a different definition is
  aliased to `read_client`/`shell_client` and restored on the response.

## Deploy (Vercel)

Option A — dashboard:

1. Push this folder to a new Git repo.
2. Vercel -> Add New Project -> import the repo. Framework preset: Other.
3. Env (optional but recommended): `GATEWAY_API_KEY=sk-...` (comma-separated
   multi-key supported).
4. Deploy. Base URL: `https://<app>.vercel.app/v1`
   (`vercel.json` rewrites `/v1/*` -> `/api/v1/*`).

Option B — CLI:

```bash
npm i -g vercel
cd oc-proxy
vercel env add GATEWAY_API_KEY
vercel --prod
```

Note: `maxDuration: 60` in `vercel.json` only fully applies on the Pro plan.
On Hobby, function duration is plan-limited — very long agentic runs may get
cut off. For long runs, consider an HF Space / VPS instead.

## Endpoints

* `GET /v1/models` — lists every `*-free` opencode model (`id` + `oc/` alias),
  fetched live from upstream and cached 5 min.
* `POST /v1/chat/completions` — OpenAI shape (`messages`, `tools`,
  `tool_choice`, `stream`). Any `*-free` model is accepted (400 otherwise).
* `GET /api/health` — deployment check.
* `GET /` — live monitor dashboard for this proxy (model state, speed, context
  fill, recent requests, per-model totals; no hardware cards). Real-time polling
  runs only while the page is open; stats are in-memory per instance and reset
  on cold start — nothing is stored.
* `GET /api/stats` — trimmed request stats snapshot (JSON) behind the dashboard.

Examples:

```bash
curl https://<app>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"oc/muse-spark-1.3-contributor-free",
       "messages":[{"role":"user","content":"reply OK"}]}'

curl -N https://<app>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"oc/muse-spark-1.2-contributor-free",
       "messages":[{"role":"user","content":"Weather in Jakarta?"}],
       "tools":[{"type":"function","function":{
         "name":"get_weather",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
       "tool_choice":"auto","stream":true}'
```

## Long tasks (no mid-token cutoffs)

Serverless functions die hard at `maxDuration`, mid-token. This proxy avoids
that: `SOFT_DEADLINE_MS` (default 50000, counted from the first upstream
bytes so slow TTFB doesn't eat the budget) plus `ABSOLUTE_DEADLINE_MS`
(default 55000, final failsafe) stop reading upstream early and close the
response gracefully with `finish_reason: "length"` (or `"tool_calls"` if a
tool call already completed). Agent loops treat `"length"` as "continue the
turn", append the partial output, and resend — so long coding tasks survive
as a chain of short requests instead of one killed stream.

Tune per plan: Hobby (short limit) -> lower `SOFT_DEADLINE_MS`; Pro ->
raise both `maxDuration` and the deadline.

## Proxy fallback (optional, for 429s)

When `PROXY_FALLBACK=1` and `PROXY_POOL_URL` point to a fresh pool (maintained
by GitHub Actions on the `pool` branch, every 15 min), the proxy retries
once via a healthy HTTP proxy **only** on retryable upstream failures
(`429`/`502`/`503`). Normal requests stay direct — no added latency. Pool
entries older than 1 hour or transparent proxies are discarded; failed
proxies are cooled down for 30 min.

```bash
PROXY_FALLBACK=1
PROXY_POOL_URL=https://cdn.jsdelivr.net/gh/MarkDev11/oc-proxy@pool/pool.json
PROXY_TIMEOUT_MS=25000
```

## Local check

```bash
npm run check
node scripts/validate-pool.js  # writes pool.json locally for testing
```

## Caveats

* The upstream free tier rate-limits aggressively (`429 FreeUsageLimitError`) —
  that's normal, retry with backoff.
* The decoy cloak essentially spoofs the `within OpenCode` check. Don't expose
  publicly without `GATEWAY_API_KEY` + your own rate limiting; upstream may
  block it at any time.
* Ported from 9Router's opencode executor + fingerprint (PR #4842). If upstream
  changes the `/inference/v1` contract or the fingerprint tools, this proxy
  must be updated too.
