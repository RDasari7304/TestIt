// Orchestrates one investigation and streams progress through `emit`.
import { getMintInfo, getOnchainMetadata } from './solana.js';
import { safeFetch } from './net.js';
import { parseHtml, extractUrls, classifyLinks, pickCrawlTargets, isNoise, scanBundle, mergeScans } from './discover.js';
import { inspectRepo, uniqueRepoRefs, findCandidateRepos } from './github.js';
import { webSearch } from './search.js';
import { BrowserSession, findBrowser } from './browser.js';
import { downloadRepo, analyzeCode } from './code.js';
import { computeSignals, summarizeToken } from './signals.js';
import { analyzeWithClaude } from './analyze.js';

function initialLinks(d) {
  const j = d.chain?.metadata?.json || {};
  const ext = j.extensions || j.properties?.links || {};
  const add = d.chain?.metadata?.additional || [];
  const websites = [j.website, j.external_url, ext.website]
    .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u) && !isNoise(u));
  const others = [
    j.twitter, j.telegram, j.discord, j.github, ext.twitter, ext.telegram, ext.discord, ext.github,
    ...add.map((kv) => kv?.[1]),
    ...extractUrls(d.chain?.metadata?.description),
  ].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  const fromDesc = extractUrls(d.chain?.metadata?.description).filter((u) => !isNoise(u) && !/x\.com|twitter|t\.me|github/.test(u));
  return { websites: [...new Set([...websites, ...fromDesc])], others };
}

