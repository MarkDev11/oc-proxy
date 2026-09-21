"use strict";

/* Proxy pool validator. Run by .github/workflows/pool.yml every 15 min
 * (and locally for testing). Zero dependencies.
 *
 * - Fetches the fresh proxifly HTTP list.
 * - Tests a rotating sample + revalidates the existing pool.
 * - Writes pool.json {updatedAt, cursor, proxies:[{url,latencyMs,anon,checkedAt}]}.
 *
 * Env overrides: PROXY_SOURCE_URL, VALIDATOR_SAMPLE, VALIDATOR_CONCURRENCY,
 * VALIDATOR_MAX_LATENCY_MS, VALIDATOR_KEEP, VALIDATOR_TIMEOUT_MS.
 */

const fs = require("fs");
const path = require("path");
const { testProxy } = require("../lib/proxy");

const LIST_URL =
  process.env.PROXY_SOURCE_URL ||
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt";
const SAMPLE = Math.max(1, parseInt(process.env.VALIDATOR_SAMPLE || "60", 10) || 60);
const CONC = Math.max(1, parseInt(process.env.VALIDATOR_CONCURRENCY || "12", 10) || 12);
const MAX_LAT = Math.max(500, parseInt(process.env.VALIDATOR_MAX_LATENCY_MS || "4000", 10) || 4000);
const KEEP = Math.max(1, parseInt(process.env.VALIDATOR_KEEP || "5", 10) || 5);
const REQ_TIMEOUT = Math.max(3000, parseInt(process.env.VALIDATOR_TIMEOUT_MS || "10000", 10) || 10000);
const OUT = path.join(process.cwd(), "pool.json");

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "oc-proxy-pool/1.0" } });
  if (!r.ok) throw new Error(`list fetch ${r.status}`);
  return r.text();
}

function norm(line) {
  const s = String(line || "").trim().split("://").pop().trim();
  return /^[0-9a-zA-Z.:\-]+:\d+$/.test(s) ? s : null;
}

async function mapPool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { ok: false, error: String((e && e.message) || e).slice(0, 80) };
        }
      }
    })
  );
  return out;
}

async function main() {
  const t0 = Date.now();
  let old = { cursor: 0, proxies: [] };
  try {
    old = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (!Array.isArray(old.proxies)) old.proxies = [];
    if (typeof old.cursor !== "number") old.cursor = 0;
  } catch {}

  const raw = await fetchText(LIST_URL);
  const seen = new Set();
  const list = [];
  for (const ln of raw.split("\n")) {
    const h = norm(ln);
    if (h && !seen.has(h)) {
      seen.add(h);
      list.push(h);
    }
  }
  console.log(`list: ${list.length} unique http proxies`);

  const start = list.length ? old.cursor % list.length : 0;
  const sample = [];
  for (let k = 0; k < Math.min(SAMPLE, list.length); k++) sample.push(list[(start + k) % list.length]);
  const recheck = old.proxies.map((p) => String(p.url || "").split("://").pop()).filter((h) => h.includes(":"));
  const targets = [...new Set([...sample, ...recheck])];
  console.log(`testing ${targets.length} (${sample.length} fresh + ${recheck.length} recheck)`);

  const results = await mapPool(targets, async (hostport) => {
    const r = await testProxy(`http://${hostport}`, REQ_TIMEOUT);
    process.stdout.write(r.ok ? "." : "x");
    return { hostport, ...r };
  });
  console.log("");

  const good = results
    .filter((r) => r.ok && r.latencyMs <= MAX_LAT && r.anon !== "transparent")
    .sort((a, b) => a.latencyMs - b.latencyMs)
    .slice(0, KEEP)
    .map((r) => ({
      url: `http://${r.hostport}`,
      latencyMs: r.latencyMs,
      anon: r.anon,
      checkedAt: new Date().toISOString(),
    }));

  const pool = {
    updatedAt: new Date().toISOString(),
    cursor: list.length ? (start + sample.length) % list.length : 0,
    proxies: good,
  };
  fs.writeFileSync(OUT, JSON.stringify(pool, null, 2) + "\n");
  console.log(`pool: ${good.length} kept in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const p of good) console.log(`  ${p.latencyMs}ms ${p.anon} ${p.url}`);
}

main().catch((e) => {
  console.error("validator failed:", (e && e.message) || e);
  process.exit(1);
});
