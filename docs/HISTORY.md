# History / changelog

Catatan kronologis pekerjaan pada deployment ini. Tanggal utama:
**2026-11-05 s/d 2026-11-06**.

## 1. Awal: reverse proxy + Cloudflare

- oc-proxy dibuat sebagai endpoint OpenAI-compatible untuk free tier
  opencode.ai, awalnya memakai Cloudflare Quick Tunnel.
- Runtime dipaksa **Bun** karena Node/curl mendapat 429; header OpenCode
  1.19.5 dan 11 tool decoy ditambahkan.
- Dashboard, `/v1/models`, `/v1/chat/completions`, `/v1/messages`,
  `/api/health`, `/api/tunnel`, `/api/stats` tersedia.
- Commit terakhir: `b42e230 feat: OpenCode 1.19.5 reverse proxy via Bun +
  Cloudflare Tunnel`.

## 2. Pindah ke Tailscale Funnel

- Cloudflare Quick Tunnel dimatikan (`TUNNEL_DISABLED=1`).
- Tailscale 1.104.5 static arm64 dipasang; `tailscaled` userspace tanpa
  TUN/root; Funnel publik port 8791.
- `PUBLIC_URL` stabil: `https://oc-proxy-termux.tail81c43d.ts.net`.
- `scripts/up.js`, `start.sh`, `status.sh`, README, `.env.example`
  diperbarui untuk mode Tailscale.
- Berhasil: health/models/chat/stream/Anthropic via Funnel.
- Belum: helper start/status Tailscale otomatis.

## 3. Logging dan reliability

- `serve-local.js`:
  - log per-request `logs/requests/<ISO>-<id>.log`;
  - `x-oc-request-id`;
  - META, client request, upstream meta/body, upstream events, raw SSE,
    client response, END;
  - cap body 4 MB;
  - mode file `0600`;
  - redaksi header sensitif, gateway key, pola `sk-`, `ghp_`,
    `github_pat_`, `Bearer`, `api_key`;
  - `AbortController` saat client disconnect.
- `lib/opencode.js`: `summarizeBody()` + export, ringkasan request tanpa isi
  pesan.
- Logging kemudian dijadikan **opt-in** (`REQUEST_LOG_ENABLED=1`) dan default
  mati karena payload bisa memuat secret.
- `api/v1/chat/completions.js` dan `api/v1/messages.js`:
  - `fetchUpstream()` dengan logging;
  - retry 429/5xx;
  - fail-fast 429 `retry-after > 300s`;
  - forward `Retry-After`;
  - `attemptFetch()` timeout 20 detik; timeout tidak di-retry.
- Verifikasi fail-fast: request tiny mendapat 429 dalam ~0,8 detik dengan
  `Retry-After` ~56k.

## 4. Investigasi 429: capture OpenCode asli

- Binary OpenCode 1.19.5 ditemukan; config provider diketahui:
  `api: https://opencode.ai/inference/openai/v1`,
  `npm: @ai-sdk/openai-compatible`, `env: ["OPENCODE_API_KEY"]`.
- `OPENCODE_CONFIG_DIR` dipakai untuk config tambahan (bukan
  `OPENCODE_CONFIG`).
- Capture server SSE valid di port 9911; `opencode run` menangkap 2 request:
  title + main.
- Hasil: header/auth OpenCode asli **sama** dengan proxy; 11 tool; system
  prompt ~9,5k; `max_tokens: 32000`; `tool_choice: auto`.
- Replay body real via Bun → 200. Header/auth/session bukan penyebab 429.

## 5. Menemukan akar masalah

- Body harness penuh: 52 caller tool + 11 decoy = 63 → 429.
- Body dengan **33 caller tool + 11 decoy = 44** → 200.
- 34 caller + 11 = 45 → 429.
- 5 decoy pertama + 33 → 200; 2 decoy + 33 → 429; 11 decoy penuh aman.
- 11 decoy saja + full history 377 message → 200 (history tool yang tidak ada
  tetap diterima).
- Kesimpulan: batas **33 tool non-OpenCode**; pesan 429 menyesatkan. Bukan
  quota/TLS/IP/`<env>` semata.
- Body harness hitam 33+11 → 200, 9,4 detik, 407.677 byte, 377 message.
- `harness_upstream.json` (63 tool/377 msg) diekstrak dari log; script replay
  dibuat.

## 6. Percobaan cap yang gagal

