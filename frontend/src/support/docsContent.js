// Help Center -> Documentation: the written guide to every Nexus module.
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
  { name: 'Employee', desc: 'Everyone starts here. Use the everyday screens: Dashboard, Workday, Team, Item Management and Help Center (with the Knowledge Base).' },
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

// A feature may carry `tour`: the on-screen label(s) the page's guided tour
// looks for when the screen words it differently from `name` (lib/autoTour.js).
export const DOCS = [
  // ───────────────────────────── Start Here ─────────────────────────────
  {
    id: 'getting-started', name: 'Getting Started', group: 'Start Here', icon: 'Sparkles',
    tagline: 'Your first 10 minutes in Nexus - the layout, search, alerts and who can see what.',
    where: 'Everywhere - these parts are on every screen',
    access: 'Everyone',
    purpose: 'Nexus is the company portal. It brings your hours, tasks, tickets, equipment, documents, training and company tools into one place, and you sign in with your normal Microsoft work account. Every module follows the same pattern, so once you learn one screen the rest feel familiar.',
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
          'Click the tab on the right edge of the left menu (Collapse Sidebar) to fold it to icons when you want more room. Click the N at the top of the menu to go back to the Dashboard.',
        ],
      },
      {
        title: 'Find Anything in Two Seconds',
        steps: [
          'Press Ctrl+K (Cmd+K on a Mac) or /, or click Search Nexus in the top header.',
          'Type a few letters of a task, project, person, portfolio, team, item, checkout, purchase request or page.',
          'Click the result (or use the arrow keys and Enter) to jump straight to it. A person opens their tasks if you use Tasks, otherwise their contact card.',
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
          'Click Profile to check your details, photo, signature, Dark Mode and theme.',
          'Pick your Date Format in Profile - MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD or DD MMM YYYY - and every date in Nexus shows that way for you.',
          'Scroll to Email Settings in Profile to choose which emails Nexus sends you.',
        ],
      },
      {
        title: 'Keep Up With What\'s New',
        steps: [
          'Click your photo (top right) and click What\'s New.',
          'Click For You to see only updates about the modules you use.',
          'Click Follow, pick modules and categories, and tick the Monday digest if you want an email. Matching updates land in your bell.',
          'Click Feature Request, describe what you would like, and click Send Request. It becomes a Feature Request ticket and is posted to the Nexus team on Teams. Its status (New, Under Review, Planned, In Progress, Shipped or Declined) and the replies on its ticket show there, and your bell rings when it changes.',
        ],
      },
    ],
    features: [
      { name: 'Left Menu', desc: 'Grouped into My Desk, Work, Modules and System. You only see what your role or Access Groups allow.' },
      { name: 'Top Tabs', desc: 'Each module shows its own tabs in the header (in the page itself on a phone).' },
      { name: 'Search (Ctrl+K)', desc: 'One Search Nexus bar in the same place on every screen: tasks, projects, people, portfolios, teams, items, checkouts, purchase requests and pages. Press / to jump to it (on Contact and the Knowledge Base, / goes to that page\'s own search), and Esc clears it.' },
      { name: 'Notification Bell', desc: 'Every alert meant for you: approvals, handovers, assignments, mentions, reminders and updates on tickets you raised. Repeats are grouped into one notice that updates in place, other task and ticket activity stays inside those modules, and anything you clear stays under Closed for 30 days.' },
      { name: 'Page Help (?)', desc: 'The ? in the header (or the ? key) opens the Help panel. Home has Search for Help, Ask a Question, What\'s New in Nexus, Help with This Page and Take the Tour; Messages lists your tickets; Help searches the guide, documents and courses.' },
      { name: 'Profile Menu', desc: 'Profile (your photo, signature, appearance, Date Format, world clock and Email Settings - everything that is only about you; Date Format sets how every date in Nexus reads for you, MM/DD/YYYY until you pick another), What\'s New, Legal and Sign Out.' },
      { name: 'Tour', desc: 'Every screen has a guided tour: open the ? Help panel and click Take the Tour, or Other Tours to pick another screen. Tasks, Tickets and Help Center also run theirs once on your first visit.' },
      { name: 'Time Clock in the Left Menu', desc: 'The foot of the left menu shows your shift and hours with Punch In, Start Break / End Break and Punch Out, even when the menu is folded to icons. On a phone it is a pill that opens the same clock.' },
      { name: 'Priority Bar', desc: 'A yellow bar at the top of the screen for things that need you, like a time sheet to sign or a punch fix to approve. Tap the text for the full message; Open goes to the item and clears it, and with several waiting, Show All lists them and Clear All closes them all (each stays in the bell under Closed).' },
      { name: 'New in Nexus Bar', desc: 'A green bar at the top when a New Feature came out this week (See What\'s New opens it), or when a newer version of Nexus is out (Reload loads it). Close it with the X; the week\'s news also waits in the bell.' },
      { name: 'What\'s New', desc: 'Every change to Nexus, open to everyone from the menu under your name or the Help panel. Latest shows the newest updates with Pinned, For You and Needs Your Attention (known issues and features going away); Timeline lists them all by day with filters.' },
      { name: 'New on This Screen', desc: 'A small card on a screen that says what changed there, a Known Issue with its workaround, or a feature Going Away, with See What\'s Changed or See Details (and Take the Tour when the update has one).' },
      { name: 'Phone Friendly', desc: 'Nexus works in your phone browser. The left menu becomes a menu button, and tabs become swipeable.' },
    ],
    manager: {
      title: 'How Access Works',
      points: [
        'Your role tier (Employee, Supervisor, Manager, IT Admin, Global Admin) sets what you can approve.',
        'Your job role gives you a standard set of modules. Access Groups add extra modules on top.',
        'Each module grant has a level: Viewer, Editor, Full or Owner.',
        'Admins set job roles per company in Settings > People & Access with the company picked, and everything else there with the scope on Every company. See the Settings page of this guide.',
      ],
    },
    tips: [
      'Cannot see a module a colleague uses? It is not broken. You just have not been granted it yet. Ask your manager or raise a ticket.',
      'Dates show as MM/DD/YYYY and times as 12-hour AM/PM everywhere in Nexus.',
      'Stuck? Help Center > Submit a Ticket reaches a real person.',
      'Managers can raise a priority notice for one person from the megaphone in the bell. It stays as a yellow bar on their screen until they act on it.',
      'People with Tasks or Tickets access can add a What\'s New update (Add New Update) and comment. A manager publishes it and runs Manage. Work merged into Nexus is published there on its own.',
    ],
  },

  // ───────────────────────────── My Desk ─────────────────────────────
  {
    id: 'dashboard', name: 'Dashboard', group: 'My Desk', icon: 'LayoutDashboard', view: 'dashboard',
    tagline: 'Your home page: what needs you today, at a glance.',
    where: 'Left menu > Dashboard',
    access: 'Everyone. Team widgets need a Supervisor or Manager role (depending on the widget) or the Manager Dashboard grant.',
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
          'Click any stat tile (Open Tasks, Checked-Out Items, My Equipment, Signatures Needed) to jump to that list.',
          'Click an alert in the queue to open it, or use Quick Actions to start a task, event, email, ticket or item request.',
        ],
      },
      {
        title: 'Build Your Own View',
        steps: [
          'Click Customize (top right of the greeting).',
          'Click Add Widget and pick one (KPI Stat, Calendar, Notes, Quick Links, Notifications and more).',
          'Drag widgets to move them and drag a corner to resize. Click Auto-Fit to close gaps.',
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
      { name: 'Customize', desc: 'Edit mode: Add Widget, drag to arrange, resize, Auto-Fit, Save and Done.' },
      { name: '"..." View Menu', tour: 'View options', desc: 'Rename View, Set as My Default, Make Home My Default, Save as New View, Publish to Department, Delete View.' },
      { name: 'Widget Gallery', desc: 'Metrics (KPI Stat), Workday (Time Clock, Action Required, My Work, My Time, My Requests, Due Back Soon, Coming Up), Actions (Action Tile, Quick Actions), Navigation (Shortcut Tile), Links (Quick Links, Links Folder, Favorites, My Personal Links), Live (Notifications, Calendar, Weather, Announcements), Utility (Clock & Greeting, Notes), plus Team widgets and, for Accounting users, Find a Transaction.' },
      { name: 'Links Tab', desc: 'Every company and personal web link. Search, filter by category, department or company, pin, favorite, sort into folders, and switch between tile and list view.' },
      { name: 'Personal Links', desc: 'A link you add is visible only to you. Company-wide links are managed by admins through Manage Links.' },
    ],
    manager: {
      title: 'Managers & Admins',
      points: [
        'Team widgets open by role. Supervisors get Team Clocked-In, Who Has What, My Ticket Queue and My Team; Managers also get Team Approvals, Time Off to Review, Pending Approvals, Team Time, Time Exceptions, Out Today and Pending Purchases. The Manager Dashboard grant opens all of them.',
        'Publish to Department shares your view with everyone in your department.',
        'Admins use Manage Links (Links tab) to add company links for everyone, set categories, departments and companies, or Batch Import links.',
      ],
    },
    tips: [
      'A view with a star in the picker is your default, and it opens first.',
      'Leaving Customize with unsaved changes asks before throwing them away.',
      'The Notes widget saves what you type straight away. No Save is needed outside Customize.',
    ],
  },
  {
    id: 'workday', name: 'Workday', group: 'My Desk', icon: 'Contact', view: 'myhr',
    tagline: 'Clock in and out, check your hours and request time off.',
    where: 'Left menu > Workday',
    access: 'Everyone (employees)',
    purpose: 'Workday is everything about your own time and HR record in one place. Overview opens with the Time Clock, so you punch in and out (with breaks) from the page you land on; below it are your hours, documents, upcoming time off and profile. My Schedule on the Overview shows your week of shifts and the time off coming up. Check your time sheet for the pay period, request time off, and keep your contact and emergency details up to date. Only you see your own Workday.',
    gains: [
      'Get paid correctly. Every punch is timestamped and tagged with where it happened.',
      'See your hours for this pay period, day by day, before payroll does.',
      'Request time off in a few clicks and see when it is approved.',
      'Find your signed documents, HR files and paystubs in one place: My Documents.',
    ],
    shot: 'clock',
    walkthroughs: [
      {
        title: 'Punch In for the Day',
        steps: [
          'Open Workday from the left menu. The Time Clock is the first card on Overview.',
          'Click Punch In (or Play on the clock in the left menu). The first time, read the monitoring notice and acknowledge it. Write your Beginning of Day message when asked - unless your role is exempt, Nexus does not clock you in without it.',
          'Allow location if your browser asks. On a phone this gives the most accurate location check.',
        ],
      },
      {
        title: 'Take a Break and Punch Out',
        steps: [
          'Click Start Break when you step away and say why in the Going on Break box - it posts to your Teams chat. The button changes to End Break.',
          'Click End Break when you are back.',
          'Click Punch Out at the end of your day and write your End of Day message - the clock-out waits for it unless your role is exempt.',
        ],
      },
      {
        title: 'Request Time Off',
        steps: [
          'Click the Time Off tab.',
          'Pick the Reason (Personal, Sick, Vacation or Medical Appointment) and the From and To dates. Turn All day off to take part of one day.',
          'Add a note if your approver should know more (optional), then click Request. It shows as Pending until your approver decides.',
        ],
      },
      {
        title: 'Check Your Hours',
        steps: [
          'Click the Time Sheet tab.',
          'Read your hours for this pay period, day by day, including breaks.',
          'Use the arrows beside the dates to move between pay periods, or click the dates to pick one from the list of recent pay periods (the current one is marked) or jump to the period that holds a date.',
        ],
      },
      {
        title: 'Ask the Company to Buy Something',
        steps: [
          'Click the Purchase Requests tab (or Purchase Request on the Overview).',
          'Click New Purchase Request. Pick who it is for, the item, quantity, department, a reason, the manager who should approve it and an optional reference link, then click Submit Request.',
          'It shows under My Requests as Pending Approval, then Approved, Ordered and Fulfilled - or Rejected with the reason. History on a request lists every step.',
        ],
      },
      {
        title: 'Sign Your Time Sheet',
        steps: [
          'After the pay period ends, your manager reviews and approves your hours - you do not have to submit first. You get a bell and an email when it is approved.',
          'Click the Time Sheet tab. Time Sheet Review & Signature is at the top; Time Sheets to Sign lists any period still waiting on you.',
          'Check the hours. Something wrong? Ask for a punch fix on the day, or decline in Nexus Sign with a reason - either way it goes back to your manager.',
          'Click Sign & Submit and sign in Nexus Sign. Your signature finalizes the period for payroll, and the signed copy is filed in My Documents.',
        ],
      },
    ],
    features: [
      { name: 'Overview', desc: 'Opens with one row of tiles: Hours This Week, Time Off This Year (approved working days, Monday to Friday, a partial day counted as its share of 8 hours), Time With Us (from the start date on your HR record - ask HR if it is wrong) and Ask HR at the right end - it opens New Request and every request you have sent with the answer from HR, and a red dot on it means HR has updated one you have not looked at yet (the request is marked Updated by HR). Then the Time Clock, then your profile, contact and emergency details, assigned equipment and checkouts, My Schedule and My Documents (signed documents, the files HR keeps for you and your paystubs, by folder). Only you see this page.' },
      { name: 'Documents to Sign', desc: 'At the top of Overview whenever a Nexus Sign document is waiting on your signature (an offer letter, a policy, an HR form). Click Review & Sign to sign it right here - the bell and the email open it for you. Time Sheets to sign stay on the Time Sheet tab.' },
      { name: 'Time Clock', desc: 'On Overview: Punch In, Start Break, End Break and Punch Out with a live dial for the shift you are on and where the punch was recorded. Beside it, your hours with a Today / This Week / Pay Period switch (it opens on Today and remembers your pick on this browser) - the total, days worked, daily average and breaks, then the punches of the day on a timeline or daily bars against an 8-hour line. Time Sheet opens every punch, day by day.' },
      { name: 'My Schedule', desc: 'On the Overview (your own shifts moved here from the Shifts module on 10/13/2026): a line that sums the week up - shifts, paid hours, time off and your next shift - then your days one by one; Request under a shift asks to swap, offer or release it (when your company allows it), Confirm shows when a manager asks you to confirm a newly shared schedule, past shifts show On Time, Late, Left Early or No-Show (tap to read), In your Outlook calendar (when your company has it on) and Subscribe in another calendar put your shifts in your calendar, weather calls on your days wait here for you to acknowledge (Text me when a weather call changes my shift turns your texts off), and My Availability opens under the week. The My Week | Team switch shows your group\'s week in the same card (it is also Team > Shifts).' },
      { name: 'Time Sheet', desc: 'Your hours this pay period, day by day. Sick, vacation and personal hours show on their own lines. A shift with a break shows as punch pairs: clock-in to the break, then the break end to clock-out, each with its hours, and the break between them. To ask for missing time, click Add on the day, pick its Type - Regular, Break, Sick, Vacation or Personal - set the start and end, and give a reason. Times are in your own timezone. The request shows on its day as Not Yet Approved until your approver decides. Add Note leaves a note on a day for your manager. Time Sheet Review & Signature sits at the top, then Change Requests This Period. Send to Manager asks your manager to look before the period ends (optional). A contractor\'s Time Sheet reads Rate, Amount and Monthly Fee instead of pay, and an Invoice card under Time Sheet Review & Signature shows the invoice drafted when the period is finalized, then when HR sent it, with its PDF. On a phone each day is its own card.' },
      { name: 'Time Off', desc: 'Request time off: a Reason (Personal, Sick, Vacation or Medical Appointment), the dates, and an optional Note. Keep this confidential shows your team only that you are out and the reason, never the note. Every request you have made is listed under My Requests as Pending, Approved, Rejected or Cancelled, and you can cancel one that is pending or approved. Past dates are grayed out - click Request for a Past Date to ask for one you missed. Your manager\'s manager is told about every request too.' },
      { name: 'Location Tag', desc: 'Each punch shows the location you were at when you punched, judged by where the punch was made, even if you move between several locations in a day. A punch inside any of your company locations shows that site; a punch away from all of them shows Out of Location, and that time is never billed to the nearest site. A punch from a device with no GPS (a desktop) often gets only a rough location and shows Approx. Location, because it is too rough to tell which site you were at - punch from your phone for a precise one. A rough location that is nowhere near any site still shows Out of Location. Remote and Hybrid staff can punch from anywhere (away from a site it shows Remote), and their location is still recorded. Click a location on the time sheet to see the punches of that shift on the map; a manager can also change the location of the punch from there.' },
      { name: 'Location Off at Clock-In', desc: 'A punch never waits for your location. If you clock in with location turned off, a red Needs Attention bar asks you to turn it on, with Turn On and Skip. Turn On asks your browser for your location (or shows the steps to allow it when it is blocked) and adds it to that clock-in. Skip keeps the clock-in as Location Off on your Time Sheet and lets your manager know. Works the same on a phone and a computer. People exempt from screen monitoring are never asked.' },
      { name: 'Clock in the Left Menu', desc: 'The time clock also sits in the left menu: Play punches in (or ends a break), Pause starts a break, Stop punches out. The dial fills toward 8 hours - green on the clock, amber on a break, red off - and clicking it opens the full clock.' },
      { name: 'Purchase Requests', desc: 'Formal requests for things the company does not have yet (moved here from Item Management on 10/22/2026). My Requests lists yours with their status, reason, reference link and history. Item Management managers also get Approvals: Approve and pick who purchases and fulfills it, or Reject with a reason. The person picked marks it Ordered, then Fulfill Without Adding (consumables, with a note) or Received - Add to Items, which opens the Add Item form prefilled and fulfills the request once the item is saved.' },
      { name: 'Delegate My Approvals', desc: 'At the bottom of the Time Off tab, collapsed. Only for days you have approved time off: pick who covers your approvals - your manager or someone above, a peer under the same manager, or someone at your level or above, never your own team - and the dates. Your approvals go to them for those days; you keep yours too.' },
      { name: 'California Meal and Rest Breaks', desc: 'For everyone whose Country or Region is the US, hourly and salaried: the signing screen and the signed time sheet carry the statement "I was provided every meal and rest break California law requires.", and signing confirms it. Hourly staff on the California overtime rule who missed a break click Report a Missed Break instead of signing - pick the days and Meal or Rest; your manager adds the premium pay and sends it back to you.' },
    ],
    manager: {
      title: 'Managers & Admins',
      points: [
        'Time Sheets to Review is only in People > Time - your own Workday > Time Sheet tab lists just the time sheets waiting on your signature. A "For <name>" chip means you are covering that person\'s approvals.',
        'Time-off requests route to your approver. Managers review them from the Dashboard (Time Off to Review) and the bell.',
        'Team hours, punch fixes and payroll time sheets live in People > Time. The schedule itself is built in Team > Schedule.',
        'HR sets locations (the geofence used for on-site checks) and holiday calendars in People.',
      ],
    },
    tips: [
      'A red dot on a module in the left menu means something there is waiting on you - a request to approve, a document to sign, a schedule to confirm. Open the module and the tab with the red number is where it is; inside it, each item waiting on you sits in a red-tinted box with a red bar on its left. The dot and the box go away once you have acted.',
      'If you see "Your Punch Did Not Record", try again from a phone or a stable connection. Nothing was saved.',
      'Approved time off is not punched in for you automatically.',
      'If Workday shows no clock and no Time Sheet tab, you are on a salaried, time-tracking-exempt setup - Nexus does not record punches or hours for you. Raise a ticket if that is wrong.',
    ],
  },
  {
    id: 'workforce-analytics', name: 'Workforce Analytics', group: 'My Desk', icon: 'MonitorDot', view: 'employee-tracking',
    tagline: 'Live coverage, activity, the weekly hours Scorecard, punch locations and company computers.',
    where: 'Left menu > Workforce Analytics',
    access: 'IT Admin and Global Admin, or anyone given the Workforce Analytics grant. The Scorecard tab alone opens with the Workforce Scorecard grant.',
    purpose: 'Workforce Analytics is the disclosed monitoring dashboard. It shows who is working right now, where each person last punched from, activity on enrolled company computers and screenshots taken under the company policy. Employees are told about it before they first clock in.',
    gains: [
      'Know at a glance who is working, on break or not clocked in.',
      'Spot punches made away from the location.',
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
        title: 'Score Last Week\'s Hours',
        steps: [
          'Click the Scorecard tab. It opens on the last full week; use the arrows to move between weeks.',
          'Each hourly person shows their expected hours (published shift, else shift preset, else the standard day - US 8h, India 9h), the hours they punched, Sick / PTO leave, and a score with Absent, Short and Late day counts.',
          'Click a row for the day-by-day breakdown: holidays, approved time off and missing punches are written on the day.',
          'Click Email Me This Report to get the same scorecard in your inbox. Managers holding the grant also receive it automatically every week once Settings > Workforce Scorecard is live.',
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
      { name: 'Coverage', desc: 'Live list of who is Working, On Break or Not Clocked In, with On Site and Out of Location tags.' },
      { name: 'Activity', desc: 'Time and activity per person across the day.' },
      { name: 'Scorecard', desc: 'Punched hours against expected hours for each hourly person, by week: On Track, Below Expected, Well Below, Absent, with the days that were excused and why. The same report goes to managers by email.' },
      { name: 'Locations', desc: 'A map of where each person last punched from.' },
      { name: 'Location Trail', desc: 'When a company turns on Location Trail While Clocked In (Settings > Workforce Analytics > Location Trail), the live position of each person on your team who is clocked in, and the trail of any one person for a chosen day with their punches on it. Managers only: employees never see a trail, their own included.' },
      { name: 'Computers', desc: 'Company computers with the desktop agent. Copy the install or uninstall command here.' },
      { name: 'Screenshots', desc: 'Screenshots captured under the policy, shown by day, with the capture interval.' },
    ],
    manager: {
      title: 'Who Can Do What',
      points: [
        'A viewer grant lets you watch coverage, activity and locations.',
        'A full grant also allows remote control and managing devices and policies.',
        'The Workforce Scorecard grant is separate: Viewer scores your direct reports, Editor your whole reporting line, Full the whole company. Its weekly email, standard day and thresholds live in Settings > Workforce Scorecard.',
        'The monitoring policy itself (whether work on company computers is captured, how often and what is tracked) is set per company in Settings > Workforce Analytics with the company picked. The app and website ratings behind the productive / neutral / unproductive split are Settings > Workforce Analytics > App & Website Ratings - the same list the Activity tab\'s Rate button opens.',
      ],
    },
    tips: [
      'Monitoring is disclosed. Every employee acknowledges it before their first punch.',
      'Monitoring Alerts never lists someone whose role is exempt from monitoring, and a desktop agent that has gone quiet is not an alert while the in-browser share is still capturing that person.',
      'The Locations map shows everyone who has punched with a location - including external staff and people still onboarding in People - until they are offboarded.',
    ],
  },
  {
    id: 'shifts', name: 'Team', group: 'My Desk', icon: 'Handshake', view: 'shifts',
    tagline: 'Reach anyone in the company and see your group\'s shifts; managers build and share the schedule.',
    where: 'Left menu > Team (managers: Schedule and Requests tabs)',
    access: 'Everyone sees Contact and Shifts. Managers and above also get Schedule (the grid) and Requests (the inbox). Your own shifts are in Workday > My Schedule. Shift types and groups are in Settings > Shifts & Scheduling; staff ask for swaps, offers, releases and open shifts in Workday > Time Off once their company turns those on (they are off by default).',
    purpose: 'Team is everything about the people you work with. Contact is the company directory: find anyone, see who is on shift or off today, and reach them on Teams, by phone or by email. Shifts is your group\'s week, with you pinned at the top. Managers open Schedule to place shifts on a weekly grid, fill a whole group from a shift type in one go, post open shifts and Share when it is ready. Share lists every change and any rule warnings first, and once a day has started the grid shows who was on time, late, left early or did not show. Nothing reaches the team until it is shared.',
    gains: [
      'Find and reach anyone in the company, with who is in and who is off today.',
      'See who else is on this week without messaging your manager.',
      'Ask for an open shift, or swap, offer or release a shift, without messaging your manager (when your company turns requests on).',
      'Managers: plan the week on one grid, with daily and weekly hour totals as you go.',
      'Fill a group\'s schedule across a date range in one step instead of shift by shift.',
      'See time off, holidays and limited availability right on the grid before you schedule someone.',
      'Tell people only when their shifts change, by bell and email.',
      'Managers: see on the grid who was on time, late, left early or a no-show, and get a bell when someone has not clocked in.',
      'Catch short rest, too many days in a row and overtime before you share, not after.',
      'Get your shared shifts in Outlook or any calendar app, and confirm you have seen a new schedule.',
    ],
    walkthroughs: [
      {
        title: 'Check When You Work',
        steps: [
          'Open Workday from the left menu and find My Schedule on the Overview.',
          'Read your next shift and this week\'s hours at the top, then your week day by day.',
          'To see who else is on, open Team and click Shifts. You are pinned at the top, and a green dot marks who is on shift now.',
          'This week, each person also shows a live status from the time clock (Working, On Break with how long, or Clocked Out), and the line above the grid names who is on a break right now. It refreshes every minute.',
        ],
      },
      {
        title: 'Reach a Colleague',
        steps: [
          'Open Team from the left menu and click the Contact tab (the last one).',
          'Search a name, or browse by Departments, Reporting Line or Org Chart.',
          'Click the person, then Chat, Call or Email.',
        ],
      },
      {
        title: 'Swap, Offer or Release a Shift',
        steps: [
          'In Workday > My Schedule, click Request under one of your shifts and pick Swap, Offer or Release. Request shows only when your company has turned these on.',
          'Pick the teammate (and, for a swap, one of their shifts).',
          'Send it. A swap or an offer goes to your teammate first, then to a manager; a release goes to a manager, or straight to the open pool if your company needs no approval.',
        ],
      },
      {
        title: 'Set Up a Shift Type and a Group',
        steps: [
          'Administrators: open Settings > Shifts & Scheduling. If you look after more than one company, pick it in the Scope box at the top first - a shift type or group is either Shared With Every Company or belongs to one.',
          'Under Shift Types, click New Shift Type: name, a short code for the grid, color, start and end time, unpaid break, grace minutes, time zone and days. Click Save.',
          'Under Groups, click New Group: name it, pick its members from the People list and any Schedulers, then click Save. For an outdoor crew, also pick its Work Site and Weather Deciders.',
          'To send the group\'s BOD, EOD and break messages to Microsoft Teams, choose Group Chat or Channel under Microsoft Teams. Click Bind A Chat (or Bind A Channel, then pick the team\'s channel) and Save. Members must be in that chat, or in that team and channel, for their messages to post; in a channel each message is a new post. Every message Nexus posts to Teams (BOD, EOD, break and ticket updates) goes out as the person and ends with a small gray "Sent by Nexus" line, so it is easy to tell apart from something typed by hand.',
        ],
      },
      {
        title: 'Fill a Week for a Group',
        steps: [
          'On Team > Schedule, open the ... menu and click Fill From Usual Hours.',
          'Pick the group in Apply to, then the Shift Type, the From and To dates and the days of the week.',
          'Click Fill Schedule. The shifts land as drafts, with a dashed border, until you share.',
        ],
      },
      {
        title: 'Place or Change One Shift',
        steps: [
          'Click an empty day on a person\'s row.',
          'Pick a Shift Type or set the start, end and unpaid break, and add a label or note. If the shift breaks a rule or clashes with time off, Check before saving says why - you can still save.',
          'Click Save. Drag a shift to move it, or Ctrl-drag to copy it.',
        ],
      },
      {
        title: 'Share the Schedule',
        steps: [
          'Click Share. The number on it counts the changes your team has not seen yet.',
          'Pick the From and To dates (and a Group if you like) and who hears about it - only people whose shifts changed, or the whole team - then click Review.',
          'Read the changes and warnings (click one to see that shift on the grid), give a Reason For Sharing With Warnings if asked, and click Share. Staff see the shifts in Workday > My Schedule.',
        ],
      },
      {
        title: 'Handle a Shift Request',
        steps: [
          'Click Requests. The number shows how many are waiting on you.',
          'Read the request: time off, a swap, an offer, an open shift or a release.',
          'Click Approve or Decline, with a note if you like.',
        ],
      },
      {
        title: 'Make a Weather Call',
        steps: [
          'When the weather watch sees major rain for a group, its deciders get a bell, and a rain icon shows on the day in Team > Schedule. Click either.',
          'Untick anyone who can still work with pay, pick the call (Cancel the Day, Delay the Start, End Early, Move the Crew or Proceed as Planned) and give the crew a reason.',
          'Click Make the Call, then Confirm. Nexus changes the shifts and tells each person by bell, email, Teams and text; the call shows who has acknowledged, with Remind the Silent and Reinstate.',
        ],
      },
    ],
    features: [
      { name: 'Contact', desc: 'Reach anyone in the company (moved here from Support on 10/13/2026): Teams chat, call or video, email (opens Outlook in a new tab), phone numbers and who they report to. Every person shows whether they are on shift (On Shift, On Break, Off Shift, Off Today, On Leave, Holiday) and their Teams status (Available, Busy, On a Call, Away, Out of Office, Offline). Three lenses on the same people - Departments (A-Z, across every company), Reporting Line, and Org Chart (the company as a tree of cards you pan and zoom). Export PDF prints the people shown as a contact sheet with the reporting line. Filter by Everyone, My Team, Department Leads, Off Today or Pinned (star a person to pin them), or by company and office; Save Contact downloads their card. HR and administrators get a Manage button that shows what is still missing (managers, titles, photos, phones).' },
      { name: 'Shifts', desc: 'Everyone: your group\'s week, with you pinned at the top and open shifts you can ask to take when your company allows it. Your own week is Workday > My Schedule.' },
      { name: 'Requests From Staff', desc: 'In Workday > Time Off > Shift Requests: ask for an open shift, swap or offer a shift to a teammate, or release one to the open pool. Each kind is off until the company turns it on, and every request goes to a manager (a release can skip approval if the company chooses).' },
      { name: 'My Availability', desc: 'Workday > My Schedule > My Availability: when you can work each weekday, one-off Dates you cannot work (or only part of), and your Preferred and Most Hours Per Week. Managers see it on the grid as a guide; it never blocks a shift.' },
      { name: 'Add', desc: 'Managers and above: one button on the Schedule for a shift, an open shift, time off or a day note. Editing opens a panel on the right so the grid stays in view.' },
      { name: 'Schedule', desc: 'The grid: one row per person, grouped by shift group, with Day, Week and Month views, Today and the arrows to move around.' },
      { name: 'Open Shifts', desc: 'A row of shifts nobody holds yet, with how many spots each needs. Staff can ask to take one.' },
      { name: 'Fill From Usual Hours', desc: 'Under the ... menu: apply one shift type to a whole group, or everyone in view, across a date range. It can skip days a person has time off.' },
      { name: 'Copy Week', desc: 'Under the ... menu: copy a range of shifts to later dates, as many times as you need, with or without notes. It can skip days a person has time off.' },
      { name: 'Clear Week', desc: 'Under the ... menu: remove every shift in a date range. Drafts are deleted; shared shifts are marked for removal until you share.' },
      { name: 'Import', desc: 'Add shifts from a spreadsheet. They come in as drafts.' },
      { name: 'Requests', desc: 'The manager\'s inbox: Time Off, Swaps, Offers and Open Shifts tabs (and Releases when releasing is on), with what still waits on a teammate. A time-off request shows the shared shifts inside it, with Approve And Remove Shifts.' },
      { name: 'Role Checklists', desc: 'Only for the head (or backup) of a department, and HR. Pick one of your department\'s roles, then Onboarding, Promotion, Offboarding or Leave or Suspension, and add the extra steps that role needs - its training, its tools (for example Intacct Training for an accounting role). They are added after the company\'s own steps whenever someone in that role starts one of those checklists. Above the role\'s steps, Baseline (folded) lists the steps every hire at the company gets first - read-only, with where they are edited - so a role only adds what it needs on top; a role step with the same title as a baseline step is flagged in orange. Copy From… copies another role\'s steps in while you build: pick the role, which checklists, and Add (a step with the same title is skipped) or Replace. Remove All Steps takes them off again. Changes reach checklists already open too, and their tasks: a new step is added (with its subtask), a changed step that is still open takes the new title, owner, timing and conditions (an owner or date someone set by hand stays), and a step taken out is marked N/A with the note Removed from the template on its date - never deleted. Steps already done stay as they were. The save says how many open checklists it updated.' },
      { name: 'Share', desc: 'Share drafts, edits and removals in a date range with the team, and choose who is told. Review lists every change and warning per person first, and Recent Shares shows earlier shares made over warnings, with their reason. Until then the team keeps seeing the last shared version.' },
      { name: 'Actuals', desc: 'Past and running shifts show what the clock recorded: a colored bar and a letter (check for On Time, L Late, E Left Early, N No-Show), or Excused for time off and holidays. Hover, or tap on a phone, for the times; View Options > Actuals hides it. A line above the grid sums the week: scheduled against worked hours, with the Late, No-Show and Left Early counts.' },
      { name: 'No-Show Alerts', desc: 'When a shared shift has started, the grace has passed and nobody has clocked in after the No-Show Alert minutes (10 by default), the manager, backup manager and the group\'s schedulers get one bell per team and day, and one email. Set it, or 0 to turn it off, in Settings > Shifts & Scheduling > Attendance.' },
      { name: 'Overtime Alert', desc: 'Off by default. With Alert managers before overtime on (Settings > Shifts & Scheduling > Overtime Alerts, per company), the manager and backup manager get one bell, from the actual punches, when someone clocked in is 30 minutes from daily overtime (California rule only) or 2 hours from 40 weekly hours. Both leads can be changed.' },
      { name: 'Rules', desc: 'Settings > Shifts & Scheduling > Rules: Minimum Rest Between Shifts (10 hours), Most Days In A Row (6), Daily Overtime After (8, California rule only), Weekly Overtime After (40, payroll week Sunday to Saturday) and Most Hours Per Week (off). They warn on the grid and at Share and never block; 0 turns one off. Sharing over a warning, approved time off or a holiday asks for a reason (on by default) that only managers see, in the shift\'s History.' },
      { name: 'History', desc: 'Open a shift to see its History: who created, edited, shared, swapped or removed it, and when. Staff see only what was shared.' },
      { name: 'Confirm Schedule', desc: 'On by default: a share asks each person to Confirm in Workday > My Schedule. The grid shows a check beside everyone who has, and the 5 Of 8 Confirmed chip lists the rest, with Nudge and Nudge Everyone.' },
      { name: 'Outlook and Other Calendars', desc: 'Off by default, per company: Add shared shifts to people\'s Outlook calendars (Settings > Shifts & Scheduling > Sharing), shown as Free or Busy. Each person can keep shifts out with In your Outlook calendar on My Schedule; turning it off takes the events back off. Subscribe in another calendar gives a private link for Google or Apple Calendar; New Link stops the old one.' },
      { name: 'Open Shifts Across Teams', desc: 'Off by default, per company: open shifts from every team in the company are offered to everyone, marked Other Team.' },
      { name: 'Weather Call', desc: 'For outdoor crews. The weather watch reads the forecast over each group\'s scheduled hours at its work site: a heads-up icon on the day, and for major rain or a National Weather Service warning a bell to the group\'s Weather Deciders and the company\'s managers. A person makes the call - Nexus never cancels work on its own. A canceled day stays on the grid, struck through, and is unpaid. Turned on per company in Settings > Shifts & Scheduling > Weather Alerts.' },
      { name: 'Discard Changes', desc: 'Under the ... menu: undo edits and removals that are not shared yet, going back to what the team sees.' },
      { name: 'Export and Print', desc: 'Download the schedule as a spreadsheet or print it.' },
      { name: 'Day Note', desc: 'A note on a day for everyone, e.g. "Inventory day - all hands".' },
      { name: 'Add Time Off', desc: 'Add time off for a person straight from the grid, approved now or left for Requests.' },
      { name: 'Shift Types and Groups', desc: 'Settings > Shifts & Scheduling: shift types (time, unpaid break, grace, days, color, code, time zone), groups of people in the order they appear on the grid, a Work Site and Weather Deciders per group, and the shift settings: what staff may request and see, the team time zone, week start, Default Grace, attendance alerts, rules, sharing and time-off reasons. A company can have its own shift settings: pick it in the Scope box, and Use the Defaults drops them.' },
    ],
    manager: {
      title: 'Who Can Do What',
      points: [
        'Everyone sees their own shifts (Workday > My Schedule) and their group\'s (Team > Shifts). The schedule itself is read-only for them.',
        'Managers and above see Schedule and Requests, and build and share schedules there.',
        'Settings > Shifts & Scheduling > Requests & Visibility (per company) decides whether staff can request open shifts, swap, offer or release shifts and request time off, and what they see of teammates. Open shifts, swaps, offers, releases and cross-team open shifts stay off until turned on.',
        'On the grid, managers see what the clock recorded; anyone else sees only the status (On Time, Late, Left Early, No-Show).',
        'Shift types, groups and shift settings are changed by administrators; an administrator limited to one company changes only that company\'s own.',
      ],
    },
    tips: [
      'A dashed border means a draft the team cannot see yet, a small corner mark an edit not shared yet, and struck through a shift removed at the next share.',
      'When someone is offboarded in People, their future shifts come off the schedule (shared ones at the next share); past shifts stay as the record.',
      'No Teams status on Contact means the Teams status permission is not granted yet - it is not an error.',
      'Scheduled hours leave out the unpaid break, so a 9:00 AM to 5:00 PM shift with a 30-minute lunch counts as 7.5 hours.',
      'Ctrl+C over a shift and Ctrl+V over a day copies it, like in Teams.',
      'Shifts became its own module on 09/29/2026 and part of Team on 10/13/2026, when your own shifts moved to Workday > My Schedule. Old Shifts and Contact Directory links still land in the right place.',
    ],
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
      'Many ways to see the same work: List, Board, Calendar, Timeline, Dashboard and Files, plus Workload for managers.',
      'Nothing is lost in email. Comments, files and history stay on the task.',
      'Automatic reminders before things are due.',
    ],
    shot: 'tasks',
    walkthroughs: [
      {
        title: 'Add a Task in One Line',
        steps: [
          'Open Tasks (it opens on Home) and click the Tasks tab, your own list.',
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
          'Change its status (Not Started, In Progress, Completed) or priority, and add a comment or file.',
          'Tick the checkbox to complete it.',
        ],
      },
      {
        title: 'See a Project Your Way',
        steps: [
          'Click the Projects tab and open a project.',
          'Switch between List, Board, Calendar, Timeline, Dashboard or Files at the top.',
          'On List or Board, group by status, priority, assignee, project or Custom (your own sections - click Add Section).',
        ],
      },
    ],
    features: [
      { name: 'Home', desc: 'Four tiles (Overdue, Due Today, This Week, In Progress) that switch the Tasks card, and the number of tasks that need you now - the same count as the dashboard. Then Tasks (grouped Today, Tomorrow, This Week, Later, with No Due Date folded away; Today, This Week or This Month picks the window), Updates (what other people did lately on tasks you are on or follow, and comments that mention you) and Bookmarks. Below them your own widgets: My Day, Week Ahead and By Priority (click a day or a bar to filter the Tasks card), Projects at Risk, Completed This Week, Teams, Team Workload and the Recycle Bin. Customize adds, removes and moves widgets (Move Up and Move Down work without a mouse).' },
      { name: 'Tasks', desc: 'Everything assigned to you across every project, with comment, attachment and subtask counts on each row. Switch between List, Board, Calendar, Dashboard, Files and Time (your logged time, a week at a time).' },
      { name: 'Projects', desc: 'Related work in one place. You see a project if it is open to the company or you were added (directly or through a team).' },
      { name: 'Portfolios', desc: 'Groups of projects, so leads can follow progress across several at once.' },
      { name: 'Teams', desc: 'Named groups of people. Attach a team to a project to give everyone access in one move.' },
      { name: 'Views', desc: 'A project shows List, Board, Calendar, Timeline, Dashboard and Files. Workload (who has how much) is for managers, in Manage > Task List.' },
      { name: 'Templates', desc: 'Save as Template (the task\'s menu) keeps a task with its subtasks and checklists, and Create > Template or Use Template builds a task or project from one in one step. Duplicate Task asks what to bring over.' },
      { name: 'Recurring Tasks', desc: 'Repeat daily, weekly, monthly, yearly, periodically (every so many days) or on a Custom rule such as the second Tuesday or the last day of the month, with an end date or a number of occurrences. Subtasks can repeat With Main Task, stay behind, or keep their own schedule.' },
      { name: 'Due Date Extensions', desc: 'The third and every later extension, or one more than a month past the first agreed date, waits for the requester or an assignee\'s manager to Approve it or Keep the old date. Until then the task keeps its date; Withdraw Request takes it back.' },
      { name: 'Subtasks', desc: 'New subtasks copy the main task\'s people, priority and fields, and each can have several assignees and its own due date. Drag the six dots to reorder them; Subtask of goes back to the main task.' },
      { name: 'Collaborators', desc: 'The Collaborators pickers list the people you share the most tasks with under Frequent, above All.' },
      { name: 'Bulk Actions', desc: 'Select rows (Ctrl, Cmd or Shift+click) to Assign, Move To, Move to Section, Set Field or Duplicate them all at once.' },
      { name: 'Time Tracking', desc: 'Start Timer or Log Time on a task to record effort (separate from the Time Clock). Each project\'s Time Tracking setting is Automatic, On or Off.' },
      { name: 'From Ticket', desc: 'A task made from a ticket links back to it (From Ticket on the task, and a From Ticket filter). The ticket\'s assignee is told when its last task is done.' },
      { name: 'Task Emails', desc: 'Routine task emails are bundled into one summary email instead of one per change. Mentions, urgent tasks and anything due today or tomorrow still arrive right away.' },
    ],
    manager: {
      title: 'Manage (Managers and Above)',
      points: [
        'The Manage button appears for Managers and above, and for anyone who holds Tasks at Owner level. Changes there affect the module for everyone.',
        'Custom Fields and Custom Statuses extend what a task holds. Scope them to the projects that need them, and tick Required for a project to make the field required there.',
        'Templates decide how new work starts. Automation Rules react to changes on their own (for example, when a task is completed).',
        'Data Quality lists every open task missing a due date, project, priority or team, editable in the same table as the Task List.',
        'Reporting and Activity Log show what happened and who did it.',
      ],
    },
    tips: [
      'Scope custom fields to a project. Left unscoped, they appear on every project in the company.',
      'Replay the Tasks tour any time from the ? Help panel > Take the Tour.',
      'Double-click a column edge in the list to fit the column to its content.',
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
    where: 'Left menu > Tickets (agents). Everyone raises tickets from Help Center.',
    access: 'Desk agents with the Tickets grant. Anyone can raise a ticket from Help Center.',
    purpose: 'Tickets is the agent side of the help desk. Requests for IT, HR, facilities, finance apps and more arrive here with the right questions already answered. Each ticket has a type, priority, SLA due time, assignee and full thread. If you only need to ask for help, use Help Center instead. You do not need this module for that.',
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
          'Set yourself as the assignee. The status moves to In Progress on its own. From then on only the assignee, managers and Global Admins can change the ticket - everyone else can still reply.',
          'Click Done. Nothing on an open ticket is saved or sent until you do.',
        ],
      },
      {
        title: 'Resolve a Ticket',
        steps: [
          'Reply in the thread. Use an Internal Note for anything the requester should not see.',
          'Click Mark Resolved and write what was done. A resolution is required to resolve or close a ticket.',
          'Click Done. Your reply, the new status and any other changes are saved together, and the requester gets one email and one Teams message about all of it. The requester is only messaged when their ticket is assigned, gets a reply (the message includes it), or is resolved or closed - other edits show in their bell only. An assignment is told by the assignees, never by whoever clicked Assign: the new assignee messages the requester that they have it, and on a reassignment the previous assignee also says who has it now.',
          'The requester confirms it (Confirm Resolution, then Done) and answers a 1 to 5 star satisfaction survey, or, while it is still Resolved, reopens it with a reason - once it is Closed it stays closed, and a problem that comes back is a new ticket. The survey result shows at the top of the Overview tab of the ticket.',
        ],
      },
      {
        title: 'Reply With a Saved Reply',
        steps: [
          'In the ticket\'s Conversation, click Saved Replies under the reply box.',
          'Search or pick a reply. Replies marked This Topic, written for this ticket\'s help topic, are listed first, and the preview already shows this ticket\'s details.',
          'Click Insert Reply. It goes into your reply for you to edit, and anything else in braces, like {order_number}, is left for you to fill in.',
          'Click Done to send it with your other changes. To add your own replies, click Manage in the Saved Replies window.',
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
      { name: 'Tiles', desc: 'Live counts for Unassigned (first - tickets nobody is working), Open, SLA Breached, Resolved and Closed. While any ticket has no owner, the Unassigned tile turns amber and says Action Required. Click one to filter the list.' },
      { name: 'SLA Clocks', desc: 'Each ticket has two deadlines, both set from its priority: a first response and a resolution. Due Date shows the exact date and time, and every hour counts, weekends included. The clock shows Paused while the ticket is Waiting for User or awaiting approval, then picks up with the time it had left.' },
      { name: 'Respond By', desc: 'Under SLA Due Date in an open ticket, Respond By shows when the first reply is due. It changes to Responded once someone on the desk replies where the requester can see it (internal notes do not count), or to Response Overdue in red if nobody did in time.' },
      { name: 'Default Assignee', desc: 'A new ticket nobody assigned can go straight to a set person, chosen first by its help topic, then by its department. The ticket history says "Assigned to ... automatically". If that person can no longer take tickets, it waits unassigned and the history flags it in amber.' },
      { name: 'Saved Replies', desc: 'Answers the desk gives again and again. Insert one into your reply, filled in with the requester\'s name, the ticket number and your name, then edit it before you click Done. Personal replies are yours; shared ones are for the whole desk.' },
      { name: 'Collaborators', desc: 'Other people pulled in to help, on the create form and in the ticket. They can open it, reply and get its updates, and each one added gets a bell. Pick a Team to add a whole group at once, or save the people you picked as a team.' },
      { name: 'Screen Recordings', desc: "Raising a ticket, the Show Us the Problem card under the description records your screen (with your voice if you like) or attaches a file. If the problem happens again later, open the ticket's Conversation and use Record Screen or Upload Attachment under the reply: the file is saved to the ticket's Attachments and a link to it goes in your reply when you click Done. Feature, service, access and change requests take files only." },
      { name: 'List, Board, Reports', desc: 'A sortable table, drag-between-columns board, or charts of volume, SLA and time spent.' },
      { name: 'Ticket Types', desc: 'Incident, Bug Report, Feature Request, Access Request and Other, each with a one-line definition in the dropdown. Each asks only its own questions.' },
      { name: 'Help With', desc: 'What the ticket is about. The choices depend on the department: IT topics for IT, maintenance topics for Construction. Some topics have a Which One? list (Microsoft - Outlook, Teams, OneDrive; Nexus - its modules) to narrow it down. Other takes a short typed answer.' },
      { name: 'Property', desc: 'A ticket for a building or site team (Construction & Maintenance, Operations, site security) can name the Asset Management property it is about. The property\'s asset manager gets one bell about it. Other teams are never asked, so an HR or Payroll ticket can never show on a property.' },
      { name: 'Vendor and Cost', desc: 'Resolving a ticket that is on a property asks for an optional vendor and cost. They go on the property\'s maintenance record and its Total Spend. A resolved or closed property ticket is part of that property\'s maintenance history, so it cannot be deleted or moved to another property until it is reopened.' },
      { name: 'Ratings', desc: 'Every confirmed ticket carries the requester\'s 1 to 5 star rating. Reports show the average.' },
      { name: 'Approvals', desc: 'Some types go to an approver before anyone can be assigned. The approver does not need Tickets access: they get a bell and an email, and click Approve or Reject on the ticket. The SLA clock is paused while it waits, and a default assignee takes it once it is approved.' },
      { name: 'Linking', desc: 'Linked Tickets ties related tickets together (blocks, blocked by, duplicate). Under Tasks, Create Task from Ticket makes a task with the ticket\'s title, description, assignee, priority and collaborators, and Link Existing adds one you already have. When the last task is done, the assignee is told the ticket may be ready to resolve.' },
      { name: 'Export', desc: 'Export the currently filtered tickets to CSV, latest comment included.' },
      { name: 'Latest Comment', desc: 'The last column shows the newest reply on each ticket: the replier\'s picture, a line of what they said, and when. Click it to open the ticket on its conversation. Internal notes show a lock and are never shown to requesters.' },
      { name: 'Status Colors', desc: 'Open is gray (the normal state of a new ticket, not an alarm), In Progress is amber, purple is waiting on someone else (Waiting for User, Waiting for Vendor, On Hold), Resolved is green, Closed is a deeper green and Reopened is red. Elsewhere, red means a missed SLA or an Urgent priority.' },
    ],
    manager: {
      title: 'Desk Leads & Admins',
      points: [
        'To Route holds new tickets waiting for an owner. To Approve holds tickets waiting on your approval.',
        'Settings > Tickets is the Ticket Manager, with tabs for Routing & Escalation (default agents, and for each company its departments - drag the grip to set the order requesters see them in, switch off any department that should not take tickets, and pick its Department Head and Default Assignee), Notifications, SLA & Ticket Types (the five ticket types - Incident, Bug Report, Feature Request, Access Request and Other - each with its label, hint and questions, switched on or off for Submit a Ticket, at least one on; SLA Target Hours (resolution) and First Response Target Hours for each priority; drag types and questions to reorder), and Help Topics (the "What do you need help with?" choices for each department and each optional Which One? list, plus a default assignee for each topic for each company - the person icon on the topic\'s row - that wins over the department\'s), Desk Access (which Tickets access level makes someone an agent or a supervisor, administrators only) and Saved Replies (the desk\'s ready-made answers - only supervisors add shared ones, and any agent keeps their own from Manage in a ticket).',
        'In Ticket Manager > Notifications, SLA breach alerts are on by default: in the bell only, one a day per person that lists their late tickets, sent to the assignee (or the desk if it is unassigned) and the department head. Due and overdue reminders are off until you switch them on. They go on Teams from the assignee\'s manager on the due date and every other business day while the ticket stays open, and after two unanswered ones the department head is copied.',
        'A default assignee must be someone on that company\'s ticket desk. Batch Create lines and scheduled maintenance tickets keep their own routing and are never assigned this way.',
        'Departments are the company\'s own list from Settings > Companies (pick the company) - the same one Tasks uses. Add, rename or delete them there; the Ticket Manager only turns each one on or off for tickets. The department head is one head for the whole of Nexus: setting it here or under Companies > the company > Departments changes the same one.',
        'Reports shows recurring issues, so you can fix the cause, not just the ticket.',
      ],
    },
    tips: [
      'Inside an open ticket, changes wait for Done. Close it without clicking Done and you are asked before they are thrown away.',
      'State and Priority can be changed straight from the list without opening the ticket.',
      'A green check at the end of a row means the ticket is resolved. To resolve one, open it and write what was done. Hover a row to follow it across a wide screen.',
      'Resolved and Closed tickets sit in a Completed section at the bottom that starts collapsed on every visit, so open work stays on top.',
      'If someone else changed a field while you were editing, Done asks first (Ticket Changed). Pick Keep Editing to look, or Save Anyway.',
    ],
  },
  {
    id: 'knowledge-base', name: 'Knowledge Base', group: 'Work', icon: 'BookOpen', view: 'sop',
    tagline: 'Every SOP, policy and guide, plus your training courses.',
    where: 'Help Center > Knowledge Base & Training',
    access: 'Everyone',
    purpose: 'The Knowledge Base is how the company does things, written down. The Playbook holds every approved SOP, manual and guide. Learn holds training courses with quizzes and certificates. Policies that need your acknowledgement ask you to read and e-sign them.',
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
          'Open Help Center and click Knowledge Base & Training. You land on the Playbook.',
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
          'Signing: a bar pinned to the top of the screen always shows how many required fields are done (click it for the list of what is left) and Finish, which turns on once every required field is filled. The yellow START / NEXT tab walks through the fields, and Finish is also under the document.',
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
      {
        title: 'Add a Signature Block',
        steps: [
          'Open a template (or a document) and go to the Insert tab.',
          'Click the pen icon (Signature Block).',
          'Pick Who Signs Here - or type a new signer, such as Manager, and click Add Signer.',
          'Add a caption if you want one (it can use variables, like For {{company_legal}}), and choose whether to include the Name and Date lines.',
          'Click Insert Signature Block. When the document is sent for signature, that signer\'s signature, name and date fields are already on the line - nobody places boxes by hand.',
        ],
      },
      {
        title: "Find a Person's HR Documents",
        steps: [
          'Open Documents > HR Records (shown to People editors only).',
          'Every document an HR packet generated is listed - offer letters, NDAs, promotion letters, separation packages - with the person, the template version it came from and where it stands (In Review, Out For Signature, Signed...).',
          'Open shows the document (the sealed, signed copy once it is signed). Documents that show pay open only with Pay & Benefits access.',
          'These records are never edited. To change the wording for future packets, click Open Template, edit it and Publish.',
        ],
      },
      {
        title: 'Publish Template Changes',
        steps: [
          'Edits to a template save as you type, but HR packets keep printing the last PUBLISHED version, so a half-finished edit never reaches a candidate.',
          'When the wording is final, click Publish Changes at the top of the template (a template that was never published shows Publish).',
          'Every HR packet that has not been sent yet switches to the new wording. Documents already out for signature never change.',
          'In the Templates list, Not Published and Unpublished Changes show which templates still need a Publish.',
          'A new template starts as a Draft: the top of the editor says Draft - Not Usable Yet with an Activate button. A Draft cannot make documents or go in an HR packet; Activate makes it Active and publishes it (v1). The Templates list shows Active And Draft together, so a new draft never disappears.',
        ],
      },
      {
        title: 'Use Variables in a Template',
        steps: [
          'A variable is a {{name}} in the text that changes per document. Insert one from Insert A Variable... on the toolbar, or browse them all with the Variables button (click or drag one onto the page). Typing {{name}} works too - Find Variables turns the text into a real variable.',
          'Built-in variables are filled by Nexus - nobody types them. The picker groups them by when they are filled: Filled From The Person (name, email, job title, address...), Filled From The Company (legal name, address, signatory...), Filled At The Offer / Hire (employment type, supervisor, offer expires, work schedule...), Filled At A Promotion (new title, effective date...), Filled At A Separation (last day...), Signers and Document (the date it is made). Custom Fields In This Template lists your own.',
          'Any other name is a custom field. Open Template Fields (the checklist icon) to set, for each one, who fills it and the type of answer: Whoever Makes The Document (typed in when a document is made), The New Hire (Intake Form) (asked on the intake form of the new hire, once however many documents print it) or HR At The Offer (asked on Make An Offer). Built-ins are listed there as Filled By Nexus, with where each comes from.',
          'Nexus guesses the type from the name: dates are Date, amounts are Currency, and ID or account numbers (PAN, GSTIN, SSN, passport, Aadhaar, license, IFSC, account, routing, ZIP, phone) are Text, never Number.',
          'The same field in two templates should mean the same thing. When another template already defines it, a new one starts from that setting and shows Same as in <that template>; if they differ, Defined Differently In <that template> has a Use The Same Setting button.',
        ],
      },
    ],
    features: [
      { name: 'Dashboard', desc: 'Shortcuts to New Document, New Template and Send for Signature, plus what is waiting.' },
      { name: 'My Documents', desc: 'Your documents in folders with tags. Edit, Duplicate, Archive, Restore or Delete.' },
      { name: 'Templates', desc: 'Reusable templates with categories, an owning department, draft or active status, and a default per type. The letterheads they print on are Settings > Branding & Email > Letterheads.' },
      { name: 'Nexus Sign', desc: 'Envelopes with statuses: Awaiting Signatures, Partially Executed, Fully Executed, Declined, Voided, Expired. Each signer shows Waiting, Notified, Viewed or Signed. Signed Time Sheets are not listed here: they open from the Time Sheet (Open Signed Copy) for the employee, the approving manager, the company HR contact, Full HR and Global Admins only.' },
      { name: 'Signing Fields', desc: 'Signature, Initials, Name, Date Signed, Text, Checkbox, Dropdown, Radio and File Upload.' },
      { name: 'Electronic Signature Consent', desc: 'Before signing, each signer reads the electronic records disclosure and agrees to sign electronically. It names the company sending the document (its legal name from Settings > Companies), and the certificate records the exact text they agreed to.' },
      { name: 'Sign on Paper', desc: 'A signer can print, sign by hand and upload a scan instead.' },
      { name: 'PDF Tools', desc: 'Open a PDF full screen to add text, draw, add shapes and save.' },
    ],
    manager: {
      title: 'Managers & Admins',
      points: [
        'Set a template as the default for its type so everyone starts from the approved version.',
        'Copy a signer\'s link or fix their name, email or access code if they cannot open it.',
        'Envelopes that show pay (offer and promotion letters) can be downloaded, have their links copied, or have a signer changed only by people with Pay & Benefits access. Everyone in HR still sees their status.',
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
          'Click the bell alert "Daily Log Ready to Review", or open the project.',
          'Read the AI summary. Click to see what the worker originally wrote.',
          'Approve it, or send it back with a note.',
        ],
      },
      {
        title: 'Publish the Weekly Report (Project Manager)',
        steps: [
          'Open Construction > Site Activity and pick the project.',
          'Under Weekly Reports, click Generate This Week.',
          'Fix any section in place, then click Publish.',
        ],
      },
    ],
    features: [
      { name: 'Project Dashboard', desc: 'Active projects with phase progress, milestones and recent activity. New Project starts one.' },
      { name: 'Site Activity', desc: 'The daily log feed across your jobsites.' },
      { name: 'Daily Logs', desc: 'Hours, crew size, notes and photos, with an AI summary. Logs filed outside the jobsite geofence are flagged (advisory only).' },
      { name: 'Weekly Reports', desc: 'On Site Activity, Generate This Week drafts a report from the approved daily logs. Edit any section (the original is one click away), download a PDF, then Publish. A published report is frozen, and later edits make a new version.' },
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
    tips: [
      'Not on any project? You will see an empty list. Ask your project manager to add you.',
      'The Logistics & Supply Chain and Equipment Status cards on the Project Dashboard are sample data for now.',
    ],
  },
  {
    id: 'operations', name: 'Operations', group: 'Modules', icon: 'Store', view: 'operations',
    tagline: 'Storage facility figures from Cubby: occupancy, collections, units, the day\'s work and market rates.',
    where: 'Left menu > Operations',
    access: 'Supervisors and above with the Operations grant',
    purpose: 'Operations shows how every storage facility is doing, read from Cubby. Nexus copies Cubby every 15 minutes and only reads it: payments, leases and tenant changes stay in Cubby, and every tenant name opens their record there. Pick All Facilities or one facility at the top, and a Period for the activity figures.',
    gains: [
      'Occupancy, rent roll, past due and move-ins across every facility in one place.',
      'Every number and chart bar opens the list behind it.',
      'Street rates compared with nearby competitors, with a suggested rate.',
      'A spreadsheet of every list, plus Cubby\'s rent roll and aged receivables.',
    ],
    walkthroughs: [
      {
        title: 'Check a Facility',
        steps: [
          'Open Operations. You land on Overview.',
          'Click a facility at the top, or keep All Facilities.',
          'Pick the Period (This Month by default) for move-ins, collections and failed payments.',
          'Click a number or a chart bar to open the list behind it.',
        ],
      },
      {
        title: 'Chase Past-Due Tenants',
        steps: [
          'Click the Collections tab.',
          'Click a bar on Past Due by Age to list the tenants in it.',
          'Click a name to open the tenant in Cubby.',
        ],
      },
      {
        title: 'Compare Rates With the Market',
        steps: [
          'Click Market Rates and pick one facility.',
          'Add the competitors you track from Nearby Storage Facilities, or click Add Competitor.',
          'Click Set Rates Page so a competitor is read every day, or use Record Rate for a rate you got by phone or drive-by.',
          'Read the Suggested rate for each unit size, and click Write Analysis for a written summary.',
        ],
      },
    ],
    features: [
      { name: 'Overview', desc: 'Units by facility, Needs Attention, rented units over time, move-ins and move-outs, and the Facility Scorecard.' },
      { name: 'Collections', desc: 'Past Due by Age, Tenants Past Due, Failed Payments (the last 31 days) and the past-due balance over time.' },
      { name: 'Units & Pricing', desc: 'Unit types by empty rent, Tenants Under Street Rate (rent-increase candidates) and Off-Market Units with the reason.' },
      { name: 'Facility Tasks', desc: 'Overlocks to place, locks to remove, open tasks and leads from Cubby, scheduled move-outs and upcoming move-ins.' },
      { name: 'Market Rates', desc: 'Our street rate by unit size against nearby competitors: market low, median and high, where we sit, and a suggested rate (the market median moved by how full we are, held to a 10% step). Competitor rates pages are read once a day.' },
      { name: 'Reports', desc: 'Download any list as a CSV, plus Cubby\'s Rent Roll and Aged Receivables. Follows the facility picker.' },
      { name: 'Find a Unit or Tenant', desc: 'The search box at the top looks across every facility.' },
      { name: 'Refresh', desc: 'Asks Cubby for a fresh copy now. The header shows when the last sync ran.' },
      { name: 'Settings', desc: 'Push to Cubby (off by default) and the Unit Rules - which unit types are mailboxes, and which records are not units at all - are Settings > Operations.' },
    ],
    manager: {
      title: 'Note',
      points: [
        'Nexus never changes Cubby. Payments, leases and tenant edits are made in Cubby.',
        'If Cubby is not connected the screen says so. The Nexus team adds the Cubby API key on the server.',
      ],
    },
    tips: ['Occupancy, rent and balances are always as of today. The Period changes only move-ins, collections and failed payments.'],
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
          'Purchase requests live in Workday now: open Workday > Purchase Requests (or click Purchase Request on the Workday Overview).',
          'Click New Purchase Request, fill in the item, quantity, reason and a reference link, then submit for approval.',
        ],
      },
    ],
    features: [
      { name: 'Browse Catalog', tour: ['Browse Catalog', 'Check Out an Item'], desc: 'Everything available to check out, with photos, filters and search.' },
      { name: 'Cart', desc: 'Collect several items and request them in one go.' },
      { name: 'My Checkouts', tour: ['My Checkouts', 'Return or Extend'], desc: 'Active, Past and Permanent tabs: what you have now, what you had, and what is assigned to you.' },
      { name: 'Checkout Stages', desc: 'Requested, Approved, Awaiting Handover, In Use, Returned. The due date counts from handover, not from the request.' },
      { name: 'Permanent Returns', desc: 'Return an assigned item normally, report it dead, report it lost, or return it for reassignment.' },
      { name: 'To Hand Over', desc: 'For allocators: items waiting for you to hand over with a photo.' },
    ],
    manager: {
      title: 'Managers, Supervisors & Admins',
      points: [
        'Managers approve or reject checkout requests. Supervisors hand items over and confirm returns.',
        'Manage tab: Add Item, Edit Item, Import Items From CSV or Excel, Export Report, assign to a person or location, and the Recycle Bin.',
        'Who Has What shows holdings by person or location. Send Alert nudges someone about an overdue item.',
        'Activity Log records every change with who and when, and most changes can be undone.',
        'Admins set item types and custom fields in Settings > Items & Equipment.',
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
      {
        title: 'Raise Tickets for a Property',
        steps: [
          'Open the property and go to Maintenance.',
          'Click Create New Ticket for one issue, or Start Walkthrough to log several line by line. The property is filled in and cannot be changed, and only building and site teams are offered.',
          'Open Tickets lists everything still being worked at the property, including tickets raised from Help Center or Tickets for it. Closed Tickets is its maintenance history.',
          'The property stays fixed on those tickets - in Help Center and Tickets too.',
        ],
      },
      {
        title: 'Add a Resolved Ticket to the Maintenance Record',
        steps: [
          'When a ticket at your property is resolved you get a bell. Open the property > Maintenance > Needs Action.',
          'Click Add to Maintenance Record. The form is filled in from the ticket: service date, system, work performed, vendor and cost. Attach the invoice (or press Ctrl+V to paste it) and add notes.',
          'There is no status - adding it closes the ticket and it joins the Maintenance Log and Total Spend.',
          'On the original ticket you can set Next Service Due and how often it repeats (one time, or every so many weeks, months or years). You are reminded 15 days before; if nobody opens the ticket by the due date, one opens automatically with the same details, and the next date is scheduled.',
          'Recurring Services shows each service: the original ticket and every ticket it opened underneath, with date and cost and a total. Edit the schedule, Stop it, or Open Ticket Now to start early.',
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
      { name: 'Site Model', desc: 'Storage properties with a model show a to-scale 3D plan with every unit, marked Leased, Vacant or Out of Service from Cubby. Find a unit, switch between Satellite and Illustrated, use See Inside and the level buttons; editors click Add Pin to mark maintenance, inspections or notes. Customer Unit Finder opens the public page customers use to find their unit.' },
      { name: 'Flag for Review', desc: 'Mark a record for a colleague to check.' },
      { name: 'Export & Trash', desc: 'Export data, and restore anything deleted from Trash.' },
      { name: 'Maintenance Tickets', desc: 'Maintenance has Needs Action (resolved tickets waiting for the asset manager), Open Tickets, Closed Tickets and Recurring Services for every ticket raised for the property and its parcels. A ticket the asset manager adds to the maintenance record joins the Maintenance Log with its vendor and cost counted in Total Spend; one closed as Duplicate or Won\'t Fix is listed under Closed Without Work. Export History CSV and the asset\'s Export CSV include them.' },
      { name: 'Follow a Ticket', desc: 'Asset Management editors and the property\'s asset manager can Follow a ticket to open it, reply and hear about updates. Viewers see a summary only.' },
    ],
    manager: {
      title: 'Asset Managers',
      points: [
        'Each property has a PM / Asset Manager who gets its reminders, and one bell (and email) for every new ticket or batch at the property.',
        'Link a property to another (for example, a parcel to its project).',
      ],
    },
    tips: [
      'The Warranties Expiring widget on the Dashboard counts warranties ending within 60 days.',
      'The Customer Unit Finder link needs no sign-in, so it can be shared with customers.',
    ],
  },
  {
    id: 'accounting', name: 'Accounting', group: 'Modules', icon: 'Calculator', view: 'accounting',
    tagline: 'The finance module: dashboard, reports, loans, budgets, recurring income and expenses, and the accounting tools.',
    where: 'Left menu > Accounting',
    access: 'Supervisors and above with the Accounting grant. PFS is its own grant (Personal Financial Statements), and the Access tab can limit a person to certain entities.',
    purpose: 'Accounting is the Nexus face of the finance dashboard. It reads the company ledger (a mirror of Sage Intacct, which stays the source of truth and is never written to from here). Use it to watch cash and performance, run the month-end close, pull and send reports, review loans, keep budgets and recurring income and expenses, ask the accountant about a line, and build import files for Intacct and QuickBooks.',
    gains: [
      'Live finance figures without logging in to Intacct.',
      'A 13-week cash forecast with scenarios.',
      'A shared close checklist so everyone knows what is done.',
      'Ask the accountant about any ledger line, right where you see it.',
      'Intacct and QuickBooks import files built in the browser, without retyping.',
    ],
    walkthroughs: [
      {
        title: 'Check the Numbers',
        steps: [
          'Open Accounting. You land on Dashboard > Overview.',
          'Open the Dashboard menu and pick Cash for the plan, scenarios and 13-week forecast.',
          'Pick Performance from the same menu for budget versus actual versus last year, with commentary.',
        ],
      },
      {
        title: 'Work the Month-End Close',
        steps: [
          'Open the Dashboard menu and pick Close.',
          'Tick checklist items as you finish them and mark reconciliations.',
          'Add a note on any unusual movement (flux).',
        ],
      },
      {
        title: 'Pull a Report',
        steps: [
          'Open the Reports menu, point at a group (Financial, Budget, Audit & Insights...) and pick a report, or open Report Center for every report.',
          'Set the period, entities, Columns and Book in the row above the statement.',
          'Click any amount to see the ledger lines behind it.',
          'Click Memorize to keep the view, or Export to send it to Excel, CSV, PDF, Email or Files.',
        ],
      },
      {
        title: 'Ask My Accountant About a Line',
        steps: [
          'Find the line with the search box at the top right, or by clicking an amount on a report.',
          'Click the question mark at the end of the line.',
          'Type the question, check the accountant and send it. They get a bell.',
          'Follow the thread on Reports > Audit & Insights > AMA. Resolve it with the account the line moved to.',
        ],
      },
      {
        title: 'Recode an AMA Line',
        steps: [
          'Open Reports > Audit & Insights > AMA. Other Side lists every account on the other side of the entry - the bank or card the money came from or went to.',
          'Type what you know in the Notes box on the line. It saves when you click away, and the bookkeeper sees it.',
          'Click Pick GL, search for the account and, if there is one, the vendor or customer. Send To Bookkeeper - the line shows Awaiting Bookkeeper.',
          'Bookkeepers (AMA Settings > Bookkeepers) pick Awaiting Bookkeeper in the Whose filter, check each one, change it or Send Back with a note.',
          'To approve, click Preview Change: Nexus reads the original entry and shows exactly what changes - the line, its account and vendor or customer before and after; amounts never change. Then Approve & Push To Intacct edits that original entry, reads it back to confirm, and the line moves to Resolved.',
          'Push Reclasses on the toolbar does a few lines at once - never more than the limit set for this server while pushes are being checked (1, then 4, then 10). Every push is logged, before and after.',
        ],
      },
      {
        title: 'Plan a New Loan',
        steps: [
          'Open Financing > Loans and click the Loan Planning tab.',
          'Enter the amount, rate, amortization and term in the Mortgage Calculator.',
          'Pick the entity to check the DSCR and see the Max Loan at the target.',
          'Click Save Planned Loan (Editors), then tick two or three to compare them.',
        ],
      },
      {
        title: 'Turn a Bank Statement Into an Intacct Import',
        steps: [
          'Open Tools > Import Hub and pick Bank Statement to Intacct.',
          'Upload the statement (CSV or Excel) and check the columns it found.',
          'Enter the cash account, offset account and entity, and look over the preview.',
          'Click Download Intacct Import, then import the file in Intacct.',
        ],
      },
    ],
    features: [
      { name: 'Overview', desc: 'Customizable widgets and role-based views.' },
      { name: 'Cash', desc: 'Cash plan, scenarios and 13-week forecast.' },
      { name: 'Performance', desc: 'Budget vs actual vs prior year, with commentary.' },
      { name: 'Close', desc: 'Close checklist, reconciliations and flux review.' },
      { name: 'Reports', desc: 'The Reports menu is grouped, each group opening to the side: Report Center (every report, Report Builder, Packages), Financial (Balance Sheet, Trial Balance on the Accrual or Cash book or both side by side, Income Statement as T12 - the last 12 full months, a column each and a Total -, YTD vs. Prior Year or This Month vs. Last Month, General Ledger, Statement of Cash Flows, Cash Position, PFS), Banking & Credit Cards (Credit Card Activity, Bank Activity), Budget (the Budget, Budget vs. Actual YTD and MTD), Payroll & People (Compensation, Payroll Summary) and Audit & Insights (Flux Analysis, MRE, MRI, AMA, Manual Journal Entries, Profitability, Management Fees). Pick the period, entities, Columns and the Intacct Book (Accrual, Cash or a user-defined book); Memorize keeps a view.' },
      { name: 'Ledger Search', desc: 'The box at the top right of every tab (except PFS) finds any posted line by vendor, customer, invoice, amount or memo. Every amount on a report opens the lines behind it.' },
      { name: 'Flux Analysis', desc: 'Lines that moved past your thresholds are flagged. The Review column says where each flagged line stands: Open (no explanation yet), Answered (an explanation is written, waiting for the reviewer) and Reviewed (a reviewer accepted the explanation with the check mark; the arrow reopens it). Mark a line Reviewed once its variance is explained. Filter by Review Status, or by Amount with =, >, <, >=, <= or Between.' },
      { name: 'Credit Card and Bank Activity', desc: 'Reports > Banking & Credit Cards: pick one credit card or bank account and see every transaction in the period - date, description, vendor, amount and a running balance that starts from the balance before the period - with the usual period, entities, book and Filters. Click any account on Overview > Account Reconciliations to open its activity already filtered.' },
      { name: 'Budget vs. Actual', desc: 'Reports > Budget: the income statement against the budget (the Intacct budget, else the one saved on the Budget page), opened Year-to-Date or Month-to-Date, with Variance $ and Variance %.' },
      { name: 'Report Builder', desc: 'Reports > Report Center > Report Builder: pick GL accounts, entities, Filters (department, vendor, customer, employee, Project-Job, item, journal), the period, Columns and the Book, add named Row Groups mapped to accounts, and Run. Compare adds vs Prior Period and vs Prior Year, each with Variance $ and Variance %. Anyone with Accounting can Save (a draft) and Publish; a published report is still seen only by you until Share With Everyone. Stop Sharing and Unpublish undo either. Export to Excel, CSV or PDF.' },
      { name: 'Packages', desc: 'A named set of memorized reports for a lender. Build PDF reads each one fresh and returns one PDF, with any add-backs printed beside the figures.' },
      { name: 'PFS', desc: 'Personal financial statements of the guarantors, for any date: Statement, Borrower(s), Affiliated Entities, History and Profile, Assets, Liabilities and Real Estate. Each file is locked: Send Code emails you a code that opens that one file for 90 minutes, the borrowers are emailed that it was opened, and every access is in the Access Log (the button beside Export, for editors): who, when, what they did and which statement.' },
      { name: 'MRI', desc: 'Monthly recurring income (leases, CAM, interest and loan payments) in Income Roll, Outstanding and Payers views. What was received is read from the ledger, never keyed. Lease Term is Annual, Month to Month or Custom, and picking the tenant fills empty contact fields from the Intacct customer.' },
      { name: 'MRE', desc: 'Monthly recurring expenses by vendor and entity, each month marked Paid, Short, Over, Missed or Upcoming against what was expected. A Variance % lets a payment close to expected still count as Paid.' },
      { name: 'AMA', desc: 'Ask My Accountant: lines parked on the AMA (suspense) account, plus questions asked on any ledger line. Filter Open, Answered, Resolved or All, and Assigned To Me or Asked By Me; a row opens the thread with Resolve (and Moved To Account) and Reopen. Other Side shows the offsetting account, Notes are typed on the line, and Pick GL sends a reclass to the bookkeeper, who alone previews it and pushes it - the push edits the original entry in Intacct.' },
      { name: 'Management Fees', desc: 'The asset management agreements: for the period picked (Year to Date, a quarter or a month), each managed entity\'s gross revenue read from the ledger and the fee it works out to, Billed YTD against Expected YTD, and the next billing. A fee is set per agreement: Greater of Percent or Monthly Minimum (the usual contract - for example 3% of gross revenue or $3,000 a month, whichever is higher, decided month by month; a new agreement starts there), a percent of revenue, a flat amount, or Percent or Flat - the percent of gross when gross is above a threshold, else a flat fee. The chip next to Calculated Fee says which rule applied (Percent, Minimum, Mixed or Flat); hover it for the months on each side. Editors use Add Agreement; Fee GL Account is searched by number or title, and Agreement opens the linked document.' },
      { name: 'Manual Journal Entries', desc: 'Reports > Audit & Insights: only the journal entries a person keyed in Intacct - not the bank-feed and rule entries the system creates - with the date, journal, entry number, entities, description, amount, who created it and who posted or last changed it, and when. A system entry a person later changed counts too and says Changed by a Person (untick Include system entries a person changed to leave them out). Filter by period, entities, Journals and user; Group by user, click a header to sort, Open shows the entry, Export. Who keyed an entry is read from Intacct itself, so a long period takes a moment.' },
      { name: 'Profitability', desc: 'Revenue, NOI, interest, depreciation, net income, debt service and cash flow after debt service per entity, against the same period a year earlier. Click a figure for the accounts behind it.' },
      { name: 'Payroll Summary', desc: 'Reports > Payroll & People (Full level, like Compensation): QuickBooks\' Payroll Summary built from the QuickBooks payroll imported into the PYRJ journal. Pick the pay dates, the entities and one, several or all employees: Gross Pay, Taxes Withheld, Deductions From Net Pay, Net Pay, Employer Taxes and Contributions and Total Payroll Cost, a column per employee and a Total (or employees as rows), Export. The check under it says whether every PYRJ line of the period is in a row and names any account that is not. A line imported without an employee is placed by its entry description ("Payroll <date> - <employee>").' },
      { name: 'Compensation', desc: 'Reports > Payroll & People: hours and gross wages per employee from Time Clock for a run of months, with totals by company and department, and payroll expense on the ledger below. Full level only, and it asks you to confirm it is you.' },
      { name: 'Financing', desc: 'Loans (every loan from the ledger with balance, principal and interest paid, debt service and DSCR), Stress Test (rate shocks per loan or across the portfolio) and Loan Planning (Mortgage Calculator, DSCR check and Planned Loans). Editors also get Intercompany and Investments here.' },
      { name: 'Budget', desc: 'Reports > Budget > Budget: one entity and year, every income statement account by month, edited in place. Start with Copy From Last Year\'s Actuals or Copy From Intacct Budget.' },
      { name: 'Records Menu', desc: 'Records holds Vendors, Customers, General Ledger Accounts (the chart of accounts - search it, Show inactive, export it), Entities (every entity with its parent) and Journals: point at Journals for APJ, GJCA, GJC, PYRJ, PEJ, PIJ, SJI, GJ and HJCA. A journal opens its lines for the period picked, with the entities, Filters, a search box, the column filters and resizable columns of the ledger lines, and Export.' },
      { name: 'Records', desc: 'Every vendor and customer from the ledger, number first. Click a row to open the record: its details, entity and status, its ledger activity (lines, totals, entities and the latest lines) and every change requested in Nexus; View All Ledger Lines opens them in Reports. Inactive records are hidden until Customize > Show Inactive. Once the full Intacct record is available, edits go to a manager for approval and show Awaiting Intacct until keyed in.' },
      { name: 'Data', desc: 'Tools > Data: reference figures the ledger does not carry (Editors and up).' },
      { name: 'Access', desc: 'Tools > Access (Full level): which entities each person reads (All Entities by default), Bring From Intacct and Last Opened. Owners also set which PFS each person sees, as Viewer or Editor.' },
      { name: 'Allocations', desc: 'Tools > Allocations: the monthly payroll allocation entry, splitting wages across entities by hours worked at each site. The Full level keeps the mapping and clicks Keep Run; a kept run downloads as an Intacct CSV or Excel.' },
      { name: 'Import Hub', desc: 'Tools > Import Hub, built in your browser: Bank Statement to Intacct, Payroll Hours to QuickBooks (approved time sheet hours as a QuickBooks IIF or an Intacct hours file) and QuickBooks Payroll to Intacct. Nothing is written to Intacct or QuickBooks.' },
    ],
    manager: {
      title: 'Editors and Full Access',
      points: [
        'Editors maintain Data, Intercompany and Investments, record close ticks, marks and flux notes, mark flux lines Reviewed, save planned loans and keep the AMA Settings (the AMA accounts and the accountant for each entity). Your name is saved with each change.',
        'The Full level opens Access, Compensation and Keep Run on Allocations.',
        'Vendor and customer change requests are decided by a manager with the Accounting grant, or anyone at the Full level.',
        'A person limited to certain entities sees only those entities, and no Dashboard, Data, Access, Allocations or Compensation.',
        'The same close ticks and notes appear in the Nexus Accounting app.',
      ],
    },
    tips: [
      'Each tab shows one section at a time. Use the section list at the top to switch.',
      'Administrators and owners are always listed on Access with every entity. An administrator role does not open PFS.',
    ],
  },
  {
    id: 'reimbursements', name: 'Reimbursements', group: 'Modules', icon: 'Receipt', view: 'myhr',
    tagline: 'Get paid back for company purchases you paid for yourself.',
    where: 'Workday > Reimbursements (the tile beside Ask HR). People > a person > Reimbursements for their history.',
    access: 'Everyone files. Whoever is picked approves (your manager unless you pick someone else). HR approves and pays, the same people who handle time sheets: your company\'s HR contact, an administrator or a Full HR grant.',
    purpose: 'When you pay for something on behalf of the company, file it with the receipt. The person you pick approves it, HR approves it and pays you back, and every step is recorded on the claim.',
    gains: [
      'One place for receipts - no more emailing photos around.',
      'You always know where your claim is and who has it.',
      'Managers and HR can open any past claim, with its receipts and history.',
    ],
    walkthroughs: [
      {
        title: 'File a Reimbursement',
        steps: [
          'Open Workday and click Reimbursements, beside Ask HR.',
          'Click New Reimbursement. Say what you bought, the category (pick Other and say what it was if none fit), the amount and its currency, when and where, and what it was for.',
          'Pick who approves it, or leave My Manager.',
          'Attach the receipts. You can paste a screenshot with Ctrl+V. No receipt yet? Send it anyway and add the receipt once you have bought it.',
          'Click Send for Approval. Your approver gets a notification.',
        ],
      },
      {
        title: 'Approve One',
        steps: [
          'Open Workday > Reimbursements and pick To Approve.',
          'Open the receipts and check the details.',
          'Approve it, or add a note and Send Back (the employee fixes it and resubmits) or Reject it.',
        ],
      },
      {
        title: 'Approve and Pay (HR)',
        steps: [
          'Open Workday > Reimbursements and pick HR. To Approve holds the claims their approver approved.',
          'Check the receipts and Approve it - it moves to To Pay. Send Back and Reject work as above.',
          'Once the money has gone out, click Mark Paid and enter the date, the method and a reference.',
        ],
      },
    ],
    features: [
      { name: 'Reimbursements (Workday)', desc: 'File one and follow it; fix and resubmit one that was sent back; add receipts later.' },
      { name: 'To Approve', desc: 'The claims waiting on you as their approver.' },
      { name: 'HR', desc: 'To Approve, To Pay and Paid, for the companies you are HR for.' },
      { name: 'Reimbursements (People profile)', desc: 'Every claim one person has filed, with receipts and the history.' },
    ],
    tips: ['A claim is never deleted. Rejected and canceled claims stay on the record.', 'Receipts open through a short private link, only for the employee, the approver, their manager and HR.'],
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
      'An onboarding and offboarding checklist for every person, with an owner and a due date on each step.',
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
          'Pick the hiring company, then the role: the list shows that company\'s own roles under its name, then Shared Roles (the ones every company uses). Other is for a role that does not exist yet: type its title and department and, on save, it becomes a real role of that company (with no access until an administrator sets it). The Hiring Setup button then shows a count until that role has hiring documents - open it and click Add Packet beside the role.',
          "Last name, personal email and phone are required on a new candidate - the interview invite and the offer go there. Expected Interview Date (five business days out to start with) is when the interview should happen; screening is due the business day before it, and the card shows it until an interview is booked.",
          "Move them through Screening, Interview, Decision and Offer as things progress - with the buttons on the card, or by dragging the card to another lane on the board. Dragging to Interview opens Schedule Interview (Interview always means a booked interview); dragging back to an earlier stage asks first; Hired is final.",
          "Hired and Rejected always show on the board. Open a rejected candidate and click Remove From Board to take them off it - anyone rejected more than 90 days ago leaves it by itself. Show Inactive lists them; Reopen brings one back.",
          "After the interview the candidate moves to Decision by themselves (End Interview, or Nexus notices the Teams meeting has ended and finds its transcript) - or click Move To Decision. Everyone who interviewed them and the head of the role's department get ONE task, Decide on <name>, and a bell. Each answers with a comment that starts with Yes or No and says why (for example \"Yes - strong on Intacct\"). Their answers show on the candidate's Overview under Interview Feedback, with who has not answered yet; every comment also goes onto the notes. The department head's Yes or No is the final call: it closes the task and tells HR.",
          "Then click Make Offer (green): Make An Offer opens (see Make an Offer below). Making an offer before the department head has said Yes asks first. The offer letter goes first; when the company and the candidate have both signed it, they are hired and their hiring packet goes out to them by itself. Reject is the red button.",
          'Only for an offer signed on paper: Mark Hired By Hand, which asks why. Nothing is sent or filed that way.',
          "Screening: when a candidate is added, the head of the role's department (the department head set under People > Companies > Departments, else the role's default manager) and everyone above them in the reporting line get a bell and ONE task, Screen <name>, assigned to all of them. It is due the business day before the interview - the expected date at first, then the interview once it is booked or moved. The resume is attached to the task, and every comment they write on the task goes straight onto the candidate's notes - so a manager needs no Hiring access. Marking the task complete means they have screened them; rejecting or hiring the candidate closes it. The company's HR contact is on the task too, so HR and the department head screen together.",
          "Notes And History on the candidate is one list, newest first: every note, every move with its note, and every interview that finished with its score - each with who and when. Anyone who can see the candidate can add a note; a note still in the box goes along with the next move you make from the card. The Interview Room shows the same notes at the top, so the interviewer reads everyone's screening notes first.",
        ],
      },
      {
        title: 'Interview a Candidate',
        steps: [
          'From Screening, click Schedule Interview: pick the date, time, who interviews, and the questionnaire (the role\'s own, or General). The interviewer list shows the role\'s department first, its lead at the top, each person with their job title. The candidate and the interviewers get a Teams invite.',
          'Interview already happened, or not needed? Skip Interview sits at the bottom left of Schedule Interview. It asks first, takes an optional note for why, and moves the candidate straight to Decision. The notes show "Interview skipped", who skipped it and the note, and Make Offer does not warn about a missing interview.',
          "Questionnaires (Settings > Hiring > Interview Questionnaires) are written under the three things an interview checks: Character, Competence and Availability. The Interview Room shows the questions grouped the same way, with everyone's notes so far at the top. The transcript and scoring tools stay folded under Transcript And Scoring until the interview is over.",
          'The Teams meeting is set to record and transcribe itself from the moment it starts - nobody needs to press Record. The round shows "Auto-recording on"; if Teams refused (a permission is missing), it says so and the interviewer records by hand.',
          'When they join, open the Interview Room: the questions are on screen, Start Interview marks it live, and you type what you want. End Interview hands the rest to Nexus and moves them to Decision. If nobody clicks End Interview, Nexus looks for the Teams transcript 15 minutes after the meeting was due to end; finding one completes the round. With no transcript (a no-show), the round stays as it was and says so.',
          'If Teams refuses Nexus (a permission or the Teams access policy is missing), the round says exactly which one instead of waiting.',
          'Nexus pulls the Teams transcript, fills the answers nobody typed, scores the round, and keeps pulling the recording until Teams publishes it (up to a few hours). Play Recording and Transcript appear on the round, on the candidate, and in the room. Pull Recording retries by hand.',
          'The candidate\'s Interviews tab lists every round as Interview 1, Interview 2 and so on, each with its recording and transcript. Once they are hired, the recording and transcript files are on their profile under Documents. Interviews belong to hiring, so the profile has no Interviews tab.',
        ],
      },
      {
        title: 'Make an Offer',
        steps: [
          "Open the candidate at the Decision stage and click Make Offer. Make An Offer opens. If no offer letter is set up for that company yet, Nexus says so and links to Settings > Hiring > Hiring Documents > Offer Letter - the offer comes first.",
          "Follow it on the Offer & Documents tab: Offer Progress shows each step with its time - prepared, checked by HR, signed by the candidate, hiring packet sent. Send Hiring Packet stays greyed out until the candidate has signed; the packet then goes out by itself.",
          "1. Who you are hiring: pick Employee (then Full-Time, Part-Time or Intern) or Contractor, and where they work. Nexus never guesses this - the same role can be either - and it decides which offer letter goes. A contractor's letter never says employment.",
          "Nexus shows the offer letter it picked for that kind of hire (for example US Employee Offer, or India Contractor Offer) and the hiring packet that will follow it. If none is set up, it says so - add one under Settings > Hiring > Hiring Documents > Offer Letter.",
          "2. The offer: their legal name, the start date, when the offer expires, the supervisor and the pay (Pay & Benefits access needed; a contractor's pay is their fee). The form asks only what the letter and the packet print - their address, the work location, the work hours - and every question the documents mark HR At The Offer (a probation period, a bonus). Answer once: the hiring packet reuses all of it.",
          "Supervisor is who the hire reports to day to day (hover the i for Reports To); they become the manager on the profile and the letter prints them. Offer Comes From is the Head of HR (the company's HR department head, else its HR contact) unless you pick the Department Head - the head of the role's department, greyed out when that department has none. The letter closes with that person's name and title, and the offer email comes from them.",
          "Click Create Offer Letter. The candidate moves to Offer and the filled-in letter opens for review. The verifier checks it and clicks Verify And Send - the candidate gets an email and signs with no Nexus login. Nobody signs an offer for the company: the candidate is its only signer (Neil, Oct 22 2026).",
          "When they have signed, they are hired: People record, pay from the start date, onboarding checklist. Their hiring packet then starts by itself: they get a second email with a link to a short form on their phone (no login), the documents fill themselves in from their answers, HR verifies them and they sign. Their profile shows Onboarding Paperwork Not Complete - hold their first paycheck - until the packet is signed; then the line leaves the profile header and stays on the Compliance tab.",
          "If they decline the offer or it expires, nothing else goes out: change what is needed and make the offer again, or reject them. If no hiring packet was set up when they signed, the offer card says so - set one up and click Start Hiring Packet there.",
        ],
      },
      {
        title: 'Set Up an Offer Letter',
        steps: [
          "Write the offer letter once in Documents > Templates with the category Offer Letter - From Word File is the quickest. One letter per kind of hire: a US employee, a US contractor, an India contractor...",
          "Mark each blank: Nexus Fills It (name, company, role, start date, pay, work location, hired as), HR At The Offer (only HR knows it, it changes per hire), or Same For Everyone. The letter needs a signature spot for the Employee only - an offer is never signed for the company, so a Company signature spot in it prints nothing.",
          "In Settings > Hiring > Hiring Documents open the Offer Letter tab, click Add Packet, set Works In (the country, and for the US the state) and Hired As (employees or contractors), then pick the letter. Nexus picks the letter from where the hire works and how they are hired, as HR answers on Make An Offer: the state's letter before the country's, employees or contractors before both, the company's own before the one for every company. A letter for another country or state is never sent.",
          "The Person is the only signer of an offer letter. HR still checks it (Verify And Send) before it goes - that is a review, not a signature.",
        ],
      },
      {
        title: 'Set Up a Hiring Packet',
        steps: [
          'First write each document once in Documents > Templates - the offer letter, the NDA, each addendum, a Job Description per role - each its own template. Use variables for whatever changes per person ({{first_name}}, {{job_title}}, {{salary}}, {{start_date}}, {{work_schedule}}...), insert a Signature Block wherever someone signs (Company, Employee...), and click Publish.',
          'Open Settings > Hiring > Hiring Documents (or Hiring Setup on the Hiring board). Pick the company, or leave All Companies to add one that every company shares. Under Hiring Packet click Add Packet.',
          'Set Works In (country, and for the US the state) and Hired As first - one packet per place and kind of hire, for example California Employee, California Contractor, India Contractor; add Texas when you start hiring there. A hiring packet must say where it applies, and two packets for the same place and kind of hire are refused. The name fills itself from the place until you type one. The same packet goes to every role hired there: each person\'s role, job description and role documents are filled in for them. Only For One Role is for the rare role that truly needs different paperwork - and it still applies only to its place.',
          'To start from a packet you already have, pick it in Copy From at the top of a new packet (the list shows each packet\'s company, type, role, who it is for and country), or click Duplicate on its row in the list. The new packet starts with the same documents, signing order, verifier, Details Form, team and role documents and Egnyte subfolder; change the Company, Role, Hired As or Works In, then save. Sign Once signatures are not copied - the company signs the new packet once.',
          'Add the documents from the template list, in order. Preview shows each one filled with a sample person; Open In Documents takes you to the wording. A template must be published to be used, and the packet always prints its published version - edit and Publish Changes in Documents, and every packet that has not been sent yet updates.',
          'Check the Signing Order. Each signer named by the signature blocks in the documents gets a step, set by ROLE: HR, Manager, Authorized Signatory, IT, Accounting... - the same roles the checklists use - with who holds it today shown beside it. The new hire signs first; the company countersigns after them - the company never signs before the person (Neil, Oct 22 2026). A step can also Approve or just Get A Copy.',
          'Pick who verifies the packet (normally HR), the letterhead for templates that need one, write the welcome note and set the Egnyte subfolder (blank uses Hiring Documents). Click Save Packet - the editor stays open on Ready To Send.',
          'Ready To Send is the packet\'s checklist, at the top of the editor and as a chip in the Packets list (Ready To Send, 2 To Fix, 1 Warning): every template published, the company has an HR contact (and a signatory if one signs), the verifier can see pay, the company has signed once, the pay prints in a document, every variable has something that fills it, and no fill-in blank is left (a ____ line, an empty [   ] or a "Label:" line with nothing after it would print empty - the warning names the document). Each line that is not done has its fix right there - pick the HR contact, Sign Once, Add To Details Form, Open Template. Start Hiring Packet shows the same problems before you generate anything.',
          'A letter that prints {{signatory}} must be signed by the Authorized Signatory (set the person in People > Companies); a letter HR signs should print {{signer.company}} instead, which always names whoever actually signs.',
          'Signs Once: tick it on a company step (HR, Authorized Signatory...) and the company signs the packet only once. Save the packet; whoever holds that role clicks Sign Once (in the packet, or on the first packet\'s review), adopts their signature and enters the one-time code emailed to them. From then on that signature goes on every packet by itself, the moment the person has signed - never before, and never at send. If someone else becomes the company\'s HR contact (or signatory), the old signature stops counting and the new person signs once before the next packet can go.',
          'Details Form (hiring packets): name, phone, address and emergency contact are always asked. Add any other field the documents need - any country: an ID number, date of birth, bank details. Each field has a label, a type (text, number, date, email, phone, yes / no, dropdown), and can be Required, Sensitive (only people with Pay & Benefits access see it, and the documents that print it) or Last 4 Only (only the last 4 characters are kept and printed, e.g. XXXX 1234). Section headings group them. When the person is hired, only their Personal Details reach their People profile: name, phone, address, emergency contact, and date of birth, gender and a national ID (Aadhaar, SSN). A bank account number with its holder, IFSC / routing number, bank name and account type becomes a bank account on Pay & Benefits. Fields are matched by their variable name or label. A Sensitive ID stays off Personal Details. A PAN (India) answer goes to the Compliance tab, where it prints on a contractor\'s invoices. Every other answer (nationality...) stays on the packet and in the signed documents, never on the profile.',
          'Each field is a variable: "PAN Number" fills {{pan_number}} - the editor shows it beside the field. Put the same variable in the template. When a document prints a variable nothing fills yet, the editor lists it with a button to add it to the form. Something the same for every hire (a client\'s name) does not belong on the form: give the variable a Default Value in the template instead.',
          "Easier: mark the variable in the template itself (From Word File, Template Fields or the variable's own editor) as The New Hire (Intake Form) - it goes on their form by itself, asked once however many documents print it, and Private keeps it to Pay & Benefits. HR At The Offer variables are asked on Make An Offer. The packet lists both under its documents.",
          "Hired As and Works In pick the packet the same way as an offer letter. Make An Offer will not send an offer when no hiring packet would follow it - set the packet up first, so a new hire is never left waiting after they sign. A company's state (Settings > Companies > the company > State) is the default for where its hires work.",
          "A role brings its own paperwork to whatever packet it is hired with (Settings > People & Access, the company picked, > Roles > a role > Hiring Documents): write its duties once under Job Description - printed wherever a document uses Role Description, so one Job Description document serves every role - and add its Role Documents, each either added to the packet or replacing one of the packet's documents (for example the role's own confidentiality agreement replacing the standard one). Role documents go with the hiring packet, never the offer letter.",
          "Added For A Team Or Role: the documents that change by team - each team's own confidentiality agreement - go here, so one packet covers every role. Pick Team (department) or Role, then the documents; they are added only for people in that team or role.",
          "What The New Hire Will Be Asked (on the Documents step) lists the whole intake form as you build the packet: Always Asked (name, phone, address, emergency contact), From The Documents (every field a template marks The New Hire (Intake Form), with the documents that print it and a Private chip) and Also Ask (Saved To Their Record, Not Printed In A Document) - the packet's own extra fields, edited right there. Each Role's Own Documents lists, for every role of the company (or the packet's one role) that has hiring documents of its own, what it adds or replaces and the questions those documents add. A detail a document prints (the emergency contact, the permanent address) is required on the form. Filled At The Offer By HR lists what Make An Offer will ask. Preview Intake Form shows exactly the page the new hire sees; nothing is sent.",
          "Where an offer letter is set up, the hiring packet is never sent at Offer: it starts by itself once the offer is signed (Make an Offer above).",
        ],
      },
      {
        title: 'Turn a Word File Into a Template',
        steps: [
          'In Documents > Templates click From Word File and drop in the .docx. Give it a name and a category (HR, or Job Description for a role) and click Read The File. Page size, tables and fonts come across as they are.',
          'Nexus lists every blank it found - empty boxes beside a label in a table, "Label:" lines, [      ] brackets, "Rs.      per month" gaps - with what it thinks fills each one: Nexus Fills It (the person\'s name, the company, the start date, the pay...), The New Hire (Intake Form) (their own details: ID numbers, bank details), Same For Everyone (type it once - a client\'s name) or Leave Blank (filled by hand, like a notary page). Most are right already - change only the ones that are wrong. The Variable column shows the {{name}} each blank becomes.',
          'Missed one? In the box under the table, type any text from the document - a blank Nexus did not catch (____) or real text that changes per hire (Hyderabad, 6:00 PM). Every place it appears is listed; untick any to keep, give it a label, pick what fills it and click Add. Each variable has one fixed source: Salary is always the pay on the offer, Company Legal Name the hiring company\'s, Start Date the offer\'s - the guessing happens only here, never when a packet goes out.',
          'It also lists every signature line with who signs it - The Person or The Company. The Date and Name lines under a signature are drawn by the signature spot itself, so they go.',
          "HR At The Offer is a fifth choice: something only HR knows that changes per hire (a probation period, a bonus) - it is asked on Make An Offer. The New Hire (Intake Form) blanks have a Private tick (ID and account numbers are ticked for you): only Pay & Benefits sees the answer. HR At The Offer blanks have a This Is Pay tick.",
          'Click Create And Publish. The template is published (v1) with every variable and signature spot in place. Preview With Sample Person shows it filled in; Open In Editor if you want to change any wording.',
          'Add it to a packet in Settings > Hiring > Hiring Documents. The packet\'s Ready To Send checklist offers to put every The New Hire (Intake Form) field on its Details Form in one click, and warns if anything is still missing.',
          'Splitting a big Word file: if parts of it are shared by many roles (an agreement, an NDA) and one part is per role (a scope of work), save them as separate Word files first and make a template from each - each role\'s packet then reuses the shared ones.',
          'Text written with Markdown bold - **Term** - prints in bold, never with the asterisks: in a .txt or .md import, when a document opens in the editor, and in every PDF and Word file Nexus makes (hiring packets included). A single or spaced-out asterisk (5 * 3) stays as written.',
        ],
      },
      {
        title: 'Start a Hiring Packet',
        steps: [
          "Where the company has an offer letter, you never start the packet by hand - it starts by itself when the offer is signed (see Make an Offer). This is for companies with no offer letter yet.",
          'Move the candidate to Offer and open them. When their company and role have a packet built from Documents, the button reads Start Hiring Packet.',
          'Pick the four things that change per person: the Role (job title), the Pay (Pay & Benefits access needed - or write it out, e.g. "$22.00 per hour plus commission"), the Timings (start and end time and the work days, or a description), and the Job Description. Add the start date and the date the offer expires, and the supervisor.',
          'Choose who fills in their details. "They Fill Them In" emails the candidate a link (no login needed) to enter their legal name, address, phone, an emergency contact and everything on the packet\'s Details Form; the documents are generated the moment they send it. "I Will" lets you type the details now.',
          'Click Send Details Link or Generate Documents. Whoever holds the Verified By role (normally HR) is asked to check the documents once they exist. Nothing goes to the candidate to sign yet.',
          'The details link works once and stops working after the offer expires. If they lost it or made a mistake, open the packet and click Send Link Again - the old link stops working.',
        ],
      },
      {
        title: 'Review And Verify a Packet',
        steps: [
          'Open the packet from the candidate (Open Review) or from the bell. You see the offer, the details, every document, the signing order with real names, and anything that stops it from going out.',
          'Preview each document - it is exactly what will be signed. A document that shows pay opens only for people with Pay & Benefits access.',
          'A detail the person left empty that a document prints is named: a standard one (the emergency contact) stops the packet until it is filled in, an optional answer shows as Prints Blank so you can fill it in or send it as is.',
          'Fix anything with Edit: the documents regenerate. The role cannot be changed here - it decides which packet goes; void the packet and start again for another role.',
          'If a template is published in Documents while the packet waits, its documents update by themselves. Documents already sent never change.',
          'Only the verifier sees Verify And Send - the person who holds the Verified By role today (change the company\'s HR contact or its HR department head and the verifier changes with it). Tick both confirmations and click Verify And Send.',
          'The candidate is emailed at once and signs first. The company countersigns after them - whoever holds the company step is emailed once the candidate has signed, and with Signs Once the company signature goes on by itself at that point. When a hiring packet is fully signed they are hired: their details land on People (Details Form answers under the profile\'s personal details - Sensitive ones stay on the packet), their pay is set from the start date, and their onboarding checklist starts.',
          'Void Packet stops a packet before it is sent - nothing reaches the candidate.',
        ],
      },
      {
        title: 'Send a Hiring Packet',
        steps: [
          'Move the candidate to Offer, open them and click Send Hiring Packet.',
          'The card says which packet will go - Nexus matches the company and the job role. Enter the job title, start date, the date the offer expires (they can review and sign through that day; after it the link stops working and the packet reads Expired), employment type, supervisor and pay; the Packet dropdown is pre-filled with the match and can be changed for this hire. Then click Review Packet. Check the documents, the signing order and the Egnyte folder; fill in anything the template still needs. Pay is typed per offer - two people hired for the same role on the same packet can be paid differently - and prints wherever the template says {{salary}}; the review warns if the letter never shows it. A packet that is already out is never edited: void it and send a new one with the new values.',
          'A former employee applying again with the same email is a rehire: the review says so, and when they sign their old People record is reactivated as Onboarding - no second record. Someone still active with that email cannot be hired again; edit their record instead.',
          'Tick the confirmation and click Send Packet. The new hire is emailed at their personal address and signs first; you countersign for the company after them - the company never signs before the person. If something is wrong, void it and send a corrected packet. A packet sent before 10/22/2026 that is still waiting for your signature shows Sign Now on the candidate card until you do.',
          'The new hire needs no Nexus login: the email carries their own signing link, they confirm a one-time code sent to the same address, and sign. The email says who signs for the company after them.',
          'The candidate card shows who has signed. Void stops a packet; after a decline, void or expiry you can send a new one. While a packet is out you cannot reject the candidate or schedule another interview round - void it first. Correcting the candidate\'s email re-sends the packet to the new address and kills the old link.',
          "When the new hire signs, Nexus adds them to People as Onboarding, sets their pay from the start date, starts the onboarding checklist and files the signed packet in their Egnyte folder (Human Resources > Employees > their name), which they see in My HR > My Documents. If Egnyte is down it retries; use Retry Filing on the candidate if it says Not Filed. If it keeps failing because the folder cannot be made (for example the company's Human Resources folders are missing in Egnyte), click File Manually and browse to a folder that exists in the Egnyte folder picker (it opens at their folder when Nexus knows it; you can also paste a path or Egnyte link and click Go To Folder), then Use This Folder - the offer letter and hiring packet are filed there together. Once signed they are not shown above the profile tabs: each is one line under Signed Paperwork on the Documents tab, with its Egnyte filing, Retry Filing and File Manually.",
          'If a signed packet could not be applied (the card says Signed, but not applied), the signatures are safe in Nexus Sign - click Retry; if it keeps failing, send the message shown to support.',
        ],
      },
      {
        title: "Promote or Change Someone's Role",
        steps: [
          'Set up the letter once in Settings > Hiring > Hiring Documents under Promotion Letter: Add Packet, upload the letter PDF (or type it), place the signature boxes for the employee and the manager (employee first), and save. A promotion letter is always countersigned: the employee signs, then their manager (or HR) - a letter with only the employee\'s signature box is not accepted. A packet can be for every role or for particular roles.',
          'Only HR (People editors who are not limited to their own team), IT Admins and Global Admins can change a role or promote someone - managers do not see Change Role or Promote; a manager asks HR. There is no approval step.',
          'In People: open the person, click Change Role and choose Role Change Without Promotion. Pick the new role, write the reason (required), and click Change Role. It takes effect right away. Their manager and the employee get a bell, and the manager sees the reason. Your own role is changed by someone else in HR or a Global Admin.',
          'In Settings > Access: pick the person and click Change Role. There is no promotion here. Pick the new role, write the reason (required), and click Change Role. It takes effect right away, the same as in People.',
          'In Settings > Roles (or a company\'s Roles), clicking Assign on a role and picking someone who already holds another role is a role change too: write the Reason For The Change (one reason for everyone picked; it is shown on their Role History) and click Assign. Someone with no role yet is assigned at once.',
          'Removing someone from a role there (the X next to their name) asks for the reason too, and logs it on their Role History as a change to No role. A role is never changed by adding or removing people as group members - Access Groups refuse job roles.',
          "A role change request sent for approval before 10/22/2026 and still waiting shows on the person's Role tab (and as an orange hourglass next to their name in the People list). HR, an IT Admin or a Global Admin approves, declines or cancels it there; a change made meanwhile cancels it. No new requests can be sent.",
          "Every change is logged under Role History on the person's Role tab in People (and their Access tab in Settings > Access): when, from what to what, the reason, who raised it and who approved it - or, for a promotion, who signed.",
          'For a promotion, choose Promotion there, or click Promote on the profile.',
          "Pick the new role, the title in the letter, the effective date (it can be in the past), their new responsibilities, their new pay (in any currency) and the reason (required - it is kept on their Role History), then click Review Letter.",
          'Check the change, the signing order and the Egnyte folder. Any time sheet already signed from that date is listed - it is flagged for review, not repriced.',
          'Tick the confirmation and click Send For Signature. The employee signs first, then their manager. Each gets an email whose button opens their signing screen in Nexus directly.',
          "When both have signed, the new role (and its access), the title and the pay take effect - the pay dated from the effective date - and the letter is filed in their Egnyte folder under Promotion Documents, where they see it in My HR > My Documents. The employee, their manager and the company's HR contact get a bell.",
          'Promotions are made in People only. The roles themselves are set up in Settings.',
        ],
      },
      {
        title: 'Offboard Someone',
        steps: [
          "Set up the separation package once in Settings > Hiring > Hiring Documents under Separation Package: Add Packet, upload the documents, place the signature boxes (the company first, the employee last), and save.",
          'Open the person in People and click Offboard.',
          'Enter their last day and why they are leaving: Voluntary Resignation, Job Abandonment (they quit without notice and stopped showing up), Termination, End Of Contract, Retirement or Death. Choose what happens to their mailbox, who gets their tasks (blank = their supervisor), and whether to export their mailbox and start the offboarding checklist. The mailbox export is only started here; once it is ready, Download .zip is on their Documents tab.',
          'Click Review. If the last day is today, their access ends as soon as you confirm and the paperwork goes to their personal email. If it is later, the paperwork goes to their work email; they keep their access through their last day and Nexus marks them Left the morning after by itself.',
          'Tick the confirmation and click Offboard Now (or Schedule Offboarding). You sign the package first; they sign last. Untick the package to offboard without documents.',
          'Leaving does what changing their status to Left always did: items returned, tasks handed over, Microsoft 365 sign-in blocked and sessions ended. If the package is still unsigned when their account closes, it moves to their personal email (add one on their profile first) so they can still sign. The signed package is filed in their Egnyte folder under Separation Documents.',
          'A scheduled offboarding shows on their profile until the day - Cancel Offboarding keeps them active and voids any paperwork still out. Voiding the package in Nexus Sign does not cancel the offboarding. If the package was declined or voided, running Offboard again replaces the scheduled one.',
        ],
      },
      {
        title: 'Approve Leave',
        steps: [
          'Click the Leave tab (or the bell alert).',
          'Open the request and click Approve or Reject.',
        ],
      },
      {
        title: 'Run an Onboarding or Offboarding Checklist',
        steps: [
          'Marking a candidate Hired starts their onboarding checklist, and a signed promotion letter starts their promotion checklist. For anyone else, open their profile, click the Checklist tab, then Start Checklist.',
          'Someone already working here with no onboarding record (full paperwork, but no picture ID on file, say): click Run Onboarding Audit on their Checklist tab, or tick several people under People With No Onboarding Record in Settings > Hiring & Onboarding, the company picked, > Checklists and click Start Audit For N People. An audit is an onboarding checklist marked Audit, dated from the day it starts (not their old start date). Every step is checked against their record at once - an ID document on file, a verified work authorization, the signed hiring packet - and what is there is ticked with that date (Marked done by Nexus: ...); the rest goes to its owners as tasks, one email per owner for the lot. Someone with an open onboarding checklist is skipped, so nothing starts twice. Download Audit Record on the checklist gives a CSV of every step, its status, who or what closed it and on what date - the proof that on that date it was all on file.',
          'Pick Onboarding, Promotion, Offboarding or Leave or Suspension. Promotion asks for the date the new role takes effect. Offboarding asks for the exit date and the exit type; start it the day notice is received.',
          'Each checklist gets ONE task in Tasks - for example Onboarding - Jane Doe - assigned to the head of the company\'s HR department, in the company\'s HR project (Settings > Hiring & Onboarding, the company picked, > Checklists > Where Checklist Tasks Go; by default the HR department\'s #General project, else one named Human Resources). Every step is a subtask of it, assigned to that step\'s owners and named with the person (Laptop Shipped - Jane Doe), so an IT or Accounting owner sees theirs on My Tasks while the task stays in the HR project; My Tasks shows a subtask\'s project and, under it, Subtask of: the task. It works both ways: completing a subtask marks that step done on the checklist, and ticking a step on the checklist completes its subtask. HR completing the whole task marks every remaining step done; when the last step is done the task completes by itself. A step given to someone else moves its subtask to them. A role with several owners shares the subtask - any of them completing it marks the step done. Changing Where Checklist Tasks Go offers Move The N Open Checklist Tasks Too, so the tasks of checklists already running follow. Checklists started before 10/23/2026 had a task per owner; the next time they update, their subtasks move under the one task and the emptied ones go to the Recycle Bin. Comments and due dates are shared too: a comment on a step shows on its subtask and one on the subtask shows on the step (with who wrote it and when), and moving the subtask\'s due date moves the step\'s.',
          'Each step shows its owner and due date. Click the circle to mark a step done, the block icon to mark it N/A with a reason, or the people icon to change the owner or date.',
          'Steps marked Auto-Ticks are marked done by Nexus itself when it sees it happen, for example a finished provisioning run or the status changing to Left.',
        ],
      },
      {
        title: 'Give a Manager Their Team in People',
        steps: [
          'Administrators: give the person the Manager tier and the People grant (through their job role or a group). Nothing else to switch on.',
          'They see only the people below them in the reporting line - their direct reports and everyone who reports to those people - set by Reports To on each profile.',
          "In People they get the team's list and five read-only profile tabs: Overview, Role, Assets, Work Mode and Work Logs. Hiring, Org Chart, Leave, Checklists, Add Person, documents and compliance are hidden.",
          "For their DIRECT reports (Reports To is the manager) there are also a read-only Pay & Benefits tab (base pay, pay history, benefits and deductions, and paystubs to open - no Edit, no uploads, and no bank accounts) and a Reimbursements tab with the claims they filed. People further down the chain do not show them.",
          "In Time they see the team's hours, time sheets (Payroll), the Action Log (punch requests and missing punches) and time off - never pay or wage figures, and no payroll files. They can fix their team's time (add a missing punch, correct a time, decide punch requests) except while a time sheet is back with the employee or finalized. Changing hours they already approved sends the time sheet back to them to approve again.",
          'HR staff who need everyone should be Global Admins (administrator and up), which is never limited.',
        ],
      },
      {
        title: 'Review and Approve Time Sheets',
        steps: [
          'Open People > Time. Time Sheets to Review lists every time sheet waiting on you once its period is over, submitted or not.',
          'Click Review All Clean to go through every time sheet with nothing flagged in one pass: look each one over (Open shows the full time sheet), tick it, and click Approve Reviewed - only the ticked ones are approved and sent to sign. Flagged ones stay in the list with a note saying why.',
          'For a flagged one, click Review, fix the hours and decide any open punch fixes - approval waits until none are pending.',
          'Click Review & Approve, or write what needs changing and click Send Back.',
          'The employee is asked to sign - the request comes from Nexus, not the manager. Their signature finalizes the period, and the signed copy files to their Egnyte folder under Timesheets & Attendance.',
          'The signed copy reads like the Time Sheet screen. Page 1 is the whole time sheet - name, company, employee code, department, period and pay rate, then every day and shift with its breaks, the weekly totals, pay rate and wages, and the hours and wage summary - fitted onto one page however many punches there are. Page 2 is the employee\'s attestation (staff whose Country or Region is the US also confirm they were provided every meal and rest break California law requires), their signature and date, and the Approval History: every step with who and when, ending with the employee\'s signature, which finalizes it. Then the Nexus Sign certificate. Notes written by a manager or HR are left off, since the employee signs it.',
          'HR only: for someone who left, or who has not signed 3 days after approval, open their time sheet and use Employee Not Signing? > Finalize Without Employee Signature, with a reason.',
          'HR and Global Admins only: Print Time Sheet (beside the totals) opens the period as a PDF to print and sign on paper instead of in Nexus Sign - for example a new hire who must be paid before their intake is finished. It works for any period and any employee, in review, finalized or locked, prints every punch, break and note, and changes nothing in Nexus.',
        ],
      },
      {
        title: 'Get Ready for Payroll',
        steps: [
          'Open People > Time > Payroll and click Run Check on Payroll Readiness.',
          'Read the chips: Ready, Need Attention (not approved, not signed, missing punches, open fixes, no pay rate), With Variance (25% or 8 hours off last period or the schedule, by default) and With Anomalies.',
          'Click Open Time Sheet on a person to fix what is wrong, then click Refresh.',
          'Export (CSV, QuickBooks IIF or Export for Intacct). If anyone is still not ready Nexus asks before downloading, but it never blocks.',
        ],
      },
      {
        title: 'Add a Bonus to a Time Sheet',
        steps: [
          'Open their time sheet in People > Time for the pay period the bonus belongs to.',
          'In the Bonus section at the bottom, write what the bonus is for and the amount, then click Add Bonus.',
          'Each bonus is its own line in the pay summary and is added to the total. It prints on the Time Sheet (and the signed copy, when added before the employee signs) and on a contractor\'s invoice.',
          'The employee is notified at once with the amount, and sees the bonus on their own Time Sheet (Workday > Time Sheet) - what it is for, who added it and when.',
          'A bonus needs no approval or signature (Neil, Oct 23): adding or removing one never sends the time sheet back to the manager and never asks the employee to sign again - an approval or signature already given still stands.',
          'A bonus cannot be added or removed on your own Time Sheet. Once a period is finalized only HR can still add or remove one, at the very end - the period stays final.',
        ],
      },
      {
        title: 'Add Time for Someone',
        steps: [
          'Open their time sheet in People > Time and click Add Time (or Add Time beside a person in the Action Log).',
          'Pick the days - each one says what it holds (Needs Out, Off - Vacation, Holiday, Locked).',
          'Set Clock In, Clock Out, Unpaid Break and Type once, or tick Different hours per day. Use Shift Hours or Use Usual Hours fills them.',
          'Write the Reason, click Preview to see what will be written, then add it. Undo takes the whole batch back.',
        ],
      },
    ],
    features: [
      { name: 'People', desc: 'The directory of every employee and contractor, with filters by company, department and status. Two tabs: Active, and Inactive for anyone marked Left or Inactive - a status change moves them there with their full record; Remove from Nexus is only for records that should not exist. The Overview shows the whole personal record, current and permanent address included.' },
      { name: 'Employee Record', desc: 'Job, reporting line, contact, emergency contact, documents with expiry dates, and history. The Compliance tab (HR only) holds right-to-work details and, for India, the PAN - shown masked, printed on a contractor\'s invoices. A contractor\'s Next Invoice Number is set once under Contractor Engagement; each invoice Nexus sends then counts up from it, and Invoice Description is the service line it prints. Reports To can be a Nexus person or an External User (listed in their own group) - a contractor or client-side lead someone answers to. Backup Manager covers the person when their manager is out and has the same rights over them as the manager: time sheets, punches, time off and approvals. It covers that person only - the people who report to them have backups of their own. Leave it on Default and it is the manager of their manager, or the HR contact of their company when there is none.' },
      { name: 'Office & Contact', desc: 'Office, mobile phone, office phone, street address, city, state, ZIP and country or region - the contact info Microsoft 365 shows in Outlook and Teams. It is kept in step both ways: edit it here (Edit on the profile) and Microsoft 365 updates when you save; a change made in the Microsoft 365 admin center comes into Nexus within 15 minutes, or straight away with Sync Now. If both sides changed the same field, the Nexus value wins. Job title and department sync the same way. Only production writes to Microsoft 365.' },
      { name: 'Hiring', desc: 'Candidates through Screening, Interview, Offer, Hired and Onboarding, with interview scores.' },
      { name: 'Org Chart', desc: 'Reporting lines as a tree of cards you pan and zoom, colored by division. Drag a card onto a manager to move someone; drop it in open space to clear their reporting line. Every card reads Name, Role, Department and Company. External Users in the toolbar (off by default, remembered on this device) adds active guests and contractors under whoever they report to, each card marked External. Everyone can see the same chart, read-only, under Team > Contact > Org Chart.' },
      { name: 'Leave', desc: 'Time-off requests, approvals and the holiday calendar. The vacation and sick policies people are assigned, the date balances count from (a default, and a company\'s own) and the time-off reasons are Settings > Time & Pay (Leave Policies, Time-Off Reasons).' },
      { name: 'Time', desc: 'Team punches, time sheets and payroll hours. The hourly time sheet reads like SwipeClock\'s, line by line: Date, Edit, In, Out, Deducted Time, Category, Total Hours, OT, Location, Pay Rate, Wage. A shift with a break reads as punch pairs, like SwipeClock - one row from the clock-in to the break, the next from the break end to the clock-out, each with its own hours - and a thin line between them gives the length and times of the break. Edit and Add sit in the same two places on every row. A punch someone entered or changed reads bold, and the In and Out times are color-banded as on SwipeClock (the key sits above the grid): green is a punch exactly as the clock took it, blue is one HR entered or changed, and a manager\'s change stays in the normal color. Hover any time for its punch history - the exact time and what it was rounded to, where it came from (mobile app, web browser or phone, with its IP address, a manager\'s entry), and who entered or changed it and when. Add Note in the toolbar leaves a note on a day (pick the day, write it; the employee does not see it). The line under the day then reads Note by employee, Note by HR and On the punches (the reasons on edited punches), one line each; the Log column at the right opens the day\'s Work Log. Edit on a row opens that shift - change the in or out time, the location or the Type, or delete the in-punch, the out-punch or both (a deleted punch comes out of the hours; the audit record keeps it with who deleted it); on the row after a break (or by clicking the break line), Edit fixes the break instead - adds its missing end, or deletes it (give a reason; its punches come off the card and the audit record keeps them). Add on a day adds time for someone, on any pay type: pick the Type - Regular, Break, Sick, Vacation or Personal - and set its start and end. A Break has to fall inside a clock-in and clock-out that day - one outside a shift is refused, never silently dropped. Sick can be part of a day, for example one hour. On an hourly card leave pays the base rate; on a fixed-salary card a leave day is deducted like an absence unless hours were also worked. Every change shows on the card at once - no reload needed, and a reload reopens the card that was open. The employee list filters by company and by department (the selects above it show when there is more than one to choose from); the person picker follows the same filter. The Pay Period box at the top of the employee list picks the period first (the arrows, or click the dates for the list of periods); picking someone else keeps that period, so you can go through everyone for one period without picking it again. Someone who went inactive or left before the period is not on the list for it; someone who left during it stays for their last pay. A fixed-salary card is the same grid with the salaried columns - Day (Present, Absent, Half Day, Weekend, leave...), Total Hours, the day\'s Break against the 60 minute allowance, and Effect on Pay - with each break punched on its own Break row. On a fixed-salary card the Missed days line also says why each day was missed - for example Sick ×2 · Personal ×8 · Absent ×1 - from the leave entered on the day or the approved time off that covers it, and each day covered by approved time off is named on its own row (Personal, or Personal · Half Day when part of it was worked) instead of Absent. A month\'s absences never take more than the month\'s pay - a month with no work pays nothing, never less. A punch the employee asked for shows on its day as Not Yet Approved, with their reason, and Approve and Reject right there. Four tabs: Payroll, Action Log, Time Off and Invoices. Invoices lists each contractor\'s invoice, drafted when their Time Sheet is finalized - Preview the PDF, then Approve & Send emails it to the company\'s Contractor Invoice Recipients (set in Settings > Companies) with the contractor in cc. On the Time Off tab the Year and Month selects narrow the requests to the ones that fall in that period (the status counts follow), and on the Payroll tab the Only People With Missing Punches box narrows the employee list to who still has a punch to fix this period. The Action Log is one list per person of everything that stands between a time sheet and payroll - punch requests to approve or reject (tick several to decide them together) and missing punches to fix on the time sheet (Fix on Time Sheet opens the right pay period). Filter it by department, by name, or to just requests or just missing punches; you only see the people you manage. Someone still on the clock is not listed as missing a clock-out. Who is on or off today is in Team > Schedule, and screenshots and hours by location are in Workforce Analytics. Time Sheets to Review sits at the top, with its own count. In the Time Sheet, type in the person picker to filter the list to matching names, then press Enter or click one.' },
      { name: 'Company Editor', desc: 'Open a company to manage its Overview (including HR Contact and Contractor Invoice Recipients - the emails that receive a contractor\'s approved invoice, no Nexus login needed), Departments (each with an optional Department Head - the one head Nexus uses everywhere: ticket escalations, hiring screening, equipment reminders and the Contact Directory; pick it when adding the department or on its row), Locations (the clock geofences), Holiday Calendar and Workforce Analytics Policy. A location is placed one way: its Google Maps link. In Google Maps click the building so a red pin shows, click Share - Copy link, and paste it into the Google Maps Link box (coordinates copied from a right-click work too). Nexus reads the exact point of the place from the link - a link that only shows a map view is flagged - and fills in the address from the same link, written the US way (25260 N Centre City Pkwy, Escondido, CA 92026), plus the name when the link is a business and the Name is empty. If the link has no address, or you need to change it, click Enter Manually and type it. The map on the right jumps to the location; drag the pin (or click the map) onto the exact building, and a pin moved far from the link point is flagged. Set the radius in feet with the slider (330-1,000 ft suits most locations; under 330 ft, phone GPS drift flags people who are on-site). Distances everywhere read in miles and feet. In the Location Library, the Companies dropdown sets who punches in there: tick All, or tick the companies that use it. The radius slider sits under the map. Show Punches Here (off unless you turn it on) shows the last 30 days of punches as green (inside) and red (outside) dots, and warns if a change would turn punches that were on-site into Out of Location. A location marked Verify Location was placed with the old map pin: edit it and paste its Google Maps link once.' },
      { name: 'Records Audit', desc: 'Every morning Nexus checks each active person\'s record for what HR must have on file - picture ID, manager, start date, worker type, personal email, emergency contact and (in the US) verified work authorization - and for documents, work authorization and contracts past their date. A banner at the top of People lists who needs attention (click Review). The company\'s HR department head and backup get one notification per company, updated until everything is fixed (else the HR contact, else the Global Admins). Turn it off under Settings > Emails & Reminders > HR & Compliance Reminders.' },
      { name: 'Checklists', desc: 'Onboarding, promotion, offboarding and leave checklists per person, on the Checklist tab of their profile. A checklist is the company\'s steps plus the extra steps of the person\'s role (Team > Role Checklists). Steps are grouped by phase, each with an owner and a due date counted from the start date, the exit date or the leave start. Business-day steps skip weekends and the company\'s holidays; a date that lands on a weekend moves to the Friday before; a step whose date has already passed when the checklist starts is due that day. When the start date on the profile changes, open dates move with it. Which steps a person gets depends on their worker type and country (an I-9 for US employees, PF for India, a W-9 for contractors; everyone, contractors and India included, gets Picture ID On File, ticked by itself once an ID document is on the Documents tab) and, for offboarding, the exit type. Owners get one bell reminder per checklist when steps are due tomorrow or overdue, and see their steps under My Checklist Steps on My HR, where they can tick them without People access. Click a step to comment on it; a step with comments stays open so the thread is in view. Change Owner lists the step\'s department head and backup first, then everyone in Nexus People. Starting an offboarding checklist changes nothing in Microsoft 365 - Left still happens from Change Status.' },
      { name: 'Checklists Overview', desc: 'People > Checklists > Overview: everyone with an open onboarding, promotion, offboarding or leave checklist in one list, most urgent first. It is only for running them - the steps are set up in Settings. Tiles count Onboarding, Promotion, Offboarding, On Leave, Steps Overdue and Waiting On You; click one to filter. Each row shows the person, the checklist and its date (for example Starts 11/02/2026 - in 12 days), progress, and the next step with its owner and due date. Click a row to open that person on their Checklist tab. People with an open checklist also show a small progress chip in the directory and next to their status on the profile - it names the checklist, not the person (Offboarding Checklist 5/26 in amber, red once steps are late), so someone who has Left reads Left with their checklist beside it; when every step is done it turns green, Offboarding Complete. Click the chip to open their Checklist tab.' },
      { name: 'Checklist From A Status Change', desc: 'Changing someone to Left or Inactive offers to start the matching checklist in the same step (ticked by default) when they do not have one yet: Left starts offboarding with the exit type you pick, Inactive starts Leave or Suspension. It counts from the effective date, or today; steps already past are due straight away.' },
      { name: 'Checklist Settings', desc: 'Settings > Hiring & Onboarding > Checklist Library holds the standard steps; pick the company in the Scope box and Checklists is that company\'s. HR, IT and Accounting steps go to the head and the backup of the department of that name (Settings > Companies, the company picked, > Departments: HR or Human Resources, IT, Accounting or Finance) - there is no separate checklist owner setting. Those three always own steps; under Departments That Own Steps on the company\'s Checklists tab you can tick any other department (Estimating, Construction...) and pick it as a step\'s owner, and its head and backup get those steps (no head or backup active, or unticked later: HR takes them) - both get the task, and either one closing it closes it (Payroll and Finance steps are Accounting\'s, Equipment is IT\'s). Manager steps go to the person\'s reports-to (no reports-to: their department head). With nobody active in the department, HR steps go to the company\'s HR contact, and anything still unowned goes to the Global Admins. Changing a head or backup moves the open steps (and their tasks) of checklists already running, except steps someone reassigned by hand. The steps for Onboarding, Promotion, Offboarding and Leave or Suspension read as plain sentences grouped by phase; click a step to edit its title, owner, timing, who it is for and how it gets marked done. The owner can always tick a step; How It Gets Marked Done also lets you pick any number of automatic conditions, and any one of them being true ticks the step by itself - for example An ID document is on file (Documents tab, not expired), Work authorization is Verified on the Compliance tab, The signed hiring packet is on file, an emergency contact on the profile, or a finished provisioning run. These check the person\'s own record, so a step ticked by Nexus says which condition did it and when (Marked done by Nexus: an ID document is on file, 10/23/2026). It ticks the moment the record changes - a signed offer or hiring packet, a finished provisioning run, an ID uploaded, a profile saved - and its task completes with it. Every role then adds its own steps. With the company picked, Hiring & Onboarding > Checklists shows Baseline Steps - the steps every hire at that company gets first, whatever the role: the Checklist Library\'s until the company makes its own copy (View And Edit, or Copy From… the library or another company) - then Who Does Each Step and the Role Checklists audit: one row per role with its Onboarding, Promotion, Offboarding and Leave steps, Baseline Only (N steps) in grey when the role adds nothing of its own (the baseline covers it, so it counts as built), or Missing in orange when there are no steps at all - click either, or Build, to build that role\'s steps right there, and tick Only Roles With Something Missing to see what is left. Open checklists update with every change (steps already done stay as they were). A role\'s own extra steps are edited in Settings > People & Access, the company picked, > Roles > a role > Checklists, or in Team > Role Checklists.' },
      { name: 'Payroll Readiness', desc: 'People > Time > Payroll: one check of a pay period before payroll runs - who is not ready, big changes against last period or the schedule, and unusual weeks, each with a one-line reason. Managers see it without pay figures. What counts as a big change or an unusual week is Settings > Time & Pay > Payroll Readiness - a default, and each company\'s own.' },
      { name: 'Retro Pay', desc: 'People > Time > Payroll, for people who can see pay (not the Manager tier): back-dated rate changes on finalized periods - hours, rate paid, rate now and the amount owed - with totals and Download CSV. Finalizing freezes each day\'s rate, so a later back-dated raise shows here instead of changing the finalized card.' },
      { name: 'California Review', desc: 'People > Time > Payroll, HR only: Run Review checks the period of each hourly employee who works in California (their work site, where they punch, or their company\'s sites) - meal breaks and waivers, 7th-day and double time, days over 16 hours, split shifts (only when the pay does not already cover the premium), reporting time, the state minimum wage (Settings > Time & Pay > California Minimum Wage) and manual time with no reason. Flags are counted by type and grouped by person, each saying what happened and what is owed; Pay Meal Premium, Already Handled, Adjust Time Sheet or Resolve with Note. A flag opens again by itself if the facts change. People whose work state is unknown are listed to set. Employees never see these flags.' },
      { name: 'Meal and Rest Premiums', desc: 'California-rule hourly staff only: Meal Premium and Rest Premium lines on the time sheet, one hour of pay at the day\'s rate. They come from the employee\'s missed-break report, or the manager clicks Add Premium; Remove asks why.' },
      { name: 'Meal Waiver', desc: 'On Pay & Benefits under Time Clock, California-rule hourly staff only: Send Waiver to Sign sends the meal period waiver in Nexus Sign; Revoke Waiver records the employee\'s written request.' },
      { name: 'Approval Delegations', desc: 'People > Leave, for HR: who covers whose approvals and when. Set one (Whose Approvals, Covered By, dates) for someone who is out and could not set it, or revoke one. Show ended and revoked lists past ones.' },
      { name: 'Work Mode', desc: 'On an employee profile: On-Site, Remote (punch from anywhere) or Hybrid (their usual locations some days, remote on others - a punch at a company location counts at that site, anywhere else counts as Remote, never Out of Location). For On-Site and Hybrid, optionally click their usual locations - any number of them. A punch inside any company location counts as at that site; their usual sites only win where two sites overlap.' },
    ],
    manager: {
      title: 'HR & Admins',
      points: [
        'Compensation (salary, pay type, bank accounts, benefits and deductions) is only visible with the People - Compensation grant. A contractor\'s PAN and GSTIN are entered under Bank Accounts on Pay, Benefits & Bank and print on their invoices - the PAN is the same one Compliance shows, so changing it in either place changes both. Approve & Send emails the invoice to the company\'s Contractor Invoice Recipients with the contractor in cc, subject "<invoice date> - <contractor> (<total>)"; the email says which month it covers (or which dates, for a bi-weekly contractor) and who approved it. HR can Approve & Send from the Invoices tab or from the Invoice card under the contractor\'s Time Sheet. Reopening a period voids an unsent invoice and its number is reused for the corrected one; a sent invoice keeps its number.',
        'The Manager tier with the People grant sees only their own team (everyone below them in Reports To), read only. Pay shows only on the Pay & Benefits tab of their DIRECT reports, read only and without bank accounts - never in Time, and the Compensation grant does not widen it. HR staff who need everyone should be Global Admins.',
        'Offboarding: start the offboarding checklist the day notice is received, hand over their tasks, set mailbox handling, then mark them Left. Left logs them out of Nexus on every device straight away and, when the mailbox is removed or shared, ends their Microsoft 365 sessions too (Outlook and Teams on their phone stop working).',
        'Changing a status asks for a reason, and every change is kept in history.',
        'Punch locations are judged punch by punch from where the punch was made: the time sheet shows the company location the person punched at, or Out of Location when they were inside none of them. Adding and mapping a new site later also corrects earlier punches made there.',
        'Nobody approves their own punch fix or punch edit - it goes to your manager, HR contact or the Global Admins, and leaves your own approval list.',
        'A person with no manager is reviewed by their company\'s HR contact; with no HR contact either, by the Global Admins.',
      ],
    },
    tips: [
      'People pickers across Nexus use this directory, so keep names and emails correct here.',
      'Time sheets: the manager clicks Review & Approve once the period is over - the employee does not have to submit first, and nothing is signed or coded by the manager. The employee then clicks Sign & Submit and signs in Nexus Sign; their signature finalizes the period, and the signed PDF logs who approved it and when. Only the employee signs.',
      'Any change after the manager approved - the employee asking for a punch fix, the manager editing - sends the time sheet back to the manager to approve again, and pulls back a copy that was out for signature. HR can change hours at any point without approval; the employee is then asked to sign the changed card. Only HR or a Global Admin can unlock a finalized period, and they must say why. While it is unlocked only HR can change it - the manager and the employee cannot. When the hours are right, HR clicks Send to the employee to Sign: the employee signs the corrected time sheet, or declines it with what is wrong (it goes back to HR). If they do neither within 3 days it is accepted as sent and finalized again. If nothing needed changing, HR clicks Re-lock (No Changes) and the signed copy stands. The manager is told when it is unlocked and when it is final again.',
      'Payroll: filter the employee list by company and department. With a company picked, QuickBooks IIF downloads the finalized time sheets of that company for the period, ready to import into QuickBooks.',
      'The out-of-fence punch email\'s Review the Punch in Nexus button opens that person\'s time sheet on the period of the punch.',
    ],
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
    id: 'business-intelligence', name: 'Insights', group: 'Modules', icon: 'InsightsChart', view: 'bi',
    tagline: 'Company-wide numbers from every module, with what needs attention first.',
    where: 'Left menu > Insights',
    access: 'Supervisors and above with the Insights grant',
    purpose: 'Insights pulls the key numbers from across Nexus onto one board, counted exactly as each module counts them. Anything past its alert level - overdue, breached, unassigned, expiring - is listed first under Needs Attention; every module then gets its own card of counts. Click a count to see who or what is behind it.',
    gains: [
      'Cross-module numbers in one place, refreshed every 30 seconds.',
      'What needs attention is at the top, worst first.',
      'Any count opens its breakdown by person or by record.',
      'Download the board or any card as CSV.',
    ],
    walkthroughs: [
      {
        title: 'Find Out Who Is Behind a Number',
        steps: [
          'Open Insights.',
          'Under Needs Attention, click a tile, or click any count on a module card.',
          'The breakdown opens: a bar per person, or the records themselves when there is no "who".',
          'Click Open (the module\'s name) to go there and act on it.',
        ],
      },
      {
        title: 'Narrow the Board',
        steps: [
          'Type in the Find a metric box to keep only matching counts.',
          'Pick Critical, Warning or Good to keep only counts at that alert level.',
          'Use Modules to hide the cards you do not read. The choice is remembered on this browser.',
        ],
      },
    ],
    features: [
      { name: 'Needs Attention', desc: 'Every critical or warning count above zero, across every module, worst first.' },
      { name: 'Module Cards', desc: 'Each module\'s counts in its alert colors, plus a breakdown bar, a 7-day attendance trend, or the hiring pipeline by stage where the module has one.' },
      { name: 'Breakdown', desc: 'Click a count to see it by person, or the records themselves.' },
      { name: 'Export', desc: 'Download the board or any card as CSV.' },
    ],
    manager: { title: 'Note', points: ['You only see numbers from modules you have access to.'] },
    tips: [],
  },
  {
    id: 'credential-vault', name: 'Credential Vault', group: 'Modules', icon: 'KeyRound', view: 'credvault',
    tagline: 'Shared company passwords, kept by their owners, opened by the people who need them.',
    where: 'Left menu > Credential Vault',
    access: 'Anyone with the Credential Vault grant. The grant is given on purpose per role; it is never part of a default bundle.',
    purpose: 'Credential Vault stores company logins so they are never shared in chat or spreadsheets. Every credential has an owner and a department. People in that department can open it; everyone else can see that it exists and ask the owner for timed access. Critical credentials are opened only by their owners and admins. Your Personal Vault is private, locked with your own password, and nobody else - admins included - can read it.',
    gains: [
      'No more passwords in email, chat or sticky notes.',
      'Every reveal, copy, share and change is logged, with who and when.',
      'Owners decide who gets in and for how long; access ends by itself.',
    ],
    walkthroughs: [
      {
        title: 'Open a Shared Password',
        steps: [
          'Open Credential Vault and find the credential - search, pick a collection tab above the list (Owned by Me, Shared With Me, Favorites), or choose a department in the Department filter.',
          'Click the row. The drawer shows the username, the masked password, the link and the notes.',
          'Click Reveal. The first time in a while you confirm it is you with a code by text or email; after that the header says "Verified until" and reveals are instant.',
          'Click Copy. Copies are logged, like reveals.',
        ],
      },
      {
        title: 'Ask for a Password You Cannot Open',
        steps: [
          'Rows marked Request Access belong to another department or are Critical.',
          'Open the row, click Request Access and choose how long you need it.',
          'The owner (or an admin) approves it on the Approvals tab. You get a bell notification, and the password shows in your drawer until the time runs out.',
        ],
      },
      {
        title: 'Share a Password You Own',
        steps: [
          'Open the credential and click Share in the Access section.',
          'Pick the person and a duration. They see it in their own Credential Vault for that long.',
          'The Access section lists who has it and until when; End Access cuts it short.',
        ],
      },
      {
        title: 'Save Your Own Password',
        steps: [
          'Open the Personal tab. The first time, choose a Personal Vault password.',
          'Click Add, fill in the name, username and password, then save. No one else can see it.',
          'The vault locks itself when the unlock window ends (Settings > Security), or when you click Lock Now.',
        ],
      },
    ],
    features: [
      { name: 'Collections', desc: 'All Credentials, Owned by Me, Shared With Me, Favorites, Needs Attention and Trash, as tabs above the list. The Department, Type and Tier filters narrow it further.' },
      { name: 'Drawer', desc: 'Everything about one credential: sign-in, link, notes, rotation, expiry, who has access, and its history.' },
      { name: 'Access by Department', desc: 'Your department opens its own credentials; everyone else asks. Critical credentials are owner and admin only.' },
      { name: 'Timed Sharing and Requests', desc: 'Owners share for 1 hour to 7 days; others request the same way. Access ends by itself.' },
      { name: 'Rotation and Expiry Reminders', desc: 'Owners and backup owners get a bell when a rotation is due or a key is about to expire. The previous password is kept for one rotation.' },
      { name: 'Personal Vault', desc: 'Private, encrypted, locked with your own password. Reset it with a code if you forget it.' },
      { name: 'Import and Trash', desc: 'Load credentials from a CSV with Add Credential > Import From CSV; removed ones sit in the Trash until recovered or deleted for good.' },
      { name: 'Activity', desc: 'Every action, searchable by person, credential, action and date.' },
    ],
    manager: {
      title: 'Owners and Admins',
      points: [
        'The owner, the backup owner and admins edit, share, recover and hand a credential to a new owner. Set a backup owner so nothing is stranded.',
        'When someone leaves, their credentials pass to the person who inherits their tasks, their backup role is cleared and their shared access ends.',
        'Critical requests and requests for other departments are decided on the Approvals tab by the owner or an admin - either.',
      ],
    },
    tips: [
      'Star the credentials you use most; Favorites keeps them one click away.',
      'Forgot your Personal Vault password? Click Unlock, then Forgot Password. You will verify with a code first.',
    ],
  },

  // ───────────────────────────── System ─────────────────────────────
  {
    id: 'support', name: 'Help Center', group: 'System', icon: 'HelpCircle', view: 'support',
    tagline: 'Get help and learn: raise a ticket, read this guide, take your training.',
    where: 'Left menu > Help Center',
    access: 'Everyone',
    purpose: 'Help Center (Support until 10/13/2026) is where anyone goes for help or to learn. Submit a ticket to IT, HR, facilities or any other team - one ticket or a whole batch - report something broken in Nexus, and track everything you have raised. Documentation and the Knowledge Base & Training are here too. You do not need access to the Tickets module to use it.',
    gains: [
      'Help from the right team, with the right questions asked up front.',
      'Live status of everything you have raised.',
      'This Documentation (the Documentation card on Help Center), for learning any module.',
      'SOPs and your training courses, one click away.',
    ],
    shot: 'support',
    walkthroughs: [
      {
        title: 'Submit a Ticket',
        steps: [
          'Open Help Center and click Submit a Ticket.',
          'Give it a title. Requester is you - pick a colleague instead if you are raising it on their behalf.',
          'Describe the problem. Format it with the toolbar, and record your screen, upload a file or paste a screenshot with Ctrl+V right under it.',
          'Pick the department - the team that needs to help you - then what you need help with. If it is not listed, pick Other and name it in a few words. If a Which One? list appears (for example Outlook or Teams), pick the one it is about - it is optional.',
          'The type starts as Incident, which fits most problems. Change it if this is a request, a bug or something else, answer its questions, and click Create Ticket.',
        ],
      },
      {
        title: 'Batch Create Tickets',
        steps: [
          'Found several issues at once - walking a property, setting up a new office? Click Submit a Ticket, then the Batch Create tab at the top (the service desk, the Asset Management team and administrators see it; it was Property Walkthrough until 10/13/2026). From Asset Management, open the property and use Start Walkthrough instead - the property is then filled in and fixed.',
          'Pick the team. For a building or site team, a Property field appears - pick one to link every ticket to it, or leave it empty.',
          'Type the first issue and press Enter to start the next line. For each line pick what it is, the priority and a location, and take a photo or paste one with Ctrl+V.',
          'Click Create Tickets. Every line becomes its own ticket, all at once - if one line needs fixing, nothing is filed until it is. Each person involved gets one notification for the whole batch.',
          'No signal? Your lines are kept on this device. If the submit could not be confirmed, the lines lock and Try Again sends exactly the same lines - nothing is ever filed twice.',
        ],
      },
      {
        title: 'Report a Bug in Nexus',
        steps: [
          'Click Submit a Ticket and set the type to Bug Report.',
          'Describe what happened and what you expected, and paste a screenshot with Ctrl+V or record your screen.',
          'Click Create Ticket. It goes in as a bug, not a request.',
        ],
      },
      {
        title: 'Follow Up on Your Ticket',
        steps: [
          'Find it in Open Tickets (search by ticket number or title). A blue dot to the left of the row means something changed since you last opened it. Each row shows the date and time it was created and last updated, and Latest Comment shows who replied last (their picture) and what they said. Drag a column edge to resize it.',
          'Click the row to open the full thread and reply. While it is still Open, click the pencil to edit it.',
          'Sorted out already, maybe with a colleague\'s help? Click Mark Resolved, optionally say what fixed it, and the team is told.',
          'When it is resolved, click Confirm Resolution and then Done - a short survey asks how satisfied you are (1 to 5 stars, a comment is optional) and closes the ticket. Your rating then shows at the top of the Overview tab. Or click Reopen and say why.',
        ],
      },
    ],
    features: [
      { name: 'Submit a Ticket', desc: 'The same form the Tickets module uses, with routing and due dates set automatically.' },
      { name: 'Bug Report', desc: 'A ticket type in Submit a Ticket, for anything broken in Nexus itself.' },
      { name: 'On Behalf Of', desc: 'Raise a ticket for a colleague by picking them as the Requester. They get the updates; you can still see it.' },
      { name: 'Collaborators', desc: 'Add anyone else who should follow your ticket. They can open it, reply and get its updates.' },
      { name: 'Batch Create', desc: 'The second tab of Submit a Ticket: many tickets at once, one per line, for any team - with a property when a building or site team takes them.' },
      { name: 'Assistant', desc: 'The card with the question mark: opens the same help panel as the ? at the top of every page - Search for Help, Ask a Question, What\'s New in Nexus, Help with This Page and Take the Tour, plus Messages (your tickets).' },
      { name: 'Knowledge Base & Training', desc: 'Opens the Knowledge Base: every SOP and guide, and your training courses.' },
      { name: 'Legal', desc: 'The Privacy Policy and Terms & Conditions, one page with a tab each. Open it from Legal in the menu under your name (top right), or Legal in the phone menu.' },
      { name: 'Implementation Guide', desc: 'For administrators: how to set Nexus up for an organization, in 15 phases - Microsoft 365, branding, companies, job roles, people, time and pay, shifts, checklists, the modules, notifications, verification, go-live and running it after. Each phase has the decisions to make, steps with an Open button to each screen, checks that every administrator ticks off together, and pitfalls. Open it from the Implementation Guide tab at the top of Documentation.' },
      { name: 'Open Tickets', desc: 'Everything you raised that is not closed yet, with when it was last updated and the latest comment. Sort, search and page through it, or mark one Resolved yourself.' },
      { name: 'Closed Tickets', desc: 'Your finished tickets, for reference. If the same problem comes back, submit a new ticket.' },
      { name: 'Documentation', desc: 'This guide. Administrators also get an Implementation Guide tab at the top.' },
    ],
    manager: { title: 'Note', points: ['Ticket agents work the queue from the Tickets module. Help Center is the requester\'s side.'] },
    tips: ['Email and bell updates about your ticket open it right here.'],
  },
  {
    id: 'settings', name: 'Settings', group: 'System', icon: 'Settings', view: 'admin-console',
    tagline: 'Every setting for the organization or for one company, by subject, who can access what, and the audit trail.',
    where: 'Left menu > Settings',
    access: 'IT Admin and Global Admin, or anyone given the Settings grant. Each person sees only the subjects and groups they may change: a manager the ticket desk, task emails, item types, app ratings and unit rules; someone whose People access covers some companies, those companies with one picked in the Scope box.',
    purpose: 'Settings is where admins shape Nexus. One Settings tab, a list of subjects on the left (Companies, Locations, People & Access, Security, Branding & Email, Emails & Reminders, Tickets, Time & Pay, Workforce Analytics, Shifts & Scheduling, Hiring & Onboarding, Items & Equipment, Operations) and a Scope box at the top: Every company shows what applies to all, picking a company shows that company\'s own profile, departments, holiday calendar, locations, job roles, checklists and workforce analytics policy. Every setting is on the page, open - nothing to expand. Tools holds actions rather than settings, such as the Microsoft 365 sync, and Logs record every change. Act As lives in your profile menu (top right), under Tools.',
    gains: [
      'Change a setting once for the whole organization, or for just one company.',
      'Give someone exactly the access they need, in one place.',
      'A full record of who changed what.',
    ],
    shot: 'access',
    walkthroughs: [
      {
        title: 'Find and Change a Setting',
        steps: [
          'Open Settings. It opens on Companies, with the scope on Every company.',
          'Pick a subject on the left (on a phone, from the Subject list), or type in Filter Settings to search every subject.',
          'Every setting is already open: make your change and click Save, or flip the switch.',
        ],
      },
      {
        title: 'Set Up a Company',
        steps: [
          'Open Settings > Companies and click Edit on the company (or Add Company), or pick it in the Scope box at the top.',
          'Companies now shows its profile, departments and holiday calendar; Locations its sites; People & Access its roles; Hiring & Onboarding its checklists; Workforce Analytics its policy.',
          'Switch the Scope box back to Every company for the settings shared by all.',
        ],
      },
      {
        title: 'Give Someone Access to a Module',
        steps: [
          'Open Settings and click People & Access in the subject list.',
          'Pick a person.',
          'Add them to an Access Group that grants the module, or click Change Role to give them a new job role (only their company\'s roles and shared roles are offered). Write the reason - it is kept in their Role History - and the change takes effect right away.',
          'Pick the access level (Viewer, Editor, Full or Owner). Access Group and level changes save right away.',
        ],
      },
      {
        title: 'See What Someone Else Sees',
        steps: [
          'Open your profile menu (top right) and click Act As under Tools, or press A with the menu open.',
          'Type part of a name, title, company or site and pick the person (Up / Down, then Enter). Nexus shows their view, with a banner saying who you are acting as.',
          'Stop acting as them from the banner when you are done.',
        ],
      },
    ],
    features: [
      { name: 'Subjects', desc: 'Companies. Locations (the Location Library, and each company\'s sites). People & Access. Security: Sign-In & Sessions and the Sign-In Policy. Branding & Email: Brand Color, Email Appearance, Letterheads and the Email Signature templates. Emails & Reminders: Task Notifications, the Daily Briefing, the Weekly Digest, the Workforce Scorecard, HR & Compliance Reminders and Equipment Reminders. Tickets: the Ticket Manager (routing, escalation and default assignees, ticket email and alerts, SLA & Ticket Types, Help Topics, Desk Access, Saved Replies and AI Features) and the Property Rules. Time & Pay: Pay Rules (punch rounding, auto-lunch and California paid rest breaks - a default, and each company\'s own), Payroll Export Codes, Shift Differentials and Call-Back Pay, Payroll Readiness, the California Minimum Wage, Leave Policies, Time-Off Reasons and the Intacct Nightly Sync. Workforce Analytics: the App & Website Ratings, the Location Trail, and each company\'s policy. Shifts & Scheduling: Schedule Basics, Requests & Visibility, Attendance, Overtime Alerts, Rules and Sharing (each one a company can override), Shift Types, Groups and Weather Alerts. Hiring & Onboarding: Hiring Documents, Interview Questionnaires, the Checklist Library and each company\'s Checklists. Items & Equipment: Item Types & Custom Fields. Operations: Push to Cubby and the Unit Rules. The rail lists the groups of the subject on screen, a per-company setting at Every company lists the companies and where each stands, and with a company picked each subject says what is different for it.' },
      { name: 'Companies', desc: 'Every legal entity and the group manager above them all. Pick a company in the Scope box for its profile and logo, managers (Nexus People or external users) and HR contact, contractor invoice recipients, email domains, departments and holiday calendar.' },
      { name: 'Scope', desc: 'The box at the top of Settings. Every company shows what applies to all of Nexus; a company shows what is set for it alone - its profile, locations, roles, checklists and workforce analytics policy. Subjects with nothing to set for one company sit under For Every Company in the list and switch the scope back.' },
      { name: 'Company Roles', desc: 'Each company\'s job roles, grouped by its departments: the baseline set of modules, seniority tier and default approver. Roles shared across companies are listed there too, and can be moved into a company when everyone holding them works there. A role\'s Checklists tab holds the extra onboarding, promotion, offboarding and leave steps for people in that role (a shared role has a Checklists button).' },
      { name: 'People & Access', desc: 'Each person\'s effective access, Access Groups (extras on top of a job role), the roles shared by every company and the Matrix (everyone\'s access at once). With a company picked: that company\'s job roles.' },
      { name: 'Tools', desc: 'Actions rather than settings: the Microsoft 365 directory sync. Act As is in the profile menu.' },
      { name: 'Logs', desc: 'Every access and settings change, with who and when.' },
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
      'Where BOD, EOD and break messages post in Microsoft Teams is set on the job role: open the role, then under Teams Messages pick Group Chat or Channel and bind it. Everyone given the role posts there. A shift group chat is only used for people whose role sets none.',
      'Who is off today: the first BOD posted to a chat or channel each day is followed by one "Out today" post listing everyone who posts there and is on approved time off that day - the type of leave (or just "Time off" when the request is confidential), the hours of a partial day, or the date it runs through. Nothing posts on a day nobody is off.',
      'Every BOD and EOD shows where it was sent from in brackets beside the time: (Remote) for anyone set to Remote under People > Work Mode, the site name when they are at one of their allowed sites, or (Off-Site Punch) anywhere else. Someone set to Hybrid shows the site name when they are at a company location and (Remote) anywhere else. When the browser shares no location, or only a rough one, nothing is shown.',
      'Not sure which category a setting is in? Type a word like "email" or "SLA" in Filter Settings.',
      'Shift Differentials and Call-Back Pay (Time Clock > Pay Rules) is off for every company until turned on. It adds extra pay per hour at night, on weekends or at certain sites, and a minimum paid time for a call-back. Hourly staff only; a finalized time sheet keeps the rules it was finalized with.',
      'Payroll Export Codes (Time Clock > Pay Rules): the payroll item name each pay class carries in the QuickBooks IIF and the Intacct memo, per company. Leave a box blank for the default; names must match the QuickBooks payroll items, and two classes cannot share one name.',
    ],
  },
];
