// CMA Overview (Miranda's mockup, artboard 1): where each unit type sits
// against the market, the suggestion, and a Proposed rate typed right in the
// table. Clicking a unit type opens its competitors below the table, where
// "Add Manual Rate" records a rate for THAT pricing group in place (Miranda,
// Oct 21: "we should have the ability to add data by hand as we're looking at
// the pricing group").
//
// Words are Cubby's (Miranda): "Current Standard Rate" (standardRate), "Web
// Rate" (webRate - what we sell at; Miranda's rate algorithm fills it in once
// it is connected, ops_cma.algorithm_web_rate), "Walk-In Rate".
import { Fragment, useMemo, useState } from 'react';
import { Download, History, Plus, RefreshCw, Send, Users } from 'lucide-react';
import { api } from '../../api';
import { formatDate } from '../../lib/datetime';
import { count } from '../model';
import ManualRateModal from './ManualRateModal';
import {
  COMP_COLUMNS, OVERVIEW_COLUMNS, compRows, dash, exportRows, feeRange, occText, pctText, signedUsd, sizeLine, sizeOf,
  sourceLabel, toCents, usd, varianceText,
} from './cmaModel';

const CATS = ['Self-Storage', 'Vehicle Storage'];
const FILTERS = [['all', 'All Unit Types'], ['Self-Storage', 'Self-Storage'], ['Vehicle Storage', 'Vehicle Storage']];
const COLS = 19;

const TIPS = {
  total: 'Units of this type in Cubby, offline ones included.',
  vacant: 'Unleased and rentable.',
  offline: 'Not rentable in Cubby (damaged, held, reserved).',
  occ: 'Occupied / total units.',
  days: "Average days this pricing group's vacant units have been unrented, from each unit's last move-out in Cubby. Units never rented in Cubby are left out.",
  standard: "Cubby's standard (in-store) rate for the pricing group.",
  web: "Cubby's web rate - what a new customer pays online, and the rate compared with the market. Our rate algorithm will fill this in once it is connected.",
  walkIn: "Cubby's walk-in rate.",
  low: 'Lowest competitor rate for this size (closed competitors left out).',
  high: 'Highest competitor rate for this size (closed competitors left out).',
  avg: 'Average of the same competitors, never including us.',
  variance: 'Our Web Rate - market average, in dollars and percent of the average.',
  comps: 'Competitors with a rate for this size in the last 120 days.',
  promo: 'Competitors running a promotion for this size right now.',
  fee: "Competitors' admin fees from their latest survey.",
  suggested: 'Raise halfway to the average when 80%+ occupied and more than 2% below it; lower halfway toward it when under 50% occupied and more than 5% above it; otherwise hold. Holds when fewer than 2 comps. Rates ending in .50 keep the .50.',
  proposed: 'The new Web Rate to send to Cubby. Saved as a draft when you leave the field.',
  delta: '(Proposed - current Web Rate) x occupied units, per month.',
};

function Th({ label, tip, num }) {
  return <th className={num ? 'num' : undefined} title={tip}>{label}</th>;
}

function Kpi({ label, value, sub, tone, children }) {
  return (
    <div className={`cma-kpi${tone ? ` cma-kpi-${tone}` : ''}`}>
      <div className="cma-kpi-label">{label}</div>
      {value != null && <div className="cma-kpi-value">{value}</div>}
      {sub && <div className="cma-kpi-sub">{sub}</div>}
      {children}
    </div>
  );
}

function ProposedInput({ row, disabled, onSave }) {
  const initial = row.proposed == null ? '' : String(row.proposed / 100);
  const [value, setValue] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (seen !== initial) { setSeen(initial); setValue(initial); }
  const commit = async () => {
    const cents = value.trim() === '' ? null : toCents(value);
    if (value.trim() !== '' && cents == null) { setValue(initial); return; }
    if (cents === row.proposed) return;
    setBusy(true);
    try { await onSave(row, cents); } finally { setBusy(false); }
  };
  return (
    <input className="form-input cma-proposed" inputMode="decimal" aria-label={`Proposed rate for ${row.name}`} value={value}
      placeholder={row.suggested != null ? String(row.suggested / 100) : ''} disabled={disabled || busy || !row.total || row.offlineOnly}
      onChange={(e) => setValue(e.target.value)} onBlur={commit} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      style={{ fontWeight: row.ready ? 700 : 400 }} />
  );
}

