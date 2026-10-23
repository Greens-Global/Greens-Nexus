import { useState } from 'react';
import { X, Pencil, AlertTriangle, Lock } from 'lucide-react';
import { FIELD_SOURCES, FIELD_SOURCE_HELP, FIELD_TYPES, FILLED_WHEN, RESERVED_TYPES } from '../lib/mergeFieldTypes';
import { mergeFieldDefs, sameSetting, SHARED_KEYS } from '../lib/extractVariables';

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
// Built-ins ({{first_name}}, {{job_title}}...) are listed as Filled By Nexus,
// read-only (Pranshu, Oct 23: authors read a NEW, Typed Each Time first name
// as "HR has to type it"). A custom field another template already defines
// says whether the two agree, and can be brought in step in one click.
//
// Type is editable inline; everything else about a field (options for a
// dropdown, validation, default) stays in DefineMergeFieldModal, reached from
// the pencil - one editor for that, not two.
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1290, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const card = { background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
const rowStyle = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--line)' };
const selectStyle = { fontSize: 12.5, fontFamily: 'inherit', border: '1px solid var(--line)', borderRadius: 7, padding: '6px 8px', background: 'var(--card)', color: 'var(--ink)', width: '100%', cursor: 'pointer' };
const sectionHead = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: '14px 0 2px' };
const chip = (warn) => ({ fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999,
  color: warn ? '#92400e' : 'var(--muted)', background: warn ? 'rgba(245,158,11,0.13)' : 'var(--mist)' });
const WHERE = Object.fromEntries(FILLED_WHEN.map(([k, , where]) => [k, where]));

const nameCell = (label, token, extra) => (
  <div style={{ flex: '1 1 200px', minWidth: 0 }}>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {label}{extra}
    </div>
    <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {`{{${token}}}`}
    </div>
  </div>
);

export default function TemplateFieldsPanel({ fieldDefs = [], tokens = [], highlight = [], docTokens = [],
  builtins = {}, shared = {}, onChange, onEdit, onClose }) {
  const isBuiltin = (t) => !!builtins[t];
  // A token found in the text that has no definition yet - shown so it can be
  // given a type here rather than silently going out as a plain text box.
  const known = new Set(fieldDefs.map((f) => f.token));
  const [undefinedTokens] = useState(() => [...new Set([...tokens, ...docTokens])]
    .filter((t) => !known.has(t) && !isBuiltin(t)));
  const startDef = (t) => mergeFieldDefs([], [t], { shared }).added[0];
  const rows = [...fieldDefs, ...undefinedTokens.filter((t) => !known.has(t)).map(startDef)];
  const customRows = rows.filter((r) => !isBuiltin(r.token));
  const nexusTokens = [...new Set([...docTokens, ...tokens, ...fieldDefs.map((f) => f.token)])].filter(isBuiltin);

  const setField = (token, patch) => {
    const existing = fieldDefs.find((f) => f.token === token) || startDef(token);
    const next = [...fieldDefs.filter((f) => f.token !== token), { ...existing, ...patch }];
    // Keep the document's own order - a list that reshuffles as you set types
    // is unusable.
    onChange(rows.map((r) => next.find((f) => f.token === r.token)).filter(Boolean));
  };
  const setType = (token, type) => setField(token, { type, ...(RESERVED_TYPES.includes(type) ? { required: false } : {}) });

  return (
    <div style={overlay} onClick={onClose}>
      <div className="nx-popup" style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Template Fields">
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Template Fields</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Who fills each one in an HR packet, and the type of answer it takes.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div className="nx-fill" style={{ overflowY: 'auto', padding: '4px 20px 16px' }}>
          {customRows.length === 0 && nexusTokens.length === 0 && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '16px 0' }}>
              This template has no variables yet. Write {'{{a_name}}'} in the text, or select text and convert it into a merge field.
            </p>
          )}

          {customRows.length > 0 && (<>
            <div style={sectionHead}>Fields Someone Fills In</div>
            <ul style={{ margin: '4px 0 6px', paddingLeft: 18, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              {FIELD_SOURCES.map(([v, l]) => <li key={v}><strong style={{ color: 'var(--ink)' }}>{l}</strong> - {FIELD_SOURCE_HELP[v]}</li>)}
            </ul>
          </>)}
          {customRows.map((fd) => {
            const isNew = highlight.includes(fd.token);
            const other = shared[fd.token];
            const label = fd.label || fd.token;
            return (
              <div key={fd.token} style={rowStyle}>
                {nameCell(label, fd.token, isNew && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}>NEW</span>)}
                <div style={{ flex: '1 1 170px', minWidth: 0 }}>
                  <select aria-label={`Who fills ${label}`} value={fd.source || ''} style={selectStyle}
                    title={FIELD_SOURCE_HELP[fd.source || '']}
                    onChange={(e) => setField(fd.token, { source: e.target.value })}>
                    {FIELD_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div style={{ flex: '1 1 130px', minWidth: 0 }}>
                  <select aria-label={`Type for ${label}`} value={fd.type || 'text'} style={selectStyle}
                    onChange={(e) => setType(fd.token, e.target.value)}>
                    {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <span title={RESERVED_TYPES.includes(fd.type) ? 'Placed on the document, never typed into the form' : (fd.required ? 'Required in the form' : 'Optional')}
                  style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {RESERVED_TYPES.includes(fd.type) ? 'Placed' : (fd.required ? 'Required' : 'Optional')}
                </span>
                <button onClick={() => onEdit(fd)} title="Options, default value and validation"
                  aria-label={`Edit ${label}`}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                  <Pencil size={13} />
                </button>
                {other && (
                  <div style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {sameSetting(fd, other) ? (
                      <span style={chip(false)}>Same as in {other.templateName}</span>
                    ) : (<>
                      <span style={chip(true)}>
                        <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Defined differently in {other.templateName}
                      </span>
                      <button type="button" onClick={() => setField(fd.token, Object.fromEntries(SHARED_KEYS.map((k) => [k, other[k]])))}
                        style={{ fontSize: 11.5, fontWeight: 600, background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: '3px 8px', cursor: 'pointer', color: 'var(--ink)' }}>
                        Use The Same Setting
                      </button>
                    </>)}
                  </div>
                )}
              </div>
            );
          })}
          {undefinedTokens.length > 0 && (
            <p style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--muted)', margin: '12px 0 0' }}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {undefinedTokens.length} variable{undefinedTokens.length === 1 ? ' was' : 's were'} found in the text without a definition. Setting a type here adds {undefinedTokens.length === 1 ? 'it' : 'them'} to the template.
            </p>
          )}

          {nexusTokens.length > 0 && (<>
            <div style={sectionHead}>Filled By Nexus</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 4px' }}>
              Nobody types these - Nexus fills them when a document is made.
            </div>
            {nexusTokens.map((t) => (
              <div key={t} style={rowStyle} data-testid={`nexus-${t}`}>
                {nameCell(builtins[t].label || t, t)}
                <span style={{ flex: '2 1 240px', fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Lock size={12} style={{ flexShrink: 0 }} />
                  {WHERE[builtins[t].when] || WHERE.document}
                </span>
              </div>
            ))}
          </>)}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="primary-btn" style={{ fontSize: 12.5 }}>Done</button>
        </div>
      </div>
    </div>
  );
}
