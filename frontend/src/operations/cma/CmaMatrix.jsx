// Rate Management > CMA (Oct 28 2026 call with Neil, B17 / B18): the CMA as
// one input page, laid out like a CubeSmart CMA - every unit type at the
// facility on one line, grouped Self-Storage, Vehicle Storage and Mailboxes,
// our rates, then each competitor's rate (and how far it sits above or below
// our Web Rate) and current promotion, then the market average and our
// variance. Typing a competitor's rate or promotion in its cell records it as
// a manual survey for that unit type (POST /facility-ops/cma/surveys, the same
// path as Add Manual Rate), so it counts from the moment it is saved.
// Compact on purpose (B18): one line per unit type, the header row and the
// unit type column stay put while the rest scrolls (B6).
import { Fragment, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { api } from '../../api';
import { formatDate } from '../../lib/datetime';
import { useRole } from '../../contexts/RoleContext';
import { count } from '../model';
import { CATS } from './CmaOverview';
import { dash, exportRows, occText, sizeOf, toCents, usd } from './cmaModel';
import { ColumnsButton, ExportMenu } from '../ColumnsMenu';
import { arrange } from '../columnControls';
import { useOpsColumns } from '../opsPrefs';

const METHODS = [['phone', 'Phone Call'], ['drive_by', 'Drive-By'], ['walk_in', 'Walk-In'], ['flyer', 'Flyer / Signage']];

// "+8.3%" - the competitor against our Web Rate: plus = they charge more than us.
export function vsOurs(rate, ours) {
  if (rate == null || !ours) return null;
  return (rate - ours) / ours;
}
const vsText = (x) => (x == null ? '' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

function EditCell({ label, value, display, disabled, title, onSave, numeric }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // One save per edit: Enter blurs the box, and a second blur while the save
  // is on its way must not send it again.
  const saving = useRef(false);
  if (editing) {
    const done = async (save) => {
      if (saving.current) return;
      if (!save) { setEditing(false); return; }
      const next = text.trim();
      if (next === String(value ?? '')) { setEditing(false); return; }
      saving.current = true;
      setBusy(true);
      try { if (await onSave(next) !== false) setEditing(false); } finally { saving.current = false; setBusy(false); }
    };
    return (
      <input className="form-input cma-cell-input" autoFocus aria-label={label} value={text} disabled={busy} inputMode={numeric ? 'decimal' : undefined}
        onChange={(e) => setText(e.target.value)} onBlur={() => done(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); done(false); } }} />
    );
  }
  return (
    <button type="button" className="cma-cell-btn" aria-label={label} title={title} disabled={disabled}
      onClick={() => { setText(value == null ? '' : String(value)); setEditing(true); }}>
      {display}
    </button>
  );
}

