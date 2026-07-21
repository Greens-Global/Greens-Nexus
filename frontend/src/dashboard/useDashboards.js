import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { WIDGETS, clampToLimits } from './widgets.jsx';

// Sensible starting layouts so a brand-new user never sees an empty screen.
const DEFAULTS = {
  dashboard: [
    { i: 'd1', type: 'clock',         x: 0, y: 0, w: 3, h: 3 },
    { i: 'd2', type: 'quick-actions', x: 3, y: 0, w: 3, h: 3 },
    { i: 'd3', type: 'kpi',           x: 6, y: 0, w: 3, h: 2, config: { metric: 'my_open_tasks' } },
    { i: 'd4', type: 'kpi',           x: 9, y: 0, w: 3, h: 2, config: { metric: 'my_checkouts' } },
    { i: 'd5', type: 'kpi',           x: 6, y: 2, w: 3, h: 2, config: { metric: 'my_assignments' } },
    { i: 'd6', type: 'kpi',           x: 9, y: 2, w: 3, h: 2, config: { metric: 'unread_notifications' } },
    { i: 'd7', type: 'notifications', x: 0, y: 3, w: 6, h: 5 },
    { i: 'd8', type: 'links',         x: 6, y: 4, w: 3, h: 4 },
    { i: 'd9', type: 'kpi-bar',       x: 9, y: 4, w: 3, h: 4 },
  ],
  'manager-dashboard': [
    { i: 'm1', type: 'team-attendance', x: 0, y: 0, w: 3, h: 2 },
    { i: 'm2', type: 'team-approvals',  x: 3, y: 0, w: 3, h: 2 },
    { i: 'm3', type: 'kpi',             x: 6, y: 0, w: 3, h: 2, config: { metric: 'pending_inventory' } },
    { i: 'm4', type: 'kpi',             x: 9, y: 0, w: 3, h: 2, config: { metric: 'time_off_pending' } },
    { i: 'm8', type: 'approvals',       x: 0, y: 2, w: 8, h: 5 },
    { i: 'm6', type: 'notifications',   x: 8, y: 2, w: 4, h: 5 },
    { i: 'm9', type: 'who-has-what',    x: 0, y: 7, w: 8, h: 5 },
    { i: 'm7', type: 'links',           x: 8, y: 7, w: 4, h: 5 },
  ],
};

const rid = () => `w${Math.random().toString(36).slice(2, 8)}`;

const COLS = 12;

const collides = (a, b) =>
  a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Place items one by one at the topmost-leftmost free spot — unlike a plain
// "slide up/left", an item can jump across columns into a hole.
function placeAll(order) {
  const placed = [];
  for (const it of order) {
    const w = Math.max(1, Math.min(it.w || 2, COLS));
    const h = Math.max(1, it.h || 2);
    let done = false;
    for (let y = 0; y < 500 && !done; y++) {
      for (let x = 0; x <= COLS - w && !done; x++) {
        const cand = { ...it, x, y, w, h };
        if (!placed.some(p => collides(cand, p))) { placed.push(cand); done = true; }
      }
    }
    if (!done) placed.push({ ...it, x: 0, w, h });   // unreachable backstop
  }
  return placed;
}

// Auto-fit: true bin-packing. Tries several orderings — reading order (keeps
// the user's arrangement), biggest-area-first and tallest-first (pack better
// when sizes vary) — and picks the one with the shortest board; ties go to the
// result that moved widgets the least. Deterministic, never overlaps.
export function compactLayout(items) {
  if (!items.length) return items;
  const reading = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const byArea  = [...items].sort((a, b) => (b.w * b.h - a.w * a.h) || (a.y - b.y) || (a.x - b.x));
  const byH     = [...items].sort((a, b) => (b.h - a.h) || (b.w - a.w) || (a.y - b.y) || (a.x - b.x));
  const score = (placed) => {
    const height = Math.max(...placed.map(p => p.y + p.h));
    const moved = placed.reduce((s, p) => {
      const o = items.find(i => i.i === p.i);
      return s + Math.abs(p.x - o.x) + Math.abs(p.y - o.y);
    }, 0);
    return height * 10000 + moved;   // height dominates; displacement tie-breaks
  };
  const best = [reading, byArea, byH].map(placeAll)
    .reduce((a, b) => (score(b) < score(a) ? b : a));
  return items.map(it => best.find(p => p.i === it.i) || it);
}

