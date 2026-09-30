import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X, Users, Check, SlidersHorizontal, Loader2 } from 'lucide-react';
import { api } from '../api';
import { Avatar } from './ShiftScheduleExtras';

// Teams on the schedule grid (Neil, Sep 30 - Microsoft Teams Shifts parity):
// the "All schedules" switcher, the View menu, a team's ... menu, Add
// Members and Reorder Teams. "Group" reads "Team" everywhere in the UI.

const POP = { position: 'absolute', zIndex: 1300, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
  boxShadow: '0 12px 32px rgba(0,0,0,0.16)', fontFamily: 'Inter,sans-serif' };
const ITEM = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', border: 'none', background: 'none',
  cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', color: 'var(--ink)', textAlign: 'left' };
const HEAD = { fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 12px 4px' };
const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '92dvh', overflowY: 'auto' };

// Closes a popover on an outside press or Escape.
function useDismiss(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, onClose]);
  return ref;
}

// "All schedules": every team, the active ones, or the archived ones; picking
// one filters the whole grid to it.
export function TeamSwitcher({ groups, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('active');
  const [q, setQ] = useState('');
  const ref = useDismiss(open, () => setOpen(false));
  const picked = groups.find(g => g.id === value);
  const list = groups
    .filter(g => (tab === 'all' ? true : tab === 'archived' ? g.archived : !g.archived))
    .filter(g => !q.trim() || g.name.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (id) => { onChange(id); setOpen(false); };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="secondary-btn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        aria-label="Choose a team" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
        <Users size={14} /> {picked ? picked.name : 'All Schedules'}{picked?.archived ? ' (Archived)' : ''} <ChevronDown size={13} />
      </button>
      {open && (
        <div style={{ ...POP, top: 'calc(100% + 6px)', left: 0, width: 280 }}>
          <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, padding: '8px 8px 0', borderBottom: '1px solid var(--line)' }}>
            {[['all', 'All Teams'], ['active', 'Active Teams'], ['archived', 'Archived Teams']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                style={{ border: 'none', background: 'none', padding: '6px 8px', fontSize: 12, fontWeight: tab === k ? 800 : 600, cursor: 'pointer', fontFamily: 'inherit',
                  whiteSpace: 'nowrap', color: tab === k ? 'hsl(var(--color-green))' : 'var(--muted)', marginBottom: -1,
                  borderBottom: tab === k ? '2px solid hsl(var(--color-green))' : '2px solid transparent' }}>{label}</button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 8, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 8px' }}>
            <Search size={12} color="var(--muted)" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search teams" aria-label="Search teams" autoFocus
              style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
          </label>
          <div role="listbox" aria-label="Teams" style={{ maxHeight: 300, overflowY: 'auto', paddingBottom: 6 }}>
            {tab !== 'archived' && !q.trim() && (
              <button type="button" role="option" aria-selected={!value} onClick={() => pick('')} style={ITEM}>
                <span style={{ flex: 1, fontWeight: 700 }}>All Schedules</span>{!value && <Check size={13} color="hsl(var(--color-green))" />}
              </button>
            )}
            {list.map(g => (
              <button key={g.id} type="button" role="option" aria-selected={value === g.id} onClick={() => pick(g.id)} style={ITEM}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{g.name}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{g.members?.length || 0}</span>
                {value === g.id && <Check size={13} color="hsl(var(--color-green))" />}
              </button>
            ))}
            {!list.length && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>{tab === 'archived' ? 'No archived teams.' : 'No teams match.'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// The View menu (Teams parity): quick access, view by, and what shows.
const SHOW_OPTIONS = [['teams', 'Teams'], ['open', 'Open Shifts'], ['conflicts', 'Shift Conflicts'],
  ['availability', 'Availability'], ['photos', 'Profile Pictures'], ['sunday', 'Sunday']];

export function ViewMenu({ prefs, onChange, canViewByShift }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const set = (k, v) => onChange({ ...prefs, [k]: v });
  const radio = (on, label, fn) => (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={fn} style={ITEM}>
      <span style={{ width: 14, display: 'inline-flex' }}>{on && <Check size={13} color="hsl(var(--color-green))" />}</span>{label}
    </button>
  );
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="secondary-btn" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}
        style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <SlidersHorizontal size={13} /> View <ChevronDown size={13} />
      </button>
      {open && (
        <div role="menu" aria-label="View options" style={{ ...POP, top: 'calc(100% + 6px)', right: 0, width: 220, paddingBottom: 6 }}>
          <div style={HEAD}>Quick Access</div>
          {radio(prefs.mine, 'Your Shifts', () => set('mine', true))}
          {radio(!prefs.mine, 'Team Shifts', () => set('mine', false))}
          {canViewByShift && (
            <>
              <div style={HEAD}>View By</div>
              {radio(prefs.rowsBy !== 'shifts', 'People', () => set('rowsBy', 'people'))}
              {radio(prefs.rowsBy === 'shifts', 'Shift', () => set('rowsBy', 'shifts'))}
            </>
          )}
          <div style={HEAD}>Show</div>
          {SHOW_OPTIONS.map(([k, label]) => (
            <label key={k} style={{ ...ITEM, cursor: 'pointer' }}>
              <input type="checkbox" checked={prefs[k] !== false} onChange={e => set(k, e.target.checked)} aria-label={`Show ${label}`} />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// A team header's ... menu.
export function TeamMenu({ team, canReorder, onAction }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const act = (a) => { setOpen(false); onAction(a); };
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-label={`${team.name} options`} aria-haspopup="menu"
        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: '0 4px', fontSize: 15, lineHeight: 1, fontWeight: 800 }}>⋯</button>
      {open && (
        <div role="menu" aria-label={`${team.name} options`} style={{ ...POP, top: 'calc(100% + 4px)', left: 0, width: 190, padding: '4px 0' }}>
          <button type="button" role="menuitem" style={ITEM} onClick={() => act('rename')}>Rename Team</button>
          {canReorder && <button type="button" role="menuitem" style={ITEM} onClick={() => act('reorder')}>Reorder Teams</button>}
          <button type="button" role="menuitem" style={ITEM} onClick={() => act('archive')}>{team.archived ? 'Restore Team' : 'Archive Team'}</button>
          <button type="button" role="menuitem" style={ITEM} onClick={() => act('manage')}>Manage Teams</button>
          {canReorder && <button type="button" role="menuitem" style={{ ...ITEM, color: '#b91c1c' }} onClick={() => act('delete')}>Delete Team</button>}
        </div>
      )}
    </span>
  );
}

const emailOf = (p) => (p.workEmail || p.work_email || p.email || '').toLowerCase();
const nameOf = (p) => p.name || `${p.firstName || p.first_name || ''} ${p.lastName || p.last_name || ''}`.trim() || emailOf(p);

// Add members: the curated Nexus People list, minus who is already on it.
export function AddMembersModal({ team, busy, onAdd, onClose, onManage }) {
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    let live = true;
    api.getPeopleDirectory().then(rows => { if (live) setPeople(Array.isArray(rows) ? rows : []); }).catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, []);
  const have = useMemo(() => new Set((team.members || []).map(m => m.toLowerCase())), [team]);
  const list = (people || []).filter(p => emailOf(p) && !have.has(emailOf(p)))
    .filter(p => !q.trim() || `${nameOf(p)} ${emailOf(p)}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const toggle = (em) => setPicked(ps => (ps.includes(em) ? ps.filter(x => x !== em) : [...ps, em]));
  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Add Members" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Add Members to {team.name}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Pick people from the Nexus People list. They show under this team on the schedule.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', marginBottom: 8 }}>
          <Search size={13} color="var(--muted)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people" aria-label="Search people to add" autoFocus
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
        </label>
        <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          {people === null && <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /></div>}
          {people !== null && !list.length && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--muted)' }}>Nobody else to add.</div>}
          {list.map(p => {
            const em = emailOf(p);
            return (
              <label key={em} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}>
                <input type="checkbox" checked={picked.includes(em)} onChange={() => toggle(em)} aria-label={`Add ${nameOf(p)}`} />
                <Avatar name={nameOf(p)} photoUrl={p.photoUrl || p.photo_url || ''} size={24} />
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{nameOf(p)}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{em}</div>
                </span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          {onManage && <button type="button" onClick={onManage} style={{ background: 'none', border: 'none', color: 'hsl(var(--color-green))', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, padding: 0 }}>Manage Team</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" disabled={busy || !picked.length} onClick={() => onAdd(picked)}>
            {picked.length > 1 ? `Add ${picked.length} People` : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Reorder Teams: move each up or down; Save sets the order for everyone.
export function ReorderTeamsModal({ groups, busy, onSave, onClose }) {
  const [order, setOrder] = useState(() => groups.map(g => g.id));
  const byId = Object.fromEntries(groups.map(g => [g.id, g]));
  const move = (i, d) => setOrder(o => { const n = [...o]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Reorder Teams" style={{ ...MODAL_CARD, maxWidth: 400 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Reorder Teams</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 8 }}>
          {order.map((id, i) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderBottom: i < order.length - 1 ? '1px solid var(--line)' : 'none' }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{byId[id]?.name}{byId[id]?.archived ? ' (Archived)' : ''}</span>
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${byId[id]?.name} up`} style={{ padding: 3 }}><ChevronUp size={14} /></button>
              <button type="button" className="icon-btn" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${byId[id]?.name} down`} style={{ padding: 3 }}><ChevronDown size={14} /></button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => onSave(order)}>Save</button>
        </div>
      </div>
    </div>
  );
}
