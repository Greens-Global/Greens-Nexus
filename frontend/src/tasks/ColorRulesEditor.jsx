// Task Module - the Row Colors editor (Neil, Oct 22 2026).
//
// One Modal, two panes: the ordered list of rules (swatch, name, the rule as
// a sentence, an on/off switch, drag or arrow keys to reorder, edit /
// duplicate / delete, and three suggested starters) and one rule's editor
// (name, palette color, Bold Title, all/any, up to five conditions with the
// right widget for each value, a live "Matches N tasks" count and a preview
// row). Every change to the list is saved as it is made through `onSave`;
// the server refuses a save over a list someone else changed meanwhile and
// the screen re-reads it (see TasksWorkspace / store.saveColorRules).
//
// Read-only for anyone who cannot edit: the parent does not open it for them.
import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Copy, GripVertical, Pencil, Plus, Trash2, X, Sparkles } from 'lucide-react';
import { Modal, DateField, PersonSelect, useIsMobile } from './components';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { StatusLabel } from '../components/StatusLabel';
import { dialog } from '../ui/dialog';
import {
  PALETTE, MAX_RULES, MAX_CONDITIONS, MAX_NAME, MAX_DAYS, OP_KIND, colorHex, fieldInfo, fieldChoices, opLabel,
  defaultValue, blankRule, blankCondition, newRuleId, ruleProblems, draftProblem, describeRule, starterRules,
  usableRules, colorMap,
} from './colorRules';
import { rowColorAttrs, boldTitleStyle } from './rowColorState';
import { RowColorSwitch as Switch } from './RowColors';
import { todayISO } from './lib';

const label = { display: 'block', fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const hint = { fontSize: 12.5, color: NX.dim, lineHeight: 1.5 };
const iconBtn = { ...btn('ghost'), padding: 5, color: NX.dim };

/** Pick one (or several) from a short list, as soft chips. */
function OptionChips({ options, value, multi = false, onChange, ariaLabel }) {
  const picked = multi ? (Array.isArray(value) ? value : []) : [value];
  return (
    <div role={multi ? 'group' : 'radiogroup'} aria-label={ariaLabel} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const on = picked.includes(o.id);
        return (
          <button key={o.id} type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={on}
            onClick={() => onChange(multi ? (on ? picked.filter((x) => x !== o.id) : [...picked, o.id]) : o.id)}
            className={on ? 'nx-label' : undefined}
            style={on ? { '--c': o.color || NX.blue, border: '1px solid transparent', cursor: 'pointer', fontFamily: FONT }
              : { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999, fontSize: 12, fontWeight: 500, lineHeight: '18px', border: `1px solid ${NX.border}`, background: 'transparent', color: NX.dim, cursor: 'pointer', fontFamily: FONT }}>
            {on ? <span className="nx-label-text">{o.label}</span> : o.label}
          </button>
        );
      })}
      {!options.length && <span style={hint}>Nothing to choose from here.</span>}
    </div>
  );
}

