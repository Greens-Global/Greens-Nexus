// TicketList - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { Link2, CheckCircle2, Clock, ArrowUp, ArrowDown, ArrowUpDown, ChevronDown, Check } from 'lucide-react';
import { NX, FONT, chip, btn, PRIORITY_META } from '../tasks/theme';
import { Avatar, PriorityChip, UnassignedAvatar, SelectMenu } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import { ColResizer } from '../tasks/tableCols';
import {
  fmtDate,
  TICKET_STATUS_META, CLOSED_STATES,
  SLA_META, slaState, fmtDueAt,
  commentStale, COMMENT_STALE_META, COMMENT_STALE_HOURS,
  APPROVAL_META,
  ticketNoShort,
} from './ticketMeta';
import { TicketTypeIcon, TicketStatusChip } from './TicketAtoms';
import { StatusLabel, PrioritySignal } from '../components/StatusLabel';
import { LatestCommentPreview } from './LatestComment';
import { TicketAssignSheet } from './TicketAssignSheet';
import { statusOptions, priorityOptions, ticketRights } from './ticketViewShared';
import { ApprovalChip } from './TicketApproval';

// Column header for the desktop list view - driven by TICKET_COLUMNS/cols so
// widths, labels and sort keys stay in one place. Each movable cell is
// click-to-sort, drag-to-reorder (useTableColumns' dragProps) and carries a
// resize handle on its trailing edge; checkbox/type/resolved are `fixed` and
// render a blank (or the select-all checkbox) header cell instead. Renders as
// a CSS grid using the shared --nx-grid template, so it lines up with every
// row without either one tracking the other's widths directly - the same
// contract the task list's rich-list grid uses (tasks/views/richlist.jsx).
const TICKET_ROW_H = 44;    // tall enough for the two-line title cell

