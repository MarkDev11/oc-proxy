"use strict";

/* POST /v1/messages — Anthropic Messages API facade.
 * Lets Claude Code (ANTHROPIC_BASE_URL) talk straight to this proxy.
 * Accepts any model name; names not ending in -free map to ANTHROPIC_DEFAULT_MODEL.
 */
const crypto = require("crypto");
const {
  cors,
  isAllowedModel,
  baseModel,
  buildUpstreamBody,
  buildHeaders,
  upstreamUrl,
  newSessionId,
  splitFrames,
  parseFrame,
  makeTranslator,
} = require("../../lib/opencode");

function checkAnthropicAuth(req) {
  const need = (process.env.GATEWAY_API_KEY || "").trim();
  if (!need) return true;
  const keys = need.split(",").map((s) => s.trim()).filter(Boolean);
  const bearer = String(req.headers.authorization || "");
  const apiKey = String(req.headers["x-api-key"] || "");
  return keys.some((k) => bearer === `Bearer ${k}` || apiKey === k);
}

function defaultModel() {
  return (process.env.ANTHROPIC_DEFAULT_MODEL || "mimo-v2.6-flash-free").trim();
}

function resolveModel(id) {
  const m = String(id || "").trim();
  if (m && isAllowedModel(m)) return baseModel(m);
  return baseModel(defaultModel());
}

function textOfBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
}