function ValueInput({ cond, field, onChange, ctx }) {
  const kind = OP_KIND[cond.op];
  if (!field || kind === 'none') return null;
  const v = cond.value;
  const multi = kind === 'list';
  if (field.kind === 'status') {
    return <OptionChips ariaLabel="Status" multi={multi} value={v} onChange={onChange} options={ctx.statusOptions} />;
  }
  if (field.kind === 'priority') {
    return <OptionChips ariaLabel="Priority" multi={multi} value={v} onChange={onChange}
      options={PRIORITY_ORDER.map((k) => ({ id: k, label: PRIORITY_META[k].label, color: PRIORITY_META[k].color }))} />;
  }
  if (field.kind === 'section') {
    return <OptionChips ariaLabel="Section" value={v} onChange={onChange}
      options={(ctx.sections || []).map((s) => ({ id: s.id, label: s.name }))} />;
  }
  if (field.type === 'select' || field.type === 'multiselect') {
    return <OptionChips ariaLabel={field.label} multi={multi} value={v} onChange={onChange}
      options={(field.def.options || []).map((o) => ({ id: o?.id ?? o, label: o?.label ?? o, color: o?.color }))} />;
  }
  if (kind === 'person') {
    return (
      <div style={{ minWidth: 200, maxWidth: 280 }}>
        <PersonSelect value={v || null} onChange={(em) => onChange(em || '')} people={ctx.people || []} placeholder="Choose a person" />
      </div>
    );
  }
  if (kind === 'date') {
    return <DateField value={v || ''} onChange={(d) => onChange(d || '')} placeholder="Pick a date" style={{ minWidth: 150 }} />;
  }
  if (kind === 'days') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: NX.dim }}>
        <input type="number" min={0} max={MAX_DAYS} step={1} aria-label="Number of days" value={v ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          style={{ ...inputStyle, width: 72, padding: '6px 8px', fontSize: 13 }} />
        days
      </span>
    );
  }
  if (kind === 'number') {
    return <input type="number" aria-label="Number" value={v ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      style={{ ...inputStyle, width: 110, padding: '6px 8px', fontSize: 13 }} />;
  }
  if (kind === 'range') {
    const [a = '', b = ''] = Array.isArray(v) ? v : [];
    const num = (x) => (x === '' ? '' : Number(x));
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: NX.dim }}>
        <input type="number" aria-label="From" value={a} onChange={(e) => onChange([num(e.target.value), b])} style={{ ...inputStyle, width: 90, padding: '6px 8px', fontSize: 13 }} />
        and
        <input type="number" aria-label="To" value={b} onChange={(e) => onChange([a, num(e.target.value)])} style={{ ...inputStyle, width: 90, padding: '6px 8px', fontSize: 13 }} />
      </span>
    );
  }
  return <input type="text" aria-label="Value" value={v ?? ''} maxLength={120} onChange={(e) => onChange(e.target.value)}
    placeholder={field.kind === 'tag' ? 'Tag name' : 'Text'} style={{ ...inputStyle, width: 200, padding: '6px 8px', fontSize: 13 }} />;
}

