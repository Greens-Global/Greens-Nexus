// Support -> Documentation: the written guide to every Nexus module.
//
// One entry per left-nav module (plus Getting Started), in the same order and
// grouping as Sidebar.jsx's NAV, so a new person reads it in the order they
// see it. SupportDocs.jsx renders this; nothing here is fetched.
//
// KEEP THIS CURRENT as modules change - it is written by hand from what each
// screen actually does, so a renamed tab or a moved button belongs here too.
// House style (CLAUDE.md): American English, Title Case for headings/buttons,
// plain hyphens (never em dashes), US date formats.
//
// Entry shape:
//   id, name, group, icon (lucide name, resolved in SupportDocs), view/sub
//     (where "Open Module" goes via nexus:navigate; omit for guide-only pages)
//   tagline      - one line under the title
//   where        - how to reach it ("Left menu > Tasks")
//   access       - who sees it, in plain words
//   purpose      - what it is for (a short paragraph)
//   gains        - what you get out of it, as bullets
//   shot         - key of an illustrated screenshot in DocShots.jsx (optional)
//   walkthroughs - [{ title, steps: [...] }]; each step is ONE action, so the
//                  step count is the click count shown on the card
//   features     - [{ name, desc }] - every tab/button worth knowing
//   manager      - { title, points: [...] } - what managers/admins get extra
//   tips         - short "good to know" lines

export const DOC_GROUPS = ['Start Here', 'My Desk', 'Work', 'Modules', 'System'];

export const ROLE_TIERS = [
  { name: 'Employee', desc: 'Everyone starts here. Use the everyday screens: Dashboard, Workday, Knowledge Base, Item Management and Support.' },
  { name: 'Supervisor', desc: 'Can hand over items and handle returns, plus any modules their job role or an Access Group grants.' },
  { name: 'Manager', desc: 'Approves requests (items, time off, documents) and sees team widgets and reports. Cannot grant access or delete core records.' },
  { name: 'IT Admin', desc: 'Sees every module, manages settings and item catalogs, and can grant access up to Manager.' },
  { name: 'Global Admin', desc: 'Full, unrestricted access, including managing other admins and deleting core records.' },
];

export const ACCESS_LEVELS = [
  { name: 'Viewer', desc: 'See and use the screen normally.' },
  { name: 'Editor', desc: 'Also create and edit records.' },
  { name: 'Full', desc: 'Also delete records.' },
  { name: 'Owner', desc: 'Full access, plus decide who else gets access.' },
];

