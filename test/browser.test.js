// Tests the CDP browser against a local fake "app" (hostnames mapped to localhost).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { findBrowser } from '../server/browser.js';

const APP = `<!doctype html><html><head><title>Fake Perps</title></head><body><div id="root"></div>
<script>
  const root = document.getElementById('root');
  root.innerHTML = '<h1>Trade perps</h1><input placeholder="Search market"><button id="go">Load markets</button><button>Sign in with X</button><ul id="list"></ul>';
  document.getElementById('go').onclick = async () => {
    const r = await fetch('/api/markets'); const j = await r.json();
    document.getElementById('list').innerHTML = j.markets.map(m => '<li>' + m + '</li>').join('');
  };
  fetch('http://10.1.2.3/steal').catch(() => {});
</script></body></html>`;

let port;
const server = http.createServer((req, res) => {
  if (req.url === '/api/markets') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ markets: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'] }));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(APP);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;

// The app hostname resolves (for our guard) to a public IP, but Chrome is told to map it to localhost.
dns.lookup = async (host) => (host === 'app.fakeperps.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.1.2.3', family: 4 }]);
process.env.TESTIT_BROWSER_ARGS = `--host-resolver-rules=MAP app.fakeperps.example 127.0.0.1:${port}`;

const { BrowserSession } = await import('../server/browser.js');
const skip = findBrowser() ? false : 'no Chrome/Chromium on this machine';
let b;
after(() => {
  b?.close();
  server.close();
});

test('browser renders a JS app, clicks, types, captures API calls and screenshots', { skip }, async () => {
  b = await BrowserSession.launch();
  const page = await b.open('http://app.fakeperps.example/');
  assert.equal(page.title, 'Fake Perps');
  assert.match(page.text, /Trade perps/);
  assert.ok(page.controls.some((c) => c.text === 'Sign in with X'));
  assert.ok(b.blocked.some((u) => u.includes('10.1.2.3')), 'private-IP request must be blocked');

  const clicked = await b.click('Load markets');
  assert.match(clicked.text, /SOL-PERP/);
  assert.ok(clicked.apiCalls.some((c) => c.url.endsWith('/api/markets') && c.status === 200));

  const typed = await b.type('Search market', 'SOL');
  assert.match(typed.typedInto, /input/);
  assert.equal(await b.evaluate('document.querySelector("input").value'), 'SOL');

  const bodies = await b.responseBodies();
  assert.ok(bodies.some((x) => x.body.includes('BTC-PERP')));

  const shot = await b.screenshot('home');
  assert.ok(shot.data.length > 1000);
  await assert.rejects(b.open('http://127.0.0.1:1/'), /non-public/);
});
