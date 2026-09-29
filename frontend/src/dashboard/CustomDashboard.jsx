import { useState, useRef, Suspense } from 'react';
import { SkeletonBlocks } from '../components/AsyncState';
import { LayoutGrid, Plus, Save, Pencil, MoreHorizontal, Star, Share2, Trash2, Copy, X, Wand2, SlidersHorizontal, Check } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useDashboards } from './useDashboards';
import { WIDGETS } from './widgets.jsx';
import DashboardGrid from './DashboardGrid';
import DeskHome, { DeskGreeting } from './DeskHome';
import { WidgetGallery, ConfigModal } from './WidgetGallery';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
import { useIsMobile } from '../lib/useIsMobile';
import AnchoredMenu from '../components/AnchoredMenu';

// Portrait phones, plus phones held sideways (touch screen, short viewport).
const PHONE_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 500px)';
const phoneBarBtn = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: 'none', background: 'transparent', fontSize: 14, fontWeight: 600, fontFamily: 'var(--wk-font)', cursor: 'pointer', padding: '0 8px', whiteSpace: 'nowrap' };
const phoneBarSep = { width: 1, background: 'var(--wk-line2)', alignSelf: 'stretch' };

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
  const dirty = v.trim() !== initial.trim();
  const guard = useUnsavedGuard(dirty, onClose, submit);
  return (
    <>
      <div onClick={e => { if (e.target === e.currentTarget) guard.requestClose(); }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
          <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{title}</h3>
            <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
          </div>
          <div style={{ padding: 18 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>{label}</label>
            <input autoFocus value={v} onChange={e => setV(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') guard.requestClose(); }}
              className="form-input" style={{ width: '100%' }} placeholder="e.g. Operations team" />
            <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={onClose}>Cancel</button>
              <button className="primary-btn" onClick={submit} disabled={!v.trim() || busy}>{busy ? 'Saving…' : cta}</button>
            </div>
          </div>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </>
  );
}

// Manager Dashboard folded into this one board (Sep 3) - see the useDashboards
// / widgets.jsx comments for the "why". `canSeeWidget` is the single access
// layer both the grid (an already-placed widget) and the Add Widget gallery
// read: someone's actual role level (can(minRole)) OR the 'manager-dashboard'
// Access Group grant, which is how a Supervisor's job role hands them manager-
// tier widgets today (see jobroles.py) without requiring the Manager role
// itself. A widget with no minRole is open to everyone.
export default function CustomDashboard() {
  const { can, myEmail, myGrantedModules } = useRole();
  const { notifications, markRead, markAllRead, dismiss, clearRead } = useNotifications();
  const canSeeWidget = (def) => !def.minRole || can(def.minRole) || myGrantedModules.has('manager-dashboard');
  // 'manager' | 'supervisor' | 'employee' - same access layer as canSeeWidget
  // above, just collapsed to one tier label. Drives which role-tiered widgets
  // seed a pristine board and whether team-wide KPIs get fetched (see
  // useDashboards.js) - the grant maps to 'manager' since it unlocks that
  // fuller tier too, same as canSeeWidget treats it.
  const widgetTier = (can('manager') || myGrantedModules.has('manager-dashboard')) ? 'manager'
    : can('supervisor') ? 'supervisor' : 'employee';
  const d = useDashboards(widgetTier);
  const [gallery, setGallery] = useState(false);
  const [configItem, setConfigItem] = useState(null);
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef(null);
  // View picker + Customize crowded/overlapped the session chip on a phone
  // (Pranshu, Sep 22: "fix the customize and view area for mobile") - the
  // fixed-width select plus a right-justified row wrapped into a jagged
  // staircase instead of a clean stack at narrow widths.
  const isMobile = useIsMobile();
  // A phone in EITHER orientation (Neil, Sep 28: Customize only worked held
  // sideways). Portrait trips the 640px breakpoint; landscape is a touch
  // screen too short for the desktop grid's drag + resize. Either way the
  // board stacks to one column with up/down arrows and the edit actions ride
  // a bottom bar instead of the header's scrolling toolbar, where Save and
  // Done were cut off past the screen edge.
  const isPhone = useIsMobile(PHONE_QUERY);
  const [nameModal, setNameModal] = useState(null);
  const [toast, setToast] = useState(null);

  const flash = (t, ok = true) => { setToast({ t, ok }); setTimeout(() => setToast(null), 3000); };
  const wrap = (fn, okMsg) => async (...a) => { try { await fn(...a); if (okMsg) flash(okMsg); } catch (e) { flash(e?.message || 'Something went wrong', false); } };

  const isOwnPersonal  = d.activeView?.scope === 'personal';
  const canEditInPlace = isOwnPersonal || (d.activeView?.scope === 'department' && d.canPublish);
  const canRename      = isOwnPersonal || (d.activeView?.scope === 'department' && d.canPublish);

  // Render each widget as a real component (<Comp/>), never a direct function
  // call - widgets use hooks, and calling them inline would register those hooks
  // under this component, crashing when widgets are added/removed.
  // "Clear all": mark everything read, then delete the read ones - the two
  // functional state updates queue in order so this clears the whole list.
  const clearAllNotifs = () => { markAllRead(); clearRead(); };

  const renderWidget = (it) => {
    const def = WIDGETS[it.type];
    if (!def) return <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)' }}>Unknown widget</div>;
    // Role-gated widget in a layout the user inherited (e.g. a dept template):
    // show an inert card instead of the real panel - and never delete it from
    // their saved layout.
    if (!canSeeWidget(def)) {
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
    title: 'Create a New View', label: 'Starts from the default layout - customize it after', initial: '', cta: 'Create View',
    onSubmit: wrap(name => d.createNewView(name), 'View created - customize away'),
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
  const confirmDiscard = () => !d.dirty || window.confirm('You have unsaved layout changes - discard them?');
  const guardedSwitch = (id) => { if (confirmDiscard()) d.switchView(id); };
  const guardedNew = () => { if (confirmDiscard()) createNew(); };
  const guardedDone = () => { if (confirmDiscard()) { d.setEditing(false); d.reload(); } };

  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--wk-font)', cursor: 'pointer' };
  const saveLabel = d.dirty ? 'Save' : 'Saved';

  // Delete: your own personal views always; a department view only if you're a
  // manager AND you're the one who published it - members can never delete a
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
      // Escape hatch: a saved default view otherwise hides the designed Home forever.
      ...(d.views.some(v => v.scope === 'personal' && v.isDefault)
        ? [{ label: 'Make Home My Default', icon: LayoutGrid, on: wrap(async () => { setMenu(false); await d.clearDefaultView(); guardedSwitch(null); }, 'Home is your landing view again') }] : []),
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
        <div role="status" style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 12, fontSize: 12.5, fontWeight: 600,
          background: toast.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: toast.ok ? 'hsl(var(--color-green))' : '#b91c1c',
          // Phone: float it just above the bottom bar - the top of a long
          // scrolled page is where nobody is looking after tapping Save.
          ...(isPhone ? { position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(80px + env(safe-area-inset-bottom))',
            margin: 0, zIndex: 395, whiteSpace: 'nowrap', background: 'var(--card)', border: '1px solid var(--wk-line2)', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' } : null) }}>{toast.t}</div>
      )}

      {/* Controls: view picker + Customize + the "…" view menu. Used to sit in
          their own title band ("Dashboard" / "Viewing X") above the greeting -
          repeating the tab-strip label as a big h2 plus a whole separate
          control row wasted vertical space for no new information (Neil,
          Sep 15). They now live in the greeting's header-right instead, so
          the page starts at "Good morning" and gets straight to the KPIs. */}
      {(() => {
        // Split so the "…" menu can sit tight against the session chip
        // (Pranshu, Sep 15) while the view picker/Customize keep their own
        // group with normal spacing.
        const controls = (
          // On a phone this is one item in the greeting's scrolling toolbar
          // row (.dk-toolbar, see DeskGreeting) rather than a full-width
          // stack of its own - the picker sizes to its name (Sep 23).
          <div className="dk-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: isMobile ? 'nowrap' : 'wrap', justifyContent: isMobile ? 'flex-start' : 'flex-end', flexShrink: 0 }}>
            <select value={d.activeId || ''}
              onChange={e => { const val = e.target.value; if (val === '__new__') guardedNew(); else guardedSwitch(val || null); }}
              className="form-input" title="Switch dashboard view"
              style={{ fontSize: 12.5, fontWeight: 600, width: isMobile ? 'auto' : 170, maxWidth: isMobile ? 176 : undefined, padding: '7px 30px 7px 11px', lineHeight: 1.4, height: 'auto', flexShrink: 0 }}>
              <option value="">Home</option>
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
              <option value="__new__">＋ New view…</option>
            </select>
            {d.editing ? (
              // On a phone these live in the bottom bar (below) instead.
              !isPhone && (
                <>
                  <button className="secondary-btn" style={btn} onClick={() => setGallery(true)}><Plus size={14} /> Add Widget</button>
                  <button className="secondary-btn" style={btn} onClick={d.autoFit} title="Slide widgets up and left to fill blank space"><Wand2 size={14} /> Auto-Fit</button>
                  <button className="primary-btn" style={{ ...btn, opacity: d.dirty ? 1 : 0.6 }} onClick={save} disabled={!d.dirty}><Save size={14} /> {saveLabel}</button>
                  <button className="secondary-btn" style={btn} onClick={guardedDone}><X size={14} /> Done</button>
                </>
              )
            ) : isPhone ? (
              // Icon only on a phone (Neil, Sep 28) - the word crowded the
              // toolbar row; the label stays for screen readers and long-press.
              <button className="secondary-btn" style={{ ...btn, padding: '7px 10px' }} onClick={() => d.setEditing(true)} title="Customize" aria-label="Customize"><SlidersHorizontal size={16} /></button>
            ) : (
              <button className="secondary-btn" style={btn} onClick={() => d.setEditing(true)}><SlidersHorizontal size={14} /> Customize</button>
            )}
          </div>
        );
        // The single home for view-level actions (rename, default, publish,
        // delete). Lives outside edit mode too - renaming a view shouldn't
        // require entering Customize - and stays available while editing so
        // you can fork the on-screen layout with "Save as new view". Kept
        // separate from `controls` so it renders after the session chip, as
        // its own distinct button at the row's right corner - not merged
        // with the chip (Pranshu, Sep 15 2nd follow-up).
        const viewMenu = (
          <>
            <button ref={menuBtn} className="secondary-btn" style={{ ...btn, padding: '6px 9px', flexShrink: 0 }} onClick={() => setMenu(m => !m)} title="View options" aria-label="View options" aria-haspopup="menu" aria-expanded={menu}><MoreHorizontal size={15} /></button>
            {/* Portaled: on a phone the toolbar is a horizontal scroller, which
                clipped the old in-place menu at its bottom edge. */}
            <AnchoredMenu anchorRef={menuBtn} open={menu} onClose={() => setMenu(false)} align="end" minWidth={220}
              style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, boxShadow: '0 18px 50px rgba(17,24,39,0.18)', padding: 6 }}>
              <div style={{ padding: '6px 10px 9px', borderBottom: '1px solid var(--line)', marginBottom: 5 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.activeView?.name || 'Default layout'}</div>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>{scopeCaption}</div>
              </div>
              {menuSections.map((section, si) => (
                <div key={si} style={si > 0 ? { borderTop: '1px solid var(--line)', marginTop: 5, paddingTop: 5 } : undefined}>
                  {section.map((m, i) => (
                    <button key={i} role="menuitem" onClick={() => { setMenu(false); m.on(); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', background: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, textAlign: 'left', fontFamily: 'var(--wk-font)', color: m.danger ? 'hsl(var(--color-red))' : 'var(--ink)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      <m.icon size={14} /> {m.label}
                    </button>
                  ))}
                </div>
              ))}
            </AnchoredMenu>
          </>
        );
        return d.loading ? (
          <div style={{ padding: '8px 0' }}><SkeletonBlocks count={4} height={90} /></div>
        ) : (!d.editing && !d.activeId) ? (
          /* The Operations Desk home - the designed default. Saved views and
             Customize keep the widget grid untouched below. The view
             picker/Customize/... controls live in the greeting's
             header-right now, not a separate title band above it. */
          <DeskHome kpis={d.kpis} notifications={notifications} markRead={markRead} headerRight={controls} headerMenu={viewMenu} />
        ) : (
          /* Saved views + Customize keep the page greeting - it belongs to the
             Dashboard, not to a layout, so picking a custom view (or saving one
             as default) can never make "Good morning" disappear. */
          <>
            <div style={{ margin: '2px 0 18px' }}><DeskGreeting right={controls} menu={viewMenu} /></div>
            {d.editing && isPhone && (
              <p style={{ margin: '0 2px 18px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                Use the arrows to reorder, the gear to change what a widget shows. The new order carries over to desktop.
              </p>
            )}
            <DashboardGrid
              layout={d.layout}
              editing={d.editing}
              onLayoutChange={d.setLayout}
              renderWidget={renderWidget}
              onRemove={d.removeWidget}
              onConfigure={(it) => WIDGETS[it.type]?.configurable ? setConfigItem(it) : null}
              canConfigure={(it) => !!WIDGETS[it.type]?.configurable}
              limitsFor={(it) => WIDGETS[it.type]?.limits}
              stacked={isPhone}
              onMove={d.moveWidget}
            />
            {/* Room for the bottom bar, so it never covers the last widget. */}
            {d.editing && isPhone && <div aria-hidden style={{ height: 'calc(92px + env(safe-area-inset-bottom))' }} />}
          </>
        );
      })()}

      {/* Phone edit bar: always on screen, in thumb reach, never clipped -
          the same floating-pill idiom as the Tasks/Tickets phone bar. */}
      {d.editing && isPhone && !d.loading && (
        <div role="toolbar" aria-label="Customize dashboard" style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(16px + env(safe-area-inset-bottom))',
          width: 'min(calc(100vw - 32px), 420px)', height: 54, display: 'flex', alignItems: 'stretch', zIndex: 390,  // under .mobile-menu (400) and modals (500)
          background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.22)', overflow: 'hidden',
          fontFamily: 'var(--wk-font)',
        }}>
          <button onClick={() => setGallery(true)} style={{ ...phoneBarBtn, flex: 1.25, color: 'var(--ink)' }}><Plus size={18} /> Add Widget</button>
          <span style={phoneBarSep} />
          <button onClick={save} disabled={!d.dirty} style={{ ...phoneBarBtn, color: d.dirty ? 'hsl(var(--color-blue))' : 'var(--muted)', cursor: d.dirty ? 'pointer' : 'default' }}><Save size={17} /> {saveLabel}</button>
          <span style={phoneBarSep} />
          <button onClick={guardedDone} style={{ ...phoneBarBtn, background: 'var(--wk-brand, hsl(var(--color-blue)))', color: '#fff' }}><Check size={18} /> Done</button>
        </div>
      )}

      {gallery && <WidgetGallery canSee={canSeeWidget} layout={d.layout} onAdd={d.addWidget} onClose={() => setGallery(false)} />}
      {configItem && <ConfigModal item={configItem} onSave={(cfg) => d.updateWidgetConfig(configItem.i, cfg)} onClose={() => setConfigItem(null)} />}
      {nameModal && <NameModal {...nameModal} onClose={() => setNameModal(null)} />}
    </div>
  );
}
