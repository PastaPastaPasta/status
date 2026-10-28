import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCi } from './ci.js';

const T0 = Date.parse('2026-09-29T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const report = (jobs = [], runner = {}) => ({
  v: 1, reporter: '1', python: '3.9.6', at: iso(T0),
  host: { hostname: 'mac', os: 'macOS 26.6.2', arch: 'arm64', cpus: 14, load: [1.5, 1.2, 1], memTotal: 38e9, memUsed: 20e9, uptimeSec: 3600, disks: [{ path: '/', total: 500e9, free: 130e9 }], docker: null },
  runners: [{ key: '/Users/x/actions-runner', name: 'mac-runner-brian', pool: 'platform-repositories', kind: 'native', version: '2.337.0', listening: true, busy: false, job: null, diag: { bytes: 6e9, files: 162880 }, ...runner }],
  jobs,
});
const job = (startMin, durMin, extra = {}) => ({ runner: '/Users/x/actions-runner', runnerName: 'mac-runner-brian', name: 'Swift SDK build', start: iso(T0 - startMin * 60_000), end: iso(T0 - (startMin - durMin) * 60_000), result: 'Succeeded', repo: 'dashpay/platform', runId: 100 + startMin, attempt: 1, workflow: 'Tests', event: 'push', visibility: 'public', ...extra });

test('reporter tokens authenticate; reports are stored, deduplicated and summarised', () => {
  let now = T0;
  const ci = createCi({ dataDir: mkdtempSync(join(tmpdir(), 'ci-')), clock: () => now });
  const { id, token } = ci.addReporter('Brian Mac Studio');
  assert.equal(id, 'brian-mac-studio');
  assert.match(token, /^dcr_brian-mac-studio_/);
  assert.throws(() => ci.addReporter('brian mac studio'), /already exists/);
  assert.equal(ci.authenticate(`Bearer ${token}`), id);
  assert.equal(ci.authenticate(`Bearer ${token}x`), null);
  assert.equal(ci.authenticate(token), null);
  assert.throws(() => ci.ingest(id, { v: 2 }), /v1 report/);

  assert.deepEqual(ci.ingest(id, report([job(120, 30), job(60, 30, { result: 'Failed' }), { name: 'bad' }])), { accepted: 2 });
  ci.ingest(id, report([job(60, 30, { result: 'Failed' })], { busy: true, job: { name: 'Rust tests', start: iso(T0 - 15 * 60_000), repo: 'dashpay/platform', runId: 7 } }));
  const s = ci.summary({ admin: true });
  assert.equal(s.totals.jobs24h, 2);
  assert.equal(s.totals.failed24h, 1);
  const r = s.runners[0];
  assert.equal(r.status, 'busy');
  assert.equal(r.job.name, 'Rust tests');
  assert.equal(r.day.busySec, 75 * 60); // two 30-minute jobs + 15 minutes of the running one
  assert.equal(r.hours.length, 48);
  assert.equal(r.hours.at(-1).reported, true);
  assert.equal(s.recent[0].url, 'https://github.com/dashpay/platform/actions/runs/160');
  assert.equal(s.workflows[0].jobs, 2);
  assert.equal(s.daily.length, 14);
  assert.deepEqual([s.daily.at(-1).succeeded, s.daily.at(-1).failed, s.daily.at(-1).runnerHours, s.daily.at(-1).light], [1, 1, 1, 0]);
  assert.equal(s.reporters[0].id, id);
  assert.equal(ci.summary().reporters, undefined);

  now += 4 * 60_000; // no report for four minutes
  assert.equal(ci.summary().runners[0].status, 'offline');
  ci.removeReporter(id);
  assert.equal(ci.authenticate(`Bearer ${token}`), null);
  assert.equal(ci.summary().runners.length, 0);
});

