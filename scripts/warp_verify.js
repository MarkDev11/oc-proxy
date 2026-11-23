#!/usr/bin/env bun
"use strict";

/* Verify WARP egress independently of the proxy server.
 *
 * Builds the same OpenCode-shaped request as lib/opencode.js, sends it through
 * the local usque HTTP proxy, and prints "<model> <status>" per model. Running
 * this out-of-process means a 429 here cannot pollute the proxy log (and thus
 * cannot trigger another rotation), and the proxy's own upstream egress can
 * stay direct.
 *
 * Usage: bun scripts/warp_verify.js <model> [model...]
 */

const path = require("path");

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {}

const oc = require("../lib/opencode");

const proxy = (
  process.env.WARP_PROXY_URL ||
  `http://127.0.0.1:${process.env.WARP_PROXY_PORT || "28090"}`
).trim();
const models = process.argv.slice(2);

if (!models.length) {
  console.error("usage: warp_verify.js <model> [model...]");
  process.exit(2);
}
if (!process.versions.bun) {
  console.error("warp_verify.js requires Bun (fetch proxy support)");
  process.exit(2);
}

for (const model of models) {
  const built = oc.buildUpstreamBody({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 8,
    stream: false,
  });
  try {
    const res = await fetch(oc.upstreamUrl(model), {
      method: "POST",
      headers: oc.buildHeaders({ sessionId: oc.newSessionId(), model }),
      body: JSON.stringify(built.body),
      proxy,
      signal: AbortSignal.timeout(30000),
    });
    console.log(`${model} ${res.status}`);
    try {
      await res.body?.cancel();
    } catch {}
  } catch {
    console.log(`${model} 000`);
  }
}
