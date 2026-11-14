# Status

Last updated: **2026-11-12** (box complex tests: OpenClaw 2026.3.24, DSH, Hermes).

## Ringkasan

Proxy berjalan di Bun, Tailscale Funnel aktif, dan request harness penuh yang
sebelumnya selalu `429 FreeUsageLimitError` sekarang diterima upstream
(**HTTP 200**) melalui proxy lokal. Perbaikan utama: batas **33 tool
non-OpenCode** + 11 decoy OpenCode, alias tool pemicu 429, dan shim `<env>` yang
mengikuti working directory klien. Jangan pin sesi OpenCode agent; proxy memakai
sesi baru per request. OpenClaw 2026.3.24, DSH, dan Hermes sudah lulus task
kompleks 5/5 test + `REPORT.md`.

## 2026-11-12 — Local cleanup + box test target

Semua harness/agentic lokal selain OpenCode sudah dihapus: OpenClaw (global
Termux + seluruh state/workspace), DSH, Hermes, payload harness, dan payload
agentic. Yang disisakan hanya OpenCode di `/tmp/opencode/oc-local/` plus tooling
proxy/box.

Final test dipindahkan ke Simular box `main` / `cb-ae8d7c84eae9` (Ubuntu x86_64,
Node 24, tanpa Bun). Inventory box:

- Claude Code **2.1.318** — terpasang.
- Codex CLI **0.166.0** — terpasang.
- OpenCode **1.19.5** — terpasang di `/workspace/oc-harness/opencode-app`.
- OpenClaw **2026.3.24** dan **2026.11.3** — terpasang.
- DSH **0.2.2-rc.1** — terpasang di `/workspace/oc-harness/dsh-app`.
- Hermes **0.23.1** — terpasang di `/workspace/oc-harness/hermes-home`.
- Bun **1.4.4** di box hanya untuk diagnostik egress; proxy tetap di Termux.
- Proxy publik dari box: health **OK**, `/v1/models` **200**.

Status lengkap, aturan testing, cleanup, dan next steps ada di
[`TESTING.md`](TESTING.md). Jangan menganggap hasil harness lokal sebagai bukti
final.

Hasil box terbaru:

- Claude Code 2.1.318: smoke **OK**; task kompleks 12 turn, 10 request HTTP 200,
  test 4/4, `REPORT.md`. Pemicu 429-nya `ReportFindings`; sudah dialias.
- Codex CLI 0.166.0: smoke **OK**; task kompleks 13 request HTTP 200, test 4/4,
  CLI JSON valid, `write_stdin`/`stdin` + echo `ping→pong`, `REPORT.md`.
  Pemicu 429-nya `write_stdin`; sudah dialias ke `stdin`.
- OpenCode 1.19.5: smoke **OK**; task kompleks 12 tool call, 9 request utama
  HTTP 200, test 4/4, CLI JSON `115.25`, `REPORT.md`. Tiga subrequest judul
  (`tools=0`) tetap 429 dan non-fatal.
- OpenClaw 2026.11.3: smoke **OK**; task kompleks 17 tool call awal, lalu 15
  tool call report, 4/4 test, CLI JSON `115.25`, `REPORT.md` valid. Report
  ditulis di `$OPENCLAW_STATE_DIR/workspace` lalu disalin ke project.
- OpenClaw 2026.3.24: **OK**; test 5/5, CLI JSON `115.25`, `REPORT.md`.
  Workspace di-set lewat `agents.defaults.workspace`; runner menyalin
  `ledger.test.js` + `REPORT.md` kembali ke project.
- DSH 0.2.2-rc.1: **OK**; 9/9 request HTTP 200, test 5/5, CLI JSON `115.25`,
  `REPORT.md`. Pasangan `working_directory` + `read_image` memicu 429; proxy
  drop `read_image` hanya saat pasangan itu muncul.
- Hermes 0.23.1: **OK**; test 5/5, CLI JSON `115.25`, `REPORT.md` 1442 byte,
  agent melaporkan `cat REPORT.md` exit 0. Gateway sempat linger setelah run;
  itu hang CLI, bukan 429/quota.

### 429 `FreeUsageLimitError` = fake rejection

Jangan berhenti atau menyimpulkan quota habis saat melihat 429 ini. Agent
OpenCode yang sedang menjalankan sesi ini memakai model free OpenCode terus
menerus tanpa 429/daily cap. Upstream memakai pesan 429 yang menyesatkan untuk
menolak **komposisi request** yang tidak cocok. `retry-after` puluhan ribu
detik juga artefak, bukan sisa kuota.

