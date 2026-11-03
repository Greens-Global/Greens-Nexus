import { Pencil } from 'lucide-react';
import SaveRow from '../components/SaveRow';
import { FL, HINT } from './lib';

// Small pieces every tab of the person record shares (11/03/2026): the read
// row, the section heading, the field label and the Edit button. The look is
// the record's existing one - hairline rows, uppercase muted labels.

// One read row: icon, label, value.
export function Row({ icon: Icon, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      {Icon && <Icon size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5, color: value ? 'var(--ink)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{value || '-'}</span>
    </div>
  );
}

// A section heading with anything on its right (an Edit button, a status line).
export function SectionHead({ icon: Icon, title, children, first = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: first ? '0 0 2px' : '20px 0 2px', flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
        {Icon && <Icon size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />}{title}
      </h3>
      {children}
    </div>
  );
}

// A labelled field; `wide` spans the whole grid row.
export function Field({ label, htmlFor, hint, wide = false, children }) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label style={FL} htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div style={HINT}>{hint}</div>}
    </div>
  );
}

// The tab's one Save row (components/SaveRow.jsx): Save disabled until
// something changed, Discard Changes beside it; Cancel leaves an untouched edit.
export function TabSaveRow({ t, note, saveDisabled = false }) {
  return (
    <SaveRow dirty={t.dirty} busy={t.busy} onSave={t.save} onDiscard={t.discard} saveDisabled={saveDisabled} note={note}>
      {!t.dirty && <button type="button" className="secondary-btn" onClick={t.discard} disabled={t.busy} style={{ fontSize: 12.5 }}>Cancel</button>}
    </SaveRow>
  );
}

// The tab's Edit button - shown while the tab is read and may be edited.
export function EditButton({ onClick, label = 'Edit' }) {
  return (
    <button type="button" className="secondary-btn" onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
      <Pencil size={13} /> {label}
    </button>
  );
}
