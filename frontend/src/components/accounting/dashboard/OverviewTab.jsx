import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, GripVertical, LayoutGrid, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import { SkeletonBlocks } from '../../AsyncState';
import { Chip, EmptyBox, card, input } from './Bits';
import { useDash } from './DashContext';
import { Toolbar } from './Filters';
import { useAttention, useViews } from './hooks';
import { SIZE_LABEL, SIZES, WIDGET_CATS, WIDGET_LIST, WIDGETS, WidgetPanel, useDashNav } from './registry';

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

export default function OverviewTab({ canEdit }) {
  const { view, setView, act } = useDash();
  const { views, isLoading } = useViews();
  const nav = useDashNav();
  const attention = useAttention();
  const span = useColumns();
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  const [flash, setFlash] = useState(null);
  const [attnAll, setAttnAll] = useState(false);
  const [form, setForm] = useState(null);   // { mode: 'new' | 'rename', name, role, copy }
  const [dragFrom, setDragFrom] = useState(null);

  const current = useMemo(() => views.find((v) => v.id === view) ?? views[0] ?? null, [views, view]);
  const [widgets, setWidgets] = useState([]);
  useEffect(() => { if (current) setWidgets(current.widgets); }, [current]);

  const persist = async (next) => {
    if (!current) return;
    setWidgets(next);
    try { await act('view-save', { view: { ...current, widgets: next } }); } catch (e) { window.alert(e?.message || 'Could not save the view'); }
  };
  const move = (i, j) => { if (j < 0 || j >= widgets.length || i === j) return; const next = [...widgets]; const [w] = next.splice(i, 1); next.splice(j, 0, w); persist(next); };
  const resize = (i) => { const next = [...widgets]; next[i] = { ...next[i], size: SIZES[(SIZES.indexOf(next[i].size) + 1) % SIZES.length] }; persist(next); };
  const remove = (i) => persist(widgets.filter((_, k) => k !== i));
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

  const resetView = () => {
    if (!current || !DEFAULT_IDS.includes(current.id)) { window.alert('Custom views have no default layout'); return; }
    if (!window.confirm(`Reset ${current.name} to its default widgets? This changes the view for everyone.`)) return;
    persist(DEFAULT_WIDGETS[current.id]);
  };
  const removeView = async () => {
    if (!current) return;
    if (views.length < 2) { window.alert('Keep at least one view'); return; }
    if (!window.confirm(`Delete the ${current.name} view for everyone?`)) return;
    await act('view-delete', { id: current.id });
    setEditing(false);
    setView(views.find((v) => v.id !== current.id).id);
  };
  const submitForm = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    if (form.mode === 'new') {
      const id = `${slug(name)}-${Date.now().toString(36)}`;
      const base = form.copy ? (views.find((v) => v.id === form.copy)?.widgets ?? []) : [];
      await act('view-save', { view: { id, name, role: form.role.trim() || 'Custom', widgets: base, sort: views.length + 1 } });
      setView(id); setEditing(true);
    } else if (current) {
      await act('view-save', { view: { ...current, name, role: form.role.trim() || 'Custom', widgets } });
    }
    setForm(null);
  };

  const roleViews = views.filter((v) => DEFAULT_IDS.includes(v.id));
  const customViews = views.filter((v) => !DEFAULT_IDS.includes(v.id));
  const shown = attnAll ? attention : attention.slice(0, 4);
  const small = { fontSize: '0.74rem', padding: '4px 10px' };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Toolbar right={
        <>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LayoutGrid size={14} style={{ color: 'var(--text-muted)' }} />
            <select value={current?.id ?? ''} disabled={editing} aria-label="Overview view" style={{ ...input, fontWeight: 600 }} onChange={(e) => { const v = e.target.value; if (v === '__new') setForm({ mode: 'new', name: '', role: 'Custom', copy: '' }); else { setView(v); setEditing(false); } }}>
              <optgroup label="Role views">{roleViews.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.role})</option>)}</optgroup>
              {customViews.length ? <optgroup label="Custom views">{customViews.map((v) => <option key={v.id} value={v.id}>{v.name}{v.role && v.role !== 'Custom' ? ` (${v.role})` : ''}</option>)}</optgroup> : null}
              {canEdit ? <option value="__new">+ New view…</option> : null}
            </select>
          </span>
          {canEdit && !editing ? <button type="button" className="secondary-btn" style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setEditing(true)} disabled={!current}><Pencil size={13} /> Customize</button> : null}
        </>
      } />

      {editing && current ? (
        <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 14px', borderColor: 'var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', fontSize: '0.8rem' }}>
          <span style={{ marginRight: 'auto' }}><b>Customizing {current.name}.</b> Drag to reorder, change a widget's width, add widgets from the library.</span>
          <button type="button" className="secondary-btn" style={small} onClick={() => setAddOpen((v) => !v)}><Plus size={12} style={{ verticalAlign: -2 }} /> Add Widget</button>
          <button type="button" className="secondary-btn" style={small} onClick={() => setForm({ mode: 'rename', name: current.name, role: current.role, copy: '' })}>Rename</button>
          <button type="button" className="secondary-btn" style={small} onClick={resetView}>Reset</button>
          <button type="button" className="secondary-btn" style={{ ...small, color: 'var(--bad-fg, #dc2626)' }} onClick={removeView}>Delete View</button>
          <button type="button" className="primary-btn" style={small} onClick={() => { setEditing(false); setAddOpen(false); }}>Done</button>
        </div>
      ) : null}

      {form ? (
        <form onSubmit={submitForm} style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
          <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{form.mode === 'new' ? 'New view' : 'Rename view'}</span>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: '0.78rem' }}>
          {attention.length === 0 ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ok-fg, #15803d)' }}><CheckCircle2 size={14} /> Nothing needs attention</span>
          ) : (
            <>
              <AlertTriangle size={14} style={{ color: '#b45309' }} />
              {shown.map((a, i) => (
                <button key={i} type="button" onClick={() => goFor(a.target)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
                  <Chip tone={a.severity === 0 ? 'bad' : a.severity === 1 ? 'wait' : 'ok'}>{a.text}</Chip>
                </button>
              ))}
              {attention.length > 4 ? <button type="button" onClick={() => setAttnAll((v) => !v)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: '0.72rem', color: 'var(--wk-brand, #2b45e1)' }}>{attnAll ? 'Show less' : `+${attention.length - 4} more`}</button> : null}
            </>
          )}
        </div>
      ) : null}

      {addOpen && editing ? (
        <div style={{ ...card, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><b style={{ fontSize: '0.86rem' }}>Widget library</b><button type="button" className="icon-btn" aria-label="Close" onClick={() => setAddOpen(false)}><X size={14} /></button></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {WIDGET_CATS.map((cat) => (
              <div key={cat}>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>{cat}</div>
                {WIDGET_LIST.filter((w) => w.cat === cat).map((w) => (
                  <button key={w.id} type="button" onClick={() => add(w.id)} style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'flex-start', textAlign: 'left', padding: 8, marginBottom: 6, borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-card)', cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
                    <span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', fontWeight: 600 }}>{w.title}{widgets.some((x) => x.type === w.id) ? <Chip tone="ok">On view</Chip> : null}</span><span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{w.desc}</span></span>
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
        : widgets.length === 0 ? <EmptyBox title="This view is empty" body="Select Customize, then Add Widget to build it out." />
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 14, paddingBottom: 16 }}>
            {widgets.map((w, i) => (
              <div key={`${i}:${w.type}`} id={`acct-widget-${w.type}`} draggable={editing}
                onDragStart={() => setDragFrom(i)} onDragOver={(e) => { if (editing) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragFrom != null) move(dragFrom, i); setDragFrom(null); }}
                style={{ gridColumn: `span ${span(w.size)}`, minWidth: 0, position: 'relative', outline: editing ? '1px dashed var(--wk-brand, #2b45e1)' : 'none', outlineOffset: 2, borderRadius: 12, cursor: editing ? 'grab' : 'default' }}>
                <WidgetPanel id={w.type} flash={flash === w.type} style={{ height: '100%' }} right={
                  editing ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <GripVertical size={14} style={{ color: 'var(--text-muted)' }} />
                      <button type="button" className="secondary-btn" style={{ fontSize: '0.68rem', padding: '2px 8px' }} onClick={() => resize(i)}>{SIZE_LABEL[w.size]}</button>
                      <button type="button" className="icon-btn" aria-label="Remove" onClick={() => remove(i)} style={{ padding: 4, color: 'var(--bad-fg, #dc2626)' }}><X size={13} /></button>
                    </span>
                  ) : canEdit ? (
                    <span style={{ position: 'relative' }}>
                      <button type="button" className="icon-btn" aria-label="Widget menu" onClick={() => setMenuFor(menuFor === i ? null : i)} style={{ padding: 4 }}><MoreHorizontal size={14} /></button>
                      {menuFor === i ? (
                        <div style={{ ...card, position: 'absolute', right: 0, top: 26, zIndex: 20, minWidth: 190, padding: 4, display: 'grid' }} onMouseLeave={() => setMenuFor(null)}>
                          {[
                            ['Move up', <ChevronUp size={13} />, () => move(i, i - 1), i === 0],
                            ['Move down', <ChevronDown size={13} />, () => move(i, i + 1), i === widgets.length - 1],
                            [`Change width (${SIZE_LABEL[SIZES[(SIZES.indexOf(w.size) + 1) % SIZES.length]]})`, null, () => resize(i), false],
                            ['Remove from this view', <Trash2 size={13} />, () => remove(i), false, true],
                          ].map(([label, icon, fn, disabled, danger]) => (
                            <button key={label} type="button" disabled={disabled} onClick={() => { fn(); setMenuFor(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: 'none', background: 'none', textAlign: 'left', font: 'inherit', fontSize: '0.78rem', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, color: danger ? 'var(--bad-fg, #dc2626)' : 'inherit', borderRadius: 6 }}>{icon}{label}</button>
                          ))}
                        </div>
                      ) : null}
                    </span>
                  ) : null
                } />
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
