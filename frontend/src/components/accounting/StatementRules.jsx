import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { control } from './reportControls';

// Import Hub > Bank Statement to Intacct > Rules (Charmi, 10/27 call item 01:
// "We were able to create rules for each and every transaction"). The
// stand-alone Import Hub's Rules tab, ported: list, add, edit and delete the
// team's statement rules (routers/import_hub.py). Shared by the whole
// accounting team; the Accounting editor level changes them, anyone with
// Accounting reads them. Popup at the house 60% size, list grows into it.

const MATCH = [['contains', 'Contains'], ['equals', 'Equals'], ['starts_with', 'Starts With']];
const DIRECTION = [['any', 'Any'], ['in', 'Money In'], ['out', 'Money Out']];
const label = { display: 'grid', gap: 4, fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-secondary)' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 };
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nameOf = (list, id) => (list || []).find((p) => p.id === id)?.name || '';

const EMPTY_RULE = { matchText: '', matchType: 'contains', direction: 'any', amount: null, account: '', accountName: '', vendorId: '', vendorName: '', customerId: '', customerName: '', priority: 100, active: true, notes: '' };

/** Who / where a rule sends its lines, in one short line. */
function ruleTarget(r) {
  return [r.account && `${r.account}${r.accountName ? ` ${r.accountName}` : ''}`, r.vendorId && `Vendor ${r.vendorName || r.vendorId}`, r.customerId && `Customer ${r.customerName || r.customerId}`].filter(Boolean).join(' - ');
}

