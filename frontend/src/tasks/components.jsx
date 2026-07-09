// Task Module — shared UI atoms (inline-styled to match the export's light theme).
import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ChevronDown } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, colorForKey, initialsOf, statusChip, priorityChip, btn } from './theme';

export function Avatar({ email, name, size = 26 }) {
  const label = name || email || '';
  return (
    <div title={label} style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: colorForKey(email || label), color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 700,
    }}>{initialsOf(label)}</div>
  );
}

export function StatusChip({ status }) {
  const { label, ...s } = statusChip(status);
  return <span style={s}>{label}</span>;
}
export function PriorityChip({ priority }) {
  const { label, ...s } = priorityChip(priority);
  return <span style={s}>{label}</span>;
}

export function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: NX.dim }}>
      {Icon && <Icon size={34} style={{ color: NX.faint, marginBottom: 12 }} />}
      <div style={{ fontSize: 15, fontWeight: 600, color: NX.ink }}>{title}</div>
      {hint && <div style={{ fontSize: 13, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

// Centered modal (portal to body so it isn't clipped by overflow containers).
export function Modal({ title, onClose, children, footer, width = 560 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 4000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '7vh 16px',
      fontFamily: FONT, animation: 'fadeIn 0.13s ease',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: NX.surface, borderRadius: 14, width, maxWidth: '100%', maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.28)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: `1px solid ${NX.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink }}>{title}</div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto' }}>{children}</div>
        {footer && <div style={{ padding: '13px 20px', borderTop: `1px solid ${NX.border}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// Loads the roles directory once (deduped in api.js) → [{email,name}] for pickers.
export function usePeople() {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getRolesDirectory().then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return people;
}

// A compact dropdown that picks a person (email) from the directory.
export function PersonSelect({ value, onChange, people, placeholder = 'Unassigned' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const sel = people.find((p) => p.email === value);
  const filtered = q ? people.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : people;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {sel ? <Avatar email={sel.email} name={sel.name} size={20} /> : null}
          <span style={{ color: sel ? NX.ink : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sel ? sel.name : placeholder}</span>
        </span>
        <ChevronDown size={15} style={{ color: NX.faint }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50, maxHeight: 280, overflowY: 'auto' }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }} />
          <div onClick={() => { onChange(null); setOpen(false); }} style={{ padding: '8px 12px', fontSize: 13, color: NX.dim, cursor: 'pointer' }}>Unassigned</div>
          {filtered.map((p) => (
            <div key={p.email} onClick={() => { onChange(p.email); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: p.email === value ? NX.hover : 'transparent' }}>
              <Avatar email={p.email} name={p.name} size={22} />
              <span style={{ flex: 1 }}>{p.name}</span>
              {p.email === value && <Check size={14} style={{ color: NX.blue }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
