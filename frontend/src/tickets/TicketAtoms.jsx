// Ticket Module - small presentational pieces shared by the list, the create
// wizard and the drawer. Everything here is driven by ticketMeta.js.
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { NX, FONT, chip, btn, input as inputStyle } from '../tasks/theme';
import { PersonSelect, PersonMultiSelect, DateField, SearchSelect, SelectMenu, Avatar, useIsMobile } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import TeamPicks, { pickableTeams, firstTeamPick, toggleRoster } from '../tasks/teamPicks';
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
  // An option may carry `desc` - a one-line plain-English definition shown
  // under its label in the open list (Neil, Sep 30: people cannot tell a Bug
  // Report from an Incident unless each option says what it means).
  const withDesc = opts.some((o) => o.desc);
  const renderOption = withDesc ? (o) => (
    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontWeight: 600 }}>{o.label}</span>
      {o.desc && <span style={{ fontSize: 11.5, color: NX.dim, whiteSpace: 'normal', lineHeight: 1.35 }}>{o.desc}</span>}
    </span>
  ) : undefined;
  return (
    <SearchSelect options={withDesc ? opts.map((o) => ({ ...o, keywords: o.desc || '' })) : opts}
      value={command ? undefined : (value ?? '')}
      onPick={(id) => onChange(id)} placeholder={placeholder} searchPlaceholder={searchPlaceholder}
      emptyText={emptyText} menuMinWidth={withDesc ? Math.max(menuMinWidth, 320) : menuMinWidth} buttonStyle={base}
      renderOption={renderOption} />
  );
}

// The Requester dropdown's look, picking several people (Collaborators, Sagar
// Oct 14 2026): the same full-width field, search box and two-line rows (name,
// then email). The list stays open while people are ticked; the field shows
// them as small chips that can be taken off without opening it.
// `options` is [{ id: email, label: name, desc: email }]; value/onChange are arrays.
// And the task module's Collaborators extras (Neil, Oct 14 2026: "use the
// same functionality that is in the task module"): `teams` adds a Teams
// group - a whole roster in one click - with "Save as a Team" once two or
// more are picked (`onSaveTeam`); `frequent` (emails, best first) puts the
// people you work with most above everyone else while nothing is typed.
export function TicketPeopleMultiSelect({ value, onChange, options, placeholder = 'No collaborators', searchPlaceholder = 'Search people…', emptyText = 'No one matches.', label = 'Collaborators', teams = null, onSaveTeam = null, frequent = null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const queryRef = useRef(null);
  const isMobile = useIsMobile();
  const picked = Array.isArray(value) ? value : [];
  const nameOf = (id) => options.find((o) => o.id === id)?.label || id;
  const query = q.trim().toLowerCase();
  const shown = query ? options.filter((o) => `${o.label} ${o.desc || ''}`.toLowerCase().includes(query)) : options;
  // TeamPicks speaks the people-directory shape.
  const people = options.map((o) => ({ email: o.id, name: o.label }));
  const top = query ? [] : (frequent || []).map((em) => options.find((o) => o.id === em)).filter(Boolean).slice(0, 5);
  const teamRows = teams ? pickableTeams(teams, people, q).length : 0;
  // Once a name is ticked the search that found it is done: clear it, so the
  // next name can be typed straight away - as in the task module.
  const toggle = (id) => {
    const adding = !picked.includes(id);
    onChange(adding ? [...picked, id] : picked.filter((x) => x !== id));
    if (adding && query) { setQ(''); queryRef.current?.focus(); }
  };
  const pickTeam = (next, adding) => { onChange(next); if (adding) { setQ(''); queryRef.current?.focus(); } };
  const caption = (text) => <div style={{ padding: '9px 12px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint }}>{text}</div>;
  const row = (o, keyPrefix = '') => {
    const on = picked.includes(o.id);
    return (
      <div key={keyPrefix + o.id} role="option" aria-selected={on} className="nx-menu-row" onClick={() => toggle(o.id)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink,
          background: on ? `${NX.blue}12` : undefined, ...(isMobile ? { minHeight: 40, boxSizing: 'border-box' } : null) }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{o.label}</span>
          {o.desc && <span style={{ fontSize: 11.5, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.desc}</span>}
        </span>
        {on && <Check size={14} style={{ color: NX.blue, flexShrink: 0 }} />}
      </div>
    );
  };
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" aria-label={label} aria-haspopup="listbox" onClick={() => { setOpen((o) => !o); setQ(''); }}
        style={{ ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer',
          height: 'auto', minHeight: 38, textAlign: 'left', fontWeight: 400, padding: picked.length ? '5px 10px' : undefined }}>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minWidth: 0, flex: 1 }}>
          {picked.length === 0 && <span style={{ color: NX.faint }}>{placeholder}</span>}
          {picked.map((id) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 7px 2px 2px', fontSize: 12, color: NX.ink }}>
              <Avatar email={id} name={nameOf(id)} size={18} card={false} />
              {nameOf(id)}
              {/* A span: it sits inside the trigger button. */}
              <span role="button" tabIndex={-1} title={`Remove ${nameOf(id)}`}
                onClick={(e) => { e.stopPropagation(); toggle(id); }}
                style={{ display: 'inline-flex', cursor: 'pointer', color: NX.faint }}><X size={11} /></span>
            </span>
          ))}
        </span>
        <ChevronDown size={15} style={{ flexShrink: 0, opacity: 0.75 }} />
      </button>
      {open && (
        <SelectMenu anchorRef={ref} onClose={() => { setOpen(false); setQ(''); }} minWidth={260}>
          <input ref={queryRef} autoFocus={!isMobile} value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return; }
              // Enter on a search that names a team and nobody takes the team.
              if (e.key === 'Enter' && teams) {
                e.preventDefault();
                if (shown.length) { toggle(shown[0].id); return; }
                const team = firstTeamPick(teams, people, q);
                if (team) { const r = toggleRoster(picked, team.roster); pickTeam(r.next, r.adding); }
              }
            }}
            style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: isMobile ? '11px 12px' : '9px 12px',
              fontSize: isMobile ? 16 : 13, fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          {teams && <TeamPicks teams={teams} people={people} selected={picked} query={q} inset={12} rowPad="8px 12px"
            onSaveTeam={onSaveTeam} onChange={pickTeam} />}
          {top.length > 0 && caption('Frequent')}
          {top.map((o) => row(o, 'f:'))}
          {top.length > 0 ? caption('All') : (teamRows > 0 && shown.length > 0 && caption('People'))}
          {shown.map((o) => row(o))}
          {shown.length === 0 && teamRows === 0 && <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>{query ? `No matches for “${q.trim()}”.` : emptyText}</div>}
        </SelectMenu>
      )}
    </div>
  );
}

