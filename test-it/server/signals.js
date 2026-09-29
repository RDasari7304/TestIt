// Deterministic checks that don't need an LLM. Each is { level, label, detail }.
const DAY = 86_400_000;

export function computeSignals(d) {
  const out = [];
  const add = (level, label, detail = '') => out.push({ level, label, detail });
  const now = Date.now();

  if (!d.site) add('red', 'No working website found', 'No site listed in the token metadata, or it failed to load.');
  else {
    if (d.site.status >= 400) add('red', `Website returns HTTP ${d.site.status}`, d.site.url);
    if (/coming soon|launching soon|join the waitlist/i.test(`${d.site.text || ''} ${d.render?.pages?.map((p) => p.text).join(' ') || ''}`)) add('yellow', 'Site says "coming soon" / waitlist', 'Product may not exist yet.');
  }

  const rendered = d.render?.pages || [];
  if (rendered.length) {
    const apiCalls = rendered.flatMap((p) => p.apiCalls || []);
    const okCalls = apiCalls.filter((c) => c.status && c.status < 400);
    if (okCalls.length) add('green', `App makes live backend calls (${okCalls.length} succeeded)`, [...new Set(okCalls.map((c) => { try { return new URL(c.url).host; } catch { return c.url; } }))].slice(0, 4).join(', '));
    else add('yellow', 'Rendered app made no successful backend calls', 'The page may be static or everything is behind a login.');
    const errs = rendered.flatMap((p) => p.consoleErrors || []);
    if (errs.length >= 5) add('yellow', `${errs.length} JavaScript errors while loading the app`, errs[0]?.slice(0, 120));
  }

  const scan = d.bundles?.summary;
  if (scan?.sdks?.includes('Mock / demo data')) add('yellow', 'Site code references mock/demo data', 'Some displayed data may be fake.');

  const repos = (d.github || []).filter((g) => g && !g.error);
  const strongCandidates = (d.candidates?.candidates || []).filter((c) => c.score >= 6);
  if (!repos.length) {
    if (d.links?.github?.length) add('red', 'Linked GitHub is missing or private', 'No public source code to verify.');
    else if (strongCandidates.length) add('yellow', 'No GitHub linked, but likely repos were found', strongCandidates.map((c) => c.fullName).join(', '));
    else add('yellow', 'No public source code found', 'No GitHub linked and none found by search.');
  }
  for (const g of repos) {
    const label = g.fullName + (g.candidate ? ' (found by search)' : '');
    if (g.fork) add('red', `${label} is a fork`, `Forked from ${g.parent}. Check whether any original work was added.`);
    if (g.commitsSampled <= 5) add('red', `${label} has ${g.commitsSampled} commit(s)`, 'Almost no development history.');
    else if (g.commitsCapped) add('green', `${label} has 100+ commits`, `${g.commitAuthors} authors in the latest 100.`);
    if (g.pushedAt && (now - new Date(g.pushedAt)) / DAY > 90) add('yellow', `${label} inactive`, `Last push ${new Date(g.pushedAt).toISOString().slice(0, 10)}.`);
    if (g.stars >= 500) add('green', `${label} has ${g.stars.toLocaleString()} stars`, 'Real outside interest (stars can be bought, though).');
    if (!g.readmeChars || g.readmeChars < 300) add('yellow', `${label} has little or no README`);
  }

  const code = d.code;
  if (code && !code.skipped) {
    const inv = code.inventory;
    if (inv.codeLines < 300) add('red', `Only ${inv.codeLines} lines of code`, 'Too little code to implement a real product.');
    else add('green', `${inv.codeLines.toLocaleString()} lines of code`, Object.keys(inv.languages || {}).filter((l) => !['JSON', 'Markdown', 'YAML', 'TOML'].includes(l)).slice(0, 4).join(', '));
    if (inv.secrets?.length) add('red', `${inv.secrets.length} hardcoded secret(s) in the code`, inv.secrets.slice(0, 3).map((s) => `${s.kind} in ${s.file}:${s.line}`).join('; '));
    if (inv.codeLines && inv.placeholderHits / Math.max(inv.codeLines, 1) > 0.01) add('yellow', `Lots of mock/TODO/placeholder markers (${inv.placeholderHits})`, inv.placeholderFiles?.slice(0, 3).map((f) => f.file).join(', '));
    if (inv.tokenAddressFoundIn?.length) add('green', 'Code references this token address', inv.tokenAddressFoundIn.slice(0, 3).join(', '));
  }
  return out;
}

export function summarizeToken(d) {
  const m = d.chain?.metadata || {};
  const j = m.json || {};
  return {
    name: m.name || j.name || null,
    symbol: m.symbol || j.symbol || null,
    description: m.description || j.description || null,
    image: j.image || null,
    program: d.chain?.program || null,
  };
}
