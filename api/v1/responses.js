"use strict";

/* POST /v1/responses — Responses API facade for Codex CLI.
 * Codex 0.166+ requires wire_api="responses"; free OpenCode models only speak
 * Chat Completions upstream, so requests are bridged to the chat lane and the
 * resulting chat stream is translated back into Responses SSE events.
 */
const crypto = require("crypto");
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
  summarizeBody,
} = require("../../lib/opencode");
const stats = require("../../lib/stats");
const { fetchUpstream, forwardUpstreamError } = require("./chat/completions");

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      if (typeof req.body === "string") {
        try {
          resolve(JSON.parse(req.body || "{}"));
        } catch {
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

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

function inputToMessages(body) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message" || (!item.type && item.role)) {
      const text = textOfContent(item.content);
      if (!text) continue;
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: text });
    } else if (item.type === "function_call") {
      const call = {
        id: item.call_id || item.id || `call_${crypto.randomBytes(9).toString("base64url")}`,
        type: "function",
        function: { name: String(item.name || ""), arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
        last.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: "", tool_calls: [call] });
      }
    } else if (item.type === "function_call_output") {
      const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id || item.id, content: out || "(no output)" });
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "..." });
  return messages;
}

function toolsToChat(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "function") continue;
    if (typeof tool.name !== "string" || !tool.name.trim()) continue;
    out.push({
      type: "function",
      function: {
        name: tool.name.trim(),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters:
          tool.parameters && typeof tool.parameters === "object"
            ? tool.parameters
            : { type: "object", properties: {} },
      },
    });
  }
  return out;
}

