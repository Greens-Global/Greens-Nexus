import { useEffect, useMemo, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { api } from '../../api';
import { formatDate } from '../../lib/datetime';
import { formatAmount } from './Amount';
import { Dialog } from './LoanDialogs';
import { control } from './reportControls';

// Accounting -> AMA, Ask My Accountant (Neil, 10/15): the "Ask My Accountant"
// action on one ledger line - from Ledger Search (and so every report's
// drill-down), the journal entry, or an Ask My Accountant line on the AMA
// screen. A question and the accountant it goes to; the line travels as a
// snapshot so the question still reads after Intacct changes it. The
// accountant defaults to the one set for the entity, then the one for every
// entity, then the last one this person asked. People come from the curated
// Nexus People list only.

const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const full = { ...control, width: '100%' };

const numbered = (name, id) => (id && name && name !== id ? `${id} ${name}` : name || id || '');

/** A Ledger Search / drill-down row as the line the question is about. */
export function lineFromSearch(r) {
  return {
    entityCode: r.location || '', entityName: r.location_name || '', entryId: r.entry_id || '', entryNo: r.entry_no || '',
    lineId: r.line_id ? String(r.line_id) : '', lineNo: r.line_no ? String(r.line_no) : '', accountNo: r.gl_code ? String(r.gl_code) : '',
    accountTitle: r.account_name || '', date: String(r.entry_date || '').slice(0, 10), debit: Number(r.debit) || 0, credit: Number(r.credit) || 0,
    description: r.description || '', memo: r.memo || '', journal: r.journal || '',
    party: numbered(r.vendor_name, r.vendor_id) || numbered(r.customer_name, r.customer_id) || r.employee_name || r.employee_id || '',
    // Oct 22 (Priyanka): the columns Intacct's AMA report carries.
    department: numbered(r.department_name, r.department), vendor: numbered(r.vendor_name, r.vendor_id),
    custom: numbered(r.custom_name, r.custom_id || r.custom) || numbered(r.project_name, r.project_id),
  };
}

/** A journal entry's line (EntryDetail) as the line the question is about. */
export function lineFromEntry(l, g, entry, journal = '') {
  return {
    entityCode: l.location || '', entityName: l.location_name || '', entryId: entry?.id || l.entry_id || '', entryNo: entry?.entry_no || '',
    lineId: l.id ? String(l.id) : '', lineNo: l.line_no ? String(l.line_no) : '', accountNo: l.gl_code ? String(l.gl_code) : '',
    accountTitle: l.account_name || '', date: String(entry?.entry_date || '').slice(0, 10), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
    description: l.description || g?.memo || '', memo: g?.memo || '', journal,
    party: numbered(g?.vendor_name, g?.vendor_id) || numbered(g?.customer_name, g?.customer_id) || g?.employee_name || '',
    department: numbered(l.department_name, l.department), vendor: numbered(g?.vendor_name, g?.vendor_id),
    custom: numbered(g?.custom_name, g?.custom_id) || numbered(g?.class_name, g?.class_id || g?.project_id),
  };
}

/** The accountant a new question goes to, given the settings. */
export function defaultAccountant(settings, entity) {
  const per = settings?.accountants || {};
  return per[entity]?.[0]?.email || per['']?.[0]?.email || settings?.lastAccountant || '';
}

export const amountText = (line) => {
  const v = (Number(line.debit) || 0) - (Number(line.credit) || 0);
  return v < 0 ? `(${formatAmount(-v)})` : formatAmount(v);
};

/** The people the accountant picker offers: the Nexus People list. */
export function usePeople() {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory()
      .then((rows) => {
        if (!alive) return;
        setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || '' }))
          .filter((p) => p.email).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'en-US')));
      })
      .catch(() => { if (alive) setPeople([]); });
    return () => { alive = false; };
  }, []);
  return people;
}

