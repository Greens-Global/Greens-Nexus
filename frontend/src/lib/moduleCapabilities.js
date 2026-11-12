// What each grant level really unlocks, per module - the hover tooltips, the
// bundle editor's line under a picked level, and the Level Guide on the Matrix
// tab. Levels are ordinal: viewer < editor < full (each includes everything
// below it). Owner was retired (11/2026): the API reads a stored 'owner' as
// 'full', and so does capabilityText.
//
// `tiers` says what still needs a seniority TIER whatever the grant - a Full
// grant never replaces a Manager or Administrator check. Plain English for a
// non-technical administrator; this mirrors the backend checks exactly, so a
// change there is a change here.

export const MODULE_CAPABILITIES = {
  accounting: {
    viewer: 'The Accounting screen - Profit & Loss, ledgers and every report.',
    editor: 'Also record and edit entries, budgets, loans, leases, flux and saved reports, and run imports.',
    full:   'Also allocations, the compensation sub-ledger, liability reconciliation, the month-end close and saved-report administration. Entity access still limits which entities they read.',
    tiers:  { administrator: 'opens the screen without a grant' },
  },
  'accounting-app': {
    viewer: 'Sign in to the accounting app as a member.',
    editor: 'Same as Viewer.',
    full:   'Sign in as its administrator.',
    tiers:  { administrator: 'app administrator without a grant' },
  },
  hr: {
    viewer: 'The People list and profiles.',
    editor: 'Also add and edit people and HR records, hiring and checklists.',
    full:   'HR for the company - approvals, letters, leave, finalizing Time Sheets, confidential HR tickets and company-wide edits.',
    tiers:  {
      manager: 'sees only their own team in People, and never pay',
      administrator: 'People for their company without a grant',
      super: 'deleting or restoring a person, a candidate, a company or a work site',
    },
  },
  hr_comp: {
    viewer: 'See salary and bank details.',
    editor: 'Change them.',
    full:   'Same as Editor.',
    tiers:  { super: 'the only tier that sees pay without this grant; an Administrator never does' },
  },
  myhr: {
    viewer: 'Open Workday - their own time off, requests, documents and pay stubs. Everyone has it; the grant matters only for external guests.',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
  },
  timeclock: {
    viewer: 'Open Time Clock. Who they can see is decided by their tier and People access, not this grant. Everyone has it; the grant matters only for external guests.',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
  },
  shifts: {
    viewer: 'Open the Shift Planner for the teams they are named Scheduler on.',
    editor: "Also add, edit and share those teams' shifts.",
    full:   'Also clear and import weeks, change who is on those teams, decide swaps, offers and weather calls, and rename and archive their teams.',
    tiers:  { manager: "all of this for their company's people without a grant; never Time Sheets, pay, labor cost, shift types or Settings" },
  },
  'employee-tracking': {
    viewer: 'The Team analytics tabs (live, coverage, screenshots, alerts, locations, enrolled PCs) for their direct reports.',
    editor: 'The same for their whole reporting line.',
    full:   'The whole company inside the company walls, plus the monitoring policy, enrolling and revoking PCs and remote control.',
    tiers:  { administrator: 'Full without a grant' },
  },
  'workforce-scorecard': {
    viewer: 'The weekly Scorecard for their direct reports, by email too.',
    editor: 'Their whole reporting line.',
    full:   'The whole company.',
    tiers:  { administrator: 'the Scorecard settings, recipients and test send' },
  },
  tasks: {
    viewer: 'See, work and complete the tasks and projects shared with them, and comment.',
    editor: 'Also create tasks and projects, import lists and assign external people.',
    full:   'Acts as a manager inside Tasks - Manage, every task, the Activity Log, automation rules, templates and intake forms.',
    tiers:  { manager: 'all of Full without a grant' },
  },
  tickets: {
    viewer: 'Raise and follow their own tickets and open the Tickets screen.',
    editor: 'Same as Viewer today.',
    full:   'Same as Viewer today.',
    note:   "The ticket desk's own roles (Requester, Agent, Supervisor) are set under Settings > Tickets and are under review.",
    tiers:  { manager: 'desk departments, routing and notification settings', administrator: "supervises every company's desk" },
  },
  sop: {
    viewer: 'Read the pages they are allowed to see and take assigned training.',
    editor: 'Also write and edit pages, SOPs and courses.',
    full:   'Also create and manage collections, delete content and courses, and the KB reminder settings.',
    tiers:  { manager: 'treated as Full inside the Knowledge Base' },
  },
  it: {
    viewer: 'See the network dashboard and export it (the module is read-only).',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
  },
  ops: {
    viewer: 'Open Construction. Reach is per jobsite and company; money needs the Accounting grant. Everyone has it; the grant matters only for external guests.',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
  },
  operations: {
    viewer: 'Read everything - portfolio, reports, insights, CMA, rates, unit map, third parties, budget and facility work.',
    editor: 'Also edit rates, reports, third-party records, facility work, the unit map and CMA drafts.',
    full:   'Also approve CMAs, revenue, the customer map and the budget, and save Operations and Cubby settings.',
    tiers:  { supervisor: 'reads without a grant', manager: 'edits and approves', administrator: 'settings' },
  },
  'property-asset': {
    viewer: 'The properties, vehicles and equipment they may see.',
    editor: 'Add and edit them, their records and files.',
    full:   'Also change or clear a connected Egnyte folder.',
    tiers:  { administrator: "every company's assets", super: 'private assets and the Private switch' },
  },
  pfs: {
    viewer: 'Open statements and produce the lender PDF.',
    editor: 'Also guarantors, accounts, holdings and loans.',
    full:   'Also delete a guarantor profile.',
    tiers:  { super: 'the only tier that opens these without the grant; an Administrator never does' },
  },
  'investor-relations': {
    viewer: 'The dashboard, funds, investors, calls, distributions, documents and updates they are scoped to.',
    editor: 'Also create and edit all of those, and portal access.',
    full:   'Also delete funds, investors, commitments, documents and updates.',
    tiers:  { manager: 'edits without a grant', administrator: 'deletes' },
  },
  documents: {
    viewer: 'Open Documents, read what they may see and sign what is sent to them.',
    editor: 'Also keep Nexus Sign templates, send documents for signature, copy signing links, send reminders and follow the envelopes they sent.',
    full:   'Also void an envelope, correct a signer and delete a sign template.',
    tiers:  {
      manager: "their department's document templates",
      administrator: 'company-wide templates. People access decides HR packets, employee records and the full Nexus Sign list',
    },
  },
  egnyte: {
    viewer: 'Browse the folders they can reach in Egnyte - open, preview, search and download.',
    editor: 'Also upload, make folders, rename, move and copy.',
    full:   'Also delete files and folders.',
    tiers:  { supervisor: "every write without a grant. Egnyte's own permissions still apply", manager: 'folder wiring and folder groups' },
  },
  marketing: {
    viewer: 'See campaigns, ads and reviews.',
    editor: 'Also edit ads and reply to reviews.',
    full:   'Also map ad accounts and edit the Business Profile listing.',
    tiers:  { administrator: 'connecting and disconnecting the Google and ads accounts' },
  },
  'external-links': {
    viewer: 'See the links.',
    editor: 'Also add, edit, reorder and import links, and handle link requests.',
    full:   'Also delete links.',
    tiers:  { manager: 'edits without a grant', administrator: 'deletes' },
  },
  inventory: {
    viewer: 'See items, stock and their own requests.',
    editor: 'Also create and edit items, approve and allocate.',
    full:   'Also delete items and custom fields, and the equipment reminder settings.',
    tiers:  { manager: 'Editor without a grant', super: 'deletes without a grant' },
  },
  credvault: {
    viewer: 'Open Credentials, use the shared logins their department or a share opens, and ask for the rest.',
    editor: 'Also add and import credentials.',
    full:   'Also manage every credential on their side of the company wall - edit, share, hand over, trash, recover and delete for good.',
    tiers:  { administrator: 'the whole activity log' },
  },
  testing: {
    viewer: 'See test cases, runs and bug reports; start a run, record results and file bugs.',
    editor: 'Also add and change test cases, approve generated specs, change bug reports, assign testers and import a workbook.',
    full:   'Also delete a run with its results.',
  },
  'build-mode': {
    viewer: "See everyone's pins, the Build Sessions and their reports.",
    editor: 'Also drop pins, comment, work their own pins and sessions, and mint Build Tokens.',
    full:   "Also change, dismiss, reopen and check anyone's pins, and rename anyone's session.",
    tiers:  { super: 'Build Mode without a grant, and purging its media' },
  },
  workflows: {
    viewer: 'See workflows, their runs and the automations list.',
    editor: 'Also build, test, publish and pause their own.',
    full:   'Also manage every workflow in their scope and save company templates.',
    tiers:  { super: 'the organization-wide controls' },
  },
  bi: {
    viewer: 'The Insights page and its drill-downs (read-only).',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
    tiers:  { supervisor: 'opens it without a grant' },
  },
  dashboard: {
    viewer: 'Open the Dashboard. Everyone has it; the grant matters only for external guests.',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
  },
  'manager-dashboard': {
    viewer: 'Add the team widgets (approvals, team time) to their own Dashboard.',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
  },
  'admin-console': {
    viewer: "Open Settings. Each setting group opens by tier or by another module's grant (People, Item Management, Operations, Knowledge Base, Workflows, Workforce Analytics).",
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
    tiers:  { manager: 'the groups marked for managers', administrator: 'most groups', super: 'organization-wide groups' },
  },
  support: {
    viewer: 'Open the Help Center and raise support tickets. Ask Nexus reads the Knowledge Base grant. Everyone has it.',
    editor: 'Same as Viewer.',
    full:   'Same as Viewer.',
    tiers:  { administrator: 'known issues and signals' },
  },
};

const LEVEL_KEY = (level) => (level === 'owner' ? 'full' : level);

// One-line description of what `level` allows on `moduleId`. Every grantable
// module has an entry (moduleCapabilities.test.js pins it); `moduleLabel` only
// names a module that has none yet.
export function capabilityText(moduleId, level, moduleLabel) {
  if (!level) return 'No access to this screen.';
  return MODULE_CAPABILITIES[moduleId]?.[LEVEL_KEY(level)] || `See and use ${moduleLabel || moduleId}.`;
}

const TIER_WORD = { supervisor: 'Supervisor tier', manager: 'Manager tier', administrator: 'Administrator tier', super: 'Super Administrator' };
export const SUPER_LINE = 'Super Administrator - everything, every company';

// What still needs a tier on `moduleId`, lowest tier first, always ending with
// the Super Administrator line.
export function tierText(moduleId) {
  const tiers = MODULE_CAPABILITIES[moduleId]?.tiers || {};
  return [
    ...Object.keys(TIER_WORD).filter(t => tiers[t]).map(t => `${TIER_WORD[t]} - ${tiers[t]}`),
    SUPER_LINE,
  ];
}
