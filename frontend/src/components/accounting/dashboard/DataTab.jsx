import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SkeletonBlocks } from '../../AsyncState';
import { SectionTabs, card, input } from './Bits';
import { useDash } from './DashContext';

// Accounting -> Data. The figures the ledger does not carry: loans and
// covenants, intercompany balances, brokerage holdings, partner capital, cap
// rates, the close checklist, the filing calendar and close history. One grid
// per table; a row saves when you leave a field. Editors and up.

const GRIDS = [
  { id: 'loans', title: 'Loans', table: 'fin_loans', key: 'loans', desc: 'Mortgages and credit lines: balance, rate, maturity, monthly principal and interest, DSCR and the covenant minimum.',
    cols: [['lender', 'Lender', 'text'], ['entity_code', 'Entity / property', 'entity'], ['balance', 'Balance', 'number'], ['rate_pct', 'Rate %', 'number', '0.01'], ['maturity', 'Maturity', 'date'], ['monthly_pi', 'Monthly P&I', 'number'], ['dscr', 'DSCR', 'number', '0.01'], ['covenant_min', 'Covenant min', 'number', '0.01'], ['is_active', 'Active', 'check']],
    blank: () => ({ lender: '', entity_code: '', balance: 0, rate_pct: 0, maturity: null, monthly_pi: 0, dscr: null, covenant_min: null, is_active: true, notes: '' }) },
  { id: 'intercompany', title: 'Intercompany', table: 'fin_intercompany', key: 'intercompany', desc: 'Due-from and due-to pairs. Matched when both sides agree; the dashboard flags any difference before consolidation.',
    cols: [['from_code', 'Due from (owed to)', 'entity'], ['to_code', 'Due to (owes)', 'entity'], ['description', 'Description', 'text'], ['due_from', "On the from-entity's books", 'number'], ['due_to', "On the to-entity's books", 'number']],
    blank: () => ({ from_code: '', to_code: '', description: '', due_from: 0, due_to: 0 }) },
  { id: 'holdings', title: 'Investments', table: 'fin_holdings', key: 'holdings', desc: 'Brokerage and money-market holdings at market value. The ledger carries book value; the dashboard shows market value and the unrealized gain.',
    cols: [['entity_code', 'Entity', 'entity'], ['account_label', 'Account', 'text'], ['symbol', 'Symbol', 'text'], ['name', 'Name', 'text'], ['asset_class', 'Class', 'select', ['Equity', 'Equity ETF', 'Treasuries', 'Money Market', 'Bonds']], ['quantity', 'Qty', 'number', '0.0001'], ['cost', 'Cost', 'number'], ['market_value', 'Market value', 'number'], ['prior_value', 'Prior month value', 'number'], ['valued_at', 'Valued', 'date']],
    blank: () => ({ entity_code: '', account_label: '', symbol: '', name: '', asset_class: 'Equity', quantity: 0, cost: 0, market_value: 0, prior_value: 0, valued_at: null }) },
  { id: 'partners', title: 'Partner capital', table: 'fin_partner_capital', key: 'partnerCapital', desc: 'Investor classes per entity with capital, ownership share and the scheduled distribution.',
    cols: [['entity_code', 'Entity', 'entity'], ['class_name', 'Class', 'text'], ['capital', 'Capital', 'number'], ['ownership', 'Ownership (0.72 = 72%)', 'number', '0.0001'], ['distribution', 'Distribution per period', 'number'], ['frequency', 'Frequency', 'select', ['M', 'Q']], ['sort', 'Order', 'number']],
    blank: () => ({ entity_code: '', class_name: '', capital: 0, ownership: 0, distribution: 0, frequency: 'Q', sort: 0 }) },
  { id: 'caprates', title: 'Cap rates', table: 'fin_cap_rates', key: 'capRates', desc: 'Market cap rate by asset type, used to imply portfolio value from trailing NOI. Give each property entity its asset type in Nexus Accounting, Setup, Entities.',
    cols: [['asset_type', 'Asset type', 'text'], ['cap_rate', 'Cap rate (0.0575 = 5.75%)', 'number', '0.0001']], keyOf: (r) => r.asset_type, match: (r) => ({ asset_type: r.asset_type }),
    blank: () => ({ asset_type: '', cap_rate: 0.06 }) },
  { id: 'close', title: 'Close checklist', table: 'fin_close_tasks', key: 'closeTasks', desc: 'The month-end plan: phase, task, owner, and the business day after period end it is due.',
    cols: [['phase', 'Phase', 'text'], ['title', 'Task', 'text'], ['owner', 'Owner', 'text'], ['day_offset', 'Due day', 'number'], ['sort', 'Order', 'number'], ['is_active', 'Active', 'check']],
    blank: () => ({ phase: '', title: '', owner: '', day_offset: 1, sort: 99, is_active: true }) },
  { id: 'deadlines', title: 'Filing calendar', table: 'fin_deadlines', key: 'deadlines', desc: 'Recurring filings and payments. Monthly entries take a day number; dated entries take month/day pairs.',
    cols: [['title', 'Deadline', 'text'], ['owner', 'Owner', 'text'], ['kind', 'Kind', 'select', ['monthly', 'dates']], ['schedule', 'Schedule', 'json'], ['sort', 'Order', 'number'], ['is_active', 'Active', 'check']],
    blank: () => ({ title: '', owner: '', kind: 'dates', schedule: [], sort: 99, is_active: true }) },
  { id: 'history', title: 'Close history', table: 'fin_close_history', key: 'closeHistory', desc: 'The business day each month closed on. The Close tab records it when a month reaches Closed; correct it here.',
    cols: [['period', 'Month (YYYY-MM)', 'text'], ['closed_day', 'Closed on business day', 'number']], keyOf: (r) => r.period, match: (r) => ({ period: r.period }),
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
        <button type="button" className="secondary-btn" style={{ marginLeft: 'auto', fontSize: '0.74rem', padding: '4px 10px' }} onClick={() => act('seed')}>Seed defaults</button>
      </div>
      <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{def.desc} Edits save when you leave a field.</p>
      {tablesLoading ? <SkeletonBlocks count={1} height={200} /> : <Grid key={def.id} def={def} rows={tables?.[def.key] ?? []} act={act} ix={ix} />}
    </div>
  );
}