export async function runAnalysis({ ca, mode, emit, signal, onBillable, onCost }) {
  const actions = new Map();
  const step = async (id, label, fn, { skip, fatal } = {}) => {
    if (skip) {
      emit('step', { id, label, status: 'skipped', detail: skip });
      return null;
    }
    let detail;
    const note = (msg) => {
      detail = msg;
      emit('step', { id, label, status: 'running', detail: msg });
    };
    emit('step', { id, label, status: 'running' });
    try {
      const result = await fn(note);
      emit('step', { id, label, status: 'done', detail });
      return result;
    } catch (e) {
      if (signal.aborted) throw e;
      emit('step', { id, label, status: 'error', detail: e.message });
      if (fatal) throw e;
      return null;
    }
  };

  // Shared, lazily-started browser; always cleaned up.
  let browser = null;
  let browserError = null;
  const getBrowser = async () => {
    if (browser || browserError) return browser;
    try {
      browser = await BrowserSession.launch({ signal });
    } catch (e) {
      browserError = e.message;
    }
    return browser;
  };
  let archive = null;

  try {
    const d = { ca, mode, collectedAt: new Date().toISOString() };

    d.chain = await step('chain', 'Reading the token and its project links', async (note) => {
      const mint = await getMintInfo(ca, signal);
      if (!mint.exists) throw new Error('No account exists at this address on Solana mainnet.');
      if (!mint.isMint) throw new Error(`This address is not a token mint (it is owned by program ${mint.owner}).`);
      const metadata = await getOnchainMetadata(ca, mint, signal).catch((e) => ({ error: e.message }));
      note(`${metadata?.name || 'Unnamed token'}${metadata?.symbol ? ` ($${metadata.symbol})` : ''}`);
      const image = metadata?.json?.image;
      emit('meta', { name: metadata?.name || metadata?.json?.name || null, symbol: metadata?.symbol || metadata?.json?.symbol || null, image: typeof image === 'string' && /^https:\/\//.test(image) ? image : null });
      return { program: mint.program, metadata };
    }, { fatal: true });

    const seed = initialLinks(d);
    d.site = await step('site', 'Reading the project website', async (note) => {
      for (const home of seed.websites.slice(0, 3)) {
        try {
          const r = await safeFetch(home, { signal });
          const html = r.contentType.includes('html');
          const p = html ? parseHtml(r.text, r.url) : { title: '', metaDesc: '', headings: [], text: r.text, links: [], scripts: [], looksLikeSpa: false };
          note(`HTTP ${r.status} · ${new URL(r.url).hostname}${p.looksLikeSpa ? ' · JS-rendered app' : ''}`);
          return { listedUrl: home, url: r.url, status: r.status, ms: r.ms, title: p.title, metaDesc: p.metaDesc, headings: p.headings, text: p.text.slice(0, 15000), textLength: p.text.length, looksLikeSpa: p.looksLikeSpa, links: p.links.slice(0, 200), scripts: p.scripts };
        } catch (e) {
          note(`${home}: ${e.message}`);
        }
      }
      if (!seed.websites.length) note('No website listed in the token metadata');
      return null;
    });

    d.bundles = await step('bundles', "Reading the site's JavaScript", async (note) => {
      const siteHost = d.site ? new URL(d.site.url).host : '';
      const scripts = (d.site?.scripts || []).filter((u) => !isNoise(u) && !/googletagmanager|google-analytics|gtag|hotjar|segment|intercom|crisp|cloudflareinsights|clarity\.ms/.test(u)).slice(0, 8);
      if (!scripts.length) {
        note('No site scripts to scan');
        return null;
      }
      const files = [];
      const scans = [];
      for (const u of scripts) {
        try {
          const r = await safeFetch(u, { signal, maxBytes: 10_000_000, timeoutMs: 25000 });
          scans.push(scanBundle(r.text, siteHost));
          files.push({ url: r.url, kb: Math.round(r.bytes / 1024), status: r.status });
        } catch (e) {
          files.push({ url: u, error: e.message });
        }
      }
      const summary = mergeScans(scans);
      note(`${files.length} files · ${summary.apiPaths.length + summary.apiUrls.length} API routes · ${summary.backendHosts.length} backend hosts${summary.sdks.length ? ` · ${summary.sdks.slice(0, 4).join(', ')}` : ''}`);
      return { files, summary };
    });

    d.links = await step('links', 'Discovering docs, repos and socials', async (note) => {
      const links = classifyLinks([...seed.websites, ...seed.others, ...(d.site?.links || []), ...(d.bundles?.summary?.githubLinks || [])], d.site?.url);
      links.websites = seed.websites;
      note(`${links.github.length} GitHub · ${links.docs.length} docs · ${links.app.length} app · ${links.whitepaper.length} whitepaper`);
      return links;
    }) || { websites: seed.websites, github: [], twitter: [], telegram: [], discord: [], docs: [], whitepaper: [], app: [], internal: [] };

    const tokenName = d.chain?.metadata?.name;
    const tokenSymbol = d.chain?.metadata?.symbol;
    d.candidates = await step('search', 'Searching GitHub and the web for source code', async (note) => {
      const domains = [...seed.websites, d.site?.url].filter(Boolean);
      const extraUrls = [];
      const queries = [];
      if (tokenName) queries.push(`${tokenName} github`);
      const root = domains[0] ? new URL(domains[0]).hostname.replace(/^www\./, '') : null;
      if (root) queries.push(`"${root}" github`);
      const webResults = [];
      for (const q of queries.slice(0, mode === 'fast' ? 1 : 2)) {
        try {
          const rs = await webSearch(q, { signal });
          webResults.push(...rs.slice(0, 6));
          extraUrls.push(...rs.map((r) => r.url).filter((u) => /github\.com\//.test(u)));
        } catch {}
      }
      const res = await findCandidateRepos({ name: tokenName, symbol: tokenSymbol, domains, ca, extraUrls }, { signal });
      res.webResults = webResults.slice(0, 10);
      const strong = res.candidates.filter((c) => c.score >= 6);
      note(`${res.candidates.length} candidate repos${strong.length ? ` · likely: ${strong.slice(0, 2).map((c) => c.fullName).join(', ')}` : ''}${res.errors.length ? ` · ${res.errors[0]}` : ''}`);
      return res;
    });

    d.github = await step('github', 'Inspecting GitHub', async (note) => {
      const refs = uniqueRepoRefs(d.links.github).slice(0, 2);
      const out = [];
      for (const ref of refs) out.push(await inspectRepo(ref, { signal }).catch((e) => ({ ref: `${ref.owner}/${ref.repo || ''}`, error: e.message })));
      if (!out.some((g) => !g.error)) {
        for (const c of (d.candidates?.candidates || []).filter((c) => c.score >= 6).slice(0, 2)) {
          const [owner, repo] = c.fullName.split('/');
          const g = await inspectRepo({ owner, repo }, { signal }).catch((e) => ({ ref: c.fullName, error: e.message }));
          out.push({ ...g, candidate: true, candidateReasons: c.reasons });
        }
      }
      note(out.length ? out.map((g) => (g.error ? `${g.ref}: ${g.error}` : `${g.fullName}${g.candidate ? ' (found by search)' : ''} · ${g.commitsCapped ? '100+' : g.commitsSampled} commits · ★${g.stars}`)).join(' | ') : 'No repo linked or found');
      return out;
    });

    d.render = await step('render', 'Opening the app in a real browser', async (note) => {
      const targets = [...new Set([d.site?.url, ...d.links.app.slice(0, 2)].filter(Boolean))].slice(0, mode === 'fast' ? 1 : 3);
      if (!targets.length) {
        note('No site to open');
        return null;
      }
      const b = await getBrowser();
      if (!b) throw new Error(browserError || 'Browser unavailable');
      const pages = [];
      for (const url of targets) {
        try {
          const p = await b.open(url);
          if (p.error) {
            pages.push({ url, error: p.error });
            continue;
          }
          await b.screenshot(url === d.site?.url ? 'Homepage' : 'App');
          pages.push({ url: p.url, status: p.status, title: p.title, text: p.text, textChars: p.textChars, controls: p.controls.slice(0, 40), apiCalls: p.apiCalls, consoleErrors: p.consoleErrors, popupsOpened: p.popupsOpened });
        } catch (e) {
          pages.push({ url, error: e.message });
        }
      }
      const calls = pages.reduce((n, p) => n + (p.apiCalls?.length || 0), 0);
      note(`${pages.filter((p) => !p.error).length}/${targets.length} pages rendered · ${calls} API calls observed`);
      return { pages };
    }, { skip: findBrowser() ? null : 'No Chrome/Edge/Chromium found (set CHROME_PATH), or Node < 22' });

    d.crawl = mode === 'fast' ? null : await step('crawl', 'Opening docs and whitepaper pages', async (note) => {
      const targets = pickCrawlTargets({ ...d.links, app: [] }, d.site?.url);
      if (!targets.length) {
        note('Nothing beyond the homepage to open');
        return [];
      }
      const pages = await Promise.all(targets.map(async (u) => {
        try {
          const r = await safeFetch(u, { signal, maxBytes: 3_000_000 });
          const html = r.contentType.includes('html');
          const pdf = r.contentType.includes('pdf');
          const p = html ? parseHtml(r.text, r.url) : null;
          return { url: r.url, status: r.status, ms: r.ms, contentType: r.contentType.split(';')[0], title: p?.title || '', looksLikeSpa: p?.looksLikeSpa || false, text: pdf ? `[PDF, ${Math.round(r.bytes / 1024)} KB — text not extracted]` : (p ? p.text : r.text).slice(0, 5000) };
        } catch (e) {
          return { url: u, error: e.message };
        }
      }));
      note(`${pages.filter((p) => p.status && p.status < 400).length}/${pages.length} pages loaded`);
      return pages;
    });

    if (mode === 'build') {
      d.code = await step('code', 'Downloading and analyzing the source code', async (note) => {
        const repo = (d.github || []).find((g) => g && !g.error && g.fullName);
        if (!repo) return { skipped: true, reason: 'No public GitHub repository was linked or found, so there is no code to analyze.' };
        note(`Downloading ${repo.fullName}…`);
        archive = await downloadRepo(repo.fullName, repo.defaultBranch, { signal });
        const inventory = analyzeCode(archive, { ca });
        note(`${repo.fullName}: ${inventory.codeFiles} code files · ${inventory.codeLines.toLocaleString()} lines · ${Object.keys(inventory.languages).filter((l) => !['JSON', 'Markdown', 'YAML', 'TOML'].includes(l)).slice(0, 3).join(', ')}`);
        return { repo: repo.fullName, candidate: Boolean(repo.candidate), branch: repo.defaultBranch, inventory };
      });
    }

    d.signals = computeSignals(d);
    onBillable?.();

    const analysis = await step('ai', 'Claude is testing the claims', async (note) => {
      const result = await analyzeWithClaude(d, {
        mode,
        signal,
        note,
        archive,
        getBrowser,
        onCost,
        onLog: (l) => emit('log', l),
        onAction: (a) => {
          const key = a.id || `t${actions.size}`;
          const { image, ...rest } = a;
          actions.set(key, rest);
          emit('action', a);
        },
      });
      note(`${result.verdict.replace(/_/g, ' ')} · ${result.confidence}% confidence · ${result.toolCalls} tool calls`);
      return result;
    }, { skip: process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY is not set — showing automated checks only' });

    return {
      ca,
      mode,
      generatedAt: new Date().toISOString(),
      token: summarizeToken(d),
      links: d.links,
      site: d.site && { url: d.site.url, status: d.site.status, title: d.site.title, ms: d.site.ms, looksLikeSpa: d.site.looksLikeSpa },
      bundles: d.bundles?.summary || null,
      candidates: d.candidates?.candidates || [],
      github: d.github,
      render: d.render?.pages?.map(({ text, controls, ...p }) => p) || null,
      crawl: d.crawl,
      code: d.code,
      signals: d.signals,
      analysis,
      actions: [...actions.values()],
      screenshots: browser?.screenshots || [],
    };
  } finally {
    browser?.close();
  }
}
