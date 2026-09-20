"use strict";

/* Shared opencode.ai zen proxy logic.
 * Ported from 9Router PR #4165 behavior (open-sse/executors/opencode.js +
 * open-sse/providers/registry/opencode.js), trimmed to the opencode provider.
 *
 * Upstream contract (verified live):
 * - POST {base}/zen/v1/responses for muse-spark-*-free
 * - every Responses request must carry BOTH `bash` + `read` function tools
 *   AND tool_choice "auto", otherwise 403 FreeTierError
 *   ("can only be used from within OpenCode")
 */

const crypto = require("crypto");

const UPSTREAM_BASE = (process.env.UPSTREAM_BASE_URL || "https://opencode.ai").replace(/\/+$/, "");
const CLIENT_UA = "opencode/1.18.31";

// Upstream (zen) model ids. Gateway also accepts the `oc/` alias prefix.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const FORCE_AUTO_TOOL_CHOICE = new Set([...RESPONSES_MODELS]);

// Decoy tools, Responses shape. Same copy as 9Router bundle (u/v arrays).
const DECOYS = [
  {
    type: "function",
    name: "bash",
    description: "This tool is currently unavailable and must not be used.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "read",
    description: "This tool is currently unavailable and must not be used.",
    parameters: { type: "object", properties: {} },
  },
];

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randB62(n) {
  const b = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += B62[b[i] % 62];
  return s;
}
function newSessionId() {
  return `ses_${crypto.randomBytes(6).toString("hex")}${randB62(14)}`;
}
function newRequestId() {
  return `msg_${crypto.randomBytes(6).toString("hex")}${randB62(14)}`;
}

/** Strip 9Router "(max)" suffix / alias prefix, e.g. "oc/muse-spark-1.3-contributor-free" -> bare id. */
function baseModel(id) {
  return String(id || "")
    .replace(/^oc\//i, "")
    .replace(/\(max\)\s*$/i, "")
    .trim();
}
function isAllowedModel(id) {
  return RESPONSES_MODELS.has(baseModel(id));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && (p.type === "text" || p.type === "input_text") && p.text)
      .map((p) => p.text)
      .join("");
  return "";
}

/** Map OpenAI chat messages -> Responses `input` items. */
function messagesToInput(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t) out.push({ type: "message", role: m.role, content: [{ type: "input_text", text: t }] });
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content) out.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts = [];
        for (const p of m.content) {
          if (!p || typeof p !== "object") continue;
          if ((p.type === "text" || p.type === "input_text") && p.text) parts.push({ type: "input_text", text: p.text });
          else if (p.type === "image_url" && (p.image_url?.url || p.image_url)) {
            const u = typeof p.image_url === "string" ? p.image_url : p.image_url.url || p.image_url;
            parts.push({ type: "input_image", image_url: u });
          }
        }
        if (parts.length) out.push({ type: "message", role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        if (!fn.name) continue;
        out.push({
          type: "function_call",
          name: fn.name,
          call_id: tc.id || `call_${randB62(12)}`,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
    } else if (m.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: m.tool_call_id || m.call_id || `call_${randB62(12)}`,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
    }
  }
  return out;
}

/** Normalize OpenAI/Responses tool defs -> Responses shape. */
function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const fn = t.function && typeof t.function === "object" && !Array.isArray(t.function) ? t.function : null;
    const name =
      (typeof t.name === "string" && t.name.trim() ? t.name.trim() : "") ||
      (fn && typeof fn.name === "string" ? fn.name.trim() : "");
    if (!name) continue;
    const desc =
      (typeof t.description === "string" && t.description ? t.description : "") ||
      (fn && typeof fn.description === "string" ? fn.description : "");
    let params =
      t.parameters && typeof t.parameters === "object" && !Array.isArray(t.parameters)
        ? t.parameters
        : fn && fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} };
    if (params.type !== "object" || !params.properties) params = { ...params, type: "object", properties: params.properties || {} };
    out.push({ type: "function", name: name.slice(0, 128), ...(desc ? { description: desc } : {}), parameters: params });
  }
  return out;
}

/** PR #4165 core: cloak decoys on EVERY Responses request + default auto. */
function cloak(body) {
  if (!Array.isArray(body.tools)) body.tools = [];
  const have = new Set(body.tools.map((t) => t && (t.name || t.function?.name)).filter(Boolean));
  for (const d of DECOYS) {
    if (!have.has(d.name)) body.tools.push({ ...d, parameters: { ...d.parameters, properties: {} } });
  }
  if (!body.tool_choice) body.tool_choice = "auto";
  return body;
}

