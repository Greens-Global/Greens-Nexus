// Support -> Implementation Guide (Neil, 10/06): the guide for whoever SETS
// NEXUS UP for an organization - our own team on a new client, or the
// client's owner/administrator - as opposed to Documentation, which explains
// each module to the people using it once it is set up.
//
// "When you and I earn our first client, what are the internal steps that we
// are going to take with that client and what are we going to make happen?"
//
// It is written as phases in the order they must happen (later phases lean on
// earlier ones: roles need companies, people need roles, time needs people).
// Each phase says WHY it matters (the logic), the DECISIONS to get from the
// client first, the STEPS (each opens the screen it names), the CHECKS that
// prove it is done (ticked off together - routers/implementation.py keeps one
// shared list), and the PITFALLS we have already hit.
//
// KEEP THIS CURRENT: written by hand from what each settings screen actually
// does (audited Oct 7, 2026). A renamed tab or a moved setting belongs here
// too, the same as in docsContent.js. House style (CLAUDE.md): American
// English, Title Case for headings and buttons, plain hyphens, US dates.
//
// Phase shape:
//   id, n, title, icon (lucide name, resolved in ImplementationGuide.jsx)
//   owner     - who does it: 'Nexus Team' | 'Client IT' | 'Client Admin' | 'Client HR' | mixes
//   time      - rough effort for a company of ~50 people
//   summary   - one line
//   why       - the logic, a short paragraph (or two)
//   needs     - phases / facts that must exist first
//   decisions - questions to settle with the client before the steps
//   steps     - [{ title, where, view, sub, items: [...] }] - `view`/`sub` make the Open button
//   checks    - [{ id, text }] - the shared, tickable done-list (ids are stable; never reuse one)
//   pitfalls  - things that went wrong before, and how to avoid them

export const IMPL_INTRO = {
  title: 'Implementation Guide',
  lead: 'Everything an organization sets up so Nexus works the way it runs - companies, people, access, time and pay, the modules it uses and the integrations behind them - in the order it has to happen.',
  audience: 'For whoever implements Nexus: the Nexus team onboarding a new client, or the client’s owner and administrators. Everyday users want Documentation instead.',
  howTo: [
    'Work the phases in order. Each one leans on the ones before it: job roles need companies, people need job roles, timecards need people and pay rules.',
    'Settle the Decisions with the client before touching a screen - most rework comes from setting something up before the answer was known.',
    'Each step’s Open button takes you to the screen it describes. Tick a check when it is really true, not when the screen was visited; the whole team sees the same progress and who ticked what.',
    'Plan on two to three weeks for an organization of about fifty people: a week for phases 1 to 5, a week for time, shifts and the modules, and a few days of verification and training before go-live.',
  ],
};

// How Nexus is organized - read once before Phase 1.
export const IMPL_CONCEPTS = [
  { term: 'Organization', text: 'One Nexus deployment, one Microsoft 365 tenant. Global Settings (Settings > Global Settings) apply to everything in it.' },
  { term: 'Company', text: 'A legal entity the organization runs (Settings > Company Settings). Each has its own departments, locations, holiday calendar, workforce analytics policy, managers, HR contact and job roles. One organization can hold many companies.' },
  { term: 'Department', text: 'A team inside one company (Operations, Accounting, IT...). Used by people, tasks, tickets and reporting. Keep the list short and aligned with how the books are organized - sub-teams belong in shifts groups or task teams, not new departments.' },
  { term: 'Location', text: 'A physical site people punch in at, placed once in the Location Library from its Google Maps link with a geofence radius, then switched on for the companies that use it.' },
  { term: 'Job Role', text: 'What a person does: a seniority tier, a department, a bundle of modules at set levels, the time-clock exemptions, the Teams chat or channel their day messages post to, and a default approver. Giving someone a role gives them all of it at once.' },
  { term: 'Tier', text: 'Employee, Supervisor, Manager, IT Admin (Administrator) or Global Admin (Owner). It decides what a person can approve and how far they see - a Manager with People sees their own team; IT Admins grant access up to Manager; only Global Admins manage other admins and see across company walls.' },
  { term: 'Access Level', text: 'Each module is granted at Viewer, Editor, Full or Owner. Viewer reads, Editor creates and edits, Full runs the module, Owner also manages who else gets in.' },
  { term: 'Access Group', text: 'Extra modules on top of a job role, for a few people who need more than their role (a payroll helper who also needs Accounting). Additive only - it never takes access away.' },
  { term: 'Company Walls', text: 'When on, a person whose role belongs to a company sees only that company’s people and records. Global Admins see across all of them. Turn it on once every person has a company.' },
  { term: 'Person', text: 'A People record: Employee (on payroll), Independent Contractor, or External (a partner-company person who signs in with an emailed code). Internal people sign in with Microsoft 365; Nexus never stores their password.' },
  { term: 'Reports To', text: 'The reporting line. It drives the org chart, who approves time off and timesheets, who a manager sees in People, and who gets a person’s day-message notifications. Get it right early - half of Nexus reads it.' },
];

