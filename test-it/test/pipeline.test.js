// End-to-end tests with a fully mocked network (no real requests are made).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { b58decode, b58encode, findProgramAddress, isPubkey } from '../server/b58.js';
import { ARCHIVE } from './helpers/tar.js';

process.env.TESTIT_NO_BROWSER = '1';
delete process.env.GITHUB_TOKEN;
delete process.env.BRAVE_API_KEY;

const CA = 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const [META_PDA] = findProgramAddress([Buffer.from('metadata'), b58decode(METAPLEX), b58decode(CA)], METAPLEX);

dns.lookup = async (host) => (host.endsWith('internal-test.com') ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);

function borshStr(s, pad) {
  const b = Buffer.alloc(4 + pad);
  b.writeUInt32LE(pad, 0);
  Buffer.from(s).copy(b, 4);
  return b;
}
const metaAccount = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), b58decode(CA), borshStr('AgentX', 32), borshStr('AGX', 10), borshStr('https://ipfs.io/ipfs/QmAgentX', 200)]);

const calls = [];
let claudeScript = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const html = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const SITE = `<!doctype html><html><head><title>AgentX — autonomous trading agents</title>
<meta name="description" content="AgentX runs AI agents that trade on Solana."><script type="module" src="/assets/app-1a2b.js"></script></head>
<body><h1>AgentX</h1><p>Our proprietary LLM powers on-chain agents. Try the <a href="https://app.agentx.example/">app</a>.</p>
<a href="https://docs.agentx.example/">Docs</a> <a href="/about">About</a> <a href="https://x.com/agentx">X</a></body></html>`;
const BUNDLE = `const API="https://api.agentx.example/v1";fetch("/api/v1/chat",{method:"POST"});const o="https://api.openai.com/v1";const repo="https://github.com/agentx/core";const PROGRAM="Ag3ntPrograM1111111111111111111111111111111";const mockData=[1];`;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, method: init.method || 'GET', body: init.body });
  if (url.includes('api.mainnet-beta.solana.com')) {
    const { method, params } = JSON.parse(init.body);
    if (method === 'getAccountInfo' && params[0] === CA) return json({ result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } } } });
    if (method === 'getAccountInfo' && params[0] === META_PDA) return json({ result: { value: { data: [metaAccount.toString('base64'), 'base64'] } } });
    if (method === 'getAccountInfo') return json({ result: { value: null } });
    if (method === 'getTokenLargestAccounts') throw new Error('holder data must not be fetched');
    if (method === 'getSignaturesForAddress') return json({ result: [{ signature: '5sig', blockTime: 1700000000 }] });
    return json({ error: { message: 'Method not found' } });
  }
  if (url === 'https://ipfs.io/ipfs/QmAgentX') return json({ name: 'AgentX', symbol: 'AGX', description: 'AI agents on Solana', website: 'https://agentx.example', twitter: 'https://x.com/agentx' });
  if (url.includes('dexscreener')) throw new Error('market data must not be fetched');
  if (url === 'https://agentx.example/') return html(SITE);
  if (url === 'https://agentx.example/assets/app-1a2b.js') return new Response(BUNDLE, { status: 200, headers: { 'content-type': 'text/javascript' } });
  if (url === 'https://docs.agentx.example/') return html('<html><head><title>AgentX Docs</title></head><body><h2>API</h2><p>POST https://api.agentx.example/v1/chat</p></body></html>');
  if (url === 'https://agentx.example/about') return html('<html><body><h1>About</h1><p>Team.</p></body></html>');
  if (url === 'https://api.agentx.example/v1/chat') return json({ reply: 'Hello from AgentX', model: 'gpt-4o-mini' });
  if (url === 'https://agentx.example/old') return new Response(null, { status: 302, headers: { location: 'https://internal-test.com/admin' } });
  if (url.startsWith('https://html.duckduckgo.com/')) {
    return html('<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fagentx%2Fcore&rut=x">agentx/core</a><a class="result__snippet">Core agent runtime</a></div>');
  }
  if (url.startsWith('https://api.github.com/')) {
    const p = url.replace('https://api.github.com', '');
    const repoJson = { full_name: 'agentx/core', html_url: 'https://github.com/agentx/core', clone_url: 'https://github.com/agentx/core.git', description: 'AgentX core', homepage: 'https://agentx.example', fork: false, archived: false, stargazers_count: 42, forks_count: 3, open_issues_count: 1, created_at: '2025-02-01T00:00:00Z', pushed_at: new Date().toISOString(), size: 900, license: { spdx_id: 'MIT' }, default_branch: 'main' };
    if (p.startsWith('/search/repositories')) return json({ items: decodeURIComponent(p).includes('agentx.example') ? [repoJson] : [] });
    if (p === '/repos/agentx/core') return json(repoJson);
    if (p.startsWith('/repos/agentx/core/languages')) return json({ TypeScript: 50000 });
    if (p.startsWith('/repos/agentx/core/commits')) return json(Array.from({ length: 23 }, (_, i) => ({ sha: `abcdef${i}0`, author: { login: i % 2 ? 'alice' : 'bob' }, commit: { message: `commit ${i}`, author: { date: new Date(Date.now() - i * 86400000).toISOString() } } })));
    if (p.startsWith('/repos/agentx/core/contributors')) return json([{}, {}]);
    if (p.startsWith('/repos/agentx/core/tarball/')) return new Response(ARCHIVE, { status: 200, headers: { 'content-type': 'application/x-gzip' } });
    if (p.startsWith('/repos/agentx/core/contents/src')) return new Response('export async function chat(prompt){ return openai.chat(prompt) }', { status: 200 });
    if (p.startsWith('/repos/agentx/core/contents')) return json([{ name: 'package.json' }, { name: 'src' }, { name: 'README.md' }]);
    if (p.startsWith('/repos/agentx/core/readme')) return new Response('# AgentX\nAgents that trade.\n'.repeat(30), { status: 200 });
    return json({ message: 'Not Found' }, 404);
  }
  if (url === 'https://api.anthropic.com/v1/messages') {
    const body = JSON.parse(init.body);
    const next = claudeScript.shift();
    assert.ok(next, 'unexpected extra Claude call');
    return json(next(body));
  }
  throw new Error(`Unmocked fetch: ${init.method || 'GET'} ${url}`);
};

