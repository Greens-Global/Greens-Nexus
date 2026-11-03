// Item Management - Name typeahead over the Nexus People directory.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef, useEffect, useMemo } from 'react';
import { usePeopleDirectory } from '../../lib/queries';
import { matchPeople } from '../../lib/peopleSearch';
import { useListNav } from '../../lib/listNav';

// Name typeahead over the people directory - shows closest matches as you type
// (used for "Declared by" on person-bound op statuses). Picking a match captures
// the email so the backend can notify them; free-typed text leaves email blank.
export function PersonTypeahead({ valueName, onPick, placeholder = 'Type a name…' }) {
  const { data: dir = [] } = usePeopleDirectory();
  const [text, setText] = useState(valueName || '');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { setText(valueName || ''); }, [valueName]);
  useEffect(() => {
    function onDoc(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const q = text.trim().toLowerCase();
  // Closest match first - the same order as every people picker (first-name
  // start, then another name word, then any name/email hit; Oct 25 2026).
  const matches = useMemo(() => (q ? matchPeople(dir, q, { limit: 6 }) : []), [dir, q]);

  function pick(p) { onPick({ email: p.email || '', name: p.name || '' }); setText(p.name || ''); setOpen(false); }
  // Up / Down / Enter over the matches; Enter with no list keeps the typed name.
  const nav = useListNav(matches, { open: open && matches.length > 0, query: q, onPick: pick });

  return (
    <div ref={boxRef} style={{ position:'relative' }}>
      <input className="form-input" style={{ width:'100%' }} value={text} placeholder={placeholder}
        onChange={e => { setText(e.target.value); setOpen(true); onPick({ email:'', name: e.target.value }); }}
        onFocus={() => setOpen(true)} {...nav.inputProps}
        onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); return; } nav.onKeyDown(e); }} />
      {open && matches.length > 0 && (
        <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:30, marginTop:4, background:'var(--card)', border:'1px solid var(--line)', borderRadius:8, boxShadow:'var(--shadow-lg)', maxHeight:220, overflowY:'auto' }}>
          {matches.map((p, i) => (
            <div key={p.email || p.name} {...nav.optionProps(i)} onMouseDown={e => { e.preventDefault(); pick(p); }}
              style={{ padding:'8px 12px', cursor:'pointer', display:'flex', flexDirection:'column' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--mist)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
              <span style={{ fontWeight:600, fontSize:13 }}>{p.name}</span>
              <span style={{ fontSize:11, color:'var(--muted)' }}>{p.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
