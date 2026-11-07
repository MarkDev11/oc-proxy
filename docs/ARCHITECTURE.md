# Architecture

## Diagram

```
client (OpenAI SDK / curl / OpenCode / DeepSeek Harness)
        |
        v
https://oc-proxy-termux.tail81c43d.ts.net
        |  Tailscale Funnel (public HTTPS, userspace tailscaled)
        v
127.0.0.1:8791  serve-local.js (Bun)
        |
        |  OpenAI-compatible facade
        |  tool cap 33 + 11 decoys, headers, <env>, retry
        v
https://opencode.ai/inference/openai/v1/chat/completions
```

Cloudflare Quick Tunnel masih tersedia sebagai opsi, tetapi untuk deployment
sekarang **dimatikan** dengan `TUNNEL_DISABLED=1`.

## Komponen

| Path | Peran |
| --- | --- |
| `serve-local.js` | HTTP server Bun, routing, body limit 8 MB, optional request logging, request ID |
| `api/health.js` | `GET /api/health` |
| `api/v1/models.js` | daftar model `*-free` + alias `oc/` |
| `api/v1/chat/completions.js` | endpoint chat OpenAI, retry/fail-fast, relay SSE |
| `api/v1/messages.js` | facade Anthropic Messages (`/v1/messages`) |
| `lib/opencode.js` | inti fingerprint, tool handling, build body/header, relay/translator |
| `lib/stats.js` | statistik in-memory untuk `/api/stats` dan dashboard |
| `public/index.html` | dashboard |
| `scripts/up.js` | supervisor proses server + tunnel opsional |
| `scripts/start.sh` | start background, health wait, tulis URL |
| `scripts/stop.sh`, `scripts/status.sh` | stop/status |
| `run/` | PID supervisor, `tunnel-url.txt` (gitignored) |
| `logs/` | `up.log`, `oc-proxy.log`, `requests/` jika logging aktif (gitignored) |
| `.env` | konfigurasi dan secret (gitignored, jangan dibaca/dicetak) |

## Alur request chat

1. `serve-local.js` membaca body (maksimal 8 MB). Jika
   `REQUEST_LOG_ENABLED=1`, proxy membuat `x-oc-request-id` dan membuka log
   `logs/requests/<ISO>-<id>.log`; default logging mati.
2. `api/v1/chat/completions.js` memvalidasi gateway key dan model
   (`*-free`).
3. `buildUpstreamBody()`:
   - `normalizeTools()` menyeragamkan bentuk tool.
   - `capClientTools()` memotong caller tools jika lebih dari 33. Untuk caller
     besar, yang dipertahankan adalah 33 nama pada `SAFE_CLIENT_TOOLS`; sisa
     slot diisi tool caller berikutnya. Caller dengan <= 33 tool tidak
     dipotong.
   - `concealFingerprintNames()` mengganti nama caller tool yang bertabrakan
     dengan 11 nama OpenCode tetapi definisinya berbeda, menjadi
     `read_client`, `write_client`, `edit_client`, dan seterusnya.
   - `appendFingerprintTools()` menambahkan 11 definisi OpenCode yang persis
     (`FP_DEFS`) jika belum ada.
   - `retargetToolChoice()` dan `aliasHistoryToolCalls()` menyesuaikan
     `tool_choice`/history terhadap rename.
   - `noteUnavailable()` memberi tahu model bahwa tool FP yang baru
     ditambahkan dan tidak punya padanan caller adalah placeholder.
   - `gateEnvMessage()` menambahkan blok `<env>` sebagai system message
     pertama.
4. `buildHeaders()` membuat/mereuse `ses_...`, `msg_...`,
   `Authorization: Bearer public`, UA OpenCode 1.19.5, dan header
   `x-opencode-*`.
5. `fetchUpstream()` mengirim ke upstream dengan Bun. Status 429/500/502/503/504
   di-retry; 429 dengan `retry-after > 300s` langsung dikembalikan; timeout
   koneksi 20 detik.
6. Respons SSE/JSON diteruskan ke client. `restoreName()` mengembalikan nama
   tool yang di-rename ke nama asli caller.
7. Log ditutup dengan `=== END ... ===`.

## Tool budget (ringkas)

- Maksimum caller tool yang diterima upstream: **33**.
- Ditambah **11** definisi OpenCode (`bash`, `edit`, `glob`, `grep`, `read`,
  `skill`, `task`, `todowrite`, `webfetch`, `websearch`, `write`).
