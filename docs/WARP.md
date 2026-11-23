# WARP rotation

Last updated: **2026-11-23**.

Egress default oc-proxy sekarang adalah **wireproxy**: Cloudflare WARP lewat
userspace WireGuard, diekspos sebagai HTTP proxy lokal di
`127.0.0.1:28091`. Device WARP dimiliki oc-proxy sendiri
(`run/warp-device.json`), jadi rotasi tidak bergantung pada proses atau device
milik opencode-hop.

Mesin lama **usque** (MASQUE, `127.0.0.1:28090`) masih tersedia untuk eksperimen
dan bisa diaktifkan dengan `WARP_ENGINE=usque`.

## Arsitektur

```
proxy (Bun)  --HTTP CONNECT-->  127.0.0.1:28091  wireproxy
                                      |
                                      v  (WireGuard UDP)
                              162.159.192.x:4500  Cloudflare WARP
                                      |
                                      v
                              opencode.ai upstream
```

- `wireproxy` membaca config `run/warp-wireproxy.conf` (mode 600) yang berisi
  private key, address, peer public key, dan endpoint WARP.
- `scripts/warp_register.js` mendaftarkan device baru ke
  `https://api.cloudflareclient.com/v0a2158/reg`, merotasi key X25519 lewat
  `PATCH /reg/:id`, lalu menulis ulang config dan me-restart wireproxy.
- Request upstream membawa fingerprint OpenCode lengkap dan
  `Authorization: Bearer <key>` dari `run/opencode-console.key`. `Bearer public`
  tetap jadi fallback, tetapi beberapa egress WARP membalas `429` sampai key
  asli dipakai.

## Menjalankan

```bash
cd /root/oc-proxy

bash scripts/wireproxy.sh status      # port + IP/colo/warp egress
bash scripts/wireproxy.sh start       # start wireproxy (config dari device)
bash scripts/wireproxy.sh stop        # stop wireproxy
bash scripts/wireproxy.sh restart     # restart wireproxy
bash scripts/wireproxy.sh test        # verifikasi model lewat egress aktif
bash scripts/wireproxy.sh rotate      # rotasi device + rebuild config + verifikasi
```

Perintah `rotate` memakai lock `run/warp-once.lock`, jadi rotasi dari startup,
dashboard, dan CLI tidak saling tumpang tindih. Lewat npm:
`npm run warp:status`, `npm run warp:test`, `npm run warp:rotate`.

`scripts/start.sh` otomatis menyalakan wireproxy. Dengan `WARP_ROTATE=1`, startup
juga menjalankan `warp_register.js --test`; kalau hasilnya bukan `200`, rotasi
dijalankan di background sampai egress lolos.

## Rotasi device

`scripts/warp_register.js` mendukung:

```bash
bun scripts/warp_register.js --register   # device Cloudflare baru
bun scripts/warp_register.js --rotate     # rotasi key device yang tersimpan
bun scripts/warp_register.js --test       # cek egress + model, tanpa rotasi
bun scripts/warp_register.js --write-conf # tulis ulang config dari device
bun scripts/warp_register.js --max 8      # batas percobaan rotasi
```

Alur `--rotate`:

1. Baca `run/warp-device.json`; kalau belum ada, daftarkan device baru.
2. Generate pasangan key X25519 baru dan `PATCH /reg/:id` ke Cloudflare.
3. Tulis `run/warp-device.json` dan `run/warp-wireproxy.conf`.
4. Restart wireproxy.
5. Baca egress lewat `https://[2606:4700:4700::1111]/cdn-cgi/trace`; pastikan
   `warp=on`.
6. Kirim request model dengan body/header OpenCode asli lewat egress tersebut,
   untuk **setiap** model di `WARP_VERIFY_MODELS`. `429/403` langsung
   menghentikan probe model sisanya karena alamat itu sudah pasti dipakai
   ulang.
7. Semua `200` → simpan IP/prefix ke `run/warp-live-ip.txt`,
   `run/warp-live-prefix.txt`, `run/warp-egress-ip.txt`, dan
   `run/warp-egress.txt`.
8. Ada `429/403` → prefix dimasukkan ke `run/warp-burned.json`, key dirotasi
   lagi, ulangi sampai `WARP_MAX_ATTEMPTS`.
