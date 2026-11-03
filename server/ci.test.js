import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCi } from './ci.js';
import { createOrgQueue } from './ci-queue.js';

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
  assert.equal(r.day.jobs, 3); // the ledger's two finished jobs and the running one
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
  ], { busy: true, job: { name: 'Rust tests', start: iso(T0 - 15 * 60_000), repo: 'dashpay/platform', runId: 7, workflow: 'Tests', headRef: 'feat/x', visibility: 'public' } }));
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
  assert.deepEqual(p.running, [{ name: 'r730-light-aaaaaa', since: iso(T0 - 60_000), job: null }]);
  ci.ingest(id, { ...report(), runners: [], pools: [{ ...pool, idle: 1, starting: 0 }] });
  assert.equal(ci.summary().pools[0].status, 'short');
  // Draining empties the pool on purpose: what is left is the capacity, not its size.
  ci.ingest(id, { ...report(), runners: [], pools: [{ ...pool, idle: 0, starting: 0, draining: true }] });
  const drained = ci.summary();
  assert.deepEqual([drained.pools[0].status, drained.totals.runners, drained.totals.online], ['draining', 1, 1]);
  ci.ingest(id, { ...report(), runners: [], pools: [pool] });
  // Two ledger jobs of 30 s, plus the runner busy for the last minute.
  assert.deepEqual([p.day.jobs, p.day.failed, p.day.busySec], [3, 1, 120]);
  // A second controller's light pool on the same reporter keeps its own jobs.
  ci.ingest(id, { ...report(), runners: [], pools: [pool, { ...pool, controller: 'other', instances: [] }] });
  assert.deepEqual(ci.summary().pools.map((x) => x.day.jobs), [3, 0]);
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
  assert.deepEqual(pub.pools[0].running, [{ since: iso(T0 - 60_000), job: null }]);
  assert.equal(pub.recent[0].runnerName, 'macOS host 1 · light pool');

  // No report for four minutes: the pool is offline and none of it counts as online.
  let later = T0;
  const stale = createCi({ dataDir: mkdtempSync(join(tmpdir(), 'ci-')), clock: () => later });
  stale.ingest(stale.addReporter('r730').id, { ...report(), runners: [], pools: [pool] });
  later += 4 * 60_000;
  const off = stale.summary();
  assert.deepEqual([off.pools[0].status, off.pools[0].online, off.pools[0].running.length, off.totals.online], ['offline', 0, 0, 0]);
});

