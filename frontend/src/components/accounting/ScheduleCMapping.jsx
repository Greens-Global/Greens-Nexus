import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import Amount from './Amount';
import { control } from './reportControls';
import { FORM, SCHEDULE_C_LINES, SKIP, lineText } from './scheduleC';

// Schedule C (Draft) -> Line Mapping (10/27 triage item 18): which Schedule C
// line each income statement account adds into, for the entity on the report
// (or every entity when none or several are picked). Each row shows what the
// account adds into today and where that came from - mapped for this entity,
// mapped for every entity, or suggested from its name - and a Line box to
// change it. Saved in Nexus only (PUT /accounting/tax-lines); nothing goes to
// Intacct. One Save for the whole list; Accept Suggestions keeps every
// suggested line as a saved one.

const SHOW = [
  { key: 'all', label: 'All Accounts' },
  { key: 'unmapped', label: 'Not Mapped' },
  { key: 'suggested', label: 'Suggested' },
  { key: 'saved', label: 'Mapped' },
];
const SOURCE = { entity: 'This entity', all: 'Every entity', suggested: 'Suggested', '': 'Not mapped' };
const SECTION = { revenue: 'Revenue', cogs: 'Cost of Sales', expense: 'Operating Expenses', other_income: 'Other Income', other_expense: 'Other Expenses' };

export default function ScheduleCMapping({ rows = [], entity = '', entityLabel = '', canEdit = true, onClose, onSaved }) {
  const [draft, setDraft] = useState({});   // code -> line ('' = clear this scope's line)
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What this scope saved: an entity's own line, or (no entity) the every-entity line.
  const own = (r) => (entity ? (r.source === 'entity' ? r.line : '') : (r.source === 'all' ? r.line : ''));
  const pick = (r) => (r.code in draft ? draft[r.code] : own(r));
  const changed = Object.entries(draft).filter(([code, line]) => {
    const r = rows.find((x) => x.code === code);
    return r && line !== own(r);
  });
  const dirty = changed.length > 0;
  const counts = useMemo(() => ({
    unmapped: rows.filter((r) => !r.line).length, suggested: rows.filter((r) => r.source === 'suggested').length,
  }), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => (show === 'all' || (show === 'unmapped' ? !r.line : show === 'suggested' ? r.source === 'suggested' : r.source === 'entity' || r.source === 'all'))
      && (!s || `${r.code} ${r.title} ${lineText(r.line)}`.toLowerCase().includes(s)));
  }, [rows, q, show]);
  const acceptSuggestions = () => setDraft((d) => {
    const next = { ...d };
    rows.forEach((r) => { if (r.source === 'suggested' && r.suggested && !(r.code in d)) next[r.code] = r.suggested; });
    return next;
  });
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.saveAccountingTaxLines({ form: FORM, entity, lines: changed.map(([accountNo, line]) => ({ accountNo, line })) });
      setDraft({});
      onSaved?.();
    } catch (e) {
      setError(e?.message || 'Could not save the mapping.');
    } finally {
      setBusy(false);
    }
  };
  const scope = entity ? `${entityLabel || entity} only - overrides the mapping for every entity` : 'Every entity - an entity\'s own mapping overrides it (pick one entity on the report to set one)';
  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', flexWrap: 'wrap' }}>
      {canEdit && counts.suggested > 0 && (
        <button type="button" className="secondary-btn" onClick={acceptSuggestions} title="Keep every suggested line as a saved mapping" style={{ fontSize: '0.78rem' }}>Accept Suggestions ({counts.suggested})</button>
      )}
      <span style={{ flex: 1 }} />
      {error && <span role="alert" style={{ color: 'var(--bad-fg, #dc2626)', fontSize: '0.78rem' }}>{error}</span>}
      {canEdit && <button type="button" className="secondary-btn" disabled={!dirty || busy} onClick={() => setDraft({})} style={{ fontSize: '0.78rem' }}>Discard Changes</button>}
      {canEdit
        ? <button type="button" className="primary-btn" disabled={!dirty || busy} onClick={save} style={{ fontSize: '0.78rem' }}>{busy ? 'Saving...' : dirty ? `Save (${changed.length})` : 'Save'}</button>
        : <button type="button" className="secondary-btn" onClick={onClose} style={{ fontSize: '0.78rem' }}>Close</button>}
    </div>
  );
  return (
    <Modal title="Schedule C Line Mapping" onClose={onClose} footer={footer} isDirty={dirty}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flex: 1 }}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Saving for: <strong style={{ color: 'var(--text-primary)' }}>{scope}</strong>. Kept in Nexus only - nothing is sent to Intacct.
          {!canEdit && ' You can read the mapping; changing it needs the editor level on Accounting.'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" placeholder="Search account, name or line" style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </div>
          <div role="group" aria-label="Show" style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
            {SHOW.map((f) => (
              <button key={f.key} type="button" aria-pressed={show === f.key} onClick={() => setShow(f.key)}
                style={{ border: 'none', padding: '0 10px', height: 28, font: 'inherit', fontSize: '0.76rem', cursor: 'pointer', fontWeight: show === f.key ? 600 : 400,
                  background: show === f.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: show === f.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)' }}>
                {f.label}{f.key === 'unmapped' ? ` (${counts.unmapped})` : f.key === 'suggested' ? ` (${counts.suggested})` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="acct-lines-wrap nx-fill" style={{ overflow: 'auto', minHeight: 0 }}>
          <table className="acct-lines acct-sticky-head" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead>
              <tr><th scope="col">Account</th><th scope="col">Section</th><th scope="col" className="acct-num">Amount</th><th scope="col">Adds Into Today</th><th scope="col">Line</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.code || r.title}>
                  <td style={{ whiteSpace: 'normal', minWidth: 150 }}><span className="acct-code">{r.code}</span> {r.title}</td>
                  <td style={{ color: 'var(--text-secondary)', whiteSpace: 'normal', maxWidth: 110 }}>{SECTION[r.section] || r.section}</td>
                  <td className="acct-num"><Amount value={r.amount} /></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 130 }}>
                    <span style={{ color: r.line ? undefined : 'var(--bad-fg, #dc2626)' }}>{r.line ? lineText(r.line) : 'Not mapped'}</span>
                    {r.line && <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{SOURCE[r.source]}</span>}
                  </td>
                  <td>
                    <select value={pick(r)} disabled={!canEdit || !r.code} onChange={(e) => setDraft((d) => ({ ...d, [r.code]: e.target.value }))}
                      aria-label={`Line for ${r.code} ${r.title}`} style={{ ...control, width: 170, maxWidth: 170, fontWeight: r.code in draft ? 600 : 400 }}>
                      <option value="">{entity && (r.source === 'all') ? `As Every Entity: Line ${r.line === SKIP ? '-' : r.line}` : r.suggested ? `Suggested: Line ${r.suggested}` : 'Not Mapped'}</option>
                      <optgroup label="Part I - Income">
                        {SCHEDULE_C_LINES.filter((l) => l.part === 1).map((l) => <option key={l.line} value={l.line}>{lineText(l.line)}</option>)}
                      </optgroup>
                      <optgroup label="Part II - Expenses">
                        {SCHEDULE_C_LINES.filter((l) => l.part !== 1).map((l) => <option key={l.line} value={l.line}>{lineText(l.line)}</option>)}
                      </optgroup>
                      <option value={SKIP}>{lineText(SKIP)}</option>
                    </select>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 18 }}>{rows.length ? 'No account matches.' : 'No income statement accounts with activity in this period.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
