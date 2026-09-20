# oc-proxy

Thin OpenAI-compatible proxy for the **opencode.ai zen free tier**
(`muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`).
Vercel-ready, zero dependencies. Logic ported from 9Router PR #4165.

## Why this exists

Upstream `POST https://opencode.ai/zen/v1/responses` returns
`403 FreeTierError (...only be used from within OpenCode)` unless **every**
Responses request carries both `bash` + `read` function tools **and**
`tool_choice: "auto"`. This proxy injects those decoys unconditionally
(plus forces `auto` on the two free models), then translates the Responses
SSE stream back to OpenAI `chat.completions` format.

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

* `GET /v1/models` — lists 4 ids (`oc/` alias + bare).
* `POST /v1/chat/completions` — OpenAI shape (`messages`, `tools`,
  `tool_choice`, `stream`). Only the two free models are accepted (400 otherwise).
* `GET /api/health` — deployment check.

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

## Local check

```bash
npm run check
```

## Caveats

* The upstream free tier rate-limits aggressively (`429 FreeUsageLimitError`) —
  that's normal, retry with backoff.
* The decoy cloak essentially spoofs the `within OpenCode` check. Don't expose
  publicly without `GATEWAY_API_KEY` + your own rate limiting; upstream may
  block it at any time.
* Ported from the 9Router v0.5.81 bundle + PR #4165 (unmerged at time of
  writing). If upstream changes the Responses contract, this proxy must be
  updated too.