// Local-state text inputs for TypeFieldInput's free-text cases: `onChange`
// (the actual patch({ typeFields: ... }) save) fires on blur, never per
// keystroke. A field wired straight to onChange={(v) => patch(...)} - what
// this used to be - saves on every keystroke, and once activity logging
// started diffing typeFields (Sept 8 2026) that meant one "changed X from
// ... to ..." row per CHARACTER typed. This is the actual fix, not a
// workaround for the log after the fact - same blur-commit pattern
// TicketCustomFieldInput already uses below.
function DebouncedTextInput({ value, onChange, ...props }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <input value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value ?? '')) onChange(v); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      {...props} />
  );
}
function DebouncedTextarea({ value, onChange, ...props }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <textarea value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value ?? '')) onChange(v); }}
      {...props} />
  );
}

export function TypeFieldInput({ field: f, value, onChange, people, projects, invalid }) {
  // `invalid` only tints the border - the "Required" text is rendered by the caller.
  const iStyle = invalid ? { ...inputStyle, borderColor: NX.red } : inputStyle;
  if (f.type === 'textarea') return <DebouncedTextarea value={value} onChange={onChange} rows={3} placeholder={f.placeholder || ''} style={{ ...iStyle, resize: 'vertical', fontFamily: FONT }} />;
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
      <DebouncedTextInput type="number" value={value} onChange={onChange} placeholder={f.placeholder || ''} style={{ ...iStyle, flex: 1, minWidth: 0 }} />
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
  return <DebouncedTextInput value={value} onChange={onChange} placeholder={f.placeholder || ''} style={iStyle} />;
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

export function TicketStatusChip({ status, size }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: '#64748b' };
  return <StatusLabel label={m.label} color={m.color} size={size} />;
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

