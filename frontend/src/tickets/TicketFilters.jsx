// TicketFilters - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useRef, useState } from 'react';
import { Plus, X, Bookmark, SlidersHorizontal, MoreHorizontal, Download } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';
import { Modal } from '../tasks/components';
import { BottomSheet } from '../tasks/MobileTaskBar';
import { requiredHint, label, field } from './ticketMeta';
import { TicketSelect } from './TicketAtoms';
import AnchoredMenu from '../components/AnchoredMenu';
import {
  TICKET_COLUMNS,
  priorityOptions, typeOptions, slaFilterOptions,
  statusFilterOptions, serviceAreaOptions, groupByOptions,
} from './ticketViewShared';

// The phone's Sort By choices - the keys the desktop column headers sort on
// (TICKET_COLUMNS[].sort), each in the direction someone usually wants it.
// Newest First (created, desc) is the list's default.
const MOBILE_SORTS = [
  ['updated:desc', 'Recently Updated'],
  ['clock:asc', 'Next Clock'],
  ['created:desc', 'Newest First'],
  ['created:asc', 'Oldest First'],
  ['updated:desc', 'Recently Updated'],
  ['clock:asc', 'Next Clock'],
  ['priority:asc', 'Priority'],
  ['state:asc', 'Status'],
  ['latestComment:desc', 'Latest Comment'],
  ['title:asc', 'Title (A-Z)'],
  ['company:asc', 'Company (A-Z)'],
  ['requester:asc', 'Requester (A-Z)'],
  ['assignee:asc', 'Assignee (A-Z)'],
];
const sortValueOf = (sort) => `${sort?.key || 'created'}:${sort?.dir === 'asc' ? 'asc' : 'desc'}`;
// A sort picked from a desktop header (say Title, descending) and carried over
// by a rotate still reads as itself instead of a blank picker.
function mobileSortOptions(sort) {
  const cur = sortValueOf(sort);
  if (MOBILE_SORTS.some(([v]) => v === cur)) return MOBILE_SORTS;
  const col = TICKET_COLUMNS.find((c) => c.key === sort?.key);
  if (!col?.sort) return MOBILE_SORTS;
  return [...MOBILE_SORTS, [cur, `${col.label} (${sort.dir === 'asc' ? 'Ascending' : 'Descending'})`]];
}

