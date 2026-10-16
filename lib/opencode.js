"use strict";

/* Shared opencode.ai free-tier proxy logic.
 * Ported from 9Router (open-sse/executors/opencode.js + utils/opencodeFingerprint.js),
 * trimmed to the opencode provider. Updated for the 2026-10-14 breaking change:
 * OpenCode v2 moved free inference off /zen/v1 onto /inference/v1 with a stricter
 * client fingerprint (PR #4842).
 *
 * Upstream contract (verified live 2026-10-16):
 * - muse-spark-*  -> POST {base}/inference/v1/responses   (OpenAI Responses SSE)
 * - other *-free  -> POST {base}/inference/v1/chat/completions (OpenAI Chat SSE)
 * - must carry OpenCode's own `read` + `shell` tools with EXACT description and
 *   parameters, plus a v2 UA and a session id whose prefix encodes a small
 *   counter; otherwise 403 FreeTierError ("can only be used from within OpenCode").
 * - `x-opencode-request` must be ABSENT (any value -> 403).
 */

const crypto = require("crypto");

const UPSTREAM_BASE = (process.env.UPSTREAM_BASE_URL || "https://opencode.ai").replace(/\/+$/, "");
// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
const CLIENT_UA = "opencode/latest/2.0.26/cli";
const CLIENT_NAME = "cli";

// Free tier: any model whose id ends in "-free". muse-spark is served by the
// Responses endpoint; every other free model uses Chat Completions.
function isResponsesModel(id) {
  const base = baseModel(id);
  const bare = base.includes("/") ? base.split("/").pop() : base;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(bare);
}
function isAllowedModel(id) {
  const b = baseModel(id).toLowerCase();
  return !!b && /-free$/i.test(b);
}

/* ---------- verbatim OpenCode v2.0.26 fingerprint tools ---------- */
// Upstream compares description and parameters exactly; do not reword.
const FP_DEFS = {
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};
const FP_NAMES = ["read", "shell"];

/* ---------- session / request ids ---------- */
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randB62(n) {
  const b = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += B62[b[i] % 62];
  return s;
}

