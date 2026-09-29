// Web search for finding a project's repo, team, audits or coverage.
// Uses the Brave Search API when BRAVE_API_KEY is set (reliable, free tier),
// otherwise DuckDuckGo's HTML endpoint (no key, but can be rate-limited).
import { safeFetch } from './net.js';

function decode(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

export async function webSearch(query, { signal } = {}) {
  if (process.env.BRAVE_API_KEY) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, {
      headers: { accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`);
    const j = await res.json();
    return (j.web?.results || []).map((r) => ({ title: decode(r.title || ''), url: r.url, snippet: decode(r.description || '').slice(0, 300) }));
  }
  const r = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal, timeoutMs: 15000, headers: { accept: 'text/html' } });
  if (r.status !== 200) throw new Error(`Web search unavailable (HTTP ${r.status}); set BRAVE_API_KEY for reliable search`);
  const results = [];
  const blocks = r.text.split(/<div class="result[ "]/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, '&');
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
    results.push({ title: decode(a[2]), url, snippet: snip ? decode(snip[1]).slice(0, 300) : '' });
    if (results.length >= 10) break;
  }
  if (!results.length && /anomaly|captcha|unusual traffic/i.test(r.text)) throw new Error('Web search was rate-limited; set BRAVE_API_KEY for reliable search');
  return results;
}
