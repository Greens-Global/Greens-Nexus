import { useEffect, useRef, useState } from 'react';
import { Users, Plus, Pencil, X, Search, Check, Star, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useWorkforceView } from './viewContext';
import { Spinner } from '../AsyncState';

// The picker, the "showing view X" notice and the view editor. State and the
// filter itself live in viewContext.js.

const pill = (on) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 9, cursor: 'pointer',
  fontFamily: 'var(--wk-font)', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
  border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`,
  background: on ? 'var(--wk-brand-tint)' : 'var(--card)', color: on ? 'var(--wk-brand)' : 'var(--ink)',
});

/** The picker in the module header: Everyone / a saved team, plus New and Edit. */
export function WorkforceViewBar({ state }) {
  const { views, active, setActiveId, reload } = state;
  const [editing, setEditing] = useState(null);   // null | 'new' | view
  const list = views || [];
  const done = (saved, deleted) => {
    setEditing(null);
    reload();
    if (deleted) setActiveId('');
    else if (saved) setActiveId(saved.id);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <Users size={14} style={{ position: 'absolute', left: 10, color: active ? 'var(--wk-brand)' : 'var(--muted)', pointerEvents: 'none' }} />
        <select aria-label="Team View" title="Team view - who this screen shows"
          value={active?.id || ''} onChange={e => setActiveId(e.target.value)} disabled={views === null}
          style={{ ...pill(!!active), appearance: 'auto', paddingLeft: 30, maxWidth: 240 }}>
          <option value="">Everyone I Can See</option>
          {list.map(v => <option key={v.id} value={v.id}>{v.name}{v.isDefault ? ' ★' : ''} ({v.count})</option>)}
        </select>
      </span>
      {active && (
        <button type="button" onClick={() => setEditing(active)} style={pill(false)} title="Edit this view">
          <Pencil size={13} /> Edit
        </button>
      )}
      <button type="button" onClick={() => setEditing('new')} style={pill(false)}>
        <Plus size={14} /> New View
      </button>
      {editing && <ViewEditor view={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={done} />}
    </div>
  );
}

/** When a team view is on, say so - an empty list should never look like "nobody's working". */
export function ViewNotice({ shown, total, noun = 'people' }) {
  const { active } = useWorkforceView();
  if (!active) return null;
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
      Showing the <strong style={{ color: 'var(--wk-brand)' }}>{active.name}</strong> view
      {typeof shown === 'number' && typeof total === 'number' ? ` - ${shown} of ${total} ${noun}` : ''}.
    </div>
  );
}

const DIMS = [
  ['departments', 'Departments', 'id'],
  ['managers', 'Reports To', 'email'],
  ['shiftGroups', 'Shift Groups', 'id'],
  ['locations', 'Locations', 'id'],
  ['companies', 'Companies', 'id'],
];
const EMPTY = { companies: [], departments: [], locations: [], managers: [], shiftGroups: [], people: [] };

function ViewEditor({ view, onClose, onDone }) {
  const [name, setName] = useState(view?.name || '');
  const [criteria, setCriteria] = useState(() => ({ ...EMPTY, ...(view?.criteria || {}) }));
  const [isDefault, setIsDefault] = useState(!!view?.isDefault);
  const [opts, setOpts] = useState(null);
  const [match, setMatch] = useState(null);       // { key, count } - the last count back
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nameRef = useRef(null);

  useEffect(() => {
    api.workforceViewOptions().then(setOpts).catch(() => setOpts(false));
    nameRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Live match count, debounced so ticking boxes doesn't fire a request each.
  // "Counting…" is whenever the last answer is for different criteria.
  const criteriaKey = JSON.stringify(criteria);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.workforceViewPreview(JSON.parse(criteriaKey))
        .then(r => { if (live) setMatch({ key: criteriaKey, count: r?.count ?? null }); })
        .catch(() => { if (live) setMatch({ key: criteriaKey, count: null }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [criteriaKey]);
  const counting = !match || match.key !== criteriaKey;

  const toggle = (key, val) => setCriteria(c => ({
    ...c, [key]: c[key].includes(val) ? c[key].filter(x => x !== val) : [...c[key], val],
  }));
  const nothing = Object.values(criteria).every(a => !a.length);

  const save = async () => {
    if (!name.trim()) { setErr('Give the view a name.'); nameRef.current?.focus(); return; }
    if (nothing) { setErr('Pick at least one team filter or person.'); return; }
    setBusy(true); setErr('');
    try {
      const body = { name: name.trim(), criteria, isDefault };
      const saved = view ? await api.workforceViewUpdate(view.id, body) : await api.workforceViewCreate(body);
      onDone(saved, false);
    } catch (e) { setErr(e?.message || 'Could not save the view.'); setBusy(false); }
  };
  const remove = async () => {
    if (!view || !window.confirm(`Delete the "${view.name}" view?`)) return;
    setBusy(true);
    try { await api.workforceViewDelete(view.id); onDone(null, true); }
    catch (e) { setErr(e?.message || 'Could not delete the view.'); setBusy(false); }
  };

  const ql = q.trim().toLowerCase();
  const people = (opts?.people || []).filter(p => !ql || `${p.name} ${p.email} ${p.department} ${p.jobTitle}`.toLowerCase().includes(ql));
  const picked = new Set(criteria.people);

  return (
    <div role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}>
      <div role="dialog" aria-modal="true" aria-label={view ? 'Edit Team View' : 'New Team View'}
        style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: 'min(90vh, 100%)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{view ? 'Edit Team View' : 'New Team View'}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
              Only you see your views. They narrow who this screen shows - never who you're allowed to see.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain', display: 'grid', gap: 16 }}>
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={LBL}>View Name</span>
            <input ref={nameRef} className="form-input" value={name} maxLength={80} placeholder="e.g. Front Desk Team"
              onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); }} />
          </label>

          {opts === null ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Spinner size={14} /> Loading your teams…
            </div>
          ) : opts === false ? (
            <div style={{ fontSize: 12.5, color: '#b91c1c' }}>Could not load the team options - close and try again.</div>
          ) : (<>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              The view shows people who match every filter you set below, plus anyone you pick by name.
            </p>
            {DIMS.map(([key, label, idKey]) => {
              const items = opts[key] || [];
              if (!items.length) return null;
              return (
                <div key={key} style={{ display: 'grid', gap: 6 }}>
                  <span style={LBL}>{label}{key === 'managers' && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}> - everyone under them</span>}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {items.map(it => {
                      const id = it[idKey];
                      const on = criteria[key].includes(id);
                      return (
                        <button key={id} type="button" aria-pressed={on} onClick={() => toggle(key, id)} style={chip(on)}>
                          {on && <Check size={12} />}{it.name}<span style={{ opacity: 0.6, fontWeight: 500 }}>{it.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={LBL}>People{criteria.people.length ? ` (${criteria.people.length} picked)` : ''}</span>
              <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--muted)' }} />
                <input className="form-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Search people by name, email or department" style={{ paddingLeft: 32 }} />
              </span>
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 10 }}>
                {people.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12.5, color: 'var(--muted)' }}>No one matches.</div>
                ) : people.map(p => (
                  <label key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontSize: 13 }}>
                    <input type="checkbox" checked={picked.has(p.email)} onChange={() => toggle('people', p.email)} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      {(p.jobTitle || p.department) && <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {[p.jobTitle, p.department].filter(Boolean).join(' · ')}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </>)}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
            <Star size={13} style={{ color: '#d97706' }} /> Open Workforce Analytics on this view
          </label>
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span role="status" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', marginRight: 'auto' }}>
            {nothing ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Nothing picked yet</span>
              : counting ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Counting…</span>
                : match.count === null ? '' : `${match.count} ${match.count === 1 ? 'person' : 'people'} match`}
          </span>
          {err && <span style={{ fontSize: 12, color: '#b91c1c', width: '100%', order: -1 }}>{err}</span>}
          {view && (
            <button type="button" className="secondary-btn" onClick={remove} disabled={busy} style={{ color: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Trash2 size={13} /> Delete
            </button>
          )}
          <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={13} /> : <Check size={13} />} Save View
          </button>
        </div>
      </div>
    </div>
  );
}

const LBL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' };
const chip = (on) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
  fontFamily: 'var(--wk-font)', fontSize: 12.5, fontWeight: 600,
  border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`,
  background: on ? 'var(--wk-brand-tint)' : 'var(--card)', color: on ? 'var(--wk-brand)' : 'var(--ink)',
});
