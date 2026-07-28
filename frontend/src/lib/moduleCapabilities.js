// What each access level actually lets someone do, per module - used for the
// hover tooltips and the "what they'll be able to do" summary when assigning
// access in a job role or group. Levels are ordinal: viewer ⊂ editor ⊂ full ⊂
// owner (each includes everything below it). Modules not listed here fall back
// to a generic per-tier phrasing (GEN below), so every module has a sensible
// description even before a bespoke one is written.

export const MODULE_CAPABILITIES = {
  timeclock: {
    viewer: 'See the time clock and their own timesheet.',
    editor: 'Clock in / out and manage their own time entries.',
    full:   "Review and correct everyone's punches; approve and export timesheets.",
    owner:  'Everything in Full, plus manage who else can access Time Clock.',
  },
  hr: {
    viewer: 'Browse the people directory and view profiles.',
    editor: 'Add and edit employee records and profile details.',
    full:   'Also delete employees and run M365 provisioning / sync.',
    owner:  'Full People access, plus manage who else can use it.',
  },
  myhr: {
    viewer: 'View their own HR profile, documents and leave.',
    editor: 'Update their own contact details and raise requests.',
    full:   'Manage their own HR self-service fully.',
    owner:  'Personal self-service - no admin over others.',
  },
  inventory: {
    viewer: 'See items, stock levels and their own requests.',
    editor: 'Raise requests and create / edit items.',
    full:   'Approve and allocate, manage assignments, and delete items.',
    owner:  'Full item control, plus manage access to the module.',
  },
  accounting: {
    viewer: 'View transactions, invoices, budgets and reports.',
    editor: 'Create and edit transactions, invoices and budgets.',
    full:   'Also delete records and manage vendors / imports.',
    owner:  'Full accounting access, plus manage who else can use it.',
  },
  documents: {
    viewer: 'View documents and sign ones sent to them.',
    editor: 'Create and send documents / templates for signature.',
    full:   'Manage all documents; void, correct and delete requests / templates.',
    owner:  'Full document control, plus manage access.',
  },
  tasks: {
    viewer: 'See tasks assigned to or shared with them.',
    editor: 'Create, edit and complete tasks.',
    full:   'Manage all tasks and projects, including deletes.',
    owner:  'Full task control, plus manage access.',
  },
  sop: {
    viewer: 'Read SOPs and articles, and take assigned training.',
    editor: 'Author and edit KB articles, SOPs and courses.',
    full:   'Manage and delete KB content and courses.',
    owner:  'Full Knowledge Base control, plus manage access.',
  },
  it: {
    viewer: 'View the network dashboard and website list.',
    editor: 'Manage website entries and IT records.',
    full:   'Full IT management, including deletes.',
    owner:  'Full IT access, plus manage who else can use it.',
  },
  'property-asset': {
    viewer: 'View the property portfolio and asset details.',
    editor: 'Add and edit properties, vehicles and equipment.',
    full:   'Also delete assets and manage documents / inspections.',
    owner:  'Full asset control, plus manage access.',
  },
  'manager-dashboard': {
    viewer: "View their team's dashboard and pending approvals.",
    editor: 'Act on team requests and approvals.',
    full:   'Full manager oversight tools.',
    owner:  'Full access, plus manage who else can use it.',
  },
  marketing: {
    viewer: 'View campaigns, ads and reputation.',
    editor: 'Create and edit campaigns and content.',
    full:   'Manage and delete campaigns and integrations.',
    owner:  'Full marketing control, plus manage access.',
  },
  dashboard: {
    viewer: 'View dashboards.',
    editor: 'Build and save their own dashboard views.',
    full:   'Manage shared / department dashboards.',
    owner:  'Full dashboard control, plus manage access.',
  },
};

const GEN = {
  viewer: (m) => `See and use ${m}.`,
  editor: (m) => `See ${m}, plus create and edit records in it.`,
  full:   (m) => `Create, edit and delete records in ${m}.`,
  owner:  (m) => `Full access to ${m}, plus manage who else can use it.`,
};

// One-line description of what `level` allows on `moduleId`. `moduleLabel` is the
// human name used by the generic fallback (pass MODULES' label).
export function capabilityText(moduleId, level, moduleLabel) {
  if (!level) return 'No access to this screen.';
  return MODULE_CAPABILITIES[moduleId]?.[level] || GEN[level]?.(moduleLabel || moduleId) || '';
}