/** Upstream rejects non-auto tool_choice with 400 on these models. */
function forceAuto(model, body) {
  if ("tool_choice" in body && body.tool_choice !== "auto" && FORCE_AUTO_TOOL_CHOICE.has(baseModel(model))) {
    body.tool_choice = "auto";
  }
  return body;
}

/** Build upstream Responses body from an OpenAI chat.completions body. */
function buildUpstreamBody(chatBody) {
  const model = baseModel(chatBody.model);
  const body = { model, stream: true, store: false };

  let input = Array.isArray(chatBody.input) ? chatBody.input : messagesToInput(chatBody.messages);
  if (!input.length) input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
  body.input = input;

  if (chatBody.max_output_tokens !== undefined) body.max_output_tokens = chatBody.max_output_tokens;
  else if (chatBody.max_completion_tokens !== undefined) body.max_output_tokens = chatBody.max_completion_tokens;
  else if (chatBody.max_tokens !== undefined) body.max_output_tokens = chatBody.max_tokens;

  for (const k of ["temperature", "top_p", "reasoning", "reasoning_effort"]) {
    if (chatBody[k] !== undefined) body[k] = chatBody[k];
  }

  const tools = normalizeTools(chatBody.tools);
  body.tools = tools;

  if (chatBody.tool_choice !== undefined) body.tool_choice = chatBody.tool_choice;
  const names = new Set(tools.map((t) => t.name));
  if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    !Array.isArray(body.tool_choice) &&
    body.tool_choice.type === "function"
  ) {
    const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
    if (!n || !names.has(n)) delete body.tool_choice;
  }

  forceAuto(model, body);
  cloak(body);
  return body;
}

function buildHeaders({ sessionId, requestId, userAgent } = {}) {
  let ua = CLIENT_UA;
  const m = String(userAgent || "").match(/opencode\/(\d+)\.(\d+)/i);
  if (m && (parseInt(m[1], 10) > 1 || (parseInt(m[1], 10) === 1 && parseInt(m[2], 10) >= 17))) ua = userAgent;
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer public",
    "User-Agent": ua,
    "x-opencode-client": "desktop",
    "x-opencode-session": sessionId || newSessionId(),
    "x-opencode-request": requestId || newRequestId(),
    "x-opencode-project": "global",
    Accept: "text/event-stream",
  };
}

function upstreamUrl() {
  return `${UPSTREAM_BASE}/zen/v1/responses`;
}

/* ---------- Responses SSE -> OpenAI chat chunks ---------- */

function splitFrames(buffer) {
  const frames = [];
  let start = 0;
  while (true) {
    const i = buffer.indexOf("\n\n", start);
    if (i === -1) break;
    frames.push(buffer.slice(start, i));
    start = i + 2;
  }
  return { frames, rest: buffer.slice(start) };
}

function parseFrame(raw) {
  let event = null;
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.trim() === "") continue;
  }
  if (!dataLines.length) return null;
  const dataRaw = dataLines.join("\n");
  if (dataRaw === "[DONE]") return { event: "done", data: null };
  try {
    return { event, data: JSON.parse(dataRaw) };
  } catch {
    return null;
  }
}

