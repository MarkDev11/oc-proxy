"use strict";

/* Register or rotate oc-proxy's own Cloudflare WARP device and write a
 * wireproxy config. This mirrors the working opencode-hop tjk-warp flow:
 * X25519 keys -> POST /reg (or PATCH /reg/:id) -> wireproxy -> egress check.
 *
 * Usage:
 *   node scripts/warp_register.js            # reuse device, rotate only if needed
 *   node scripts/warp_register.js --register # force a new Cloudflare device
 *   node scripts/warp_register.js --rotate   # rotate the saved device keys
 *   node scripts/warp_register.js --test     # only test the current egress
 *   node scripts/warp_register.js --max 8    # rotation attempts (default 5)
 */

const crypto = require("crypto");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RUN = path.join(ROOT, "run");
const DEVICE_FILE = path.join(RUN, "warp-device.json");
const CONF_FILE = path.join(RUN, "warp-wireproxy.conf");
const BURNED_FILE = path.join(RUN, "warp-burned.json");
const LIVE_IP_FILE = path.join(RUN, "warp-live-ip.txt");
const LIVE_PREFIX_FILE = path.join(RUN, "warp-live-prefix.txt");
const KEY_FILE = path.join(RUN, "opencode-console.key");
const PROXY = `http://127.0.0.1:${process.env.WARP_WIREPROXY_PORT || "28091"}`;
const REG_URL = "https://api.cloudflareclient.com/v0a2158/reg";
const CLIENT_VERSION = "a-6.11-2223";
const TEST_MODELS = (process.env.WARP_VERIFY_MODELS || process.env.WARP_VERIFY_MODEL || "deepseek-v4.1-flash-free")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_MODEL = TEST_MODELS[0];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const FORCE_REGISTER = flag("--register");
const FORCE_ROTATE = flag("--rotate");
const TEST_ONLY = flag("--test");
const WRITE_CONF = flag("--write-conf");
const MAX_ATTEMPTS = Math.max(1, parseInt(opt("--max", "5"), 10) || 5);

// Registration/rotation and the egress check need Bun's TLS/HTTP fingerprint.
// Writing the wireproxy config from an existing device is pure JSON/file I/O,
// so it is allowed under plain Node too (wireproxy.sh uses it as a fallback).
if (!process.versions.bun && !WRITE_CONF) {
  console.error("warp_register must run under bun (TLS/HTTP fingerprint): bun scripts/warp_register.js");
  process.exit(2);
}

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function genKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKey: b64(publicKey.export({ type: "spki", format: "der" }).subarray(12)),
    privateKey: b64(privateKey.export({ type: "pkcs8", format: "der" }).subarray(16)),
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode });
  try {
    fs.chmodSync(file, mode);
  } catch {}
}

function burned() {
  const data = readJson(BURNED_FILE, { version: 1, keys: {} });
  if (!data || typeof data !== "object") return { version: 1, keys: {} };
  if (!data.keys || typeof data.keys !== "object") data.keys = {};
  return data;
}

function burn(prefix) {
  if (!prefix) return;
  const data = burned();
  data.keys[prefix] = Date.now();
  writeJson(BURNED_FILE, data, 0o644);
}

function isBurned(prefix) {
  return Boolean(prefix && burned().keys[prefix]);
}

function prefixOf(ip) {
  if (!ip) return "";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":");
  return ip;
}

function curl(args, timeoutMs = 30000) {
  try {
    return execFileSync("curl", ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), ...args], {
      encoding: "utf8",
      timeout: timeoutMs + 2000,
    });
  } catch (e) {
    return e.stdout ? String(e.stdout) : "";
  }
}

function egress() {
  const out = curl([
    "-x",
    PROXY,
    "https://[2606:4700:4700::1111]/cdn-cgi/trace",
  ], 8000);
  const ip = (out.match(/^ip=(.+)$/m) || [])[1] || "";
  const warp = (out.match(/^warp=(.+)$/m) || [])[1] || "";
  return { ip: ip.trim(), warp: warp.trim() };
}

async function modelStatus(model = TEST_MODEL) {
  // A bare curl gets 429 even on a working egress; the free tier also checks
  // the OpenCode fingerprint (TLS/HTTP stack, UA, client headers, tool
  // definitions). Use Bun's fetch and the proxy's own builder so the rotation
  // test matches real traffic.
  const oc = require(path.join(ROOT, "lib", "opencode.js"));
  const built = oc.buildUpstreamBody({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 8,
    stream: false,
  });
  const headers = oc.buildHeaders({ sessionId: oc.newSessionId(), model });
  try {
    const r = await fetch(oc.upstreamUrl(model), {
      method: "POST",
      headers,
      body: JSON.stringify(built.body),
      proxy: PROXY,
      signal: AbortSignal.timeout(60000),
    });
    return r.status;
  } catch {
    return 0;
  }
}

