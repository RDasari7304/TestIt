// GitHub evidence via the REST API: repo facts, commit history, contributors,
// README and top-level files. Unauthenticated limit is 60 req/h; set GITHUB_TOKEN.
const API = 'https://api.github.com';
const RESERVED = new Set(['orgs', 'sponsors', 'features', 'about', 'login', 'topics', 'marketplace', 'settings', 'explore', 'search', 'apps', 'collections']);

async function gh(path, { signal, raw = false } = {}) {
  const headers = {
    accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'user-agent': 'test.it',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(API + path, {
    headers,
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
  });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error('GitHub API rate limit hit; add GITHUB_TOKEN to .env');
  }
  if (res.status === 404) throw new Error(`GitHub: ${path.split('?')[0]} not found (deleted or private)`);
  if (!res.ok) throw new Error(`GitHub ${path.split('?')[0]}: HTTP ${res.status}`);
  return raw ? res.text() : res.json();
}

export function parseGitHubUrl(url) {
  const m = url.match(/github\.com\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?/i);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const repo = m[2] ? m[2].replace(/\.git$/, '') : null;
  return { owner: m[1], repo };
}

export function uniqueRepoRefs(urls) {
  const seen = new Map();
  for (const u of urls) {
    const ref = parseGitHubUrl(u);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo || ''}`.toLowerCase();
    if (!seen.has(key)) seen.set(key, ref);
  }
  // Prefer explicit repos over bare org/user links
  return [...seen.values()].sort((a, b) => Number(!!b.repo) - Number(!!a.repo));
}

export function detectStack(names) {
  const s = new Set(names);
  if (s.has('Anchor.toml')) return 'rust';
  if (s.has('package.json')) return 'node';
  if (s.has('Cargo.toml')) return 'rust';
  if (['requirements.txt', 'pyproject.toml', 'setup.py'].some((f) => s.has(f))) return 'python';
  if (s.has('go.mod')) return 'go';
  return null;
}

async function resolveOwnerRepo(ref, signal) {
  if (ref.repo) return { owner: ref.owner, repo: ref.repo, orgRepos: null };
  const repos = await gh(`/users/${ref.owner}/repos?sort=pushed&per_page=30`, { signal });
  if (!repos.length) throw new Error(`GitHub account ${ref.owner} has no public repositories`);
  const pick = repos.find((r) => !r.fork && !r.archived) || repos[0];
  return {
    owner: ref.owner,
    repo: pick.name,
    orgRepos: repos.map((r) => ({ name: r.name, fork: r.fork, pushedAt: r.pushed_at, stars: r.stargazers_count, description: r.description })).slice(0, 15),
  };
}

export async function inspectRepo(ref, { signal } = {}) {
  const { owner, repo, orgRepos } = await resolveOwnerRepo(ref, signal);
  const r = await gh(`/repos/${owner}/${repo}`, { signal });
  const [languages, commits, contributors, contents, readme] = await Promise.all([
    gh(`/repos/${owner}/${repo}/languages`, { signal }).catch(() => ({})),
    gh(`/repos/${owner}/${repo}/commits?per_page=100`, { signal }).catch(() => []),
    gh(`/repos/${owner}/${repo}/contributors?per_page=100&anon=1`, { signal }).catch(() => []),
    gh(`/repos/${owner}/${repo}/contents/`, { signal }).catch(() => []),
    gh(`/repos/${owner}/${repo}/readme`, { signal, raw: true }).catch(() => ''),
  ]);
  const dates = commits.map((c) => c.commit?.author?.date).filter(Boolean).sort();
  const authors = new Set(commits.map((c) => c.author?.login || c.commit?.author?.name).filter(Boolean));
  const topLevel = Array.isArray(contents) ? contents.map((c) => c.name) : [];
  return {
    fullName: r.full_name,
    url: r.html_url,
    cloneUrl: r.clone_url,
    description: r.description,
    homepage: r.homepage,
    fork: r.fork,
    parent: r.parent?.full_name || null,
    archived: r.archived,
    stars: r.stargazers_count,
    forks: r.forks_count,
    openIssues: r.open_issues_count,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    sizeKb: r.size,
    license: r.license?.spdx_id || null,
    defaultBranch: r.default_branch,
    languages,
    stack: detectStack(topLevel),
    topLevel: topLevel.slice(0, 60),
    commitsSampled: commits.length,
    commitsCapped: commits.length === 100,
    firstCommitInSample: dates[0] || null,
    lastCommit: dates.at(-1) || null,
    commitAuthors: authors.size,
    contributors: Array.isArray(contributors) ? contributors.length : null,
    recentCommitMessages: commits.slice(0, 15).map((c) => c.commit?.message?.split('\n')[0]?.slice(0, 120)),
    readme: readme ? readme.slice(0, 9000) : null,
    readmeChars: readme ? readme.length : 0,
    orgRepos,
  };
}

// ---------- search + exploration (used by the pipeline and by Claude's github tool) ----------

function slimRepo(r) {
  return {
    fullName: r.full_name,
    url: r.html_url,
    description: r.description?.slice(0, 200) || null,
    homepage: r.homepage || null,
    stars: r.stargazers_count,
    fork: r.fork,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    language: r.language,
  };
}

export async function searchRepos(query, { signal, per = 10 } = {}) {
  const j = await gh(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${per}`, { signal });
  return (j.items || []).map(slimRepo);
}

