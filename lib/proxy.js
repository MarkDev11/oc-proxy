"use strict";

/* Proxy fallback layer for oc-proxy (zero dependencies).
 *
 * - Pool of healthy HTTP proxies is maintained by scripts/validate-pool.js
 *   (GitHub Actions, every 15 min) and published as pool.json.
 * - This module: fetch/cache pool, pick lowest-latency entry with cooldown,
 *   HTTPS tunnelling via HTTP CONNECT + TLS (global fetch has no proxy
 *   support), and testProxy() used by the validator.
 */

const net = require("net");
const tls = require("tls");

const POOL_TTL_MS = 10 * 60 * 1000;
const POOL_MAX_AGE_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

let poolCache = { at: 0, proxies: [] };
const cooldowns = new Map(); // proxyUrl -> timestamp until

function fallbackEnabled() {
  return process.env.PROXY_FALLBACK === "1";
}
function timeoutMs() {
  return Math.max(5000, parseInt(process.env.PROXY_TIMEOUT_MS || "25000", 10) || 25000);
}
function poolUrl() {
  return (process.env.PROXY_POOL_URL || "").trim();
}

async function loadPool() {
  const now = Date.now();
  if (poolCache.proxies.length && now - poolCache.at < POOL_TTL_MS) return poolCache.proxies;
  const url = poolUrl();
  if (!url) return poolCache.proxies;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "oc-proxy/1.0" } });
    if (!r.ok) return poolCache.proxies;
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.proxies;
    if (!Array.isArray(list)) return poolCache.proxies;
    const fresh = list
      .filter((p) => p && typeof p.url === "string" && p.url.startsWith("http://"))
      .filter((p) => !p.checkedAt || now - Date.parse(p.checkedAt) < POOL_MAX_AGE_MS)
      .slice(0, 10);
    poolCache = { at: now, proxies: fresh };
    return fresh;
  } catch {
    return poolCache.proxies;
  }
}

/** Lowest-latency proxy not on cooldown, or null. Pure (testable). */
function pickProxy(proxies, now = Date.now()) {
  const avail = (proxies || []).filter((p) => (cooldowns.get(p.url) || 0) < now);
  avail.sort((a, b) => (a.latencyMs ?? 999999) - (b.latencyMs ?? 999999));
  return avail[0] || null;
}
function coolDown(url, ms = COOLDOWN_MS) {
  cooldowns.set(url, Date.now() + ms);
}
function clearCooldowns() {
  cooldowns.clear();
}

function parseProxyUrl(u) {
  const x = new URL(u);
  if (x.protocol !== "http:") throw new Error("only http:// proxies supported for fallback");
  return { host: x.hostname, port: parseInt(x.port || "80", 10) };
}

function parseHead(text) {
  const lines = text.split("\r\n");
  const status = parseInt((lines[0] || "").split(" ")[1] || "0", 10);
  const headers = {};
  for (const ln of lines.slice(1)) {
    const i = ln.indexOf(":");
    if (i > 0) headers[ln.slice(0, i).trim().toLowerCase()] = ln.slice(i + 1).trim();
  }
  return { status, headers };
}

/**
 * HTTPS request through an HTTP proxy (CONNECT + TLS), zero deps.
 * Returns fetch-like {ok, status, stream (WHATWG), cancel(), text()}.
 */