export function PersonSelect({ id, people, value, onChange, extra = null, ariaLabel = 'Accountant', placeholder = 'Pick a Person' }) {
  const list = useMemo(() => (value && !people.some((p) => p.email === value) ? [{ email: value, name: extra || value }, ...people] : people), [people, value, extra]);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} style={full}>
      <option value="">{placeholder}</option>
      {list.map((p) => <option key={p.email} value={p.email}>{p.name ? `${p.name} (${p.email})` : p.email}</option>)}
    </select>
  );
}

export function LineFacts({ line }) {
  const facts = [
    ['Date', line.date ? formatDate(line.date) : ''],
    ['Entity', numbered(line.entityName, line.entityCode)],
    ['Entry', line.entryNo],
    ['Account', [line.accountNo, line.accountTitle].filter(Boolean).join(' ')],
    ['Amount', amountText(line)],
    // The line memo first (Priyanka, 10/15), then the entry's own description.
    ['Description', line.memo || line.description],
    ['Entry Description', line.memo && line.description && line.description !== line.memo ? line.description : ''],
    ['Department', line.department],
    ['Vendor / Customer', line.vendor || line.party],
    ['Custom', line.custom],
  ].filter(([, v]) => v);
  return (
    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '110px 1fr', gap: '3px 10px', fontSize: '0.8rem' }}>
      {facts.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
          <dd style={{ margin: 0, color: 'var(--text-primary)', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The small button on a ledger line. */
export function AskButton({ onClick, title = 'Ask My Accountant about this line' }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={title} title={title}
      style={{ padding: 2, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex' }}>
      <MessageCircleQuestion size={14} />
    </button>
  );
}

export default function AskAccountantDialog({ line, onClose, onAsked }) {
  const people = usePeople();
  const [settings, setSettings] = useState(null);
  const [question, setQuestion] = useState('');
  const [accountant, setAccountant] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState({});

  useEffect(() => {
    let alive = true;
    api.getAskSettings()
      .then((s) => { if (alive) setSettings(s || {}); })
      .catch(() => { if (alive) setSettings({}); });
    return () => { alive = false; };
  }, []);
  const suggested = defaultAccountant(settings, line.entityCode);
  const chosen = touched ? accountant : accountant || suggested;

  const submit = (e) => {
    e.preventDefault();
    const m = {};
    if (!question.trim()) m.question = 'Type the question.';
    if (!chosen) m.accountant = 'Pick the accountant.';
    setMissing(m);
    if (Object.keys(m).length) return;
    setBusy(true);
    setError('');
    api.askAccountant({ ...line, question: question.trim(), accountant: chosen })
      .then((t) => onAsked?.(t))
      .catch((err) => { setError(err?.message || 'Could not send the question.'); setBusy(false); });
  };

  return (
    <Dialog title="Ask My Accountant" onClose={onClose} onSubmit={submit} busy={busy} submitLabel="Send Question" error={error} width={560}
      sub="The accountant is notified in Nexus and answers on the AMA screen.">
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-secondary)' }}>
        <LineFacts line={line} />
      </div>
      <div>
        <label style={label} htmlFor="ask-question">Question</label>
        <textarea id="ask-question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} maxLength={4000} autoFocus
          placeholder="What do you need to know about this line?" style={{ ...full, height: 'auto', resize: 'vertical', fontFamily: 'inherit' }} />
        {missing.question && <div role="alert" style={{ fontSize: '0.7rem', color: 'var(--bad-fg, #dc2626)', marginTop: 3 }}>{missing.question}</div>}
      </div>
      <div>
        <label style={label} htmlFor="ask-accountant">Accountant</label>
        <PersonSelect id="ask-accountant" people={people} value={chosen} onChange={(v) => { setTouched(true); setAccountant(v); }}
          extra={chosen === settings?.lastAccountant ? settings?.lastAccountantName : null} />
        {missing.accountant
          ? <div role="alert" style={{ fontSize: '0.7rem', color: 'var(--bad-fg, #dc2626)', marginTop: 3 }}>{missing.accountant}</div>
          : <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>{suggested && chosen === suggested ? 'The accountant set for this entity, or the last one you asked.' : 'They need Accounting access to this entity.'}</div>}
      </div>
    </Dialog>
  );
}
