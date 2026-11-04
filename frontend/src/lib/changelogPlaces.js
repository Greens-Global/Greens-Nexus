// Where in Nexus an update landed (Neil, 11/04/2026: "the modules filter ...
// should follow the actual sitemap / hierarchy of the site ... so people can
// easily see what happened").
//
// An update's `module` is free text - the PR title's prefix ("Workday:",
// "Shifts Phase 3a:", "Oct 28 batch:") - so the Timeline's filter grew one
// entry per spelling. This file is the ONE map from that text to a place on
// the site: a SECTION (a left-navigation module, in the navigation's order)
// and, when the text names one, a PAGE inside it (the module's tab). The
// Timeline's filter, its rows and the detail all read placeOf(); the stored
// `module` is never rewritten.
//
// Matching, on lowercased words:
//   1. "Section > Page" / "Section - Page" in the module text, by name;
//   2. else a page's own words (longest match wins - "payroll export codes"
//      beats "payroll"); a page's bare label ("Reports", "Overview") counts
//      only beside its section's name, because several sections have one;
//   3. else a section's words;
//   4. else the same steps over the title, then the update's Screen;
//   5. else Across Nexus (navigation, header, phones, batches, internals).
// New pages: add them here, in the navigation's order, with the words PR
// titles use for them.

const S = (key, label, words, pages = []) => ({ key, label, words, pages });
const P = (key, label, words = []) => ({ key, label, words });

export const ACROSS = 'nexus';

