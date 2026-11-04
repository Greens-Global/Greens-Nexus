// The weeks a manager may pick on Weekly Reports (Neil, 11/03/2026): ONE week
// rule - the project's week_starts_on on the jobsite's own clock, which the
// server answers as `weekStart` (construction_company.current_week_start, the
// same rule the Friday scheduler cuts by).
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The weeks a manager may draft: the jobsite's current week (the server's
// `weekStart` - the project's week_starts_on on the jobsite's clock) and the
// seven before it. Without the server's answer, the project's week start day
// on this browser's calendar.
export function weekChoices(project, count = 8) {
  let start;
  if (/^\d{4}-\d{2}-\d{2}$/.test(project?.weekStart || '')) {
    const [y, m, d] = project.weekStart.split('-').map(Number);
    start = new Date(y, m - 1, d);
  } else {
    start = new Date();
    const first = project?.weekStartsOn ?? 1;
    start.setDate(start.getDate() - ((start.getDay() - first + 7) % 7));
  }
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() - 7 * i);
    return iso(d);
  });
}
