import { useState } from 'react';
import { LayoutGrid, Plus, Save, Pencil, MoreHorizontal, Star, Share2, Trash2, Copy, Check, X } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useDashboards } from './useDashboards';
import { WIDGETS } from './widgets.jsx';
import DashboardGrid from './DashboardGrid';
import { WidgetGallery, ConfigModal } from './WidgetGallery';

export default function CustomDashboard({ target }) {
  const { can } = useRole();
  const { notifications } = useNotifications();
  const d = useDashboards(target);
  const [gallery, setGallery] = useState(false);
  const [configItem, setConfigItem] = useState(null);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = (t, ok = true) => { setToast({ t, ok }); setTimeout(() => setToast(null), 3000); };
  const wrap = (fn, okMsg) => async (...a) => { try { await fn(...a); if (okMsg) flash(okMsg); } catch (e) { flash(e?.message || 'Something went wrong', false); } };

  const renderWidget = (it) => {
    const def = WIDGETS[it.type];
    if (!def) return <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)' }}>Unknown widget</div>;
    return def.render({
      config: it.config || {}, kpis: d.kpis, notifications,
      updateConfig: (patch) => d.updateWidgetConfig(it.i, patch),
    });
  };

  const save = wrap(async () => { await d.save(); }, 'Layout saved');
  const saveAsNew = wrap(async () => { const name = window.prompt('Name this view:', 'New view'); if (name) await d.saveAsNew(name); }, 'View created');
  const publish = wrap(async () => { const name = window.prompt('Publish a department view named:', `${d.department || 'Department'} view`); if (name) await d.publishDepartment(name); }, 'Published to your department');
  const makeDefault = wrap(async () => { if (d.activeId) await d.setDefaultView(d.activeId); }, 'Set as your default');
  const rename = wrap(async () => { if (d.activeView && d.activeView.scope === 'personal') { const n = window.prompt('Rename view:', d.activeView.name); if (n) await d.renameView(d.activeId, n); } }, 'Renamed');
  const del = wrap(async () => { if (d.activeId && window.confirm('Delete this view?')) await d.removeView(d.activeId); }, 'View deleted');

  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter,sans-serif', cursor: 'pointer' };

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
          className="form-input" style={{ height: 34, fontSize: 13, fontWeight: 600, maxWidth: 260, paddingRight: 28 }}>
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
            <div style={{ position: 'relative' }}>
              <button className="secondary-btn" style={{ ...btn, padding: '6px 9px' }} onClick={() => setMenu(m => !m)}><MoreHorizontal size={15} /></button>
              {menu && (
                <div onMouseLeave={() => setMenu(false)} style={{ position: 'absolute', right: 0, top: 40, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 50, minWidth: 210 }}>
                  {[
                    { label: 'Save as new view', icon: Copy, on: saveAsNew },
                    ...(d.activeView?.scope === 'personal' ? [
                      { label: 'Set as my default', icon: Star, on: makeDefault },
                      { label: 'Rename view', icon: Pencil, on: rename },
                      { label: 'Delete view', icon: Trash2, on: del, danger: true },
                    ] : []),
                    ...(d.canPublish ? [{ label: 'Publish to department', icon: Share2, on: publish }] : []),
                  ].map((m, i) => (
                    <button key={i} onClick={() => { setMenu(false); m.on(); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', background: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, textAlign: 'left', fontFamily: 'Inter,sans-serif', color: m.danger ? 'hsl(var(--color-red))' : 'var(--ink)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      <m.icon size={14} /> {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <button className="secondary-btn" style={btn} onClick={() => d.setEditing(true)}><Pencil size={14} /> Customize</button>
        )}
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
        />
      )}

      {gallery && <WidgetGallery target={target} can={can} onAdd={d.addWidget} onClose={() => setGallery(false)} />}
      {configItem && <ConfigModal item={configItem} onSave={(cfg) => d.updateWidgetConfig(configItem.i, cfg)} onClose={() => setConfigItem(null)} />}
    </div>
  );
}
