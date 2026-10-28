// One control per catalog param type (Oct 2026). The catalog says what an
// action takes (`params: [{key, label, type, ...}]`) and this picks the
// control: a template box with the Insert Field menu, a recipients picker,
// a number box, a switch, a duration, a date offset, a list source. Nothing
// about any action is hard-coded here - a new param type is a new case.
import { useEffect, useRef, useState } from 'react';
import { Braces, ChevronDown, Plus, X } from 'lucide-react';
import { api } from '../../api';
import { PersonSelect, TimeField, useClickOutside } from '../../tasks/components';
import { NumberBox, Switch } from '../../components/settings/SettingsUI';
import { templatePaths } from '../lib/definition';
import {
  DURATION_UNITS, TEMPLATE_FILTERS, chip, fieldLabel, filterSuffix, groupBy, hint, iconBtn,
  insertAtCaret, joinMinutes, recipientKindsFor, recipientLabel, select, splitMinutes, textInput,
} from '../lib/text.builder-helpers';

// `ctx` = { catalog, entityDef, eventDef, people, companies, loopNames }.
export default function ParamControl({ param, value, onChange, ctx, id }) {
  const t = param.type;
  if (t === 'template') return <TemplateBox id={id} param={param} value={value} onChange={onChange} ctx={ctx} />;
  if (t === 'recipients' || t === 'approvers') return <RecipientsPicker id={id} value={value} onChange={onChange} ctx={ctx} />;
  if (t === 'number') {
    return <NumberBox value={value ?? ''} onChange={(v) => onChange(v === '' ? '' : Number(v))} min={param.min ?? 0} max={param.max ?? 9999} unit={param.unit} label={param.label} />;
  }
  if (t === 'bool') return <Switch checked={!!value} onChange={onChange} label={param.label} id={id} />;
  if (t === 'select') return <SelectControl id={id} param={param} value={value} onChange={onChange} />;
  if (t === 'person') return <PersonSelect id={id} value={value || ''} onChange={(v) => onChange(v || '')} people={ctx.people || []} placeholder="Choose a person" noneLabel="Nobody" ariaLabel={param.label} />;
  if (t === 'duration') return <DurationControl id={id} value={value} onChange={onChange} label={param.label} />;
  if (t === 'date_offset') return <DateOffsetControl id={id} value={value} onChange={onChange} ctx={ctx} label={param.label} />;
  if (t === 'entity_ref') return <EntityRefControl id={id} param={param} value={value} onChange={onChange} />;
  if (t === 'list_source') return <ListSourceControl id={id} value={value} onChange={onChange} ctx={ctx} label={param.label} />;
  if (t === 'options') return <OptionsEditor id={id} value={value} onChange={onChange} label={param.label} />;
  return (
    <input id={id} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={textInput}
      placeholder={param.hint || ''} aria-label={param.label} maxLength={param.max || undefined} />
  );
}

// ── Template text with the Insert Field menu ───────────────────────────────

