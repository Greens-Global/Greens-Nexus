// TicketBoard - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useState } from 'react';
import { NX, input as inputStyle } from '../tasks/theme';
import { Avatar, PriorityChip } from '../tasks/components';
import { TICKET_STATUS_META, TICKET_STATUS_ORDER, ticketNoShort } from './ticketMeta';
import { TicketTypeIcon, SlaBadge } from './TicketAtoms';

// ── Kanban board - columns by status, drag a card to change its status ────────
// `mobile` (from TicketsView): HTML5 drag-and-drop does not exist on touch
// screens, so on a phone the cards are not draggable and each carries a Move To
// picker instead - routed through the same onMove (TicketsView's guardedUpdate)
// a drop uses, so moving to Resolved/Closed still asks for the resolution.
// Columns narrow to leave the next one peeking in and snap as they scroll.
// `canMove(t)`: the drawer's status gate (ticketRights.canEditStatus) - a card
// someone may not move is neither draggable nor offered a Move To picker.
function TicketBoard({ tickets, nameOf, onOpen, onMove, mobile = false, canMove = () => true }) {
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  return (
    <div data-testid="ticket-board" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 8,
      ...(mobile ? { scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' } : null) }}>
      {TICKET_STATUS_ORDER.map((s) => {
        const m = TICKET_STATUS_META[s];
        const col = tickets.filter((t) => t.status === s);
        return (
          <div key={s}
            onDragOver={(e) => { e.preventDefault(); setOver(s); }}
            onDragLeave={() => setOver((o) => (o === s ? null : o))}
            onDrop={() => {
              const dragged = dragId && tickets.find((x) => x.id === dragId);
              if (dragged && dragged.status !== s) onMove(dragId, s);
              setDragId(null); setOver(null);
            }}
            style={{ width: mobile ? 'min(260px, 82vw)' : 260, flexShrink: 0, background: over === s ? `${m.color}12` : NX.surface2, border: `1px solid ${over === s ? m.color : NX.border}`, borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column', gap: 8,
              ...(mobile ? { scrollSnapAlign: 'start', boxSizing: 'border-box' } : null) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: NX.ink }}>{m.label}</span>
              <span style={{ fontSize: 12, color: NX.faint, marginLeft: 'auto' }}>{col.length}</span>
            </div>
            {col.slice(0, 100).map((t) => {
              const movable = canMove(t);
              const drag = !mobile && movable;
              return (
              <div key={t.id} draggable={drag} onDragStart={drag ? () => setDragId(t.id) : undefined} onDragEnd={drag ? () => setDragId(null) : undefined} onClick={() => onOpen(t.id)}
                title={!mobile && !movable ? 'You cannot change this ticket\'s status' : undefined}
                style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 10, cursor: drag ? 'grab' : 'pointer', opacity: dragId === t.id ? 0.5 : 1, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TicketTypeIcon type={t.type} size={14} />
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: NX.faint }}>{ticketNoShort(t.code)}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: NX.ink }}>{t.subject}</div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <PriorityChip priority={t.priority} />
                    <SlaBadge t={t} compact />
                  </span>
                  {t.assigneeId && <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={20} />}
                </div>
                {mobile && movable && (
                  // A native select: the phone's own picker, which no column or
                  // scroller can clip. Clicks stop here so they never open the card.
                  <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim, whiteSpace: 'nowrap' }}>Move To</span>
                    <select value={t.status} aria-label={`Move ${ticketNoShort(t.code) || 'ticket'} To`}
                      onChange={(e) => { const next = e.target.value; if (next && next !== t.status) onMove(t.id, next); }}
                      style={{ ...inputStyle, flex: 1, minWidth: 0, width: 'auto', fontSize: 16, padding: '6px 8px', minHeight: 36, cursor: 'pointer', appearance: 'auto' }}>
                      {TICKET_STATUS_ORDER.map((st) => <option key={st} value={st}>{TICKET_STATUS_META[st].label}</option>)}
                    </select>
                  </div>
                )}
              </div>
              );
            })}
            {col.length > 100 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '6px 0' }}>+ {col.length - 100} more - filter to narrow down</div>}
            {col.length === 0 && <div style={{ fontSize: 11.5, color: NX.faint, textAlign: 'center', padding: '10px 0' }}>No tickets</div>}
          </div>
        );
      })}
    </div>
  );
}

export { TicketBoard };
