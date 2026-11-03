import { Fragment, useEffect, useState } from 'react';
import { ago, clock, num, pct, secs, useResource } from '../lib.js';
import { Err, Section } from '../ui.jsx';
import { CapacityStrip, StripLegend, TipLayer } from '../charts.jsx';
import { useTip } from '../viz.js';

// At capacity this share of the time or more: worth more runners (warn), badly short (down).
const WARN = 0.2, DOWN = 0.5;
const level = (v) => (v >= DOWN ? 'lv-down' : v >= WARN ? 'lv-warn' : '');
const hours = (s) => (s >= 36_000 ? num(Math.round(s / 3600)) : (s / 3600).toFixed(1));
// 0.4% reads as "<1%", not "0%": a label set that was ever short is not shown as never.
const pctOf = (v) => (v > 0 && v < 0.01 ? '<1%' : pct(v * 100));
const AT_CAPACITY = { key: 'atCapacity', label: 'At capacity', title: 'Share of the time at least one job with these labels had waited over a minute for a runner: a job queued then would have waited too' };
const COLUMNS = [
  { key: 'jobs', label: 'Jobs', title: 'Jobs finished in the window (skipped jobs left out)' },
  { key: 'runnerSec', label: 'Runner-h', title: 'Runner time used in the window, and its share of all runner time' },
  { key: 'medianRunSec', label: 'Median run' },
  { key: 'p90RunSec', label: 'p90 run' },
  { key: 'maxRunSec', label: 'Longest' },
  { key: 'avgRunning', label: 'Running avg · p95 · peak', title: 'Jobs running at once: time-weighted average, 95th percentile and peak. For our pools, compared with the runners they have now' },
  { key: 'medianWaitSec', label: 'Median wait' },
  { key: 'p90WaitSec', label: 'p90 wait' },
];

