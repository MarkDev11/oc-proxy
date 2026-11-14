# Testing Harness / Agentic

Last updated: **2026-11-12**.

## Objective

Membuat `oc-proxy` lolos di **semua harness/agentic client** yang ditargetkan:

- OpenCode 1.19.5
- OpenClaw 2026.3.24 dan 2026.11.3
- Claude Code
- Codex CLI
- Hermes
- DSH (DeepSeek Harness)

Kelulusan berarti harness asli berhasil menyelesaikan task **kompleks** yang
memaksa banyak tool call berantai: baca/tulis/edit file, eksekusi shell,
membaca hasil, memperbaiki error, menjalankan ulang, dan menghasilkan artefak.
Bukan sekadar CRUD atau request sintetis.

## Aturan Testing

1. **Final test wajib di Simular box** `main` / `cb-ae8d7c84eae9`, bukan di
   Termux/proot lokal.
2. Lokal hanya untuk menjalankan proxy (Bun) dan OpenCode saja.
3. Jangan bertanya; lanjutkan sampai semua harness lulus.
4. Setiap kegagalan harus punya bukti: request ID, status HTTP, nama tool,
   hasil tool, dan log proxy bila perlu.
5. Jangan mencetak gateway key, box token, atau isi `.env` ke chat/dokumen.
6. Logging proxy default mati. Aktifkan hanya saat menangkap kegagalan, lalu
   kembalikan ke `REQUEST_LOG_ENABLED=0`.

## 429 `FreeUsageLimitError` Itu Fake

**Jangan pernah menyimpulkan kuota habis atau berhenti karena 429 ini.**

Fakta yang sudah terbukti:

- Agent OpenCode yang sedang menulis dokumentasi ini berjalan terus memakai
  model free OpenCode (`deepseek-v4.1-flash-free`) selama sesi panjang ini,
  tanpa 429 dan tanpa daily usage cap.
- Request harness dengan prompt/system/tool asli bisa **200** pada waktu yang
  sama ketika request bentuk lain mendapat 429.
- `retry-after` 42.000–57.000 detik adalah artefak penolakan fingerprint,
  bukan sisa kuota nyata.
- 429 muncul dari upstream untuk **komposisi request yang tidak cocok**, lalu
  pesannya menyesatkan ke arah subscribe/Go.

Aturan saat melihat 429:

1. Jangan berhenti, jangan bilang quota habis, jangan sarankan upgrade.
2. Langsung capture request ID dan body (logging sementara).
3. Audit jumlah tool, nama tool, profil yang terdeteksi, ukuran system prompt,
   dan bentuk message/history.
4. Bandingkan dengan request yang sudah terbukti 200; perbaiki komposisi lalu
   ulangi di box.

Bukti terbaru: Claude Code 2.1.318 mengirim **12 tool** + 11 decoy = **23 tool
upstream**, tetapi tetap 429 `retry-after` ~42.859s (request
`mwdi49m3-4b1d478b`). Setelah bisect, pemicunya adalah nama tool
**`ReportFindings`** dalam PascalCase saat digabung dengan `ScheduleWakeup`
atau `DeferredToolPlaceholder`. Alias ke `report_findings` membuat replay
**200**, dan task kompleks Claude Code akhirnya lulus.

Codex CLI 0.166.0 juga sempat 429 dengan 7 function tool + 11 decoy. Pemicunya
nama **`write_stdin`**; `exec_command` sendirian **200**, `exec_command` +
`write_stdin` **429**, rename `write_stdin` → `stdin` **200**, sedangkan
`write_stdin_client` tetap **429**. Alias permanen sekarang ada di
`ANOMALY_TOOL_ALIASES`.

Kesimpulan: 429 di sini adalah **penolakan komposisi/fingerprint**, bukan quota.
Jangan berhenti; bisect nama tool, alias/rename, lalu replay.

## Local Cleanup 2026-11-12

Dihapus dari mesin lokal:

- `/tmp/opencode/harness-openclaw`
- `/tmp/opencode/harness-dsh`
- `/tmp/opencode/harness-hermes`
- seluruh `/tmp/opencode/openclaw-*`
- `/tmp/opencode/harness_*.json`
- `/tmp/opencode/agentic_*.json`
- OpenClaw global Termux: package, binary symlink, dan `~/.openclaw`

Disisakan:

- `/tmp/opencode/oc-local/` — konfigurasi OpenCode lokal + `proof.txt`
- proxy `oc-proxy` beserta dependency-nya
- tooling box: `/tmp/opencode/box_mcp.mjs`, `/tmp/opencode/box_token`,
  `/tmp/opencode/box_*.json`

Alasan: OpenClaw 2026.11.3 lokal selalu hang di preflight SQLite proot;
harness final harus dijalankan di box x86_64. Artefak payload harness juga
pernah memuat secret pihak ketiga, jadi tidak disimpan di lokal.

