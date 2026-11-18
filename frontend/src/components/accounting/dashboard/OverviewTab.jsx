import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, GripVertical, Info, LayoutGrid, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { SkeletonBlocks } from '../../AsyncState';
import AnchoredMenu from '../../AnchoredMenu';
import { Chip, EmptyBox, card, input } from './Bits';
import { useDash } from './DashContext';
import { Toolbar } from './Filters';
import { useAttention, useEmptyWidgets, useViews } from './hooks';
import { dashDensityOf, useAccountingPrefs } from '../prefs';
import { CustomizeButton } from '../reportControls';
import { dialog } from '../../../ui/dialog';
import { SIZE_LABEL, SIZES, WIDGET_CATS, WIDGET_LIST, WIDGETS, WidgetPanel, useDashNav } from './registry';
import { HOLD_MAJOR_MS } from '../../../ui/HoldButton';

// Overview tab: the attention bar and a customizable widget grid with shared
// role views (Principal, CFO, Controller, Bookkeeper) plus custom views.
// Views are shared across the company; the last view you opened is
// remembered on this device.

const DEFAULT_IDS = ['principal', 'cfo', 'controller', 'bookkeeper'];
const W = (pairs) => pairs.map(([type, size]) => ({ type, size }));
const DEFAULT_WIDGETS = {
  principal: W([['kpiCash', 'xs'], ['kpiNI', 'xs'], ['kpiYtd', 'xs'], ['kpiInvest', 'xs'], ['income', 'lg'], ['expenses', 'lg'], ['cashTrend', 'md'], ['noiProp', 'md'], ['valuation', 'md'], ['partners', 'md']]),
  cfo: W([['kpiCash', 'xs'], ['kpiRunway', 'xs'], ['kpiYtd', 'xs'], ['kpiMargin', 'xs'], ['cashForecast', 'lg'], ['ytdVariance', 'md'], ['maturity', 'md'], ['valuation', 'md'], ['partners', 'md'], ['deadlines', 'md']]),
  controller: W([['kpiCash', 'sm'], ['kpiRecon', 'sm'], ['kpiNI', 'sm'], ['recon', 'lg'], ['close', 'md'], ['ic', 'sm'], ['deadlines', 'sm'], ['flux', 'md'], ['entityCash', 'md'], ['activity', 'md']]),
  bookkeeper: W([['kpiCash', 'sm'], ['kpiRecon', 'sm'], ['kpiNI', 'sm'], ['recon', 'lg'], ['uncat', 'md'], ['close', 'md']]),
};
// Oct 7 (Priyanka: no Bookkeeper in the picker): the four role views always
// appear. One missing from the shared table (deleted, or never seeded) is
// listed anyway with its default layout and written back the first time it
// is opened. Role views reset; only custom views delete.
const ROLE_META = {
  principal: { name: 'Principal', role: 'Principal' },
  cfo: { name: 'CFO', role: 'CFO' },
  controller: { name: 'Controller', role: 'Controller' },
  bookkeeper: { name: 'Bookkeeper', role: 'Bookkeeper' },
};
/** The shared views with every role view present, role views first in their fixed order. */
function withRoleViews(saved) {
  const byId = new Map(saved.map((v) => [v.id, v]));
  const roles = DEFAULT_IDS.map((id, i) => byId.get(id) ?? { id, ...ROLE_META[id], widgets: DEFAULT_WIDGETS[id], sort: i + 1, missing: true });
  return [...roles, ...saved.filter((v) => !DEFAULT_IDS.includes(v.id))];
}
const viewLabel = (v) => (v.role && v.role !== 'Custom' && v.role !== v.name ? `${v.name} (${v.role})` : v.name);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'view';

function useColumns() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1400 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return (size) => {
    if (w < 700) return 12;
    if (w < 1100) return size === 'xs' || size === 'sm' ? 6 : 12;
    return { xs: 3, sm: 4, md: 6, lg: 12 }[size] ?? 4;
  };
}

