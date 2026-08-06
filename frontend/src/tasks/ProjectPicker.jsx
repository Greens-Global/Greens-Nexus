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

const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' });

export default function ProjectPicker({
  projects = [], teams = [], myEmail = '', value = '', onChange, onCreateNew,
  invalid = false, placeholder = 'Select a project…', allowNone = false, noneLabel = 'No project',
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef(null);
  const searchRef = useRef(null);

  const selected = projects.find((p) => p.id === value) || null;

  const { mine, others } = useMemo(() => {
    const mineIds = myProjectIds(projects, teams, myEmail);
    const needle = q.trim().toLowerCase();
    const match = (p) => !needle || (p.name || '').toLowerCase().includes(needle);
    const live = (projects || []).filter((p) => !p.archived && match(p));
    return {
      mine: live.filter((p) => mineIds.has(p.id)).sort(byName),
      others: live.filter((p) => !mineIds.has(p.id)).sort(byName),
    };
  }, [projects, teams, myEmail, q]);

  // Close on an outside click or Escape - a panel that traps you is worse than
  // the select it replaced.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);

  const pick = (id) => { onChange?.(id); setOpen(false); setQ(''); };

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
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
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

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.16)', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            borderBottom: `1px solid ${NX.border2}` }}>
            <Search size={14} style={{ color: NX.faint, flexShrink: 0 }} />
            <input
              ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search projects"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const first = mine[0] || others[0];
                  if (first) pick(first.id);
                }
              }}
              style={{ border: 'none', outline: 'none', background: 'transparent', flex: 1,
                fontSize: 13.5, color: NX.ink, fontFamily: FONT }} />
          </div>

          <div className="nx-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
            {allowNone && !q.trim() && (
              <button type="button" onClick={() => pick('')} style={rowStyle(!value)}>
                <span style={{ width: 14, flexShrink: 0 }}>{!value && <Check size={14} />}</span>
                <span style={{ color: NX.dim }}>{noneLabel}</span>
              </button>
            )}

            {mine.length > 0 && <div style={heading}>Your Projects</div>}
            {mine.map((p) => (
              <button key={p.id} type="button" onClick={() => pick(p.id)} style={rowStyle(p.id === value)}>
                <span style={{ width: 14, flexShrink: 0 }}>{p.id === value && <Check size={14} />}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </button>
            ))}

            {others.length > 0 && <div style={heading}>{mine.length ? 'All Projects' : 'Projects'}</div>}
            {others.map((p) => (
              <button key={p.id} type="button" onClick={() => pick(p.id)} style={rowStyle(p.id === value)}>
                <span style={{ width: 14, flexShrink: 0 }}>{p.id === value && <Check size={14} />}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
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
              style={{ ...rowStyle(false), borderTop: `1px solid ${NX.border2}`, color: NX.blue, fontWeight: 600 }}>
              <Plus size={14} /> Create New Project
            </button>
          )}
        </div>
      )}
    </div>
  );
}
