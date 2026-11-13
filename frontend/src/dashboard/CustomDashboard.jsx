import { useState, useRef, Suspense } from 'react';
import { SkeletonBlocks } from '../components/AsyncState';
import { LayoutGrid, Plus, Save, Pencil, Star, Share2, Trash2, Copy, X, Wand2, SlidersHorizontal, Check, ChevronDown } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useDashboards, resolveCollisions } from './useDashboards';
import WidgetBoundary from '../components/WidgetBoundary';
import { WidgetCrashCard, WidgetSkeleton } from './listParts.jsx';
import { WIDGETS, widgetAllowed, widgetHidden, limitsOf } from './widgets.jsx';
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
        <div className="nx-popup" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
          <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{title}</h3>
            <button onClick={guard.requestClose} aria-label="Close" title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, margin: '-8px -10px -8px 0', borderRadius: 8 }}><X size={18} /></button>
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

// One row of the Customize menu: an action (its icon) or a view to switch to
// (a radio row, ticked when it is the one on screen).
function CzRow({ icon: Icon, label, hint, on, checked, danger, radio }) {
  return (
    <button type="button" role={radio ? 'menuitemradio' : 'menuitem'} aria-checked={radio ? !!checked : undefined}
      className={`dk-cz-row${danger ? ' is-danger' : ''}${checked ? ' is-on' : ''}`} onClick={on}>
      <span className="dk-cz-ico" aria-hidden="true">{radio ? (checked ? <Check size={14} /> : null) : <Icon size={14} />}</span>
      <span className="dk-cz-words"><span className="dk-cz-label">{label}</span>{hint && <span className="dk-cz-hint">{hint}</span>}</span>
    </button>
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
  const { can, myEmail, myGrantedModules, canAccessModule, timeTrackingExempt } = useRole();
  const { notifications, markRead, markAllRead, dismiss, clearRead } = useNotifications();
  // Module-gated tiles (Find a Transaction needs the Accounting grant) go
  // through the same helper - see widgetAllowed in widgets.jsx.
  const canSeeWidget = (def) => widgetAllowed(def, { can, myGrantedModules, canAccessModule });
  // Not for this person at all (a punch tile for a salaried person): out of
  // the grid and the gallery, but never out of the saved layout - a shared
  // view still carries it for the people it is for. Distinct from
  // canSeeWidget, which renders an inert "needs access" card instead.
  // Takes the placed item, not just the type: an Action Tile is only a punch
  // tile by its config, so the config decides (widgetHidden's third argument).
  const isHiddenItem = (it) => widgetHidden(WIDGETS[it.type], { timeTrackingExempt }, it.config);
  const offerWidget = (def) => canSeeWidget(def) && !widgetHidden(def, { timeTrackingExempt });
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

  // The grid shows the layout minus the tiles that are not for this person;
  // the hidden ones ride along unchanged on every layout change and save.
  const hiddenItems = d.layout.filter(isHiddenItem);
  const shownLayout = hiddenItems.length ? d.layout.filter(it => !isHiddenItem(it)) : d.layout;

  const isOwnPersonal  = d.activeView?.scope === 'personal';
  const canEditInPlace = isOwnPersonal || (d.activeView?.scope === 'department' && d.canPublish);
  const canRename      = isOwnPersonal || (d.activeView?.scope === 'department' && d.canPublish);

  // Render each widget as a real component (<Comp/>), never a direct function
  // call - widgets use hooks, and calling them inline would register those hooks
  // under this component, crashing when widgets are added/removed.
  // "Clear all": mark everything read, then delete the read ones - the two
  // functional state updates queue in order so this clears the whole list.
  const clearAllNotifs = () => { markAllRead(); clearRead(); };

  const renderWidget = (it, { phone = false } = {}) => {
    const def = WIDGETS[it.type];
    if (!def) return <div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: 16 }}>This widget is no longer available.</div>;
    // Role-gated widget in a layout the user inherited (e.g. a dept template):
    // show an inert card instead of the real panel - and never delete it from
    // their saved layout.
    if (!canSeeWidget(def)) {
      return (
        <div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: 16 }}>
          "{def.title}" needs {def.module ? (def.moduleLabel || def.module) : def.minRole} access
        </div>
      );
    }
    const Comp = def.render;
    // Each tile has its own boundary (Oct 14): a render crash - or a lazy
    // chunk that 404s right after a deploy - used to reach the view's
    // boundary and turn the whole dashboard into one error card.
    return (
      <WidgetBoundary name={`dashboard:${it.type}`} resetKey={`${it.i}:${it.type}`} fallback={<WidgetCrashCard title={def.title} />}>
        <Suspense fallback={<div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}><WidgetSkeleton rows={2} /></div>}>
          <Comp
            config={it.config || {}} size={{ w: it.w, h: it.h }} phone={phone} kpis={d.kpis} notifications={notifications}
            markRead={markRead} markAllRead={markAllRead} dismiss={dismiss} clearAll={clearAllNotifs}
            // Outside Customize a widget's own change (the Weather tile's city)
            // saves straight to the view - there is no Save button there.
            updateConfig={(patch) => (d.editing ? d.updateWidgetConfig(it.i, patch) : d.saveWidgetConfig(it.i, patch))}
            saveConfig={(patch) => d.saveWidgetConfig(it.i, patch)} canSaveConfig={d.canSaveInPlace}
          />
        </Suspense>
      </WidgetBoundary>
    );
  };

  const openName = (opts) => { setMenu(false); setNameModal(opts); };

  // Save: update your own view in place; otherwise ask for a name and create one.
  const save = () => {
    if (canEditInPlace) return wrap(() => d.save(), 'Layout saved')();
    openName({
      title: 'Save Your Dashboard', initial: 'My View', cta: 'Save View',
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
  const guardedDone = () => { if (confirmDiscard()) d.cancelEdit(); };

  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, fontFamily: 'var(--wk-font)', cursor: 'pointer' };
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

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {toast && (
        <div role="status" style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 600,
          background: toast.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: toast.ok ? 'hsl(var(--color-green))' : '#b91c1c',
          // Phone: float it just above the bottom bar - the top of a long
          // scrolled page is where nobody is looking after tapping Save.
          ...(isPhone ? { position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(80px + env(safe-area-inset-bottom))',
            margin: 0, zIndex: 395, whiteSpace: 'nowrap', background: 'var(--card)', border: '1px solid var(--wk-line2)', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' } : null) }}>{toast.t}</div>
      )}

      {/* Controls: ONE Customize in the greeting's header-right (Neil,
          11/13/2026: "simplify the Dashboard icons at the top right into
          just Customize"). The view picker and the "..." view menu that sat
          beside it are rows of its menu now; editing shows the edit toolbar
          (Add Widget, Auto-Fit, Save, Done) in its place. */}
      {(() => {
        const controls = (
          // On a phone this is one item in the greeting's scrolling toolbar
          // row (.dk-toolbar, see DeskGreeting) rather than a full-width
          // stack of its own - the picker sizes to its name (Sep 23).
          <div className="dk-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: isMobile ? 'nowrap' : 'wrap', justifyContent: isMobile ? 'flex-start' : 'flex-end', flexShrink: 0 }}>
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
            ) : (
              // ONE Customize (Neil, 11/13/2026: "merge the functionality of
              // the '...' button and My View into Customize"): it opens the
              // menu below - Edit Layout, the views to switch between, and
              // what can be done to the view on screen.
              <button ref={menuBtn} type="button" className="secondary-btn dk-customize" style={btn}
                onClick={() => setMenu(m => !m)} aria-haspopup="menu" aria-expanded={menu} title="Customize your dashboard">
                <SlidersHorizontal size={14} /> Customize<ChevronDown size={14} className="dk-customize-caret" aria-hidden="true" />
              </button>
            )}
          </div>
        );
        // The Customize menu: Edit Layout, then the views (Home, yours,
        // your department's, New View...), then what can be done to the view
        // on screen (rename, default, save as new, publish, delete). While
        // editing, the edit toolbar stands in its place.
        const personalViews = d.views.filter(v => v.scope === 'personal');
        const deptViews = d.views.filter(v => v.scope === 'department');
        const pickView = (id) => { setMenu(false); guardedSwitch(id); };
        const viewMenu = (
          // Portaled: on a phone the toolbar is a horizontal scroller, which
          // clipped an in-place menu at its bottom edge.
          <AnchoredMenu anchorRef={menuBtn} open={menu && !d.editing} onClose={() => setMenu(false)} align="end" minWidth={264}
            className="dk-cz-menu" aria-label="Customize">
            <CzRow icon={LayoutGrid} label="Edit Layout" hint="Add, move and resize widgets" on={() => { setMenu(false); d.setEditing(true); }} />
            <div className="dk-cz-sep" role="separator" />
            <div className="dk-cz-head" aria-hidden="true">Views</div>
            <CzRow radio checked={!d.activeId} label="Home" hint="The standard dashboard" on={() => pickView(null)} />
            {personalViews.map(v => (
              <CzRow key={v.id} radio checked={d.activeId === v.id} label={v.name} hint={v.isDefault ? 'Your default' : ''} on={() => pickView(v.id)} />
            ))}
            {deptViews.map(v => (
              <CzRow key={v.id} radio checked={d.activeId === v.id} label={v.name} hint={`${v.department || 'Department'} - shared view`} on={() => pickView(v.id)} />
            ))}
            <CzRow icon={Plus} label="New View..." on={() => { setMenu(false); guardedNew(); }} />
            {menuSections.map((section, si) => (
              <div key={si} role="none">
                <div className="dk-cz-sep" role="separator" />
                {si === 0 && d.activeView && <div className="dk-cz-head" aria-hidden="true">{d.activeView.name}</div>}
                {section.map((m) => <CzRow key={m.label} icon={m.icon} label={m.label} danger={m.danger} on={() => { setMenu(false); m.on(); }} />)}
              </div>
            ))}
          </AnchoredMenu>
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
              <p style={{ margin: '0 2px 18px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>
                Use the arrows to reorder, the gear to change what a widget shows. The new order carries over to desktop.
              </p>
            )}
            <DashboardGrid
              layout={shownLayout}
              editing={d.editing}
              onLayoutChange={(next) => d.setLayout(hiddenItems.length ? resolveCollisions([...next, ...hiddenItems], next.map(w => w.i)) : next)}
              resolveLayout={(next, movedId) => resolveCollisions(next, [movedId])}
              renderWidget={renderWidget}
              onRemove={d.removeWidget}
              onDuplicate={d.duplicateWidget}
              onConfigure={(it) => WIDGETS[it.type]?.configurable ? setConfigItem(it) : null}
              canConfigure={(it) => !!WIDGETS[it.type]?.configurable}
              limitsFor={(it) => limitsOf(it.type, it.config)}
              compactFor={(it) => !!WIDGETS[it.type]?.compact}
              rowsFor={(it) => WIDGETS[it.type]?.phoneRowsWhen?.(it.config)}
              fitFor={(it) => !!WIDGETS[it.type]?.fit}
              stacked={isPhone}
              onMove={(i, dir) => d.moveWidget(i, dir, hiddenItems)}
              emptyState={(
                // An empty board used to be a bare dotted canvas with nothing
                // saying what to do next.
                <div style={{ textAlign: 'center', maxWidth: 360, fontFamily: 'var(--wk-font)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--mist)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', marginBottom: 12 }}><LayoutGrid size={20} /></div>
                  <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>This view is empty</h3>
                  <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>Add a widget to start building it - a punch tile, your open tasks, a shortcut, anything from the gallery.</p>
                  {d.editing
                    ? <button className="primary-btn" style={btn} onClick={() => setGallery(true)}><Plus size={14} /> Add Widget</button>
                    : <button className="secondary-btn" style={btn} onClick={() => d.setEditing(true)}><SlidersHorizontal size={14} /> Customize</button>}
                </div>
              )}
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

      {gallery && <WidgetGallery canSee={offerWidget} layout={d.layout} onAdd={d.addWidget} onClose={() => setGallery(false)} />}
      {configItem && <ConfigModal item={configItem} onSave={(cfg) => d.updateWidgetConfig(configItem.i, cfg)} onClose={() => setConfigItem(null)} />}
      {nameModal && <NameModal {...nameModal} onClose={() => setNameModal(null)} />}
    </div>
  );
}