function RuleForm({ start, accounts, vendors, customers, onCancel, onSaved }) {
  const [d, setD] = useState({ ...EMPTY_RULE, ...start, amount: start.amount ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (p) => setD((x) => ({ ...x, ...p }));
  const save = async (e) => {
    e.preventDefault();
    if (!d.matchText.trim() || !d.account.trim()) { setError('Give the description text and the GL account.'); return; }
    setBusy(true); setError('');
    const body = {
      ...d, matchText: d.matchText.trim(), account: d.account.trim(), amount: d.amount === '' ? null : Number(d.amount),
      accountName: d.accountName || accounts.find((a) => String(a.account_no) === d.account.trim())?.title || '',
      vendorName: d.vendorId ? nameOf(vendors, d.vendorId.trim()) || d.vendorName : '', customerName: d.customerId ? nameOf(customers, d.customerId.trim()) || d.customerName : '',
      vendorId: d.vendorId.trim(), customerId: d.customerId.trim(), priority: Number(d.priority) || 0,
    };
    try {
      await (d.id ? api.updateStatementRule(d.id, body) : api.createStatementRule(body));
      onSaved(d.id ? 'Rule saved.' : 'Rule added - it applies to this statement now and to every later upload.');
    } catch (err) { setError(err?.message || 'Could not save the rule.'); }
    finally { setBusy(false); }
  };
  const text = (k, t, extra = {}) => <label style={label}>{t}<input value={d[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} style={{ ...control, width: '100%' }} {...extra} /></label>;
  const pick = (k, t, opts) => (
    <label style={label}>{t}
      <select value={d[k]} onChange={(e) => set({ [k]: e.target.value })} style={{ ...control, width: '100%' }}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>
  );
  return (
    <form onSubmit={save} style={{ display: 'grid', gap: 12 }} aria-label={d.id ? 'Edit Rule' : 'New Rule'}>
      <div style={grid}>
        <div style={{ gridColumn: '1 / -1' }}>{text('matchText', 'Description Holds', { placeholder: 'e.g. INTEREST PAYMENT', autoFocus: true })}</div>
        {pick('matchType', 'Match', MATCH)}
        {pick('direction', 'Direction', DIRECTION)}
        {text('amount', 'Only This Amount', { placeholder: 'Any amount', inputMode: 'decimal' })}
        {text('account', 'GL Account', { list: 'ih-accounts', placeholder: 'e.g. 40100' })}
        {text('vendorId', 'Vendor', { list: 'ih-vendors', placeholder: 'Optional - vendor ID' })}
        {text('customerId', 'Customer', { list: 'ih-customers', placeholder: 'Optional - customer ID' })}
        {text('priority', 'Priority', { inputMode: 'numeric', title: 'Lower runs first' })}
        <label style={{ ...label, alignContent: 'end' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32 }}>
            <input type="checkbox" checked={!!d.active} onChange={(e) => set({ active: e.target.checked })} /> Rule Is Active
          </span>
        </label>
        <div style={{ gridColumn: '1 / -1' }}>{text('notes', 'Notes', { placeholder: 'Optional' })}</div>
      </div>
      <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--text-muted)' }}>Case and extra spaces are ignored. The first active rule that matches a line, lowest priority number first, gives it its account, vendor and customer; a pick made on the line itself always wins.</p>
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #dc2626)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving...' : d.id ? 'Save Rule' : 'Add Rule'}</button>
      </div>
    </form>
  );
}

export default function StatementRules({ rules, draft = null, accounts = [], vendors = [], customers = [], onChanged, onClose }) {
  const [editing, setEditing] = useState(draft);   // a rule (or a new one) in the form; null = the list
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rules.filter((r) => JSON.stringify(r).toLowerCase().includes(s)) : rules;
  }, [rules, q]);
  const saved = (msg) => { setEditing(null); setNote(msg); onChanged(); };
  const remove = async (r) => {
    try { await api.deleteStatementRule(r.id); setConfirm(''); setNote('Rule deleted.'); onChanged(); } catch (e) { setNote(e?.message || 'Could not delete the rule.'); }
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content nx-popup" role="dialog" aria-modal="true" aria-label="Statement Rules" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{editing ? (editing.id ? 'Edit Rule' : 'New Rule') : `Statement Rules (${rules.length})`}</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>Shared by the accounting team and applied to every statement uploaded here.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div className="nx-fill" style={{ padding: '12px 24px 18px', overflowY: 'auto', gap: 10 }}>
          {editing ? (
            <RuleForm start={editing} accounts={accounts} vendors={vendors} customers={customers} onCancel={() => setEditing(null)} onSaved={saved} />
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules" aria-label="Search rules" style={{ ...control, width: 240 }} />
                {note && <span role="status" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{note}</span>}
                <button type="button" className="primary-btn" onClick={() => { setNote(''); setEditing({ ...EMPTY_RULE }); }} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> New Rule</button>
              </div>
              <div className="req-table-wrapper nx-fill" style={{ overflow: 'auto' }}>
                <table className="req-table" aria-label="Rules">
                  <thead><tr><th>Priority</th><th>Description</th><th>Direction</th><th style={{ textAlign: 'right' }}>Amount</th><th>Posts To</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id} style={r.active ? undefined : { color: 'var(--text-muted)' }}>
                        <td>{r.priority}</td>
                        <td><strong>{r.matchText}</strong><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{MATCH.find((m) => m[0] === r.matchType)?.[1]}{r.notes ? ` - ${r.notes}` : ''}</div></td>
                        <td>{DIRECTION.find((m) => m[0] === r.direction)?.[1]}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.amount ? fmt(r.amount) : 'Any'}</td>
                        <td>{ruleTarget(r)}</td>
                        <td>{r.active ? 'Active' : 'Off'}</td>
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {confirm === r.id ? (
                            <>
                              <span style={{ fontSize: '0.76rem', marginRight: 6 }}>Delete this rule?</span>
                              <button type="button" className="secondary-btn" onClick={() => remove(r)} style={{ padding: '3px 8px', color: 'var(--danger, #dc2626)' }}>Delete</button>{' '}
                              <button type="button" className="secondary-btn" onClick={() => setConfirm('')} style={{ padding: '3px 8px' }}>Keep</button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="secondary-btn" onClick={() => { setNote(''); setEditing(r); }} aria-label={`Edit rule ${r.matchText}`} style={{ padding: '3px 8px' }}><Pencil size={13} /></button>{' '}
                              <button type="button" className="secondary-btn" onClick={() => setConfirm(r.id)} aria-label={`Delete rule ${r.matchText}`} style={{ padding: '3px 8px' }}><Trash2 size={13} /></button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                    {shown.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--text-muted)' }}>{rules.length ? 'No rule matches that search.' : 'No rules yet. Add one here, or use Save as Rule on a statement line.'}</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
