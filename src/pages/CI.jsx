import { useState } from 'react';
import { ago, api, bytes, clock, pct, secs, useNow, useResource, useSession } from '../lib.js';
import { Dot, Empty, Err, Link, Meter, Section, Stat } from '../ui.jsx';
import { Columns, HourStrip, Legend, StripLegend, TipLayer, TipRow } from '../charts.jsx';
import { SERIES, useTip } from '../viz.js';

const STATUS = { busy: ['deploying', 'running a job'], idle: ['ok', 'idle'], offline: ['down', 'offline'], error: ['warn', 'reporter error'] };
// A pool keeps `size` single-use runners ready; each takes one job and is replaced.
const POOL_STATUS = { ok: ['ok', 'ready'], short: ['warn', 'below size'], draining: ['warn', 'draining'], offline: ['down', 'offline'], error: ['warn', 'reporter error'] };
const COMMON_LABELS = new Set(['self-hosted', 'Linux', 'X64', 'dash-ci-pool']);
const RESULT = { Succeeded: 'lv-ok', Failed: 'lv-down', Canceled: 'text-dim', Abandoned: 'lv-warn' };
const JOB_SERIES = [
  { key: 'succeeded', label: 'Succeeded', color: SERIES[0] },
  { key: 'failed', label: 'Failed', color: SERIES[1] },
  { key: 'other', label: 'Canceled / abandoned', color: SERIES[2] },
];

export function CiTabs({ active }) {
  return (
    <div className="ml-auto flex gap-1">
      <Link to="/ci" className={`btn ${active === 'runners' ? '!border-accent' : ''}`}>Runners</Link>
      <Link to="/ci/queue" className={`btn ${active === 'queue' ? '!border-accent' : ''}`}>Actions queue</Link>
    </div>
  );
}