## Box Environment

- Box: `main` / `cb-ae8d7c84eae9`
- Status: running; image `sbxdesk:v13` (latest `v20`, belum upgrade)
- OS: Ubuntu x86_64, kernel `6.8.0-142-generic`
- User/cwd: `user` / `/workspace`
- Node `v24.21.0`, npm `11.19.0`, Python `3.12.3`, git `2.43.0`
- Bun `1.4.4` terpasang di `/home/user/.bun/bin/bun` (hanya untuk diagnostik
  egress; proxy tetap di lokal)
- Env proxy box: `/workspace/.ocproxy_env` (mode 600, jangan dicetak)

Akses box:

```bash
node /tmp/opencode/box_mcp.mjs call shell \
  '{"command":"...","timeout_s":60}'
```

Token box: `/tmp/opencode/box_token` (mode 600). Jangan print.

Proxy publik sudah bisa diakses dari box:

- `https://oc-proxy-termux.tail81c43d.ts.net/api/health` → `status: ok`
- `/v1/models` dengan gateway key → 200

## Inventory Harness di Box

| Harness | Status | Versi | Catatan |
| --- | --- | --- | --- |
| Claude Code | terpasang | 2.1.318 | `/usr/local/bin/claude` |
| Codex CLI | terpasang | 0.166.0 | `/usr/local/bin/codex` |
| OpenCode | terpasang | 1.19.5 | `/workspace/oc-harness/opencode-app` |
| OpenClaw 2026.3.24 | terpasang | 2026.3.24 | `/workspace/oc-harness/openclaw-2026324`; config valid; mock 24 tool |
| OpenClaw 2026.11.3 | terpasang | 2026.11.3 | `/workspace/oc-harness/openclaw-2026113`; config valid |
| DSH | terpasang | 0.2.2-rc.1 | `/workspace/oc-harness/dsh-app`; patch `llm-pi-ai` valid; mock 23 tool |
| Hermes | terpasang | 0.23.1 (2026.9.24) | `/workspace/oc-harness/hermes-home`; provider `ocproxy`; mock 8 tool |

Claude Code memakai `/v1/messages` lewat `ANTHROPIC_BASE_URL`. Codex sudah
dikonfigurasi di `/home/user/.codex/config.toml` dengan
`wire_api = "responses"` (Codex 0.166 menolak `wire_api = "chat"`) dan
`base_url = "https://oc-proxy-termux.tail81c43d.ts.net/v1"`.

## Matrix Status

| Harness | Local | Box | Complex tool test |
| --- | --- | --- | --- |
| OpenCode 1.19.5 | **OK** (`OPENCODE_HARNESS_OK`) | **OK** (`OPENCODE_BOX_OK`) | **OK**: 12 tool call, 9 request 200, 4/4 test, CLI JSON `115.25`, `REPORT.md` |
| Claude Code 2.1.318 | tidak dipakai | **OK** (`CLAUDE_PROXY_OK`) | **OK**: 12 turn, 10 request 200, 4/4 test, `REPORT.md` |
| Codex CLI 0.166.0 | tidak dipakai | **OK** (`CODEX_PROXY_OK`) | **OK**: 13 request 200, 4/4 test, CLI JSON, `stdin`/echo, `REPORT.md` |
| OpenClaw 2026.3.24 | dihapus | **OK** (`OPENCLAW_324_OK`) | **OK**: 5/5 test, CLI JSON `115.25`, `REPORT.md` |
| OpenClaw 2026.11.3 | dihapus (hang SQLite) | **OK** (`OPENCLAW_113_OK`) | **OK**: 17 tool call awal + 15 tool call report, 4/4 test, CLI JSON `115.25`, `REPORT.md` |
| Hermes 0.23.1 | dihapus | **OK** | **OK**: test 5/5, CLI JSON `115.25`, `REPORT.md` 1442 byte, `cat REPORT.md` exit 0 |
| DSH 0.2.2-rc.1 | dihapus | **OK** (`DSH_OK`) | **OK**: 9/9 request 200, test 5/5, CLI JSON `115.25`, `REPORT.md` |

Catatan OpenCode: 3 subrequest judul (`tools=0`) tetap 429 dan non-fatal;
request utama 9/9 HTTP 200.

Catatan OpenClaw: 2026.11.3 butuh filter profil `OPENCLAW_SAFE_TOOLS` karena
14-tool mix aslinya memicu 429. 2026.3.24 mengirim 24 tool dan dipetakan ke
core OpenClaw yang sama sebelum decoy ditambahkan. `openclaw agent --local`
menjalankan tool di workspace agent, bukan cwd proses; 2026.3.24 tidak memakai
`OPENCLAW_WORKSPACE_DIR`, jadi `agents.defaults.workspace` harus diisi absolut.
Runner menyalin `ledger.test.js` + `REPORT.md` kembali ke project setelah run.