test('GitHub timing adds queue time; queued self-hosted jobs are listed', async () => {
  const now = T0;
  const dataDir = mkdtempSync(join(tmpdir(), 'ci-'));
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const headers = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(T0 / 1000 + 3600) };
    if (url.includes('/attempts/1/jobs')) return Response.json({ jobs: [{ id: 1, name: 'Swift SDK build', status: 'completed', conclusion: 'success', created_at: iso(T0 - 125 * 60_000), started_at: iso(T0 - 120 * 60_000 + 3000), completed_at: iso(T0 - 90 * 60_000), runner_name: 'mac-runner-brian', labels: ['self-hosted', 'macOS', 'ARM64'], html_url: 'https://github.com/dashpay/platform/actions/runs/220/job/1' }] }, { headers });
    if (url.includes('status=in_progress')) return Response.json({ workflow_runs: [{ id: 9, name: 'Tests', created_at: iso(T0 - 10 * 60_000), head_branch: 'v4.2-dev' }] }, { headers });
    if (url.includes('status=queued')) return Response.json({ workflow_runs: [] }, { headers });
    if (url.includes('/runs/9/jobs')) return Response.json({ jobs: [
      { id: 2, name: 'Swift SDK build', status: 'queued', created_at: iso(T0 - 8 * 60_000), labels: ['self-hosted', 'macOS', 'ARM64'], html_url: 'u2' },
      { id: 3, name: 'Lint', status: 'queued', created_at: iso(T0 - 8 * 60_000), labels: ['ubuntu-24.04'], html_url: 'u3' },
      { id: 4, name: 'Build', status: 'in_progress', created_at: iso(T0 - 9 * 60_000), labels: ['self-hosted'], html_url: 'u4' },
    ] }, { headers });
    return new Response('{}', { status: 404, headers });
  };
  const ci = createCi({ dataDir, clock: () => now, fetcher, github: { id: 'cid', secret: 'sec' } });
  const { id } = ci.addReporter('brian');
  ci.ingest(id, report([job(120, 30)]));
  await ci.tick();
  assert.ok(calls.every((c) => c.auth === `Basic ${Buffer.from('cid:sec').toString('base64')}`));
  const s = ci.summary();
  assert.equal(s.recent[0].queueSec, 5 * 60 + 3);
  assert.equal(s.recent[0].url, 'https://github.com/dashpay/platform/actions/runs/220/job/1');
  assert.equal(s.totals.queuedNow, 1);
  assert.equal(s.queue.jobs[0].name, 'Swift SDK build');
  assert.equal(s.workflows[0].medianQueueSec, 303);
  // A completed run is not fetched again.
  const before = calls.filter((c) => c.url.includes('/attempts/')).length;
  await ci.tick();
  assert.equal(calls.filter((c) => c.url.includes('/attempts/')).length, before);
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'ci', 'github.json'), 'utf8')).rate.remaining > 0);
});

test('before sign-in: statistics without names, hosts, branches, links or private repositories', () => {
  const ci = createCi({ dataDir: mkdtempSync(join(tmpdir(), 'ci-')), clock: () => T0 });
  const { id } = ci.addReporter('mac-runner-brian');
  ci.ingest(id, report([
    job(120, 30, { headRef: 'claude/strange-elbakyan', ref: 'refs/pull/5/merge' }),
    job(60, 20, { repo: 'dashpay/secret-infra', visibility: 'private', workflow: 'Deploy prod', name: 'ship it' }),
  ], { busy: true, job: { name: 'Rust tests', start: iso(T0 - 15 * 60_000), repo: 'dashpay/platform', runId: 7, workflow: 'Tests', headRef: 'feat/x' } }));
  const p = ci.publicSummary();
  const text = JSON.stringify(p);
  for (const leak of ['brian', 'mac-runner', '/Users/', 'actions-runner', 'claude/strange', 'refs/pull', 'secret-infra', 'Deploy prod', 'ship it', 'github.com', 'feat/x', 'platform-repositories'])
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.equal(p.public, true);
  assert.equal(p.hosts[0].label, 'macOS host 1');
  assert.equal(p.hosts[0].hostname, undefined);
  assert.equal(p.runners[0].name, 'macOS host 1 runner');
  assert.equal(p.runners[0].job.repo, 'dashpay/platform');
  assert.deepEqual(p.recent.map((j) => j.repo).sort(), ['dashpay/platform', 'private repository']);
  assert.equal(p.recent[0].runnerName, 'macOS host 1 runner');
  assert.equal(p.totals.jobs24h, 2);
  assert.equal(p.reporters, undefined);
});

