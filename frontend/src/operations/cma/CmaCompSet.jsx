// Comp Set & Manual Entry (Miranda's mockup, artboard 2): the competitors with
// their source (Website / Manual / Closed - closed ones struck through and
// out of every average, kept for history), a survey form with rates by unit
// (their size as quoted, matched to our nearest unit type), a website price
// override with a 30-day lock, the Website / Manual Only price source, and
// manual rates imported from a CSV / XLS sheet. Backend: routers/ops_cma.py.
// The website reader and the nearby list stay the Market screen's, opened
// from "Website Reading & Nearby".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Globe, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, LoadingState } from '../../components/AsyncState';
import { Modal } from '../../tasks/components';
import { formatDate } from '../../lib/datetime';
import Market from '../Market';
import { IMPORT_COLUMNS, dash, downloadImportTemplate, exportRows, nearestType, sheetToObjects, usd } from './cmaModel';

const BADGE = { website: 'Website', manual: 'Manual', closed: 'Closed' };
let rowSeq = 0;
const blankRow = () => ({ id: (rowSeq += 1), size: '', kind: 'storage', access: '', street: '', online: '', match: '', note: '' });

const COMPSET_COLUMNS = [
  { header: 'Competitor', get: (x) => x.c.name, width: 28 },
  { header: 'Status', get: (x) => BADGE[x.c.badge], width: 10 },
  { header: 'Distance (Mi)', get: (x) => (x.c.distanceMiles == null ? '' : x.c.distanceMiles), width: 12 },
  { header: 'Address', get: (x) => x.c.address, width: 30 },
  { header: 'Phone', get: (x) => x.c.phone, width: 14 },
  { header: 'Their Size', get: (x) => x.r?.theirSize || '', width: 12 },
  { header: 'Surface / Access', get: (x) => x.r?.access || '', width: 18 },
  { header: 'Street Rate', get: (x) => (x.r ? usd(x.r.street) : ''), width: 12 },
  { header: 'Online Rate', get: (x) => (x.r?.online ? usd(x.r.online) : ''), width: 12 },
  { header: 'Compares To', get: (x) => x.r?.matchedUnitType || '', width: 22 },
  { header: 'Source', get: (x) => x.r?.source || '', width: 10 },
  { header: 'Observed', get: (x) => (x.r ? formatDate(x.r.observedOn) : ''), width: 12 },
  { header: 'Current Special', get: (x) => x.c.lastSurvey?.special || '', width: 28 },
  { header: 'Admin Fee', get: (x) => (x.c.lastSurvey?.adminFee == null ? '' : usd(x.c.lastSurvey.adminFee)), width: 10 },
  { header: 'Insurance', get: (x) => x.c.lastSurvey?.insurance || '', width: 18 },
];

function Badge({ c }) {
  return <span className={`cma-badge cma-badge-${c.badge}`}>{BADGE[c.badge]}</span>;
}

function CompetitorCard({ c, on, onPick }) {
  const bits = [c.distanceMiles == null ? 'Distance not recorded' : `${c.distanceMiles.toFixed(1)} mi`];
  if (c.closed) bits.push('Excluded from averages · kept for history');
  else {
    if (c.propertyType) bits.push(c.propertyType);
    if (c.lastSurvey) bits.push(`last survey ${formatDate(c.lastSurvey.date)}`);
    if (c.syncedOn) bits.push(`synced ${formatDate(c.syncedOn)}`);
    if (c.lockedOverrides) bits.push(`${c.lockedOverrides} locked ${c.lockedOverrides === 1 ? 'override' : 'overrides'}`);
  }
  return (
    <li>
      <button type="button" className={`cma-card${c.closed ? ' cma-card-closed' : ''}`} aria-pressed={on} onClick={() => onPick(c.id)}>
        <div className="cma-card-name"><span>{c.name}</span><Badge c={c} /></div>
        <div className="cma-card-sub">{bits.join(' · ')}</div>
      </button>
    </li>
  );
}