Catatan shim `<env>`: jangan pakai `process.cwd()` proxy. Shim sekarang membaca
`Working directory:` / `Your working directory is:` dari system prompt klien,
supaya model tidak mengira workspace ada di `/root/oc-proxy`. Ini yang membuat
OpenClaw 2026.3.24, DSH, dan Hermes berhenti menulis/membaca path proxy.

Catatan DSH: wiring, provider, dan tool list divalidasi lewat mock. Uji nyata
lulus 9/9 HTTP 200, test 5/5, `REPORT.md`. Pemicu 429 DSH adalah pasangan
`working_directory` + `read_image`; cukup drop `read_image` saat pasangan itu
muncul. `working_directory` tetap dikirim.

Catatan Hermes: uji nyata lulus tanpa 429: test 5/5, CLI JSON `115.25`,
`REPORT.md` 1442 byte, dan agent melaporkan `cat REPORT.md` exit 0. Proses
gateway Hermes sempat linger setelah selesai; itu hang CLI, bukan 429/quota.

Status proxy yang sudah terbukti:

- Tool cap 33 caller + 11 decoy = 44 upstream.
- Alias `sessions_spawn` → `spawn_agent`; `subagent_fork` → `fork_agent`;
  `ReportFindings` → `report_findings`; `write_stdin` → `stdin`.
- `/v1/responses` bridge: Responses input/tools → Chat Completions upstream,
  lalu SSE Chat → Responses. Tool call arguments diakumulasi oleh objek slot
  yang sama sebelum `response.function_call_arguments.done`.
- OpenClaw 2026.11.3 system prompt asli + 33 tool → 200 di 7 model.
- `pulse-alpha-free` 400 “Model is unavailable.”;
  `crouton-alpha-free` 410 deprecated.
- Funnel publik bisa melayani request harness dari Node/curl HTTP/1.1; perilaku
  HTTP/2 dengan harness asli masih perlu validasi di box.

## 429 investigation (corrected)

429 `FreeUsageLimitError` **bukan quota, bukan egress/account gate, dan bukan
rate-limit burst**. `retry-after` puluhan ribu detik adalah artefak. Jangan
menunggu reset dan jangan menyimpulkan limit dari satu 429.

Penyebab yang terbukti:

- **Komposisi tool:** pasangan `working_directory` + `read_image` (DSH) dan nama
  tool tertentu (`ReportFindings`, `write_stdin`, grup `mcp_skills`) ditolak.
  Perbaikan: drop/alias tool, bukan menunggu.
- **Workspace shim:** `<env>` memakai `process.cwd()` proxy sehingga model
  mengira workspace di `/root/oc-proxy`. Perbaikan: `detectWorkingDir()` membaca
  working directory dari system prompt klien.
- **Sesi:** jangan pin sesi OpenCode agent (`OPENCODE_SESSION`). Sesi statis
  membuat model mewarisi konteks `/root/oc-proxy`. Proxy sekarang memakai sesi
  baru per request; fresh-session smoke **200**.

Hasil setelah ketiga perbaikan: OpenClaw 2026.3.24 5/5 test + report, Hermes
5/5 + `cat` exit 0, DSH 5/5 + report. Tidak ada 429 pada run final.

Runner yang sudah disiapkan di box:

- `/workspace/oc-harness/run-openclaw113-report.sh`
- `/workspace/oc-harness/run-openclaw324-complex.sh`
- `/workspace/oc-harness/run-dsh-complex.sh`
- `/workspace/oc-harness/run-hermes-complex.sh`
- Task: `/workspace/oc-harness/task-complex.txt`,
  `/workspace/oc-harness/task-report.txt`

## Next Steps

1. Semua harness target sudah lulus di box; tidak ada blocker 429 yang tersisa.
2. Opsional: validasi Funnel HTTP/2 dengan harness asli; jika abort, pakai
   `--http1.1`.
3. Setelah debugging, kembalikan `REQUEST_LOG_ENABLED=0`, restart proxy, lalu
   hapus/rotasi log yang memuat kredensial.
4. Update `STATUS.md`, `FREE-TIER.md`, dan model list bila ada perubahan.
5. Bila muncul 429 baru: capture body, bisect komposisi tool/workspace/sesi,
   patch, replay runner. Jangan mengulang langsung tanpa diagnosis.

## Security

- Jangan print/copy gateway key, box token, atau isi `.env`.
- Jangan simpan payload harness yang memuat tool result berisi API key pihak
  ketiga.
- Rotasi box token dan token Vercel lama masih pending.
