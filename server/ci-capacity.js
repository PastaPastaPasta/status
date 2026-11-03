// Runner capacity per runs-on label set over a window: how much runner time its
// jobs used, how many ran at once, and how often it was at capacity. At capacity
// means some job with those labels had already waited longer than GRACE_MS for a
// runner, so a job queued then would have waited too. A short pickup delay (a
// hosted VM or a single-use runner registering) is not a shortage.
import { median, overlap, pctile } from './ci.js';

const GRACE_MS = 60_000;
export const WINDOWS = { '24h': { ms: 86_400_000, bucketMs: 3_600_000 }, '7d': { ms: 7 * 86_400_000, bucketMs: 4 * 3_600_000 }, '14d': { ms: 14 * 86_400_000, bucketMs: 8 * 3_600_000 } };
const TOP_JOBS = 15;

const sec = (ms) => Math.round(ms / 1000);

// Sorted, non-overlapping cover of the intervals.
function merge(intervals) {
  const out = [];
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Time-weighted levels of concurrency: peak, p95 and average over [from, to).
function concurrency(runs, from, to) {
  const ev = [];
  for (const [a, b] of runs) { ev.push([a, 1], [b, -1]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const at = new Map(); // level -> ms spent at it
  let level = 0, t = from, peak = 0;
  for (const [x, d] of ev) {
    if (x > t) { at.set(level, (at.get(level) || 0) + x - t); t = x; }
    level += d;
    peak = Math.max(peak, level);
  }
  if (to > t) at.set(level, (at.get(level) || 0) + to - t);
  const total = to - from;
  let acc = 0, p95 = 0;
  for (const l of [...at.keys()].sort((a, b) => a - b)) { acc += at.get(l); p95 = l; if (acc >= 0.95 * total) break; }
  return { peak, p95: total > 0 ? p95 : 0 };
}

// jobs: { labels, hosted?, repo, workflow, name, queuedAt, startedAt, endAt, ran } with times in ms.
//   queuedAt  when it began waiting for a runner (null: unknown, e.g. after a hold)
//   startedAt when a runner took it (null: never, still waiting or cancelled while queued)
//   endAt     when it finished, or the last time it is known to be in its state
// from: start of the window (already clipped to when recording began).
// windowFrom: start of the requested window; buckets before `from` are marked as not recorded.
export function capacityStats({ jobs, from, to, windowFrom = from, bucketMs, hostedOf = () => null, capacityOf = () => null }) {
  const covered = Math.max(0, to - from);
  const groups = new Map();
  for (const j of jobs) {
    const k = JSON.stringify([...j.labels].sort());
    if (!groups.has(k)) groups.set(k, { labels: [...j.labels].sort(), jobs: [] });
    groups.get(k).jobs.push(j);
  }
  const first = Math.floor(Math.min(from, windowFrom) / bucketMs) * bucketMs;
  const buckets = [];
  for (let b = first; b < to; b += bucketMs) buckets.push(b);

  const rows = [];
  let totalRunMs = 0;
  for (const [key, g] of groups) {
    const runs = [], waits = [], durs = [], ws = [], byJob = new Map();
    let runMs = 0, finished = 0;
    for (const j of g.jobs) {
      const end = j.endAt ?? to, ran = j.ran && j.startedAt != null;
      let ms = 0;
      if (ran) {
        const a = Math.max(j.startedAt, from), b = Math.min(end, to);
        if (b > a) { ms = b - a; runs.push([a, b]); runMs += ms; }
      }
      // Waiting from queuedAt until a runner took it (or it was cancelled while queued).
      if (j.queuedAt != null) {
        const a = Math.max(j.queuedAt + GRACE_MS, from), b = Math.min(ran ? j.startedAt : end, to);
        if (b > a) waits.push([a, b]);
      }
      if (j.done && j.endAt >= from && j.endAt <= to) {
        finished++;
        const dur = ran ? sec(j.endAt - j.startedAt) : null;
        const wait = ran && j.queuedAt != null ? Math.max(0, sec(j.startedAt - j.queuedAt)) : null;
        const jk = `${j.repo}\u0000${j.workflow || ''}\u0000${j.name || ''}`;
        if (!byJob.has(jk)) byJob.set(jk, { repo: j.repo, workflow: j.workflow || null, name: j.name || null, durs: [], waits: [], runMs: 0 });
        const e = byJob.get(jk);
        if (dur != null) { durs.push(dur); e.durs.push(dur); e.runMs += ms; }
        if (wait != null) { ws.push(wait); e.waits.push(wait); }
      }
    }
    const full = merge(waits);
    const fullMs = full.reduce((s, [a, b]) => s + b - a, 0);
    const conc = concurrency(runs, from, to);
    totalRunMs += runMs;
    rows.push({
      key, labels: g.labels, hosted: hostedOf(key, g.labels), capacity: capacityOf(g.labels),
      jobs: finished, runnerSec: sec(runMs),
      medianRunSec: median(durs), p90RunSec: pctile(durs, 0.9), maxRunSec: pctile(durs, 1),
      medianWaitSec: median(ws), p90WaitSec: pctile(ws, 0.9),
      atCapacity: covered ? fullMs / covered : null,
      avgRunning: covered ? runMs / covered : null, p95Running: conc.p95, peakRunning: conc.peak,
      buckets: buckets.map((b0) => {
        const a = Math.max(b0, from), b = Math.min(b0 + bucketMs, to), len = b - a;
        const f = full.reduce((s, [x, y]) => s + overlap(x, y, a, b), 0);
        const r = runs.reduce((s, [x, y]) => s + overlap(x, y, a, b), 0);
        return { at: new Date(b0).toISOString().replace(/\.\d{3}Z$/, 'Z'), recorded: len > 0, atCapacity: len > 0 ? f / len : 0, avgRunning: len > 0 ? r / len : 0 };
      }),
      topJobs: [...byJob.values()].sort((a, b) => b.runMs - a.runMs || b.durs.length - a.durs.length).slice(0, TOP_JOBS)
        .map((e) => ({ repo: e.repo, workflow: e.workflow, name: e.name, jobs: e.durs.length, runnerSec: sec(e.runMs), medianRunSec: median(e.durs), p90RunSec: pctile(e.durs, 0.9), medianWaitSec: median(e.waits) })),
      jobGroups: byJob.size,
    });
  }
  const total = sec(totalRunMs);
  for (const r of rows) r.share = total ? r.runnerSec / total : null;
  rows.sort((a, b) => b.runnerSec - a.runnerSec || b.jobs - a.jobs);
  return { windowFrom: new Date(windowFrom).toISOString(), graceSec: GRACE_MS / 1000, bucketSec: bucketMs / 1000, runnerSec: total, labels: rows };
}
