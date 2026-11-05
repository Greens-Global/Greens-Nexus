// Construction's place in the address bar (Neil, 11/03/2026). A project is a
// URL: /construction/project:<id> opens it on the Project Dashboard tab and
// /construction/activity:<id> opens Site Activity on that jobsite - so Back
// works, a bell lands on the right job (construction_notify.py sends
// `activity:<id>`), and "Open Site Activity" carries the project across.

// Old sub ids (from before the module's URL segment was renamed from /ops to
// /construction - see PATH_TO_VIEW/VIEW_TO_PATH in App.jsx) still show up in
// bookmarks, saved notification links, and the nexus:navigate event - they
// are normalized here so none of those old links break. The Cubby
// Integration tab (a mock file browser) was removed Sep 22 - its old ids land
// on the dashboard.
const SUB_ALIASES = {
  'ops-dashboard': 'construction-dashboard', 'ops-activity': 'construction-activity',
  'ops-cubby': 'construction-dashboard', 'construction-cubby': 'construction-dashboard',
};

// The Job page's tab rides in the URL too (11/03/2026, phase 2):
// /construction/project:<id>:<tab> - overview (the default, left off),
// schedule, punch, field, photos, rfis, changes, money, closeout. A job id never holds a colon.
export const JOB_TABS = ['overview', 'schedule', 'punch', 'field', 'photos', 'rfis', 'permits', 'subs', 'changes', 'money', 'closeout'];

export function parseConstructionSub(raw) {
  const sub = SUB_ALIASES[raw] || raw || 'construction-dashboard';
  const m = /^(project|activity):([^:]+)(?::([a-z]+))?$/.exec(sub);
  if (m) {
    const jobTab = m[1] === 'project' && JOB_TABS.includes(m[3]) && m[3] !== 'overview' ? m[3] : undefined;
    return { tab: m[1] === 'project' ? 'construction-dashboard' : 'construction-activity', projectId: m[2], jobTab };
  }
  return { tab: sub === 'construction-activity' ? 'construction-activity' : 'construction-dashboard', projectId: '' };
}

export const projectSub = (id, tab = '') => (id ? `project:${id}${tab && tab !== 'overview' ? `:${tab}` : ''}` : 'construction-dashboard');
export const activitySub = (id) => (id ? `activity:${id}` : 'construction-activity');
