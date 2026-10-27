// Organisation-wide GitHub Actions queue: every workflow job in the org that is
// waiting for a runner or running on one, whichever runner (GitHub-hosted or
// self-hosted) it wants. An org webhook delivers `workflow_job` events as they
// happen; a periodic sweep of the REST API adds jobs queued before the webhook
// existed, drops jobs whose completion was never delivered, and lists runs that
// have been stuck for more than a day.
//
//   data/ci/org-queue.json   active jobs, last 24 h of finished jobs, label sets served
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { median, pctile, str } from './ci.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SWEEP_MS = 15 * 60_000;
// Repositories with no push for this long rarely run anything (GitHub disables their schedules).
const ACTIVE_REPO_DAYS = 60;
// GitHub ends a job that waited 24 h for a runner; a run queued longer will never start.
const STUCK_MS = DAY;
// The sweep shares the OAuth app's hourly budget with ci.js (which stops at 200).
const RATE_FLOOR = 1500;
const MAX_JOB_CALLS = 300;
const PAGES = 5;
// Jobs not yet given a runner: requested, pending (concurrency group), waiting (environment approval), queued.
const RANK = { requested: 0, pending: 0, waiting: 0, queued: 0, in_progress: 1, completed: 2 };
// Held before a runner is asked for: a concurrency group (pending) or an environment approval (waiting).
const HELD = new Set(['pending', 'waiting']);
// Without an update for this long, a job is shown as unverified: it may have finished unseen.
const STALE_MS = 2 * HOUR;
// No workflow run lasts longer; a job not heard of since is dropped.
const MAX_AGE_MS = 35 * DAY;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const id = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const labelKey = (labels) => JSON.stringify([...labels].sort());
const hostedLabels = (labels) => labels.length > 0 && labels.every((l) => /^(ubuntu|windows|macos)-/i.test(l));

// One workflow job, from a webhook payload or the REST API (same shape).
function cleanJob(j, repo) {
  const jobId = id(j?.id);
  const status = Object.hasOwn(RANK, j?.status) ? j.status : null;
  if (!jobId || !status || !REPO.test(repo?.full_name || '')) return null;
  return {
    id: jobId, runId: id(j.run_id), attempt: id(j.run_attempt) || 1, repo: repo.full_name, private: repo.private !== false,
    workflow: str(j.workflow_name), name: str(j.name, 300) || '—', status, conclusion: str(j.conclusion, 20),
    labels: Array.isArray(j.labels) ? j.labels.slice(0, 12).map((l) => str(l, 60)).filter(Boolean) : [],
    createdAt: time(j.created_at), startedAt: RANK[status] === 0 ? null : time(j.started_at), completedAt: time(j.completed_at),
    runner: str(j.runner_name, 100), runnerGroup: str(j.runner_group_name, 100), branch: str(j.head_branch), url: str(j.html_url, 300),
  };
}

