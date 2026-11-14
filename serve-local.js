// Local runner for oc-proxy (Vercel-style handlers, zero deps).
// Usage: node serve-local.js   (reads .env automatically when present)
'use strict';

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const health = require('./api/health');
const models = require('./api/v1/models');
const completions = require('./api/v1/chat/completions');
const messages = require('./api/v1/messages');
const responses = require('./api/v1/responses');
const stats = require('./lib/stats');

const PORT = parseInt(process.env.PORT || '8791', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;
const INDEX = path.join(__dirname, 'public', 'index.html');
const TUNNEL_URL_FILE = path.resolve(__dirname, process.env.TUNNEL_URL_FILE || 'run/tunnel-url.txt');
const REQUEST_LOG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.REQUEST_LOG_ENABLED || '');
const REQUEST_LOG_DIR = path.join(__dirname, 'logs', 'requests');
const LOG_BODY_LIMIT = 4 * 1024 * 1024;
if (REQUEST_LOG_ENABLED) fs.mkdirSync(REQUEST_LOG_DIR, { recursive: true });

const SENSITIVE_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'proxy-authorization',
]);
const GATEWAY_KEY = process.env.GATEWAY_API_KEY || '';

function redact(s) {
  if (s === undefined || s === null) return '';
  let out = String(s);
  if (GATEWAY_KEY) out = out.split(GATEWAY_KEY).join('[REDACTED]');
  return out
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/("?(?:api[_-]?key|authorization|x-api-key)"?\s*[:=]\s*")[^"]+/gi, '$1[REDACTED]');
}

function safeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function createRequestLog(req, r) {
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REQUEST_LOG_DIR, `${stamp}-${id}.log`);
  const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  let ended = false;
  const raw = String(r.rawBody || '');
  stream.write(`=== META ===\n`);
  stream.write(`id: ${id}\n`);
  stream.write(`time: ${new Date().toISOString()}\n`);
  stream.write(`method: ${req.method}\n`);
  stream.write(`url: ${req.url}\n`);
  stream.write(`headers: ${JSON.stringify(safeHeaders(req.headers))}\n`);
  stream.write(`bodyBytes: ${Buffer.byteLength(raw, 'utf8')}\n`);
  stream.write(`=== CLIENT REQUEST ===\n`);
  stream.write(redact(raw.slice(0, LOG_BODY_LIMIT)) + '\n');
  if (raw.length > LOG_BODY_LIMIT) stream.write(`[client request truncated at ${LOG_BODY_LIMIT} bytes]\n`);
  const log = {
    id,
    file,
    stream,
    write(s) {
      if (ended) return;
      const text = redact(String(s));
      stream.write(text + (text.endsWith('\n') ? '' : '\n'));
    },
    raw(s) {
      if (ended) return;
      stream.write(redact(String(s)));
    },
    end(extra) {
      if (ended) return;
      ended = true;
      if (extra) stream.write(redact(String(extra)) + '\n');
      stream.write(`=== END ${new Date().toISOString()} ===\n`);
      stream.end();
    },
  };
  return log;
}

function wrap(res, log) {
  let headSent = false;
  let ended = false;
  let responseLogged = false;
  const logHead = () => {
    if (!log || responseLogged) return;
    responseLogged = true;
    log.raw('\n=== CLIENT RESPONSE ===\n');
    log.raw(`status: ${w._code}\n`);
    log.raw(`headers: ${JSON.stringify(safeHeaders(w._headers))}\n`);
    log.raw('--- body ---\n');
  };
  const sendHead = () => {
    if (headSent) return;
    headSent = true;
    res.writeHead(w._code, w._headers);
  };
  const flushHead = () => {
    sendHead();
    logHead();
  };
  const w = {
    _code: 200,
    _headers: {},
    status(c) { w._code = c; return w; },
    setHeader(k, v) { w._headers[k] = v; },
    writeHead(code, headers) {
      if (code) w._code = code;
      if (headers) Object.assign(w._headers, headers);
      sendHead();
      return w;
    },
    write(chunk) {
      flushHead();
      if (ended) return false;
      if (log) {
        const text = Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : (chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk));
        log.raw(text);
      }
      return res.write(chunk);
    },
    json(o) {
      w._headers['content-type'] = 'application/json';
      w.end(JSON.stringify(o));
    },
    send(t) { w.end(t); },
    end(t) {
      if (ended) return;
      ended = true;
      if (t !== undefined) {
        flushHead();
        const isBytes = Buffer.isBuffer(t) || t instanceof Uint8Array;
        const text = Buffer.isBuffer(t) ? t.toString('utf8') : (t instanceof Uint8Array ? Buffer.from(t).toString('utf8') : String(t));
        if (log) log.raw(text);
        res.end(isBytes ? Buffer.from(t) : Buffer.from(String(t)));
      } else {
        if (!headSent) flushHead();
        else logHead();
        res.end();
      }
      if (log) log.end();
    },
  };
  if (log) w._headers['x-oc-request-id'] = log.id;
  return w;
}

function readTunnelUrl() {
  try {
    return fs.readFileSync(TUNNEL_URL_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  let raw = '';
  let tooLarge = false;
  req.on('data', (c) => {
    if (tooLarge) return;
    raw += c;
    if (raw.length > MAX_BODY) {
      tooLarge = true;
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'body too large' } }));
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (tooLarge) return;
    let json;
    try { json = raw ? JSON.parse(raw) : undefined; } catch {}
    const r = {
      method: req.method, url: req.url, query: Object.fromEntries(new URL(req.url, 'http://x').searchParams),
      headers: req.headers, body: json, rawBody: raw,
    };
    const u = new URL(req.url, 'http://x');
    const shouldLog = REQUEST_LOG_ENABLED && req.method === 'POST' && (
      u.pathname.startsWith('/v1/') || u.pathname.startsWith('/api/v1/')
    );
    const log = shouldLog ? createRequestLog(req, r) : null;
    r.log = log;
    const w = wrap(res, log);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        ac.abort();
        log?.end('[client disconnected before response end]');
      }
    });
    r.signal = ac.signal;
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        try {
          const html = fs.readFileSync(INDEX);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(html);
        } catch {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'dashboard not found' }));
        }
      }
      if (u.pathname === '/api/health' || u.pathname === '/v1/health') return await health(r, w);
      if (u.pathname === '/api/stats' || u.pathname === '/v1/stats') return w.status(200).json(stats.snapshot());
      if (u.pathname === '/api/tunnel') return w.status(200).json({ url: readTunnelUrl() });
      if (u.pathname === '/api/v1/models' || u.pathname === '/v1/models') return await models(r, w);
      if (u.pathname === '/api/v1/chat/completions' || u.pathname === '/v1/chat/completions')
        return await completions(r, w);
      if (u.pathname === '/api/v1/messages' || u.pathname === '/v1/messages')
        return await messages(r, w);
      if (u.pathname === '/api/v1/responses' || u.pathname === '/v1/responses')
        return await responses(r, w);
      if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      if (log) {
        log.write(`=== HANDLER ERROR ===\n${(e && e.stack) || String(e)}`);
        log.end();
      }
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }));
      } else {
        try { res.end(); } catch {}
      }
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => console.log(`oc-proxy local on ${HOST}:${PORT}`));

function shutdown(sig) {
  console.log(`\noc-proxy shutting down (${sig})`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
