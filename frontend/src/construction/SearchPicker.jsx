// Construction - a one-field searchable picker.
//
// The jobsite picker was a native <select>. That is fine for the four sites a
// demo has and useless for the forty a real portfolio carries: a native select
// cannot be typed into, so finding "Riverside Tower B" means scrolling a list
// ordered by whatever the API returned.
//
// Deliberately local to this module rather than the Task module's SearchSelect:
// Construction owns its own components and its own CSS variables, and a jobsite
// is not a TaskProject. It is small enough that the copy costs less than the
// coupling would.
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

/** `options` is [{ id, label, hint }] - `hint` is extra searchable text shown
 *  muted on the right (a phase, a code). Single selection; `value` is an id. */
export default function SearchPicker({
  value, onChange, options, id,
  placeholder = 'Select…', searchPlaceholder = 'Search…', emptyText = 'Nothing to choose from.',
  minWidth = 220,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) { setOpen(false); setQ(''); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => `${o.label || ''} ${o.hint || ''}`.toLowerCase().includes(needle))
    : options;
  const chosen = options.find((o) => o.id === value);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth }}>
      <button
        type="button" id={id}
        onClick={() => { setOpen((v) => !v); setQ(''); }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          width: '100%', padding: '8px 12px', borderRadius: 8,
          border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)',
          color: chosen ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontSize: '0.9rem', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chosen?.label || placeholder}
        </span>
        <ChevronDown size={15} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', zIndex: 50, top: 'calc(100% + 4px)', left: 0, minWidth: '100%',
          maxWidth: 360, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
          borderRadius: 10, boxShadow: 'var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.15))', overflow: 'hidden',
        }}>
          <div style={{ position: 'relative', borderBottom: '1px solid var(--border-color)' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '9px 12px 9px 30px', border: 'none',
                outline: 'none', fontSize: '0.85rem', fontFamily: 'inherit',
                backgroundColor: 'transparent', color: 'var(--text-primary)',
              }} />
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((o) => (
              <button
                key={o.id} type="button"
                onClick={() => { onChange(o.id); setOpen(false); setQ(''); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '9px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: '0.875rem', fontFamily: 'inherit', color: 'var(--text-primary)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover, var(--bg-primary))'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                {o.hint && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', flexShrink: 0 }}>{o.hint}</span>}
                {o.id === value && <Check size={14} style={{ flexShrink: 0, color: 'hsl(var(--color-blue))' }} />}
              </button>
            ))}
            {shown.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {needle ? `No matches for "${q.trim()}".` : emptyText}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