// Session prefix = 12 hex of ~(timeMs*0x1000+counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403, so the counter
// must stay small (0-16 pass, >=100 fail).
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
let lastTs = 0;
let counter = 0;
function descendingTimeHex(time, c) {
  return (~(BigInt(time) * 0x1000n + BigInt(c)) & SESSION_PREFIX_MASK).toString(16).padStart(12, "0");
}
function newSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTs) {
    lastTs = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${randB62(14)}`;
}
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// Reuse a conforming incoming session (preserves upstream quota); otherwise
// derive a valid one deterministically so the counter stays small.
function resolveSession(incoming) {
  const s = String(incoming || "").trim();
  if (SESSION_RE.test(s)) return s;
  if (s) {
    const digest = crypto.createHash("sha256").update(`opencode\0${s}`).digest();
    const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & ((1n << 36n) - 1n);
    const timeHex = descendingTimeHex(time, 1);
    let rand = "";
    for (let i = 6; i < 20; i++) rand += B62[digest[i] % 62];
    return `ses_${timeHex}${rand}`;
  }
  return newSessionId();
}

/* ---------- model helpers ---------- */
/** Strip "oc/" alias prefix and "(max)" thinking suffix. */
function baseModel(id) {
  return String(id || "")
    .replace(/^oc\//i, "")
    .replace(/\([^()]+\)\s*$/i, "")
    .trim();
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && (p.type === "text" || p.type === "input_text" || p.type === "output_text") && p.text)
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

/** Normalize OpenAI/Responses tool defs -> a given shape. */
function normalizeTools(tools, flat) {
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
    const name2 = name.slice(0, 128);
    out.push(
      flat
        ? { type: "function", name: name2, ...(desc ? { description: desc } : {}), parameters: params }
        : { type: "function", function: { name: name2, ...(desc ? { description: desc } : {}), parameters: params } }
    );
  }
  return out;
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string" && fn.name.trim()) return fn.name.trim();
  return "";
}
function chatFunctionOf(tool) {
  const fn = tool && tool.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}
function isFingerprintDef(tool, key) {
  const def = chatFunctionOf(tool) || tool;
  const want = FP_DEFS[key];
  return !!def && def.description === want.description && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}
function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

// Move caller tools off the fingerprint names when their definition differs, so
// the exact fingerprint definitions can be appended without a duplicate name.
function concealFingerprintNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || !tools.length) return { tools, map };
  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }
    const key = FP_NAMES.includes(toolNameOf(tool)) ? toolNameOf(tool) : "";
    if (!key) {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) continue; // upstream rejects duplicate names; keep first
    seen.add(key);
    if (isFingerprintDef(tool, key)) {
      out.push(tool);
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

function appendFingerprintTools(tools, flat) {
  const appended = [];
  for (const name of FP_NAMES) {
    if (tools.some((t) => toolNameOf(t) === name)) continue;
    const { description, parameters } = FP_DEFS[name];
    tools.push(
      flat
        ? { type: "function", name, description, parameters, strict: false }
        : { type: "function", function: { name, description, parameters } }
    );
    appended.push(name);
  }
  return appended;
}

function retargetToolChoice(body, map) {
  if (!body || !map.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = new Map([...map].map(([alias, orig]) => [orig, alias]));
  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

function aliasHistoryToolCalls(body, map) {
  if (!body || !map.size) return;
  const aliases = new Map([...map].map(([alias, orig]) => [orig, alias]));
  if (Array.isArray(body.input)) {
    body.input = body.input.map((it) =>
      it && it.type === "function_call" && aliases.has(it.name) ? { ...it, name: aliases.get(it.name) } : it
    );
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((m) => {
      if (!Array.isArray(m?.tool_calls)) return m;
      return {
        ...m,
        tool_calls: m.tool_calls.map((c) =>
          c && c.function && aliases.has(c.function.name)
            ? { ...c, function: { ...c.function, name: aliases.get(c.function.name) } }
            : c
        ),
      };
    });
  }
}

// Tell the model the appended fingerprint tools are placeholders (upstream does
// not gate on prompt text; without this the model actually calls them).
function noteUnavailable(body, flat, names) {
  const list = names.map((n) => `\`${n}\``).join(" or ");
  const note =
    names.length > 1
      ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
      : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim() ? `${body.instructions}\n\n${note}` : note;
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/** Full fingerprint pass: alias conflicting caller tools, append read/shell,
 * retarget tool_choice, alias history, note placeholders. Returns rename map. */
function applyFingerprint(body, flat) {
  if (!body || typeof body !== "object") return new Map();
  const { tools, map } = concealFingerprintNames(body.tools);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailable(body, flat, appended);
  // Responses: never default tool_choice to "none" (upstream 403s it).
  if (!body.tool_choice && flat) body.tool_choice = "auto";
  return map;
}

// Zen reasoning models reject multi-turn history whose assistant messages carry
// no reasoning_content; inject a placeholder (9router reasoningInject scope=all).
function injectReasoning(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  body.messages = body.messages.map((m) =>
    m && m.role === "assistant" && !(typeof m.reasoning_content === "string" && m.reasoning_content)
      ? { ...m, reasoning_content: " " }
      : m
  );
  return body;
}

/** Build upstream body. Returns { body, map } (map: sent tool name -> original). */
function buildUpstreamBody(chatBody) {
  const model = baseModel(chatBody.model);
  if (isResponsesModel(model)) {
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
    if (body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) && !body.reasoning.summary) {
      body.reasoning = { ...body.reasoning, summary: "auto" };
    }
    body.tools = normalizeTools(chatBody.tools, true);
    if (chatBody.tool_choice !== undefined) body.tool_choice = chatBody.tool_choice;
    dropInvalidObjectChoice(body);
    if ("tool_choice" in body && body.tool_choice !== "auto") body.tool_choice = "auto";
    const map = applyFingerprint(body, true);
    return { body, map };
  }

  // Chat lane: pass messages through in OpenAI shape.
  const body = { model, stream: true };
  body.messages = Array.isArray(chatBody.messages) ? chatBody.messages.slice() : [];
  for (const k of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "tool_choice"]) {
    if (chatBody[k] !== undefined) body[k] = chatBody[k];
  }
  body.tools = normalizeTools(chatBody.tools, false);
  dropInvalidObjectChoice(body);
  if ("tool_choice" in body && body.tool_choice !== "auto") body.tool_choice = "auto";
  const map = applyFingerprint(body, false);
  injectReasoning(body);
  return { body, map };
}