function Grid({ def, rows, act, ix }) {
  const [adding, setAdding] = useState(null);
  const remove = async (r) => {
    if (!window.confirm('Delete this row?')) return;
    await act('row-delete', { table: def.table, match: def.match ? def.match(r) : { id: r.id } });
  };
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px', borderBottom: '1px solid var(--border-color)' }}>
        <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setAdding(def.blank())}><Plus size={13} /> Add row</button>
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
  const last = useRef(JSON.stringify(row));
  useEffect(() => { setDraft(row); last.current = JSON.stringify(row); }, [row]);
  const roots = useMemo(() => [...ix.roots].sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code, 'en-US', { numeric: true })), [ix]);

  const save = async (next) => {
    if (JSON.stringify(next) === last.current) return;
    if (isNew && def.cols.some(([k, , t]) => t === 'text' && REQUIRED.includes(k) && !String(next[k] ?? '').trim())) return;
    const payload = { ...next };
    for (const [k, , t] of def.cols) {
      if (t === 'number') payload[k] = payload[k] === '' || payload[k] == null ? null : Number(payload[k]);
      if (t === 'date' && !payload[k]) payload[k] = null;
      if (t === 'json' && typeof payload[k] === 'string') { try { payload[k] = JSON.parse(payload[k]); } catch { window.alert('Schedule must be JSON, e.g. [[4,15],[6,15]]'); return; } }
    }
    setSaving(true);
    try { await act('row-save', { table: def.table, row: payload }); last.current = JSON.stringify(next); onSaved?.(); }
    catch (e) { window.alert(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setAndSave = (k, v) => { const next = { ...draft, [k]: v }; setDraft(next); save(next); };
  const style = { ...input, width: '100%', boxSizing: 'border-box', opacity: saving ? 0.6 : 1 };

  const field = ([k, label, t, extra]) => {
    const v = draft[k];
    switch (t) {
      case 'check': return <input type="checkbox" checked={!!v} onChange={(e) => setAndSave(k, e.target.checked)} aria-label={label} />;
      case 'entity': return <select value={v ?? ''} onChange={(e) => setAndSave(k, e.target.value)} aria-label={label} style={style}><option value="">- none -</option>{roots.map((e) => <option key={e.code} value={e.code}>{e.name || e.code} ({e.code})</option>)}</select>;
      case 'select': return <select value={v ?? ''} onChange={(e) => setAndSave(k, e.target.value)} aria-label={label} style={style}>{extra.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
      case 'json': return <input value={typeof v === 'string' ? v : JSON.stringify(v ?? [])} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} placeholder="monthly: [1] · dates: [[4,15],[6,15]]" aria-label={label} style={{ ...style, fontFamily: 'monospace' }} />;
      case 'number': return <input type="number" step={extra ?? '0.01'} value={v == null ? '' : String(v)} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} aria-label={label} style={{ ...style, textAlign: 'right' }} />;
      case 'date': return <input type="date" value={v ? String(v).slice(0, 10) : ''} onChange={(e) => set(k, e.target.value || null)} onBlur={() => save(draft)} aria-label={label} style={style} />;
      default: return <input value={v ?? ''} onChange={(e) => set(k, e.target.value)} onBlur={() => save(draft)} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} aria-label={label} style={style} />;
    }
  };
  return (
    <tr style={isNew ? { background: 'var(--wk-brand-tint, #e8ecfd)' } : undefined}>
      {def.cols.map((c) => <td key={c[0]} style={{ padding: '4px 6px' }}>{field(c)}</td>)}
      <td style={{ padding: '4px 6px' }}><button type="button" className="icon-btn" aria-label="Delete row" onClick={onDelete} style={{ padding: 4, color: 'var(--text-muted)' }}><Trash2 size={13} /></button></td>
    </tr>
  );
}