export function useDashboards(target) {
  const [views, setViews] = useState([]);
  const [activeId, setActiveId] = useState(null);   // null = built-in default
  const [layout, setLayoutState] = useState(DEFAULTS[target] || []);
  const [kpis, setKpis] = useState({});
  const [department, setDepartment] = useState('');
  const [canPublish, setCanPublish] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const applyView = useCallback((view) => {
    // clampToLimits normalizes layouts saved before per-widget size caps existed
    // (e.g. a KPI tile stretched over half the page).
    const items = (view && Array.isArray(view.layout) && view.layout.length)
      ? view.layout : (DEFAULTS[target] || []);
    setActiveId(view?.id ?? null);
    setLayoutState(items.map(clampToLimits));
    setDirty(false);
  }, [target]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [v, k] = await Promise.all([
        api.dashViews(target).catch(() => ({ views: [] })),
        api.dashKpis(target === 'manager-dashboard' ? 'team' : 'self').catch(() => ({ kpis: {} })),
      ]);
      setViews(v.views || []);
      setDepartment(v.department || '');
      setCanPublish(!!v.canPublish);
      setKpis(k.kpis || {});
      const def = (v.views || []).find(x => x.isDefault && x.scope === 'personal')
        || (v.views || []).find(x => x.scope === 'personal')
        || (v.views || []).find(x => x.scope === 'department');
      applyView(def || null);
    } finally {
      setLoading(false);
    }
  }, [target, applyView]);

  useEffect(() => { load(); }, [load]);

  const activeView = views.find(v => v.id === activeId) || null;
  const isOwnPersonal = activeView && activeView.scope === 'personal';

  const setLayout = (next) => { setLayoutState(next); setDirty(true); };

  const addWidget = (type, config) => {
    const def = WIDGETS[type]; if (!def) return;
    const maxY = layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    setLayout([...layout, { i: rid(), type, x: 0, y: maxY, w: def.size.w, h: def.size.h, ...(config ? { config } : {}) }]);
    setEditing(true);
  };
  const removeWidget = (i) => setLayout(layout.filter(w => w.i !== i));
  const autoFit = () => setLayout(compactLayout(layoutRef.current));
  const updateWidgetConfig = (i, patch) => setLayout(layout.map(w => w.i === i ? { ...w, config: { ...(w.config || {}), ...patch } } : w));

  const switchView = (id) => {
    const v = views.find(x => x.id === id);
    if (v) applyView(v);
    else { setActiveId(null); setLayoutState(DEFAULTS[target] || []); setDirty(false); }
    setEditing(false);
  };

  // Save: update your own personal view in place; otherwise fork into a new
  // personal view (you can't overwrite the built-in default or a dept template
  // unless you're editing the dept template as a manager).
  const save = async () => {
    const cur = layoutRef.current;
    if (isOwnPersonal) {
      const updated = await api.dashUpdateView(activeId, { layout: cur });
      setViews(vs => vs.map(v => v.id === updated.id ? updated : v));
    } else if (activeView && activeView.scope === 'department' && canPublish) {
      const updated = await api.dashUpdateView(activeId, { layout: cur });
      setViews(vs => vs.map(v => v.id === updated.id ? updated : v));
    } else {
      const created = await api.dashCreateView({ target, name: 'My view', layout: cur, is_default: true });
      setViews(vs => [...vs, created]);
      setActiveId(created.id);
    }
    setDirty(false);
    setEditing(false);
  };

  const saveAsNew = async (name) => {
    const created = await api.dashCreateView({ target, name: name || 'New view', layout: layoutRef.current });
    setViews(vs => [...vs, created]);
    setActiveId(created.id);
    setDirty(false);
    return created;
  };

  // Brand-new view starting from the built-in default layout (vs. saveAsNew,
  // which copies whatever is currently on screen).
  const createNewView = async (name) => {
    const created = await api.dashCreateView({ target, name: name || 'New view', layout: DEFAULTS[target] || [] });
    setViews(vs => [...vs, created]);
    applyView(created);
    setEditing(true);
    return created;
  };

  const publishDepartment = async (name) => {
    const created = await api.dashCreateView({ target, name: name || `${department || 'Department'} view`, layout: layoutRef.current, scope: 'department', department });
    setViews(vs => [...vs, created]);
    return created;
  };

  const setDefaultView = async (id) => {
    await api.dashSetDefault(id);
    setViews(vs => vs.map(v => ({ ...v, isDefault: v.id === id })));
  };

  const removeView = async (id) => {
    await api.dashDeleteView(id);
    setViews(vs => vs.filter(v => v.id !== id));
    if (activeId === id) { setActiveId(null); setLayoutState(DEFAULTS[target] || []); setDirty(false); }
  };

  const renameView = async (id, name) => {
    const updated = await api.dashUpdateView(id, { name });
    setViews(vs => vs.map(v => v.id === updated.id ? updated : v));
  };

  return {
    views, activeId, activeView, layout, kpis, department, canPublish, dirty, loading, editing,
    setEditing, setLayout, addWidget, removeWidget, autoFit, updateWidgetConfig,
    switchView, save, saveAsNew, createNewView, publishDepartment, setDefaultView, removeView, renameView, reload: load,
  };
}
