// Ticket Module - small presentational pieces shared by the list, the create
// wizard and the drawer. Everything here is driven by ticketMeta.js.
import { useEffect, useState } from 'react';
import { NX, FONT, chip, btn, input as inputStyle } from '../tasks/theme';
import { PersonSelect, PersonMultiSelect, DateField, SearchSelect } from '../tasks/components';
import {
  TICKET_TYPE_META, TICKET_STATUS_META, SLA_META, slaState, toEmailList, fmtDate,
} from './ticketMeta';

// The kit dropdown, shaped like the <select> it replaces (same value/onChange,
// options as [id, label] pairs) so a conversion is one line per call site.
//
// Why not a native <select>: its list is drawn by the browser, not the page.
// It cannot carry a search box - typing only jumps to a prefix - and it ignores
// the app's type scale, which is why phone dropdowns came up at system size
// beside 12.5px chrome (Sagar, Sept 1 2026). SearchSelect renders in-page, so
// it searches, matches the kit, and is one control on every browser.
//
// `command` = the bulk bar's "Set status…" shape: the trigger always reads as
// its placeholder because the pick is an action, not a stored value.
export function TicketSelect({
  value, onChange, options, placeholder = 'Select…', searchPlaceholder = 'Search…',
  emptyText = 'Nothing to choose from.', style, disabled = false, invalid = false,
  command = false, menuMinWidth = 240,
}) {
  const opts = (options || []).map((o) => (Array.isArray(o) ? { id: o[0], label: o[1] } : o));
  const base = {
    ...inputStyle, cursor: 'pointer', justifyContent: 'space-between', height: 'auto',
    fontWeight: 400, textAlign: 'left', gap: 8,
    ...(invalid ? { borderColor: NX.red } : null),
    ...style,
  };
  // Disabled reads as the value it holds, not as a dead control you can open -
  // the native `disabled` select this replaces did the same.
  if (disabled) {
    const chosen = opts.find((o) => o.id === (value ?? ''));
    return (
      <div style={{ ...base, display: 'flex', alignItems: 'center', overflow: 'hidden', opacity: 0.7, cursor: 'default', color: chosen ? NX.ink : NX.faint }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chosen?.label || placeholder}</span>
      </div>
    );
  }
  return (
    <SearchSelect options={opts} value={command ? undefined : (value ?? '')}
      onPick={(id) => onChange(id)} placeholder={placeholder} searchPlaceholder={searchPlaceholder}
      emptyText={emptyText} menuMinWidth={menuMinWidth} buttonStyle={base} />
  );
}

