// test.it frontend — vanilla JS, no build step.
import { getWallets, onWallets, connect as connectWallet, disconnect as disconnectWallet, signAndSend } from './wallet.js';
// All project-supplied text is inserted with textContent (never innerHTML).

const $ = (sel) => document.querySelector(sel);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function safeLink(url, text) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw 0;
    return h('a', { href: u.toString(), target: '_blank', rel: 'noopener noreferrer' }, text ?? u.hostname + (u.pathname !== '/' ? u.pathname : ''));
  } catch {
    return h('span', {}, text ?? String(url));
  }
}

const compact = (n, prefix = '') =>
  n == null || Number.isNaN(n) ? '—' : prefix + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
const ago = (iso) => {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso)) / 86400000;
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h ago`;
  if (d < 60) return `${Math.round(d)}d ago`;
  if (d < 730) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
};

function openLightbox(src, caption) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = src;
  lb.querySelector('p').textContent = caption || '';
  lb.hidden = false;
}
$('#lightbox').addEventListener('click', () => ($('#lightbox').hidden = true));
document.addEventListener('keydown', (e) => e.key === 'Escape' && ($('#lightbox').hidden = true));

// ---------- health ----------
let health = null;
async function loadHealth() {
  try {
    const hs = await (await fetch('/api/health')).json();
    health = hs;
    const pay = hs.payments || {};
    document.querySelectorAll('.price').forEach((el) => {
      const usd = pay.prices?.[el.dataset.mode];
      el.textContent = pay.enabled && usd != null ? `$${usd.toFixed(2)}${pay.symbol ? ` in $${pay.symbol}` : ''}` : pay.enabled ? '' : 'free';
    });
    $('#wallet-btn').hidden = !pay.enabled;
    updateGoLabel();
    const chips = [
      [hs.anthropic ? 'ok' : 'warn', hs.anthropic ? `AI · ${hs.model}` : 'No Claude API key'],
      [hs.browser ? 'ok' : 'warn', hs.browser ? 'Browser ready' : 'No browser found'],
      [hs.github ? 'ok' : '', hs.github ? 'GitHub token' : 'GitHub: limited search'],
    ];
    $('#health').replaceChildren(...chips.map(([cls, label]) => h('span', { class: `chip ${cls}` }, label)));
  } catch {
    $('#health').replaceChildren(h('span', { class: 'chip warn' }, 'Server unreachable'));
  }
}

// ---------- form ----------
const form = $('#form');
const caInput = $('#ca');

function validateCa(v) {
  if (!v) return 'Paste a token contract address.';
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return 'That looks like an EVM address. test.it supports Solana tokens.';
  if (!B58.test(v)) return 'That is not a valid Solana address.';
  return '';
}

caInput.addEventListener('input', () => {
  caInput.classList.remove('invalid');
  $('#ca-hint').textContent = '';
});

$('#paste').addEventListener('click', async () => {
  try {
    caInput.value = (await navigator.clipboard.readText()).trim();
    caInput.dispatchEvent(new Event('input'));
  } catch {}
  caInput.focus();
});

const qs = new URLSearchParams(location.search);
if (qs.get('ca')) caInput.value = qs.get('ca');
if (['fast', 'build'].includes(qs.get('mode'))) document.querySelector(`input[value="${qs.get('mode')}"]`).checked = true;

let es = null;
let finished = false;
let lastReport = null;
const stepEls = new Map();
const feedEls = new Map();

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ca = caInput.value.trim();
  const err = validateCa(ca);
  if (err) {
    caInput.classList.add('invalid');
    $('#ca-hint').textContent = err;
    return;
  }
  payAndStart(ca, new FormData(form).get('mode'));
});

form.addEventListener('change', updateGoLabel);

// ---------- wallet + payment ----------
let conn = null;
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function updateGoLabel() {
  const pay = health?.payments;
  const mode = new FormData(form).get('mode');
  const usd = pay?.prices?.[mode];
  if ($('#go').disabled) return;
  $('#go').textContent = pay?.enabled && usd != null ? `Pay $${usd.toFixed(2)} & test` : 'Test it';
}

function payStatus(msg, cls = '') {
  const el = $('#pay-status');
  el.textContent = msg || '';
  el.className = `pay-status ${cls}`;
  el.hidden = !msg;
}

function renderWalletButton() {
  const btn = $('#wallet-btn');
  btn.textContent = conn ? short(conn.address) : 'Connect wallet';
  btn.classList.toggle('connected', Boolean(conn));
  btn.title = conn ? `${conn.wallet.name} · click to disconnect` : '';
}

function chooseWallet() {
  return new Promise((resolve, reject) => {
    const list = getWallets();
    const menu = $('#wallet-menu');
    const close = () => {
      menu.hidden = true;
      document.removeEventListener('click', outside, true);
    };
    const outside = (e) => {
      if (!menu.contains(e.target) && e.target !== $('#wallet-btn')) {
        close();
        reject(new Error('No wallet selected.'));
      }
    };
    if (list.length === 1) return resolve(list[0]);
    menu.replaceChildren(
      ...(list.length
        ? [h('p', {}, 'Choose a wallet'), ...list.map((w) => h('button', { type: 'button', onclick: () => { close(); resolve(w); } }, w.icon ? h('img', { src: w.icon, alt: '' }) : null, w.name))]
        : [h('p', {}, 'No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page.')])
    );
    menu.hidden = false;
    setTimeout(() => document.addEventListener('click', outside, true));
    if (!list.length) setTimeout(() => reject(new Error('No Solana wallet found. Install Phantom, Solflare or Backpack.')), 0);
  });
}

async function ensureWallet() {
  if (conn) return conn;
  const w = await chooseWallet();
  conn = await connectWallet(w);
  renderWalletButton();
  return conn;
}

$('#wallet-btn').addEventListener('click', async () => {
  if (conn) {
    await disconnectWallet(conn.wallet);
    conn = null;
    renderWalletButton();
    return;
  }
  try {
    await ensureWallet();
  } catch (e) {
    payStatus(e.message, 'err');
  }
});
onWallets(() => {});

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || `Request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return j;
}

