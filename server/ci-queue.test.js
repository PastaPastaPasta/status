import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrgQueue } from './ci-queue.js';

const T0 = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dir = () => mkdtempSync(join(tmpdir(), 'ciq-'));
const repo = (name = 'dashpay/dash', priv = false) => ({ full_name: name, private: priv });
const job = (id, status, extra = {}) => ({
  id, run_id: 1000 + id, run_attempt: 1, workflow_name: 'CI', name: `build ${id}`, status, conclusion: status === 'completed' ? 'success' : null,
  labels: ['ubuntu-24.04'], created_at: iso(T0 - 10 * 60_000), started_at: status === 'queued' ? null : iso(T0 - 4 * 60_000),
  runner_name: status === 'queued' ? null : 'GitHub Actions 7', runner_group_name: status === 'queued' ? null : 'GitHub Actions',
  head_branch: 'feat/x', html_url: `https://github.com/dashpay/dash/actions/runs/${1000 + id}/job/${id}`, ...extra,
});
const event = (j, r = repo()) => ({ action: j.status, workflow_job: j, repository: r, organization: { login: 'dashpay' } });

test('webhook signatures are checked against the exact body', () => {
  const q = createOrgQueue({ dataDir: dir(), secret: 's3cret', clock: () => T0 });
  const raw = Buffer.from('{"a":1}');
  const sig = `sha256=${createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
  assert.equal(q.verify(raw, sig), true);
  assert.equal(q.verify(Buffer.from('{"a":2}'), sig), false);
  assert.equal(q.verify(raw, sig.slice(0, -1)), false);
  assert.equal(q.verify(raw, undefined), false);
  assert.equal(createOrgQueue({ dataDir: dir(), clock: () => T0 }).verify(raw, sig), false);
});

test('jobs move from waiting to running to finished, never backwards', () => {
  const q = createOrgQueue({ dataDir: dir(), secret: 's', clock: () => T0 });
  assert.equal(q.webhook('workflow_job', event(job(1, 'queued'))), 'all');
  assert.equal(q.webhook('workflow_job', event(job(2, 'queued', { labels: ['dash-x64-light'] }))), 'all');
  let s = q.summary({ full: true });
  assert.equal(s.totals.waiting, 2);
  assert.deepEqual(s.waiting.map((j) => j.id), [1, 2]);
  // Before any runner took dash-x64-light, its group is self-hosted by elimination and never served.
  assert.equal(s.labels.find((g) => g.labels[0] === 'dash-x64-light').hosted, false);
  assert.equal(s.labels.find((g) => g.labels[0] === 'dash-x64-light').lastStartedAt, null);

  q.webhook('workflow_job', event(job(1, 'in_progress')));
  assert.equal(q.webhook('workflow_job', event(job(1, 'queued'))), false, 'a late queued event does not undo in_progress');
  s = q.summary({ full: true });
  assert.deepEqual([s.totals.waiting, s.totals.running], [1, 1]);
  assert.equal(s.running[0].runner, 'GitHub Actions 7');

  q.webhook('workflow_job', event(job(1, 'completed', { completed_at: iso(T0) })));
  assert.equal(q.webhook('workflow_job', event(job(1, 'in_progress'))), false, 'a finished job stays finished');
  q.webhook('workflow_job', event(job(3, 'completed', { conclusion: 'skipped', labels: [], started_at: iso(T0 - 10 * 60_000) })));
  s = q.summary({ full: true });
  assert.deepEqual([s.totals.waiting, s.totals.running, s.totals.finished24h], [1, 0, 1]);
  assert.equal(s.totals.medianWaitSec24h, 360);
  const hosted = s.labels.find((g) => g.labels[0] === 'ubuntu-24.04');
  assert.equal(hosted.hosted, true);
  assert.equal(hosted.lastStartedAt, iso(T0 - 4 * 60_000));
  assert.equal(hosted.medianWaitSec, 360);

  // Other events and other organisations are ignored.
  assert.equal(q.webhook('workflow_run', { action: 'requested' }), false);
  assert.equal(q.webhook('workflow_job', { ...event(job(9, 'queued')), organization: { login: 'someone-else' } }), false);
  assert.throws(() => q.webhook('workflow_job', { workflow_job: { id: 'x' }, repository: repo() }), /not a workflow_job/);
});

test('signed-out view leaves out private repositories, branches, links and runners', () => {
  const q = createOrgQueue({ dataDir: dir(), secret: 's', clock: () => T0 });
  q.webhook('workflow_job', event(job(1, 'queued')));
  q.webhook('workflow_job', event(job(2, 'in_progress'), repo('dashpay/secret-hotfix', true)));
  const pub = q.summary();
  assert.equal(pub.public, true);
  assert.deepEqual(pub.waiting.map((j) => j.repo), ['dashpay/dash']);
  assert.equal(pub.running.length, 0);
  assert.equal(pub.waiting[0].branch, undefined);
  assert.equal(pub.waiting[0].url, undefined);
  assert.ok(!JSON.stringify(pub).includes('secret-hotfix'));
  const full = q.summary({ full: true });
  assert.equal(full.running[0].repo, 'dashpay/secret-hotfix');
  assert.equal(full.running[0].private, true);
  assert.equal(full.waiting[0].branch, 'feat/x');
});

test('the sweep backfills, drops jobs whose completion was lost, and lists stuck runs', async () => {
  let now = T0;
  const dataDir = dir();
  const calls = [];
  const runs = {
    'dashpay/dash': { queued: [{ id: 1001, name: 'CI', status: 'queued', event: 'pull_request', head_branch: 'feat/x', created_at: iso(T0 - 10 * 60_000) },
      { id: 77, name: 'Old CI', status: 'queued', event: 'pull_request_target', head_branch: 'chore/release', created_at: iso(T0 - 90 * 86_400_000), html_url: 'https://github.com/dashpay/dash/actions/runs/77' }] },
  };
  const fetcher = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const headers = { 'x-ratelimit-remaining': '4100', 'x-ratelimit-reset': String(T0 / 1000 + 3600) };
    const u = new URL(url);
    if (u.pathname === '/orgs/dashpay/repos') return Response.json([
      { full_name: 'dashpay/dash', private: false, archived: false, pushed_at: iso(T0 - 86_400_000) },
      { full_name: 'dashpay/old', private: false, archived: false, pushed_at: iso(T0 - 400 * 86_400_000) },
      { full_name: 'dashpay/gone', private: false, archived: true, pushed_at: iso(T0) },
    ], { headers });
    let m = /^\/repos\/(.+)\/actions\/runs$/.exec(u.pathname);
    if (m) return Response.json({ workflow_runs: runs[m[1]]?.[u.searchParams.get('status')] || [] }, { headers });
    m = /^\/repos\/(.+)\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    if (m && m[2] === '1001') return Response.json({ jobs: [job(1, 'queued'), job(2, 'completed', { completed_at: iso(T0 - 60_000) })] }, { headers });
    return new Response('{}', { status: 404, headers });
  };
  const q = createOrgQueue({ dataDir, secret: 's', github: { id: 'cid', secret: 'csec' }, fetcher, clock: () => now });
  // Delivered before the sweep, but its completion event never arrived.
  q.webhook('workflow_job', event(job(5, 'in_progress', { run_id: 1005 })));
  // A private job the public sweep cannot see: left alone.
  q.webhook('workflow_job', event(job(6, 'queued'), repo('dashpay/private', true)));
  now += 60_000;

  assert.equal(await q.tick(), 'all');
  assert.match(calls[0].url, /\/orgs\/dashpay\/repos\?type=public/);
  assert.match(calls[0].auth, /^Basic /);
  assert.ok(!calls.some((c) => c.url.includes('dashpay/old') || c.url.includes('dashpay/gone')), 'archived and quiet repositories are skipped');
  assert.ok(!calls.some((c) => c.url.includes('/runs/77/jobs')), 'stuck runs are listed without fetching their jobs');
  const s = q.summary({ full: true });
  assert.deepEqual(s.waiting.map((j) => j.id).sort(), [1, 6]);
  assert.equal(s.running.length, 0, 'job 5 was not found by the sweep, so it finished');
  assert.equal(s.totals.finished24h, 1);
  assert.equal(s.stuck.length, 1);
  assert.equal(s.stuck[0].url, 'https://github.com/dashpay/dash/actions/runs/77');
  assert.deepEqual([s.sweep.repos, s.sweep.scope, s.sweep.rate.remaining], [1, 'public', 4100]);

  // Not again until the interval has passed; state survives a restart.
  assert.equal(await q.tick(), false);
  const again = createOrgQueue({ dataDir, secret: 's', clock: () => now }).summary({ full: true });
  assert.deepEqual(again.waiting.map((j) => j.id).sort(), [1, 6]);
  assert.equal(again.stuck.length, 1);
});

test('a token sweeps private repositories too; with no credentials there is no sweep', async () => {
  const urls = [];
  const fetcher = async (url, opts) => { urls.push([url, opts.headers.Authorization]); return Response.json(url.includes('/orgs/') ? [] : { workflow_runs: [] }); };
  const q = createOrgQueue({ dataDir: dir(), token: 'ghp_x', fetcher, clock: () => T0 });
  await q.tick();
  assert.match(urls[0][0], /type=all/);
  assert.equal(urls[0][1], 'Bearer ghp_x');
  assert.equal(q.summary().configured.sweep, 'all');
  const none = createOrgQueue({ dataDir: dir(), fetcher: () => { throw new Error('no call expected'); }, clock: () => T0 });
  assert.equal(await none.tick(), false);
  assert.deepEqual(none.summary().configured, { webhook: false, sweep: null });
});

test('review regressions: re-runs, approval waits, long matrices and pending jobs are not lost', async () => {
  let now = T0;
  const old = iso(T0 - 3 * 86_400_000);
  const runs = {
    queued: [{ id: 1, name: 'CI', status: 'queued', created_at: old, run_started_at: iso(T0 - 5 * 60_000) }, // a re-run of a 3-day-old run
      { id: 3, name: 'Ghost', status: 'queued', created_at: old }],
    waiting: [{ id: 2, name: 'Deploy', status: 'waiting', created_at: old }],
  };
  const matrix = Array.from({ length: 150 }, (_, i) => job(500 + i, 'queued', { run_id: 1 }));
  const fetcher = async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (u.pathname === '/orgs/dashpay/repos') return Response.json([{ full_name: 'dashpay/dash', private: false, archived: false, pushed_at: iso(T0) }]);
    if (u.pathname === '/repos/dashpay/dash/actions/runs') return Response.json({ workflow_runs: runs[u.searchParams.get('status')] || [] });
    if (u.pathname === '/repos/dashpay/dash/actions/runs/1/jobs') return Response.json({ jobs: matrix.slice((page - 1) * 100, page * 100) });
    if (u.pathname === '/repos/dashpay/dash/actions/runs/2/jobs') return Response.json({ jobs: [job(900, 'waiting', { run_id: 2 })] });
    return new Response('{}', { status: 404 });
  };
  const q = createOrgQueue({ dataDir: dir(), secret: 's', github: { id: 'c', secret: 's' }, fetcher, clock: () => now });
  q.webhook('workflow_job', event(job(641, 'queued', { run_id: 1 })));      // on page 2 of the matrix
  q.webhook('workflow_job', event(job(950, 'queued', { run_id: 3 })));      // belongs to a stuck run: kept, not judged
  assert.equal(q.webhook('workflow_job', event(job(960, 'pending'))), 'all'); // waiting on a concurrency group
  now += 60_000;
  await q.tick();
  const s = q.summary({ full: true });
  assert.deepEqual(s.stuck.map((r) => r.workflow), ['Ghost'], 'neither the re-run nor the approval wait is stuck');
  const ids = new Set(s.waiting.map((j) => j.id));
  for (const want of [641, 649]) assert.ok(ids.has(want), `job ${want} is still waiting`);
  assert.deepEqual(s.held.map((j) => j.id), [900], 'the approval wait is held, not waiting for a runner');
  assert.equal(ids.has(960), false, 'a pending job the covered sweep no longer sees has finished');
  assert.equal(s.totals.waiting, 150, 'job 950 is shown with its stuck run, not as waiting');
});

test('the public view does not reveal private activity through aggregates', async () => {
  const fetcher = async (url) => Response.json(url.includes('/orgs/') ? [{ full_name: 'dashpay/secret', private: true, archived: false, pushed_at: iso(T0) }] : { workflow_runs: [] });
  const q = createOrgQueue({ dataDir: dir(), secret: 's', token: 't', fetcher, clock: () => T0 });
  q.webhook('workflow_job', event(job(1, 'in_progress', { labels: ['dash-x64-light'] }), repo('dashpay/secret', true)));
  await q.tick();
  const pub = q.summary();
  assert.equal(pub.lastEventAt, null);
  assert.equal(pub.sweep.repos, undefined);
  assert.equal(pub.labels.length, 0);
  q.webhook('workflow_job', event(job(2, 'queued', { labels: ['dash-x64-light'] })));
  assert.equal(q.summary().labels[0].lastStartedAt, null, 'a private start is not shown on a public label row');
  assert.ok(q.summary({ full: true }).labels[0].lastStartedAt);
});

test('stuck runs clear once cancelled or once their repository leaves the sweep', async () => {
  let now = T0, stuckRun = true, archived = false;
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/orgs/dashpay/repos') return Response.json([{ full_name: 'dashpay/dash', private: false, archived, pushed_at: iso(T0) }]);
    const runs = stuckRun && u.searchParams.get('status') === 'queued' ? [{ id: 7, name: 'Old', status: 'queued', created_at: iso(T0 - 9 * 86_400_000) }] : [];
    return Response.json({ workflow_runs: runs });
  };
  const q = createOrgQueue({ dataDir: dir(), github: { id: 'c', secret: 's' }, fetcher, clock: () => now });
  await q.tick();
  assert.equal(q.summary().totals.stuck, 1);
  stuckRun = false; now += 20 * 60_000;
  await q.tick();
  assert.equal(q.summary().totals.stuck, 0, 'cancelled');
  stuckRun = true; now += 20 * 60_000;
  await q.tick();
  assert.equal(q.summary().totals.stuck, 1);
  archived = true; now += 20 * 60_000;
  await q.tick();
  assert.equal(q.summary().totals.stuck, 0, 'repository archived');
});

test('a failed save is logged and the sweep keeps running', async () => {
  let now = T0;
  const logs = [];
  const dataDir = dir();
  const fetcher = async (url) => Response.json(url.includes('/orgs/') ? [] : { workflow_runs: [] });
  const q = createOrgQueue({ dataDir, github: { id: 'c', secret: 's' }, fetcher, clock: () => now, log: (...a) => logs.push(a.join(' ')) });
  rmSync(join(dataDir, 'ci'), { recursive: true, force: true });
  writeFileSync(join(dataDir, 'ci'), 'not a directory');
  assert.equal(await q.tick(), 'all');
  assert.match(logs.join('\n'), /ci queue save:/);
  now += 20 * 60_000;
  assert.equal(await q.tick(), 'all', 'not stuck after a failed save');
});

test('held jobs are counted apart, and runner wait starts when a hold ends', () => {
  let now = T0 - 60 * 60_000;
  const q = createOrgQueue({ dataDir: dir(), secret: 's', clock: () => now });
  const created = iso(T0 - 60 * 60_000);
  q.webhook('workflow_job', event(job(1, 'pending', { created_at: created })));
  q.webhook('workflow_job', event(job(2, 'waiting', { created_at: created })));
  q.webhook('workflow_job', event(job(3, 'queued', { created_at: created })));
  let s = q.summary({ full: true });
  assert.deepEqual([s.totals.waiting, s.totals.held, s.totals.approval, s.totals.concurrency], [1, 2, 1, 1]);
  assert.deepEqual([s.labels[0].waiting, s.labels[0].held], [1, 2]);
  now = T0 - 30 * 60_000; // the concurrency group frees up
  q.webhook('workflow_job', event(job(1, 'queued', { created_at: created })));
  assert.equal(q.summary({ full: true }).waiting.find((j) => j.id === 1).queuedAt, new Date(now).toISOString());
  now = T0;
  q.webhook('workflow_job', event(job(1, 'completed', { created_at: created, started_at: iso(T0 - 20 * 60_000), completed_at: iso(T0) })));
  s = q.summary({ full: true });
  assert.equal(s.totals.medianWaitSec24h, 600, '10 min on the runner queue, not the 40 min since the job was created');
});

test('approval waits stay visible, marked unverified, instead of disappearing', () => {
  let now = T0;
  const q = createOrgQueue({ dataDir: dir(), secret: 's', clock: () => now });
  q.webhook('workflow_job', event(job(1, 'waiting'), repo('dashpay/private', true)));
  now += 37 * 3_600_000;
  q.tick();
  let s = q.summary({ full: true });
  assert.equal(s.held.length, 1);
  assert.equal(s.held[0].stale, true);
  assert.equal(s.totals.unverified, 1);
  now += 40 * 86_400_000; // longer than any workflow run can last
  q.tick();
  s = q.summary({ full: true });
  assert.equal(s.held.length, 0);
});

test('private activity changes neither public timestamps nor public notices', async () => {
  let now = T0;
  const q = createOrgQueue({ dataDir: dir(), secret: 's', clock: () => now });
  assert.equal(q.webhook('workflow_job', event(job(1, 'queued'), repo('dashpay/private', true))), 'members');
  assert.equal(q.summary().since, null);
  assert.equal(q.summary().lastEventAt, null);
  assert.ok(q.summary({ full: true }).since);
  now += 60_000;
  assert.equal(q.webhook('workflow_job', event(job(2, 'queued'))), 'all');
  assert.equal(q.summary().since, new Date(now).toISOString());
  assert.equal(q.webhook('workflow_job', event(job(2, 'queued'))), 'all', 'a repeat still refreshes, but reveals only public timing');
  q.webhook('workflow_job', event(job(2, 'completed')));
  now += 40 * 86_400_000;
  assert.equal(await q.tick(), 'members', 'dropping an old private job is announced to members only');
});
