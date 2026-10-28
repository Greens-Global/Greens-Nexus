// The module a catalog entry belongs to, as the screens name it. The
// catalog carries only the key (`hr`, `tasks`, ...); the label lives here so
// Templates and Catalog agree, and an unknown key still reads as a title.
const LABELS = {
  core: 'Core', hr: 'HR', tasks: 'Tasks', tickets: 'Tickets', time: 'Time Clock',
  shifts: 'Shifts', items: 'Items', approvals: 'Approvals', performance: 'Performance',
};
const ORDER = ['core', 'hr', 'tasks', 'tickets', 'time', 'shifts', 'items'];

export function moduleLabel(key) {
  if (!key) return 'Other';
  return LABELS[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Modules in the order the app lists them, the rest alphabetically after.
export function sortModules(keys) {
  return [...new Set(keys.filter(Boolean))].sort((a, b) => {
    const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return moduleLabel(a).localeCompare(moduleLabel(b));
  });
}

// The last segment of a template blank, as a title: "letter.template" ->
// "Letter Template", "manager_email" -> "Manager Email".
export function blankLabel(path) {
  const last = String(path || '').split('.').filter(Boolean).pop() || '';
  return last.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
