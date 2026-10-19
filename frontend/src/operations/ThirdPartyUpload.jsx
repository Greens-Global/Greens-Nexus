// Upload a third-party operator's report (CubeSmart, Oct 20 2026): the Qlik
// SRE Summary, the SmartView Daily Flash, or the monthly rent roll. Two steps,
// one endpoint: Preview parses and validates the file and saves nothing;
// Save sends the same file again with commit=1 and the server upserts it
// (property + month, property + day, property + as-of day). A rent roll's
// unit list never comes back to the browser - only how many units it has.
import { useState } from 'react';
import { Upload } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { PREVIEW_COLUMNS, REPORT_KINDS, kindLabel, periodLabel, previewCell } from './thirdParty';

const ACCEPT = '.xlsx,.csv';

export default function ThirdPartyUpload({ properties = [], defaultPropertyId = '', onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [kind, setKind] = useState('auto');
  const [propertyId, setPropertyId] = useState(defaultPropertyId);
  const [asOf, setAsOf] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const reset = () => { setPreview(null); setError(''); setDone(''); };
  const pick = (f) => { setFile(f || null); reset(); };
  const opts = (commit) => ({ kind, propertyId, asOf, commit });

  const runPreview = async () => {
    if (!file) return;
    setBusy('preview'); reset();
    try {
      setPreview(await api.uploadThirdPartyReport(file, opts(false)));
    } catch (e) {
      setError(e?.message || 'Could not read that file.');
    } finally {
      setBusy('');
    }
  };
  const save = async () => {
    setBusy('save'); setError('');
    try {
      const r = await api.uploadThirdPartyReport(file, opts(true));
      const n = r?.savedRows ?? r?.rows?.length ?? 0;
      setDone(`Saved ${n} ${n === 1 ? 'row' : 'rows'} from ${file.name}.`);
      onSaved?.(r);
    } catch (e) {
      setError(e?.message || 'Could not save the report.');
    } finally {
      setBusy('');
    }
  };

  const cols = PREVIEW_COLUMNS[preview?.kind] || [];
  const replaces = (preview?.rows || []).filter((r) => r.replaces).length;
  const canSave = !!preview && !preview.errors?.length && !!preview.rows?.length && !done;

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button type="button" className="secondary-btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
      <button type="button" className="secondary-btn" onClick={runPreview} disabled={!file || !!busy}>
        {busy === 'preview' ? 'Reading…' : 'Preview'}
      </button>
      <button type="button" className="primary-btn" onClick={save} disabled={!canSave || !!busy}>
        {busy === 'save' ? 'Saving…' : 'Save'}
      </button>
    </div>
  );

  return (
    <Modal title="Upload Operator Report" onClose={onClose} footer={footer} minHeight="60vh">
      <p className="ops-note" style={{ margin: '0 0 14px' }}>
        Export the SRE Summary from CubeSmart's Qlik reports, the Daily Flash from SmartView, or the Rent Roll sheet of the
        monthly Financials workbook, as Excel or CSV. Columns can be in any order. Nothing is saved until you check the preview.
      </p>
      <div className="ops-form" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <label className="ops-period" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <span>Report</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value); reset(); }} aria-label="Report">
            {REPORT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="ops-period" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <span>Property</span>
          <select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); reset(); }} aria-label="Property">
            <option value="">Detect From File</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.shortName} ({p.managedLabel})</option>)}
          </select>
        </label>
        <label className="ops-period" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <span>As Of (If the File Does Not Say)</span>
          <input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); reset(); }} aria-label="As Of" />
        </label>
      </div>

      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer?.files?.[0]); }}
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, padding: '18px 16px', border: '1px dashed var(--line)', borderRadius: 10, cursor: 'pointer', color: 'var(--muted)', fontSize: 13 }}>
        <Upload size={16} aria-hidden="true" />
        <span>{file ? file.name : 'Choose an .xlsx or .csv file, or drop it here'}</span>
        <input type="file" accept={ACCEPT} aria-label="Report File" style={{ display: 'none' }}
          onChange={(e) => pick(e.target.files?.[0])} />
      </label>

      {error && <p className="ops-form-error" role="alert" style={{ marginTop: 12 }}>{error}</p>}
      {done && <p className="ops-note" role="status" style={{ marginTop: 12, color: 'var(--ok-fg)' }}>{done}</p>}

      {preview && (
        <div style={{ marginTop: 16 }} data-testid="tp-preview">
          <div className="dash-card-title">
            {kindLabel(preview.kind)}{preview.properties?.length ? ` - ${preview.properties.map((p) => p.shortName).join(', ')}` : ''}
          </div>
          <div className="dash-card-sub" style={{ marginBottom: 10 }}>
            {preview.rows.length} {preview.rows.length === 1 ? 'row' : 'rows'} found
            {replaces ? ` - ${replaces} will replace figures already in Nexus` : ''}
          </div>
          {preview.errors?.map((m) => <p key={m} className="ops-form-error" role="alert" style={{ margin: '0 0 6px' }}>{m}</p>)}
          {preview.warnings?.map((m) => (
            <p key={m} style={{ margin: '0 0 6px', fontSize: 12.5 }}><span className="status-badge pill-warn">Check</span> {m}</p>
          ))}
          {preview.unknownLabels?.length > 0 && (
            <p className="ops-note" style={{ margin: '0 0 8px' }}>
              Kept but not shown on the screen yet: {preview.unknownLabels.join(', ')}
            </p>
          )}
          {preview.rows.length > 0 && (
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead>
                  <tr>
                    <th>Property</th><th>{preview.kind === 'sre' ? 'Month' : 'Date'}</th>
                    {cols.map(([, head]) => <th key={head} className="num">{head}</th>)}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 24).map((r) => (
                    <tr key={`${r.propertyId}-${r.period}`}>
                      <td data-th="Property">{r.property}</td>
                      <td data-th={preview.kind === 'sre' ? 'Month' : 'Date'}>{periodLabel(r.period)}</td>
                      {cols.map(([field, head]) => <td key={field} data-th={head} className="num">{previewCell(field, r.values?.[field])}</td>)}
                      <td data-th="Status">{r.replaces ? <span className="status-badge pill-info">Replaces</span> : <span className="status-badge pill-ok">New</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
