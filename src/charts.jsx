// Small chart kit for the infrastructure pages: one hover tooltip, a 48-hour
// utilisation strip, stacked daily columns and labelled horizontal bars.
// Colours are validated for the dark surface (dataviz validator): a one-hue
// blue ramp for magnitude and fixed categorical slots for series.
import { SEQ } from './viz.js';

export function TipLayer({ tip }) {
  if (!tip) return null;
  return (
    <div role="tooltip" className="fixed z-50 pointer-events-none panel px-2.5 py-1.5 text-[11.5px] shadow-lg max-w-[320px]"
      style={{ left: Math.min(tip.x + 12, window.innerWidth - 330), top: Math.max(8, tip.y - 12), transform: 'translateY(-100%)' }}>
      {tip.render()}
    </div>
  );
}

export function TipRow({ color, value, label }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      {color && <span className="inline-block w-3 h-[2px] rounded" style={{ background: color }} />}
      <span className="mono font-semibold text-fg">{value}</span>
      <span className="text-dim">{label}</span>
    </div>
  );
}

const rampColor = (v) => SEQ[Math.min(SEQ.length - 1, Math.floor(v * SEQ.length))];

// Busy fraction per hour; hours without a report are hatched (offline, not idle).
export function HourStrip({ hours, bind, label }) {
  return (
    <div className="flex gap-[2px] h-3.5" role="img" aria-label={label}>
      {hours.map((h) => {
        const pct = Math.round(h.busy * 100);
        const when = `${h.hour.slice(5, 10)} ${h.hour.slice(11, 16)}Z`;
        return (
          <div key={h.hour} className={`flex-1 rounded-[2px] ${!h.reported && h.busy === 0 ? 'hatch' : ''}`}
            style={{ background: h.busy > 0 ? rampColor(h.busy) : h.reported ? '#1a2330' : undefined }}
            {...bind(() => (<><div className="text-dim mb-0.5">{when} · 1 hour</div>{h.reported || h.busy > 0 ? <TipRow value={`${pct}%`} label="busy" /> : <div className="text-dim">no report from the runner host</div>}</>))} />
        );
      })}
    </div>
  );
}

// Share of each bucket a label set was at capacity; buckets before recording began are hatched.
export function CapacityStrip({ buckets, bucketSec, bind, label }) {
  const hours = bucketSec / 3600;
  return (
    <div className="flex gap-[1px] h-3.5 min-w-[160px]" role="img" aria-label={label}>
      {buckets.map((b) => {
        const when = `${b.at.slice(5, 10)} ${b.at.slice(11, 16)}Z`;
        return (
          <div key={b.at} className={`flex-1 rounded-[2px] ${!b.recorded ? 'hatch' : ''}`}
            style={{ background: b.atCapacity > 0 ? rampColor(b.atCapacity) : b.recorded ? '#1a2330' : undefined }}
            {...bind(() => (<><div className="text-dim mb-0.5">{when} · {hours} hour{hours === 1 ? '' : 's'}</div>
              {b.recorded ? <><TipRow value={`${Math.round(b.atCapacity * 100)}%`} label="of the time at capacity" /><TipRow value={b.avgRunning.toFixed(1)} label="jobs running on average" /></> : <div className="text-dim">not recorded yet</div>}</>))} />
        );
      })}
    </div>
  );
}

export function StripLegend({ low = 'idle', high = 'busy', hatched = 'no report' }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-dim">
      <span className="flex items-center gap-1">{low} <span className="inline-block w-3 h-2.5 rounded-[2px]" style={{ background: '#1a2330' }} />{SEQ.map((c) => <span key={c} className="inline-block w-3 h-2.5 rounded-[2px]" style={{ background: c }} />)} {high}</span>
      <span className="flex items-center gap-1"><span className="inline-block w-3 h-2.5 rounded-[2px] hatch" /> {hatched}</span>
    </div>
  );
}

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

// Stacked columns (bottom-up in `series` order), <=24px wide, 2px surface gaps,
// 4px rounded cap on the top segment only, square at the baseline.
export function Columns({ rows, series, xLabel, bind, height = 150, format = (v) => v.toLocaleString('en-US'), tip }) {
  const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const ticks = [0, max / 2, max];
  const step = Math.max(1, Math.ceil(rows.length / 8)); // label about eight columns, ending at the newest
  return (
    <div className="flex gap-2">
      <div className="flex flex-col justify-between text-[10.5px] text-faint mono text-right shrink-0 pb-5" style={{ height: height + 20 }}>
        {[...ticks].reverse().map((t) => <span key={t} className="leading-none">{format(t)}</span>)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative" style={{ height }}>
          {ticks.map((t) => <div key={t} className="absolute left-0 right-0 border-t border-line" style={{ bottom: `${(t / max) * 100}%` }} />)}
          <div className="absolute inset-0 flex items-end">
            {rows.map((r, i) => {
              const segs = series.filter((s) => r[s.key] > 0);
              return (
                <div key={i} tabIndex={0} className="flex-1 h-full flex flex-col-reverse items-center outline-none group" {...bind(() => tip(r))}>
                  {segs.map((s, j) => (
                    <div key={s.key} className={`w-full max-w-[24px] group-hover:brightness-125 ${j === segs.length - 1 ? 'rounded-t-[4px]' : ''}`}
                      style={{ height: `calc(${(r[s.key] / max) * 100}% - ${j ? 2 : 0}px)`, marginTop: j < segs.length - 1 ? 2 : 0, background: s.color }} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex mt-1.5">
          {rows.map((r, i) => <div key={i} className="flex-1 text-center text-[10.5px] text-faint mono whitespace-nowrap overflow-visible">{(rows.length - 1 - i) % step ? '' : xLabel(r)}</div>)}
        </div>
      </div>
    </div>
  );
}

export function Legend({ series }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-dim">
      {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: s.color }} />{s.label}</span>)}
    </div>
  );
}

// Horizontal bars, one hue, value at the tip.
export function HBars({ rows, format, bind, tip, color }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} tabIndex={0} className="grid grid-cols-[minmax(120px,38%)_1fr] items-center gap-3 text-[12px] outline-none group" {...bind(() => tip(r))}>
          <span className="truncate text-dim" title={r.label}>{r.label}</span>
          <span className="flex items-center gap-2 min-w-0">
            <span className="h-3.5 rounded-r-[4px] group-hover:brightness-125 shrink-0" style={{ width: `${Math.max(0.5, (r.value / max) * 72)}%`, background: color }} />
            <span className="mono text-fg shrink-0">{format(r.value)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
