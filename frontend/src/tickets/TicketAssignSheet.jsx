// Assigning a ticket on a phone (Neil, Oct 1 2026: the list "is not working for
// me on mobile the way that I need" when assigning). The desktop picker is a
// small anchored dropdown with an auto-focused search box: on a phone the
// keyboard jumped up over the very list it was filtering, and the menu was
// pinned to a field halfway down a scrolled drawer. This is a bottom sheet
// instead - full width, big rows, the keyboard only when you tap Search, and
// it follows the visible viewport (BottomSheet) so nothing hides under it.
import { useState } from 'react';
import { Check, ChevronDown, Search, UserMinus } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';
import { Avatar, UnassignedAvatar } from '../tasks/components';
import { BottomSheet } from '../tasks/MobileTaskBar';
import { matchPeople } from '../lib/peopleSearch';

export function TicketAssignSheet({ value, people, onPick, onClose, title = 'Assign To' }) {
  const [q, setQ] = useState('');
  const me = (value || '').toLowerCase();
  const filtered = matchPeople(people, q);
  const row = {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 48, padding: '8px 10px',
    border: 'none', borderRadius: 10, background: 'transparent', cursor: 'pointer', fontFamily: FONT,
    fontSize: 15, color: NX.ink, textAlign: 'left',
  };
  const pick = (email) => { onPick(email); onClose(); };
  return (
    <BottomSheet title={title} onClose={onClose}>
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={16} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: NX.faint, pointerEvents: 'none' }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people"
          enterKeyHint="search" style={{ ...inputStyle, fontSize: 16, padding: '10px 12px 10px 34px' }} />
      </div>
      <div role="listbox" aria-label={title}>
        {!q && (
          <button type="button" role="option" aria-selected={!me} className="nx-menu-row" style={row} onClick={() => pick('')}>
            <UnassignedAvatar size={30} />
            <span style={{ flex: 1, color: NX.dim }}>Unassigned</span>
            {!me ? <Check size={17} style={{ color: NX.blue }} /> : <UserMinus size={16} style={{ color: NX.faint }} />}
          </button>
        )}
        {filtered.map((p) => (
          <button key={p.email} type="button" role="option" aria-selected={p.email === me} className="nx-menu-row" style={{ ...row, background: p.email === me ? NX.hover : 'transparent' }}
            onClick={() => pick(p.email)}>
            <Avatar email={p.email} name={p.name} size={30} card={false} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || p.email}</span>
              {p.title && <span style={{ display: 'block', fontSize: 12, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>}
            </span>
            {p.email === me && <Check size={17} style={{ color: NX.blue, flexShrink: 0 }} />}
          </button>
        ))}
        {filtered.length === 0 && <div style={{ padding: '14px 4px', fontSize: 14, color: NX.faint }}>No one matches "{q.trim()}".</div>}
      </div>
    </BottomSheet>
  );
}

/** The drawer's Assign To field on a phone: looks like the desktop picker's
 *  button, opens the sheet above. */
export function MobileAssignField({ value, people, nameOf, onChange, disabled = false, placeholder = 'Unassigned' }) {
  const [open, setOpen] = useState(false);
  const name = value ? (nameOf?.(value) || people.find((p) => p.email === (value || '').toLowerCase())?.name || value) : '';
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}
        style={{ ...btn('outline'), width: '100%', minHeight: 42, justifyContent: 'space-between', opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0 }}>
          {value ? <Avatar email={value} name={name} size={22} card={false} /> : <UnassignedAvatar size={22} />}
          <span style={{ color: value ? NX.ink : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15 }}>{value ? name : placeholder}</span>
        </span>
        <ChevronDown size={16} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
      {open && !disabled && (
        <TicketAssignSheet value={value} people={people} onPick={(email) => onChange(email || '')} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
