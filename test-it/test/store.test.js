// Stored results (file backend) and the Upstash Redis backend's command format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PAYMENTS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'testit-store-'));
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const store = await import('../server/store.js');

const CA = 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC';
const CA2 = 'B4yFFEgct6yccfzme2j9EqrzVxuRg5WYQCpQtbUWpump';
const report = (ca, mode, verdict, at, extra = {}) => ({
  ca, mode, generatedAt: new Date(at).toISOString(),
  token: { name: ca === CA ? 'AgentX' : 'XLiquid', symbol: ca === CA ? 'AGX' : 'XLQ', image: 'https://ipfs.io/x.png' },
  analysis: { verdict, confidence: 70, headline: `${verdict} headline` },
  screenshots: Array.from({ length: 10 }, (_, i) => ({ data: `img${i}`, url: `u${i}` })),
  ...extra,
});

test('file store: save, replace with latest, list, search, per-token lookup', async () => {
  assert.equal(store.storageKind(), 'file');
  await store.saveReport(report(CA, 'probe', 'UNVERIFIABLE', 1000));
  await store.saveReport(report(CA2, 'fast', 'DOES_NOT_WORK', 2000));
  const s = await store.saveReport(report(CA, 'probe', 'PARTIALLY_WORKS', 3000));
  assert.equal(s.runs, 2, 'second test of the same token+mode counts as a re-test');

  const latest = await store.getReport(CA, 'probe');
  assert.equal(latest.analysis.verdict, 'PARTIALLY_WORKS', 'latest result replaces the old one');
  assert.equal(latest.screenshots.length, 6, 'screenshots trimmed for storage');
  assert.equal(latest.screenshots.at(-1).data, 'img9', 'last screenshot kept');

  const { items, total } = await store.listTested();
  assert.equal(total, 2);
  assert.deepEqual(items.map((i) => i.ca), [CA, CA2], 'newest first');
  assert.equal((await store.listTested({ q: 'xliq' })).total, 1);
  assert.equal((await store.listTested({ q: CA2.slice(0, 10) })).items[0].ca, CA2);

  await store.saveReport(report(CA, 'fast', 'WORKS', 4000));
  const forToken = await store.testedFor(CA);
  assert.deepEqual(forToken.map((t) => t.mode), ['fast', 'probe']);
  assert.equal(await store.getReport(CA, 'build'), null);
});

test('redis store sends the right Upstash commands', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  const sent = [];
  const db = { hash: {}, str: {}, z: {}, runs: {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.upstash.io/pipeline');
    assert.equal(init.headers.authorization, 'Bearer tok');
    const cmds = JSON.parse(init.body);
    sent.push(...cmds.map((c) => c[0]));
    const out = cmds.map(([op, ...a]) => {
      if (op === 'HINCRBY') return { result: (db.runs[a[1]] = (db.runs[a[1]] || 0) + a[2]) };
      if (op === 'SET') return { result: ((db.str[a[0]] = a[1]), 'OK') };
      if (op === 'GET') return { result: db.str[a[0]] ?? null };
      if (op === 'HSET') return { result: ((db.hash[a[1]] = a[2]), 1) };
      if (op === 'HMGET') return { result: a.slice(1).map((k) => db.hash[k] ?? null) };
      if (op === 'ZADD') return { result: ((db.z[a[2]] = a[1]), 1) };
      if (op === 'ZREVRANGE') return { result: Object.entries(db.z).sort((x, y) => y[1] - x[1]).map(([k]) => k) };
      return { error: `unexpected ${op}` };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  try {
    assert.equal(store.storageKind(), 'redis');
    await store.saveReport(report(CA, 'build', 'WORKS', 5000));
    await store.saveReport(report(CA, 'build', 'DOES_NOT_WORK', 6000));
    assert.equal((await store.getReport(CA, 'build')).analysis.verdict, 'DOES_NOT_WORK');
    const list = await store.listTested();
    assert.equal(list.items[0].runs, 2);
    assert.equal((await store.testedFor(CA))[0].mode, 'build');
    assert.ok(['HINCRBY', 'SET', 'HSET', 'ZADD', 'GET', 'ZREVRANGE', 'HMGET'].every((c) => sent.includes(c)));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
