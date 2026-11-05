// What the job hands over, and what it tracks on the way (Neil, 11/03/2026,
// plan phase 3; Round Two, 11/05/2026): warranties, permits and inspections,
// as-built and O&M documents - one list and one Add form, shown whole on the
// Closeout tab and as permits and inspections only on the Permits And
// Inspections tab. An inspection carries the day it is scheduled for (the
// superintendent is belled the day before) and its result (Failed bells the
// managers); a permit the day it expires. Close Out writes each record to the
// property in Asset Management; one already there is that module's row.
import { useState } from 'react';
import { Plus, Building2 } from 'lucide-react';
import { api } from '../../api';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { DateField } from '../../tasks/components';
import { formatDate } from '../../lib/datetime';
import { CARD, TONE } from '../ui';
import { clientId } from '../lib/job';

export const KIND_LABEL = { warranty: 'Warranty', permit: 'Permit', inspection: 'Inspection', document: 'Document' };
export const RESULT = { passed: ['Passed', TONE.green], failed: ['Failed', TONE.red], partial: ['Partial', TONE.yellow], pending: ['Pending', TONE.slate] };
const DOC_CATS = [['as_built', 'As-Built'], ['om_manual', 'O&M Manual'], ['certificate', 'Certificate of Occupancy'], ['other', 'Other']];
const quiet = { fontSize: '0.82rem', color: 'var(--text-secondary)' };

