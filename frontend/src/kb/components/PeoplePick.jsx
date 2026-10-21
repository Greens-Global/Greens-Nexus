// Pick one person (owner, reviewer, assignee) or several, from the curated
// Nexus People list (/kb/people -> nexus_employees), never M365.
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';
import { api } from '../../api';
import { Av } from './Chips';

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

function matches(p, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return (p.name || '').toLowerCase().includes(s) || (p.email || '').toLowerCase().includes(s) || (p.department || '').toLowerCase().includes(s) || (p.job_title || '').toLowerCase().includes(s);
}

export default function PeoplePick({ value = '', onChange, placeholder = 'Search people', preferManagers = false, disabled = false, allowClear = true }) {
  const people = usePeopleList();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const chosen = people.find((p) => p.email === (value || '').toLowerCase());
  const list = useMemo(() => {
    const rows = people.filter((p) => matches(p, q));
    if (preferManagers) rows.sort((a, b) => (b.role !== 'employee') - (a.role !== 'employee') || a.name.localeCompare(b.name));
    return rows.slice(0, 40);
  }, [people, q, preferManagers]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (chosen && !open) {
    return (
      <div className="kb-input" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer' }} onClick={() => !disabled && setOpen(true)}>
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
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={value && !chosen ? value : placeholder}
               disabled={disabled} className="kb-bare" style={{ border: 0, font: 'inherit', flex: '1 1 auto', minWidth: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      {open && (
        <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--kb-card)', border: '1px solid var(--kb-line)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: 280, overflow: 'auto' }}>
          {list.length === 0 && <div className="kb-empty" style={{ padding: 14 }}>No one matches</div>}
          {list.map((p) => (
            <button key={p.email} type="button" onClick={() => { onChange(p.email); setOpen(false); setQ(''); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 0, background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'inherit' }}
                    onMouseDown={(e) => e.preventDefault()}>
              <Av name={p.name} email={p.email} size={24} />
              <span className="kb-grow kb-ellipsis">{p.name}<span className="kb-meta"> · {[p.job_title, p.department].filter(Boolean).join(', ') || p.email}</span></span>
              {p.role !== 'employee' && <span className="kb-tag">{p.role === 'owner' ? 'Global Admin' : p.role === 'administrator' ? 'IT Admin' : 'Manager'}</span>}
            </button>
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
  const list = useMemo(() => people.filter((p) => !value.includes(p.email) && matches(p, q)).slice(0, 30), [people, value, q]);
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
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={placeholder}
               className="kb-bare" style={{ border: 0, font: 'inherit', flex: '1 1 120px', minWidth: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      {open && list.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--kb-card)', border: '1px solid var(--kb-line)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: 260, overflow: 'auto' }}>
          {list.map((p) => (
            <button key={p.email} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange([...value, p.email]); setQ(''); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px', border: 0, background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'inherit' }}>
              <Av name={p.name} email={p.email} size={24} /><span className="kb-grow kb-ellipsis">{p.name}<span className="kb-meta"> · {p.job_title || p.department || p.email}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