function showRetry(label, fn) {
  const b = $('#retry');
  b.textContent = label;
  b.hidden = false;
  b.onclick = () => {
    b.hidden = true;
    fn();
  };
}

const PENDING_KEY = 'testit-paid-credit';
const savePending = (v) => { try { v ? sessionStorage.setItem(PENDING_KEY, JSON.stringify(v)) : sessionStorage.removeItem(PENDING_KEY); } catch {} };
const loadPending = () => { try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } };

async function verifyAndStart(quote, signature, ca, mode) {
  payStatus('Confirming your payment on Solana…');
  try {
    const { credit } = await postJson('/api/pay/verify', { quoteId: quote.quoteId, signature });
    savePending({ credit, ca, mode });
    payStatus('Payment confirmed.', 'ok');
    start(ca, mode, credit);
  } catch (e) {
    setBusy(false);
    payStatus(e.message, 'err');
    if (e.status === 408 || e.status >= 500) showRetry('Check payment again', () => { setBusy(true); verifyAndStart(quote, signature, ca, mode); });
  }
}

let busy = false;
function setBusy(on) {
  busy = on;
  $('#go').disabled = on;
  caInput.disabled = on;
  if (on) $('#go').textContent = 'Waiting…';
  else updateGoLabel();
}

async function payAndStart(ca, mode) {
  $('#retry').hidden = true;
  showError('');
  const pay = health?.payments;
  if (!pay?.enabled) return start(ca, mode);
  if (!pay.configured) return payStatus('Payments are not set up on this server yet.', 'err');
  const pending = loadPending();
  if (pending && pending.ca === ca && pending.mode === mode) {
    payStatus('Using your earlier payment for this test.', 'ok');
    return start(ca, mode, pending.credit);
  }
  setBusy(true);
  try {
    await ensureWallet();
    payStatus('Getting the current price…');
    const quote = await postJson('/api/quote', { ca, mode, payer: conn.address });
    payStatus(`Approve ${quote.amount} $${quote.symbol} (≈ $${quote.usd.toFixed(2)}) in your wallet…`);
    let signature;
    try {
      signature = await signAndSend(conn, quote.transaction);
    } catch (e) {
      throw new Error(/reject|denied|cancel/i.test(e.message || '') ? 'Payment cancelled in your wallet. You were not charged.' : `Wallet error: ${e.message || e}`);
    }
    await verifyAndStart(quote, signature, ca, mode);
  } catch (e) {
    setBusy(false);
    payStatus(e.message, 'err');
  }
}