// The survey form for one competitor (mockup: survey fields + Rates by Unit).
function SurveyForm({ data, c, onSaved }) {
  const [f, setF] = useState({ date: data.asOf, method: 'phone', by: '', special: c.lastSurvey?.special || '',
    fee: c.lastSurvey?.adminFee == null ? '' : String(c.lastSurvey.adminFee / 100), insurance: c.lastSurvey?.insurance || '' });
  const [rows, setRows] = useState([blankRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setRow = (i, k, val) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: val, ...(k === 'kind' ? { access: '' } : {}) } : r)));
  const auto = (r) => nearestType(r.size, r.kind === 'parking', data.unitTypes);
  const save = async (e) => {
    e.preventDefault();
    setError('');
    const filled = rows.filter((r) => r.size.trim() || r.street || r.online);
    if (!f.by.trim()) { setError('Say who surveyed it.'); return; }
    setBusy(true);
    try {
      onSaved(await api.saveOpsCmaSurvey({
        facility_id: data.facilityId, competitor_id: c.id, survey_date: f.date, method: f.method, surveyed_by: f.by.trim(),
        special: f.special.trim(), admin_fee: f.fee === '' ? null : Number(f.fee), insurance: f.insurance.trim(),
        rates: filled.map((r) => ({ their_size: r.size.trim(), kind: r.kind, access: r.access,
          street: Number(r.street) > 0 ? Number(r.street) : null, online: Number(r.online) > 0 ? Number(r.online) : null,
          matched_unit_type: r.match || '', note: r.note.trim() })),
      }));
      setRows([blankRow()]);
    } catch (err) {
      console.error('Operations: survey could not be saved', err);
      setError(err?.status === 422 && err?.message ? err.message : 'The survey could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} data-testid="survey-form">
      <div className="cma-form">
        <label>Survey Date<input className="form-input" type="date" value={f.date} max={data.asOf} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label>Method
          <select className="form-input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {Object.entries(data.methods).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>Surveyed By<input className="form-input" value={f.by} maxLength={80} onChange={(e) => setF({ ...f, by: e.target.value })} placeholder="JW" /></label>
        <label>Current Special<input className="form-input" value={f.special} maxLength={200} onChange={(e) => setF({ ...f, special: e.target.value })} placeholder="1st month $1, no increase for 1 year" /></label>
        <label>Admin Fee ($)<input className="form-input" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} placeholder="25" /></label>
        <label>Insurance / Protection<input className="form-input" value={f.insurance} maxLength={120} onChange={(e) => setF({ ...f, insurance: e.target.value })} placeholder="$ / month, required?" /></label>
      </div>
      <div className="cma-panel" style={{ marginTop: 14 }}>
        <div className="cma-panel-head">
          <div>
            <h4 className="cma-h3">Rates by Unit</h4>
            <div className="cma-sub">Enter their size as quoted - Nexus matches it to our nearest unit type.</div>
          </div>
        </div>
        <div className="req-table-wrapper">
          <table className="req-table stack-table cma-table cma-rates-table">
            <thead><tr>
              <th>Their Size</th><th>Kind</th><th>Surface / Access</th><th className="num">Street Rate</th><th className="num">Online Rate</th>
              <th>Compares To Our...</th><th>Note</th><th aria-label="Remove" />
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const a = auto(r);
                return (
                  <tr key={r.id}>
                    <td data-th="Their Size"><input className="form-input" value={r.size} onChange={(e) => setRow(i, 'size', e.target.value)} placeholder="8 x 10" aria-label={`Row ${i + 1} their size`} /></td>
                    <td data-th="Kind">
                      <select className="form-input" value={r.kind} onChange={(e) => setRow(i, 'kind', e.target.value)} aria-label={`Row ${i + 1} kind`}>
                        <option value="storage">Storage</option><option value="parking">Parking</option>
                      </select>
                    </td>
                    <td data-th="Surface / Access">
                      <select className="form-input" value={r.access} onChange={(e) => setRow(i, 'access', e.target.value)} aria-label={`Row ${i + 1} surface or access`}>
                        <option value="">-</option>
                        {(r.kind === 'parking' ? data.parkingAccess : data.storageAccess).map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </td>
                    <td data-th="Street Rate"><input className="form-input" inputMode="decimal" value={r.street} onChange={(e) => setRow(i, 'street', e.target.value)} placeholder="$" aria-label={`Row ${i + 1} street rate`} /></td>
                    <td data-th="Online Rate"><input className="form-input" inputMode="decimal" value={r.online} onChange={(e) => setRow(i, 'online', e.target.value)} placeholder="$" aria-label={`Row ${i + 1} online rate`} /></td>
                    <td data-th="Compares To">
                      <select className="form-input" value={r.match} onChange={(e) => setRow(i, 'match', e.target.value)} aria-label={`Row ${i + 1} compares to`}>
                        <option value="">{a.name ? `Auto: ${a.name}` : 'Auto (enter a size)'}</option>
                        {data.unitTypes.filter((t) => (r.kind === 'parking') === t.parking).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                      </select>
                    </td>
                    <td data-th="Note"><input className="form-input" value={r.note} onChange={(e) => setRow(i, 'note', e.target.value)}
                      placeholder={!r.match && a.name && !a.exact ? a.note : 'Optional'} aria-label={`Row ${i + 1} note`} /></td>
                    <td>
                      <button type="button" className="icon-btn" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [blankRow()]))}><X size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="cma-actions">
          <button type="button" className="secondary-btn cma-btn" onClick={() => setRows((rs) => [...rs, blankRow()])}><Plus size={14} aria-hidden="true" /> Add Unit Size</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={() => setRows([blankRow()])}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving' : 'Save Survey'}</button>
        </div>
        {error && <p className="cma-error" role="alert">{error}</p>}
      </div>
    </form>
  );
}

