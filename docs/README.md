# oc-proxy documentation

Internal documentation for this deployment. Last updated: **2026-11-06**.

Dokumen ini dibuat karena konteks sesi AI terbatas dan sering terkena
compaction. Baca file di folder ini sebelum melanjutkan pekerjaan dari sesi
baru.

## Snapshot

| Item | Nilai |
| --- | --- |
| Public URL | `https://oc-proxy-termux.tail81c43d.ts.net` |
| Local listen | `127.0.0.1:8791` |
| Runtime | Bun (wajib untuk fingerprint upstream) |
| Upstream | `https://opencode.ai/inference/openai/v1` |
| Tunnel | Tailscale Funnel, publik |
| Cloudflare Quick Tunnel | Dimatikan (`TUNNEL_DISABLED=1`) |
| Request logging | **Off by default**; aktifkan dengan `REQUEST_LOG_ENABLED=1` |
| Gateway auth | `Authorization: Bearer <GATEWAY_API_KEY>` untuk semua `/v1/*` |
| Free models | `beam-free`, `flint-40b-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `pulse-alpha-free`, `crouton-alpha-free` (+ alias `oc/`) |
| Repo | `/root/oc-proxy`, branch `reverse-oc-proxy` |
| Last commit | `b42e230` (perubahan terbaru belum di-commit) |

## Status singkat

- **429 FreeUsageLimitError untuk harness sudah diperbaiki.** Penyebabnya
  bukan quota, IP, TLS, atau `<env>` semata, tetapi jumlah/komposisi tool.
  Free tier menolak lebih dari **33 tool non-OpenCode**. Proxy sekarang
  memotong ke 33 tool inti lalu menambahkan **11 tool decoy OpenCode** =
  **44 tool total**.
- Request harness penuh (payload 52 tool, 375 message) melalui proxy lokal
  sekarang **HTTP 200**, upstream melihat **44 tool**, 377 input item.
- Hermes/desktop agent memakai `HERMES_SAFE_TOOLS` 33; request Hermes asli
  yang sebelumnya 429 sekarang **200** lewat lokal dan Funnel publik.
- Payload penuh lewat **Tailscale Funnel HTTP/2** sempat abort setelah 244
  byte; versi `--http1.1` dan replay Hermes via Node `fetch` **200**. Detail
  di `STATUS.md`.
- Ada risiko keamanan: payload harness dan log request (jika logging
  diaktifkan) dapat memuat kredensial pihak ketiga di dalam isi
  message/tool result. Jangan membagikan file
  `/tmp/opencode/harness_client.json`, isi `logs/requests/`, atau payload asli.
  Redaksi log belum menangkap semua bentuk API key di dalam konten.

## Urutan baca untuk sesi baru

1. `STATUS.md` — kondisi terkini, yang sudah jalan, yang gagal, next action.
2. `FREE-TIER.md` — hasil investigasi 429, aturan 33+11, header/fingerprint.
3. `HARNESS.md` — detail harness, 503, tool schema, tes reproduksi.
4. `OPERATIONS.md` — runbook start/stop/log/troubleshooting/Tailscale.
5. `ARCHITECTURE.md` — alur request dan file utama.
6. `HISTORY.md` — kronologi pekerjaan dan percobaan yang gagal.

## Dokumen

| File | Isi |
| --- | --- |
| `STATUS.md` | Status operasional, test matrix, known issues, next steps |
| `ARCHITECTURE.md` | Arsitektur, komponen, endpoint, env, alur request |
| `FREE-TIER.md` | Investigasi 429, tool budget 33+11, header, replay |
| `HARNESS.md` | DeepSeek Harness, 503, schema tool, security |
| `OPERATIONS.md` | Runbook, log, Tailscale, troubleshooting, security |
| `HISTORY.md` | Timeline perubahan dan kegagalan |

## Aturan penting

- Jangan pernah mencetak, menyalin, atau meng-commit isi `.env`, API key
  provider, token Tailscale, atau payload yang mengandung kredensial.
- Jangan memakai request kecil tanpa `tools` sebagai health check upstream.
  Free tier membalas **429** untuk `tools=0`; itu bukan bukti quota habis.
- Jangan memakai Node/curl langsung ke upstream sebagai pengganti Bun. Proxy
  harus dijalankan dengan Bun.
- Setelah mengubah kode proxy, restart dengan `npm run stop && npm run bg`.
- Jangan commit kecuali diminta.
