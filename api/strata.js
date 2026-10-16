"use strict";

/* GET /api/strata — live Strata engine monitor (trimmed, no hardware fields).
 * Upstream is Strata's own `metrics` endpoint (the same one its #monitor page
 * polls every second). Only request-centric stats are exposed; all
 * gpu/ram/cpu/vram/pcie/temperature/power data is dropped on purpose.
 * Configure with STRATA_URL (must stay reachable publicly).
 */

const { cors } = require("../lib/opencode");

const BASE = (process.env.STRATA_URL || "https://081a-166-19-116-234.ngrok-free.app").replace(/\/+$/, "");

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function trimReq(r) {
  const promptMs = num(r.prompt_ms);
  const read = num(r.prompt_read);
  const pre = promptMs > 0 ? read / (promptMs / 1000) : 0;
  return {
    t: Math.round(num(r.time) * 1000),
    fin: typeof r.finish === "string" ? r.finish : "",
    p: num(r.prompt_tokens),
    re: num(r.reused),
    c: num(r.output_tokens),
    pre: Math.round(pre * 10) / 10,
    dec: num(r.decode_tok_s),
    dur: num(r.duration_s),
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: { message: "method not allowed" } });

  const now = Date.now();
  try {
    const r = await fetch(`${BASE}/metrics?requests=all`, {
      headers: { "User-Agent": "Mozilla/5.0", "ngrok-skip-browser-warning": "1" },
    });
    if (!r.ok) throw new Error(`strata HTTP ${r.status}`);
    const j = await r.json();
    const cc = j.conversation_cache || {};
    const out = {
      ok: true,
      stale: false,
      at: now,
      engine: {
        model: (j.engine && j.engine.model) || "strata",
        ctx: num(j.engine && j.engine.max_context) || 262144,
        version: (j.engine && j.engine.version) || "",
      },
      live: {
        state: (j.live && j.live.state) || "idle",
        queued: num(j.live && j.live.queued),
        tok_s: j.live && j.live.tok_s != null ? num(j.live.tok_s) : null,
      },
      totals: {
        since: Math.round(num(j.totals && j.totals.since) * 1000),
        requests: num(j.totals && j.totals.requests),
        prompt: num(j.totals && j.totals.prompt_tokens),
        reused: num(j.totals && j.totals.reused),
        out: num(j.totals && j.totals.output_tokens),
      },
      cache: {
        req: num(cc.requests),
        reqRe: num(cc.requests_reused),
        re: num(cc.reused_tokens),
        p: num(cc.prompt_tokens),
        lastRe: num(cc.last_reused),
        lastP: num(cc.last_prompt),
      },
      requests: Array.isArray(j.requests) ? j.requests.slice(0, 120).map(trimReq) : [],
    };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ ok: false, error: { message: `strata unreachable: ${e.message}` } });
  }
};
