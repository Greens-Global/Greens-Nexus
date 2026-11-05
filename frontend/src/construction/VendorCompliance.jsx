// A subcontractor's papers (Round Two item 7, Neil, 11/05/2026). The vendor
// is Intacct's, through Accounting > Vendors & Customers; Nexus keeps only
// what Intacct does not - when the insurance certificate, the workers comp
// certificate and the license expire, and whether a W-9 is on file. ONE
// form, two doors: the job's Subs tab and the vendor record's Compliance
// tab (components/accounting/PartnersTab.jsx) both draw this. The state
// words come from the server (backend/vendor_compliance.py - the one rule).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { StatusLabel } from '../components/StatusLabel';
import { DateField } from '../tasks/components';
import { formatDate } from '../lib/datetime';
import { TONE } from './ui';

export const PAPERS = {
  ok: ['Papers Current', TONE.green],
  expiring: ['Expiring Soon', TONE.yellow],
  expired: ['Expired', TONE.red],
  missing: ['No Insurance On File', TONE.slate],
};

export function PapersLabel({ compliance, size = 'sm' }) {
  const [label, color] = PAPERS[compliance?.state] || PAPERS.missing;
  return <StatusLabel size={size} label={label} color={color} />;
}

const DATES = [['coiExpiresOn', 'Insurance Certificate Expires'], ['wcExpiresOn', 'Workers Comp Expires'], ['licenseExpiresOn', 'License Expires']];
const draftOf = (c) => ({
  coiExpiresOn: c?.coiExpiresOn || '', wcExpiresOn: c?.wcExpiresOn || '', licenseExpiresOn: c?.licenseExpiresOn || '',
  licenseNumber: c?.licenseNumber || '', w9OnFile: !!c?.w9OnFile, notes: c?.notes || '',
});
const quiet = { fontSize: '0.8rem', color: 'var(--text-secondary)' };

export default function VendorCompliance({ vendorId, initial = null, onSaved }) {
  const [c, setC] = useState(initial);
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initial) return undefined;
    let live = true;
    api.getVendorCompliance(vendorId)
      .then((d) => { if (live) { setC(d.compliance); setDraft(draftOf(d.compliance)); } })
      .catch((e) => { if (live) setError(e?.message || 'Could not read the papers.'); });
    return () => { live = false; };
  }, [vendorId]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(c));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const d = await api.saveVendorCompliance(vendorId, {
        coi_expires_on: draft.coiExpiresOn, wc_expires_on: draft.wcExpiresOn, license_expires_on: draft.licenseExpiresOn,
        license_number: draft.licenseNumber, w9_on_file: draft.w9OnFile, notes: draft.notes,
      });
      setC(d.compliance); setDraft(draftOf(d.compliance)); onSaved?.(d.compliance);
    } catch (err) { setError(err?.message || 'Could not save the papers.'); }
    setBusy(false);
  };
  if (!c && !error) return <div style={quiet}>Reading the papers…</div>;
  return (
    <form onSubmit={save} aria-label={`Papers of ${c?.vendorName || vendorId}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {c && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <PapersLabel compliance={c} />
          <span style={quiet}>{c.issues?.length ? c.issues.join(' ') : 'Every paper on file is current.'}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {DATES.map(([k, label]) => (
          <div key={k}><span className="form-label" style={{ display: 'block' }}>{label}</span>
            <DateField value={draft[k]} onChange={(v) => setDraft((d) => ({ ...d, [k]: v || '' }))} title={label} /></div>
        ))}
        <label className="form-label" style={{ margin: 0 }}>License Number
          <input className="form-input" value={draft.licenseNumber} onChange={(e) => setDraft((d) => ({ ...d, licenseNumber: e.target.value }))} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'end', fontSize: '0.86rem', paddingBottom: 8 }}>
          <input type="checkbox" checked={draft.w9OnFile} onChange={(e) => setDraft((d) => ({ ...d, w9OnFile: e.target.checked }))} />W-9 On File</label>
      </div>
      <label className="form-label" style={{ margin: 0 }}>Notes
        <input className="form-input" value={draft.notes} placeholder="e.g. COI names Greens as additional insured" onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} /></label>
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="submit" className="primary-btn" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save Papers'}</button>
        {c?.updatedAt && <span style={quiet}>Updated {formatDate(c.updatedAt)}{c.updatedBy ? ` by ${c.updatedBy}` : ''}</span>}
      </div>
    </form>
  );
}
