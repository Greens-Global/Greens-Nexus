import { useState } from 'react';
import { X, Plus, Check } from 'lucide-react';
import { WIDGETS, KPI_CATALOG, SHORTCUT_TARGETS } from './widgets.jsx';

const Overlay = ({ children, onClose }) => (
  <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
    {children}
  </div>
);

const Shell = ({ title, sub, onClose, children }) => (
  <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
    <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{title}</h3>
        {sub && <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>{sub}</p>}
      </div>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
    </div>
    <div style={{ padding: 18, overflow: 'auto' }}>{children}</div>
  </div>
);

// Config picker used both when adding a configurable widget and when editing one.
function ConfigFields({ type, config, onChange }) {
  if (type === 'kpi') {
    return (
      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Metric</label>
        <select className="form-input" value={config.metric || ''} onChange={e => onChange({ metric: e.target.value })} style={{ width: '100%' }}>
          <option value="">Pick a metric…</option>
          {Object.entries(KPI_CATALOG).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
      </div>
    );
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

export function WidgetGallery({ target, can, onAdd, onClose }) {
  const [picking, setPicking] = useState(null);   // { type, config }

  const entries = Object.entries(WIDGETS).filter(([, def]) => {
    if (def.target && def.target !== target) return false;
    if (def.minRole && !can(def.minRole)) return false;
    return true;
  });
  const cats = [...new Set(entries.map(([, d]) => d.cat))];

  if (picking) {
    const def = WIDGETS[picking.type];
    return (
      <Overlay onClose={onClose}>
        <Shell title={`Add ${def.title}`} sub="Choose what it shows" onClose={onClose}>
          <ConfigFields type={picking.type} config={picking.config} onChange={patch => setPicking(p => ({ ...p, config: { ...p.config, ...patch } }))} />
          <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="secondary-btn" onClick={() => setPicking(null)}>Back</button>
            <button className="primary-btn" onClick={() => { onAdd(picking.type, picking.config); onClose(); }}>
              <Plus size={14} /> Add Widget
            </button>
          </div>
        </Shell>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={onClose}>
      <Shell title="Add a Widget" sub="Click to add - you can move and resize it after" onClose={onClose}>
        {cats.map(cat => (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>{cat}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              {entries.filter(([, d]) => d.cat === cat).map(([type, def]) => {
                const Icon = def.icon;
                return (
                  <button key={type} onClick={() => {
                      if (def.configurable) setPicking({ type, config: def.configurable === 'kpi' ? { metric: 'open_tasks' } : { ...SHORTCUT_TARGETS[0] } });
                      else { onAdd(type); onClose(); }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'hsl(var(--color-blue))'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--line)'}>
                    <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={16} /></div>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{def.title}</span>
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
  return (
    <Overlay onClose={onClose}>
      <Shell title={`Configure ${def?.title || 'widget'}`} onClose={onClose}>
        <ConfigFields type={item.type} config={config} onChange={patch => setConfig(c => ({ ...c, ...patch }))} />
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={() => { onSave(config); onClose(); }}><Check size={14} /> Save</button>
        </div>
      </Shell>
    </Overlay>
  );
}