// Every filter the desktop toolbar shows, stacked into the mobile bar's sheet.
// Changes apply immediately - the sheet is a view onto the same state, so there
// is nothing to "save" and no way to lose a selection by dismissing it.
function TicketMobileFilters({
  onClose, statusFilter, setStatusFilter, priorityFilter, setPriorityFilter,
  typeFilter, setTypeFilter, slaFilter, setSlaFilter, hrDeptFilter, setHrDeptFilter, hrDepts,
  serviceAreaFilter, setServiceAreaFilter, assigneeFilter, setAssigneeFilter, assigneeOptions,
  groupBy, setGroupBy, showGroup, showSort = true, sort, setSort, onClearAll,
}) {
  const row = { width: '100%', fontSize: 15, padding: '10px 12px' };
  // Clear All only when there is something to clear - the same seven filters
  // TicketFilterMenu counts on desktop.
  const anyFilter = [statusFilter, priorityFilter, typeFilter, slaFilter, hrDeptFilter, serviceAreaFilter, assigneeFilter]
    .some((v) => v !== 'all');
  const wrap = { marginBottom: 14 };
  const lab = { ...label, fontSize: 12.5 };
  // MobileTaskBar renders filterSheet(...) raw - the caller supplies the sheet
  // chrome (same contract as the task module's MobileFilters).
  return (
    <BottomSheet title="Filter, Sort & Group" onClose={onClose}>
      {/* Phones have no column headers to tap, so the sort the desktop list
          takes from its headers lives here - the same `sort` state. Only the
          list is sorted (Board and Reports get the unsorted set), so like
          Group By it is hidden on the other views. */}
      {showSort && sort && setSort && (
        <div style={wrap}>
          <label style={lab}>Sort By</label>
          <TicketSelect value={sortValueOf(sort)} style={row}
            options={mobileSortOptions(sort)}
            onChange={(v) => { const [key, dir] = String(v).split(':'); setSort({ key, dir: dir === 'asc' ? 'asc' : 'desc' }); }} />
        </div>
      )}
      <div style={wrap}>
        <label style={lab}>Status</label>
        <TicketSelect value={statusFilter} onChange={setStatusFilter} options={statusFilterOptions()} style={row} />
      </div>
      <div style={wrap}>
        <label style={lab}>Priority</label>
        <TicketSelect value={priorityFilter} onChange={setPriorityFilter} style={row}
          options={[['all', 'All Priorities'], ...priorityOptions()]} />
      </div>
      <div style={wrap}>
        <label style={lab}>Type</label>
        <TicketSelect value={typeFilter} onChange={setTypeFilter} style={row}
          options={[['all', 'All Types'], ...typeOptions()]} />
      </div>
      <div style={wrap}>
        <label style={lab}>SLA</label>
        <TicketSelect value={slaFilter} onChange={setSlaFilter} options={slaFilterOptions} style={row} />
      </div>
      {hrDepts.length > 0 && (
        <div style={wrap}>
          <label style={lab}>Department</label>
          <TicketSelect value={hrDeptFilter} onChange={setHrDeptFilter} style={row} searchPlaceholder="Search departments…"
            options={[['all', 'All Departments'], ['', 'No Department'], ...hrDepts.map((d) => [d.id, d.name])]} />
        </div>
      )}
      <div style={wrap}>
        <label style={lab}>Service Area</label>
        <TicketSelect value={serviceAreaFilter} onChange={setServiceAreaFilter} style={row}
          options={[['all', 'All Service Areas'], ['', 'Not Set'], ...serviceAreaOptions()]} />
      </div>
      {assigneeOptions.length > 0 && (
        <div style={wrap}>
          <label style={lab}>Assignee</label>
          <TicketSelect value={assigneeFilter} onChange={setAssigneeFilter} style={row} searchPlaceholder="Search people…"
            options={[['all', 'Anyone'], ...assigneeOptions]} />
        </div>
      )}
      {showGroup && (
        <div style={wrap}>
          <label style={lab}>Group By</label>
          <TicketSelect value={groupBy} onChange={setGroupBy} options={groupByOptions()} style={row} />
        </div>
      )}
      {/* Pinned to the bottom of the sheet's scroll area (the phone create
          form's technique): with every filter showing, the sheet is taller than
          the screen and Done used to sit below the fold. Negative margins let
          the bar span the sheet's full width over its padding - the bottom
          padding is 16px PLUS the safe-area inset (BottomSheet), so the bar
          cancels both and pads itself back out, reaching the sheet's edge on
          Face ID iPhones with nothing scrolling visibly underneath. */}
      <div style={{
        position: 'sticky', bottom: 'calc(-16px - env(safe-area-inset-bottom))', zIndex: 2, background: NX.surface,
        borderTop: `1px solid ${NX.border2}`, marginTop: 6,
        marginLeft: -16, marginRight: -16, marginBottom: 'calc(-16px - env(safe-area-inset-bottom))',
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {anyFilter && onClearAll && (
          <button type="button" onClick={onClearAll}
            style={{ ...btn('outline'), flex: '0 0 auto', justifyContent: 'center', padding: '11px 14px', fontSize: 15 }}>Clear All</button>
        )}
        <button type="button" onClick={onClose} style={{ ...btn('primary'), flex: 1, justifyContent: 'center', padding: '11px 0', fontSize: 15 }}>Done</button>
      </div>
    </BottomSheet>
  );
}

// Desktop filter popover. The five selects used to sit inline in the toolbar,
// which is what made the header two crowded rows; behind one button they match
// the task module's Filters control. Shows a count so a narrowed list is never
// mistaken for an empty one.
function TicketFilterMenu({
  statusFilter, setStatusFilter, priorityFilter, setPriorityFilter, typeFilter, setTypeFilter,
  slaFilter, setSlaFilter, hrDeptFilter, setHrDeptFilter, hrDepts,
  serviceAreaFilter, setServiceAreaFilter, assigneeFilter, setAssigneeFilter, assigneeOptions,
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  // Every filter here is a TicketSelect, whose options render in their own
  // document.body portal (SelectMenu). A plain containment check saw a pick
  // as "outside" and closed the WHOLE panel before the option's click ran
  // (Pranshu, Sep 9). AnchoredMenu counts taps routed through its React tree
  // - portals included - as inside, so the backdrop workaround is gone and
  // the panel can no longer be clipped by the toolbar on a phone.
  const active = [statusFilter, priorityFilter, typeFilter, slaFilter, hrDeptFilter, serviceAreaFilter, assigneeFilter].filter((v) => v !== 'all').length;
  const rowStyle = { width: '100%' };
  const wrap = { marginBottom: 10 };
  const lab = { ...label, fontSize: 12 };
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((o) => !o)} title="Filters" aria-haspopup="dialog" aria-expanded={open} style={{ ...btn('outline'), borderColor: active ? NX.blue : NX.border, color: active ? NX.blue : NX.ink }}>
        <SlidersHorizontal size={15} /> Filters{active ? ` (${active})` : ''}
      </button>
      <AnchoredMenu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} align="end" role="dialog" aria-label="Filters"
        style={{ width: 260, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 12 }}>
        <div style={wrap}>
          <label style={lab}>Status</label>
          <TicketSelect value={statusFilter} onChange={setStatusFilter} options={statusFilterOptions()} style={rowStyle} />
        </div>
        <div style={wrap}>
          <label style={lab}>Priority</label>
          <TicketSelect value={priorityFilter} onChange={setPriorityFilter} style={rowStyle}
            options={[['all', 'All Priorities'], ...priorityOptions()]} />
        </div>
        <div style={wrap}>
          <label style={lab}>Type</label>
          <TicketSelect value={typeFilter} onChange={setTypeFilter} style={rowStyle}
            options={[['all', 'All Types'], ...typeOptions()]} />
        </div>
        <div style={wrap}>
          <label style={lab}>SLA</label>
          <TicketSelect value={slaFilter} onChange={setSlaFilter} options={slaFilterOptions} style={rowStyle} />
        </div>
        {hrDepts.length > 0 && (
          <div style={wrap}>
            <label style={lab}>Department</label>
            <TicketSelect value={hrDeptFilter} onChange={setHrDeptFilter} style={rowStyle} searchPlaceholder="Search departments…"
              options={[['all', 'All Departments'], ['', 'No Department'], ...hrDepts.map((d) => [d.id, d.name])]} />
          </div>
        )}
        <div style={wrap}>
          <label style={lab}>Service Area</label>
          <TicketSelect value={serviceAreaFilter} onChange={setServiceAreaFilter} style={rowStyle}
            options={[['all', 'All Service Areas'], ['', 'Not Set'], ...serviceAreaOptions()]} />
        </div>
        {assigneeOptions.length > 0 && (
          <div style={wrap}>
            <label style={lab}>Assignee</label>
            <TicketSelect value={assigneeFilter} onChange={setAssigneeFilter} style={rowStyle} searchPlaceholder="Search people…"
              options={[['all', 'Anyone'], ...assigneeOptions]} />
          </div>
        )}
        {active > 0 && (
          <button onClick={() => { setStatusFilter('all'); setPriorityFilter('all'); setTypeFilter('all'); setSlaFilter('all'); setHrDeptFilter('all'); setServiceAreaFilter('all'); setAssigneeFilter('all'); }}
            style={{ ...btn('ghost'), width: '100%', justifyContent: 'center', color: NX.red, fontSize: 12.5 }}>Clear Filters</button>
        )}
      </AnchoredMenu>
    </>
  );
}

