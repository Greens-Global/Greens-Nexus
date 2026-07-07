import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { WIDGETS } from './widgets.jsx';

// Sensible starting layouts so a brand-new user never sees an empty screen.
const DEFAULTS = {
  dashboard: [
    { i: 'd1', type: 'clock',         x: 0, y: 0, w: 3, h: 3 },
    { i: 'd2', type: 'quick-actions', x: 3, y: 0, w: 3, h: 3 },
    { i: 'd3', type: 'kpi',           x: 6, y: 0, w: 3, h: 2, config: { metric: 'my_open_tasks' } },
    { i: 'd4', type: 'kpi',           x: 9, y: 0, w: 3, h: 2, config: { metric: 'my_checkouts' } },
    { i: 'd5', type: 'kpi',           x: 6, y: 2, w: 3, h: 2, config: { metric: 'my_assignments' } },
    { i: 'd6', type: 'kpi',           x: 9, y: 2, w: 3, h: 2, config: { metric: 'unread_notifications' } },
    { i: 'd7', type: 'notifications', x: 0, y: 3, w: 6, h: 4 },
    { i: 'd8', type: 'links',         x: 6, y: 4, w: 3, h: 4 },
    { i: 'd9', type: 'kpi-bar',       x: 9, y: 4, w: 3, h: 4 },
  ],
  'manager-dashboard': [
    { i: 'm1', type: 'team-attendance', x: 0, y: 0, w: 3, h: 2 },
    { i: 'm2', type: 'team-approvals',  x: 3, y: 0, w: 3, h: 2 },
    { i: 'm3', type: 'kpi',             x: 6, y: 0, w: 3, h: 2, config: { metric: 'pending_inventory' } },
    { i: 'm4', type: 'kpi',             x: 9, y: 0, w: 3, h: 2, config: { metric: 'open_tasks' } },
    { i: 'm5', type: 'kpi-bar',         x: 0, y: 2, w: 4, h: 4 },
    { i: 'm6', type: 'notifications',   x: 4, y: 2, w: 4, h: 4 },
    { i: 'm7', type: 'links',           x: 8, y: 2, w: 4, h: 4 },
  ],
};

const rid = () => `w${Math.random().toString(36).slice(2, 8)}`;

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
    if (view && Array.isArray(view.layout) && view.layout.length) {
      setActiveId(view.id);
      setLayoutState(view.layout);
    } else {
      setActiveId(view?.id ?? null);
      setLayoutState(view?.layout?.length ? view.layout : (DEFAULTS[target] || []));
    }
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
    setEditing, setLayout, addWidget, removeWidget, updateWidgetConfig,
    switchView, save, saveAsNew, publishDepartment, setDefaultView, removeView, renameView, reload: load,
  };
}