export const DOCS = [
  // ───────────────────────────── Start Here ─────────────────────────────
  {
    id: 'getting-started', name: 'Getting Started', group: 'Start Here', icon: 'Sparkles',
    tagline: 'Your first 10 minutes in Nexus - the layout, search, alerts and who can see what.',
    where: 'Everywhere - these parts are on every screen',
    access: 'Everyone',
    purpose: 'Nexus is the Greens Global company portal. It brings your hours, tasks, tickets, equipment, documents, training and company tools into one place, and you sign in with your normal Microsoft work account. Every module follows the same pattern, so once you learn one screen the rest feel familiar.',
    gains: [
      'One sign-in for your time clock, tasks, requests, equipment, training and company documents.',
      'Alerts come to you in the bell, so you do not have to check each module.',
      'You only see the modules your role needs, so the menu stays short.',
    ],
    shot: 'layout',
    walkthroughs: [
      {
        title: 'Move Around Nexus',
        steps: [
          'Click a module in the left menu (for example Workday). The menu only moves you between modules.',
          'Use the tabs across the top of the page to switch between the parts of that module.',
          'Click the arrow at the top of the left menu to collapse it to icons when you want more room.',
        ],
      },
      {
        title: 'Find Anything in Two Seconds',
        steps: [
          'Press Ctrl+K (Cmd+K on a Mac), or click the search box in the top header.',
          'Type a few letters of a page, person, task, project or team.',
          'Click the result to jump straight to it.',
        ],
      },
      {
        title: 'Never Miss What Needs You',
        steps: [
          'Click the bell in the top-right corner. A red number means you have unread alerts.',
          'Click an alert to open the exact item it is about (a ticket, an approval, an item handover).',
          'Items that need action (Approve, Overdue) also pop up briefly as a toast at the corner of the screen.',
        ],
      },
      {
        title: 'Set Up Your Profile',
        steps: [
          'Click your photo or initials in the top-right corner.',
          'Click My Profile to check your details, photo, Dark Mode and theme.',
          'Click Email Settings to choose which emails Nexus sends you.',
        ],
      },
    ],
    features: [
      { name: 'Left Menu', desc: 'Grouped into My Desk, Work, Modules and System. You only see what your role or Access Groups allow.' },
      { name: 'Top Tabs', desc: 'Each module shows its own tabs in the header (in the page itself on a phone).' },
      { name: 'Search (Ctrl+K)', desc: 'Searches pages, people, tasks, projects, portfolios and teams from anywhere.' },
      { name: 'Notification Bell', desc: 'Every alert meant for you: approvals, handovers, ticket updates, reminders. Click to open the item.' },
      { name: 'Page Help (?)', desc: 'The "?" in the header opens a short guide for the page you are on.' },
      { name: 'Profile Menu', desc: 'My Profile, Email Settings, Tour and Sign Out.' },
      { name: 'Tour', desc: 'Tasks, Tickets and Support have a guided tour. It runs once on your first visit, and you can replay it from the profile menu.' },
      { name: 'Phone Friendly', desc: 'Nexus works in your phone browser. The left menu becomes a menu button, and tabs become swipeable.' },
    ],
    manager: {
      title: 'How Access Works',
      points: [
        'Your role tier (Employee, Supervisor, Manager, IT Admin, Global Admin) sets what you can approve.',
        'Your job role gives you a standard set of modules. Access Groups add extra modules on top.',
        'Each module grant has a level: Viewer, Editor, Full or Owner.',
        'Admins set job roles per company in Settings > Company Settings, and everything else in Settings > Global Settings > Access. See the Settings page of this guide.',
      ],
    },
    tips: [
      'Cannot see a module a colleague uses? It is not broken. You just have not been granted it yet. Ask your manager or raise a ticket.',
      'Dates show as MM/DD/YYYY and times as 12-hour AM/PM everywhere in Nexus.',
      'Stuck? Support > Submit a Ticket reaches a real person.',
    ],
  },

  // ───────────────────────────── My Desk ─────────────────────────────
  {
    id: 'dashboard', name: 'Dashboard', group: 'My Desk', icon: 'LayoutDashboard', view: 'dashboard',
    tagline: 'Your home page: what needs you today, at a glance.',
    where: 'Left menu > Dashboard',
    access: 'Everyone. Team widgets need the Manager Dashboard grant.',
    purpose: 'The Dashboard is where Nexus opens. It greets you, shows your clock status and hours, counts what is waiting on you (open tasks, checked-out items, equipment, signatures), lists your latest alerts and gives you one-click shortcuts. You can keep the designed Home layout or build your own views from widgets.',
    gains: [
      'See your open tasks, checked-out items, assigned equipment and pending signatures without opening each module.',
      'Jump to any of them with one click on the tile.',
      'Build a personal board that shows exactly the numbers you care about.',
      'Keep all your everyday web links (Links tab) in one searchable place.',
    ],
    shot: 'dashboard',
    walkthroughs: [
      {
        title: 'Read Your Day',
        steps: [
          'Open Dashboard from the left menu. Home shows your greeting, clock status and local times.',
          'Click any stat tile (Open Tasks, Checked-out Items, My Equipment, Signatures Needed) to jump to that list.',
          'Click an alert in the queue to open it, or use Quick Actions to start a task, event, email or item request.',
        ],
      },
      {
        title: 'Build Your Own View',
        steps: [
          'Click Customize (top right of the greeting).',
          'Click Add Widget and pick one (KPI Stat, Calendar, Notes, Quick Links, Notifications and more).',
          'Drag widgets to move them and drag a corner to resize. Click Auto-fit to close gaps.',
          'Click Save, then Done.',
        ],
      },
      {
        title: 'Save a Link on the Links Tab',
        steps: [
          'Click the Links tab at the top of the Dashboard.',
          'Click Add Link.',
          'Paste the URL and give it a name (leave the description blank and Nexus fills it in from the site).',
          'Click Save. Star it to add it to Favorites.',
        ],
      },
    ],
    features: [
      { name: 'Home', desc: 'The designed default layout: greeting, clock status, hours, stat tiles, alerts queue and quick actions.' },
      { name: 'View Picker', desc: 'Switch between Home, your own saved views and department views.' },
      { name: 'Customize', desc: 'Edit mode: Add Widget, drag to arrange, resize, Auto-fit, Save and Done.' },
      { name: '"..." View Menu', desc: 'Rename View, Set as My Default, Make Home My Default, Save as New View, Publish to Department, Delete View.' },
      { name: 'Widget Gallery', desc: 'Metrics (KPI Stat, KPI Bar Chart), Navigation (Shortcut Tile, Quick Links, Links Folder, Quick Actions), Live (Notifications, Calendar), Utility (Clock, Notes), plus Team and Portfolio widgets.' },
      { name: 'Links Tab', desc: 'Every company and personal web link. Search, filter by category, department or company, pin, favorite, sort into folders, and switch between tile and list view.' },
      { name: 'Personal Links', desc: 'A link you add is visible only to you. Company-wide links are managed by admins through Manage Links.' },
    ],
    manager: {
      title: 'Managers & Admins',
      points: [
        'The Manager Dashboard grant unlocks Team widgets: Team Clocked-In, Team Approvals, Time Off to Review, Pending Approvals, Who Has What, Team Time, Workload by Employee, Project-Wise Tasks and Team Calendar.',
        'Publish to Department shares your view with everyone in your department.',
        'Admins use Manage Links (Links tab) to add company links for everyone, set categories, departments and companies, or Batch Import links.',
      ],
    },
    tips: [
      'A view with a star in the picker is your default, and it opens first.',
      'Leaving Customize with unsaved changes asks before throwing them away.',
    ],
  },
  {
    id: 'workday', name: 'Workday', group: 'My Desk', icon: 'Contact', view: 'myhr',
    tagline: 'Clock in and out, check your hours, see your shifts and request time off.',
    where: 'Left menu > Workday',
    access: 'Everyone (employees)',
    purpose: 'Workday is everything about your own time and HR record in one place. Punch in and out (with breaks), check your time sheet for the pay period, see when you are scheduled, request time off, and keep your contact and emergency details up to date. Only you see your own Workday.',
    gains: [
      'Get paid correctly. Every punch is timestamped and tagged with where it happened.',
      'See your hours for this pay period, day by day, before payroll does.',
      'Request time off in a few clicks and see when it is approved.',
      'Find your signed documents and paystubs in one place.',
    ],
    shot: 'clock',
    walkthroughs: [
      {
        title: 'Punch In for the Day',
        steps: [
          'Open Workday from the left menu, then click the Clock tab.',
          'Click Punch In. The first time, read the monitoring notice and acknowledge it.',
          'Allow location if your browser asks. On a phone this gives the most accurate work-site check.',
        ],
      },
      {
        title: 'Take a Break and Punch Out',
        steps: [
          'Click Start Break when you step away. The button changes to End Break.',
          'Click End Break when you are back.',
          'Click Punch Out at the end of your day.',
        ],
      },
      {
        title: 'Request Time Off',
        steps: [
          'Click the Time Off tab.',
          'Pick the type (Vacation, Sick, Personal, Unpaid or Other) and the start and end dates.',
          'Add a short note and send the request. It shows as Pending until your approver decides.',
        ],
      },
      {
        title: 'Check Your Hours',
        steps: [
          'Click the Time Sheet tab.',
          'Read your hours for this pay period, day by day, including breaks.',
          'Use the Previous Week and Next Week arrows to move between weeks.',
        ],
      },
    ],
    features: [
      { name: 'Overview', desc: 'Your profile, contact and emergency details, assigned equipment, checkouts, signed documents, paystubs and leave. Only you see this page.' },
      { name: 'Clock', desc: 'Punch In, Start Break, End Break and Punch Out, with today\'s punches and location tags.' },
      { name: 'Time Sheet', desc: 'Your hours this pay period, day by day. Sick and vacation hours show on their own lines.' },
      { name: 'Shifts', desc: 'When you are scheduled to work, week by week. Team Shifts shows who else is on.' },
      { name: 'Time Off', desc: 'Request time off and see what is coming up. Approved, Pending, Rejected and Cancelled requests are all listed.' },
      { name: 'Location Tag', desc: 'Each punch records whether it was on site or off site. Remote staff can punch from anywhere, and their location is still recorded.' },
    ],
    manager: {
      title: 'Managers & Admins',
      points: [
        'Time-off requests route to your approver. Managers review them from the Dashboard (Time Off to Review) and the bell.',
        'Team hours, punch fixes and payroll time cards live in People > Time.',
        'HR sets work sites (the geofence used for on-site checks) and holiday calendars in People.',
      ],
    },
    tips: [
      'If you see "Your Punch Did Not Record", try again from a phone or a stable connection. Nothing was saved.',
      'Approved time off is not punched in for you automatically.',
      '"Time Tracking Is Off for You" means HR has not enabled the clock for your profile. Raise a ticket if that is wrong.',
    ],
  },
  {
    id: 'workforce-analytics', name: 'Workforce Analytics', group: 'My Desk', icon: 'MonitorDot', view: 'employee-tracking',
    tagline: 'Live coverage, activity, punch locations and company computers.',
    where: 'Left menu > Workforce Analytics',
    access: 'IT Admin and Global Admin, or anyone given the Workforce Analytics grant',
    purpose: 'Workforce Analytics is the disclosed monitoring dashboard. It shows who is working right now, where each person last punched from, activity on enrolled company computers and screenshots taken under the company policy. Employees are told about it before they first clock in.',
    gains: [
      'Know at a glance who is working, on break or not clocked in.',
      'Spot punches made away from the work site.',
      'Keep company computers enrolled and accounted for.',
    ],
    walkthroughs: [
      {
        title: 'See Who Is Working Now',
        steps: [
          'Open Workforce Analytics from the left menu. You land on Coverage.',
          'Filter by company, department, country or site status to narrow the list.',
          'Click a person to see their day. With a full grant, you can also watch their screen live.',
        ],
      },
      {
        title: 'Enroll a Company Computer',
        steps: [
          'Click the Computers tab.',
          'Click Copy Command to copy the install command.',
          'Run it on the computer. It appears in the list once the agent reports in.',
        ],
      },
    ],
    features: [
      { name: 'Coverage', desc: 'Live list of who is Working, On Break or Not Clocked In, with On Site and Off Site tags.' },
      { name: 'Activity', desc: 'Time and activity per person across the day.' },
      { name: 'Locations', desc: 'A map of where each person last punched from.' },
      { name: 'Computers', desc: 'Company computers with the desktop agent. Copy the install or uninstall command here.' },
      { name: 'Screenshots', desc: 'Screenshots captured under the policy, shown by day, with the capture interval.' },
    ],
    manager: {
      title: 'Who Can Do What',
      points: [
        'A viewer grant lets you watch coverage, activity and locations.',
        'A full grant also allows remote control and managing devices and policies.',
        'The monitoring policy itself (what is captured and who is exempt) is set in People settings and Settings.',
      ],
    },
    tips: ['Monitoring is disclosed. Every employee acknowledges it before their first punch.'],
  },

  // ───────────────────────────── Work ─────────────────────────────
  {
    id: 'tasks', name: 'Tasks', group: 'Work', icon: 'CheckSquare', view: 'tasks',
    tagline: 'Plan, assign and track work across projects and teams.',
    where: 'Left menu > Tasks',
    access: 'Anyone whose job role or Access Group grants Tasks (most do)',
    purpose: 'Tasks is where work gets planned and done. Every task has an owner, a due date, a status and a priority, and it can hold comments, files and subtasks. Tasks are grouped into Projects, projects into Portfolios, and people into Teams.',
    gains: [
      'One list of everything assigned to you, across every project.',
      'Six ways to see the same work: List, Board, Calendar, Timeline, Files and Workload.',
      'Nothing is lost in email. Comments, files and history stay on the task.',
      'Automatic reminders before things are due.',
    ],
    shot: 'tasks',
    walkthroughs: [
      {
        title: 'Add a Task in One Line',
        steps: [
          'Open Tasks, then click the My Tasks tab.',
          'Click the one-line box at the top of the list and type a title.',
          'Press Enter. Set the due date right on that line if you need one.',
        ],
      },
      {
        title: 'Create a Full Task',
        steps: [
          'Click Create.',
          'Fill in the title, description, assignee, project, due date and priority. Attach files or paste a screenshot with Ctrl+V.',
          'Click Create Task. The assignee is notified.',
        ],
      },
      {
        title: 'Work a Task',
        steps: [
          'Click a task row to open it.',
          'Change its status (Not Started, In Progress, Done) or priority, and add a comment or file.',
          'Tick the checkbox to complete it.',
        ],
      },
      {
        title: 'See a Project Your Way',
        steps: [
          'Click the Projects tab and open a project.',
          'Switch between List, Board, Calendar, Timeline, Files or Workload at the top.',
          'On List or Board, group by status, assignee or priority.',
        ],
      },
    ],
    features: [
      { name: 'Home', desc: 'Your own dashboard of widgets (due soon, urgent, completed) for your day, week or month. Customize adds or removes widgets.' },
      { name: 'My Tasks', desc: 'Everything assigned to you across every project, with comment, attachment and subtask counts on each row.' },
      { name: 'Projects', desc: 'Related work in one place. You see a project if it is open to the company or you were added (directly or through a team).' },
      { name: 'Portfolios', desc: 'Groups of projects, so leads can follow progress across several at once.' },
      { name: 'Teams', desc: 'Named groups of people. Attach a team to a project to give everyone access in one move.' },
      { name: 'Views', desc: 'List, Board, Calendar, Timeline, Files and Workload for any list.' },
      { name: 'Templates', desc: 'Start a project or task from a saved template (Use Template, Save as Template).' },
      { name: 'Recurring Tasks', desc: 'Repeat daily, weekly, monthly or yearly, with an end date or a number of occurrences.' },
      { name: 'Task Emails', desc: 'Routine task emails are bundled into one summary email instead of one per change. Mentions, urgent tasks and anything due today or tomorrow still arrive right away.' },
    ],
    manager: {
      title: 'Manage (Managers and Above)',
      points: [
        'The Manage button appears for Managers and above. Changes there affect the module for everyone.',
        'Custom Fields and Custom Statuses extend what a task holds. Scope them to the projects that need them.',
        'Templates and Intake Forms decide how new work arrives. Automation Rules react to changes on their own (for example, when status changes to Done).',
        'Reporting and Activity Log show what happened and who did it.',
      ],
    },
    tips: [
      'Scope custom fields to a project. Left unscoped, they appear on every project in the company.',
      'Replay the Tasks tour any time from the profile menu > Tour.',
    ],
  },
  {
    id: 'files', name: 'Files', group: 'Work', icon: 'HardDrive', view: 'egnyte',
    tagline: 'Browse, upload and search the company Egnyte drive without leaving Nexus.',
    where: 'Left menu > Files',
    access: 'Supervisors and above with the Files grant',
    purpose: 'Files is a window onto Egnyte, the company file store. Egnyte stays the one true copy. Nexus lists, previews, uploads and links files in place, using your own Egnyte permissions, so you see exactly what you would see in Egnyte itself.',
    gains: [
      'Find and open company files without switching apps.',
      'Upload straight into the right folder.',
      'Nothing is duplicated. Every change lands in Egnyte.',
    ],
    walkthroughs: [
      {
        title: 'Connect Once',
        steps: [
          'Open Files from the left menu.',
          'If you see "Connect Your Egnyte Account", click it and sign in to Egnyte.',
          'You land back in Nexus on your usual work folder.',
        ],
      },
      {
        title: 'Upload a File',
        steps: [
          'Open the folder you want.',
          'Click Upload to This Folder (or drag files onto the list).',
          'Wait for the upload to finish. The file appears in the list.',
        ],
      },
      {
        title: 'Preview and Share',
        steps: [
          'Click a file to preview it. Use the left and right arrow keys to move between files.',
          'Click More Actions to Download, Rename, Move, Copy or Copy Egnyte Link.',
        ],
      },
    ],
    features: [
      { name: 'Browse Files', desc: 'The folder browser, opening on your normal work folder. Search, sort by name, size or date, and resize columns.' },
      { name: 'Preview', desc: 'View files in Nexus. Files locked for editing in Egnyte are marked.' },
      { name: 'File Actions', desc: 'Open in Egnyte, Download, Rename, Move To, Copy To, Copy Egnyte Link, Edit Description and Delete.' },
      { name: 'Property Documents', desc: 'Folders tied to each property, used by Asset Management and Construction.' },
    ],
    manager: {
      title: 'Admins',
      points: [
        'Folder Groups map teams to their Egnyte folders, so each person opens in the right place.',
        'Admins set where new property folders and signed documents are filed.',
      ],
    },
    tips: ['If a folder is missing, you probably do not have access to it in Egnyte. Ask the folder owner.'],
  },
  {
    id: 'tickets', name: 'Tickets', group: 'Work', icon: 'Ticket', view: 'tickets',
    tagline: 'The service desk queue: route, work and resolve requests from across the company.',
    where: 'Left menu > Tickets (agents). Everyone raises tickets from Support.',
    access: 'Desk agents with the Tickets grant. Anyone can raise a ticket from Support.',
    purpose: 'Tickets is the agent side of the help desk. Requests for IT, HR, facilities, finance apps and more arrive here with the right questions already answered. Each ticket has a type, priority, SLA due time, assignee and full thread. If you only need to ask for help, use Support instead. You do not need this module for that.',
    gains: [
      'Every request is in one queue, with nothing lost in email or chat.',
      'SLA timers show what is about to breach.',
      'Requesters see live status, so you get fewer "any update?" messages.',
      'Reports show volume, SLA performance and recurring issues.',
    ],
    shot: 'tickets',
    walkthroughs: [
      {
        title: 'Pick Up a Ticket',
        steps: [
          'Open Tickets and click the Unassigned tile (or the Assigned to Me tab).',
          'Click a row to open the full thread, attachments and history.',
          'Set yourself as the assignee and move the state to In Progress.',
        ],
      },
      {
        title: 'Resolve a Ticket',
        steps: [
          'Reply in the thread. Use an Internal Note for anything the requester should not see.',
          'Click Mark Resolved and add the resolution.',
          'The requester is notified and can confirm or reopen it.',
        ],
      },
      {
        title: 'Save a Filtered View',
        steps: [
          'Click Filters and pick status, priority, type, SLA, department or service area.',
          'Click More and save it as a named view.',
          'Open it any time from Saved Views.',
        ],
      },
    ],
    features: [
      { name: 'Tabs', desc: 'All, My Requests, Assigned to Me, and (only when something is waiting) To Route and To Approve.' },
      { name: 'Tiles', desc: 'Live counts for Open, Unassigned, SLA Breached, Resolved and Closed. Click one to filter the list.' },
      { name: 'List, Board, Reports', desc: 'A sortable table, drag-between-columns board, or charts of volume, SLA and time spent.' },
      { name: 'Ticket Types', desc: 'Incident, Service Request, Access Request, Bug Report, Feature Request, Change and more. Each asks only its own questions.' },
      { name: 'Approvals', desc: 'Some types go to an approver before anyone can be assigned.' },
      { name: 'Linking', desc: 'Link related tickets (blocks, blocked by, duplicate) or create a task from a ticket.' },
      { name: 'Export', desc: 'Export the currently filtered tickets to CSV.' },
    ],
    manager: {
      title: 'Desk Leads & Admins',
      points: [
        'To Route holds new tickets waiting for an owner. To Approve holds tickets waiting on your approval.',
        'Settings > Global Settings > Notifications & Communications has the Service Desk section, with tabs for Routing & Escalation (default agents), Notifications, and SLA & Ticket Types (intake questions and SLA hours).',
        'Reports shows recurring issues, so you can fix the cause, not just the ticket.',
      ],
    },
    tips: [
      'State and Priority can be changed straight from the list without opening the ticket.',
      'Resolved and Closed tickets collapse into their own section so open work stays on top.',
    ],
  },
  {
    id: 'knowledge-base', name: 'Knowledge Base', group: 'Work', icon: 'BookOpen', view: 'sop',
    tagline: 'Every SOP, policy and guide, plus your training courses.',
    where: 'Left menu > Knowledge Base',
    access: 'Everyone',
    purpose: 'The Knowledge Base is how Greens does things, written down. The Playbook holds every approved SOP, manual and guide. Learn holds training courses with quizzes and certificates. Policies that need your acknowledgement ask you to read and e-sign them.',
    gains: [
      'Find the right procedure in seconds, or ask a question in plain English and get an answer with its sources.',
      'Know a document is current. Green Verified or amber Needs Verification chips show it.',
      'Run an SOP as a live checklist so no step is skipped.',
      'Complete required training and get a certificate.',
    ],
    shot: 'kb',
    walkthroughs: [
      {
        title: 'Find an Answer',
        steps: [
          'Open Knowledge Base. You land on the Playbook.',
          'Type in the big search box (or press "/") to filter the library live.',
          'Press Enter (or click Ask AI) to ask it as a question. The answer cites the SOPs it came from.',
        ],
      },
      {
        title: 'Sign Off a Policy',
        steps: [
          'Open the document from For You in the right panel (anything waiting on you shows there).',
          'Read it to the end.',
          'Click Review & Sign, then type your full name to sign.',
        ],
      },
      {
        title: 'Take a Course',
        steps: [
          'Click the Learn tab. Required Training is at the top with due dates.',
          'Open the course and work through each lesson. Progress saves as you go.',
          'Take the quiz and click Submit Quiz. Pass to get your Certificate of Completion.',
        ],
      },
      {
        title: 'Write a New SOP',
        steps: [
          'Click New SOP.',
          'Capture: paste screenshots with Ctrl+V and jot rough notes, then click Format with Nexus.',
          'Content: check the title and each section. Settings: pick the type, departments and Reviewing Manager.',
          'Publish: click Submit for Review. Your manager approves it or sends it back with notes.',
        ],
      },
    ],
    features: [
      { name: 'Playbook', desc: 'The whole library in List, Tiles or Department view. Filter by department, type and status. Star a document to pin it.' },
      { name: 'Ask AI', desc: 'Answers come only from approved SOPs and cite their sources.' },
      { name: 'Run This SOP', desc: 'Turns a procedure into a live checklist. Open runs wait under Runs in Progress.' },
      { name: 'Share', desc: 'Copy link, copy as text, download, or Print / Save PDF.' },
      { name: 'Language', desc: 'Switch to a translated version where one exists.' },
      { name: 'Revision History', desc: 'Every version, with Compare Versions to highlight what changed.' },
      { name: 'Freshness', desc: 'When it was last verified. Owners click Still Accurate - Verify to reset the review clock.' },
      { name: 'Learn', desc: 'Courses, lessons, quizzes with explanations, and printable certificates.' },
    ],
    manager: {
      title: 'Managers and Above',
      points: [
        'Review and approve drafts, or click Request Changes with a note. Archive old documents.',
        'Manage hub: Action Needed, Needs Review, Sign-offs and Drafts tiles, plus Assignment Matrix, Sign-off Tracking, Insights and Activity Log.',
        'Build a course (Manage > Training Courses > New Course): paste your material and click Generate Course, then edit and Publish.',
        'Assign a course to people with a due date, and see every attempt and missed question in Report.',
      ],
    },
    tips: [
      'Anyone can start a draft. It only goes live after a manager approves it.',
      'Click the "?" on any Knowledge Base page for its own step-by-step help.',
    ],
  },
  {
    id: 'documents', name: 'Documents', group: 'Work', icon: 'FileText', view: 'documents',
    tagline: 'Create documents from templates, send them for e-signature and edit PDFs.',
    where: 'Left menu > Documents',
    access: 'Supervisors and above with the Documents grant',
    purpose: 'Documents is where company paperwork gets made and signed. Build a document from a template with merge fields filled in, send it through Nexus Sign for signature (inside or outside the company), and fix up PDFs with PDF Tools. Every signature has an audit trail.',
    gains: [
      'Offer letters, agreements and forms in minutes, not hours.',
      'E-signatures with a full audit trail. No printing or scanning.',
      'Track exactly who has viewed and signed.',
    ],
    shot: 'sign',
    walkthroughs: [
      {
        title: 'Send a Document for Signature',
        steps: [
          'Open Documents and click the Nexus Sign tab (or Send for Signature on the Dashboard).',
          'Drop in a PDF or Word file, or click Start From a Template.',
          'Add each signer\'s name and email, and a message.',
          'Drag Signature, Initials, Date Signed and other fields onto the page for each signer.',
          'Click Send. Signers get an email link and no login is needed.',
        ],
      },
      {
        title: 'Create a Document From a Template',
        steps: [
          'Click New Document (Dashboard or My Documents tab).',
          'Pick a template, or Blank Document.',
          'Fill in the details. Merge fields fill themselves.',
          'Save it to a folder, or send it for signature.',
        ],
      },
    ],
    features: [
      { name: 'Dashboard', desc: 'Shortcuts to New Document, New Template and Send for Signature, plus what is waiting.' },
      { name: 'My Documents', desc: 'Your documents in folders with tags. Edit, Duplicate, Archive, Restore or Delete.' },
      { name: 'Templates', desc: 'Reusable templates with categories, an owning department, draft or active status, and a default per type.' },
      { name: 'Nexus Sign', desc: 'Envelopes with statuses: Awaiting Signatures, Partially Executed, Fully Executed, Declined, Voided, Expired. Each signer shows Waiting, Notified, Viewed or Signed.' },
      { name: 'Signing Fields', desc: 'Signature, Initials, Name, Date Signed, Text, Checkbox, Dropdown, Radio and File Upload.' },
      { name: 'Sign on Paper', desc: 'A signer can print, sign by hand and upload a scan instead.' },
      { name: 'PDF Tools', desc: 'Open a PDF full screen to add text, draw, add shapes and save.' },
    ],
    manager: {
      title: 'Managers & Admins',
      points: [
        'Set a template as the default for its type so everyone starts from the approved version.',
        'Copy a signer\'s link or fix their name, email or access code if they cannot open it.',
        'Signed documents are filed to Egnyte automatically.',
      ],
    },
    tips: ['Signers outside the company do not need a Nexus account. The emailed link is enough.'],
  },

  // ───────────────────────────── Modules ─────────────────────────────
  {
    id: 'it', name: 'IT', group: 'Modules', icon: 'Monitor', view: 'it',
    tagline: 'Network health and company websites, watched in one place.',
    where: 'Left menu > IT',
    access: 'Supervisors and above with the IT grant',
    purpose: 'IT shows the health of the company network (from UniFi) and the status of every company website: uptime, SSL certificates and domain renewals. Problems show up here before someone has to report them.',
    gains: [
      'See offline devices and internet issues at every site immediately.',
      'Never let an SSL certificate or domain expire by surprise.',
    ],
    walkthroughs: [
      {
        title: 'Check the Network',
        steps: [
          'Open IT. You land on Network Dashboard.',
          'Check the Critical Notifications and WAN Connections cards for anything red (WAN Down, Packet Loss).',
          'Click a device to open it in UniFi.',
        ],
      },
      {
        title: 'Add a Website to Watch',
        steps: [
          'Click the Website Management tab.',
          'Click Add Site.',
          'Enter the name, URL, platform and hosting details, then save.',
        ],
      },
    ],
    features: [
      { name: 'Network Dashboard', desc: 'Devices, clients, offline devices, internet issues, WAN status and firmware updates.' },
      { name: 'Website Management', desc: 'Every site with status, uptime, SSL expiry and domain expiry, plus SSL alerts.' },
    ],
    manager: { title: 'Admins', points: ['IT Admins also manage hardware in Item Management and access in Settings.'] },
    tips: [],
  },
  {
    id: 'construction', name: 'Construction', group: 'Modules', icon: 'HardHat', view: 'ops',
    tagline: 'Jobsite projects, daily logs, RFIs, submittals and milestones.',
    where: 'Left menu > Construction',
    access: 'Anyone assigned to a jobsite, plus the construction team',
    purpose: 'Construction runs each jobsite. Field crews file daily logs from their phones (hours, crew size, notes, photos), and Nexus writes an AI summary for the project manager to review. RFIs, submittals and milestones track the paperwork and the schedule.',
    gains: [
      'Daily logs from the field without paperwork.',
      'Project managers see every site\'s progress in one dashboard.',
      'Questions (RFIs) and submittals are tracked with who has the ball.',
    ],
    walkthroughs: [
      {
        title: 'File a Daily Log (Field Crew)',
        steps: [
          'Open Construction and click the Site Activity tab.',
          'Pick your project and fill in hours worked, crew size and what happened. Add photos.',
          'Submit it. Your project manager is notified that it is ready to review.',
        ],
      },
      {
        title: 'Review a Daily Log (Project Manager)',
        steps: [
          'Click the bell alert "Daily log ready to review", or open the project.',
          'Read the AI summary. Click to see what the worker originally wrote.',
          'Approve it, or send it back with a note.',
        ],
      },
    ],
    features: [
      { name: 'Project Dashboard', desc: 'Active projects with phase progress, milestones and recent activity. New Project starts one.' },
      { name: 'Site Activity', desc: 'The daily log feed across your jobsites.' },
      { name: 'Daily Logs', desc: 'Hours, crew size, notes and photos, with an AI summary. Logs filed outside the jobsite geofence are flagged (advisory only).' },
      { name: 'RFIs', desc: 'Questions to the design team, with Ball In Court, response due date and the answer.' },
      { name: 'Submittals', desc: 'Material and product approvals by spec section: Draft, Submitted, In Review, Approved.' },
      { name: 'Milestones', desc: 'Target date versus actual date for each project milestone.' },
    ],
    manager: {
      title: 'Project Managers',
      points: [
        'Create projects and add workers. A worker only sees the projects they are on.',
        'Review, approve or send back daily logs.',
      ],
    },
    tips: ['Not on any project? You will see an empty list. Ask your project manager to add you.'],
  },
  {
    id: 'operations', name: 'Operations', group: 'Modules', icon: 'Store', view: 'operations',
    tagline: 'Storage facility operations: FMS, reputation and site staffing.',
    where: 'Left menu > Operations',
    access: 'Supervisors and above with the Operations grant',
    purpose: 'Operations is the home for running the storage facilities: the facility management system connection, customer reviews and the staff roster. It is still being built. The screens show the planned layout, and some figures are sample data until the live connectors are switched on.',
    gains: ['One place for facility health, reviews and staffing, once connected.'],
    walkthroughs: [
      {
        title: 'Look Around',
        steps: [
          'Open Operations. You land on FMS Integration.',
          'Click Reputation Management to see reviews across facilities.',
          'Click Site Staff & Scheduling to see the roster and open shifts.',
        ],
      },
    ],
    features: [
      { name: 'FMS Integration', desc: 'The facility management system connector: units, occupancy and last sync.' },
      { name: 'Reputation Management', desc: 'Reviews across storage facilities with replies.' },
      { name: 'Site Staff & Scheduling', desc: 'Roster and shift coverage by facility.' },
    ],
    manager: { title: 'Note', points: ['For live review data today, use Marketing > Reputation.'] },
    tips: [],
  },
  {
    id: 'item-management', name: 'Item Management', group: 'Modules', icon: 'Package', view: 'inventory',
    tagline: 'Borrow equipment, return it, and see what is assigned to you.',
    where: 'Left menu > Item Management',
    access: 'Everyone. Managing the catalog needs an Editor grant.',
    purpose: 'Item Management tracks every physical company item: laptops, tools, vehicles, keys. There are two kinds. Temporary items are borrowed and returned (checkouts). Permanent items are assigned to you to keep (assignments). Photos are taken at handover and return, so everyone has proof of condition.',
    gains: [
      'Request equipment like online shopping: add to cart, check out.',
      'Always know what you have and when it is due back.',
      'Photo evidence at every handover protects you if something was already damaged.',
    ],
    shot: 'items',
    walkthroughs: [
      {
        title: 'Borrow an Item',
        steps: [
          'Open Item Management and click Check Out an Item.',
          'Find the item (search or filter) and click Add to Cart.',
          'Click Cart (top right), give a reason and dates, and submit.',
          'After approval, the allocator hands it over with a photo. Click Confirm Receipt when you have it.',
        ],
      },
      {
        title: 'Return or Extend',
        steps: [
          'Click Return or Extend (or the My Checkouts tab).',
          'Click Return Item and add a photo of its condition. Paste one with Ctrl+V if you like.',
          'Or click Request Extension to ask for more time.',
        ],
      },
      {
        title: 'Accept Equipment Assigned to You',
        steps: [
          'Click the bell alert about the assignment, or open My Checkouts > Permanent.',
          'Click Confirm You Have It. A photo is optional.',
        ],
      },
      {
        title: 'Need Something Not in the Catalog?',
        steps: [
          'Click Purchase Request on the Item Management home.',
          'Fill in the item, quantity, reason and a reference link, then submit for approval.',
        ],
      },
    ],
    features: [
      { name: 'Browse Catalog', desc: 'Everything available to check out, with photos, filters and search.' },
      { name: 'Cart', desc: 'Collect several items and request them in one go.' },
      { name: 'My Checkouts', desc: 'Active, Past and Permanent tabs: what you have now, what you had, and what is assigned to you.' },
      { name: 'Checkout Stages', desc: 'Requested, Approved, Awaiting Handover, In Use, Returned. The due date counts from handover, not from the request.' },
      { name: 'Permanent Returns', desc: 'Return an assigned item normally, report it dead, report it lost, or return it for reassignment.' },
      { name: 'To Hand Over', desc: 'For allocators: items waiting for you to hand over with a photo.' },
      { name: 'Purchase Requests', desc: 'Formal requests for items the company does not have yet.' },
    ],
    manager: {
      title: 'Managers, Supervisors & Admins',
      points: [
        'Managers approve or reject checkout requests. Supervisors hand items over and confirm returns.',
        'Manage tab: Add Item, Edit Item, Import Items From CSV or Excel, Export Report, assign to a person or location, and the Recycle Bin.',
        'Who Has What shows holdings by person or location. Send Alert nudges someone about an overdue item.',
        'Activity Log records every change with who and when, and most changes can be undone.',
        'Admins set item types and custom fields in Settings > Global Settings > Items.',
      ],
    },
    tips: [
      'Lost-item reports are the only return that does not need a photo.',
      'Warranty and serial details live on the item itself. There is no separate asset list.',
    ],
  },
  {
    id: 'asset-management', name: 'Asset Management', group: 'Modules', icon: 'Home', view: 'property-asset',
    tagline: 'The property portfolio: every property with its documents and deadlines.',
    where: 'Left menu > Asset Management',
    access: 'Supervisors and above with the Asset Management grant',
    purpose: 'Asset Management holds the company property portfolio. Each property card opens a full record: parcel and zoning details, financials, insurance, loans, equipment warranties, inspections, utilities, vendors, permits and documents. Dates that matter (policy expirations, inspections, warranty ends) are tracked so nothing lapses.',
    gains: [
      'Everything about a property in one record, not ten spreadsheets.',
      'Warning before an insurance policy, warranty or inspection lapses.',
      'A Data Completeness score shows what is still missing.',
    ],
    walkthroughs: [
      {
        title: 'Open a Property',
        steps: [
          'Open Asset Management. You land on Property Portfolio.',
          'Click a property card (or switch to Map to find it by location).',
          'Use the tabs and the "On This Page" list to jump between sections.',
        ],
      },
      {
        title: 'Update a Section',
        steps: [
          'Click Edit on the section (for example Insurance).',
          'Change the fields and upload the document if there is one.',
          'Click Save Changes. Leaving with unsaved changes asks first.',
        ],
      },
    ],
    features: [
      { name: 'Portfolio', desc: 'Property cards with type, status and key numbers. Filter by category and view on a map.' },
      { name: 'Property Record', desc: 'Parcel and zoning, units, financials (NOI, cap rate, IRR), loans, insurance and title.' },
      { name: 'Warranties', desc: 'Equipment warranties with Current, Due Soon, Expired and Lapsed status.' },
      { name: 'Inspections', desc: 'Inspection types, last completed and next due dates.' },
      { name: 'Utilities & Vendors', desc: 'Providers, account numbers, autopay, contacts and service records.' },
      { name: 'Documents', desc: 'As-built plans and other documents, linked to their Egnyte location.' },
      { name: 'Flag for Review', desc: 'Mark a record for a colleague to check.' },
      { name: 'Export & Trash', desc: 'Export data, and restore anything deleted from Trash.' },
    ],
    manager: {
      title: 'Asset Managers',
      points: [
        'Each property has a PM / Asset Manager who gets its reminders.',
        'Link a property to another (for example, a parcel to its project).',
      ],
    },
    tips: ['The Warranties Expiring widget on the Dashboard counts warranties ending within 60 days.'],
  },
  {
    id: 'accounting', name: 'Accounting', group: 'Modules', icon: 'Calculator', view: 'accounting',
    tagline: 'The finance dashboard: cash, performance, month-end close and reports.',
    where: 'Left menu > Accounting',
    access: 'Supervisors and above with the Accounting grant',
    purpose: 'Accounting is the Nexus face of the finance dashboard. It reads the company ledger (a mirror of Sage Intacct, which stays the source of truth and is never written to from here). Use it to see cash, compare budget to actual, run the month-end close checklist and pull reports.',
    gains: [
      'Live finance figures without logging in to Intacct.',
      'A 13-week cash forecast with scenarios.',
      'A shared close checklist so everyone knows what is done.',
    ],
    walkthroughs: [
      {
        title: 'Check the Numbers',
        steps: [
          'Open Accounting. You land on Overview.',
          'Click Cash for the plan, scenarios and 13-week forecast.',
          'Click Performance for budget versus actual versus last year, with commentary.',
        ],
      },
      {
        title: 'Work the Month-End Close',
        steps: [
          'Click the Close tab.',
          'Tick checklist items as you finish them and mark reconciliations.',
          'Add a note on any unusual movement (flux).',
        ],
      },
    ],
    features: [
      { name: 'Overview', desc: 'Customizable widgets and role-based views.' },
      { name: 'Cash', desc: 'Cash plan, scenarios and 13-week forecast.' },
      { name: 'Performance', desc: 'Budget vs actual vs prior year, with commentary.' },
      { name: 'Close', desc: 'Close checklist, reconciliations and flux review.' },
      { name: 'Reports', desc: 'Standard financial reports from the ledger.' },
      { name: 'Data', desc: 'Reference figures the ledger does not carry (Editors and up).' },
    ],
    manager: {
      title: 'Editors',
      points: [
        'Editors can maintain the Data tab and record close ticks, marks and notes. Your name is saved with each change.',
        'The same close ticks and notes appear in the Nexus Accounting app.',
      ],
    },
    tips: ['Each tab shows one section at a time. Use the section list at the top to switch.'],
  },
  {
    id: 'investor-relations', name: 'Investor Relations', group: 'Modules', icon: 'Landmark', view: 'investor-relations',
    tagline: 'Deals, investors, capital calls, distributions and investor documents.',
    where: 'Left menu > Investor Relations',
    access: 'Supervisors and above with the Investor Relations grant',
    purpose: 'Investor Relations tracks every deal and the investors in it: what each committed, what has been called and paid, what has been distributed back, and the documents and updates they receive. Capital account statements are built from those records.',
    gains: [
      'One record per investor across every deal.',
      'Capital calls and distributions tracked to the penny.',
      'Statements and K-1s in one document library.',
    ],
    walkthroughs: [
      {
        title: 'Issue a Capital Call',
        steps: [
          'Open Investor Relations and click the Capital Calls tab.',
          'Click New Capital Call and pick the deal, amount and due date.',
          'Save it. Record each investor\'s payment as it arrives, and the call shows Paid once complete.',
        ],
      },
      {
        title: 'Share a Document With Investors',
        steps: [
          'Click the Documents tab, then Upload Document.',
          'Pick the category (Quarterly Report, K-1, PPM and others) and the deal or investor.',
          'Upload it.',
        ],
      },
    ],
    features: [
      { name: 'Dashboard', desc: 'Deals by status, upcoming capital calls, recent distributions and updates.' },
      { name: 'Deals', desc: 'Each deal with its thesis, linked property, investors, and IRR, TVPI and DPI.' },
      { name: 'Investors', desc: 'Individuals, trusts, IRAs and entities, with KYC and accreditation status.' },
      { name: 'Commitments', desc: 'Committed, called and unfunded amounts per investor per deal.' },
      { name: 'Capital Calls', desc: 'Calls issued and their paid status.' },
      { name: 'Distributions', desc: 'Money returned to investors.' },
      { name: 'Capital Accounts', desc: 'Statements and the cash-flow ledger per investor.' },
      { name: 'Documents & Updates', desc: 'Investor documents and posted communications.' },
    ],
    manager: { title: 'Relationship Owners', points: ['Each investor has a relationship owner who manages their record.'] },
    tips: [],
  },
  {
    id: 'people', name: 'People', group: 'Modules', icon: 'Users', view: 'hr',
    tagline: 'HR for the company: employee records, hiring, org chart, leave and time.',
    where: 'Left menu > People',
    access: 'HR and managers with the People grant. Pay and bank details need a separate grant.',
    purpose: 'People is the HR side of Nexus. It holds every employee\'s record (job, manager, contact, documents), runs hiring from candidate to onboarding, draws the org chart, approves leave, and manages team time. This is also where people are added to Nexus and given a job role.',
    gains: [
      'Every employee record in one place, always up to date.',
      'Hiring pipeline from screening to hired, with offer letters sent through Nexus Sign.',
      'Leave and time approvals in one screen.',
    ],
    shot: 'people',
    walkthroughs: [
      {
        title: 'Add a New Employee',
        steps: [
          'Open People. You land on the People tab.',
          'Click Add Person.',
          'Fill in their name, email, company, department, job title and manager.',
          'Choose a Job Role. That decides which Nexus modules they get.',
        ],
      },
      {
        title: 'Move a Candidate Through Hiring',
        steps: [
          'Click the Hiring tab, then Add Candidate.',
          'Move them through Screening, Interview and Offer as things progress.',
          'At Offer, send the offer letter for signature. Mark them Hired to start onboarding.',
        ],
      },
      {
        title: 'Approve Leave',
        steps: [
          'Click the Leave tab (or the bell alert).',
          'Open the request and click Approve or Reject.',
        ],
      },
    ],
    features: [
      { name: 'People', desc: 'The directory of every employee and contractor, with filters by company, department and status.' },
      { name: 'Employee Record', desc: 'Job, reporting line, contact, emergency contact, documents with expiry dates, and history.' },
      { name: 'Hiring', desc: 'Candidates through Screening, Interview, Offer, Hired and Onboarding, with interview scores.' },
      { name: 'Org Chart', desc: 'Reporting lines by department. Drag to move someone.' },
      { name: 'Leave', desc: 'Time-off requests, approvals and the holiday calendar.' },
      { name: 'Time', desc: 'Team punches, time cards and payroll hours.' },
      { name: 'Company Editor', desc: 'Open a company to manage its Overview, Departments, Work Sites (the clock geofences), Holiday Calendar and Workforce Analytics Policy.' },
    ],
    manager: {
      title: 'HR & Admins',
      points: [
        'Compensation (salary, pay type, bank accounts, benefits and deductions) is only visible with the People - Compensation grant.',
        'Offboarding: hand over their tasks, set mailbox handling, then mark them Left.',
        'Changing a status asks for a reason, and every change is kept in history.',
      ],
    },
    tips: ['People pickers across Nexus use this directory, so keep names and emails correct here.'],
  },
  {
    id: 'marketing', name: 'Marketing', group: 'Modules', icon: 'Megaphone', view: 'marketing',
    tagline: 'Ads, reviews, SEO, business listings and leads for every facility.',
    where: 'Left menu > Marketing',
    access: 'Supervisors and above with the Marketing grant',
    purpose: 'Marketing shows how each property is found and chosen: Google Ads spend and results, online reviews and replies, search rankings, Google Business Profile health, and the leads that come in. Alerts flag what needs attention, like a low rating awaiting a reply or a budget running out.',
    gains: [
      'See spend, clicks, leads and move-ins by property.',
      'Reply to reviews before they go stale.',
      'Know where you rank in local search and why.',
    ],
    walkthroughs: [
      {
        title: 'Answer New Reviews',
        steps: [
          'Open Marketing and click the Reputation tab.',
          'Find the reviews still awaiting a reply (the Pending Replies count shows how many).',
          'Open a review, write your reply and click Reply.',
        ],
      },
      {
        title: 'Check an Ad Budget',
        steps: [
          'Click the Ad Performance tab.',
          'Pick the date range (Last 7 Days, This Month and others).',
          'Click Set Budget to change a property\'s monthly budget.',
        ],
      },
    ],
    features: [
      { name: 'Ad Performance', desc: 'Google Ads campaigns: spend, clicks, CTR, conversions and cost per lead, with budgets.' },
      { name: 'Reputation', desc: 'All reviews in a live feed, rating trend, NPS and replies.' },
      { name: 'Insights', desc: 'Website sessions, conversion funnel, lead sources and an AI Marketing Analyst.' },
      { name: 'SEO', desc: 'Rank tracker, keyword explorer, local pack rankings, backlinks and competitors.' },
      { name: 'Business Profile', desc: 'Google Business listings: posts, photos, Q&A and listing alerts.' },
      { name: 'Leads', desc: 'Every lead with source, stage and owner, against monthly lead goals.' },
    ],
    manager: { title: 'Marketing Leads', points: ['Set monthly lead goals and ad budgets per property. Alerts fire when a goal is at risk or a budget is nearly spent.'] },
    tips: [],
  },
  {
    id: 'business-intelligence', name: 'Business Intelligence', group: 'Modules', icon: 'Gauge', view: 'bi',
    tagline: 'Company-wide KPIs from every module, as charts you can arrange.',
    where: 'Left menu > Business Intelligence',
    access: 'Supervisors and above with the BI grant',
    purpose: 'Business Intelligence pulls key numbers from across Nexus onto one board. Each card can be a chart, table or single number, and anything that needs attention is flagged at the top.',
    gains: [
      'Cross-module numbers in one place.',
      'Download any card as CSV.',
    ],
    walkthroughs: [
      {
        title: 'Arrange Your Board',
        steps: [
          'Open Business Intelligence.',
          'Click Customize.',
          'Pick each card\'s chart type (Bar, Line, Pie, Table, Card and more) and drag the cards into place.',
          'Click Done. Click Reset Layout to start over.',
        ],
      },
    ],
    features: [
      { name: 'Cards', desc: 'Bar, Column, Stacked Bar, Line, Area, Pie, Donut, Funnel, Treemap, Table or a single number.' },
      { name: 'Alerts', desc: 'Metrics past their alert level are flagged.' },
      { name: 'Export', desc: 'Download any card as CSV.' },
    ],
    manager: { title: 'Note', points: ['You only see numbers from modules you have access to.'] },
    tips: [],
  },
  {
    id: 'credential-vault', name: 'Credential Vault', group: 'Modules', icon: 'KeyRound', view: 'credvault',
    tagline: 'Shared company passwords, stored safely, with access by request.',
    where: 'Left menu > Credential Vault',
    access: 'Supervisors and above with the Credential Vault grant',
    purpose: 'Credential Vault stores company logins so they are never shared in chat or spreadsheets. Shared credentials belong to a department and an owner. You request access, the owner approves it, and revealing a password needs a quick identity check. Your Personal Vault is private, locked with your own password.',
    gains: [
      'No more passwords in email, chat or sticky notes.',
      'Every reveal and copy is logged.',
      'Owners control who has access, and for how long.',
    ],
    walkthroughs: [
      {
        title: 'Use a Shared Password',
        steps: [
          'Open Credential Vault and find the credential (Shared With Me, or search).',
          'If you do not have access, click Request Access. The owner is notified.',
          'Once approved, click Reveal and verify it is you (SMS or email).',
          'Click Copy for the username or password.',
        ],
      },
      {
        title: 'Save Your Own Password',
        steps: [
          'Click Personal Vault. The first time, choose a Personal Vault password.',
          'Click Add Personal Credential.',
          'Fill in the name, username and password, then save. No one else can see it.',
        ],
      },
    ],
    features: [
      { name: 'Shared With Me', desc: 'Credentials you have access to, in tile or list view.' },
      { name: 'Personal Vault', desc: 'Encrypted and private, locked with your own password.' },
      { name: 'Access Requests', desc: 'Request, then approve or deny, with an access duration.' },
      { name: 'Rotation Alerts', desc: 'Set a password expiry timeline and get reminded to change it.' },
      { name: 'Batch Import', desc: 'Upload many credentials from a CSV template.' },
      { name: 'Trash & Activity Log', desc: 'Deleted credentials can be recovered, and every action is logged.' },
    ],
    manager: {
      title: 'Owners & Admins',
      points: [
        'Owners approve access requests and can Share Access directly.',
        'Manage Vault: Edit Mode for bulk edits and deletes, Batch Import, and the Activity Log.',
      ],
    },
    tips: ['Forgot your Personal Vault password? Reset it from the vault. You will verify your identity first.'],
  },

  // ───────────────────────────── System ─────────────────────────────
  {
    id: 'support', name: 'Support', group: 'System', icon: 'HelpCircle', view: 'support',
    tagline: 'Get help: raise a ticket, report a bug, and read this guide.',
    where: 'Left menu > Support',
    access: 'Everyone',
    purpose: 'Support is where anyone goes for help. Submit a ticket to IT, HR, facilities or any other team, report something broken in Nexus, find a colleague, and track everything you have raised. You do not need access to the Tickets module to use it.',
    gains: [
      'Help from the right team, with the right questions asked up front.',
      'Live status of everything you have raised.',
      'This Documentation tab, for learning any module.',
    ],
    shot: 'support',
    walkthroughs: [
      {
        title: 'Submit a Ticket',
        steps: [
          'Open Support and click Submit a Ticket.',
          'Pick the type of request. Only that type\'s questions appear.',
          'Fill them in, attach a screenshot if it helps, and submit. It is routed to the right person automatically.',
        ],
      },
      {
        title: 'Report a Bug in Nexus',
        steps: [
          'Click Report a Bug.',
          'Describe what happened and what you expected, and paste a screenshot with Ctrl+V.',
          'Submit. It goes to the Nexus team as a bug, not a request.',
        ],
      },
      {
        title: 'Follow Up on Your Ticket',
        steps: [
          'Find it in My Open Tickets (search by ticket number or title).',
          'Click the row to open the full thread and reply.',
        ],
      },
    ],
    features: [
      { name: 'Submit a Ticket', desc: 'The same form the Tickets module uses, with routing and due dates set automatically.' },
      { name: 'Report a Bug', desc: 'For anything broken in Nexus itself.' },
      { name: 'Contact Directory', desc: 'Find the right person across the organization.' },
      { name: 'Privacy Policy & Terms', desc: 'What Nexus collects, and the terms of use.' },
      { name: 'My Open Tickets', desc: 'Everything you raised that is not closed yet. Sort, search and page through it.' },
      { name: 'Documentation', desc: 'This guide.' },
    ],
    manager: { title: 'Note', points: ['Ticket agents work the queue from the Tickets module. Support is the requester\'s side.'] },
    tips: ['Email and bell updates about your ticket open it right here.'],
  },
  {
    id: 'settings', name: 'Settings', group: 'System', icon: 'Settings', view: 'admin-console',
    tagline: 'Organization-wide settings, per-company setup, who can access what, and the audit trail.',
    where: 'Left menu > Settings',
    access: 'IT Admin and Global Admin, or anyone given the Settings grant',
    purpose: 'Settings is where admins shape Nexus. Global Settings apply to every company; Company Settings, including each company\'s job roles, are managed one company at a time. Access, under Global Settings, decides who sees which module. Tools holds actions rather than settings, such as Act As and the Microsoft 365 sync, and Audit Logs record every change.',
    gains: [
      'Change a setting once for the whole organization, or for just one company.',
      'Give someone exactly the access they need, in one place.',
      'A full record of who changed what.',
    ],
    shot: 'access',
    walkthroughs: [
      {
        title: 'Find and Change a Global Setting',
        steps: [
          'Open Settings. Global Settings opens first.',
          'Pick a category on the left (on a phone, from the Category list), or type in Filter Settings to search every category.',
          'Click a section to open it, make your change and click Save.',
        ],
      },
      {
        title: 'Set Up a Company',
        steps: [
          'Click the Company Settings tab.',
          'Click Edit on the company, or Add Company.',
          'Use its tabs for the profile, workforce analytics policy, departments, work sites and holiday calendar.',
        ],
      },
      {
        title: 'Give Someone Access to a Module',
        steps: [
          'Open Settings. In Global Settings, click Access in the category list.',
          'Pick a person.',
          'Change their job role (only their company\'s roles and shared roles are offered), or add them to an Access Group that grants the module.',
          'Pick the access level (Viewer, Editor, Full or Owner). It saves right away.',
        ],
      },
      {
        title: 'See What Someone Else Sees',
        steps: [
          'Open Settings and click the Tools tab.',
          'Click Act As and pick the person. Nexus shows their view, with a banner saying who you are acting as.',
          'Stop acting as them from the banner when you are done.',
        ],
      },
    ],
    features: [
      { name: 'Global Settings', desc: 'Settings that apply to every company, by category. Organization: Email Signature and the Work Site Library. Notifications & Communications: Service Desk (ticket routing and escalation, ticket email, and SLA & Ticket Types), Task Notifications and the Daily Briefing. Access: who can open which module. Items: Item Types & Custom Fields.' },
      { name: 'Company Settings', desc: 'One company at a time: its profile and logo, managers and HR contact, workforce analytics policy, departments, the work sites it uses from the library, and its holiday calendar. The group manager above every company is set here too.' },
      { name: 'Company Roles', desc: 'Each company\'s job roles, grouped by its departments: the baseline set of modules, seniority tier and default approver. Roles shared across companies are listed there too, and can be moved into a company when everyone holding them works there.' },
      { name: 'Access', desc: 'In Global Settings: each person\'s effective access, Access Groups (extras on top of a job role), per-person overrides and the full access matrix.' },
      { name: 'Tools', desc: 'Actions rather than settings: Act As, the Microsoft 365 directory sync, and troubleshooting (a live check of the Nexus server and diagnostic info to paste into a support ticket).' },
      { name: 'Audit Logs', desc: 'Every access and settings change, with who and when.' },
    ],
    manager: {
      title: 'Who Can Do What',
      points: [
        'IT Admins can grant access up to Manager. Only Global Admins can manage other admins.',
        'Same job in another company? Duplicate the role for that company rather than sharing one role across companies.',
        'Set an approver for a whole role once, instead of for each person.',
      ],
    },
    tips: [
      'Changes to a job role apply to everyone with that role right away.',
      'Not sure which category a setting is in? Type a word like "email" or "SLA" in Filter Settings.',
    ],
  },
];
