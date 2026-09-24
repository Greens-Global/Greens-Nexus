import { useState } from 'react';
import { useDash } from './DashContext';

// Month-end close task views (Priyanka, Sep 24): My Tasks / All Tasks /
// Overdue, on the Close tab checklist AND on the Overview's Month-End Close
// card, sharing one preference. "Mine" means tasks whose owner is the role I
// picked ("Bookkeeper", "Controller"...) or my own name. With no role picked
// the dashboard view stands in: the Bookkeeper view shows Bookkeeper tasks,
// the Controller view Controller tasks, so a bookkeeper's dashboard opens on
// My Tasks without setup. Mirrors the accounting app's close-views.tsx.

export const TASK_VIEWS = [{ id: 'mine', label: 'My Tasks' }, { id: 'all', label: 'All Tasks' }, { id: 'overdue', label: 'Overdue' }];
const ROLE_LS = 'nexus-accounting-close-role';
const readPref = () => { try { return JSON.parse(localStorage.getItem(ROLE_LS) || '{}') || {}; } catch { return {}; } };
const writePref = (p) => { try { localStorage.setItem(ROLE_LS, JSON.stringify(p)); } catch { /* private mode */ } };

export const isMine = (r, role, me) => {
  const o = (r.owner || '').trim().toLowerCase();
  return !!o && (o === (role || '').trim().toLowerCase() || (!!me && o === me.trim().toLowerCase()));
};

/** The owner name a dashboard view implies when the person has not picked a role. */
export const roleFromView = (view, owners) => {
  const v = (view || '').trim().toLowerCase();
  return owners.find((o) => o.trim().toLowerCase() === v) || '';
};

export function useCloseViews(rows, meName = '') {
  const { view: dashView } = useDash();
  const [pref, setPref] = useState(() => { const s = readPref(); return { role: s.role || '', view: s.view || '' }; });
  const owners = [...new Set(rows.map((r) => (r.owner || '').trim()).filter(Boolean))].sort();
  const pickedRole = pref.role;
  const role = pickedRole || roleFromView(dashView, owners);
  // Default: My Tasks whenever a role is known (picked or implied by the view), else All.
  const view = pref.view || (role ? 'mine' : 'all');
  const save = (next) => { setPref(next); writePref(next); };
  const setView = (v) => save({ ...pref, view: v });
  const setRole = (r) => save({ role: r, view: r ? 'mine' : 'all' });
  const showRow = (r) => (view === 'all' ? true : view === 'overdue' ? r.state === 'past_due' : isMine(r, role, meName));
  return { view, setView, role, pickedRole, setRole, owners, showRow };
}

/** The three-way switch. `late` adds the overdue count to that label. */
export function TaskViewSwitch({ view, onChange, late, size = 'sm' }) {
  return (
    <span style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, padding: 2 }}>
      {TASK_VIEWS.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)} aria-pressed={view === t.id}
          style={{ border: 'none', borderRadius: 6, padding: size === 'xs' ? '1px 7px' : '2px 8px', font: 'inherit', fontSize: size === 'xs' ? '0.68rem' : '0.72rem', fontWeight: 600, cursor: 'pointer', background: view === t.id ? 'var(--wk-brand, #2b45e1)' : 'transparent', color: view === t.id ? '#fff' : 'var(--text-secondary)' }}>
          {t.label}{t.id === 'overdue' && late ? ` (${late})` : ''}
        </button>
      ))}
    </span>
  );
}