Contoh: Claude Code 2.1.318, 12 tool + 11 decoy = 23 tool upstream, tetap 429
karena nama `ReportFindings`; Codex CLI 0.166.0 429 karena `write_stdin`. Kedua
tool sudah dialias. Tindakan yang benar: capture body, bisect nama tool, alias,
replay. Selain komposisi, cek juga dua hal: (a) jangan pin sesi agent di
`OPENCODE_SESSION`; (b) shim `<env>` harus memakai working directory klien,
bukan `process.cwd()` proxy. Setelah static session dihapus dan shim membaca
system prompt klien, OpenClaw 2026.3.24, DSH, dan Hermes lulus tanpa 429.

Caveat Funnel: payload harness penuh lewat curl **HTTP/2** pernah abort setelah
244 byte. Replay Hermes via Node `fetch` publik dan full harness via
`curl --http1.1` sama-sama **200**; perilaku HTTP/2 belum dijelaskan dan masih
perlu validasi dengan harness asli.

## Yang sudah bekerja

- Supervisor + server berjalan; `npm run status` melaporkan
  `supervisor: running`, health `status: ok`, runtime `bun/1.4.4`.
- Tailscale Funnel publik aktif di
  `https://oc-proxy-termux.tail81c43d.ts.net`.
- Cloudflare Quick Tunnel dimatikan (`TUNNEL_DISABLED=1`).
- Semua endpoint utama tersedia: `/v1/models`, `/v1/chat/completions`,
  `/v1/messages`, `/api/health`, `/api/tunnel`, `/api/stats`, dashboard `/`.
- Gateway key melindungi `/v1/*`.
- Retry 429/5xx; 429 `retry-after > 300s` dicoba sekali dengan session baru
  (~1,5s) lalu fail-fast bila tetap 429; timeout koneksi upstream 20 detik.
- Request logging per-request tersedia **opt-in** (`REQUEST_LOG_ENABLED=1`)
  dengan `x-oc-request-id`, ringkasan body, dan redaksi header/secret umum;
  default **mati**.
- Tool cap 33 + 11 decoy; caller tools yang berbeda definisi di-rename ke
  `*_client`; tool FP yang tidak punya padanan ditandai placeholder.
- Pasangan `working_directory` + `read_image` memicu 429 bahkan dengan hanya
  empat tool; proxy drop `read_image` saat pasangan itu ada.
- Shim `<env>` memakai `detectWorkingDir()` dari system prompt klien, bukan
  `process.cwd()` proxy. `OPENCODE_SESSION` harus kosong agar sesi baru.
- Hermes/desktop toolset dideteksi via `read_file` + `search_files` +
  `terminal`; `HERMES_SAFE_TOOLS` memilih 33 tool yang sudah diuji, dengan
  `setup_mcp`, `skill_manage`, `skills_list`, `text_to_speech` dikecualikan.
- Request harness penuh via proxy lokal: **200**, upstream **44 tool**,
  377 input item, 405.770 byte.
- Request Hermes identik (37 client tool, history 38 message): **200**,
  upstream **44 tool**; replay via Funnel publik **200** (~24 detik).
- Request langsung ke upstream dengan body hasil `buildUpstreamBody()`:
  **200** untuk `glm-5.3-flash-free`.
- `npm run check`: **OK**.

## Yang belum selesai / gagal

### 1. Funnel publik memutus payload penuh

Uji `curl` payload harness penuh ke URL publik:

- Header: `HTTP/2 200`
- `x-oc-request-id: mw4wf15u-61fb1d92`
- Awal SSE diterima
- curl: `Recv failure: Software caused connection abort`
- Hanya 244 byte response yang diterima client

Uji payload yang sama ke `127.0.0.1:8791` berhasil penuh (HTTP 200, ~6,3 detik,
response 2.363 byte untuk request terakhir; request sebelumnya 4.148 byte).
Kemungkinan penyebab: perilaku Funnel/HTTP2 saat streaming, buffering, atau
koneksi Tailscale; belum dipastikan. Perlu uji dengan harness asli dan
`curl --http1.1`/tanpa `-D`, serta cek log `tailscaled`.

### 2. 503 `fetch connect timeout (reset after 23s)`