$('#cancel').addEventListener('click', () => {
  finished = true;
  es?.close();
  setRunning(false);
  showError('Cancelled.');
});

function setRunning(on) {
  $('#go').disabled = on;
  $('#cancel').hidden = !on;
  caInput.disabled = on;
  if (on) $('#go').textContent = 'Testing…';
  else updateGoLabel();
}

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').hidden = !msg;
}

function start(ca, mode, credit) {
  finished = false;
  lastReport = null;
  stepEls.clear();
  feedEls.clear();
  showError('');
  $('#report').hidden = true;
  $('#report').replaceChildren();
  $('#steps').replaceChildren();
  $('#feed').replaceChildren(h('li', { class: 'feed-empty' }, 'Every action the AI takes shows up here once it starts testing.'));
  $('#feed-count').textContent = '';
  $('#run').hidden = false;
  setRunning(true);
  history.replaceState(null, '', `?ca=${encodeURIComponent(ca)}&mode=${mode}`);

  es = new EventSource(`/api/analyze?ca=${encodeURIComponent(ca)}&mode=${encodeURIComponent(mode)}${credit ? `&credit=${encodeURIComponent(credit)}` : ''}`);
  es.addEventListener('step', (e) => renderStep(JSON.parse(e.data)));
  es.addEventListener('action', (e) => renderAction(JSON.parse(e.data)));
  es.addEventListener('report', (e) => {
    finished = true;
    es.close();
    setRunning(false);
    lastReport = JSON.parse(e.data);
    savePending(null);
    payStatus('');
    renderReport(lastReport);
  });
  es.addEventListener('fail', (e) => {
    finished = true;
    es.close();
    setRunning(false);
    const f = JSON.parse(e.data);
    if (f.refunded && credit) {
      showError(`${f.message} Your payment was not used, so you can try again without paying.`);
      showRetry('Try again (already paid)', () => start(ca, mode, credit));
    } else {
      if (credit && /already been used|not found/i.test(f.message)) savePending(null);
      showError(f.message);
    }
  });
  es.onerror = () => {
    if (finished) return;
    finished = true;
    es.close();
    setRunning(false);
    showError('Lost connection to the test.it server.');
  };
}

const ICONS = { done: '✓', error: '!', skipped: '–', running: '' };

function renderStep(s) {
  let el = stepEls.get(s.id);
  if (!el) {
    el = h('li', { class: 'step' }, h('span', { class: 'step-icon' }), h('div', {}, h('div', { class: 'step-label' }), h('div', { class: 'step-detail' })));
    stepEls.set(s.id, el);
    $('#steps').append(el);
  }
  el.className = `step ${s.status}`;
  el.querySelector('.step-icon').textContent = ICONS[s.status] ?? '';
  el.querySelector('.step-label').textContent = s.label;
  if (s.detail !== undefined) el.querySelector('.step-detail').textContent = s.detail || '';
}

