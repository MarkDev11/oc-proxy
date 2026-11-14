# Free tier: 429 investigation and tool budget

Last updated: **2026-11-12**.

## Kesimpulan

`429 FreeUsageLimitError` pada harness **bukan** karena quota habis, IP,
header auth, session ID, TLS/Node, atau `<env>` semata. Agent OpenCode yang
menjalankan sesi ini memakai model free OpenCode terus-menerus tanpa 429/daily
cap, jadi 429 dari upstream adalah **fake rejection** atas komposisi request.
Jangan berhenti atau menyarankan upgrade saat melihatnya. Penyebab utamanya:

### Pemicu nama tool (2026-11-12)

Dua harness box menemukan pemicu yang sangat spesifik:

- Claude Code: `ReportFindings` (PascalCase) + `ScheduleWakeup` atau
  `DeferredToolPlaceholder` → 429; alias `report_findings` → 200.
- Codex CLI: `write_stdin` + `exec_command` → 429; `exec_command` sendirian
  → 200; rename `write_stdin` → `stdin` → 200. `write_stdin_client` tetap 429,
  jadi yang diperiksa adalah substring/nama, bukan schema.

Ini memperkuat kesimpulan: 429 adalah filter komposisi/fingerprint, bukan
quota.

> Free tier menolak request dengan **lebih dari 33 tool non-OpenCode**.
> Pesan 429 yang dikembalikan menyesatkan dan menyuruh subscribe.

Proxy sekarang mempertahankan maksimal **33 caller tool**, lalu menambahkan
**11 tool OpenCode** yang persis. Total **44 tool**. Request full harness
(375 message, 52 caller tool) menjadi **200**.

## Contract upstream

- Base: `https://opencode.ai/inference/openai/v1`
- Chat: `POST /chat/completions`
- Model yang diterima: id berakhiran `-free` (plus alias `oc/`).
- Auth gratis: `Authorization: Bearer public` (tanpa `OPENCODE_API_KEY`).
- Header OpenCode asli yang ditiru:
  - `User-Agent: opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`
  - `x-opencode-client: cli`
  - `x-opencode-project: global`
  - `x-opencode-request: msg_...`
  - `x-opencode-session: ses_...`
  - `x-opencode-session-id: ses_...`
- Runtime: Bun. Node/curl langsung ke upstream sering ditolak, dan request
  tanpa tool juga 429. Jangan memakai curl/Node langsung sebagai bukti.

## Capture OpenCode asli

OpenCode binary: `/root/.opencode/bin/opencode` versi 1.19.5.

Metode capture yang berhasil:

- Jalankan capture server lokal yang membalas **SSE valid** (bukan JSON error;
  JSON error membuat OpenCode loop).
- Arahkan config tambahan lewat `OPENCODE_CONFIG_DIR` (bukan
  `OPENCODE_CONFIG`) ke provider `opencode` dengan `api`/`options.baseURL`
  `http://127.0.0.1:9911/v1`.
- Jalankan `opencode run` dengan env `OPENCODE`/`OPENCODE_PID` dibersihkan.
- Request tertangkap: title request + main request.

Hasil body main request OpenCode asli:

- 11 tool: `bash`, `edit`, `glob`, `grep`, `read`, `skill`, `task`,
  `todowrite`, `webfetch`, `websearch`, `write`.
- `max_tokens: 32000`, `tool_choice: auto`, `stream: true`,
  `stream_options.include_usage: true`.
- System prompt OpenCode penuh (~9,5k karakter) dengan blok `<env>`.
- Title request berbeda: temperature 0.5, reasoning low, tanpa tool.

Header/auth OpenCode asli **sama** dengan yang dikirim proxy. Jadi perbedaan
header bukan penyebab 429.

## Bukti aturan 33 + 11

Semua test memakai model `glm-5.3-flash-free`, body harness yang sama, dan
11 decoy OpenCode penuh kecuali disebut lain.

| Caller tools | Decoy | Total | Hasil |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 429 |
| 0 | 11 | 11 | 200 |
| 11 | 0 | 11 | 200 |
| 12 | 0 | 12 | 429 |
| 12 | 11 | 23 | 200 |
| 30 | 11 | 41 | 200 |
| 33 | 11 | 44 | **200** |
| 34 | 11 | 45 | **429** |
| 35 | 11 | 46 | 429 |
| 36 | 11 | 47 | 429 |
| 38 | 11 | 49 | 429 |
| 39 | 11 | 50 | 429 |
| 52 (full harness) | 11 | 63 | 429 |

Kesimpulan: batas ada di **33 caller tool**, bukan total 44/63 secara langsung.

