// TicketDrawerCards - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { Plus, Link2, ClipboardList, X, Star } from 'lucide-react';
import { NX, chip, btn, input as inputStyle } from '../tasks/theme';
import { StatusChip } from '../tasks/components';
import { LINK_TYPES, linkTypeLabel, ticketNoShort } from './ticketMeta';
import { TicketSelect } from './TicketAtoms';
import { CSAT_LABELS } from './ticketViewShared';

// ── Tasks spawned from / linked to a ticket (one ticket → many tasks) ─────────
// Each row opens the task in place (onOpen) and carries its live status chip,
// so progress on the work is readable from the ticket without switching module.
// A linked id the store does not hold (deleted, or not visible to this person)
// still gets a row - hiding it made the link look like it had never been made.
function TicketTasks({ taskIds, tasks, tasksLoading = false, onOpen, onSpawn, onLink, onUnlink, readOnly }) {
  const [linking, setLinking] = useState(false);
  const linked = taskIds.map((id) => tasks.find((x) => x.id === id) || { id, missing: true });
  // Still fetching (Support mounts its own store lazily): a link is not
  // "missing" until the list it would be found in has actually arrived.
  if (tasksLoading && linked.some((x) => x.missing)) return <span className="skel" style={{ display: 'block', width: 220, height: 14 }} />;
  const options = tasks.filter((x) => !taskIds.includes(x.id));
  return (
    <div>
      {linked.length === 0 && readOnly && <span style={{ fontSize: 12.5, color: NX.faint }}>No linked tasks</span>}
      {linked.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {linked.map((task) => (
            <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
              <ClipboardList size={13} style={{ color: NX.faint, flexShrink: 0 }} />
              {task.missing ? (
                <span style={{ color: NX.faint, fontStyle: 'italic' }}>Task not available - it may have been deleted or you may not have access</span>
              ) : (
                <>
                  <button onClick={() => onOpen(task.id)} title="Open Task"
                    style={{ ...btn('ghost'), padding: 0, minWidth: 0, color: NX.primary, fontWeight: 600, fontSize: 13, textDecoration: task.completed ? 'line-through' : 'underline', textUnderlineOffset: 2, justifyContent: 'flex-start' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.code ? `${task.code} · ` : ''}{task.title}</span>
                  </button>
                  <span style={{ flexShrink: 0 }}><StatusChip status={task.completed ? 'completed' : task.status} /></span>
                </>
              )}
              {!readOnly && <button onClick={() => onUnlink(task.id)} title="Unlink task" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>}
            </div>
          ))}
        </div>
      )}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={onSpawn} style={{ ...btn('outline'), fontSize: 12 }}><Plus size={13} /> Create Task from Ticket</button>
          {linking ? (
            <TicketSelect command placeholder="Select a task…" searchPlaceholder="Search tasks…"
              emptyText="No tasks to link." style={{ width: 'auto', minWidth: 180 }}
              options={options.map((task) => [task.id, `${task.code ? `${task.code} · ` : ''}${task.title}`])}
              onChange={(id) => { if (id) onLink(id); setLinking(false); }} />
          ) : (
            <button onClick={() => setLinking(true)} style={{ ...btn('ghost'), fontSize: 12, color: NX.dim }}><Link2 size={13} /> Link Existing</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Ticket ↔ ticket links (relates / duplicate / blocks / blocked by) ─────────
function TicketLinks({ ticket, tickets, onAdd, onRemove, readOnly }) {
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [type, setType] = useState('relates');
  const links = ticket.links || [];
  const byId = (id) => tickets.find((x) => x.id === id);
  const options = tickets.filter((x) => x.id !== ticket.id && !links.some((l) => l.ticketId === x.id));

  const submit = () => { if (!target) return; onAdd(target, type); setTarget(''); setType('relates'); setAdding(false); };

  return (
    <div>
      {links.length === 0 && readOnly && <span style={{ fontSize: 12.5, color: NX.faint }}>No linked tickets</span>}
      {links.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {links.map((l) => {
            const lt = byId(l.ticketId);
            return (
              <div key={l.ticketId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ ...chip(NX.dim, NX.border2), flexShrink: 0 }}>{linkTypeLabel(l.type)}</span>
                <Link2 size={13} style={{ color: NX.faint, flexShrink: 0 }} />
                <span style={{ color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {lt ? `${ticketNoShort(lt.code) ? ticketNoShort(lt.code) + ' · ' : ''}${lt.subject}` : l.ticketId}
                </span>
                {!readOnly && <button onClick={() => onRemove(l.ticketId)} title="Remove link" style={{ ...btn('ghost'), padding: 2, marginLeft: 'auto', color: NX.faint }}><X size={13} /></button>}
              </div>
            );
          })}
        </div>
      )}
      {!readOnly && (<>
      {adding ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <TicketSelect value={type} onChange={setType} style={{ width: 'auto' }}
            options={LINK_TYPES.map((l) => [l.key, l.label])} />
          <TicketSelect value={target} onChange={setTarget} style={{ flex: 1, minWidth: 160 }}
            placeholder="Select a ticket…" searchPlaceholder="Search tickets…" emptyText="No tickets to link."
            options={[['', 'Select a ticket…'],
              ...options.map((x) => [x.id, `${ticketNoShort(x.code) ? `${ticketNoShort(x.code)} · ` : ''}${x.subject}`])]} />
          <button onClick={submit} disabled={!target} style={{ ...btn('primary'), opacity: target ? 1 : 0.5 }}>Link</button>
          <button onClick={() => setAdding(false)} style={btn('ghost')}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}><Link2 size={13} /> Link a ticket</button>
      )}
      </>)}
    </div>
  );
}

// The requester's satisfaction survey, at the top of the Overview tab once it
// is in (Oct 1) - the first thing anyone opening a closed ticket sees.
function SatisfactionCard({ ticket, nameOf }) {
  const rating = ticket.csatRating || 0;
  const tone = rating >= 4 ? NX.green : rating === 3 ? NX.amber : NX.red;
  const who = ticket.requesterId ? (nameOf?.(ticket.requesterId) || ticket.requesterId) : 'The requester';
  return (
    <div data-testid="satisfaction-card" style={{ border: `1px solid ${NX.border}`, borderLeft: `4px solid ${tone}`, borderRadius: 10,
      background: NX.surface2, padding: '10px 14px', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: NX.dim, marginBottom: 6 }}>
        Satisfaction Survey
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} size={18} aria-hidden style={{ color: rating >= n ? NX.amber : NX.border, fill: rating >= n ? NX.amber : 'none' }} />
        ))}
        <span style={{ fontSize: 13.5, fontWeight: 700, color: tone, marginLeft: 8 }}>{CSAT_LABELS[rating] || `${rating}/5`}</span>
        <span style={{ fontSize: 12.5, color: NX.dim, marginLeft: 6 }}>{rating}/5 · rated by {who}</span>
      </div>
      {ticket.csatComment && (
        <p style={{ margin: '8px 0 0', fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap' }}>“{ticket.csatComment}”</p>
      )}
    </div>
  );
}

