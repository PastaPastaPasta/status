import { useState } from 'react';
import { ago, clock, secs, useNow, useResource, useSession } from '../lib.js';
import { Empty, Err, Section, Stat } from '../ui.jsx';
import { CiTabs } from './CI.jsx';

// Waiting longer than this for one label set means its runners are short or gone.
const SLOW_SEC = 15 * 60;
const labelKey = (labels) => JSON.stringify([...labels].sort());
const HOLD = { waiting: ['approval', "waiting for a deployment environment's approval or wait timer"], pending: ['concurrency', 'waiting for another run in the same concurrency group to finish'] };

export default function Queue() {
  const session = useSession();
  const now = useNow(1000);
  const { data, error } = useResource(session.loaded ? `/api/ci/queue?as=${session.user?.id || 'public'}` : null, (t) => t === 'ci-queue');
  const [repo, setRepo] = useState('');
  const [labels, setLabels] = useState(null);
  if (!session.loaded) return <div className="mt-6 text-dim">Loading…</div>;
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!data) return <div className="mt-6 text-dim">Loading…</div>;
  const t = data.totals;
  const age = (ts) => (now - Date.parse(ts)) / 1000;
  const live = data.configured.webhook || data.configured.sweep;
  const show = (j) => (!repo || j.repo === repo) && (!labels || labelKey(j.labels) === labels);
  const waiting = data.waiting.filter(show), held = data.held.filter(show), running = data.running.filter(show);
  const repos = [...new Set([...data.waiting, ...data.held, ...data.running].map((j) => j.repo))].sort();
  const queuedAt = (j) => j.queuedAt || j.createdAt;
  const filtered = repo || labels;
  return (
    <div>
      <div className="mt-5 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-[16px] font-semibold">Actions queue</h1>
        <span className="text-dim text-[12px]">every {data.org} workflow job waiting, held or running now, GitHub-hosted and self-hosted</span>
        <CiTabs active="queue" />
      </div>
      {data.public && <div className="mt-2 text-[12px] text-dim">Public view: public repositories only; branches, links and runner names are left out. {session.user ? 'Your account has no access to more.' : 'Sign in for details.'}</div>}
      {!live ? (
        <div className="mt-3"><Empty>The Actions queue is not set up yet: the server has neither the org webhook secret nor GitHub API credentials.</Empty></div>
      ) : (
        <>
          <div className="mt-3 grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Waiting for a runner" value={t.waiting} level={t.oldestWaitingAt && age(t.oldestWaitingAt) > SLOW_SEC ? 'warn' : undefined}
              sub={t.oldestWaitingAt ? `oldest ${ago(t.oldestWaitingAt, now)}` : 'none'} title="Queued jobs that have asked for a runner and not got one yet" />
            <Stat label="Held" value={t.held} sub={`${t.approval} approval · ${t.concurrency} concurrency`} title="Jobs not yet asking for a runner: waiting for an environment approval or for another run in their concurrency group" />
            <Stat label="Running now" value={t.running} sub={`${data.labels.filter((g) => g.running).length} runner label sets`} />
            <Stat label="Runner wait · 24h" value={secs(t.medianWaitSec24h)} sub={t.p90WaitSec24h != null ? `p90 ${secs(t.p90WaitSec24h)}` : 'median, queued → started'} title="From queued (after any approval or concurrency hold) to started" level={t.p90WaitSec24h > SLOW_SEC ? 'warn' : undefined} />
            <Stat label="Finished · 24h" value={t.finished24h} sub={data.since ? `recording for ${ago(data.since, now)}` : 'nothing recorded yet'} title={data.since ? `since ${clock(data.since)}` : undefined} />
            <Stat label="Stuck runs" value={t.stuck} level={t.stuck ? 'warn' : undefined} sub="queued > 24 h" title="Runs queued for over 24 hours. GitHub will not start them; cancel them from the run page." />
          </div>

          <Section title="By runner labels" right={<span className="text-dim text-[11px]">select a row to filter the lists below</span>}>
            <div className="panel overflow-x-auto max-h-[360px]">
              <table className="grid w-full text-[12px]">
                <thead><tr><th>runs-on labels</th><th>Runners</th><th className="text-right">Waiting</th><th className="text-right">Oldest wait</th><th className="text-right">Held</th><th className="text-right">Running</th><th className="text-right">Median wait · 24h</th><th className="text-right">p90</th><th className="text-right">Jobs · 24h</th><th>Last picked up</th></tr></thead>
                <tbody>
                  {data.labels.map((g) => {
                    const oldest = g.oldestWaitingAt ? age(g.oldestWaitingAt) : null;
                    // Waiting jobs whose labels no runner has taken in a day or more of recording.
                    const orphan = g.waiting > 0 && !g.lastStartedAt && data.since && age(data.since) > 86_400;
                    return (
                      <tr key={g.key} className={labels === g.key ? 'open' : ''} onClick={() => setLabels(labels === g.key ? null : g.key)}>
                        <td>{g.labels.length ? g.labels.map((l) => <span key={l} className="tag mr-1">{l}</span>) : <span className="text-dim">none</span>}</td>
                        <td className="text-dim">{g.hosted ? 'GitHub-hosted' : 'self-hosted'}</td>
                        <td className={`mono text-right ${g.waiting ? 'lv-warn' : 'text-dim'}`}>{g.waiting}</td>
                        <td className={`mono text-right ${oldest > SLOW_SEC ? 'lv-warn' : ''}`}>{oldest != null ? ago(g.oldestWaitingAt, now) : '—'}</td>
                        <td className="mono text-right">{g.held || <span className="text-dim">0</span>}</td>
                        <td className="mono text-right">{g.running || <span className="text-dim">0</span>}</td>
                        <td className="mono text-right">{secs(g.medianWaitSec)}</td>
                        <td className={`mono text-right ${g.p90WaitSec > SLOW_SEC ? 'lv-warn' : ''}`}>{secs(g.p90WaitSec)}</td>
                        <td className="mono text-right">{g.finished24h}</td>
                        <td className={`mono ${orphan ? 'lv-down' : 'text-dim'}`} title={orphan ? 'No runner has started a job with exactly these labels since recording began. Check the label spelling and that a runner or pool serves it.' : undefined}>
                          {g.lastStartedAt ? `${ago(g.lastStartedAt, now)} ago` : orphan ? 'never seen' : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!data.labels.length && <div className="p-4 text-dim text-center">Nothing queued or running, and no jobs finished in the last 24 hours.</div>}
            </div>
          </Section>

          <Section title={`Waiting for a runner (${waiting.length}${filtered ? ` of ${data.waiting.length}` : ''})`} right={<Filters repos={repos} repo={repo} setRepo={setRepo} labels={labels} clear={() => { setRepo(''); setLabels(null); }} />}>
            <div className="panel overflow-x-auto max-h-[560px]">
              <table className="grid w-full text-[12px]">
                <thead><tr><th>Waiting</th><th>Repository</th><th>Workflow · job</th><th>Labels</th>{!data.public && <th>Branch</th>}</tr></thead>
                <tbody>
                  {waiting.map((j) => (
                    <tr key={j.id}>
                      <td className={`mono ${age(queuedAt(j)) > SLOW_SEC ? 'lv-warn' : ''}`} title={`queued ${clock(queuedAt(j))}`}>{ago(queuedAt(j), now)}</td>
                      <td className="mono">{j.repo}{j.private && <span className="tag ml-1.5">private</span>}</td>
                      <td className="max-w-[460px] truncate"><JobLink j={j} /><Unverified j={j} /></td>
                      <td className="mono text-dim">{j.labels.join(', ')}</td>
                      {!data.public && <td className="mono text-dim max-w-[220px] truncate">{j.branch || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!waiting.length && <div className="p-4 text-dim text-center">{filtered ? 'No waiting job matches the filter.' : 'No job is waiting for a runner.'}</div>}
            </div>
          </Section>

          {data.held.length > 0 && (
            <Section title={`Held before asking for a runner (${held.length}${filtered ? ` of ${data.held.length}` : ''})`} right={<span className="text-dim text-[11px]">not runner capacity: an approval or a concurrency group</span>}>
              <div className="panel overflow-x-auto max-h-[320px]">
                <table className="grid w-full text-[12px]">
                  <thead><tr><th>Held for</th><th>Repository</th><th>Workflow · job</th><th>Waiting on</th><th>Labels</th>{!data.public && <th>Branch</th>}</tr></thead>
                  <tbody>
                    {held.map((j) => (
                      <tr key={j.id}>
                        <td className="mono" title={clock(j.createdAt)}>{ago(j.createdAt, now)}</td>
                        <td className="mono">{j.repo}{j.private && <span className="tag ml-1.5">private</span>}</td>
                        <td className="max-w-[420px] truncate"><JobLink j={j} /><Unverified j={j} /></td>
                        <td className="text-dim" title={HOLD[j.status]?.[1]}>{HOLD[j.status]?.[0] || j.status}</td>
                        <td className="mono text-dim">{j.labels.join(', ')}</td>
                        {!data.public && <td className="mono text-dim max-w-[200px] truncate">{j.branch || '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!held.length && <div className="p-4 text-dim text-center">No held job matches the filter.</div>}
              </div>
            </Section>
          )}

          <Section title={`Running (${running.length}${filtered ? ` of ${data.running.length}` : ''})`}>
            <div className="panel overflow-x-auto max-h-[420px]">
              <table className="grid w-full text-[12px]">
                <thead><tr><th>Running for</th><th>Repository</th><th>Workflow · job</th>{!data.public && <th>Runner</th>}<th>Labels</th>{!data.public && <th>Branch</th>}</tr></thead>
                <tbody>
                  {running.map((j) => (
                    <tr key={j.id}>
                      <td className="mono" title={j.startedAt ? clock(j.startedAt) : undefined}>{j.startedAt ? ago(j.startedAt, now) : '—'}</td>
                      <td className="mono">{j.repo}{j.private && <span className="tag ml-1.5">private</span>}</td>
                      <td className="max-w-[420px] truncate"><JobLink j={j} /><Unverified j={j} /></td>
                      {!data.public && <td className="mono text-dim max-w-[220px] truncate" title={j.runnerGroup || undefined}>{j.runner || '—'}</td>}
                      <td className="mono text-dim">{j.labels.join(', ')}</td>
                      {!data.public && <td className="mono text-dim max-w-[200px] truncate">{j.branch || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!running.length && <div className="p-4 text-dim text-center">{filtered ? 'No running job matches the filter.' : 'No job is running.'}</div>}
            </div>
          </Section>

          {data.stuck.length > 0 && (
            <Section title={`Stuck runs (${data.stuck.length})`} right={<span className="text-dim text-[11px]">queued for over 24 h; cancel them from the run page</span>}>
              <div className="panel overflow-x-auto max-h-[320px]">
                <table className="grid w-full text-[12px]">
                  <thead><tr><th>Queued for</th><th>Repository</th><th>Workflow</th><th>Status</th><th>Trigger</th>{!data.public && <th>Branch</th>}</tr></thead>
                  <tbody>
                    {data.stuck.map((r) => (
                      <tr key={`${r.repo}|${r.createdAt}|${r.workflow}|${r.url || ''}`}>
                        <td className="mono lv-warn" title={clock(r.createdAt)}>{ago(r.createdAt, now)}</td>
                        <td className="mono">{r.repo}</td>
                        <td>{r.url ? <a className="link" href={r.url} target="_blank" rel="noreferrer">{r.workflow || '—'}</a> : r.workflow || '—'}</td>
                        <td className="text-dim">{r.status}</td>
                        <td className="mono text-dim">{r.event}</td>
                        {!data.public && <td className="mono text-dim max-w-[220px] truncate">{r.branch || '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
      <div className="mt-3 text-faint text-[11px]">
        {data.configured.webhook ? `Org webhook: last event ${data.lastEventAt ? `${ago(data.lastEventAt, now)} ago` : 'not received yet'}.` : 'Org webhook not configured: the queue updates only when GitHub is swept.'}{' '}
        {data.sweep ? `Swept ${data.sweep.repos != null ? `${data.sweep.repos} ` : ''}active ${data.sweep.scope === 'all' ? '' : 'public '}repositories ${ago(data.sweep.at, now)} ago.` : data.configured.sweep ? 'First sweep pending.' : ''}
        {data.sweep?.error ? ` Last sweep error: ${data.sweep.error}.` : ''}
        {data.sweep?.rate ? ` ${data.sweep.rate.remaining} GitHub requests left this hour.` : ''}
        {t.unverified ? ` ${t.unverified} job${t.unverified === 1 ? '' : 's'} not updated for over 2 hours (marked unverified).` : ''}
      </div>
    </div>
  );
}

function Unverified({ j }) {
  return j.stale ? <span className="tag ml-1.5 lv-warn" title="No update from GitHub for over 2 hours (the sweep cannot read this repository); it may have finished.">unverified</span> : null;
}

function JobLink({ j }) {
  const text = `${j.workflow ? `${j.workflow} · ` : ''}${j.name}`;
  return j.url ? <a className="link" href={j.url} target="_blank" rel="noreferrer">{text}</a> : <span>{text}</span>;
}

function Filters({ repos, repo, setRepo, labels, clear }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {labels && <span className="text-dim">label filter on</span>}
      <select className="input !py-0.5 !text-[11px]" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Filter by repository">
        <option value="">all repositories</option>
        {repos.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      {(repo || labels) && <button className="text-dim hover:text-fg" onClick={clear}>clear</button>}
    </div>
  );
}