export function TemplateBox({ id, param, value, onChange, ctx, rows }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const menuRef = useRef(null);
  const btnRef = useRef(null);
  useClickOutside([menuRef, btnRef], () => setOpen(false), open);
  const paths = templatePaths(ctx.entityDef, ctx.eventDef);
  (ctx.loopNames || []).forEach((n) => paths.push({ path: `${n}.name`, label: `${n} (Name)`, group: 'For Each' }));
  const filters = ctx.catalog?.filters?.length ? ctx.catalog.filters : TEMPLATE_FILTERS;
  const query = q.trim().toLowerCase();
  const shown = query ? paths.filter((p) => `${p.label} ${p.path}`.toLowerCase().includes(query)) : paths;
  const long = (param.max || 0) > 200 || rows;

  const insert = (path) => {
    const el = ref.current;
    const text = `{{ ${path}${filterSuffix(filter)} }}`;
    const { value: next, caret } = insertAtCaret(value, el?.selectionStart, el?.selectionEnd, text);
    onChange(next);
    setOpen(false);
    setQ('');
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(caret, caret); } catch { /* not focusable yet */ }
    });
  };

  const Box = long ? 'textarea' : 'input';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
      <Box ref={ref} id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={param.label}
        placeholder={param.hint || ''} maxLength={param.max || undefined}
        style={{ ...textInput, ...(long ? { minHeight: 88, resize: 'vertical', lineHeight: 1.45 } : null) }}
        {...(long ? { rows: rows || 4 } : { type: 'text' })} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
          style={{ ...chip, cursor: 'pointer', color: 'var(--nx-primary)', borderColor: 'transparent', background: 'transparent', padding: '2px 4px', fontWeight: 600 }}>
          <Braces size={13} /> Insert Field <ChevronDown size={12} />
        </button>
        {param.max ? <span style={hint}>{String(value || '').length} / {param.max}</span> : null}
      </div>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Insert a field" style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 4, width: 'min(360px, 100%)',
          background: 'var(--nx-surface)', border: '1px solid var(--nx-border)', borderRadius: 12,
          boxShadow: '0 16px 40px rgba(17,24,39,0.18)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields" aria-label="Search fields" style={textInput} autoFocus />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            <span style={{ ...hint, marginRight: 2 }}>Insert as</span>
            <FilterChip active={filter === ''} onClick={() => setFilter('')}>Plain</FilterChip>
            {filters.map((f) => (
              <FilterChip key={f.key} active={filter === f.key} onClick={() => setFilter(filter === f.key ? '' : f.key)}>
                {TEMPLATE_FILTERS.find((x) => x.key === f.key)?.label || f.label}
              </FilterChip>
            ))}
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!shown.length && <div style={{ ...hint, padding: 6 }}>No field matches.</div>}
            {groupBy(shown, (p) => p.group).map(([group, items]) => (
              <div key={group}>
                <div style={{ ...hint, fontWeight: 700, padding: '6px 6px 2px' }}>{group}</div>
                {items.map((p) => (
                  <button key={p.path} type="button" role="menuitem" onClick={() => insert(p.path)} style={{
                    display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, alignItems: 'center',
                    border: 'none', background: 'transparent', padding: '6px 8px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 13, color: 'var(--nx-ink)', textAlign: 'left', fontFamily: 'inherit',
                  }}>
                    <span>{p.label}</span>
                    <code style={{ fontSize: 11, color: 'var(--nx-faint)' }}>{p.path}</code>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} style={{
      ...chip, cursor: 'pointer', fontSize: 11.5, padding: '2px 7px',
      ...(active ? { background: 'var(--nx-primary)', color: '#fff', borderColor: 'var(--nx-primary)' } : null),
    }}>{children}</button>
  );
}

// ── Recipients ─────────────────────────────────────────────────────────────

export function RecipientsPicker({ id, value, onChange, ctx }) {
  const list = Array.isArray(value) ? value : [];
  const [adding, setAdding] = useState('');     // a kind that needs a value
  const [draft, setDraft] = useState('');
  const kinds = recipientKindsFor(ctx.entityDef);
  const labelCtx = { people: ctx.people || [], companies: ctx.companies || [], entityDef: ctx.entityDef };
  const has = (k) => list.some((r) => r.kind === k && !r.value);

  const pick = (kind) => {
    if (!kind) return;
    const meta = kinds.find((k) => k.kind === kind);
    if (meta?.needsValue) { setAdding(kind); setDraft(''); return; }
    if (!has(kind)) onChange([...list, { kind }]);
  };
  const commit = (val) => {
    if (!val) return;
    if (!list.some((r) => r.kind === adding && r.value === val)) onChange([...list, { kind: adding, value: val }]);
    setAdding('');
    setDraft('');
  };
  const remove = (i) => onChange(list.filter((_, j) => j !== i));
  const meta = kinds.find((k) => k.kind === adding);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {list.map((r, i) => (
          <span key={`${r.kind}-${r.value || ''}-${i}`} style={chip}>
            {recipientLabel(r, labelCtx)}
            <button type="button" onClick={() => remove(i)} aria-label={`Remove ${recipientLabel(r, labelCtx)}`} style={{ ...iconBtn, padding: 0 }}><X size={12} /></button>
          </span>
        ))}
        <select id={id} value="" onChange={(e) => pick(e.target.value)} aria-label="Add a recipient" style={{ ...select, padding: '4px 8px', fontSize: 12.5 }}>
          <option value="">+ Add</option>
          {groupBy(kinds, (k) => k.group).map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((k) => <option key={k.kind} value={k.kind} disabled={!k.needsValue && has(k.kind)}>{k.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      {adding && meta?.needsValue === 'person' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <PersonSelect value={draft} onChange={(v) => { if (v) commit(v); }} people={ctx.people || []} placeholder="Choose a person" allowNone={false} ariaLabel="Choose a person" autoFocus />
          <button type="button" onClick={() => setAdding('')} style={{ ...iconBtn }} aria-label="Cancel"><X size={14} /></button>
        </div>
      )}
      {adding && meta?.needsValue === 'company' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={draft} onChange={(e) => commit(e.target.value)} aria-label="Choose a company" style={select} autoFocus>
            <option value="">Choose a company</option>
            {(ctx.companies || []).map((c) => <option key={c.id ?? c.value} value={c.id ?? c.value}>{c.name || c.label}</option>)}
          </select>
          <button type="button" onClick={() => setAdding('')} style={{ ...iconBtn }} aria-label="Cancel"><X size={14} /></button>
        </div>
      )}
      {adding && meta?.needsValue === 'text' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label={meta.label}
            placeholder={`${meta.label.replace(/^A /, '')} name`} style={{ ...textInput, maxWidth: 260 }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(draft.trim()); } if (e.key === 'Escape') setAdding(''); }} />
          <button type="button" onClick={() => commit(draft.trim())} style={{ ...chip, cursor: 'pointer' }}><Plus size={12} /> Add</button>
          <button type="button" onClick={() => setAdding('')} style={{ ...iconBtn }} aria-label="Cancel"><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

// ── Plain select ───────────────────────────────────────────────────────────

function optionList(options) {
  if (Array.isArray(options)) return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o.value ?? o.id ?? o.key, label: o.label ?? o.name ?? String(o.value ?? o.id ?? o.key) }));
  return [];
}

function SelectControl({ id, param, value, onChange }) {
  const opts = optionList(param.options);
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={param.label} style={select}>
      <option value="">{param.hint || 'Choose'}</option>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── Duration ───────────────────────────────────────────────────────────────

function DurationControl({ id, value, onChange, label }) {
  // The unit is the person's choice; the amount is read from the minutes
  // through it, so a saved 120 opens as 2 hours and typing 3 keeps hours.
  const [u, setU] = useState(() => splitMinutes(value).unit);
  const per = (DURATION_UNITS.find((x) => x.key === u) || DURATION_UNITS[0]).minutes;
  const amount = Math.round((Number(value) || 0) / per);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <NumberBox value={amount} onChange={(v) => onChange(joinMinutes(v, u))} min={0} max={99999} label={label} />
      <select id={id} value={u} onChange={(e) => { setU(e.target.value); onChange(joinMinutes(amount, e.target.value)); }} aria-label={`${label} unit`} style={select}>
        {DURATION_UNITS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
      </select>
    </span>
  );
}

// ── A date on the record plus an offset and a time ─────────────────────────

export function DateOffsetControl({ id, value, onChange, ctx, label, withTime = true }) {
  const v = value && typeof value === 'object' ? value : { field: '', offsetDays: 0, time: '08:00' };
  const dates = ctx.entityDef?.dates || [];
  const fields = dates.length ? dates : (ctx.entityDef?.fields || []).filter((f) => f.type === 'date' || f.type === 'datetime');
  const set = (patch) => onChange({ ...v, ...patch });
  const off = Number(v.offsetDays) || 0;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <NumberBox value={Math.abs(off)} onChange={(n) => set({ offsetDays: (off < 0 ? -1 : 1) * (Number(n) || 0) })} min={0} max={3650} unit="days" label={`${label} days`} />
      <select value={off < 0 ? 'before' : 'after'} onChange={(e) => set({ offsetDays: (e.target.value === 'before' ? -1 : 1) * Math.abs(off) })} aria-label={`${label} before or after`} style={select}>
        <option value="before">Before</option>
        <option value="after">After</option>
      </select>
      <select id={id} value={v.field || ''} onChange={(e) => set({ field: e.target.value })} aria-label={`${label} date`} style={select}>
        <option value="">Choose a date</option>
        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      {withTime && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={hint}>at</span><TimeField value={v.time || ''} onChange={(t) => set({ time: t })} ariaLabel={`${label} time`} /></span>}
    </div>
  );
}

// ── A record of another kind (a project, a department, a template) ─────────

function EntityRefControl({ id, param, value, onChange }) {
  const source = typeof param.options === 'string' ? param.options : '';
  const [rows, setRows] = useState(Array.isArray(param.options) ? optionList(param.options) : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (source !== 'task_projects') return undefined;
    let alive = true;
    api.getTaskProjects().then((list) => {
      if (!alive) return;
      setRows((list || []).map((p) => ({ value: p.id, label: p.name })));
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [source]);
  if (rows) {
    return (
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={param.label} style={select}>
        <option value="">{param.hint || `Choose ${param.label.toLowerCase()}`}</option>
        {rows.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (source === 'task_projects' && !failed) return <span style={hint}>Loading projects...</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input id={id} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={param.label} style={{ ...textInput, maxWidth: 360 }} placeholder={param.hint || 'Paste the id'} />
      <span style={hint}>{failed ? 'The list could not be loaded - paste the id instead.' : 'Enter the id of the record this step uses.'}</span>
    </div>
  );
}

// ── A list source and its params ───────────────────────────────────────────

export function ListSourceControl({ id, value, onChange, ctx, label }) {
  const v = value && typeof value === 'object' ? value : { key: '', params: {} };
  const sources = ctx.catalog?.listSources || [];
  const def = sources.find((s) => s.key === v.key);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <select id={id} value={v.key || ''} onChange={(e) => onChange({ key: e.target.value, params: {} })} aria-label={label} style={select}>
        <option value="">Choose a list</option>
        {groupBy(sources, (s) => s.module).map(([module, items]) => (
          <optgroup key={module} label={module}>
            {items.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </optgroup>
        ))}
      </select>
      {(def?.params || []).map((p) => (
        <div key={p.key}>
          <label style={fieldLabel} htmlFor={`${id}-${p.key}`}>{p.label}</label>
          <ParamControl id={`${id}-${p.key}`} param={p} value={v.params?.[p.key]} onChange={(pv) => onChange({ ...v, params: { ...(v.params || {}), [p.key]: pv } })} ctx={ctx} />
        </div>
      ))}
    </div>
  );
}

// ── A list of words (approval options) ─────────────────────────────────────

export function OptionsEditor({ id, value, onChange, label }) {
  const list = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const w = draft.trim();
    if (!w || list.includes(w)) return;
    onChange([...list, w]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {list.map((o) => (
        <span key={o} style={chip}>
          {o}
          <button type="button" onClick={() => onChange(list.filter((x) => x !== o))} aria-label={`Remove ${o}`} disabled={list.length <= 2} style={{ ...iconBtn, padding: 0, opacity: list.length <= 2 ? 0.4 : 1 }}><X size={12} /></button>
        </span>
      ))}
      <input id={id} type="text" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Add ${label || 'option'}`} placeholder="Add an option"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} style={{ ...textInput, width: 150 }} />
      <button type="button" onClick={add} style={{ ...chip, cursor: 'pointer' }}><Plus size={12} /> Add</button>
    </div>
  );
}
