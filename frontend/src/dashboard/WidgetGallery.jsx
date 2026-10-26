import { useState, useEffect } from 'react';
import { LoadingState } from '../components/AsyncState';
import { X, Plus, Check, Search, ArrowUp, ArrowDown } from 'lucide-react';
import { WIDGETS, KPI_CATALOG, SHORTCUT_TARGETS, DEFAULT_QUICK_ACTIONS, ACTION_CHOICES, DEFAULT_ACTION, sizeLabel, limitsOf, QUICK_STYLES, DEFAULT_QUICK_STYLE, quickStyleOf, actionAllowed, actionChoice } from './widgets.jsx';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';
import { useIsMobile } from '../lib/useIsMobile';
import { WeatherConfigFields } from './weatherWidget.jsx';
import { weatherConfigValid, WEATHER_DEFAULT } from './weatherLib';

// `onClose` here is expected to already be the guarded `requestClose` when
// the caller has editable state to protect (see ConfigModal / the picking
// step below) - Overlay itself just needs one place to hang the backdrop click.
const Overlay = ({ children, onClose }) => (
  <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    {children}
  </div>
);

const Shell = ({ title, sub, onClose, children }) => (
  // min(85vh, 100%): on a phone 85vh counts the height hidden behind the
  // browser's toolbars, so the sheet's bottom rows could sit off-screen;
  // 100% of the fixed overlay is the space actually visible.
  <div className="nx-popup" style={{ background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
    <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{title}</h3>
        {sub && <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{sub}</p>}
      </div>
      <button onClick={onClose} aria-label="Close" title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, margin: '-8px -10px -8px 0', borderRadius: 8, flexShrink: 0 }}><X size={18} /></button>
    </div>
    <div style={{ padding: 18, overflow: 'auto', minHeight: 0, overscrollBehavior: 'contain' }}>{children}</div>
  </div>
);

// Folder picker for the Links Folder widget - its own component (not just a
// branch inline in ConfigFields) since it needs its own fetch effect, and
// conditionally calling a hook inside ConfigFields depending on `type`
// would break the rules of hooks the moment the picker switches widget
// types mid-session. Lists every folder the user has built in External
// Links across BOTH tabs (Aug 14, "add a option external links where i can
// see all my folders... company and personal") - grouped so it's clear
// which tab each one lives in, since the two are kept strictly separate
// everywhere else in this module.
function LinksFolderFields({ config, onChange }) {
  const [state, setState] = useState({ loading: true, folders: [] });
  useEffect(() => {
    api.getLinkLayout().then(l => setState({ loading: false, folders: l?.folders || [] }))
      .catch(() => setState({ loading: false, folders: [] }));
  }, []);
  const key = (f) => `${f.item_type || 'external'}:${f.id}`;
  const cur = config.folderId ? `${config.itemType || 'external'}:${config.folderId}` : '';
  const company = state.folders.filter(f => (f.item_type || 'external') === 'external');
  const personal = state.folders.filter(f => f.item_type === 'personal');
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Folder</label>
      {state.loading ? (
        <LoadingState compact label="Loading your folders…" />
      ) : state.folders.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          You don't have any folders yet - open Links, drag a couple of apps together (or hit "New Folder" on either tab), then come back here.
        </p>
      ) : (
        <select className="form-input" value={cur} style={{ width: '100%' }}
          onChange={e => {
            const f = state.folders.find(x => key(x) === e.target.value);
            if (f) onChange({ folderId: f.id, itemType: f.item_type || 'external', folderName: f.name });
          }}>
          <option value="">Pick a folder…</option>
          {company.length > 0 && (
            <optgroup label="Company Links">
              {company.map(f => <option key={key(f)} value={key(f)}>{f.name}</option>)}
            </optgroup>
          )}
          {personal.length > 0 && (
            <optgroup label="Personal Links">
              {personal.map(f => <option key={key(f)} value={key(f)}>{f.name}</option>)}
            </optgroup>
          )}
        </select>
      )}
    </div>
  );
}

