// Operations -> Rate Management (Neil / Miranda, Oct 20 2026): the CMA screen.
//
// Every unit type we rent (a Cubby pricing group), what it is Set at and Sells
// for, what the competitors charge, the rule's suggestion and a Proposed rate
// a person types. Proposals are saved as drafts (who and when) until a manager
// opens Review & Push and sends them to Cubby, one unit type at a time with a
// result per row. Nothing is ever pushed automatically.
//
// The numbers come from GET /facility-ops/rates, which runs the same
// ops_market.compare the old Market Rates table used, against the Sell rate.
// The competitor set and manual entry are the existing Market screen, opened
// from "Comp Set & Manual Entry".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, History, RefreshCw, Send, Users } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { Modal } from '../tasks/components';
import { formatDate, formatDateTime } from '../lib/datetime';
import { count, money } from './model';
import Market from './Market';

const CATS = ['Self-Storage', 'Vehicle Storage'];
const TABS = [['all', 'All Unit Types'], ['Self-Storage', 'Self-Storage'], ['Vehicle Storage', 'Vehicle Storage']];
const dash = '-';
const $ = (c) => (c == null ? dash : money(c, { exact: c % 100 !== 0 }));
const signed = (c) => (c == null ? dash : `${c > 0 ? '+' : c < 0 ? '-' : ''}${money(Math.abs(c), { exact: Math.abs(c) % 100 !== 0 })}`);
const pctText = (x, digits = 1) => (x == null ? dash : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
const toCents = (s) => {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const toInput = (c) => (c == null ? '' : String(c / 100));

const GREEN = '#14532d';
const th = { textAlign: 'right', whiteSpace: 'nowrap' };

function Kpi({ label, value, sub, tone }) {
  const warn = tone === 'warn';
  return (
    <div className="kpi-card" style={warn ? { background: 'rgba(251, 146, 60, 0.10)', borderColor: 'rgba(251, 146, 60, 0.45)' } : undefined}>
      <div className="kpi-label">{label}</div>
      {value != null && <div className="kpi-value">{value}</div>}
      {sub && <div className="kpi-delta">{sub}</div>}
    </div>
  );
}

// The Proposed cell: typed freely, saved as a draft when the field is left.
function ProposedInput({ row, disabled, onSave }) {
  const initial = toInput(row.proposed);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(initial); }, [initial]);
  const commit = async () => {
    const cents = value.trim() === '' ? null : toCents(value);
    if (value.trim() !== '' && cents == null) { setValue(initial); return; }
    if (cents === row.proposed) return;
    setBusy(true);
    try { await onSave(row, cents); } finally { setBusy(false); }
  };
  return (
    <input className="form-input" inputMode="decimal" aria-label={`Proposed rate for ${row.name}`} value={value}
      placeholder={row.sell ? String(row.sell / 100) : ''} disabled={disabled || busy || !row.total}
      onChange={(e) => setValue(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      style={{ width: 92, textAlign: 'right', padding: '6px 8px', fontWeight: row.ready ? 700 : 400,
        borderColor: row.ready ? GREEN : undefined }} />
  );
}

function Row({ r, canEdit, onSave, onHistory }) {
  const off = r.total > 0 && r.offline === r.total;
  return (
    <tr>
      <td style={{ fontWeight: 600 }}>
        <button type="button" className="ops-cell" onClick={() => onHistory(r.name)} title="Rate history for this unit type" style={{ fontWeight: 600 }}>{r.name}</button>
        {r.valuePricing === 'APPROVED' && <div className="ops-delta">Tier pricing on in Cubby</div>}
      </td>
      <td data-th="Total" className="num">{count(r.total)}</td>
      <td data-th="Vacant" className="num">{count(r.vacant)}</td>
      <td data-th="Offline" className="num">{count(r.offline)}</td>
      <td data-th="Occ." className="num">{r.total ? `${(r.occupancy * 100).toFixed(r.occupancy * 1000 % 10 ? 1 : 0)}%` : dash}</td>
      <td data-th="Set" className="num">{$(r.set)}</td>
      <td data-th="Sell" className="num"><strong>{$(r.sell)}</strong></td>
      <td data-th="Walk-In" className="num">{off ? dash : $(r.walkIn)}</td>
      <td data-th="Mkt Low" className="num" title={r.lowestBy ? `Lowest: ${r.lowestBy}` : undefined}>{$(r.marketLow)}</td>
      <td data-th="Mkt High" className="num">{$(r.marketHigh)}</td>
      <td data-th="Mkt Median" className="num">{$(r.marketMedian)}</td>
      <td data-th="Variance" className="num" style={{ whiteSpace: 'nowrap', fontWeight: 600, color: r.variance < 0 ? '#1d4ed8' : r.variance > 0 ? '#b45309' : undefined }}>
        {r.variance == null ? dash : `${signed(r.variance)} - ${pctText(r.variancePct)}`}
      </td>
      <td data-th="Comps" className="num">
        {r.competitors === 1
          ? <span className="status-badge status-pending" title="Only one competitor rate for this size">1</span>
          : count(r.competitors)}
      </td>
      <td data-th="Suggested" style={{ minWidth: 200 }}>
        {off ? <span className="ops-why">All units offline - nothing to price</span> : (
          <>
            {r.suggested != null && (
              <button type="button" className="ops-cell" disabled={!canEdit} title={canEdit ? 'Use as the proposed rate' : undefined}
                onClick={() => onSave(r, r.suggested)} style={{ fontWeight: 700 }}>{$(r.suggested)}</button>
            )}
            <div className="ops-why">{r.why}</div>
          </>
        )}
      </td>
      <td data-th="Proposed" className="num">
        <ProposedInput row={r} disabled={!canEdit} onSave={onSave} />
        {r.draft && <div className="ops-delta" title={`Proposed by ${r.draft.updatedBy}`}>{formatDate(r.draft.updatedAt)}</div>}
      </td>
      <td data-th="Rev. Change / Mo" className="num" style={{ fontWeight: 600, color: r.revDelta > 0 ? GREEN : r.revDelta < 0 ? '#b91c1c' : undefined }}>
        {signed(r.revDelta)}
      </td>
    </tr>
  );
}

function Subtotal({ label, rows }) {
  const total = rows.reduce((a, r) => a + r.total, 0);
  const rented = rows.reduce((a, r) => a + r.rented, 0);
  return (
    <tr style={{ background: 'var(--bg-secondary, #f8fafc)', fontWeight: 700 }}>
      <td>Subtotal {label}</td>
      <td className="num">{count(total)}</td>
      <td className="num">{count(rows.reduce((a, r) => a + r.vacant, 0))}</td>
      <td className="num">{count(rows.reduce((a, r) => a + r.offline, 0))}</td>
      <td className="num">{total ? `${Math.round((rented / total) * 100)}%` : dash}</td>
      <td colSpan={10} />
      <td className="num">{signed(rows.reduce((a, r) => a + r.revDelta, 0))}</td>
    </tr>
  );
}

// Review & Push: old -> new for every change, ticked by default; the result
// of each row once pushed. "Export Checklist" is the same list as a PDF for
// anyone applying it in Cubby by hand.
export function ReviewModal({ view, onClose, onPushed, onChecklist }) {
  // What was reviewed stays on screen with its results after the push refreshes the table.
  const [ready] = useState(() => view.rows.filter((r) => r.ready));
  const [picked, setPicked] = useState(() => new Set(ready.map((r) => r.name)));
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const chosen = ready.filter((r) => picked.has(r.name));
  const total = chosen.reduce((a, r) => a + r.revDelta, 0);
  const toggle = (name) => setPicked((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const push = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await api.pushOpsRates(view.facilityId, chosen.map((r) => r.name));
      setResults(out.results);
      onPushed(out.view);
    } catch (err) {
      console.error('Operations: rate push failed', err);
      setError(err?.status === 503 ? 'Cubby is not connected on this server, so rates cannot be pushed.'
        : err?.status === 424 ? "Cubby's pricing groups could not be read just now, so nothing was pushed. Try again in a minute."
          : 'The push could not be started. Nothing was changed. Try again.');
    } finally { setBusy(false); }
  };
  const byName = Object.fromEntries((results || []).map((x) => [x.unitType, x]));
  const footer = results ? (
    <button type="button" className="primary-btn" onClick={onClose}>Done</button>
  ) : (
    <>
      <button type="button" className="secondary-btn" onClick={() => onChecklist(chosen)} disabled={!chosen.length}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={14} aria-hidden="true" /> Export Checklist</button>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      {view.canPush && view.pushConnected !== false && (
        <button type="button" className="primary-btn" onClick={push} disabled={busy || !chosen.length}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Send size={14} aria-hidden="true" /> {busy ? 'Pushing' : `Push ${chosen.length} to Cubby`}
        </button>
      )}
    </>
  );
  return (
    <Modal title={`Review & Push to Cubby - ${view.facility}`} onClose={onClose} width="60vw" minHeight="60vh" footer={footer}>
      <p className="ops-note" style={{ marginTop: 0 }}>
        Each unit type is sent to Cubby on its own, so every row gets its own result. The Sell rate is Cubby&apos;s web rate;
        the Set rate (standard) moves by the same amount unless one was typed.
        {!view.canPush ? ' Only managers and above can push. Export the checklist to hand it on.'
          : view.pushConnected === false ? ' Pushing needs a Manager-role Cubby key on this server. Until then, export the checklist and enter the rates in Cubby.' : ''}
      </p>
      {ready.length === 0 ? <div className="ops-empty">No changes are ready. Enter a Proposed rate in the table first.</div> : (
        <div className="req-table-wrapper">
          <table className="req-table stack-table" data-testid="review-table">
            <thead><tr>
              {!results && <th aria-label="Include" />}
              <th>Unit Type</th><th style={th}>Sell</th><th style={th}>Set</th><th style={th}>Vacant</th><th style={th}>Rev. Change / Mo</th>
              {results && <th>Result</th>}
            </tr></thead>
            <tbody>
              {ready.map((r) => {
                const res = byName[r.name];
                return (
                  <tr key={r.name}>
                    {!results && (
                      <td><input type="checkbox" checked={picked.has(r.name)} onChange={() => toggle(r.name)} aria-label={`Include ${r.name}`} /></td>
                    )}
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td data-th="Sell" className="num">{$(r.sell)} &rarr; <strong>{$(r.proposed)}</strong></td>
                    <td data-th="Set" className="num">{$(r.set)} &rarr; {$(r.proposedSet)}</td>
                    <td data-th="Vacant" className="num">{count(r.vacant)}</td>
                    <td data-th="Rev. Change / Mo" className="num">{signed(r.revDelta)}</td>
                    {results && (
                      <td data-th="Result">
                        {res ? <span className={`status-badge ${res.status === 'ok' ? 'status-approved' : res.status === 'failed' ? 'status-rejected' : 'pill-muted'}`}>
                          {res.status === 'ok' ? 'Pushed' : res.status === 'failed' ? 'Failed' : 'Skipped'}
                        </span> : <span className="pill-muted status-badge">Not Sent</span>}
                        {res && res.status !== 'ok' && <div className="ops-why">{res.detail}</div>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!results && chosen.length > 0 && (
        <p style={{ fontWeight: 600, marginTop: 12 }}>{chosen.length} {chosen.length === 1 ? 'change' : 'changes'}, {signed(total)} per month on vacant units at the new rate.</p>
      )}
      {error && <p className="ops-form-error" role="alert">{error}</p>}
    </Modal>
  );
}

function HistoryModal({ view, initial, onClose }) {
  const [unitType, setUnitType] = useState(initial || view.rows[0]?.name || '');
  const [state, setState] = useState({ status: 'loading', data: null });
  useEffect(() => {
    let live = true;
    if (!unitType) return undefined;
    setState({ status: 'loading', data: null });
    api.getOpsRateHistory(view.facilityId, unitType)
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch((err) => { console.error('Operations: rate history failed', err); if (live) setState({ status: 'error', data: null }); });
    return () => { live = false; };
  }, [view.facilityId, unitType]);
  const d = state.data;
  return (
    <Modal title="Rate History" onClose={onClose} width="60vw" minHeight="60vh">
      <label className="ops-period" style={{ marginBottom: 12 }}>
        <span>Unit Type</span>
        <select value={unitType} onChange={(e) => setUnitType(e.target.value)} aria-label="Unit Type">
          {view.rows.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
        </select>
      </label>
      {state.status === 'loading' && <LoadingState compact label="Loading rate history" />}
      {state.status === 'error' && <div className="ops-empty" role="alert">The rate history could not be loaded. Try again.</div>}
      {d && (
        <>
          <h4 style={{ margin: '8px 0' }}>Our Rate Changes</h4>
          {d.ours.length ? (
            <table className="req-table stack-table"><thead><tr>
              <th>Date</th><th style={th}>Sell</th><th style={th}>Set</th><th>By</th><th>Result</th>
            </tr></thead><tbody>
              {d.ours.map((p) => (
                <tr key={p.id}>
                  <td>{formatDateTime(p.pushedAt)}</td>
                  <td data-th="Sell" className="num">{$(p.oldSell)} &rarr; {$(p.newSell)}</td>
                  <td data-th="Set" className="num">{$(p.oldSet)} &rarr; {$(p.newSet)}</td>
                  <td data-th="By">{p.pushedBy}</td>
                  <td data-th="Result">{p.status === 'ok' ? 'Pushed' : p.status === 'failed' ? `Failed: ${p.detail}` : `Skipped: ${p.detail}`}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="ops-empty">No rate changes pushed from Nexus yet.</div>}
          <h4 style={{ margin: '16px 0 8px' }}>Competitor Rates for This Size</h4>
          {d.competitors.length ? (
            <table className="req-table stack-table"><thead><tr>
              <th>Date Seen</th><th>Competitor</th><th style={th}>Rate</th><th>Source</th>
            </tr></thead><tbody>
              {d.competitors.map((c, i) => (
                <tr key={`${c.competitorId}:${c.observedOn}:${i}`}>
                  <td>{formatDate(c.observedOn)}</td><td data-th="Competitor">{c.competitor}</td>
                  <td data-th="Rate" className="num">{$(c.rate)}</td>
                  <td data-th="Source">{c.source === 'stortrack' ? 'StorTrack' : c.source === 'web' ? 'Website' : 'Manual'}{c.promo ? ` - ${c.promo}` : ''}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="ops-empty">No competitor rates recorded for this size.</div>}
        </>
      )}
    </Modal>
  );
}

const PDF_COLUMNS = [
  { header: 'Unit Type', get: (r) => r.name, width: 22 },
  { header: 'Category', get: (r) => r.category, width: 14 },
  { header: 'Total', get: (r) => r.total, width: 7 },
  { header: 'Vacant', get: (r) => r.vacant, width: 7 },
  { header: 'Offline', get: (r) => r.offline, width: 7 },
  { header: 'Occ.', get: (r) => (r.total ? `${Math.round(r.occupancy * 100)}%` : dash), width: 7 },
  { header: 'Set', get: (r) => $(r.set), width: 9 },
  { header: 'Sell', get: (r) => $(r.sell), width: 9 },
  { header: 'Mkt Low', get: (r) => $(r.marketLow), width: 9 },
  { header: 'Mkt High', get: (r) => $(r.marketHigh), width: 9 },
  { header: 'Mkt Median', get: (r) => $(r.marketMedian), width: 10 },
  { header: 'Variance', get: (r) => (r.variance == null ? dash : `${signed(r.variance)} (${pctText(r.variancePct)})`), width: 14 },
  { header: 'Comps', get: (r) => r.competitors, width: 7 },
  { header: 'Suggested', get: (r) => $(r.suggested), width: 10 },
  { header: 'Proposed', get: (r) => $(r.proposed), width: 10 },
  { header: 'Rev. Change / Mo', get: (r) => signed(r.revDelta), width: 12 },
];

const CHECKLIST_COLUMNS = [
  { header: 'Done', get: () => '[  ]', width: 6 },
  { header: 'Unit Type (Cubby Pricing Group)', get: (r) => r.name, width: 28 },
  { header: 'Web Rate Now', get: (r) => $(r.sell), width: 12 },
  { header: 'New Web Rate', get: (r) => $(r.proposed), width: 12 },
  { header: 'Standard Rate Now', get: (r) => $(r.set), width: 14 },
  { header: 'New Standard Rate', get: (r) => $(r.proposedSet), width: 14 },
  { header: 'Proposed By', get: (r) => r.draft?.updatedBy || '', width: 22 },
];

export default function RateManagement({ facility, facilities, onPick }) {
  const facilityId = facility?.id;
  const [state, setState] = useState({ status: 'loading', data: null });
  const [tab, setTab] = useState('all');
  const [panel, setPanel] = useState(null);       // 'review' | { history: name }
  const [showComps, setShowComps] = useState(false);
  const [refreshing, setRefreshing] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!facilityId) return;
    setState((s) => (s.data?.facilityId === facilityId ? s : { status: 'loading', data: null }));
    try {
      setState({ status: 'ready', data: await api.getOpsRates(facilityId) });
    } catch (err) {
      console.error('Operations: could not load rate management', err);
      setState({ status: 'error', data: null });
    }
  }, [facilityId]);
  useEffect(() => { load(); }, [load]);

  const v = state.data;
  const setView = (data) => setState({ status: 'ready', data });
  const shown = useMemo(() => (v ? v.rows.filter((r) => tab === 'all' || r.category === tab) : []), [v, tab]);

  const saveDraft = async (row, cents) => {
    setError('');
    try {
      setView(await api.saveOpsRateDraft({ facility_id: facilityId, unit_type: row.name, proposed: cents == null ? null : cents / 100 }));
    } catch (err) {
      console.error('Operations: could not save proposed rate', err);
      setError(`The proposed rate for ${row.name} could not be saved. Try again.`);
    }
  };

  const refreshWebsites = async () => {
    const list = (v?.competitors || []).filter((c) => c.ratesUrl && c.watch);
    if (!list.length) { setRefreshing('No competitor has a rates page to read. Set one under Comp Set & Manual Entry.'); return; }
    setRefreshing('Reading competitor websites');
    let read = 0;
    for (const c of list) {
      try { await api.checkOpsCompetitor(c.id); read += 1; } catch (err) {
        if (err?.status !== 409) console.error('Operations: website check failed', err);
      }
    }
    setRefreshing(`${read} of ${list.length} competitor websites read${read < list.length ? ' (the rest were read in the last 10 minutes or could not be read)' : ''}.`);
    load();
  };

  const exportPdf = async (rows, checklist = false) => {
    const { exportPdf: pdf } = await import('../tasks/exporting');
    await pdf({
      title: checklist ? `Cubby Rate Checklist - ${v.name}` : `Rate Management - ${v.name}`,
      subtitle: checklist
        ? `Apply in Cubby > Pricing Groups. Prepared ${formatDate(v.asOf)}.`
        : `Competitive market analysis as of ${formatDate(v.asOf)}${v.lastSurvey ? `, last survey ${formatDate(v.lastSurvey)}` : ''}. Sell = Cubby web rate; market = competitors' newest rates.`,
      columns: checklist ? CHECKLIST_COLUMNS : PDF_COLUMNS,
      rows,
      filename: `${checklist ? 'cubby-rate-checklist' : 'rate-management'}-${(v.facility || 'facility').toLowerCase().replace(/\s+/g, '-')}-${v.asOf}.pdf`,
    });
  };

  const picker = (
    <label className="ops-period" style={{ marginBottom: 12 }}>
      <span>Facility</span>
      <select value={facilityId || ''} aria-label="Facility" onChange={(e) => onPick(e.target.value || 'all')}>
        {!facilityId && <option value="">Choose a Facility</option>}
        {facilities.map((f) => <option key={f.id} value={f.id}>{f.shortName}</option>)}
      </select>
    </label>
  );

  if (!facility) {
    return (
      <div className="dash-card">
        {picker}
        <div className="dash-card-title">Choose a Facility</div>
        <div className="dash-card-sub">Rates are set against the competitors around one facility at a time.</div>
      </div>
    );
  }
  if (state.status === 'loading') return <>{picker}<LoadingState size="section" label="Loading rate management" minHeight={240} /></>;
  if (state.status === 'error') return <>{picker}<ErrorBanner message="Couldn't load rate management." onRetry={load} /></>;

  const k = v.kpis;
  const cs = v.compSet;
  const ready = v.rows.filter((r) => r.ready);
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6 };

  return (
    <>
      {picker}
      <div className="dash-card">
        <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-secondary, #64748b)', fontWeight: 600 }}>
          Competitive Market Analysis - Confidential
        </div>
        <h2 style={{ margin: '4px 0' }}>{v.name}</h2>
        <div className="dash-card-sub" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
          {v.address && <span>{v.address}</span>}
          <span>Last survey {v.lastSurvey ? formatDate(v.lastSurvey) : 'none yet'}</span>
          <span>Unit counts &amp; our rates live from Cubby</span>
          {v.billingCycle === 'DAYS_28' && <span>Cubby rates here are per 28 days</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type="button" className="secondary-btn" style={btn} onClick={() => setPanel({ history: '' })}><History size={14} aria-hidden="true" /> Rate History</button>
          <button type="button" className="secondary-btn" style={btn} aria-pressed={showComps} onClick={() => setShowComps((x) => !x)}><Users size={14} aria-hidden="true" /> Comp Set &amp; Manual Entry</button>
          <button type="button" className="secondary-btn" style={btn} onClick={refreshWebsites} disabled={refreshing === 'Reading competitor websites'}><RefreshCw size={14} aria-hidden="true" /> Refresh Websites</button>
          <button type="button" className="primary-btn" style={btn} onClick={() => exportPdf(v.rows)}><Download size={14} aria-hidden="true" /> Export PDF</button>
        </div>
        {refreshing && <p className="ops-note" role="status" style={{ marginTop: 8 }}>{refreshing}</p>}
      </div>

      <div className="kpi-grid">
        <Kpi label="Competitive Set" value={`${count(cs.active)} active`}
          sub={`${cs.web} website-synced - ${cs.stortrack} StorTrack - ${cs.manual} manual - ${cs.closed} closed (excluded)`} />
        <Kpi label="Sell Rate vs Market" value={pctText(k.vsMarket)} sub={`${k.belowMarket} of ${k.rateable} rateable unit types below market`} />
        <Kpi label="Occupancy (Cubby)" value={k.units ? `${((k.rented / k.units) * 100).toFixed(1)}%` : dash}
          sub={`${count(k.rented)} occupied of ${count(k.units)} units - ${count(k.offline)} offline`} />
        <Kpi label="Needs Attention" tone={v.attention.length ? 'warn' : undefined}
          sub={v.attention.length ? v.attention.join(' - ') : 'Nothing stands out.'} />
      </div>

      <div style={{ background: GREEN, color: '#fff', borderRadius: 12, padding: '14px 18px', margin: '0 0 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }} data-testid="ready-bar">
        <div>
          <div style={{ fontWeight: 700 }}>{ready.length} {ready.length === 1 ? 'change' : 'changes'} ready for Cubby</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            {ready.length ? `${ready.map((r) => `${r.name} ${signed(r.proposed - r.sell)}`).slice(0, 3).join(' - ')}${ready.length > 3 ? ' ...' : ''} - ${signed(k.readyDelta)} per month` : 'Edit Proposed below to add one.'}
          </div>
        </div>
        <button type="button" onClick={() => setPanel('review')} disabled={!ready.length}
          style={{ background: '#bbf7d0', color: GREEN, border: 'none', borderRadius: 8, padding: '8px 14px', fontWeight: 700, cursor: ready.length ? 'pointer' : 'default', opacity: ready.length ? 1 : 0.6 }}>
          Review &amp; Push to Cubby
        </button>
      </div>

      {!v.cubbyGroups.ok && (
        <p className="ops-note" role="status">Cubby&apos;s pricing groups could not be read, so Sell and Set show the rent roll&apos;s standard rate and nothing can be pushed right now.</p>
      )}
      {error && <p className="ops-form-error" role="alert">{error}</p>}

      <div className="dash-card">
        <div className="dash-card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="scroll-tabs ops-pills" role="tablist" aria-label="Unit Category">
            {TABS.map(([key, label]) => (
              <button type="button" role="tab" key={key} className="ops-pill" aria-selected={tab === key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <div className="dash-card-sub">Variance = our Sell rate vs the market median. Click a unit type to see its rate history.</div>
        </div>
        <div className="req-table-wrapper">
          <table className="req-table stack-table" data-testid="rate-table">
            <thead><tr>
              <th>Unit Type</th><th style={th}>Total</th><th style={th}>Vacant</th><th style={th}>Offline</th><th style={th}>Occ.</th>
              <th style={th}>Set</th><th style={th}>Sell</th><th style={th} title="Cubby walk-in rate">Walk-In</th>
              <th style={th}>Mkt Low</th><th style={th}>Mkt High</th><th style={th}>Mkt Median</th><th style={th}>Variance</th>
              <th style={th}>Comps</th><th>Suggested</th><th style={th}>Proposed</th><th style={th}>Rev. Change / Mo</th>
            </tr></thead>
            <tbody>
              {CATS.filter((c) => tab === 'all' || tab === c).map((c) => {
                const rows = shown.filter((r) => r.category === c);
                if (!rows.length) return null;
                return [
                  <tr key={`h-${c}`}><td colSpan={16} style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 12, color: GREEN, background: 'rgba(20, 83, 45, 0.08)' }}>{c}</td></tr>,
                  ...rows.map((r) => <Row key={r.name} r={r} canEdit={v.canEdit} onSave={saveDraft} onHistory={(name) => setPanel({ history: name })} />),
                  <Subtotal key={`s-${c}`} label={c} rows={rows} />,
                ];
              })}
            </tbody>
          </table>
        </div>
        {!shown.length && <div className="ops-empty">No unit types in this category.</div>}
        <p className="ops-note" style={{ marginTop: 10 }}>
          Market is each competitor&apos;s newest rate from the last {v.freshDays} days. Suggested = the market median, moved by how full we are,
          held to a 10% step from today&apos;s Sell rate; it needs {v.minCompetitors} competitor rates. Rev. Change / Mo = (Proposed - Sell) x vacant units.
        </p>
      </div>

      {v.pushes?.length > 0 && (
        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Recent Pushes to Cubby</div>
            <div className="dash-card-sub">Every rate change sent from Nexus, failed tries included.</div>
          </div></div>
          <ul className="ops-reports">
            {v.pushes.slice(0, 8).map((p) => (
              <li className="ops-report" key={p.id}>
                <div>
                  <div className="ops-report-title">{p.unitType}: {$(p.oldSell)} &rarr; {$(p.newSell)}</div>
                  <div className="ops-report-about">{formatDateTime(p.pushedAt)} by {p.pushedBy}{p.status !== 'ok' ? ` - ${p.detail}` : ''}</div>
                </div>
                <span className={`status-badge ${p.status === 'ok' ? 'status-approved' : p.status === 'failed' ? 'status-rejected' : 'pill-muted'}`}>
                  {p.status === 'ok' ? 'Pushed' : p.status === 'failed' ? 'Failed' : 'Skipped'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showComps && <Market facility={facility} facilities={facilities} onPick={onPick} />}

      {panel === 'review' && (
        <ReviewModal view={v} onClose={() => setPanel(null)} onPushed={setView} onChecklist={(rows) => exportPdf(rows, true)} />
      )}
      {panel?.history !== undefined && <HistoryModal view={v} initial={panel.history} onClose={() => setPanel(null)} />}
    </>
  );
}
