import { Pencil } from 'lucide-react';
import SaveRow from '../components/SaveRow';
import { FL, HINT } from './lib';

// Small pieces every tab of the person record shares (11/03/2026). The look
// is the record's (pass of 11/08/2026): a label column in the canon - 12px,
// normal case, muted - beside the value, hairline rows, no icon per row,
// section titles in Title Case. An email or a phone number is a link.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;

// One read row: label, value. `children` in place of `value` puts a control
// in the value cell (a section being edited in place). An empty value says
// "Not set" - every field still reads on the main screen (Neil, Oct 12).
export function Row({ label, value, children, htmlFor }) {
  let shown = children;
  if (shown == null && value != null && typeof value === 'object') shown = value; // an element, as is
  else if (shown == null) {
    const v = value == null ? '' : String(value);
    if (!v.trim()) shown = <span style={{ color: 'var(--muted)' }}>Not set</span>;
    else if (EMAIL.test(v.trim())) shown = <a href={`mailto:${v.trim()}`} className="pr-link">{v}</a>;
    else if (/phone|mobile/i.test(String(label)) && PHONE.test(v.trim())) shown = <a href={`tel:${v.replace(/[^\d+]/g, '')}`} className="pr-link">{v}</a>;
    else shown = v;
  }
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className="pr-row">
      <Label htmlFor={htmlFor} className="pr-row-label">{label}</Label>
      <div className="pr-row-value">{shown}</div>
    </div>
  );
}

// A section heading with anything on its right (an Edit button, a status line).
export function SectionHead({ title, children, first = false }) {
  return (
    <div className="pr-section-head" style={{ marginTop: first ? 0 : 26 }}>
      <h3>{title}</h3>
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
      {!t.dirty && <button type="button" className="secondary-btn" onClick={t.discard} disabled={t.busy} style={{ fontSize: 13 }}>Cancel</button>}
    </SaveRow>
  );
}

// The tab's Edit button - shown while the tab is read and may be edited.
export function EditButton({ onClick, label = 'Edit' }) {
  return (
    <button type="button" className="secondary-btn" onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '5px 11px' }}>
      <Pencil size={13} /> {label}
    </button>
  );
}