function createTranslator(openaiModel) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randB62(12)}${Date.now().toString(36)}`;
  const state = { text: "", tools: new Map(), order: [], usage: null, respModel: openaiModel, cutoff: false, toolsDone: false };

  function toolSlot(key) {
    if (!state.tools.has(key)) {
      const slot = { key, index: state.order.length, id: null, name: null, args: "", sent: 0, nameEmitted: false };
      state.tools.set(key, slot);
      state.order.push(key);
    }
    return state.tools.get(key);
  }

  // Emit one tool_calls delta chunk for new argument piece and/or newly known name.
  function toolChunk(s, piece) {
    const fn = {};
    if (s.name && !s.nameEmitted) {
      fn.name = s.name;
      s.nameEmitted = true;
    }
    if (piece) fn.arguments = piece;
    const tc = { index: s.index, type: "function", function: fn };
    if (s.id && (!s.idEmitted || fn.name)) {
      tc.id = s.id;
      s.idEmitted = true;
    }
    return chunk({ tool_calls: [tc] });
  }

  function chunk(delta, finish = null, extra = null) {
    const c = {
      id,
      object: "chat.completion.chunk",
      created,
      model: state.respModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (extra) Object.assign(c, extra);
    return `data: ${JSON.stringify(c)}\n\n`;
  }

  // Returns array of OpenAI SSE strings for one upstream event. Mutates state.
  function apply(type, d) {
    const out = [];
    if (!d || typeof d !== "object") return out;
    if (type === "response.created" && d.response) {
      if (d.response.model) state.respModel = d.response.model;
      out.push(chunk({ role: "assistant" }));
    } else if (type === "response.output_item.added" && d.item) {
      const it = d.item;
      if (it.type === "function_call") {
        const key = String(d.output_index ?? it.call_id ?? it.id ?? state.order.length);
        const s = toolSlot(key);
        if (it.call_id || it.id) s.id = it.call_id || it.id;
        if (it.name) s.name = it.name;
        if (it.arguments && !s.args) s.args = typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments);
      }
    } else if (type === "response.function_call_arguments.delta") {
      const key = String(d.output_index ?? d.item_id ?? state.order.length);
      const s = toolSlot(key);
      if (d.item_id && !s.id) s.id = d.item_id;
      const piece = typeof d.delta === "string" ? d.delta : "";
      s.args += piece;
      s.sent += piece.length;
      out.push(toolChunk(s, piece));
    } else if (type === "response.output_text.delta") {
      const piece = typeof d.delta === "string" ? d.delta : "";
      state.text += piece;
      out.push(chunk({ content: piece }));
    } else if (type === "response.output_item.done" && d.item) {
      const it = d.item;
      if (it.type === "function_call") {
        const key = String(d.output_index ?? it.call_id ?? it.id ?? state.order.length);
        const s = toolSlot(key);
        if (it.call_id || it.id) s.id = it.call_id || it.id;
        if (it.name) s.name = it.name;
        s.done = true;
        state.toolsDone = true;
        const full = typeof it.arguments === "string" ? it.arguments : it.arguments ? JSON.stringify(it.arguments) : "";
        if (full && full.length >= s.args.length) {
          const rest = full.slice(s.sent);
          s.args = full;
          s.sent = full.length;
          if ((!s.nameEmitted && s.name) || rest) out.push(toolChunk(s, rest));
        } else if (s.name && !s.nameEmitted) {
          out.push(toolChunk(s, ""));
        }
      } else if (it.type === "message" && !state.text) {
        const t = Array.isArray(it.content)
          ? it.content.filter((p) => p.type === "output_text" && p.text).map((p) => p.text).join("")
          : "";
        if (t) {
          state.text = t;
          out.push(chunk({ content: t }));
        }
      }
    } else if (type === "response.output_text.done" && typeof d.text === "string") {
      if (!state.text) {
        state.text = d.text;
        out.push(chunk({ content: d.text }));
      }
    } else if ((type === "response.completed" || type === "response.incomplete") && d.response?.usage) {
      const u = d.response.usage;
      state.usage = {
        prompt_tokens: u.input_tokens ?? 0,
        completion_tokens: u.output_tokens ?? 0,
        total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      };
      if (d.response.model) state.respModel = d.response.model;
    } else if (type === "response.failed" || type === "error") {
      const msg = d.error?.message || d.message || "upstream error";
      throw new Error(`upstream: ${msg}`);
    }
    return out;
  }

  function finishReason() {
    const tools = state.order.map((k) => state.tools.get(k));
    if (state.cutoff && !state.toolsDone) return "length";
    return tools.length ? "tool_calls" : "stop";
  }

  function finalChunk() {
    const extra = state.usage ? { usage: state.usage } : null;
    return chunk({}, finishReason(), extra);
  }

  function finalJson() {
    const tools = state.order.map((k) => state.tools.get(k));
    const message = { role: "assistant", content: state.text };
    if (tools.length) {
      message.tool_calls = tools.map((s) => ({
        id: s.id || `call_${randB62(12)}`,
        type: "function",
        function: { name: s.name || "", arguments: s.args },
      }));
    }
    return {
      id,
      object: "chat.completion",
      created,
      model: state.respModel,
      choices: [{ index: 0, message, finish_reason: finishReason() }],
      usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  function markCutoff() {
    state.cutoff = true;
  }

  return { state, apply, finalChunk, finalJson, markCutoff };
}

/* ---------- gateway helpers ---------- */

function checkAuth(req) {
  const need = (process.env.GATEWAY_API_KEY || "").trim();
  if (!need) return true;
  const got = String(req.headers.authorization || req.headers.Authorization || "");
  const keys = need.split(",").map((s) => s.trim()).filter(Boolean);
  return keys.some((k) => got === `Bearer ${k}`);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

module.exports = {
  UPSTREAM_BASE,
  RESPONSES_MODELS,
  DECOYS,
  baseModel,
  isAllowedModel,
  messagesToInput,
  normalizeTools,
  cloak,
  forceAuto,
  buildUpstreamBody,
  buildHeaders,
  upstreamUrl,
  newSessionId,
  newRequestId,
  splitFrames,
  parseFrame,
  createTranslator,
  checkAuth,
  cors,
};