export const SITE = [
  S('dashboard', 'Dashboard', ['dashboard', 'dashboard widgets', 'widgets', 'daily briefing', 'my day', 'home page'], [
    P('approvals', 'Approvals', ['approvals', 'approvals inbox', 'approvals on the phone', 'approver delegation', 'waiting on you']),
    P('notes', 'Notes', ['notes', 'quick note', 'notes on a phone', 'boards', 'whiteboard', 'whiteboards']),
    P('links', 'Links', ['links', 'external links']),
  ]),
  S('myhr', 'Workday', ['workday', 'my hr', 'my workday', 'time clock', 'time clock launch pass', 'time clock audit'], [
    P('overview', 'Overview', ['workday overview', 'time clock chip', 'clock chip', 'clock chip flourishes', 'punch', 'punch type',
      'punch location', 'location off at clock in', 'fill a form', 'my tickets', 'my work']),
    P('timesheet', 'Time Sheet', ['time sheet', 'time sheets', 'timesheet', 'timesheets', 'timecard', 'time card', 'signed time sheet',
      'signed time sheets', 'signed time sheet pdf']),
    P('timeoff', 'Time Off', ['time off', 'time off prod feedback', 'pto', 'leave balances', 'qb time off import']),
    P('performance', 'Performance', ['my performance']),
    P('ask-hr', 'Ask HR', ['ask hr', 'hr letters']),
    P('reimbursements', 'Reimbursements', ['reimbursement', 'reimbursements']),
    P('purchase', 'Purchase Requests', ['purchase request', 'purchase requests', 'purchase requisition']),
    P('extra-time', 'Extra Time', ['extra time']),
  ]),
  S('shifts', 'Team', ['team'], [
    P('shifts', 'Shifts', ['shifts', 'group shifts', 'my shifts']),
    P('schedule', 'Shift Planner', ['shift planner', 'shift schedule', 'schedule', 'shifts phase', 'shifts phase 0', 'shifts phase 1',
      'shifts phase 2', 'shifts phase 3a', 'shifts phase 3b', 'weather call', 'weather follows the jobsite']),
    P('directory', 'Directory', ['directory', 'contact directory']),
    P('analytics', 'Workforce Analytics', ['workforce analytics', 'workforce scorecard', 'scorecard', 'employee tracking', 'location trail']),
  ]),
  S('tasks', 'Tasks', ['tasks', 'task', 'tasks screens', 'tasks mobile', 'cubby tasks', 'custom grouping'], [
    P('home', 'Home', ['tasks home']),
    P('projects', 'Projects', ['projects']),
    P('portfolios', 'Portfolios', ['portfolios']),
    P('manage', 'Manage', ['task manage', 'tasks manage']),
  ]),
  S('tickets', 'Tickets', ['tickets', 'ticket', 'service desk', 'support desk'], [
    P('reports', 'Reports', ['ticket reports']),
    P('preventive', 'Preventive Maintenance', ['preventive maintenance', 'preventive', 'work orders', 'scan to request']),
  ]),
  S('egnyte', 'Files', ['files', 'egnyte', 'egnyte throttling']),
  S('documents', 'Documents', ['documents', 'document library'], [
    P('templates', 'Templates', ['templates', 'document templates']),
    P('forms', 'Forms', ['forms', 'field forms', 'federal forms']),
    P('filing', 'Filing & Sorting', ['filing and sorting', 'filing', 'hr filing']),
    P('esign', 'Nexus Sign', ['nexus sign', 'esign', 'e sign']),
    P('pdf', 'PDF Tools', ['pdf tools', 'pdf editor']),
  ]),
  S('credvault', 'Credentials', ['credentials', 'credential vault']),
  S('workflows', 'Workflows', ['workflows', 'automations']),
  S('it', 'IT', ['network dashboard']),
  S('ops', 'Construction', ['construction', 'construction jobs', 'site activity', 'jobsite', 'site models'], [
    P('dashboard', 'Project Dashboard', ['project dashboard']),
  ]),
  S('operations', 'Operations', ['operations', 'ops', 'ops polish', 'facility operations', 'cubby'], [
    P('collections', 'Collections', ['collections']),
    P('units', 'Units & Pricing', ['units and pricing']),
    P('worklist', 'Facility Tasks', ['facility tasks']),
    P('market', 'Market Rates', ['market rates']),
    P('reports', 'Reports', ['operations reports']),
    P('revenue', 'ECRI Management', ['ecri', 'ecri management']),
    P('portfolio', 'Portfolio', ['ops portfolio']),
    P('site-map', 'Site Map', ['site map', 'customer map']),
  ]),
  S('inventory', 'Item Management', ['item management', 'items', 'checkouts', 'assignments', 'equipment']),
  S('property-asset', 'Asset Management', ['asset management', 'assets', 'property portfolio', 'properties', 'property assets']),
  S('accounting', 'Accounting', ['accounting', 'accounting oct 22', 'accounting review fixes', 'intacct'], [
    P('reports', 'Reports', ['accounting reports', 'accounting reporting', 'reports', 'retro pay report']),
    P('import', 'Import Hub', ['accounting import hub', 'import hub', 'quickbooks iif']),
    P('mre', 'MRE', ['mre', 'mre grid', 'accounting mre', 'accounting mri']),
    P('ledger', 'Ledger Search', ['ledger search', 'general ledger']),
    P('loans', 'Loans & Financing', ['loans and financing', 'loans']),
    P('access', 'Access', ['accounting access']),
  ]),
  S('investor-relations', 'Investor Relations', ['investor relations', 'investors', 'capital calls', 'distributions']),
  S('pfs', 'Personal Financial Statements', ['pfs', 'personal financial statements']),
  S('leasing', 'Leasing', ['leasing', 'tenants', 'lease']),
  S('hr', 'People', ['people', 'hr', 'benefits', 'benefits phase 1a 1d'], [
    P('people', 'People', ['people directory', 'more details fields', 'nexus fields']),
    P('hiring', 'Hiring', ['hiring', 'hiring packet', 'hiring packets', 'hiring documents', 'hr packets', 'screening notes',
      'offer letter', 'offer letters', 'people and hiring setup', 'hiring 1 of 2', 'probation', 'onboarding']),
    P('org', 'Organizational Chart', ['org chart', 'organizational chart']),
    P('time', 'Time', ['people time', 'payroll', 'payroll timecard', 'payroll time sheet', 'payroll readiness', 'payroll readiness check',
      'payroll feedback oct 28', 'rate history', 'time sheets to review', 'contractor invoices', 'contractor invoices part 1',
      'contractor invoices part 2', 'contractor invoice email', 'salary advance', 'time sheet people']),
    P('checklists', 'Checklists', ['checklists']),
    P('analytics', 'Analytics', ['people analytics']),
    P('reports', 'Reports', ['people reports']),
    P('exits', 'Exits', ['exits', 'offboarding', 'offboard']),
    P('performance', 'Performance', ['performance', 'performance reviews', 'review cycles', 'performance made simple', 'kpi', 'kpi scorecards', 'bonus plans']),
  ]),
  S('marketing', 'Marketing', ['marketing']),
  S('bi', 'Insights', ['insights', 'business intelligence']),
  S('support', 'Help Center', ['help center', 'help', 'support'], [
    P('kb', 'Knowledge Base', ['knowledge base', 'knowledge base and training', 'training', 'ask nexus', 'courses']),
  ]),
  S('admin-console', 'Settings', ['settings', 'global settings', 'company settings', 'audit log'], [
    P('companies', 'Companies', ['companies', 'departments', 'company profile']),
    P('locations', 'Locations', ['locations', 'work sites', 'location library']),
    P('access', 'People & Access', ['people and access', 'roles and access', 'role editor', 'access groups', 'tiers', 'role changes', 'access people']),
    P('security', 'Security', ['security', 'sign in', 'sessions']),
    P('branding', 'Branding & Email', ['branding', 'branding and email', 'brand color', 'letterheads', 'email appearance']),
    P('emails', 'Emails & Reminders', ['emails and reminders', 'weekly digest']),
    P('pay', 'Time & Pay', ['time and pay', 'pay rules', 'payroll export codes', 'india contractor policy', 'shift differentials',
      'california minimum wage', 'intacct nightly sync']),
    P('leave', 'Time Off & Leave', ['time off and leave', 'leave policies', 'holiday policies', 'time off reasons']),
    P('shift-settings', 'Shifts & Scheduling', ['shift settings', 'shift types', 'shifts and scheduling']),
  ]),
  S('testing', 'Testing', ['testing', 'qa']),
  S('whats-new', "What's New", ['whats new', 'what s new', 'changelog', 'new in nexus bar', 'feature requests']),
  S(ACROSS, 'Across Nexus', ['navigation', 'sidebar', 'header', 'header search', 'header cleanup', 'popups', 'bell',
    'notifications', 'mobile', 'mobile audit', 'mobile audit follow up', 'mobile batch', 'phone pass', 'phone keyboard', 'loading',
    'startup', 'startup migrations', 'schema guard', 'bundle budget', 'frontend', 'ui pass', 'status labels', 'cleanup', 'hotfix',
    'hotfix to dev', 'people pickers', 'people pickers everywhere', 'profile', 'profile menu tools', 'profile date format', 'field app',
    'offline', 'frontline reach', 'act as', 'priority bar', 'nexus motion', 'teams', 'fix the dev ci']),
];