const { runAnalysis } = await import('../server/pipeline.js');
const { parseHtml, classifyLinks, scanBundle } = await import('../server/discover.js');
const { safeFetch } = await import('../server/net.js');

const REPORT = {
  verdict: 'PARTIALLY_WORKS',
  confidence: 72,
  headline: 'The chat API works, but it is a wrapper around a public model.',
  project_summary: 'AgentX claims AI trading agents.',
  user_experience: 'Opened the app, clicked Chat, got a reply.',
  claimed_tech: [{ claim: 'Proprietary LLM', status: 'FAILED', evidence: 'API reports gpt-4o-mini', how_tested: 'POST /v1/chat' }],
  tests_performed: [{ description: 'POST /v1/chat', outcome: 'pass' }],
  red_flags: ['Undisclosed wrapper'],
  green_flags: ['Active repo'],
  untested: 'Trading requires a funded wallet.',
};
const toolUse = (uses) => ({ id: 'msg', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, ...uses.map(([id, name, input]) => ({ type: 'tool_use', id, name, input }))], stop_reason: 'tool_use' });

beforeEach(() => {
  calls.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

test('base58 + PDA helpers', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(b58encode(b58decode(usdc)), usdc);
  assert.equal(findProgramAddress([Buffer.from('metadata'), b58decode(METAPLEX), b58decode(usdc)], METAPLEX)[0], '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq');
  assert.ok(isPubkey(CA));
  assert.ok(!isPubkey('0xabc'));
});

test('parseHtml, link classification and bundle scanning', () => {
  const p = parseHtml(SITE, 'https://agentx.example/');
  assert.equal(p.title, 'AgentX — autonomous trading agents');
  assert.deepEqual(p.scripts, ['https://agentx.example/assets/app-1a2b.js']);
  const l = classifyLinks(p.links, 'https://agentx.example/');
  assert.deepEqual(l.app, ['https://app.agentx.example/']);
  assert.ok(l.docs.includes('https://docs.agentx.example/'));
  const s = scanBundle(BUNDLE, 'agentx.example');
  assert.ok(s.githubLinks.includes('https://github.com/agentx/core'));
  assert.ok(s.apiPaths.includes('/api/v1/chat'));
  assert.ok(s.sdks.includes('OpenAI'));
  assert.ok(s.sdks.includes('Mock / demo data'));
  assert.ok(s.backendHosts.includes('api.agentx.example'));
});

test('safeFetch blocks private hosts, including via redirect', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1:3001/api/health'), /non-public/);
  await assert.rejects(safeFetch('http://localhost/'), /non-public/);
  await assert.rejects(safeFetch('https://internal-test.com/'), /non-public/);
  await assert.rejects(safeFetch('https://agentx.example/old'), /non-public/);
  await assert.rejects(safeFetch('file:///etc/passwd'), /http/);
});

