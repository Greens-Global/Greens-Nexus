import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SkeletonBlocks } from '../../AsyncState';
import { SectionTabs, card, input } from './Bits';
import { useDash } from './DashContext';
import { EntityPicker } from '../reportControls';

// Accounting -> Data. The figures the ledger does not carry: loans and
// covenants, intercompany balances, brokerage holdings, partner capital, cap
// rates, the close checklist, the filing calendar and close history. One grid
// per table; a row saves when you leave a field. Editors and up.
//
// Sep 30 (Neil, call of 09/29): Loans replaces the loans spreadsheet. A loan
// is set up once with its number, kind (external, intercompany, given) and
// GL account; with "Balance from" set to Ledger the principal is read from
// Intacct as of the month shown and cannot be typed. Rate and maturity are
// typed, and the rate is fixed or variable.
//
// Oct 7: no browser dialogs - a row that cannot save says why in a line under
// it (a schedule that is not JSON, or the server's answer), and Delete asks
// in place (Remove / Keep). Headers and buttons in Title Case.

const GRIDS = [
  { id: 'loans', title: 'Loans', table: 'fin_loans', key: 'loans', desc: 'Every loan - external, intercompany, and loans given - set up once: loan number, lender, entity, and the GL account the principal sits on. With Balance from set to Ledger, the balance is read from Intacct as of the month shown; rate, fixed or variable, maturity, monthly principal and interest, DSCR and the covenant minimum are typed.',
    cols: [['loan_no', 'Loan #', 'text'], ['kind', 'Kind', 'select', ['external', 'intercompany', 'given'], { external: 'External', intercompany: 'Intercompany', given: 'Loan Given' }], ['lender', 'Lender', 'text'], ['entity_code', 'Entity / Property', 'entity'], ['gl_account', 'GL Account', 'text'], ['balance_source', 'Balance From', 'select', ['manual', 'ledger'], { manual: 'Kept by Hand', ledger: 'Ledger' }], ['balance', 'Balance', 'balance'], ['rate_pct', 'Rate %', 'number', '0.01'], ['rate_type', 'Rate', 'select', ['fixed', 'variable'], { fixed: 'Fixed', variable: 'Variable' }], ['maturity', 'Maturity', 'date'], ['monthly_pi', 'Monthly P&I', 'number'], ['dscr', 'DSCR', 'number', '0.01'], ['covenant_min', 'Covenant Min', 'number', '0.01'], ['is_active', 'Active', 'check']],
    blank: () => ({ loan_no: '', kind: 'external', lender: '', entity_code: '', gl_account: '', balance_source: 'ledger', balance: 0, rate_pct: 0, rate_type: 'fixed', maturity: null, monthly_pi: 0, dscr: null, covenant_min: null, is_active: true, notes: '' }) },
  { id: 'intercompany', title: 'Intercompany', table: 'fin_intercompany', key: 'intercompany', desc: 'Due-from and due-to pairs. Matched when both sides agree; the dashboard flags any difference before consolidation.',
    cols: [['from_code', 'Due From (Owed To)', 'entity'], ['to_code', 'Due To (Owes)', 'entity'], ['description', 'Description', 'text'], ['due_from', "On the From-Entity's Books", 'number'], ['due_to', "On the To-Entity's Books", 'number']],
    blank: () => ({ from_code: '', to_code: '', description: '', due_from: 0, due_to: 0 }) },
  { id: 'holdings', title: 'Investments', table: 'fin_holdings', key: 'holdings', desc: 'Brokerage and money-market holdings at market value. The ledger carries book value; the dashboard shows market value and the unrealized gain.',
    cols: [['entity_code', 'Entity', 'entity'], ['account_label', 'Account', 'text'], ['symbol', 'Symbol', 'text'], ['name', 'Name', 'text'], ['asset_class', 'Class', 'select', ['Equity', 'Equity ETF', 'Treasuries', 'Money Market', 'Bonds']], ['quantity', 'Qty', 'number', '0.0001'], ['cost', 'Cost', 'number'], ['market_value', 'Market Value', 'number'], ['prior_value', 'Prior Month Value', 'number'], ['valued_at', 'Valued', 'date']],
    blank: () => ({ entity_code: '', account_label: '', symbol: '', name: '', asset_class: 'Equity', quantity: 0, cost: 0, market_value: 0, prior_value: 0, valued_at: null }) },
  { id: 'partners', title: 'Partner Capital', table: 'fin_partner_capital', key: 'partnerCapital', desc: 'Investor classes per entity with capital, ownership share and the scheduled distribution.',
    cols: [['entity_code', 'Entity', 'entity'], ['class_name', 'Class', 'text'], ['capital', 'Capital', 'number'], ['ownership', 'Ownership (0.72 = 72%)', 'number', '0.0001'], ['distribution', 'Distribution per Period', 'number'], ['frequency', 'Frequency', 'select', ['M', 'Q']], ['sort', 'Order', 'number']],
    blank: () => ({ entity_code: '', class_name: '', capital: 0, ownership: 0, distribution: 0, frequency: 'Q', sort: 0 }) },
  { id: 'caprates', title: 'Cap Rates', table: 'fin_cap_rates', key: 'capRates', desc: 'Market cap rate by asset type, used to imply portfolio value from trailing NOI. Give each property entity its asset type in Nexus Accounting, Setup, Entities.',
    cols: [['asset_type', 'Asset Type', 'text'], ['cap_rate', 'Cap Rate (0.0575 = 5.75%)', 'number', '0.0001']], keyOf: (r) => r.asset_type, match: (r) => ({ asset_type: r.asset_type }),
    blank: () => ({ asset_type: '', cap_rate: 0.06 }) },
  { id: 'close', title: 'Close Checklist', table: 'fin_close_tasks', key: 'closeTasks', desc: 'The month-end plan: phase, task, owner, and the business day after period end it is due.',
    cols: [['phase', 'Phase', 'text'], ['title', 'Task', 'text'], ['owner', 'Owner', 'text'], ['day_offset', 'Due Day', 'number'], ['sort', 'Order', 'number'], ['is_active', 'Active', 'check']],
    blank: () => ({ phase: '', title: '', owner: '', day_offset: 1, sort: 99, is_active: true }) },
  { id: 'deadlines', title: 'Filing Calendar', table: 'fin_deadlines', key: 'deadlines', desc: 'Recurring filings and payments. Monthly entries take a day number; dated entries take month/day pairs.',
    cols: [['title', 'Deadline', 'text'], ['owner', 'Owner', 'text'], ['kind', 'Kind', 'select', ['monthly', 'dates']], ['schedule', 'Schedule', 'json'], ['sort', 'Order', 'number'], ['is_active', 'Active', 'check']],
    blank: () => ({ title: '', owner: '', kind: 'dates', schedule: [], sort: 99, is_active: true }) },
  { id: 'history', title: 'Close History', table: 'fin_close_history', key: 'closeHistory', desc: 'The business day each month closed on. The Close tab records it when a month reaches Closed; correct it here.',
    cols: [['period', 'Month (YYYY-MM)', 'text'], ['closed_day', 'Closed on Business Day', 'number']], keyOf: (r) => r.period, match: (r) => ({ period: r.period }),
    blank: () => ({ period: '', closed_day: 7 }) },
];

