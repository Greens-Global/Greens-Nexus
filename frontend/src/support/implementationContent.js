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
    'Work the phases in order. Each one leans on the ones before it: job roles need companies, people need job roles, time sheets need people and pay rules.',
    'Settle the Decisions with the client before touching a screen - most rework comes from setting something up before the answer was known.',
    'Each step’s Open button takes you to the screen it describes. Tick a check when it is really true, not when the screen was visited; the whole team sees the same progress and who ticked what.',
    'Plan on two to three weeks for an organization of about fifty people: a week for phases 1 to 5, a week for time, shifts and the modules, and a few days of verification and training before go-live.',
  ],
};

// How Nexus is organized - read once before Phase 1.
export const IMPL_CONCEPTS = [
  { term: 'Organization', text: 'One Nexus deployment, one Microsoft 365 tenant. Settings with the scope on Every company apply to everything in it.' },
  { term: 'Company', text: 'A legal entity the organization runs (Settings > Companies). Pick it in the Scope box at the top of Settings to see what is set for it alone. Each has its own departments, locations, holiday calendar, workforce analytics policy, managers, HR contact and job roles. One organization can hold many companies.' },
  { term: 'Department', text: 'A team inside one company (Operations, Accounting, IT...). Used by people, tasks, tickets and reporting. Keep the list short and aligned with how the books are organized - sub-teams belong in shifts groups or task teams, not new departments.' },
  { term: 'Holiday Policy', text: 'A named set of holidays with its weekend rule (Settings > Companies > Holiday Policies), applied to one or more companies. Each company’s Holiday Calendar shows its policies’ holidays and can skip or change any of them, or add its own.' },
  { term: 'Location', text: 'A physical site people punch in at, placed once in the Location Library from its Google Maps link with a geofence radius, then switched on for the companies that use it.' },
  { term: 'Job Role', text: 'What a person does: a seniority tier, a department, a bundle of modules at set levels, the time-clock exemptions, the Teams chat or channel their day messages post to, and a default approver. Giving someone a role gives them all of it at once.' },
  { term: 'Tier', text: 'Employee, Supervisor, Manager, IT Admin (Administrator) or Global Admin (Owner). It decides what a person can approve and how far they see - a Manager with People sees their own team; IT Admins grant access up to Manager; only Global Admins manage other admins and see across company walls.' },
  { term: 'Access Level', text: 'Each module is granted at Viewer, Editor, Full or Owner. Viewer reads, Editor creates and edits, Full runs the module, Owner also manages who else gets in.' },
  { term: 'Access Group', text: 'Extra modules on top of a job role, for a few people who need more than their role (a payroll helper who also needs Accounting). Additive only - it never takes access away.' },
  { term: 'Company Walls', text: 'When on, a person whose role belongs to a company sees only that company’s people and records. Global Admins see across all of them. Turn it on once every person has a company.' },
  { term: 'Person', text: 'A People record: Employee (on payroll), Independent Contractor, or External (a partner-company person who signs in with an emailed code). Internal people sign in with Microsoft 365; Nexus never stores their password.' },
  { term: 'Reports To', text: 'The reporting line. It drives the org chart, who approves time off and time sheets, who a manager sees in People, and who gets a person’s day-message notifications. Get it right early - half of Nexus reads it.' },
];

