import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';

const EMPTY_LAYOUT = { folders: [], items: [], favorites: [] };

// Named, saveable External Links arrangements with a default star and an
// explicit Customize -> edit -> Save/Save as new/Done flow - mirrors
// useDashboards.js (frontend/src/dashboard/useDashboards.js) one screen
// over (Aug 14, "same option as we have in dashboard section... default
// view and add customize views... save it per our convenient name"), minus
// the department/scope/target machinery that module needed and this
// doesn't - every Link View is personal, and there's only one screen it
// applies to.
//
// activeId === null means Home - the synthesized, unarranged default order
// (pinned/sort_order/name for Company, sort_order/name for Personal).
// That's rendered entirely client-side by LinksLayoutSection (it already
// falls back to defaultOrderItems() when handed an empty layout); this
// hook never persists anything for Home, exactly like Dashboard's
// activeId === null never touches DashboardView at all.
//
// One shared `layout` document covers BOTH the Company My Layout tab and
// the Personal Links tab (folders/items are already scoped by item_type -
// see link_layouts.py) - one Customize/Save/Done cycle edits both at once,
// same as Dashboard's one Customize edits its one grid.
//
// Favorites are the one exception to the edit/save cycle: toggling a
// favorite auto-saves immediately via `toggleFavorite`, bypassing
// dirty/editing entirely - gating something as lightweight as a bookmark
// toggle behind Customize/Save would be pure friction, and it was already
// instant before this multi-view rework shipped.
export function useLinkViews() {
  const [views, setViews] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [layout, setLayoutState] = useState(EMPTY_LAYOUT);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const applyView = useCallback((view) => {
    setActiveId(view?.id ?? null);
    setLayoutState(view?.layout || EMPTY_LAYOUT);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listLinkViews().catch(() => ({ views: [] }));
      const vs = res.views || [];
      setViews(vs);
      applyView(vs.find(v => v.isDefault) || null);
    } finally {
      setLoading(false);
    }
  }, [applyView]);
  useEffect(() => { load(); }, [load]);

  const activeView = views.find(v => v.id === activeId) || null;

  const setLayout = useCallback((next) => { setLayoutState(next); setDirty(true); }, []);
  const mutate = useCallback((updater) => setLayout(updater(layoutRef.current)), [setLayout]);

  const switchView = (id) => {
    const v = id ? views.find(x => x.id === id) : null;
    applyView(v || null);
    setEditing(false);
  };

  // Save: update the active view in place; otherwise (editing from Home)
  // fork into a new personal view and make it the default, mirroring
  // useDashboards.js's save().
  const save = async () => {
    const cur = layoutRef.current;
    if (activeView) {
      const updated = await api.updateLinkView(activeId, { layout: cur });
      setViews(vs => vs.map(v => v.id === updated.id ? updated : v));
    } else {
      const created = await api.createLinkView({ name: 'My view', layout: cur, is_default: true });
      setViews(vs => [...vs, created]);
      setActiveId(created.id);
    }
    setDirty(false);
    setEditing(false);
  };

  const saveAsNew = async (name) => {
    const created = await api.createLinkView({ name: name || 'New view', layout: layoutRef.current });
    setViews(vs => [...vs, created]);
    setActiveId(created.id);
    setDirty(false);
    return created;
  };

  // Brand-new view starting BLANK (Home's synthesized default), vs.
  // saveAsNew which copies whatever is currently on screen.
  const createNewView = async (name) => {
    const created = await api.createLinkView({ name: name || 'New view', layout: EMPTY_LAYOUT });
    setViews(vs => [...vs, created]);
    applyView(created);
    setEditing(true);
    return created;
  };

  const setDefaultView = async (id) => {
    await api.setDefaultLinkView(id);
    setViews(vs => vs.map(v => ({ ...v, isDefault: v.id === id })));
  };

  // Back to Home as the landing view - un-default the view that currently
  // holds it, same escape hatch as useDashboards.js's clearDefaultView.
  const clearDefaultView = async () => {
    const cur = views.find(v => v.isDefault);
    if (!cur) return;
    await api.updateLinkView(cur.id, { is_default: false });
    setViews(vs => vs.map(v => ({ ...v, isDefault: false })));
  };

  const removeView = async (id) => {
    await api.deleteLinkView(id);
    setViews(vs => vs.filter(v => v.id !== id));
    if (activeId === id) applyView(null);
  };

  const renameView = async (id, name) => {
    const updated = await api.updateLinkView(id, { name });
    setViews(vs => vs.map(v => v.id === updated.id ? updated : v));
  };

  const clearSaveError = useCallback(() => setSaveError(null), []);

  // Applies + saves immediately, independent of the edit/save cycle above -
  // reads/writes straight through to the active view (or the server's
  // notion of "the default view", auto-creating one on the very first call
  // exactly like the old single-row model did) via the legacy bare
  // endpoints, optimistic with rollback on failure. Used for favoriting
  // (toggleFavorite below) and for organizing an already-open folder's
  // contents (Aug 14, "when we drag an application from folder it is not
  // responsive... we should have the option to drag the application from
  // folder also") - both are lightweight, expected-to-just-work actions
  // that shouldn't need a Customize/Save/Done detour the way rearranging
  // the main screen does.
  const mutateNow = useCallback((updater) => {
    const prev = layoutRef.current;
    const next = updater(prev);
    setLayoutState(next);
    return api.saveLinkLayout(next, activeId || undefined).then(() => {
      if (activeId) {
        setViews(vs => vs.map(v => v.id === activeId ? { ...v, layout: next } : v));
      } else if (!activeView) {
        // First-ever change with no active view - the server just silently
        // created "the" default row; reload once so the switcher picks it
        // up as a real view instead of staying blank.
        load();
      }
    }).catch(e => {
      setLayoutState(prev);
      setSaveError(e?.message || 'Could not save that change - reverted.');
      throw e;
    });
  }, [activeId, activeView, load]);

  const toggleFavorite = useCallback((itemType, itemId) => {
    mutateNow(prev => {
      const exists = prev.favorites.some(f => f.item_type === itemType && f.item_id === itemId);
      const favorites = exists
        ? prev.favorites.filter(f => !(f.item_type === itemType && f.item_id === itemId))
        : [...prev.favorites, { item_type: itemType, item_id: itemId }];
      return { ...prev, favorites };
    }).catch(() => {}); // saveError already surfaced via banner in ExternalLinks.jsx
  }, [mutateNow]);

  return {
    views, activeId, activeView, layout, loading, editing, dirty, saveError,
    setEditing, setLayout, mutate, mutateNow, switchView, save, saveAsNew, createNewView,
    setDefaultView, clearDefaultView, removeView, renameView, toggleFavorite, clearSaveError,
    reload: load,
  };
}
