// Task Module - formula column UI (Neil, Oct 22 2026): the read-only cell,
// the formula editor (autocomplete on "{", live preview, syntax help,
// validation) and the create/edit popup the list's "+ Column" menu opens.
// The math itself is tasks/formula.js; the server re-checks every save
// (backend/task_formula.py).
import { useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Sigma } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { Modal } from './components';
import { fieldsForProject } from './lib';
import {
  BUILTIN_FIELDS, FORMULA_FUNCTIONS, FORMULA_OPERATORS, RESULT_FORMATS, MAX_LENGTH,
  checkFormula, formatFormulaValue, normalizeFormat, fieldKey, formulaContext, previewRows,
} from './formula';

const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

/** One formula cell: the computed value, or a muted "#Error" whose tooltip
 *  says why. Never throws - the engine has already caught everything. */
export function FormulaValue({ task, field, engine, align = 'center', size = 12.5 }) {
  const r = engine ? engine.result(task, field) : { value: null, error: '' };
  if (r.error) {
    return (
      <span title={r.error} aria-label={`Error: ${r.error}`} data-formula-error
        style={{ fontSize: size, color: NX.faint, fontStyle: 'italic', cursor: 'help' }}>#Error</span>
    );
  }
  const text = formatFormulaValue(r.value, field.formulaFormat);
  return (
    <span title={field.formula ? `= ${field.formula}` : undefined}
      style={{ fontSize: size, color: text ? NX.ink : NX.faint, textAlign: align, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
      {text || '-'}
    </span>
  );
}

// The open "{" the caret sits in, if any: { start, query }.
function openBrace(text, caret) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('{');
  if (at === -1 || before.lastIndexOf('}') > at) return null;
  // Inside a "string"? An odd number of unescaped quotes before the brace.
  let quotes = 0;
  for (let i = 0; i < at; i += 1) {
    if (before[i] === '\\') { i += 1; continue; }
    if (before[i] === '"') quotes += 1;
  }
  if (quotes % 2 === 1) return null;
  return { start: at, query: before.slice(at + 1) };
}

/** The formula box with its format, autocomplete, preview and help.
 *  `fieldNames` are the custom fields it may name (besides the built-ins);
 *  `formulaFields` {name: expression} the other formula columns, for the
 *  circular-reference check; `preview` = [{ id, title, result }] or null. */
export function FormulaEditor({ formula, onFormula, format, onFormat, fieldNames, formulaFields = {}, selfName = '', preview = null, readOnly = false }) {
  const boxRef = useRef(null);
  const [caret, setCaret] = useState(0);
  const [hi, setHi] = useState(0);
  const [focused, setFocused] = useState(false);
  const fmt = normalizeFormat(format);
  const problem = formula.trim() ? checkFormula(formula, { selfName, fieldNames, formulaFields }) : '';
  const names = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const n of [...BUILTIN_FIELDS.map((b) => b.name), ...fieldNames]) {
      const k = fieldKey(n);
      if (n && !seen.has(k) && k !== fieldKey(selfName)) { seen.add(k); out.push(n); }
    }
    return out;
  }, [fieldNames, selfName]);
  const brace = focused && !readOnly ? openBrace(formula, caret) : null;
  const matches = brace ? names.filter((n) => fieldKey(n).includes(fieldKey(brace.query))).slice(0, 8) : [];
  const pick = (name) => {
    if (!brace) return;
    const after = formula.slice(caret);
    const closeAt = after.indexOf('}');
    // Replace through a "}" already typed right after the name, if there is one.
    const tail = closeAt !== -1 && !after.slice(0, closeAt).includes('{') ? after.slice(closeAt + 1) : after;
    const next = `${formula.slice(0, brace.start)}{${name}}${tail}`;
    onFormula(next);
    const pos = brace.start + name.length + 2;
    setCaret(pos);
    requestAnimationFrame(() => { const el = boxRef.current; if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  };
  const onKeyDown = (e) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + matches.length) % matches.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[Math.min(hi, matches.length - 1)]); }
    else if (e.key === 'Escape') { e.stopPropagation(); setFocused(false); }
  };
  const track = (e) => { setCaret(e.target.selectionStart ?? e.target.value.length); setHi(0); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
      <div>
        <label style={label} htmlFor="nx-formula-box">Formula</label>
        <textarea id="nx-formula-box" ref={boxRef} value={formula} readOnly={readOnly} maxLength={MAX_LENGTH}
          onChange={(e) => { onFormula(e.target.value); track(e); }} onKeyUp={track} onClick={track}
          onFocus={(e) => { setFocused(true); track(e); }} onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={onKeyDown} rows={3} spellCheck={false} aria-invalid={!!problem || undefined}
          aria-describedby="nx-formula-status"
          placeholder='e.g. {Budget} - {Spent}   or   IF({Due Date} < TODAY(), "Late", "On Track")'
          style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, resize: 'vertical', minHeight: 72 }} />
        {matches.length > 0 && (
          <div role="listbox" aria-label="Fields" style={{ marginTop: 4, border: `1px solid ${NX.border}`, borderRadius: 8, background: NX.surface, boxShadow: '0 8px 24px rgba(0,0,0,0.10)', padding: 4 }}>
            {matches.map((n, i) => (
              <button key={n} type="button" role="option" aria-selected={i === hi}
                onMouseDown={(e) => { e.preventDefault(); pick(n); }}
                style={{ display: 'flex', width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, padding: '6px 8px', cursor: 'pointer', fontFamily: FONT, fontSize: 12.5, color: NX.ink, background: i === hi ? NX.hover : 'transparent' }}>
                {`{${n}}`}
                {BUILTIN_FIELDS.some((b) => b.name === n) && <span style={{ marginLeft: 'auto', color: NX.faint, fontSize: 11.5 }}>Built-in</span>}
              </button>
            ))}
          </div>
        )}
        <div id="nx-formula-status" role="status" style={{ marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, color: problem ? NX.red : NX.green, minHeight: 18 }}>
          {!formula.trim() ? <span style={{ color: NX.faint }}>Type {'{'} to pick a field.</span>
            : problem ? <><AlertCircle size={13} />{problem}</>
            : <><CheckCircle2 size={13} />Looks good.</>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={label} htmlFor="nx-formula-format">Result Format</label>
          <select id="nx-formula-format" value={fmt.format} disabled={readOnly}
            onChange={(e) => onFormat(normalizeFormat({ format: e.target.value }))}
            style={{ ...inputStyle, cursor: 'pointer' }}>
            {RESULT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        {['number', 'currency', 'percent'].includes(fmt.format) && (
          <div style={{ flex: '0 1 140px' }}>
            <label style={label} htmlFor="nx-formula-decimals">Decimals</label>
            <select id="nx-formula-decimals" value={fmt.decimals} disabled={readOnly}
              onChange={(e) => onFormat({ ...fmt, decimals: Number(e.target.value) })} style={{ ...inputStyle, cursor: 'pointer' }}>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
      </div>

      {preview && (
        <div>
          <div style={label}>Preview</div>
          {preview.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.faint }}>No tasks to preview yet.</div>
          ) : (
            <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
              {preview.map((p, i) => (
                <div key={p.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '7px 12px', fontSize: 12.5, borderTop: i ? `1px solid ${NX.border2}` : 'none' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: NX.dim }}>{p.title}</span>
                  {p.result.error
                    ? <span title={p.result.error} style={{ color: NX.faint, fontStyle: 'italic' }}>#Error - {p.result.error}</span>
                    : <span style={{ color: NX.ink, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatFormulaValue(p.result.value, fmt) || '-'}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <details className="nx-fill" style={{ fontSize: 12.5, color: NX.dim }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, color: NX.dim }}>Syntax Help</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, max-content) 1fr', gap: '4px 14px', marginTop: 8 }}>
          {[...FORMULA_OPERATORS, ...FORMULA_FUNCTIONS].map((h) => (
            <FragmentRow key={h.sig} sig={h.sig} help={h.help} />
          ))}
          {BUILTIN_FIELDS.map((b) => <FragmentRow key={b.name} sig={`{${b.name}}`} help={b.help} />)}
        </div>
        <p style={{ margin: '8px 0 0', color: NX.faint }}>
          A select field gives its label, people give names, a checkbox gives true or false, and a date gives a date.
          A built-in field name wins over a custom field with the same name.
        </p>
      </details>
    </div>
  );
}

function FragmentRow({ sig, help }) {
  return (
    <>
      <code style={{ fontSize: 12, color: NX.ink, whiteSpace: 'nowrap' }}>{sig}</code>
      <span>{help}</span>
    </>
  );
}

/** Create or edit a formula column. `field` set = editing it. Saves through
 *  `onSave({ name, description, formula, formula_format })`; a refusal from
 *  the server (it re-checks) is shown in place. */
export function FormulaFieldModal({ field = null, store, lockedProjectId = '', previewTasks = [], onClose, onSave, readOnly = false }) {
  const [name, setName] = useState(field?.name || 'Formula');
  const [description, setDescription] = useState(field?.description || '');
  const [formula, setFormula] = useState(field?.formula || '');
  const [format, setFormat] = useState(normalizeFormat(field?.formulaFormat));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const selfId = field?.id || '__draft';
  const allFields = store?.customFields;
  const ctx = useMemo(() => formulaContext(allFields || [], selfId), [allFields, selfId]);
  // Autocomplete leads with the fields on this list.
  const suggest = useMemo(() => {
    const local = (lockedProjectId ? fieldsForProject(allFields || [], lockedProjectId) : (allFields || []))
      .filter((f) => f.id !== selfId).map((f) => f.name);
    return [...local, ...ctx.fieldNames.filter((n) => !local.includes(n))];
  }, [allFields, lockedProjectId, ctx.fieldNames, selfId]);
  const draft = { id: selfId, name: name.trim(), type: 'formula', formula, formulaFormat: format, projectIds: field?.projectIds || (lockedProjectId ? [lockedProjectId] : []) };
  const problem = checkFormula(formula, { selfName: name.trim(), ...ctx });
  // Five rows - cheap enough to work out on every keystroke.
  const preview = formula.trim() && !problem
    ? previewRows({ draft, store, tasks: previewTasks, projectIds: draft.projectIds }) : null;
  const dirty = name !== (field?.name || 'Formula') || description !== (field?.description || '')
    || formula !== (field?.formula || '') || JSON.stringify(format) !== JSON.stringify(normalizeFormat(field?.formulaFormat));
  const canSave = !readOnly && !!name.trim() && !problem && !busy;
  const save = async () => {
    if (!canSave) return;
    setBusy(true); setSaveError('');
    try {
      await onSave({ name: name.trim(), description: description.trim(), type: 'formula', formula: formula.trim(), formula_format: format });
      onClose();
    } catch (e) {
      setSaveError(e?.status === 403 ? 'Only a manager can change this formula.' : (e?.message || 'The formula could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={readOnly ? 'View Formula Column' : field ? 'Edit Formula Column' : 'New Formula Column'} onClose={onClose}
      isDirty={dirty && !readOnly} onSave={canSave ? save : undefined} footer={readOnly ? (
        <button style={btn('primary')} onClick={onClose}>Close</button>
      ) : (
        <>
          <button style={btn('ghost')} onClick={onClose}>Cancel</button>
          <button style={{ ...btn('primary'), opacity: canSave ? 1 : 0.5 }} disabled={!canSave} onClick={save}>
            <Sigma size={14} />{busy ? 'Saving…' : field ? 'Save Formula' : 'Add Column'}
          </button>
        </>
      )}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <label style={label} htmlFor="nx-formula-name">Column Name</label>
            <input id="nx-formula-name" autoFocus={!field} value={name} readOnly={readOnly} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: '2 1 280px' }}>
            <label style={label} htmlFor="nx-formula-desc">Description</label>
            <input id="nx-formula-desc" value={description} readOnly={readOnly} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" style={inputStyle} />
          </div>
        </div>
        <FormulaEditor formula={formula} onFormula={setFormula} format={format} onFormat={setFormat}
          fieldNames={suggest} formulaFields={ctx.formulaFields} selfName={name.trim()} preview={preview} readOnly={readOnly} />
        {saveError && <div role="alert" style={{ fontSize: 12.5, color: NX.red }}>{saveError}</div>}
      </div>
    </Modal>
  );
}
