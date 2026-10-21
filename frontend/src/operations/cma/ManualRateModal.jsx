// "Add Manual Rate" for ONE pricing group, opened from its competitor panel on
// the CMA Overview (Miranda, Oct 21: add data by hand while looking at the
// pricing group, not somewhere further down the page). It saves a manual
// survey (POST /facility-ops/cma/surveys) with this one rate matched to the
// pricing group, so it counts for it straight away.
import { useState } from 'react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { sizeOf } from './cmaModel';

const METHODS = [['phone', 'Phone Call'], ['drive_by', 'Drive-By'], ['walk_in', 'Walk-In / Mystery Shop'], ['flyer', 'Flyer / Signage']];
const NEW = '__new__';

export default function ManualRateModal({ view, row, onClose, onSaved }) {
  const comps = view.competitors || [];
  const parking = row.parking || row.category === 'Vehicle Storage';
  const [f, setF] = useState({
    competitor: comps[0]?.id || NEW, newName: '', date: view.asOf, method: 'phone', by: '',
    size: row.width && row.depth ? `${row.width} x ${row.depth}` : '', street: '', online: '', special: '', fee: '', insurance: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = async () => {
    setError('');
    if (f.competitor === NEW && !f.newName.trim()) { setError('Give the new competitor a name.'); return; }
    if (!f.by.trim()) { setError('Say who surveyed it.'); return; }
    if (!(Number(f.street) > 0) && !(Number(f.online) > 0)) { setError('Enter the street or online rate they quoted.'); return; }
    if (!f.size.trim()) { setError('Enter their size as quoted, like 10 x 20.'); return; }
    setBusy(true);
    try {
      let cid = f.competitor;
      if (cid === NEW) {
        const cs = await api.addOpsCmaCompetitor({ facility_id: view.facilityId, name: f.newName.trim(), price_source: 'manual' });
        cid = (cs.competitors || []).find((c) => c.name === f.newName.trim() && !c.closed)?.id;
        if (!cid) throw new Error('The new competitor could not be found after saving.');
      }
      await api.saveOpsCmaSurvey({
        facility_id: view.facilityId, competitor_id: cid, survey_date: f.date, method: f.method, surveyed_by: f.by.trim(),
        special: f.special.trim(), admin_fee: f.fee === '' ? null : Number(f.fee), insurance: f.insurance.trim(),
        rates: [{ their_size: f.size.trim(), kind: parking ? 'parking' : 'storage', street: Number(f.street) > 0 ? Number(f.street) : null,
          online: Number(f.online) > 0 ? Number(f.online) : null, matched_unit_type: row.name }],
      });
      onSaved();
    } catch (err) {
      console.error('Operations: manual rate could not be saved', err);
      setError(err?.status === 422 && err?.message ? err.message : 'The rate could not be saved. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Add Manual Rate - ${sizeOf(row)} ${parking ? 'Parking' : 'Storage'}`} onClose={onClose} width="60vw" minHeight="60vh"
      isDirty={!!(f.street || f.online || f.newName)}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save Rate'}</button>
      </>}>
      <p className="cma-note" style={{ marginTop: 0 }}>
        This rate counts for <strong>{row.name}</strong> (our Web Rate {row.sell == null ? '-' : `$${(row.sell / 100).toFixed(2)}`}) from today. It is saved as a manual survey, so it also shows under Comp Set &amp; Manual Entry.
      </p>
      <div className="cma-form">
        <label>Competitor
          <select className="form-input" value={f.competitor} onChange={set('competitor')} aria-label="Competitor">
            {comps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW}>+ New Competitor</option>
          </select>
        </label>
        {f.competitor === NEW && (
          <label>New Competitor Name<input className="form-input" value={f.newName} onChange={set('newName')} maxLength={120} placeholder="Tri-City Boat & RV Storage" /></label>
        )}
        <label>Survey Date<input className="form-input" type="date" value={f.date} max={view.asOf} onChange={set('date')} /></label>
        <label>Method
          <select className="form-input" value={f.method} onChange={set('method')}>
            {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>Surveyed By<input className="form-input" value={f.by} onChange={set('by')} maxLength={80} placeholder="JW" /></label>
        <label>Their Size<input className="form-input" value={f.size} onChange={set('size')} maxLength={40} placeholder="12 x 32" /></label>
        <label>Street Rate ($)<input className="form-input" inputMode="decimal" value={f.street} onChange={set('street')} placeholder="110" /></label>
        <label>Online Rate ($)<input className="form-input" inputMode="decimal" value={f.online} onChange={set('online')} placeholder="Optional" /></label>
        <label>Current Special<input className="form-input" value={f.special} onChange={set('special')} maxLength={200} placeholder="1st month $1" /></label>
        <label>Admin Fee ($)<input className="form-input" inputMode="decimal" value={f.fee} onChange={set('fee')} placeholder="Optional" /></label>
        <label>Insurance / Protection<input className="form-input" value={f.insurance} onChange={set('insurance')} maxLength={120} placeholder="$ / month, required?" /></label>
      </div>
      {error && <p className="cma-error" role="alert">{error}</p>}
    </Modal>
  );
}
