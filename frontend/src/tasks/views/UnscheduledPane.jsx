// Task Module - the Calendar's Unscheduled pane (Neil, Oct 22 2026; Microsoft
// Planner parity). The open tasks with no due date, beside the calendar they
// would otherwise be missing from. Its rows are the calendar's own task set
// (calendarMove.unscheduledTasks), so the filters, the project scope and the
// subtask rule the calendar was handed apply here unchanged.
//
// Desktop: a collapsible column on the calendar's right. A row dragged onto a
// day is scheduled there; a dated chip dragged onto the pane loses its due
// date. Both go through the calendar's one date path (CalendarView
// moveTask -> calendarMove.calendarDatePatch), so the approval hold, the
// held start date, the repeating-task refusal and Undo are the drag's own.
// Phones: a full-screen sheet (the shared Modal) opened from the toolbar's
// "Unscheduled (N)" button, with no drag - every row's Schedule button does it.
// Read-only people see the rows, with no drag and no Schedule button.
import { useMemo, useState } from 'react';
import { CalendarOff, PanelRightClose, Search } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from '../theme';
import { Avatar, PriorityChip, DateField } from '../components';
import { taskAssignees } from '../lib';
import { projectLook } from '../projectLook';
import { unscheduledTasks } from '../calendarMove';
import { useRowColorMap } from '../rowColorState';

// Rows drawn at most - a project with thousands of undated tasks must not
// slow the calendar beside it. The search narrows to what is wanted.
export const UNSCHEDULED_CAP = 200;

/**
 * `tasks`: the calendar's task set. `canSchedule(t)`: may this person date it
 * (an editor, not completed). `onSchedule(id, iso)`: the calendar's date path.
 * `dragId` / `onDragRow(id)` / `onDragEnd()`: the calendar's shared drag.
 * `clearTarget`: a dated chip this person may change is being dragged, so the
 * pane takes it as a drop that clears its due date (`onDropClear`).
 * `sheet`: drawn inside the phone sheet - no header (the sheet has one), no drag.
 */