export default function DataTab() {
  const { tables, tablesLoading, act, ix } = useDash();
  const [tab, setTab] = useState(GRIDS[0].id);
  const def = GRIDS.find((g) => g.id === tab);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <SectionTabs tabs={GRIDS.map((g) => ({ id: g.id, label: g.title }))} value={tab} onChange={setTab} />
        <button type="button" className="secondary-btn" style={{ marginLeft: 'auto', fontSize: '0.74rem', padding: '4px 10px' }} onClick={() => act('seed')}>Seed Defaults</button>
      </div>
      <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{def.desc} Edits save when you leave a field.</p>
      {tablesLoading ? <SkeletonBlocks count={1} height={200} /> : <Grid key={def.id} def={def} rows={tables?.[def.key] ?? []} act={act} ix={ix} />}
    </div>
  );
}

function Grid({ def, rows, act, ix }) {
  const [adding, setAdding] = useState(null);
  // Confirmed in place by the row (Remove / Keep) - never a browser dialog.
  const remove = (r) => act('row-delete', { table: def.table, match: def.match ? def.match(r) : { id: r.id } });
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px', borderBottom: '1px solid var(--border-color)' }}>
        <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setAdding(def.blank())}><Plus size={13} /> Add Row</button>
      </div>
      <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
        <table className="req-table">
          <thead><tr>{def.cols.map((c) => <th key={c[0]}>{c[1]}</th>)}<th style={{ width: 36 }} /></tr></thead>
          <tbody>
            {rows.map((r) => <EditRow key={def.keyOf ? def.keyOf(r) : r.id} def={def} row={r} act={act} ix={ix} onDelete={() => remove(r)} />)}
            {adding ? <EditRow def={def} row={adding} isNew act={act} ix={ix} onSaved={() => setAdding(null)} onDelete={() => setAdding(null)} /> : null}
            {!rows.length && !adding ? <tr><td colSpan={def.cols.length + 1} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Nothing here yet. Add a row, or seed the defaults.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const REQUIRED = ['lender', 'class_name', 'asset_type', 'title', 'period', 'account_label'];

function EditRow({ def, row, isNew, act, ix, onSaved, onDelete }) {
  const [draft, setDraft] = useState(row);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');     // why the row did not save, shown under it
  const [asking, setAsking] = useState(false);    // Delete, confirmed in place
  const [removing, setRemoving] = useState(false);
  const last = useRef(JSON.stringify(row));
  useEffect(() => { setDraft(row); last.current = JSON.stringify(row); }, [row]);
  // Top-level entities only (the dashboard rolls figures up to roots), in the
  // module's one entity picker (Oct 7): number order, searchable by number.
  const roots = useMemo(() => ix.roots.map((e) => ({ ...e, parent_code: '' })), [ix]);

  const save = async (next) => {
    if (JSON.stringify(next) === last.current) return;
    if (isNew && def.cols.some(([k, , t]) => t === 'text' && REQUIRED.includes(k) && !String(next[k] ?? '').trim())) return;
    const payload = { ...next };
    delete payload.ledger_balance;
    delete payload.ledger_asof;
    for (const [k, , t] of def.cols) {
      if (t === 'number' || t === 'balance') payload[k] = payload[k] === '' || payload[k] == null ? null : Number(payload[k]);
      if (t === 'date' && !payload[k]) payload[k] = null;
      if (t === 'json' && typeof payload[k] === 'string') { try { payload[k] = JSON.parse(payload[k]); } catch { setProblem('The schedule must be JSON, e.g. [[4,15],[6,15]] - not saved.'); return; } }
    }
    setSaving(true);
    setProblem('');
    try { await act('row-save', { table: def.table, row: payload }); last.current = JSON.stringify(next); onSaved?.(); }
    catch (e) { setProblem(e?.message || 'Could not save the row.'); }
    finally { setSaving(false); }
  };
  const confirmRemove = async () => {
    setRemoving(true);
    setProblem('');
    try { await onDelete(); }
    catch (e) { setProblem(e?.message || 'Could not delete the row.'); setAsking(false); }
    finally { setRemoving(false); }
  };
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setAndSave = (k, v) => { const next = { ...draft, [k]: v }; setDraft(next); save(next); };
  const style = { ...input, width: '100%', boxSizing: 'border-box', opacity: saving ? 0.6 : 1 };

  const field = ([k, label, t, extra, names]) => {
    const v = draft[k];
    switch (t) {
      case 'check': return <input type="checkbox" checked={!!v} onChange={(e) => setAndSave(k, e.target.checked)} aria-label={label} />;
      case 'entity': return <EntityPicker entities={roots} value={v ?? ''} onChange={(code) => setAndSave(k, code)} noneLabel="None" ariaLabel={label} active={false} disabled={saving} style={{ width: '100%', maxWidth: 'none' }} />;
      case 'select': return <select value={v ?? ''} onChange={(e) => setAndSave(k, e.target.value)} aria-label={label} style={style}>{extra.map((o) => <option key={o} value={o}>{names?.[o] || o}</option>)}</select>;
      case 'balance': {
        // A ledger-sourced loan shows the figure the ledger gave as of the month shown; only a hand-kept one is typed.
        if (draft.balance_source === 'ledger') {
          const has = draft.ledger_balance != null;
          const hint = has ? `From the ledger as of ${draft.ledger_asof || 'the month shown'}` : draft.gl_account ? 'No balance on that account in this entity yet' : 'Give the loan its GL account';
          return (
            <span aria-label={label} title={hint} style={{ display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: has ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: '0.8rem' }}>
              {has ? Number(draft.ledger_balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : draft.gl_account ? 'Not on the ledger' : 'Needs a GL account'}
            </span>
          );
        }
        return <input type="number" step="0.01" value={v == null ? '' : String(v)} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} aria-label={label} style={{ ...style, textAlign: 'right' }} />;
      }
      case 'json': return <input value={typeof v === 'string' ? v : JSON.stringify(v ?? [])} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} placeholder="monthly: [1] · dates: [[4,15],[6,15]]" aria-label={label} style={{ ...style, fontFamily: 'monospace' }} />;
      case 'number': return <input type="number" step={extra ?? '0.01'} value={v == null ? '' : String(v)} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} aria-label={label} style={{ ...style, textAlign: 'right' }} />;
      case 'date': return <input type="date" value={v ? String(v).slice(0, 10) : ''} onChange={(e) => set(k, e.target.value || null)} onBlur={() => save(draft)} aria-label={label} style={style} />;
      default: return <input value={v ?? ''} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} aria-label={label} style={style} />;
    }
  };
  return (
    <Fragment>
      <tr style={isNew ? { background: 'var(--wk-brand-tint, #e8ecfd)' } : undefined}>
        {def.cols.map((c) => <td key={c[0]} style={{ padding: '4px 6px' }}>{field(c)}</td>)}
        <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
          {asking ? (
            <span role="group" aria-label="Delete this row?" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button type="button" className="primary-btn" disabled={removing} onClick={confirmRemove}
                style={{ fontSize: '0.72rem', height: 24, padding: '0 8px', background: 'var(--bad-fg, #dc2626)', borderColor: 'var(--bad-fg, #dc2626)' }}>{removing ? 'Removing...' : 'Remove'}</button>
              <button type="button" className="secondary-btn" disabled={removing} onClick={() => setAsking(false)} style={{ fontSize: '0.72rem', height: 24, padding: '0 8px' }}>Keep</button>
            </span>
          ) : (
            <button type="button" className="icon-btn" aria-label="Delete row" onClick={() => (isNew ? onDelete() : setAsking(true))} style={{ padding: 4, color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
          )}
        </td>
      </tr>
      {problem && (
        <tr>
          <td colSpan={def.cols.length + 1} role="alert" style={{ padding: '2px 8px 6px', fontSize: '0.76rem', color: 'var(--bad-fg, #dc2626)' }}>{problem}</td>
        </tr>
      )}
    </Fragment>
  );

}