// The desk's one overflow menu (10/31/2026): every occasional control in one
// place - Group By, Columns, Export, the saved views (with their delete; the
// views themselves are tabs in the bar), Save Current View, and the property
// link clean-up - so the toolbar stays List / Board / Reports, search, Filters
// and this. It renders the same on every view; what does not apply (grouping
// and columns outside the list) is simply absent.
function MoreMenu({ views, onApply, onSave, onDelete, groupBy, setGroupBy, showGroup,
  onExport, columns, hidden, toggleHidden, cols, showColumns = false, suggestLinks = null }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const item = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', fontSize: 13, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, color: NX.ink, textAlign: 'left' };
  const sectionLabel = { padding: '8px 12px 4px', fontSize: 12, fontWeight: 600, color: NX.dim };
  const rule = <div style={{ borderTop: `1px solid ${NX.border2}` }} />;
  // Hiding the last data column would leave only the checkbox / type /
  // resolved gutters - that one stays checked and disabled.
  const hideable = (columns || []).filter((c) => !c.fixed);
  const visibleCount = (cols || []).filter((c) => !c.fixed).length;
  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), padding: '7px 9px' }}
        title="More" aria-label="More" aria-haspopup="menu" aria-expanded={open}>
        <MoreHorizontal size={16} />
      </button>
      {/* The "Group by" TicketSelect's portaled list counts as inside. */}
      <AnchoredMenu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} align="end" minWidth={250}
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', fontFamily: FONT, maxHeight: '70vh', overflowY: 'auto' }}>
        {showGroup && (
          <>
            <div style={sectionLabel}>Group By</div>
            <div style={{ padding: '0 12px 10px' }}>
              <TicketSelect value={groupBy} onChange={setGroupBy} options={groupByOptions()} style={{ width: '100%' }} />
            </div>
            {rule}
          </>
        )}
        {showColumns && hideable.length > 0 && (
          <>
            <div style={sectionLabel}>Show Columns</div>
            <div style={{ padding: '0 6px 6px' }}>
              {hideable.map((c) => {
                const checked = !(hidden || []).includes(c.key);
                const lastOne = checked && visibleCount <= 1;
                return (
                  <label key={c.key} style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 6px', boxSizing: 'border-box',
                    borderRadius: 6, cursor: lastOne ? 'default' : 'pointer', fontSize: 13, color: NX.ink,
                  }}>
                    <input type="checkbox" checked={checked} disabled={lastOne} onChange={() => toggleHidden(c.key)} />
                    {c.label}
                  </label>
                );
              })}
            </div>
            {rule}
          </>
        )}
        <div style={sectionLabel}>Saved Views</div>
        {views.length === 0 && <div style={{ padding: '0 12px 8px', fontSize: 12.5, color: NX.faint }}>No saved views yet.</div>}
        {views.map((v) => (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center' }}>
            <button onClick={() => { onApply(v); setOpen(false); }} style={{ ...item, flex: 1, minWidth: 0 }}>
              <Bookmark size={13} style={{ color: NX.faint, flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
            </button>
            <button onClick={() => { setOpen(false); onDelete(v); }} title="Delete view" aria-label={`Delete view ${v.name}`} style={{ ...btn('ghost'), padding: 6, color: NX.faint }}><X size={13} /></button>
          </div>
        ))}
        <button onClick={() => { onSave(); setOpen(false); }} style={{ ...item, color: NX.blue, fontWeight: 600 }}><Plus size={14} />Save Current View…</button>
        {rule}
        {onExport && (
          <button onClick={() => { setOpen(false); onExport(); }} style={item} title="Export the tickets on screen to CSV">
            <Download size={14} style={{ color: NX.faint }} />Export CSV
          </button>
        )}
        {/* The property clean-up's own button and dialog, styled as a row. */}
        {suggestLinks && <div onClick={() => setOpen(false)}>{suggestLinks(item)}</div>}
      </AnchoredMenu>
    </>
  );
}

// Names a saved view - the shared Modal, in place of window.prompt. `onSave`
// returns a promise; a failure stays in the dialog with the reason.
export function SaveViewDialog({ onSave, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setErr('');
    try { await onSave(name.trim()); onClose(); }
    catch (e) { setErr(`Could not save the view: ${e?.message || e}`); setBusy(false); }
  };
  return (
    <Modal title="Save View" onClose={onClose} minHeight="60vh" isDirty={!!name.trim() && !busy} onSave={go} footer={
      <>
        <button style={btn('outline')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: busy || !name.trim() ? 0.6 : 1 }} onClick={go} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save View'}
        </button>
      </>
    }>
      <div style={field}>
        <label style={label} htmlFor="ticket-view-name">View Name</label>
        <input id="ticket-view-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
          placeholder="e.g. My open hardware tickets" style={{ ...inputStyle, fontFamily: FONT }} />
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
          Saves the tab, filters, department, search, sort and grouping you have on screen now.
        </div>
        {err && <div role="alert" style={{ ...requiredHint, marginTop: 8 }}>{err}</div>}
      </div>
    </Modal>
  );
}

export { TicketMobileFilters, TicketFilterMenu, MoreMenu };
