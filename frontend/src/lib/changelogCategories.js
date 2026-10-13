// Update announcements speak in categories only (Neil, Oct 12 2026): "2 new
// features and 3 bug fixes". The details - what each one is - live in What's
// New itself. Counts come from the server keyed by an update's type
// (ChangelogView's CHANGE_TYPES), in the order a reader cares about.
const PHRASES = {
  'New Feature': ['new feature', 'new features'],
  Improvement: ['improvement', 'improvements'],
  Performance: ['performance improvement', 'performance improvements'],
  'Security Update': ['security update', 'security updates'],
  'Bug Fix': ['bug fix', 'bug fixes'],
  Hotfix: ['hotfix', 'hotfixes'],
  Maintenance: ['maintenance update', 'maintenance updates'],
};

export function summarizeCategories(counts = {}) {
  const parts = Object.keys(PHRASES)
    .filter((t) => counts[t] > 0)
    .map((t) => `${counts[t]} ${PHRASES[t][counts[t] === 1 ? 0 : 1]}`);
  const other = Object.entries(counts).reduce((n, [t, c]) => (PHRASES[t] ? n : n + (c || 0)), 0);
  if (other > 0) parts.push(`${other} other update${other === 1 ? '' : 's'}`);
  if (parts.length < 2) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export const hasNewFeature = (counts) => (counts?.['New Feature'] || 0) > 0;
