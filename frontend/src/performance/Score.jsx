// My Score (Oct 30 2026): the person's role scorecard (Settings >
// Performance > KPI Scorecards) applied to their month - one row per KPI
// with its weight, target and attainment, and the total. A manager or HR
// rates a manual KPI from here, with a reason. Rules: backend/perf_scores.py.
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Gauge, PenLine } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { Modal } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { formatDateTime } from '../lib/datetime';
import { NX } from '../tasks/theme';
import { card, cardHead, HD, LBL, muted, TAP } from './lib';

const STATUS = {
  met: { label: 'Met', color: NX.green },
  partly: { label: 'Partly', color: NX.amber },
  missed: { label: 'Missed', color: NX.red },
  unmeasured: { label: 'Not Measured', color: '#64748b' },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = p => { const [y, m] = p.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
const shift = (p, n) => { const [y, m] = p.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export function scoreColor(n) {
  return n == null ? '#64748b' : n >= 90 ? NX.green : n >= 60 ? NX.amber : NX.red;
}

function RateModal({ item, person, month, onClose, onSaved, toastErr }) {
  const [value, setValue] = useState(item.rating?.value ?? '');
  const [reason, setReason] = useState(item.rating?.reason || '');
  const [busy, setBusy] = useState(false);
  const rating = item.unit === 'rating';
  const save = () => {
    setBusy(true);
    api.perfRateKpi({ person, kpi: item.kpi, month, value: Number(value), reason })
      .then(onSaved).catch(e => toastErr?.(e.message || 'Could not save the rating.')).finally(() => setBusy(false));
  };
  const ok = value !== '' && reason.trim();
  return (
    <Modal title={`Rate ${item.name}`} onClose={onClose} isDirty={!!reason}
      footer={<><button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" disabled={!ok || busy} onClick={save}>{busy ? 'Saving...' : 'Save Rating'}</button></>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={muted}>{monthLabel(month)}. Target {item.target}{item.unit === '%' ? '%' : ''}, weight {item.weight}%. {rating ? 'Rate from 1 to 5.' : item.unit === '%' ? 'A percentage from 0 to 100.' : 'A number.'}</div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={LBL}>Rating</span>
          {rating ? (
            <div role="radiogroup" aria-label="Rating" style={{ display: 'flex', gap: 6 }}>
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" role="radio" aria-checked={Number(value) === n} onClick={() => setValue(n)}
                  className="secondary-btn" style={{ ...TAP, minWidth: 44, fontWeight: 700, background: Number(value) === n ? 'var(--ink)' : undefined, color: Number(value) === n ? '#fff' : undefined }}>{n}</button>
              ))}
            </div>
          ) : <input className="form-input" type="number" aria-label="Rating" value={value} onChange={e => setValue(e.target.value)} style={{ maxWidth: 160 }} />}
        </label>
        <label className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={LBL}>Reason</span>
          <textarea className="form-input nx-fill" aria-label="Reason" value={reason} onChange={e => setReason(e.target.value)} rows={5}
            placeholder="What this rating is based on - the person reads it." style={{ resize: 'vertical' }} />
        </label>
      </div>
    </Modal>
  );
}

function Row({ it, onRate }) {
  const st = STATUS[it.status] || STATUS.unmeasured;
  const unit = it.unit === '%' ? '%' : '';
  return (
    <div className="nx-perf-score-row" data-kpi={it.kpi}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{it.name}</span>
          <StatusLabel label={st.label} color={st.color} size="sm" />
          {it.source === 'manual' && onRate && (
            <button type="button" className="secondary-btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => onRate(it)}>
              <PenLine size={12} /> {it.rating ? 'Change Rating' : 'Rate'}
            </button>
          )}
        </div>
        <div style={{ ...muted, fontSize: 12 }}>
          Weight {it.weight}% - target {it.target}{unit}, threshold {it.threshold}{unit}
          {it.rating && <> - rated by {it.rating.byName || it.rating.by}{it.rating.at ? ` on ${formatDateTime(it.rating.at)}` : ''}: "{it.rating.reason}"</>}
        </div>
      </div>
      <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{it.measured ? it.display : <span style={muted}>-</span>}</div>
        <div style={{ ...muted, fontSize: 11.5 }}>{it.measured ? `${it.attainment}% of target` : (it.source === 'manual' ? 'Awaiting a rating' : 'No data yet')}</div>
      </div>
      <div className="nx-perf-score-bar" aria-hidden="true">
        <span style={{ width: `${it.attainment || 0}%`, background: st.color }} />
      </div>
    </div>
  );
}

// `email` '' = the signed-in person. `canRate` = the viewer is the person's
// manager or HR (the server checks again).
export default function ScoreCard({ email = '', title = 'My Score', canRate = false, toastOk, toastErr }) {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [rating, setRating] = useState(null);
  const load = useCallback(() => {
    setErr('');
    api.perfScore(email, month).then(setData).catch(e => setErr(e.message || 'Could not load the score.'));
  }, [email, month]);
  useEffect(() => { setData(null); load(); }, [load]);
  const total = data?.score;
  return (
    <section style={card} data-score-card aria-label={title}>
      <div style={cardHead}>
        <Gauge size={16} /><span style={HD}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="secondary-btn" aria-label="Previous month" style={{ padding: '4px 6px' }} onClick={() => setMonth(m => shift(m, -1))}><ChevronLeft size={14} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 120, textAlign: 'center' }}>{monthLabel(month)}</span>
          <button type="button" className="secondary-btn" aria-label="Next month" style={{ padding: '4px 6px' }} disabled={month >= thisMonth()} onClick={() => setMonth(m => shift(m, 1))}><ChevronRight size={14} /></button>
        </span>
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : !data ? <SkeletonBlocks count={3} height={40} /> : data.status === 'no_role' ? (
        <div style={muted}>No job role in People yet, so there is no scorecard to score against.</div>
      ) : data.status === 'no_scorecard' ? (
        <div style={muted}>No KPI scorecard for the {data.role?.name} role this month. HR sets one in Settings &gt; Performance &gt; KPI Scorecards.</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
            <span data-score-total style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: scoreColor(total), lineHeight: 1 }}>{total == null ? '-' : total}</span>
            <span style={muted}>
              {total == null ? 'Nothing measured yet this month.' : `out of 100 for the ${data.role?.name} role`}
              {data.measuredWeight > 0 && data.measuredWeight < 100 && ` - ${data.measuredWeight}% of the weight measured so far, the rest scaled up`}
            </span>
          </div>
          {data.bonusPlan && (
            <div data-bonus-plan style={{ ...muted, marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--mist)' }}>
              <b>Bonus plan:</b> {data.bonusPlan.targetPct}% of base pay, paid {data.bonusPlan.period}.{' '}
              {data.bonusPlan.payoutPct == null ? 'Nothing measured yet, so no payout to show.'
                : data.bonusPlan.blendedScore != null ? `Blended with your latest review (${data.bonusPlan.reviewScore}) the bonus score is ${data.bonusPlan.blendedScore}, which pays ${data.bonusPlan.payoutPct}% of the target.`
                  : `At this score the payout is ${data.bonusPlan.payoutPct}% of the target.`}{' '}
              Score {data.bonusPlan.thresholdScore} pays {data.bonusPlan.payoutAtThreshold}%, 100 pays the full target{data.bonusPlan.maxPayout > 100 ? `, up to ${data.bonusPlan.maxPayout}% when every KPI is over target` : ''}.
              {data.bonusPlan.reviewWeight > 0 && ` The bonus score blends ${100 - data.bonusPlan.reviewWeight}% KPIs with ${data.bonusPlan.reviewWeight}% your latest review rating.`}
            </div>
          )}
          <div style={{ display: 'grid' }}>
            {(data.items || []).map(it => <Row key={it.kpi} it={it} onRate={canRate ? setRating : null} />)}
          </div>
        </>
      )}
      {rating && data && (
        <RateModal item={rating} person={data.email} month={month} toastErr={toastErr} onClose={() => setRating(null)}
          onSaved={s => { setRating(null); setData(s); toastOk?.('Rating saved.'); }} />
      )}
    </section>
  );
}