export default function UnscheduledPane({
  tasks, store, onOpen, lockedProjectId = null, canSchedule, onSchedule,
  dragId = null, onDragRow, onDragEnd, clearTarget = false, onDropClear, onCollapse, sheet = false,
}) {
  const [search, setSearch] = useState('');
  const [over, setOver] = useState(false);
  const rowColors = useRowColorMap();
  const { all, rows } = useMemo(() => unscheduledTasks(tasks, search), [tasks, search]);
  const shown = rows.length > UNSCHEDULED_CAP ? rows.slice(0, UNSCHEDULED_CAP) : rows;
  const projectOf = (id) => (id ? (store?.projects || []).find((p) => p.id === id) : null);
  const nameOf = store?.nameOf;
  const hot = clearTarget && over;

  const dropProps = clearTarget ? {
    onDragOver: (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => { e.preventDefault(); setOver(false); onDropClear?.(); },
  } : {};

  const row = (t) => {
    const editable = !!canSchedule?.(t);
    const drag = editable && !sheet;
    const proj = !lockedProjectId ? projectOf(t.projectId) : null;
    const projColor = projectLook(proj, NX.purple).color;
    const people = taskAssignees(t);
    const rc = rowColors?.get(t.id) || null;
    return (
      <div key={t.id} data-unscheduled={t.id} role="group" aria-label={t.title} data-row-color={rc?.id}
        draggable={drag || undefined}
        onDragStart={drag ? (e) => { onDragRow?.(t.id); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); } catch { /* no dataTransfer (tests) */ } } : undefined}
        onDragEnd={drag ? onDragEnd : undefined}
        onClick={() => onOpen(t.id)}
        title={drag ? 'Drag onto a day to set its due date' : undefined}
        style={{
          padding: '8px 10px', borderRadius: 10, border: `1px solid ${NX.border}`, background: NX.surface,
          cursor: drag ? 'grab' : 'pointer', opacity: dragId === t.id ? 0.45 : 1,
          boxShadow: rc ? `inset 3px 0 0 ${rc.hex}` : undefined,
        }}>
        {/* The title is the row's keyboard handle: Enter opens the task. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <button type="button" title={t.title} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}
            style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: 0, textAlign: 'left', cursor: 'inherit', fontFamily: FONT, fontSize: 12.5, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.title}
          </button>
          {editable && (
            // The no-drag path: keyboard, phones. The calendar opens in a
            // portal, whose clicks still bubble through React to this row -
            // stopped here so picking a day does not also open the task.
            <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ flexShrink: 0, display: 'inline-flex' }}>
              <DateField value="" placeholder="Schedule" title={`Schedule "${t.title}"`} noPast color={NX.blue}
                onChange={(v) => { if (v) onSchedule?.(t.id, v); }}
                style={{ border: `1px solid ${NX.border}`, borderRadius: 7, padding: sheet ? '7px 12px' : '2px 7px', fontSize: sheet ? 13 : 11.5, fontWeight: 600, gap: 5 }} />
            </span>
          )}
        </div>
        {(proj || t.priority || people.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, minWidth: 0 }}>
            {proj && (
              <span style={{ padding: '1px 7px', borderRadius: 5, fontSize: 10.5, fontWeight: 600, background: `${projColor}1a`, color: projColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>{proj.name}</span>
            )}
            {t.priority && <span style={{ flexShrink: 0, display: 'inline-flex' }}><PriorityChip priority={t.priority} /></span>}
            {people.length > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, marginLeft: 'auto' }}>
                {people.slice(0, 3).map((a, i) => (
                  <span key={a} style={{ display: 'inline-flex', marginLeft: i ? -6 : 0, borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}` }}>
                    <Avatar email={a} name={nameOf?.(a)} size={18} />
                  </span>
                ))}
                {people.length > 3 && <span style={{ fontSize: 10.5, color: NX.faint, marginLeft: 3 }}>+{people.length - 3}</span>}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section aria-label="Unscheduled tasks" data-testid="unscheduled-pane" {...dropProps}
      style={{
        display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', fontFamily: FONT,
        background: hot ? `${NX.primary}14` : 'transparent', boxShadow: hot ? `inset 0 0 0 2px ${NX.primary}` : 'none',
        borderRadius: sheet ? 0 : 16, transition: 'background .1s',
      }}>
      {!sheet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px 14px' }}>
          <CalendarOff size={15} style={{ color: NX.dim, flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>Unscheduled</span>
          <span aria-label={`${all.length} unscheduled`} style={{ fontSize: 12, fontWeight: 600, color: NX.faint, fontVariantNumeric: 'tabular-nums' }}>{all.length}</span>
          {onCollapse && (
            <button type="button" onClick={onCollapse} title="Hide Unscheduled" aria-label="Hide Unscheduled"
              style={{ ...btn('ghost'), padding: 4, marginLeft: 'auto', color: NX.faint }}><PanelRightClose size={16} /></button>
          )}
        </div>
      )}
      {all.length > 0 && (
        <div style={{ position: 'relative', padding: sheet ? '0 0 10px' : '0 12px 8px' }}>
          <Search size={13} style={{ position: 'absolute', left: sheet ? 9 : 21, top: 9, color: NX.faint, pointerEvents: 'none' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search unscheduled…" aria-label="Search unscheduled tasks"
            style={{ ...inputStyle, padding: '6px 10px 6px 28px', fontSize: sheet ? 16 : 12.5 }} />
        </div>
      )}
      {clearTarget && (
        <div role="status" style={{ margin: sheet ? '0 0 8px' : '0 12px 8px', padding: '8px 10px', borderRadius: 10, border: `1.5px dashed ${hot ? NX.primary : NX.border}`, fontSize: 12, color: hot ? NX.primary : NX.dim, textAlign: 'center' }}>
          Drop here to remove the due date
        </div>
      )}
      <div className={sheet ? 'nx-fill' : 'nx-scroll'} style={{ flex: 1, minHeight: 0, overflowY: sheet ? 'visible' : 'auto', padding: sheet ? 0 : '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {all.length === 0 ? (
          <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12.5, color: NX.dim }}>Every task here has a due date.</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12.5, color: NX.dim }}>No unscheduled tasks match your search.</div>
        ) : (
          <>
            {shown.map(row)}
            {rows.length > shown.length && (
              <div style={{ padding: '6px 4px', fontSize: 11.5, color: NX.faint }}>
                Showing {shown.length} of {rows.length} - search to narrow down
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
