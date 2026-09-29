import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

// Workforce Analytics team views (Neil, Sep 29: "not every manager cares to
// see every employee"). A view is the viewer's own saved, named team - picked
// by company / department / location / reporting line / shift group and/or by
// name - and every Workforce Analytics tab (Coverage, Activity, Locations,
// Screenshots) shows only that team while it is active.
//
// The server resolves members inside the viewer's existing scope
// (routers/workforce_views.py), so a view only ever narrows what they can
// already see. Here it is just a filter: `inView(email)`.

const ALL = { active: null, inView: () => true, count: null };
const ViewCtx = createContext(ALL);
export const WorkforceViewProvider = ViewCtx.Provider;
/** { active, inView(email), count } - `inView` is always true with no view. */
export const useWorkforceView = () => useContext(ViewCtx);

const LS_KEY = 'nexus:workforceView';
const lsGet = () => { try { return localStorage.getItem(LS_KEY); } catch { return null; } };
// '' is a real choice (Everyone) and must be kept - removing the key would
// bring the default view back on the next visit.
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, v || ''); } catch { /* private mode */ } };

// '' = Everyone (explicitly chosen), null = never chosen on this browser -> the default view.
export function useWorkforceViews() {
  const [views, setViews] = useState(null);      // null loading, [] none
  const [failed, setFailed] = useState(false);
  const [activeId, setActiveIdState] = useState(lsGet);
  const load = useCallback(() => api.workforceViews()
    .then(r => { setViews(r?.views || []); setFailed(false); })
    .catch(() => { setViews([]); setFailed(true); }), []);
  useEffect(() => { load(); }, [load]);

  const setActiveId = useCallback((id) => { setActiveIdState(id || ''); lsSet(id || ''); }, []);
  const list = views || [];
  // A remembered view that was deleted elsewhere falls back to the default.
  const chosen = activeId === '' ? null : list.find(v => v.id === activeId);
  const active = chosen || (activeId === '' ? null : list.find(v => v.isDefault) || null);

  const ctx = useMemo(() => {
    if (!active) return ALL;
    const set = new Set((active.emails || []).map(e => e.toLowerCase()));
    return { active, inView: (email) => set.has((email || '').toLowerCase()), count: set.size };
  }, [active]);

  return { views, failed, active, ctx, setActiveId, reload: load };
}