- Versi pertama memakai `TOOL_PRIORITY` luas yang memuat `subagent_fork`,
  `wait_agent`, `web_fetch`, `web_search`, `working_directory`, `write_client`,
  terminal, team, dll.
- `test_build.js` menghasilkan 44 tool tetapi tetap **429**.
- Retest individual:
  - `subagent_fork` + decoy → **429**;
  - `team_task_*`, `terminal_*`, `todo_write` → 200;
  - `wait_agent`, `web_fetch`, `web_search`, `working_directory`,
    `write_client` → 200 setelah retest dengan jeda.
- Uji berikutnya juga 429 karena jaringan/quota tidak stabil
  (`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, 429 dengan retry-after ~46k).
- Broad selected 33 (team/terminal) + 11 → 429 dua kali. Belum pasti apakah
  karena komposisi tool atau 429 transien.
- Upaya alias FP (`webfetch`→`web_fetch`, `bash`→`pwsh`, dll.) dibatalkan
  karena schema argumen berbeda (camelCase vs snake_case); rename nama saja
  tidak cukup.

## 7. Cap final yang bekerja

- Baseline 33 pertama harness dikurangi `plugin_manager`, `ralph`,
  `schedule_list`, `schedule_view`, lalu ditambah `write`, `web_fetch`,
  `web_search`, `todo_write`.
- 33 safe + 11 decoy = 44 → **200**.
- `capClientTools()` sekarang memakai `SAFE_CLIENT_TOOLS` (OpenCode) atau
  `HERMES_SAFE_TOOLS` (Hermes); caller <=33 tidak dipotong; caller >33 diambil
  33 nama safe lalu fallback.
- Tool caller yang bentrok nama/schema di-rename `*_client`; 11 FP di-append;
  FP tanpa padanan diberi catatan placeholder.
- `docs/` dibuat; README diperbarui.

## 8. Verifikasi

- Direct upstream safe 33+11: **200**.
- Proxy lokal full harness: **200**, ~6,3 detik, 44 upstream tool, 377 input,
  body 405.770 byte.
- Public Funnel full harness: **HTTP/2 200**, SSE mulai, lalu
  `Recv failure: Software caused connection abort` setelah 244 byte.
- `npm run check`: **OK**.
- `npm run status`: supervisor running, health ok, `bun/1.4.4`.

## 9. Yang gagal / belum selesai

- Funnel publik memutus payload penuh (caveat utama).
- 503 `fetch connect timeout (reset after 23s)` belum direproduksi setelah
  logging; dugaan timeout harness/upstream hang.
- Rate limit/quota upstream tetap ada; tes intensif memicu 429 transien dan
  gangguan jaringan.
- Log/payload berpotensi memuat secret; redaksi belum lengkap.
- Tailscale masih manual; helper belum ada.
- Airplane mode side task butuh root/Magisk/ADB/Shizuku.
- Perubahan di-commit dan di-push ke `reverse-oc-proxy` (lihat `STATUS.md`).

## 10. Next

- Uji harness asli end-to-end (tool call) lewat lokal dan Funnel.
- Investigasi abort Funnel (`--http1.1`, tanpa `-D`, log `tailscaled`).
- Uji argumen tool `write_client`/`edit_client`/`read_client`,
  `web_fetch`, `web_search`, `todo_write`, `subagent`.
- Amankan/rotasi secret dan bersihkan log uji.
- Buat helper Tailscale; commit setelah diminta.

## 11. Hermes desktop agent (2026-11-07)

- Request logging dinyalakan lagi (`REQUEST_LOG_ENABLED=1`) untuk menangkap
  percobaan Hermes.
- Request Hermes tercatat di
  `logs/requests/2026-11-07T10-53-31-141Z-mw6aca6d-4d376b5f.log`:
  37 client tool, 38 message, 44 upstream tool, status **429** dengan
  `retry-after 47186s`.
- History Hermes yang sama + core 15 tool → **200**, jadi history/ukuran body
  bukan penyebab utama.
- Cap lama memilih 33 tool Hermes pertama dan membuang `write_file`,
  `web_extract`, `tour`, `vision_analyze`; kombinasi itu memicu 429.
- `HERMES_SAFE_TOOLS` ditambahkan: 33 tool (file/shell/web/delegation/skill
  view/project/UI/browser/exec), mengecualikan `setup_mcp`, `skill_manage`,
  `skills_list`, `text_to_speech`.
- Replay body Hermes identik: **200** lokal; **200** via Funnel publik
  (~24 detik).
- `npm run check`: **OK**; server di-restart dengan kode baru.