function Row({ r, on, onPick, canEdit, onSave }) {
  const web = r.algorithmWebRate ?? r.sell;
  return (
    <tr className={`cma-row${on ? ' cma-row-on' : ''}`} onClick={() => onPick(r.name)} aria-selected={on}>
      <td>
        <button type="button" className="rm-linkbtn cma-type" onClick={(e) => { e.stopPropagation(); onPick(r.name); }}
          aria-label={`Show competitors for ${r.name}`}>{sizeOf(r)}</button>
        <div className="cma-type-sub">{sizeLine(r)}</div>
        {r.nearestSize && <div className="cma-type-sub">Nearest size: {r.nearestSize}</div>}
      </td>
      <td className="num" data-th="Total">{count(r.total)}</td>
      <td className="num" data-th="Vacant">{count(r.vacant)}</td>
      <td className="num" data-th="Offline">{count(r.offline)}</td>
      <td className="num" data-th="Occ.">{occText(r)}</td>
      <td className="num" data-th="Avg Days Vacant" title={r.vacant && r.avgDaysVacant == null ? 'No move-out on file for these units' : undefined}>
        {r.avgDaysVacant == null ? dash : count(r.avgDaysVacant)}
      </td>
      <td className="num" data-th="Current Standard Rate">{usd(r.set)}</td>
      <td className="num" data-th="Web Rate">
        <strong>{usd(web)}</strong>
        <div className="cma-type-sub">{r.algorithmWebRate != null ? 'Rate algorithm' : r.webRate == null ? 'No web rate - standard' : 'From Cubby'}</div>
      </td>
      <td className="num" data-th="Walk-In Rate">{usd(r.walkIn)}</td>
      <td className="num" data-th="Mkt Low">{usd(r.marketLow)}</td>
      <td className="num" data-th="Mkt High">{usd(r.marketHigh)}</td>
      <td className="num" data-th="Mkt Avg">{usd(r.marketAvg)}</td>
      <td className={`num${r.variance < 0 ? ' cma-below' : ''}`} data-th="Variance" style={{ whiteSpace: 'nowrap' }}>{varianceText(r)}</td>
      <td className="num" data-th="Comps">{r.competitors === 1 ? <span className="cma-one">1</span> : r.competitors}</td>
      <td data-th="Comp Promotions" title={(r.promoBy || []).join(', ')}>
        {r.promoCount ? <>Yes ({r.promoCount})<div className="cma-type-sub">{(r.promoBy || []).slice(0, 2).join(', ')}{r.promoBy.length > 2 ? '...' : ''}</div></> : r.competitors ? 'No' : dash}
      </td>
      <td className="num" data-th="Comp Admin Fee">{feeRange(r)}</td>
      <td data-th="Suggested">
        {r.suggested == null ? dash : (
          <button type="button" className="rm-linkbtn" disabled={!canEdit} onClick={(e) => { e.stopPropagation(); onSave(r, r.suggested); }}
            title={canEdit ? `Use ${usd(r.suggested)} as the proposed rate` : undefined} style={{ fontWeight: 700, color: 'var(--ink)' }}>
            {usd(r.suggested)}
          </button>
        )}
        <div className="cma-why">{r.why}</div>
      </td>
      <td data-th="Proposed"><ProposedInput row={r} disabled={!canEdit} onSave={onSave} /></td>
      <td className={`num${r.revDelta > 0 ? ' cma-up' : r.revDelta < 0 ? ' cma-under' : ''}`} data-th="Rev. Change / Mo">
        {r.proposed == null ? '$0' : signedUsd(r.revDelta)}
      </td>
    </tr>
  );
}

function Subtotal({ label, rows }) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const total = sum('total');
  return (
    <tr className="cma-subtotal">
      <td>Subtotal {label}</td>
      <td className="num" data-th="Total">{count(total)}</td>
      <td className="num" data-th="Vacant">{count(sum('vacant'))}</td>
      <td className="num" data-th="Offline">{count(sum('offline'))}</td>
      <td className="num" data-th="Occ.">{total ? `${((sum('rented') / total) * 100).toFixed(1)}%` : dash}</td>
      <td colSpan={COLS - 6} />
      <td className="num" data-th="Rev. Change / Mo">{signedUsd(rows.reduce((a, r) => a + (r.proposed == null ? 0 : r.revDelta), 0))}</td>
    </tr>
  );
}