// What to ask the client before Phase 1 - the kickoff questionnaire.
export const IMPL_DISCOVERY = [
  { area: 'Organization', questions: [
    'Which legal entities (companies) will use Nexus? Legal name, country, tax ID and addresses for each.',
    'Which email domains does each company use? (People are matched to their company by email domain.)',
    'Who is the owner (Global Admin) and who administers Nexus day to day (IT Admins)?',
    'Who is HR for each company? Their HR contact reviews time sheets for people with no manager, can change or finalize any time sheet, and pays reimbursements.',
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
    'Any shift differentials (nights, weekends, sites) or call-back minimums? What are the payroll item names in QuickBooks? Any hourly staff in California?',
  ]},
  { area: 'Modules and Integrations', questions: [
    'Which modules will they use at launch? Which wait for phase two?',
    'Ticket desks: which departments take tickets, who works them, what SLAs?',
    'Files: do they use Egnyte? Accounting: Sage Intacct? Payroll: QuickBooks? Storage facilities: Cubby? Marketing: Google Business Profile and Google Ads?',
    'Existing data to bring in: items and equipment (spreadsheet), properties, passwords for the vault, dashboard links, SOPs and policies.',
  ]},
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
      { title: 'Run the Discovery Questions', where: 'This guide > Discovery Questions', items: [
        'Walk the client through every Discovery question. Write the answers into a shared sheet: one tab per area (Organization, People, Time and Pay, Modules).',
        'Ask for an export of the Microsoft 365 users (name, title, department, manager, office) and an org chart. Mark which people are not in Microsoft 365 (contractors, partners).',
      ]},
      { title: 'Agree the Plan', items: [
        'Share this guide’s phase list with dates against each phase and an owner per phase.',
        'Book the go-live briefing and the training sessions now (Phase 14).',
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
      { title: 'Register the App and Grant Consent', where: 'Microsoft Entra admin center (client tenant)', items: [
        'Create the app registration for Nexus with the web redirect address of the client’s Nexus site.',
        'Add the permissions and click Grant admin consent: sign-in (openid, profile, email, offline_access); directory (User.ReadWrite.All, plus license assignment for provisioning); Teams (Chat.ReadBasic, Chat.Create, ChatMessage.Send, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Send); email (Mail.Send, and Mail.ReadWrite for ticket replies by email).',
        'Hand the tenant ID, client ID and client secret to the Nexus team for the server settings.',
      ]},
      { title: 'Tell Nexus Which Domains Are the Client’s', where: 'Settings > Companies > pick the company > Company > Email Domains', view: 'admin-console', sub: 'companies', items: [
        'List every email domain each company uses. The directory sync brings in only people on these domains and tags them to that company.',
      ]},
      { title: 'Optional: Actionable Messages', items: [
        'Follow docs/Actionable-Messages-Setup.md: register the originator and set the originator and audience server settings. Task emails then carry buttons that work inside Outlook.',
      ]},
      { title: 'Optional: Teams Status and Outlook Shift Calendars', where: 'Microsoft Entra admin center (client tenant)', items: [
        'For Teams status on Team > Company Directory, add the Presence.Read.All application permission and grant admin consent (docs/Teams-Presence-Setup.md). Until then the Company Directory simply shows no status.',
        'To put shared shifts on Outlook calendars, add Calendars.ReadWrite (application) and grant consent (docs/Outlook-Calendar-Setup.md). Nothing is written until a company also turns it on in Settings > Shifts & Scheduling > Sharing.',
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
      { title: 'Brand Color and Email Appearance', where: 'Settings > Branding & Email', view: 'admin-console', sub: 'branding', items: [
        'Brand Color: pick the accent used across Nexus.',
        'Email Appearance: logo, title, accent, footer text and company address line. Check the Preview, then save.',
      ]},
      { title: 'Publish the Sign-In Policy', where: 'Settings > Security > Sign-In Policy', view: 'admin-console', sub: 'security:signin-policy', items: [
        'Edit the Policy Text, Save Draft, have it approved, then click Publish and Ask Everyone.',
      ]},
      { title: 'Sessions and Guest Sign-In', where: 'Settings > Security > Sign-In & Sessions', view: 'admin-console', sub: 'security:sign-in-sessions', items: [
        'Set the Web Session Idle Limit, Act As Session Length and the Credentials unlock times.',
        'Guest Sign-In: code lifetime, wrong-code attempts, lockout duration, code requests per hour and invitation link lifetime.',
      ]},
      { title: 'Email Signature', where: 'Settings > Branding & Email > Email Signature', view: 'admin-console', sub: 'branding:email-signature', items: [
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
      'Its managers, its HR contact (reviews time sheets for people with no manager, and can change or finalize any of them), and the group manager over all companies.',
      'Departments per company, matched to the chart of accounts.',
      'Every work site: its Google Maps link and a geofence radius. Which companies use each.',
      'Holidays: which sets of holidays the companies share (US, India...), whether a holiday that falls on a weekend moves (Keep The Date unless the client says otherwise) and, for India, which gazetted and restricted holidays count.',
      'Which departments work outdoors and get Weather Calls (Construction by default).',
    ],
    steps: [
      { title: 'Add Each Company', where: 'Settings > Companies > Add Company', view: 'admin-console', sub: 'companies', items: [
        'Overview: legal details, logo, domains, main phone and social links, the company manager(s) and the HR Contact.',
        'Set the Group Manager (the person above every company) once, at the top of the Companies list.',
      ]},
      { title: 'Departments', where: 'Settings > Companies > pick the company > Departments', view: 'admin-console', sub: 'companies', items: [
        'Add the company’s departments, each with its Department Head. Tasks, tickets and People all use this one list.',
        'Weather Calls: leave it on only for outdoor departments (on for Construction by default, off for every other). Rain advisories and weather calls reach only the people of those departments.',
      ]},
      { title: 'Locations', where: 'Settings > Locations > Location Library', view: 'admin-console', sub: 'locations', items: [
        'Add each site once: paste its Google Maps link (that places it), set the radius, and pick the companies whose people punch in there.',
        'Or pick the company in the Scope box: Locations then shows that company\'s sites.',
      ]},
      { title: 'Holiday Policies', where: 'Settings > Companies > Holiday Policies (scope: Every company)', view: 'admin-console', sub: 'companies:holiday-policies', items: [
        'Build each shared set once: New Holiday Policy, a name (US Holidays, India Holidays), the country, then Add Holidays From - Federal Holidays, Common Company Holidays or Some States Only in the US; National, Gazetted or Restricted Holidays (Optional) in India - plus any day by hand. Each holiday is Mandatory, Optional or Half Day.',
        'Pick When A Holiday Falls On A Weekend: Keep The Date (the default), Friday Before Or Monday After (Federal Rule), Always The Friday Before, Always The Monday After or No Day Off.',
        'Under Applies To, pick every company the set is for, and save. One policy can serve many companies; editing it updates all of them.',
      ]},
      { title: 'Each Company’s Holiday Calendar', where: 'Settings > Companies > pick the company > Holiday Calendar', view: 'admin-console', sub: 'companies', items: [
        'Check the year: the policies’ holidays are listed with their source. Skip For This Company, Change Date or Change Type where this company differs, and add its own days.',
      ]},
      { title: 'Workforce Analytics Policy', where: 'Settings > Workforce Analytics > pick the company', view: 'admin-console', sub: 'analytics', items: [
        'If monitoring is used: what is captured while clocked in (screenshots, activity) and the capture interval. Leave it off if the client does not monitor.',
      ]},
    ],
    checks: [
      { id: 'company.profiles', text: 'Every company added with its legal details, logo and domains.' },
      { id: 'company.contacts', text: 'Managers and HR contact set for every company; group manager set.' },
      { id: 'company.departments', text: 'Departments added for every company, aligned with accounting.' },
      { id: 'company.locations', text: 'Every work site placed from its Google Maps link and assigned to its companies.' },
      { id: 'company.holidays', text: 'Holiday calendar filled for this year and next, for every company - from its holiday policies, with the weekend rule agreed.' },
      { id: 'company.weather', text: 'Weather Calls on only for the outdoor departments.' },
      { id: 'company.monitoring', text: 'Workforce analytics policy decided (on with settings, or off) for every company.' },
    ],
    pitfalls: [
      'Too many departments. Microsoft and every ERP push back on "maintenance support" vs "maintenance admin" - one department, sub-teams elsewhere.',
      'A location without its Google Maps link has no point on the map, so no punch can be judged on-site there.',
      'No HR contact on a company: time sheets of people with no manager land with the Global Admins, and nobody there can finalize an unsigned time sheet or pay a reimbursement.',
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
      { title: 'Create the Job Roles', where: 'Settings > People & Access > pick the company > Roles', view: 'admin-console', sub: 'access', items: [
        'New Role: name, seniority tier, department and a plain description.',
        'Module Bundle: click a level per module (the x on the selected level removes it). Inherit from an existing role to start fast; Duplicate a role for the same job in another company.',
        'Time Clock: Exempt from screen-share monitoring, Skip day and break messages, Exempt from time tracking - as decided.',
        'Teams Messages: bind the group chat or channel this role’s beginning-of-day, end-of-day and break messages post to.',
        'Set the default approver.',
      ]},
      { title: 'Access Groups for the Extras', where: 'Settings > People & Access > Groups', view: 'admin-console', sub: 'access', items: [
        'Create a group only for access a few people need beyond their role, and add those people.',
      ]},
      { title: 'Check the Matrix', where: 'Settings > People & Access > Matrix', view: 'admin-console', sub: 'access', items: [
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
      { title: 'Import the Directory', where: 'Settings > Tools > Microsoft 365 Directory Sync', view: 'admin-console', sub: 'tools', items: [
        'Click Sync Now. People on the company domains are created and tagged to their company, with their profile photos; shared mailboxes, rooms and inactive accounts are skipped. It runs in the background.',
      ]},
      { title: 'Complete Every Record', where: 'People > a person > Edit', view: 'hr', sub: 'hr-people', items: [
        'Company and department, employment type, start date, Reports To.',
        'Office & Contact: office, mobile and office phone, street address, city, state, ZIP and country. Saved changes update Microsoft 365; changes made there come back within 15 minutes or with Sync Now.',
        'Role tab: give the job role. Their modules, tier, exemptions and Teams destination follow.',
        'Work Mode tab: On-Site, Remote or Hybrid (both - remote allowed, plus the usual locations they punch in at).',
      ]},
      { title: 'Add People Who Are Not in the Directory Yet', where: 'People > Add Person', view: 'hr', sub: 'hr-people', items: [
        'Add Employee or Add Independent Contractor (scope, SOW and rate live on the same record).',
        'Provision Accounts creates their Microsoft 365 account and licenses; send the welcome email.',
      ]},
      { title: 'Invite Externals', where: 'People > Add Person > Add External', view: 'hr', sub: 'hr-people', items: [
        'Email, name and partner company. They sign in with a code sent by email (or text once their phone is verified).',
        'Limit what they see on their Role tab (for example one company), and set an expiry if the engagement ends.',
      ]},
      { title: 'Pay and Benefits', where: 'People > a person > Pay & Benefits', view: 'hr', sub: 'hr-people', items: [
        'Pay basis, base amount, frequency, currency and effective date; the overtime rule (California, Federal or None). Needs the People - Compensation grant.',
      ]},
    ],
    checks: [
      { id: 'people.imported', text: 'Directory imported; everyone is in People with the right company.' },
      { id: 'people.reports', text: 'Reports To set for every person; the org chart looks right.' },
      { id: 'people.roles', text: 'Every person has a job role.' },
      { id: 'people.contact', text: 'Office and contact details complete and showing in Microsoft 365.' },
      { id: 'people.pay', text: 'Pay set for everyone who is paid through Nexus time sheets.' },
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
    id: 'time-pay', n: 6, title: 'Time Clock, Time Sheets and Leave', icon: 'Clock', owner: 'Client HR + Client Admin', time: 'Half a day + a test pay period',
    summary: 'Set the pay rules, the time sheet approval path, time off and monitoring - then run a test period.',
    why: 'Time sheets are computed from punches with the organization’s rules: rounding, auto-lunch, California rest breaks, each person’s overtime rule, and leave classes (sick and vacation are paid at base and kept out of overtime). After the period ends, the person’s manager (Reports To; with none, the company’s HR contact) approves the time sheet, and the employee - the only signer - signs it in Nexus Sign, which finalizes the period. Getting the rules right before the first live pay period avoids re-running payroll.',
    needs: ['Phase 5 (people, managers, pay).'],
    decisions: [
      'Punch rounding, auto-lunch deduction and California paid rest breaks.',
      'Time-off reasons beyond the standard ones.',
      'Who reviews time: managers via People > Time, HR across everyone.',
      'Shift differentials and call-back pay (off by default, per company).',
      'Payroll item names for the QuickBooks IIF and Intacct memo, per company.',
      'Whether managers get a live alert before someone reaches overtime (off by default).',
      'Leave: the vacation and sick policies, the date balances count from, what happens to unused time at year end (Use It Or Lose It by default; California vacation never expires) and whether HR approves time off after the manager.',
      'India companies: whether contractors on fixed monthly pay follow the India Contractor Policy (on by default for an India company) and from which month.',
    ],
    steps: [
      { title: 'Pay Rules', where: 'Settings > Time & Pay > Pay Rules', view: 'admin-console', sub: 'pay', items: [
        'Punch rounding, the auto-lunch deduction and California paid rest breaks - the rules every time sheet is computed with.',
        'Payroll Export Codes: pick each company and type its QuickBooks payroll item names (blank keeps the default).',
        'Shift Differentials and Call-Back Pay: turn it on only for companies that pay them, then add each differential.',
      ]},
      { title: 'California Staff', where: 'People > the person > Pay & Benefits', view: 'hr', sub: 'hr-people', items: [
        'For hourly staff on the California rule who waive meal periods: Send Waiver to Sign. California Review on People > Time > Payroll then checks each period.',
      ]},
      { title: 'Time Off', where: 'Settings > Time & Pay > Time-Off Reasons', view: 'admin-console', sub: 'pay:time-off-reasons', items: [
        'With the Scope box on Every company, add the time-off reasons the client uses - the default list; a company that needs its own gets it with that company picked. Requests route to the person’s manager; approved time off is not punched in automatically (India contractors on the India Contractor Policy are the exception: an approved Vacation or Sick request is paid leave).',
      ]},
      { title: 'Leave Policies and Balances', where: 'Settings > Time & Pay > Leave Policies', view: 'admin-console', sub: 'pay:leave-policies', items: [
        'Leave Policies: the vacation and sick policies people are assigned - hours earned per hour worked, caps and carry-over.',
        'Leave Year-End: Use It Or Lose It, Carry Everything or Carry Up To a Cap, per bucket - a default, and a company’s own. Time-Off Approval: turn on Second Approval By HR for a company that wants HR to approve after the manager.',
        'In People > Time > Time Off, set the date balances count from and import each person’s opening balance from QuickBooks once.',
      ]},
      { title: 'India Contractor Policy', where: 'Settings > Time & Pay > India Contractor Policy', view: 'admin-console', sub: 'pay:india-contractor-policy', items: [
        'For India companies: check the policy is on and its start month. Contractors are then credited by hours (8 full, 4 half), the month-end pool buys back missing half days, and approved Extra Time pays 1.35 times the daily rate divided by 9.',
        'Extra Time claims are approved by the company’s HR contact (else the Global Admins) in People > Time > Extra Time - make sure every India company has an HR contact.',
      ]},
      { title: 'Payroll Readiness', where: 'Settings > Time & Pay > Payroll Readiness', view: 'admin-console', sub: 'pay:payroll-readiness', items: [
        'Set what counts as a big change or an unusual week (25% or 8 hours off last period or the schedule by default) - a default, and each company’s own. The check itself runs from People > Time > Payroll.',
      ]},
      { title: 'Monitoring Computers', where: 'Team > Workforce Analytics', view: 'employee-tracking', items: [
        'If monitoring is on: enroll each company computer (desktop agent), or have people share their screen in Chrome when clocking in.',
      ]},
      { title: 'Run a Test Pay Period', where: 'People > Time', view: 'hr', sub: 'hr-time', items: [
        'Have a few people punch in and out for a week, with a break, a missed punch and a punch request.',
        'Clear the Action Log (punch requests and missing punches), run Payroll Readiness, then have the manager Review & Approve one time sheet and the employee sign it.',
        'Compare totals and overtime with the client’s current payroll for the same days.',
      ]},
    ],
    checks: [
      { id: 'time.rules', text: 'Pay rules set and confirmed by payroll.' },
      { id: 'time.exempt', text: 'Salaried people exempt from time tracking (via their role) see no clock.' },
      { id: 'time.timeoff', text: 'Time-off reasons set; a test request was approved by the right manager.' },
      { id: 'time.monitoring', text: 'Monitoring computers enrolled, or monitoring confirmed off.' },
      { id: 'time.test', text: 'A test time sheet was approved by the manager and signed by the employee - totals match payroll.' },
      { id: 'time.codes', text: 'Payroll export codes match the client’s QuickBooks payroll items (or the defaults are confirmed).' },
      { id: 'time.readiness', text: 'Payroll Readiness on the test period shows everyone Ready.' },
      { id: 'time.leave', text: 'Leave policies, year-end rule, time-off approval and opening balances set (or leave balances confirmed not used).' },
      { id: 'time.india', text: 'India Contractor Policy on with its start month, and an HR contact set for Extra Time (or no India contractors).' },
    ],
    pitfalls: [
      'Wrong Reports To sends time sheets and time off to the wrong approver.',
      'Export codes that do not match QuickBooks exactly create new payroll items on import.',
      'A leave punch must use a job category Nexus recognizes as Sick or Vacation (Sick Day, PTO, Annual Leave...) to be paid as leave.',
    ],
  },

  // ── 7 ────────────────────────────────────────────────────────────────────
  {
    id: 'shifts', n: 7, title: 'Shifts and Day Messages', icon: 'CalendarClock', owner: 'Client Admin + Managers', time: '2 to 3 hours',
    summary: 'Shift types, scheduling groups, request and schedule rules, attendance alerts, calendars and weather - and where beginning/end-of-day messages go.',
    why: 'Shifts show who is on and who is off, today and ahead, to the whole team. Shift types are reusable time blocks (6:00 AM - 2:00 PM) placed for a team or a person; groups are the rows of the schedule. Day messages (beginning-of-day, end-of-day, breaks) post to Teams as the person, to the chat or channel set on their job role.',
    needs: ['Phase 4 (roles with Teams destinations), Phase 5 (people).'],
    decisions: [
      'Team time zone and the first day of the week.',
      'Whether staff may request open shifts, swap, offer or release shifts, and claim open shifts across teams - all off until turned on, per company (most offices: leave off).',
      'The shift types and the scheduling groups, and who schedules each group.',
      'Schedule rules (rest between shifts, days in a row, daily and weekly overtime, most hours a week) and whether sharing over a warning needs a reason (on by default).',
      'No-show alert minutes (10 by default, 0 = off), and whether to alert for usual hours too and before overtime (both off by default).',
      'Whether shared shifts go on Outlook calendars (off by default) and whether people confirm a shared schedule (on by default).',
      'Outdoor crews only: which companies get weather alerts, and each group’s work site and weather deciders. Only departments with Weather Calls on (Phase 3) are ever on a call.',
    ],
    steps: [
      { title: 'Shift Settings', where: 'Settings > Shifts & Scheduling', view: 'admin-console', sub: 'shifts:shift-settings', items: [
        'Set the Scope box to Every company for the defaults, or pick a company; a company with none of its own follows the defaults.',
        'Schedule Basics (Team Time Zone, Week Starts On, Default Grace) and Requests & Visibility.',
        'Attendance (No-Show Alert, Left Early, the break and meal reminders, Alert for usual hours too), Overtime Alerts (daily and weekly warning minutes), Rules, and Sharing (Outlook calendars, Show In Outlook As, Ask people to confirm a shared schedule).',
      ]},
      { title: 'Shift Types and Groups', where: 'Settings > Shifts & Scheduling', view: 'admin-console', sub: 'shifts', items: [
        'Shift Types: name, code, color, times, grace, unpaid break, time zone, days and company (Shared With Every Company or one).',
        'Groups: members and schedulers. Leave Teams binding to the job roles; a group binding is only the fallback.',
        'Outdoor crews: give the group a Work Site with coordinates (from the Location Library) and its Weather Deciders.',
      ]},
      { title: 'Weather Alerts (Outdoor Crews Only)', where: 'Settings > Shifts & Scheduling > Weather Alerts', view: 'admin-console', sub: 'shifts:shift-weather', items: [
        'Switch on each company to watch (off by default), check the rain thresholds and quiet hours, and click Check Now.',
        'Confirm Weather Calls is on for the outdoor departments only (Settings > Companies > the company > Departments). People in other departments on the same group are never on the call.',
      ]},
      { title: 'Build and Publish the First Schedule', where: 'Team > Schedule', view: 'shifts', sub: 'schedule', items: [
        'Fill a week or month per team (Fill Automatically), copy it forward (Copy Week), then Save & Share - Review shows every change and rule warning first.',
      ]},
      { title: 'Test Day Messages', where: 'Workday (as a test person)', view: 'myhr', items: [
        'Punch in as someone in each role: the beginning-of-day message posts to their role’s Teams chat or channel, ending with "Sent by Nexus".',
      ]},
    ],
    checks: [
      { id: 'shifts.settings', text: 'Shift settings, types and groups created.' },
      { id: 'shifts.schedule', text: 'The first schedule is published.' },
      { id: 'shifts.messages', text: 'A test beginning-of-day message posted to the right Teams chat or channel for each role.' },
      { id: 'shifts.rules', text: 'Rules, no-show alert and reason-to-share settings agreed for every company.' },
      { id: 'shifts.attendance', text: 'A test no-show alert reached the right manager, and the grid shows On Time / Late for a past day.' },
      { id: 'shifts.calendar', text: 'Outlook calendars and confirm requests set on or off per company (Calendars.ReadWrite consented if on).' },
      { id: 'shifts.weather', text: 'Weather alerts on, with a work site and deciders per outdoor group and Weather Calls on for the outdoor departments only - or confirmed not needed.' },
    ],
    pitfalls: [
      'Creating a group for every sub-team to route Teams messages. Route by job role instead; groups are for scheduling.',
      'Turning trading or a rule on in the defaults when only one company wants it. Pick that company first so the change is saved for it alone.',
      'A US person with no payroll rate is judged on the California daily overtime rule; set pay in People first.',
    ],
  },

  // ── 8 ────────────────────────────────────────────────────────────────────
  {
    id: 'checklists', n: 8, title: 'Checklists, Probation, HR Letters and Performance', icon: 'ListChecks', owner: 'Client HR', time: '2 to 3 hours',
    summary: 'The steps HR, IT, Accounting and managers take for every new starter, promotion, leaver and leave of absence - plus probation, the letters HR issues and performance reviews.',
    why: 'Checklists make joining and leaving repeatable: each step has an owner and a due date counted from the start date, exit date or leave start, with reminders. Templates vary by worker type and country (an I-9 for US employees, PF for India, a W-9 for contractors).',
    steps: [
      { title: 'The Checklist Library', where: 'Settings > Hiring & Onboarding > Checklist Library', view: 'admin-console', sub: 'hiring:checklist-library', items: [
        'Review the standard onboarding, promotion, offboarding and leave steps and adjust them to the client’s process.',
        'Set the default owner for each kind of step (HR, IT, Accounting).',
      ]},
      { title: 'Each Company', where: 'Settings > Hiring & Onboarding > pick the company > Checklists', view: 'admin-console', sub: 'hiring', items: [
        'Set a head and a backup for the HR, IT and Accounting departments (Settings > Companies > the company > Departments), then read the Role Checklists audit: every role should have its onboarding, promotion, offboarding and leave steps built. Click Build on any role with something Missing.',
      ]},
      { title: 'Each Role', where: 'Team > Role Checklists', view: 'shifts', sub: 'role-checklists', items: [
        'The head of each department adds the extra steps its roles need - their training and tools. Set department heads under Companies > the company > Departments first.',
      ]},
      { title: 'Probation', where: 'Settings > Hiring & Onboarding > Probation', view: 'admin-console', sub: 'hiring:probation', items: [
        'The probation length (calendar months), when the manager and the HR contact are reminded, and the confirmation and extension letter templates with their letterhead - a default, and each company’s own.',
        'Only new hires are tracked, from their start date. A manager’s Confirm, Extend or End is a recommendation; HR finalizes, and the employee is the only signer of the letter.',
      ]},
      { title: 'Letterheads and HR Letters', where: 'Settings > Branding & Email > Letterheads, then Settings > Hiring & Onboarding > HR Letters', view: 'admin-console', sub: 'hiring:hr-letters', items: [
        'Letterheads: the letterheads documents and letters print on, and the default.',
        'HR Letters: which letters each company offers in Workday > Ask HR (employment verification, salary certificate, experience letter, address proof, visa NOC), the Documents template each prints from and its letterhead. The company signatory signs them; the employee never signs a letter.',
      ]},
      { title: 'Performance', where: 'Settings > Performance', view: 'admin-console', sub: 'performance', items: [
        'Performance Reminders, the one setting: how many days a goal someone updates by hand may go without an update (14 by default), and the reminder before a 1:1 with an empty agenda. A company can keep its own.',
        'Nothing else to set up. My Numbers come from what Nexus already records (arrival, hours, Time Sheets, tasks, tickets, training), reviews use one fixed form with three questions and a four-word rating (Exceeds, Meets, Partly Meets, Below), and review reminders are automatic.',
        'The first review: People > Performance > New Review Cycle - a name, the company and a due date. Everyone at that company who is past probation is in it.',
      ]},
    ],
    checks: [
      { id: 'checklists.templates', text: 'Onboarding, offboarding and leave templates reviewed and owners set.' },
      { id: 'checklists.probation', text: 'Probation length, reminders and letter templates set for every company that tracks probation.' },
      { id: 'checklists.letters', text: 'Letterheads uploaded and the HR letters each company offers set up.' },
      { id: 'checklists.performance', text: 'Performance reminders agreed and the first review cycle planned (or Performance confirmed not used).' },
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
      'Task teams, custom fields and statuses (and which projects require each field); how often task emails are batched; who beyond Managers runs Tasks (a Tasks Owner grant opens Manage).',
      'Which departments run a ticket desk, their agents and supervisors, response and resolution targets, help topics, and who each department or topic assigns new tickets to.',
      'Which policies need a signed acknowledgment; which trainings are required.',
      'Default document templates per type; where signed documents are filed.',
    ],
    steps: [
      { title: 'Tasks', where: 'Tasks > Manage', view: 'tasks', items: [
        'Teams, Custom Fields (with Required per project), Custom Statuses, Templates and Automation Rules.',
        'Each project’s settings: Time Tracking (Automatic, On or Off) and its default view.',
        'Task Notifications (Settings > Emails & Reminders): the batching window for task emails.',
      ]},
      { title: 'Ticket Desks', where: 'Settings > Tickets', view: 'admin-console', sub: 'tickets', items: [
        'Routing & Escalation: departments that take tickets, their order, default agents, and each department’s head and default assignee.',
        'Notifications, SLA & Ticket Types (resolution and first response hours per priority), Help Topics per department (with an optional default assignee per topic), Desk Access (requester, agent, supervisor) and Saved Replies (shared answers for the desk).',
      ]},
      { title: 'Knowledge Base', where: 'Knowledge Base > Manage', view: 'sop', items: [
        'Load the SOPs and policies, assign sign-offs, and build required training courses.',
      ]},
      { title: 'Documents and E-Signature', where: 'Documents', view: 'documents', items: [
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
    pitfalls: [
      'Due and overdue ticket reminders are sent on Teams from each assignee’s manager. Tell the managers before switching them on in Ticket Manager > Notifications.',
      'A default assignee who leaves or loses Tickets access is skipped - new tickets wait unassigned and their history says so. Recheck defaults when the desk changes.',
    ],
  },

  // ── 10 ───────────────────────────────────────────────────────────────────
  {
    id: 'operations-modules', n: 10, title: 'Items, Assets, Accounting and the Other Modules', icon: 'Package', owner: 'Module Owners', time: 'Half a day to 2 days',
    summary: 'Load the catalog, the properties, the finance connection and each remaining module the client uses.',
    why: 'Each operational module starts from data the client already has - an equipment list, property list, ledger, passwords, links. Loading it in bulk now makes the module useful on day one instead of filling up slowly.',
    steps: [
      { title: 'Item Management', where: 'Settings > Items & Equipment, then Item Management > Manage', view: 'inventory', items: [
        'Item Types & Custom Fields first, then Import Items From CSV or Excel. Assign permanent equipment to people.',
        'Equipment Reminders (Settings > Emails & Reminders > Equipment Reminders): overdue returns, warranty and inspection dates.',
      ]},
      { title: 'Asset Management', where: 'Asset Management', view: 'property-asset', items: [
        'Add each asset (Add Asset: Property / Real Estate, Vehicle or Heavy Equipment), or Import From a Spreadsheet in the portfolio’s more menu. Give each property its PM / Asset Manager, who gets its reminders and ticket alerts.',
        'Mark Private only the assets company officers alone should see.',
      ]},
      { title: 'Accounting', where: 'Accounting > Tools > Access', view: 'accounting', items: [
        'Connected through Nexus Accounting (Sage Intacct). Give the Accounting grant (Editor for close work and AMA Settings, Full for Access, Allocations and Compensation), then limit which entities each person reads on Tools > Access, or click Bring From Intacct to copy Intacct’s own limits.',
        'PFS is a separate grant (Personal Financial Statements). Owners pick which PFS each person sees on the Access tab; an administrator role does not open them.',
        'On Reports > Audit & Insights > AMA, an editor opens Settings to pick the Ask My Accountant accounts and the accountant for each entity.',
        'On Tools > Allocations, map every work site and company to its entity and account before the first Keep Run.',
      ]},
      { title: 'Operations (Cubby)', where: 'Operations', view: 'operations', items: [
        'The Nexus team sets the Cubby API key on the server; until then Operations says Cubby is not connected. Nexus copies Cubby every 15 minutes and only reads it.',
        'Give the Operations grant to facility managers, then add each facility’s competitors in Pricing > Comp Set & Manual Entry so the suggested rates on CMA Overview have data.',
        'Push to Cubby (Settings > Operations) stays off until the client wants Nexus to send rates and rent changes to Cubby.',
      ]},
      { title: 'Dashboard Links', where: 'Dashboard > Links > Manage Links', view: 'dashboard', items: [
        'Add company links by category, department and company, or Batch Import them.',
      ]},
      { title: 'The Rest', items: [
        'Credentials: Add Credential > Import From CSV for the shared passwords, then set owners and backup owners.',
        'Marketing: connect Google Business Profile and Google Ads; set lead goals and budgets per property.',
        'Investor Relations, Construction, IT and Insights: give the grants to their owners and load their records.',
      ]},
    ],
    checks: [
      { id: 'ops.items', text: 'Item types set and the catalog imported (if used).' },
      { id: 'ops.assets', text: 'Properties added with their asset managers (if used).' },
      { id: 'ops.accounting', text: 'Accounting connected and entity access set (if used).' },
      { id: 'ops.cubby', text: 'Cubby connected and every facility showing on Operations (if used).' },
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
      { title: 'Communications', where: 'Settings > Emails & Reminders', view: 'admin-console', sub: 'emails', items: [
        'Daily Briefing and Weekly Digest: on or off, send time, test recipients.',
        'HR & Compliance Reminders: visa and right-to-work expiry, contract ends, new-starter documents - days before and who is told.',
        'Equipment Reminders: overdue returns, warranties, inspections, registrations, insurance.',
        'Ticket Manager > Notifications: SLA breach alerts (on by default, bell only) and due and overdue ticket reminders (off by default, sent on Teams from the assignee’s manager).',
      ]},
      { title: 'Workforce Scorecard', where: 'Settings > Emails & Reminders > Workforce Scorecard', view: 'admin-console', sub: 'emails:workforce-scorecard', items: [
        'The weekly email to managers scoring each hourly person’s punched hours against their expected hours: turn it on, check the standard day and thresholds.',
        'Give the Workforce Scorecard grant to whoever should receive it: Viewer for a manager’s direct reports, Editor for the whole reporting line, Full for the company. The email goes to every grant holder with people in scope.',
      ]},
    ],
    checks: [
      { id: 'notify.briefing', text: 'Daily Briefing and Weekly Digest decided and tested.' },
      { id: 'notify.reminders', text: 'HR and equipment reminder timing set.' },
      { id: 'notify.tickets', text: 'Ticket breach alerts and overdue reminders decided; managers told before reminders were switched on.' },
      { id: 'notify.scorecard', text: 'Workforce Scorecard email decided, and the grant given to the managers who should get it.' },
    ],
  },

  // ── 12 ───────────────────────────────────────────────────────────────────
  {
    id: 'workflows', n: 12, title: 'Workflows and Automations', icon: 'Workflow', owner: 'Client Admin + Module Owners', time: '2 to 3 hours',
    summary: 'Decide which automatic jobs run, set the limits, and build the first workflows from templates.',
    why: 'Workflows automate what people would otherwise remember to do: when something happens in Nexus (time off approved, a probation about to end, a ticket breaching), they send the email, create the task or ask for the approval. Everything automatic - workflows, Tasks automation rules and the built-in background jobs - is listed in one place and can be switched off there, so the client decides up front what runs.',
    needs: ['Phase 4 (roles and grants), Phase 5 (people and managers), Phase 11 (who hears about what).'],
    decisions: [
      'Whether workflows run for each company, and the per-hour and recipient ceilings.',
      'Which built-in automations the client wants off (each lists what it does and the setting that controls it).',
      'Who builds workflows (Workflows grant: Editor builds their own, Full manages every workflow in their scope) and the first two or three to build.',
    ],
    steps: [
      { title: 'Workflow Settings', where: 'Settings > Workflows', view: 'admin-console', sub: 'workflows', items: [
        'Whether workflows run for a company, the per-hour and recipient ceilings and the weekly owner digest - a default, and each company’s own.',
        'Global Admins only: Pause All (stops every workflow at once; events still queue for 7 days) and the webhook allow-list.',
      ]},
      { title: 'Review the Automations', where: 'Workflows > Automations', view: 'workflows', items: [
        'Read Built-In Automations with the client. A Global Admin can switch any one off; everyone else sees an Off chip.',
        'Tasks automation rules are listed here too, each with its own switch.',
      ]},
      { title: 'Build the First Workflows', where: 'Workflows > Templates', view: 'workflows', items: [
        'Pick a template, click Use Template, and fill the marked blanks. Click Test to run it against a recent event without sending anything, then Publish.',
        'Check the Runs tab after the first real event: every step, what it changed and the record it touched.',
      ]},
    ],
    checks: [
      { id: 'workflows.settings', text: 'Workflow settings and ceilings set for every company (or workflows confirmed off).' },
      { id: 'workflows.automations', text: 'Built-in automations reviewed with the client; the unwanted ones switched off.' },
      { id: 'workflows.first', text: 'The first workflows built from templates, tested and published, with their owners named.' },
    ],
    pitfalls: [
      'A workflow runs as its owner and can only do what the owner could do by hand. When the owner leaves, re-own it before it starts failing.',
    ],
  },

  // ── 13 ───────────────────────────────────────────────────────────────────
  {
    id: 'verify', n: 13, title: 'Verify Before Go-Live', icon: 'BadgeCheck', owner: 'Nexus Team + Client Admin', time: '1 day',
    summary: 'See Nexus as each kind of person, prove each flow end to end, and fix what is off.',
    why: 'Setup screens show what was configured; only acting as real people shows what they will experience. One person per role and tier, walked through their day, catches the wrong module, the missing manager and the misrouted message before anyone else sees it.',
    steps: [
      { title: 'Act As Each Kind of Person', where: 'Profile menu (top right) > Tools > Act As', items: [
        'Pick one person per job role and tier (an employee, a supervisor, a manager, HR). Check their menu, their Workday, their People view and their approvals.',
      ]},
      { title: 'Prove the Flows', items: [
        'A punch in and out with the day messages; a punch request approved from the Action Log.',
        'A time-off request approved by the right manager; a time sheet approved by the manager and signed by the employee.',
        'A ticket raised and routed; a task email received; a document signed and filed.',
        'A profile change in Nexus appearing in Microsoft 365, and one made there coming back.',
      ]},
      { title: 'Review the Logs', where: 'Settings > Logs', view: 'admin-console', sub: 'audit', items: [
        'Every access and settings change is recorded - skim it for anything unexpected.',
      ]},
    ],
    checks: [
      { id: 'verify.actas', text: 'Acted as one person per role and tier; menus and data are right.' },
      { id: 'verify.flows', text: 'Every launch flow proven end to end.' },
      { id: 'verify.signoff', text: 'Client implementation owner signed off.' },
    ],
  },

  // ── 14 ───────────────────────────────────────────────────────────────────
  {
    id: 'go-live', n: 14, title: 'Go Live and Train', icon: 'Rocket', owner: 'Nexus Team + Client', time: '1 to 2 days',
    summary: 'Announce, train each audience, and support the first pay period closely.',
    why: 'People adopt what they are shown. Short sessions per audience (everyone, managers, HR, admins) using the built-in Tours, Documentation and Help with This Page get Nexus used the way it was set up.',
    steps: [
      { title: 'Announce and Train', items: [
        'Send the go-live announcement with the sign-in link and the date the old tools stop.',
        'Everyone: Workday, punching in (also from the time clock at the foot of the left menu), time off, Approvals, Help Center (Ask Nexus and Submit a Ticket), Help with This Page, Take the Tour and What’s New (Follow the modules they use).',
        'Managers: People (their team), Approvals, the Action Log, Shifts, probation recommendations and Workday > Performance.',
        'HR: People, Checklists, Pay & Benefits, time sheet approval, Payroll Readiness and the payroll exports.',
        'Admins: Settings, Access, Act As, Logs - and this guide.',
      ]},
      { title: 'Watch the First Weeks', items: [
        'Watch the first pay period closely: the Action Log daily, missing punches, and Payroll Readiness before each payroll.',
        'Collect feedback through Help Center tickets and What’s New > My Requests (requesters see the status change); merged fixes publish to What’s New on their own.',
      ]},
    ],
    checks: [
      { id: 'live.announced', text: 'Go-live announced to everyone.' },
      { id: 'live.trained', text: 'Everyone, managers, HR and admins trained.' },
      { id: 'live.payroll', text: 'The first live pay period closed cleanly.' },
    ],
  },

  // ── 15 ───────────────────────────────────────────────────────────────────
  {
    id: 'run', n: 15, title: 'Running Nexus After Go-Live', icon: 'RefreshCw', owner: 'Client Admin + Client HR', time: 'Ongoing',
    summary: 'The routines that keep Nexus accurate: joiners, leavers, roles, holidays and access reviews.',
    why: 'An implementation stays good only if the routines around it do. Most drift comes from people joining or leaving outside Nexus, roles edited person by person, and next year’s holidays never added.',
    steps: [
      { title: 'Joiners and Leavers', where: 'People', view: 'hr', sub: 'hr-people', items: [
        'Joiner: Add Employee, give the job role and manager, provision, start the onboarding checklist.',
        'Leaver: start the offboarding checklist the day notice is received, hand over tasks, set mailbox handling, then mark Left.',
      ]},
      { title: 'Regular Reviews', items: [
        'Quarterly: read the access matrix and Access Groups; remove what is no longer needed.',
        'Yearly: check every Holiday Policy has next year’s holidays (confirm lunar dates nearer the time) and each company’s calendar is right; run Leave Year End in People > Time > Time Off; review pay rules and the sign-in policy.',
        'Change a job role rather than a person when a whole job changes - it applies to everyone with that role at once.',
        'Every payroll: run Payroll Readiness, then export. After a back-dated raise: run Retro Pay to see who is owed.',
      ]},
    ],
    checks: [
      { id: 'run.owners', text: 'Owners named for joiners/leavers, access reviews and yearly holidays.' },
    ],
  },
];

export const IMPL_CHECK_IDS = IMPL_PHASES.flatMap((p) => p.checks.map((c) => c.id));
