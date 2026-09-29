// Build mode: download a project's full source code and analyze it WITHOUT
// running anything. The repo archive (.tar.gz) is unpacked in memory only —
// nothing is written to disk or executed — then scanned for size, languages,
// dependencies, leaked secrets, mock/placeholder code, AI and Solana usage.
// Claude can then list, search and read every file through the `code` tool.
import zlib from 'node:zlib';
import path from 'node:path';

const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024; // compressed
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;
const MAX_TEXT_FILE = 1_500_000;
const MAX_FILES = 40000;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'target', 'dist', 'build', '.next', 'out', '__pycache__', '.venv', 'venv', 'coverage', '.turbo', '.cache', '.yarn', '.pnpm-store', 'bower_components']);
const LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.rs': 'Rust', '.py': 'Python', '.go': 'Go', '.sol': 'Solidity', '.move': 'Move', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.md': 'Markdown', '.json': 'JSON', '.toml': 'TOML', '.yml': 'YAML', '.yaml': 'YAML', '.sh': 'Shell',
};
const CODE = new Set(['TypeScript', 'JavaScript', 'Rust', 'Python', 'Go', 'Solidity', 'Move', 'Java', 'Kotlin', 'Swift', 'C', 'C++', 'C#', 'Ruby', 'PHP', 'Vue', 'Svelte', 'Shell']);
const MANIFESTS = new Set(['package.json', 'Cargo.toml', 'Anchor.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'foundry.toml', 'Dockerfile', 'docker-compose.yml', 'Makefile']);
const TEXT_EXT = new Set([...Object.keys(LANG), '.txt', '.env', '.example', '.lock', '.cfg', '.ini', '.xml', '.graphql', '.prisma', '.sql', '.proto', '.gitignore', '.dockerignore']);

const SECRET_RULES = [
  ['private key (PEM)', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Solana keypair array', /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ['hardcoded secret', /\b(?:secret|private_?key|api_?key|access_?token|password)\w*\s*[:=]\s*["'][A-Za-z0-9+/_\-]{20,}["']/i],
];
const MARKERS = {
  ai: {
    OpenAI: /\bopenai\b|api\.openai\.com/i, Anthropic: /anthropic|claude-[0-9a-z]/i, Gemini: /generativelanguage|@google\/genai|google-generativeai|gemini-/i,
    LangChain: /langchain/i, LlamaIndex: /llama_?index/i, Ollama: /ollama/i, HuggingFace: /huggingface|transformers\b/i, 'PyTorch/TensorFlow': /\bimport torch\b|tensorflow/i,
    'Other LLM APIs': /groq|openrouter|together\.ai|mistralai|deepseek/i, 'Eliza/agent frameworks': /elizaos|@ai16z|agentkit|solana-agent-kit/i,
  },
  solana: {
    'web3.js': /@solana\/web3\.js/, 'Anchor (TS)': /@coral-xyz\/anchor|@project-serum\/anchor/, 'Anchor (Rust)': /anchor[-_]lang/, 'solana-program': /solana[-_]program/,
    'solana-sdk': /solana[-_]sdk/, 'SPL token': /@solana\/spl-token|spl[-_]token/, Jupiter: /jup\.ag|@jup-ag/, Metaplex: /metaplex/i, 'Solana Kit': /@solana\/kit/,
  },
  services: {
    Hyperliquid: /hyperliquid/i, 'X/Twitter API': /api\.twitter\.com|api\.x\.com|twitter-api-v2|tweepy/i, Telegram: /telegraf|node-telegram-bot|python-telegram-bot|grammy/i,
    Discord: /discord\.js|discord\.py/i, Supabase: /supabase/i, Firebase: /firebase/i, Prisma: /prisma/i, Postgres: /\bpg\b|postgres/i, Redis: /redis/i, Stripe: /stripe/i,
  },
};
const PLACEHOLDER = /\b(?:TODO|FIXME|HACK|XXX)\b|\b(?:mock\w*|dummy\w*|fake\w*|placeholder|lorem ipsum|hard-?coded|simulat(?:e|ed|ion)|not implemented|coming soon)\b/gi;

// ---------- download ----------

export async function downloadRepo(fullName, branch, { signal } = {}) {
  const [owner, repo] = String(fullName).split('/');
  if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(repo || '')) throw new Error('Invalid repo name');
  const headers = { 'user-agent': 'test.it', accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(branch || 'HEAD')}`;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]) });
  if (res.status === 404) throw new Error('Repository archive not found (private or deleted)');
  if (!res.ok) throw new Error(`Could not download the repository (HTTP ${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ARCHIVE_BYTES) throw new Error(`Repository is too large to analyze (${Math.round(len / 1e6)} MB)`);
  const chunks = [];
  let total = 0;
  for await (const c of res.body) {
    total += c.length;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('Repository is too large to analyze');
    chunks.push(c);
  }
  return parseTarGz(Buffer.concat(chunks));
}

// ---------- in-memory tar parsing (never touches the filesystem) ----------

function octal(buf, start, len) {
  const s = buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}
function cstr(buf, start, len) {
  const b = buf.subarray(start, start + len);
  const z = b.indexOf(0);
  return (z >= 0 ? b.subarray(0, z) : b).toString('utf8');
}
function paxPath(data) {
  const text = data.toString('utf8');
  const m = text.match(/\d+ path=([^\n]*)\n/);
  return m ? m[1] : null;
}

function isProbablyText(name, buf) {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name);
  if (!TEXT_EXT.has(ext) && !MANIFESTS.has(base) && !/^(readme|license|makefile|dockerfile|procfile)/i.test(base)) {
    // Unknown extension: sniff for binary
    if (buf.subarray(0, 8000).includes(0)) return false;
  }
  return !buf.subarray(0, 8000).includes(0);
}

export function parseTarGz(gz) {
  const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files = new Map(); // path -> { size, text|null }
  let skipped = 0;
  let longName = null;
  let paxName = null;
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'x') { paxName = paxPath(data); continue; }
    if (type === 'g') continue;
    let name = paxName || longName || (() => {
      const prefix = cstr(h, 345, 155);
      const n = cstr(h, 0, 100);
      return prefix ? `${prefix}/${n}` : n;
    })();
    paxName = null;
    longName = null;
    if (type !== '0' && type !== '\0' && type !== '7') continue; // regular files only (no symlinks, devices)
    name = name.split('/').slice(1).join('/'); // drop GitHub's top-level "<owner>-<repo>-<sha>/" folder
    if (!name || name.split('/').some((seg) => SKIP_DIRS.has(seg) || seg === '..')) {
      skipped++;
      continue;
    }
    if (files.size >= MAX_FILES) break;
    const text = size <= MAX_TEXT_FILE && isProbablyText(name, data) ? data.toString('utf8') : null;
    files.set(name, { size, text });
  }
  return { files, skipped };
}

