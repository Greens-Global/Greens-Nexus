import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';

// One journal entry, opened from the entry number on a search result or a
// report drill-down (Charmi, Sep 24: "we should be able to click on the entry
// after we pull the reports"). Shows the header, every line with its account,
// entity and department, and the Intacct records behind it (batch, vendor,
// customer, employee, Project-Job). "Open in Nexus Accounting" deep-links the
// same entry in the accounting app through the one-time sign-in.

const money = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return '';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const BOOK_LABEL = { both: 'Both books', actual_only: 'Accrual only', tax_only: 'Cash only' };
const partyOf = (g) => g.vendor_name || g.customer_name || g.employee_name || g.vendor_id || g.customer_id || g.employee_id || '';

export default function EntryDetail({ entryId, entryNo, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    api.getAccountingEntry(entryId)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load the entry.'); });
    return () => { alive = false; };
  }, [entryId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Same pattern as the Accounting tab's "Open Nexus Accounting": the tab is
  // opened on the click (popup blockers allow it) and pointed at the one-time
  // URL once it arrives.
  const openInApp = () => {
    if (opening || !data?.path) return;
    setOpening(true);
    const tab = window.open('', '_blank');
    api.launchAccounting(data.path)
      .then(({ url }) => { if (tab) tab.location = url; else window.location.assign(url); })
      .catch((e) => { if (tab) tab.close(); setError(e?.message || 'Could not open Nexus Accounting.'); })
      .finally(() => setOpening(false));
  };

  const entry = data?.entry;
  const lines = data?.lines || [];
  const intacct = data?.intacct || [];
  const batch = intacct.find((g) => g.batch_no)?.batch_no || '';
  const journal = intacct.find((g) => g.journal)?.journal || '';
  const hasDept = lines.some((l) => l.department);
  const hasParty = intacct.some((g) => partyOf(g));
  const hasJob = intacct.some((g) => g.class_id || g.project_id);
  const th = { textAlign: 'left', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' };
  const td = { padding: '7px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.82rem', verticalAlign: 'top' };
  const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const meta = (label, value) => value ? (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>{value}</div>
    </div>
  ) : null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={`Journal entry ${entryNo || ''}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 'min(1100px, 96vw)' }}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Journal Entry {entry?.entry_no || entryNo || ''}</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {entry ? `${formatDate(entry.entry_date)}${journal ? ` · ${journal}` : ''}${batch ? ` · Intacct batch ${batch}` : ''}` : 'Loading the entry...'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={openInApp} disabled={!data?.path || opening} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', padding: '5px 10px' }}>
              <ExternalLink size={14} /> {opening ? 'Opening...' : 'Open in Nexus Accounting'}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div style={{ padding: '16px 24px 20px' }}>
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 12 }}>{error}</div>}
          {!data && !error && <SkeletonBlocks count={3} />}
          {data && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 14 }}>
                {meta('Entry no.', entry.entry_no)}
                {meta('Date', formatDate(entry.entry_date))}
                {meta('Journal', journal)}
                {meta('Intacct batch', batch)}
                {meta('Document', intacct.find((g) => g.doc)?.doc)}
                {meta('Posted', entry.posted_at ? formatDate(entry.posted_at) : '')}
              </div>
              {(entry.narration || intacct.find((g) => g.batch_title)?.batch_title) && (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', marginBottom: 12 }}>{entry.narration || intacct.find((g) => g.batch_title)?.batch_title}</div>
              )}
              <div className="req-table-wrapper">
                <table className="req-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Account</th>
                      <th style={th}>Description</th>
                      <th style={th}>Entity</th>
                      {hasDept && <th style={th}>Department</th>}
                      {hasParty && <th style={th}>Vendor / Customer</th>}
                      {hasJob && <th style={th}>Project-Job</th>}
                      <th style={th}>Book</th>
                      <th style={{ ...th, textAlign: 'right' }}>Debit</th>
                      <th style={{ ...th, textAlign: 'right' }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const g = intacct.find((x) => x.record_no && x.record_no === l.intacct_record_no);
                      return (
                        <tr key={l.id}>
                          <td style={td}>
                            <span style={{ fontFamily: 'monospace', fontSize: '0.76rem', marginRight: 6, color: 'var(--text-secondary)' }}>{l.gl_code}</span>{l.account_name}
                          </td>
                          <td style={{ ...td, maxWidth: 360 }}>{l.description || g?.memo || ''}</td>
                          <td style={td}>{l.location_name || l.location || ''}</td>
                          {hasDept && <td style={td}>{l.department_name || l.department || ''}</td>}
                          {hasParty && <td style={td}>{g ? partyOf(g) : ''}</td>}
                          {hasJob && <td style={td}>{g ? (g.class_name || g.class_id || g.project_id || '') : ''}</td>}
                          <td style={{ ...td, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{BOOK_LABEL[l.book_tag] || l.book_tag}</td>
                          <td style={num}>{money(l.debit)}</td>
                          <td style={num}>{money(l.credit)}</td>
                        </tr>
                      );
                    })}
                    <tr style={{ fontWeight: 700 }}>
                      <td style={td} colSpan={3 + (hasDept ? 1 : 0) + (hasParty ? 1 : 0) + (hasJob ? 1 : 0) + 1}>Total</td>
                      <td style={num}>{money(data.totals.debit)}</td>
                      <td style={num}>{money(data.totals.credit)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {Math.abs(data.totals.debit - data.totals.credit) >= 0.01 && (
                <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>This entry is out of balance by {money(data.totals.debit - data.totals.credit)}.</div>
              )}
              <div style={{ marginTop: 10, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                From the Nexus Accounting ledger{intacct.length ? ` · ${intacct.length} Intacct ${intacct.length === 1 ? 'record' : 'records'}` : ''}.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