test('dash-ci-pool hosts: pools count as capacity, single-use runner jobs are timed and anonymised', async () => {
  const pool = { name: 'light', controller: 'r730', backend: 'proxmox-lxc', labels: ['self-hosted', 'Linux', 'X64', 'dash-x64-light'], size: 4, idle: 2, busy: 1, starting: 1, draining: false, at: iso(T0),
    instances: [{ name: 'r730-light-aaaaaa', state: 'busy', since: iso(T0 - 60_000) }, { name: 'r730-light-bbbbbb', state: 'idle', since: iso(T0 - 600_000) }, { name: 'x', state: 'weird' }] };
  const poolJob = (startMin, runner, extra = {}) => job(startMin, 0.5, { runner, runnerName: runner, pool: 'light', repo: 'dashpay/dash', runId: 500 + startMin, workflow: 'CI', name: 'Lint', ...extra });
  const fetcher = async (url) => {
    const headers = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(T0 / 1000 + 3600) };
    const ghJob = (id, runner, offset) => ({ id, name: 'Lint', status: 'completed', conclusion: 'success', created_at: iso(T0 - 30 * 60_000 - 4000), started_at: iso(T0 - 30 * 60_000 + offset), completed_at: iso(T0 - 29 * 60_000), runner_name: runner, labels: ['dash-x64-light'], html_url: `https://github.com/dashpay/dash/actions/runs/530/job/${id}` });
    if (url.includes('/runs/530/attempts/1/jobs')) return Response.json({ jobs: [ghJob(9, 'r730-light-cccccc', 1000), ghJob(10, 'r730-light-eeeeee', 2000), ghJob(11, 'GitHub Actions 7', 0)] }, { headers });
    if (url.includes('status=')) return Response.json({ workflow_runs: [] }, { headers });
    return new Response('{}', { status: 404, headers });
  };
  const ci = createCi({ dataDir: mkdtempSync(join(tmpdir(), 'ci-')), clock: () => T0, fetcher, github: { id: 'cid', secret: 'sec' } });
  const { id } = ci.addReporter('r730');
  assert.throws(() => ci.ingest(id, { ...report(), pools: Array(9).fill(pool) }), /v1 report/);
  ci.ingest(id, { ...report([poolJob(30, 'r730-light-cccccc'), poolJob(90, 'r730-light-dddddd', { result: 'Failed' })]), runners: [], pools: [pool] });
  await ci.tick();
  const s = ci.summary();
  assert.equal(s.runners.length, 0);
  const p = s.pools[0];
  assert.deepEqual([p.status, p.size, p.online, p.busy, p.idle, p.starting], ['ok', 4, 3, 1, 2, 1]);
  assert.deepEqual(p.running, [{ name: 'r730-light-aaaaaa', since: iso(T0 - 60_000) }]);
  ci.ingest(id, { ...report(), runners: [], pools: [{ ...pool, idle: 1, starting: 0 }] });
  assert.equal(ci.summary().pools[0].status, 'short');
  // Draining empties the pool on purpose: what is left is the capacity, not its size.
  ci.ingest(id, { ...report(), runners: [], pools: [{ ...pool, idle: 0, starting: 0, draining: true }] });
  const drained = ci.summary();
  assert.deepEqual([drained.pools[0].status, drained.totals.runners, drained.totals.online], ['draining', 1, 1]);
  ci.ingest(id, { ...report(), runners: [], pools: [pool] });
  assert.deepEqual([p.day.jobs, p.day.failed, p.day.busySec], [2, 1, 60]);
  // A second controller's light pool on the same reporter keeps its own jobs.
  ci.ingest(id, { ...report(), runners: [], pools: [pool, { ...pool, controller: 'other' }] });
  assert.deepEqual(ci.summary().pools.map((x) => x.day.jobs), [2, 0]);
  ci.ingest(id, { ...report(), runners: [], pools: [pool] });
  assert.equal(p.hours.length, 48);
  assert.deepEqual([s.totals.runners, s.totals.online, s.totals.busy, s.totals.jobs24h, s.totals.failed24h, s.totals.light24h], [4, 3, 1, 0, 0, 2]);
  // Light-pool jobs are counted apart from the real ones, not in the daily columns.
  assert.deepEqual([s.daily.at(-1).succeeded, s.daily.at(-1).failed, s.daily.at(-1).light, s.daily.at(-1).lightRunnerHours], [0, 0, 2, 0.02]);
  // The runner is gone, but its job is matched on GitHub by the name it ran under.
  const timed = s.recent.find((j) => j.runnerName === 'r730-light-cccccc');
  assert.equal(timed.queueSec, 5);
  assert.equal(timed.url, 'https://github.com/dashpay/dash/actions/runs/530/job/9');
  // Its run was complete when fetched; a job of the same run reported a minute later is still timed.
  ci.ingest(id, { ...report([poolJob(30, 'r730-light-eeeeee', { start: iso(T0 - 30 * 60_000 + 2000) })]), runners: [], pools: [pool] });
  assert.equal(ci.summary().recent.find((j) => j.runnerName === 'r730-light-eeeeee').queueSec, 6);

  const pub = ci.publicSummary();
  const text = JSON.stringify(pub);
  for (const leak of ['r730', 'cccccc']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.equal(pub.pools[0].hostLabel, 'macOS host 1');
  assert.deepEqual(pub.pools[0].running, [{ since: iso(T0 - 60_000) }]);
  assert.equal(pub.recent[0].runnerName, 'macOS host 1 · light pool');

  // No report for four minutes: the pool is offline and none of it counts as online.
  let later = T0;
  const stale = createCi({ dataDir: mkdtempSync(join(tmpdir(), 'ci-')), clock: () => later });
  stale.ingest(stale.addReporter('r730').id, { ...report(), runners: [], pools: [pool] });
  later += 4 * 60_000;
  const off = stale.summary();
  assert.deepEqual([off.pools[0].status, off.pools[0].online, off.pools[0].running.length, off.totals.online], ['offline', 0, 0, 0]);
});