export function TypeFieldInput({ field: f, value, onChange, people, projects, invalid }) {
  // `invalid` only tints the border - the "Required" text is rendered by the caller.
  const iStyle = invalid ? { ...inputStyle, borderColor: NX.red } : inputStyle;
  if (f.type === 'textarea') return <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={f.placeholder || ''} style={{ ...iStyle, resize: 'vertical', fontFamily: FONT }} />;
  if (f.type === 'select') return (
    <TicketSelect value={value ?? ''} onChange={onChange} invalid={invalid}
      options={[['', 'Select…'], ...f.options.map((o) => [o, o])]} placeholder="Select…" />
  );
  if (f.type === 'radio') return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {f.options.map((o) => {
        const on = value === o;
        return <button type="button" key={o} onClick={() => onChange(on ? '' : o)} style={{
          ...btn('ghost'), padding: '5px 11px', fontSize: 12.5, borderRadius: 20, border: `1px solid ${on ? NX.blue : NX.border}`,
          background: on ? 'rgba(37,99,235,0.10)' : 'transparent', color: on ? NX.blue : NX.dim, fontWeight: on ? 700 : 600,
        }}>{o}</button>;
      })}
    </div>
  );
  if (f.type === 'number') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {f.prefix && <span style={{ color: NX.dim, fontWeight: 600 }}>{f.prefix}</span>}
      <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder || ''} style={{ ...iStyle, flex: 1, minWidth: 0 }} />
    </div>
  );
  if (f.type === 'date') return <DateField value={value || ''} onChange={(v) => onChange(v || '')} placeholder="Pick a date" style={iStyle} />;
  if (f.type === 'datetime') return <input type="datetime-local" value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ ...iStyle, appearance: 'auto' }} />;
  if (f.type === 'person') return <PersonSelect value={value || null} onChange={(v) => onChange(v || '')} people={people} placeholder="Select person" />;
  if (f.type === 'multiperson') return <PersonMultiSelect value={toEmailList(value)} onChange={onChange} people={people} placeholder="Select people" />;
  // Projects are alphabetical and searchable: a ticket desk sees the whole
  // workspace's project list, which is far past what a native select can show.
  if (f.type === 'project') return (
    <SearchSelect value={value ?? ''} placeholder="No project" searchPlaceholder="Search projects…"
      emptyText="No projects yet." onPick={(id) => onChange(id)}
      buttonStyle={{ ...iStyle, cursor: 'pointer', justifyContent: 'space-between' }}
      options={[{ id: '', label: 'No project' },
                ...(projects || []).slice()
                  .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                  .map((p) => ({ id: p.id, label: p.name }))]} />
  );
  if (f.type === 'multiselect') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {f.options.map((o) => {
          const on = arr.includes(o);
          return <button type="button" key={o} onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])} style={{
            ...btn('ghost'), padding: '5px 11px', fontSize: 12.5, borderRadius: 20, border: `1px solid ${on ? NX.blue : NX.border}`,
            background: on ? 'rgba(37,99,235,0.10)' : 'transparent', color: on ? NX.blue : NX.dim, fontWeight: on ? 700 : 600,
          }}>{o}</button>;
        })}
      </div>
    );
  }
  if (f.type === 'checklist') {
    const items = Array.isArray(value) && value.length ? value : (f.items || []).map((l) => ({ label: l, done: false }));
    const setItem = (i, done) => onChange(items.map((it, x) => (x === i ? { ...it, done } : it)));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map((it, i) => (
          <label key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!it.done} onChange={(e) => setItem(i, e.target.checked)} />
            <span style={{ color: it.done ? NX.faint : NX.ink, textDecoration: it.done ? 'line-through' : 'none' }}>{it.label}</span>
          </label>
        ))}
      </div>
    );
  }
  return <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder || ''} style={iStyle} />;
}

// Inline "Required" note shown under a field after a failed submit.

export function TicketTypeIcon({ type, size = 15 }) {
  const m = TICKET_TYPE_META[type] || TICKET_TYPE_META.request;
  const Icon = m.icon;
  return <Icon size={size} style={{ color: m.color, flexShrink: 0 }} title={m.label} />;
}


export function SlaBadge({ t, compact = false }) {
  const s = slaState(t);
  const m = SLA_META[s];
  if (!m) return null;
  return (
    // A step down from the status/priority chip it sits beside - it qualifies
    // that chip rather than competing with it (Sagar, Sept 1 2026).
    <span title={`SLA due ${fmtDate(t.slaDueOn)}`} style={{ ...chip(m.color, m.tint), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px' }}>
      <m.Icon size={11} />{compact ? '' : m.label}
    </span>
  );
}

export function TicketStatusChip({ status }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: NX.dim, tint: NX.border2 };
  return <span style={chip(m.color, m.tint)}>{m.label}</span>;
}


// Saved-views dropdown - apply a saved filter set, save the current one, or delete.

// ── Custom field input (reuses the Manage custom-field definitions) ───────────
export function TicketCustomFieldInput({ field, value, onChange }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const style = { ...inputStyle, width: 'auto', minWidth: 180, padding: '6px 9px', fontSize: 13 };
  if (field.type === 'select' && Array.isArray(field.options)) {
    return (
      <TicketSelect value={v} onChange={(id) => { setV(id); onChange(id); }} style={style}
        options={[['', '-'], ...field.options.map((o) => [o, o])]} placeholder="-" />
    );
  }
  return (
    <input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={() => onChange(v)} style={style} />
  );
}

