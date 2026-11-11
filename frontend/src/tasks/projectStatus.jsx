// Task Module - a project's health (Neil, 11/08/2026): Not Started / On Track /
// At Risk / Off Track / Finished, set by hand by a project editor from the
// Projects list, the Portfolios rows and the project's header. One soft
// StatusLabel chip; clicking it (when you may edit) opens a small popover
// with the five words, a one-line Why and Save. A project nobody has set
// shows nothing of this - the caller keeps whatever it showed before.
import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { StatusLabel } from '../components/StatusLabel';
import AnchoredMenu from '../components/AnchoredMenu';
import { useRole } from '../contexts/RoleContext';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { fmtDate, projectRoleWithTeams, roleAtLeast } from './lib';

export const PROJECT_HEALTH = {
  not_started: { label: 'Not Started', color: '#64748b' },
  on_track:    { label: 'On Track',    color: NX.green },
  at_risk:     { label: 'At Risk',     color: NX.amber },
  off_track:   { label: 'Off Track',   color: NX.red },
  finished:    { label: 'Finished',    color: '#94a3b8' },
};
export const PROJECT_HEALTH_ORDER = ['not_started', 'on_track', 'at_risk', 'off_track', 'finished'];

/** The health meta of a project somebody has set, else null. */
export function projectHealth(p) {
  return p?.statusSetAt && PROJECT_HEALTH[p.status] ? PROJECT_HEALTH[p.status] : null;
}

/** "Set by Sagar on 11/08/2026: Permits are late". */
export function healthTitle(p, nameOf) {
  if (!p?.statusSetAt) return '';
  const who = p.statusSetBy ? (nameOf?.(p.statusSetBy) || p.statusSetBy) : 'someone';
  return `Set by ${who} on ${fmtDate(p.statusSetAt)}${p.statusNote ? `: ${p.statusNote}` : ''}`;
}

/** Who may set a project's status (its editors and up), and the save. */
export function useProjectStatusEditor() {
  const store = useTasks() || {};
  const { canAccessModule } = useRole() || {};
  const isManager = typeof canAccessModule === 'function' && !!canAccessModule('tasks', 'manager', 'full');
  return {
    canSet: (p) => !!p && roleAtLeast(projectRoleWithTeams(p, store.myEmail, store.teams || [], isManager), 'editor'),
    save: (p, data) => store.updateProject(p.id, data),
    nameOf: store.nameOf,
  };
}

/**
 * The chip. `fallback` is what to show while the project has no status
 * (the list's computed Not Started / In Progress / Completed); it becomes
 * the trigger when the person may edit, so a first status can be set.
 * `onSave(project, { status, statusNote })` saves; absent = read only.
 */
export function ProjectStatusChip({ project: p, nameOf, onSave = null, fallback = null, size = 'md' }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const health = projectHealth(p);
  const title = healthTitle(p, nameOf);
  const face = health
    ? <StatusLabel label={health.label} color={health.color} title={title} size={size} />
    : fallback;
  if (!onSave) return face;
  const openIt = (e) => {
    e.stopPropagation();
    setPick(health ? p.status : '');
    setWhy(p.statusNote || '');
    setOpen(true);
  };
  const save = async (e) => {
    e.stopPropagation();
    if (!pick) return;
    setBusy(true);
    try {
      await onSave(p, { status: pick, statusNote: why.trim() });
      setOpen(false);
    } catch { /* the store's own alert says why */ } finally {
      setBusy(false);
    }
  };
  return (
    <span ref={ref} style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={openIt} aria-haspopup="dialog" aria-expanded={open}
        aria-label={health ? `Project status: ${health.label}. Change it` : 'Set the project status'}
        title={title || 'Set the project status'}
        style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', fontFamily: FONT }}>
        {face}
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} role="dialog" aria-label="Project status"
        style={{ width: 260, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 8, fontFamily: FONT }}>
        <div role="radiogroup" aria-label="Status" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {PROJECT_HEALTH_ORDER.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={pick === k} onClick={() => setPick(k)} className="nx-menu-row"
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 7, border: 'none', cursor: 'pointer', background: pick === k ? NX.border2 : 'transparent', fontFamily: FONT }}>
              <StatusLabel label={PROJECT_HEALTH[k].label} color={PROJECT_HEALTH[k].color} size="sm" />
              {pick === k && <Check size={13} style={{ marginLeft: 'auto', color: NX.dim }} />}
            </button>
          ))}
        </div>
        <input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} placeholder="Why - one line"
          aria-label="Why" onKeyDown={(e) => { if (e.key === 'Enter') save(e); }}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: 8, fontSize: 12.5 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ ...btn('ghost'), padding: '5px 10px', fontSize: 12 }}>Cancel</button>
          <button type="button" onClick={save} disabled={!pick || busy} style={{ ...btn('primary'), padding: '5px 12px', fontSize: 12 }}>Save</button>
        </div>
      </AnchoredMenu>
    </span>
  );
}
