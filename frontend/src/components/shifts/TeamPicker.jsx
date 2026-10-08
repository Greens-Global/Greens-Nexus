// The team switcher (10/02): the schedule shows ONE team at a time - "rather
// than going down and looking at teams you get a dropdown where you can
// toggle between teams" (the owner, looking at eight teams stacked). The
// button says which team, how many people and their hours this week; the
// menu lists every team with its people, hours and anything waiting
// (drafts, open shifts), then All Teams (the stacked view, kept) and People
// Without a Team. Searchable past six teams; arrows + Enter, Esc closes.
// Used by the Schedule toolbar (desktop and phone) and My Shifts' Group
// Shifts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search, Layers, UserMinus } from 'lucide-react';
import { useAnchor, useDismissBoth, HEAD } from './Menu';
import { fmtHrs } from './shiftLib';

export const ALL_TEAMS = '__all';
export const NO_TEAM = '__none';

const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
// "7 people · 278 Hrs" - hours only when known.
export const teamStats = (t) => [Number.isFinite(t?.people) ? people(t.people) : '', Number.isFinite(t?.min) ? fmtHrs(t.min) : '', t?.hint || ''].filter(Boolean).join(' · ');

const Dot = ({ color, size = 10 }) => (
  <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: '0 0 0 2px var(--card), 0 0 0 3px color-mix(in srgb, currentColor 10%, transparent)' }} />
);
const Glyph = ({ Icon }) => (
  <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
    <Icon size={11} />
  </span>
);
const Count = ({ n, label, tone }) => (n > 0 ? (
  <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
    background: `hsla(var(--color-${tone}),0.12)`, color: `hsl(var(--color-${tone}))` }}>{n} {label}</span>
) : null);

