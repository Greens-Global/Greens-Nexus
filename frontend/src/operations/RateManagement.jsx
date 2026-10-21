// Operations -> Rate Management (Neil / Miranda, Oct 20 2026): the CMA screen.
//
// Every unit type we rent (a Cubby pricing group), what it is Set at and Sells
// for, what the competitors charge, the rule's suggestion and a Proposed rate
// a person types. Proposals are saved as drafts (who and when) until someone
// opens Review Changes, enters the new rates in Cubby BY HAND (from the screen
// or the printable checklist) and marks them Entered in Cubby here, which
// records who and when and clears the draft. Push to Cubby exists only behind
// the Operations switch (Settings > Global Settings > Operations, OFF by
// default - Visesh, Oct 21 2026): with it off no push button is shown and the
// server refuses the push route.
//
// Plain language (Visesh, Oct 20 2026: "where we know which competitor and all
// that data and what are we lacking"): a summary card names every competitor
// we compare with and lists what the comparison is missing; the table reads
// as Our Rate / Market (a range bar) / Position / Suggested with a short
// reason; a row opens to that size competitor by competitor
// (GET /facility-ops/rates/comps) and its rate history.
//
// The numbers come from GET /facility-ops/rates, which runs the same
// ops_market.compare the old Market Rates table used, against the Sell rate.
// The competitor set and manual entry are the existing Market screen, opened
// from "Comp Set & Manual Entry" (or Manage Competitors in the summary).
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, Check, ChevronDown, ChevronRight, Download, HelpCircle, History, Info, RefreshCw, Send, Users } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { Modal } from '../tasks/components';
import { formatDate, formatDateTime } from '../lib/datetime';
import { count, money } from './model';
import Market from './Market';
import SectionPicker from './SectionPicker';