test('pools without a job ledger: busy time is sampled from the busy runners each report lists', () => {
  let now = T0;
  const dataDir = mkdtempSync(join(tmpdir(), 'ci-'));
  const ci = createCi({ dataDir, clock: () => now });
  const { id } = ci.addReporter('r730');
  const busy = (name, sinceMs) => ({ name, state: 'busy', since: iso(sinceMs) });
  const build = (instances) => ({ name: 'build', controller: 'r730', backend: 'qemu-vm', labels: ['self-hosted', 'dash-x64-build'], size: 2, idle: 2 - instances.length, busy: instances.length, starting: 0, draining: false, at: iso(now), instances });
  const send = (instances, jobs = []) => ci.ingest(id, { ...report(jobs), at: iso(now), runners: [], pools: [build(instances)] });
  // Busy since 30 minutes ago, still busy ten minutes later, then gone. Names
  // from another controller, and a later `since` for a known runner, are ignored.
  send([busy('r730-build-aaaaaa', T0 - 30 * 60_000), busy('other-build-ffffff', T0 - 30 * 60_000)]);
  now += 10 * 60_000;
  send([busy('r730-build-aaaaaa', T0 - 5 * 60_000), busy('r730-build-bbbbbb', now - 60_000)]);
  now += 10 * 60_000;
  send([busy('r730-build-bbbbbb', T0 + 9 * 60_000)]);
  // aaaaaa: 40 min up to its last busy report; bbbbbb: 11 min and running.
  let p = ci.summary().pools[0];
  assert.deepEqual([p.day.jobs, p.day.failed, p.day.busySec], [2, 0, (40 + 11) * 60]);
  now += 2 * 60_000; // a running job keeps counting until the report goes stale
  assert.equal(ci.summary().pools[0].day.busySec, (40 + 13) * 60);
  now += 2 * 60_000;
  assert.equal(ci.summary().pools[0].day.busySec, (40 + 11) * 60);
  now -= 2 * 60_000;
  const hour = ci.summary().pools[0].hours.find((x) => x.hour === '2026-09-29T11:00Z');
  assert.equal(hour.busy, 30 / 120); // 30 of its 2 runners' 120 minutes
  assert.ok(ci.summary().totals.utilization24h > 0);
  // Once the ledger has a runner's finished job, the job is used instead of its span,
  // even while a report still lists the runner busy.
  const ledgered = { runner: 'r730-build-bbbbbb', runnerName: 'r730-build-bbbbbb', name: 'build', start: iso(T0 + 9 * 60_000), end: iso(now - 60_000), result: 'Failed', pool: 'build' };
  send([], [ledgered]);
  send([busy('r730-build-bbbbbb', T0 + 9 * 60_000)]);
  p = ci.summary().pools[0];
  assert.deepEqual([p.day.jobs, p.day.failed, p.day.busySec], [2, 1, (40 + 12) * 60]);
  assert.ok(!JSON.stringify(ci.publicSummary()).includes('aaaaaa'));
  // A job stopped at its time limit has no end in the ledger: its span keeps the busy time.
  now += 60_000;
  send([busy('r730-build-cccccc', now - 10 * 60_000)]);
  now += 60_000;
  const abandoned = { runner: 'r730-build-cccccc', runnerName: 'r730-build-cccccc', name: 'build', start: iso(now - 11 * 60_000), end: null, result: 'Abandoned', pool: 'build' };
  send([], [abandoned]);
  p = ci.summary().pools[0];
  assert.deepEqual([p.day.jobs, p.day.busySec], [3, (40 + 12 + 10) * 60]);
  // A `since` ahead of the server's clock starts now; the host's clock skew is measured from its `at`.
  // A job that started over 24 hours ago adds busy time but not to the day's count.
  ci.ingest(id, { ...report(), at: iso(now - 60_000), runners: [], pools: [build([busy('r730-build-dddddd', now + 60 * 60_000), busy('r730-build-eeeeee', now - 3 * 60_000), busy('r730-build-gggggg', now - 25 * 3_600_000)])] });
  const spans = JSON.parse(readFileSync(join(dataDir, 'ci', 'hosts', `${id}.json`), 'utf8')).spans;
  assert.deepEqual([spans['r730-build-dddddd'].start, spans['r730-build-eeeeee'].start], [now, now - 2 * 60_000]);
  assert.equal(ci.summary().pools[0].day.jobs, 3 + 2);
  assert.equal(spans['other-build-ffffff'], undefined);
  // Spans older than the 48-hour strip are dropped.
  now += 50 * 3_600_000;
  send([]);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'ci', 'hosts', `${id}.json`), 'utf8')).spans, {});
});