function postViaProxy(proxyUrl, targetUrl, { method = "POST", headers = {}, body = "", timeout = timeoutMs() } = {}) {
  const t = new URL(targetUrl);
  if (t.protocol !== "https:") throw new Error("only https: targets supported");
  const { host: ph, port: pp } = parseProxyUrl(proxyUrl);

  let sock = null;
  let tlsSock = null;
  let done = false;
  let onCancel = null;
  const destroy = () => {
    try {
      tlsSock && tlsSock.destroy();
    } catch {}
    try {
      sock && sock.destroy();
    } catch {}
  };

  const promise = new Promise((resolve, reject) => {
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error("proxy timeout")), timeout);

    sock = net.connect({ host: ph, port: pp });
    sock.setTimeout(timeout, () => fail(new Error("proxy connect timeout")));
    sock.once("error", fail);

    let acc = Buffer.alloc(0);
    const MARK = Buffer.from("\r\n\r\n");

    sock.on("connect", () => {
      sock.write(`CONNECT ${t.hostname}:443 HTTP/1.1\r\nHost: ${t.hostname}:443\r\n\r\n`);
    });

    sock.on("data", (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      const i = acc.indexOf(MARK);
      if (i === -1) {
        if (acc.length > 65536) fail(new Error("proxy CONNECT header too large"));
        return;
      }
      const headText = acc.slice(0, i).toString("latin1");
      const { status } = parseHead(headText);
      if (status !== 200) {
        fail(new Error(`proxy CONNECT refused: ${status}`));
        return;
      }
      const rest = acc.slice(i + MARK.length);
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      tlsSock = tls.connect({ socket: sock, servername: t.hostname, timeout });
      tlsSock.once("error", fail);
      tlsSock.once("secureConnect", () => {
        const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
        const h = { ...headers, Host: t.host, "Content-Length": String(bodyBuf.length), Connection: "close" };
        delete h["content-length"];
        let raw = `${method} ${t.pathname}${t.search} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(h)) raw += `${k}: ${v}\r\n`;
        raw += "\r\n";
        tlsSock.write(raw);
        if (bodyBuf.length) tlsSock.write(bodyBuf);
        watchResponse(rest);
      });
    });

    function watchResponse(initial) {
      let buf = initial;
      let mode = "head";
      let status = 0;
      let respHeaders = {};
      let chunkLeft = null;
      let finished = false;
      let controller = null;

      const stream = new ReadableStream({
        start(c) {
          controller = c;
          onCancel = () => {
            if (!finished) {
              finished = true;
              clearTimeout(timer);
              try {
                c.close();
              } catch {}
              destroy();
            }
          };
          if (buf.length) pump();
        },
        cancel() {
          if (onCancel) onCancel();
        },
      });

      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        destroy();
        try {
          if (err) controller.error(err);
          else controller.close();
        } catch {}
      };

      function pump() {
        try {
          for (;;) {
            if (mode === "head") {
              const i = buf.indexOf(MARK);
              if (i === -1) return;
              const parsed = parseHead(buf.slice(0, i).toString("latin1"));
              status = parsed.status;
              respHeaders = parsed.headers;
              buf = buf.slice(i + MARK.length);
              const te = respHeaders["transfer-encoding"] || "";
              if (/chunked/i.test(te)) mode = "chunked";
              else if (respHeaders["content-length"]) {
                mode = "length";
                chunkLeft = parseInt(respHeaders["content-length"], 10);
              } else mode = "close";
              if (!finished) {
                done = true;
                clearTimeout(timer);
                resolve({
                  ok: status >= 200 && status < 300,
                  status,
                  headers: respHeaders,
                  stream,
                  cancel: () => onCancel && onCancel(),
                  text: async () => Buffer.concat(await collectAll(stream)).toString("utf8"),
                });
              }
            } else if (mode === "chunked") {
              if (chunkLeft === null) {
                const i = buf.indexOf("\r\n");
                if (i === -1) return;
                chunkLeft = parseInt(buf.slice(0, i).toString("ascii").trim(), 16);
                buf = buf.slice(i + 2);
                if (chunkLeft === 0) {
                  finish();
                  return;
                }
              }
              if (buf.length < chunkLeft + 2) return;
              controller.enqueue(buf.slice(0, chunkLeft));
              buf = buf.slice(chunkLeft + 2);
              chunkLeft = null;
            } else if (mode === "length") {
              if (buf.length < chunkLeft) return;
              controller.enqueue(buf.slice(0, chunkLeft));
              buf = buf.slice(chunkLeft);
              finish();
              return;
            } else {
              if (buf.length) {
                controller.enqueue(buf);
                buf = Buffer.alloc(0);
              }
              return;
            }
          }
        } catch (e) {
          finish(e);
        }
      }

      tlsSock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        pump();
      });
      tlsSock.on("end", () => finish());
      tlsSock.on("close", () => finish());
      tlsSock.on("error", (e) => finish(e));
    }
  });

  return promise;
}

async function collectAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return parts;
}

/**
 * Health-test one proxy: GET ip echo + headers echo through the tunnel.
 * Returns {ok, latencyMs, anon} or {ok:false, error}.
 */
async function testProxy(proxyUrl, timeoutPerReq = 10000) {
  const t0 = Date.now();
  try {
    const r1 = await postViaProxy(proxyUrl, "https://api.ipify.org", { method: "GET", headers: {}, timeout: timeoutPerReq });
    const ip = (await r1.text()).trim();
    if (r1.status !== 200 || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return { ok: false, error: `bad ip echo: ${r1.status} ${ip.slice(0, 40)}` };
    }
    const latencyMs = Date.now() - t0;
    const r2 = await postViaProxy(proxyUrl, "https://httpbin.org/headers", { method: "GET", headers: {}, timeout: timeoutPerReq });
    let anon = "unknown";
    if (r2.status === 200) {
      try {
        const hdrs = JSON.parse(await r2.text()).headers || {};
        const keys = Object.keys(hdrs).map((k) => k.toLowerCase());
        anon = keys.some((k) => ["x-forwarded-for", "via", "forwarded", "x-real-ip"].includes(k))
          ? "transparent"
          : "anonymous";
      } catch {}
    }
    return { ok: true, latencyMs, anon };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

module.exports = {
  fallbackEnabled,
  timeoutMs,
  poolUrl,
  loadPool,
  pickProxy,
  coolDown,
  clearCooldowns,
  postViaProxy,
  testProxy,
};
