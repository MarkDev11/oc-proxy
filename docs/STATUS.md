# Status

Last updated: **2026-11-07** (Hermes/desktop toolset + logging opt-in).

## Ringkasan

Proxy berjalan di Bun, Tailscale Funnel aktif, dan request harness penuh yang
sebelumnya selalu `429 FreeUsageLimitError` sekarang diterima upstream
(**HTTP 200**) melalui proxy lokal. Perbaikan utama: batas **33 tool
non-OpenCode** + 11 decoy OpenCode, dengan pemilihan 33 tool inti yang sudah
diverifikasi. Hermes/desktop agent memakai toolset berbeda dan sekarang punya
**Hermes-safe 33** sendiri; request Hermes identik berhasil **200** lewat lokal
maupun Funnel publik.

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
- Retry 429/5xx, fail-fast untuk 429 dengan `retry-after > 300s`, timeout
  koneksi upstream 20 detik.
- Request logging per-request tersedia **opt-in** (`REQUEST_LOG_ENABLED=1`)
  dengan `x-oc-request-id`, ringkasan body, dan redaksi header/secret umum;
  default **mati**.
- Tool cap 33 + 11 decoy; caller tools yang berbeda definisi di-rename ke
  `*_client`; tool FP yang tidak punya padanan ditandai placeholder.
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

### 3. Rate limit / quota upstream tetap ada

Saat pengujian intensif, upstream kadang membalas 429 dengan `retry-after`
~46.000–57.000 detik. Ini bisa transien/quota, dan tidak selalu berarti request
salah. Beberapa request baik tetap 200 setelah 429; beberapa koneksi juga
mengalami `ENOTFOUND`, `ECONNREFUSED`, atau `ECONNRESET`. Jangan menyimpulkan
tool composition hanya dari satu 429 saat jaringan/quota sedang tidak stabil.

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

### 6. Perubahan belum di-commit

Branch `reverse-oc-proxy`, commit terakhir `b42e230`. Perubahan logging,
fail-fast, timeout, tool cap, docs, dan README masih bekerja di working tree.
Jangan commit tanpa instruksi eksplisit.

### 7. Side task airplane mode

Belum bisa dilanjutkan: butuh root/Magisk/ADB wireless/Shizuku untuk
mengaktifkan airplane mode dan mempertahankan akses lokal.

## Test matrix terakhir

| Test | Body | Hasil |
| --- | --- | --- |
| Direct upstream, safe 33 + 11 | 44 tools, full harness | **200** |
| Proxy lokal, full harness | 52 client tools → 44 upstream | **200**, 6,3s |
| Public Funnel, full harness | 52 client tools → 44 upstream | **HTTP/2 200**, SSE mulai, lalu curl abort setelah 244 byte |
| Public Funnel, full harness `--http1.1` | 52 client tools → 44 upstream | **200**, 27,4s, 1.861 byte |
| Hermes exact, cap lama | 37 client tools → 44 upstream | **429**, `retry-after 47186s` |
| Hermes exact, core 15 + history | 26 tools | **200** |
| Hermes exact, Hermes-safe 33 + 11 | 44 upstream, exclude 4 | **200** lokal |
| Hermes exact via public Funnel | 44 upstream | **200**, ~24s |
| Hermes `mcp_skills` group + core | 19 caller | **429**; tool individual **200** |
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

Catatan: hasil 429/200 pada tes individual bisa terpengaruh quota/rate limit
dan gangguan jaringan. Test matrix di atas adalah bukti terbaik yang ada,
bukan jaminan upstream selalu stabil.

## Next actions (prioritas)

1. **Validasi harness agentic asli.** Request Hermes identik sudah 200 lewat
   publik; lanjutkan dengan loop tool call nyata. Jika HTTP/2 abort, uji
   `curl --http1.1`, tanpa `-D`, dan cek `tailscale funnel status`/log
   `tailscaled`.
2. **Uji tool call end-to-end.** Pastikan model memanggil `write_client`,
   `edit_client`, `read_client`, `web_fetch`, `todo_write`, `subagent`, `pwsh`
   untuk OpenCode, serta `read_file`/`write_file`/`terminal`/`patch` untuk
   Hermes; proxy harus mengembalikan nama tool yang dikenal client.
3. **Amankan log.** Hapus log uji yang memuat kredensial; rotasi key yang
   terekspos; logging default mati, aktifkan hanya saat debugging.
4. **Reproduksi/atasi 503 23 detik.** Cek apakah harness mengirim
   `AbortController`/timeout sendiri; bandingkan dengan timeout 20 detik proxy.
5. **Buat helper Tailscale** agar Funnel bisa dinyalakan ulang setelah reboot.

## Git

```
branch: reverse-oc-proxy
remote: MarkDev11/oc-proxy
commits: cap + logging opt-in + docs, lalu Hermes-safe cap
working tree: bersih setelah commit Hermes fix
```

File utama: `.env.example`, `README.md`, `api/v1/chat/completions.js`,
`api/v1/messages.js`, `lib/opencode.js`, `scripts/start.sh`,
`scripts/status.sh`, `scripts/up.js`, `serve-local.js`, plus folder `docs/`.