function createResponsesTranslator(model, renameMap) {
  const responseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const items = [];
  const toolSlots = new Map();
  let seq = 0;
  let started = false;
  let messageItem = null;
  let text = "";
  let usage = null;
  let finishReason = null;
  let completed = false;

  const restore = (name) => (renameMap && renameMap.has(name) ? renameMap.get(name) : name);
  const emit = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++seq, ...data })}\n\n`;

  const responseObj = (status, output) => {
    const u = usage || {};
    const inputTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
    const outputTokens = u.completion_tokens ?? u.output_tokens ?? 0;
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model,
      output,
      parallel_tool_calls: true,
      tool_choice: "auto",
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: u.total_tokens ?? inputTokens + outputTokens,
      },
    };
  };

  const ensureStarted = () => {
    if (started) return [];
    started = true;
    return [
      emit("response.created", { response: responseObj("in_progress", []) }),
      emit("response.in_progress", { response: responseObj("in_progress", []) }),
    ];
  };

  const ensureMessage = () => {
    if (messageItem) return [];
    const out = ensureStarted();
    const index = items.length;
    messageItem = { id: `msg_${crypto.randomBytes(12).toString("hex")}`, index, done: false };
    items.push({ kind: "message", ...messageItem });
    out.push(
      emit("response.output_item.added", {
        output_index: index,
        item: { type: "message", id: messageItem.id, status: "in_progress", role: "assistant", content: [] },
      })
    );
    out.push(
      emit("response.content_part.added", {
        item_id: messageItem.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      })
    );
    return out;
  };

  const ensureTool = (key, tc) => {
    if (toolSlots.has(key)) return { out: [], slot: toolSlots.get(key) };
    const out = ensureStarted();
    const index = items.length;
    const slot = {
      id: `fc_${crypto.randomBytes(12).toString("hex")}`,
      callId: tc.id || `call_${crypto.randomBytes(9).toString("base64url")}`,
      rawName: tc.function?.name || "",
      name: restore(tc.function?.name || ""),
      args: "",
      index,
      done: false,
    };
    toolSlots.set(key, slot);
    slot.kind = "function_call";
    items.push(slot);
    out.push(
      emit("response.output_item.added", {
        output_index: index,
        item: {
          type: "function_call",
          id: slot.id,
          call_id: slot.callId,
          name: slot.name,
          arguments: "",
          status: "in_progress",
        },
      })
    );
    return { out, slot };
  };

  function applyChunk(chunk) {
    const out = [];
    if (!chunk || typeof chunk !== "object") return out;
    if (Array.isArray(chunk.choices) && chunk.choices.length) {
      const choice = chunk.choices[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        out.push(...ensureMessage());
        text += delta.content;
        out.push(
          emit("response.output_text.delta", {
            item_id: messageItem.id,
            output_index: messageItem.index,
            content_index: 0,
            delta: delta.content,
          })
        );
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = String(tc.index ?? toolSlots.size);
        const ensured = ensureTool(key, tc);
        out.push(...ensured.out);
        const slot = ensured.slot;
        if (tc.function?.name) {
          slot.rawName = tc.function.name;
          slot.name = restore(tc.function.name);
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
          slot.args += tc.function.arguments;
          out.push(
            emit("response.function_call_arguments.delta", {
              item_id: slot.id,
              output_index: slot.index,
              delta: tc.function.arguments,
            })
          );
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.usage) usage = chunk.usage;
    return out;
  }

  function finish() {
    if (completed) return [];
    completed = true;
    const out = [];
    if (!started) out.push(...ensureStarted());
    for (const item of items) {
      if (item.kind === "message" && !item.done) {
        item.done = true;
        out.push(
          emit("response.output_text.done", {
            item_id: item.id,
            output_index: item.index,
            content_index: 0,
            text,
          })
        );
        out.push(
          emit("response.content_part.done", {
            item_id: item.id,
            output_index: item.index,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          })
        );
        out.push(
          emit("response.output_item.done", {
            output_index: item.index,
            item: {
              type: "message",
              id: item.id,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          })
        );
      } else if (item.kind === "function_call" && !item.done) {
        item.done = true;
        out.push(
          emit("response.function_call_arguments.done", {
            item_id: item.id,
            output_index: item.index,
            name: item.name,
            arguments: item.args,
          })
        );
        out.push(
          emit("response.output_item.done", {
            output_index: item.index,
            item: {
              type: "function_call",
              id: item.id,
              call_id: item.callId,
              name: item.name,
              arguments: item.args,
              status: "completed",
            },
          })
        );
      }
    }
    const output = items.map((item) => {
      if (item.kind === "message") {
        return {
          type: "message",
          id: item.id,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        };
      }
      return {
        type: "function_call",
        id: item.id,
        call_id: item.callId,
        name: item.name,
        arguments: item.args,
        status: "completed",
      };
    });
    const status = finishReason === "length" ? "incomplete" : "completed";
    out.push(emit("response.completed", { response: responseObj(status, output) }));
    return out;
  }

  return { applyChunk, finish, getUsage: () => usage, getFinish: () => finishReason, getText: () => text };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "method not allowed" } });
  if (!checkAuth(req)) return res.status(401).json({ error: { message: "invalid api key" } });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return res.status(e.status || 400).json({ error: { message: e.message } });
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: { message: "empty body" } });
  if (!body.model || !isAllowedModel(body.model)) {
    return res.status(400).json({ error: { message: `unsupported model '${body.model}'` } });
  }

  const chatBody = {
    model: body.model,
    messages: inputToMessages(body),
    tools: toolsToChat(body.tools),
    stream: true,
  };
  for (const k of ["temperature", "top_p", "tool_choice"]) {
    if (body[k] !== undefined) chatBody[k] = body[k];
  }
  if (typeof body.max_output_tokens === "number") chatBody.max_tokens = body.max_output_tokens;
  else if (typeof body.max_tokens === "number") chatBody.max_tokens = body.max_tokens;

  const displayModel = String(body.model);
  const t0 = Date.now();
  let upBody;
  let renameMap;
  try {
    const built = buildUpstreamBody(chatBody);
    upBody = built.body;
    renameMap = built.map;
  } catch (e) {
    req.log?.write(`[handler] buildUpstreamBody failed: ${e.message}`);
    return res.status(400).json({ error: { message: e.message } });
  }

  if (req.log) {
    req.log.write("=== UPSTREAM REQUEST META ===");
    req.log.write(JSON.stringify(summarizeBody(upBody)));
    const full = JSON.stringify(upBody);
    req.log.write("=== UPSTREAM REQUEST BODY ===");
    req.log.raw(full.slice(0, 4 * 1024 * 1024) + (full.length > 4 * 1024 * 1024 ? "\n[truncated]\n" : "\n"));
  }

  const makeHeaders = () => buildHeaders({ sessionId: newSessionId(), userAgent: req.headers["user-agent"] });
  const headers = buildHeaders({
    sessionId: req.headers["x-opencode-session"] || newSessionId(),
    userAgent: req.headers["user-agent"],
  });

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl(displayModel), {
      headers,
      refreshHeaders: makeHeaders,
      body: JSON.stringify(upBody),
      signal: req.signal,
      log: req.log,
    });
  } catch (e) {
    req.log?.write(`[handler] upstream unreachable: ${e.message}`);
    stats.record({ m: displayModel, ok: false, st: 502, ms: Date.now() - t0, fin: "error" });
    return res.status(502).json({ error: { message: `upstream unreachable: ${e.message}` } });
  }
  if (!upstream.ok || !upstream.body) {
    const err = await forwardUpstreamError(upstream);
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    req.log?.write(`[client] returning upstream error status=${err.status} retry-after=${retryAfter || "0"}s`);
    stats.record({ m: displayModel, ok: false, st: err.status, ms: Date.now() - t0, fin: "error" });
    return res.status(err.status).json(err.body);
  }

  const tr = createResponsesTranslator(displayModel, renameMap);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const enc = new TextEncoder();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    req.log?.write("=== UPSTREAM RESPONSE (RAW SSE) ===");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      req.log?.raw(chunkText);
      buf += chunkText;
      const { frames, rest } = splitFrames(buf);
      buf = rest;
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (!parsed || parsed.event === "done") continue;
        for (const s of tr.applyChunk(parsed.data)) res.write(enc.encode(s));
      }
    }
    const tail = decoder.decode();
    if (tail) {
      const { frames } = splitFrames(tail);
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (!parsed || parsed.event === "done") continue;
        for (const s of tr.applyChunk(parsed.data)) res.write(enc.encode(s));
      }
    }
    for (const s of tr.finish()) res.write(enc.encode(s));
    res.end();
    stats.record({
      m: displayModel,
      ok: true,
      st: 200,
      p: tr.getUsage()?.prompt_tokens || stats.est(upBody),
      c: tr.getUsage()?.completion_tokens || stats.est(tr.getText()),
      ms: Date.now() - t0,
      fin: tr.getFinish(),
    });
  } catch (e) {
    stats.record({ m: displayModel, ok: false, st: 200, ms: Date.now() - t0, fin: "error" });
    try {
      res.write(enc.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: e.message } })}\n\n`));
      res.end();
    } catch {}
  } finally {
    try {
      reader.cancel();
    } catch {}
  }
};
