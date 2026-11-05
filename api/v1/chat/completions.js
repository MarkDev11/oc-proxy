"use strict";

/* POST /v1/chat/completions (rewritten to /api/v1/chat/completions)
 * OpenAI-compatible facade over opencode.ai zen Responses API.
 */
const {
  cors,
  checkAuth,
  isAllowedModel,
  buildUpstreamBody,
  buildHeaders,
  upstreamUrl,
  newSessionId,
  splitFrames,
  parseFrame,
  makeTranslator,
} = require("../../../lib/opencode");
const stats = require("../../../lib/stats");

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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchUpstream(url, { headers, body }) {
  const maxWait = Math.max(5000, parseInt(process.env.UPSTREAM_MAX_WAIT_MS || "120000", 10) || 120000);
  const baseDelay = Math.max(500, parseInt(process.env.UPSTREAM_RETRY_DELAY_MS || "2000", 10) || 2000);
  const started = Date.now();
  let attempt = 0;
  let lastError = null;
  for (;;) {
    attempt++;
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      if (!RETRYABLE_STATUS.has(r.status)) return r;
      const retryAfter = parseInt(r.headers.get("retry-after") || "0", 10) || 0;
      const backoff = Math.min(30000, baseDelay * 2 ** (attempt - 1));
      // The free tier reports a generic "until midnight" retry-after even for
      // short bursts, so cap how long we honor it instead of failing instantly.
      const delay = Math.min(30000, Math.max(retryAfter * 1000, backoff));
      if (Date.now() - started + delay > maxWait) return r;
      try {
        await r.body?.cancel();
      } catch {}
      console.warn(`[oc-proxy] upstream ${r.status} (retry-after ${retryAfter}s); retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    } catch (e) {
      lastError = e;
      const delay = Math.min(30000, baseDelay * 2 ** (attempt - 1));
      if (Date.now() - started + delay > maxWait) throw e;
      console.warn(`[oc-proxy] upstream error (${e.message}); retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
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
        message: `unsupported model '${chatBody.model}'. Use any *-free opencode model (e.g. deepseek-v4.1-flash-free).`,
      },
    });
  }

  const clientWantsStream = chatBody.stream === true;
  const displayModel = String(chatBody.model);
  const t0 = Date.now();
  let upBody;
  let renameMap;
  try {
    const built = buildUpstreamBody(chatBody);
    upBody = built.body;
    renameMap = built.map;
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }

  const headers = buildHeaders({
    sessionId: req.headers["x-opencode-session"] || newSessionId(),
    userAgent: req.headers["user-agent"],
  });

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl(displayModel), { headers, body: JSON.stringify(upBody) });
  } catch (e) {
    stats.record({ m: displayModel, ok: false, st: 502, ms: Date.now() - t0, fin: "error" });
    return res.status(502).json({ error: { message: `upstream unreachable: ${e.message}` } });
  }
  if (!upstream.ok || !upstream.body) {
    const err = await forwardUpstreamError(upstream);
    stats.record({ m: displayModel, ok: false, st: err.status, ms: Date.now() - t0, fin: "error" });
    return res.status(err.status).json(err.body);
  }

  let tr = makeTranslator(displayModel, renameMap);
  let reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  // Optional graceful cutoffs. Disabled by default (0) now that the proxy runs
  // locally instead of in a serverless function: set SOFT_DEADLINE_MS to close
  // with finish_reason "length" after N ms of streamed output, and
  // ABSOLUTE_DEADLINE_MS as a hard cap from the request start.
  const startedAt = Date.now();
  const softMs = Math.max(0, parseInt(process.env.SOFT_DEADLINE_MS || "0", 10) || 0);
  const absMs = Math.max(0, parseInt(process.env.ABSOLUTE_DEADLINE_MS || "0", 10) || 0);
  let firstBytesAt = 0;
  const expired = () => {
    const t = Date.now();
    if (absMs > 0 && t - startedAt > absMs) return true;
    return softMs > 0 && firstBytesAt > 0 && t - firstBytesAt > softMs;
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
      const out = tr.finalJson();
      stats.record({
        m: displayModel,
        ok: true,
        st: 200,
        p: out.usage.prompt_tokens || stats.est(upBody),
        c: out.usage.completion_tokens || stats.est(tr.state.text),
        ms: Date.now() - t0,
        fin: out.choices[0].finish_reason,
      });
      return res.status(200).json(out);
    } catch (e) {
      stats.record({ m: displayModel, ok: false, st: 502, ms: Date.now() - t0, fin: "error" });
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
    {
      const u = tr.state.usage || {};
      stats.record({
        m: displayModel,
        ok: true,
        st: 200,
        p: u.prompt_tokens || stats.est(upBody),
        c: u.completion_tokens || stats.est(tr.state.text),
        ms: Date.now() - t0,
        fin: tr.finish(),
      });
    }
  } catch (e) {
    stats.record({ m: displayModel, ok: false, st: 200, ms: Date.now() - t0, fin: "error" });
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
