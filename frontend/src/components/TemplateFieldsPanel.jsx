import { useState } from 'react';
import { X, Pencil, AlertTriangle } from 'lucide-react';
import { FIELD_TYPES, RESERVED_TYPES } from '../lib/mergeFieldTypes';
import { inferFieldDef } from '../lib/extractVariables';

// Template Fields - every {{variable}} in a template, with the TYPE of answer
// it takes, in one list (Sagar, Sep 21 2026: pasting from Word or importing a
// .docx should let you "define the type of data for the variables so it'll be
// easier to fill the details correctly via form").
//
// Importing/pasting already turns tokens into merge fields and guesses a type
// from the name (extractVariables.inferType: *_date -> Date, salary ->
// Currency…). A guess is not a decision, and the only way to correct one was
// to find that chip in the document and double-click it - so this panel opens
// by itself right after an import that added fields. What is set here is what
// Nexus Sign's fill form asks for when somebody picks the template.
//
// Type is editable inline; everything else about a field (options for a
// dropdown, validation, default) stays in DefineMergeFieldModal, reached from
// the pencil - one editor for that, not two.
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1290, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const card = { background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
const rowStyle = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 150px auto auto', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--line)' };
const selectStyle = { fontSize: 12.5, fontFamily: 'inherit', border: '1px solid var(--line)', borderRadius: 7, padding: '6px 8px', background: 'var(--card)', color: 'var(--ink)', width: '100%', cursor: 'pointer' };

export default function TemplateFieldsPanel({ fieldDefs = [], tokens = [], highlight = [], onChange, onEdit, onClose }) {
  // A token found in the text that has no definition yet - shown so it can be
  // given a type here rather than silently going out as a plain text box.
  const known = new Set(fieldDefs.map((f) => f.token));
  const [undefinedTokens] = useState(() => tokens.filter((t) => !known.has(t)));
  const rows = [...fieldDefs, ...undefinedTokens.filter((t) => !known.has(t)).map(inferFieldDef)];

  const setType = (token, type) => {
    const existing = fieldDefs.find((f) => f.token === token) || inferFieldDef(token);
    const next = [...fieldDefs.filter((f) => f.token !== token),
                  { ...existing, type, ...(RESERVED_TYPES.includes(type) ? { required: false } : {}) }];
    // Keep the document's own order - a list that reshuffles as you set types
    // is unusable.
    onChange(rows.map((r) => next.find((f) => f.token === r.token)).filter(Boolean));
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Template Fields">
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Template Fields</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              The type decides what the form asks for when this template is used.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 20px 16px' }}>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '16px 0' }}>
              This template has no variables yet. Write {'{{a_name}}'} in the text, or select text and convert it into a merge field.
            </p>
          ) : rows.map((fd) => {
            const isNew = highlight.includes(fd.token);
            return (
              <div key={fd.token} style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fd.label || fd.token}
                    {isNew && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}>NEW</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {`{{${fd.token}}}`}
                  </div>
                </div>
                <select aria-label={`Type for ${fd.label || fd.token}`} value={fd.type || 'text'} style={selectStyle}
                  onChange={(e) => setType(fd.token, e.target.value)}>
                  {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <span title={RESERVED_TYPES.includes(fd.type) ? 'Placed on the document, never typed into the form' : (fd.required ? 'Required in the form' : 'Optional')}
                  style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {RESERVED_TYPES.includes(fd.type) ? 'Placed' : (fd.required ? 'Required' : 'Optional')}
                </span>
                <button onClick={() => onEdit(fd)} title="Options, default value and validation"
                  aria-label={`Edit ${fd.label || fd.token}`}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                  <Pencil size={13} />
                </button>
              </div>
            );
          })}
          {undefinedTokens.length > 0 && (
            <p style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--muted)', margin: '12px 0 0' }}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {undefinedTokens.length} variable{undefinedTokens.length === 1 ? ' was' : 's were'} found in the text without a definition. Setting a type here adds {undefinedTokens.length === 1 ? 'it' : 'them'} to the template.
            </p>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="primary-btn" style={{ fontSize: 12.5 }}>Done</button>
        </div>
      </div>
    </div>
  );
}
