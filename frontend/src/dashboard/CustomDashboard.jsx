import { useState, Suspense } from 'react';
import { LayoutGrid, Plus, Save, Pencil, MoreHorizontal, Star, Share2, Trash2, Copy, X } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useDashboards } from './useDashboards';
import { WIDGETS } from './widgets.jsx';
import DashboardGrid from './DashboardGrid';
import { WidgetGallery, ConfigModal } from './WidgetGallery';

// Small, reliable name dialog (replaces window.prompt, which wouldn't let the
// user type / was silently blocked). Auto-focuses; Enter submits, Esc cancels.
function NameModal({ title, label = 'View name', initial = '', cta = 'Save', onSubmit, onClose }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!v.trim() || busy) return;
    setBusy(true);
    try { await onSubmit(v.trim()); onClose(); } catch { setBusy(false); }
  };
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, flex: 1 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
        </div>
        <div style={{ padding: 18 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>{label}</label>
          <input autoFocus value={v} onChange={e => setV(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
            className="form-input" style={{ width: '100%' }} placeholder="e.g. Operations team" />
          <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="secondary-btn" onClick={onClose}>Cancel</button>
            <button className="primary-btn" onClick={submit} disabled={!v.trim() || busy}>{busy ? 'Saving…' : cta}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CustomDashboard({ target }) {
  const { can } = useRole();
  const { notifications, markRead, markAllRead, dismiss, clearRead } = useNotifications();
  const d = useDashboards(target);
  const [gallery, setGallery] = useState(false);
  const [configItem, setConfigItem] = useState(null);
  const [menu, setMenu] = useState(false);
  const [nameModal, setNameModal] = useState(null);
  const [toast, setToast] = useState(null);

  const flash = (t, ok = true) => { setToast({ t, ok }); setTimeout(() => setToast(null), 3000); };
  const wrap = (fn, okMsg) => async (...a) => { try { await fn(...a); if (okMsg) flash(okMsg); } catch (e) { flash(e?.message || 'Something went wrong', false); } };

  const isOwnPersonal  = d.activeView?.scope === 'personal';
  const canEditInPlace = isOwnPersonal || (d.activeView?.scope === 'department' && d.canPublish);
  const canRename      = isOwnPersonal || (d.activeView?.scope === 'department' && d.canPublish);

  // Render each widget as a real component (<Comp/>), never a direct function
  // call — widgets use hooks, and calling them inline would register those hooks
  // under this component, crashing when widgets are added/removed.
  // "Clear all": mark everything read, then delete the read ones — the two
  // functional state updates queue in order so this clears the whole list.
  const clearAllNotifs = () => { markAllRead(); clearRead(); };

  const renderWidget = (it) => {
    const def = WIDGETS[it.type];
    if (!def) return <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)' }}>Unknown widget</div>;
    // Role-gated widget in a layout the user inherited (e.g. a dept template):
    // show an inert card instead of the real panel — and never delete it from
    // their saved layout.
    if (def.minRole && !can(def.minRole)) {
      return (
        <div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: 16 }}>
          "{def.title}" needs {def.minRole} access
        </div>
      );
    }
    const Comp = def.render;
    return (
      <Suspense fallback={
        <div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 12.5 }}>
          Loading…
        </div>
      }>
        <Comp
          config={it.config || {}} kpis={d.kpis} notifications={notifications}
          markRead={markRead} markAllRead={markAllRead} dismiss={dismiss} clearAll={clearAllNotifs}
          updateConfig={(patch) => d.updateWidgetConfig(it.i, patch)}
        />
      </Suspense>
    );
  };

  const openName = (opts) => { setMenu(false); setNameModal(opts); };

  // Save: update your own view in place; otherwise ask for a name and create one.
  const save = () => {
    if (canEditInPlace) return wrap(() => d.save(), 'Layout saved')();
    openName({
      title: 'Save your dashboard', initial: 'My view', cta: 'Save view',
      onSubmit: wrap(async (name) => { const v = await d.saveAsNew(name); await d.setDefaultView(v.id); }, 'View saved'),
    });
  };
  const saveAsNew = () => openName({
    title: 'Save as a new view', initial: '', cta: 'Create view',
    onSubmit: wrap(name => d.saveAsNew(name), 'View created'),
  });
  const rename = () => openName({
    title: 'Rename view', initial: d.activeView?.name || '', cta: 'Rename',
    onSubmit: wrap(name => d.renameView(d.activeId, name), 'Renamed'),
  });
  const publish = () => openName({
    title: 'Publish to your department', label: 'Everyone in your department gets this view', initial: `${d.department || 'Department'} view`, cta: 'Publish',
    onSubmit: wrap(name => d.publishDepartment(name), 'Published to your department'),
  });
  const makeDefault = wrap(async () => { setMenu(false); if (d.activeId) await d.setDefaultView(d.activeId); }, 'Set as your default');
  const del = wrap(async () => { setMenu(false); if (d.activeId && window.confirm('Delete this view?')) await d.removeView(d.activeId); }, 'View deleted');

  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter,sans-serif', cursor: 'pointer' };

  const menuItems = [
    { label: 'Save as new view', icon: Copy, on: saveAsNew },
    ...(canRename ? [{ label: 'Rename view', icon: Pencil, on: rename }] : []),
    ...(isOwnPersonal ? [
      { label: 'Set as my default', icon: Star, on: makeDefault },
      { label: 'Delete view', icon: Trash2, on: del, danger: true },
    ] : []),
    ...(d.canPublish ? [{ label: 'Publish to department', icon: Share2, on: publish }] : []),
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {toast && (
        <div style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 12, fontSize: 12.5, fontWeight: 600,
          background: toast.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: toast.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{toast.t}</div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
          <LayoutGrid size={16} />
        </div>
        <select value={d.activeId || ''} onChange={e => d.switchView(e.target.value || null)}
          className="form-input" style={{ fontSize: 13, fontWeight: 600, maxWidth: 260, padding: '8px 28px 8px 12px', lineHeight: 1.4, height: 'auto' }}>
          <option value="">Default layout</option>
          {d.views.filter(v => v.scope === 'personal').length > 0 && (
            <optgroup label="My views">
              {d.views.filter(v => v.scope === 'personal').map(v => (
                <option key={v.id} value={v.id}>{v.name}{v.isDefault ? ' ★' : ''}</option>
              ))}
            </optgroup>
          )}
          {d.views.filter(v => v.scope === 'department').length > 0 && (
            <optgroup label="Department views">
              {d.views.filter(v => v.scope === 'department').map(v => (
                <option key={v.id} value={v.id}>{v.name} (dept)</option>
              ))}
            </optgroup>
          )}
        </select>

        <div style={{ flex: 1 }} />

        {d.editing ? (
          <>
            <button className="secondary-btn" style={btn} onClick={() => setGallery(true)}><Plus size={14} /> Add widget</button>
            <button className="primary-btn" style={{ ...btn, opacity: d.dirty ? 1 : 0.6 }} onClick={save} disabled={!d.dirty}><Save size={14} /> {d.dirty ? 'Save' : 'Saved'}</button>
            <button className="secondary-btn" style={btn} onClick={() => { d.setEditing(false); d.reload(); }}><X size={14} /> Done</button>
          </>
        ) : (
          <button className="secondary-btn" style={btn} onClick={() => d.setEditing(true)}><Pencil size={14} /> Customize</button>
        )}
        {/* View actions (rename, default, delete, publish) live outside edit mode
            too — renaming a view shouldn't require entering Customize. */}
        <div style={{ position: 'relative' }}>
          <button className="secondary-btn" style={{ ...btn, padding: '6px 9px' }} onClick={() => setMenu(m => !m)} title="View options"><MoreHorizontal size={15} /></button>
          {menu && (
            <div onMouseLeave={() => setMenu(false)} style={{ position: 'absolute', right: 0, top: 40, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 50, minWidth: 210 }}>
              {menuItems.map((m, i) => (
                <button key={i} onClick={m.on} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', background: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, textAlign: 'left', fontFamily: 'Inter,sans-serif', color: m.danger ? 'hsl(var(--color-red))' : 'var(--ink)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <m.icon size={14} /> {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {d.loading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading your dashboard…</div>
      ) : (
        <DashboardGrid
          layout={d.layout}
          editing={d.editing}
          onLayoutChange={d.setLayout}
          renderWidget={renderWidget}
          onRemove={d.removeWidget}
          onConfigure={(it) => WIDGETS[it.type]?.configurable ? setConfigItem(it) : null}
          limitsFor={(it) => WIDGETS[it.type]?.limits}
        />
      )}

      {gallery && <WidgetGallery target={target} can={can} onAdd={d.addWidget} onClose={() => setGallery(false)} />}
      {configItem && <ConfigModal item={configItem} onSave={(cfg) => d.updateWidgetConfig(configItem.i, cfg)} onClose={() => setConfigItem(null)} />}
      {nameModal && <NameModal {...nameModal} onClose={() => setNameModal(null)} />}
    </div>
  );
}