export default function OverviewTab({ canEdit: mayEdit }) {
  const { view, setView, act, loading, down } = useDash();
  const { views: savedViews, isLoading, failed: viewsFailed } = useViews();
  // The shared views could not be read (11/12/2026): show the role views' defaults, change nothing -
  // a write now would overwrite the real views with the defaults.
  const canEdit = mayEdit && !viewsFailed;
  const views = useMemo(() => withRoleViews(savedViews), [savedViews]);
  const nav = useDashNav();
  const attention = useAttention();
  const empty = useEmptyWidgets();
  const span = useColumns();
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  // One widget menu is open at a time, so one anchor: the "..." last clicked.
  const menuBtn = useRef(null);
  const [flash, setFlash] = useState(null);
  const [attnAll, setAttnAll] = useState(false);
  const [form, setForm] = useState(null);   // { mode: 'new' | 'rename', name, role, copy }
  const [dragFrom, setDragFrom] = useState(null);
  // A short inline note under the toolbar (Oct 7: never a browser alert).
  const [note, setNote] = useState('');
  // Oct 7 (Neil, comment 6): the Dashboard density lives in the module's one
  // Customize panel - the person's own, saved to their profile (dashDensity).
  const [prefs, setPrefs] = useAccountingPrefs();
  const dashDensity = dashDensityOf(prefs);

  const current = useMemo(() => views.find((v) => v.id === view) ?? views[0] ?? null, [views, view]);
  const [widgets, setWidgets] = useState([]);
  useEffect(() => { if (current) setWidgets(current.widgets); }, [current]);
  // A role view missing from the shared table is put back, once, when opened.
  const rebuilt = useRef(new Set());
  useEffect(() => {
    if (isLoading || viewsFailed || !current?.missing || rebuilt.current.has(current.id)) return;
    rebuilt.current.add(current.id);
    const { id, name, role, widgets: w, sort } = current;
    act('view-save', { view: { id, name, role, widgets: w, sort } }).catch(() => { rebuilt.current.delete(id); });
  }, [current, isLoading, viewsFailed, act]);

  const persist = async (next) => {
    if (!current) return;
    setWidgets(next);
    try { await act('view-save', { view: { ...current, widgets: next } }); } catch (e) { setNote(e?.message || 'Could not save the view.'); }
  };
  const move = (i, j) => { if (j < 0 || j >= widgets.length || i === j) return; const next = [...widgets]; const [w] = next.splice(i, 1); next.splice(j, 0, w); persist(next); };
  const resize = (i) => { const next = [...widgets]; next[i] = { ...next[i], size: SIZES[(SIZES.indexOf(next[i].size) + 1) % SIZES.length] }; persist(next); };
  // Instant, with an Undo (11/12/2026): the view is shared, so a slip changes it for everyone.
  const remove = (i) => {
    const before = widgets;
    const cur = current;
    persist(widgets.filter((_, k) => k !== i));
    dialog.undo(`${WIDGETS[widgets[i].type]?.title || 'Widget'} removed from ${cur?.name || 'this view'}.`, () => {
      act('view-save', { view: { ...cur, widgets: before } }).catch((e) => setNote(e?.message || 'Could not put the widget back.'));
    });
  };
  const add = (type) => persist([...widgets, { type, size: WIDGETS[type].size }]);

  const goFor = (target) => {
    const w = WIDGETS[target];
    if (w?.page) { nav(w.page); return; }
    if (widgets.some((x) => x.type === target)) { flashTo(target); return; }
    const other = views.find((v) => v.widgets.some((x) => x.type === target));
    if (other) { setView(other.id); setTimeout(() => flashTo(target), 400); return; }
    persist([...widgets, { type: target, size: w?.size ?? 'md' }]).then(() => flashTo(target));
  };
  const flashTo = (type) => {
    setFlash(type);
    setTimeout(() => document.getElementById(`acct-widget-${type}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    setTimeout(() => setFlash(null), 2600);
  };

  const resetView = async () => {
    if (!current || !DEFAULT_IDS.includes(current.id)) { setNote('Custom views have no default layout to reset to.'); return; }
    setNote('');
    if (!await dialog.confirm(`Reset ${current.name} to its default widgets? This changes the view for everyone.`, { title: 'Reset View', confirmText: 'Reset' })) return;
    persist(DEFAULT_WIDGETS[current.id]);
  };
  const removeView = async () => {
    if (!current) return;
    if (DEFAULT_IDS.includes(current.id)) { setNote('Role views cannot be deleted. Use Reset to bring back the default widgets.'); return; }
    setNote('');
    // Press and hold (11/11/2026 Accounting pass, picture 10): it goes for everyone.
    if (!await dialog.confirm(`Delete the ${current.name} view for everyone?`, { title: 'Delete View', confirmText: 'Delete View', doneText: 'Deleted', hold: true, holdMs: HOLD_MAJOR_MS, onConfirm: () => act('view-delete', { id: current.id }) })) return;
    setEditing(false);
    setView(DEFAULT_IDS[0]);
  };
  const submitForm = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    // A refusal keeps the form open and says why (11/12/2026), never a silent revert.
    try {
      if (form.mode === 'new') {
        const id = `${slug(name)}-${Date.now().toString(36)}`;
        const base = form.copy ? (views.find((v) => v.id === form.copy)?.widgets ?? []) : [];
        await act('view-save', { view: { id, name, role: form.role.trim() || 'Custom', widgets: base, sort: views.length + 1 } });
        setView(id); setEditing(true);
      } else if (current) {
        await act('view-save', { view: { ...current, name, role: form.role.trim() || 'Custom', widgets } });
      }
      setForm(null);
    } catch (err) {
      setNote(err?.message || 'Could not save the view.');
    }
  };

  // Where a folded card is set up: a budget on Trackers > Budgets, the rest on Reference Data.
  const SETUP_AT = { cashForecast: ['budget', 'Trackers > Budgets'], default: ['data', 'Tools > Reference Data'] };
  // 11/11/2026 (picture 4): cards with nothing to show fold into one line where the first
  // of them stood; arranging shows every card, and the view itself is never changed.
  const folded = editing ? [] : widgets.filter((w) => empty[w.type]);
  const roleViews = views.filter((v) => DEFAULT_IDS.includes(v.id));
  const customViews = views.filter((v) => !DEFAULT_IDS.includes(v.id));
  const shown = attnAll ? attention : attention.slice(0, 4);
  const small = { fontSize: 12, padding: '4px 10px' };

  return (
    <div style={{ display: 'grid', gap: 'var(--dash-gap, 14px)' }}>
      <Toolbar right={
        <>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LayoutGrid size={14} style={{ color: 'var(--text-muted)' }} />
            <select value={current?.id ?? ''} disabled={editing} aria-label="Overview view" style={{ ...input, fontWeight: 600 }} onChange={(e) => { const v = e.target.value; if (v === '__new') setForm({ mode: 'new', name: '', role: 'Custom', copy: '' }); else { setView(v); setEditing(false); } }}>
              <optgroup label="Role Views">{roleViews.map((v) => <option key={v.id} value={v.id}>{viewLabel(v)}</option>)}</optgroup>
              {customViews.length ? <optgroup label="Custom Views">{customViews.map((v) => <option key={v.id} value={v.id}>{viewLabel(v)}</option>)}</optgroup> : null}
              {canEdit ? <option value="__new">+ New View…</option> : null}
            </select>
          </span>
          {/* Oct 7 (Neil): the module's one Customize - density, and for an
              editor the widget arranging that used to be its own button. */}
          <CustomizeButton density={dashDensity} onDensity={(d) => setPrefs({ dashDensity: d })} active={editing}>
            {canEdit ? (
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
                <button type="button" className="secondary-btn" style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setNote(''); setEditing(true); }} disabled={!current || editing}>
                  <LayoutGrid size={13} /> Arrange Widgets
                </button>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Add, remove, resize and reorder this view's widgets - for everyone who uses the view.</span>
              </div>
            ) : null}
          </CustomizeButton>
        </>
      } />

      {editing && current ? (
        <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 14px', borderColor: 'var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', fontSize: 13 }}>
          <span style={{ marginRight: 'auto' }}><b>Arranging {current.name}.</b> Drag to reorder, change a widget's width, add widgets from the library.</span>
          <button type="button" className="secondary-btn" style={small} onClick={() => setAddOpen((v) => !v)}><Plus size={12} style={{ verticalAlign: -2 }} /> Add Widget</button>
          <button type="button" className="secondary-btn" style={small} onClick={() => setForm({ mode: 'rename', name: current.name, role: current.role, copy: '' })}>Rename</button>
          <button type="button" className="secondary-btn" style={small} onClick={resetView}>Reset</button>
          {!DEFAULT_IDS.includes(current.id) ? <button type="button" className="secondary-btn" style={{ ...small, color: 'var(--bad-fg, #dc2626)' }} onClick={removeView}>Delete View</button> : null}
          <button type="button" className="primary-btn" style={small} onClick={() => { setEditing(false); setAddOpen(false); setNote(''); }}>Done</button>
        </div>
      ) : null}

      {note ? (
        <div role="status" style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--warn-fg)', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{note}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNote('')} style={{ padding: 4 }}><X size={13} /></button>
        </div>
      ) : null}

      {form ? (
        <form onSubmit={submitForm} style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{form.mode === 'new' ? 'New View' : 'Rename View'}</span>
          <input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="View name" style={{ ...input, width: 200 }} />
          <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="Role label" style={{ ...input, width: 140 }} />
          {form.mode === 'new' ? (
            <select value={form.copy} onChange={(e) => setForm({ ...form, copy: e.target.value })} style={input}><option value="">Start blank</option>{views.map((v) => <option key={v.id} value={v.id}>Copy of {v.name}</option>)}</select>
          ) : null}
          <button type="submit" className="primary-btn" style={small}>{form.mode === 'new' ? 'Create' : 'Save'}</button>
          <button type="button" className="secondary-btn" style={small} onClick={() => setForm(null)}>Cancel</button>
        </form>
      ) : null}

      {!editing ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {/* Books not reached: the notice above says so - never "Nothing needs attention". */}
          {down || viewsFailed ? null : loading || isLoading ? (
            <div style={{ width: 320, maxWidth: '100%' }}><SkeletonBlocks count={1} height={20} borderRadius={999} /></div>
          ) : attention.length === 0 ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ok-fg, #15803d)' }}><CheckCircle2 size={14} /> Nothing needs attention</span>
          ) : (
            <>
              <AlertTriangle size={14} style={{ color: 'var(--warn-fg)' }} />
              {shown.map((a, i) => (
                <button key={i} type="button" onClick={() => goFor(a.target)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
                  <Chip tone={a.severity === 0 ? 'bad' : 'wait'}>{a.text}</Chip>
                </button>
              ))}
              {attention.length > 4 ? <button type="button" onClick={() => setAttnAll((v) => !v)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'var(--wk-brand, #2b45e1)' }}>{attnAll ? 'Show less' : `+${attention.length - 4} more`}</button> : null}
            </>
          )}
        </div>
      ) : null}

      {addOpen && editing ? (
        <div style={{ ...card, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><b style={{ fontSize: 14 }}>Widget Library</b><button type="button" className="icon-btn" aria-label="Close" onClick={() => setAddOpen(false)}><X size={14} /></button></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {WIDGET_CATS.map((cat) => (
              <div key={cat}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>{cat}</div>
                {WIDGET_LIST.filter((w) => w.cat === cat).map((w) => (
                  <button key={w.id} type="button" onClick={() => add(w.id)} style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'flex-start', textAlign: 'left', padding: 8, marginBottom: 6, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-card)', cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
                    <span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>{w.title}{widgets.some((x) => x.type === w.id) ? <Chip tone="ok">On view</Chip> : null}</span><span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{w.desc}</span></span>
                    <Plus size={14} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {isLoading ? <SkeletonBlocks count={4} height={160} gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" />
        : !current ? <EmptyBox title="No views yet" body="Create a view to start arranging widgets." />
        : widgets.length === 0 ? <EmptyBox title="This view is empty" body="Select Customize > Arrange Widgets, then Add Widget to build it out." />
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 'var(--dash-gap, 14px)', paddingBottom: 16 }}>
            {widgets.map((w, i) => (folded.includes(w) ? (w === folded[0] ? (
              <div key="folded" role="note" style={{ ...card, gridColumn: 'span 12', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>
                <Info size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}><b style={{ color: 'var(--text-primary)' }}>Nothing to show yet:</b> {folded.map((x) => `${WIDGETS[x.type].title} (${empty[x.type]})`).join(' · ')}</span>
                {[...new Map(folded.map((x) => SETUP_AT[x.type] || SETUP_AT.default).map((at) => [at[0], at])).values()].filter(([to]) => nav.can?.(to) ?? true).map(([to, where]) => (
                  <button key={to} type="button" onClick={() => nav(to)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>Set Up in {where}</button>
                ))}
              </div>
            ) : null) : (
              <div key={`${i}:${w.type}`} id={`acct-widget-${w.type}`} draggable={editing}
                onDragStart={() => setDragFrom(i)} onDragOver={(e) => { if (editing) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragFrom != null) move(dragFrom, i); setDragFrom(null); }}
                style={{ gridColumn: `span ${span(w.size)}`, minWidth: 0, position: 'relative', outline: editing ? '1px dashed var(--wk-brand, #2b45e1)' : 'none', outlineOffset: 2, borderRadius: 12, cursor: editing ? 'grab' : 'default' }}>
                <WidgetPanel id={w.type} flash={flash === w.type} style={{ height: '100%' }} right={
                  editing ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <GripVertical size={14} style={{ color: 'var(--text-muted)' }} />
                      <button type="button" className="secondary-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => resize(i)}>{SIZE_LABEL[w.size]}</button>
                      <button type="button" className="icon-btn" aria-label="Remove" onClick={() => remove(i)} style={{ padding: 4, color: 'var(--bad-fg, #dc2626)' }}><X size={13} /></button>
                    </span>
                  ) : canEdit ? (
                    <span>
                      <button type="button" className="icon-btn" aria-label="Widget menu" aria-haspopup="menu" aria-expanded={menuFor === i}
                        onClick={(e) => { menuBtn.current = e.currentTarget; setMenuFor(menuFor === i ? null : i); }} style={{ padding: 4 }}><MoreHorizontal size={14} /></button>
                      <AnchoredMenu anchorRef={menuBtn} open={menuFor === i} onClose={() => setMenuFor(null)} align="end" minWidth={190}
                        style={{ ...card, padding: 4, display: 'grid' }}>
                        {[
                          ['Move Up', <ChevronUp size={13} />, () => move(i, i - 1), i === 0],
                          ['Move Down', <ChevronDown size={13} />, () => move(i, i + 1), i === widgets.length - 1],
                          [`Change Width (${SIZE_LABEL[SIZES[(SIZES.indexOf(w.size) + 1) % SIZES.length]]})`, null, () => resize(i), false],
                          ['Remove From This View', <Trash2 size={13} />, () => remove(i), false, true],
                        ].map(([label, icon, fn, disabled, danger]) => (
                          <button key={label} type="button" role="menuitem" disabled={disabled} onClick={() => { fn(); setMenuFor(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: 'none', background: 'none', textAlign: 'left', font: 'inherit', fontSize: 13, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, color: danger ? 'var(--bad-fg, #dc2626)' : 'inherit', borderRadius: 6 }}>{icon}{label}</button>
                        ))}
                      </AnchoredMenu>
                    </span>
                  ) : null
                } />
              </div>
            )))}
          </div>
        )}
    </div>
  );
}
