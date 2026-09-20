"use strict";

const { cors } = require("../../lib/opencode");

const MODELS = [
  {
    id: "oc/muse-spark-1.3-contributor-free",
    object: "model",
    owned_by: "opencode",
    context_length: 1048576,
    max_completion_tokens: 131072,
  },
  {
    id: "oc/muse-spark-1.2-contributor-free",
    object: "model",
    owned_by: "opencode",
    context_length: 1048576,
    max_completion_tokens: 131072,
  },
  {
    id: "muse-spark-1.3-contributor-free",
    object: "model",
    owned_by: "opencode",
    context_length: 1048576,
    max_completion_tokens: 131072,
  },
  {
    id: "muse-spark-1.2-contributor-free",
    object: "model",
    owned_by: "opencode",
    context_length: 1048576,
    max_completion_tokens: 131072,
  },
];

module.exports = function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: { message: "method not allowed" } });
  return res.status(200).json({ object: "list", data: MODELS });
};