function TicketListHeader({ cols, widths, startResize, resetWidth, autofitWidth, dragProps, sort, onSort, allSelected, someSelected, onToggleSelectAll }) {
  // Checkbox "indeterminate" (some but not all selected) isn't settable via a
  // JSX prop - it's a DOM-only flag, so it's applied imperatively via a ref.
  const selectAllRef = useRef(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = !!someSelected; }, [someSelected]);
  const headCell = { position: 'relative', display: 'flex', alignItems: 'center', minHeight: 34, padding: '0 10px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  return (
    // Sticky, not just top-of-list - scrolling a long queue used to lose the
    // column labels entirely (Pranshu, Sep 9 2026). Anchored to the module's
    // own scrolling body (the "nx-scroll nx-gutter" div below list/board/
    // reports - .nx-list-scroll itself only handles horizontal overflow),
    // with an opaque background so rows scrolling underneath don't show
    // through. top: -16 (not 0) cancels that scroller's own `padding: 16` -
    // sticky's offset is measured from the padding edge, so top: 0 stuck the
    // header 16px below the scroller's true top edge, leaving a gap the
    // still-scrolling row directly above it could show through (Pranshu, Sep
    // 9 2026 - "header column overlapping"). -16 pins it flush instead.
    <div style={{ position: 'sticky', top: -16, zIndex: 3, display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'stretch', padding: '9px 0', background: NX.surface2, borderBottom: `1px solid ${NX.border}` }}>
      {cols.map((col) => {
        if (col.key === 'checkbox') {
          return (
            <div key="checkbox" style={{ ...headCell, justifyContent: 'center' }}>
              <input ref={selectAllRef} type="checkbox" checked={!!allSelected} onChange={onToggleSelectAll}
                title={allSelected ? 'Deselect all' : 'Select all'} style={{ cursor: 'pointer', width: 15, height: 15, margin: 0, accentColor: NX.blue }} />
            </div>
          );
        }
        // type/resolved are fixed, label-less structure columns - a blank cell
        // keeps the grid template in step without offering anything to drag/sort.
        if (col.fixed) return <div key={col.key} style={headCell} />;
        const drag = dragProps(col.key, true);
        const active = sort.key === col.key;
        const SortIcon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
        return (
          <div key={col.key} {...drag} onClick={() => onSort(col.key)} title={`Sort by ${col.label}`}
            style={{
              ...headCell, cursor: 'pointer', userSelect: 'none',
              // The column being dragged fades; the one it would land on shows
              // the insertion edge, so a drop reads as "it goes there" before
              // the mouse is released - same cue the Task List's drag uses.
              opacity: drag['data-dragging'] ? 0.4 : 1,
              boxShadow: drag['data-dropping'] ? `inset 2px 0 0 ${NX.blue}` : 'none',
            }}>
            <span style={{
              flex: 1, minWidth: 0, fontFamily: FONT, fontSize: 11, fontWeight: 700, color: NX.ink,
              textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{col.label}</span>
            <SortIcon size={11} style={{ flexShrink: 0, marginLeft: 4, opacity: active ? 1 : 0.4 }} />
            <ColResizer onMouseDown={startResize(col.key, widths[col.key] ?? col.width)} onReset={() => resetWidth(col.key)} onAutofit={() => autofitWidth(col.key)} />
          </div>
        );
      })}
    </div>
  );
}

// Click-to-edit State/Priority directly from the list, no drawer (Pranshu,
// Sep 2026 - clicking the pill offers a dropdown right there). Shows
// `children` (the row's status label / priority signal) unchanged at rest; when
// `editable`, a click opens a small anchored option list and picking one
// fires `onChange` immediately. Gated by the SAME canWorking the drawer
// enforces for these exact fields (see TicketRow below) - this is UI
// convenience only, the backend's _ticket_edit_scope is the real boundary
// regardless, same as everywhere else in this file.
function InlineTicketSelect({ value, options, onChange, editable, meta, children }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef(null);
  if (!editable) return children;
  const pick = (id) => {
    setOpen(false);
    if (id === value || busy) return;
    setBusy(true);
    onChange(id).catch((e) => appDialog.alert(`Could not update: ${e.message || e}`)).finally(() => setBusy(false));
  };
  return (
    <div ref={anchorRef} onClick={(e) => { e.stopPropagation(); if (!busy) setOpen((o) => !o); }}
      style={{ display: 'flex', alignItems: 'center', minWidth: 0, width: '100%', height: '100%', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1 }}>
      {children}
      {open && (
        // Portaled to document.body (SelectMenu, position:fixed off the anchor's
        // own rect) rather than absolutely positioned inside this cell - the
        // State/Priority cells are `overflow:hidden` (the solid fills that used
        // to live there needed it to clip to the cell edge), which silently clipped an
        // in-place dropdown to invisible: it existed in the DOM, computed
        // visible/display:block, and still never painted (Pranshu, Sep 9 2026 -
        // reported as "clicking State/Priority does nothing").
        <SelectMenu anchorRef={anchorRef} onClose={() => setOpen(false)} minWidth={170}>
          {options.map(([id, optLabel]) => {
            const m = meta[id] || {};
            const selected = id === value;
            return (
              <div key={id} onClick={(e) => { e.stopPropagation(); pick(id); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', fontSize: 12.5, borderRadius: 6, cursor: 'pointer', color: NX.ink, background: selected ? NX.hover : 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = selected ? NX.hover : 'transparent'; }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color || NX.dim, flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{optLabel}</span>
                {selected && <Check size={13} style={{ color: NX.blue, flexShrink: 0 }} />}
              </div>
            );
          })}
        </SelectMenu>
      )}
    </div>
  );
}

// `mobile` comes from TicketsView, never from a useIsMobile() of the row's own:
// two hooks listening to the same media query flip on separate renders, so on a
// rotate across 640px a row could switch to the desktop grid while its parent
// was still rendering the phone list (which passes no `cols`) and crash the
// whole view on cols.map.
// Memoized, with id-taking callbacks (onOpen(id, tab), onToggle(id)) that
// TicketsView keeps stable - so ticking one checkbox or typing in the search
// box re-renders the rows that changed, not all of them.
const TicketRow = memo(function TicketRow({ t, nameOf, hrDeptName, companyName, myEmail, privileged, updateTicket, onOpen, people, checked, onToggle, cols, band = false, mobile = false }) {
  const isMobile = !!mobile || !Array.isArray(cols);
  const open = () => onOpen(t.id);
  const openConversation = () => onOpen(t.id, 'conversation');
  const toggle = () => onToggle(t.id);
  const [assigning, setAssigning] = useState(false);
  // Resting background: selection wins, then the zebra band. Hover is the
  // .nx-row-hover class (style.css) - the Accounting ledger's whole-row
  // highlight, layered over both (Neil, Oct 1).
  const rowBg = checked ? 'rgba(37,99,235,0.10)' : band ? NX.zebra : NX.surface;
  // Every cell shares this base (minHeight/padding/border) - the same cellPad
  // contract the task rich-list rows use, so the two grids read identically.
  const cell = { minWidth: 0, minHeight: TICKET_ROW_H, display: 'flex', alignItems: 'center', padding: '0 12px', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' };
  const sla = slaState(t);
  // Paused (waiting on the requester) reads as its own quiet state, never late.
  const slaM = (sla === 'breached' || sla === 'at_risk' || sla === 'paused') ? SLA_META[sla] : null;
  const approvalM = t.approvalStatus === 'pending' ? APPROVAL_META.pending : null;
  const staleM = commentStale(t) ? COMMENT_STALE_META : null;
  // The HR department is what routed this ticket, so it belongs on the row.
  const hrDept = t.hrDepartmentId ? hrDeptName(t.hrDepartmentId) : '';

  // Same canWorking the drawer enforces for type/status/priority/assignee/
  // department/resolution - never let the list's inline dropdown drift from
  // it (see TicketDrawer below and InlineTicketSelect above).
  const { canWorking, canEditStatus, requesterOnly: rowRequesterOnly } = ticketRights(t, myEmail, privileged);
  // Assigning is the desk's (the drawer hides Assign To from a requester on an
  // Open ticket) and waits for any approval - the same gates as the drawer.
  const canAssignRow = isMobile && !!people && canWorking && !rowRequesterOnly
    && t.approvalStatus !== 'pending' && !CLOSED_STATES.includes(t.status);

  // Phones: two stacked lines instead of eight columns. Subject leads; the chips
  // and the assignee wrap underneath. Requester, the separate SLA date column and
  // the bulk-select checkbox are dropped - all reachable by opening the ticket,
  // and bulk edit is a desktop job.
  if (isMobile) {
    return (
      <div onClick={open} className="nx-row-hover" data-selected={checked ? 'true' : undefined} style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '11px 12px',
        borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer', background: rowBg,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <TicketTypeIcon type={t.type} size={15} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: NX.ink, lineHeight: 1.35 }}>
              {t.subject}
              {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
            </div>
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>
              {ticketNoShort(t.code) || '-'}{hrDept ? ` · ${hrDept}` : ''}{t.source === 'email' ? ' · Via Email' : ''}
            </div>
          </div>
          {t.resolvedAt && <CheckCircle2 size={16} style={{ color: NX.green, flexShrink: 0 }} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <TicketStatusChip status={t.status} />
          {t.approvalStatus === 'pending' && <ApprovalChip ticket={t} />}
          <PriorityChip priority={t.priority} />
          {/* Words, not icon-only chips with a hover title - a phone has no
              hover. The SLA due date reads as a date (red once breached, amber
              when due soon) and a quiet ticket says it needs a comment. */}
          {(t.slaDueAt || t.slaDueOn) && !CLOSED_STATES.includes(t.status) && (
            <span data-testid="ticket-row-due" title={slaM ? `${slaM.label} - SLA due ${fmtDueAt(t)}` : `SLA due ${fmtDueAt(t)}`}
              style={slaM
                ? { ...chip(slaM.color, slaM.tint), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px', fontWeight: 700 }
                : { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color: NX.dim }}>
              {slaM ? <slaM.Icon size={11} /> : <Clock size={11} style={{ color: NX.faint }} />}
              {sla === 'paused' ? 'Paused' : `Due ${fmtDueAt(t)}`}
            </span>
          )}
          {staleM && (
            <span title={`No comment in over ${COMMENT_STALE_HOURS[t.priority] ?? 24}h - past this priority's check-in window`}
              style={{ ...chip(staleM.color, staleM.tint), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px' }}>
              <staleM.Icon size={11} /> {staleM.label}
            </span>
          )}
          {/* Tap to assign right from the card (Neil, Oct 1: assigning "is
              not working for me on mobile") - a bottom sheet, saved at once
              like the desktop list's inline Status/Priority. Only for someone
              who could assign it in the drawer. */}
          {canAssignRow ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); setAssigning(true); }}
              aria-label={t.assigneeId ? `Assigned to ${nameOf(t.assigneeId) || t.assigneeId} - change` : 'Assign this ticket'}
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, minHeight: 32, padding: '3px 8px 3px 4px',
                border: `1px solid ${NX.border}`, borderRadius: 999, background: NX.surface, cursor: 'pointer', fontFamily: FONT }}>
              {t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} card={false} /> : <UnassignedAvatar size={22} />}
              <span style={{ fontSize: 12.5, color: t.assigneeId ? NX.dim : NX.blue, fontWeight: t.assigneeId ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                {t.assigneeId ? nameOf(t.assigneeId) || t.assigneeId : 'Assign'}
              </span>
              <ChevronDown size={13} style={{ color: NX.faint, flexShrink: 0 }} />
            </button>
          ) : (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              {t.assigneeId
                ? <><Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={20} />
                    <span style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{nameOf(t.assigneeId)}</span></>
                : <UnassignedAvatar size={20} />}
            </span>
          )}
        </div>
        {t.latestComment && (
          <LatestCommentPreview compact comment={t.latestComment} nameOf={nameOf} onOpen={openConversation} />
        )}
        {assigning && (
          <TicketAssignSheet value={t.assigneeId || ''} people={people}
            onPick={(email) => { updateTicket(t.id, { assigneeId: email || '' }).catch((err) => appDialog.alert(`Could not assign: ${err.message || err}`)); }}
            onClose={() => setAssigning(false)} />
        )}
      </div>
    );
  }

  const stateM = TICKET_STATUS_META[t.status] || { label: t.status, color: NX.dim };
  const priM = PRIORITY_META[t.priority] || { label: t.priority, color: NX.dim };

  // Cells are keyed and rendered in `cols`' order (useTableColumns' saved
  // arrangement) rather than a fixed sequence, the same reason
  // tasks/views/richlist.jsx's TaskRow does it - once columns can be
  // dragged, a row that renders them in source order puts every value under
  // the wrong heading the moment someone reorders the header.
  const cells = {
    checkbox: (
      <div style={{ ...cell, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={!!checked} onChange={toggle}
          title="Select" style={{ cursor: 'pointer', width: 15, height: 15, margin: 0, accentColor: NX.blue }} />
      </div>
    ),
    type: (
      <div style={{ ...cell, justifyContent: 'center' }}>
        <TicketTypeIcon type={t.type} size={16} />
      </div>
    ),
    title: (
      <div style={{ ...cell, overflow: 'hidden', textAlign: 'left' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.subject}
            {t.linkedTaskId && <Link2 size={13} style={{ color: NX.faint, marginLeft: 6, verticalAlign: 'middle' }} />}
          </div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1 }}>
            {ticketNoShort(t.code) || '-'}{hrDept ? ` · ${hrDept}` : ''}{t.source === 'email' ? ' · Via Email' : ''}
          </div>
        </div>
      </div>
    ),
    company: (
      <div style={{ ...cell, justifyContent: 'flex-start', overflow: 'hidden' }} title={companyName(t.companyId) || ''}>
        <span style={{ fontSize: 12.5, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companyName(t.companyId) || '-'}</span>
      </div>
    ),
    // Soft labels, not solid fills (Neil, Oct 14 2026): the status as a label,
    // an approval wait as a small label beside it, priority as a signal. Each
    // problem flag lives in its own column - SLA in Due Date, a quiet ticket in
    // Latest Comment - so nothing borrows these cells. Wrapped in
    // InlineTicketSelect so clicking offers a dropdown right there - no drawer.
    state: (
      <div style={{ ...cell, overflow: 'hidden' }} title={approvalM ? `${stateM.label} · awaiting approval` : stateM.label}>
        <InlineTicketSelect value={t.status} options={statusOptions()} meta={TICKET_STATUS_META} editable={canEditStatus}
          onChange={(v) => updateTicket(t.id, { status: v })}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
            <StatusLabel label={stateM.label} color={stateM.color} />
            {approvalM && <StatusLabel size="sm" label={approvalM.label} color={approvalM.color} />}
          </span>
        </InlineTicketSelect>
      </div>
    ),
    priority: (
      <div style={{ ...cell, overflow: 'hidden' }} title={priM.label}>
        <InlineTicketSelect value={t.priority} options={priorityOptions()} meta={PRIORITY_META} editable={canWorking}
          onChange={(v) => updateTicket(t.id, { priority: v })}>
          <PrioritySignal priority={t.priority} title={priM.label} />
        </InlineTicketSelect>
      </div>
    ),
    // The SLA lives here: red with a shield once breached, amber when due
    // within a day, plain otherwise.
    due: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 5, overflow: 'hidden' }}
        title={slaM ? `${slaM.label} - SLA due ${fmtDueAt(t)}` : undefined}>
        {slaM ? <slaM.Icon size={12} style={{ color: slaM.color, flexShrink: 0 }} /> : <Clock size={12} style={{ color: NX.faint, flexShrink: 0 }} />}
        <span style={{ fontSize: 12, color: slaM ? slaM.color : NX.dim, fontWeight: sla === 'breached' || sla === 'at_risk' ? 600 : 400, textAlign: 'left' }}>{fmtDueAt(t)}</span>
      </div>
    ),
    requester: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 6, overflow: 'hidden' }} title={`Requester: ${nameOf(t.requesterId) || 'Unknown'}`}>
        {t.requesterId ? <Avatar email={t.requesterId} name={nameOf(t.requesterId)} size={22} /> : <span style={{ width: 22, flexShrink: 0 }} />}
        <span style={{ fontSize: 12.5, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.requesterId ? nameOf(t.requesterId) : '-'}</span>
      </div>
    ),
    assignee: (
      <div style={{ ...cell, justifyContent: 'flex-start', gap: 6, overflow: 'hidden' }} title={`Assignee: ${t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned'}`}>
        {/* Unassigned is said here, once (Neil, Oct 14 2026): the dashed avatar
            and the word in amber - the row itself is never tinted for it. */}
        {t.assigneeId ? <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} /> : <UnassignedAvatar size={22} />}
        {!t.assigneeId && !CLOSED_STATES.includes(t.status) && <span style={{ fontSize: 12.5, fontWeight: 600, color: NX.amber, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>Unassigned</span>}
        {t.assigneeId && <span style={{ fontSize: 12.5, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(t.assigneeId)}</span>}
      </div>
    ),
    created: (
      <div style={{ ...cell, justifyContent: 'flex-start', overflow: 'hidden' }} title={t.createdAt ? `Created ${fmtDate(t.createdAt)}` : ''}>
        <span style={{ fontSize: 12, color: NX.dim, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.createdAt ? fmtDate(t.createdAt) : '-'}</span>
      </div>
    ),
    // A ticket past its priority's check-in window says so here, beside the
    // last comment it is missing (Oct 14 2026 - it used to be a second solid
    // block in the Priority cell).
    latestComment: (
      <div style={{ ...cell, overflow: 'hidden', padding: '0 10px', gap: 8 }}>
        {staleM && (
          <span title={`No comment in over ${COMMENT_STALE_HOURS[t.priority] ?? 24}h - past this priority's check-in window`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, color: staleM.color, whiteSpace: 'nowrap' }}>
            <staleM.Icon size={13} /> {staleM.label}
          </span>
        )}
        {(t.latestComment || !staleM) && (
          <div style={{ minWidth: 0, flex: 1 }}>
            <LatestCommentPreview comment={t.latestComment} nameOf={nameOf} onOpen={openConversation} />
          </div>
        )}
      </div>
    ),
    // Resolved shows as a green check, but resolving is never a one-click row
    // action (Neil, Oct 19): a ticket is a conversation, so it is resolved from
    // inside it with a written resolution.
    resolved: (
      <div style={{ ...cell, justifyContent: 'center', borderRight: 'none', padding: 0 }}>
        {t.resolvedAt && <CheckCircle2 size={16} style={{ color: NX.green }} title={`Resolved ${fmtDate(t.resolvedAt)}`} />}
      </div>
    ),
  };

  return (
    <div onClick={open} className="nx-row-hover" data-selected={checked ? 'true' : undefined} style={{
      display: 'grid', gridTemplateColumns: 'var(--nx-grid)', alignItems: 'stretch',
      borderBottom: `1px solid ${NX.border}`, cursor: 'pointer', background: rowBg,
    }}>
      {cols.map((c) => <Fragment key={c.key}>{cells[c.key]}</Fragment>)}
    </div>
  );
});

export { TicketListHeader, TicketRow };