export default function QueueCapacity({ as, now }) {
  const [win, setWin] = useState('7d');
  const [sort, setSort] = useState('runnerSec');
  const [open, setOpen] = useState(null);
  const [bind, tip] = useTip();
  // Recomputed by the server at most once a minute: refreshed on a timer, not on every queue event.
  const { data, error, reload } = useResource(`/api/ci/queue/capacity?window=${win}&as=${as}`);
  useEffect(() => { const t = setInterval(reload, 60_000); return () => clearInterval(t); }, [reload]);
  const windows = data?.windows || ['24h', '7d', '14d'];
  const right = (
    <div className="flex items-center gap-3">
      <StripLegend low="never" high="always at capacity" hatched="not recorded" />
      <div className="flex gap-1">{windows.map((w) => <button key={w} className={`btn !py-0 !text-[11px] ${w === win ? '!border-accent' : ''}`} onClick={() => setWin(w)}>{w}</button>)}</div>
    </div>
  );
  if (error) return <Section title="Capacity by runner labels" right={right}><Err error={error} /></Section>;
  if (!data) return <Section title="Capacity by runner labels" right={right}><div className="panel p-4 text-dim">Loading…</div></Section>;
  const rows = [...data.labels].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || b.runnerSec - a.runnerSec);
  const partial = Date.parse(data.recordedFrom) > Date.parse(data.windowFrom);
  return (
    <Section title={`Capacity by runner labels · ${data.window}`} right={right}>
      <TipLayer tip={tip} />
      <div className="mb-2 text-[11.5px] text-dim">
        At capacity: the share of the time a job with these labels had already waited over {data.graceSec} s for a runner, so a new job would have queued too.
        The strip shows when ({data.bucketSec / 3600} h per cell). Select a row to see which jobs use the runner time.
        {partial && <span> Recording began {ago(data.recordedFrom, now)} ago ({clock(data.recordedFrom)}); figures cover that part of the window.</span>}
        {data.public && <span> Public repositories only.</span>}
      </div>
      <div className="panel overflow-x-auto max-h-[620px]">
        <table className="grid w-full text-[12px]">
          <thead>
            <tr>
              <th>runs-on labels</th><th>Runners</th>
              <SortTh c={AT_CAPACITY} sort={sort} setSort={setSort} />
              <th>When</th>
              {COLUMNS.map((c) => <SortTh key={c.key} c={c} sort={sort} setSort={setSort} />)}
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <Fragment key={g.key}>
                <tr className={open === g.key ? 'open' : ''} onClick={() => setOpen(open === g.key ? null : g.key)}>
                  <td>{g.labels.length ? g.labels.map((l) => <span key={l} className="tag mr-1">{l}</span>) : <span className="text-dim">none</span>}</td>
                  <td className="text-dim" title={g.capacity ? `${g.capacity.online} online now in ${g.capacity.pools} pool${g.capacity.pools === 1 ? '' : 's'}` : undefined}>
                    {g.hosted ? 'GitHub-hosted' : g.capacity ? <><span className="mono text-fg">{g.capacity.runners}</span> self-hosted</> : 'self-hosted'}
                  </td>
                  <td className={`mono text-right ${level(g.atCapacity)}`}>{g.atCapacity != null ? pctOf(g.atCapacity) : '—'}</td>
                  <td className="w-[22%]"><CapacityStrip buckets={g.buckets} bucketSec={data.bucketSec} bind={bind} label={`${g.labels.join(', ')}: share of each ${data.bucketSec / 3600} h at capacity`} /></td>
                  <td className="mono text-right">{num(g.jobs)}</td>
                  <td className="mono text-right">{hours(g.runnerSec)}<span className="text-faint"> {g.share != null ? pct(g.share * 100) : ''}</span></td>
                  <td className="mono text-right">{secs(g.medianRunSec)}</td>
                  <td className="mono text-right">{secs(g.p90RunSec)}</td>
                  <td className="mono text-right text-dim">{secs(g.maxRunSec)}</td>
                  <td className={`mono text-right ${g.capacity?.runners && g.p95Running >= g.capacity.runners ? 'lv-warn' : ''}`}>
                    {g.avgRunning != null ? g.avgRunning.toFixed(1) : '—'} · {g.p95Running} · {g.peakRunning}{g.capacity?.runners ? <span className="text-faint"> of {g.capacity.runners}</span> : null}
                  </td>
                  <td className="mono text-right">{secs(g.medianWaitSec)}</td>
                  <td className="mono text-right">{secs(g.p90WaitSec)}</td>
                </tr>
                {open === g.key && <tr className="detail"><td colSpan={COLUMNS.length + 4}><TopJobs g={g} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-4 text-dim text-center">No job has run or waited in this window yet.</div>}
      </div>
      <div className="mt-1 text-faint text-[11px]">
        Total runner time {hours(data.runnerSec)} h. Runner counts are the pools reporting now; GitHub-hosted capacity is not published, so only its waits show.
      </div>
    </Section>
  );
}

function SortTh({ c, sort, setSort }) {
  return (
    <th className="num cursor-pointer select-none" title={c.title} onClick={() => setSort(c.key)} aria-sort={sort === c.key ? 'descending' : undefined}>
      {c.label}{sort === c.key ? ' ↓' : ''}
    </th>
  );
}

function TopJobs({ g }) {
  if (!g.topJobs.length) return <div className="text-dim py-1">No job with these labels finished in this window.</div>;
  return (
    <div className="py-1">
      <div className="text-dim text-[11px] mb-1">Where the runner time goes: {g.topJobs.length < g.jobGroups ? `top ${g.topJobs.length} of ${g.jobGroups}` : g.jobGroups} jobs by runner time</div>
      <table className="w-full text-[12px]">
        <thead><tr><th>Repository · workflow · job</th><th className="num">Runs</th><th className="num">Runner-h</th><th className="num">Share</th><th className="num">Median run</th><th className="num">p90 run</th><th className="num">Median wait</th></tr></thead>
        <tbody>
          {g.topJobs.map((j) => (
            <tr key={`${j.repo}|${j.workflow}|${j.name}`}>
              <td className="py-0.5 max-w-[520px] truncate"><span className="mono text-dim">{j.repo}</span> · {j.workflow || '—'} · {j.name || '—'}</td>
              <td className="mono text-right">{j.jobs}</td>
              <td className="mono text-right">{hours(j.runnerSec)}</td>
              <td className="mono text-right text-dim">{g.runnerSec ? pct((j.runnerSec / g.runnerSec) * 100) : '—'}</td>
              <td className="mono text-right">{secs(j.medianRunSec)}</td>
              <td className="mono text-right">{secs(j.p90RunSec)}</td>
              <td className="mono text-right">{secs(j.medianWaitSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