export async function searchCode(query, { signal, per = 15 } = {}) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GitHub code search needs GITHUB_TOKEN in .env');
  const j = await gh(`/search/code?q=${encodeURIComponent(query)}&per_page=${per}`, { signal });
  return (j.items || []).map((i) => ({ repo: i.repository?.full_name, path: i.path, url: i.html_url }));
}

function splitRepo(repo) {
  const m = String(repo).replace(/^https?:\/\/github\.com\//, '').match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error('repo must look like owner/name');
  return [m[1], m[2].replace(/\.git$/, '')];
}

export async function repoSummary(repo, { signal } = {}) {
  const [o, n] = splitRepo(repo);
  return inspectRepo({ owner: o, repo: n }, { signal });
}

export async function repoTree(repo, { signal, limit = 500 } = {}) {
  const [o, n] = splitRepo(repo);
  const r = await gh(`/repos/${o}/${n}`, { signal });
  const t = await gh(`/repos/${o}/${n}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`, { signal });
  const files = (t.tree || []).filter((x) => x.type === 'blob').map((x) => `${x.path}${x.size > 200000 ? ` (${Math.round(x.size / 1024)}KB)` : ''}`);
  return { repo: r.full_name, branch: r.default_branch, totalFiles: files.length, truncated: t.truncated || files.length > limit, files: files.slice(0, limit) };
}

export async function repoFile(repo, path, { signal, maxChars = 16000 } = {}) {
  const [o, n] = splitRepo(repo);
  const text = await gh(`/repos/${o}/${n}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { signal, raw: true });
  return { repo: `${o}/${n}`, path, chars: text.length, content: text.slice(0, maxChars), truncated: text.length > maxChars };
}

export async function repoCommits(repo, { signal } = {}) {
  const [o, n] = splitRepo(repo);
  const list = await gh(`/repos/${o}/${n}/commits?per_page=40`, { signal });
  return list.map((c) => ({ sha: c.sha.slice(0, 7), date: c.commit?.author?.date, author: c.author?.login || c.commit?.author?.name, message: c.commit?.message?.split('\n')[0]?.slice(0, 140) }));
}

// Find repos that probably belong to the project even when the site never links them.
export async function findCandidateRepos({ name, symbol, domains = [], ca, extraUrls = [] }, { signal } = {}) {
  const found = new Map();
  const errors = [];
  const add = (r, points, reason) => {
    if (!r?.fullName) return;
    const cur = found.get(r.fullName.toLowerCase()) || { ...r, score: 0, reasons: [] };
    cur.score += points;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    found.set(r.fullName.toLowerCase(), cur);
  };
  const clean = (s) => String(s || '').replace(/[^\w .-]/g, ' ').trim();
  const nm = clean(name);
  const sym = clean(symbol);
  const roots = [...new Set(domains.map((d) => { try { return new URL(d).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean))];

  const tasks = [];
  for (const d of roots.slice(0, 2)) {
    tasks.push(searchRepos(`"${d}" in:readme,description`, { signal, per: 10 }).then((rs) => rs.forEach((r) => add(r, 5, `mentions ${d} in README/description`))).catch((e) => errors.push(e.message)));
    if (process.env.GITHUB_TOKEN) tasks.push(searchCode(`"${d}"`, { signal }).then((rs) => rs.forEach((x) => add({ fullName: x.repo, url: `https://github.com/${x.repo}` }, 3, `code references ${d} (${x.path})`))).catch((e) => errors.push(e.message)));
  }
  if (nm && nm.length >= 3) tasks.push(searchRepos(`${nm} in:name`, { signal, per: 10 }).then((rs) => rs.forEach((r) => add(r, 2, `name matches "${nm}"`))).catch((e) => errors.push(e.message)));
  if (sym && sym.length >= 4 && sym.toLowerCase() !== nm.toLowerCase()) tasks.push(searchRepos(`${sym} solana in:name,description`, { signal, per: 6 }).then((rs) => rs.forEach((r) => add(r, 1, `name/description matches "${sym}"`))).catch((e) => errors.push(e.message)));
  if (ca && process.env.GITHUB_TOKEN) tasks.push(searchCode(`"${ca}"`, { signal }).then((rs) => rs.forEach((x) => add({ fullName: x.repo, url: `https://github.com/${x.repo}` }, 6, `code contains the token address (${x.path})`))).catch((e) => errors.push(e.message)));
  for (const u of extraUrls) {
    const ref = parseGitHubUrl(u);
    if (ref?.repo) add({ fullName: `${ref.owner}/${ref.repo}`, url: `https://github.com/${ref.owner}/${ref.repo}` }, 4, 'found via web search');
  }
  await Promise.all(tasks);

  for (const c of found.values()) {
    const hp = (c.homepage || '').toLowerCase();
    if (roots.some((d) => hp.includes(d))) {
      c.score += 6;
      c.reasons.push('repo homepage is the project site');
    }
    if (nm && c.fullName.toLowerCase().split('/')[0].includes(nm.toLowerCase().replace(/\s+/g, ''))) {
      c.score += 2;
      c.reasons.push('owner name matches project');
    }
    if (c.fork) c.score -= 2;
    if (c.pushedAt && Date.now() - new Date(c.pushedAt) < 120 * 86400000) c.score += 1;
  }
  const list = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  return { candidates: list, errors: [...new Set(errors)].slice(0, 3) };
}
