// test.it server: zero dependencies. Serves the frontend from /public and
// streams investigations over Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { runAnalysis } = await import('./pipeline.js');
const { isValidSolanaAddress } = await import('./solana.js');
const { findBrowser } = await import('./browser.js');
const { paymentConfig, paymentToken, createQuote, verifyPayment, consumeCredit, refundCredit, PayError } = await import('./payments.js');
const { modeConfig } = await import('./analyze.js');

const PORT = Number(process.env.PORT || 3001);
// Locally only reachable from this machine; in production set HOST=0.0.0.0 (the Dockerfile does).
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const MODES = new Set(['fast', 'probe', 'build']);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
let running = 0;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 10_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new PayError('Request too large', 413);
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new PayError('Invalid JSON');
  }
}

async function payments(res) {
  const cfg = paymentConfig();
  let token = null;
  try {
    token = cfg.enabled && cfg.configured ? await Promise.race([paymentToken(), new Promise((r) => setTimeout(() => r(null), 4000))]) : null;
  } catch {}
  return { enabled: cfg.enabled, configured: cfg.configured, mint: cfg.mint, symbol: token?.symbol || null, prices: cfg.prices };
}

async function health(res) {
  json(res, 200, {
    ok: true,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    model: modeConfig('probe').model,
    payments: await payments(),
    browser: findBrowser() ? true : false,
    webSearch: process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo',
    github: Boolean(process.env.GITHUB_TOKEN),
    customRpc: Boolean(process.env.SOLANA_RPC_URL),
  });
}

async function analyze(req, res, params) {
  const ca = String(params.get('ca') || '').trim();
  const mode = String(params.get('mode') || 'probe');
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const fail = (message) => {
    send('fail', { message });
    res.end();
  };
  if (!isValidSolanaAddress(ca)) return fail('That is not a valid Solana address.');
  if (!MODES.has(mode)) return fail('Mode must be fast, probe or build.');
  if (running >= MAX_CONCURRENT) return fail('Too many tests running right now; try again in a minute. You have not been charged.');

  // Pay-per-run: a verified, unused credit is required unless payments are disabled.
  const pay = paymentConfig();
  const creditId = String(params.get('credit') || '');
  if (pay.enabled) {
    if (!pay.configured) return fail('Payments are not configured on this server yet (set PAYMENT_TOKEN_MINT and PAYMENT_WALLET, or PAYMENTS_DISABLED=1 for local testing).');
    try {
      consumeCredit(creditId, ca, mode);
    } catch (e) {
      return fail(e.message);
    }
  }
  let billable = false;
  const refund = () => {
    if (billable) return false;
    if (pay.enabled) refundCredit(creditId);
    return pay.enabled;
  };

  running++;
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
  console.log(`[analyze] ${mode} ${ca}`);
  try {
    const report = await runAnalysis({ ca, mode, emit: send, signal: controller.signal, onBillable: () => (billable = true) });
    send('report', report);
    const a = report.analysis;
    if (a) console.log(`[analyze] done ${mode} ${ca}: ${a.verdict} · ${a.toolCalls} tests · AI cost $${a.costUsd}`);
    try {
      const dir = path.join(ROOT, 'reports');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ca}-${mode}-${Date.now()}.json`), JSON.stringify(report, null, 2));
    } catch {}
  } catch (e) {
    const refunded = refund();
    if (!controller.signal.aborted) {
      console.error('[analyze] failed:', e);
      send('fail', { message: e.message || String(e), refunded, credit: refunded ? creditId : undefined });
    }
  } finally {
    running--;
    clearInterval(ping);
    res.end();
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': TYPES['.html'], ...SECURITY_HEADERS });
        res.end(html);
      });
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  });
}

async function postRoute(req, res, pathname) {
  try {
    const body = await readJson(req);
    if (pathname === '/api/quote') return json(res, 200, await createQuote({ ca: String(body.ca || '').trim(), mode: String(body.mode || ''), payer: String(body.payer || '').trim() }));
    if (pathname === '/api/pay/verify') return json(res, 200, await verifyPayment({ quoteId: String(body.quoteId || ''), signature: String(body.signature || '') }));
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!(e instanceof PayError)) console.error('[payments]', e);
    return json(res, e.status || 500, { error: e instanceof PayError ? e.message : 'Payment service error. Try again.' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) return postRoute(req, res, url.pathname);
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (url.pathname === '/api/health') return health(res);
  if (url.pathname === '/api/analyze') return analyze(req, res, url.searchParams);
  return serveStatic(res, url.pathname);
});

server.requestTimeout = 0; // SSE streams can run for many minutes
server.headersTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`test.it running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (listening on all interfaces)' : ''}`);
  console.log(`  Up to ${MAX_CONCURRENT} test(s) at a time`);
  const b = findBrowser();
  console.log(b ? `  Browser: ${b}` : '  ⚠ No Chrome/Edge/Chromium found (or Node < 22): browser testing disabled. Set CHROME_PATH in .env.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('  ⚠ ANTHROPIC_API_KEY not set in .env: the AI investigation step will be skipped');
  const pay = paymentConfig();
  if (!pay.enabled) console.warn('  ⚠ PAYMENTS_DISABLED=1: tests run for free');
  else if (!pay.configured) console.warn('  ⚠ Payments on but not configured: set PAYMENT_TOKEN_MINT and PAYMENT_WALLET in .env (or PAYMENTS_DISABLED=1 to test locally)');
  else console.log(`  Payments: $${pay.prices.fast.toFixed(2)} / $${pay.prices.probe.toFixed(2)} / $${pay.prices.build.toFixed(2)} (fast/probe/build) in ${pay.mint} → ${pay.treasury}`);
});
