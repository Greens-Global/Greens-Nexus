import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import Amount from './Amount';
import { control } from './reportControls';
import { FORMS, SKIP, TAX_REPORTS, lineChoices, lineText as formLineText } from './taxForms/engine';
import { ColumnFilterRow, ColumnFiltersEmpty, useColumnFilters } from './columnFilters';
import { filterCellOf } from './viewFilterColumns';

// Tax forms -> Line Mapping (10/27 triage item 18, Schedule C first; every
// form of the tax engine since 11/19/2026): which line of the form each
// account adds into, for the entity on the report (or every entity when none
// or several are picked). Each row shows what the account adds into today and
// where that came from - mapped for this entity, mapped for every entity, or
// suggested from its name - and a Line box to change it. Saved in Nexus only
// (PUT /accounting/tax-lines); nothing goes to Intacct. One Save for the whole
// list; Accept Suggestions keeps every suggested line as a saved one. On the
// Form 1040 the rows are the entities (Schedule C or Schedule E), each saved
// for its own entity.

const SHOW = [
  { key: 'all', label: 'All Accounts' },
  { key: 'unmapped', label: 'Not Mapped' },
  { key: 'suggested', label: 'Suggested' },
  { key: 'saved', label: 'Mapped' },
];
const SOURCE = { entity: 'This Entity', all: 'Every Entity', suggested: 'Suggested', '': 'Not Mapped' };
const SECTION = { revenue: 'Revenue', cogs: 'Cost of Sales', expense: 'Operating Expenses', other_income: 'Other Income', other_expense: 'Other Expenses', asset: 'Assets', liability: 'Liabilities', equity: 'Equity', entity: 'Entity' };
const filterCell = filterCellOf();
const keyOf = (r) => r.rowKey || r.code;