test('probe mode: discovery, tool loop with several tools, report', async () => {
  claudeScript = [
    (body) => {
      assert.equal(body.model, 'claude-sonnet-5-5');
      assert.equal(body.thinking?.type, 'enabled');
      assert.equal(body.system[0].cache_control?.type, 'ephemeral', 'system prompt cached');
      assert.equal(body.messages[0].content.at(-1).cache_control?.type, 'ephemeral', 'dossier cached');
      const names = body.tools.map((t) => t.name);
      for (const n of ['http_request', 'inspect_asset', 'browser', 'github', 'web_search', 'solana_rpc', 'submit_report']) assert.ok(names.includes(n), n);
      assert.ok(!names.includes('sandbox'));
      assert.match(body.messages[0].content[0].text, /MODE: Probe/);
      assert.match(body.messages[0].content[0].text, /api\/v1\/chat/, 'bundle scan results reach Claude');
      return toolUse([
        ['t1', 'http_request', { url: 'https://api.agentx.example/v1/chat', method: 'POST', json_body: { prompt: 'hi' }, reason: 'chat API' }],
        ['t2', 'github', { action: 'file', repo: 'agentx/core', path: 'src/chat.ts' }],
        ['t3', 'solana_rpc', { method: 'getSignaturesForAddress', params: ['Ag3ntPrograM1111111111111111111111111111111', { limit: 5 }] }],
        ['t4', 'solana_rpc', { method: 'sendTransaction', params: [] }],
        ['t5', 'browser', { action: 'open', url: 'https://app.agentx.example/' }],
      ]);
    },
    (body) => {
      const results = body.messages.at(-1).content;
      assert.equal(results.at(-1).cache_control?.type, 'ephemeral', 'newest turn carries the moving cache breakpoint');
      assert.match(results[0].content, /gpt-4o-mini/);
      assert.match(results[1].content, /openai\.chat/);
      assert.match(results[2].content, /5sig/);
      assert.equal(results[3].is_error, true);
      assert.match(results[3].content, /not allowed/);
      assert.match(results[4].content, /Browser unavailable/);
      assert.equal(body.messages.at(-2).content[0].type, 'thinking', 'thinking blocks are preserved');
      return toolUse([['t6', 'submit_report', REPORT]]);
    },
  ];
  const events = [];
  const report = await runAnalysis({ ca: CA, mode: 'probe', emit: (e, d) => events.push([e, d]), signal: new AbortController().signal });

  assert.equal(report.token.name, 'AgentX');
  assert.equal(report.token.description, 'AI agents on Solana');
  for (const k of ['priceUsd', 'liquidityUsd', 'marketCap', 'top10Pct', 'mintAuthority']) assert.ok(!(k in report.token), k);
  assert.ok(!report.signals.some((s) => /liquidity|holders|mint authority|freeze|brand-new/i.test(s.label)));
  assert.ok(!calls.some((c) => c.url.includes('dexscreener')));
  assert.doesNotMatch(JSON.stringify(events), /Pulling market data/);
  assert.equal(report.github[0].fullName, 'agentx/core');
  assert.ok(report.candidates.some((c) => c.fullName === 'agentx/core' && c.score >= 6));
  assert.ok(report.bundles.apiPaths.includes('/api/v1/chat'));
  assert.equal(report.analysis.verdict, 'PARTIALLY_WORKS');
  assert.equal(report.analysis.toolCalls, 5);
  assert.equal(report.actions.find((a) => a.id === 't1').status, 200);
  const steps = events.filter(([e]) => e === 'step').map(([, d]) => d);
  assert.equal(steps.find((s) => s.id === 'render').status, 'skipped');
  assert.ok(!steps.some((s) => s.id === 'build'));
  assert.deepEqual(steps.filter((s) => s.status === 'error'), []);
  assert.equal(claudeScript.length, 0);
});

test('agent is forced to report after the tool budget', async () => {
  process.env.MAX_TOOL_CALLS = '2';
  const loop = () => toolUse([['x' + Math.random(), 'web_search', { query: 'agentx github' }]]);
  claudeScript = [
    loop,
    (body) => {
      assert.doesNotMatch(JSON.stringify(body.messages.at(-1).content), /budget/);
      return loop();
    },
    (body) => {
      assert.match(JSON.stringify(body.messages.at(-1).content), /testing budget/);
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_report' });
      assert.equal(body.thinking, undefined);
      return toolUse([['r', 'submit_report', { ...REPORT, verdict: 'DOES_NOT_WORK' }]]);
    },
  ];
  const report = await runAnalysis({ ca: CA, mode: 'probe', emit: () => {}, signal: new AbortController().signal });
  delete process.env.MAX_TOOL_CALLS;
  assert.equal(report.analysis.verdict, 'DOES_NOT_WORK');
  assert.equal(report.analysis.toolCalls, 2);
});

