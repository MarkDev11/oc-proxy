"use strict";

/* GET /api/stats — in-memory oc-proxy request stats for the monitor dashboard.
 * Nothing is stored: counters reset on cold start and are per instance. */

const { cors } = require("../lib/opencode");
const stats = require("../lib/stats");

module.exports = function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: { message: "method not allowed" } });
  return res.status(200).json(stats.snapshot());
};
