"use strict";

/* WARP rotation control/status for the dashboard.
 *
 * scripts/warp_rotate.sh owns the tunnel lifecycle and writes state under
 * run/. This module only reads that state and spawns the script for explicit
 * actions. Mutations are gated by the gateway key in serve-local.js.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RUN = path.join(ROOT, "run");
const LOGS = path.join(ROOT, "logs");
const SCRIPT = path.join(ROOT, "scripts", "warp_rotate.sh");
const WIREPROXY_SCRIPT = path.join(ROOT, "scripts", "wireproxy.sh");
const WIREPROXY_ROTATE_SCRIPT = path.join(ROOT, "scripts", "wireproxy_rotate.sh");
const REGISTER_SCRIPT = path.join(ROOT, "scripts", "warp_register.js");
const PID_FILE = path.join(RUN, "warp-rotate.pid");
const ONCE_PID_FILE = path.join(RUN, "warp-once.pid");
const ONCE_LOCK = path.join(RUN, "warp-once.lock");
const EGRESS_FILE = path.join(RUN, "warp-egress.txt");
const EGRESS_IP_FILE = path.join(RUN, "warp-egress-ip.txt");
const LIVE_IP_FILE = path.join(RUN, "warp-live-ip.txt");
const LIVE_PREFIX_FILE = path.join(RUN, "warp-live-prefix.txt");
const COOLING_FILE = path.join(RUN, "warp-cooling.txt");
const BURNED_FILE = path.join(RUN, "warp-burned.json");
const BACKOFF_FILE = path.join(RUN, "warp-backoff-until");
const ROTATE_LOG = path.join(LOGS, "warp-rotate.log");
const REGISTER_LOG = path.join(LOGS, "warp-register.log");
const UPSTREAM_PROXY_FILE = path.join(RUN, "upstream-proxy.txt");

const USQUE_PORT = parseInt(process.env.WARP_PROXY_PORT || "28090", 10);
const RELAY_PORT = parseInt(process.env.WARP_FWD_PORT || "24443", 10);
// The working free-tier egress is the wireproxy HTTP proxy, not usque. The
// dashboard toggle and upstream status use this port; usque stays available
// for the rotation experiments.
const WIREPROXY_PORT = parseInt(process.env.WARP_WIREPROXY_PORT || "28091", 10);
const WIREPROXY_URL = (process.env.WARP_UPSTREAM_URL || `http://127.0.0.1:${WIREPROXY_PORT}`).trim();
const WARP_ENGINE = String(process.env.WARP_ENGINE || "").trim().toLowerCase();
const COOLDOWN = Math.max(60, parseInt(process.env.WARP_COOLDOWN || "600", 10) || 600);
// A quota hit holds the request while WARP is rotated. Mirror opencode-hop:
// no cooldown, one shared rotation at a time, and up to N rotation rounds per
// request before giving the 429 back to the client.
const QUOTA_ROUNDS = Math.max(1, parseInt(process.env.WARP_QUOTA_ROTATE_ROUNDS || "6", 10) || 6);
const AUTO_ROTATE_TIMEOUT_MS = Math.max(
  20000,
  parseInt(process.env.WARP_AUTO_ROTATE_TIMEOUT_MS || "180000", 10) || 180000
);
let healPromise = null;
const ENV_UPSTREAM_PROXY = (process.env.UPSTREAM_PROXY || "").trim();
const VERIFY_MODELS = String(
  process.env.WARP_VERIFY_MODELS ||
    process.env.WARP_VERIFY_MODEL ||
    "deepseek-v4.1-flash-free,mimo-v2.6-flash-free,tidepool-alpha-free"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function read(file, max = 65536) {
  try {
    return fs.readFileSync(file, "utf8").trim().slice(0, max);
  } catch {
    return "";
  }
}

function pidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port, host = "127.0.0.1", timeout = 350) {
  return new Promise((resolve) => {
    let done = false;
    const socket = net.connect({ port, host });
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// Count only cooling entries that have not expired, so the dashboard does not
// show stale prefixes between monitor purges.
function coolingCount() {
  const now = Math.floor(Date.now() / 1000);
  return read(COOLING_FILE, 128 * 1024)
    .split(/\r?\n/)
    .filter((line) => {
      const [ts, prefix] = line.trim().split(/\s+/);
      const at = parseInt(ts, 10);
      return Boolean(prefix) && Number.isFinite(at) && at + COOLDOWN > now;
    }).length;
}

// wireproxy rotation stores rejected /64 prefixes in warp-burned.json with
// millisecond timestamps. Count only entries still inside the cooldown window
// so the dashboard matches the usque cooling counter.
function burnedCount() {
  try {
    const data = JSON.parse(read(BURNED_FILE, 256 * 1024) || "{}");
    const keys = data && typeof data.keys === "object" ? data.keys : {};
    const now = Date.now();
    return Object.values(keys).filter((ts) => Number.isFinite(ts) && now - ts < COOLDOWN * 1000).length;
  } catch {
    return 0;
  }
}

function recentLog(file = ROTATE_LOG, lines = 10) {
  const text = read(file, 128 * 1024);
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).slice(-lines);
}

function activeUpstreamProxy() {
  return ENV_UPSTREAM_PROXY || read(UPSTREAM_PROXY_FILE, 256) || "";
}

// Pick the egress engine. WARP_ENGINE wins; otherwise infer it from the
// upstream proxy that traffic is actually using. wireproxy is the default
// because it is the egress that works with the current free tier.
function engine() {
  if (WARP_ENGINE === "usque" || WARP_ENGINE === "wireproxy") return WARP_ENGINE;
  const upstream = activeUpstreamProxy();
  if (upstream.includes(`:${USQUE_PORT}`)) return "usque";
  return "wireproxy";
}

function setUpstream(enabled) {
  if (ENV_UPSTREAM_PROXY) {
    const err = new Error("upstream proxy is locked by UPSTREAM_PROXY");
    err.status = 409;
    throw err;
  }
  if (enabled) {
    fs.mkdirSync(RUN, { recursive: true });
    fs.writeFileSync(UPSTREAM_PROXY_FILE, `${WIREPROXY_URL}\n`, { mode: 0o600 });
  } else {
    try {
      fs.unlinkSync(UPSTREAM_PROXY_FILE);
    } catch {}
  }
  return { ok: true, enabled: Boolean(enabled), upstreamProxy: activeUpstreamProxy() || null };
}

async function status() {
  const eng = engine();
  const monitorPid = parseInt(read(PID_FILE, 64), 10) || 0;
  const oncePid = parseInt(read(ONCE_PID_FILE, 64), 10) || 0;
  const rotating = pidRunning(oncePid);
  const monitoring = pidRunning(monitorPid);
  const [usque, relay, wireproxy] = await Promise.all([
    portOpen(USQUE_PORT),
    portOpen(RELAY_PORT),
    portOpen(WIREPROXY_PORT),
  ]);
  const backoffUntil = parseInt(read(BACKOFF_FILE, 64), 10) || 0;
  const backoff = Math.max(0, backoffUntil - Math.floor(Date.now() / 1000));

  return {
    ok: true,
    at: Date.now(),
    running: rotating || monitoring,
    rotating,
    monitor: monitoring,
    pid: rotating ? oncePid : monitoring ? monitorPid : null,
    ip: read(LIVE_IP_FILE, 128) || read(EGRESS_IP_FILE, 128) || null,
    prefix: read(LIVE_PREFIX_FILE, 128) || read(EGRESS_FILE, 128) || null,
    verifiedIp: read(EGRESS_IP_FILE, 128) || null,
    verifiedPrefix: read(EGRESS_FILE, 128) || null,
    cooling: eng === "usque" ? coolingCount() : burnedCount(),
    backoff,
    backoffUntil: backoff > 0 ? backoffUntil : null,
    engine: eng,
    usque,
    relay,
    wireproxy,
    ports: { usque: USQUE_PORT, relay: RELAY_PORT, wireproxy: WIREPROXY_PORT },
    upstreamProxy: activeUpstreamProxy() || null,
    upstreamLocked: Boolean(ENV_UPSTREAM_PROXY),
    verifyModels: VERIFY_MODELS,
    cooldown: COOLDOWN,
    log: recentLog(eng === "usque" ? ROTATE_LOG : REGISTER_LOG, 10),
  };
}

// Reserve the once-lock before spawning. The shell script takes the same lock,
// but doing it here closes the window where two rapid HTTP calls both see no
// PID file and both spawn a rotation.
function reserveOnceLock() {
  try {
    fs.mkdirSync(ONCE_LOCK);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const oncePid = parseInt(read(ONCE_PID_FILE, 64), 10) || 0;
  if (pidRunning(oncePid)) return false;
  let age = 0;
  try {
    age = Date.now() / 1000 - fs.statSync(ONCE_LOCK).mtimeMs / 1000;
  } catch {
    return false;
  }
  // A lock with no live PID is stale only after the same 5 minute grace the
  // shell script uses; inside that window the owning process may still be
  // starting up.
  if (age < 300) return false;
  try {
    fs.unlinkSync(ONCE_PID_FILE);
  } catch {}
  try {
    fs.rmdirSync(ONCE_LOCK);
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(ONCE_LOCK);
    return true;
  } catch {
    return false;
  }
}

function releaseOnceLock() {
  try {
    fs.unlinkSync(ONCE_PID_FILE);
  } catch {}
  try {
    fs.rmdirSync(ONCE_LOCK);
  } catch {}
}

function spawnDetached(cmd, args, logFile, env = process.env, onError = null) {
  let stdio = "ignore";
  let fd = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, "a");
    stdio = ["ignore", fd, fd];
  }
  let child;
  try {
    child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio, env });
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  child.on("error", (err) => {
    if (onError) onError(err);
  });
  child.unref();
  return child.pid || null;
}

function runUsque(action) {
  if (!fs.existsSync(SCRIPT)) throw new Error(`warp script missing: ${SCRIPT}`);
  let reserved = false;
  if (action === "rotate" || action === "once") {
    const oncePid = parseInt(read(ONCE_PID_FILE, 64), 10) || 0;
    if (pidRunning(oncePid) || !(reserved = reserveOnceLock())) {
      const err = new Error("rotation already in progress");
      err.status = 409;
      throw err;
    }
  }
  return spawnDetached(
    "bash",
    [SCRIPT, action],
    null,
    reserved ? { ...process.env, WARP_ONCE_LOCK_HELD: "1" } : process.env,
    () => {
      if (reserved) releaseOnceLock();
    }
  );
}

function rotate() {
  if (engine() === "usque") return runUsque("once");
  if (!fs.existsSync(REGISTER_SCRIPT) || !fs.existsSync(WIREPROXY_ROTATE_SCRIPT)) {
    throw new Error(`wireproxy rotation script missing: ${REGISTER_SCRIPT}`);
  }
  if (!reserveOnceLock()) {
    const err = new Error("rotation already in progress");
    err.status = 409;
    throw err;
  }
  try {
    return spawnDetached(
      "bash",
      [WIREPROXY_ROTATE_SCRIPT],
      null,
      { ...process.env, WARP_ONCE_LOCK_HELD: "1" },
      () => releaseOnceLock()
    );
  } catch (err) {
    releaseOnceLock();
    throw err;
  }
}

function start() {
  if (engine() === "usque") return runUsque("start");
  return spawnDetached("bash", [WIREPROXY_SCRIPT, "start"], null);
}

function stop() {
  if (engine() === "usque") return runUsque("stop");
  return spawnDetached("bash", [WIREPROXY_SCRIPT, "stop"], null);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The free tier reports exhausted quota as FreeUsageLimitError with a
// retry-after measured in hours. A plain session retry cannot fix that; the
// quota is tied to the egress address, so the useful response is a new WARP
// device address.
async function isQuotaResponse(response) {
  try {
    const text = await response.clone().text();
    return /FreeUsageLimitError|Free usage limit reached/i.test(text);
  } catch {
    return false;
  }
}

async function waitForRotation(timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // The wrapper writes its pid file and takes the lock immediately; give it a
  // beat before treating a missing lock as completion.
  await sleep(300);
  let sawLivePid = false;
  while (Date.now() < deadline) {
    const pid = parseInt(read(ONCE_PID_FILE, 64), 10) || 0;
    if (pid && pidRunning(pid)) sawLivePid = true;
    if (!fs.existsSync(ONCE_LOCK)) return true;
    // A fresh lock with no live owner is stale (the shell script has the same
    // five-minute grace); waiting the full timeout would only stall clients.
    if (!sawLivePid && Date.now() - started > 8000) return false;
    await sleep(500);
  }
  return false;
}

// Rotate once per quota event. Concurrent 429s share the same rotation; there
// is deliberately no cooldown, so a request keeps trying fresh WARP addresses
// until one verifies. Returns true when a newly verified egress is available.
async function healQuotaEgress({ timeoutMs = AUTO_ROTATE_TIMEOUT_MS } = {}) {
  if (engine() !== "wireproxy") return false;
  // Rotation only changes the address the upstream actually sees. If traffic
  // is going out directly, a quota error is not an egress problem.
  if (!activeUpstreamProxy().includes(`:${WIREPROXY_PORT}`)) return false;
  if (healPromise) return healPromise;

  healPromise = (async () => {
    let before = 0;
    try {
      before = fs.statSync(LIVE_IP_FILE).mtimeMs;
    } catch {}
    try {
      let started = false;
      try {
        rotate();
        started = true;
      } catch (err) {
        if (err.status !== 409) throw err;
        // A dashboard/startup rotation owns the lock; join it instead.
      }
      if (!(await waitForRotation(timeoutMs))) {
        console.warn("[warp] auto-rotate timed out");
        return false;
      }
      let after = 0;
      try {
        after = fs.statSync(LIVE_IP_FILE).mtimeMs;
      } catch {}
      const ok = after > before;
      console.log(
        `[warp] auto-rotate ${ok ? "verified a new egress" : "finished without a new egress"}${
          started ? "" : " (joined existing run)"
        }`
      );
      return ok;
    } catch (err) {
      console.warn(`[warp] auto-rotate failed: ${err.message}`);
      return false;
    } finally {
      healPromise = null;
    }
  })();
  return healPromise;
}

// Hold the request while rotating. Each round runs one rotation (which itself
// may try several WARP endpoints); a failed round waits five seconds, exactly
// like opencode-hop's quota retry, then tries another batch of addresses.
async function waitForQuotaEgress({ rounds = QUOTA_ROUNDS, onRound = null } = {}) {
  for (let round = 1; round <= rounds; round++) {
    if (onRound) onRound(round, rounds);
    if (await healQuotaEgress()) return true;
    if (round < rounds) await sleep(5000);
  }
  return false;
}

module.exports = {
  status,
  setUpstream,
  rotate,
  start,
  stop,
  QUOTA_ROUNDS,
  isQuotaResponse,
  healQuotaEgress,
  waitForQuotaEgress,
};

