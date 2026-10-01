import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useIsMobile } from '../../lib/useIsMobile';
import { useAccountingPrefs } from './prefs';

// One journal entry, opened from the entry number on a search result or a
// report drill-down (Charmi, Sep 24: "we should be able to click on the entry
// after we pull the reports").
//
// Sep 25 (Neil): what has value in an entry is the itemized list - account,
// amount, department, location, memo, vendor, Project-Job, item, employee,
// customer - "the fundamental Intacct and accounting system", so every one of
// those is a column here even when the line leaves it blank. The entry
// number, the Intacct batch and the posted date have no value to a reader and
// sit in one quiet line under the title. The window takes most of the screen,
// can fill it, and can be dragged larger from its corner.
// The "Open in Nexus Accounting" button that used to sit here came off on
// 09/30 (Charmi, call of 09/29: remove it everywhere).

const money = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return '';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const BOOK_LABEL = { both: 'Both books', actual_only: 'Accrual only', tax_only: 'Cash only' };
const named = (name, id) => name || id || '';

// The columns, in the order Neil listed them.
const COLUMNS = [
  { key: 'account', label: 'Account', width: '16%' },
  { key: 'debit', label: 'Debit', num: true, width: '7%' },
  { key: 'credit', label: 'Credit', num: true, width: '7%' },
  { key: 'department', label: 'Department', width: '9%' },
  { key: 'location', label: 'Location', width: '11%' },
  { key: 'memo', label: 'Memo', width: '13%' },
  { key: 'vendor', label: 'Vendor', width: '9%' },
  { key: 'project', label: 'Project-Job', width: '8%' },
  { key: 'item', label: 'Item', width: '5%' },
  { key: 'employee', label: 'Employee', width: '6%' },
  { key: 'customer', label: 'Customer', width: '9%' },
];