// The Screen field on an update stores a module id (RoleContext MODULES);
// a few ids are not left-navigation sections and land on the one they live in.
const SCREEN_TO_SECTION = { timeclock: 'myhr', 'manager-dashboard': 'dashboard', 'employee-tracking': 'shifts',
  'workforce-scorecard': 'shifts', sop: 'support', hr_comp: 'hr', admin: 'admin-console', 'external-links': 'dashboard' };

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const has = (text, word) => word && text.includes(` ${word} `);

const BY_KEY = new Map(SITE.map((s) => [s.key, s]));

// The longest of `words` found in `text`, or 0.
function best(text, words) {
  let n = 0;
  for (const w of words) if (w.length > n && has(text, w)) n = w.length;
  return n;
}

const sectionWords = (s) => [norm(s.label).trim(), ...s.words].filter((w) => w && !(s.key === 'it' && w === 'it'));
const pageWords = (p) => p.words;

// The section a name stands for exactly ("Workday", "People", "IT").
function sectionNamed(name) {
  const t = norm(name).trim();
  return SITE.find((s) => norm(s.label).trim() === t || s.words.includes(t)) || null;
}

function pageIn(section, text) {
  let hit = null; let n = 0;
  for (const p of section.pages) {
    const m = Math.max(best(text, pageWords(p)), best(text, [norm(p.label).trim()]));
    if (m > n) { n = m; hit = p; }
  }
  return hit;
}

// One piece of text -> { section, page } or null. A title is read more
// strictly: Across Nexus's words ("header", "mobile") and a page's bare label
// say nothing there, and only a page's longer words count.
function fromText(raw, { title = false } = {}) {
  if (!raw) return null;
  // 0. A section by its exact name ("IT", "Workday").
  const named = !title && sectionNamed(raw);
  if (named) return { section: named, page: null };
  // 1. "Section > Page" or "Section - Page".
  const parts = String(raw).split(/\s*>\s*|\s+-\s+/).filter(Boolean);
  if (!title && parts.length > 1) {
    const sec = sectionNamed(parts[0]);
    if (sec) return { section: sec, page: pageIn(sec, norm(parts.slice(1).join(' '))) };
  }
  const text = norm(raw);
  const sections = title ? SITE.filter((s) => s.key !== ACROSS) : SITE;
  const words = (p) => (title ? pageWords(p).filter((w) => w.length >= 6) : pageWords(p));
  // 2. A page by its own words, anywhere on the site (longest wins), or by its
  //    bare label beside its section's name.
  let hit = null; let n = 0;
  for (const s of sections) {
    const secHere = !title && best(text, sectionWords(s)) > 0;
    for (const p of s.pages) {
      const m = Math.max(best(text, words(p)), secHere ? best(text, [norm(p.label).trim()]) : 0);
      if (m > n) { n = m; hit = { section: s, page: p }; }
    }
  }
  // 3. A section by its words - kept over the page when its match is longer
  //    ("Time Off prod feedback" is a page; "Accounting Oct 22" a section).
  let sec = null; let sn = 0;
  for (const s of sections) {
    const m = best(text, sectionWords(s));
    if (m > sn) { sn = m; sec = s; }
  }
  if (hit && n >= sn) return hit;
  if (sec) return { section: sec, page: hit && hit.section === sec ? hit.page : null };
  return hit;
}