export default function TeamPicker({ teams = [], value, onChange, all = null, none = null, compact = false, ariaLabel = 'Choose a team', width = 380, shortcuts = false, style }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const close = useCallback(() => { setOpen(false); setQ(''); }, []);
  const ref = useRef(null);
  const popRef = useRef(null);
  useDismissBoth(open, [ref, popRef], () => { close(); btnRef.current?.focus(); });
  const pos = useAnchor(open, btnRef, compact ? 340 : width);
  const live = teams.filter((t) => !t.archived);
  const archived = teams.filter((t) => t.archived);
  const searchable = live.length > 6;
  const needle = q.trim().toLowerCase();
  const match = (t) => !needle || t.name.toLowerCase().includes(needle);

  // Every pickable row in order: the teams, then All Teams, People Without a
  // Team, then the archived teams.
  const options = useMemo(() => {
    const rows = live.filter(match).map((t) => ({ ...t, kind: 'team', key: live.indexOf(t) < 9 ? String(live.indexOf(t) + 1) : '' }));
    archived.filter(match).forEach((t, i) => rows.push({ ...t, kind: 'archived', head: i === 0 }));
    // All Teams and People Without a Team sit in a footer that never scrolls away.
    if (!needle) {
      if (all) rows.push({ ...all, id: ALL_TEAMS, name: 'All Teams', kind: 'all' });
      if (none && none.people > 0) rows.push({ ...none, id: NO_TEAM, name: 'People Without a Team', kind: 'none' });
    }
    return rows;
  }, [teams, all, none, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = value === ALL_TEAMS ? { ...all, id: ALL_TEAMS, name: 'All Teams', kind: 'all' }
    : value === NO_TEAM ? { ...none, id: NO_TEAM, name: 'People Without a Team', kind: 'none' }
      : teams.find((t) => t.id === value) || null;

  useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.id === value);
    setActive(i < 0 ? 0 : i);
    if (!searchable) listRef.current?.focus();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && needle) setActive(0); }, [needle, open]);
  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const pick = (o) => { if (!o) return; onChange(o.id); close(); btnRef.current?.focus(); };
  const keys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(options[active]); }
    else if (e.key === 'Tab') { close(); }
  };
  const buttonKeys = (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); setOpen(true); } };

  const lead = (o, size) => (o?.kind === 'all' ? <Glyph Icon={Layers} /> : o?.kind === 'none' ? <Glyph Icon={UserMinus} /> : <Dot color={o?.color || 'var(--muted)'} size={size} />);
  const stats = current ? teamStats(current) : '';
  const row = (o, i) => {
    const on = o.id === value;
    const hot = i === active;
    return (
      <div key={o.id}>
        {o.sep && <div style={{ height: 1, background: 'var(--line)', margin: '6px 6px' }} />}
        {o.head && <div style={{ ...HEAD, padding: '10px 8px 4px' }}>Archived</div>}
        <div id={`team-opt-${i}`} data-idx={i} role="option" aria-selected={on} onClick={() => pick(o)} onMouseMove={() => setActive(i)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
            background: hot ? 'var(--bg)' : 'transparent', boxShadow: hot ? 'inset 0 0 0 1px var(--line)' : 'none' }}>
          {lead(o, 9)}
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: on ? 700 : 600, color: o.kind === 'archived' ? 'var(--muted)' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</span>
              <Count n={o.drafts} label={o.drafts === 1 ? 'draft' : 'drafts'} tone="orange" />
              <Count n={o.open} label="open" tone="green" />
            </span>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {[Number.isFinite(o.people) ? people(o.people) : '', o.hint || '', o.kind === 'all' ? 'Every team, stacked' : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          {Number.isFinite(o.min) && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtHrs(o.min)}</span>}
          {shortcuts && (
            <kbd aria-label={o.key ? `Shortcut ${o.key}` : undefined} style={{ width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderRadius: 5,
              border: o.key ? '1px solid var(--line)' : 'none', background: o.key ? 'var(--bg)' : 'transparent', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', fontFamily: 'inherit' }}>{o.key || ''}</kbd>
          )}
          <span style={{ width: 14, display: 'inline-flex', flexShrink: 0 }}>{on && <Check size={14} color="var(--wk-brand)" />}</span>
        </div>
      </div>
    );
  };
  const listId = 'team-picker-list';

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0, display: 'inline-flex', ...style }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} onKeyDown={buttonKeys} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        title={current ? `${current.name}${stats ? ` - ${stats}` : ''}` : undefined}
        className="team-picker-btn"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0, maxWidth: '100%', height: compact ? 36 : 40, padding: compact ? '0 10px 0 11px' : '0 12px 0 13px',
          border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)',
          boxShadow: open ? '0 0 0 3px var(--wk-brand-tint)' : '0 1px 2px rgba(15,23,42,0.04)', borderColor: open ? 'var(--wk-brand)' : 'var(--line)', flex: compact ? 1 : undefined }}>
        {lead(current, 10)}
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: compact ? 13.5 : 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '-0.005em' }}>{current ? current.name : 'Choose a Team'}</span>
          {stats && !compact && <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stats}</span>}
        </span>
        <ChevronDown size={15} style={{ flexShrink: 0, color: 'var(--muted)', marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && pos && createPortal(
        <div ref={popRef} className="m-menu" style={{ ...pos, zIndex: 1350, background: 'var(--card)',
          border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 16px 40px rgba(15,23,42,0.18)', fontFamily: 'Inter,sans-serif', overflow: 'hidden' }}>
          {searchable && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: 8, border: '1px solid var(--line)', borderRadius: 8, padding: '6px 9px' }}>
              <Search size={13} color="var(--muted)" />
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} placeholder="Search teams" aria-label="Search teams" autoFocus
                aria-controls={listId} aria-activedescendant={options[active] ? `team-opt-${active}` : undefined}
                style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, flex: 1, fontFamily: 'inherit', color: 'var(--ink)', minWidth: 0 }} />
            </label>
          )}
          <div ref={listRef} id={listId} role="listbox" aria-label="Teams" tabIndex={searchable ? -1 : 0} onKeyDown={keys}
            aria-activedescendant={options[active] ? `team-opt-${active}` : undefined}
            style={{ maxHeight: 'min(420px, 60vh)', overflowY: 'auto', padding: searchable ? '0 6px 6px' : 6, outline: 'none' }}>
            {options.map((o, i) => (o.kind === 'team' || o.kind === 'archived' ? row(o, i) : null))}
            {!options.length && <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No teams match.</div>}
            {options.some((o) => o.kind === 'all' || o.kind === 'none') && (
              <div role="group" aria-label="Other views" style={{ position: 'sticky', bottom: searchable ? -6 : -6, margin: '6px -6px -6px', padding: 6, borderTop: '1px solid var(--line)', background: 'var(--card)' }}>
                {options.map((o, i) => (o.kind === 'all' || o.kind === 'none' ? row(o, i) : null))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
