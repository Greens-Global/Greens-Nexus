// Task module - picking a project when creating a task.
//
// This was a bare <select> listing every project the API returned, in whatever
// order the database handed them over. With ~30 projects that is unusable, and
// the end-user feedback named all three problems at once: no scoping, no order,
// no search.
//
// What it does NOT do is narrow the list to only the projects you belong to.
// The backend already scopes this (visible_project_ids), and it counts an
// `org`-level project as visible to everyone deliberately - that is most of
// them, and people legitimately file tasks into projects they are not a member
// of. Removing those would trade an annoyance for "I can't file my task at all".
//
// So the fix is ordering, not exclusion: the projects you actually belong to
// come first under their own heading, everything else follows, both alphabetical,
// and a search box covers the long tail. The common case becomes the top of the
// list and the rare case is still reachable.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import { NX, FONT, input as inputStyle } from './theme';
import { teamInProject } from './lib';
import AnchoredMenu from '../components/AnchoredMenu';
import { useListNav, openPickerOnKey, caretToEnd, focusNextField } from '../lib/listNav';

// The "No project" row, as an item the keyboard can land on.
const NONE_ROW = { id: '', name: '' };

/** Projects the user is actually attached to: owner, explicit member, or a
 *  member of a team that is on the project. Mirrors the "direct access or team
 *  access" the request asks for - minus the org-wide default, which is what
 *  makes the raw list long. */
export function myProjectIds(projects, teams, myEmail) {
  const me = (myEmail || '').toLowerCase();
  if (!me) return new Set();
  const mine = new Set();
  for (const p of projects || []) {
    const owner = (p.ownerId || '').toLowerCase();
    const members = (p.memberIds || []).map((m) => (m || '').toLowerCase());
    if (owner === me || members.includes(me)) mine.add(p.id);
  }
  for (const t of teams || []) {
    if (!(t.memberIds || []).some((m) => (m || '').toLowerCase() === me)) continue;
    for (const p of projects || []) if (teamInProject(t, p.id)) mine.add(p.id);
  }
  return mine;
}

// numeric:true so number-led names (street addresses - "26382 Palisades Drive",
// "910 S. ECR") sort by their numeric value (910 before 26382) instead of
// character-by-character, where "9" > "2" put 910 after 26382/29960 and read
// as broken alphabetical order even though a plain string sort was correct.
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base', numeric: true });

