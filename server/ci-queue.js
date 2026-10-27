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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SWEEP_MS = 15 * 60_000;
// Repositories with no push for this long rarely run anything (GitHub disables their schedules).
const ACTIVE_REPO_DAYS = 60;
// GitHub ends a job that waited 24 h for a runner; anything older is a run GitHub will never start.
const STUCK_MS = DAY;
const RANK = { queued: 0, waiting: 0, in_progress: 1, completed: 2 };
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);
const id = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const pctile = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export const labelKey = (labels) => JSON.stringify([...labels].sort());
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
    createdAt: time(j.created_at), startedAt: status === 'queued' || status === 'waiting' ? null : time(j.started_at), completedAt: time(j.completed_at),
    runner: str(j.runner_name, 100), runnerGroup: str(j.runner_group_name, 100), branch: str(j.head_branch), url: str(j.html_url, 300),
  };
}

export function createOrgQueue({ dataDir, org = 'dashpay', secret = null, github = null, token = null, fetcher = fetch, clock = Date.now, log = () => {} }) {
  const path = join(dataDir, 'ci', 'org-queue.json');
  const st = { jobs: {}, done: [], served: {}, stuck: [], since: null, lastEventAt: null, sweep: null, rate: null, ...readJSON(path, {}) };
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeAtomic(path, JSON.stringify(st)), 1000); saveTimer.unref?.(); };
  const flush = () => { clearTimeout(saveTimer); writeAtomic(path, JSON.stringify(st)); };
  const iso = () => new Date(clock()).toISOString();

  function verify(raw, header) {
    if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
    const got = Buffer.from(header);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  // Deliveries can arrive out of order: a job never moves back to an earlier state.
  function apply(job, seenAt) {
    const key = String(job.id);
    const prior = st.jobs[key];
    if (prior && RANK[prior.status] > RANK[job.status]) return false;
    if (st.done.some((d) => d.id === job.id)) return false;
    if (job.startedAt && job.runnerGroup) st.served[labelKey(job.labels)] = { at: job.startedAt, hosted: job.runnerGroup === 'GitHub Actions' };
    if (job.status === 'completed') {
      delete st.jobs[key];
      st.done.push({ id: job.id, repo: job.repo, private: job.private, labels: job.labels, createdAt: job.createdAt || prior?.createdAt || null,
        startedAt: job.startedAt || prior?.startedAt || null, completedAt: job.completedAt || seenAt, conclusion: job.conclusion });
    } else {
      st.jobs[key] = { ...prior, ...job, createdAt: job.createdAt || prior?.createdAt || seenAt, seenAt };
    }
    return true;
  }

  function prune() {
    const now = clock();
    st.done = st.done.filter((d) => Date.parse(d.completedAt) > now - DAY).slice(-10_000);
    for (const [k, s] of Object.entries(st.served)) if (Date.parse(s.at) < now - 30 * DAY) delete st.served[k];
  }

  // Returns true when the queue changed.
  function webhook(event, body) {
    if (event !== 'workflow_job') return false;
    if (body?.organization?.login && body.organization.login.toLowerCase() !== org.toLowerCase()) return false;
    const job = cleanJob(body?.workflow_job, body?.repository);
    if (!job) throw new Error('not a workflow_job event');
    st.lastEventAt = iso();
    st.since ||= st.lastEventAt;
    const changed = apply(job, st.lastEventAt);
    prune();
    save();
    return changed;
  }

  // ---- sweep ---------------------------------------------------------------
  async function api(p) {
    if (st.rate && st.rate.remaining < 500 && st.rate.reset * 1000 > clock()) throw new Error('GitHub rate limit low; waiting for reset');
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

  async function sweep() {
    const started = clock();
    const startedAt = iso();
    st.since ||= startedAt;
    const cutoff = started - ACTIVE_REPO_DAYS * DAY;
    const repos = new Map(); // full_name -> repository object
    for (let page = 1; page <= 10; page++) {
      const list = await api(`/orgs/${org}/repos?type=${token ? 'all' : 'public'}&per_page=100&page=${page}`);
      for (const r of list) if (!r.archived && Date.parse(r.pushed_at) > cutoff) repos.set(r.full_name, { full_name: r.full_name, private: r.private });
      if (list.length < 100) break;
    }
    // A job we already track is checked even if its repository is quiet.
    for (const j of Object.values(st.jobs)) if (!repos.has(j.repo) && (token || !j.private)) repos.set(j.repo, { full_name: j.repo, private: j.private });

    const seen = new Set(), stuck = [], covered = new Set();
    let error = null;
    for (const repo of repos.values()) {
      try {
        const runs = new Map();
        for (const status of ['queued', 'waiting', 'pending', 'in_progress']) {
          for (const r of (await api(`/repos/${repo.full_name}/actions/runs?status=${status}&per_page=100`))?.workflow_runs || []) runs.set(r.id, r);
        }
        for (const run of runs.values()) {
          if (Date.parse(run.created_at) < started - STUCK_MS && run.status !== 'in_progress') {
            stuck.push({ repo: repo.full_name, private: repo.private, runId: run.id, workflow: str(run.name), status: str(run.status, 20), event: str(run.event, 40),
              branch: str(run.head_branch), createdAt: time(run.created_at), url: str(run.html_url, 300) });
            continue;
          }
          const v = await api(`/repos/${repo.full_name}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
          for (const raw of v?.jobs || []) {
            const job = cleanJob({ ...raw, workflow_name: raw.workflow_name || run.name, head_branch: raw.head_branch || run.head_branch }, repo);
            if (!job) continue;
            seen.add(job.id);
            apply(job, startedAt);
          }
        }
        covered.add(repo.full_name);
      } catch (e) { error = `${repo.full_name}: ${e.message}`; if (/rate limit/.test(e.message)) break; }
    }
    // A job the sweep could see but did not find has finished; its completion event was lost.
    for (const [k, j] of Object.entries(st.jobs)) {
      if (covered.has(j.repo) && !seen.has(j.id) && Date.parse(j.seenAt) < started) delete st.jobs[k];
    }
    st.stuck = stuck.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    st.sweep = { at: startedAt, ms: clock() - started, repos: covered.size, scope: token ? 'all' : 'public', error };
    expire();
    prune();
    flush();
  }

  // Jobs the sweep cannot check (private repositories without a token) end on their own.
  function expire() {
    const now = clock();
    for (const [k, j] of Object.entries(st.jobs)) {
      const age = now - Date.parse(j.seenAt);
      if ((j.status === 'in_progress' && age > 6 * DAY) || (j.status !== 'in_progress' && now - Date.parse(j.createdAt) > STUCK_MS + 12 * HOUR && age > 12 * HOUR)) delete st.jobs[k];
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking || !(token || github)) return false;
    if (st.sweep && clock() - Date.parse(st.sweep.at) < SWEEP_MS) return false;
    ticking = true;
    try { await sweep(); return true; } catch (e) { log('ci queue sweep:', e.message); st.sweep = { ...st.sweep, at: iso(), error: e.message }; return false; } finally { ticking = false; }
  }

  // ---- view ----------------------------------------------------------------
  // Signed out: public repositories only, without branches, links or runner names.
  function summary({ full = false } = {}) {
    const now = clock();
    const keep = (x) => full || !x.private;
    const waiting = Object.values(st.jobs).filter((j) => j.status !== 'in_progress' && keep(j)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const running = Object.values(st.jobs).filter((j) => j.status === 'in_progress' && keep(j)).sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    // Skipped jobs (an `if:` was false) never wait for a runner.
    const done = st.done.filter((d) => keep(d) && d.conclusion !== 'skipped');
    const waitSec = (d) => (d.startedAt && d.createdAt ? Math.max(0, (Date.parse(d.startedAt) - Date.parse(d.createdAt)) / 1000) : null);
    const waits = done.map(waitSec).filter((x) => x != null);

    const groups = new Map();
    const group = (labels) => {
      const k = labelKey(labels);
      if (!groups.has(k)) {
        const served = st.served[k];
        groups.set(k, { key: k, labels: [...labels].sort(), hosted: served ? served.hosted : hostedLabels(labels), lastStartedAt: served?.at || null, waiting: 0, oldestWaitingAt: null, running: 0, finished24h: 0, waits: [] });
      }
      return groups.get(k);
    };
    for (const j of waiting) { const g = group(j.labels); g.waiting++; g.oldestWaitingAt ||= j.createdAt; }
    for (const j of running) group(j.labels).running++;
    for (const d of done) { const g = group(d.labels); g.finished24h++; const w = waitSec(d); if (w != null) g.waits.push(w); }
    const labels = [...groups.values()].map(({ waits: w, ...g }) => ({ ...g, medianWaitSec: median(w), p90WaitSec: pctile(w, 0.9) }))
      .sort((a, b) => b.waiting - a.waiting || b.running - a.running || b.finished24h - a.finished24h);

    const view = (j) => ({ id: j.id, repo: j.repo, workflow: j.workflow, name: j.name, status: j.status, labels: j.labels, createdAt: j.createdAt, startedAt: j.startedAt,
      ...(full ? { private: j.private, runner: j.runner, runnerGroup: j.runnerGroup, branch: j.branch, url: j.url || (j.runId ? `https://github.com/${j.repo}/actions/runs/${j.runId}` : null) } : {}) });
    return {
      public: !full, at: new Date(now).toISOString(), org,
      configured: { webhook: !!secret, sweep: token ? 'all' : github ? 'public' : null },
      since: st.since, lastEventAt: st.lastEventAt, sweep: st.sweep && { at: st.sweep.at, repos: st.sweep.repos, scope: st.sweep.scope, ...(full ? { error: st.sweep.error, rate: st.rate } : {}) },
      totals: {
        waiting: waiting.length, oldestWaitingAt: waiting[0]?.createdAt || null, running: running.length,
        finished24h: done.length, medianWaitSec24h: median(waits), p90WaitSec24h: pctile(waits, 0.9), stuck: st.stuck.filter(keep).length,
      },
      labels,
      waiting: waiting.slice(0, 500).map(view),
      running: running.slice(0, 500).map(view),
      stuck: st.stuck.filter(keep).map((r) => ({ repo: r.repo, workflow: r.workflow, status: r.status, event: r.event, createdAt: r.createdAt, ...(full ? { branch: r.branch, url: r.url } : {}) })),
    };
  }

  return { verify, webhook, tick, sweep, summary, flush, configured: () => !!secret };
}
