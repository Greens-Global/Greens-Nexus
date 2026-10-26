// Pick one person (owner, reviewer, assignee) or several, from the curated
// Nexus People list (/kb/people -> nexus_employees), never M365.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';
import { api } from '../../api';
import { Av } from './Chips';
import { findPeople } from '../../lib/peopleSearch';
import { recentRows, noteRecentPerson } from '../../lib/recentPeople';
import { useListNav } from '../../lib/listNav';

let cache = null;
export function usePeopleList() {
  const [people, setPeople] = useState(cache || []);
  useEffect(() => {
    let live = true;
    if (cache) return undefined;
    api.kbPeople().then((rows) => { cache = rows || []; if (live) setPeople(cache); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return people;
}

// Ranked like every Nexus people picker (first-name prefix first), still
// matching the department and job title as before.
const FIELDS = { fields: ['department', 'job_title'] };
const MENU_CAPTION = { padding: '8px 12px 3px' };

export default function PeoplePick({ value = '', onChange, placeholder = 'Search people', preferManagers = false, disabled = false, allowClear = true }) {
  const people = usePeopleList();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const chosen = people.find((p) => p.email === (value || '').toLowerCase());
  const typed = q.trim() !== '';
  const list = useMemo(() => {
    const rows = findPeople(people, q, FIELDS).list;
    // Managers first only while nothing is typed - a search keeps its ranking.
    const sorted = preferManagers && !q.trim() ? [...rows].sort((a, b) => (b.role !== 'employee') - (a.role !== 'employee') || a.name.localeCompare(b.name)) : rows;
    return sorted.slice(0, 40);
  }, [people, q, preferManagers]);
  // People picked lately, while nothing is typed - read when the menu opens,
  // so a pick never reshuffles an open list.
  const [recent, setRecent] = useState([]);
  const top = typed ? [] : recent;
  const items = [...top, ...list];
  const openMenu = () => { if (!open) setRecent(recentRows(people)); setOpen(true); };
  const close = () => { setOpen(false); setQ(''); };
  const choose = (p) => { noteRecentPerson(p.email); onChange(p.email); close(); };
  const nav = useListNav(items, { open, query: q, onPick: choose });
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (chosen && !open) {
    return (
      <div className="kb-input" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer' }} onClick={() => !disabled && openMenu()}>
        <Av name={chosen.name} email={chosen.email} size={22} />
        <span className="kb-grow kb-ellipsis">{chosen.name}<span className="kb-meta"> · {chosen.job_title || chosen.email}</span></span>
        {allowClear && !disabled && <button type="button" className="kb-ibtn" style={{ width: 24, height: 24, border: 0 }} aria-label="Clear" onClick={(e) => { e.stopPropagation(); onChange(''); }}><X size={14} /></button>}
      </div>
    );
  }
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div className="kb-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Search size={15} style={{ color: 'var(--kb-dim)' }} />
        <input value={q} onChange={(e) => { setQ(e.target.value); openMenu(); }} onFocus={openMenu} placeholder={value && !chosen ? value : placeholder}
               autoFocus={!!chosen} {...nav.inputProps}
               onKeyDown={(e) => {
                 if (e.key === 'Escape') { if (open) { e.stopPropagation(); close(); } return; }
                 if (!open) { if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(); } return; }
                 nav.onKeyDown(e);
               }}
               disabled={disabled} className="kb-bare" style={{ border: 0, font: 'inherit', flex: '1 1 auto', minWidth: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      {open && (
        <div role="listbox" style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--kb-card)', border: '1px solid var(--kb-line)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: 280, overflow: 'auto' }}>
          {list.length === 0 && <div className="kb-empty" style={{ padding: 14 }}>No one matches</div>}
          {items.map((p, i) => (
            <Fragment key={(i < top.length ? 'r:' : '') + p.email}>
            {top.length > 0 && i === 0 && <div className="kb-label" style={MENU_CAPTION}>Recent</div>}
            {top.length > 0 && i === top.length && <div className="kb-label" style={MENU_CAPTION}>All</div>}
            <button type="button" {...nav.optionProps(i)} onClick={() => choose(p)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 0, background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'inherit' }}
                    onMouseDown={(e) => e.preventDefault()}>
              <Av name={p.name} email={p.email} size={24} />
              <span className="kb-grow kb-ellipsis">{p.name}<span className="kb-meta"> · {[p.job_title, p.department].filter(Boolean).join(', ') || p.email}</span></span>
              {p.role !== 'employee' && <span className="kb-tag">{p.role === 'owner' ? 'Global Admin' : p.role === 'administrator' ? 'IT Admin' : 'Manager'}</span>}
            </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export function PeopleMultiPick({ value = [], onChange, placeholder = 'Add people' }) {
  const people = usePeopleList();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const chosen = value.map((e) => people.find((p) => p.email === e) || { email: e, name: e });
  const list = useMemo(() => findPeople(people.filter((p) => !value.includes(p.email)), q, FIELDS).list.slice(0, 30), [people, value, q]);
  // People picked lately, while nothing is typed (read when the menu opens).
  const [recent, setRecent] = useState([]);
  const top = q.trim() ? [] : recent.filter((p) => !value.includes(p.email));
  const items = [...top, ...list];
  const openMenu = () => { if (!open) setRecent(recentRows(people)); setOpen(true); };
  // A pick keeps the menu open for the next person.
  const add = (p) => { noteRecentPerson(p.email); onChange([...value, p.email]); setQ(''); };
  const nav = useListNav(items, { open, query: q, onPick: add });
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div className="kb-input" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {chosen.map((p) => (
          <span key={p.email} className="kb-tag" style={{ gap: 6 }}><Av name={p.name} email={p.email} size={18} />{p.name}
            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((e) => e !== p.email))} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', color: 'inherit' }}><X size={12} /></button>
          </span>
        ))}
        <input value={q} onChange={(e) => { setQ(e.target.value); openMenu(); }} onFocus={openMenu} placeholder={placeholder}
               {...nav.inputProps}
               onKeyDown={(e) => {
                 if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); setQ(''); } return; }
                 if (!open) { if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(); } return; }
                 nav.onKeyDown(e);
               }}
               className="kb-bare" style={{ border: 0, font: 'inherit', flex: '1 1 120px', minWidth: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      {open && items.length > 0 && (
        <div role="listbox" style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--kb-card)', border: '1px solid var(--kb-line)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: 260, overflow: 'auto' }}>
          {items.map((p, i) => (
            <Fragment key={(i < top.length ? 'r:' : '') + p.email}>
            {top.length > 0 && i === 0 && <div className="kb-label" style={MENU_CAPTION}>Recent</div>}
            {top.length > 0 && i === top.length && <div className="kb-label" style={MENU_CAPTION}>All</div>}
            <button type="button" {...nav.optionProps(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => add(p)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 0, background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'inherit' }}>
              <Av name={p.name} email={p.email} size={24} /><span className="kb-grow kb-ellipsis">{p.name}<span className="kb-meta"> · {p.job_title || p.department || p.email}</span></span>
            </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