// "Adjusting a website price": use another rate for one size, locked 30 days.
function OverrideCard({ data, c, onSaved }) {
  const web = c.rates.filter((r) => r.source === 'web' || r.source === 'stortrack');
  const [pick, setPick] = useState(0);
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const [lock, setLock] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!web.length) return null;
  const r = web[Math.min(pick, web.length - 1)];
  const save = async () => {
    setError('');
    if (!(Number(rate) > 0)) { setError('Enter the rate to use instead.'); return; }
    if (!reason.trim()) { setError('Give a reason, like "Phone quote lower than site".'); return; }
    setBusy(true);
    try {
      onSaved(await api.saveOpsCmaOverride({ competitor_id: c.id, width: r.width, depth: r.depth, parking: r.parking,
        rate: Number(rate), reason: reason.trim(), lock }));
      setRate(''); setReason('');
    } catch (err) {
      console.error('Operations: override could not be saved', err);
      setError('The override could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <div className="cma-panel" style={{ marginTop: 14 }} data-testid="override-card">
      <div className="cma-panel-head"><div>
        <h4 className="cma-h3">Adjusting a Website Price</h4>
        <div className="cma-sub">Use another rate for one of {c.name}&apos;s sizes, for example after a phone quote.</div>
      </div></div>
      <div className="cma-form">
        <label>Unit
          <select className="form-input" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {web.map((x, i) => <option key={x.id} value={i}>{x.theirSize}{x.parking ? ' parking' : ''}{x.access ? ` - ${x.access}` : ''}</option>)}
          </select>
        </label>
        <label>Website Shows<input className="form-input" readOnly value={`${usd(r.street)} · synced ${formatDate(r.observedOn)}`} /></label>
        <label>Use This Rate Instead ($)<input className="form-input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. after a phone quote" /></label>
        <label>Reason<input className="form-input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Phone quote lower than site" /></label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginTop: 10 }}>
        <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
        Lock this value - don&apos;t overwrite on the next website sync (unlocks automatically after {data.lockDays} days)
      </label>
      <div className="cma-actions"><button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save Override'}</button></div>
      {error && <p className="cma-error" role="alert">{error}</p>}
    </div>
  );
}