// What to ask the client before Phase 1 - the kickoff questionnaire.
export const IMPL_DISCOVERY = [
  { area: 'Organization', questions: [
    'Which legal entities (companies) will use Nexus? Legal name, country, tax ID and addresses for each.',
    'Which email domains does each company use? (People are matched to their company by email domain.)',
    'Who is the owner (Global Admin) and who administers Nexus day to day (IT Admins)?',
    'Who is HR for each company? Their HR contact signs every timesheet last.',
    'Is there one manager over all companies (the group manager)?',
  ]},
  { area: 'People', questions: [
    'How many people, in which companies and departments? Is the Microsoft 365 directory clean (titles, departments, managers), or does HR hold the truth?',
    'Who reports to whom? Get an org chart or a spreadsheet of Reports To for everyone.',
    'Which jobs exist, and what should each be able to open? (This becomes the job roles.)',
    'Are there contractors? Partner-company people who need limited access (externals)?',
    'Which offices and work addresses should Microsoft 365 show for each person?',
  ]},
  { area: 'Time and Pay', questions: [
    'Who clocks in? Who is salaried and exempt from time tracking?',
    'Pay periods: biweekly hourly, monthly salaried? Which overtime rule applies (California, Federal, none)?',
    'Punch rounding, auto-lunch deduction, California paid rest breaks?',
    'Which sites do people punch in at? Who works remotely or in the field?',
    'Is screen monitoring used while clocked in? Who is exempt (usually leadership)?',
    'Should people post beginning-of-day and end-of-day messages to Teams? Which chat or channel per team? Who cannot type them (field crews)?',
    'Which holidays does each company observe, per country? Which time-off reasons (Vacation, Sick, PTO...)?',
  ]},
  { area: 'Modules and Integrations', questions: [
    'Which modules will they use at launch? Which wait for phase two?',
    'Ticket desks: which departments take tickets, who works them, what SLAs?',
    'Files: do they use Egnyte? Accounting: Sage Intacct? Marketing: Google Business Profile and Google Ads?',
    'Existing data to bring in: items and equipment (spreadsheet), properties, passwords for the vault, dashboard links, SOPs and policies.',
  ]},
];

// Microsoft 365 and other integrations - the reference table for Phase 1.
export const IMPL_INTEGRATIONS = [
  { name: 'Microsoft Entra ID (sign-in)', what: 'Single sign-on for every internal person. Nexus keeps no passwords.', setup: 'An app registration in the client tenant with a web redirect to Nexus; tenant ID, client ID and secret go in the Nexus server settings. Admin consent once.', perms: 'openid, profile, email, offline_access' },
  { name: 'Microsoft Graph (directory)', what: 'Directory sync, provisioning new accounts and licenses, the Microsoft 365 contact-info sync both ways, photos, offboarding (revoking sessions).', setup: 'Application permissions on the same app registration, with admin consent. Writes to Microsoft 365 happen from production only.', perms: 'User.ReadWrite.All, plus license assignment for provisioning' },
  { name: 'Microsoft Teams', what: 'Beginning-of-day, end-of-day and break messages posted as the person into a chat or channel, and ticket-update chats. Each post ends with a small "Sent by Nexus" line.', setup: 'Delegated permissions, consented once by an admin. Each person must be a member of the chat or channel their role posts to.', perms: 'Chat.ReadBasic, Chat.Create, ChatMessage.Send, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Send' },
  { name: 'Outlook Actionable Messages', what: 'Task emails people can act on inside Outlook (optional).', setup: 'Register the originator in the Actionable Email Developer Dashboard and set the originator and audience in the server settings - see docs/Actionable-Messages-Setup.md.', perms: 'Entra ID token audience (the app ID URI and client ID)' },
  { name: 'Email (Mail.Send)', what: 'Every Nexus email: notifications, the daily briefing, weekly digest, ticket and task emails, e-sign requests.', setup: 'A sending mailbox (shared inbox) and Mail.Send for it. Appearance is set in Branding & Policies > Email Appearance.', perms: 'Mail.Send (and Mail.ReadWrite for ticket replies by email)' },
  { name: 'Egnyte', what: 'Files: browse and upload as yourself, property folders, signed documents filed automatically.', setup: 'Each person clicks Connect Egnyte once in Files; an admin maps Folder Groups and where new property folders and signed documents go.', perms: 'Per-user Egnyte OAuth' },
  { name: 'Sage Intacct (Nexus Accounting)', what: 'The Accounting dashboard, close and reporting figures, leasing rent received.', setup: 'Connected through the Nexus Accounting app with an internal key; entity access per person in Accounting > Access.', perms: 'Intacct web services user (in the accounting app)' },
  { name: 'Google Business Profile and Google Ads', what: 'Marketing: reviews, listings, ad spend and budgets.', setup: 'An admin connects each Google account once from Marketing.', perms: 'Google OAuth consent' },
  { name: 'Workforce Analytics agent', what: 'Coverage, activity and screenshots while clocked in, on company computers.', setup: 'Install the desktop agent on each company computer (Workforce Analytics > Enroll a Company Computer), or use Chrome screen share.', perms: 'Disclosed in the sign-in policy everyone accepts' },
];

