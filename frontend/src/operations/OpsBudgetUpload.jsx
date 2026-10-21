// Ops Budget: upload a site's Ops Budget workbook (administrators only - the
// server checks too). Two steps, like the operator-store upload: Check File
// reads it and shows what would load - tabs, months, the columns we did not
// recognize and the ones that are missing - nothing saved; Save Figures loads
// it (every month in the file is replaced). The file is kept with the upload.
import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { api, saveBlob } from '../api';
import { Modal } from '../tasks/components';
import { LoadingState } from '../components/AsyncState';
import { formatDateTime } from '../lib/datetime';
import { monthText } from './opsBudgetFormat';

function List({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <div className={`ob-up-list ob-up-${tone}`}>
      <h4>{title}</h4>
      <ul>{items.slice(0, 40).map((t) => <li key={t}>{t}</li>)}</ul>
      {items.length > 40 && <p className="ops-note">And {items.length - 40} more.</p>}
    </div>
  );
}

export default function OpsBudgetUpload({ facilities, current, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [facilityId, setFacilityId] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [loads, setLoads] = useState(null);

  const loadLoads = useCallback(async () => {
    try { setLoads((await api.getOpsBudgetLoads(current)).loads || []); } catch { setLoads([]); }
  }, [current]);
  useEffect(() => { loadLoads(); }, [loadLoads]);

  const send = async (commit) => {
    if (!file) return;
    setBusy(commit ? 'save' : 'check');
    setError('');
    try {
      const r = await api.uploadOpsBudget(file, { facilityId, commit });
      setPreview(r);
      if (commit) { setDone(r); onSaved?.(); loadLoads(); }
    } catch (err) {
      setError(err?.message || "Couldn't read that file.");
      if (!commit) setPreview(null);
    } finally {
      setBusy('');
    }
  };

  const pick = (f) => { setFile(f || null); setPreview(null); setDone(null); setError(''); };
  const download = async (id) => {
    try { const { blob, filename } = await api.getOpsBudgetLoadFile(id); saveBlob(blob, filename || 'ops-budget.xlsx'); }
    catch (err) { setError(err?.message || "Couldn't download that file."); }
  };

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
      <button type="button" className="secondary-btn" disabled={!file || !!busy} onClick={() => send(false)}>
        {busy === 'check' ? 'Checking…' : 'Check File'}
      </button>
      <button type="button" className="primary-btn" disabled={!preview || preview.errors?.length > 0 || !!busy || !!done} onClick={() => send(true)}>
        {busy === 'save' ? 'Saving…' : 'Save Figures'}
      </button>
    </div>
  );

  return (
    <Modal title="Upload Ops Budget Workbook" onClose={onClose} footer={footer} minHeight="60vh">
      <div className="ob-up">
        <p className="ops-note" style={{ margin: 0 }}>
          One workbook per site (Ops_Budget_Report_Template.xlsx). We read the Setup, SS Actual, VS Actual, SS Budget and
          VS Budget tabs by their column headers. A blank cell stays blank; a typed 0 is zero. Uploading again replaces every
          month in the file.
        </p>
        <div className="ob-up-row">
          <label className="ob-up-file">
            <FileSpreadsheet size={16} aria-hidden="true" />
            <span>{file ? file.name : 'Choose a .xlsx file'}</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <label className="ops-period"><span>Site</span>
            <select value={facilityId} onChange={(e) => { setFacilityId(e.target.value); setPreview(null); setDone(null); }}>
              <option value="">From the Setup tab</option>
              {facilities.map((f) => <option key={f.id} value={f.id}>{f.shortName}</option>)}
            </select>
          </label>
        </div>

        {error && <p className="ob-up-error" role="alert">{error}</p>}
        {done && <p className="ob-up-ok" role="status">Saved {done.rowsWritten} figures across {done.months} months for {done.facility?.shortName}.</p>}

        {preview && (
          <>
            <div className="ob-up-head">
              <b>{preview.facility?.name || preview.setup?.name || 'Unknown site'}</b>
              {preview.setup?.budgetYearStart && <span> · Budget year from {monthText(preview.setup.budgetYearStart)}</span>}
              {preview.setup?.historyStart && <span> · History from {monthText(preview.setup.historyStart)}</span>}
            </div>
            <List title="This File Cannot Be Saved" items={preview.errors} tone="bad" />
            <table className="req-table ob-up-table">
              <thead><tr><th>Tab</th><th className="num">Months</th><th className="num">With Figures</th><th>Range</th><th className="num">Values</th></tr></thead>
              <tbody>
                {preview.sheets.map((s) => (
                  <tr key={s.sheet}>
                    <td>{s.sheet}</td><td className="num">{s.months}</td><td className="num">{s.monthsWithData}</td>
                    <td>{s.first ? `${monthText(s.first)} - ${monthText(s.last)}` : '-'}</td><td className="num">{s.values}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <List title="Columns We Did Not Recognize (Not Loaded)" items={preview.unknownHeaders} tone="warn" />
            <List title="Metrics With No Column" items={preview.missingHeaders} tone="warn" />
            <List title="Notes" items={preview.warnings} tone="note" />
          </>
        )}

        <h4 className="ob-up-h">Recent Uploads For This Site</h4>
        {loads === null ? <LoadingState size="inline" label="Loading uploads" minHeight={40} />
          : loads.filter((l) => l.kind === 'workbook').length === 0 ? <p className="ops-note" style={{ margin: 0 }}>No workbook uploaded for this site yet.</p>
            : (
              <ul className="ob-up-loads">
                {loads.filter((l) => l.kind === 'workbook').slice(0, 8).map((l) => (
                  <li key={l.id}>
                    <span>{l.fileName || 'Workbook'} · {formatDateTime(l.at)} · {l.by} · {l.rows} figures</span>
                    <button type="button" className="ops-link" onClick={() => download(l.id)}><Download size={13} aria-hidden="true" /> Download</button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </Modal>
  );
}