// A page inside a known section, from a title's longer page words only.
function pageFromTitle(section, title) {
  const text = norm(title);
  let hit = null; let n = 0;
  for (const p of section.pages) {
    const m = best(text, pageWords(p).filter((w) => w.length >= 6));
    if (m > n) { n = m; hit = p; }
  }
  return hit;
}

const placeCache = new WeakMap();

// Where an update landed: { key, sectionKey, label, sectionLabel, pageLabel }.
// The module text decides; a module that names nothing ("General", "Oct 28
// batch") hands over to the title, then to the Screen the author picked.
export function placeOf(entry) {
  if (!entry) return toPlace(BY_KEY.get(ACROSS), null);
  if (typeof entry === 'object' && placeCache.has(entry)) return placeCache.get(entry);
  const screenSec = entry.screen ? BY_KEY.get(SCREEN_TO_SECTION[entry.screen] || entry.screen) || null : null;
  let found = fromText(entry.module) || fromText(entry.title, { title: true });
  if (screenSec && (!found || found.section !== screenSec)) {
    // The Screen the author picked is the section; a page only from inside it.
    found = { section: screenSec, page: found?.section === screenSec ? found.page : null };
  }
  // "HR: Redesigned Org Chart" - the module names the section, the title the page.
  if (found && !found.page && found.section.pages.length) {
    found = { section: found.section, page: pageFromTitle(found.section, entry.title) };
  }
  const place = toPlace(found?.section || BY_KEY.get(ACROSS), found?.page || null);
  if (typeof entry === 'object') placeCache.set(entry, place);
  return place;
}

function toPlace(section, page) {
  return {
    key: page ? `${section.key}/${page.key}` : section.key,
    sectionKey: section.key,
    sectionLabel: section.label,
    pageLabel: page?.label || '',
    label: page ? `${section.label} - ${page.label}` : section.label,
  };
}

// Does an update's place fall under a filter key ("myhr" takes in every
// Workday page; "myhr/timesheet" only that page)?
export function inPlace(place, key) {
  return place.key === key || place.sectionKey === key;
}

// A filter value from an old link (a raw module name) -> today's key.
export function placeKeyFor(value) {
  if (!value) return value;
  if (BY_KEY.has(value)) return value;
  const [s, p] = value.split('/');
  if (BY_KEY.get(s)?.pages.some((x) => x.key === p)) return value;
  return placeOf({ module: value }).key;
}

// The filter's options: every section and page that has updates, in the
// navigation's order, each with its count (a section counts its pages too).
export function placeOptions(entries) {
  const counts = new Map();
  for (const e of entries) {
    const p = placeOf(e);
    counts.set(p.key, (counts.get(p.key) || 0) + 1);
    if (p.key !== p.sectionKey) counts.set(p.sectionKey, (counts.get(p.sectionKey) || 0) + 1);
  }
  const out = [];
  for (const s of SITE) {
    if (!counts.has(s.key)) continue;
    out.push({ key: s.key, label: s.label, count: counts.get(s.key), depth: 0 });
    for (const p of s.pages) {
      const k = `${s.key}/${p.key}`;
      if (counts.has(k)) out.push({ key: k, label: `${s.label} - ${p.label}`, count: counts.get(k), depth: 1 });
    }
  }
  return out;
}

// Every place, for the author form's suggestions ("Workday - Time Sheet").
export function allPlaceLabels() {
  return SITE.flatMap((s) => [s.label, ...s.pages.map((p) => `${s.label} - ${p.label}`)]);
}

// The label for a filter key.
export function placeLabel(key) {
  const [s, p] = String(key || '').split('/');
  const sec = BY_KEY.get(s);
  if (!sec) return key;
  const page = p && sec.pages.find((x) => x.key === p);
  return page ? `${sec.label} - ${page.label}` : sec.label;
}
