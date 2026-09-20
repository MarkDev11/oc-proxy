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

1. Push folder ini ke repo Git baru.
2. Vercel -> Add New Project -> import repo. Framework preset: Other.
3. Env (optional tapi disarankan): `GATEWAY_API_KEY=sk-...` (boleh CSV multi-key).
4. Deploy. Base URL: `https://<app>.vercel.app/v1`
   (`vercel.json` me-rewrite `/v1/*` -> `/api/v1/*`).

Option B — CLI:

```bash
npm i -g vercel
cd oc-proxy
vercel env add GATEWAY_API_KEY
vercel --prod
```

Catatan `maxDuration: 60` di `vercel.json` hanya full di plan Pro.
Di Hobby, durasi function dibatasi plan — request agentik panjang bisa
kepotong. Untuk run panjang, pertimbangkan HF Space / VPS.

## Endpoints

* `GET /v1/models` — list 4 id (`oc/` alias + bare).
* `POST /v1/chat/completions` — OpenAI shape (`messages`, `tools`,
  `tool_choice`, `stream`). Hanya 2 model free yang diterima (400 jika lain).
* `GET /api/health` — cek deploy.

Contoh:

```bash
curl https://<app>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"oc/muse-spark-1.3-contributor-free",
       "messages":[{"role":"user","content":"jawab OK"}]}'

curl -N https://<app>.vercel.app/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"oc/muse-spark-1.2-contributor-free",
       "messages":[{"role":"user","content":"Cuaca Jakarta?"}],
       "tools":[{"type":"function","function":{
         "name":"get_weather",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
       "tool_choice":"auto","stream":true}'
```

## Local check

```bash
npm run check
```

## Peringatan

* Free tier upstream agresif rate-limit (`429 FreeUsageLimitError`) — normal,
  retry dengan jeda.
* Cloak decoy pada dasarnya memalsukan cek `within OpenCode`. Jangan expose
  publik tanpa `GATEWAY_API_KEY` + rate limit sendiri; sewaktu-waktu bisa
  diblok upstream.
* File ini port dari bundle 9Router v0.5.81 + PR #4165 (belum merge saat
  ditulis). Jika upstream mengubah kontrak Responses, proxy harus ikut update.