// ── CSAT - a 1-5 satisfaction rating shown once a ticket is resolved/closed ────
function CsatWidget({ ticket, canRate, onRate, onComment }) {
  const [hover, setHover] = useState(0);
  const rating = ticket.csatRating || 0;
  const [comment, setComment] = useState(ticket.csatComment || '');
  useEffect(() => setComment(ticket.csatComment || ''), [ticket.csatComment]);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} size={22} onClick={() => canRate && onRate(n)} onMouseEnter={() => canRate && setHover(n)} onMouseLeave={() => setHover(0)}
            style={{ cursor: canRate ? 'pointer' : 'default', color: (hover || rating) >= n ? NX.amber : NX.border, fill: (hover || rating) >= n ? NX.amber : 'none' }} />
        ))}
        {rating > 0 && <span style={{ fontSize: 12.5, color: NX.dim, marginLeft: 6 }}>{rating}/5</span>}
      </div>
      {canRate ? (
        <input value={comment} onChange={(e) => setComment(e.target.value)} onBlur={() => { if (comment !== (ticket.csatComment || '')) onComment(comment); }}
          placeholder="Optional feedback…" style={{ ...inputStyle, marginTop: 8 }} />
      ) : ticket.csatComment ? (
        <p style={{ margin: '6px 0 0', fontSize: 12.5, color: NX.dim, fontStyle: 'italic' }}>“{ticket.csatComment}”</p>
      ) : null}
    </div>
  );
}

export { TicketTasks, TicketLinks, SatisfactionCard, CsatWidget };
