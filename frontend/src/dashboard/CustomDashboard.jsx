import { useState, Suspense } from 'react';
import { LayoutGrid, Plus, Save, Pencil, MoreHorizontal, Star, Share2, Trash2, Copy, X, Wand2, SlidersHorizontal } from 'lucide-react';
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
  const { can, myEmail } = useRole();
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
      title: 'Save Your Dashboard', initial: 'My view', cta: 'Save View',
      onSubmit: wrap(async (name) => { const v = await d.saveAsNew(name); await d.setDefaultView(v.id); }, 'View saved'),
    });
  };
  const saveAsNew = () => openName({
    title: 'Save as a New View', initial: '', cta: 'Create View',
    onSubmit: wrap(name => d.saveAsNew(name), 'View created'),
  });
  const rename = () => openName({
    title: 'Rename View', initial: d.activeView?.name || '', cta: 'Rename',
    onSubmit: wrap(name => d.renameView(d.activeId, name), 'Renamed'),
  });
  const createNew = () => openName({
    title: 'Create a New View', label: 'Starts from the default layout — customize it after', initial: '', cta: 'Create View',
    onSubmit: wrap(name => d.createNewView(name), 'View created — customize away'),
  });
  const publish = () => openName({
    title: 'Publish to Your Department', label: 'Everyone in your department gets this view', initial: `${d.department || 'Department'} view`, cta: 'Publish',
    onSubmit: wrap(name => d.publishDepartment(name), 'Published to your department'),
  });
  const makeDefault = wrap(async () => { setMenu(false); if (d.activeId) await d.setDefaultView(d.activeId); }, 'Set as your default');
  const del = wrap(async () => {
    setMenu(false);
    if (!d.activeId) return;
    const msg = d.activeView?.scope === 'department'
      ? `Delete "${d.activeView?.name}" for everyone in ${d.activeView?.department || 'the department'}?`
      : `Delete "${d.activeView?.name}"?`;
    if (window.confirm(msg)) await d.removeView(d.activeId);
  }, 'View deleted');

  // Guard against silently losing unsaved layout changes.
  const confirmDiscard = () => !d.dirty || window.confirm('You have unsaved layout changes — discard them?');
  const guardedSwitch = (id) => { if (confirmDiscard()) d.switchView(id); };
  const guardedNew = () => { if (confirmDiscard()) createNew(); };
  const guardedDone = () => { if (confirmDiscard()) { d.setEditing(false); d.reload(); } };

  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter,sans-serif', cursor: 'pointer' };

  // Delete: your own personal views always; a department view only if you're a
  // manager AND you're the one who published it — members can never delete a
  // view that was pushed to them.
  const canDelete = isOwnPersonal ||
    (d.activeView?.scope === 'department' && d.canPublish &&
     (d.activeView?.createdBy || '').toLowerCase() === (myEmail || '').toLowerCase());

  // The "…" menu is the ONLY home for view-level actions (no duplicate toolbar
  // buttons). Sections: manage this view / make a copy of this layout / delete.
  const menuSections = [
    [
      ...(canRename ? [{ label: 'Rename View', icon: Pencil, on: rename }] : []),
      ...(isOwnPersonal ? [{ label: 'Set as My Default', icon: Star, on: makeDefault }] : []),
    ],
    [
      { label: 'Save as New View', icon: Copy, on: saveAsNew },
      ...(d.canPublish ? [{ label: 'Publish to Department', icon: Share2, on: publish }] : []),
    ],
    [
      ...(canDelete ? [{ label: 'Delete View', icon: Trash2, on: del, danger: true }] : []),
    ],
  ].filter(s => s.length > 0);

  // Menu header caption: what the actions below apply to.
  const scopeCaption = !d.activeView
    ? 'Built-in layout'
    : d.activeView.scope === 'department'
      ? `${d.activeView.department || 'Department'} · shared view`
      : `Personal view${d.activeView.isDefault ? ' · default' : ''}`;

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
        <select value={d.activeId || ''}
          onChange={e => { const val = e.target.value; if (val === '__new__') guardedNew(); else guardedSwitch(val || null); }}
          className="form-input" style={{ fontSize: 13, fontWeight: 600, maxWidth: 260, padding: '8px 28px 8px 12px', lineHeight: 1.4, height: 'auto' }}>
          <option value="">Default Layout</option>
          {d.views.filter(v => v.scope === 'personal').length > 0 && (
            <optgroup label="My Views">
              {d.views.filter(v => v.scope === 'personal').map(v => (
                <option key={v.id} value={v.id}>{v.name}{v.isDefault ? ' ★' : ''}</option>
              ))}
            </optgroup>
          )}
          {d.views.filter(v => v.scope === 'department').length > 0 && (
            <optgroup label="Department Views">
              {d.views.filter(v => v.scope === 'department').map(v => (
                <option key={v.id} value={v.id}>{v.name} (dept)</option>
              ))}
            </optgroup>
          )}
          <option value="__new__">＋ New View…</option>
        </select>
        <div style={{ flex: 1 }} />

        {d.editing ? (
          <>
            <button className="secondary-btn" style={btn} onClick={() => setGallery(true)}><Plus size={14} /> Add Widget</button>
            <button className="secondary-btn" style={btn} onClick={d.autoFit} title="Slide widgets up and left to fill blank space"><Wand2 size={14} /> Auto-fit</button>
            <button className="primary-btn" style={{ ...btn, opacity: d.dirty ? 1 : 0.6 }} onClick={save} disabled={!d.dirty}><Save size={14} /> {d.dirty ? 'Save' : 'Saved'}</button>
            <button className="secondary-btn" style={btn} onClick={guardedDone}><X size={14} /> Done</button>
          </>
        ) : (
          <button className="secondary-btn" style={btn} onClick={() => d.setEditing(true)}><SlidersHorizontal size={14} /> Customize</button>
        )}
        {/* The single home for view-level actions (rename, default, publish,
            delete). Lives outside edit mode too — renaming a view shouldn't
            require entering Customize — and stays available while editing so
            you can fork the on-screen layout with "Save as New View". */}
        <div style={{ position: 'relative' }}>
          <button className="secondary-btn" style={{ ...btn, padding: '6px 9px' }} onClick={() => setMenu(m => !m)} title="View options"><MoreHorizontal size={15} /></button>
          {menu && (
            <div onMouseLeave={() => setMenu(false)} style={{ position: 'absolute', right: 0, top: 40, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 50, minWidth: 220 }}>
              <div style={{ padding: '6px 10px 9px', borderBottom: '1px solid var(--line)', marginBottom: 5 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.activeView?.name || 'Default Layout'}</div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 2 }}>{scopeCaption}</div>
              </div>
              {menuSections.map((section, si) => (
                <div key={si} style={si > 0 ? { borderTop: '1px solid var(--line)', marginTop: 5, paddingTop: 5 } : undefined}>
                  {section.map((m, i) => (
                    <button key={i} onClick={m.on} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', background: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, textAlign: 'left', fontFamily: 'Inter,sans-serif', color: m.danger ? 'hsl(var(--color-red))' : 'var(--ink)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      <m.icon size={14} /> {m.label}
                    </button>
                  ))}
                </div>
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
