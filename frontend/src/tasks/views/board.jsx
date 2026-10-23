// Task Module - Board view (1:1 port of the export's NexusBoardView).
// Columns with drag-and-drop, per-column WIP limits (Status columns),
// collapsible columns, an "Add Column" column that creates a custom status,
// an inline comment composer on cards, and orthogonal swimlanes. Grey
// columns, white cards.
//
// Planner's board (Oct 22 2026): the columns are a choice - Status (built-in
// plus custom statuses), Section (a project's Custom sections), Priority or
// Due Date - and the swimlanes are the toolbar's Group on Board (None /
// Assignee / Priority / Project / Label / a select field; boardLayout.js).
// Cards can show a preview under their title (CardPreview.jsx).
//
// On the Tasks workspace the toolbar owns the Group and Columns choices
// (`group` / `columns` props); a board without them (My Tasks) keeps its own
// small Group / Columns menus here, so a screen never has two of either.
import { useMemo, useRef, useState } from 'react';
import {
  Circle, CheckCircle2, MessageSquare, Diamond, Plus, Trash2, ChevronsLeft, ChevronsRight,
  MoreHorizontal, Gauge, Rows3, ChevronDown, ListChecks, ArrowRightLeft, Check, CornerDownRight, ListTree,
  Columns3, Image as ImageIcon,
} from 'lucide-react';
import { useCanEditTask } from '../canEditTask';
import { NX, FONT, btn, input as inputStyle, STATUS_META, STATUS_ORDER, PRIORITY_META } from '../theme';
import { cfFieldId, taskFieldValue, fieldsForProject, taskAssignees, requiredFieldsFor, effectiveProjectId, withTaskFields } from '../lib';
import { useFlip } from '../../lib/motion';
import ChangeFlash from '../../components/ChangeFlash';
import { changedRecently } from '../recentChanges';
import { statusesForProject } from '../TasksContext';
import { Avatar, PriorityChip } from '../components';
import { fmtDate, todayISO, wipStorageKey } from '../lib';
import DueBadge from '../DueBadge';
import AnchoredMenu from '../../components/AnchoredMenu';
import { useRowColorMap, rowColorAttrs, boldTitleStyle } from '../rowColorState';
import { projectLook } from '../projectLook';
import {
  boardSetup, boardHasSections, PRIORITY_COLUMNS, dueColumns, dueColumnOf, labelLaneTags, assigneeLanePeople, laneAddDefaults,
} from '../boardLayout';
import { moveTaskToDay } from '../calendarMove';
import CardPreview from '../CardPreview';

const SECTION_PALETTE = ['#4573fa', '#8b6bf0', '#14a76c', '#e8a33d', '#e0844e', '#e8384f', '#29a8ab', '#db2777'];
const PRIORITY_LANE_ORDER = ['urgent', 'high', 'medium', 'low'];
const DUE_COLORS = { overdue: NX.red, today: NX.amber, tomorrow: NX.blue, week: NX.purple, nextweek: NX.teal, later: NX.dim, none: NX.faint };

const dueColor = (iso, completed) => {
  if (!iso || completed) return NX.faint;
  const today = todayISO();
  if (iso < today) return NX.red;
  if (iso === today) return NX.amber;
  return NX.dim;
};
const fmtDue = (iso) => fmtDate(iso);

// defaultAssigneeId: who cards added from a column header belong to. My Tasks
// passes the current user - a task created there with no assignee would drop
// straight out of the view.
// Per-column card render cap. Each card is heavy; an unfiltered board can have
// thousands of tasks in one status column, which freezes the tab. Cap the cards
// drawn per column (headers/counts stay accurate) and show a "+N more" note -
// same reasoning as the list view's render cap.
const MAX_BOARD_CARDS = 100;

// Per-board WIP limits - see wipStorageKey (lib.js).
const readWip = (key) => {
  try { const v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
function MoreCards({ n }) {
  return (
    <div style={{ padding: '6px 4px', fontSize: 12, color: NX.faint, fontFamily: FONT }}>
      + {n} more - search or filter to narrow down
    </div>
  );
}

/** A label lane's header - the plain label pill the task drawer uses. */
export function LabelPill({ label }) {
  return (
    <span data-testid="label-pill" style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: NX.dim, background: NX.border2 }}>
      {label}
    </span>
  );
}