- Total maksimum: **44**.
- Lebih dari 33 caller tool → 429 `FreeUsageLimitError` yang menyesatkan.
- Caller dengan <= 33 tool (contoh OpenCode asli: 11) tidak dipotong.
- Tool caller yang namanya bertabrakan tetapi definisinya beda tetap bisa
  dipakai lewat nama `*_client`; tool FP yang tidak punya padanan diberi catatan
  placeholder.

Detail investigasi: `FREE-TIER.md`.

## Endpoint

Semua `/v1/*` membutuhkan gateway key jika `GATEWAY_API_KEY` di-set.

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/` | dashboard |
| GET | `/api/health`, `/v1/health` | health + runtime |
| GET | `/api/stats`, `/v1/stats` | statistik in-memory |
| GET | `/api/tunnel` | URL publik dari `run/tunnel-url.txt` |
| GET | `/v1/models`, `/api/v1/models` | model free + alias |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` | Anthropic Messages facade |
| OPTIONS | `*` | CORS preflight |

`/api/health`, `/api/stats`, `/api/tunnel`, dan dashboard tidak memakai
gateway key; server hanya listen di `127.0.0.1`, akses publik lewat tunnel.

## Runtime dan mode tunnel

- **Wajib Bun** untuk request ke upstream: `scripts/up.js` menjalankan
  `bun serve-local.js`; health melaporkan `runtime: bun/...`.
- **Tailscale Funnel**: `tailscaled` userspace, tanpa TUN/root. Funnel publik
  port 8791. `PUBLIC_URL` ditulis ke `run/tunnel-url.txt`.
- **Cloudflare Quick Tunnel**: opsional, hanya jika `TUNNEL_DISABLED != 1`.
  Binary `bin/cloudflared` (gitignored). Tidak dipakai pada deployment ini.

## Konfigurasi penting

| Variable | Default | Catatan |
| --- | --- | --- |
| `PORT` / `HOST` | `8791` / `127.0.0.1` | listen lokal |
| `GATEWAY_API_KEY` | — | wajib; comma-separated multi-key |
| `UPSTREAM_BASE_URL` | `https://opencode.ai` | origin upstream |
| `OPENCODE_UA` | UA 1.19.5 | override UA |
| `UPSTREAM_MAX_WAIT_MS` | `120000` | total budget retry |
| `UPSTREAM_RETRY_DELAY_MS` | `2000` | backoff awal |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `20000` | timeout satu percobaan |
| `TUNNEL_DISABLED` | `0` | `1` = tanpa Cloudflare |
| `PUBLIC_URL` | — | URL publik Tailscale |
| `SOFT_DEADLINE_MS` / `ABSOLUTE_DEADLINE_MS` | `0` | cutoff opsional |
| `ANTHROPIC_DEFAULT_MODEL` | `mimo-v2.6-flash-free` | fallback `/v1/messages` |

Nilai secret tidak boleh ditulis di dokumentasi. Lihat `.env.example` untuk
nama variabel.

## Logging

- **Default mati.** Aktifkan hanya untuk debugging dengan
  `REQUEST_LOG_ENABLED=1` lalu restart.
- Saat aktif, hanya `POST /v1/*` dan `/api/v1/*` yang membuat file log.
- Lokasi: `logs/requests/<ISO>-<request-id>.log`, mode `0600`.
- Isi: META, CLIENT REQUEST (cap 4 MB), UPSTREAM REQUEST META, UPSTREAM
  REQUEST BODY (cap 4 MB), event `[upstream]`, raw SSE, CLIENT RESPONSE, END.
- `x-oc-request-id` dikembalikan ke client.
- Redaksi: header sensitif, gateway key, pola `sk-`, `ghp_`, `github_pat_`,
  `Bearer`, `api_key`/`authorization`.
- **Belum aman untuk secret arbitrer di dalam pesan/tool result.** Payload
  harness pernah memuat API key pihak ketiga di tool output. Jangan bagikan
  log/payload; lihat `OPERATIONS.md`.

## Batasan desain

- Satu host, satu identitas upstream, tanpa proxy pool.
- `serve-local.js` memakai HTTP server Node API meski dijalankan Bun.
- Statistik in-memory hilang saat restart.
- Log tidak dirotasi otomatis; bisa membesar.
- Klien dengan >33 tool kehilangan tool di luar 33 terpilih (kecuali
  direpresentasikan oleh 11 tool FP).
- Tool FP adalah decoy; model diberi catatan agar tidak memanggil placeholder
  yang tidak punya padanan.