function AddRecord({ project, kinds, onAdded }) {
  const [kind, setKind] = useState(kinds[0]);
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.addCloseoutRecord(project.id, { id: clientId('rec'), kind, ...f }); setF({}); onAdded(); }
    catch (err) { setError(err.message || 'Could not add that.'); }
    setBusy(false);
  };
  const input = (k, label, ph = '') => (
    <label className="form-label" style={{ margin: 0 }}>{label}<input className="form-input" value={f[k] || ''} onChange={set(k)} placeholder={ph} /></label>
  );
  const date = (k, label) => (
    <div><span className="form-label" style={{ display: 'block' }}>{label}</span><DateField value={f[k] || ''} onChange={(v) => setF((x) => ({ ...x, [k]: v || '' }))} title={label} /></div>
  );
  return (
    <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }} aria-label="Add a Record">
      {kinds.length > 1 && (
        <div role="group" aria-label="Kind" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {kinds.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setF({}); }}
              className={kind === k ? 'primary-btn' : 'secondary-btn'} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>{KIND_LABEL[k]}</button>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {kind === 'warranty' && <>{input('title', 'Item Covered', 'e.g. Gate motor')}{input('vendor', 'Vendor')}{date('start_on', 'Start')}{date('end_on', 'End')}{input('serial', 'Serial (optional)')}{input('item_id', 'Items Id (optional)', 'For equipment in Items')}</>}
        {kind === 'permit' && <>{input('number', 'Permit Number')}{input('ahj', 'Authority (AHJ)')}{input('title', 'What It Covers')}{date('date_on', 'Issued or Finaled')}{date('end_on', 'Expires')}</>}
        {kind === 'inspection' && <>{input('title', 'Inspection', 'e.g. Final building')}{input('ahj', 'Authority (AHJ)')}{date('due_on', 'Scheduled For')}{date('date_on', 'Inspected On')}</>}
        {kind === 'document' && <>{input('title', 'Title', 'e.g. As-built set')}{date('date_on', 'Document Date')}</>}
        {(kind === 'permit' || kind === 'inspection') && (
          <label className="form-label" style={{ margin: 0 }}>Result
            <select className="form-input" value={f.result || ''} onChange={set('result')}>
              <option value="">Not Known</option>
              {Object.entries(RESULT).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
        {kind === 'document' && (
          <label className="form-label" style={{ margin: 0 }}>Category
            <select className="form-input" value={f.category || 'other'} onChange={set('category')}>
              {DOC_CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
      </div>
      {input('notes', 'Notes')}
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
      <div><button type="submit" className="primary-btn" disabled={busy}><Plus size={14} />{busy ? 'Adding…' : `Add ${KIND_LABEL[kind]}`}</button></div>
    </form>
  );
}

export function describe(r) {
  if (r.kind === 'warranty') return [r.vendor, r.startOn || r.endOn ? `${formatDate(r.startOn, '-')} to ${formatDate(r.endOn, '-')}` : '', r.itemName ? `Item: ${r.itemName}` : '', r.serial ? `Serial ${r.serial}` : ''];
  if (r.kind === 'permit') return [r.number ? `No. ${r.number}` : '', r.ahj, r.dateOn ? formatDate(r.dateOn, '') : '', r.endOn ? `Expires ${formatDate(r.endOn, r.endOn)}` : ''];
  if (r.kind === 'inspection') return [r.ahj, r.dueOn ? `Scheduled ${formatDate(r.dueOn, r.dueOn)}` : '', r.dateOn ? `Inspected ${formatDate(r.dateOn, r.dateOn)}` : ''];
  return [(DOC_CATS.find(([k]) => k === r.category) || [0, 'Other'])[1], r.dateOn ? formatDate(r.dateOn, '') : ''];
}

export default function HandoverRecords({ project, data, reload, kinds = Object.keys(KIND_LABEL), title = 'Handed Over', blurb = null, icon: Icon = Building2 }) {
  const records = (data.records || []).filter((r) => kinds.includes(r.kind));
  const setResult = (r, result) => api.updateCloseoutRecord(r.id, { result }).then(reload).catch(() => {});
  return (
    <section style={{ ...CARD, marginBottom: 14 }} aria-label={title}>
      <h3 style={{ fontSize: '1.05rem', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><Icon size={16} />{title}</h3>
      <p style={{ ...quiet, margin: '0 0 12px' }}>
        {blurb || (data.property ? <>Close Out adds these to <b>{data.property.name}</b> in Asset Management{data.property.canWrite ? '' : ' (someone with edit access there has to close out, or send them later)'}; an equipment warranty also goes on its item in Items.</>
          : 'Link the job to a property (Edit Job) so Close Out can add these to Asset Management.')}
      </p>
      {records.length === 0 ? <div style={quiet}>{kinds.length === 2 ? 'Nothing yet. Add the permits pulled and the inspections scheduled for this job.' : 'Nothing yet. Add the warranties, permits, inspections and documents the owner receives.'}</div>
        : records.map((r) => {
          const res = RESULT[r.result];
          const mayDecide = data.canAdd && !r.written?.asset && (r.kind === 'permit' || r.kind === 'inspection');
          return (
            <div key={r.id} data-closeout-record={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '9px 0', borderTop: '1px solid var(--border-color)' }}>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontSize: '0.88rem' }}><b>{KIND_LABEL[r.kind]}</b> · {r.title || r.number}</div>
                <div style={quiet}>{describe(r).filter(Boolean).join(' · ')}</div>
                {r.written?.error && <div style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{r.written.error}</div>}
              </div>
              {mayDecide ? (
                <select className="form-input" aria-label={`Result of ${r.title || r.number}`} value={r.result || ''} style={{ width: 130, padding: '4px 8px', fontSize: '0.8rem' }}
                  onChange={(e) => setResult(r, e.target.value)}>
                  <option value="">Not Known</option>
                  {Object.entries(RESULT).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
                </select>
              ) : res && <StatusLabel size="sm" label={res[0]} color={res[1]} />}
              <StatusLabel size="sm" label={r.written?.asset ? 'In Asset Management' : 'Not Handed Over'} color={r.written?.asset ? TONE.green : TONE.slate} />
              {data.canAdd && !r.written?.asset && (
                <HoldButton label="Remove" ariaLabel="Remove this record" doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                  onConfirm={() => api.removeCloseoutRecord(r.id).then(reload)} fallbackMessage="Take this record off the job?" />
              )}
            </div>
          );
        })}
      {data.canAdd && <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 8, paddingTop: 12 }}><AddRecord project={project} kinds={kinds} onAdded={reload} /></div>}
    </section>
  );
}