export const IMPL_PHASES = [
  // ── 0 ────────────────────────────────────────────────────────────────────
  {
    id: 'kickoff', n: 0, title: 'Kickoff and Discovery', icon: 'ClipboardList', owner: 'Nexus Team + Client Admin', time: '1 to 2 meetings',
    summary: 'Agree who does what, collect the answers every later phase depends on, and set the go-live date.',
    why: 'Nexus mirrors how an organization actually runs - its companies, reporting lines, pay rules and ways of working. Every screen in later phases asks a question the client has to answer. Collecting the answers first (the Discovery questions below) turns setup into data entry instead of a series of meetings.',
    decisions: [
      'Name the client’s implementation owner (signs off each phase) and their IT contact (Microsoft 365 admin).',
      'Pick the launch modules and the go-live date. Everything else can switch on later without redoing setup.',
      'Agree where the source data comes from: Microsoft 365, an HR spreadsheet, or both - and which one wins when they disagree.',
    ],
    steps: [
      { title: 'Run the Discovery questions', where: 'This guide > Discovery Questions', items: [
        'Walk the client through every Discovery question. Write the answers into a shared sheet: one tab per area (Organization, People, Time and Pay, Modules).',
        'Ask for an export of the Microsoft 365 users (name, title, department, manager, office) and an org chart. Mark which people are not in Microsoft 365 (contractors, partners).',
      ]},
      { title: 'Agree the plan', items: [
        'Share this guide’s phase list with dates against each phase and an owner per phase.',
        'Book the go-live briefing and the training sessions now (Phase 13).',
      ]},
    ],
    checks: [
      { id: 'kickoff.owner', text: 'Client implementation owner and IT contact named.' },
      { id: 'kickoff.discovery', text: 'Discovery answers collected for all four areas.' },
      { id: 'kickoff.modules', text: 'Launch modules and go-live date agreed.' },
      { id: 'kickoff.data', text: 'People export and org chart received.' },
    ],
    pitfalls: [
      'Starting before Reports To is known. Approvals, the org chart and manager views all read it - fixing it later means re-checking every approval chain.',
    ],
  },

  // ── 1 ────────────────────────────────────────────────────────────────────
  {
    id: 'microsoft-365', n: 1, title: 'Connect Microsoft 365', icon: 'Cloud', owner: 'Nexus Team + Client IT', time: 'Half a day',
    summary: 'Sign-in, the directory, Teams and email - the plumbing everything else runs on.',
    why: 'People sign in to Nexus with their Microsoft 365 work account, and Nexus reads and writes the directory (titles, offices, phones, managers), posts to Teams and sends email through Microsoft 365. Until this is connected nothing else can be tested. The client’s IT grants the permissions once; Nexus never sees anyone’s password.',
    needs: ['A Microsoft 365 Global Administrator on the client side for admin consent.'],
    decisions: [
      'Which mailbox Nexus sends email from (usually a shared inbox like nexus@company.com).',
      'Whether Outlook Actionable Messages (act on task emails inside Outlook) are wanted now or later.',
      'Which environment is production. Only production writes to Microsoft 365; test environments only read, so test data never overwrites the real directory.',
    ],
    steps: [
      { title: 'Register the app and grant consent', where: 'Microsoft Entra admin center (client tenant)', items: [
        'Create the app registration for Nexus with the web redirect address of the client’s Nexus site.',
        'Add the permissions listed under Integrations below (sign-in, Graph directory, Teams, Mail.Send) and click Grant admin consent.',
        'Hand the tenant ID, client ID and client secret to the Nexus team for the server settings.',
      ]},
      { title: 'Tell Nexus which domains are the client’s', where: 'Settings > Company Settings > a company > Overview > Email Domains', view: 'admin-console', sub: 'company', items: [
        'List every email domain each company uses. The directory sync brings in only people on these domains and tags them to that company.',
      ]},
      { title: 'Optional: Actionable Messages', items: [
        'Follow docs/Actionable-Messages-Setup.md: register the originator and set the originator and audience server settings. Task emails then carry buttons that work inside Outlook.',
      ]},
    ],
    checks: [
      { id: 'm365.signin', text: 'An admin from the client can sign in to Nexus with their Microsoft 365 account.' },
      { id: 'm365.consent', text: 'Admin consent granted for directory, Teams and Mail.Send permissions.' },
      { id: 'm365.domains', text: 'Every company’s email domains entered.' },
      { id: 'm365.mail', text: 'A test notification email arrived from the sending mailbox.' },
    ],
    pitfalls: [
      'Pushing to Microsoft 365 from a test site. Test and production share one tenant - only production writes, and that switch must stay as it is.',
      'Teams posts fail for a person who is not a member of the chat or channel their role posts to. Add them in Teams first.',
    ],
  },

  // ── 2 ────────────────────────────────────────────────────────────────────
  {
    id: 'branding', n: 2, title: 'Brand, Sign-In Policy and Security', icon: 'Palette', owner: 'Client Admin', time: '1 to 2 hours',
    summary: 'Make Nexus look like the client, publish the policy everyone accepts, and set session rules.',
    why: 'Before anyone else signs in, Nexus should carry the client’s brand and the policy they want accepted. The sign-in policy is versioned: everyone accepts it on first sign-in and again whenever it changes, so publishing it before people arrive saves asking everyone twice.',
    decisions: [
      'Brand color and logo. The email look: logo, title, footer text and company address line.',
      'The sign-in policy wording - especially the monitoring disclosure if screen monitoring is used (legal or HR should approve it).',
      'Session idle limit, and how guest (external) sign-in codes behave.',
    ],
    steps: [
      { title: 'Brand color and email appearance', where: 'Settings > Global Settings > Branding & Policies', view: 'admin-console', sub: 'global-branding', items: [
        'Brand Color: pick the accent used across Nexus.',
        'Email Appearance: logo, title, accent, footer text and company address line. Check the Preview, then save.',
      ]},
      { title: 'Publish the sign-in policy', where: 'Settings > Global Settings > Branding & Policies > Sign-In Policy', view: 'admin-console', sub: 'global-branding', items: [
        'Edit the Policy Text, Save Draft, have it approved, then click Publish and Ask Everyone.',
      ]},
      { title: 'Sessions and guest sign-in', where: 'Settings > Global Settings > Security > Sign-In & Sessions', view: 'admin-console', sub: 'global-security', items: [
        'Set the Web Session Idle Limit, Act As Session Length and the Credential Vault unlock times.',
        'Guest Sign-In: code lifetime, wrong-code attempts, lockout duration, code requests per hour and invitation link lifetime.',
      ]},
      { title: 'Email signature', where: 'Settings > Global Settings > Organization > Email Signature', view: 'admin-console', sub: 'global', items: [
        'Choose the template and sign-off. Each person’s signature fills from their profile and their company’s logo and address.',
      ]},
    ],
    checks: [
      { id: 'brand.color', text: 'Brand color and email appearance set and previewed.' },
      { id: 'brand.policy', text: 'Sign-in policy approved and published.' },
      { id: 'brand.sessions', text: 'Session and guest sign-in limits set.' },
      { id: 'brand.signature', text: 'Email signature template chosen.' },
    ],
    pitfalls: [
      'Publishing a policy change asks everyone to accept again - make the edits before people start signing in.',
    ],
  },

  // ── 3 ────────────────────────────────────────────────────────────────────
  {
    id: 'companies', n: 3, title: 'Companies, Departments, Locations and Holidays', icon: 'Building2', owner: 'Client Admin + Client HR', time: '2 to 4 hours per company',
    summary: 'Build each legal entity: its profile, departments, the sites people punch in at, and its holiday calendar.',
    why: 'A company is the frame everything else hangs on. People belong to one, job roles are created inside one, departments come from its list, punches are judged against its locations, and holidays show on its people’s calendars. Departments double as the cost-center lines in the books, so keep them few and aligned with accounting - sub-teams go in shift groups or task teams.',
    needs: ['Phase 1 (domains).'],
    decisions: [
      'For each company: legal name, country, tax ID, physical and mailing address, signatory, logo, website, main phone.',
      'Its managers, its HR contact (the last signature on every timesheet), and the group manager over all companies.',
      'Departments per company, matched to the chart of accounts.',
      'Every work site: its Google Maps link and a geofence radius. Which companies use each.',
      'Holidays per company and country, for this year and the next few.',
    ],
    steps: [
      { title: 'Add each company', where: 'Settings > Company Settings > Add Company', view: 'admin-console', sub: 'company', items: [
        'Overview: legal details, logo, domains, main phone and social links, the company manager(s) and the HR Contact.',
        'Set the Group Manager (the person above every company) once, on the Company Settings page.',
      ]},
      { title: 'Departments', where: 'Company Settings > the company > Departments', view: 'admin-console', sub: 'company', items: [
        'Add the company’s departments. Tasks, tickets and People all use this one list.',
      ]},
      { title: 'Locations', where: 'Settings > Global Settings > Organization > Location Library', view: 'admin-console', sub: 'global', items: [
        'Add each site once: paste its Google Maps link (that places it), set the radius, and pick the companies whose people punch in there.',
        'Or from the company: Company Settings > the company > Locations.',
      ]},
      { title: 'Holiday calendar', where: 'Company Settings > the company > Holiday Calendar', view: 'admin-console', sub: 'company', items: [
        'Pick the country and year to see its public holidays, and add the ones the company observes. Add company-only days by hand.',
        'Use Copy to Year(s) to roll the set forward, and save it as a Holiday Policy to reuse in another company instead of rebuilding it.',
      ]},
      { title: 'Workforce analytics policy', where: 'Company Settings > the company > Workforce Analytics Policy', view: 'admin-console', sub: 'company', items: [
        'If monitoring is used: what is captured while clocked in (screenshots, activity) and the capture interval. Leave it off if the client does not monitor.',
      ]},
    ],
    checks: [
      { id: 'company.profiles', text: 'Every company added with its legal details, logo and domains.' },
      { id: 'company.contacts', text: 'Managers and HR contact set for every company; group manager set.' },
      { id: 'company.departments', text: 'Departments added for every company, aligned with accounting.' },
      { id: 'company.locations', text: 'Every work site placed from its Google Maps link and assigned to its companies.' },
      { id: 'company.holidays', text: 'Holiday calendar filled for this year and next, for every company.' },
      { id: 'company.monitoring', text: 'Workforce analytics policy decided (on with settings, or off) for every company.' },
    ],
    pitfalls: [
      'Too many departments. Microsoft and every ERP push back on "maintenance support" vs "maintenance admin" - one department, sub-teams elsewhere.',
      'A location without its Google Maps link has no point on the map, so no punch can be judged on-site there.',
      'No HR contact on a company: timesheets cannot finish their signing chain.',
    ],
  },

  // ── 4 ────────────────────────────────────────────────────────────────────
  {
    id: 'roles', n: 4, title: 'Job Roles and Access', icon: 'ShieldCheck', owner: 'Client Admin', time: 'Half a day',
    summary: 'Turn every job into a role that carries its modules, tier, time-clock rules and Teams destination.',
    why: 'Access in Nexus is given by role, not person by person: build the role once and everyone given it gets the same screens, the same approval reach and the same time-clock rules, from day one. A person’s access is their job role plus any Access Groups (extras), plus rare per-person overrides. Building roles before adding people means each person is set up in one click.',
    needs: ['Phase 3 (companies and departments).'],
    decisions: [
      'The list of jobs per company, and for each: tier, department, modules and level per module.',
      'Who is exempt from screen-share monitoring, from beginning/end-of-day messages, and from time tracking (salaried leadership).',
      'Where each role’s day messages post in Teams (a group chat or a channel).',
      'The default approver per role (used when a person has no manager yet).',
      'Who the Global Admins are - keep it to a very few.',
    ],
    steps: [
      { title: 'Create the job roles', where: 'Settings > Company Settings > the company > Roles', view: 'admin-console', sub: 'company', items: [
        'New Role: name, seniority tier, department and a plain description.',
        'Module Bundle: click a level per module (the x on the selected level removes it). Inherit from an existing role to start fast; Duplicate a role for the same job in another company.',
        'Time Clock: Exempt from screen-share monitoring, Skip day and break messages, Exempt from time tracking - as decided.',
        'Teams Messages: bind the group chat or channel this role’s beginning-of-day, end-of-day and break messages post to.',
        'Set the default approver.',
      ]},
      { title: 'Access Groups for the extras', where: 'Settings > Global Settings > Access > People & Access Groups', view: 'admin-console', sub: 'access', items: [
        'Create a group only for access a few people need beyond their role, and add those people.',
      ]},
      { title: 'Check the matrix', where: 'Settings > Global Settings > Access', view: 'admin-console', sub: 'access', items: [
        'Read the access matrix role by role. Every module a role opens should have a reason.',
        'Company Walls: switch on once every person has a company (Phase 5), so people only see their own company.',
      ]},
    ],
    checks: [
      { id: 'roles.created', text: 'A job role exists for every job, in every company.' },
      { id: 'roles.bundles', text: 'Every role’s module bundle reviewed with the client.' },
      { id: 'roles.exemptions', text: 'Monitoring, day-message and time-tracking exemptions set on the right roles.' },
      { id: 'roles.teams', text: 'Every role that posts day messages has its Teams chat or channel bound.' },
      { id: 'roles.admins', text: 'Global Admins and IT Admins named and limited.' },
    ],
    pitfalls: [
      'Granting through per-person overrides instead of roles. It works on day one and becomes unmanageable by month three.',
      'Sharing one role across companies when the job exists in two. Duplicate it per company so walls and departments stay correct.',
    ],
  },

  // ── 5 ────────────────────────────────────────────────────────────────────
  {
    id: 'people', n: 5, title: 'People: Employees, Contractors and Externals', icon: 'Users', owner: 'Client HR + Client Admin', time: '1 to 2 days',
    summary: 'Bring everyone in, give them a company, role, manager and contact details, and invite partner users.',
    why: 'People is the master list. Each record ties a person to their company, department, job role (their access), manager (their approvals) and the contact details Microsoft 365 shows. Importing from Microsoft 365 avoids retyping, then HR completes what the directory does not know. From then on HR edits people in Nexus and Microsoft 365 stays in step both ways.',
    needs: ['Phase 1 (Microsoft 365), Phase 3 (companies), Phase 4 (job roles).'],
    decisions: [
      'Which source wins for titles, departments and managers on the first import (Microsoft 365 or HR’s sheet).',
      'Employment type per person: full-time, part-time, contractor, intern.',
      'Which partner-company people get Nexus (externals) and what they may see.',
    ],
    steps: [
      { title: 'Import the directory', where: 'Settings > Tools > Microsoft 365 Directory Sync', view: 'admin-console', sub: 'tools', items: [
        'Click Sync Now. People on the company domains are created and tagged to their company, with their profile photos; shared mailboxes, rooms and inactive accounts are skipped. It runs in the background.',
      ]},
      { title: 'Complete every record', where: 'People > a person > Edit', view: 'hr', sub: 'hr-people', items: [
        'Company and department, employment type, start date, Reports To.',
        'Office & Contact: office, mobile and office phone, street address, city, state, ZIP and country. Saved changes update Microsoft 365; changes made there come back within 15 minutes or with Sync Now.',
        'Access tab: give the job role. Their modules, tier, exemptions and Teams destination follow.',
        'Work Mode tab: on-site, remote, or the usual locations they punch in at.',
      ]},
      { title: 'Add people who are not in the directory yet', where: 'People > Add Person', view: 'hr', sub: 'hr-people', items: [
        'Add Employee or Add Independent Contractor (scope, SOW and rate live on the same record).',
        'Provision Accounts creates their Microsoft 365 account and licenses; send the welcome email.',
      ]},
      { title: 'Invite externals', where: 'People > Add Person > Add External', view: 'hr', sub: 'hr-people', items: [
        'Email, name and partner company. They sign in with a code sent by email (or text once their phone is verified).',
        'Limit what they see on their Access tab (for example one company), and set an expiry if the engagement ends.',
      ]},
      { title: 'Pay and benefits', where: 'People > a person > Pay & Benefits', view: 'hr', sub: 'hr-people', items: [
        'Pay basis, base amount, frequency, currency and effective date; the overtime rule (California, Federal or None). Needs the People - Compensation grant.',
      ]},
    ],
    checks: [
      { id: 'people.imported', text: 'Directory imported; everyone is in People with the right company.' },
      { id: 'people.reports', text: 'Reports To set for every person; the org chart looks right.' },
      { id: 'people.roles', text: 'Every person has a job role.' },
      { id: 'people.contact', text: 'Office and contact details complete and showing in Microsoft 365.' },
      { id: 'people.pay', text: 'Pay set for everyone who is paid through Nexus timecards.' },
      { id: 'people.externals', text: 'External users invited and limited to what they need.' },
      { id: 'people.walls', text: 'Company walls switched on (if the client has more than one company).' },
    ],
    pitfalls: [
      'Editing people in the Microsoft 365 admin center instead of Nexus. It syncs back, but HR loses the audit trail of who changed what - make Nexus the place.',
      'A manager with no People grant cannot see their team’s time. Give managers the People grant through their role; with the Manager tier they see only their own team.',
    ],
  },

  // ── 6 ────────────────────────────────────────────────────────────────────
  {
    id: 'time-pay', n: 6, title: 'Time Clock, Timesheets and Leave', icon: 'Clock', owner: 'Client HR + Client Admin', time: 'Half a day + a test pay period',
    summary: 'Set the pay rules, the timesheet signing chain, time off and monitoring - then run a test period.',
    why: 'Timecards are computed from punches with the organization’s rules: rounding, auto-lunch, California rest breaks, each person’s overtime rule, and leave classes (sick and vacation are paid at base and kept out of overtime). A timesheet is then reviewed by the person’s manager (Reports To) and signed employee, manager, then the company’s HR contact. Getting the rules right before the first live pay period avoids re-running payroll.',
    needs: ['Phase 5 (people, managers, pay).'],
    decisions: [
      'Punch rounding, auto-lunch deduction and California paid rest breaks.',
      'Time-off reasons beyond the standard ones.',
      'Who reviews time: managers via People > Time, HR across everyone.',
    ],
    steps: [
      { title: 'Pay rules', where: 'Settings > Global Settings > Time Clock > Pay Rules', view: 'admin-console', sub: 'global-timeclock', items: [
        'Punch rounding, the auto-lunch deduction and California paid rest breaks - the rules every timecard is computed with.',
      ]},
      { title: 'Time off', where: 'Settings > Global Settings > Shifts > Shift Settings', view: 'admin-console', sub: 'global-shifts', items: [
        'Add the time-off reasons the client uses. Requests route to the person’s manager; approved time off is not punched in automatically.',
      ]},
      { title: 'Monitoring computers', where: 'Workforce Analytics', view: 'employee-tracking', items: [
        'If monitoring is on: enroll each company computer (desktop agent), or have people share their screen in Chrome when clocking in.',
      ]},
      { title: 'Run a test pay period', where: 'People > Time', view: 'hr', sub: 'hr-time', items: [
        'Have a few people punch in and out for a week, with a break, a missed punch and a punch request.',
        'Clear the Action Log (punch requests and missing punches), then submit, agree and sign one timesheet end to end through the HR contact.',
        'Compare totals and overtime with the client’s current payroll for the same days.',
      ]},
    ],
    checks: [
      { id: 'time.rules', text: 'Pay rules set and confirmed by payroll.' },
      { id: 'time.exempt', text: 'Salaried people exempt from time tracking (via their role) see no clock.' },
      { id: 'time.timeoff', text: 'Time-off reasons set; a test request was approved by the right manager.' },
      { id: 'time.monitoring', text: 'Monitoring computers enrolled, or monitoring confirmed off.' },
      { id: 'time.test', text: 'A test timesheet was signed employee, manager, HR - totals match payroll.' },
    ],
    pitfalls: [
      'Wrong Reports To sends timesheets and time off to the wrong approver.',
      'A leave punch must use a job category Nexus recognizes as Sick or Vacation (Sick Day, PTO, Annual Leave...) to be paid as leave.',
    ],
  },

  // ── 7 ────────────────────────────────────────────────────────────────────
  {
    id: 'shifts', n: 7, title: 'Shifts and Day Messages', icon: 'CalendarClock', owner: 'Client Admin + Managers', time: '2 to 3 hours',
    summary: 'Shift types, scheduling groups, request rules - and where beginning/end-of-day messages go.',
    why: 'Shifts show who is on and who is off, today and ahead, to the whole team. Shift types are reusable time blocks (6:00 AM - 2:00 PM) placed for a team or a person; groups are the rows of the schedule. Day messages (beginning-of-day, end-of-day, breaks) post to Teams as the person, to the chat or channel set on their job role.',
    needs: ['Phase 4 (roles with Teams destinations), Phase 5 (people).'],
    decisions: [
      'Team time zone and the first day of the week.',
      'Whether staff may request open shifts, swap or offer shifts (most offices: off).',
      'The shift types and the scheduling groups, and who schedules each group.',
    ],
    steps: [
      { title: 'Shift settings', where: 'Settings > Global Settings > Shifts > Shift Settings', view: 'admin-console', sub: 'global-shifts', items: [
        'Time zone, week start, shift reminders and what staff may request or see.',
      ]},
      { title: 'Shift types and groups', where: 'Settings > Global Settings > Shifts', view: 'admin-console', sub: 'global-shifts', items: [
        'Shift Types: name, code, color and times.',
        'Groups: members and schedulers. Leave Teams binding to the job roles; a group binding is only the fallback.',
      ]},
      { title: 'Build and publish the first schedule', where: 'Shifts > Schedule', view: 'shifts', sub: 'schedule', items: [
        'Fill a week per group, copy it forward, and publish.',
      ]},
      { title: 'Test day messages', where: 'Workday (as a test person)', view: 'myhr', items: [
        'Punch in as someone in each role: the beginning-of-day message posts to their role’s Teams chat or channel, ending with "Sent by Nexus".',
      ]},
    ],
    checks: [
      { id: 'shifts.settings', text: 'Shift settings, types and groups created.' },
      { id: 'shifts.schedule', text: 'The first schedule is published.' },
      { id: 'shifts.messages', text: 'A test beginning-of-day message posted to the right Teams chat or channel for each role.' },
    ],
    pitfalls: [
      'Creating a group for every sub-team to route Teams messages. Route by job role instead; groups are for scheduling.',
    ],
  },

  // ── 8 ────────────────────────────────────────────────────────────────────
  {
    id: 'checklists', n: 8, title: 'Onboarding and Offboarding Checklists', icon: 'ListChecks', owner: 'Client HR', time: '1 to 2 hours',
    summary: 'The steps HR, IT and managers take for every new starter, leaver and leave of absence.',
    why: 'Checklists make joining and leaving repeatable: each step has an owner and a due date counted from the start date, exit date or leave start, with reminders. Templates vary by worker type and country (an I-9 for US employees, PF for India, a W-9 for contractors).',
    steps: [
      { title: 'Owners and templates', where: 'People > Checklists > Owners & Templates', view: 'hr', sub: 'hr-checklists', items: [
        'Set the default owner for each kind of step (HR, IT, the manager).',
        'Review the onboarding, offboarding and leave templates and adjust the steps and due days to the client’s process.',
      ]},
    ],
    checks: [
      { id: 'checklists.templates', text: 'Onboarding, offboarding and leave templates reviewed and owners set.' },
    ],
    pitfalls: [
      'Offboarding is a checklist plus the Left status. Marking Left signs the person out everywhere - start the checklist first.',
    ],
  },

  // ── 9 ────────────────────────────────────────────────────────────────────
  {
    id: 'work-modules', n: 9, title: 'Tasks, Tickets, Knowledge Base, Documents and Files', icon: 'CheckSquare', owner: 'Client Admin + Module Owners', time: '1 day',
    summary: 'Set up how work is tracked, how help is asked for, where policies live and how documents are signed and filed.',
    why: 'These are the everyday work modules. Each has a small setup that decides how it behaves for everyone: task teams and fields, ticket desks and SLAs, the SOP library and sign-offs, document templates and e-signature, and the file store.',
    decisions: [
      'Task teams, custom fields and statuses; how often task emails are batched.',
      'Which departments run a ticket desk, their agents and supervisors, SLAs and help topics.',
      'Which policies need a signed acknowledgment; which trainings are required.',
      'Default document templates per type; where signed documents are filed.',
    ],
    steps: [
      { title: 'Tasks', where: 'Tasks > Manage', view: 'tasks', items: [
        'Teams, Custom Fields, Custom Statuses, Templates and Automation Rules.',
        'Task Notifications (Settings > Global Settings > Notifications & Communications): the batching window for task emails.',
      ]},
      { title: 'Ticket desks', where: 'Settings > Global Settings > Notifications & Communications > Ticket Manager', view: 'admin-console', sub: 'global-notifications', items: [
        'Routing & Escalation: departments that take tickets, their order and default agents.',
        'Notifications, SLA & Ticket Types, Help Topics per department, and Desk Access (requester, agent, supervisor).',
      ]},
      { title: 'Knowledge Base', where: 'Knowledge Base > Manage', view: 'sop', items: [
        'Load the SOPs and policies, assign sign-offs, and build required training courses.',
      ]},
      { title: 'Documents and e-signature', where: 'Documents', view: 'documents', items: [
        'Upload the templates, set a default per type, and define merge fields.',
      ]},
      { title: 'Files (Egnyte)', where: 'Files', view: 'egnyte', items: [
        'Connect Egnyte, map Folder Groups, and set where property folders and signed documents are filed.',
      ]},
    ],
    checks: [
      { id: 'work.tasks', text: 'Task teams, fields, statuses and notification batching set.' },
      { id: 'work.tickets', text: 'Ticket desks, agents, SLAs and help topics set; a test ticket reached the right agent.' },
      { id: 'work.kb', text: 'Core policies loaded with sign-offs assigned.' },
      { id: 'work.documents', text: 'Document templates uploaded; a test document was signed and filed.' },
      { id: 'work.files', text: 'Egnyte connected and folder groups mapped (if used).' },
    ],
  },

  // ── 10 ───────────────────────────────────────────────────────────────────
  {
    id: 'operations-modules', n: 10, title: 'Items, Assets, Accounting and the Other Modules', icon: 'Package', owner: 'Module Owners', time: 'Half a day to 2 days',
    summary: 'Load the catalog, the properties, the finance connection and each remaining module the client uses.',
    why: 'Each operational module starts from data the client already has - an equipment list, property list, ledger, passwords, links. Loading it in bulk now makes the module useful on day one instead of filling up slowly.',
    steps: [
      { title: 'Item Management', where: 'Settings > Global Settings > Items, then Item Management > Manage', view: 'inventory', items: [
        'Item Types & Custom Fields first, then Import Items From CSV or Excel. Assign permanent equipment to people.',
        'Equipment Reminders (Notifications & Communications): overdue returns, warranty and inspection dates.',
      ]},
      { title: 'Asset Management', where: 'Asset Management', view: 'property-asset', items: [
        'Add each property with its PM / Asset Manager (who gets its reminders and ticket alerts).',
      ]},
      { title: 'Accounting', where: 'Accounting > Access', view: 'accounting', items: [
        'Connected through Nexus Accounting (Sage Intacct). Give the Accounting grant, then limit which entities each person reads on the Access tab.',
      ]},
      { title: 'Dashboard links', where: 'Dashboard > Links > Manage Links', view: 'dashboard', items: [
        'Add company links by category, department and company, or Batch Import them.',
      ]},
      { title: 'The rest', items: [
        'Credential Vault: Batch Import shared passwords and set owners.',
        'Marketing: connect Google Business Profile and Google Ads; set lead goals and budgets per property.',
        'Investor Relations, Construction, Operations, IT and Business Intelligence: give the grants to their owners and load their records.',
      ]},
    ],
    checks: [
      { id: 'ops.items', text: 'Item types set and the catalog imported (if used).' },
      { id: 'ops.assets', text: 'Properties added with their asset managers (if used).' },
      { id: 'ops.accounting', text: 'Accounting connected and entity access set (if used).' },
      { id: 'ops.links', text: 'Company links on the Dashboard.' },
      { id: 'ops.others', text: 'Every other launch module has its owner and starting data.' },
    ],
  },

  // ── 11 ───────────────────────────────────────────────────────────────────
  {
    id: 'notifications', n: 11, title: 'Notifications and Reminders', icon: 'Bell', owner: 'Client Admin', time: '1 hour',
    summary: 'Decide who hears about what, how often, and when HR and equipment reminders fire.',
    why: 'Nexus tells people what needs them - in the bell, by email and in Teams. Too much and it is ignored; too little and work stalls. These settings set the rhythm for the whole organization.',
    steps: [
      { title: 'Communications', where: 'Settings > Global Settings > Notifications & Communications', view: 'admin-console', sub: 'global-notifications', items: [
        'Daily Briefing and Weekly Digest: on or off, send time, test recipients.',
        'HR & Compliance Reminders: visa and right-to-work expiry, contract ends, new-starter documents - days before and who is told.',
        'Equipment Reminders: overdue returns, warranties, inspections, registrations, insurance.',
      ]},
    ],
    checks: [
      { id: 'notify.briefing', text: 'Daily Briefing and Weekly Digest decided and tested.' },
      { id: 'notify.reminders', text: 'HR and equipment reminder timing set.' },
    ],
  },

  // ── 12 ───────────────────────────────────────────────────────────────────
  {
    id: 'verify', n: 12, title: 'Verify Before Go-Live', icon: 'BadgeCheck', owner: 'Nexus Team + Client Admin', time: '1 day',
    summary: 'See Nexus as each kind of person, prove each flow end to end, and fix what is off.',
    why: 'Setup screens show what was configured; only acting as real people shows what they will experience. One person per role and tier, walked through their day, catches the wrong module, the missing manager and the misrouted message before anyone else sees it.',
    steps: [
      { title: 'Act as each kind of person', where: 'Settings > Tools > Act As', view: 'admin-console', sub: 'actas', items: [
        'Pick one person per job role and tier (an employee, a supervisor, a manager, HR). Check their menu, their Workday, their People view and their approvals.',
      ]},
      { title: 'Prove the flows', items: [
        'A punch in and out with the day messages; a punch request approved from the Action Log.',
        'A time-off request approved by the right manager; a timesheet signed through HR.',
        'A ticket raised and routed; a task email received; a document signed and filed.',
        'A profile change in Nexus appearing in Microsoft 365, and one made there coming back.',
      ]},
      { title: 'Review the logs', where: 'Settings > Logs', view: 'admin-console', sub: 'audit', items: [
        'Every access and settings change is recorded - skim it for anything unexpected.',
      ]},
    ],
    checks: [
      { id: 'verify.actas', text: 'Acted as one person per role and tier; menus and data are right.' },
      { id: 'verify.flows', text: 'Every launch flow proven end to end.' },
      { id: 'verify.signoff', text: 'Client implementation owner signed off.' },
    ],
  },

  // ── 13 ───────────────────────────────────────────────────────────────────
  {
    id: 'go-live', n: 13, title: 'Go Live and Train', icon: 'Rocket', owner: 'Nexus Team + Client', time: '1 to 2 days',
    summary: 'Announce, train each audience, and support the first pay period closely.',
    why: 'People adopt what they are shown. Short sessions per audience (everyone, managers, HR, admins) using the built-in Tours, Documentation and Help with This Page get Nexus used the way it was set up.',
    steps: [
      { title: 'Announce and train', items: [
        'Send the go-live announcement with the sign-in link and the date the old tools stop.',
        'Everyone: Workday, punching in, time off, Support and Help with This Page.',
        'Managers: People (their team), approvals, the Action Log, Shifts.',
        'HR: People, Checklists, Pay & Benefits, timesheet signing.',
        'Admins: Settings, Access, Act As, Logs - and this guide.',
      ]},
      { title: 'Watch the first weeks', items: [
        'Watch the first pay period closely: the Action Log daily, missing punches, unsigned timesheets.',
        'Collect feedback through Support tickets; publish fixes in What’s New.',
      ]},
    ],
    checks: [
      { id: 'live.announced', text: 'Go-live announced to everyone.' },
      { id: 'live.trained', text: 'Everyone, managers, HR and admins trained.' },
      { id: 'live.payroll', text: 'The first live pay period closed cleanly.' },
    ],
  },

  // ── 14 ───────────────────────────────────────────────────────────────────
  {
    id: 'run', n: 14, title: 'Running Nexus After Go-Live', icon: 'RefreshCw', owner: 'Client Admin + Client HR', time: 'Ongoing',
    summary: 'The routines that keep Nexus accurate: joiners, leavers, roles, holidays and access reviews.',
    why: 'An implementation stays good only if the routines around it do. Most drift comes from people joining or leaving outside Nexus, roles edited person by person, and next year’s holidays never added.',
    steps: [
      { title: 'Joiners and leavers', where: 'People', view: 'hr', sub: 'hr-people', items: [
        'Joiner: Add Employee, give the job role and manager, provision, start the onboarding checklist.',
        'Leaver: start the offboarding checklist the day notice is received, hand over tasks, set mailbox handling, then mark Left.',
      ]},
      { title: 'Regular reviews', items: [
        'Quarterly: read the access matrix and Access Groups; remove what is no longer needed.',
        'Yearly: copy each company’s holiday calendar forward; review pay rules and the sign-in policy.',
        'Change a job role rather than a person when a whole job changes - it applies to everyone with that role at once.',
      ]},
    ],
    checks: [
      { id: 'run.owners', text: 'Owners named for joiners/leavers, access reviews and yearly holidays.' },
    ],
  },
];

export const IMPL_CHECK_IDS = IMPL_PHASES.flatMap((p) => p.checks.map((c) => c.id));
