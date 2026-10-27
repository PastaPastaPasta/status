import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
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
  assert.equal(q.webhook('workflow_job', event(job(1, 'queued'))), true);
  assert.equal(q.webhook('workflow_job', event(job(2, 'queued', { labels: ['dash-x64-light'] }))), true);
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

  assert.equal(await q.tick(), true);
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