export default function CmaMatrix({ view: v, onReload }) {
  const role = useRole();
  const [group, setGroup] = useState('all');
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('phone');
  const [by, setBy] = useState(() => (role?.myEmail || '').split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const comps = v.competitors || [];
  // Which competitors show, in which order - the person's own (B5).
  const compCols = useMemo(() => comps.map((c) => ({ key: c.id, label: c.name })), [comps]);
  const [shape, setShape] = useOpsColumns(`cma-matrix:${v.facilityId}`);
  const shownComps = useMemo(() => arrange(compCols, shape).map((c) => comps.find((x) => x.id === c.key)).filter(Boolean), [compCols, shape, comps]);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => v.rows.filter((r) => (group === 'all' || r.category === group)
    && (!needle || `${r.name} ${sizeOf(r)}`.toLowerCase().includes(needle))), [v.rows, group, needle]);
  const ours = (r) => r.algorithmWebRate ?? r.sell;
  const compOf = (r, cid) => (r.comps || []).find((c) => c.competitorId === cid);

  // One cell typed in = one manual survey line for this unit type.
  const record = async (r, c, { rate, special }) => {
    setError(''); setNote('');
    if (!by.trim()) { setError('Say who surveyed it - the Surveyed By box above the table.'); return false; }
    const have = compOf(r, c.id);
    const street = rate !== undefined ? rate : (have?.rate != null ? have.rate / 100 : null);
    if (!street) { setError(`Enter ${c.name}'s rate for ${sizeOf(r)} first; a promotion is kept with a rate.`); return false; }
    const parking = r.parking || r.category === 'Vehicle Storage';
    try {
      await api.saveOpsCmaSurvey({
        facility_id: v.facilityId, competitor_id: c.id, survey_date: v.asOf, method, surveyed_by: by.trim(),
        special: special !== undefined ? special : (have?.promo || ''), admin_fee: null, insurance: '',
        rates: [{ their_size: r.width && r.depth ? `${r.width} x ${r.depth}` : r.name.slice(0, 40), kind: parking ? 'parking' : 'storage',
          street, online: null, matched_unit_type: r.name }],
      });
      setNote(`${c.name}, ${sizeOf(r)}: saved.`);
      onReload();
      return true;
    } catch (err) {
      console.error('Operations: CMA cell could not be saved', err);
      setError(err?.status === 422 && err?.message ? err.message : `${c.name}'s rate for ${sizeOf(r)} could not be saved. Try again.`);
      return false;
    }
  };

  const exportAll = (format) => {
    const cols = [
      { header: 'Group', get: (r) => r.category }, { header: 'Unit Type', get: (r) => r.name },
      { header: 'Units', get: (r) => r.total }, { header: 'Occupancy', get: (r) => occText(r) },
      { header: 'Current Standard Rate', get: (r) => (r.set == null ? '' : r.set / 100) },
      { header: 'Web Rate', get: (r) => (ours(r) == null ? '' : ours(r) / 100) },
      ...shownComps.flatMap((c) => [
        { header: `${c.name} Rate`, get: (r) => { const x = compOf(r, c.id); return x?.rate == null ? '' : x.rate / 100; } },
        { header: `${c.name} vs Us`, get: (r) => { const x = compOf(r, c.id); return vsText(vsOurs(x?.rate, ours(r))); } },
        { header: `${c.name} Promotion`, get: (r) => compOf(r, c.id)?.promo || '' },
      ]),
      { header: 'Market Average', get: (r) => (r.marketAvg == null ? '' : r.marketAvg / 100) },
      { header: 'Variance', get: (r) => (r.variancePct == null ? '' : `${(r.variancePct * 100).toFixed(1)}%`) },
    ];
    exportRows(format === 'xlsx' ? 'xls' : 'csv', { title: 'CMA', facility: v.facility, asOf: v.asOf, columns: cols, rows })
      .catch((err) => { console.error('Operations: CMA export failed', err); setError('The export could not be built. Try again.'); });
  };

  const colSpan = 5 + shownComps.length * 2 + 2;
  return (
    <div className="dash-card cma-matrix-card" data-testid="cma-matrix">
      <div className="cma-matrix-head">
        <p className="cma-matrix-line">
          <strong>{v.name}</strong> - {count(v.rows.length)} unit types, {count(comps.length)} competitors
          - last survey {v.lastSurvey ? formatDate(v.lastSurvey) : 'none yet'}
          {v.billingCycle === 'DAYS_28' ? ' - Cubby rates here are per 28 days' : ''}
        </p>
        <div className="cma-matrix-tools">
          <label className="ops-search" style={{ margin: 0, maxWidth: 200 }}>
            <Search size={13} aria-hidden="true" />
            <input type="search" value={q} placeholder="Find a unit type" aria-label="Find a unit type" onChange={(e) => setQ(e.target.value)} />
          </label>
          <select className="form-input cma-matrix-select" aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="all">All Groups</option>
            {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {v.canEdit && (
            <>
              <select className="form-input cma-matrix-select" aria-label="How the rates were surveyed" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input className="form-input cma-matrix-by" aria-label="Surveyed By" placeholder="Surveyed By" value={by} maxLength={80} onChange={(e) => setBy(e.target.value)} />
            </>
          )}
          <ColumnsButton columns={compCols} shape={shape} onShape={setShape} />
          <button type="button" className="secondary-btn ops-btn-sm" onClick={onReload} aria-label="Reload the CMA"><RefreshCw size={13} aria-hidden="true" /></button>
          <ExportMenu onPick={exportAll} />
        </div>
      </div>
      {error && <p className="cma-error" role="alert">{error}</p>}
      {note && <p className="ops-filter-line" role="status">{note}</p>}
      {v.canEdit && <p className="ops-filter-line">Click a competitor&apos;s rate or promotion to type it; Enter saves it as a {METHODS.find(([k]) => k === method)?.[1].toLowerCase()} survey for today.</p>}

      <div className="req-table-wrapper ops-scroll cma-matrix-wrap">
        <table className="req-table cma-matrix">
          <thead>
            <tr>
              <th rowSpan={2} className="cma-mx-type">Unit Type</th>
              <th rowSpan={2} className="num">Units</th>
              <th rowSpan={2} className="num">Occ.</th>
              <th rowSpan={2} className="num" title="Cubby's standard (in-store) rate">Standard</th>
              <th rowSpan={2} className="num" title="What a new customer pays online - the rate compared with the market">Web Rate</th>
              {shownComps.map((c) => (
                <th key={c.id} colSpan={2} className="cma-mx-comp" title={[c.address, c.distanceMiles != null ? `${c.distanceMiles.toFixed(1)} mi` : ''].filter(Boolean).join(' - ')}>
                  {c.name}{c.distanceMiles != null ? <span className="cma-mx-mi"> {c.distanceMiles.toFixed(1)} mi</span> : null}
                </th>
              ))}
              <th rowSpan={2} className="num" title="Average of the competitors, never including us">Mkt Avg</th>
              <th rowSpan={2} className="num" title="Our Web Rate against the market average">Variance</th>
            </tr>
            <tr>
              {shownComps.map((c) => (
                <Fragment key={c.id}>
                  <th className="num cma-mx-sub">Rate</th>
                  <th className="cma-mx-sub">Promotion</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATS.filter((g) => group === 'all' || g === group).map((g) => {
              const list = rows.filter((r) => r.category === g);
              if (!list.length) return null;
              return (
                <Fragment key={g}>
                  <tr className="cma-mx-group"><td colSpan={colSpan}>{g} <span className="cma-mx-n">{list.length}</span></td></tr>
                  {list.map((r) => {
                    const our = ours(r);
                    return (
                      <tr key={r.name}>
                        <td className="cma-mx-type" title={r.name}>{sizeOf(r)}<span className="cma-mx-sub-name"> {r.name.replace(/^[\d.' x]+/, '').trim()}</span></td>
                        <td className="num">{count(r.total)}</td>
                        <td className="num">{occText(r)}</td>
                        <td className="num">{usd(r.set)}</td>
                        <td className="num"><strong>{usd(our)}</strong></td>
                        {shownComps.map((c) => {
                          const x = compOf(r, c.id);
                          const vs = vsOurs(x?.rate, our);
                          const lab = `${c.name} rate for ${r.name}`;
                          return (
                            <Fragment key={c.id}>
                              <td className="num cma-mx-rate">
                                <EditCell label={lab} numeric value={x?.rate != null ? x.rate / 100 : ''} disabled={!v.canEdit}
                                  title={x ? `${x.source === 'web' || x.source === 'stortrack' ? 'From their website' : 'Entered by hand'}, ${formatDate(x.observedOn)}${x.note ? ` - ${x.note}` : ''}` : 'No rate yet'}
                                  display={x?.rate != null
                                    ? <>{usd(x.rate)} <span className={vs > 0 ? 'cma-mx-up' : vs < 0 ? 'cma-mx-down' : 'cma-mx-even'}>{vsText(vs)}</span></>
                                    : <span className="cma-mx-empty">{dash}</span>}
                                  onSave={async (t) => {
                                    const cents = toCents(t);
                                    if (cents == null) { setError(`Type ${c.name}'s rate as a number, like 129 or 129.50.`); return false; }
                                    return record(r, c, { rate: cents / 100 });
                                  }} />
                              </td>
                              <td className="cma-mx-promo">
                                <EditCell label={`${c.name} promotion for ${r.name}`} value={x?.promo || ''} disabled={!v.canEdit || x?.rate == null}
                                  title={x?.promo || (x?.rate == null ? 'Enter a rate first' : 'No promotion')}
                                  display={x?.promo ? <span className="cma-mx-promo-t">{x.promo}</span> : <span className="cma-mx-empty">{dash}</span>}
                                  onSave={(t) => record(r, c, { special: t.slice(0, 200) })} />
                              </td>
                            </Fragment>
                          );
                        })}
                        <td className="num">{usd(r.marketAvg)}</td>
                        <td className={`num${r.variance < 0 ? ' cma-below' : ''}`}>{r.variancePct == null ? dash : vsText(r.variancePct)}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="ops-empty">No unit type matches.</div>}
      </div>
      <p className="ops-note" style={{ marginTop: 8 }}>
        A competitor&apos;s percent is their rate against our Web Rate: plus means they charge more than we do. Closed competitors are left out of the market average.
      </p>
    </div>
  );
}