// ---------- analysis ----------

export function analyzeCode({ files }, { ca } = {}) {
  const langs = {};
  const secrets = [];
  const placeholders = {};
  const hits = { ai: {}, solana: {}, services: {} };
  const programIds = new Set();
  const caHits = [];
  const manifests = [];
  let codeLines = 0;
  let codeFiles = 0;
  let binaryFiles = 0;

  for (const [name, f] of files) {
    const base = path.basename(name);
    if (MANIFESTS.has(base) || /^hardhat\.config\./.test(base)) manifests.push(name);
    if (f.text == null) {
      binaryFiles++;
      continue;
    }
    const lang = LANG[path.extname(name).toLowerCase()];
    const minified = /\.min\.|\.map$|lock/i.test(base);
    const lines = f.text.split('\n');
    const nonBlank = lines.filter((l) => l.trim()).length;
    if (lang && !minified) {
      langs[lang] = langs[lang] || { files: 0, lines: 0 };
      langs[lang].files++;
      langs[lang].lines += nonBlank;
    }
    if (lang && CODE.has(lang) && !minified) {
      codeLines += nonBlank;
      codeFiles++;
      const ph = (f.text.match(PLACEHOLDER) || []).length;
      if (ph) placeholders[name] = ph;
    }
    if (minified) continue;
    for (const [kind, re] of SECRET_RULES) {
      const idx = lines.findIndex((l) => re.test(l));
      if (idx >= 0 && !/example|sample|test|mock|fixture|\.md$/i.test(name)) secrets.push({ kind, file: name, line: idx + 1 });
    }
    for (const [group, defs] of Object.entries(MARKERS)) {
      for (const [k, re] of Object.entries(defs)) if (re.test(f.text)) (hits[group][k] = hits[group][k] || []).push(name);
    }
    for (const m of f.text.matchAll(/declare_id!\s*\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)) programIds.add(m[1]);
    if (base === 'Anchor.toml') for (const m of f.text.matchAll(/^\s*\w+\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gm)) programIds.add(m[1]);
    if (ca && f.text.includes(ca)) caHits.push(name);
  }

  const packages = [];
  for (const m of manifests.filter((x) => path.basename(x) === 'package.json').slice(0, 25)) {
    try {
      const j = JSON.parse(files.get(m).text);
      const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
      packages.push({
        dir: path.dirname(m),
        name: j.name,
        scripts: Object.keys(j.scripts || {}),
        depCount: Object.keys(deps).length,
        notableDeps: Object.keys(deps).filter((d) => /solana|anchor|openai|anthropic|langchain|ai-sdk|^ai$|hyperliquid|next|react|express|fastify|hono|prisma|supabase|viem|ethers|jup|metaplex|eliza|agent|telegraf|discord|twitter/i.test(d)).slice(0, 30),
      });
    } catch {}
  }
  const pyDeps = [];
  for (const m of manifests.filter((x) => path.basename(x) === 'requirements.txt').slice(0, 5)) {
    pyDeps.push(...(files.get(m).text || '').split('\n').map((l) => l.trim().split(/[=<>~! ;[]/)[0]).filter((l) => l && !l.startsWith('#')));
  }
  const sizes = [...files].map(([n, f]) => [n, f.size]).sort((a, b) => b[1] - a[1]);
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1].length - a[1].length).slice(0, n);
  const readme = [...files.keys()].find((n) => /^readme(\.md|\.txt)?$/i.test(n));

  return {
    totalFiles: files.size,
    codeFiles,
    codeLines,
    binaryFiles,
    languages: Object.fromEntries(Object.entries(langs).sort((a, b) => b[1].lines - a[1].lines).slice(0, 12)),
    manifests: manifests.slice(0, 60),
    packages,
    pythonDeps: [...new Set(pyDeps)].slice(0, 40),
    secrets: secrets.slice(0, 20),
    placeholderHits: Object.values(placeholders).reduce((a, b) => a + b, 0),
    placeholderFiles: Object.entries(placeholders).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([file, count]) => ({ file, count })),
    ai: Object.fromEntries(top(hits.ai, 10).map(([k, v]) => [k, { files: v.length, examples: v.slice(0, 4) }])),
    solana: Object.fromEntries(top(hits.solana, 10).map(([k, v]) => [k, { files: v.length, examples: v.slice(0, 4) }])),
    services: Object.fromEntries(top(hits.services, 12).map(([k, v]) => [k, { files: v.length, examples: v.slice(0, 3) }])),
    programIds: [...programIds].slice(0, 12),
    tokenAddressFoundIn: caHits.slice(0, 10),
    largestFiles: sizes.slice(0, 8).map(([file, bytes]) => ({ file, kb: Math.round(bytes / 1024) })),
    readme: readme ? { file: readme, chars: files.get(readme).size } : null,
  };
}

