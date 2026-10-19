// Operations -> Market Rates: our street rate against nearby facilities, size
// by size, and a suggested rate.
//
// Competitor rates come from three places: the StorTrack feed Cubby includes in
// our plan (ops_stortrack.py, read from Cubby's warehouse a few times a day),
// each competitor's own public pricing page, read once a day by the server
// (ops_market_engine.py - an identified reader that obeys robots.txt), and
// what people record by hand (a call, a drive-by, a site that cannot be read). Who is nearby comes from
// OpenStreetMap, which must be credited wherever that list is shown. The
// suggested rate is a rule printed on the screen, not an opinion: the median
// competitor rate, moved by how full we are, held to a 10% step. The written
// analysis is Claude reading this same table.
import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { useRole } from '../contexts/RoleContext';
import { formatDate, formatDateTime, formatTime } from '../lib/datetime';
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

// One observation says where it came from: StorTrack, the competitor's website, or a person.
const SOURCE_CHIP = {
  stortrack: ['pill-info', 'StorTrack', 'From the StorTrack rate feed (through Cubby)'],
  web: ['status-approved', 'Website', "Read from the competitor's own pricing page"],
  manual: ['pill-muted', 'Manual', 'Entered by staff'],
};
export function SourceChip({ source }) {
  const [cls, label, title] = SOURCE_CHIP[source] || SOURCE_CHIP.manual;
  return <span className={`status-badge ${cls}`} title={title}>{label}</span>;
}

// "StorTrack last synced 10/20/2026 9:05 AM", the Sync Now button for
// managers, and a quiet "not connected yet" until the warehouse key is set.
export function StorTrackStatus({ st, canSync, facilityId, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!st) return null;
  if (!st.connected) {
    return (
      <p className="ops-note" data-testid="stortrack-status">
        <strong>StorTrack not connected yet.</strong> {st.hint || 'Rates from the StorTrack feed appear here once the Cubby warehouse key is set.'}
      </p>
    );
  }
  const sync = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await api.syncOpsStorTrack(facilityId);
      if (out?.market) onSaved(out.market);
    } catch (err) {
      console.error('Operations: StorTrack sync failed', err);
      setError(err?.status === 409 ? 'A StorTrack sync is already running. The rates will update when it finishes.'
        : 'StorTrack could not be synced just now. Try again in a few minutes.');
    } finally { setBusy(false); }
  };
  const when = st.lastSyncedAt ? `${formatDate(st.lastSyncedAt)} ${formatTime(st.lastSyncedAt)}` : '';
  return (
    <div className="ops-note" data-testid="stortrack-status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
      <span>
        <SourceChip source="stortrack" />{' '}
        {st.running ? 'StorTrack sync running now.' : when ? `StorTrack last synced ${when}` : 'StorTrack has not synced yet.'}
        {st.lastStatus === 'error' && st.lastDetail ? ` The last try did not finish: ${st.lastDetail}.` : ''}
      </span>
      {canSync && (
        <button type="button" className="secondary-btn" onClick={sync} disabled={busy || st.running}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} aria-hidden="true" /> {busy ? 'Syncing' : 'Sync StorTrack Now'}
        </button>
      )}
      {error && <span className="ops-form-error" role="alert">{error}</span>}
    </div>
  );
}

// How the last read of a competitor's rates page went.
const CHECK_STATUS = {
  ok: ['status-approved', 'Rates Read'],
  no_rates_found: ['pill-muted', 'No Rates Found'],
  blocked_by_robots: ['status-pending', 'Blocked by Robots Rules'],
  blocked: ['status-pending', 'Blocked'],
  unreachable: ['status-pending', 'Unreachable'],
  not_connected: ['pill-muted', 'Not Connected'],
  error: ['status-rejected', 'Error'],
};