export function createOrgQueue({ dataDir, org = 'dashpay', secret = null, github = null, token = null, fetcher = fetch, clock = Date.now, log = () => {} }) {
  const path = join(dataDir, 'ci', 'org-queue.json');
  // served: label set -> last start by any job (`all`) and by a public-repository job (`pub`).
  // since / lastEventAt have public twins so the signed-out view never shows when private jobs ran.
  const st = { jobs: {}, done: [], served: {}, stuck: [], since: null, publicSince: null, lastEventAt: null, lastPublicEventAt: null, sweep: null, rate: null, ...readJSON(path, {}) };
  let saveTimer = null;
  // A failed write (disk full) must not crash the server or stop the sweep; the next save retries.
  const flush = () => { clearTimeout(saveTimer); try { writeAtomic(path, JSON.stringify(st)); } catch (e) { log('ci queue save:', e.message); } };
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1000); saveTimer.unref?.(); };
  const iso = () => new Date(clock()).toISOString();

  function verify(raw, header) {
    if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
    const got = Buffer.from(header);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  // Deliveries can arrive out of order: a job never moves back to an earlier state.
  // queuedAt: when it began waiting for a runner, after any concurrency or approval hold.
  function apply(job, seenAt) {
    const key = String(job.id);
    const prior = st.jobs[key];
    if (prior && RANK[prior.status] > RANK[job.status]) return false;
    if (st.done.some((d) => d.id === job.id)) return false;
    const queuedAt = prior?.queuedAt || (HELD.has(job.status) ? null : prior && HELD.has(prior.status) ? seenAt : job.createdAt || seenAt);
    if (job.startedAt && job.runnerGroup) {
      const k = labelKey(job.labels), s = { at: job.startedAt, hosted: job.runnerGroup === 'GitHub Actions' };
      st.served[k] = { ...st.served[k], all: s, ...(job.private ? {} : { pub: s }) };
    }
    if (job.status === 'completed') {
      delete st.jobs[key];
      st.done.push({ id: job.id, repo: job.repo, private: job.private, labels: job.labels, createdAt: job.createdAt || prior?.createdAt || null,
        queuedAt, startedAt: job.startedAt || prior?.startedAt || null, completedAt: job.completedAt || seenAt, conclusion: job.conclusion });
    } else {
      st.jobs[key] = { ...prior, ...job, createdAt: job.createdAt || prior?.createdAt || seenAt, queuedAt, seenAt };
    }
    return true;
  }

  function prune() {
    const now = clock();
    st.done = st.done.filter((d) => Date.parse(d.completedAt) > now - DAY).slice(-10_000);
    for (const [k, s] of Object.entries(st.served)) if (!s.all || Date.parse(s.all.at) < now - 30 * DAY) delete st.served[k];
  }

  // Who should hear that the queue changed: 'all', 'members' (a private job only) or false.
  function webhook(event, body) {
    if (event !== 'workflow_job') return false;
    if (body?.organization?.login && body.organization.login.toLowerCase() !== org.toLowerCase()) return false;
    const job = cleanJob(body?.workflow_job, body?.repository);
    if (!job) throw new Error('not a workflow_job event');
    st.lastEventAt = iso();
    st.since ||= st.lastEventAt;
    if (!job.private) { st.lastPublicEventAt = st.lastEventAt; st.publicSince ||= st.lastEventAt; }
    const changed = apply(job, st.lastEventAt);
    prune();
    save();
    return changed && (job.private ? 'members' : 'all');
  }

  // ---- sweep ---------------------------------------------------------------
  async function api(p) {
    if (st.rate && st.rate.remaining < RATE_FLOOR && st.rate.reset * 1000 > clock()) throw new Error('GitHub rate limit low; waiting for reset');
    const auth = token ? `Bearer ${token}` : github ? `Basic ${Buffer.from(`${github.id}:${github.secret}`).toString('base64')}` : null;
    const r = await fetcher(`https://api.github.com${p}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dash-status', 'X-GitHub-Api-Version': '2022-11-28', ...(auth ? { Authorization: auth } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const remaining = Number(r.headers.get('x-ratelimit-remaining')), reset = Number(r.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && Number.isFinite(reset)) st.rate = { remaining, reset };
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${p.split('?')[0]}`);
    return r.json();
  }
  // Up to PAGES pages of a list; `complete` is false when there may be more.
  async function pages(p, key) {
    const items = [];
    for (let page = 1; page <= PAGES; page++) {
      const v = await api(`${p}&per_page=100&page=${page}`);
      const list = key ? v?.[key] || [] : v || [];
      items.push(...list);
      if (list.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  async function sweep() {
    const started = clock();
    const startedAt = iso();
    st.since ||= startedAt;
    st.publicSince ||= startedAt;
    const cutoff = started - ACTIVE_REPO_DAYS * DAY;
    const repos = new Map(); // full_name -> repository object
    for (const r of (await pages(`/orgs/${org}/repos?type=${token ? 'all' : 'public'}`)).items) {
      if (!r.archived && Date.parse(r.pushed_at) > cutoff) repos.set(r.full_name, { full_name: r.full_name, private: r.private });
    }
    // A job we already track is checked even if its repository is quiet, and first: the job lookup cap may not reach the rest.
    const tracked = new Map();
    for (const j of Object.values(st.jobs)) if (token || !j.private) tracked.set(j.repo, repos.get(j.repo) || { full_name: j.repo, private: j.private });
    const order = [...tracked.values(), ...[...repos.values()].filter((r) => !tracked.has(r.full_name))];

    // listed: repositories whose active runs were all read, so their stuck runs are known.
    // covered: also every active job was read, so a tracked job missing there has finished.
    const seen = new Set(), stuck = [], listed = new Set(), covered = new Set(), stuckRuns = new Set();
    let error = null, jobCalls = 0;
    for (const repo of order) {
      try {
        const runs = new Map();
        let complete = true;
        for (const status of ['requested', 'queued', 'waiting', 'pending', 'in_progress']) {
          const res = await pages(`/repos/${repo.full_name}/actions/runs?status=${status}`, 'workflow_runs');
          for (const r of res.items) runs.set(r.id, r);
          complete &&= res.complete;
        }
        if (complete) listed.add(repo.full_name);
        for (const run of runs.values()) {
          // A re-run keeps created_at; run_started_at is the current attempt. Approval waits may last weeks.
          const since = run.run_started_at || run.created_at;
          if (Date.parse(since) < started - STUCK_MS && !['in_progress', 'waiting'].includes(run.status)) {
            stuck.push({ repo: repo.full_name, private: repo.private, runId: run.id, workflow: str(run.name), status: str(run.status, 20), event: str(run.event, 40),
              branch: str(run.head_branch), createdAt: time(since), url: str(run.html_url, 300), confirmedAt: startedAt });
            stuckRuns.add(run.id);
            continue;
          }
          if (jobCalls >= MAX_JOB_CALLS) { complete = false; continue; }
          jobCalls++;
          const res = await pages(`/repos/${repo.full_name}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
          complete &&= res.complete;
          for (const raw of res.items) {
            const job = cleanJob({ ...raw, workflow_name: raw.workflow_name || run.name, head_branch: raw.head_branch || run.head_branch }, repo);
            if (!job) continue;
            seen.add(job.id);
            apply(job, startedAt);
          }
        }
        if (complete) covered.add(repo.full_name);
      } catch (e) { error = `${repo.full_name}: ${e.message}`; if (/rate limit/.test(e.message)) break; }
    }
    // A job the sweep could see but did not find has finished; its completion event was lost.
    for (const [k, j] of Object.entries(st.jobs)) {
      if (covered.has(j.repo) && !seen.has(j.id) && !stuckRuns.has(j.runId) && Date.parse(j.seenAt) < started) delete st.jobs[k];
    }
    // Repositories the sweep could not list keep their earlier stuck runs for a while.
    const keepOld = (r) => !listed.has(r.repo) && (repos.has(r.repo) || tracked.has(r.repo)) && Date.parse(r.confirmedAt) > started - 2 * HOUR;
    st.stuck = [...stuck, ...st.stuck.filter(keepOld)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    st.sweep = { at: startedAt, ms: clock() - started, repos: covered.size, scope: token ? 'all' : 'public', error };
  }

  // Jobs the sweep cannot check (private repositories without a token) are shown as unverified
  // rather than dropped (an approval can wait for weeks); only jobs older than any run are.
  // Returns who should hear of it, like webhook().
  function expire() {
    const now = clock();
    let changed = false;
    for (const [k, j] of Object.entries(st.jobs)) {
      if (now - Date.parse(j.createdAt) > MAX_AGE_MS && now - Date.parse(j.seenAt) > STALE_MS) { delete st.jobs[k]; changed = changed === 'all' || !j.private ? 'all' : 'members'; }
    }
    return changed;
  }

  let ticking = false;
  async function tick() {
    if (ticking) return false;
    const due = (token || github) && (!st.sweep || clock() - Date.parse(st.sweep.at) >= SWEEP_MS);
    if (!due) { const changed = expire(); prune(); if (changed) save(); return changed; }
    ticking = true;
    // Sweeps run on a fixed schedule, so telling everyone reveals nothing about private jobs.
    try { await sweep(); return 'all'; } catch (e) { log('ci queue sweep:', e.message); st.sweep = { ...st.sweep, at: iso(), error: e.message }; return false; } finally { ticking = false; expire(); prune(); flush(); }
  }

  // ---- view ----------------------------------------------------------------
  // Signed out: public repositories only, without branches, links or runner names.
  function summary({ full = false } = {}) {
    const now = clock();
    const keep = (x) => full || !x.private;
    // Jobs of a stuck run are listed with the run, not as waiting.
    const stuckRuns = new Set(st.stuck.map((r) => r.runId));
    const active = Object.values(st.jobs).filter((j) => keep(j) && !stuckRuns.has(j.runId));
    const since = (j) => j.queuedAt || j.createdAt;
    const waiting = active.filter((j) => RANK[j.status] === 0 && !HELD.has(j.status)).sort((a, b) => since(a).localeCompare(since(b)));
    const held = active.filter((j) => HELD.has(j.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const running = active.filter((j) => j.status === 'in_progress').sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    // Skipped jobs (an `if:` was false) never wait for a runner; cancelled ones may never have reached one.
    const done = st.done.filter((d) => keep(d) && d.conclusion !== 'skipped');
    // Runner wait only: from queued (after any hold) to started.
    const waitSec = (d) => (d.conclusion !== 'cancelled' && d.startedAt && since(d) ? Math.max(0, (Date.parse(d.startedAt) - Date.parse(since(d))) / 1000) : null);
    const stuck = st.stuck.filter(keep);

    const groups = new Map();
    const group = (labels) => {
      const k = labelKey(labels);
      if (!groups.has(k)) {
        const served = st.served[k]?.[full ? 'all' : 'pub'];
        groups.set(k, { key: k, labels: [...labels].sort(), hosted: served ? served.hosted : hostedLabels(labels), lastStartedAt: served?.at || null, waiting: 0, oldestWaitingAt: null, held: 0, running: 0, finished24h: 0, waits: [] });
      }
      return groups.get(k);
    };
    const waits = [];
    for (const j of waiting) { const g = group(j.labels); g.waiting++; g.oldestWaitingAt ||= since(j); }
    for (const j of held) group(j.labels).held++;
    for (const j of running) group(j.labels).running++;
    for (const d of done) { const g = group(d.labels); g.finished24h++; const w = waitSec(d); if (w != null) { g.waits.push(w); waits.push(w); } }
    const labels = [...groups.values()].map(({ waits: w, ...g }) => ({ ...g, medianWaitSec: median(w), p90WaitSec: pctile(w, 0.9) }))
      .sort((a, b) => b.waiting - a.waiting || b.running - a.running || b.held - a.held || b.finished24h - a.finished24h);

    const stale = (j) => now - Date.parse(j.seenAt) > STALE_MS;
    const view = (j) => ({ id: j.id, repo: j.repo, workflow: j.workflow, name: j.name, status: j.status, labels: j.labels, createdAt: j.createdAt, queuedAt: j.queuedAt || null, startedAt: j.startedAt, stale: stale(j),
      ...(full ? { private: j.private, runner: j.runner, runnerGroup: j.runnerGroup, branch: j.branch, url: j.url || (j.runId ? `https://github.com/${j.repo}/actions/runs/${j.runId}` : null) } : {}) });
    return {
      public: !full, at: new Date(now).toISOString(), org,
      configured: { webhook: !!secret, sweep: token ? 'all' : github ? 'public' : null },
      since: full ? st.since : st.publicSince, lastEventAt: full ? st.lastEventAt : st.lastPublicEventAt,
      sweep: st.sweep && { at: st.sweep.at, scope: st.sweep.scope, ...(full ? { repos: st.sweep.repos, error: st.sweep.error, rate: st.rate } : {}) },
      totals: {
        waiting: waiting.length, oldestWaitingAt: waiting[0] ? since(waiting[0]) : null, running: running.length,
        held: held.length, approval: held.filter((j) => j.status === 'waiting').length, concurrency: held.filter((j) => j.status === 'pending').length,
        unverified: active.filter(stale).length,
        finished24h: done.length, medianWaitSec24h: median(waits), p90WaitSec24h: pctile(waits, 0.9), stuck: stuck.length,
      },
      labels,
      waiting: waiting.slice(0, 500).map(view),
      held: held.slice(0, 500).map(view),
      running: running.slice(0, 500).map(view),
      stuck: stuck.map((r) => ({ repo: r.repo, workflow: r.workflow, status: r.status, event: r.event, createdAt: r.createdAt, ...(full ? { branch: r.branch, url: r.url } : {}) })),
    };
  }

  return { verify, webhook, tick, summary, flush, configured: () => !!secret };
}