test('a pool lists the job each busy runner runs, from the org Actions queue, oldest first', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ci-'));
  const q = createOrgQueue({ dataDir, secret: 's', clock: () => T0 });
  const ci = createCi({ dataDir, clock: () => T0, runningJobs: q.runningJobs });
  const ghJob = (id, name, runner, repo, priv, status = 'in_progress') => q.webhook('workflow_job', { organization: { login: 'dashpay' }, repository: { full_name: repo, private: priv },
    workflow_job: { id, run_id: 900 + id, run_attempt: 1, workflow_name: priv ? 'Deploy prod' : 'Tests', name, status, labels: ['self-hosted', 'dash-x64-build'], created_at: iso(T0 - 12 * 60_000),
      started_at: iso(T0 - 9 * 60_000), runner_name: runner, runner_group_name: 'Default', head_branch: 'feat/x', html_url: `https://github.com/${repo}/actions/runs/${900 + id}/job/${id}` } });
  ghJob(1, 'Rust workspace tests', 'r730-build-aaaaaa', 'dashpay/platform', false);
  ghJob(2, 'ship it', 'r730-build-bbbbbb', 'dashpay/secret-infra', true);
  ghJob(3, 'Lint', 'r730-build-dddddd', 'dashpay/platform', false);
  ghJob(3, 'Lint', 'r730-build-dddddd', 'dashpay/platform', false, 'completed');
  const { id } = ci.addReporter('r730');
  const busy = (name, min) => ({ name, state: 'busy', since: min == null ? null : iso(T0 - min * 60_000) });
  const build = { name: 'build', controller: 'r730', backend: 'qemu-vm', labels: ['self-hosted', 'dash-x64-build'], size: 4, idle: 0, busy: 4, starting: 0, draining: false, at: iso(T0),
    instances: [busy('r730-build-eeeeee'), busy('r730-build-dddddd', 3), busy('r730-build-bbbbbb', 5), busy('r730-build-aaaaaa', 9), busy('r730-build-cccccc', 20)] };
  // A runner running, for over a day, a job of a private repository the ledger has not seen finish.
  const longJob = { name: 'ship it', start: iso(T0 - 25 * 3_600_000), repo: 'dashpay/secret-infra', runId: 7, workflow: 'Deploy prod' };
  ci.ingest(id, { ...report([], { busy: true, job: longJob }), pools: [build] });

  const running = ci.summary().pools[0].running;
  assert.deepEqual(running.map((i) => i.name), ['r730-build-cccccc', 'r730-build-aaaaaa', 'r730-build-bbbbbb', 'r730-build-dddddd', 'r730-build-eeeeee']);
  // Not (yet) known to GitHub, or its job already finished: listed without a job.
  assert.deepEqual([running[0].job, running[3].job, running[4].job], [null, null, null]);
  assert.deepEqual(running[1].job, { repo: 'dashpay/platform', private: false, runId: 901, workflow: 'Tests', name: 'Rust workspace tests', start: iso(T0 - 9 * 60_000), url: 'https://github.com/dashpay/platform/actions/runs/901/job/1' });
  assert.equal(running[2].job.name, 'ship it');

  const pub = ci.publicSummary();
  assert.deepEqual(pub.pools[0].running, [
    { since: iso(T0 - 20 * 60_000), job: null },
    { since: iso(T0 - 9 * 60_000), job: { name: 'Rust workspace tests', repo: 'dashpay/platform', workflow: 'Tests', start: iso(T0 - 9 * 60_000) } },
    // Signed out, when a private job runs stays private: the runner only reads as busy.
    { since: iso(T0 - 5 * 60_000), job: null },
    { since: iso(T0 - 3 * 60_000), job: null },
    { since: null, job: null },
  ]);
  // The running job counts in the runner's day only if it started within it.
  assert.equal(ci.summary().runners[0].day.jobs, 0);
  // GitHub marks the repository private, so the runner's job is masked too.
  assert.deepEqual(pub.runners[0].job, { name: null, repo: 'private repository', workflow: 'private workflow', start: longJob.start });
  const text = JSON.stringify(pub);
  for (const leak of ['r730', 'aaaaaa', 'github.com', 'secret-infra', 'ship it', 'Deploy prod', 'feat/x', 'Default']) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test('signed out, a runner shows its running job only when the reporter says the repository is public', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ci-'));
  const ci = createCi({ dataDir, clock: () => T0 });
  const start = iso(T0 - 4 * 60_000);
  const shownFor = (visibility) => {
    const { id } = ci.addReporter(`host-${visibility}`);
    ci.ingest(id, report([], { busy: true, job: { name: 'ship it', start, repo: 'dashpay/secret-infra', runId: 8, workflow: 'Deploy prod', ...(visibility && { visibility }) } }));
    const pub = ci.publicSummary();
    ci.removeReporter(id);
    return pub.runners[0].job;
  };
  // No ledger entry and no queue match: only the reporter's visibility can tell.
  const masked = { name: null, repo: 'private repository', workflow: 'private workflow', start };
  assert.deepEqual(shownFor('private'), masked);
  assert.deepEqual(shownFor(undefined), masked);
  assert.deepEqual(shownFor('public'), { name: 'ship it', repo: 'dashpay/secret-infra', workflow: 'Deploy prod', start });
});
