# DeepSeek Harness notes

Last updated: **2026-11-06**.

## Identitas request

Dari log `logs/requests/2026-11-06T08-10-10-933Z-mw4p2dmd-9080a4b3.log`:

- Client: `deepseek-harness/0.2.2-rc.1`
- OS: Windows x64, Node v24.21.0
- Model yang diminta: `glm-5.3-flash-free`
- Message: 375 total (developer 1, user 34, assistant 171, tool 169)
- Tool caller: 52
- Client body: 395.767 byte
- Upstream body saat itu: 422.466 byte, 63 tool, 377 input item
- `max_completion_tokens: 128000`, `store: false`, `stream: true`
- Error: `429 FreeUsageLimitError`
  `Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go`
- `retry-after` saat itu ~56.988 detik

## Setelah perbaikan

Payload harness yang sama (52 tool, 375 message) melalui proxy lokal:

- Client tools 52 → upstream **44 tool** (33 caller + 11 decoy).
- Input 377 item.
- Body upstream ~405.770 byte.
- **HTTP 200**, waktu ~6,3 detik.
- SSE valid; `x-oc-request-id` tersedia.
- `npm run check` OK.

Public Funnel dengan payload yang sama:

- Header **HTTP/2 200**
- Awal SSE diterima
- curl: `Recv failure: Software caused connection abort`
- Hanya 244 byte yang diterima
- Belum jelas apakah ini masalah Funnel/HTTP2, buffering, atau koneksi; uji
  ulang dengan harness asli dan `curl --http1.1`.

## Kenapa 52 tool menjadi 44

Harness mengirim 52 tool dengan nama/schema sendiri. Contoh schema harness
memakai **snake_case**:

- `edit`: `file_path`, `old_string`, `new_string`
- `read`: `file_path`
- `write`: `file_path`, `content`
- `pwsh`: `description`, `command`, `timeoutMs`, `workdir`
- `subagent`: `description`, `prompt`
- `web_fetch`: `url`
- `web_search`: `queries`
- `todo_write`: `todos`

OpenCode fingerprint memakai **camelCase**:

- `edit`: `filePath`, `oldString`, `newString`
- `read`: `filePath`
- `write`: `filePath`, `content`
- `bash`: `command`, `timeout`, `workdir`
- `task`: `description`, `prompt`, `subagent_type`
- `webfetch`: `url`, `format`
- `websearch`: `query`
- `todowrite`: `todos`

Proxy **tidak** menerjemahkan argumen. Karena itu:

- Tool caller yang bentrok nama tetapi schema berbeda di-rename menjadi
  `edit_client`, `read_client`, `write_client`, `glob_client`, `grep_client`,
  `skill_client`.
- Model harus memakai nama `*_client` untuk schema harness yang benar.
- 11 tool OpenCode asli di-append sebagai decoy; model diberi catatan agar
  tidak memanggil tool FP yang tidak punya padanan.
- Tool caller yang tetap ada (mis. `web_fetch`, `web_search`, `todo_write`,
  `subagent`, `pwsh`) dipakai dengan schema harness asli.

33 tool yang dipertahankan sekarang:

```text
ask_user_question, create_goal, create_worktree, edit, get_goal,
glob, grep, interrupt_agent, job_kill, job_list, job_output,
list_agents, list_subagent_models, load_workspace_dependencies,
present, pwsh, read, read_image, schedule_create, schedule_edit,
send_message, session_event_read, session_event_search,
session_event_trace, session_search, session_trace, skill,
spawn_teammate, subagent, write, web_fetch, web_search, todo_write
```

Tool harness yang tidak masuk 33 (mis. `terminal_*`, `team_task_*`,
`update_goal`, `workflow`, `working_directory`, `subagent_fork`) tidak
tersedia langsung. `pwsh` dapat dipakai untuk terminal/file; `edit`/`write`
untuk file; `web_fetch`/`web_search` untuk web.

## Hasil uji tool selection

