// Preventive schedule presets (Construction plan phase 5, 11/03/2026): the
// three the plan names - every month on the 1st, weekly on Monday, quarterly -
// as { unit, every, nextDue } with the next such day after `from`
// (YYYY-MM-DD, the local calendar day). The backend rolls each one on by
// keeping that day (maintenance_services.advance).

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function presetDue(key, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  if (key === 'monthly1') return { unit: 'month', every: 1, nextDue: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1)) };
  if (key === 'mondays') {
    const n = new Date(d);
    n.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
    return { unit: 'week', every: 1, nextDue: ymd(n) };
  }
  if (key === 'quarterly') {
    const q = Math.floor(d.getMonth() / 3) * 3 + 3;
    return { unit: 'month', every: 3, nextDue: ymd(new Date(d.getFullYear(), q, 1)) };
  }
  return null;
}
