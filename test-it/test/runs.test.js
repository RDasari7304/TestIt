// Traffic handling: queue, positions, shared results, live joining, fairness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunManager } from '../server/runs.js';

function harness(opts = {}) {
  const pending = new Map(); // ca -> { resolve, reject, emit, billable }
  const refunds = [];
  const mgr = new RunManager({
    maxConcurrent: 2,
    maxQueue: 3,
    maxPerVisitor: 2,
    cacheMinutes: 60,
    onRefund: (run) => refunds.push(run.credit),
    runAnalysis: ({ ca, emit, onBillable }) =>
      new Promise((resolve, reject) => {
        emit('step', { id: 'chain', status: 'running', ca });
        pending.set(ca, { resolve: (r) => resolve(r ?? { ca, verdict: 'WORKS' }), reject, onBillable });
      }),
    ...opts,
  });
  const viewer = () => {
    const events = [];
    const send = (event, data, o = {}) => events.push({ event, data, end: o.end });
    return { events, send, last: (e) => [...events].reverse().find((x) => x.event === e) };
  };
  return { mgr, pending, refunds, viewer };
}
const tick = () => new Promise((r) => setImmediate(r));

test('runs beyond the limit wait in line and see their position', async () => {
  const { mgr, pending, viewer } = harness();
  const views = ['A', 'B', 'C', 'D'].map((ca, i) => {
    const v = viewer();
    const run = mgr.create({ ca, mode: 'fast', visitor: `v${i}` });
    run.subscribe(v.send, { creator: true });
    return v;
  });
  await tick();
  assert.equal(mgr.stats().running, 2);
  assert.equal(mgr.stats().queued, 2);
  assert.equal(views[2].last('queue').data.position, 1);
  assert.equal(views[3].last('queue').data.position, 2);
  assert.ok(views[3].last('queue').data.etaSeconds > 0);

  pending.get('A').resolve();
  await tick();
  await tick();
  assert.ok(views[0].last('report').end, 'finished viewer gets the report and the stream ends');
  assert.ok(views[2].events.some((e) => e.event === 'started'), 'next in line started');
  assert.equal(views[3].last('queue').data.position, 1, 'position moves up');
});

test('finished results are reused, and a second viewer joins a running test live', async () => {
  const { mgr, pending, viewer } = harness();
  const v1 = viewer();
  const run = mgr.create({ ca: 'TOK', mode: 'probe', visitor: 'a' });
  run.subscribe(v1.send, { creator: true });
  await tick();
  assert.equal(mgr.findActive('TOK', 'probe'), run);
  const v2 = viewer();
  mgr.findActive('TOK', 'probe').subscribe(v2.send);
  assert.deepEqual(v2.events.map((e) => e.event), ['started', 'step'], 'late viewer gets the history replayed');
  pending.get('TOK').resolve({ ca: 'TOK', verdict: 'PARTIALLY_WORKS' });
  await tick();
  assert.equal(v2.last('report').data.verdict, 'PARTIALLY_WORKS');
  assert.equal(mgr.cached('TOK', 'probe').report.verdict, 'PARTIALLY_WORKS');
  assert.equal(mgr.cached('TOK', 'fast'), null, 'cache is per mode');
  assert.equal(mgr.findActive('TOK', 'probe'), null);
});

test('a waiting run nobody is watching is dropped and refunded; a running one keeps going', async () => {
  const { mgr, pending, refunds, viewer } = harness({ maxConcurrent: 1 });
  const v1 = viewer();
  const r1 = mgr.create({ ca: 'X1', mode: 'fast', visitor: 'a', credit: 'c1' });
  const s1 = r1.subscribe(v1.send, { creator: true });
  const v2 = viewer();
  const r2 = mgr.create({ ca: 'X2', mode: 'fast', visitor: 'b', credit: 'c2' });
  const s2 = r2.subscribe(v2.send, { creator: true });
  await tick();
  r2.unsubscribe(s2);
  assert.equal(mgr.stats().queued, 0);
  assert.deepEqual(refunds, ['c2']);
  r1.unsubscribe(s1);
  assert.equal(mgr.stats().running, 1, 'running test continues so others can reuse it');
  pending.get('X1').resolve();
  await tick();
  assert.ok(mgr.cached('X1', 'fast'));
});

test('fairness limits and failure refunds', async () => {
  const { mgr, pending, refunds, viewer } = harness({ maxConcurrent: 1 });
  mgr.create({ ca: 'P1', mode: 'fast', visitor: 'spam' }).subscribe(viewer().send);
  mgr.create({ ca: 'P2', mode: 'fast', visitor: 'spam' }).subscribe(viewer().send);
  assert.match(mgr.admit('spam'), /already have 2 tests/);
  assert.equal(mgr.admit('someone-else'), null);
  mgr.create({ ca: 'P3', mode: 'fast', visitor: 'x' }).subscribe(viewer().send);
  mgr.create({ ca: 'P4', mode: 'fast', visitor: 'y' }).subscribe(viewer().send);
  assert.match(mgr.admit('z'), /waiting line is full/);

  // A run that fails before any paid work refunds its creator only.
  const { mgr: m2, pending: p2, refunds: rf2, viewer: vw2 } = harness();
  const creator = vw2();
  const watcher = vw2();
  const run = m2.create({ ca: 'F', mode: 'fast', visitor: 'a', credit: 'cr' });
  run.subscribe(creator.send, { creator: true });
  run.subscribe(watcher.send);
  await tick();
  p2.get('F').reject(new Error('RPC down'));
  await tick();
  assert.deepEqual(rf2, ['cr']);
  assert.equal(creator.last('fail').data.refunded, true);
  assert.equal(creator.last('fail').data.credit, 'cr');
  assert.equal(watcher.last('fail').data.refunded, false);
  assert.equal(m2.cached('F', 'fast'), null, 'failures are not cached');
  void pending;
  void refunds;
});
