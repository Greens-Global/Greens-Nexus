import { useRef, useState } from 'react';
import { Search, ChevronDown, User } from 'lucide-react';
import AnchoredMenu from './AnchoredMenu';
import { matchPeople } from '../lib/peopleSearch';
import { recentRows, noteRecentPerson } from '../lib/recentPeople';
import { usePhotoMap } from '../lib/peoplePhotos';

// A face beside each name (Neil, Oct 28 2026): the row's own photoUrl, else
// the People photo for that email, else a person glyph.
function Face({ p, photos }) {
  const [broken, setBroken] = useState(false);
  const url = p.photoUrl || photos[(p.email || '').toLowerCase()] || '';
  const base = { width: 22, height: 22, borderRadius: '50%', flexShrink: 0, alignSelf: 'center' };
  if (url && !broken) return <img src={url} alt="" onError={() => setBroken(true)} style={{ ...base, objectFit: 'cover', border: '1px solid var(--line)' }} />;
  // No photo: a plain person glyph, so the option's text stays the name alone.
  return <span aria-hidden="true" style={{ ...base, background: 'var(--bg)', border: '1px solid var(--line)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}><User size={12} /></span>;
}

// A searchable people dropdown (Sep 29): click to browse the whole list, or type
// to narrow it by name or email. `groups` = [{ label, people: [{ email, name }] }];
// each non-empty group gets a caption. Picking fires onPick(email) - the caller
// keeps the chosen list (Company Manager(s) shows them as chips above).
// Each group is ranked first-name matches first (lib/peopleSearch.js); while
// nothing is typed a "Recent" group leads with the people picked lately.
export default function PersonSearchSelect({ groups, onPick, placeholder = 'Search people...' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const photos = usePhotoMap();
  const [boxWidth, setBoxWidth] = useState();
  // Read when the list opens, so a pick never reshuffles an open list.
  const [recent, setRecent] = useState([]);
  const query = q.trim().toLowerCase();
  const everyone = groups.flatMap(g => g.people);
  const top = query ? [] : recent.filter(r => everyone.some(p => p.email === r.email));
  const shown = groups
    .map(g => ({ ...g, people: matchPeople(g.people, query) }))
    .filter(g => g.people.length);
  if (top.length) shown.unshift({ label: 'Recent', people: top });
  const flat = shown.flatMap(g => g.people);
  const openList = () => { setBoxWidth(boxRef.current?.offsetWidth); if (!open) setRecent(recentRows(everyone)); setOpen(true); };
  const close = () => { setOpen(false); setQ(''); setHi(0); };
  const pick = (p) => { noteRecentPerson(p.email); onPick(p.email); close(); inputRef.current?.blur(); };
  const optionStyle = (on) => ({ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left', padding: '7px 12px', border: 'none',
    background: on ? 'var(--mist)' : 'none', cursor: 'pointer', fontSize: 12.5, fontFamily: 'Inter,sans-serif', color: 'var(--ink)' });
  let idx = -1;
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div className="form-input" onMouseDown={e => { if (e.target !== inputRef.current) { e.preventDefault(); inputRef.current?.focus(); openList(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', cursor: 'text' }}>
        <Search size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <input className="nx-inline-edit" ref={inputRef} value={q} placeholder={placeholder} role="combobox" aria-expanded={open} aria-autocomplete="list"
          onFocus={openList} onBlur={() => setTimeout(close, 150)}
          onChange={e => { setQ(e.target.value); setHi(0); openList(); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); openList(); setHi(h => Math.min(h + 1, Math.max(flat.length - 1, 0))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && open && flat[hi]) { e.preventDefault(); pick(flat[hi]); }
            else if (e.key === 'Escape') { close(); inputRef.current?.blur(); }
          }}
          style={{ flex: 1, minWidth: 0, border: 'none', fontSize: 'inherit', fontFamily: 'inherit', color: 'var(--ink)', padding: 0 }} />
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
                  <Face p={p} photos={photos} />
                  <span style={{ fontWeight: 600 }}>{p.name || p.email}</span>
                  {/* Their job title next to the name (Neil, Oct 19), then the email. */}
                  <span style={{ color: 'var(--muted)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[p.title, p.email].filter(Boolean).join(' · ')}</span>
                </button>
              );
            })}
          </div>
        ))}
      </AnchoredMenu>
    </div>
  );
}