function dropInvalidObjectChoice(body) {
  if (!body.tool_choice || typeof body.tool_choice !== "object" || Array.isArray(body.tool_choice)) return;
  if (body.tool_choice.type !== "function") return;
  const names = new Set((body.tools || []).map(toolNameOf));
  const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
  if (!n || !names.has(n)) delete body.tool_choice;
}

function buildHeaders({ sessionId, userAgent } = {}) {
  const s = resolveSession(sessionId);
  const m = String(userAgent || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  const ua = m && parseInt(m[1], 10) >= 2 ? userAgent : CLIENT_UA;
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer public",
    "User-Agent": ua,
    "x-opencode-client": CLIENT_NAME,
    "x-opencode-session": s,
    "x-opencode-session-id": s,
    "x-session-affinity": s,
    "x-session-id": s,
    "x-opencode-project": "global",
    Accept: "text/event-stream",
  };
}

function upstreamUrl(model) {
  return `${UPSTREAM_BASE}/inference/v1/${isResponsesModel(model) ? "responses" : "chat/completions"}`;
}

/* ---------- SSE framing ---------- */
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

/* ---------- shared translator scaffold ---------- */
function makeState(openaiModel) {
  return { text: "", tools: new Map(), order: [], usage: null, respModel: openaiModel, cutoff: false, toolsDone: false, upstreamFinish: null };
}
function toolSlot(state, key) {
  if (!state.tools.has(key)) {
    const slot = { key, index: state.order.length, id: null, name: null, args: "", sent: 0, nameEmitted: false };
    state.tools.set(key, slot);
    state.order.push(key);
  }
  return state.tools.get(key);
}
function restoreName(map, name) {
  if (map && map.size && typeof name === "string" && map.has(name)) return map.get(name);
  return name;
}
function finishReasonFor(state) {
  if (state.cutoff && !state.toolsDone) return "length";
  if (state.upstreamFinish) return state.upstreamFinish;
  return state.order.length ? "tool_calls" : "stop";
}
function mkChunk(state, id, created, delta, finish, extra) {
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
function usageOf(u) {
  return {
    prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0),
  };
}
function finalJsonOf(state, id, created) {
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
    choices: [{ index: 0, message, finish_reason: finishReasonFor(state) }],
    usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/* ---------- Responses lane translator (muse-spark) ---------- */
function createTranslator(openaiModel, renameMap) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randB62(12)}${Date.now().toString(36)}`;
  const state = makeState(openaiModel);

  function toolChunk(s, piece) {
    const fn = {};
    if (s.name && !s.nameEmitted) {
      fn.name = restoreName(renameMap, s.name);
      s.nameEmitted = true;
    }
    if (piece) fn.arguments = piece;
    const tc = { index: s.index, type: "function", function: fn };
    if (s.id && (!s.idEmitted || fn.name)) {
      tc.id = s.id;
      s.idEmitted = true;
    }
    return mkChunk(state, id, created, { tool_calls: [tc] }, null);
  }

  function apply(type, d) {
    const out = [];
    if (!d || typeof d !== "object") return out;
    if (type === "response.created" && d.response) {
      if (d.response.model) state.respModel = d.response.model;
      out.push(mkChunk(state, id, created, { role: "assistant" }, null));
    } else if (type === "response.output_item.added" && d.item) {
      const it = d.item;
      if (it.type === "function_call") {
        const s = toolSlot(state, String(d.output_index ?? it.call_id ?? it.id ?? state.order.length));
        if (it.call_id || it.id) s.id = it.call_id || it.id;
        if (it.name) s.name = it.name;
        if (it.arguments && !s.args) s.args = typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments);
      }
    } else if (type === "response.function_call_arguments.delta") {
      const s = toolSlot(state, String(d.output_index ?? d.item_id ?? state.order.length));
      if (d.item_id && !s.id) s.id = d.item_id;
      const piece = typeof d.delta === "string" ? d.delta : "";
      s.args += piece;
      s.sent += piece.length;
      out.push(toolChunk(s, piece));
    } else if (type === "response.output_text.delta") {
      const piece = typeof d.delta === "string" ? d.delta : "";
      state.text += piece;
      out.push(mkChunk(state, id, created, { content: piece }, null));
    } else if (type === "response.output_item.done" && d.item) {
      const it = d.item;
      if (it.type === "function_call") {
        const s = toolSlot(state, String(d.output_index ?? it.call_id ?? it.id ?? state.order.length));
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
          out.push(mkChunk(state, id, created, { content: t }, null));
        }
      }
    } else if (type === "response.output_text.done" && typeof d.text === "string") {
      if (!state.text) {
        state.text = d.text;
        out.push(mkChunk(state, id, created, { content: d.text }, null));
      }
    } else if ((type === "response.completed" || type === "response.incomplete") && d.response?.usage) {
      state.usage = usageOf(d.response.usage);
      if (d.response.model) state.respModel = d.response.model;
    } else if (type === "response.failed" || type === "error") {
      const msg = d.error?.message || d.message || "upstream error";
      throw new Error(`upstream: ${msg}`);
    }
    return out;
  }

  return {
    state,
    apply,
    markCutoff: () => (state.cutoff = true),
    finish: () => finishReasonFor(state),
    finalChunk: () => mkChunk(state, id, created, {}, finishReasonFor(state), state.usage ? { usage: state.usage } : null),
    finalJson: () => finalJsonOf(state, id, created),
  };
}

/* ---------- Chat lane relay (other free models): upstream is already OpenAI ---------- */
function createChatRelay(openaiModel, renameMap) {
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-${randB62(12)}${Date.now().toString(36)}`;
  const state = makeState(openaiModel);

  function apply(type, d) {
    const out = [];
    if (!d || typeof d !== "object") return out;
    if (typeof d.id === "string" && d.id) id = d.id;
    if (d.model) state.respModel = d.model;
    const ch = Array.isArray(d.choices) ? d.choices[0] : null;
    const delta = ch && ch.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) state.text += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const s = toolSlot(state, String(tc.index ?? state.order.length));
          if (tc.id) s.id = tc.id;
          if (tc.function?.name) {
            s.name = tc.function.name;
            s.nameEmitted = true;
          }
          if (typeof tc.function?.arguments === "string") s.args += tc.function.arguments;
        }
      }
    }
    if (ch && typeof ch.finish_reason === "string" && ch.finish_reason) {
      state.upstreamFinish = ch.finish_reason;
      state.toolsDone = true;
    }
    if (d.usage) state.usage = usageOf(d.usage);

    // Relay the chunk, but strip finish_reason (we emit our own final) and
    // restore any aliased tool names so the client sees its own tool.
    const relay = { ...d };
    if (Array.isArray(relay.choices)) {
      relay.choices = relay.choices.map((c) => {
        const next = { ...c, finish_reason: null };
        if (c.delta && Array.isArray(c.delta.tool_calls)) {
          next.delta = {
            ...c.delta,
            tool_calls: c.delta.tool_calls.map((tc) =>
              tc.function && tc.function.name
                ? { ...tc, function: { ...tc.function, name: restoreName(renameMap, tc.function.name) } }
                : tc
            ),
          };
        }
        return next;
      });
    }
    out.push(`data: ${JSON.stringify(relay)}\n\n`);
    return out;
  }

  return {
    state,
    apply,
    markCutoff: () => (state.cutoff = true),
    finish: () => finishReasonFor(state),
    finalChunk: () => mkChunk(state, id, created, {}, finishReasonFor(state), state.usage ? { usage: state.usage } : null),
    finalJson: () => finalJsonOf(state, id, created),
  };
}

function makeTranslator(model, renameMap) {
  return isResponsesModel(model) ? createTranslator(model, renameMap) : createChatRelay(model, renameMap);
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
  FP_DEFS,
  baseModel,
  isAllowedModel,
  isResponsesModel,
  messagesToInput,
  normalizeTools,
  applyFingerprint,
  buildUpstreamBody,
  buildHeaders,
  upstreamUrl,
  newSessionId,
  resolveSession,
  splitFrames,
  parseFrame,
  createTranslator,
  createChatRelay,
  makeTranslator,
  checkAuth,
  cors,
};
