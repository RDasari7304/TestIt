// Handles heavy traffic:
//  - Waiting line: runs beyond MAX_CONCURRENT wait in a queue instead of failing,
//    and every waiting visitor sees their position and an estimated wait.
//  - Shared results: a finished report for the same token + mode is reused for
//    CACHE_MINUTES (default 360), so popular tokens are answered instantly.
//  - Live sharing: if the same token + mode is already being tested, new
//    visitors join that run and watch it live instead of starting another.
//  - Fairness: each visitor can have at most MAX_RUNS_PER_VISITOR runs in
//    progress, and the line is capped at MAX_QUEUE.
import { randomBytes } from 'node:crypto';

const DEFAULT_SECONDS = { fast: 100, probe: 300, build: 480 };

export class RunManager {
  constructor({ runAnalysis, maxConcurrent = 3, maxQueue = 100, maxPerVisitor = 2, cacheMinutes = 360, onFinish, onRefund } = {}) {
    this.runAnalysis = runAnalysis;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.maxPerVisitor = maxPerVisitor;
    this.cacheMs = cacheMinutes * 60_000;
    this.onFinish = onFinish;
    this.onRefund = onRefund;
    this.cache = new Map(); // key -> { report, at }
    this.active = new Map(); // key -> Run (queued or running)
    this.queue = []; // Runs waiting for a slot
    this.running = 0;
    this.durations = { ...DEFAULT_SECONDS }; // moving average per mode
  }

  key(ca, mode) {
    return `${ca}:${mode}`;
  }

  cached(ca, mode) {
    const hit = this.cache.get(this.key(ca, mode));
    if (!hit) return null;
    if (Date.now() - hit.at > this.cacheMs) {
      this.cache.delete(this.key(ca, mode));
      return null;
    }
    return hit;
  }

  findActive(ca, mode) {
    return this.active.get(this.key(ca, mode)) || null;
  }

  visitorLoad(visitor) {
    let n = 0;
    for (const r of this.active.values()) if (r.visitor === visitor) n++;
    return n;
  }

  // Returns an error message if a new run can't be accepted right now.
  admit(visitor) {
    if (this.maxPerVisitor > 0 && this.visitorLoad(visitor) >= this.maxPerVisitor) return `You already have ${this.maxPerVisitor} tests in progress. Wait for one to finish before starting another.`;
    if (this.queue.length >= this.maxQueue) return 'test.it is extremely busy right now and the waiting line is full. Please try again in a few minutes.';
    return null;
  }

  create({ ca, mode, visitor, credit }) {
    const run = new Run(this, { ca, mode, visitor, credit });
    this.active.set(run.key, run);
    this.queue.push(run);
    this.pump();
    this.broadcastPositions();
    return run;
  }

  estimateSeconds(index) {
    // Work ahead of this position, spread across the parallel slots.
    const ahead = this.queue.slice(0, index).reduce((s, r) => s + this.durations[r.mode], 0);
    const inFlight = [...this.active.values()].filter((r) => r.state === 'running').reduce((s, r) => s + Math.max(20, this.durations[r.mode] - (Date.now() - r.startedAt) / 1000), 0);
    return Math.round((ahead + inFlight) / this.maxConcurrent);
  }

  broadcastPositions() {
    this.queue.forEach((run, i) => run.broadcast('queue', { position: i + 1, total: this.queue.length, running: this.running, etaSeconds: this.estimateSeconds(i) }));
  }

  pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const run = this.queue.shift();
      this.start(run);
    }
  }

  async start(run) {
    this.running++;
    run.state = 'running';
    run.startedAt = Date.now();
    run.broadcast('started', { at: run.startedAt });
    let billable = false;
    try {
      const report = await this.runAnalysis({
        ca: run.ca,
        mode: run.mode,
        signal: run.controller.signal,
        emit: (event, data) => run.broadcast(event, data),
        onBillable: () => (billable = true),
      });
      this.cache.set(run.key, { report, at: Date.now() });
      const secs = (Date.now() - run.startedAt) / 1000;
      this.durations[run.mode] = Math.round(this.durations[run.mode] * 0.7 + secs * 0.3);
      run.finish('report', report);
      this.onFinish?.(run, report);
    } catch (e) {
      const refunded = !billable && run.credit ? (this.onRefund?.(run), true) : false;
      run.finish('fail', { message: e.message || String(e) }, { refunded });
    } finally {
      this.running--;
      this.active.delete(run.key);
      this.pump();
      this.broadcastPositions();
    }
  }

  // Called when the last viewer of a run leaves.
  abandoned(run) {
    if (run.state !== 'queued') return; // a running test finishes so its result is cached for others
    this.queue = this.queue.filter((r) => r !== run);
    this.active.delete(run.key);
    if (run.credit) this.onRefund?.(run);
    run.state = 'cancelled';
    this.broadcastPositions();
  }

  stats() {
    return { running: this.running, queued: this.queue.length, maxConcurrent: this.maxConcurrent, cached: this.cache.size };
  }

  // Everything running or waiting, for the public "Live now" page.
  list() {
    return [...this.active.values()]
      .map((r) => ({
        ca: r.ca,
        mode: r.mode,
        state: r.state,
        position: r.state === 'queued' ? this.queue.indexOf(r) + 1 : null,
        createdAt: r.createdAt,
        startedAt: r.startedAt || null,
        viewers: r.subscribers.size,
        name: r.meta.name || null,
        symbol: r.meta.symbol || null,
        image: r.meta.image || null,
        step: r.currentStep,
        toolCalls: r.toolCalls,
      }))
      .sort((a, b) => (a.state === b.state ? a.createdAt - b.createdAt : a.state === 'running' ? -1 : 1));
  }
}

class Run {
  constructor(manager, { ca, mode, visitor, credit }) {
    this.id = randomBytes(6).toString('hex');
    this.manager = manager;
    this.ca = ca;
    this.mode = mode;
    this.key = manager.key(ca, mode);
    this.visitor = visitor;
    this.credit = credit || null;
    this.state = 'queued';
    this.controller = new AbortController();
    this.subscribers = new Set();
    this.history = []; // replayed to viewers who join mid-run
    this.createdAt = Date.now();
    this.meta = {};
    this.currentStep = null;
    this.toolCalls = 0;
  }

  subscribe(send, { creator = false } = {}) {
    const sub = { send, creator };
    this.subscribers.add(sub);
    for (const [event, data] of this.history) send(event, data);
    if (this.state === 'queued') {
      const i = this.manager.queue.indexOf(this);
      if (i >= 0) send('queue', { position: i + 1, total: this.manager.queue.length, running: this.manager.running, etaSeconds: this.manager.estimateSeconds(i) });
    }
    return sub;
  }

  unsubscribe(sub) {
    this.subscribers.delete(sub);
    if (!this.subscribers.size && !this.done) this.manager.abandoned(this);
  }

  broadcast(event, data) {
    if (event === 'meta') this.meta = { ...this.meta, ...data };
    if (event === 'step' && data?.label) this.currentStep = data.status === 'running' ? data.label : this.currentStep;
    if (event === 'action' && data?.type === 'tool' && data.status === 'pending') this.toolCalls++;
    if (event !== 'queue') {
      this.history.push([event, data]);
      if (this.history.length > 800) this.history.splice(1, 100);
    }
    for (const s of this.subscribers) s.send(event, data);
  }

  finish(event, data, { refunded = false } = {}) {
    this.done = true;
    for (const s of this.subscribers) s.send(event, event === 'fail' ? { ...data, refunded: s.creator && refunded, credit: s.creator && refunded ? this.credit : undefined } : data, { end: true });
  }
}
