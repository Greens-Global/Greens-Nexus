// Update announcements speak in categories only (Neil, Oct 12 2026): "2 New
// Features and 3 Bug Fixes". The details - what each one is - live in What's
// New itself. Counts come from the server keyed by an update's type
// (ChangelogView's CHANGE_TYPES), in the order a reader cares about.
//
// Category names are Title Case even inside a sentence (Neil, Oct 12 2026:
// "New Features", "Bug Fixes" - never "new features"). Only the joining
// "and" stays lowercase.
const PHRASES = {
  'New Feature': ['New Feature', 'New Features'],
  Improvement: ['Improvement', 'Improvements'],
  Performance: ['Performance Improvement', 'Performance Improvements'],
  'Security Update': ['Security Update', 'Security Updates'],
  'Bug Fix': ['Bug Fix', 'Bug Fixes'],
  Hotfix: ['Hotfix', 'Hotfixes'],
  Maintenance: ['Maintenance Update', 'Maintenance Updates'],
};

export function summarizeCategories(counts = {}) {
  const parts = Object.keys(PHRASES)
    .filter((t) => counts[t] > 0)
    .map((t) => `${counts[t]} ${PHRASES[t][counts[t] === 1 ? 0 : 1]}`);
  const other = Object.entries(counts).reduce((n, [t, c]) => (PHRASES[t] ? n : n + (c || 0)), 0);
  if (other > 0) parts.push(`${other} Other Update${other === 1 ? '' : 's'}`);
  if (parts.length < 2) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export const hasNewFeature = (counts) => (counts?.['New Feature'] || 0) > 0;