test('cost cap stops the agent and cost is tracked', async () => {
  process.env.PROBE_MAX_COST_USD = '0.05';
  const expensive = (uses) => ({ ...toolUse(uses), usage: { input_tokens: 2000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0, output_tokens: 1500 } });
  claudeScript = [
    // 2000*2 + 10000*2.5 + 1500*10 = 44,000 / 1e6 = $0.044 >= 80% of $0.05
    () => expensive([['c1', 'web_search', { query: 'q1' }], ['c2', 'web_search', { query: 'q2' }]]),
    (body) => {
      const content = body.messages.at(-1).content;
      assert.match(content[0].content, /not run/, 'tools skipped once over budget');
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_report' });
      return toolUse([['r', 'submit_report', REPORT]]);
    },
  ];
  const report = await runAnalysis({ ca: CA, mode: 'probe', emit: () => {}, signal: new AbortController().signal });
  delete process.env.PROBE_MAX_COST_USD;
  assert.equal(report.analysis.toolCalls, 0);
  assert.ok(report.analysis.costUsd >= 0.044 && report.analysis.costUsd < 0.05, String(report.analysis.costUsd));
});

test('fast mode: no thinking, small budget, fewer pages', async () => {
  claudeScript = [
    (body) => {
      assert.equal(body.thinking, undefined);
      assert.match(body.messages[0].content[0].text, /MODE: Fast/);
      assert.match(body.messages[0].content[0].text, /about 14 tool calls/);
      assert.ok(!body.tools.some((t) => t.name === 'sandbox'));
      return toolUse([['f', 'submit_report', REPORT]]);
    },
  ];
  const events = [];
  const report = await runAnalysis({ ca: CA, mode: 'fast', emit: (e, d) => events.push([e, d]), signal: new AbortController().signal });
  assert.equal(report.crawl, null);
  assert.ok(!events.some(([e, d]) => e === 'step' && d.id === 'crawl'));
  assert.ok(!calls.some((c) => c.url === 'https://docs.agentx.example/'), 'docs not crawled in fast mode');
});

test('build mode: downloads and analyzes the source, Claude reads it with the code tool', async () => {
  claudeScript = [
    (body) => {
      const names = body.tools.map((t) => t.name);
      assert.ok(names.includes('code'));
      assert.ok(!names.includes('sandbox'));
      const dossier = body.messages[0].content[0].text;
      assert.match(dossier, /MODE: Build/);
      assert.match(dossier, /Ag3ntPrograM1111111111111111111111111111111/, 'code inventory reaches Claude');
      return toolUse([['g1', 'code', { action: 'grep', pattern: 'mockDecision' }], ['g2', 'code', { action: 'read', path: 'src/agent.ts', start_line: 1, line_count: 5 }]]);
    },
    (body) => {
      const results = body.messages.at(-1).content;
      assert.match(results[0].content, /src\/agent\.ts:4/);
      assert.match(results[1].content, /TODO: real strategy/);
      return toolUse([['r', 'submit_report', REPORT]]);
    },
  ];
  const events = [];
  const report = await runAnalysis({ ca: CA, mode: 'build', emit: (e, d) => events.push([e, d]), signal: new AbortController().signal });
  assert.equal(report.code.repo, 'agentx/core');
  assert.equal(report.code.inventory.secrets.length, 1);
  assert.ok(report.signals.some((s) => /hardcoded secret/.test(s.label)));
  assert.equal(events.filter(([e, d]) => e === 'step' && d.id === 'code').at(-1)[1].status, 'done');
  assert.ok(!events.some(([e]) => e === 'log'), 'nothing executed, no build logs');
});

test('no API key: automated checks only', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const events = [];
  const report = await runAnalysis({ ca: CA, mode: 'probe', emit: (e, d) => events.push([e, d]), signal: new AbortController().signal });
  assert.equal(report.analysis, null);
  assert.ok(report.signals.length > 0);
  assert.equal(events.filter(([e, d]) => e === 'step' && d.id === 'ai').at(-1)[1].status, 'skipped');
});

test('non-mint address fails with a clear message', async () => {
  await assert.rejects(runAnalysis({ ca: 'So11111111111111111111111111111111111111112', mode: 'probe', emit: () => {}, signal: new AbortController().signal }), /No account exists/);
});