function statusBadge(st) {
  if (st === 'pending') return h('span', { class: 'status pending' }, '…');
  if (st === 'error') return h('span', { class: 'status err' }, 'ERR');
  if (typeof st === 'number') return h('span', { class: `status s${String(st)[0]}` }, st);
  if (typeof st === 'string' && st.startsWith('exit')) return h('span', { class: 'status s4' }, st);
  return h('span', { class: 'status s2' }, 'ok');
}

const TOOL_LABEL = { http_request: 'http', inspect_asset: 'js', code: 'code', browser: 'browser', github: 'github', web_search: 'search', solana_rpc: 'chain', };

function renderAction(a) {
  const feed = $('#feed');
  feed.querySelector('.feed-empty')?.remove();
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  if (a.type === 'thought') {
    feed.append(h('li', { class: 'feed-item thought' }, a.text));
  } else if (a.type === 'tool') {
    const tag = TOOL_LABEL[a.tool] || a.tool;
    const img = a.image ? `data:image/jpeg;base64,${a.image}` : null;
    const item = h(
      'li',
      { class: 'feed-item' },
      h('div', { class: 'req' }, statusBadge(a.status), h('span', { class: `tool-tag ${tag}` }, tag), h('span', { class: 'req-url' }, a.summary), a.ms != null ? h('span', { class: 'muted' }, a.ms > 1500 ? `${(a.ms / 1000).toFixed(1)}s` : `${a.ms}ms`) : null),
      a.reason || a.detail ? h('div', { class: 'req-reason' }, [a.reason, a.status === 'error' ? a.detail : a.detail && a.tool !== 'browser' ? a.detail : null].filter(Boolean).join(' — ')) : null,
      img ? h('img', { class: 'thumb', src: img, alt: 'Screenshot', onclick: () => openLightbox(img, a.summary) }) : null
    );
    const prev = feedEls.get(a.id);
    if (prev) prev.replaceWith(item);
    else feed.append(item);
    feedEls.set(a.id, item);
    $('#feed-count').textContent = `(${feedEls.size})`;
  }
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

// ---------- report ----------
const VERDICT_LABEL = { WORKS: 'Works', PARTIALLY_WORKS: 'Partially works', DOES_NOT_WORK: "Doesn't work", UNVERIFIABLE: 'Unverifiable', NONE: 'No AI verdict' };
const VERDICT_COLOR = { WORKS: 'green', DOES_NOT_WORK: 'red', PARTIALLY_WORKS: 'yellow', UNVERIFIABLE: 'muted', NONE: 'muted' };

const card = (title, ...body) => h('div', { class: 'card' }, h('h3', {}, title), ...body);
const facts = (rows) => h('dl', { class: 'facts' }, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v ?? '—'))));
const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));