// The selected unit type, competitor by competitor (mockup: under the table).
function CompetitorPanel({ r, canEdit, onAdd }) {
  const list = r.comps || [];
  return (
    <section className="cma-panel" aria-label={`${r.name} competitor rates`} data-testid="comp-panel">
      <div className="cma-panel-head">
        <div>
          <h3 className="cma-h3">{sizeOf(r)} {r.parking || r.category === 'Vehicle Storage' ? 'parking' : 'storage'} - competitor rates</h3>
          <div className="cma-sub">
            {r.nearestSize ? `No exact match; using competitors' ${r.nearestSize} spaces (nearest size)` : `Matched to competitors' ${sizeOf(r)} spaces`}
            {' '}- our Web Rate {usd(r.sell)}, market avg {usd(r.marketAvg)}
          </div>
        </div>
        {canEdit && (
          <button type="button" className="primary-btn cma-btn" onClick={onAdd}><Plus size={14} aria-hidden="true" /> Add Manual Rate</button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="ops-empty">No competitor rate for this size yet. Add one from a call or a drive-by with Add Manual Rate.</div>
      ) : (
        <div className="req-table-wrapper">
          <table className="req-table stack-table cma-table">
            <thead><tr>
              <th>Competitor</th><th className="num">Distance</th><th>Source</th><th className="num">Rate</th><th className="num">Vs Our Web Rate</th>
              <th>Current Special</th><th>Admin Fee / Insurance</th><th>Updated</th>
            </tr></thead>
            <tbody>
              {list.map((c) => {
                const vs = c.rate ? (r.sell - c.rate) / c.rate : null;
                return (
                  <tr key={c.competitorId}>
                    <td><strong>{c.competitor}</strong>{c.note ? <div className="cma-type-sub">{c.note}</div> : null}</td>
                    <td className="num" data-th="Distance">{c.distanceMiles == null ? dash : `${c.distanceMiles.toFixed(1)} mi`}</td>
                    <td data-th="Source">
                      <span className={`cma-badge cma-badge-${c.source === 'web' || c.source === 'stortrack' ? 'website' : 'manual'}`}>
                        {c.source === 'web' || c.source === 'stortrack' ? 'Website - Auto' : c.locked ? 'Manual - Locked' : 'Manual'}
                      </span>
                    </td>
                    <td className="num" data-th="Rate"><strong>{usd(c.rate)}</strong>{c.online ? <div className="cma-type-sub">Online {usd(c.online)}</div> : null}</td>
                    <td className="num" data-th="Vs Our Web Rate" style={{ color: vs == null ? undefined : vs > 0 ? 'var(--warn-fg)' : 'var(--info-fg)' }}>
                      {vs == null ? dash : `we are ${pctText(vs)}`}
                    </td>
                    <td data-th="Current Special">{c.promo || dash}</td>
                    <td data-th="Admin Fee / Insurance">
                      {c.adminFee == null && !c.insurance ? <span className="rm-muted">Not captured yet</span>
                        : <>{c.adminFee == null ? '' : `${usd(c.adminFee)} fee`}{c.adminFee != null && c.insurance ? ' / ' : ''}{c.insurance}</>}
                    </td>
                    <td data-th="Updated" style={{ whiteSpace: 'nowrap' }}>{formatDate(c.observedOn)} <span className="rm-muted">{sourceLabel(c.source)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function CmaOverview({ view: v, facility, onView, onSection, onReload }) {
  const [filter, setFilter] = useState('all');
  const [picked, setPicked] = useState('');
  const [adding, setAdding] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const shown = useMemo(() => v.rows.filter((r) => filter === 'all' || r.category === filter), [v, filter]);
  const sel = v.rows.find((r) => r.name === picked) || v.rows.find((r) => r.ready) || v.rows.find((r) => r.competitors) || v.rows[0];
  const k = v.kpis;
  const cs = v.compSet;
  const ready = v.rows.filter((r) => r.ready);
  const promos = v.proposedPromos || 0;
  const nReady = ready.length + promos;

  const saveDraft = async (row, cents) => {
    setError('');
    try {
      onView(await api.saveOpsRateDraft({ facility_id: v.facilityId, unit_type: row.name, proposed: cents == null ? null : cents / 100 }));
    } catch (err) {
      console.error('Operations: could not save proposed rate', err);
      setError(`The proposed rate for ${row.name} could not be saved. Try again.`);
    }
  };
  const refreshWebsites = async () => {
    const list = (v.competitors || []).filter((c) => c.ratesUrl && c.watch);
    if (!list.length) { setNote('No competitor has a rates page to read. Set one under Comp Set & Manual Entry.'); return; }
    setNote('Reading competitor websites');
    let read = 0;
    for (const c of list) {
      try { await api.checkOpsCompetitor(c.id); read += 1; } catch (err) { if (err?.status !== 409) console.error('Operations: website check failed', err); }
    }
    setNote(`${read} of ${list.length} competitor websites read${read < list.length ? ' (the rest were read in the last 10 minutes or could not be read)' : ''}.`);
    onReload();
  };
  const exportAll = (format) => {
    exportRows(format, { title: 'CMA', facility: v.facility, asOf: v.asOf, columns: OVERVIEW_COLUMNS, rows: v.rows })
      .catch((err) => { console.error('Operations: CMA export failed', err); setError('The export could not be built. Try again.'); });
  };
  const exportComps = (format) => {
    exportRows(format, { title: 'CMA Competitor Rates', facility: v.facility, asOf: v.asOf, columns: COMP_COLUMNS, rows: compRows(v.rows) })
      .catch((err) => { console.error('Operations: CMA export failed', err); setError('The export could not be built. Try again.'); });
  };
  const attention = [...(v.attention || [])];
  if (cs.closed) attention.push(`${cs.closed} closed ${cs.closed === 1 ? 'competitor is' : 'competitors are'} left out of the averages`);

  return (
    <>
      <div className="dash-card" data-testid="cma-overview">
        <div className="cma-eyebrow">Competitive Market Analysis · Confidential</div>
        <h2 className="cma-title">{v.name}</h2>
        <div className="cma-meta">
          {v.address && <span>{v.address}</span>}
          <span>Last survey {v.lastSurvey ? formatDate(v.lastSurvey) : 'none yet'}{v.lastSurveyBy ? ` · ${v.lastSurveyBy}` : ''}</span>
          <span>Unit counts &amp; our rates: live from Cubby</span>
          <span>Competitor websites: read daily</span>
          {v.billingCycle === 'DAYS_28' && <span>Cubby rates here are per 28 days</span>}
        </div>
        <div className="cma-actions">
          <button type="button" className="secondary-btn cma-btn" onClick={() => onSection('history')}><History size={14} aria-hidden="true" /> Rate History</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => onSection('comps')}><Users size={14} aria-hidden="true" /> Comp Set &amp; Manual Entry</button>
          <button type="button" className="secondary-btn cma-btn" onClick={refreshWebsites} disabled={note === 'Reading competitor websites'}><RefreshCw size={14} aria-hidden="true" /> Refresh Websites</button>
          <button type="button" className="primary-btn cma-btn" onClick={() => exportAll('csv')}><Download size={14} aria-hidden="true" /> Export CSV</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => exportAll('xls')}><Download size={14} aria-hidden="true" /> Export XLS</button>
        </div>
        {note && <p className="cma-note" role="status">{note}</p>}
        {!v.cubbyGroups.ok && <p className="cma-note" role="status">Cubby&apos;s pricing groups could not be read, so the rates show the rent roll&apos;s standard rate.</p>}
      </div>

      <div className="cma-kpis">
        <Kpi label="Competitive Set" value={`${count(cs.active)} active`}
          sub={`${count(cs.web + cs.stortrack)} website-synced · ${count(cs.manual)} manual · ${count(cs.closed)} closed (excluded)`} />
        <Kpi label="Web Rate vs Market Avg" value={pctText(k.vsMarket)} tone={k.vsMarket < 0 ? 'below' : undefined}
          sub={`${count(k.belowMarket)} of ${count(k.rateable)} rateable unit types below market`} />
        <Kpi label="Occupancy (Cubby)" value={k.units ? `${((k.rented / k.units) * 100).toFixed(1)}%` : dash}
          sub={`${count(k.rented)} occupied of ${count(k.units)} units · ${count(k.offline)} offline`} />
        <Kpi label="Needs Attention" tone="attn">
          {attention.length ? <ul>{attention.slice(0, 4).map((a) => <li key={a}>{a}</li>)}</ul> : <div className="cma-kpi-sub">Nothing needs attention.</div>}
        </Kpi>
      </div>

      <div className="cma-banner" data-testid="ready-bar">
        <div>
          <div className="cma-banner-title">{nReady} {nReady === 1 ? 'change' : 'changes'} ready for Cubby</div>
          <div className="cma-banner-sub">
            {nReady
              ? [...ready.map((r) => `${sizeOf(r)} web rate ${signedUsd(r.proposed - r.sell)}`), promos ? `${promos} ${promos === 1 ? 'promotion' : 'promotions'}` : '']
                .filter(Boolean).join(' · ')
              : 'Type a Proposed rate below, or click a Suggested price, to add one.'}
          </div>
        </div>
        <button type="button" onClick={() => onSection('review')} disabled={!nReady} className="cma-btn">
          <Send size={14} aria-hidden="true" /> {v.pushOn ? 'Review & Push to Cubby' : 'Review Changes'}
        </button>
      </div>

      {error && <p className="cma-error" role="alert">{error}</p>}

      <div className="dash-card">
        <div className="cma-tablebar">
          <div className="cma-pills" role="group" aria-label="Unit types">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className="cma-pill" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>
          <div className="cma-hint">Variance = our Web Rate vs market avg excluding us · click a unit type to see each competitor</div>
        </div>
        <div className="req-table-wrapper">
          <table className="req-table stack-table cma-table" data-testid="rate-table">
            <thead><tr>
              <th>Unit Type</th>
              <Th label="Total" tip={TIPS.total} num /><Th label="Vacant" tip={TIPS.vacant} num /><Th label="Offline" tip={TIPS.offline} num />
              <Th label="Occ." tip={TIPS.occ} num /><Th label="Avg Days Vacant" tip={TIPS.days} num />
              <Th label="Current Standard Rate" tip={TIPS.standard} num /><Th label="Web Rate" tip={TIPS.web} num />
              <Th label="Walk-In Rate" tip={TIPS.walkIn} num />
              <Th label="Mkt Low" tip={TIPS.low} num /><Th label="Mkt High" tip={TIPS.high} num /><Th label="Mkt Avg" tip={TIPS.avg} num />
              <Th label="Variance" tip={TIPS.variance} num /><Th label="Comps" tip={TIPS.comps} num />
              <Th label="Comp Promotions" tip={TIPS.promo} /><Th label="Comp Admin Fee" tip={TIPS.fee} num />
              <Th label="Suggested" tip={TIPS.suggested} /><Th label="Proposed" tip={TIPS.proposed} />
              <Th label="Rev. Change / Mo" tip={TIPS.delta} num />
            </tr></thead>
            <tbody>
              {CATS.filter((c) => filter === 'all' || filter === c).map((c) => {
                const rows = shown.filter((r) => r.category === c);
                if (!rows.length) return null;
                return (
                  <Fragment key={c}>
                    <tr className="cma-group"><td colSpan={COLS}>{c}</td></tr>
                    {rows.map((r) => <Row key={r.name} r={r} on={sel?.name === r.name} onPick={setPicked} canEdit={v.canEdit} onSave={saveDraft} />)}
                    <Subtotal label={c} rows={rows} />
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {!shown.length && <div className="ops-empty">No unit types in this group.</div>}
      </div>

      {sel && <CompetitorPanel r={sel} canEdit={v.canEdit} onAdd={() => setAdding(sel)} />}
      <div className="cma-actions" style={{ marginTop: 0 }}>
        <span className="cma-hint">Every competitor rate behind this table:</span>
        <button type="button" className="secondary-btn cma-btn" onClick={() => exportComps('csv')}><Download size={14} aria-hidden="true" /> Competitor Rates CSV</button>
        <button type="button" className="secondary-btn cma-btn" onClick={() => exportComps('xls')}><Download size={14} aria-hidden="true" /> Competitor Rates XLS</button>
      </div>

      {adding && (
        <ManualRateModal facility={facility} view={v} row={adding} onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); onReload(); }} />
      )}
    </>
  );
}