function RateMoves({ moves }) {
  return (
    <div className="dash-card">
      <div className="dash-card-head"><div>
        <div className="dash-card-title">Rate Moves</div>
        <div className="dash-card-sub">Competitor rates that changed by 10% or more in the last 30 days, biggest first.</div>
      </div></div>
      <div className="req-table-wrapper">
        <table className="req-table stack-table">
          <thead><tr>
            <th>Competitor</th><th>Unit Size</th><th className="num">Old Rate</th><th className="num">New Rate</th>
            <th className="num">Change</th><th>Date Seen</th><th>Source</th>
          </tr></thead>
          <tbody>
            {moves.map((v) => (
              <tr key={`${v.competitorId}:${v.parking}:${v.width}x${v.depth}`}>
                <td style={{ fontWeight: 600 }}>{v.competitor}</td>
                <td data-th="Unit Size">{sizeLabel(v)}</td>
                <td data-th="Old Rate" className="num">{money(v.oldRate)}</td>
                <td data-th="New Rate" className="num"><strong>{money(v.newRate)}</strong></td>
                <td data-th="Change" className="num">
                  <span className={`status-badge ${v.percent < 0 ? 'pill-info' : 'status-pending'}`}>{v.percent > 0 ? '+' : ''}{v.percent}%</span>
                </td>
                <td data-th="Date Seen">{formatDate(v.date)}</td>
                <td data-th="Source"><SourceChip source={v.source} />{v.promo ? <span className="ops-delta"> - {v.promo}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const NEARBY_SHOWN = 8;

// Storage facilities around this one, from OpenStreetMap. Its own read, so a
// failure here leaves the rest of the tab standing.
function Nearby({ facilityId, onSaved }) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading', data: null });
    try {
      setState({ status: 'ready', data: await api.getOpsNearby(facilityId) });
    } catch (err) {
      console.error('Operations: could not load nearby facilities', err);
      setState({ status: 'error', data: null });
    }
  }, [facilityId]);
  useEffect(() => { load(); }, [load]);

  const add = async (n) => {
    setAdding(n.osmId);
    setError('');
    try {
      onSaved(await api.addOpsCompetitor({ facility_id: facilityId, name: n.name, address: n.address, website: n.website,
        distance_miles: n.distanceMiles, lat: n.lat, lng: n.lng, osm_id: n.osmId }));
      setState((s) => (s.data ? { ...s, data: { ...s.data, facilities: s.data.facilities.filter((x) => x.osmId !== n.osmId) } } : s));
    } catch (err) {
      console.error('Operations: could not add nearby facility', err);
      setError(`${n.name} could not be added. Try again.`);
    } finally { setAdding(''); }
  };

  const d = state.data;
  const list = d?.facilities || [];
  return (
    <div className="dash-card">
      <div className="dash-card-head"><div>
        <div className="dash-card-title">Nearby Storage Facilities</div>
        <div className="dash-card-sub">
          {d ? `Within ${d.radiusMiles} miles, nearest first. Add the ones a customer would price against.` : 'Storage facilities around this one, nearest first.'}
        </div>
      </div></div>
      {state.status === 'loading' && <LoadingState compact label="Looking for nearby facilities" />}
      {state.status === 'error' && (
        <div className="ops-empty" role="alert">
          The nearby list could not be loaded just now. Competitors can still be added by hand below.{' '}
          <button type="button" className="ops-cell" onClick={load}>Try Again</button>
        </div>
      )}
      {state.status === 'ready' && !list.length && (
        <div className="ops-empty">{d.detail || `No other storage facilities found within ${d.radiusMiles} miles.`}</div>
      )}
      {list.length > 0 && (
        <ul className="ops-reports">
          {(all ? list : list.slice(0, NEARBY_SHOWN)).map((n) => (
            <li className="ops-report" key={n.osmId}>
              <div>
                <div className="ops-report-title">{n.name}</div>
                <div className="ops-report-about">
                  {n.distanceMiles} miles away{n.address ? ` - ${n.address}` : ''}{n.website ? '' : ' - no website listed'}
                </div>
              </div>
              <button type="button" className="secondary-btn" onClick={() => add(n)} disabled={adding === n.osmId} aria-label={`Add ${n.name}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <Plus size={14} aria-hidden="true" /> Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > NEARBY_SHOWN && !all && (
        <button type="button" className="ops-cell" onClick={() => setAll(true)} style={{ marginTop: 8 }}>Show All {count(list.length)}</button>
      )}
      {error && <p className="ops-form-error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
      {state.status === 'ready' && <p className="ops-note" style={{ marginTop: 12 }}>{d.attribution || 'Nearby facilities from OpenStreetMap contributors'}</p>}
    </div>
  );
}

// One tracked competitor: what is on file, the page its rates are read from,
// how the last read went, and the controls for the daily reader.
function Competitor({ c, engine, onSaved, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(c.ratesUrl || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const latest = c.rates[0];
  const [cls, label] = CHECK_STATUS[c.lastStatus] || ['pill-muted', 'Not Checked Yet'];

  const run = async (what, call, failed) => {
    setBusy(what);
    setError('');
    try {
      onSaved(await call());
      return true;
    } catch (err) {
      console.error(`Operations: competitor ${what} failed`, err);
      setError(failed(err));
      return false;
    } finally { setBusy(''); }
  };
  const saveUrl = async (e) => {
    e.preventDefault();
    const next = url.trim();
    if (next && !/^https?:\/\/\S+\.\S+/i.test(next)) { setError('Enter a full web address, starting with https://'); return; }
    if (await run('save', () => api.updateOpsCompetitor(c.id, { rates_url: next }), () => 'The rates page could not be saved. Check the address and try again.')) setEditing(false);
  };
  const check = () => run('check', () => api.checkOpsCompetitor(c.id),
    (err) => (err?.status === 409 ? 'This competitor was checked in the last 10 minutes. Try again a little later.' : 'The rates page could not be checked just now. Try again in a minute.'));
  const watch = (e) => run('watch', () => api.updateOpsCompetitor(c.id, { watch: e.target.checked }), () => 'The change could not be saved. Try again.');
  const checkHint = !c.ratesUrl ? 'Set a rates page first' : !engine?.connected ? 'Reading rates is not connected on this server yet' : undefined;

  return (
    <li className="ops-report ops-comp">
      <div>
        <div className="ops-report-title">{c.name}</div>
        <div className="ops-report-about">
          {c.distanceMiles ? `${c.distanceMiles} miles away - ` : ''}{count(c.rates.length)} {c.rates.length === 1 ? 'rate' : 'rates'} on file
          {latest ? ` - last seen ${formatDate(latest.observedOn)}` : ''}
        </div>
        {latest?.rate ? (
          <div className="ops-comp-line">
            Latest: {sizeLabel(latest)} at {money(latest.rate)}{latest.promo ? ` (${latest.promo})` : ''} <SourceChip source={latest.source} />
          </div>
        ) : null}
        {editing ? (
          <form className="ops-comp-form" onSubmit={saveUrl}>
            <input className="form-input" type="url" value={url} maxLength={300} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..." aria-label={`Rates page for ${c.name}`} />
            <button type="submit" className="primary-btn" disabled={busy === 'save'}>Save</button>
            <button type="button" className="secondary-btn" onClick={() => { setEditing(false); setUrl(c.ratesUrl || ''); setError(''); }}>Cancel</button>
          </form>
        ) : (
          <div className="ops-comp-line">
            {c.ratesUrl
              ? <>Rates page: <a className="ops-link" href={c.ratesUrl} target="_blank" rel="noreferrer noopener" style={{ whiteSpace: 'normal' }}>{c.ratesUrl.replace(/^https?:\/\//i, '')}</a></>
              : 'No rates page set, so this competitor is not read automatically.'}{' '}
            <button type="button" className="ops-cell" onClick={() => { setUrl(c.ratesUrl || ''); setEditing(true); }}>{c.ratesUrl ? 'Change' : 'Set Rates Page'}</button>
          </div>
        )}
        <div className="ops-comp-line">
          <span className={`status-badge ${cls}`}>{label}</span>
          {c.lastDetail ? ` ${c.lastDetail}.` : ''}{c.lastCheckedAt ? ` Checked ${formatDateTime(c.lastCheckedAt)}.` : ''}
        </div>
        {error && <p className="ops-form-error" role="alert" style={{ marginTop: 6 }}>{error}</p>}
      </div>
      <div className="ops-comp-actions">
        <label className="ops-watch" title="Read this competitor's rates page in the daily run">
          <input type="checkbox" checked={!!c.watch} disabled={busy === 'watch'} onChange={watch} /> Watch
        </label>
        <button type="button" className="secondary-btn" onClick={check} disabled={!!checkHint || busy === 'check'} title={checkHint}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} aria-hidden="true" /> {busy === 'check' ? 'Checking' : 'Check Now'}
        </button>
        <button type="button" className="secondary-btn" onClick={() => onRemove(c)} aria-label={`Stop tracking ${c.name}`} title="Stop tracking. Recorded rates are kept.">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
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
  const role = useRole();
  const canSync = role?.can?.('manager') ?? false;
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
  const hours = m.engine?.everyHours || 24;
  const every = hours === 24 ? 'once a day' : `every ${hours} hours`;
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

      <p className="ops-note">
        Rates come from the StorTrack feed through Cubby, from each competitor&apos;s own public pricing page, read {every} by an
        identified reader that follows the site&apos;s robots rules, and from anything staff record by hand; a site that blocks
        automated readers or loads prices with scripts has to be entered by hand. Every source counts the standard (regular)
        rate.{m.engine && !m.engine.connected ? ' The automatic reader is not connected on this server yet.' : ''}
      </p>

      <StorTrackStatus st={m.stortrack} canSync={canSync} facilityId={facilityId} onSaved={setData} />

      {m.moves?.length > 0 && <RateMoves moves={m.moves} />}

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
              <th>Position</th><th>Sources</th><th className="num">Suggested</th><th>Why</th>
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
                    <td data-th="Sources">{r.sources?.length ? r.sources.map((x) => <SourceChip key={x} source={x} />) : '-'}</td>
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

      <Nearby key={facilityId} facilityId={facilityId} onSaved={setData} />

      <div className="ops-grid-2">
        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Competitors</div>
            <div className="dash-card-sub">Facilities a customer would price against {m.facility}</div>
          </div></div>
          {m.competitors.length ? (
            <ul className="ops-reports">
              {m.competitors.map((c) => <Competitor key={c.id} c={c} engine={m.engine} onSaved={setData} onRemove={remove} />)}
            </ul>
          ) : <div className="ops-empty">No competitors yet. Add the two or three facilities nearest {m.facility}, from the nearby list or by hand.</div>}
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
