// Links departments (Neil, Oct 21 2026).
//
// A department is a free-text tag on a Company Link (link.departments), a
// Personal Link (link.department), an admin-managed picker row
// (external-links/taxonomy) and a saved Link View filter - never a key, so
// the SAME name must appear everywhere. "Storage" became "Operations": the
// server rewrote every stored row once (main.py migrations) and the backend
// aliases writes (routers/external_links.py DEPARTMENT_RENAMES - keep the two
// tables in step); this is the read side, so a row the migration could not
// reach still shows under its new name and never as "Storage".
const RENAMES = { storage: 'Operations' };

// The department on a person's HR record (People > Profile, free text) is
// not necessarily spelled like the Links department it belongs to - "HR",
// "Ops", "Information Technology". Lower-cased spellings on the left, the
// Links department they mean on the right. Matching is case-insensitive and
// falls back to the exact name, so "Accounting" matches "Accounting" with
// no entry here.
const HR_ALIASES = {
  hr: 'Human Resources',
  'human resource': 'Human Resources',
  'human resources': 'Human Resources',
  people: 'Human Resources',
  ops: 'Operations',
  operation: 'Operations',
  operations: 'Operations',
  storage: 'Operations',
  it: 'IT',
  'information technology': 'IT',
  tech: 'IT',
  technology: 'IT',
  admin: 'Administration',
  administration: 'Administration',
  finance: 'Accounting',
  accounts: 'Accounting',
  accounting: 'Accounting',
  marketing: 'Marketing',
  construction: 'Construction',
};

const key = (s) => (s || '').trim().toLowerCase();

// The department name as it should read today ("Storage" -> "Operations");
// anything else trimmed and otherwise untouched. '' stays '' (company-wide).
export function canonDepartment(name) {
  const v = (name || '').trim();
  return RENAMES[v.toLowerCase()] || v;
}

// A link's department list with every name canonical and no duplicates
// (a link tagged "Storage" and "Operations" is tagged Operations once).
export function canonDepartments(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach(d => {
    const c = canonDepartment(d);
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
  });
  return out;
}

// Company Links with their departments canonical; Personal Links too (their
// single `department`). Shape otherwise untouched.
export const canonLink = (l) => (l && Array.isArray(l.departments) ? { ...l, departments: canonDepartments(l.departments) } : l);
export const canonPersonalLink = (l) => (l && typeof l.department === 'string' ? { ...l, department: canonDepartment(l.department) } : l);

// The Links department (one of `available`, as spelled there) that a
// person's HR department means, or '' when it matches nothing - the caller
// then shows every department rather than guessing.
export function matchDepartment(hrDepartment, available) {
  const k = key(hrDepartment);
  if (!k) return '';
  const wanted = key(HR_ALIASES[k] || canonDepartment(hrDepartment));
  return (available || []).find(d => key(d) === wanted) || (available || []).find(d => key(d) === k) || '';
}

// Alphabetical, case-insensitive, no duplicates - the one order every
// department list on the Links screen uses.
export function sortDepartments(names) {
  const seen = new Set();
  return (names || []).filter(n => {
    const k = key(n);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// The department this viewer last picked on the Links screen, per account
// and browser. null = never picked here (first visit: default to their own
// department); '' = they chose All Departments. localStorage can be absent
// or throw (private mode, cleared site data), so every access is guarded.
const memoryKey = (email) => `nexus-links-dept:${(email || '').toLowerCase()}`;

export function readPickedDepartment(email) {
  try {
    const raw = localStorage.getItem(memoryKey(email));
    return raw === null ? null : canonDepartment(raw);
  } catch {
    return null;
  }
}

export function writePickedDepartment(email, department) {
  try { localStorage.setItem(memoryKey(email), canonDepartment(department)); } catch { /* private mode */ }
}