/** Anthropic Messages body -> internal OpenAI-ish chat body (for buildUpstreamBody). */
function anthropicToChat(body) {
  const messages = [];
  const sys = body.system;
  if (typeof sys === "string" && sys.trim()) messages.push({ role: "system", content: sys });
  else if (Array.isArray(sys)) {
    const t = sys.filter((b) => b && b.type === "text" && b.text).map((b) => b.text).join("\n");
    if (t.trim()) messages.push({ role: "system", content: t });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    const c = m.content;
    if (m.role === "user") {
      if (typeof c === "string") {
        if (c) messages.push({ role: "user", content: c });
        continue;
      }
      if (!Array.isArray(c)) continue;
      const parts = [];
      for (const p of c) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
        else if (p.type === "image" && p.source && p.source.type === "base64") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${p.source.media_type || "image/png"};base64,${p.source.data}` },
          });
        } else if (p.type === "tool_result") {
          const out = typeof p.content === "string" ? p.content : Array.isArray(p.content)
            ? p.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n")
            : "";
          messages.push({ role: "tool", tool_call_id: p.tool_use_id, content: out || "(no output)" });
        }
      }
      if (parts.length) {
        if (parts.length === 1 && parts[0].type === "text") messages.push({ role: "user", content: parts[0].text });
        else messages.push({ role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      if (typeof c === "string") {
        if (c) messages.push({ role: "assistant", content: c });
        continue;
      }
      if (!Array.isArray(c)) continue;
      const texts = [];
      const calls = [];
      for (const p of c) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && typeof p.text === "string" && p.text) texts.push(p.text);
        else if (p.type === "tool_use") {
          calls.push({
            id: p.id || `call_${crypto.randomBytes(9).toString("base64url")}`,
            type: "function",
            function: { name: String(p.name || ""), arguments: JSON.stringify(p.input || {}) },
          });
        }
      }
      const msg = { role: "assistant" };
      if (texts.length) msg.content = texts.join("\n");
      if (calls.length) msg.tool_calls = calls;
      if (msg.content !== undefined || calls.length) messages.push(msg);
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "..." });

  const chat = { model: resolveModel(body.model), messages, stream: body.stream === true };
  if (typeof body.max_tokens === "number") chat.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools
      .filter((t) => t && typeof t.name === "string" && t.name.trim())
      .map((t) => ({
        type: "function",
        function: {
          name: t.name.trim(),
          ...(typeof t.description === "string" ? { description: t.description } : {}),
          parameters:
            t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
        },
      }));
  }
  const tc = body.tool_choice;
  if (tc === "auto" || tc === "any") chat.tool_choice = tc === "any" ? "auto" : tc;
  else if (tc && typeof tc === "object" && typeof tc.name === "string") {
    chat.tool_choice = { type: "function", function: { name: tc.name } };
  }
  return chat;
}

function stopReasonOf(openaiFinish) {
  if (openaiFinish === "tool_calls") return "tool_use";
  if (openaiFinish === "length") return "max_tokens";
  return "end_turn";
}

function msgId() {
  return `msg_${crypto.randomBytes(12).toString("hex")}`;
}

/* OpenAI chunk -> Anthropic SSE events, streaming. */
function makeAnthropicStreamer(requestedModel) {
  const id = msgId();
  let started = false;
  let blockIndex = -1;
  let blockType = null; // "text" | "tool_use"
  let toolSeen = new Map(); // openai index -> anthropic block index
  let finish = null;
  const enc = new TextEncoder();

  const ev = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ensureStarted = () => {
    if (started) return [];
    started = true;
    return [
      ev("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  };
  const openText = () => {
    const out = [];
    if (blockType === "text") return out;
    if (blockType === "tool_use") out.push(ev("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    blockIndex++;
    blockType = "text";
    out.push(
      ev("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "text", text: "" },
      })
    );
    return out;
  };

  /** Apply one OpenAI chat.completion.chunk; returns Anthropic SSE strings. */
  function apply(chunk) {
    const out = ensureStarted();
    if (!chunk || typeof chunk !== "object") return out;
    const ch = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = ch && ch.delta;
    if (delta && typeof delta.content === "string" && delta.content) {
      out.push(...openText());
      out.push(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: delta.content },
        })
      );
    }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = String(tc.index ?? 0);
        if (!toolSeen.has(key)) {
          if (blockType === "text" || blockType === "tool_use") {
            if (blockType === "tool_use") out.push(ev("content_block_stop", { type: "content_block_stop", index: blockIndex }));
            else if (blockType === "text") out.push(ev("content_block_stop", { type: "content_block_stop", index: blockIndex }));
          }
          blockIndex++;
          blockType = "tool_use";
          toolSeen.set(key, blockIndex);
          out.push(
            ev("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id || `toolu_${crypto.randomBytes(12).toString("hex")}`,
                name: tc.function?.name || "",
                input: {},
              },
            })
          );
        }
        const piece = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
        if (piece) {
          out.push(
            ev("content_block_delta", {
              type: "content_block_delta",
              index: toolSeen.get(key),
              delta: { type: "input_json_delta", partial_json: piece },
            })
          );
        }
      }
    }
    if (ch && typeof ch.finish_reason === "string" && ch.finish_reason) finish = ch.finish_reason;
    return out;
  }

  function finishEvents(usage) {
    const out = [];
    if (blockType) out.push(ev("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    if (!started) out.push(...ensureStarted());
    out.push(
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReasonOf(finish || "stop"), stop_sequence: null },
        usage: { output_tokens: usage?.completion_tokens || 0 },
      })
    );
    out.push(ev("message_stop", { type: "message_stop" }));
    return out;
  }

  return { apply, finishEvents, get finish() { return finish; } };
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
  for (;;) {
    attempt++;
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      if (!RETRYABLE_STATUS.has(r.status)) return r;
      const retryAfter = parseInt(r.headers.get("retry-after") || "0", 10) || 0;
      const backoff = Math.min(30000, baseDelay * 2 ** (attempt - 1));
      const delay = Math.min(30000, Math.max(retryAfter * 1000, backoff));
      if (Date.now() - started + delay > maxWait) return r;
      try {
        await r.body?.cancel();
      } catch {}
      console.warn(`[oc-proxy] upstream ${r.status} (retry-after ${retryAfter}s); retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    } catch (e) {
      const delay = Math.min(30000, baseDelay * 2 ** (attempt - 1));
      if (Date.now() - started + delay > maxWait) throw e;
      console.warn(`[oc-proxy] upstream error (${e.message}); retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ type: "error", error: { type: "invalid_request_error", message: "method not allowed" } });
  if (!checkAnthropicAuth(req)) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "invalid api key" } });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } });
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "empty body" } });
  }

  const requestedModel = String(body.model || "").trim() || defaultModel();
  const chat = anthropicToChat(body);
  const clientWantsStream = body.stream === true;

  let upBody, renameMap;
  try {
    const built = buildUpstreamBody(chat);
    upBody = built.body;
    renameMap = built.map;
  } catch (e) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: e.message } });
  }

  const headers = buildHeaders({
    sessionId: req.headers["x-opencode-session"] || newSessionId(),
    userAgent: req.headers["user-agent"],
  });

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl(chat.model), { headers, body: JSON.stringify(upBody) });
  } catch (e) {
    return res.status(502).json({ type: "error", error: { type: "api_error", message: `upstream unreachable: ${e.message}` } });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let msg = text.slice(0, 2000) || `upstream ${upstream.status}`;
    try {
      msg = JSON.parse(text)?.error?.message || msg;
    } catch {}
    return res.status(upstream.status >= 400 ? upstream.status : 502).json({
      type: "error",
      error: { type: "api_error", message: msg },
    });
  }

  const tr = makeTranslator(chat.model, renameMap);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const softMs = Math.max(0, parseInt(process.env.SOFT_DEADLINE_MS || "0", 10) || 0);
  const absMs = Math.max(0, parseInt(process.env.ABSOLUTE_DEADLINE_MS || "0", 10) || 0);
  const startedAt = Date.now();
  let firstBytesAt = 0;
  const expired = () => {
    const t = Date.now();
    if (absMs > 0 && t - startedAt > absMs) return true;
    return softMs > 0 && firstBytesAt > 0 && t - firstBytesAt > softMs;
  };

  async function drainToState() {
    let buf = "";
    for (;;) {
      if (expired()) {
        tr.markCutoff();
        try { reader.cancel(); } catch {}
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
        tr.apply(p.event, p.data);
      }
    }
  }

  if (!clientWantsStream) {
    try {
      await drainToState();
    } catch (e) {
      return res.status(502).json({ type: "error", error: { type: "api_error", message: e.message } });
    }
    const j = tr.finalJson();
    const msg = j.choices?.[0]?.message || {};
    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const tc of msg.tool_calls || []) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input });
    }
    return res.status(200).json({
      id: msgId(),
      type: "message",
      role: "assistant",
      model: requestedModel,
      content,
      stop_reason: stopReasonOf(j.choices?.[0]?.finish_reason || "stop"),
      stop_sequence: null,
      usage: {
        input_tokens: j.usage?.prompt_tokens || 0,
        output_tokens: j.usage?.completion_tokens || 0,
      },
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const enc = new TextEncoder();
  const st = makeAnthropicStreamer(requestedModel);
  try {
    let buf = "";
    for (;;) {
      if (expired()) {
        tr.markCutoff();
        try { reader.cancel(); } catch {}
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
        // Reuse OpenAI translator to normalize upstream events into chunks.
        const chunks = tr.apply(p.event, p.data);
        for (const s of chunks) {
          if (!s.startsWith("data: ")) continue;
          let c = null;
          try {
            c = JSON.parse(s.slice(6));
          } catch {}
          if (!c) continue;
          for (const bytes of st.apply(c)) res.write(bytes);
        }
      }
    }
    for (const bytes of st.finishEvents(tr.state.usage)) res.write(bytes);
    res.end();
  } catch (e) {
    try {
      res.write(enc.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } })}\n\n`));
      res.end();
    } catch {}
  } finally {
    try { reader.cancel(); } catch {}
  }
};
