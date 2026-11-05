"use strict";

const { cors } = require("../lib/opencode");

module.exports = function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  return res.status(200).json({
    status: "ok",
    mode: "local+tunnel",
    provider: "opencode",
    upstream: "https://opencode.ai/inference/openai/v1",
    runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`,
    uptime: Math.round(process.uptime()),
  });
};
