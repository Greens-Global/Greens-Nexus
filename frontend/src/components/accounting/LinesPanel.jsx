import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import SidePanel from './SidePanel';
import EntryDetail from './EntryDetail';
import { ColumnResizer } from './reportControls';
import { useColumnWidths } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import { requestReportDrill } from './drill';

// The transactions behind an amount, on the right (call of 10/27 with Charmi,
// item 17: "anytime we make any report, everything should have the drill down
// option"; "make sure this is also all resizable"). One panel for every
// Accounting report that is not a statement (the statements open their lines
// on the Reports screen itself): the ledger lines the figure adds up - date,
// entry, account, vendor / customer / employee, description and amount, with
// their total - in the module's side panel (SidePanel: Open Full, the list
// still beside it). Each entry number opens the whole entry; Open in Reports
// takes the same search to the General Ledger lines (drill.js), with every
// filter and the export. The columns drag wider or narrower, the widths kept
// per person per `widthsKey`.
//
//   <LinesPanel title="San Diego Gas & Electric - Jan 2026" caption="..."
//     queries={[{ account: '62100', party_kind: 'vendor', party: 'V-SDGE', location: '15000', from, to }]}
//     report={{ account: '62100', party: { kind: 'vendor', code: 'V-SDGE', name: 'SDG&E' }, from, to, entity: '15000' }}
//     widthsKey="mre" onClose={...} />
//
// `queries`: ledger searches (api.searchAccountingLedger), read together and
// listed as one - e.g. one per expense account of an MRE line.

export const LINES_LIMIT = 500;

export const LINE_COLUMNS = [
  { key: 'date', label: 'Date', width: 92 },
  { key: 'entry', label: 'Entry', width: 108 },
  { key: 'account', label: 'Account', width: 210 },
  { key: 'name', label: 'Name', width: 190 },
  { key: 'description', label: 'Description', width: 260 },
  { key: 'amount', label: 'Amount', width: 112, num: true },
];

const numbered = (name, id) => (id && name && name !== id ? `${id} ${name}` : name || id || '');
/** The vendor, customer or employee on a line ("V00412 Home Depot"), as the ledger lines read it. */
export function lineName(l) {
  if (l.vendor_id || l.vendor_name) return numbered(l.vendor_name, l.vendor_id);
  if (l.customer_id || l.customer_name) return numbered(l.customer_name, l.customer_id);
  return l.employee_name || l.employee_id || '';
}
/** "62100 Utilities - Electric" (older answers carry account_no / account). */
export const lineAccount = (l) => `${l.gl_code || l.account_no || l.account || ''} ${l.account_name || ''}`.trim();
export const lineAmount = (l) => (Number(l.debit) || 0) - (Number(l.credit) || 0);

/** Every query's lines as one list, newest first; `more` when a search had more than it returned. */
export async function readLines(queries, limit = LINES_LIMIT) {
  const answers = await Promise.all((queries || []).map((q) => api.searchAccountingLedger({ ...q, offset: 0, limit })));
  const lines = answers.flatMap((d) => d?.rows || []);
  const more = answers.some((d) => (Number(d?.total) || 0) > (d?.rows || []).length);
  lines.sort((a, b) => String(b.entry_date || '').localeCompare(String(a.entry_date || '')));
  return { lines, more };
}

export default function LinesPanel({ title, caption = '', queries, report = null, widthsKey = 'lines', label = 'Ledger lines', onClose }) {
  const key = JSON.stringify(queries || []);
  const [state, setState] = useState({ key: '', lines: null, more: false, error: '' });
  const [entry, setEntry] = useState(null);
  const entryOpen = useRef(false);
  useEffect(() => { entryOpen.current = !!entry; }, [entry]);
  const cols = useColumnWidths(`lines-panel:${widthsKey}`, Object.fromEntries(LINE_COLUMNS.map((c) => [c.key, c.width])), { min: 60 });
  useEffect(() => {
    let alive = true;
    readLines(JSON.parse(key))
      .then((d) => { if (alive) setState({ key, ...d, error: '' }); })
      .catch((e) => { if (alive) setState({ key, lines: [], more: false, error: e?.message || 'Could not read the ledger lines.' }); });
    return () => { alive = false; };
  }, [key]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !entryOpen.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const lines = state.key === key ? state.lines : null;
  const total = useMemo(() => (lines || []).reduce((s, l) => s + lineAmount(l), 0), [lines]);
  const toReports = report ? () => { requestReportDrill(report); onClose(); } : null;
  const head = (c) => (
    <th key={c.key} scope="col" className={c.num ? 'acct-num' : undefined} style={headStyle(cols.width(c.key))}>
      {c.label}<ColumnResizer {...cols.resizer(c.key, c.label)} />
    </th>
  );
  return (
    <>
      <SidePanel label={label} title={title} caption={caption} onClose={onClose}
        footer={toReports ? (
          <div className="modal-footer" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: '0.74rem', color: 'var(--text-muted)' }}>{state.more ? `The first ${LINES_LIMIT} lines of each search are here; Reports has them all.` : 'The same lines on the General Ledger, with every filter and the export.'}</span>
            <button type="button" className="secondary-btn" onClick={toReports} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ExternalLink size={13} /> Open in Reports</button>
          </div>
        ) : null}>
        {lines === null ? <SkeletonBlocks count={3} /> : state.error ? (
          <div role="alert" style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{state.error}</div>
        ) : !lines.length ? (
          <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>Nothing posted for this figure.</div>
        ) : (
          <div className="acct-report-wrap" style={{ background: 'var(--bg-card)', borderRadius: 8 }}>
            <table className="acct-report" aria-label={`${title} - ledger lines`}>
              <thead><tr>{LINE_COLUMNS.map(head)}</tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.line_id || l.entry_id || l.entry_no || 'x'}-${i}`}>
                    <td style={cellStyle(cols.width('date'))}>{l.entry_date ? formatDate(l.entry_date) : '-'}</td>
                    <td style={cellStyle(cols.width('entry'))}>
                      {l.entry_id ? <button type="button" className="acct-drill" onClick={() => setEntry({ id: l.entry_id, no: l.entry_no })} title="Open this journal entry">{l.entry_no || 'Open'}</button> : (l.entry_no || '-')}
                    </td>
                    <td style={cellStyle(cols.width('account'))} title={lineAccount(l)}>{lineAccount(l) || '-'}</td>
                    <td style={cellStyle(cols.width('name'))} title={lineName(l)}>{lineName(l) || '-'}</td>
                    <td style={cellStyle(cols.width('description'))} title={l.description || l.memo || ''}>{l.description || l.memo || '-'}</td>
                    <td className="acct-num" style={cellStyle(cols.width('amount'))}><Amount value={lineAmount(l)} /></td>
                  </tr>
                ))}
                <tr className="acct-grand">
                  <td colSpan={LINE_COLUMNS.length - 1} className="acct-label">Total - {lines.length} {lines.length === 1 ? 'line' : 'lines'}{state.more ? ' shown' : ''}</td>
                  <td className="acct-num"><Amount value={total} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </SidePanel>
      {entry && <EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} />}
    </>
  );
}
