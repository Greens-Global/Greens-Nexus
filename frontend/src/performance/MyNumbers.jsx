// My Numbers (Neil, Oct 29 2026: "it needs to provide some real metrics from
// Nexus"): a row of tiles from what Nexus already records - arrival, hours,
// time sheets, tasks, tickets, training - for This Month, This Quarter or
// This Review. Nobody types them; a number that does not apply to the person
// is not shown (backend/perf_metrics.py).
import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { PERIODS, card, cardHead, HD, muted } from './lib';

export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'inline-flex', padding: 3, borderRadius: 10, background: 'var(--mist)', gap: 2, maxWidth: '100%', overflowX: 'auto' }}>
      {options.map(o => (
        <button key={o.key} type="button" role="tab" aria-selected={value === o.key} onClick={() => onChange(o.key)}
          style={{ padding: '6px 12px', minHeight: 32, borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
            fontWeight: 600, whiteSpace: 'nowrap', background: value === o.key ? 'var(--card)' : 'transparent',
            color: value === o.key ? 'var(--ink)' : 'var(--muted)', boxShadow: value === o.key ? 'var(--wk-shadow)' : 'none' }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NumberTiles({ metrics }) {
  const shown = (metrics || []).filter(m => m.available);
  if (!shown.length) return <div style={{ ...muted, padding: '4px 2px' }}>No numbers yet - they fill in as Nexus records shifts, time sheets, tasks, tickets and training.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
      {shown.map(m => (
        <div key={m.key} title={m.description} data-metric={m.key}
          style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>{m.display}</div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>{m.label}</div>
          {m.detail && <div style={{ ...muted, fontSize: 11.5, marginTop: 2 }}>{m.detail}</div>}
        </div>
      ))}
    </div>
  );
}

// `email` ''= me. `start`/`end` fix the period (the review form); else the
// person picks This Month / This Quarter / This Review.
export default function MyNumbers({ email = '', start = '', end = '', title = 'My Numbers', bare = false, initialPeriod = 'quarter' }) {
  const fixed = !!(start && end);
  const [period, setPeriod] = useState(initialPeriod);
  // Each answer remembers the request it answers, so switching the period
  // shows the skeleton again rather than the last period's numbers.
  const want = `${email}|${period}|${fixed ? `${start}|${end}` : ''}`;
  const [got, setGot] = useState({ key: '', data: null, err: '' });
  useEffect(() => {
    let live = true;
    api.perfScorecard({ email, period, start: fixed ? start : '', end: fixed ? end : '' })
      .then(r => { if (live) setGot({ key: want, data: r, err: '' }); })
      .catch(e => { if (live) setGot({ key: want, data: null, err: e?.message || 'Could not load the numbers.' }); });
    return () => { live = false; };
  }, [email, period, start, end, fixed, want]);
  const out = got.key === want ? got.data : null;
  const err = got.key === want ? got.err : '';
  const body = err ? <ErrorBanner message={err} /> : !out ? <SkeletonBlocks count={1} height={72} /> : <NumberTiles metrics={out.metrics} />;
  const span = out?.period ? `${formatDate(out.period.start)} to ${formatDate(out.period.readTo || out.period.end)}` : '';
  if (bare) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {span && <div style={{ ...muted, fontSize: 12 }}>{span}</div>}
        {body}
      </div>
    );
  }
  return (
    <section style={card} aria-label={title}>
      <div style={cardHead}>
        <span className="wkc-chip"><BarChart3 size={14} /></span>
        <span style={HD}>{title}</span>
        {span && <span style={{ ...muted, fontSize: 12 }}>{span}</span>}
        {!fixed && <span style={{ marginLeft: 'auto' }}><Segmented value={period} onChange={setPeriod} options={PERIODS} label="Period" /></span>}
      </div>
      {body}
    </section>
  );
}