// ---------- Claude's read-only code tool ----------

function globToRe(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export function codeTool(archive, input) {
  const { files } = archive;
  const a = input.action;
  if (a === 'tree') {
    const re = input.pattern ? globToRe(input.pattern) : null;
    const prefix = input.path ? String(input.path).replace(/^\/+|\/+$/g, '') + '/' : '';
    const list = [...files].filter(([n]) => (!prefix || n.startsWith(prefix)) && (!re || re.test(n))).map(([n, f]) => `${n}${f.text == null ? ' [binary]' : ''} (${f.size < 1024 ? `${f.size}B` : `${Math.round(f.size / 1024)}KB`})`);
    return { total: list.length, files: list.slice(0, 400), truncated: list.length > 400 };
  }
  if (a === 'read') {
    const f = files.get(String(input.path || '').replace(/^\/+/, ''));
    if (!f) return { error: `No such file: ${input.path}. Use action "tree" or "grep" to find files.` };
    if (f.text == null) return { error: 'Binary file; cannot display' };
    const lines = f.text.split('\n');
    const start = Math.max(1, Number(input.start_line) || 1);
    const count = Math.min(Number(input.line_count) || 250, 400);
    const slice = lines.slice(start - 1, start - 1 + count).map((l, i) => `${start + i}: ${l.slice(0, 400)}`);
    return { path: input.path, totalLines: lines.length, from: start, to: start + slice.length - 1, content: slice.join('\n') };
  }
  if (a === 'grep') {
    let re;
    try {
      re = new RegExp(String(input.pattern || ''), 'i');
    } catch {
      re = new RegExp(String(input.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const prefix = input.path ? String(input.path).replace(/^\/+|\/+$/g, '') : '';
    const out = [];
    let filesMatched = 0;
    for (const [n, f] of files) {
      if (f.text == null || (prefix && !n.startsWith(prefix)) || /\.min\.|\.map$|lock\b|lock\.json$|\.lock$/i.test(n)) continue;
      const lines = f.text.split('\n');
      let matched = false;
      for (let i = 0; i < lines.length && out.length < 80; i++) {
        if (re.test(lines[i])) {
          out.push(`${n}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          matched = true;
        }
      }
      if (matched) filesMatched++;
      if (out.length >= 80) break;
    }
    return { matches: out.length, filesMatched, results: out, truncated: out.length >= 80 };
  }
  return { error: `Unknown action ${a}` };
}