async function registerDevice(keys = genKeys()) {
  const body = {
    key: keys.publicKey,
    install_id: "",
    fcm_token: "",
    tos: new Date().toISOString(),
    model: "PC",
    serial_number: "",
    locale: "en_US",
  };
  const r = await fetch(REG_URL, {
    method: "POST",
    headers: {
      "CF-Client-Version": CLIENT_VERSION,
      "User-Agent": "okhttp/3.12.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 429) {
    const err = new Error("registration rate limited by Cloudflare");
    err.code = "RATE_LIMIT";
    throw err;
  }
  if (!r.ok) throw new Error(`registration failed: HTTP ${r.status} ${JSON.stringify(json).slice(0, 180)}`);
  return buildDevice(json, keys, null);
}

async function rotateDevice(device) {
  if (!device || !device.id || !device.token) return registerDevice();
  const keys = genKeys();
  const r = await fetch(`${REG_URL}/${device.id}`, {
    method: "PATCH",
    headers: {
      "CF-Client-Version": CLIENT_VERSION,
      "User-Agent": "okhttp/3.12.1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${device.token}`,
    },
    body: JSON.stringify({ key: keys.publicKey }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn(`[warp] key rotation refused (HTTP ${r.status}); registering a new device`);
    return registerDevice();
  }
  return buildDevice(json, keys, device);
}

function ipv4Of(endpoint) {
  if (!endpoint || typeof endpoint !== "string") return "";
  const host = endpoint.split(":")[0];
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : "";
}

async function buildDevice(json, keys, previous) {
  const peer = (json.config && json.config.peers && json.config.peers[0]) || {};
  const iface = (json.config && json.config.interface) || {};
  const addresses = iface.addresses || {};
  const endpointHost = String((peer.endpoint && peer.endpoint.host) || "engage.cloudflareclient.com:2408").split(":")[0];
  let resolved = [];
  try {
    resolved = await dns.resolve4(endpointHost);
  } catch {}
  const ips = [...new Set([...resolved, ipv4Of(peer.endpoint && peer.endpoint.v4)].filter(Boolean))];
  return {
    id: json.id || previous?.id,
    token: json.token || previous?.token,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    peerPublicKey: peer.public_key || previous?.peerPublicKey,
    endpointHost,
    endpointIps: ips.length ? ips : previous?.endpointIps || [endpointHost],
    endpointPorts: (peer.endpoint && peer.endpoint.ports) || previous?.endpointPorts || [2408, 500, 1701, 4500],
    address4: addresses.v4 || previous?.address4,
    address6: addresses.v6 || previous?.address6,
  };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function writeConfig(device) {
  if (!device.address4 || !device.peerPublicKey) throw new Error("device is missing address4/peerPublicKey");
  const ip = pick(device.endpointIps) || device.endpointHost;
  const port = pick(device.endpointPorts) || 2408;
  const endpoint = `${ip}:${port}`;
  const address = `${device.address4}/32${device.address6 ? `, ${device.address6}/128` : ""}`;
  const conf = [
    "[Interface]",
    `PrivateKey = ${device.privateKey}`,
    `Address = ${address}`,
    "DNS = 1.1.1.1",
    "",
    "[Peer]",
    `PublicKey = ${device.peerPublicKey}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${endpoint}`,
    "PersistentKeepalive = 25",
    "",
    "[http]",
    `BindAddress = 127.0.0.1:${process.env.WARP_WIREPROXY_PORT || "28091"}`,
    "",
  ].join("\n");
  fs.mkdirSync(RUN, { recursive: true });
  fs.writeFileSync(CONF_FILE, conf, { mode: 0o600 });
  try {
    fs.chmodSync(CONF_FILE, 0o600);
  } catch {}
  return endpoint;
}

function restartWireproxy() {
  try {
    execFileSync("bash", [path.join(ROOT, "scripts", "wireproxy.sh"), "restart"], {
      encoding: "utf8",
      timeout: 30000,
      env: process.env,
    });
  } catch (e) {
    console.warn(`[warp] wireproxy restart: ${String(e.stdout || e.message).trim().slice(0, 300)}`);
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function checkCurrent() {
  const e = egress();
  if (!e.ip || e.warp !== "on") {
    return { ok: false, ip: e.ip, prefix: prefixOf(e.ip), status: 0, models: {}, reason: "no warp egress" };
  }
  const models = {};
  let bad;
  for (const model of TEST_MODELS) {
    const st = await modelStatus(model);
    models[model] = st;
    if (st !== 200) {
      bad = st;
      // A 429/403 is a hard per-model quota answer for this egress; probing
      // the remaining models only wastes time on an address we will discard.
      if (st === 429 || st === 403) break;
    }
  }
  return { ok: bad === undefined, ip: e.ip, prefix: prefixOf(e.ip), status: bad === undefined ? 200 : bad, models };
}

function modelSummary(result) {
  return TEST_MODELS.map((m) => `${m}=${result.models?.[m] ?? "?"}`).join(" ");
}

function writeLive(result) {
  fs.writeFileSync(LIVE_IP_FILE, `${result.ip}\n`);
  fs.writeFileSync(LIVE_PREFIX_FILE, `${result.prefix}\n`);
  // Keep the verified state in the same files the dashboard reads. For the
  // wireproxy engine these are written only after a model returns 200.
  fs.writeFileSync(path.join(RUN, "warp-egress-ip.txt"), `${result.ip}\n`);
  fs.writeFileSync(path.join(RUN, "warp-egress.txt"), `${result.prefix}\n`);
}

async function main() {
  fs.mkdirSync(RUN, { recursive: true });

  if (WRITE_CONF) {
    const device = readJson(DEVICE_FILE, null);
    if (!device) {
      console.error(`[warp] no saved device at ${DEVICE_FILE}; run with --register`);
      process.exit(1);
    }
    const endpoint = writeConfig(device);
    console.log(`[warp] wrote ${CONF_FILE} (endpoint ${endpoint})`);
    return;
  }

  if (TEST_ONLY) {
    const r = await checkCurrent();
    if (r.ok) writeLive(r);
    console.log(`[warp] egress=${r.ip || "none"} prefix=${r.prefix || "none"} ${modelSummary(r)}`);
    process.exit(r.ok ? 0 : 1);
  }

  let device = readJson(DEVICE_FILE, null);
  // Keep the last known device/config so a rotation that never finds a clean
  // egress can put the tunnel back instead of stranding it on a burned one.
  const previousDevice = device ? JSON.parse(JSON.stringify(device)) : null;
  let previousConf = null;
  try {
    previousConf = fs.readFileSync(CONF_FILE, "utf8");
  } catch {}
  let previousIp = "";
  try {
    previousIp = fs.readFileSync(LIVE_IP_FILE, "utf8").trim();
  } catch {}
  if (!device || FORCE_REGISTER) {
    console.log("[warp] registering a new Cloudflare WARP device");
    device = await registerDevice();
  } else if (FORCE_ROTATE) {
    console.log("[warp] rotating the saved WARP device keys");
    device = await rotateDevice(device);
  }
  writeJson(DEVICE_FILE, device);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const endpoint = writeConfig(device);
    console.log(`[warp] attempt ${attempt}/${MAX_ATTEMPTS}: endpoint ${endpoint}, restarting wireproxy`);
    restartWireproxy();
    await sleep(1500);

    let result = await checkCurrent();
    if (!result.ip) {
      console.warn("[warp] no egress yet; retrying the tunnel once");
      restartWireproxy();
      await sleep(2500);
      result = await checkCurrent();
    }

    console.log(`[warp] egress=${result.ip || "none"} prefix=${result.prefix || "none"} ${modelSummary(result)}`);
    if (result.ok && previousIp && result.ip === previousIp) {
      // opencode-hop rejects the network it was already on, even if the
      // verification models pass: the caller rotated because this address was
      // out of quota for its model. Rotate keys again for a different one.
      console.log(`[warp] egress ${result.ip} is unchanged; rotating for a new address`);
    } else if (result.ok) {
      writeLive(result);
      writeJson(DEVICE_FILE, device);
      console.log(`[warp] ready: ${result.ip} (${TEST_MODELS.join(", ")} = 200)`);
      return;
    }

    if (result.prefix && (result.status === 429 || result.status === 403 || !result.ip)) {
      burn(result.prefix);
    }
    if (isBurned(result.prefix) && result.status !== 200) {
      console.log(`[warp] prefix ${result.prefix} is burned; rotating`);
    }
    console.log("[warp] rotating keys for another WARP address");
    device = await rotateDevice(device);
    writeJson(DEVICE_FILE, device);
    await sleep(1000);
  }

  console.error(`[warp] no working WARP egress after ${MAX_ATTEMPTS} attempts`);
  if (previousDevice) {
    console.log("[warp] restoring the previous device and wireproxy config");
    writeJson(DEVICE_FILE, previousDevice);
    if (previousConf) {
      fs.writeFileSync(CONF_FILE, previousConf, { mode: 0o600 });
      try {
        fs.chmodSync(CONF_FILE, 0o600);
      } catch {}
    }
    restartWireproxy();
    await sleep(1500);
    const back = await checkCurrent();
    console.log(`[warp] restored egress=${back.ip || "none"} ${modelSummary(back)}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(`[warp] ${e && e.message ? e.message : e}`);
  process.exit(1);
});