9. Semua percobaan gagal → device + config **sebelum rotasi** dipulihkan dan
   wireproxy di-restart, supaya tunnel tidak tertinggal di alamat yang sudah
   kena limit.

Kuota free tier dihitung **per model per alamat egress**. Satu prefix WARP bisa
membalas `200` untuk `tidepool` tetapi `429 FreeUsageLimitError` untuk
`deepseek`/`mimo`, jadi rotasi baru dianggap sukses kalau seluruh model
verifikasi lolos.

Pengecekan model **wajib** memakai Bun + fingerprint OpenCode. `curl` minimal
sering dibalas `429` walaupun egress sehat; itu bukan bukti prefix ditolak.

## Auto-rotate saat kuota habis

Free tier membalas `429 FreeUsageLimitError` dengan `retry-after` berjam-jam
(sekitar 62.000 detik). Retry sesi biasa tidak menolong karena kuota dihitung
per model per alamat egress. Karena itu `api/v1/chat/completions.js` dan
`api/v1/messages.js` menahan request dan memanggil
`warp.waitForQuotaEgress()`:

1. Satu rotasi dijalankan (memakai lock yang sama dengan dashboard/startup).
2. Request-request lain yang kena 429 menunggu rotasi yang sama, tidak
   memulai rotasi baru.
3. Setelah lock selesai dan `run/warp-live-ip.txt` diperbarui, request
   langsung dikirim ulang ke egress baru.
4. Kalau rotasi tidak menemukan alamat baru, jeda 5 detik lalu rotasi lagi.
   Tidak ada cooldown; request ditahan sampai berhasil.
5. Maksimum `WARP_QUOTA_ROTATE_ROUNDS` (default 6) putaran per request. Kalau
   semuanya gagal, baru `429 FreeUsageLimitError` sintetis dikembalikan ke
   client.

Ini meniru kebijakan kuota opencode-hop (`F3=6`): satu promise rotasi global,
tanpa cooldown, dan retry dengan jeda 5 detik sampai alamat baru terverifikasi.

Auto-rotate hanya aktif kalau upstream memang lewat wireproxy
(`run/upstream-proxy.txt` / `UPSTREAM_PROXY` menunjuk port 28091). Kalau
upstream direct, error kuota bukan masalah egress.

## Dashboard dan API

Tab **Console** di dashboard (`GET /`) menampilkan:

- engine aktif (`wireproxy` atau `usque`);
- IP egress live dan prefix `/64`-nya;
- prefix terakhir yang lolos verifikasi;
- status wireproxy/usque/relay, cooling, dan backoff;
- apakah upstream memakai WARP atau direct;
- toggle **route upstream through WARP**;
- tombol **Rotate now**, **Start WARP**, dan **Stop WARP**;
- 10 baris terakhir log rotasi (`logs/warp-register.log` untuk wireproxy).

API:

```bash
curl -s http://127.0.0.1:8791/api/warp \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl -s -X POST http://127.0.0.1:8791/api/warp/rotate \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl -s -X POST http://127.0.0.1:8791/api/warp/start \
  -H "Authorization: Bearer $GATEWAY_API_KEY"

curl -s -X POST http://127.0.0.1:8791/api/warp/stop \
  -H "Authorization: Bearer $GATEWAY_API_KEY"
```

`rotate` mengembalikan `409` bila rotasi lain masih berjalan. `start`/`stop`
mengembalikan `202` dan PID proses yang di-spawn.

## Environment