// The Action Tile's picker (Oct 11): every choice as a tappable icon card, the
// way a home screen offers its apps, not a dropdown. Its own component for the
// role hook - the punch is left out for a time-tracking-exempt person, who has
// no clock to punch (same rule as widgetHidden).
function ActionFields({ config, onChange }) {
  const { timeTrackingExempt } = useRole();
  const choices = ACTION_CHOICES.filter(a => !(a.timeTracked && timeTrackingExempt === true));
  const cur = config.action || DEFAULT_ACTION;
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 8 }}>What this tile does</label>
      <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        {choices.map(a => {
          const on = a.key === cur;
          return (
            <button key={a.key} type="button" role="radio" aria-checked={on} onClick={() => onChange({ action: a.key })}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)',
                background: on ? 'var(--wk-brand-tint, hsla(var(--color-blue),0.08))' : 'var(--card)',
                border: `1.5px solid ${on ? 'var(--wk-brand, hsl(var(--color-blue)))' : 'var(--line)'}` }}>
              <span className={`dk-chip dk-chip--${a.color}`} style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0 }}><a.Icon size={15} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', overflowWrap: 'anywhere' }}>{a.label}</span>
                {a.hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{a.hint}</span>}
              </span>
              {on && <Check size={14} style={{ color: 'var(--wk-brand, hsl(var(--color-blue)))', flexShrink: 0 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Quick Actions picker (Oct 13): the style first (bare icons, named tiles or
// the list), then the actions as ONE ordered list - the ones on the tile at
// the top in the order they draw, with up/down to reorder (a dock reads left
// to right, so order is the layout), then the rest of the catalog to tick
// on. The punch and module-gated actions are left out for people they do not
// apply to, the same rule the tile applies when it draws.
function QuickActionsFields({ config, onChange }) {
  const role = useRole();
  const choices = ACTION_CHOICES.filter(a => actionAllowed(a, role));
  const saved = Array.isArray(config.actions) && config.actions.length ? config.actions : DEFAULT_QUICK_ACTIONS;
  const picked = saved.filter(k => choices.some(a => a.key === k));
  // Keys this editor cannot see (a grant they lack, the punch for an exempt
  // person) stay in the saved list - a shared tile must not lose them.
  const hidden = saved.filter(k => !choices.some(a => a.key === k) && actionChoice(k));
  const style = quickStyleOf(config);
  const set = (next) => onChange({ actions: [...next, ...hidden] });
  const toggle = (key) => set(picked.includes(key) ? picked.filter(k => k !== key) : [...picked, key]);
  const move = (key, dir) => {
    const i = picked.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= picked.length) return;
    const next = [...picked]; [next[i], next[j]] = [next[j], next[i]];
    set(next);
  };
  const rows = [...picked.map(actionChoice).filter(Boolean), ...choices.filter(a => !picked.includes(a.key))];
  const arrowBtn = { border: 'none', background: 'none', padding: 2, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', borderRadius: 6 };
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 8 }}>Style</label>
      <div role="radiogroup" aria-label="Style" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, marginBottom: 16 }}>
        {QUICK_STYLES.map(st => {
          const on = st.key === style;
          return (
            <button key={st.key} type="button" role="radio" aria-checked={on} onClick={() => onChange({ style: st.key })}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)',
                background: on ? 'var(--wk-brand-tint, hsla(var(--color-blue),0.08))' : 'var(--card)',
                border: `1.5px solid ${on ? 'var(--wk-brand, hsl(var(--color-blue)))' : 'var(--line)'}` }}>
              <QuickStylePreview style={st.key} />
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>{st.label}</span>
                {on && <Check size={14} style={{ color: 'var(--wk-brand, hsl(var(--color-blue)))', flexShrink: 0 }} />}
              </span>
              <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.35 }}>{st.hint}</span>
            </button>
          );
        })}
      </div>
      <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Actions on this tile, in order</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map(a => {
          const on = picked.includes(a.key);
          const i = picked.indexOf(a.key);
          return (
            <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--ink)', padding: '4px 2px', borderRadius: 8, background: on ? 'var(--wk-hover, var(--mist))' : 'transparent' }}>
              <input type="checkbox" id={`qa-pick-${a.key}`} checked={on} onChange={() => toggle(a.key)} aria-label={a.label} />
              <span className={`dk-chip dk-chip--${a.color}`} style={{ width: 26, height: 26, borderRadius: 7 }}><a.Icon size={14} /></span>
              <label htmlFor={`qa-pick-${a.key}`} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>{a.label}</label>
              {on && (
                <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
                  <button type="button" style={{ ...arrowBtn, opacity: i === 0 ? 0.3 : 1 }} disabled={i === 0} onClick={() => move(a.key, -1)} aria-label={`Move ${a.label} up`}><ArrowUp size={14} /></button>
                  <button type="button" style={{ ...arrowBtn, opacity: i === picked.length - 1 ? 0.3 : 1 }} disabled={i === picked.length - 1} onClick={() => move(a.key, 1)} aria-label={`Move ${a.label} down`}><ArrowDown size={14} /></button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {picked.length === 0 && hidden.length === 0 && <p style={{ fontSize: 12, color: 'hsl(var(--color-red))', margin: '8px 0 0' }}>Pick at least one action.</p>}
    </div>
  );
}

// A thumbnail of each style: three dots for the dock, dot-over-line tiles,
// or icon-and-line rows - so the choice is visible before it is made.
function QuickStylePreview({ style }) {
  const dot = (k) => <span key={k} style={{ width: 12, height: 12, borderRadius: 4, background: 'var(--wk-brand, hsl(var(--color-blue)))', opacity: .75 }} />;
  const line = (k, w) => <span key={k} style={{ width: w, height: 3, borderRadius: 2, background: 'var(--line)' }} />;
  if (style === 'icons') return <span style={{ display: 'flex', gap: 6 }}>{[0, 1, 2, 3].map(dot)}</span>;
  if (style === 'tiles') return <span style={{ display: 'flex', gap: 8 }}>{[0, 1, 2].map(k => <span key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>{dot(k)}{line(k, 14)}</span>)}</span>;
  return <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{[0, 1, 2].map(k => <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{dot(k)}{line(k, 34)}</span>)}</span>;
}

// Config picker used both when adding a configurable widget and when editing one.
function ConfigFields({ type, config, onChange }) {
  if (type === 'action') {
    return <ActionFields config={config} onChange={onChange} />;
  }
  if (type === 'quick-actions') {
    return <QuickActionsFields config={config} onChange={onChange} />;
  }
  if (type === 'links-folder') {
    return <LinksFolderFields config={config} onChange={onChange} />;
  }
  if (type === 'kpi') {
    return (
      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Metric</label>
        <select className="form-input" value={config.metric || ''} onChange={e => onChange({ metric: e.target.value })} style={{ width: '100%' }}>
          <option value="">Pick a metric…</option>
          {Object.entries(KPI_CATALOG).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        {/* Home keeps ONE solid focal tile (the Open Tasks hero); this makes that
            look available to any KPI tile the user wants to spotlight. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!config.hero} onChange={e => onChange({ hero: e.target.checked })} />
          Hero style - the solid color card, like Home's open tasks tile
        </label>
      </div>
    );
  }
  if (type === 'weather') {
    return <WeatherConfigFields config={config} onChange={onChange} />;
  }
  if (type === 'shortcut') {
    const cur = SHORTCUT_TARGETS.findIndex(t => t.view === config.view && (t.sub || '') === (config.sub || ''));
    return (
      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Destination</label>
        <select className="form-input" value={cur} onChange={e => { const t = SHORTCUT_TARGETS[+e.target.value]; onChange({ view: t.view, sub: t.sub, label: t.label }); }} style={{ width: '100%' }}>
          {SHORTCUT_TARGETS.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
        </select>
      </div>
    );
  }
  return <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>This widget has no options.</p>;
}

// Is this widget's config complete enough to add / save? Gates the primary
// button in both the gallery's picking step and the gear's ConfigModal.
export function configValid(type, config) {
  if (type === 'weather') return weatherConfigValid(config);
  if (type === 'links-folder') return !!config?.folderId;
  if (type === 'quick-actions') return !Array.isArray(config?.actions) || config.actions.length > 0;
  if (type === 'action') return !!config?.action;
  // A KPI tile with no metric used to save as a tile labeled "Metric" at 0.
  if (type === 'kpi') return !!config?.metric;
  return true;
}

export function WidgetGallery({ canSee, onAdd, onClose, layout = [] }) {
  const [picking, setPicking] = useState(null);   // { type, config, initial }
  const touch = useIsMobile('(pointer: coarse)');
  // Search (Oct 11): the catalog passed thirty tiles - scrolling eight
  // categories to find "weather" is not finding. Matches the title and the
  // category; the groups below shrink to what matches.
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  const entries = Object.entries(WIDGETS).filter(([, def]) => canSee(def) && !def.hidden
    && (!needle || def.title.toLowerCase().includes(needle) || def.cat.toLowerCase().includes(needle)
      || (def.aka || []).some((a) => a.toLowerCase().includes(needle))));
  const cats = [...new Set(entries.map(([, d]) => d.cat))];
  // Which widget types are already on the view - the double-My-Agenda trap was
  // adding a widget the default layout already carried, with nothing saying so.
  // Adding a second copy stays allowed (two KPI tiles with different metrics is
  // legitimate); the badge just makes it a choice instead of a surprise.
  const onView = new Set(layout.map(it => it.type));

  // Dirty once the picker's config drifts from what it opened with - an
  // unintentional exit (backdrop click) shouldn't silently drop a folder/metric
  // someone already picked before hitting "Add Widget".
  const pickDirty = !!picking && JSON.stringify(picking.config) !== JSON.stringify(picking.initial);
  const addWidget = () => { onAdd(picking.type, picking.config); onClose(); };
  const pickGuard = useUnsavedGuard(pickDirty, onClose, addWidget);

  if (picking) {
    const def = WIDGETS[picking.type];
    return (
      <>
        <Overlay onClose={pickGuard.requestClose}>
          <Shell title={`Add ${def.title}`} sub="Choose what it shows" onClose={pickGuard.requestClose}>
            <ConfigFields type={picking.type} config={picking.config} onChange={patch => setPicking(p => ({ ...p, config: { ...p.config, ...patch } }))} />
            <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setPicking(null)}>Back</button>
              <button className="primary-btn" disabled={!configValid(picking.type, picking.config)}
                onClick={addWidget}>
                <Plus size={14} /> Add Widget
              </button>
            </div>
          </Shell>
        </Overlay>
        {pickGuard.confirming && (
          <UnsavedChangesPrompt onKeepEditing={pickGuard.keepEditing} onDiscard={onClose} onSave={pickGuard.saveAndClose} saving={pickGuard.saving} />
        )}
      </>
    );
  }

  return (
    <Overlay onClose={onClose}>
      <Shell title="Add a Widget" sub={touch ? 'Tap to add - you can reorder it after' : 'Click to add - you can move and resize it after'} onClose={onClose}>
        <div style={{ position: 'relative', marginBottom: 16 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
          <input type="search" className="form-input" value={q} onChange={e => setQ(e.target.value)} autoFocus={!touch}
            placeholder="Search widgets…" aria-label="Search widgets" style={{ width: '100%', paddingLeft: 34 }} />
        </div>
        {entries.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: '18px 0' }}>Nothing matches "{q.trim()}".</p>
        )}
        {cats.map(cat => (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>{cat}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              {entries.filter(([, d]) => d.cat === cat).map(([type, def]) => {
                const Icon = def.icon;
                const added = onView.has(type);
                return (
                  <button key={type} onClick={() => {
                      if (def.configurable) {
                        const initial = def.configurable === 'kpi' ? { metric: 'open_tasks' }
                          : def.configurable === 'links-folder' ? {}
                          : def.configurable === 'quick-actions' ? { style: DEFAULT_QUICK_STYLE, actions: [...DEFAULT_QUICK_ACTIONS] }
                          : def.configurable === 'weather' ? { ...WEATHER_DEFAULT }
                          : def.configurable === 'action' ? { action: DEFAULT_ACTION }
                          // Only what the select's onChange saves - the catalog
                          // entry also carries its Icon component and color.
                          : { view: SHORTCUT_TARGETS[0].view, sub: SHORTCUT_TARGETS[0].sub, label: SHORTCUT_TARGETS[0].label };
                        setPicking({ type, config: initial, initial });
                      } else { onAdd(type); onClose(); }
                    }}
                    title={added ? 'Already on this view - click to add another copy' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'hsl(var(--color-blue))'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--line)'}>
                    <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={16} /></div>
                    {/* Name over badge, not beside it: side by side, a two-column
                        phone grid left "Notifications" ~60px and the badge
                        painted over it ("Notif", Sep 28). */}
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{def.title}</span>
                      {/* The footprint in the iOS size vocabulary, so you know
                          what you are adding before it lands on the board. */}
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 500 }}>{sizeLabel(def.size)}{limitsOf(type).minH === 1 ? ' · fits one row' : ''}</span>
                      {added && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: 'var(--wk-green, #00a25b)', background: 'var(--wk-green-bg, rgba(0,162,91,.1))', borderRadius: 999, padding: '2px 7px' }}>
                          <Check size={10} /> Added
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </Shell>
    </Overlay>
  );
}

export function ConfigModal({ item, onSave, onClose }) {
  const def = WIDGETS[item.type];
  const [config, setConfig] = useState(item.config || {});
  const dirty = JSON.stringify(config) !== JSON.stringify(item.config || {});
  const valid = configValid(item.type, config);
  const doSave = () => { if (!valid) return; onSave(config); onClose(); };
  const guard = useUnsavedGuard(dirty, onClose, valid ? doSave : undefined);
  return (
    <>
      <Overlay onClose={guard.requestClose}>
        <Shell title={`Configure ${def?.title || 'widget'}`} onClose={guard.requestClose}>
          <ConfigFields type={item.type} config={config} onChange={patch => setConfig(c => ({ ...c, ...patch }))} />
          <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="secondary-btn" onClick={onClose}>Cancel</button>
            <button className="primary-btn" onClick={doSave} disabled={!valid}><Check size={14} /> Save</button>
          </div>
        </Shell>
      </Overlay>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving} />
      )}
    </>
  );
}
