// The Training catalog's pure rules (Neil, 11/07/2026): what a filter keeps,
// how courses shelve by department, which paths are "for you", and the next
// thing to open on a path. Nothing here renders or talks to the server, so
// catalogModel.test.js pins it.

export const LEVEL_ORDER = { foundations: 0, core: 1, advanced: 2, '': 3 };
export const GENERAL = 'General';

// Which department shelf a course sits on: its first department, else General.
export function shelfOf(course) {
  const list = course?.department_list?.length ? course.department_list : String(course?.departments || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list[0] || GENERAL;
}

function hay(c) {
  return [c.title, c.description, c.code, ...(c.tags || []), ...(c.department_list || [])].filter(Boolean).join(' ').toLowerCase();
}

// filters: { q, department, level, show: 'all' | 'todo' | 'done' | 'not_started' }
export function filterCourses(courses, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  return (courses || []).filter((c) => {
    if (filters.department && filters.department !== GENERAL && !(c.department_list || []).some((d) => d.toLowerCase() === filters.department.toLowerCase())) return false;
    if (filters.department === GENERAL && (c.department_list || []).length) return false;
    if (filters.level && (c.level || '') !== filters.level) return false;
    if (filters.show === 'todo' && (c.my_status === 'Completed' || !c.assigned)) return false;
    if (filters.show === 'done' && c.my_status !== 'Completed') return false;
    if (filters.show === 'not_started' && c.my_status !== 'Not Started') return false;
    if (q && !hay(c).includes(q)) return false;
    return true;
  });
}

// [{ name, courses }] - the person's own department first, then General last,
// the rest by name; inside a shelf the order a path takes them (`order`, from
// pathOrder), then foundations before core before advanced, then the title.
export function shelveCourses(courses, myDepartment = '', order = new Map()) {
  const by = new Map();
  for (const c of courses || []) {
    const k = shelfOf(c);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  const mine = String(myDepartment || '').toLowerCase();
  const names = [...by.keys()].sort((a, b) => {
    if (a.toLowerCase() === mine) return -1;
    if (b.toLowerCase() === mine) return 1;
    if (a === GENERAL) return 1;
    if (b === GENERAL) return -1;
    return a.localeCompare(b);
  });
  return names.map((name) => ({
    name,
    courses: by.get(name).sort((a, b) => ((a.my_status === 'Completed') - (b.my_status === 'Completed')) || ((order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)) || (LEVEL_ORDER[a.level || ''] - LEVEL_ORDER[b.level || '']) || a.title.localeCompare(b.title)),
  }));
}

export function filterPaths(paths, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  return (paths || []).filter((p) => {
    if (filters.kind && p.kind !== filters.kind) return false;
    if (q && ![p.name, p.description, p.audience_text, ...(p.items || []).map((i) => i.title)].filter(Boolean).join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}

// The paths that belong on top: yours, then the ones for your role or department.
export function pathsForMe(paths) {
  return (paths || []).filter((p) => p.enrolled || p.for_me);
}

// ── Progress: ONE resolver for every Training screen (11/08/2026) ──
// My Learning, the catalog, a path page and a course home all ask here, so
// Start vs Continue, "13% done" vs "0 of 6" and the stage in hand agree.

// How far one course or path item is, 0..1: done = 1, else its own percent.
export function itemFraction(it) {
  if (!it) return 0;
  if (it.done || it.my_status === 'Completed' || it.status === 'Completed' || it.status === 'Signed') return 1;
  const pct = Number(it.pct ?? it.my_pct ?? 0);
  return Number.isFinite(pct) ? Math.min(Math.max(pct / 100, 0), 0.99) : 0;
}

// Started and not finished: a course with any lesson done or opened.
export function isStarted(it) {
  if (!it || itemFraction(it) >= 1) return false;
  return (it.my_status ?? it.status) === 'In Progress' || itemFraction(it) > 0;
}

// What the one button on a course says.
export function courseAction(c) {
  if (!c) return 'Open';
  if (itemFraction(c) >= 1) return 'Review';
  return isStarted(c) ? 'Continue' : 'Start';
}

// A course's steps, counted the way the server counts my_pct (kb_core.
// training_status): every lesson, plus the final quiz when it has one.
export function courseSteps(course) {
  const lessons = course?.lessons || [];
  const quiz = course?.quiz?.question_count > 0 ? 1 : 0;
  return { done: lessons.filter((L) => L.done).length + (quiz && course.quiz.passed ? 1 : 0), total: lessons.length + quiz };
}

// The items of a path in the order they are taken: stage by stage.
export function orderedItems(path) {
  return stagesOf(path).flatMap((s) => s.items);
}

// The first item on a path that is not done, in stage order, or null.
export function nextOnPath(path) {
  return orderedItems(path).find((i) => itemFraction(i) < 1) || null;
}

// A path's numbers, all from its items: { done, total, started, pct, finished,
// action }. pct counts a started course by its own percent, so the path never
// says 0% while a course on it says 13%.
export function pathProgress(path) {
  const items = path?.items || [];
  const total = items.length;
  const done = items.filter((i) => itemFraction(i) >= 1).length;
  const started = items.filter(isStarted).length;
  const pct = total ? Math.round((100 * items.reduce((n, i) => n + itemFraction(i), 0)) / total) : 0;
  const finished = !!path?.completed_at || (total > 0 && done >= total);
  return { done, total, started, pct, finished, action: finished ? 'Review' : done || started ? 'Continue' : 'Start' };
}

// "0 of 6 done · 1 in progress"
export function pathCountText(path) {
  const p = pathProgress(path);
  return `${p.done} of ${p.total} done${p.started ? ` · ${p.started} in progress` : ''}`;
}

// The stage the next item sits in (its index in stagesOf), or -1 when done.
export function stageInHand(path) {
  const next = nextOnPath(path);
  return next ? stagesOf(path).findIndex((s) => s.items.includes(next)) : -1;
}

// Where each course sits on the given paths (first path wins), to order a
// list the way the path takes it.
export function pathOrder(paths) {
  const at = new Map();
  let n = 0;
  for (const p of paths || []) for (const it of orderedItems(p)) { if (it.kind === 'course' && !at.has(it.id)) at.set(it.id, n); n += 1; }
  return at;
}

// Items grouped under their stage, in stage order; items with no stage go
// last under '' (an empty name means "the rest").
export function stagesOf(path) {
  const names = path?.stages || [];
  const out = names.map((name, i) => ({ index: i, name, items: [] }));
  const rest = { index: -1, name: '', items: [] };
  for (const it of path?.items || []) {
    const s = Number.isInteger(it.stage) && it.stage >= 0 && it.stage < names.length ? out[it.stage] : rest;
    s.items.push(it);
  }
  const list = out.filter((s) => s.items.length);
  if (rest.items.length) list.push(rest);
  return list;
}


// Which job titles and departments in People have no active path yet.
export function suggestPaths(options, plans) {
  const covered = { job_titles: new Set(), departments: new Set() };
  for (const p of plans || []) {
    if (!p.active) continue;
    for (const t of p.audience?.job_titles || []) covered.job_titles.add(t.toLowerCase());
    for (const d of p.audience?.departments || []) covered.departments.add(d.toLowerCase());
  }
  const out = [];
  for (const t of options?.job_titles || []) if (!covered.job_titles.has(t.toLowerCase())) out.push({ kind: 'role', value: t, name: `${t} Path`, audience: { job_titles: [t] } });
  for (const d of options?.departments || []) if (!covered.departments.has(d.toLowerCase())) out.push({ kind: 'department', value: d, name: `${d} Training`, audience: { departments: [d] } });
  return out;
}

// A tag as a learner reads it: words in Title Case ("new hire" -> "New Hire";
// "RV" and "Cubby" keep their capitals).
export function titleWords(tag) {
  return String(tag || '').trim().replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

// A description cut at a sentence, never mid-sentence: the whole sentences
// that fit in `max` characters (the first one at least); the full text is on
// the course page.
export function blurb(text, max = 170) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const parts = s.match(/[^.!?]+[.!?]+(\s+|$)/g) || [s];
  let out = '';
  for (const p of parts) {
    if (out && (out + p).trim().length > max) break;
    out += p;
  }
  return out.trim();
}