| Variable | Default | Fungsi |
| --- | --- | --- |
| `WARP_ENGINE` | `wireproxy` | Mesin egress: `wireproxy` atau `usque` |
| `WARP_WIREPROXY_PORT` | `28091` | Port HTTP proxy wireproxy |
| `WARP_WIREPROXY_INFO_PORT` | `28092` | Port info/health wireproxy |
| `WARP_MAX_ATTEMPTS` | `5` wireproxy / `15` usque | Percobaan rotasi per run |
| `WARP_ROTATE` | `0` | Saat `start.sh`, cek egress dan rotasi kalau bukan `200` |
| `OPENCODE_KEY_FILE` | `run/opencode-console.key` | File key OpenCode Console |
| `OPENCODE_CONSOLE_KEY` | — | Override key lewat environment |
| `UPSTREAM_PROXY` | — | Kunci upstream ke HTTP proxy; menimpa toggle dashboard |
| `WARP_FAIL_BACKOFF` | `300` | Jeda rotasi usque setelah gagal |
| `WARP_VERIFY_MODELS` | `deepseek-v4.1-flash-free,mimo-v2.6-flash-free,tidepool-alpha-free` | Model yang harus `200` sebelum egress diterima |
| `WARP_QUOTA_ROTATE_ROUNDS` | `6` | Maksimum putaran rotasi per request saat kuota habis |
| `WARP_AUTO_ROTATE_TIMEOUT_MS` | `180000` | Batas satu putaran rotasi sebelum putaran berikutnya |
| `WARP_VERIFY` | `1` | `0` = lewati verifikasi usque |
| `WARP_COOLDOWN` | `600` | Detik cooling per prefix |
| `WARP_POLL` | `5` | Interval poll monitor usque (detik) |
| `WARP_PROXY_PORT` | `28090` | Port HTTP proxy usque |
| `WARP_FWD_PORT` | `24443` | Port relay TCP usque |
| `WARP_ENDPOINT` | `162.159.198.3` | Endpoint WARP relay usque |
| `USQUE_DIR` | `/workspace/usque` | Direktori binary/config usque |
| `USQUE_BIN` | `$USQUE_DIR/usque-h2-v6` | Binary usque |
| `WARP_CONFIG` | `$USQUE_DIR/config2.json` | Config hasil `usque register` |

## Legacy usque

Aktifkan dengan `WARP_ENGINE=usque` di `.env`, lalu:

```bash
bash scripts/warp_rotate.sh status
bash scripts/warp_rotate.sh start
bash scripts/warp_rotate.sh once
bash scripts/warp_rotate.sh stop
```

usque memakai HTTP/2 MASQUE dan relay Python
(`connect_forward_multi.py`) ke `WARP_ENDPOINT`. Verifikasi memakai
`scripts/warp_verify.js`. Log ada di `logs/warp-rotate.log`,
`logs/warp-usque.log`, dan `logs/warp-forward.log`.

## 429 bukan quota

`429 FreeUsageLimitError` di free tier sering penolakan
komposisi/fingerprint, bukan kuota habis. Rotasi WARP hanya menolong bila yang
ditolak adalah **prefix egress**-nya. Sebelum menyalahkan WARP:

- pastikan request memakai body/header OpenCode yang benar
  (lihat [`FREE-TIER.md`](FREE-TIER.md));
- cek `logs/oc-proxy.log` dan `logs/warp-register.log`;
- jangan menganggap `retry-after` puluhan ribu detik sebagai sisa kuota;
- pastikan key di `run/opencode-console.key` terbaca oleh user proxy.

## Troubleshooting

- **`wireproxy: down`** — jalankan `bash scripts/wireproxy.sh start`; cek
  `logs/wireproxy.log`.
- **Config wireproxy hilang** — `bash scripts/wireproxy.sh start` akan
  membangunnya dari `run/warp-device.json`; kalau device juga hilang, jalankan
  `bun scripts/warp_register.js --register`.
- **`--test` selalu 429** — pastikan dijalankan dengan Bun, bukan Node/curl.
  Cek juga `run/opencode-console.key` dan `WARP_VERIFY_MODELS`.
- **Rotasi berulang tanpa 200** — lihat `logs/warp-register.log`; prefix yang
  ditolak masuk `run/warp-burned.json`. Coba `--max` lebih besar atau hapus
  file burned untuk percobaan baru.
- **Semua request proxy gagal saat rotasi** — wireproxy di-restart beberapa
  kali selama rotasi. Request yang berjalan tepat saat rotasi bisa gagal;
  ulangi setelah status `rotating` kembali `false`.
- **Semua prefix WARP ditolak (429) tetapi direct 200** — egress WARP sedang
  diblokir upstream. Matikan toggle upstream WARP (atau kosongkan
  `UPSTREAM_PROXY`) dan gunakan direct sementara.
- **Dashboard tidak menampilkan panel WARP** — isi gateway key di tab Console;
  `/api/warp` memerlukan `Authorization: Bearer $GATEWAY_API_KEY`.
