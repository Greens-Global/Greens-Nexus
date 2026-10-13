// Operations -> Market Rates: our street rate against nearby facilities, size
// by size, and a suggested rate.
//
// Competitor rates are recorded by people (a website, a call, a drive-by) with
// the date they were seen - nothing here reads another company's site. The
// suggested rate is a rule printed on the screen, not an opinion: the median
// competitor rate, moved by how full we are, held to a 10% step. The written
// analysis is Claude reading this same table.
import { useCallback, useEffect, useState } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { count, money, pct } from './model';

const signed = (cents) => `${cents > 0 ? '+' : cents < 0 ? '-' : ''}${money(Math.abs(cents))}`;
const sizeLabel = (r) => `${r.width} x ${r.depth}${r.parking ? ' Parking' : ''}`;

function Kpi({ label, value, sub }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-delta">{sub}</div>}
    </div>
  );
}

// Where we sit against the market median, as words a manager would use.
function position(r) {
  if (r.marketMedian == null) return ['pill-muted', 'No Data'];
  const gap = (r.street - r.marketMedian) / r.marketMedian;
  if (gap > 0.03) return ['status-pending', `${Math.round(gap * 100)}% Above`];
  if (gap < -0.03) return ['pill-info', `${Math.round(-gap * 100)}% Below`];
  return ['status-approved', 'At Market'];
}