export default function ScheduleCMapping({ rows = [], entity = '', entityLabel = '', canEdit = true, onClose, onSaved, taxForm = null }) {
  const { form, report } = TAX_REPORTS[taxForm?.report] || { form: FORMS.schedule_c, report: FORMS.schedule_c.reports[0] };
  const lineText = (line) => formLineText(form, line);
  const choices = lineChoices(form, report);
  const byEntity = report.basis === 'returns';
  const [draft, setDraft] = useState({});   // row key -> line ('' = clear this scope's line)
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What this scope saved: an entity's own line, or (no entity) the every-entity line.
  const own = (r) => ((r.saveEntity || entity) ? (r.source === 'entity' ? r.line : '') : (r.source === 'all' ? r.line : ''));
  const pick = (r) => (keyOf(r) in draft ? draft[keyOf(r)] : own(r));
  const short = (line) => (line === SKIP ? '-' : (line || '').replace(/^[a-z]+(?=\d)/, ''));
  // The Line box's first choice: nothing saved in this scope.
  const emptyLine = (r) => ((r.saveEntity || entity) && (r.source === 'all') ? `As Every Entity: ${byEntity ? lineText(r.line) : `Line ${short(r.line)}`}`
    : r.suggested ? `Suggested: ${byEntity ? lineText(r.suggested) : `Line ${short(r.suggested)}`}` : 'Not Mapped');
  const changed = Object.entries(draft).filter(([k, line]) => {
    const r = rows.find((x) => keyOf(x) === k);
    return r && line !== own(r);
  });
  const dirty = changed.length > 0;
  const counts = useMemo(() => ({
    unmapped: rows.filter((r) => !r.line).length, suggested: rows.filter((r) => r.source === 'suggested').length,
  }), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => (show === 'all' || (show === 'unmapped' ? !r.line : show === 'suggested' ? r.source === 'suggested' : r.source === 'entity' || r.source === 'all'))
      && (!s || `${byEntity ? '' : r.code} ${r.title} ${lineText(r.line)}`.toLowerCase().includes(s)));
  }, [rows, q, show]); // eslint-disable-line react-hooks/exhaustive-deps
  const columns = useMemo(() => [
    { key: 'account', label: byEntity ? 'Entity' : 'Account', text: (r) => (byEntity ? r.title : `${r.code || ''} ${r.title || ''}`) },
    { key: 'section', label: 'Section', text: (r) => SECTION[r.section] || r.section || '' },
    { key: 'amount', label: byEntity ? 'Net Income' : 'Amount', num: true, value: (r) => Number(r.amount) || 0 },
    { key: 'today', label: 'Adds Into Today', text: (r) => (r.line ? `${lineText(r.line)} ${SOURCE[r.source] || ''}` : 'Not Mapped') },
    { key: 'line', label: 'Line', text: (r) => (pick(r) ? lineText(pick(r)) : emptyLine(r)) },
  ], [draft, entity, form, report]); // eslint-disable-line react-hooks/exhaustive-deps
  const filters = useColumnFilters(shown, columns);
  const listed = filters.rows;
  const acceptSuggestions = () => setDraft((d) => {
    const next = { ...d };
    rows.forEach((r) => { if (r.source === 'suggested' && r.suggested && !(keyOf(r) in d)) next[keyOf(r)] = r.suggested; });
    return next;
  });
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError('');
    try {
      // One call per entity scope: the report's scope, or (Form 1040) each row's own entity.
      const scopes = new Map();
      changed.forEach(([k, line]) => {
        const r = rows.find((x) => keyOf(x) === k);
        const scope = r.saveEntity || entity;
        if (!scopes.has(scope)) scopes.set(scope, []);
        scopes.get(scope).push({ accountNo: r.code, line });
      });
      for (const [scope, lines] of scopes) await api.saveAccountingTaxLines({ form: form.form, entity: scope, lines });
      setDraft({});
      onSaved?.();
    } catch (e) {
      setError(e?.message || 'Could not save the mapping.');
    } finally {
      setBusy(false);
    }
  };
  const scope = byEntity ? 'each entity on its own row'
    : entity ? `${entityLabel || entity} only - overrides the mapping for every entity` : 'Every entity - an entity\'s own mapping overrides it (pick one entity on the report to set one)';
  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', flexWrap: 'wrap' }}>
      {canEdit && counts.suggested > 0 && (
        <button type="button" className="secondary-btn" onClick={acceptSuggestions} title="Keep every suggested line as a saved mapping" style={{ fontSize: 13 }}>Accept Suggestions ({counts.suggested})</button>
      )}
      <span style={{ flex: 1 }} />
      {error && <span role="alert" style={{ color: 'var(--bad-fg, #dc2626)', fontSize: 13 }}>{error}</span>}
      {canEdit && <button type="button" className="secondary-btn" disabled={!dirty || busy} onClick={() => setDraft({})} style={{ fontSize: 13 }}>Discard Changes</button>}
      {canEdit
        ? <button type="button" className="primary-btn" disabled={!dirty || busy} onClick={save} style={{ fontSize: 13 }}>{busy ? 'Saving...' : dirty ? `Save (${changed.length})` : 'Save'}</button>
        : <button type="button" className="secondary-btn" onClick={onClose} style={{ fontSize: 13 }}>Close</button>}
    </div>
  );
  return (
    <Modal title={`${form.title} Line Mapping`} onClose={onClose} footer={footer} isDirty={dirty}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Saving for: <strong style={{ color: 'var(--text-primary)' }}>{scope}</strong>. Kept in Nexus only - nothing is sent to Intacct.
          {!canEdit && ' You can read the mapping; changing it needs the editor level on Accounting.'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" placeholder={byEntity ? 'Search entity or schedule' : 'Search account, name or line'} style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </div>
          <div role="group" aria-label="Show" style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
            {SHOW.map((f) => (
              <button key={f.key} type="button" aria-pressed={show === f.key} onClick={() => setShow(f.key)}
                style={{ border: 'none', padding: '0 10px', height: 28, font: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: show === f.key ? 600 : 400,
                  background: show === f.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: show === f.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)' }}>
                {byEntity && f.key === 'all' ? 'All Entities' : f.label}{f.key === 'unmapped' ? ` (${counts.unmapped})` : f.key === 'suggested' ? ` (${counts.suggested})` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="acct-lines-wrap nx-fill" style={{ overflow: 'auto', minHeight: 0 }}>
          <table className="acct-lines acct-sticky-head" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead>
              <tr><th scope="col">{byEntity ? 'Entity' : 'Account'}</th><th scope="col">Section</th><th scope="col" className="acct-num">{byEntity ? 'Net Income' : 'Amount'}</th><th scope="col">Adds Into Today</th><th scope="col">Line</th></tr>
              <ColumnFilterRow columns={columns} typed={filters.typed} onChange={filters.setFilter} cellProps={filterCell} />
            </thead>
            <tbody>
              {listed.map((r) => (
                <tr key={keyOf(r) || r.title}>
                  <td style={{ whiteSpace: 'normal', minWidth: 150 }}>{byEntity ? r.title : <><span className="acct-code">{r.code}</span> {r.title}</>}</td>
                  <td style={{ color: 'var(--text-secondary)', whiteSpace: 'normal' }}>{SECTION[r.section] || r.section}</td>
                  <td className="acct-num"><Amount value={r.amount} /></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 130 }}>
                    <span style={{ color: r.line ? undefined : 'var(--bad-fg, #dc2626)' }}>{r.line ? lineText(r.line) : 'Not Mapped'}</span>
                    {r.line && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{SOURCE[r.source]}</span>}
                  </td>
                  <td>
                    <select value={pick(r)} disabled={!canEdit || !r.code} onChange={(e) => setDraft((d) => ({ ...d, [keyOf(r)]: e.target.value }))}
                      aria-label={`Line for ${byEntity ? r.title : `${r.code} ${r.title}`}`} style={{ ...control, width: 170, maxWidth: 170, fontWeight: keyOf(r) in draft ? 600 : 400 }}>
                      <option value="">{emptyLine(r)}</option>
                      {choices.map((g) => (
                        <optgroup key={g.heading} label={g.heading}>
                          {g.lines.map((l) => <option key={l.line} value={l.line}>{l.text}</option>)}
                        </optgroup>
                      ))}
                      <option value={SKIP}>{lineText(SKIP)}</option>
                    </select>
                  </td>
                </tr>
              ))}
              {!listed.length && (filters.filtering && rows.length && shown.length
                ? <ColumnFiltersEmpty colSpan={5} onClear={filters.clear} style={{ textAlign: 'center', padding: 18 }} />
                : <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 18 }}>{!rows.length ? (byEntity ? 'Pick the entities on this return first.' : 'No accounts with activity in this period.') : 'No account matches.'}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
