import { useRef, useState } from 'react';
import { Search, ChevronDown } from 'lucide-react';
import AnchoredMenu from './AnchoredMenu';

// A searchable people dropdown (Sep 29): click to browse the whole list, or type
// to narrow it by name or email. `groups` = [{ label, people: [{ email, name }] }];
// each non-empty group gets a caption. Picking fires onPick(email) - the caller
// keeps the chosen list (Company Manager(s) shows them as chips above).
export default function PersonSearchSelect({ groups, onPick, placeholder = 'Search people...' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const [boxWidth, setBoxWidth] = useState();
  const query = q.trim().toLowerCase();
  const shown = groups
    .map(g => ({ ...g, people: g.people.filter(p => !query || `${p.name || ''} ${p.email || ''}`.toLowerCase().includes(query)) }))
    .filter(g => g.people.length);
  const flat = shown.flatMap(g => g.people);
  const openList = () => { setBoxWidth(boxRef.current?.offsetWidth); setOpen(true); };
  const close = () => { setOpen(false); setQ(''); setHi(0); };
  const pick = (p) => { onPick(p.email); close(); inputRef.current?.blur(); };
  const optionStyle = (on) => ({ display: 'flex', alignItems: 'baseline', gap: 6, width: '100%', textAlign: 'left', padding: '7px 12px', border: 'none',
    background: on ? 'var(--mist)' : 'none', cursor: 'pointer', fontSize: 12.5, fontFamily: 'Inter,sans-serif', color: 'var(--ink)' });
  let idx = -1;
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div className="form-input" onMouseDown={e => { if (e.target !== inputRef.current) { e.preventDefault(); inputRef.current?.focus(); openList(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', cursor: 'text' }}>
        <Search size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <input ref={inputRef} value={q} placeholder={placeholder} role="combobox" aria-expanded={open} aria-autocomplete="list"
          onFocus={openList} onBlur={() => setTimeout(close, 150)}
          onChange={e => { setQ(e.target.value); setHi(0); openList(); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); openList(); setHi(h => Math.min(h + 1, Math.max(flat.length - 1, 0))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && open && flat[hi]) { e.preventDefault(); pick(flat[hi]); }
            else if (e.key === 'Escape') { close(); inputRef.current?.blur(); }
          }}
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 'inherit', fontFamily: 'inherit', color: 'var(--ink)', padding: 0 }} />
        <ChevronDown size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      </div>
      <AnchoredMenu anchorRef={boxRef} open={open} onClose={close} role="listbox"
        style={{ width: boxWidth, maxHeight: 320, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: '4px 0' }}>
        {flat.length === 0 ? (
          <div style={{ padding: '9px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
            {query ? `No one matches "${q.trim()}".` : 'No one left to add.'}
          </div>
        ) : shown.map(g => (
          <div key={g.label}>
            <div style={{ padding: '8px 12px 3px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>{g.label}</div>
            {g.people.map(p => {
              idx += 1;
              const i = idx;
              return (
                <button key={p.email} type="button" role="option" aria-selected={i === hi}
                  onMouseDown={ev => { ev.preventDefault(); pick(p); }} onMouseEnter={() => setHi(i)} style={optionStyle(i === hi)}>
                  <span style={{ fontWeight: 600 }}>{p.name || p.email}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.email}</span>
                </button>
              );
            })}
          </div>
        ))}
      </AnchoredMenu>
    </div>
  );
}