function renderReport(r) {
  const a = r.analysis;
  const t = r.token || {};
  const verdict = a?.verdict || 'NONE';
  const out = [];

  out.push(
    h('div', { class: `verdict v-${verdict}` },
      h('div', { class: 'stamp' }, VERDICT_LABEL[verdict], a ? h('small', {}, `${a.confidence}% confidence`) : null),
      h('div', {},
        h('p', { class: 'headline' }, a?.headline || 'AI testing was skipped. Automated checks are below; add ANTHROPIC_API_KEY to .env for a verdict.'),
        a?.project_summary ? h('p', { class: 'summary' }, a.project_summary) : null,
        a ? h('div', { style: `color: var(--${VERDICT_COLOR[verdict]})` },
          h('div', { class: 'meter' }, h('span', { style: `width:${a.confidence}%` })),
          h('div', { class: 'meter-label' }, `${a.toolCalls ?? 0} tests · ${r.mode} mode · ${a.model || ''}`)) : null)
    )
  );

  // Screenshots
  if (r.screenshots?.length) {
    out.push(card('What the app looks like',
      h('div', { class: 'shots' }, r.screenshots.map((s) => {
        const src = `data:image/jpeg;base64,${s.data}`;
        return h('figure', { class: 'shot' }, h('img', { src, alt: s.label || 'Screenshot', loading: 'lazy', onclick: () => openLightbox(src, s.url) }), h('figcaption', {}, s.label && !s.label.startsWith('open ') ? `${s.label} · ` : '', s.url));
      }))));
  }

  // Trying it as a user
  if (a?.user_experience) out.push(card('Trying it as a user', h('p', { class: 'prose' }, a.user_experience)));

  // Claims
  if (a?.claimed_tech?.length) {
    out.push(card('Claimed tech vs. what we found',
      h('div', { class: 'claims' }, a.claimed_tech.map((c) =>
        h('div', { class: 'claim' },
          h('div', { class: 'claim-top' }, h('div', { class: 'claim-text' }, c.claim), h('span', { class: `pill p-${c.status}` }, c.status)),
          h('div', { class: 'claim-evidence' }, c.evidence),
          c.how_tested ? h('div', { class: 'claim-how' }, `Tested: ${c.how_tested}`) : null)))));
  }

  // Project + flags
  const tokenCard = card('Project',
    h('div', { class: 'token-head' },
      t.image && /^https?:/.test(t.image) ? h('img', { class: 'token-img', src: t.image, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
      h('div', {}, h('div', { class: 'token-name' }, `${t.name || 'Unknown token'}${t.symbol ? ` · $${t.symbol}` : ''}`), h('div', { class: 'token-ca' }, r.ca))),
    t.description ? h('p', { class: 'small muted', style: 'margin:0 0 12px' }, t.description.slice(0, 400)) : null,
    h('p', { class: 'small', style: 'margin:0' }, safeLink(`https://pump.fun/coin/${r.ca}`, 'View on pump.fun ↗')));

  const order = ['red', 'yellow', 'green'];
  const flags = [
    ...(a?.red_flags || []).map((x) => ({ level: 'red', label: x, src: 'AI' })),
    ...(a?.green_flags || []).map((x) => ({ level: 'green', label: x, src: 'AI' })),
    ...(r.signals || []).map((s) => ({ ...s, src: 'check' })),
  ].sort((x, y) => order.indexOf(x.level) - order.indexOf(y.level));
  const flagCard = card('Flags',
    flags.length ? h('ul', { class: 'flags' }, flags.map((f) => h('li', {}, h('span', { class: `dot ${f.level}` }), h('div', {}, h('span', {}, f.label), h('span', { class: 'flag-src' }, f.src), f.detail ? h('div', { class: 'flag-detail' }, f.detail) : null)))) : h('p', { class: 'muted' }, 'No flags.'));
  out.push(h('div', { class: 'grid-2' }, tokenCard, flagCard));

  // Tests performed
  if (a?.tests_performed?.length || a?.untested) {
    out.push(card('Tests performed',
      a.tests_performed?.length ? h('ul', { class: 'tests' }, a.tests_performed.map((x) => h('li', {}, h('span', { class: `pill p-${x.outcome}` }, x.outcome), h('div', {}, h('div', {}, x.description), x.details ? h('div', { class: 'details' }, x.details) : null)))) : null,
      a.untested ? h('div', {}, h('div', { class: 'sub' }, 'Could not test'), h('p', { class: 'small muted', style: 'margin:0' }, a.untested)) : null));
  }

  // Source code
  const repos = (r.github || []).filter(Boolean);
  const cands = r.candidates || [];
  if (a?.source_code || repos.length || cands.length) {
    out.push(card('Source code',
      a?.source_code ? h('p', { class: 'prose', style: 'margin-bottom:12px' }, a.source_code) : null,
      repos.map((g) => g.error
        ? h('div', { class: 'repo' }, h('div', { class: 'repo-name' }, g.ref), h('div', { class: 'repo-desc bad' }, g.error))
        : h('div', { class: 'repo' },
          h('div', { class: 'repo-name' }, safeLink(g.url, g.fullName), g.candidate ? h('span', { class: 'pill p-PARTIAL', style: 'margin-left:8px' }, 'found by search') : null, g.fork ? h('span', { class: 'pill p-FAILED', style: 'margin-left:8px' }, 'fork') : null),
          g.description ? h('div', { class: 'repo-desc' }, g.description) : null,
          g.candidateReasons ? h('div', { class: 'repo-desc' }, `Why: ${g.candidateReasons.join('; ')}`) : null,
          facts([['Commits', g.commitsCapped ? '100+' : g.commitsSampled], ['Contributors', g.contributors], ['Stars', g.stars?.toLocaleString()], ['Last push', ago(g.pushedAt)], ['Created', g.createdAt?.slice(0, 10)], ['Language', Object.keys(g.languages || {}).slice(0, 3).join(', ') || '—']]))),
      cands.length ? h('div', {}, h('div', { class: 'sub' }, 'Repos found by searching'), cands.slice(0, 8).map((c) => h('div', { class: 'cand' }, h('span', { class: `score ${c.score >= 6 ? 'hi' : ''}` }, c.score), safeLink(c.url || `https://github.com/${c.fullName}`, c.fullName), h('span', { class: 'muted small' }, c.reasons.join('; '))))) : null));
  }

  // App internals (render + bundle scan)
  const rendered = r.render || [];
  const bundle = r.bundles;
  if (rendered.length || bundle) {
    const apiCalls = rendered.flatMap((p) => p.apiCalls || []);
    out.push(card("Under the hood of the app",
      bundle?.sdks?.length ? h('div', {}, h('div', { class: 'sub' }, 'Services & SDKs found in its code'), h('div', { class: 'tags' }, bundle.sdks.map((s) => h('span', { class: `tag ${/Mock/.test(s) ? 'bad' : ''}` }, s)))) : null,
      bundle?.backendHosts?.length ? h('div', {}, h('div', { class: 'sub' }, 'Backend hosts it talks to'), h('div', { class: 'tags' }, bundle.backendHosts.slice(0, 16).map((s) => h('span', { class: 'tag' }, s)))) : null,
      bundle?.apiPaths?.length ? h('div', {}, h('div', { class: 'sub' }, 'API routes in its JavaScript'), h('div', { class: 'tags' }, bundle.apiPaths.slice(0, 24).map((s) => h('span', { class: 'tag' }, s)))) : null,
      apiCalls.length ? h('div', {}, h('div', { class: 'sub' }, 'Live API calls when the app loaded'), h('table', { class: 'pages' }, h('tbody', {}, apiCalls.slice(0, 20).map((c) => h('tr', {}, h('td', { style: 'width:60px' }, statusBadge(c.failed ? 'error' : c.status || 'pending')), h('td', { style: 'width:50px' }, h('span', { class: 'method' }, c.method)), h('td', { class: 'u' }, c.url)))))) : null,
      bundle?.solanaAddresses?.length ? h('div', {}, h('div', { class: 'sub' }, 'Solana addresses in its code'), h('div', { class: 'tags' }, bundle.solanaAddresses.slice(0, 10).map((s) => h('span', { class: 'tag' }, s)))) : null));
  }

  // Code analysis (Build mode)
  if (r.code) out.push(renderCode(r.code));

  // Links + pages
  const L = r.links || {};
  const groups = [['Website', L.websites], ['App', L.app], ['Docs', L.docs], ['Whitepaper', L.whitepaper], ['GitHub', L.github], ['X / Twitter', L.twitter], ['Telegram', L.telegram], ['Discord', L.discord]].filter(([, v]) => v?.length);
  const pages = [...(r.site ? [{ ...r.site }] : []), ...(r.crawl || [])];
  out.push(h('div', { class: 'grid-2' },
    card('Links found', groups.length ? groups.map(([label, urls]) => h('div', { class: 'linkgroup' }, h('div', { class: 'linkgroup-label' }, label), h('div', { class: 'linklist' }, [...new Set(urls)].slice(0, 8).map((u) => safeLink(u))))) : h('p', { class: 'muted' }, 'No project links were found.')),
    card('Pages fetched', pages.length ? h('table', { class: 'pages' }, h('tbody', {}, pages.map((p) => h('tr', {}, h('td', { style: 'width:56px' }, statusBadge(p.error ? 'error' : p.status)), h('td', { class: 'u' }, safeLink(p.url, p.url)), h('td', { class: 'muted' }, p.error || p.title || ''))))) : h('p', { class: 'muted' }, 'None.'))));

  out.push(h('div', { class: 'report-actions' },
    h('button', { class: 'ghost', type: 'button', onclick: downloadReport }, 'Download JSON'),
    h('button', { class: 'ghost', type: 'button', onclick: () => navigator.clipboard?.writeText(location.href) }, 'Copy link to rerun'),
    h('span', { class: 'small muted', style: 'align-self:center' }, `Generated ${new Date(r.generatedAt).toLocaleString()}`)));

  const el = $('#report');
  el.replaceChildren(...out);
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCode(c) {
  if (c.skipped) return card('Code analysis', h('p', { class: 'muted', style: 'margin:0' }, c.reason));
  const inv = c.inventory || {};
  const tags = [...Object.keys(inv.ai || {}), ...Object.keys(inv.solana || {}), ...Object.keys(inv.services || {})];
  const deps = [...new Set((inv.packages || []).flatMap((p) => p.notableDeps || []).concat(inv.pythonDeps || []))];
  return card('Code analysis',
    h('p', { class: 'small muted', style: 'margin-top:0' }, `${c.repo}${c.candidate ? ' (found by search)' : ''} · ${c.branch || 'default branch'} · read-only, never executed`),
    kv([
      ['Lines of code', inv.codeLines?.toLocaleString()],
      ['Code files', inv.codeFiles],
      ['Total files', inv.totalFiles],
      ['Languages', Object.keys(inv.languages || {}).filter((l) => !['JSON', 'Markdown', 'YAML', 'TOML'].includes(l)).slice(0, 4).join(', ')],
      ['Mock/TODO markers', inv.placeholderHits],
      ['Hardcoded secrets', inv.secrets?.length ? h('span', { class: 'bad' }, inv.secrets.length) : 0],
    ]),
    tags.length ? h('div', {}, h('div', { class: 'sub' }, 'Uses'), h('div', { class: 'tags' }, tags.map((k) => h('span', { class: 'tag' }, k)))) : null,
    deps.length ? h('div', {}, h('div', { class: 'sub' }, 'Notable dependencies'), h('div', { class: 'tags' }, deps.slice(0, 24).map((k) => h('span', { class: 'tag' }, k)))) : null,
    inv.programIds?.length ? h('div', {}, h('div', { class: 'sub' }, 'Solana program IDs in the code'), h('div', { class: 'tags' }, inv.programIds.map((k) => h('span', { class: 'tag' }, k)))) : null,
    inv.secrets?.length ? h('div', {}, h('div', { class: 'sub' }, 'Leaked secrets'), h('p', { class: 'small bad', style: 'margin:0' }, inv.secrets.map((s) => `${s.kind}: ${s.file}:${s.line}`).join(' · '))) : null,
    inv.placeholderFiles?.length ? h('div', {}, h('div', { class: 'sub' }, 'Most mock/TODO markers'), h('div', { class: 'tags' }, inv.placeholderFiles.slice(0, 6).map((f) => h('span', { class: 'tag' }, `${f.file} (${f.count})`)))) : null);
}

function downloadReport() {
  if (!lastReport) return;
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
  const link = h('a', { href: URL.createObjectURL(blob), download: `test.it-${lastReport.token?.symbol || lastReport.ca.slice(0, 6)}-${lastReport.mode}.json` });
  document.body.append(link);
  link.click();
  link.remove();
}

loadHealth();
