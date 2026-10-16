"use strict";

const { cors } = require("../lib/opencode");

module.exports = function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  return res.status(200).json({
    status: "ok",
    provider: "opencode",
    upstream: "https://opencode.ai/inference/v1",
    models: ["oc/muse-spark-1.3-contributor-free", "oc/muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free"],
  });
};
