// HTML parsing and link discovery: turn a pile of URLs into websites, GitHub
// repos, docs, whitepapers, app pages and socials. Dependency-free on purpose.

const URL_RE = /https?:\/\/[^\s"'<>)\]\\]+/g;
const NOISE_HOSTS = [
  'dexscreener.com', 'pump.fun', 'solscan.io', 'birdeye.so', 'jup.ag', 'raydium.io', 'coingecko.com',
  'coinmarketcap.com', 'dextools.io', 'geckoterminal.com', 'photon-sol.tinyastro.io', 'bullx.io',
  'gmgn.ai', 'solana.fm', 'explorer.solana.com', 'rugcheck.xyz', 'meteora.ag', 'orca.so', 'moonshot.money',
  'ipfs.io', 'arweave.net', 'cf-ipfs.com', 'fonts.googleapis.com', 'googletagmanager.com', 'google.com',
  'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'linkedin.com', 'medium.com',
  'apple.com', 'play.google.com', 'w3.org', 'schema.org',
];

export function extractUrls(text = '') {
  return (String(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?'"]+$/, ''));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
}

export function parseHtml(html, baseUrl) {
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  let metaDesc = '';
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    if (key === 'description' || (key === 'og:description' && !metaDesc)) metaDesc = attr(tag, 'content') || metaDesc;
  }
  const links = new Set();
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol.startsWith('http')) {
        u.hash = '';
        links.add(u.toString());
      }
    } catch {}
  }
  // URLs also hide outside anchors (JS config, JSON-LD, buttons with onclick)
  for (const u of extractUrls(html)) {
    if (/github\.com|gitbook|docs\.|whitepaper|litepaper|t\.me\/|x\.com\/|twitter\.com\//i.test(u)) links.add(u);
  }
  const scriptCount = (html.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length;
  const scripts = [];
  for (const tag of html.match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi) || []) {
    const src = attr(tag, 'src');
    try {
      if (src) scripts.push(new URL(src, baseUrl).toString());
    } catch {}
  }
  for (const tag of html.match(/<link\b[^>]*rel\s*=\s*["']?(?:modulepreload|preload)[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    try {
      if (href && /\.m?js(\?|$)/.test(href)) scripts.push(new URL(href, baseUrl).toString());
    } catch {}
  }
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const headings = [...stripped.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/gi)].map((m) => clean(m[1])).filter(Boolean).slice(0, 40);
  const body = stripped.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? stripped;
  const text = clean(body.replace(/<\/(p|div|li|h\d|br|tr|section|article)\s*>/gi, ' . ').replace(/(\s\.)+/g, ' .'));
  return { title, metaDesc: clean(metaDesc), headings, text, links: [...links], scripts: [...new Set(scripts)], scriptCount, looksLikeSpa: text.length < 300 && scriptCount > 0 };
}

