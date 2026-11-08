// Variables in a Sheet (Neil, 11/05/2026): the Documents Variable Library
// ({{full_name}}, {{company_name}}...) filled from the person and company this
// sheet is about plus its own values - the same resolution an exported
// document uses (GET /documents/{id}/merge-values). Cells read them with
// =VAR("token") or show {{token}} text filled in (sheets/ engine). Only the
// owner picks the person and company; everyone sees the values.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Modal, PersonSelect } from '../tasks/components';
import { ErrorBanner } from '../components/AsyncState';

/** The variable list and this sheet's values; `reload()` after the person or company changes. */
export function useSheetVariables(docId) {
  const [variables, setVariables] = useState([]);
  const [values, setValues] = useState({});
  const [subject, setSubject] = useState({ employeeId: '', entityId: '' });
  const reload = useCallback(() => api.documentMergeValues(docId)
    .then((r) => { setValues(r?.values || {}); setSubject({ employeeId: r?.employeeId || '', entityId: r?.entityId || '' }); })
    .catch(() => setValues({})), [docId]);
  useEffect(() => {
    api.getDocVariables().then((v) => setVariables(Array.isArray(v) ? v.map(({ token, label, group }) => ({ token, label, group })) : [])).catch(() => setVariables([]));
    reload();
  }, [reload]);
  return { variables, values, subject, reload };
}

export default function SheetVariablesDialog({ docId, canManage, subject, employees = [], entities = [], variables, values, onClose, onChanged }) {
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const people = useMemo(() => {
    const seen = new Set();
    return employees.map((e) => {
      let email = (e.workEmail || '').toLowerCase();
      if (!email || seen.has(email)) email = `id:${e.id}`.toLowerCase();
      seen.add(email);
      return { id: e.id, email, name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.workEmail || e.id };
    });
  }, [employees]);
  const save = async (patch) => {
    setError('');
    try { await api.updateDocument(docId, patch); await onChanged?.(); } catch (e) { setError(e.message || 'Could not change it'); }
  };
  const shown = variables.filter((v) => !q || `${v.label} ${v.token}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <Modal title="Variables For This Sheet" onClose={onClose}
      footer={<button type="button" className="secondary-btn" onClick={onClose}>Done</button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, flex: '1 1 auto' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
          A variable fills in from the person and company this sheet is about. Type =VAR("token") in a cell, or {'{{token}}'} inside text, or pick one from Insert &gt; Variable in the sheet.
          {canManage ? '' : ' Only the owner changes the person and company.'}
        </p>
        {error && <ErrorBanner message={error} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Person
            <PersonSelect value={people.find((p) => p.id === subject.employeeId)?.email || null} disabled={!canManage}
              onChange={(v) => save({ employeeId: people.find((p) => p.email === v)?.id || '' })}
              people={people} placeholder="None" noneLabel="None" ariaLabel="Person this sheet is about" />
          </label>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Company
            <select className="form-input" value={subject.entityId} disabled={!canManage} style={{ width: '100%', marginTop: 4 }}
              onChange={(e) => save({ entityId: e.target.value })}>
              <option value="">None</option>
              {entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        </div>
        <input className="form-input" placeholder="Find a variable" aria-label="Find a variable" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="nx-fill" style={{ overflowY: 'auto', minHeight: 0, border: '1px solid var(--line)', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th style={{ padding: '8px 10px' }}>Variable</th><th style={{ padding: '8px 10px' }}>Token</th><th style={{ padding: '8px 10px' }}>Value</th></tr></thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.token} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '7px 10px' }}>{v.label || v.token}</td>
                  <td style={{ padding: '7px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{v.token}</td>
                  <td style={{ padding: '7px 10px', color: values[v.token] ? 'var(--text)' : 'var(--muted)' }}>{values[v.token] || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