| Set | Hasil |
| --- | --- |
| 33 pertama + 11 decoy | 200 |
| 34 pertama + 11 | 429 |
| Broad selected 33 (team/terminal) + 11 | 429 (dua kali) |
| Minimal swap safe 33 + 11 | 200 |
| `subagent_fork` + 11 decoy | 429 |
| `wait_agent` + 11 | 200 (retest) |
| `web_fetch` + 11 | 200 (retest) |
| `web_search` + 11 | 200 (retest) |
| `working_directory` + 11 | 200 (retest) |
| `write_client` + 11 | 200 (retest) |

Kesimpulan: `subagent_fork` dihindari; kegagalan later tools sebelumnya
kemungkinan 429 transien/rate limit. Uji intensif bisa memicu quota; selalu
sertakan kontrol baseline dan jeda.

## 503 `fetch connect timeout (reset after 23s)`

Gejala lama dari harness:

```text
503 fetch connect timeout (reset after 23s)
```

Saat itu logging per-request belum aktif, jadi request upstream tidak
tertangkap. Setelah logging + timeout 20 detik, kasus ini belum berhasil
direproduksi. Dugaan:

- Harness/agent melakukan abort/timeout sendiri sekitar 23 detik.
- Upstream hang/retry, lalu koneksi di-reset.
- Bukan respons 503 asli dari opencode.ai.

Belum ada bukti final. Jika muncul lagi, cari log request terbaru dan lihat
event `[upstream] attempt`, `status`, `timeout`, serta `CLIENT RESPONSE`.

## Reproduksi

File uji sementara ada di `/tmp/opencode/` (bukan bagian repo):

- `harness_upstream.json` — body upstream 63 tool/377 message dari log lama.
- `harness_client.json` — payload harness 52 tool/375 message.
- `test_build.js` — build body + kirim langsung ke upstream.
- `test_baseline33.js` — baseline 33 pertama.
- `test_set.js` — kirim daftar tool tertentu.
- `replay_full_cap.js`, `replay_maxcount.js`, `replay_decoy_subset.js`,
  `replay_core5.js`, `replay_later_tools.js` — eksperimen batas tool.
- `capture-server.js`, `capture-cfg/` — capture OpenCode asli.
- `capture-requests.jsonl` — request OpenCode asli.

Perintah:

```bash
cd /root/oc-proxy
bun /tmp/opencode/test_build.js
```

Proxy lokal:

```bash
set -a; . ./.env; set +a
curl -sS --max-time 180 \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/opencode/harness_client.json \
  -o /tmp/opencode/proxy_response.txt \
  -w 'HTTP %{http_code} %{time_total}s\n' \
  http://127.0.0.1:8791/v1/chat/completions
```

## Security warning

`/tmp/opencode/harness_client.json` dan log request bisa memuat **API key
pihak ketiga** di dalam isi tool result (contoh: konfigurasi plugin dengan
`apiKey`). Redaksi proxy belum menangkap semua format tersebut.

Tindakan:

- Jangan membagikan file payload/log.
- Jangan menyalin isi tool result ke chat/dokumen.
- Hapus log uji yang mengandung secret setelah debugging.
- Rotasi key yang terekspos.
- Pertimbangkan menonaktifkan body logging default atau menambah pola
  redaksi (`apiKey: ...`, `keyName: ...`, dan pola provider lain) sebelum
  menyimpan body.

## Next test yang disarankan

1. Jalankan harness asli dengan task sederhana yang memaksa satu tool call
   (`read`/`write`/`pwsh`) lewat URL publik dan lokal.
2. Pastikan model memakai `read_client`/`write_client`/`edit_client`, bukan
   decoy FP; cek nama tool di log dan hasil eksekusi harness.
3. Uji `web_fetch`, `web_search`, `todo_write`, `subagent` karena schema-nya
   berbeda dari FP.
4. Jika tool call gagal karena argumen camelCase/snake_case, tambahkan
   translasi argumen per-tool atau dispatcher; jangan mengandalkan rename nama
   saja.
5. Uji Funnel dengan `curl --http1.1` dan tanpa `-D` untuk melihat apakah
   abort hanya terjadi pada HTTP/2/header handling.
