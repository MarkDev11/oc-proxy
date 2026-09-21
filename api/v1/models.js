"use strict";

const { cors } = require("../../lib/opencode");

const FALLBACK = [
  { id: "oc/muse-spark-1.3-contributor-free", object: "model", owned_by: "opencode", context_length: 1048576, max_completion_tokens: 131072 },
  { id: "oc/muse-spark-1.2-contributor-free", object: "model", owned_by: "opencode", context_length: 1048576, max_completion_tokens: 131072 },
  { id: "muse-spark-1.3-contributor-free", object: "model", owned_by: "opencode", context_length: 1048576, max_completion_tokens: 131072 },
  { id: "muse-spark-1.2-contributor-free", object: "model", owned_by: "opencode", context_length: 1048576, max_completion_tokens: 131072 },
];

let cache = { at: 0, data: null };
const TTL = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: { message: "method not allowed" } });

  const now = Date.now();
  if (cache.data && now - cache.at < TTL) {
    return res.status(200).json({ object: "list", data: cache.data });
  }

  try {
    const r = await fetch("https://opencode.ai/zen/v1/models", {
      headers: { Authorization: "Bearer public", "User-Agent": "opencode/1.18.31" },
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = await r.json();
    const list = Array.isArray(j.data) ? j.data : [];
    // Follow upstream free tier: only expose *-free models (same as we allow in chat).
    const seen = new Set();
    const out = [];
    for (const m of list) {
      if (!m || typeof m.id !== "string") continue;
      const id = m.id.trim();
      if (!id || seen.has(id)) continue;
      if (!id.toLowerCase().includes("free")) continue;
      seen.add(id);
      const base = { id, object: "model", owned_by: m.owned_by || "opencode" };
      if (m.created) base.created = m.created;
      out.push(base);
      const alias = `oc/${id}`;
      if (!seen.has(alias)) {
        seen.add(alias);
        out.push({ ...base, id: alias });
      }
    }
    if (out.length) {
      cache = { at: now, data: out };
      return res.status(200).json({ object: "list", data: out });
    }
  } catch (e) {
    // fall through to fallback
  }
  cache = { at: now, data: FALLBACK };
  return res.status(200).json({ object: "list", data: FALLBACK });
};
