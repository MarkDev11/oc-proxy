// Local runner for oc-proxy (Vercel-style handlers, zero deps).
// Usage: node serve-local.js   (reads .env automatically when present)
'use strict';

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const http = require('http');
const fs = require('fs');
const health = require('./api/health');
const models = require('./api/v1/models');
const completions = require('./api/v1/chat/completions');
const messages = require('./api/v1/messages');
const stats = require('./lib/stats');

const PORT = parseInt(process.env.PORT || '8791', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;
const INDEX = path.join(__dirname, 'public', 'index.html');
const TUNNEL_URL_FILE = path.resolve(__dirname, process.env.TUNNEL_URL_FILE || 'run/tunnel-url.txt');

function wrap(res) {
  let headSent = false;
  let ended = false;
  const flushHead = () => {
    if (headSent) return;
    headSent = true;
    res.writeHead(w._code, w._headers);
  };
  const w = {
    _code: 200,
    _headers: {},
    status(c) { w._code = c; return w; },
    setHeader(k, v) { w._headers[k] = v; },
    writeHead(code, headers) {
      if (code) w._code = code;
      if (headers) Object.assign(w._headers, headers);
      flushHead();
      return w;
    },
    write(chunk) {
      flushHead();
      if (ended) return false;
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
        res.end(Buffer.isBuffer(t) ? t : Buffer.from(String(t)));
      } else {
        if (!headSent) flushHead();
        res.end();
      }
    },
  };
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
    const w = wrap(res);
    try {
      const u = new URL(req.url, 'http://x');
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
      if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
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