function ConditionRow({ cond, index, onChange, onRemove, canRemove, ctx, choices, problem }) {
  const field = fieldInfo(cond.field, ctx.fieldsById);
  // A condition on a deleted field keeps its row so it can be fixed or removed.
  const fieldOptions = field ? choices : [{ key: cond.field, label: 'Deleted Field' }, ...choices];
  const setField = (key) => {
    const f = fieldInfo(key, ctx.fieldsById);
    const op = f?.ops[0] || '';
    onChange({ field: key, op, ...(OP_KIND[op] === 'none' ? null : { value: defaultValue(op, f) }) });
  };
  const setOp = (op) => {
    const keep = OP_KIND[op] === OP_KIND[cond.op] && cond.value !== undefined;
    const next = { field: cond.field, op };
    if (OP_KIND[op] !== 'none') next.value = keep ? cond.value : defaultValue(op, field);
    onChange(next);
  };
  // A short value (days, a date, a number, text, a person) sits on the same
  // line as the field and comparison; a set of option chips gets its own.
  const ready = field && field.ops.includes(cond.op);
  const chips = ready && ['status', 'priority', 'section'].includes(field.kind)
    || (ready && (field.type === 'select' || field.type === 'multiselect'));
  const value = ready ? <ValueInput cond={cond} field={field} onChange={(v) => onChange({ ...cond, value: v })} ctx={ctx} /> : null;
  // "Pick a value" is a step not yet taken, said quietly; a deleted field,
  // option, status or section is something wrong, and the row says so.
  const unfinished = /^(Pick|Enter)/.test(problem || '');
  const broken = !!problem && !unfinished;
  return (
    <div data-testid="condition-row" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: `1px solid ${broken ? NX.amber : NX.border}`, borderRadius: 10, background: NX.surface }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select aria-label={`Condition ${index + 1} field`} value={cond.field} onChange={(e) => setField(e.target.value)}
          style={{ ...inputStyle, width: 'auto', minWidth: 140, padding: '6px 8px', fontSize: 13 }}>
          {fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        {field && (
          <select aria-label={`Condition ${index + 1} comparison`} value={field.ops.includes(cond.op) ? cond.op : ''} onChange={(e) => setOp(e.target.value)}
            style={{ ...inputStyle, width: 'auto', minWidth: 130, padding: '6px 8px', fontSize: 13 }}>
            {!field.ops.includes(cond.op) && <option value="">Choose…</option>}
            {field.ops.map((op) => <option key={op} value={op}>{opLabel(field, op)}</option>)}
          </select>
        )}
        {!chips && value}
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove condition ${index + 1}`} title="Remove Condition" style={{ ...iconBtn, marginLeft: 'auto' }}><X size={15} /></button>
        )}
      </div>
      {chips && value}
      {problem && <div role="note" style={{ fontSize: 12, color: broken ? NX.amber : NX.dim, fontWeight: broken ? 600 : 400 }}>{problem}</div>}
    </div>
  );
}

function RuleForm({ draft, setDraft, ctx, choices, countTasks, scopeNoun, touch }) {
  const problems = ruleProblems(draft, ctx);
  const problemAt = (i) => problems.find((p) => p.index === i)?.text || '';
  // The live count and the sample row: this rule on its own, as if enabled.
  const today = todayISO();
  const broken = problems.length > 0;
  const matches = useMemo(() => (broken ? null : colorMap([{ ...draft, enabled: true }], countTasks, { ...ctx, today })),
    [broken, draft, countTasks, ctx, today]);
  const sample = matches && matches.size ? countTasks.find((t) => matches.has(t.id)) : null;
  const preview = { id: draft.id, name: draft.name, color: draft.color, hex: colorHex(draft.color), bold: !!draft.bold };
  const attrs = rowColorAttrs(preview);
  const setCond = (i, c) => setDraft((d) => ({ ...d, conditions: d.conditions.map((x, j) => (j === i ? c : x)) }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <label htmlFor="cr-name" style={label}>Rule Name</label>
        <input id="cr-name" value={draft.name} maxLength={MAX_NAME} autoFocus={!touch} placeholder="e.g. Overdue"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} style={{ ...inputStyle, maxWidth: 360 }} />
      </div>
      <div>
        <span style={label} id="cr-color">Color</span>
        <div role="radiogroup" aria-labelledby="cr-color" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PALETTE.map((p) => {
            const on = draft.color === p.key;
            return (
              <button key={p.key} type="button" role="radio" aria-checked={on} aria-label={p.label} title={p.label}
                onClick={() => setDraft((d) => ({ ...d, color: p.key }))}
                style={{ width: 26, height: 26, borderRadius: 8, cursor: 'pointer', padding: 0, background: p.hex,
                  border: `2px solid ${on ? NX.ink : 'transparent'}`, boxShadow: on ? `inset 0 0 0 2px ${NX.surface}` : 'none' }} />
            );
          })}
        </div>
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, cursor: 'pointer', width: 'fit-content' }}>
        <Switch on={!!draft.bold} onChange={(on) => setDraft((d) => ({ ...d, bold: on }))} label="Bold Title" />
        Bold Title
        <span style={{ ...hint, fontSize: 12 }}>- also set the task name in bold</span>
      </label>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10, fontSize: 13, color: NX.ink }}>
          Color a task when
          <select aria-label="Match" value={draft.match} onChange={(e) => setDraft((d) => ({ ...d, match: e.target.value }))}
            style={{ ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 13 }}>
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these are true
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.conditions.map((c, i) => (
            <ConditionRow key={i} cond={c} index={i} ctx={ctx} choices={choices} problem={problemAt(i)}
              canRemove={draft.conditions.length > 1}
              onChange={(next) => setCond(i, next)}
              onRemove={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, j) => j !== i) }))} />
          ))}
        </div>
        {draft.conditions.length < MAX_CONDITIONS ? (
          <button type="button" onClick={() => setDraft((d) => ({ ...d, conditions: [...d.conditions, blankCondition()] }))}
            style={{ ...btn('ghost'), marginTop: 8, padding: '6px 8px', fontSize: 12.5, color: NX.blue }}>
            <Plus size={14} /> Add Condition
          </button>
        ) : <div style={{ ...hint, marginTop: 8 }}>A rule can have up to {MAX_CONDITIONS} conditions.</div>}
      </div>
      <div className="nx-fill" style={{ gap: 8 }}>
        <div aria-live="polite" style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>
          {matches ? `Matches ${matches.size} task${matches.size === 1 ? '' : 's'} ${scopeNoun}` : 'Finish the conditions to see what this colors.'}
        </div>
        <div style={{ ...label, marginBottom: 0 }}>Preview</div>
        <div data-testid="rule-preview" className={attrs.className} style={{ ...attrs.style, display: 'flex', alignItems: 'center', gap: 10, minHeight: 38, padding: '0 14px', border: `1px solid ${NX.border}`, borderRadius: 8, background: NX.surface, fontSize: 13, overflow: 'hidden' }}>
          <span style={{ fontWeight: 600, color: NX.ink, ...boldTitleStyle(preview) }}>{sample?.title || draft.name || 'A matching task'}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * props:
 *   rules, onSave(nextRules) -> Promise   - the list and how to store it
 *   ctx    - { fieldsById, statusMeta, statusOptions, sections, people, nameOf, me, sectionOf }
 *   customFields - the custom fields offered as conditions here
 *   countTasks   - the tasks the live count runs over
 *   scopeNoun    - "in this project" / "in your tasks"
 */
export default function ColorRulesEditor({ title = 'Row Colors', rules, onSave, onClose, ctx, customFields = [], countTasks = [], scopeNoun = 'in this project', statusOrder = [] }) {
  const [list, setList] = useState(rules || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // { draft, id } while one rule is open (see openDraft below).
  const [editing, setEditing] = useState(null);
  const [initialDraft, setInitialDraft] = useState('');
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const handles = useRef([]);
  // Touch screens cannot drag a list row, so they get Move Up / Move Down.
  const isPhone = useIsMobile();
  const coarse = useIsMobile('(pointer: coarse)');
  const touch = isPhone || coarse;

  // The stored list wins whenever no save is in flight: after a save it is
  // what the server kept, after a refused one (409) it is the newer list
  // someone else saved, and a change from elsewhere lands here too. Adjusted
  // during render (React's "storing information from previous renders"), not
  // in an effect, so no frame shows the stale list.
  const [seen, setSeen] = useState(rules);
  if (!busy && seen !== rules) { setSeen(rules); setList(rules || []); }

  const choices = useMemo(() => fieldChoices({ customFields, sections: ctx.sections || [] }), [customFields, ctx.sections]);
  const today = todayISO();
  const counts = useMemo(() => {
    const out = {};
    for (const r of usableRules(list.map((r) => ({ ...r, enabled: true })), ctx)) {
      out[r.id] = colorMap([r], countTasks, { ...ctx, today }).size;
    }
    return out;
  }, [list, countTasks, ctx, today]);

  const commit = async (next) => {
    const prev = list;
    setList(next);
    setBusy(true);
    setError('');
    try {
      await onSave(next);
      return true;
    } catch (e) {
      // Put the list back; a conflict (409) has already swapped `rules` for
      // the newer stored list, which the check above then shows.
      setList(prev);
      setError(e?.message || 'Could not save the color rules.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // `editing.id` is the rule being changed (null = a new one) - by id, not
  // position, so a list re-read underneath an open rule still saves it in place.
  const openDraft = (draft, id) => { setEditing({ draft, id }); setInitialDraft(JSON.stringify(draft)); setError(''); };
  const draft = editing?.draft;
  const setDraft = (fn) => setEditing((cur) => (cur ? { ...cur, draft: typeof fn === 'function' ? fn(cur.draft) : fn } : cur));
  const dirty = !!editing && JSON.stringify(editing.draft) !== initialDraft;
  const problem = draft ? draftProblem(draft, ctx) : '';

  const saveDraft = async () => {
    if (!draft || problem || busy) return false;
    const clean = { ...draft, name: draft.name.trim() };
    const next = list.some((r) => r.id === clean.id) ? list.map((r) => (r.id === clean.id ? clean : r)) : [...list, clean];
    const ok = await commit(next);
    if (ok) setEditing(null);
    return ok;
  };

  const move = (from, to) => {
    if (busy || to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r);
    commit(next);
    requestAnimationFrame?.(() => handles.current[to]?.focus());
  };
  const remove = async (i) => {
    const ok = await dialog.confirm(`Delete the rule "${list[i].name}"? Rows it colors go back to plain.`,
      { title: 'Delete Rule', confirmText: 'Delete', danger: true });
    if (ok) commit(list.filter((_, j) => j !== i));
  };
  const duplicate = (i) => {
    if (list.length >= MAX_RULES) return;
    const copy = { ...list[i], id: newRuleId(), name: `${list[i].name} (copy)`.slice(0, MAX_NAME), conditions: list[i].conditions.map((c) => ({ ...c })) };
    commit([...list.slice(0, i + 1), copy, ...list.slice(i + 1)]);
  };

  const suggestions = useMemo(() => {
    const have = new Set(list.map((r) => r.name.trim().toLowerCase()));
    return starterRules({ statusOrder, statusMeta: ctx.statusMeta || {} })
      .filter((s) => !have.has(s.name.toLowerCase()));
  }, [list, statusOrder, ctx.statusMeta]);
  const full = list.length >= MAX_RULES;

  const footer = editing ? (
    <>
      {problem && <span style={{ marginRight: 'auto', fontSize: 12.5, color: NX.dim }}>{problem}</span>}
      <button type="button" style={btn('outline')} onClick={() => setEditing(null)}>Cancel</button>
      <button type="button" style={{ ...btn('primary'), opacity: problem || busy ? 0.55 : 1 }} disabled={!!problem || busy} onClick={saveDraft}>
        {busy ? 'Saving…' : 'Save Rule'}
      </button>
    </>
  ) : (
    <button type="button" style={btn('primary')} onClick={onClose}>Done</button>
  );

  return (
    <Modal title={title} onClose={onClose} footer={footer} isDirty={dirty}
      onSave={async () => { if (await saveDraft()) onClose(); }}>
      {error && <div role="alert" style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: `${NX.red}14`, color: NX.red, fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
          <button type="button" onClick={() => setEditing(null)} style={{ ...btn('ghost'), alignSelf: 'flex-start', padding: '4px 6px', fontSize: 12.5 }}>
            <ArrowLeft size={14} /> All Rules
          </button>
          <RuleForm draft={draft} setDraft={setDraft} ctx={ctx} choices={choices} countTasks={countTasks} scopeNoun={scopeNoun} touch={touch} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
          <div style={hint}>
            Rows that match a rule get its color as a thin bar and a light tint. When several rules match, the first one in this list wins - {touch ? 'use the arrows' : 'drag'} to set the order.
          </div>
          <div className="nx-fill" style={{ gap: 0 }}>
            {list.length ? (
              <ol aria-label="Color rules" style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${NX.border}`, borderRadius: 12, overflow: 'hidden' }}>
                {list.map((r, i) => {
                  const probs = ruleProblems(r, ctx);
                  const off = r.enabled === false;
                  return (
                    <li key={r.id} data-testid="rule-row"
                      onDragOver={(e) => { if (dragIdx == null) return; e.preventDefault(); setOverIdx(i); }}
                      onDrop={(e) => { e.preventDefault(); if (dragIdx != null) move(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: i ? `1px solid ${NX.border2}` : 'none', background: overIdx === i && dragIdx !== i ? NX.hover : NX.surface, opacity: dragIdx === i ? 0.5 : 1 }}>
                      {touch ? (
                        <span style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                          <button type="button" onClick={() => move(i, i - 1)} disabled={busy || i === 0} aria-label={`Move ${r.name} Up`}
                            style={{ ...iconBtn, padding: 2, opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={15} /></button>
                          <button type="button" onClick={() => move(i, i + 1)} disabled={busy || i === list.length - 1} aria-label={`Move ${r.name} Down`}
                            style={{ ...iconBtn, padding: 2, opacity: i === list.length - 1 ? 0.3 : 1 }}><ChevronDown size={15} /></button>
                        </span>
                      ) : (
                        <button type="button" ref={(el) => { handles.current[i] = el; }} draggable
                          onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; }}
                          onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                            if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
                          }}
                          aria-label={`Reorder ${r.name}. Use the up and down arrow keys.`} title="Drag to Reorder"
                          style={{ ...iconBtn, cursor: 'grab', padding: 3 }}>
                          <GripVertical size={15} />
                        </button>
                      )}
                      <span className="nx-rc-swatch" style={{ '--rc': colorHex(r.color), opacity: off ? 0.4 : 1 }} aria-hidden="true" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13.5, fontWeight: r.bold ? 700 : 600, color: off ? NX.faint : NX.ink }}>{r.name}</span>
                          {probs.length > 0 && <StatusLabel size="sm" label="Needs Attention" color={NX.amber} title={probs.map((p) => p.text).join(' ')} />}
                          {off && <StatusLabel size="sm" label="Off" color="#64748b" />}
                          {!probs.length && !off && <span style={{ fontSize: 12, color: NX.faint }}>{counts[r.id] ?? 0} task{counts[r.id] === 1 ? '' : 's'}</span>}
                        </div>
                        <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 2 }}>{describeRule(r, ctx)}</div>
                      </div>
                      <Switch on={!off} disabled={busy} label={off ? `Turn on ${r.name}` : `Turn off ${r.name}`}
                        onChange={(on) => commit(list.map((x, j) => (j === i ? { ...x, enabled: on } : x)))} />
                      <button type="button" onClick={() => openDraft(JSON.parse(JSON.stringify(r)), r.id)} aria-label={`Edit ${r.name}`} title="Edit" style={iconBtn}><Pencil size={14} /></button>
                      <button type="button" onClick={() => duplicate(i)} disabled={busy || full} aria-label={`Duplicate ${r.name}`} title="Duplicate" style={{ ...iconBtn, opacity: full ? 0.4 : 1 }}><Copy size={14} /></button>
                      <button type="button" onClick={() => remove(i)} disabled={busy} aria-label={`Delete ${r.name}`} title="Delete" style={iconBtn}><Trash2 size={14} /></button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div style={{ textAlign: 'center', padding: '28px 12px', border: `1px dashed ${NX.border}`, borderRadius: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink }}>No Color Rules Yet</div>
                <div style={{ ...hint, marginTop: 4 }}>Add a rule, or start from a suggestion below.</div>
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <button type="button" disabled={full || busy} onClick={() => openDraft(blankRule(), null)} aria-label="Add Rule" style={{ ...btn('outline'), opacity: full ? 0.5 : 1 }}>
                <Plus size={14} /> Add Rule
              </button>
              {full && <span style={{ ...hint, marginLeft: 10 }}>A project can have up to {MAX_RULES} rules.</span>}
            </div>
          </div>
          {suggestions.length > 0 && !full && (
            <div>
              <div style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}><Sparkles size={13} /> Suggested</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {suggestions.map((s) => (
                  <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: `1px solid ${NX.border2}`, borderRadius: 10 }}>
                    <span className="nx-rc-swatch" style={{ '--rc': colorHex(s.color) }} aria-hidden="true" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{s.name}</div>
                      <div style={{ fontSize: 12, color: NX.dim }}>{describeRule(s, ctx)}</div>
                    </div>
                    <button type="button" disabled={busy} onClick={() => commit([...list, { ...s, id: newRuleId() }])}
                      aria-label={`Add ${s.name}`} style={{ ...btn('ghost'), padding: '4px 10px', fontSize: 12.5, color: NX.blue }}>
                      <Plus size={13} /> Add
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