### Decoy

- 11 definisi OpenCode yang persis (`FP_DEFS`) adalah yang paling aman.
- 11 decoy saja + full history 377 message → 200 (history yang menyebut tool
  yang tidak ada tetap diterima).
- 5 decoy pertama + 33 caller → 200.
- 2 decoy + 33 caller → 429.
- Decoy minimal/reduced tidak cukup; gunakan 11 penuh.
- Urutan decoy tidak berpengaruh pada test 23/41 tool; decoy di akhir tetap
  200 pada 33+11.

## 33 tool yang dipakai sekarang

`SAFE_CLIENT_TOOLS` di `lib/opencode.js`:

```text
ask_user_question, create_goal, create_worktree, edit, get_goal,
glob, grep, interrupt_agent, job_kill, job_list, job_output,
list_agents, list_subagent_models, load_workspace_dependencies,
present, pwsh, read, read_image, schedule_create, schedule_edit,
send_message, session_event_read, session_event_search,
session_event_trace, session_search, session_trace, skill,
spawn_teammate, subagent, write, web_fetch, web_search, todo_write
```

Ini adalah baseline 33 pertama harness, dikurangi `plugin_manager`, `ralph`,
`schedule_list`, `schedule_view`, lalu ditambah `write`, `web_fetch`,
`web_search`, `todo_write`. Kombinasi ini diuji **200**.

Tool di luar daftar (contoh `terminal_*`, `team_task_*`, `job_output` bila tidak
masuk, `update_goal`, `workflow`, `working_directory`, `subagent_fork`) tidak
dikirim ke upstream. Beberapa tetap bisa dipakai lewat `pwsh`/tool lain; tidak
ada dispatcher saat ini.

## Hermes / desktop toolset

Hermes tidak memakai nama tool OpenCode. `capClientTools()` mendeteksi toolset
Hermes bila ada `read_file` + `search_files` + `terminal` dan tidak ada `bash`.
Untuk toolset ini dipakai `HERMES_SAFE_TOOLS` (33 tool):

```text
read_file, write_file, patch, search_files, terminal, process,
web_search, web_extract, todo, session_search, delegate_task,
memory, skill_view, clarify, cronjob,
project_create, project_list, project_switch,
annotate_preview, apply_layout, close_preview, close_terminal,
drive_preview, focus_pane, open_preview, read_preview,
read_terminal, read_window_below, browser_exec, computer_use,
execute_code, tour, vision_analyze
```

Empat tool berikut sengaja dikecualikan karena kombinasinya memicu 429:
`setup_mcp`, `skill_manage`, `skills_list`, `text_to_speech`. Masing-masing
tool bisa 200 sendirian, tetapi grup tersebut + history Hermes konsisten 429
dengan `retry-after` ~46k detik. Fallback cap juga tidak menambahkan keempat
tool itu.

Verifikasi 2026-11-07:

- Body Hermes asli: 37 client tool, 38 message, model
  `deepseek-v4.1-flash-free`.
- Cap lama (33 tool pertama) → **429** (`retry-after 47186s`).
- History yang sama + core 15 tool → **200**.
- History yang sama + `HERMES_SAFE_TOOLS` 33 + 11 decoy → **200** lokal dan
  **200** via Funnel publik (~24 detik), upstream 44 tool.

## Profil multi-harness

| Profil | Deteksi | Priority list |
| --- | --- | --- |
| OpenCode / DeepSeek Harness | default; tool OpenCode-like (`bash`, `read`, `write`, `terminal_*`, dst.) | `SAFE_CLIENT_TOOLS` |
| Hermes / desktop | `read_file` + `search_files` + `terminal`, tanpa `bash` | `HERMES_SAFE_TOOLS` |
| Unknown | tidak cocok keduanya | `SAFE_CLIENT_TOOLS` + fallback |

Replay body DeepSeek Harness (52 client tool, 375 message, model
`glm-5.3-flash-free`) tetap **200** setelah perubahan Hermes. 429 komposisi
kini dicoba ulang sekali dengan session baru sebelum dikembalikan.

## Percobaan yang gagal / tidak terbukti