// showSubtasks / onToggleSubtasks (Oct 22 2026): the workspace's "Show
// Subtasks" switch - when it is on, `visible` already holds the subtasks and
// each one is a card of its own (with a "Subtask of" line). Without
// onToggleSubtasks (My Tasks, which lists subtasks anyway) no switch shows.
//
// group / columns (Oct 22 2026): the stored swimlanes and columns, owned by
// the workspace's toolbar. A value the board does not offer here falls back
// to None / Status without being written back. Left undefined, the board
// keeps its own (My Tasks). sections: the project's Custom sections
// (useCustomSections) for Section columns. cardPreviews /
// onToggleCardPreviews: the "Card Previews" switch, on by default.
export default function BoardView({
  visible, ctx, store, onOpen, lockedProjectId, defaultAssigneeId = '', onFullCreate, showSubtasks = false, onToggleSubtasks = null,
  group, columns, sections = null, cardPreviews, onToggleCardPreviews = null,
}) {
  // A read-only person sees the cards but cannot drag them or move them
  // between columns (Oct 22 2026) - the server refuses it anyway.
  const canEditTask = useCanEditTask(store);
  // Conditional row colors (Oct 22 2026): a card wears its rule's color as an
  // inset accent on its left edge - no tint on a card.
  const rowColors = useRowColorMap();
  const [dragId, setDragId] = useState(null);
  // Which lane the card was picked up FROM. With a task able to sit in
  // several assignee (or label) lanes at once, the destination alone no
  // longer says what the drag meant - see drop().
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [addIn, setAddIn] = useState(null);
  const [commentOpenId, setCommentOpenId] = useState(null);
  const [draft, setDraft] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  // My Tasks: the board's own choices (the workspace passes its toolbar's).
  const [ownLanes, setOwnLanes] = useState('none');
  const [ownColumns, setOwnColumns] = useState('status');
  const [ownPreviews, setOwnPreviews] = useState(true);
  const lanesControlled = group !== undefined;
  const columnsControlled = columns !== undefined;
  const showPreviews = cardPreviews !== undefined ? !!cardPreviews : ownPreviews;
  const togglePreviews = onToggleCardPreviews || (cardPreviews === undefined ? () => setOwnPreviews((v) => !v) : null);
  // Select-type custom fields become swimlane choices too. Memoized because `lanes`
  // depends on it, and a fresh array every render would defeat that memo.
  const boardFields = useMemo(
    () => fieldsForProject(store.customFields || [], lockedProjectId)
      .filter((f) => f.type === 'select' && (f.options || []).length),
    [store.customFields, lockedProjectId],
  );
  const hasSections = boardHasSections(lockedProjectId, sections);
  const lanesIn = lanesControlled ? group : ownLanes;
  const columnsIn = columnsControlled ? columns : ownColumns;
  const setup = useMemo(() => boardSetup({ lanes: lanesIn, columns: columnsIn, lockedProjectId, fields: boardFields, hasSections }),
    [lanesIn, columnsIn, lockedProjectId, boardFields, hasSections]);
  const swimlane = setup.lanes;
  const colKind = setup.columns;
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState('');
  // Cards glide when a drop, a status change or a filter moves them.
  const flipRef = useRef(null);
  useFlip(flipRef);
  const wipKey = wipStorageKey(lockedProjectId, defaultAssigneeId);
  const [wipState, setWipState] = useState(() => ({ key: wipKey, map: readWip(wipKey) }));
  // Switching to another project's board reads that board's own limits.
  const wip = wipState.key === wipKey ? wipState.map : readWip(wipKey);

  const setLimit = (status, n) => {
    const next = { ...wip };
    if (n == null || n <= 0) delete next[status]; else next[status] = n;
    try { localStorage.setItem(wipKey, JSON.stringify(next)); } catch { /* private mode: this session only */ }
    setWipState({ key: wipKey, map: next });
  };

  // Columns are the statuses THIS project uses (its own plus any global one) -
  // an unscoped list put a status invented for one project on every board.
  // statusMeta below still reads the full list, so a task carrying an
  // out-of-scope status renders its real label instead of a raw id.
  const projectStatuses = useMemo(
    () => statusesForProject(store.customStatuses, lockedProjectId),
    [store.customStatuses, lockedProjectId],
  );
  const customStatusIds = useMemo(() => new Set(projectStatuses.map((s) => s.id)), [projectStatuses]);
  const statuses = useMemo(() => [...STATUS_ORDER, ...projectStatuses.map((s) => s.id)], [projectStatuses]);
  const statusMeta = (key) => STATUS_META[key]
    || (() => { const c = store.customStatuses.find((s) => s.id === key); return c ? { label: c.label, color: c.color, tint: `${c.color}1a` } : { label: key, color: NX.dim, tint: NX.border2 }; })();

  // The columns - each { key, label, color, match(task) } - for the kind
  // chosen. Due Date columns read the viewer's local today.
  const today = todayISO();
  const sectionList = sections?.sections;
  const sectionOf = sections?.sectionOf;
  const cols = useMemo(() => {
    if (colKind === 'priority') {
      return PRIORITY_COLUMNS.map((p) => ({ key: p, label: PRIORITY_META[p]?.label || p, color: PRIORITY_META[p]?.color || NX.dim, match: (t) => (t.priority || 'medium') === p }));
    }
    if (colKind === 'due') {
      return dueColumns(today).map((c) => ({ key: c.key, label: c.label, color: DUE_COLORS[c.key], first: c.first, noDrop: c.key === 'overdue', match: (t) => dueColumnOf(t.dueOn, today) === c.key }));
    }
    if (colKind === 'section') {
      const known = new Set((sectionList || []).map((x) => x.id));
      const of = (t) => { const s = sectionOf ? sectionOf(t) : t.sectionId; return s && known.has(s) ? s : '-'; };
      return [
        { key: '-', label: 'No Section', color: NX.faint, match: (t) => of(t) === '-' },
        ...(sectionList || []).map((x, i) => ({ key: x.id, label: x.name, color: SECTION_PALETTE[i % SECTION_PALETTE.length], match: (t) => of(t) === x.id })),
      ];
    }
    return statuses.map((s) => { const m = statusMeta(s); return { key: s, label: m.label, color: m.color, status: true, match: (t) => t.status === s }; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKind, today, sectionList, sectionOf, statuses, store.customStatuses]);

  const toggleCollapse = (s) => setCollapsed((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });

  // The draft is cleared only once the comment has posted - a refused or
  // dropped post keeps what was typed, with the reason under it.
  const postComment = async (id) => {
    const text = draft.trim();
    if (!text || commentBusy) return;
    setCommentBusy(true); setCommentError('');
    try {
      await store.addComment(id, text);
      setDraft(''); setCommentOpenId(null);
    } catch (e) {
      setCommentError(e?.message || 'The comment did not post. Try again.');
    } finally {
      setCommentBusy(false);
    }
  };

  // Creates a custom STATUS, which is what a board column is here. The control
  // said "Add Section" and Asana sections are a real, different thing that also
  // syncs (Task.section_id) - so the label was claiming to be something it
  // wasn't. Renamed to "Add Column"; the internals keep the older names.
  const createSection = () => {
    if (!sectionName.trim()) return;
    const color = SECTION_PALETTE[store.customStatuses.length % SECTION_PALETTE.length];
    store.createCustomStatus({ label: sectionName.trim(), color }).catch(() => {});
    setSectionName(''); setAddingSection(false);
  };

  const deleteSection = (status) => {
    if (window.confirm(`Delete "${statusMeta(status).label}"? Tasks in it move back to Not Started.`)) {
      for (const t of visible.filter((x) => x.status === status)) store.setStatus(t.id, 'not_started');
      store.deleteCustomStatus(status).catch(() => {});
    }
  };

  // Swimlane rows - derived from the visible tasks so no people directory needed.
  const lanes = useMemo(() => {
    if (swimlane === 'none') return [{ key: 'all', label: '', match: () => true }];
    if (swimlane === 'priority') {
      return PRIORITY_LANE_ORDER
        .map((p) => ({ key: p, label: PRIORITY_META[p]?.label || p, match: (t) => t.priority === p }))
        .filter((l) => visible.some(l.match));
    }
    const cfId = cfFieldId(swimlane);
    if (cfId) {
      const field = boardFields.find((f) => f.id === cfId);
      if (!field) return [{ key: 'all', label: '', match: () => true }];
      const opts = (field.options || []).map((o) => (typeof o === 'string' ? { id: o, label: o } : o));
      const out = opts.map((o) => ({ key: o.id, label: o.label, match: (t) => taskFieldValue(t, cfId) === o.id }));
      if (visible.some((t) => !taskFieldValue(t, cfId))) {
        out.push({ key: '__none', label: `No ${field.name}`, match: (t) => !taskFieldValue(t, cfId) });
      }
      return out.filter((l) => visible.some(l.match));
    }
    if (swimlane === 'label') {
      // Like assignee lanes: a task with several labels is in each label's
      // lane, so the lane counts add up to more than the board holds.
      const seen = new Set();
      for (const t of visible) for (const tag of t.tags || []) if (tag) seen.add(tag);
      const out = [...seen].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
        .map((tag) => ({ key: tag, label: tag, pill: true, match: (t) => (t.tags || []).includes(tag) }));
      if (visible.some((t) => !(t.tags || []).filter(Boolean).length)) {
        out.push({ key: '__none', label: 'No Label', match: (t) => !(t.tags || []).filter(Boolean).length });
      }
      return out;
    }
    if (swimlane === 'assignee') {
      const seen = new Map();
      // A shared task appears in EVERY assignee's lane. Keying lanes on the
      // primary put a task assigned to two people in only the first one's lane,
      // so the second person's row looked empty even though the card's own
      // avatars showed them on it (reported Aug 2026).
      //
      // The counts therefore add up to more than the board holds - the same
      // task is counted for each person carrying it. That is the honest answer
      // to "what is on each person's plate", and matches both the list view's
      // grouping and the Workload view.
      for (const t of visible) {
        for (const a of taskAssignees(t)) if (!seen.has(a)) seen.set(a, ctx.nameOf?.(a) || a);
      }
      const out = [...seen.entries()].map(([id, label]) => ({
        key: id, label, match: (t) => taskAssignees(t).includes(id),
      }));
      if (visible.some((t) => !taskAssignees(t).length)) {
        out.push({ key: '__none', label: 'Unassigned', match: (t) => !taskAssignees(t).length });
      }
      return out;
    }
    // project - a subtask's is its parent's (it may only reach it that way)
    const pid = (t) => effectiveProjectId(t, store.taskById);
    const seen = new Map();
    for (const t of visible) if (pid(t) && !seen.has(pid(t))) seen.set(pid(t), store.projectName(pid(t)));
    const out = [...seen.entries()].map(([id, label]) => ({ key: id, label, match: (t) => pid(t) === id }));
    if (visible.some((t) => !pid(t))) out.push({ key: '__none', label: 'No Project', match: (t) => !pid(t) });
    return out;
  }, [swimlane, visible, ctx, store, boardFields]);

  const taskOf = (id) => (store.tasks || []).find((x) => x.id === id) || visible.find((x) => x.id === id);

  // What landing in column `col` changes - {} when nothing does. Due Date
  // columns are not a field patch: they go through the Calendar's day move
  // (calendarMove.moveTaskToDay), so approvals, the held start date, the
  // repeating-series refusals and Undo behave exactly as a calendar drag.
  const columnPatch = (t, col) => {
    if (colKind === 'status') return col.key !== t.status ? { status: col.key } : {};
    if (colKind === 'priority') return col.key !== (t.priority || 'medium') ? { priority: col.key } : {};
    // A subtask is filed with its parent - a Section column does not move it.
    if (colKind === 'section') return !t.parentTaskId && !col.match(t) ? { sectionId: col.key === '-' ? '' : col.key } : {};
    return {};
  };

  // What landing in `lane` changes, coming from lane `from`.
  const lanePatch = (t, from, lane) => {
    if (!lane || swimlane === 'none' || lane.key === 'all') return {};
    if (swimlane === 'assignee') {
      // Dragging a card between assignee lanes HANDS IT OVER: the person
      // whose lane it came from is swapped for the person whose lane it
      // landed in, and anyone else on the task stays. Dropped on Unassigned
      // it means "take me off this" - only the source person is removed, so
      // a task still held by somebody else stays on the board in their lane.
      const next = from === lane.key ? null : assigneeLanePeople(taskAssignees(t), from, lane.key);
      return next ? { assigneeIds: next } : {};
    }
    if (swimlane === 'label') {
      // Label A to label B swaps A for B; no other label is touched.
      const next = labelLaneTags(t.tags, from, lane.key);
      return next ? { tags: next } : {};
    }
    if (swimlane === 'priority') return t.priority !== lane.key ? { priority: lane.key } : {};
    if (swimlane === 'project') {
      // A subtask's project is its parent's - a project lane does not move it.
      if (t.parentTaskId) return {};
      const to = lane.key === '__none' ? '' : lane.key;
      return (t.projectId || '') !== to ? { projectId: to } : {};
    }
    const cfId = cfFieldId(swimlane);
    if (cfId) {
      const to = lane.key === '__none' ? '' : lane.key;
      return (taskFieldValue(t, cfId) || '') !== to ? withTaskFields(t, { customFieldValues: { [cfId]: to } }) : {};
    }
    return {};
  };

  // Due Date columns: a completed card stays where it is (as on the Calendar).
  const canDrag = (t) => canEditTask(t) && !(colKind === 'due' && t.completed);

  const drop = (col, lane) => {
    const id = dragId;
    const from = dragFrom;
    setDragId(null); setDragOver(null); setDragFrom(null);
    if (!id || !col || col.noDrop) return;
    const t = taskOf(id);
    if (!t || !canDrag(t)) return;
    const patch = { ...columnPatch(t, col), ...lanePatch(t, from, lane) };
    const keys = Object.keys(patch);
    const moveDay = colKind === 'due' && !col.match(t);
    const save = keys.length === 1 && keys[0] === 'status'
      ? () => Promise.resolve(store.setStatus(id, patch.status))
      : keys.length ? () => store.updateTask(id, patch) : () => Promise.resolve();
    // The field change first, then the day move - one at a time, so the
    // second never lands on a copy the first is still replacing. A refused
    // change (put back and explained by the store) moves no day either.
    Promise.resolve(save())
      .then(() => (moveDay ? moveTaskToDay(store, t, col.first || '') : null), () => null)
      .catch(() => {});
  };

  // A new card: the column's value, and the lane's (Oct 22 2026 - the lane's
  // "Add" used to open nothing).
  const addTask = (col, laneKey, title) => {
    const t = title.trim(); if (!t) return;
    const base = { title: t, type: 'task', status: 'not_started', priority: 'medium', projectId: lockedProjectId || '', assigneeIds: defaultAssigneeId ? [defaultAssigneeId] : [] };
    if (colKind === 'status') base.status = col.key;
    else if (colKind === 'priority') base.priority = col.key;
    else if (colKind === 'due') base.dueOn = col.first || '';
    else if (colKind === 'section') base.sectionId = col.key === '-' ? '' : col.key;
    const extra = laneAddDefaults(swimlane, laneKey);
    const task = { ...base, ...extra };
    // On My Tasks the new card stays the person's own, whoever's lane it is in.
    if (extra.assigneeIds && defaultAssigneeId) task.assigneeIds = [...new Set([...extra.assigneeIds, defaultAssigneeId])];
    // Required custom fields: the full Create form instead (see richlist's AddTaskInline).
    if (onFullCreate && requiredFieldsFor(store.customFields, task.projectId).length) onFullCreate(task);
    else store.createTask(task).catch((e) => alert(e?.message || 'Could not add the task.'));
    setAddIn(null);
  };

  const renderCard = (t, laneKey = null) => {
    const dc = dueColor(t.dueOn, t.completed);
    const rc = rowColors?.get(t.id) || null;
    const rcAttrs = rowColorAttrs(rc, { card: true });
    // Kit card signature: a colored project tag pill leads the card (hidden
    // when the whole board is already locked to one project).
    const proj = !lockedProjectId && t.projectId ? store.projects.find((p) => p.id === t.projectId) : null;
    const projColor = projectLook(proj, NX.purple).color;
    // Keyboard path (Oct 21 2026): the card is focusable and Enter / Space
    // opens it; its Move To menu changes the status without dragging. Keys
    // pressed inside the card's own controls (the comment box, a button) are
    // theirs, not the card's. A group, not role="button": a button's children
    // are hidden from screen readers, and this card holds real buttons.
    const onCardKey = (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); }
    };
    const editable = canEditTask(t);
    const draggable = canDrag(t);
    // A subtask card says whose subtask it is; the name opens the parent.
    const parent = t.parentTaskId ? store.taskById?.[t.parentTaskId] || (store.tasks || []).find((x) => x.id === t.parentTaskId) : null;
    return (
      <div key={t.id} draggable={draggable} data-task-row data-flip={t.id} data-subtask-card={t.parentTaskId ? t.id : undefined} className={rcAttrs.className || undefined} data-row-color={rc?.id}
        role="group" aria-roledescription={t.parentTaskId ? 'subtask card' : 'task card'} tabIndex={0} aria-keyshortcuts="Enter"
        aria-label={`${t.title} - ${statusMeta(t.status).label}${rc ? ` - ${rc.name}` : ''}`} onKeyDown={onCardKey}
        onDragStart={draggable ? () => { setDragId(t.id); setDragFrom(laneKey); } : undefined}
        onDragEnd={() => { setDragId(null); setDragFrom(null); }} onClick={() => onOpen(t.id)}
        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 6px 16px rgba(0,0,0,0.09)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)'; }}
        style={{ position: 'relative', background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 14, cursor: draggable ? 'grab' : 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', opacity: dragId === t.id ? 0.5 : 1, transition: 'box-shadow .15s', ...rcAttrs.style }}>
        <ChangeFlash value={`${t.status}:${!!t.completed}`} color={statusMeta(t.status)?.color} isFresh={() => changedRecently(t.id)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {proj && (
            <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 10.5, fontWeight: 600, background: `${projColor}1a`, color: projColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{proj.name}</span>
          )}
          {t.isMilestone && <Diamond size={11} style={{ color: NX.purple }} />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
            {editable && (
              <MoveToMenu current={t.status} statuses={statuses} statusMeta={statusMeta} title={t.title}
                onPick={(status) => { if (status !== t.status) Promise.resolve(store.setStatus(t.id, status)).catch(() => {}); }} />
            )}
            <button onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} onMouseDown={(e) => e.stopPropagation()} title="More Actions" aria-label="More Actions" style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><MoreHorizontal size={15} /></button>
            <button onClick={(e) => { e.stopPropagation(); store.toggleComplete(t); }} onMouseDown={(e) => e.stopPropagation()}
              aria-label={t.completed ? 'Mark Incomplete' : 'Mark Complete'} title={t.completed ? 'Mark Incomplete' : 'Mark Complete'} style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint }}>{t.completed ? <CheckCircle2 size={15} /> : <Circle size={15} />}</button>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none', ...boldTitleStyle(rc, t.completed) }}>{t.title}</div>
        {t.parentTaskId && (
          <div data-testid="subtask-of" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11.5, color: NX.faint, minWidth: 0 }}>
            <CornerDownRight size={11} style={{ flexShrink: 0 }} />
            <span style={{ flexShrink: 0 }}>Subtask of</span>
            {parent ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(parent.id); }} onMouseDown={(e) => e.stopPropagation()}
                title={`Open ${parent.title}`}
                style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: FONT, fontSize: 11.5, fontWeight: 600, color: NX.blue, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                {parent.title}
              </button>
            ) : <span style={{ fontWeight: 600 }}>Private Task</span>}
          </div>
        )}
        {showPreviews && <CardPreview task={t} store={store} canEdit={editable} />}
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <PriorityChip priority={t.priority} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={(e) => { e.stopPropagation(); setDraft(''); setCommentError(''); setCommentOpenId((id) => (id === t.id ? null : t.id)); }} onMouseDown={(e) => e.stopPropagation()}
              aria-label={t.commentIds?.length ? `Comments (${t.commentIds.length})` : 'Add Comment'} title={t.commentIds?.length ? `${t.commentIds.length} Comments` : 'Add Comment'}
              style={{ ...btn('ghost'), padding: 2, gap: 2, fontSize: 11, color: commentOpenId === t.id ? NX.blue : NX.faint }}>
              <MessageSquare size={11} />{t.commentIds?.length > 0 ? t.commentIds.length : ''}
            </button>
            {t.checklistTotal > 0 && (
              <span title={`Checklist ${t.checklistDone || 0} of ${t.checklistTotal} done`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: t.checklistDone === t.checklistTotal ? NX.green : NX.faint }}>
                <ListChecks size={11} />{t.checklistDone || 0}/{t.checklistTotal}
              </span>
            )}
            {t.dueOn && <span style={{ fontSize: 11, color: dc }}>{fmtDue(t.dueOn)}</span>}
            <DueBadge task={t} nameOf={ctx.nameOf} compact />
            {taskAssignees(t).slice(0, 3).map((a, i) => (
              <span key={a} style={{ display: 'inline-flex', marginLeft: i ? -7 : 0, borderRadius: '50%', boxShadow: `0 0 0 2px ${NX.surface}` }}>
                <Avatar email={a} name={ctx.nameOf?.(a)} size={20} />
              </span>
            ))}
            {taskAssignees(t).length > 3 && (
              <span title={taskAssignees(t).slice(3).join(', ')} style={{ fontSize: 10.5, color: NX.faint, marginLeft: 3 }}>+{taskAssignees(t).length - 3}</span>
            )}
          </div>
        </div>
        {commentOpenId === t.id && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${NX.border}`, paddingTop: 8 }} onClick={(e) => e.stopPropagation()}>
            <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(t.id); } }}
              placeholder="Add a comment…" rows={2} style={{ ...inputStyle, resize: 'none', fontSize: 12, fontFamily: FONT }} />
            {commentError && <div role="alert" style={{ fontSize: 11.5, color: NX.red, marginTop: 4 }}>{commentError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
              <button onClick={() => setCommentOpenId(null)} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
              <button onClick={() => postComment(t.id)} disabled={!draft.trim() || commentBusy} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: draft.trim() && !commentBusy ? 1 : 0.4 }}>{commentBusy ? 'Posting…' : 'Post'}</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const ColumnHeader = ({ col, count }) => {
    const isStatus = !!col.status;
    const limit = isStatus ? wip[col.key] : undefined;
    const over = limit != null && count > limit;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: col.color, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
          <span style={{ fontSize: 12, fontWeight: 600, padding: '0 4px', borderRadius: 4, color: over ? NX.red : NX.faint, background: over ? 'rgba(220,38,38,0.14)' : 'transparent' }}>{count}{limit != null ? ` / ${limit}` : ''}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {isStatus && <WipMenu limit={limit} onSet={(v) => setLimit(col.key, v)} />}
          {isStatus && customStatusIds.has(col.key) && (
            <button onClick={() => deleteSection(col.key)} title="Delete Column" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Trash2 size={14} /></button>
          )}
          {/* With swimlanes each lane's cell has its own Add. */}
          {!col.noDrop && swimlane === 'none' && (
            <button onClick={() => setAddIn(`all:${col.key}`)} title="Add Task" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><Plus size={15} /></button>
          )}
          {swimlane === 'none' && (
            <button onClick={() => toggleCollapse(col.key)} title="Collapse Section" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><ChevronsLeft size={15} /></button>
          )}
        </div>
      </div>
    );
  };

  // Drop-target wiring for a column (or a lane's cell): a column that takes
  // no drops (Overdue) never claims the drag, so the cursor says so.
  const dropZone = (zoneKey, col, lane) => (col.noDrop ? {} : {
    onDragOver: (e) => { e.preventDefault(); if (dragOver !== zoneKey) setDragOver(zoneKey); },
    onDragLeave: () => setDragOver((d) => (d === zoneKey ? null : d)),
    onDrop: (e) => { e.preventDefault(); e.stopPropagation(); drop(col, lane); },
  });

  const lanesLabel = setup.laneOpts.find((o) => o.key === swimlane)?.label || 'None';
  const columnsLabel = setup.columnOpts.find((o) => o.key === colKind)?.label || 'Status';

  return (
    <div ref={flipRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: NX.canvas, fontFamily: FONT, padding: 16 }}>
      {/* Board toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexShrink: 0, flexWrap: 'wrap' }}>
        {/* My Tasks has no toolbar Group / Columns on its board - its own here. */}
        {!lanesControlled && (
          <BoardMenu icon={Rows3} label={`Group: ${lanesLabel}`} ariaLabel="Group" options={setup.laneOpts} current={swimlane} onPick={setOwnLanes} />
        )}
        {!columnsControlled && (
          <BoardMenu icon={Columns3} label={`Columns: ${columnsLabel}`} ariaLabel="Columns" options={setup.columnOpts} current={colKind} onPick={setOwnColumns} />
        )}
        {onToggleSubtasks && (
          <button type="button" onClick={onToggleSubtasks} aria-pressed={!!showSubtasks}
            title={showSubtasks ? 'Hide the subtask cards' : 'Show each subtask as a card of its own'}
            style={{ ...btn('outline'), fontSize: 12.5, color: showSubtasks ? NX.blue : NX.dim }}>
            <ListTree size={14} /> Show Subtasks {showSubtasks && <Check size={13} />}
          </button>
        )}
        {togglePreviews && (
          <button type="button" onClick={togglePreviews} aria-pressed={showPreviews}
            title={showPreviews ? 'Hide the image, checklist or description under each card title' : 'Show an image, checklist or description under each card title'}
            style={{ ...btn('outline'), fontSize: 12.5, color: showPreviews ? NX.blue : NX.dim }}>
            <ImageIcon size={14} /> Card Previews {showPreviews && <Check size={13} />}
          </button>
        )}
        {colKind === 'status' && (
          <span style={{ fontSize: 11, color: NX.faint, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Set a WIP limit with the <Gauge size={11} /> in each column header.
          </span>
        )}
      </div>

      {swimlane === 'none' ? (
        /* Standard columns */
        <div className="nx-scroll" data-testid="board-columns" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flex: 1, minHeight: 0, overflowX: 'auto', paddingBottom: 4 }}>
          {cols.map((col) => {
            const tasks = visible.filter(col.match);
            const limit = col.status ? wip[col.key] : undefined;
            const over = limit != null && tasks.length > limit;
            const isOver = dragOver === col.key;
            return collapsed.has(col.key) ? (
              <button key={col.key} onClick={() => toggleCollapse(col.key)} {...dropZone(col.key, col, null)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 40, flexShrink: 0, alignSelf: 'stretch', borderRadius: 16, border: `1px solid ${isOver ? NX.blue : NX.border}`, background: NX.surface2, padding: '12px 0', cursor: 'pointer' }} title="Expand Section">
                <ChevronsRight size={14} style={{ color: NX.faint }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: col.color }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: NX.faint }}>{tasks.length}</span>
                <span style={{ marginTop: 4, fontSize: 12, fontWeight: 700, color: NX.ink, whiteSpace: 'nowrap', writingMode: 'vertical-rl' }}>{col.label}</span>
              </button>
            ) : (
              <div key={col.key} data-board-column={col.key} {...dropZone(col.key, col, null)}
                style={{ display: 'flex', flexDirection: 'column', width: 300, maxWidth: 'calc(100vw - 64px)', flexShrink: 0, alignSelf: 'stretch', minHeight: 0, borderRadius: 16, border: `1px solid ${over ? 'rgba(220,38,38,0.5)' : isOver ? NX.blue : NX.border}`, background: NX.surface2, padding: 10 }}>
                <ColumnHeader col={col} count={tasks.length} />
                {over && <div style={{ marginBottom: 8, borderRadius: 8, background: 'rgba(220,38,38,0.14)', color: NX.red, padding: '4px 8px', fontSize: 11, fontWeight: 700 }}>Over WIP limit ({tasks.length}/{limit})</div>}
                <div className="nx-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                  {addIn === `all:${col.key}` && <AddCard onAdd={(title) => addTask(col, null, title)} onCancel={() => setAddIn(null)} />}
                  {tasks.slice(0, MAX_BOARD_CARDS).map((t) => renderCard(t))}
                  {tasks.length > MAX_BOARD_CARDS && <MoreCards n={tasks.length - MAX_BOARD_CARDS} />}
                </div>
              </div>
            );
          })}
          {colKind === 'status' && <AddSectionColumn {...{ addingSection, setAddingSection, sectionName, setSectionName, createSection }} />}
        </div>
      ) : (
        /* Swimlanes */
        <div className="nx-scroll" data-testid="board-lanes" style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 4 }}>
          <div style={{ minWidth: 'max-content' }}>
            <div style={{ display: 'flex', gap: 16, borderBottom: `1px solid ${NX.border}`, paddingBottom: 4 }}>
              {cols.map((col) => (
                <div key={col.key} style={{ width: 300, flexShrink: 0 }}>
                  <ColumnHeader col={col} count={visible.filter(col.match).length} />
                </div>
              ))}
            </div>
            {lanes.map((lane) => (
              <div key={lane.key} data-board-lane={lane.key} style={{ borderBottom: `1px solid ${NX.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12, fontWeight: 700, color: NX.ink }}>
                  <Rows3 size={13} style={{ color: NX.faint }} />{lane.pill ? <LabelPill label={lane.label} /> : lane.label}
                  <span style={{ fontSize: 11, fontWeight: 400, color: NX.faint }}>{visible.filter(lane.match).length}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, paddingBottom: 12 }}>
                  {cols.map((col) => {
                    const tasks = visible.filter((t) => col.match(t) && lane.match(t));
                    const zoneKey = `${lane.key}:${col.key}`;
                    return (
                      <div key={col.key} data-board-zone={col.key} {...dropZone(zoneKey, col, lane)}
                        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 300, flexShrink: 0, minHeight: 80, borderRadius: 12, border: `1px solid ${dragOver === zoneKey ? NX.blue : 'transparent'}`, background: dragOver === zoneKey ? NX.hover : 'transparent', padding: 8 }}>
                        {tasks.slice(0, MAX_BOARD_CARDS).map((t) => renderCard(t, lane.key))}
                        {tasks.length > MAX_BOARD_CARDS && <MoreCards n={tasks.length - MAX_BOARD_CARDS} />}
                        {addIn === zoneKey && <AddCard onAdd={(title) => addTask(col, lane.key, title)} onCancel={() => setAddIn(null)} />}
                        {!col.noDrop && addIn !== zoneKey && (
                          <button onClick={() => setAddIn(zoneKey)} style={{ ...btn('ghost'), justifyContent: 'center', border: `1px dashed ${NX.border}`, fontSize: 11, color: NX.faint, padding: '6px 0' }}><Plus size={12} />Add</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The board's own Group / Columns menu (My Tasks, which has no toolbar for
 *  them on its board). */
function BoardMenu({ icon: Icon, label, ariaLabel, options, current, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  return (
    <div>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} style={{ ...btn('outline'), fontSize: 12.5 }}>
        <Icon size={14} /> {label} <ChevronDown size={13} style={{ color: NX.faint }} />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} aria-label={ariaLabel}
        style={{ width: 176, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        {options.map((o) => (
          <button key={o.key} type="button" role="menuitem" onClick={() => { onPick(o.key); setOpen(false); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', color: current === o.key ? NX.blue : NX.ink, background: current === o.key ? NX.hover : 'transparent' }}>{o.label}</button>
        ))}
      </AnchoredMenu>
    </div>
  );
}

function AddCard({ onAdd, onCancel }) {
  const [title, setTitle] = useState('');
  return (
    <div style={{ border: `1px solid ${NX.blue}`, borderRadius: 12, padding: 8, background: NX.surface }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onAdd(title); if (e.key === 'Escape') onCancel(); }}
        placeholder="Task name" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13, border: 'none' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
        <button onClick={onCancel} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 8px' }}>Cancel</button>
        <button onClick={() => onAdd(title)} disabled={!title.trim()} style={{ ...btn('primary'), fontSize: 11, padding: '5px 10px', opacity: title.trim() ? 1 : 0.4 }}>Add</button>
      </div>
    </div>
  );
}

function AddSectionColumn({ addingSection, setAddingSection, sectionName, setSectionName, createSection }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 260, flexShrink: 0, borderRadius: 16, border: `1px dashed ${NX.border}`, padding: 10 }}>
      {addingSection ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input autoFocus value={sectionName} onChange={(e) => setSectionName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createSection(); if (e.key === 'Escape') { setAddingSection(false); setSectionName(''); } }}
            placeholder="Column name" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={createSection} disabled={!sectionName.trim()} style={{ ...btn('primary'), fontSize: 12, opacity: sectionName.trim() ? 1 : 0.4 }}>Add</button>
            <button onClick={() => { setAddingSection(false); setSectionName(''); }} style={{ ...btn('ghost'), fontSize: 12 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddingSection(true)} style={{ ...btn('ghost'), justifyContent: 'flex-start', color: NX.faint, padding: '8px 8px' }}><Plus size={15} />Add Column</button>
      )}
    </div>
  );
}

/** "Move To" on a board card: the status columns as a menu, so a card can
 *  change column from the keyboard (or a screen reader) without a drag.
 *  Arrow keys walk the list; Escape closes it back onto the button. */
function MoveToMenu({ current, statuses, statusMeta, title, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const listKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  const stop = (e) => e.stopPropagation();
  return (
    <span onClick={stop} onMouseDown={stop} onKeyDown={stop} style={{ display: 'inline-flex' }}>
      <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} title="Move To" aria-label={`Move ${title} to another status`}
        aria-haspopup="menu" aria-expanded={open} style={{ ...btn('ghost'), padding: 3, color: NX.faint }}>
        <ArrowRightLeft size={14} />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} align="end" aria-label="Move To"
        style={{ width: 200, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        <div onKeyDown={listKey}>
          <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, padding: '4px 8px' }}>Move To</div>
          {statuses.map((s, i) => {
            const m = statusMeta(s);
            const here = s === current;
            return (
              <button key={s} type="button" role="menuitem" disabled={here} autoFocus={i === (statuses[0] === current ? 1 : 0)}
                onClick={() => { setOpen(false); onPick(s); ref.current?.focus(); }}
                style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12.5, color: NX.ink, opacity: here ? 0.55 : 1, cursor: here ? 'default' : 'pointer' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
                <span style={{ flex: 1, textAlign: 'left' }}>{m.label}</span>
                {here && <Check size={13} style={{ color: NX.faint }} />}
              </button>
            );
          })}
        </div>
      </AnchoredMenu>
    </span>
  );
}

function WipMenu({ limit, onSet }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(limit ?? '');
  const ref = useRef(null);
  // Portaled: the column header lives inside the board's horizontal
  // scroller, which clipped the in-place panel.
  return (
    <div>
      <button ref={ref} onClick={() => { setVal(limit ?? ''); setOpen((o) => !o); }} title="Set WIP limit" style={{ ...btn('ghost'), padding: 4, color: limit != null ? NX.blue : NX.faint }}><Gauge size={14} /></button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} align="end" role="dialog"
        style={{ width: 176, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 6 }}>WIP limit</div>
        <input type="number" min={0} autoFocus value={val} onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { onSet(val === '' ? null : Number(val) || null); setOpen(false); } }}
          placeholder="No limit" style={{ ...inputStyle, padding: '6px 8px', fontSize: 13 }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <button onClick={() => { onSet(null); setOpen(false); }} style={{ ...btn('ghost'), fontSize: 11, padding: '4px 6px', color: NX.dim }}>Clear</button>
          <span style={{ fontSize: 10, color: NX.faint }}>Enter to save</span>
        </div>
      </AnchoredMenu>
    </div>
  );
}
