"use strict";

/* POST /v1/chat/completions (rewritten to /api/v1/chat/completions)
 * OpenAI-compatible facade over opencode.ai zen Responses API.
 */
const {
  cors,
  checkAuth,
  isAllowedModel,
  baseModel,
  buildUpstreamBody,
  buildHeaders,
  upstreamUrl,
  newSessionId,
  newRequestId,
  splitFrames,
  parseFrame,
  createTranslator,
} = require("../../../lib/opencode");
const proxy = require("../../../lib/proxy");

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      if (typeof req.body === "string") {
        try {
          resolve(JSON.parse(req.body || "{}"));
        } catch (e) {
          reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
        }
      } else resolve(req.body || {});
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) reject(Object.assign(new Error("body too large"), { status: 413 }));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const RETRYABLE = new Set([429, 502, 503]);

async function fetchWithFallback(url, { headers, body }) {
  let direct = null;
  let directErr = null;
  try {
    direct = await fetch(url, { method: "POST", headers, body });
    if (direct.ok || !proxy.fallbackEnabled() || !RETRYABLE.has(direct.status)) return direct;
    try {
      directErr = { status: direct.status, text: await direct.text() };
    } catch {
      directErr = { status: direct.status, text: "" };
    }
  } catch (e) {
    if (!proxy.fallbackEnabled()) throw e;
  }
  const pool = await proxy.loadPool();
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = proxy.pickProxy(pool);
    if (!p) break;
    try {
      const r = await proxy.postViaProxy(p.url, url, { headers, body, timeout: proxy.timeoutMs() });
      if (r.ok || !RETRYABLE.has(r.status)) {
        return { ok: r.ok, status: r.status, body: r.stream, text: r.text, headers: r.headers || {} };
      }
      try {
        await r.text().catch(() => {});
      } catch {}
      proxy.coolDown(p.url);
    } catch {
      proxy.coolDown(p.url);
    }
  }
  if (directErr) {
    return { ok: false, status: directErr.status, body: null, text: async () => directErr.text, headers: {} };
  }
  throw new Error("upstream unreachable and proxy fallback exhausted");
}

async function forwardUpstreamError(upstream) {
  const text = await upstream.text().catch(() => "");
  let body = text;
  try {
    body = text ? JSON.parse(text) : { error: { message: `upstream ${upstream.status}` } };
  } catch {
    body = { error: { message: text.slice(0, 2000) || `upstream ${upstream.status}` } };
  }
  return { status: upstream.status >= 400 ? upstream.status : 502, body };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "method not allowed" } });
  if (!checkAuth(req)) return res.status(401).json({ error: { message: "invalid api key" } });

  let chatBody;
  try {
    chatBody = await readJson(req);
  } catch (e) {
    return res.status(e.status || 400).json({ error: { message: e.message } });
  }

  if (!chatBody || typeof chatBody !== "object") return res.status(400).json({ error: { message: "empty body" } });
  if (!chatBody.model || !isAllowedModel(chatBody.model)) {
    return res.status(400).json({
      error: {
        message: `unsupported model '${chatBody.model}'. Use oc/muse-spark-1.3-contributor-free or oc/muse-spark-1.2-contributor-free.`,
      },
    });
  }

  const clientWantsStream = chatBody.stream === true;
  const displayModel = String(chatBody.model);
  let upBody;
  try {
    upBody = buildUpstreamBody(chatBody);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }

  const headers = buildHeaders({
    sessionId: req.headers["x-opencode-session"] || newSessionId(),
    requestId: newRequestId(),
    userAgent: req.headers["user-agent"],
  });

  let upstream;
  try {
    upstream = await fetchWithFallback(upstreamUrl(), { headers, body: JSON.stringify(upBody) });
  } catch (e) {
    return res.status(502).json({ error: { message: `upstream unreachable: ${e.message}` } });
  }
  if (!upstream.ok || !upstream.body) {
    const err = await forwardUpstreamError(upstream);
    return res.status(err.status).json(err.body);
  }

  const tr = createTranslator(displayModel);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  // Soft deadline: close gracefully with finish_reason "length" BEFORE the
  // platform kills the function mid-token, so agent loops auto-continue.
  // The per-content deadline runs from the FIRST upstream bytes (slow TTFB
  // must not eat the whole budget); the absolute cap is the final failsafe.
  // Both must stay below the function maxDuration (vercel.json).
  const startedAt = Date.now();
  const softMs = Math.max(1000, parseInt(process.env.SOFT_DEADLINE_MS || "50000", 10) || 50000);
  const absMs = Math.max(softMs, parseInt(process.env.ABSOLUTE_DEADLINE_MS || "55000", 10) || 55000);
  let firstBytesAt = 0;
  const expired = () => {
    const t = Date.now();
    if (t - startedAt > absMs) return true;
    return firstBytesAt > 0 && t - firstBytesAt > softMs;
  };
  const cutOff = () => {
    tr.markCutoff();
    try {
      reader.cancel();
    } catch {}
  };

  if (!clientWantsStream) {
    try {
      let buf = "";
      for (;;) {
        if (expired()) {
          cutOff();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstBytesAt && value && value.length) firstBytesAt = Date.now();
        buf += decoder.decode(value, { stream: true });
        const { frames, rest } = splitFrames(buf);
        buf = rest;
        for (const f of frames) {
          const p = parseFrame(f);
          if (!p) continue;
          if (p.event === "done") continue;
          tr.apply(p.event, p.data);
        }
      }
      const tail = decoder.decode();
      if (tail) {
        const { frames } = splitFrames(tail);
        for (const f of frames) {
          const p = parseFrame(f);
          if (!p || p.event === "done") continue;
          tr.apply(p.event, p.data);
        }
      }
      return res.status(200).json(tr.finalJson());
    } catch (e) {
      if (!res.headersSent) return res.status(502).json({ error: { message: e.message } });
      try {
        res.end();
      } catch {}
      return;
    } finally {
      try {
        reader.cancel();
      } catch {}
    }
  }

  // Streaming: translate Responses SSE -> OpenAI chunks on the fly.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const enc = new TextEncoder();
  try {
    let buf = "";
    for (;;) {
      if (expired()) {
        cutOff();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstBytesAt && value && value.length) firstBytesAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      const { frames, rest } = splitFrames(buf);
      buf = rest;
      for (const f of frames) {
        const p = parseFrame(f);
        if (!p || p.event === "done") continue;
        for (const s of tr.apply(p.event, p.data)) res.write(enc.encode(s));
      }
    }
    res.write(enc.encode(tr.finalChunk()));
    res.write(enc.encode("data: [DONE]\n\n"));
    res.end();
  } catch (e) {
    try {
      res.write(enc.encode(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`));
      res.end();
    } catch {}
  } finally {
    try {
      reader.cancel();
    } catch {}
  }
};
