// Stores every token's latest test result so anyone can browse them later.
//   report:<ca>:<mode>  -> full latest report (screenshots trimmed)
//   tested index        -> one summary per token+mode (name, verdict, time, runs)
// Backends:
//   - Upstash Redis (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN):
//     permanent, survives restarts. Use this on Render's free plan, whose disk
//     is wiped on every restart/deploy.
//   - Local files in data/ (default): fine on a server with a persistent disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.PAYMENTS_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const INDEX_FILE = path.join(DATA_DIR, 'tested.json');
const MAX_SCREENSHOTS = 6;

const redisUrl = () => process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
const redisToken = () => process.env.UPSTASH_REDIS_REST_TOKEN;
export const storageKind = () => (redisUrl() && redisToken() ? 'redis' : 'file');

async function redis(commands) {
  const res = await fetch(`${redisUrl()}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${redisToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Storage error (HTTP ${res.status})`);
  const out = await res.json();
  const err = out.find((r) => r.error);
  if (err) throw new Error(`Storage error: ${err.error}`);
  return out.map((r) => r.result);
}

// ---- file backend helpers ----
let fileIndex = null;
function loadIndex() {
  if (fileIndex) return fileIndex;
  try {
    fileIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    fileIndex = {};
  }
  return fileIndex;
}
function saveIndex() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE + '.tmp', JSON.stringify(fileIndex));
  fs.renameSync(INDEX_FILE + '.tmp', INDEX_FILE);
}
const safeName = (ca, mode) => `${ca.replace(/[^A-Za-z0-9]/g, '')}-${mode.replace(/[^a-z]/g, '')}.json`;

export function summarize(report, runs = 1) {
  const a = report.analysis || {};
  const t = report.token || {};
  return {
    ca: report.ca,
    mode: report.mode,
    name: t.name || null,
    symbol: t.symbol || null,
    image: typeof t.image === 'string' && /^https:\/\//.test(t.image) ? t.image : null,
    verdict: a.verdict || null,
    confidence: a.confidence ?? null,
    headline: a.headline || null,
    at: Date.parse(report.generatedAt) || Date.now(),
    runs,
  };
}

function trimForStorage(report) {
  const r = { ...report };
  if (Array.isArray(r.screenshots) && r.screenshots.length > MAX_SCREENSHOTS) {
    // Keep the first few and the last one (usually the most informative).
    r.screenshots = [...r.screenshots.slice(0, MAX_SCREENSHOTS - 1), r.screenshots.at(-1)];
  }
  return r;
}

export async function saveReport(report) {
  const key = `${report.ca}:${report.mode}`;
  const stored = trimForStorage(report);
  if (storageKind() === 'redis') {
    const [runs] = await redis([['HINCRBY', 'tested:runs', key, 1]]);
    const summary = summarize(stored, Number(runs));
    await redis([
      ['SET', `report:${key}`, JSON.stringify(stored)],
      ['HSET', 'tested', key, JSON.stringify(summary)],
      ['ZADD', 'tested:time', summary.at, key],
    ]);
    return summary;
  }
  const index = loadIndex();
  const summary = summarize(stored, (index[key]?.runs || 0) + 1);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, safeName(report.ca, report.mode)), JSON.stringify(stored));
  index[key] = summary;
  saveIndex();
  return summary;
}

export async function getReport(ca, mode) {
  if (storageKind() === 'redis') {
    const [raw] = await redis([['GET', `report:${ca}:${mode}`]]);
    return raw ? JSON.parse(raw) : null;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, safeName(ca, mode)), 'utf8'));
  } catch {
    return null;
  }
}

export async function testedFor(ca) {
  const keys = ['fast', 'probe', 'build'].map((m) => `${ca}:${m}`);
  if (storageKind() === 'redis') {
    const [vals] = await redis([['HMGET', 'tested', ...keys]]);
    return (vals || []).filter(Boolean).map((v) => JSON.parse(v)).sort((a, b) => b.at - a.at);
  }
  const index = loadIndex();
  return keys.map((k) => index[k]).filter(Boolean).sort((a, b) => b.at - a.at);
}

export async function listTested({ q = '', offset = 0, limit = 30 } = {}) {
  let all;
  if (storageKind() === 'redis') {
    const [keys] = await redis([['ZREVRANGE', 'tested:time', 0, 1999]]);
    if (!keys?.length) return { items: [], total: 0 };
    const [vals] = await redis([['HMGET', 'tested', ...keys]]);
    all = (vals || []).filter(Boolean).map((v) => JSON.parse(v));
  } else {
    all = Object.values(loadIndex()).sort((a, b) => b.at - a.at);
  }
  const needle = q.trim().toLowerCase();
  if (needle) all = all.filter((s) => [s.ca, s.name, s.symbol, s.headline].some((f) => f && String(f).toLowerCase().includes(needle)));
  return { items: all.slice(offset, offset + limit), total: all.length };
}
