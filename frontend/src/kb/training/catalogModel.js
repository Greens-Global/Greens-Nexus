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
// the rest by name; inside a shelf foundations lead and completed sink.
export function shelveCourses(courses, myDepartment = '') {
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
    courses: by.get(name).sort((a, b) => (a.my_status === 'Completed') - (b.my_status === 'Completed') || (LEVEL_ORDER[a.level || ''] - LEVEL_ORDER[b.level || '']) || a.title.localeCompare(b.title)),
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

// The first item on a path that is not done (the stage order is the item
// order), or null when everything is.
export function nextOnPath(path) {
  return (path?.items || []).find((i) => !i.done) || null;
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

// What the one button on a course says.
export function courseAction(c) {
  if (!c) return 'Open';
  if (c.my_status === 'Completed') return 'Review';
  if (c.my_status === 'Not Started') return 'Start';
  return 'Continue';
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