function AddCompetitor({ facilityId, onSaved }) {
  const [f, setF] = useState({ name: '', distance: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!f.name.trim()) { setError('Give the competitor a name.'); return; }
    setBusy(true);
    setError('');
    try {
      onSaved(await api.addOpsCompetitor({ facility_id: facilityId, name: f.name, website: f.website,
        distance_miles: f.distance === '' ? null : Number(f.distance) }));
      setF({ name: '', distance: '', website: '' });
    } catch (err) {
      console.error('Operations: could not add competitor', err);
      setError('The competitor could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <form className="ops-form" onSubmit={submit}>
      <label>Competitor<input className="form-input" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name of the facility" /></label>
      <label>Miles Away<input className="form-input" type="number" min="0" step="0.1" value={f.distance} onChange={(e) => setF({ ...f, distance: e.target.value })} placeholder="1.5" /></label>
      <label>Website<input className="form-input" value={f.website} maxLength={300} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="Optional" /></label>
      <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} aria-hidden="true" /> Add Competitor</button>
      {error && <p className="ops-form-error" role="alert">{error}</p>}
    </form>
  );
}

function RecordRate({ competitors, sizes, today, onSaved }) {
  const blank = { competitor: competitors[0]?.id || '', size: 0, rate: '', promo: '', on: today };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const competitor = competitors.some((c) => c.id === f.competitor) ? f.competitor : competitors[0]?.id || '';
  const submit = async (e) => {
    e.preventDefault();
    const size = sizes[Number(f.size)];
    if (!competitor || !size) { setError('Choose a competitor and a size.'); return; }
    if (!(Number(f.rate) > 0)) { setError('Enter the monthly rate you saw, in dollars.'); return; }
    setBusy(true);
    setError('');
    try {
      onSaved(await api.recordOpsRate({ competitor_id: competitor, width: size.width, depth: size.depth, parking: size.parking,
        rate: Number(f.rate), promo: f.promo, observed_on: f.on || today }));
      setF({ ...f, rate: '', promo: '' });
    } catch (err) {
      console.error('Operations: could not record rate', err);
      setError(err?.status === 422 ? 'Check the rate and the date, then try again.' : 'The rate could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <form className="ops-form" onSubmit={submit}>
      <label>Competitor
        <select className="form-input" value={competitor} onChange={(e) => setF({ ...f, competitor: e.target.value })}>
          {competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label>Unit Size
        <select className="form-input" value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })}>
          {sizes.map((s, i) => <option key={s.key} value={i}>{sizeLabel(s)}</option>)}
        </select>
      </label>
      <label>Monthly Rate ($)<input className="form-input" type="number" min="1" step="1" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="189" /></label>
      <label>Date Seen<input className="form-input" type="date" max={today} value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></label>
      <label>Promotion<input className="form-input" value={f.promo} maxLength={200} onChange={(e) => setF({ ...f, promo: e.target.value })} placeholder="First month free (optional)" /></label>
      <button type="submit" className="primary-btn" disabled={busy}>Record Rate</button>
      {error && <p className="ops-form-error" role="alert">{error}</p>}
    </form>
  );
}

function Analysis({ facilityId, ready }) {
  const [state, setState] = useState({ status: 'idle', data: null, message: '' });
  const run = async () => {
    setState({ status: 'loading', data: null, message: '' });
    try {
      setState({ status: 'ready', data: await api.opsMarketAnalysis(facilityId), message: '' });
    } catch (err) {
      console.error('Operations: market analysis failed', err);
      setState({ status: 'error', data: null,
        message: err?.status === 503 ? 'The written analysis is not connected on this server yet. The table and the suggested rates do not depend on it.'
          : 'The analysis could not be written just now. Try again in a minute.' });
    }
  };
  const d = state.data;
  return (
    <div className="dash-card">
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">Written Analysis</div>
          <div className="dash-card-sub">Claude reads the table below and says what matters most. Every figure in it comes from the table.</div>
        </div>
        <button type="button" className="secondary-btn" onClick={run} disabled={!ready || state.status === 'loading'}
          title={ready ? undefined : 'Record a competitor rate first'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Sparkles size={14} aria-hidden="true" /> {d ? 'Write Again' : 'Write Analysis'}
        </button>
      </div>
      {state.status === 'loading' && <LoadingState compact label="Reading the comparison" />}
      {state.status === 'error' && <div className="ops-empty" role="alert">{state.message}</div>}
      {state.status === 'idle' && <div className="ops-empty">{ready ? 'Nothing written yet.' : 'Record at least one competitor rate, then ask for an analysis.'}</div>}
      {d && (
        <div className="ops-analysis">
          <p className="ops-analysis-head">{d.headline}</p>
          {[['What the Numbers Say', d.findings], ['What to Do', d.actions], ['What Is Missing', d.gaps]].map(([title, items]) => (items?.length ? (
            <div key={title}>
              <h4>{title}</h4>
              <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          ) : null))}
          <p className="ops-note">Written {formatDateTime(d.writtenAt)} from {count(d.sizesCompared)} compared sizes.</p>
        </div>
      )}
    </div>
  );
}

export default function Market({ facility, facilities, onPick }) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const facilityId = facility?.id;

  const load = useCallback(async () => {
    if (!facilityId) return;
    setState({ status: 'loading', data: null });
    try {
      setState({ status: 'ready', data: await api.getOpsMarket(facilityId) });
    } catch (err) {
      console.error('Operations: could not load market rates', err);
      setState({ status: 'error', data: null });
    }
  }, [facilityId]);
  useEffect(() => { load(); }, [load]);

  if (!facility) {
    return (
      <div className="dash-card">
        <div className="dash-card-title">Choose a Facility</div>
        <div className="dash-card-sub" style={{ marginBottom: 14 }}>Rates are compared against the competitors around one facility at a time.</div>
        <div className="ops-pills">
          {facilities.map((f) => <button type="button" key={f.id} className="ops-pill" aria-pressed="false" onClick={() => onPick(f.id)}>{f.shortName}</button>)}
        </div>
      </div>
    );
  }
  if (state.status === 'loading') return <LoadingState size="section" label="Loading market rates" minHeight={240} />;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load the market rates." onRetry={load} />;

  const m = state.data;
  const setData = (data) => setState({ status: 'ready', data });
  const compared = m.rows.filter((r) => r.suggested != null);
  const above = compared.filter((r) => r.street > r.marketMedian * 1.03).length;
  const below = compared.filter((r) => r.street < r.marketMedian * 0.97).length;
  const impact = compared.reduce((a, r) => a + r.monthlyImpact, 0);
  const sizes = [...new Map(m.rows.map((r) => [`${r.parking ? 'P' : 'S'}:${r.width}x${r.depth}`, { key: `${r.parking}:${r.width}x${r.depth}`, width: r.width, depth: r.depth, parking: r.parking }])).values()]
    .sort((a, b) => Number(a.parking) - Number(b.parking) || a.width * a.depth - b.width * b.depth);
  const remove = async (c) => {
    try { setData(await api.removeOpsCompetitor(c.id)); } catch (err) { console.error('Operations: could not remove competitor', err); }
  };

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Competitors Tracked" value={count(m.competitors.length)} sub={`Around ${m.facility}`} />
        <Kpi label="Sizes Compared" value={`${count(compared.length)} of ${count(m.rows.length)}`} sub={`Needs ${m.minCompetitors} competitor rates per size`} />
        <Kpi label="Priced Above Market" value={count(above)} sub="More than 3% over the median" />
        <Kpi label="Priced Below Market" value={count(below)} sub="More than 3% under the median" />
        <Kpi label="If Suggestions Are Adopted" value={signed(impact)} sub="Per month, on vacant units at the new rate" />
      </div>

      <Analysis key={facilityId} facilityId={facilityId} ready={m.rows.some((r) => r.competitors > 0)} />

      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">Our Rates Against the Market</div>
            <div className="dash-card-sub">
              Market is each competitor&apos;s newest rate from the last {m.freshDays} days. Suggested = the market median, moved by how full we are, held to a 10% step.
            </div>
          </div>
        </div>
        <div className="req-table-wrapper">
          <table className="req-table stack-table">
            <thead><tr>
              <th>Unit Type</th><th className="num">Occupancy</th><th className="num">Our Street Rate</th><th className="num">Our Average Rent</th>
              <th className="num">Market Low</th><th className="num">Market Median</th><th className="num">Market High</th>
              <th>Position</th><th className="num">Suggested</th><th>Why</th>
            </tr></thead>
            <tbody>
              {m.rows.map((r) => {
                const [cls, label] = position(r);
                return (
                  <tr key={r.name}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td data-th="Occupancy" className="num">{pct(r.rented, r.rented + r.vacant, 0)}</td>
                    <td data-th="Our Street Rate" className="num">{money(r.street)}</td>
                    <td data-th="Our Average Rent" className="num">{r.averageRent ? money(r.averageRent) : '-'}</td>
                    <td data-th="Market Low" className="num" title={r.lowestBy ? `Lowest: ${r.lowestBy}` : undefined}>{r.marketLow == null ? '-' : money(r.marketLow)}</td>
                    <td data-th="Market Median" className="num">{r.marketMedian == null ? '-' : money(r.marketMedian)}</td>
                    <td data-th="Market High" className="num">{r.marketHigh == null ? '-' : money(r.marketHigh)}</td>
                    <td data-th="Position"><span className={`status-badge ${cls}`}>{label}</span></td>
                    <td data-th="Suggested" className="num">
                      {r.suggested == null ? '-' : <><strong>{money(r.suggested)}</strong>{r.change !== 0 && <span className="ops-delta"> {signed(r.change)}</span>}</>}
                    </td>
                    <td data-th="Why" className="ops-why">{r.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="ops-grid-2">
        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Competitors</div>
            <div className="dash-card-sub">Facilities a customer would price against {m.facility}</div>
          </div></div>
          {m.competitors.length ? (
            <ul className="ops-reports">
              {m.competitors.map((c) => (
                <li className="ops-report" key={c.id}>
                  <div>
                    <div className="ops-report-title">{c.name}</div>
                    <div className="ops-report-about">
                      {c.distanceMiles ? `${c.distanceMiles} miles away - ` : ''}{count(c.rates.length)} {c.rates.length === 1 ? 'rate' : 'rates'} on file
                      {c.rates[0] ? ` - last seen ${formatDate(c.rates[0].observedOn)}` : ''}
                    </div>
                  </div>
                  <button type="button" className="secondary-btn" onClick={() => remove(c)} aria-label={`Stop tracking ${c.name}`} title="Stop tracking. Recorded rates are kept.">
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <div className="ops-empty">No competitors yet. Add the two or three facilities nearest {m.facility}.</div>}
          <AddCompetitor facilityId={facilityId} onSaved={setData} />
        </div>

        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Record a Rate</div>
            <div className="dash-card-sub">What a competitor charges for one of our sizes, and the day you saw it. Every entry is kept as history.</div>
          </div></div>
          {m.competitors.length
            ? <RecordRate competitors={m.competitors} sizes={sizes} today={m.asOf} onSaved={setData} />
            : <div className="ops-empty">Add a competitor first.</div>}
        </div>
      </div>
    </>
  );
}
