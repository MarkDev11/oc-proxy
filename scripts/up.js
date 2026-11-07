'use strict';

/* Supervisor: run oc-proxy locally. By default it also exposes the proxy
 * through a Cloudflare Quick Tunnel; set TUNNEL_DISABLED=1 to skip that and
 * use an external tunnel such as Tailscale Funnel. Restarts either child if it
 * exits and writes the current public URL to run/tunnel-url.txt (read by
 * GET /api/tunnel and the dashboard).
 *
 * Usage: node scripts/up.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

const PORT = parseInt(process.env.PORT || '8791', 10);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = (process.env.GATEWAY_API_KEY || '').trim();
const LOCAL = `http://${HOST}:${PORT}`;
const RUN_DIR = path.join(ROOT, 'run');
const LOG_DIR = path.join(ROOT, 'logs');
const PID_FILE = path.join(RUN_DIR, 'supervisor.pid');
const URL_FILE = path.resolve(ROOT, process.env.TUNNEL_URL_FILE || 'run/tunnel-url.txt');
const CLOUDFLARED = path.resolve(ROOT, process.env.CLOUDFLARED_BIN || 'bin/cloudflared');
const TUNNEL_DISABLED = /^(1|true|yes|on)$/i.test((process.env.TUNNEL_DISABLED || '').trim());
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim();

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));

if (!API_KEY) {
  console.error('[up] GATEWAY_API_KEY kosong. Isi dulu di .env sebelum expose ke publik.');
  process.exit(1);
}
if (!TUNNEL_DISABLED && !fs.existsSync(CLOUDFLARED)) {
  console.error(`[up] cloudflared tidak ada di ${CLOUDFLARED}. Jalankan: npm run install:tunnel`);
  process.exit(1);
}

const serverLog = fs.createWriteStream(path.join(LOG_DIR, 'oc-proxy.log'), { flags: 'a' });
const tunnelLog = fs.createWriteStream(path.join(LOG_DIR, 'cloudflared.log'), { flags: 'a' });

let stopping = false;
let server = null;
let tunnel = null;
let tunnelRestartTimer = null;
let serverRestartTimer = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function pipeLog(stream, file, tag) {
  stream.on('data', (buf) => {
    file.write(buf);
    const s = buf.toString();
    for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`${tag} ${line}`);
  });
}

const BUN = process.env.BUN_BIN || 'bun';
const haveBun = spawnSync(BUN, ['--version'], { encoding: 'utf8' }).status === 0;
if (!haveBun) {
  log('WARNING: bun not found; upstream requests will use Node TLS and may be rate-limited (429)');
}

function startServer() {
  if (stopping) return;
  log(`starting oc-proxy on ${LOCAL} (${haveBun ? 'bun' : 'node'})`);
  server = spawn(haveBun ? BUN : process.execPath, ['serve-local.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeLog(server.stdout, serverLog, '[oc-proxy]');
  pipeLog(server.stderr, serverLog, '[oc-proxy]');
  server.on('exit', (code, signal) => {
    if (stopping) return;
    log(`oc-proxy exited (code=${code} signal=${signal}); restarting in 2s`);
    serverRestartTimer = setTimeout(startServer, 2000);
  });
  server.on('error', (e) => log(`oc-proxy spawn error: ${e.message}`));
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const r = await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startTunnel() {
  if (stopping) return;
  if (TUNNEL_DISABLED) {
    log('cloudflare tunnel disabled (TUNNEL_DISABLED=1)');
    try {
      fs.unlinkSync(URL_FILE);
    } catch {}
    if (PUBLIC_URL) {
      fs.writeFileSync(URL_FILE, `${PUBLIC_URL}\n`);
      log(`public URL: ${PUBLIC_URL}`);
    }
    return;
  }
  try {
    fs.unlinkSync(URL_FILE);
  } catch {}
  const args = ['tunnel', '--url', LOCAL, '--no-autoupdate', '--loglevel', 'info'];
  if (process.env.TUNNEL_PROTOCOL) args.push('--protocol', process.env.TUNNEL_PROTOCOL);
  log(`starting cloudflared quick tunnel -> ${LOCAL}`);
  tunnel = spawn(CLOUDFLARED, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (buf) => {
    tunnelLog.write(buf);
    const s = buf.toString();
    for (const line of s.split(/\r?\n/)) if (line.trim()) console.log(`[cloudflared] ${line}`);
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      fs.writeFileSync(URL_FILE, `${m[0]}\n`);
      log(`public URL: ${m[0]}`);
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('error', (e) => log(`cloudflared spawn error: ${e.message}`));
  tunnel.on('exit', (code, signal) => {
    if (stopping) return;
    log(`cloudflared exited (code=${code} signal=${signal}); restarting in 5s`);
    try {
      fs.unlinkSync(URL_FILE);
    } catch {}
    tunnelRestartTimer = setTimeout(startTunnel, 5000);
  });
}

function stop(sig) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${sig})`);
  clearTimeout(tunnelRestartTimer);
  clearTimeout(serverRestartTimer);
  for (const child of [tunnel, server]) {
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
  setTimeout(() => {
    for (const child of [tunnel, server]) {
      if (child && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    try {
      fs.unlinkSync(URL_FILE);
    } catch {}
    process.exit(0);
  }, 4000).unref();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', () => {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
});

(async () => {
  startServer();
  const ok = await waitHealthy(20000);
  if (!ok) {
    log('oc-proxy did not become healthy in 20s; exiting');
    stop('unhealthy');
    return;
  }
  log('oc-proxy healthy');
  startTunnel();
})();
