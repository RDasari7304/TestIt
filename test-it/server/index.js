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
const { RunManager } = await import('./runs.js');
const store = await import('./store.js');

const PORT = Number(process.env.PORT || 3001);
// Locally only reachable from this machine; in production set HOST=0.0.0.0 (the Dockerfile does).
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const MODES = new Set(['fast', 'probe', 'build']);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);

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
    load: runs.stats(),
    payments: await payments(),
    browser: findBrowser() ? true : false,
    webSearch: process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo',
    github: Boolean(process.env.GITHUB_TOKEN),
    customRpc: Boolean(process.env.SOLANA_RPC_URL),
  });
}

function visitorId(req) {
  // Behind Render/Caddy the real client IP is the first X-Forwarded-For entry.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

// TESTIT_FAKE_RUN_MS: load-testing only — replaces the real investigation with a timed fake.
const fakeRun = async ({ ca, mode, emit, signal }) => {
  const ms = Number(process.env.TESTIT_FAKE_RUN_MS);
  emit('step', { id: 'chain', label: 'Reading the token', status: 'running' });
  emit('meta', { name: `Fake ${ca.slice(0, 4)}`, symbol: 'FAKE', image: null });
  await new Promise((r, j) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('Cancelled')); }); });
  emit('step', { id: 'chain', label: 'Reading the token', status: 'done' });
  return {
    ca, mode, generatedAt: new Date().toISOString(), token: { name: `Fake ${ca.slice(0, 4)}`, symbol: 'FAKE' }, signals: [], screenshots: [],
    analysis: { verdict: 'PARTIALLY_WORKS', confidence: 60, headline: `Fake test result at ${new Date().toLocaleTimeString()}`, project_summary: 'Load-test fake.', claimed_tech: [], tests_performed: [], red_flags: [], green_flags: [], toolCalls: 0 },
  };
};

const runs = new RunManager({
  runAnalysis: process.env.TESTIT_FAKE_RUN_MS ? fakeRun : runAnalysis,
  maxConcurrent: MAX_CONCURRENT,
  maxQueue: Number(process.env.MAX_QUEUE || 100),
  maxPerVisitor: Number(process.env.MAX_RUNS_PER_VISITOR || 2),
  cacheMinutes: Number(process.env.CACHE_MINUTES || 360),
  onFinish: (run, report) => {
    const a = report.analysis;
    console.log(`[run] done ${run.mode} ${run.ca}${a ? `: ${a.verdict} · ${a.toolCalls} tests · AI cost $${a.costUsd}` : ''} · ${JSON.stringify(runs.stats())}`);
    // Save as this token's latest result (replaces any earlier test in the same mode).
    store.saveReport(report).catch((e) => console.error('[store] save failed:', e.message));
  },
  onRefund: (run) => refundCredit(run.credit),
});

async function analyze(req, res, params) {
  const ca = String(params.get('ca') || '').trim();
  const mode = String(params.get('mode') || 'probe');
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data, { end } = {}) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (end) res.end();
  };
  const fail = (message) => send('fail', { message }, { end: true });
  if (!isValidSolanaAddress(ca)) return fail('That is not a valid Solana address.');
  if (!MODES.has(mode)) return fail('Mode must be fast, probe or build.');

  const fresh = params.get('fresh') === '1';
  const watchOnly = params.get('watch') === '1';

  // 1) Same test already running or waiting: join it and watch live (free).
  let run = runs.findActive(ca, mode);
  let creator = false;
  if (run) {
    send('joined', { state: run.state, startedAt: run.startedAt || null });
  } else {
    // 2) Already tested and no new test requested: show the stored result (free).
    if (!fresh || watchOnly) {
      const stored = await store.getReport(ca, mode).catch(() => null);
      if (stored) return send('report', { ...stored, cached: { at: Date.parse(stored.generatedAt) || Date.now() } }, { end: true });
      if (watchOnly) return fail('This test has finished or is no longer running. Check the Tested page for its result.');
    }
    // 3) New run: check fairness limits, take payment credit, join the line.
    const visitor = visitorId(req);
    const blocked = runs.admit(visitor);
    if (blocked) return fail(blocked);
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
    run = runs.create({ ca, mode, visitor, credit: pay.enabled ? creditId : null });
    creator = true;
    console.log(`[run] new ${mode} ${ca} · ${JSON.stringify(runs.stats())}`);
  }

  const sub = run.subscribe(send, { creator });
  const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(ping);
    run.unsubscribe(sub);
  });
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

// Public read-only data for the Live now / Tested / token pages.
async function apiGet(res, url) {
  try {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (url.pathname === '/api/live') return json(res, 200, { runs: runs.list(), stats: runs.stats() });
    if (url.pathname === '/api/tested') {
      const q = String(url.searchParams.get('q') || '').slice(0, 80);
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      return json(res, 200, await store.listTested({ q, offset, limit }));
    }
    if (parts[1] === 'token' && parts[2]) {
      const ca = parts[2];
      if (!isValidSolanaAddress(ca)) return json(res, 400, { error: 'Invalid address' });
      const active = runs.list().filter((r) => r.ca === ca);
      return json(res, 200, { ca, tested: await store.testedFor(ca), active });
    }
    if (parts[1] === 'report' && parts[2] && MODES.has(parts[3])) {
      if (!isValidSolanaAddress(parts[2])) return json(res, 400, { error: 'Invalid address' });
      const r = await store.getReport(parts[2], parts[3]);
      return r ? json(res, 200, r) : json(res, 404, { error: 'Not tested yet' });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[api]', e.message);
    return json(res, 500, { error: 'Temporarily unavailable. Try again.' });
  }
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
  if (url.pathname.startsWith('/api/')) return apiGet(res, url);
  return serveStatic(res, url.pathname);
});

server.requestTimeout = 0; // SSE streams can run for many minutes
server.headersTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`test.it running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${HOST === '0.0.0.0' ? ' (listening on all interfaces)' : ''}`);
  console.log(`  Results storage: ${store.storageKind() === 'redis' ? 'Upstash Redis (permanent)' : 'local files in data/ (lost on Render restarts; set UPSTASH_REDIS_REST_URL/TOKEN to keep them)'}`);
  console.log(`  Up to ${MAX_CONCURRENT} tests at a time · queue up to ${runs.maxQueue} · results reused for ${Math.round(runs.cacheMs / 60000)} min`);
  const b = findBrowser();
  console.log(b ? `  Browser: ${b}` : '  ⚠ No Chrome/Edge/Chromium found (or Node < 22): browser testing disabled. Set CHROME_PATH in .env.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('  ⚠ ANTHROPIC_API_KEY not set in .env: the AI investigation step will be skipped');
  const pay = paymentConfig();
  if (!pay.enabled) console.warn('  ⚠ PAYMENTS_DISABLED=1: tests run for free');
  else if (!pay.configured) console.warn('  ⚠ Payments on but not configured: set PAYMENT_TOKEN_MINT and PAYMENT_WALLET in .env (or PAYMENTS_DISABLED=1 to test locally)');
  else console.log(`  Payments: $${pay.prices.fast.toFixed(2)} / $${pay.prices.probe.toFixed(2)} / $${pay.prices.build.toFixed(2)} (fast/probe/build) in ${pay.mint} → ${pay.treasury}`);
});