const CATS = ['Self-Storage', 'Vehicle Storage'];
const TABS = [['all', 'All Unit Types'], ['Self-Storage', 'Self-Storage'], ['Vehicle Storage', 'Vehicle Storage']];
const dash = '-';
const $ = (c) => (c == null ? dash : money(c, { exact: c % 100 !== 0 }));
const signed = (c) => (c == null ? dash : `${c > 0 ? '+' : c < 0 ? '-' : ''}${money(Math.abs(c), { exact: Math.abs(c) % 100 !== 0 })}`);
const pctText = (x, digits = 1) => (x == null ? dash : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
const wholePct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
const toCents = (s) => {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const toInput = (c) => (c == null ? '' : String(c / 100));
const SOURCE = { stortrack: 'StorTrack', web: 'Website', manual: 'Manual', import: 'Import' };
const sourceOf = (s) => SOURCE[s] || 'Manual';
const miles = (d) => (d == null ? 'Distance not recorded' : `${d.toFixed(1)} mi`);
// "$22.50 below (27%)" - the variance in words, never "-$22.50 - -27.4%".
const varianceText = (r) => {
  if (r.variance == null) return dash;
  if (r.variance === 0) return 'Same as the median';
  return `${$(Math.abs(r.variance))} ${r.variance < 0 ? 'below' : 'above'} (${wholePct(r.variancePct)})`;
};

const GREEN = '#14532d';
const NO_PUSH_NOTE = "Nexus doesn't change rates in Cubby. Enter them in Cubby, then mark them entered here.";
const PUSH_NOTE = 'Push to Cubby sends the new rates to Cubby now, or enter them in Cubby yourself and mark them entered here.';
const NO_KEY_NOTE = "Push to Cubby is on, but this server has no Cubby key with the Manager role yet. Enter the rates in Cubby and mark them entered.";
// Push to Cubby shows only with the Operations switch on and for managers and above.
const pushShown = (v) => !!(v?.pushOn && v?.canPush);
// Rate history results. "ok" / "failed" are rows from before Oct 20 2026, when Nexus still sent rates itself.
const RESULT = {
  entered: ['status-approved', 'Entered in Cubby'], ok: ['status-approved', 'Pushed to Cubby'],
  failed: ['status-rejected', 'Failed'], skipped: ['pill-muted', 'Skipped'],
};
const resultOf = (p) => RESULT[p.status] || ['pill-muted', p.status];
const th = { textAlign: 'right', whiteSpace: 'nowrap' };

// Where our Sell rate sits against the market median (ops_rate_mgmt.position).
const POSITION = {
  below: (r) => ['pill-info', `${wholePct(r.variancePct)} Below Market`],
  at: () => ['pill-ok', 'At Market'],
  above: (r) => ['pill-warn', `${wholePct(r.variancePct)} Above Market`],
  none: () => ['pill-muted', 'No Market Data'],
  offline: () => ['pill-muted', 'Offline'],
};
const DOT = { below: 'var(--info-fg)', at: 'var(--ok-fg)', above: 'var(--warn-fg)' };

// Column headers: Title Case, each with a short "?" explanation.
function Th({ label, tip, right, style }) {
  return (
    <th style={{ ...(right ? th : { whiteSpace: 'nowrap' }), ...style }}>
      <span className="rm-th" title={tip}>
        {label}<HelpCircle size={12} aria-hidden="true" className="rm-th-q" />
        <span className="sr-only">: {tip}</span>
      </span>
    </th>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`kpi-card rm-stat${tone ? ` rm-stat-${tone}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-delta">{sub}</div>}
    </div>
  );
}

const SHOW_COMPS = 8;

// "Compared With N Competitors": who, how far, where the rates come from, how fresh.
function CompetitorList({ v, onManage }) {
  const [all, setAll] = useState(false);
  const list = v.competitors || [];
  const shown = all ? list : list.slice(0, SHOW_COMPS);
  const cs = v.compSet;
  return (
    <section className="rm-panel" aria-label="Competitors">
      <div className="rm-panel-head">
        <h3 className="rm-h3">Compared With {count(list.length)} {list.length === 1 ? 'Competitor' : 'Competitors'}</h3>
        <button type="button" className="ops-link rm-linkbtn" onClick={onManage}><Users size={13} aria-hidden="true" /> Manage Competitors</button>
      </div>
      <div className="rm-panel-sub">
        {cs.stortrack} from StorTrack, {cs.web} read from their websites, {cs.manual} entered by hand
        {cs.closed ? `, ${cs.closed} closed (not counted)` : ''}. Nearest first.
      </div>
      {list.length === 0 ? (
        <div className="ops-empty">No competitors yet. Add the facilities around this one under Manage Competitors.</div>
      ) : (
        <ul className="rm-comps">
          {shown.map((c) => (
            <li key={c.id}>
              <div className="rm-comp-name">{c.name}</div>
              <div className="rm-comp-meta">
                <span>{miles(c.distanceMiles)}</span>
                <span>{sourceOf(c.source)}</span>
                <span>{c.lastUpdated ? `Updated ${formatDate(c.lastUpdated)}` : 'No rates yet'}</span>
                <span>{c.sizes} {c.sizes === 1 ? 'size' : 'sizes'} matched</span>
              </div>
              {c.address && <div className="rm-comp-addr">{c.address}</div>}
            </li>
          ))}
        </ul>
      )}
      {list.length > SHOW_COMPS && (
        <button type="button" className="ops-link rm-linkbtn" onClick={() => setAll((x) => !x)} style={{ marginTop: 8 }}>
          {all ? 'Show Nearest 8' : `Show All ${list.length}`}
        </button>
      )}
    </section>
  );
}

// "What We're Missing": each gap with how many unit types, which ones (in full) and what to do.
function GapList({ gaps }) {
  return (
    <section className="rm-panel" aria-label="What We're Missing">
      <div className="rm-panel-head">
        <h3 className="rm-h3">What We&apos;re Missing</h3>
      </div>
      <div className="rm-panel-sub">Gaps in the comparison, the most useful to fix first.</div>
      {gaps.length === 0 ? (
        <div className="ops-empty">Nothing missing. Every size has at least 3 recent competitor rates.</div>
      ) : (
        <ul className="rm-gaps">
          {gaps.map((g) => (
            <li key={g.key} className={`rm-gap rm-gap-${g.key}`}>
              <div className="rm-gap-head">
                <span className="rm-gap-title">{g.title}</span>
                <span className="status-badge pill-muted">{count(g.count)}</span>
              </div>
              <div className="rm-gap-action">{g.action}</div>
              <ul className="rm-gap-items">{g.items.map((x, i) => <li key={`${i}:${x}`}>{x}</li>)}</ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MarketSummary({ v, onManage }) {
  const h = v.headline || {};
  const k = v.kpis;
  const priced = (h.below || 0) + (h.at || 0) + (h.above || 0);
  const types = (n) => `${n} unit ${n === 1 ? 'type' : 'types'}`;
  const [open, setOpen] = useState(null);   // 'comps' | 'gaps'
  const comps = (v.competitors || []).length;
  const gaps = v.gaps || [];
  const gapTotal = gaps.reduce((t, g) => t + (g.count || 0), 0);
  return (
    <div className="dash-card" data-testid="market-summary">
      <div className="rm-stats">
        <Stat label="Below Market" value={count(h.below)} sub={`${types(h.below)} more than 3% under the median`} tone="below" />
        <Stat label="At Market" value={count(h.at)} sub={`${types(h.at)} within 3% of the median`} tone="at" />
        <Stat label="Above Market" value={count(h.above)} sub={`${types(h.above)} more than 3% over the median`} tone="above" />
        <Stat label="Sell Rate vs Market" value={pctText(k.vsMarket)}
          sub={`Across the ${types(priced)} with market data; ${count(h.noMarket)} have none`} />
        <Stat label="If Every Suggestion Were Taken" value={`${signed(h.upside)} / Mo`}
          sub={`${signed(h.raises)} from raises, ${signed(h.cuts)} from cuts, on vacant units (${count(h.suggestions)} changes)`}
          tone={h.upside > 0 ? 'up' : h.upside < 0 ? 'down' : undefined} />
      </div>
      {/* Competitors and data gaps behind two small buttons (Visesh, Oct 20: the
          two panels filled the screen) - the page goes KPIs, then the table. */}
      <div className="rm-detail-btns">
        <button type="button" className="rm-detail-btn" onClick={() => setOpen('comps')}>
          <Info size={14} aria-hidden="true" /> Compared With {count(comps)} {comps === 1 ? 'Competitor' : 'Competitors'}
        </button>
        <button type="button" className={`rm-detail-btn${gapTotal ? ' rm-detail-btn-warn' : ''}`} onClick={() => setOpen('gaps')}>
          <AlertTriangle size={14} aria-hidden="true" /> What We&apos;re Missing{gapTotal ? ` · ${count(gaps.length)} ${gaps.length === 1 ? 'Gap' : 'Gaps'}` : ''}
        </button>
      </div>
      {open === 'comps' && (
        <Modal title="Compared With These Competitors" onClose={() => setOpen(null)} minHeight="60vh">
          <CompetitorList v={v} onManage={() => { setOpen(null); onManage(); }} />
        </Modal>
      )}
      {open === 'gaps' && (
        <Modal title="What We're Missing" onClose={() => setOpen(null)} minHeight="60vh">
          <GapList gaps={gaps} />
        </Modal>
      )}
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

function UnitsCell({ r }) {
  const occ = r.total ? r.occupancy : 0;
  const parts = [`${count(r.vacant)} vacant`];
  if (r.offline) parts.push(`${count(r.offline)} offline`);
  return (
    <div className="rm-units">
      <div><strong>{count(r.total)}</strong> <span className="rm-muted">{r.total ? `${Math.round(occ * 100)}% full` : ''}</span></div>
      {r.total > 0 && (
        <div className="rm-occ" role="img" aria-label={`${Math.round(occ * 100)}% occupied`}>
          <span style={{ width: `${Math.min(100, occ * 100)}%` }} />
          {r.offline > 0 && <i style={{ width: `${(r.offline / r.total) * 100}%` }} />}
        </div>
      )}
      <div className="rm-muted">{parts.join(' · ')}</div>
    </div>
  );
}

function OurRateCell({ r }) {
  return (
    <div className="rm-ours">
      <div className="rm-sell">{$(r.sell)}</div>
      <div className="rm-muted">Set {$(r.set)}</div>
      <div className="rm-muted">Walk-In {r.walkIn == null ? 'none' : $(r.walkIn)}</div>
    </div>
  );
}

// Low to high as a bar, the median as a tick, our Sell rate as a dot.
function MarketBar({ r, staleDays }) {
  if (r.marketMedian == null) return <span className="rm-muted">None on file</span>;
  const ours = r.sell > 100 ? r.sell : null;
  const lo = Math.min(r.marketLow, ours ?? r.marketLow);
  const hi = Math.max(r.marketHigh, ours ?? r.marketHigh);
  const span = hi - lo || 1;
  const at = (c) => `${4 + ((c - lo) / span) * 92}%`;
  return (
    <div className="rm-market">
      <div className="rm-bar" role="img"
        aria-label={`Market ${$(r.marketLow)} to ${$(r.marketHigh)}, median ${$(r.marketMedian)}${ours ? `, ours ${$(ours)}` : ''}`}>
        <span className="rm-bar-range" style={{ left: at(r.marketLow), width: `calc(${at(r.marketHigh)} - ${at(r.marketLow)})` }} />
        <span className="rm-bar-median" style={{ left: at(r.marketMedian) }} title={`Median ${$(r.marketMedian)}`} />
        {ours != null && <span className="rm-bar-dot" style={{ left: at(ours), background: DOT[r.position] || 'var(--muted)' }} title={`Our Sell rate ${$(ours)}`} />}
      </div>
      <div className="rm-bar-nums">
        <span>Low {$(r.marketLow)}</span><span>Median <b>{$(r.marketMedian)}</b></span><span>High {$(r.marketHigh)}</span>
      </div>
      <div className="rm-muted">
        {r.competitors} {r.competitors === 1 ? 'competitor' : 'competitors'}
        {r.staleComps ? `, ${r.staleComps} older than ${staleDays} days` : ''}
      </div>
    </div>
  );
}

function PositionCell({ r }) {
  const [cls, label] = (POSITION[r.position] || POSITION.none)(r);
  return (
    <div className="rm-pos" title={r.variance == null ? undefined : `Our Sell rate ${$(r.sell)} vs the ${$(r.marketMedian)} market median`}>
      <span className={`status-badge ${cls}`}>{label}</span>
      {r.variance != null && r.position !== 'offline' && <div className="rm-muted">{varianceText(r)}</div>}
    </div>
  );
}

// Why there is no suggestion, in two or three words; the sentence is the tooltip.
function noSuggestion(r, minCompetitors) {
  if (r.offlineOnly) return 'Nothing to Price';
  if (r.sell <= 100 && r.total) return 'Fix Our Rate First';
  if (!r.competitors) return dash;
  if (r.competitors < minCompetitors) return 'Need More Competitors';
  return dash;
}
const REASON_TONE = { Raise: 'pill-ok', Lower: 'pill-warn', Hold: 'pill-muted' };

function SuggestedCell({ r, canEdit, onSave, minCompetitors }) {
  if (r.suggested == null) {
    return <span className="rm-muted rm-help" title={r.why}>{noSuggestion(r, minCompetitors)}</span>;
  }
  const verb = (r.reason || '').split(': ')[1];
  return (
    <div className="rm-suggest" title={r.why}>
      <button type="button" className="ops-cell" disabled={!canEdit} title={canEdit ? `Use ${$(r.suggested)} as the proposed rate` : r.why}
        onClick={() => onSave(r, r.suggested)} style={{ fontWeight: 700, fontSize: 15 }}>{$(r.suggested)}</button>
      <div className="rm-chips">
        {r.reason && <span className={`status-badge ${REASON_TONE[verb] || 'pill-muted'} rm-help`}>{r.reason}</span>}
        {r.held && <span className="status-badge pill-muted rm-help">Held to 10% Step</span>}
      </div>
    </div>
  );
}

// One size, competitor by competitor, with ours among them, and our rate history.
function RowDetail({ r, facilityId, onHistory, onManage }) {
  const [state, setState] = useState({ status: 'loading', comps: null, history: null });
  useEffect(() => {
    let live = true;
    Promise.all([
      api.getOpsRateComps(facilityId, r.name),
      api.getOpsRateHistory(facilityId, r.name).catch((err) => { console.error('Operations: rate history failed', err); return null; }),
    ])
      .then(([comps, history]) => { if (live) setState({ status: 'ready', comps, history }); })
      .catch((err) => { console.error('Operations: competitor rates failed', err); if (live) setState({ status: 'error', comps: null, history: null }); });
    return () => { live = false; };
  }, [facilityId, r.name]);

  if (state.status === 'loading') return <LoadingState compact label="Loading competitor rates" />;
  if (state.status === 'error') return <div className="ops-empty" role="alert">The competitor rates could not be loaded. Try again.</div>;
  const list = state.comps.competitors || [];
  const ours = { us: true, competitorId: 'us', competitor: 'Greens Storage (Us)', rate: r.sell, set: r.set };
  const rows = [...list];
  if (r.sell > 100) {
    const i = rows.findIndex((c) => c.rate > r.sell);
    rows.splice(i < 0 ? rows.length : i, 0, ours);
  }
  // The median as a marker line where it falls among the prices.
  if (list.length && r.marketMedian != null) {
    const i = rows.findIndex((c) => c.rate > r.marketMedian);
    rows.splice(i < 0 ? rows.length : i, 0, { median: true, competitorId: 'median' });
  }
  const low = list.length ? list[0].competitorId : null;
  const high = list.length > 1 ? list[list.length - 1].competitorId : null;
  const ourHistory = state.history?.ours || [];
  return (
    <div className="rm-detail">
      <div>
        <div className="rm-detail-head">
          <h4 className="rm-h3">{r.name}: Competitor by Competitor</h4>
          <span className="rm-muted">
            Each competitor&apos;s newest regular price for this size from the last {state.comps.freshDays} days, cheapest first.
            Low, median and high come from these; we compare our Sell rate.
          </span>
        </div>
        {list.length === 0 ? (
          <div className="ops-empty">
            No competitor rate on file for this size.{' '}
            <button type="button" className="ops-link rm-linkbtn" onClick={onManage}>Add One by Hand</button>
          </div>
        ) : (
          <div className="req-table-wrapper">
            <table className="req-table stack-table rm-comp-table" data-testid="comp-table">
              <thead><tr>
                <th>Competitor</th><th style={th}>Distance</th><th style={th}>Regular Price</th><th style={th}>Online Price</th>
                <th>Promotion</th><th>Collected</th><th>Source</th>
              </tr></thead>
              <tbody>
                {rows.map((c) => {
                  if (c.median) {
                    return (
                      <tr key="median" className="rm-median-row">
                        <td colSpan={7}>Market Median {$(r.marketMedian)}</td>
                      </tr>
                    );
                  }
                  if (c.us) {
                    return (
                      <tr key="us" className="rm-us-row">
                        <td><strong>{c.competitor}</strong></td>
                        <td data-th="Distance" className="num">-</td>
                        <td data-th="Regular Price" className="num" title="Our Set rate (Cubby standard rate)">{$(c.set)} <span className="rm-muted">Set</span></td>
                        <td data-th="Online Price" className="num" title="Our Sell rate (Cubby web rate)"><strong>{$(c.rate)}</strong> <span className="rm-muted">Sell</span></td>
                        <td data-th="Promotion" />
                        <td data-th="Collected">Live from Cubby</td>
                        <td data-th="Source">Cubby</td>
                      </tr>
                    );
                  }
                  const tag = c.competitorId === low ? 'Lowest' : c.competitorId === high ? 'Highest' : '';
                  return (
                    <tr key={c.competitorId}>
                      <td>
                        {c.competitor}
                        {tag && <span className={`status-badge ${tag === 'Lowest' ? 'pill-info' : 'pill-warn'}`} style={{ marginLeft: 6 }}>{tag}</span>}
                      </td>
                      <td data-th="Distance" className="num">{c.distanceMiles == null ? dash : `${c.distanceMiles.toFixed(1)} mi`}</td>
                      <td data-th="Regular Price" className="num"><strong>{$(c.rate)}</strong></td>
                      <td data-th="Online Price" className="num">{$(c.online)}</td>
                      <td data-th="Promotion">
                        {c.promo || (c.promoRate == null ? dash : '')}
                        {c.promoRate != null && <span className="rm-muted">{c.promo ? ' - ' : ''}{$(c.promoRate)} promo price</span>}
                      </td>
                      <td data-th="Collected" style={{ whiteSpace: 'nowrap', color: c.stale ? 'var(--warn-fg)' : undefined }}
                        title={c.stale ? `Older than ${state.comps.staleDays} days` : undefined}>
                        {formatDate(c.observedOn)}{c.stale ? ` (${c.ageDays} days old)` : ''}
                      </td>
                      <td data-th="Source">{sourceOf(c.source)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <div className="rm-detail-head">
          <h4 className="rm-h3">Our Rate Changes</h4>
          <span className="rm-muted">Rates entered in Cubby and marked entered here.</span>
        </div>
        {state.history == null ? <div className="ops-empty">The rate history could not be loaded.</div>
          : ourHistory.length === 0 ? <div className="ops-empty">No rate changes marked entered in Cubby yet.</div> : (
            <ul className="rm-history">
              {ourHistory.slice(0, 6).map((p) => (
                <li key={p.id}>
                  <div><strong>{$(p.oldSell)} &rarr; {$(p.newSell)}</strong> <span className="rm-muted">Sell</span></div>
                  <div className="rm-muted">{formatDateTime(p.pushedAt)} by {p.pushedBy} - {resultOf(p)[1]}</div>
                </li>
              ))}
            </ul>
          )}
        <button type="button" className="secondary-btn" onClick={() => onHistory(r.name)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
          <History size={14} aria-hidden="true" /> Open Full Rate History
        </button>
      </div>
    </div>
  );
}

const COLS = 8;

function Row({ r, open, onToggle, canEdit, onSave, minCompetitors, staleDays }) {
  // A click anywhere on the row opens it, except on the inputs and buttons inside.
  const click = (e) => { if (!e.target.closest('input, button, a, select, textarea')) onToggle(r.name); };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <tr className={`rm-row${open ? ' rm-row-open' : ''}`} onClick={click}>
      <td className="rm-name">
        <button type="button" className="rm-name-btn" aria-expanded={open} onClick={() => onToggle(r.name)}
          title="Show each competitor's rate for this size">
          <Chevron size={15} aria-hidden="true" className="rm-chev" /> <span>{r.name}</span>
        </button>
        {r.valuePricing === 'APPROVED' && <div className="ops-delta">Tier pricing on in Cubby</div>}
      </td>
      <td data-th="Units"><UnitsCell r={r} /></td>
      <td data-th="Our Rate" className="num"><OurRateCell r={r} /></td>
      <td data-th="Market"><MarketBar r={r} staleDays={staleDays} /></td>
      <td data-th="Position"><PositionCell r={r} /></td>
      <td data-th="Suggested"><SuggestedCell r={r} canEdit={canEdit} onSave={onSave} minCompetitors={minCompetitors} /></td>
      <td data-th="Proposed" className="num">
        <ProposedInput row={r} disabled={!canEdit} onSave={onSave} />
        {r.draft && <div className="ops-delta" title={`Proposed by ${r.draft.updatedBy}`}>{formatDate(r.draft.updatedAt)}</div>}
      </td>
      <td data-th="Change per Month" className="num" style={{ fontWeight: 600, color: r.revDelta > 0 ? GREEN : r.revDelta < 0 ? '#b91c1c' : undefined }}>
        {r.proposed == null ? <span className="rm-muted">{dash}</span> : signed(r.revDelta)}
      </td>
    </tr>
  );
}

function Subtotal({ label, rows }) {
  const total = rows.reduce((a, r) => a + r.total, 0);
  const rented = rows.reduce((a, r) => a + r.rented, 0);
  const vacant = rows.reduce((a, r) => a + r.vacant, 0);
  const offline = rows.reduce((a, r) => a + r.offline, 0);
  return (
    <tr className="rm-subtotal">
      <td>Subtotal {label}</td>
      <td data-th="Units">
        <strong>{count(total)}</strong> <span className="rm-muted">{total ? `${Math.round((rented / total) * 100)}% full` : ''}</span>
        <div className="rm-muted">{count(vacant)} vacant{offline ? ` · ${count(offline)} offline` : ''}</div>
      </td>
      <td colSpan={COLS - 3} />
      <td data-th="Change per Month" className="num">{signed(rows.reduce((a, r) => a + r.revDelta, 0))}</td>
    </tr>
  );
}

// Review Changes: old -> new for every change, ticked by default. Staff enter
// the rates in Cubby by hand (Export Checklist is the same list as a PDF), then
// Mark Entered in Cubby per row or for every ticked row.
export function ReviewModal({ view, onClose, onMarked, onChecklist }) {
  // What was reviewed stays on screen after marking refreshes the table.
  const [ready] = useState(() => view.rows.filter((r) => r.ready));
  const [picked, setPicked] = useState(() => new Set(ready.map((r) => r.name)));
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState({});
  const [error, setError] = useState('');
  const left = ready.filter((r) => !done[r.name]);
  const chosen = left.filter((r) => picked.has(r.name));
  const total = chosen.reduce((a, r) => a + r.revDelta, 0);
  const canMark = view.canMark !== false;
  const showPush = pushShown(view);
  const push = async (rows) => {
    if (!window.confirm(`Send ${rows.length} new ${rows.length === 1 ? 'rate' : 'rates'} to Cubby now? This changes the live web and standard rates.`)) return;
    setBusy('push');
    setError('');
    try {
      const out = await api.pushOpsRates(view.facilityId, rows.map((r) => r.name));
      setDone((d) => ({ ...d, ...Object.fromEntries(out.results.map((x) => [x.unitType, x])) }));
      onMarked(out.view);
    } catch (err) {
      console.error('Operations: could not push rates to Cubby', err);
      setError(err?.message || 'The rates could not be pushed. Nothing was changed. Try again.');
    } finally { setBusy(''); }
  };
  const toggle = (name) => setPicked((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const mark = async (rows, key) => {
    setBusy(key);
    setError('');
    try {
      const seen = Object.fromEntries(rows.map((r) => [r.name, { set: r.set, sell: r.sell }]));
      const out = await api.markOpsRatesEntered(view.facilityId, rows.map((r) => r.name), seen);
      setDone((d) => ({ ...d, ...Object.fromEntries(out.results.map((x) => [x.unitType, x])) }));
      onMarked(out.view);
    } catch (err) {
      console.error('Operations: could not mark rates entered', err);
      setError('That could not be recorded. Nothing was changed. Try again.');
    } finally { setBusy(''); }
  };
  const footer = (
    <>
      <button type="button" className="secondary-btn" onClick={() => onChecklist(chosen.length ? chosen : left)} disabled={!left.length}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={14} aria-hidden="true" /> Export Checklist</button>
      <button type="button" className={left.length ? 'secondary-btn' : 'primary-btn'} onClick={onClose}>{left.length ? 'Close' : 'Done'}</button>
      {showPush && left.length > 0 && (
        <button type="button" className="primary-btn" onClick={() => push(chosen)} disabled={!!busy || !chosen.length || !view.pushReady}
          title={view.pushReady ? undefined : NO_KEY_NOTE} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Send size={14} aria-hidden="true" /> {busy === 'push' ? 'Pushing' : `Push ${chosen.length} to Cubby`}
        </button>
      )}
      {canMark && left.length > 0 && (
        <button type="button" className="primary-btn" onClick={() => mark(chosen, 'all')} disabled={!!busy || !chosen.length}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Check size={14} aria-hidden="true" /> {busy === 'all' ? 'Saving' : `Mark ${chosen.length} Entered in Cubby`}
        </button>
      )}
    </>
  );
  return (
    <Modal title={`Review Changes - ${view.facility}`} onClose={onClose} width="60vw" minHeight="60vh" footer={footer}>
      <p className="ops-note" style={{ marginTop: 0 }}>
        {showPush ? (view.pushReady ? PUSH_NOTE : NO_KEY_NOTE) : NO_PUSH_NOTE} In Cubby the Sell rate is the web rate and the Set rate is the standard rate; the Set rate moves
        by the same amount unless one was typed.
        {!canMark ? ' Only people who can propose rates can mark them entered. Export the checklist to hand it on.' : ''}
      </p>
      {ready.length === 0 ? <div className="ops-empty">No changes are ready. Enter a Proposed rate in the table first.</div> : (
        <div className="req-table-wrapper">
          <table className="req-table stack-table" data-testid="review-table">
            <thead><tr>
              <th aria-label="Include" />
              <th>Unit Type</th><th style={th}>Sell</th><th style={th}>Set</th><th style={th}>Vacant</th><th style={th}>Rev. Change / Mo</th>
              <th>Cubby</th>
            </tr></thead>
            <tbody>
              {ready.map((r) => {
                const res = done[r.name];
                return (
                  <tr key={r.name}>
                    <td>{!res && <input type="checkbox" checked={picked.has(r.name)} onChange={() => toggle(r.name)} aria-label={`Include ${r.name}`} />}</td>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td data-th="Sell" className="num">{$(r.sell)} &rarr; <strong>{$(r.proposed)}</strong></td>
                    <td data-th="Set" className="num">{$(r.set)} &rarr; {$(r.proposedSet)}</td>
                    <td data-th="Vacant" className="num">{count(r.vacant)}</td>
                    <td data-th="Rev. Change / Mo" className="num">{signed(r.revDelta)}</td>
                    <td data-th="Cubby" style={{ whiteSpace: 'nowrap' }}>
                      {res ? (
                        <>
                          <span className={`status-badge ${resultOf(res)[0]}`}>{resultOf(res)[1]}</span>
                          {res.status === 'entered' || res.status === 'ok'
                            ? <div className="ops-why">{res.pushedBy} - {formatDateTime(res.pushedAt)}</div>
                            : <div className="ops-why">{res.detail}</div>}
                        </>
                      ) : canMark ? (
                        <button type="button" className="secondary-btn" onClick={() => mark([r], r.name)} disabled={!!busy}
                          aria-label={`Mark ${r.name} Entered in Cubby`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Check size={13} aria-hidden="true" /> {busy === r.name ? 'Saving' : 'Mark Entered'}
                        </button>
                      ) : <span className="pill-muted status-badge">Not Yet in Cubby</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {chosen.length > 0 && (
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
                  <td data-th="Result">{resultOf(p)[1]}{p.status === 'failed' || p.status === 'skipped' ? `: ${p.detail}` : ''}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <div className="ops-empty">No rate changes marked entered in Cubby yet.</div>}
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
  { header: 'Vs Median', get: (r) => varianceText(r), width: 14 },
  { header: 'Comps', get: (r) => r.competitors, width: 7 },
  { header: 'Suggested', get: (r) => $(r.suggested), width: 10 },
  { header: 'Proposed', get: (r) => $(r.proposed), width: 10 },
  { header: 'Change / Mo', get: (r) => signed(r.revDelta), width: 12 },
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

const TIPS = {
  unitType: 'A Cubby pricing group. Click a row to see each competitor\'s rate for that size and our rate history.',
  units: 'How many units of this type, how full they are, and how many are vacant or offline (live from Cubby).',
  ourRate: 'Sell = Cubby web rate, what a new customer pays online; it is the rate compared with the market. Set = Cubby standard (in-store) rate. Walk-In = Cubby walk-in rate.',
  market: (days) => `Competitors' newest regular price for this size from the last ${days} days. The bar runs low to high, the tick is the median and the dot is our Sell rate.`,
  position: 'Our Sell rate against the market median. Within 3% either way is At Market.',
  suggested: (min) => `The market median, moved by how full we are (nearly full: a little above; vacancy: a little below), held to a 10% step from today's Sell rate. Needs ${min} competitor rates. Hover the reason for the full explanation; click the price to use it.`,
  proposed: 'The new Sell rate to enter in Cubby. Saved as a draft when you leave the field.',
  change: '(Proposed - Sell) x vacant units: what the new rate is worth a month on the units it reaches now.',
};

// The facility comes from the page's one Facility dropdown (Oct 20).
export default function RateManagement({ facility }) {
  const facilityId = facility?.id;
  const [state, setState] = useState({ status: 'loading', data: null });
  const [tab, setTab] = useState('all');
  const [panel, setPanel] = useState(null);       // 'review' | { history: name }
  const [showComps, setShowComps] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState('');
  const [error, setError] = useState('');
  const compsRef = useRef(null);
  const [scrollToComps, setScrollToComps] = useState(0);

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
  useEffect(() => { setOpen(new Set()); }, [facilityId]);
  useEffect(() => {
    if (scrollToComps && compsRef.current?.scrollIntoView) compsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollToComps]);

  const v = state.data;
  const setView = (data) => setState({ status: 'ready', data });
  const shown = useMemo(() => (v ? v.rows.filter((r) => tab === 'all' || r.category === tab) : []), [v, tab]);
  const toggle = useCallback((name) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  }), []);
  const manageCompetitors = () => { setShowComps(true); setScrollToComps((x) => x + 1); };

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
        ? `Enter each rate in Cubby > Pricing Groups, then mark it entered in Nexus. Prepared ${formatDate(v.asOf)}.`
        : `Competitive market analysis as of ${formatDate(v.asOf)}${v.lastSurvey ? `, last survey ${formatDate(v.lastSurvey)}` : ''}. Sell = Cubby web rate; market = competitors' newest rates.`,
      columns: checklist ? CHECKLIST_COLUMNS : PDF_COLUMNS,
      rows,
      filename: `${checklist ? 'cubby-rate-checklist' : 'rate-management'}-${(v.facility || 'facility').toLowerCase().replace(/\s+/g, '-')}-${v.asOf}.pdf`,
    });
  };

  if (!facility) {
    return (
      <div className="dash-card">
        <div className="dash-card-title">Pick a Facility</div>
        <div className="dash-card-sub">Pick a facility above to see Rate Management. Rates are set against the competitors around one facility at a time.</div>
      </div>
    );
  }
  if (state.status === 'loading') return <LoadingState size="section" label="Loading rate management" minHeight={240} />;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load rate management." onRetry={load} />;

  const k = v.kpis;
  const ready = v.rows.filter((r) => r.ready);
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6 };

  return (
    <>
      <div className="dash-card">
        <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-secondary, #64748b)', fontWeight: 600 }}>
          Competitive Market Analysis - Confidential
        </div>
        <h2 style={{ margin: '4px 0' }}>{v.name}</h2>
        <div className="dash-card-sub" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
          {v.address && <span>{v.address}</span>}
          <span>Occupancy {k.units ? `${((k.rented / k.units) * 100).toFixed(1)}%` : dash} ({count(k.rented)} of {count(k.units)} units, {count(k.offline)} offline)</span>
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

      {!v.cubbyGroups.ok && (
        <p className="ops-note" role="status" style={{ marginTop: 0 }}>Cubby&apos;s pricing groups could not be read, so Sell and Set show the rent roll&apos;s standard rate.</p>
      )}

      <MarketSummary v={v} onManage={manageCompetitors} />

      <div style={{ background: GREEN, color: '#fff', borderRadius: 12, padding: '14px 18px', margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }} data-testid="ready-bar">
        <div>
          <div style={{ fontWeight: 700 }}>{ready.length} {ready.length === 1 ? 'change' : 'changes'} ready</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            {ready.length ? `${ready.map((r) => `${r.name} ${signed(r.proposed - r.sell)}`).join(' - ')} - ${signed(k.readyDelta)} per month` : 'Type a Proposed rate below, or click a Suggested price, to add one.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setPanel('review')} disabled={!ready.length}
            style={{ background: '#bbf7d0', color: GREEN, border: 'none', borderRadius: 8, padding: '8px 14px', fontWeight: 700, cursor: ready.length ? 'pointer' : 'default', opacity: ready.length ? 1 : 0.6 }}>
            Review Changes
          </button>
        </div>
      </div>
      <p className="ops-note" style={{ marginTop: -8 }}>{pushShown(v) ? (v.pushReady ? PUSH_NOTE : NO_KEY_NOTE) : NO_PUSH_NOTE}</p>

      {error && <p className="ops-form-error" role="alert">{error}</p>}

      <div className="dash-card">
        <div className="dash-card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
          <SectionPicker label="Unit Category" icon={Boxes} value={tab} onChange={setTab}
            options={TABS.map(([key, label]) => ({ value: key, label }))} />
          <div className="dash-card-sub">Click a unit type to see each competitor&apos;s rate for that size. Hover a column name for what it means.</div>
        </div>
        <div className="req-table-wrapper">
          <table className="req-table stack-table rm-table" data-testid="rate-table">
            <thead><tr>
              <Th label="Unit Type" tip={TIPS.unitType} />
              <Th label="Units" tip={TIPS.units} />
              <Th label="Our Rate" tip={TIPS.ourRate} right />
              <Th label="Market" tip={TIPS.market(v.freshDays)} />
              <Th label="Position" tip={TIPS.position} />
              <Th label="Suggested" tip={TIPS.suggested(v.minCompetitors)} />
              <Th label="Proposed" tip={TIPS.proposed} right />
              <Th label="Change per Month" tip={TIPS.change} right />
            </tr></thead>
            <tbody>
              {CATS.filter((c) => tab === 'all' || tab === c).map((c) => {
                const rows = shown.filter((r) => r.category === c);
                if (!rows.length) return null;
                return [
                  <tr key={`h-${c}`} className="rm-cat"><td colSpan={COLS}>{c}</td></tr>,
                  ...rows.map((r) => (
                    <Fragment key={r.name}>
                      <Row r={r} open={open.has(r.name)} onToggle={toggle} canEdit={v.canEdit} onSave={saveDraft}
                        minCompetitors={v.minCompetitors} staleDays={v.staleDays || 30} />
                      {open.has(r.name) && (
                        <tr className="rm-detail-row"><td colSpan={COLS}>
                          <RowDetail r={r} facilityId={facilityId} onHistory={(name) => setPanel({ history: name })} onManage={manageCompetitors} />
                        </td></tr>
                      )}
                    </Fragment>
                  )),
                  <Subtotal key={`s-${c}`} label={c} rows={rows} />,
                ];
              })}
            </tbody>
          </table>
        </div>
        {!shown.length && <div className="ops-empty">No unit types in this category.</div>}
        <p className="ops-note" style={{ marginTop: 10 }}>
          Market is each competitor&apos;s newest regular price from the last {v.freshDays} days. Suggested = the market median, moved by how full we are,
          held to a 10% step from today&apos;s Sell rate; it needs {v.minCompetitors} competitor rates. Change per Month = (Proposed - Sell) x vacant units.
        </p>
      </div>

      {v.pushes?.length > 0 && (
        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Recent Rate Changes</div>
            <div className="dash-card-sub">Rates staff entered in Cubby and marked entered here.</div>
          </div></div>
          <ul className="ops-reports">
            {v.pushes.slice(0, 8).map((p) => (
              <li className="ops-report" key={p.id}>
                <div>
                  <div className="ops-report-title">{p.unitType}: {$(p.oldSell)} &rarr; {$(p.newSell)}</div>
                  <div className="ops-report-about">{formatDateTime(p.pushedAt)} by {p.pushedBy}{p.status === 'failed' || p.status === 'skipped' ? ` - ${p.detail}` : ''}</div>
                </div>
                <span className={`status-badge ${resultOf(p)[0]}`}>{resultOf(p)[1]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showComps && <div ref={compsRef} className="rm-comps-anchor"><Market facility={facility} /></div>}

      {panel === 'review' && (
        <ReviewModal view={v} onClose={() => setPanel(null)} onMarked={setView} onChecklist={(rows) => exportPdf(rows, true)} />
      )}
      {panel?.history !== undefined && <HistoryModal view={v} initial={panel.history} onClose={() => setPanel(null)} />}
    </>
  );
}
