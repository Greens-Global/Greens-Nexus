// Many tasks at once from a list (Neil, Oct 31 2026): "I have a list on my
// clipboard or in my head, give me N tasks in ten seconds". A multi-line
// paste into any add row (Home, My Day, the Create Task title, the phone
// quick-add) and the Create form's Add Several both land in AddSeveralModal,
// and the rows go to POST /tasks/import - the CSV / Excel engine - with
// `source` "paste" or "typed", so there is ONE create-many path, one
// transaction, one bell per person. Nothing here talks to the server; these
// are the pure pieces: reading the lines and shaping the import rows.
//
// One task per line. A line indented under the one above (a tab, or two or
// more spaces) is its subtask; deeper indents fold to that one level - a
// task list is flat or one level deep, as the task drawer draws it. Bullets
// ("-", "*", "•", "1.", "1)", "a.", "a)", "[ ]", "[x]", "☐") are stripped,
// blank lines dropped; a ticked box is still an open task - the list is what
// is still to do. A title is sent whole: the server cuts one over 500 and
// says so in the dry run (the modal shows that warning).

const BULLET = /^(?:[-*•◦▪‣]|\d{1,3}[.)]|[a-zA-Z][.)]|\[[ xX]?\]|☐|☑|✓|✔)(?:\s+|$)/;
// Windows, Unix and old-Mac line endings alike.
const LINE_END = /\r\n?|\n/;

/** Levels of indentation a line's leading whitespace reads as: a tab is one,
 *  every two spaces one (four-space indents still read as a level each). */
function indentOf(line) {
  const m = /^[ \t]*/.exec(line)[0];
  let tabs = 0, spaces = 0;
  for (const ch of m) { if (ch === '\t') tabs += 1; else spaces += 1; }
  return tabs + Math.floor(spaces / 2);
}

function stripBullets(text) {
  let s = text.trim();
  // "- [ ] Call the bank": a bullet and a checkbox, in either order.
  for (let i = 0; i < 2; i += 1) {
    const next = s.replace(BULLET, '');
    if (next === s) break;
    s = next.trim();
  }
  return s;
}

/** `text` -> [{ title, depth }], depth 0 or 1 (a subtask of the nearest
 *  depth-0 line above). The shallowest line sets the base, so a whole list
 *  pasted with a common indent is flat. */
export function parseTaskLines(text) {
  const raw = String(text || '').split(LINE_END)
    .filter((l) => l.trim())
    .map((l) => ({ indent: indentOf(l), title: stripBullets(l) }))
    .filter((l) => l.title);
  if (!raw.length) return [];
  const base = Math.min(...raw.map((l) => l.indent));
  const out = [];
  let prev = 0;
  raw.forEach((l, i) => {
    let depth = l.indent - base;
    if (i === 0) depth = 0;                 // nothing above to be under
    depth = Math.min(depth, prev + 1, 1);   // never a jump, never deeper than a subtask
    out.push({ title: l.title, depth });
    prev = depth;
  });
  return out;
}

/** Two or more lines that read as tasks: a list, not a title. A trailing
 *  lone dash (editors leave one) does not make a one-liner a list. */
export function isTaskList(text) {
  return parseTaskLines(text).length >= 2;
}

export function countLines(lines) {
  const tasks = lines.filter((l) => l.depth === 0).length;
  return { tasks, subtasks: lines.length - tasks };
}

/** "7 tasks, 2 subtasks" / "1 task" / "no tasks yet". */
export function countLabel(lines) {
  const { tasks, subtasks } = countLines(lines);
  if (!tasks) return 'no tasks yet';
  const a = `${tasks} task${tasks === 1 ? '' : 's'}`;
  return subtasks ? `${a}, ${subtasks} subtask${subtasks === 1 ? '' : 's'}` : a;
}

/** The TaskImportBody rows (backend/task_import.py `_parse_row`): `row` is
 *  1-based and `parent` names the parent's ROW NUMBER (the engine reads
 *  "3" / "row 3" / "#3"), so two lines with the same title never collide.
 *  `shared` applies to every line: assignees (emails), due / start
 *  (YYYY-MM-DD), priority, status, tags; `custom` ({fieldId: value}) goes on
 *  top-level lines only - a subtask is part of its parent and the engine
 *  checks required fields on top-level rows alone. */
export function importRowsFor(lines, shared = {}) {
  const assignees = (shared.assigneeIds || shared.assignees || []).filter(Boolean).join(', ');
  const tags = (shared.tags || []).filter(Boolean).join(', ');
  const custom = shared.customFieldValues || shared.custom || null;
  const hasCustom = custom && Object.keys(custom).length > 0;
  let lastTop = 0;
  return lines.map((l, i) => {
    const n = i + 1;
    const rec = { row: n, title: l.title };
    if (l.depth > 0 && lastTop) rec.parent = String(lastTop);
    else lastTop = n;
    if (assignees) rec.assignees = assignees;
    if (shared.dueOn) rec.due = shared.dueOn;
    if (shared.startOn) rec.start = shared.startOn;
    if (shared.priority) rec.priority = shared.priority;
    if (shared.status) rec.status = shared.status;
    if (tags) rec.tags = tags;
    if (hasCustom && !rec.parent) rec.custom = { ...custom };
    return rec;
  });
}

/** One id per Add Several submit: the engine refuses a repeat of it (409)
 *  inside a project, so a double click never adds the list twice. */
export function newBatchId() {
  return globalThis.crypto?.randomUUID?.() || `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The lines as text again, for the editable box: a tab marks a subtask. */
export function linesToText(lines) {
  return lines.map((l) => (l.depth ? '\t' : '') + l.title).join('\n');
}

/** The one check every add row makes on paste: the clipboard text when it is
 *  a list (two or more lines), else '' - and the paste types in as before. */
export function pastedTaskList(e) {
  const text = e?.clipboardData?.getData?.('text/plain') || '';
  return isTaskList(text) ? text : '';
}