// What a site's JavaScript bundle reveals: repos, backend hosts, API routes,
// SDKs/services it uses, and Solana addresses baked into the code.
const SDK_MARKERS = {
  Hyperliquid: /hyperliquid/i,
  OpenAI: /api\.openai\.com|["']openai["']|dangerouslyAllowBrowser/i,
  Anthropic: /api\.anthropic\.com|anthropic-version/i,
  'Google Gemini': /generativelanguage\.googleapis\.com/i,
  'Other LLM APIs': /api\.groq\.com|openrouter\.ai|api\.together\.xyz|api\.mistral\.ai|api\.deepseek\.com/i,
  'Solana RPC': /mainnet-beta\.solana\.com|helius-rpc\.com|quiknode\.pro|rpcpool\.com|solana-mainnet/i,
  'Solana wallet adapter': /wallet-adapter|WalletMultiButton|phantom\.app/i,
  Jupiter: /jup\.ag|quote-api|lite-api\.jup/i,
  'Pump.fun': /pump\.fun|pumpportal/i,
  Privy: /privy\.io|auth\.privy/i,
  'Dynamic.xyz': /dynamic\.xyz|dynamicauth/i,
  'X OAuth': /twitter\.com\/i\/oauth2|x\.com\/i\/oauth2|api\.twitter\.com\/oauth|api\.x\.com\/2\/oauth2/i,
  Supabase: /supabase\.co/i,
  Firebase: /firebaseio\.com|firebaseapp\.com/i,
  Stripe: /js\.stripe\.com|api\.stripe\.com/i,
  'EVM (ethers/viem/wagmi)': /wagmi|viem\/|ethers\.js|JsonRpcProvider/i,
  'Mock / demo data': /mockData|MOCK_|fakeData|dummyData|demoData|isDemo\b|generateFake/i,
};

export function scanBundle(text, siteHost) {
  const urls = extractUrls(text);
  const githubLinks = [...new Set(urls.filter((u) => /github\.com\/[\w.-]+\/?[\w.-]*/i.test(u)).map((u) => u.replace(/[\\`]+$/, '')))].slice(0, 15);
  const hostCounts = {};
  for (const u of urls) {
    const h = hostOf(u);
    if (!h || isNoise(u) || /w3\.org|reactjs\.org|github\.com|mozilla\.org|npmjs|sentry|googleapis\.com\/css|jsdelivr|unpkg|cloudflare\.com\/ajax/.test(h)) continue;
    hostCounts[h] = (hostCounts[h] || 0) + 1;
  }
  const apiPaths = new Set();
  for (const m of text.matchAll(/["'`](\/(?:api|v\d|rpc|graphql|trpc|ws|socket|auth|oauth)[A-Za-z0-9_\-/{}:.$]*)["'`]/g)) {
    if (m[1].length < 80) apiPaths.add(m[1]);
    if (apiPaths.size >= 60) break;
  }
  const apiUrls = new Set(urls.filter((u) => /\/(api|v\d|rpc|graphql|trpc)(\/|$)|^https?:\/\/api\./i.test(u) && !isNoise(u)).slice(0, 40));
  const sdks = Object.entries(SDK_MARKERS).filter(([, re]) => re.test(text)).map(([k]) => k);
  const pubkeys = new Set();
  for (const m of text.matchAll(/["'`]([1-9A-HJ-NP-Za-km-z]{32,44})["'`]/g)) {
    if (/^[1-9A-HJ-NP-Za-km-z]*\d[1-9A-HJ-NP-Za-km-z]*$/.test(m[1]) && /[A-Z]/.test(m[1]) && /[a-z]/.test(m[1])) pubkeys.add(m[1]);
    if (pubkeys.size >= 25) break;
  }
  const envKeys = new Set();
  for (const m of text.matchAll(/\b((?:NEXT_PUBLIC|VITE|REACT_APP)_[A-Z0-9_]+)/g)) {
    envKeys.add(m[1]);
    if (envKeys.size >= 30) break;
  }
  return {
    githubLinks,
    backendHosts: Object.entries(hostCounts).filter(([h]) => h !== siteHost).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([h]) => h),
    apiPaths: [...apiPaths],
    apiUrls: [...apiUrls],
    sdks,
    solanaAddresses: [...pubkeys],
    publicEnvKeys: [...envKeys],
  };
}

export function mergeScans(scans) {
  const out = { githubLinks: [], backendHosts: [], apiPaths: [], apiUrls: [], sdks: [], solanaAddresses: [], publicEnvKeys: [] };
  for (const s of scans) for (const k of Object.keys(out)) out[k].push(...(s[k] || []));
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 60);
  return out;
}

export function findMatches(text, patterns, maxMatches = 40, context = 140) {
  const out = [];
  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p, 'gi');
    } catch {
      re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }
    let count = 0;
    for (const m of text.matchAll(re)) {
      const s = Math.max(0, m.index - context);
      out.push({ pattern: p, match: m[0].slice(0, 120), context: text.slice(s, m.index + m[0].length + context).replace(/\s+/g, ' ') });
      if (++count >= Math.ceil(maxMatches / patterns.length) || out.length >= maxMatches) break;
    }
  }
  return out;
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function rootDomain(host) {
  const parts = host.split('.');
  const sld = parts.at(-2);
  // co.uk-style second-level domains
  if (parts.length > 2 && ['co', 'com', 'net', 'org', 'gov', 'ac'].includes(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function isNoise(u) {
  const h = hostOf(u);
  return !h || NOISE_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

export function classifyLinks(urls, siteUrl) {
  const siteRoot = siteUrl ? rootDomain(hostOf(siteUrl) || '') : null;
  const out = { github: [], twitter: [], telegram: [], discord: [], docs: [], whitepaper: [], app: [], internal: [] };
  const seen = new Set();
  for (const raw of urls) {
    let u;
    try {
      const x = new URL(raw);
      x.hash = '';
      u = x.toString();
    } catch {
      continue;
    }
    if (seen.has(u)) continue;
    seen.add(u);
    const host = hostOf(u);
    const path = new URL(u).pathname;
    if (host === 'github.com' || host === 'gitlab.com') out.github.push(u);
    else if (host === 'x.com' || host === 'twitter.com') out.twitter.push(u);
    else if (host === 't.me' || host === 'telegram.me') out.telegram.push(u);
    else if (host.endsWith('discord.gg') || host === 'discord.com') out.discord.push(u);
    else if (isNoise(u)) continue;
    else if (/whitepaper|litepaper|\.pdf($|\?)/i.test(u)) out.whitepaper.push(u);
    else if (/^docs?\./.test(host) || host.endsWith('gitbook.io') || host.endsWith('mintlify.app') || /\/docs?(\/|$)/i.test(path)) out.docs.push(u);
    else if (/^(app|dapp|beta|demo|platform|console|dashboard|play|agent|chat)\./.test(host) || /^\/(app|dapp|demo|launch|dashboard|playground|try|chat|agent)(\/|$)/i.test(path)) out.app.push(u);
    else if (siteRoot && rootDomain(host) === siteRoot) out.internal.push(u);
  }
  return out;
}

const INTERESTING_PATH = /about|tech|product|how|api|roadmap|feature|platform|solution|model|agent|protocol|developer|sdk/i;

export function pickCrawlTargets(links, homeUrl, limit = 6) {
  const home = homeUrl ? homeUrl.replace(/\/$/, '') : null;
  const ordered = [
    ...links.app,
    ...links.docs.slice(0, 3),
    ...links.whitepaper.slice(0, 2),
    ...links.internal.filter((u) => INTERESTING_PATH.test(new URL(u).pathname)),
  ];
  const out = [];
  for (const u of ordered) {
    if (u.replace(/\/$/, '') === home || out.includes(u)) continue;
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}