export default function CI() {
  const session = useSession();
  const now = useNow(1000);
  // Signed out (or without access) the server sends a sanitized view.
  const { data, error, reload } = useResource(session.loaded ? `/api/ci?as=${session.user?.id || 'public'}` : null, (t) => t === 'ci');
  const [bind, tip] = useTip();
  if (!session.loaded) return <div className="mt-6 text-dim">Loading…</div>;
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!data) return <div className="mt-6 text-dim">Loading…</div>;
  const t = data.totals;
  const hosts = data.hosts.map((h) => ({ ...h, runners: data.runners.filter((r) => r.host === h.id), pools: data.pools.filter((p) => p.host === h.id) }));
  return (
    <div>
      <TipLayer tip={tip} />
      <div className="mt-5 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-[16px] font-semibold">CI runners</h1>
        <span className="text-dim text-[12px]">self-hosted GitHub Actions runners · live from each runner host, queue times from GitHub</span>
        <CiTabs active="runners" />
      </div>
      {data.public && <div className="mt-2 text-[12px] text-dim">Public view: hosts are anonymised; branches, links and private repositories are left out. {session.user ? 'Your account has no access to more.' : 'Sign in for details.'}</div>}
      <div className="mt-3 grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Runners online" value={`${t.online}/${t.runners}`} level={t.online + t.starting < t.runners ? 'down' : 'ok'} sub={`${t.busy} busy now${t.starting ? ` · ${t.starting} starting` : ''}`} />
        <Stat label="Waiting for a runner" value={data.queue ? t.queuedNow : '—'} level={t.queuedNow > 0 ? 'warn' : undefined}
          sub={t.oldestQueuedAt ? `oldest ${ago(t.oldestQueuedAt, now)}` : data.queue ? `checked ${ago(data.queue.at, now)} ago` : 'GitHub not polled yet'} />
        <Stat label="Jobs · 24h" value={t.jobs24h} sub={`${t.succeeded24h} ok · ${t.failed24h} failed${t.light24h ? ` · +${t.light24h} light` : ''}`} />
        <Stat label="Success · 24h" value={t.jobs24h ? pct((t.succeeded24h / t.jobs24h) * 100) : '—'} level={t.jobs24h && t.failed24h / t.jobs24h > 0.2 ? 'warn' : undefined} sub="of finished jobs, not light" />
        <Stat label="Utilisation · 24h" value={t.utilization24h != null ? pct(t.utilization24h * 100) : '—'} sub="busy time, all runners" />
        <Stat label="Queue time · 24h" value={secs(t.medianQueueSec24h)} sub={t.p90QueueSec24h != null ? `p90 ${secs(t.p90QueueSec24h)}` : 'median, public repos'} level={t.p90QueueSec24h > 900 ? 'warn' : undefined} />
      </div>

      <Section title="Runner hosts" right={<StripLegend />}>
        {hosts.length ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {hosts.map((h) => <HostCard key={h.id} h={h} now={now} bind={bind} />)}
          </div>
        ) : <Empty>No runner host has reported yet. Admins add reporters below.</Empty>}
      </Section>

      {data.queue?.jobs?.length > 0 && (
        <Section title={`Waiting for a self-hosted runner (${data.queue.jobs.length})`} right={<span className="text-dim text-[11px]">GitHub, {ago(data.queue.at, now)} ago</span>}>
          <div className="panel overflow-x-auto">
            <table className="grid w-full text-[12px]">
              <thead><tr><th>Waiting</th><th>Repository</th><th>Workflow / job</th><th>Labels</th><th>Branch</th></tr></thead>
              <tbody>
                {data.queue.jobs.map((j) => (
                  <tr key={j.id || j.url}><td className="mono lv-warn">{ago(j.createdAt, now)}</td><td className="mono">{j.repo}</td>
                    <td>{j.url ? <a className="link" href={j.url} target="_blank" rel="noreferrer">{j.workflow} · {j.name}</a> : `${j.workflow} · ${j.name}`}</td>
                    <td className="mono text-dim">{j.labels.join(', ')}</td><td className="mono text-dim truncate max-w-[240px]">{j.branch || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <DailyJobs daily={data.daily} bind={bind} />
        <Workflows rows={data.workflows} />
      </div>

      <Section title="Recent jobs">
        <div className="panel overflow-x-auto max-h-[520px]">
          <table className="grid w-full text-[12px]">
            <thead><tr><th>Finished</th><th>Runner</th><th>Repository</th><th>Workflow / job</th>{!data.public && <th>Branch</th>}<th className="text-right">Queued</th><th className="text-right">Ran</th><th>Result</th></tr></thead>
            <tbody>
              {data.recent.map((j, i) => (
                <tr key={`${j.runnerName}|${j.start}|${j.name}|${i}`}>
                  <td className="mono text-dim" title={clock(j.end)}>{ago(j.end, now)} ago</td>
                  <td className="mono">{j.runnerName}</td>
                  <td className="mono text-dim">{j.repo || '—'}</td>
                  <td className="max-w-[420px] truncate">{j.url ? <a className="link" href={j.url} target="_blank" rel="noreferrer">{j.workflow ? `${j.workflow} · ` : ''}{j.name}</a> : j.name}</td>
                  {!data.public && <td className="mono text-dim max-w-[200px] truncate">{j.headRef || j.ref?.replace(/^refs\/(heads|tags)\//, '') || '—'}</td>}
                  <td className="mono text-right">{secs(j.queueSec)}</td>
                  <td className="mono text-right">{secs(j.durationSec)}</td>
                  <td className={RESULT[j.result] || 'text-dim'}>{j.result || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.recent.length && <div className="p-4 text-dim text-center">No finished jobs reported yet.</div>}
        </div>
      </Section>

      {data.reporters && <Reporters reporters={data.reporters} reload={reload} now={now} />}
      <div className="mt-3 text-faint text-[11px]">
        {data.public ? null : data.github.enabled ? `GitHub API: ${data.github.enriched} runs timed${data.github.rate ? `, ${data.github.rate.remaining} requests left this hour` : ''}.` : 'GitHub API credentials not configured: no queue times.'}
      </div>
    </div>
  );
}

function HostCard({ h, now, bind }) {
  const disk = h.disks?.reduce((w, d) => (d.total && (!w || d.free / d.total < w.free / w.total) ? d : w), null);
  const docker = h.docker && !h.docker.error ? ['images', 'containers', 'volumes', 'buildCache'].reduce((a, k) => a + (h.docker[k]?.bytes || 0), 0) : null;
  const reclaim = h.docker && !h.docker.error ? ['images', 'containers', 'volumes', 'buildCache'].reduce((a, k) => a + (h.docker[k]?.reclaimable || 0), 0) : null;
  return (
    <div className="panel">
      <div className="px-3 py-2 border-b border-line flex items-center gap-2 flex-wrap">
        <Dot level={h.stale ? 'down' : 'ok'} />
        <span className="font-semibold">{h.label}</span>
        <span className="text-dim mono text-[11px]">{[h.hostname, h.os, h.arch, `${h.cpus} CPU`].filter(Boolean).join(' · ')}</span>
        <span className={`ml-auto mono text-[11px] ${h.stale ? 'lv-down' : 'text-dim'}`} title={clock(h.receivedAt)}>{h.stale ? 'no report for ' : 'reported '}{ago(h.receivedAt, now)}{h.stale ? '' : ' ago'}</span>
      </div>
      <div className="px-3 py-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[12px]">
        <Metric k="Load (1m / CPUs)"><Meter value={h.load?.[0] != null && h.cpus ? (h.load[0] / h.cpus) * 100 : null} /></Metric>
        <Metric k="Memory"><Meter value={h.memTotal ? (h.memUsed / h.memTotal) * 100 : null} warn={90} /></Metric>
        <Metric k={`Disk ${!disk?.path || disk.path === '/' ? '' : disk.path}`}><Meter value={disk ? (1 - disk.free / disk.total) * 100 : null} /><div className="text-faint mono text-[10.5px] text-right">{disk ? `${bytes(disk.free)} free` : ''}</div></Metric>
        <Metric k="Docker"><div className="mono text-right">{docker != null ? bytes(docker) : '—'}</div><div className="text-faint mono text-[10.5px] text-right">{reclaim ? `${bytes(reclaim)} reclaimable` : h.docker?.error ? 'unavailable' : ''}</div></Metric>
      </div>
      {h.runners.map((r) => <RunnerRow key={r.name} r={r} now={now} bind={bind} />)}
      {h.pools.map((p, i) => <PoolRow key={`${p.name}|${i}`} p={p} now={now} bind={bind} />)}
      <div className="px-3 py-1.5 border-t border-line text-faint text-[10.5px] mono">up {secs(h.uptimeSec)}{h.reporter ? ` · reporter v${h.reporter} · python ${h.python}` : ''}</div>
    </div>
  );
}

function Metric({ k, children }) {
  return <div className="min-w-0"><div className="text-dim text-[11px] truncate">{k}</div>{children}</div>;
}

function RunnerRow({ r, now, bind }) {
  const [level, label] = STATUS[r.status] || ['stopped', r.status];
  const diagWarn = r.diag && (r.diag.bytes > 2e9 || r.diag.files > 20000);
  return (
    <div className="px-3 py-2 border-t border-line">
      <div className="flex items-center gap-2 flex-wrap text-[12px]">
        <Dot level={level} className={r.status === 'busy' ? 'live' : ''} />
        <span className="mono font-semibold">{r.name}</span>
        <span className={`lv-${level}`}>{label}</span>
        {r.pool && <span className="tag">{r.pool}</span>}
        <span className="text-dim mono text-[11px]">{r.kind === 'docker' ? (r.container ? `container ${r.container}` : 'in Docker') : 'native'}{r.version ? ` · v${r.version}` : ''}</span>
        <span className="ml-auto text-dim text-[11px]">24h: <span className="mono text-fg">{r.day.jobs}</span> jobs{r.day.failed ? <> · <span className="mono lv-down">{r.day.failed}</span> failed</> : null} · busy <span className="mono text-fg">{pct((r.day.busySec / 86400) * 100)}</span></span>
      </div>
      {r.job && (
        <div className="mt-1 text-[12px] flex gap-2 min-w-0">
          <span className="text-dim shrink-0">running</span>
          {r.job.repo && r.job.runId ? <a className="link truncate" href={`https://github.com/${r.job.repo}/actions/runs/${r.job.runId}`} target="_blank" rel="noreferrer">{r.job.repo} · {r.job.workflow ? `${r.job.workflow} · ` : ''}{r.job.name}</a> : <span className="truncate">{r.job.name}</span>}
          <span className="mono text-dim shrink-0 ml-auto">{r.job.start ? `${ago(r.job.start, now)}` : ''}</span>
        </div>
      )}
      {r.error && <div className="mt-1 text-[11.5px] lv-warn mono truncate" title={r.error}>{r.error}</div>}
      {r.containerState && r.containerState.status !== 'running' && <div className="mt-1 text-[11.5px] lv-down mono">container {r.containerState.status}</div>}
      <div className="mt-1.5"><HourStrip hours={r.hours} bind={bind} label={`${r.name}: busy time per hour, last 48 hours`} /></div>
      <div className="flex justify-between text-faint text-[10.5px] mono mt-0.5"><span>48h ago</span>{r.diag && <span className={diagWarn ? 'lv-warn' : ''} title="runner _diag logs">_diag {bytes(r.diag.bytes)} · {r.diag.files?.toLocaleString('en-US')} files</span>}<span>now</span></div>
    </div>
  );
}

function PoolRow({ p, now, bind }) {
  const [level, label] = POOL_STATUS[p.status] || ['stopped', p.status];
  return (
    <div className="px-3 py-2 border-t border-line">
      <div className="flex items-center gap-2 flex-wrap text-[12px]">
        <Dot level={p.busy ? 'deploying' : level} className={p.busy ? 'live' : ''} />
        <span className="mono font-semibold">{p.name} pool</span>
        <span className={`lv-${level}`}>{label}</span>
        {p.labels.filter((l) => !COMMON_LABELS.has(l)).map((l) => <span key={l} className="tag">{l}</span>)}
        <span className="text-dim mono text-[11px]">single-use{p.backend ? ` · ${p.backend}` : ''}</span>
        <span className="ml-auto text-dim text-[11px]">24h: <span className="mono text-fg">{p.day.jobs}</span> jobs{p.day.failed ? <> · <span className="mono lv-down">{p.day.failed}</span> failed</> : null} · busy <span className="mono text-fg">{pct(p.size ? Math.min(100, (p.day.busySec / (p.size * 86400)) * 100) : 0)}</span></span>
      </div>
      <div className="mt-1 text-[12px] text-dim">
        <span className="mono text-fg">{p.online}</span>/{p.size} online: <span className="mono text-fg">{p.busy}</span> running a job · <span className="mono text-fg">{p.idle}</span> waiting{p.starting ? <> · <span className="mono text-fg">{p.starting}</span> starting</> : null}
        {p.running.length > 0 && <span className="mono"> · oldest job {ago(p.running.reduce((a, i) => (!a || i.since < a ? i.since : a), null), now)}</span>}
      </div>
      {p.error && <div className="mt-1 text-[11.5px] lv-warn mono truncate" title={p.error}>{p.error}</div>}
      <div className="mt-1.5"><HourStrip hours={p.hours} bind={bind} label={`${p.name} pool: busy share of its ${p.size} runners per hour, last 48 hours`} /></div>
      <div className="flex justify-between text-faint text-[10.5px] mono mt-0.5"><span>48h ago</span><span>busy share of {p.size} runners</span><span>now</span></div>
    </div>
  );
}

function DailyJobs({ daily, bind }) {
  const [table, setTable] = useState(false);
  return (
    <Section title="Jobs per day · 14 days" right={<span className="flex gap-3 items-baseline"><span className="text-faint text-[11px]">light-pool jobs not charted</span><button className="text-dim hover:text-fg text-[11px]" onClick={() => setTable(!table)}>{table ? 'chart' : 'table'}</button></span>}>
      <div className="panel p-3">
        {table ? (
          <table className="grid w-full text-[12px]">
            <thead><tr><th>Day</th><th className="text-right">Succeeded</th><th className="text-right">Failed</th><th className="text-right">Other</th><th className="text-right">Runner-hours</th><th className="text-right">Light jobs</th><th className="text-right">Light runner-h</th></tr></thead>
            <tbody>{daily.map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="mono text-right">{d.succeeded}</td><td className="mono text-right">{d.failed}</td><td className="mono text-right">{d.other}</td><td className="mono text-right">{d.runnerHours}</td><td className="mono text-right text-dim">{d.light}</td><td className="mono text-right text-dim">{d.lightRunnerHours}</td></tr>)}</tbody>
          </table>
        ) : (
          <>
            <div className="mb-2"><Legend series={JOB_SERIES} /></div>
            <Columns rows={daily} series={JOB_SERIES} bind={bind} xLabel={(d) => d.day.slice(5)}
              tip={(d) => (<><div className="text-dim mb-0.5">{d.day}</div>{[...JOB_SERIES].reverse().map((s) => <TipRow key={s.key} color={s.color} value={d[s.key]} label={s.label.toLowerCase()} />)}<TipRow value={d.runnerHours} label="runner-hours" />{d.light > 0 && <TipRow value={d.light} label="light jobs, not charted" />}</>)} />
          </>
        )}
      </div>
    </Section>
  );
}

function Workflows({ rows }) {
  return (
    <Section title="Workflows · 7 days">
      <div className="panel overflow-x-auto max-h-[262px]">
        <table className="grid w-full text-[12px]">
          <thead><tr><th>Repository · workflow</th><th className="text-right">Jobs</th><th className="text-right">Failed</th><th className="text-right">Median run</th><th className="text-right">p90 run</th><th className="text-right">Median queue</th><th className="text-right">Runner-h</th></tr></thead>
          <tbody>
            {rows.map((w) => (
              <tr key={`${w.repo}|${w.workflow}`}>
                <td className="max-w-[320px] truncate">{w.repo || w.workflow ? <><span className="mono text-dim">{w.repo || '—'}</span> · {w.workflow || '—'}</> : <span className="text-dim" title="the runner kept no worker log for these jobs">unattributed jobs</span>}</td>
                <td className="mono text-right">{w.jobs}</td>
                <td className={`mono text-right ${w.failed / w.jobs > 0.2 ? 'lv-warn' : ''}`}>{w.failed}{w.jobs ? <span className="text-faint"> ({Math.round((w.failed / w.jobs) * 100)}%)</span> : null}</td>
                <td className="mono text-right">{secs(w.medianSec)}</td>
                <td className="mono text-right">{secs(w.p90Sec)}</td>
                <td className="mono text-right">{secs(w.medianQueueSec)}</td>
                <td className="mono text-right">{w.runnerHours}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-4 text-dim text-center">No jobs in the last 7 days.</div>}
      </div>
    </Section>
  );
}

function Reporters({ reporters, reload, now }) {
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState(null);
  const [err, setErr] = useState(null);
  const add = async () => {
    setErr(null);
    try { setIssued(await api('/api/ci/reporters', { method: 'POST', body: { label } })); setLabel(''); reload(); } catch (e) { setErr(e); }
  };
  const remove = async (id) => {
    if (!window.confirm(`Remove reporter ${id}? Its token stops working and its history is deleted.`)) return;
    try { await api(`/api/ci/reporters/${id}`, { method: 'DELETE' }); reload(); } catch (e) { setErr(e); }
  };
  return (
    <Section title="Reporters (admins)">
      <div className="panel p-3 text-[12px] space-y-2">
        <div className="text-dim">Each runner host runs <span className="mono">ci/reporter/dash-ci-reporter.py</span> from cron with its own token. A token is shown once.</div>
        <table className="grid w-full"><thead><tr><th>Reporter</th><th>Created</th><th>Last report</th><th /></tr></thead>
          <tbody>{reporters.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td className="mono text-dim">{r.createdAt?.slice(0, 10)}</td><td className="mono text-dim">{r.lastSeen ? `${ago(r.lastSeen, now)} ago` : 'never'}</td><td className="text-right"><button className="text-dim hover:text-fg" onClick={() => remove(r.id)}>remove</button></td></tr>)}</tbody>
        </table>
        <div className="flex gap-2 items-center"><input className="input w-60" placeholder="host label, e.g. mac-runner-3" value={label} onChange={(e) => setLabel(e.target.value)} /><button className="btn" disabled={!label.trim()} onClick={add}>Issue token</button></div>
        <Err error={err} />
        {issued && (
          <div className="panel p-2 bg-panel-2 mono text-[11.5px] whitespace-pre-wrap break-all">
            {`# on the runner host, from a checkout of dashpay/status:\nDASH_CI_URL=${issued.url} DASH_CI_TOKEN=${issued.token} \\\n  DASH_CI_RUNNERS='[{"dir":"'$HOME'/actions-runner"}]' sh ci/reporter/install.sh`}
          </div>
        )}
      </div>
    </Section>
  );
}
