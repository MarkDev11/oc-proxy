# Operations runbook

Last updated: **2026-11-06**. Environment: Termux + proot Ubuntu aarch64,
tanpa systemd, tanpa TUN/root.

## Start / stop / status

```bash
cd /root/oc-proxy

npm run bg       # supervisor + Bun server (+ Cloudflare jika TUNNEL_DISABLED != 1)
npm run status   # supervisor, health, public URL
npm run stop
npm run check    # syntax check semua handler
```

Foreground untuk debugging:

```bash
npm run server
```

Jika mengubah kode, **wajib restart**:

```bash
npm run stop && npm run bg
```

`npm run bg` menulis PID supervisor ke `run/supervisor.pid` dan URL publik ke
`run/tunnel-url.txt`.

## Health check yang benar

```bash
curl -fsS http://127.0.0.1:8791/api/health
curl -fsS http://127.0.0.1:8791/v1/models \
  -H "Authorization: Bearer $GATEWAY_API_KEY"
```

Jangan memakai request upstream kecil tanpa `tools` sebagai health check:
free tier membalas 429 untuk `tools=0`. Gunakan proxy dengan gateway key dan
body yang punya tool, atau body OpenCode/harness yang valid.

## Log

Request body logging **mati secara default** karena payload bisa memuat
secret. Aktifkan hanya saat debugging:

```bash
# tambahkan ke .env, lalu restart
REQUEST_LOG_ENABLED=1
npm run stop && npm run bg
```

| File | Isi |
| --- | --- |
| `logs/up.log` | supervisor |
| `logs/oc-proxy.log` | stdout/stderr server |
| `logs/cloudflared.log` | hanya jika Cloudflare aktif |
| `logs/requests/<ISO>-<id>.log` | hanya jika `REQUEST_LOG_ENABLED=1` |

Saat logging aktif, cari request berdasarkan `x-oc-request-id`:

```bash
ls -t logs/requests | head
f=$(ls -t logs/requests/*.log | head -1)
grep -n '^===' "$f"
sed -n '/^=== UPSTREAM REQUEST META ===/{n;p;}' "$f"
```

Jangan mencetak `CLIENT REQUEST`/`UPSTREAM REQUEST BODY` karena bisa memuat
secret. File log mode `0600`, tetapi tetap sensitif. Rotasi/cleanup manual:

```bash
# hapus log lebih dari 7 hari (contoh; sesuaikan kebutuhan)
find logs/requests -type f -mtime +7 -delete
```

Tidak ada rotasi otomatis. Setelah selesai debugging, set
`REQUEST_LOG_ENABLED=0`/hapus variabelnya dan restart.

## Tailscale Funnel

Tailscale berjalan manual di userspace. Binary:

- `/usr/local/bin/tailscale`
- `/usr/local/bin/tailscaled`
- socket `/var/run/tailscale/tailscaled.sock`
- state `/var/lib/tailscale/tailscaled.state`
- SOCKS/HTTP proxy `127.0.0.1:1055`

Contoh start (sesuaikan hostname/tailnet):

```bash
tailscaled --tun=userspace-networking \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --socks5-server=127.0.0.1:1055 \
  --outbound-http-proxy-listen=127.0.0.1:1055 &

tailscale --socket=/var/run/tailscale/tailscaled.sock up \
  --hostname=oc-proxy-termux \
  --accept-dns=false --accept-routes=false --netfilter-mode=off

tailscale --socket=/var/run/tailscale/tailscaled.sock funnel --bg 8791
tailscale --socket=/var/run/tailscale/tailscaled.sock funnel status
```

Cek status:

```bash
npm run status
tailscale --socket=/var/run/tailscale/tailscaled.sock status
tailscale --socket=/var/run/tailscale/tailscaled.sock funnel status
```

Catatan: `CapEff=0`; jangan andalkan TUN, systemd, atau fitur kernel. Helper
`scripts/tailscale.sh` belum dibuat. Setelah reboot, `tailscaled` dan Funnel
perlu dijalankan ulang.

## Cloudflare Quick Tunnel (opsional)

- Dimatikan pada deployment ini: `TUNNEL_DISABLED=1`.
- Jika diaktifkan: `TUNNEL_DISABLED=0`, `npm run install:tunnel` sekali,
  lalu `npm run bg`.
- URL Quick Tunnel berubah setiap restart. `TUNNEL_PROTOCOL=http2` jika
  QUIC/UDP bermasalah.
- Binary `bin/cloudflared` gitignored.

## Troubleshooting

| Gejala | Cek / tindakan |
| --- | --- |
| `401 invalid api key` | Header `Authorization: Bearer <GATEWAY_API_KEY>`; key comma-separated didukung |
| `400 unsupported model` | Gunakan id berakhiran `-free`; cek `/v1/models` |
| `429 FreeUsageLimitError` | Pastikan caller tool ≤33; lihat `FREE-TIER.md`; cek `retry-after`; jangan memakai body tanpa tool |
| `502 upstream unreachable` | Cek koneksi internet, DNS, `UPSTREAM_BASE_URL`; lihat log `[upstream]` |
| `503 fetch connect timeout` | Cek timeout upstream/harness; log `[upstream] attempt/status`; lihat `HARNESS.md` |
| Health lokal gagal | `npm run status`; `logs/up.log`; pastikan Bun ada |
| Funnel 502 | `tailscaled`/Funnel down; `npm run status`; `tailscale funnel status` |
| Funnel 200 lalu koneksi putus | Caveat saat ini untuk payload penuh; uji `curl --http1.1`, tanpa `-D`, dan dengan harness asli |
| URL publik berubah/ kosong | Cek `PUBLIC_URL`, `run/tunnel-url.txt`, `npm run status` |
| Proses menggantung | `npm run stop`; cek PID di `run/supervisor.pid`; kill jika perlu |
| Log membengkak | Hapus/arsipkan `logs/requests` secara manual |

## Security

- `.env` berisi gateway key dan secret provider; jangan dibaca keras,
  dicetak, disalin, atau di-commit.
- File `.env` mode ketat; jangan mengubah permission menjadi world-readable.
- Gateway key wajib di-set; Funnel publik.
- Log request dan payload harness bisa memuat API key pihak ketiga di dalam
  tool result. Redaksi yang ada belum lengkap.
- Jika secret terekspos: rotasi key, hapus log/payload terkait, dan restart.
- Jangan mengirim payload asli ke pihak ketiga/AI lain tanpa sanitasi.
- `.gitignore` mencakup `.env`, `bin/`, `run/`, `logs/`, `node_modules/`.

## Git

```bash
git status --short
git diff --stat
git log --oneline -5
```

Branch saat ini `reverse-oc-proxy`, commit terakhir `b42e230`. Perubahan
logging/fail-fast/timeout/tool cap/docs belum di-commit. Jangan commit/push
tanpa instruksi eksplisit.

## Setelah reboot / sesi baru

1. Pastikan `tailscaled` dan Funnel hidup.
2. `npm run status`; jika mati: `npm run bg`.
3. `curl /api/health`; pastikan `runtime: bun/...`.
4. Baca `docs/STATUS.md` untuk known issues dan next action.
5. Jangan langsung menjalankan tes tool besar berulang-ulang; bisa memicu
   429/quota. Sertakan baseline dan jeda.