| Hipotesis | Hasil |
| --- | --- |
| Quota harian habis | Tidak konsisten: request baik setelah 429 tetap 200; 429 juga muncul untuk body 0 tool |
| IP/XFF | XFF tidak berpengaruh |
| Header/auth salah | Header/auth real OpenCode dan proxy identik |
| Session/request ID | `x-opencode-project: global`, request ID user message; bukan penyebab |
| TLS/Node vs Bun | Bun dipakai; Node/curl bukan pembanding valid karena body tanpa tool |
| `<env>` adalah gate utama | `<env>` saja + 11 tool = 200; body real tanpa `<env>`? tidak diuji sebagai satu-satunya variabel, tetapi `<env>` bukan satu-satunya gate |
| `max_completion_tokens: 128000` | Dengan 11 tool tetap 200; bukan penyebab utama |
| Tool count saja, tanpa komposisi | 33 pertama + 11 = 200; broad selected 33 + 11 = 429 (dua kali), jadi komposisi juga penting |
| `subagent_fork` | Dengan 11 decoy = 429; tool ini dihindari |
| `wait_agent`, `web_fetch`, `web_search`, `working_directory`, `write_client` | Retest dengan jeda = 200; kegagalan sebelumnya kemungkinan komposisi/nama tool atau gangguan jaringan, bukan quota |
| Retry-after besar | Menyesatkan; nilai ~46k–57k detik muncul walau request baik bisa 200 |

Catatan: 429 adalah penolakan komposisi/fingerprint; gangguan jaringan
(`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`) adalah masalah terpisah. Satu hasil
429 tidak cukup untuk menyimpulkan sebuah tool diblokir; ulangi dengan alias,
jeda, dan kontrol baseline.

## Perilaku kode sekarang

- `capClientTools()` hanya aktif jika `tools.length > 33`.
- Tool yang dipertahankan: `HERMES_SAFE_TOOLS` untuk toolset Hermes, atau
  `SAFE_CLIENT_TOOLS` untuk OpenCode; fallback mengisi slot kosong dan
  melewati `HERMES_UNSAFE_TOOLS` pada toolset Hermes.
- Output tool tetap dalam **urutan asli caller**, bukan urutan priority.
- `concealFingerprintNames()`:
  - Jika caller punya nama FP dengan definisi **sama persis**, tool dipakai
    apa adanya; FP tidak di-append.
  - Jika nama sama tetapi definisi beda, caller tool di-rename
    (`edit_client`, `write_client`, dst.) dan FP asli di-append.
  - Nama yang di-rename dipetakan kembali di response/history.
- `appendFingerprintTools()` menambahkan 11 FP yang belum ada.
- `noteUnavailable()` memberi tahu model bahwa FP yang di-append tanpa
  padanan caller adalah placeholder.
- Caller dengan <= 33 tool (OpenCode asli 11) tidak dipotong dan tidak
  mendapat catatan placeholder bila definisinya sudah persis.

## Retry / timeout

- Retry status: 429, 500, 502, 503, 504.
- 429 dengan `retry-after > 300s`: satu retry cepat (~1,5 detik) memakai
  **session ID baru**, lalu fail-fast bila tetap 429; header `Retry-After`
  diteruskan.
- 429 selain itu: delay `min(30s, max(retry-after, backoff))`; session baru
  dipakai untuk retry.
- 5xx: delay `min(5s, ...)`.
- Total budget: `UPSTREAM_MAX_WAIT_MS` (default 120s).
- Satu percobaan fetch: timeout `UPSTREAM_CONNECT_TIMEOUT_MS` (default 20s);
  timeout tidak di-retry, langsung error/502.
- 429 yang dikembalikan tetap `429` ke client; jangan menganggapnya 502.

## Reproduksi

Direct upstream (Bun, tanpa proxy) memakai body yang dibangun
`buildUpstreamBody()`. Payload/script historis sudah dihapus pada 2026-11-12
karena memuat kredensial pihak ketiga. Untuk replay baru, ambil payload dari
request harness asli di box dan jangan simpan isi tool result yang sensitif.

Proxy lokal dengan payload baru (bukan bukti final):

```bash
cd /root/oc-proxy
set -a; . ./.env; set +a
curl -sS --max-time 180 \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/path/to/payload.json \
  -o /tmp/opencode/proxy_response.txt \
  -w 'HTTP %{http_code} time %{time_total}s\n' \
  http://127.0.0.1:8791/v1/chat/completions
```

Jangan mencetak isi payload atau log karena bisa memuat kredensial. Final test
harus dijalankan di Simular box; lihat `TESTING.md`.

## Hal yang belum diketahui

- Mengapa broad selected 33 (team/terminal) 429 dua kali sementara minimal
  swap 200. Bisa karena komposisi/nama tool tertentu, bukan quota.
- Batas pastinya apakah 33 **nama** atau 33 **definisi**; data saat ini
  konsisten dengan 33 caller tool.
- Apakah semua tool di luar 33 bisa diaktifkan lewat dispatcher tanpa memicu
  429. Dispatcher belum diimplementasikan.