export default function ProjectPicker({
  projects = [], teams = [], myEmail = '', value = '', onChange, onCreateNew,
  invalid = false, placeholder = 'Select a project…', allowNone = false, noneLabel = 'No project',
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef(null);
  const searchRef = useRef(null);
  // The panel matches the field's width; it's portaled, so it can't read it
  // from a shared parent any more.
  const [panelW, setPanelW] = useState(0);

  const selected = projects.find((p) => p.id === value) || null;

  const { mine, others } = useMemo(() => {
    const mineIds = myProjectIds(projects, teams, myEmail);
    const needle = q.trim().toLowerCase();
    const match = (p) => !needle || (p.name || '').toLowerCase().includes(needle);
    const live = (projects || []).filter((p) => !p.archived && match(p));
    // While searching, a name that STARTS with the text comes first, then one
    // with a word that does, then the rest - the same ranking the people
    // pickers use (lib/peopleSearch.js) - so "me" highlights Menifee, not
    // "GSE Development", for Enter to take.
    const rank = (p) => {
      const name = (p.name || '').toLowerCase();
      return name.startsWith(needle) ? 0 : name.split(/[\s\-_/#.]+/).some((w) => w.startsWith(needle)) ? 1 : 2;
    };
    const order = needle ? (a, b) => rank(a) - rank(b) || byName(a, b) : byName;
    return {
      mine: live.filter((p) => mineIds.has(p.id)).sort(order),
      others: live.filter((p) => !mineIds.has(p.id)).sort(order),
    };
  }, [projects, teams, myEmail, q]);

  // Escape closes just the panel, not the modal around it - hence capture +
  // stopPropagation. An outside tap is AnchoredMenu's job.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); setQ(''); wrapRef.current?.focus(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);

  const pick = (id) => { onChange?.(id); setOpen(false); setQ(''); wrapRef.current?.focus(); };
  const openPanel = (text = '') => { setPanelW(wrapRef.current?.offsetWidth || 0); setQ(text); setOpen(true); };

  // Keyboard: the highlighted row is what Enter takes (see lib/listNav.js).
  const showNone = allowNone && !q.trim();
  const navItems = [...(showNone ? [NONE_ROW] : []), ...mine, ...others];
  const nav = useListNav(navItems, {
    open, query: q,
    startAt: navItems.findIndex((p) => p.id === (value || '')),
    onPick: (p) => pick(p.id),
    onTab: (p, back) => {
      if (p) onChange?.(p.id);
      setOpen(false); setQ('');
      focusNextField(wrapRef.current, back);
    },
  });
  const navAt = (p) => nav.optionProps(navItems.indexOf(p));

  // className carries the hover/focus highlight (.nx-menu-row in style.css) -
  // inline styles cannot express a :hover state, which is why these rows only
  // ever lit up for the SELECTED one.
  const rowStyle = (active) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '8px 12px', border: 'none', background: active ? NX.hover : 'transparent',
    cursor: 'pointer', fontSize: 13.5, color: NX.ink, fontFamily: FONT,
  });

  const heading = {
    padding: '8px 12px 4px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em',
    textTransform: 'uppercase', color: NX.faint,
  };

  return (
    <div>
      <button ref={wrapRef} type="button" onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={(e) => { if (!open) openPickerOnKey(e, openPanel); }}
        style={{
          ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, cursor: 'pointer', textAlign: 'left', width: '100%',
          ...(invalid ? { borderColor: NX.red } : {}),
        }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: selected ? NX.ink : NX.faint }}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronDown size={15} style={{ color: NX.dim, flexShrink: 0 }} />
      </button>

      {/* Portaled: inside Create Task the modal body scrolls, and clipped
          the panel's lower half. */}
      <AnchoredMenu anchorRef={wrapRef} open={open} onClose={() => setOpen(false)} role="dialog" style={{
        // At least as wide as the field, and never narrower than 360px: in
        // the task drawer the field is ~220px, and copying that width cut
        // "Maintenance 910 S. ECR" to "Maintenance 910 S. El..." (Oct 13 2026).
        // AnchoredMenu keeps it on screen on a phone.
        width: Math.max(panelW || 0, 360),
        background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.16)', overflowX: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
          borderBottom: `1px solid ${NX.border2}` }}>
          <Search size={14} style={{ color: NX.faint, flexShrink: 0 }} />
          <input className="nx-inline-edit"
            ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects"
            {...nav.inputProps} onFocus={caretToEnd} onKeyDown={nav.onKeyDown}
            style={{ border: 'none', flex: 1,
              fontSize: 13.5, color: NX.ink, fontFamily: FONT }} />
        </div>

        <div role="listbox" className="nx-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {allowNone && !q.trim() && (
            <button type="button" tabIndex={-1} className="nx-menu-row" {...navAt(NONE_ROW)} onClick={() => pick('')} style={rowStyle(false)}>
              <span style={{ width: 14, flexShrink: 0 }}>{!value && <Check size={14} />}</span>
              <span style={{ color: NX.dim }}>{noneLabel}</span>
            </button>
          )}

          {mine.length > 0 && <div style={heading}>Your Projects</div>}
          {mine.map((p) => (
            <button key={p.id} type="button" tabIndex={-1} className="nx-menu-row" {...navAt(p)} onClick={() => pick(p.id)} style={rowStyle(false)}>
              <span style={{ width: 14, flexShrink: 0 }}>{p.id === value && <Check size={14} />}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.35 }}>{p.name}</span>
            </button>
          ))}

          {others.length > 0 && <div style={heading}>{mine.length ? 'All Projects' : 'Projects'}</div>}
          {others.map((p) => (
            <button key={p.id} type="button" tabIndex={-1} className="nx-menu-row" {...navAt(p)} onClick={() => pick(p.id)} style={rowStyle(false)}>
              <span style={{ width: 14, flexShrink: 0 }}>{p.id === value && <Check size={14} />}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.35 }}>{p.name}</span>
            </button>
          ))}

          {mine.length === 0 && others.length === 0 && (
            <div style={{ padding: '18px 12px', textAlign: 'center', fontSize: 13, color: NX.faint }}>
              No project matches “{q.trim()}”.
            </div>
          )}
        </div>

        {onCreateNew && (
          <button type="button" onClick={() => { setOpen(false); setQ(''); onCreateNew(); }}
            className="nx-menu-row"
            style={{ ...rowStyle(false), borderTop: `1px solid ${NX.border2}`, color: NX.blue, fontWeight: 600 }}>
            <Plus size={14} /> Create New Project
          </button>
        )}
      </AnchoredMenu>
    </div>
  );
}