function AddCompetitorModal({ data, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', address: '', phone: '', website: '', distance: '', type: '', manual: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f.name.trim()) { setError('Give the competitor a name.'); return; }
    setBusy(true);
    try {
      onSaved(await api.addOpsCmaCompetitor({ facility_id: data.facilityId, name: f.name.trim(), address: f.address, phone: f.phone,
        website: f.website, distance_miles: f.distance === '' ? null : Number(f.distance), property_type: f.type,
        price_source: f.manual ? 'manual' : 'website' }));
    } catch (err) {
      console.error('Operations: competitor could not be added', err);
      setError('The competitor could not be added. Try again.');
    } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add Competitor" onClose={onClose} width="60vw" minHeight="60vh" footer={<>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Add Competitor'}</button>
    </>}>
      <div className="cma-form">
        <label>Name<input className="form-input" value={f.name} maxLength={120} onChange={set('name')} placeholder="Sav On Storage" /></label>
        <label>Address<input className="form-input" value={f.address} maxLength={240} onChange={set('address')} /></label>
        <label>Phone<input className="form-input" value={f.phone} maxLength={40} onChange={set('phone')} /></label>
        <label>Website<input className="form-input" value={f.website} maxLength={300} onChange={set('website')} placeholder="Optional" /></label>
        <label>Miles Away<input className="form-input" type="number" min="0" step="0.1" value={f.distance} onChange={set('distance')} /></label>
        <label>Property Type<input className="form-input" value={f.type} maxLength={80} onChange={set('type')} placeholder="Self-Storage & RV Storage" /></label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginTop: 12 }}>
        <input type="checkbox" checked={f.manual} onChange={(e) => setF({ ...f, manual: e.target.checked })} /> Manual only (no website to read)
      </label>
      {error && <p className="cma-error" role="alert">{error}</p>}
    </Modal>
  );
}