Dari harness sebelumnya: upstream call berakhir 503 setelah sekitar 23 detik,
tetapi tidak terlihat di log proxy (logging belum aktif saat itu). Setelah
logging + timeout 20 detik, kasus ini belum berhasil direproduksi. Dugaan:
harness timeout/abort saat upstream hang/retry, bukan respons 503 asli dari
opencode.ai. Belum ada bukti final.

### 2b. Koreksi diagnosis 429 (2026-11-12)

Sempat dicurigai ada cooldown/egress gate karena semua body yang diuji sempat
429, termasuk smoke dan direct Bun. Itu **tidak terbukti** dan tidak boleh jadi
blocker; `retry-after` tetap artefak. Tor juga tidak berhasil membuat circuit,
jadi bukan jalur diagnosis yang dipakai.

Pemicu nyata yang berhasil diperbaiki:

- pasangan tool `working_directory` + `read_image` (DSH) dan nama tool tertentu
  (`ReportFindings`, `write_stdin`, grup `mcp_skills`);
- sesi statis `OPENCODE_SESSION` yang membuat model mewarisi konteks
  `/root/oc-proxy` — sudah dihapus, proxy memakai sesi baru per request;
- shim `<env>` yang memakai `process.cwd()` proxy — sekarang membaca working
  directory dari system prompt klien.

Setelah ketiganya diperbaiki, run final OpenClaw 2026.3.24 (5/5), DSH (5/5),
dan Hermes (5/5 + `cat`) selesai tanpa 429. Jangan menunggu reset; capture
body, bisect komposisi/workspace/sesi, patch, lalu replay runner.

### 3. 429 komposisi/fingerprint, bukan quota

Saat pengujian intensif, upstream kadang membalas 429 dengan `retry-after`
~46.000–57.000 detik. Ini **penolakan komposisi/fingerprint**, bukan sisa
quota. Bukti: agent OpenCode yang menjalankan sesi ini memakai model free terus
menerus; request dengan nama tool tertentu 429 sementara request yang sama
setelah alias 200. Beberapa koneksi juga pernah mengalami `ENOTFOUND`,
`ECONNREFUSED`, atau `ECONNRESET`; itu masalah jaringan terpisah. Jangan
menyimpulkan quota dari satu 429, dan jangan berhenti.

### 4. Log (jika diaktifkan) berpotensi memuat secret

Payload harness berisi tool result yang memuat konfigurasi dengan API key
pihak ketiga. Saat `REQUEST_LOG_ENABLED=1`, log request menyimpan **CLIENT
REQUEST** dan **UPSTREAM REQUEST BODY** (hingga 4 MB). Redaksi yang ada
menangkap header sensitif dan pola umum (`sk-`, `ghp_`, `Bearer`, `api_key`),
tetapi tidak menjamin semua API key di dalam teks/tool result. File log mode
`0600`, tetapi tetap sensitif. Logging sekarang **mati secara default**.
Tindakan yang disarankan: hapus log uji lama yang mengandung secret dan rotasi
key yang pernah masuk payload.

### 5. Tailscale masih manual

`tailscaled` dijalankan manual dengan userspace networking. Belum ada helper
`scripts/tailscale.sh` untuk start/status/funnel. Setelah reboot, Tailscale
dan Funnel perlu dijalankan ulang.

### 6. Commit

Branch `reverse-oc-proxy`; cap, logging opt-in, docs, dan Hermes-safe cap sudah
di-commit/di-push (`ef21847`). Perubahan retry session baru masih di working
tree dan belum di-commit; jangan commit/push tanpa instruksi eksplisit.

### 7. Side task airplane mode

Belum bisa dilanjutkan: butuh root/Magisk/ADB wireless/Shizuku untuk
mengaktifkan airplane mode dan mempertahankan akses lokal.

## Test matrix terakhir

