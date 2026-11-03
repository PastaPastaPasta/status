import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityStats } from './ci-capacity.js';

const M = 60_000;
const T = Date.parse('2026-11-03T12:00:00Z');
const job = (q, s, e, extra = {}) => ({ labels: ['dash-x64-build'], repo: 'dashpay/dash', workflow: 'CI', name: 'build', queuedAt: T + q * M, startedAt: s == null ? null : T + s * M, endAt: T + e * M, ran: s != null, done: true, ...extra });

test('at capacity is the time some job had waited over a minute; overlapping waits count once', () => {
  const r = capacityStats({
    jobs: [job(0, 5, 15), job(2, 10, 20), job(0, 0.5, 3, { name: 'lint' })],
    from: T - 10 * M, to: T + 30 * M, bucketMs: 10 * M,
  });
  const g = r.labels[0];
  // Waits past the grace minute: [1, 5) and [3, 10) → [1, 10); the 30 s pickup does not count.
  assert.equal(g.atCapacity, 9 / 40);
  assert.equal(g.runnerSec, (10 + 10 + 2.5) * 60);
  assert.equal(g.avgRunning, 22.5 / 40);
  assert.deepEqual([g.peakRunning, g.p95Running], [2, 2]);
  assert.equal(g.jobs, 3);
  assert.equal(g.medianRunSec, 600);
  assert.equal(g.maxRunSec, 600);
  assert.deepEqual(g.buckets.map((b) => b.atCapacity), [0, 0.9, 0, 0]);
  assert.deepEqual(g.buckets.map((b) => b.recorded), [true, true, true, true]);
  assert.deepEqual(g.topJobs.map((j) => [j.name, j.jobs, j.runnerSec]), [['build', 2, 1200], ['lint', 1, 150]]);
  assert.equal(g.share, 1);
});

test('a job cancelled while queued waited until it was cancelled and ran nowhere', () => {
  const r = capacityStats({ jobs: [job(0, null, 20, { ran: false })], from: T, to: T + 40 * M, bucketMs: 40 * M });
  const g = r.labels[0];
  assert.equal(g.atCapacity, 19 / 40);
  assert.equal(g.runnerSec, 0);
  assert.equal(g.medianRunSec, null);
  assert.equal(g.jobs, 1);
});

test('still waiting and still running jobs count up to now; only the window is counted', () => {
  const r = capacityStats({
    jobs: [job(-60, null, 30, { done: false, ran: false }), job(-50, -40, 30, { done: false })],
    from: T, to: T + 30 * M, bucketMs: 30 * M,
  });
  const g = r.labels[0];
  assert.equal(g.atCapacity, 1);
  assert.equal(g.avgRunning, 1);
  assert.equal(g.jobs, 0, 'unfinished jobs are not counted as finished');
});

test('buckets before recording began are marked unrecorded; label sets are kept apart and ranked by runner time', () => {
  const r = capacityStats({
    jobs: [job(0, 0, 5), job(0, 0, 20, { labels: ['ubuntu-24.04'] })],
    from: T, to: T + 20 * M, windowFrom: T - 20 * M, bucketMs: 10 * M,
    hostedOf: (key, labels) => labels[0].startsWith('ubuntu'), capacityOf: (labels) => (labels[0] === 'dash-x64-build' ? { runners: 10 } : null),
  });
  assert.deepEqual(r.labels.map((g) => g.labels[0]), ['ubuntu-24.04', 'dash-x64-build']);
  assert.deepEqual(r.labels.map((g) => g.hosted), [true, false]);
  assert.deepEqual(r.labels.map((g) => g.capacity), [null, { runners: 10 }]);
  assert.deepEqual(r.labels[0].buckets.map((b) => b.recorded), [false, false, true, true]);
  assert.equal(r.labels[0].share, 0.8);
});
