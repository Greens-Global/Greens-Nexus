// Item Management - The checkouts report export.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';
import { FileSpreadsheet, FileBarChart } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { ITEM_TYPES, CHECKOUT_STATUS_META, DEPARTMENTS } from '../model/status';
import { triggerDownload } from '../model/csv';
import { useEscapeKey } from '../ui/hooks';
import { FL } from '../ui/styles';

// ── Report Modal ───────────────────────────────────────────────────────────────
export function ReportModal({ onClose, checkouts, initial }) {
  const [dept,      setDept]      = useState(initial?.dept && initial.dept !== 'All' ? initial.dept : 'All');
  const [itemType,  setItemType]  = useState(initial?.itemType && initial.itemType !== 'All' ? initial.itemType : 'All');
  const [status,    setStatus]    = useState('All');
  const [person,    setPerson]    = useState('');
  const [exporting, setExporting] = useState(null);
  const [error,     setError]     = useState('');
  useEscapeKey(onClose);

  // People who appear in checkout history - offered as autocomplete for the person filter
  const knownPeople = Array.from(new Set((checkouts || []).map(c => c.requestedBy).filter(Boolean))).sort();

  function exportAs(format) {
    if (exporting) return;
    setExporting(format); setError('');
    const params = { format };
    if (dept !== 'All')     params.department   = dept;
    if (itemType !== 'All') params.item_type    = itemType;
    if (status !== 'All')   params.status       = status;
    if (person.trim())      params.requested_by = person.trim();
    api.getItemsReport(params)
      .then(({ blob, filename }) => triggerDownload(filename, blob))
      .then(onClose)
      .catch(err => setError(err?.message || 'Could not generate report.'))
      .finally(() => setExporting(null));
  }

  return (
    <div role="dialog" aria-modal="true" className="modal-overlay" style={{ zIndex:4100 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-content nx-popup" style={{ display:'flex', flexDirection:'column', padding:28 }}>
        <h3 style={{ fontSize:15, fontWeight:700, marginBottom: (initial?.dept && initial.dept !== 'All') || (initial?.itemType && initial.itemType !== 'All') ? 6 : 16 }}>Export Report</h3>
        {((initial?.dept && initial.dept !== 'All') || (initial?.itemType && initial.itemType !== 'All')) && (
          <p style={{ fontSize:12, color:'var(--muted)', marginBottom:16 }}>Pre-filled from your current filters - adjust below, then export as PDF or Excel.</p>
        )}
        <div style={{ display:'flex', flexDirection:'column', gap:14, marginBottom:20 }}>
          <div>
            <label style={FL}>DEPARTMENT</label>
            <select className="form-input" style={{ width:'100%' }} value={dept} onChange={e => setDept(e.target.value)}>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>ITEM TYPE</label>
            <select className="form-input" style={{ width:'100%' }} value={itemType} onChange={e => setItemType(e.target.value)}>
              <option>All</option>
              {ITEM_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>STATUS</label>
            <select className="form-input" style={{ width:'100%' }} value={status} onChange={e => setStatus(e.target.value)}>
              {['All','pending','approved','allocated','returned','rejected','cancelled'].map(s =>
                <option key={s} value={s}>{s === 'All' ? 'All statuses' : CHECKOUT_STATUS_META[s]?.label || s}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>PERSON <span style={{ fontSize:11, fontWeight:400 }}>(optional - separate multiple names with commas)</span></label>
            <input className="form-input" style={{ width:'100%' }} list="report-people"
              placeholder="e.g. Sahil, Valinda" value={person} onChange={e => setPerson(e.target.value)} />
            <datalist id="report-people">{knownPeople.map(n => <option key={n} value={n} />)}</datalist>
          </div>
        </div>
        {error && <p style={{ fontSize:13, color:'hsl(var(--color-red))', marginBottom:12 }}>{error}</p>}
        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={!!exporting}>Cancel</button>
          <button className="secondary-btn" disabled={!!exporting} style={{ display:'inline-flex', alignItems:'center', gap:6 }}
            onClick={() => exportAs('pdf')}>
            {exporting === 'pdf' ? <Spinner size={14} /> : <FileBarChart size={14} />} PDF
          </button>
          <button className="primary-btn" disabled={!!exporting} style={{ display:'inline-flex', alignItems:'center', gap:6 }}
            onClick={() => exportAs('excel')}>
            {exporting === 'excel' ? <Spinner size={14} /> : <FileSpreadsheet size={14} />} Excel
          </button>
        </div>
      </div>
    </div>
  );
}
