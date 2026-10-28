// Self-hosted CI runners. A reporter on each runner host (ci/reporter) pushes
// host health, runner state and finished jobs every minute; GitHub's API adds
// queue times for public repositories and lists jobs waiting for our runners.
// Hosts running dash-ci-pool also report pools of single-use runners: a new
// runner (and name) per job, so a pool is shown as one row with its capacity.
//
//   data/ci/reporters.json      reporter id -> { label, hash (sha256 of token) }
//   data/ci/hosts/<id>.json     latest report of that host (+ hours it reported)
//   data/ci/jobs/<id>.json      its finished jobs, 30 days
//   data/ci/github.json         per-run GitHub job timing, current queue
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

const DAY = 86_400_000;
const KEEP_DAYS = 30;
const STALE_MS = 3 * 60_000;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

export const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const ts = (v) => (typeof v === 'string' && TS.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// owner/name as GitHub allows; never "." or ".." (they would reach other API paths).
const repoOf = (v) => (typeof v === 'string' && REPO.test(v) && !v.split('/').some((p) => p === '.' || p === '..') ? v : null);
export const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
export const pctile = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
// dash-ci-pool's light pool (dash-x64-light) runs seconds-long housekeeping jobs
// (cache checks, labelers, PR policy): thousands a day that would drown the real
// jobs, so job counts and the daily chart keep them apart.
const isLight = (j) => j.pool === 'light';

function cleanJob(j, hostId) {
  const start = ts(j?.start);
  const name = str(j?.name, 300);
  if (!start || !name) return null;
  return {
    host: hostId, runner: str(j.runner, 300), runnerName: str(j.runnerName, 100), name, start, end: ts(j.end),
    result: str(j.result, 20), repo: repoOf(j.repo), runId: int(j.runId), attempt: int(j.attempt) || 1,
    workflow: str(j.workflow), event: str(j.event, 40), headRef: str(j.headRef), ref: str(j.ref), visibility: str(j.visibility, 20), pool: str(j.pool, 40),
  };
}

function cleanReport(b) {
  if (b?.v !== 1 || typeof b.host !== 'object' || !Array.isArray(b.runners) || b.runners.length > 16 || (b.jobs && (!Array.isArray(b.jobs) || b.jobs.length > 500)) || (b.pools && (!Array.isArray(b.pools) || b.pools.length > 8))) throw new Error('not a dash-ci-reporter v1 report');
  const h = b.host;
  const usage = (u) => (u && typeof u === 'object' ? { count: int(u.count), bytes: num(u.bytes), reclaimable: num(u.reclaimable) } : null);
  const docker = h.docker && typeof h.docker === 'object' && !h.docker.error
    ? Object.fromEntries(['images', 'containers', 'volumes', 'buildCache'].map((k) => [k, usage(h.docker[k])]))
    : h.docker?.error ? { error: str(h.docker.error) } : null;
  const job = (j) => (j && typeof j === 'object' ? { name: str(j.name, 300), start: ts(j.start), repo: repoOf(j.repo), runId: int(j.runId), attempt: int(j.attempt) || 1, workflow: str(j.workflow), headRef: str(j.headRef), event: str(j.event, 40) } : null);
  return {
    reporter: str(b.reporter, 20), python: str(b.python, 20), at: ts(b.at),
    host: {
      hostname: str(h.hostname, 100), os: str(h.os, 100), arch: str(h.arch, 20), cpus: int(h.cpus),
      load: Array.isArray(h.load) ? h.load.slice(0, 3).map(num) : [], memTotal: num(h.memTotal), memUsed: num(h.memUsed), uptimeSec: num(h.uptimeSec),
      disks: Array.isArray(h.disks) ? h.disks.slice(0, 6).map((d) => ({ path: str(d?.path, 100), total: num(d?.total), free: num(d?.free) })) : [],
      docker,
    },
    runners: b.runners.filter((r) => typeof r?.key === 'string' && r.key).map((r) => ({
      key: str(r.key, 300), name: str(r.name, 100) || str(r.key, 100), pool: str(r?.pool, 100), org: str(r?.org, 100), kind: r?.kind === 'docker' ? 'docker' : 'native',
      container: str(r?.container, 100), version: str(r?.version, 20), listening: r?.listening === true, busy: r?.busy === true, job: job(r?.job),
      diag: r?.diag ? { bytes: num(r.diag.bytes), files: int(r.diag.files) } : null, error: str(r?.error, 300),
      containerState: r?.containerState ? { status: str(r.containerState.status, 20), startedAt: str(r.containerState.startedAt, 40), restarts: int(r.containerState.restarts) } : null,
    })),
    pools: (b.pools || []).filter((p) => typeof p?.name === 'string' && p.name).map((p) => ({
      name: str(p.name, 40), controller: str(p.controller, 40), backend: str(p.backend, 20), labels: Array.isArray(p.labels) ? p.labels.slice(0, 10).map((l) => str(l, 60)).filter(Boolean) : [],
      size: int(p.size) != null ? Math.min(p.size, 1000) : null, idle: int(p.idle), busy: int(p.busy), starting: int(p.starting), draining: p.draining === true, at: ts(p.at), error: str(p.error, 300),
      instances: Array.isArray(p.instances) ? p.instances.slice(0, 64).map((i) => ({ name: str(i?.name, 100), state: ['idle', 'busy', 'starting'].includes(i?.state) ? i.state : null, since: ts(i?.since) })).filter((i) => i.name && i.state) : [],
    })),
    jobs: b.jobs || [],
  };
}

export function createCi({ dataDir, fetcher = fetch, clock = Date.now, github = null, log = () => {} }) {
  const dir = join(dataDir, 'ci');
  const dirs = { hosts: join(dir, 'hosts'), jobs: join(dir, 'jobs') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const reportersPath = join(dir, 'reporters.json');
  const githubPath = join(dir, 'github.json');
  const reporters = () => readJSON(reportersPath, {});

  function addReporter(label) {
    const id = String(label || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!ID.test(id)) throw new Error('label must contain letters or digits');
    const all = reporters();
    if (Object.hasOwn(all, id)) throw new Error(`reporter ${id} already exists; remove it first to issue a new token`);
    const token = `dcr_${id}_${randomBytes(24).toString('base64url')}`;
    all[id] = { label: String(label).slice(0, 60), hash: sha256(token), createdAt: new Date(clock()).toISOString() };
    writeAtomic(reportersPath, JSON.stringify(all, null, 1));
    return { id, token };
  }
  function removeReporter(id) {
    const all = reporters();
    if (!Object.hasOwn(all, id)) throw new Error('no such reporter');
    delete all[id];
    writeAtomic(reportersPath, JSON.stringify(all, null, 1));
    for (const d of Object.values(dirs)) rmSync(join(d, `${id}.json`), { force: true });
  }
  function authenticate(header) {
    const m = /^Bearer (dcr_[A-Za-z0-9_-]{10,120})$/.exec(header || '');
    if (!m) return null;
    const hash = Buffer.from(sha256(m[1]), 'hex');
    for (const [id, r] of Object.entries(reporters())) {
      const want = Buffer.from(String(r.hash || ''), 'hex');
      if (want.length === hash.length && timingSafeEqual(want, hash)) return id;
    }
    return null;
  }

  const jobKey = (j) => `${j.runnerName || j.runner}|${j.start}|${j.name}`;
  function ingest(id, body) {
    const report = cleanReport(body);
    const now = clock();
    const hostPath = join(dirs.hosts, `${id}.json`);
    const prior = readJSON(hostPath, {});
    // Hours with at least one report: the utilisation strip tells offline from idle.
    const hour = new Date(now).toISOString().slice(0, 13);
    const seen = Object.fromEntries(Object.entries({ ...(prior.seen || {}), [hour]: 1 }).filter(([h]) => Date.parse(`${h}:00:00Z`) > now - 3 * DAY));
    const { jobs, ...rest } = report;
    writeAtomic(hostPath, JSON.stringify({ id, receivedAt: new Date(now).toISOString(), ...rest, seen }));
    const incoming = jobs.map((j) => cleanJob(j, id)).filter(Boolean);
    if (incoming.length) {
      const path = join(dirs.jobs, `${id}.json`);
      const merged = new Map(readJSON(path, []).map((j) => [jobKey(j), j]));
      for (const j of incoming) merged.set(jobKey(j), j);
      const cut = now - KEEP_DAYS * DAY;
      const kept = [...merged.values()].filter((j) => Date.parse(j.start) > cut).sort((a, b) => a.start.localeCompare(b.start)).slice(-20_000);
      writeAtomic(path, JSON.stringify(kept));
    }
    return { accepted: incoming.length };
  }

  const list = (d) => (existsSync(d) ? readdirSync(d) : []).filter((f) => f.endsWith('.json')).map((f) => readJSON(join(d, f))).filter(Boolean);
  const allJobs = () => list(dirs.jobs).flat();

  // ---- GitHub: queue time per job, jobs waiting now -----------------------
  const runKey = (j) => `${j.repo}#${j.runId}#${j.attempt || 1}`;
  let gh = readJSON(githubPath, { runs: {}, queue: null, rate: null });
  async function api(path) {
    if (gh.rate && gh.rate.remaining < 200 && gh.rate.reset * 1000 > clock()) throw new Error('GitHub rate limit low; waiting for reset');
    const r = await fetcher(`https://api.github.com${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dash-status', 'X-GitHub-Api-Version': '2022-11-28',
        ...(github ? { Authorization: `Basic ${Buffer.from(`${github.id}:${github.secret}`).toString('base64')}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const remaining = r.headers.get('x-ratelimit-remaining'), reset = r.headers.get('x-ratelimit-reset');
    if (remaining != null && reset != null) gh.rate = { remaining: Number(remaining), reset: Number(reset) };
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${path.split('?')[0]}`);
    return r.json();
  }
  const compactJob = (j) => ({ id: j.id, name: String(j.name || '').slice(0, 300), status: j.status, conclusion: j.conclusion, createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at, runner: j.runner_name || null, labels: (j.labels || []).slice(0, 10), url: j.html_url });
  async function runJobs(repo, runId, attempt) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const v = await api(`/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (!v) return null;
      out.push(...(v.jobs || []).map(compactJob));
      if ((v.jobs || []).length < 100) break;
    }
    return out;
  }

  // Pool runners exist for one job, often for seconds: dash-ci-pool names them
  // <controller>-<pool>-<6 hex>, so they are recognised before their job is reported.
  function ourRunners() {
    const hosts = list(dirs.hosts);
    const names = new Set(hosts.flatMap((h) => (h.runners || []).map((r) => r.name)));
    const prefixes = hosts.flatMap((h) => (h.pools || []).filter((p) => p.controller).map((p) => `${p.controller}-${p.name}-`));
    return (name) => typeof name === 'string' && (names.has(name) || prefixes.some((p) => name.startsWith(p) && /^[0-9a-f]{6}$/.test(name.slice(p.length))));
  }
  async function enrich(jobs) {
    const now = clock();
    const due = new Map();
    const isOurs = ourRunners();
    for (const j of jobs) {
      if (!j.repo || !j.runId || j.visibility === 'private' || j.visibility === 'internal' || Date.parse(j.start) < now - 3 * DAY) continue;
      const k = runKey(j), e = gh.runs[k];
      // Incomplete runs are fetched again every 10 minutes for up to 6 hours.
      if (e && (e.complete || e.missing || e.attempts >= 36 || now - e.fetchedAt < 10 * 60_000)) continue;
      due.set(k, j);
      if (due.size >= 20) break;
    }
    for (const [k, j] of due) {
      const e = gh.runs[k] || { attempts: 0 };
      try {
        const all = await runJobs(j.repo, j.runId, j.attempt || 1);
        // Only jobs our runners ran are kept: timing and served label sets.
        gh.runs[k] = all ? { fetchedAt: now, attempts: e.attempts + 1, complete: all.every((x) => x.status === 'completed'), jobs: all.filter((x) => isOurs(x.runner)) } : { fetchedAt: now, attempts: e.attempts + 1, missing: true };
      } catch (err) {
        gh.runs[k] = { ...e, fetchedAt: now, attempts: e.attempts + 1, error: err.message };
        if (/rate limit/.test(err.message)) break;
      }
    }
    for (const [k, e] of Object.entries(gh.runs)) if (now - e.fetchedAt > 8 * DAY) delete gh.runs[k];
    return due.size > 0;
  }

  // Label sets our runners have served: a queued job wanting one is ours.
  function servedLabels() {
    const sets = new Set();
    const isOurs = ourRunners();
    for (const e of Object.values(gh.runs)) for (const j of e.jobs || []) if (isOurs(j.runner) && j.labels?.length) sets.add(JSON.stringify([...j.labels].sort()));
    return sets;
  }
  async function pollQueue(jobs) {
    const now = clock();
    const repos = [...new Set(jobs.filter((j) => j.repo && j.visibility === 'public' && Date.parse(j.start) > now - 7 * DAY).map((j) => j.repo))].slice(0, 8);
    const served = servedLabels();
    const waiting = [];
    let error = null;
    for (const repo of repos) {
      try {
        const runs = new Map(); // a run can move from queued to in progress between the two calls
        for (const status of ['queued', 'in_progress']) for (const r of (await api(`/repos/${repo}/actions/runs?status=${status}&per_page=30`))?.workflow_runs || []) runs.set(r.id, r);
        for (const run of [...runs.values()].filter((r) => Date.parse(r.created_at) > now - DAY).slice(0, 25)) {
          const v = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
          for (const j of (v?.jobs || []).map(compactJob)) {
            // Waiting for a runner only (not for approval or a concurrency group).
            if (j.status !== 'queued') continue;
            const labels = j.labels.map((l) => l.toLowerCase());
            if (!labels.includes('self-hosted') && !served.has(JSON.stringify([...j.labels].sort()))) continue;
            waiting.push({ id: j.id, repo, workflow: String(run.name || '').slice(0, 200), name: j.name, labels: j.labels, createdAt: j.createdAt, url: j.url, branch: String(run.head_branch || '').slice(0, 200) });
          }
        }
      } catch (err) { error = err.message; if (/rate limit/.test(err.message)) break; }
    }
    gh.queue = { at: new Date(now).toISOString(), repos, jobs: waiting.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), error };
  }

  let lastQueue = 0, ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const jobs = allJobs().sort((a, b) => b.start.localeCompare(a.start));
      let changed = await enrich(jobs);
      if (clock() - lastQueue >= 2 * 60_000) { lastQueue = clock(); await pollQueue(jobs); changed = true; }
      if (changed) writeAtomic(githubPath, JSON.stringify(gh));
    } catch (e) { log('ci github:', e.message); } finally { ticking = false; }
  }

  // ---- summary -------------------------------------------------------------
  function timing(j) {
    const e = gh.runs[runKey(j)];
    if (!e?.jobs) return null;
    const start = Date.parse(j.start);
    let best = null;
    for (const g of e.jobs) {
      if (!g.startedAt || (j.runnerName && g.runner && g.runner !== j.runnerName)) continue;
      const d = Math.abs(Date.parse(g.startedAt) - start);
      if (d < 180_000 && (!best || d < best.d)) best = { d, g };
    }
    if (!best) return null;
    const q = (Date.parse(best.g.startedAt) - Date.parse(best.g.createdAt)) / 1000;
    return { queueSec: Number.isFinite(q) && q >= 0 ? Math.round(q) : null, url: best.g.url, labels: best.g.labels };
  }

  function summary({ admin = false } = {}) {
    const now = clock();
    const hosts = list(dirs.hosts);
    const regs = reporters();
    const jobs = allJobs().map((j) => ({ ...j, ...timing(j) }));
    const dur = (j) => (j.end ? (Date.parse(j.end) - Date.parse(j.start)) / 1000 : null);
    const dayStats = (mine, busyIn) => {
      const day = mine.filter((j) => Date.parse(j.start) > now - DAY);
      return { jobs: day.length, succeeded: day.filter((j) => j.result === 'Succeeded').length, failed: day.filter((j) => j.result === 'Failed').length, canceled: day.filter((j) => j.result === 'Canceled' || j.result === 'Abandoned').length, busySec: Math.round(busyIn(now - DAY, now) / 1000) };
    };
    // Busy share of `slots` runners for each of the last 48 hours.
    const hourStrip = (h, busyIn, slots) => {
      const hours = [];
      for (let i = 47; i >= 0; i--) {
        const end = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000 - i * 3_600_000, start = end - 3_600_000;
        const label = new Date(start).toISOString().slice(0, 13);
        hours.push({ hour: `${label}:00Z`, busy: slots ? Math.min(1, busyIn(start, Math.min(end, now)) / (slots * Math.max(1, Math.min(end, now) - start))) : 0, reported: !!h.seen?.[label] });
      }
      return hours;
    };
    const runners = [], pools = [];
    for (const h of hosts) {
      const stale = now - Date.parse(h.receivedAt) > STALE_MS;
      const hostLabel = regs[h.id]?.label || h.id;
      for (const r of h.runners || []) {
        const mine = jobs.filter((j) => j.host === h.id && (j.runnerName ? j.runnerName === r.name : j.runner === r.key));
        const busyIn = (a, b) => mine.reduce((s, j) => s + (j.end ? overlap(Date.parse(j.start), Date.parse(j.end), a, b) : 0), 0)
          + (r.busy && r.job?.start && !stale ? overlap(Date.parse(r.job.start), now, a, b) : 0);
        const status = stale ? 'offline' : r.error ? 'error' : !r.listening ? 'offline' : r.busy ? 'busy' : 'idle';
        runners.push({
          host: h.id, hostLabel, hostname: h.host?.hostname, receivedAt: h.receivedAt, stale, status,
          name: r.name || r.key, pool: r.pool, kind: r.kind, container: r.container, version: r.version, error: r.error, containerState: r.containerState,
          job: r.busy && !stale ? r.job : null, diag: r.diag,
          day: dayStats(mine, busyIn),
          hours: hourStrip(h, busyIn, 1),
        });
      }
      for (const p of h.pools || []) {
        // One reporter may read several controllers: a job belongs to the one its runner name says.
        const mine = jobs.filter((j) => j.host === h.id && j.pool === p.name && (!p.controller || String(j.runnerName).startsWith(`${p.controller}-${p.name}-`)));
        // Jobs shorter than a report interval only show up in the ledger, so busy time comes from it.
        const busyIn = (a, b) => mine.reduce((s, j) => s + (j.end ? overlap(Date.parse(j.start), Date.parse(j.end), a, b) : 0), 0);
        const size = p.size || 0, count = (k) => (stale ? 0 : p[k] || 0);
        const idle = count('idle'), busy = count('busy'), starting = count('starting'), online = idle + busy;
        // A new runner starts as each one finishes its job: only a shortfall beyond those is a problem.
        const status = stale ? 'offline' : p.error ? 'error' : p.draining ? 'draining' : size && !online && !starting ? 'offline' : online + starting < size ? 'short' : 'ok';
        pools.push({
          host: h.id, hostLabel, receivedAt: h.receivedAt, stale, status, name: p.name, controller: p.controller, backend: p.backend, labels: p.labels,
          // A drained pool is emptied on purpose; one that shrank still counts the runners it has.
          size, capacity: p.draining ? online + starting : Math.max(size, online + starting), online, idle, busy, starting, draining: p.draining, error: p.error,
          running: stale ? [] : p.instances.filter((i) => i.state === 'busy').map((i) => ({ name: i.name, since: i.since })),
          day: dayStats(mine, busyIn),
          hours: hourStrip(h, busyIn, size),
        });
      }
    }
    runners.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    pools.sort((a, b) => `${a.hostLabel}|${a.name}`.localeCompare(`${b.hostLabel}|${b.name}`));
    const day = jobs.filter((j) => Date.parse(j.start) > now - DAY);
    const week = jobs.filter((j) => Date.parse(j.start) > now - 7 * DAY);
    const queued = gh.queue?.jobs || [];
    const groups = new Map();
    for (const j of week) {
      const k = `${j.repo || 'unknown'}|${j.workflow || '—'}`;
      if (!groups.has(k)) groups.set(k, { repo: j.repo, workflow: j.workflow, jobs: [] });
      groups.get(k).jobs.push(j);
    }
    const workflows = [...groups.values()].map((g) => {
      const d = g.jobs.map(dur).filter((x) => x != null), q = g.jobs.map((j) => j.queueSec).filter((x) => x != null);
      return { repo: g.repo, workflow: g.workflow, jobs: g.jobs.length, failed: g.jobs.filter((j) => j.result === 'Failed').length, canceled: g.jobs.filter((j) => j.result === 'Canceled' || j.result === 'Abandoned').length,
        medianSec: median(d), p90Sec: pctile(d, 0.9), runnerHours: Math.round(d.reduce((a, b) => a + b, 0) / 36) / 100, medianQueueSec: median(q), p90QueueSec: pctile(q, 0.9) };
    }).sort((a, b) => b.runnerHours - a.runnerHours);
    const hoursOf = (js) => Math.round(js.reduce((a, j) => a + (dur(j) || 0), 0) / 36) / 100;
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const start = Math.floor(now / DAY) * DAY - i * DAY, end = start + DAY;
      const all = jobs.filter((j) => { const t = Date.parse(j.start); return t >= start && t < end; });
      const js = all.filter((j) => !isLight(j)), light = all.filter(isLight);
      daily.push({ day: new Date(start).toISOString().slice(0, 10), succeeded: js.filter((j) => j.result === 'Succeeded').length, failed: js.filter((j) => j.result === 'Failed').length,
        other: js.filter((j) => j.result !== 'Succeeded' && j.result !== 'Failed').length, runnerHours: hoursOf(js), light: light.length, lightRunnerHours: hoursOf(light) });
    }
    const real24h = day.filter((j) => !isLight(j));
    const dq = day.map((j) => j.queueSec).filter((x) => x != null);
    const online = runners.filter((r) => r.status === 'busy' || r.status === 'idle');
    const sum = (k) => pools.reduce((a, p) => a + p[k], 0);
    const capacity = runners.length + sum('capacity');
    const busySec = [...runners, ...pools].reduce((a, x) => a + x.day.busySec, 0);
    return {
      at: new Date(now).toISOString(),
      totals: {
        runners: capacity, online: online.length + sum('online'), starting: sum('starting'), busy: runners.filter((r) => r.status === 'busy').length + sum('busy'),
        jobs24h: real24h.length, succeeded24h: real24h.filter((j) => j.result === 'Succeeded').length, failed24h: real24h.filter((j) => j.result === 'Failed').length, light24h: day.length - real24h.length,
        utilization24h: capacity ? busySec / (capacity * 86_400) : null,
        medianQueueSec24h: median(dq), p90QueueSec24h: pctile(dq, 0.9), queuedNow: queued.length, oldestQueuedAt: queued[0]?.createdAt || null,
      },
      hosts: hosts.map((h) => ({ id: h.id, label: regs[h.id]?.label || h.id, receivedAt: h.receivedAt, measuredAt: h.at, stale: now - Date.parse(h.receivedAt) > STALE_MS, reporter: h.reporter, python: h.python, ...h.host })).sort((a, b) => a.label.localeCompare(b.label)),
      runners,
      pools,
      queue: gh.queue ? { ...gh.queue, jobs: queued.slice(0, 50) } : null,
      workflows: workflows.slice(0, 40),
      daily,
      recent: jobs.filter((j) => j.end).sort((a, b) => b.end.localeCompare(a.end)).slice(0, 60)
        .map((j) => ({ ...j, durationSec: dur(j), url: j.url || (j.repo && j.runId ? `https://github.com/${j.repo}/actions/runs/${j.runId}` : null) })),
      github: { enabled: !!github, rate: gh.rate, enriched: Object.values(gh.runs).filter((e) => e.jobs).length },
      ...(admin ? { reporters: Object.entries(regs).map(([id, r]) => ({ id, label: r.label, createdAt: r.createdAt, lastSeen: hosts.find((h) => h.id === id)?.receivedAt || null })) } : {}),
    };
  }

  // Before sign-in: the same statistics without anything that identifies a
  // person, host or network location. Host and runner names (which carry
  // people's names), hostnames, paths, containers, errors, branches, links and
  // private repositories are replaced or left out.
  function publicSummary() {
    const s = summary();
    const privateRepos = new Set(allJobs().filter((j) => j.repo && j.visibility !== 'public').map((j) => j.repo));
    const repo = (r) => (!r ? null : privateRepos.has(r) ? 'private repository' : r);
    const masked = (r, text) => (r && privateRepos.has(r) ? 'private workflow' : text);
    const family = (os) => (/mac/i.test(os || '') ? 'macOS' : /ubuntu|debian|linux/i.test(os || '') ? 'Linux' : 'Runner');
    const hostLabel = new Map(), counts = {};
    for (const h of s.hosts) { const f = family(h.os); counts[f] = (counts[f] || 0) + 1; hostLabel.set(h.id, `${f} host ${counts[f]}`); }
    const runnerLabel = new Map();
    for (const [id, label] of hostLabel) {
      const mine = s.runners.filter((r) => r.host === id);
      mine.forEach((r, i) => runnerLabel.set(r.name, mine.length > 1 ? `${label} · runner ${i + 1}` : `${label} runner`));
    }
    const runnerOf = (name) => runnerLabel.get(name) || 'runner';
    const usage = (d) => (d && !d.error ? Object.fromEntries(['images', 'containers', 'volumes', 'buildCache'].map((k) => [k, d[k] ? { bytes: d[k].bytes, reclaimable: d[k].reclaimable } : null])) : null);
    return {
      public: true, at: s.at, totals: s.totals,
      hosts: s.hosts.map((h) => ({ id: hostLabel.get(h.id), label: hostLabel.get(h.id), receivedAt: h.receivedAt, stale: h.stale, os: h.os, arch: h.arch, cpus: h.cpus,
        load: h.load, memTotal: h.memTotal, memUsed: h.memUsed, uptimeSec: h.uptimeSec, disks: (h.disks || []).map((d) => ({ total: d.total, free: d.free })), docker: usage(h.docker) })),
      runners: s.runners.map((r) => ({ host: hostLabel.get(r.host), hostLabel: hostLabel.get(r.host), name: runnerOf(r.name), status: r.status, stale: r.stale, receivedAt: r.receivedAt,
        kind: r.kind, version: r.version, day: r.day, hours: r.hours,
        job: r.job && { name: masked(r.job.repo, r.job.name), repo: repo(r.job.repo), workflow: masked(r.job.repo, r.job.workflow), start: r.job.start } })),
      pools: s.pools.map((p) => ({ host: hostLabel.get(p.host), hostLabel: hostLabel.get(p.host), name: p.name, status: p.status, stale: p.stale, receivedAt: p.receivedAt, backend: p.backend, labels: p.labels,
        size: p.size, capacity: p.capacity, online: p.online, idle: p.idle, busy: p.busy, starting: p.starting, draining: p.draining, running: p.running.map((i) => ({ since: i.since })), day: p.day, hours: p.hours })),
      queue: s.queue && { at: s.queue.at, jobs: s.queue.jobs.filter((j) => !privateRepos.has(j.repo)).map((j) => ({ id: j.id, repo: j.repo, workflow: j.workflow, name: j.name, labels: j.labels, createdAt: j.createdAt })) },
      workflows: s.workflows.map((w) => ({ ...w, repo: repo(w.repo), workflow: masked(w.repo, w.workflow) })),
      daily: s.daily,
      recent: s.recent.map((j) => ({ runnerName: j.pool ? `${hostLabel.get(j.host) || 'host'} · ${j.pool} pool` : runnerOf(j.runnerName), pool: j.pool, start: j.start, end: j.end, name: masked(j.repo, j.name), repo: repo(j.repo), workflow: masked(j.repo, j.workflow),
        result: j.result, durationSec: j.durationSec, queueSec: j.queueSec ?? null })),
      github: { enabled: s.github.enabled },
    };
  }

  return { addReporter, removeReporter, authenticate, ingest, summary, publicSummary, tick, reporters };
}