export default function EntryDetail({ entryId, entryNo, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [prefs, setPrefs] = useAccountingPrefs();
  // A phone (Oct 1) always gets the whole screen, and the lines as stacked
  // cards instead of the 1,180 px table; the fill-screen toggle is moot there.
  const isPhone = useIsMobile('(max-width: 640px)');
  const full = isPhone || !!prefs.entryFull;

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

  const entry = data?.entry;
  const lines = data?.lines || [];
  const intacct = data?.intacct || [];
  const batch = intacct.find((g) => g.batch_no)?.batch_no || '';
  const journal = intacct.find((g) => g.journal)?.journal || '';
  const doc = intacct.find((g) => g.doc)?.doc || '';
  const title = entry?.narration || intacct.find((g) => g.batch_title)?.batch_title || '';
  const books = [...new Set(lines.map((l) => l.book_tag))];
  const quiet = entry ? [
    entry.entry_no ? `Entry ${entry.entry_no}` : '',
    batch ? `Intacct batch ${batch}` : '',
    doc ? `Document ${doc}` : '',
    entry.posted_at ? `Posted ${formatDate(entry.posted_at)}` : '',
    books.length === 1 ? BOOK_LABEL[books[0]] || '' : '',
  ].filter(Boolean).join(' · ') : '';

  const cell = (l, g, key) => {
    switch (key) {
      case 'account': return <><span className="acct-code">{l.gl_code}</span>{l.account_name}</>;
      case 'debit': return money(l.debit);
      case 'credit': return money(l.credit);
      case 'department': return named(l.department_name, l.department);
      case 'location': return named(l.location_name, l.location);
      case 'memo': return l.description || g?.memo || '';
      case 'vendor': return named(g?.vendor_name, g?.vendor_id);
      case 'project': return named(g?.class_name, g?.class_id || g?.project_id);
      case 'item': return named(g?.item_name, g?.item_id);
      case 'employee': return named(g?.employee_name, g?.employee_id);
      case 'customer': return named(g?.customer_name, g?.customer_id);
      default: return '';
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation" style={full ? { padding: 0 } : { padding: 12 }}>
      <div className="modal-content acct-entry" role="dialog" aria-modal="true" aria-label={`Journal entry ${entryNo || ''}`} onClick={(e) => e.stopPropagation()}
        style={full ? { maxWidth: '100vw', width: '100vw', height: '100vh', maxHeight: '100vh', borderRadius: 0, resize: 'none' } : { maxWidth: '98vw', width: 'min(1720px, 96vw)', maxHeight: '94vh' }}>
        <div className="modal-header" style={{ padding: '12px 18px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isPhone ? 'normal' : 'nowrap', fontSize: isPhone ? '0.98rem' : undefined }}>
              {entry ? `${formatDate(entry.entry_date)}${journal ? ` · ${journal}` : ''}${title ? ` · ${title}` : ''}` : `Journal Entry ${entryNo || ''}`}
            </h3>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>{entry ? quiet : 'Loading the entry...'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {!isPhone && (
              <button type="button" onClick={() => setPrefs({ entryFull: !full })} aria-pressed={full} aria-label={full ? 'Back to window size' : 'Fill the screen'} title={full ? 'Back to window size' : 'Fill the screen'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 5 }}>
                {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div style={{ padding: isPhone ? '10px 12px 16px' : '12px 18px 16px', overflow: isPhone ? 'auto' : undefined }}>
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 12 }}>{error}</div>}
          {!data && !error && <SkeletonBlocks count={3} />}
          {data && isPhone && (
            <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
              {lines.map((l) => {
                const g = intacct.find((x) => x.record_no && x.record_no === l.intacct_record_no);
                const facts = COLUMNS.filter((c) => !['account', 'debit', 'credit'].includes(c.key)).map((c) => [c.label, cell(l, g, c.key)]).filter(([, v]) => v);
                return (
                  <div key={l.id} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: '0.86rem', fontWeight: 600 }}>{cell(l, g, 'account')}</span>
                      <span style={{ fontSize: '0.86rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {money(l.debit) ? money(l.debit) : money(l.credit) ? `(${money(l.credit)})` : '0.00'}
                      </span>
                    </div>
                    {facts.map(([label, v]) => (
                      <div key={label} style={{ display: 'flex', gap: 8, fontSize: '0.76rem', marginTop: 3 }}>
                        <span style={{ color: 'var(--text-muted)', flex: '0 0 88px' }}>{label}</span>
                        <span style={{ color: 'var(--text-secondary)', minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '10px 12px', fontSize: '0.84rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', background: 'var(--bg-secondary)' }}>
                <span>Total</span>
                <span>{money(data.totals.debit) || '0.00'} debit · {money(data.totals.credit) || '0.00'} credit</span>
              </div>
            </div>
          )}
          {data && (
            <>
              {!isPhone && <div className="acct-lines-wrap" style={{ maxHeight: 'none' }}>
                <table className="acct-lines acct-entry-lines" style={{ width: '100%', minWidth: 1180 }}>
                  <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: c.width }} />)}</colgroup>
                  <thead>
                    <tr>{COLUMNS.map((c) => <th key={c.key} scope="col" className={c.num ? 'acct-num' : undefined}>{c.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const g = intacct.find((x) => x.record_no && x.record_no === l.intacct_record_no);
                      return (
                        <tr key={l.id}>
                          {COLUMNS.map((c) => <td key={c.key} className={c.num ? 'acct-num' : undefined}>{cell(l, g, c.key)}</td>)}
                        </tr>
                      );
                    })}
                    <tr className="acct-grand">
                      <td>Total</td>
                      <td className="acct-num">{money(data.totals.debit)}</td>
                      <td className="acct-num">{money(data.totals.credit)}</td>
                      <td colSpan={COLUMNS.length - 3} />
                    </tr>
                  </tbody>
                </table>
              </div>}
              {Math.abs(data.totals.debit - data.totals.credit) >= 0.01 && (
                <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>This entry is out of balance by {money(data.totals.debit - data.totals.credit)}.</div>
              )}
              {books.length > 1 && (
                <div style={{ marginTop: 8, fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                  Lines by book: {books.map((b) => `${BOOK_LABEL[b] || b} ${lines.filter((l) => l.book_tag === b).length}`).join(' · ')}
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                From the Nexus Accounting ledger{intacct.length ? ` · ${intacct.length} Intacct ${intacct.length === 1 ? 'record' : 'records'}` : ''}.{isPhone ? '' : ' Drag the corner of this window to resize it.'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