// CSV / XLS import with a preview and row-level errors (POST /cma/import).
export function ImportModal({ data, onClose, onDone }) {
  const [rows, setRows] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(''); setCheck(null); setBusy('read');
    try {
      const { readSheetFile } = await import('../../components/accounting/statementImport');
      const objs = sheetToObjects(await readSheetFile(file));
      if (!objs.length) { setError('That sheet has no rows under its header.'); return; }
      setRows(objs);
      setCheck(await api.importOpsCmaRates(data.facilityId, objs, false));
    } catch (err) {
      console.error('Operations: import could not be read', err);
      setError('That file could not be read. Save it as CSV or XLSX and try again.');
    } finally { setBusy(''); }
  };
  const commit = async () => {
    setBusy('save');
    try {
      const out = await api.importOpsCmaRates(data.facilityId, rows, true);
      onDone(out.saved, out.errors);
    } catch (err) {
      console.error('Operations: import could not be saved', err);
      setError('The rates could not be saved. Nothing was imported. Try again.');
    } finally { setBusy(''); }
  };
  return (
    <Modal title="Import Manual Rates" onClose={onClose} width="60vw" minHeight="60vh" footer={<>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" onClick={commit} disabled={!check?.ok || !!busy}>
        {busy === 'save' ? 'Saving' : `Save ${check?.ok || 0} ${check?.ok === 1 ? 'Row' : 'Rows'}`}
      </button>
    </>}>
      <p className="cma-note" style={{ marginTop: 0 }}>
        A CSV or Excel sheet with the columns {data.importColumns.join(', ')}. Competitors must already be in this comp set; dates are MM/DD/YYYY.
        Rows with errors are skipped.
      </p>
      <div className="cma-actions" style={{ marginTop: 0 }}>
        <label className="secondary-btn cma-btn" style={{ cursor: 'pointer' }}>
          <Upload size={14} aria-hidden="true" /> Choose File
          <input type="file" accept=".csv,.xlsx,.xls" onChange={pickFile} style={{ display: 'none' }} aria-label="Choose a CSV or XLS file" />
        </label>
        <button type="button" className="secondary-btn cma-btn" onClick={() => downloadImportTemplate(data.facility)}><Download size={14} aria-hidden="true" /> Download Template</button>
      </div>
      {busy === 'read' && <LoadingState compact label="Checking the rows" />}
      {error && <p className="cma-error" role="alert">{error}</p>}
      {check && (
        <>
          <p className="cma-note"><strong>{check.ok}</strong> ready to import, <strong>{check.errors}</strong> with errors.</p>
          <div className="req-table-wrapper">
            <table className="req-table stack-table cma-table" data-testid="import-preview">
              <thead><tr><th className="num">Row</th><th>Competitor</th><th>Size</th><th className="num">Street</th><th>Compares To</th><th>Date</th><th>Check</th></tr></thead>
              <tbody>
                {check.rows.map((r) => (
                  <tr key={r.row}>
                    <td className="num">{r.row}</td>
                    <td data-th="Competitor">{r.competitor || dash}</td>
                    <td data-th="Size">{r.width ? `${r.width} x ${r.depth}${r.parking ? ' parking' : ''}` : dash}</td>
                    <td className="num" data-th="Street">{usd(r.street)}</td>
                    <td data-th="Compares To">{r.matchedUnitType || dash}</td>
                    <td data-th="Date">{r.observedOn ? formatDate(r.observedOn) : dash}</td>
                    <td data-th="Check">{r.ok ? <span className="status-badge status-approved">Ready</span>
                      : <span className="cma-error" style={{ margin: 0 }}>{r.errors.join('; ')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function CmaCompSet({ facility, onSection }) {
  const facilityId = facility?.id;
  const [state, setState] = useState({ status: 'loading', data: null });
  const [picked, setPicked] = useState('');
  const [modal, setModal] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setState({ status: 'ready', data: await api.getOpsCmaCompset(facilityId) }); } catch (err) {
      console.error('Operations: comp set could not be loaded', err);
      setState({ status: 'error', data: null });
    }
  }, [facilityId]);
  useEffect(() => { load(); }, [load]);
  const d = state.data;
  const sel = useMemo(() => d && (d.competitors.find((c) => c.id === picked) || d.competitors[0]), [d, picked]);
  if (state.status === 'loading') return <LoadingState size="section" label="Loading the competitive set" minHeight={240} />;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load the competitive set." onRetry={load} />;
  const saved = (data) => { setState({ status: 'ready', data }); setError(''); };
  const act = async (fn, failed) => {
    setError('');
    try { saved(await fn()); } catch (err) { console.error('Operations: comp set change failed', err); setError(failed); }
  };
  const reimport = async () => {
    setNote('Re-importing the competitor set from Cubby');
    try {
      await api.syncOpsStorTrack(facilityId);
      setNote('Re-imported from Cubby (its StorTrack market feed). New competitors appear as Website.');
      load();
    } catch (err) {
      console.error('Operations: re-import failed', err);
      setNote(err?.status === 409 ? 'A re-import is already running. The list will update when it finishes.'
        : err?.status === 401 ? 'Re-importing from Cubby needs a manager.' : "Cubby's market data could not be read just now. Try again in a few minutes.");
    }
  };
  const exportSet = (format) => {
    const rows = d.competitors.flatMap((c) => (c.rates.length ? c.rates.map((r) => ({ c, r })) : [{ c, r: null }]));
    exportRows(format, { title: 'CMA Comp Set', facility: d.facility, asOf: d.asOf, columns: COMPSET_COLUMNS, rows })
      .catch((err) => { console.error('Operations: comp set export failed', err); setError('The export could not be built. Try again.'); });
  };

  return (
    <>
      <div className="dash-card" data-testid="cma-compset">
        <div className="cma-crumb"><button type="button" onClick={() => onSection('overview')}>CMA · {d.facility}</button> / Comp Set &amp; Manual Entry</div>
        <h2 className="cma-title">{d.facility} Competitive Set</h2>
        <div className="cma-sub">Competitors from Cubby&apos;s market data and the facilities around this one. Website comps are read daily; manual comps are entered here after a call or drive-by.</div>
        <div className="cma-actions">
          <button type="button" className="secondary-btn cma-btn" onClick={reimport}><RefreshCw size={14} aria-hidden="true" /> Re-Import From Cubby</button>
          <button type="button" className="primary-btn cma-btn" onClick={() => setModal('add')}><Plus size={14} aria-hidden="true" /> Add Competitor</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => setModal('import')}><Upload size={14} aria-hidden="true" /> Import Rates (CSV / XLS)</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => setModal('web')}><Globe size={14} aria-hidden="true" /> Website Reading &amp; Nearby</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => exportSet('csv')}><Download size={14} aria-hidden="true" /> Export CSV</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => exportSet('xls')}><Download size={14} aria-hidden="true" /> Export XLS</button>
        </div>
        {note && <p className="cma-note" role="status">{note}</p>}
        {error && <p className="cma-error" role="alert">{error}</p>}
      </div>

      <div className="cma-split">
        <section className="cma-panel" aria-label="Competitors">
          <div className="cma-eyebrow" style={{ marginBottom: 8 }}>{d.competitors.length} {d.competitors.length === 1 ? 'Competitor' : 'Competitors'}</div>
          {d.competitors.length === 0 ? <div className="ops-empty">No competitors yet. Add one, or re-import from Cubby.</div> : (
            <ul className="cma-list">
              {d.competitors.map((c) => <CompetitorCard key={c.id} c={c} on={sel?.id === c.id} onPick={setPicked} />)}
            </ul>
          )}
        </section>

        {sel && (
          <section className="cma-panel" aria-label={sel.name} key={sel.id}>
            <div className="cma-panel-head">
              <div>
                <h3 className="cma-h3" style={sel.closed ? { textDecoration: 'line-through' } : undefined}>{sel.name}</h3>
                <div className="cma-sub">{[sel.address, sel.phone, sel.propertyType].filter(Boolean).join(' · ') || 'No address or phone on file'}</div>
                {sel.closed && <div className="cma-sub">Closed{sel.closedNote ? ` - ${sel.closedNote}` : ''}. Excluded from every average, kept for history.</div>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {!sel.closed && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>Price Source
                    <span className="cma-toggle" role="group" aria-label="Price source">
                      {[['website', 'Website'], ['manual', 'Manual Only']].map(([k, l]) => (
                        <button key={k} type="button" aria-pressed={sel.priceSource === k}
                          onClick={() => sel.priceSource !== k && act(() => api.updateOpsCmaCompetitor(sel.id, { price_source: k }), 'The price source could not be changed. Try again.')}>{l}</button>
                      ))}
                    </span>
                  </span>
                )}
                <button type="button" className="secondary-btn cma-btn" onClick={() => {
                  if (sel.closed) { act(() => api.closeOpsCmaCompetitor(sel.id, false), 'The competitor could not be reopened. Try again.'); return; }
                  const why = window.prompt(`Mark ${sel.name} closed? It is kept for history and left out of every average. A note (optional):`, '');
                  if (why !== null) act(() => api.closeOpsCmaCompetitor(sel.id, true, why), 'The competitor could not be closed. Try again.');
                }}><Trash2 size={14} aria-hidden="true" /> {sel.closed ? 'Reopen' : 'Mark Closed'}</button>
              </div>
            </div>

            {sel.rates.length > 0 && (
              <div className="req-table-wrapper" style={{ marginBottom: 14 }}>
                <table className={`req-table stack-table cma-table${sel.closed ? ' cma-struck' : ''}`} data-testid="current-rates">
                  <thead><tr><th>Their Size</th><th>Surface / Access</th><th className="num">Street</th><th className="num">Online</th><th>Compares To</th><th>Source</th><th>Seen</th></tr></thead>
                  <tbody>
                    {sel.rates.map((r) => (
                      <tr key={r.id}>
                        <td>{r.theirSize}{r.parking ? ' parking' : ''}</td>
                        <td data-th="Surface / Access">{r.access || dash}</td>
                        <td className="num" data-th="Street">{usd(r.street)}</td>
                        <td className="num" data-th="Online">{r.online ? usd(r.online) : dash}</td>
                        <td data-th="Compares To">{r.matchedUnitType || 'By size'}{r.note ? <div className="cma-type-sub">{r.note}</div> : null}</td>
                        <td data-th="Source">{r.source === 'override' ? `Override${r.lockedUntil ? ` (locked until ${formatDate(r.lockedUntil)})` : ''}` : r.source === 'web' || r.source === 'stortrack' ? 'Website' : 'Manual'}</td>
                        <td data-th="Seen">{formatDate(r.observedOn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!sel.closed && <SurveyForm data={d} c={sel} onSaved={saved} />}
            {!sel.closed && <OverrideCard data={d} c={sel} onSaved={saved} />}
          </section>
        )}
      </div>

      {modal === 'add' && <AddCompetitorModal data={d} onClose={() => setModal('')} onSaved={(data) => { saved(data); setModal(''); }} />}
      {modal === 'import' && (
        <ImportModal data={{ ...d, importColumns: IMPORT_COLUMNS }}
          onClose={() => setModal('')} onDone={(n, skipped) => { setModal(''); setNote(`Imported ${n} ${n === 1 ? 'rate' : 'rates'}${skipped ? `, ${skipped} rows skipped` : ''}.`); load(); }} />
      )}
      {modal === 'web' && (
        <Modal title="Website Reading & Nearby Facilities" onClose={() => { setModal(''); load(); }} width="60vw" minHeight="60vh">
          <Market facility={facility} />
        </Modal>
      )}
    </>
  );
}
