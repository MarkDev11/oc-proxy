"use strict";

/* In-memory request stats for the monitor dashboard (GET /api/stats).
 * Nothing is persisted: everything lives in this process and resets on cold
 * start. Serverless platforms may run several instances, so the numbers are
 * best-effort per instance. That matches the dashboard contract: realtime
 * only while someone is watching, nothing stored anywhere.
 */

const MAX_RECENT = 100;

const totals = { requests: 0, errors: 0, prompt: 0, completion: 0 };
const byModel = new Map(); // model -> { m, requests, errors, prompt, completion }
const recent = []; // newest first: { t, m, ok, st, p, c, ms, fin, rate }

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Rough token estimate (~4 chars/token) when upstream reports no usage. */
function est(v) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return Math.max(0, Math.round(s.length / 4));
  } catch {
    return 0;
  }
}

function record(r) {
  try {
    if (!r || typeof r !== "object") return;
    const ms = Math.max(1, num(r.ms));
    const c = num(r.c);
    const rec = {
      t: Date.now(),
      m: String(r.m || "?").slice(0, 96),
      ok: r.ok !== false,
      st: num(r.st) || (r.ok === false ? 502 : 200),
      p: num(r.p),
      c,
      ms,
      fin: String(r.fin || (r.ok === false ? "error" : "stop")).slice(0, 24),
      rate: Math.round((c / (ms / 1000)) * 10) / 10,
    };
    totals.requests++;
    totals.prompt += rec.p;
    totals.completion += rec.c;
    if (!rec.ok) totals.errors++;
    let b = byModel.get(rec.m);
    if (!b) {
      b = { m: rec.m, requests: 0, errors: 0, prompt: 0, completion: 0 };
      byModel.set(rec.m, b);
    }
    b.requests++;
    b.prompt += rec.p;
    b.completion += rec.c;
    if (!rec.ok) b.errors++;
    recent.unshift(rec);
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  } catch {}
}

function snapshot() {
  return {
    ok: true,
    at: Date.now(),
    totals: { ...totals },
    models: [...byModel.values()].sort((a, b) => b.requests - a.requests).slice(0, 20),
    requests: recent.slice(0, 50),
  };
}

module.exports = { record, snapshot, est };
