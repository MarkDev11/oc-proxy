"use strict";

const { cors, checkAuth } = require("../../lib/opencode");

const FALLBACK_FREE = [
  "beam-free",
  "flint-40b-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "pulse-alpha-free",
  "crouton-alpha-free",
];
const FALLBACK = FALLBACK_FREE.flatMap((id) => [
  { id, object: "model", owned_by: "opencode" },
  { id: `oc/${id}`, object: "model", owned_by: "opencode" },
]);

let cache = { at: 0, data: null };
const TTL = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: { message: "method not allowed" } });
  if (!checkAuth(req)) return res.status(401).json({ error: { message: "invalid api key" } });

  const now = Date.now();
  if (cache.data && now - cache.at < TTL) {
    return res.status(200).json({ object: "list", data: cache.data });
  }

  try {
    const r = await fetch("https://opencode.ai/zen/v1/models", {
      headers: {
        Authorization: "Bearer public",
        "User-Agent": `opencode/1.19.5 ai-sdk/provider-utils/4.0.23 runtime/bun/${process.versions.bun || "1.4.4"}`,
      },
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