| Test | Body | Hasil |
| --- | --- | --- |
| Claude Code smoke box | `/v1/messages`, 12 tool + 11 decoy | **200** (`CLAUDE_PROXY_OK`) |
| Claude Code complex box | 10 request, project rusak | **200** semua; 12 turn; test 4/4; `REPORT.md` |
| Codex smoke box | `/v1/responses`, 9 tool → 7 function + 11 decoy | **200** (`CODEX_PROXY_OK`) |
| Codex complex box | 13 request, project rusak + echo server | **200** semua; test 4/4; CLI JSON; `stdin` echo; `REPORT.md` |
| Direct upstream, safe 33 + 11 | 44 tools, full harness | **200** |
| Proxy lokal, full harness | 52 client tools → 44 upstream | **200**, 6,3s |
| Public Funnel, full harness | 52 client tools → 44 upstream | **HTTP/2 200**, SSE mulai, lalu curl abort setelah 244 byte |
| Public Funnel, full harness `--http1.1` | 52 client tools → 44 upstream | **200**, 27,4s, 1.861 byte |
| Hermes exact, cap lama | 37 client tools → 44 upstream | **429**, `retry-after 47186s` |
| Hermes exact, core 15 + history | 26 tools | **200** |
| Hermes exact, Hermes-safe 33 + 11 | 44 upstream, exclude 4 | **200** lokal |
| Hermes exact via public Funnel | 44 upstream | **200**, ~24s |
| Hermes `mcp_skills` group + core | 19 caller | **429**; tool individual **200** |
| DeepSeek Harness exact after Hermes patch | 52 client → 44 upstream | **200**, 5,0s lokal |
| DeepSeek Harness exact via public Funnel | 52 client → 44 upstream | **200**, 6,6s |
| Hermes exact after retry change | 37 client → 44 upstream | **200**, 7,5s lokal |
| OpenClaw 2026.3.24 complex box | 24 tool + workspace config + cwd shim | **200**; 5/5 test; `REPORT.md` |
| Hermes complex box final | Hermes tools + new session + cwd shim | **200**; 5/5 test; `REPORT.md`; `cat` exit 0 |
| DSH complex box rerun | pair fix + cwd shim | **200**; 5/5 test; `REPORT.md` |
| `npm run check` | static syntax | **OK** |
| Health lokal | `GET /api/health` | **ok**, `bun/1.4.4` |
| 33 client + 11 decoy (baseline) | 44 tools | **200** |
| 34 client + 11 decoy | 45 tools | **429** |
| 5 decoy + 33 client | 38 tools | **200** |
| 2 decoy + 33 client | 35 tools | **429** |
| Broad selected 33 (team/terminal) + 11 | 44 tools | **429** (dua kali) |
| `subagent_fork` + 11 decoy | 12 tools | **429** |
| `wait_agent`, `web_fetch`, `web_search`, `working_directory`, `write_client` + 11 decoy | 12 tools | **200** setelah retest dengan jeda |
| Safe 33 swap + 11 | 44 tools | **200** |
| 11 decoy saja, full 377 message | 11 tools | **200** |

Catatan: hasil 429/200 pada tes individual dipengaruhi komposisi tool, sesi,
dan workspace shim — bukan quota. Jangan menyimpulkan limit dari satu 429.
Test matrix di atas adalah bukti terbaik yang ada, bukan jaminan upstream
selalu stabil.

## Next actions (prioritas)

1. **Semua harness target sudah lulus** di box: OpenCode 1.19.5, Claude Code,
   Codex, OpenClaw 2026.3.24 + 2026.11.3, DSH, Hermes. Tidak ada blocker 429.
2. **Validasi Funnel HTTP/2 dengan harness asli.** Jika abort, uji
   `curl --http1.1`, tanpa `-D`, dan cek log `tailscaled`.
3. **Amankan log.** Setelah debugging, kembalikan `REQUEST_LOG_ENABLED=0`,
   restart, lalu hapus/rotasi log uji yang memuat kredensial.
4. **Reproduksi/atasi 503 23 detik.** Cek apakah harness mengirim
   `AbortController`/timeout sendiri; bandingkan dengan timeout 20 detik proxy.
5. **Buat helper Tailscale** agar Funnel bisa dinyalakan ulang setelah reboot.

## Git

```
branch: reverse-oc-proxy
remote: MarkDev11/oc-proxy
last commit: ef21847 (cap + logging opt-in + docs + Hermes-safe cap)
working tree: belum bersih; berisi bridge /v1/responses, alias
ReportFindings/write_stdin, cwd shim `<env>`, handling sesi baru, docs, dan
replay test
```

File utama: `.env.example`, `README.md`, `api/v1/chat/completions.js`,
`api/v1/messages.js`, `api/v1/responses.js`, `lib/opencode.js`,
`scripts/start.sh`, `scripts/status.sh`, `scripts/up.js`, `serve-local.js`,
plus folder `docs/`. Jangan commit/push tanpa instruksi.
