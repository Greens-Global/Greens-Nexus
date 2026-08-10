// Task module guided tour - the step list, built from what the viewer can reach.
//
// Access-based on purpose: a tour that walks somebody through a Manage screen
// they cannot open teaches them a button that is not there, which is worse than
// no tour. Steps carry a `when` predicate and are filtered before the tour runs,
// so an employee and a manager get genuinely different walkthroughs rather than
// the same one with disabled parts.
//
// Rendered by GuidedTour (components/GuidedTour.jsx), which spotlights
// [data-tour="<target>"], shields every click outside its popover so the tour
// can never change real data, and handles Escape / arrows / reflow. This file
// only decides WHAT to say and in WHICH order - matching how views/RolesAccess
// and components/PayrollTimecard already define their own steps.
//
// Step shape (GuidedTour's contract):
//   target - the data-tour value to spotlight; null centers the card
//   before - run before locating the element (switch tab, open a panel, …)
//   when   - OUR addition, filtered out here so GuidedTour never sees it

/**
 * @param {object} ctx
 * @param {(sub: string) => void} ctx.go        switch module tab
 * @param {boolean}               ctx.canManage viewer holds Manager or above
 * @param {boolean}               ctx.isMobile  phone layout (some chrome is hidden)
 */
export function buildTaskTourSteps({ go, canManage, isMobile }) {
  const steps = [
    {
      target: 'task-tabs',
      before: () => go('home'),
      title: 'Five tabs, and that is the whole module',
      body: 'Your work is in My Tasks. Work is grouped into Projects, projects into Portfolios, and people into Teams. Home is a dashboard you arrange yourself.',
    },
    {
      target: 'task-screen-home',
      before: () => go('home'),
      title: 'Home is yours to arrange',
      body: 'Widgets you pick and drag - what is due, what is urgent, what you finished. Customize adds or removes them, and the switch above changes whether they report on your day, week or month.',
    },
    {
      target: 'task-screen-mine',
      before: () => go('mine'),
      title: 'My Tasks is where you actually live',
      body: 'Everything assigned to you, across every project, in one list. Each row shows its comment, attachment and subtask counts, so you can see what has a conversation attached before opening anything.',
    },
    // The navbar Create button is hidden on phones for the screens that carry
    // their own floating + - pointing at it there would spotlight nothing.
    {
      target: 'task-create',
      before: () => go('mine'),
      when: () => !isMobile,
      title: 'Two ways to add work',
      body: 'Create opens the full form. For something you just need written down, use the one-line box at the top of a list - type a title, press Enter, and set a due date without leaving the line.',
    },
    {
      target: 'task-views',
      before: () => go('mine'),
      when: () => !isMobile,
      title: 'The same list, six ways',
      body: 'List and Board for working, Calendar and Timeline for dates, Files for every attachment at once, Workload for how it is spread across people. List and Board also group - by status, assignee or priority.',
    },
    {
      target: 'task-screen-projects',
      before: () => go('projects'),
      title: 'Projects hold related work',
      body: 'Click one to open its task list with those same six views. You see a project if it is open to the company, or if you were added to it - directly or through a team.',
    },
    {
      target: 'task-screen-teams',
      before: () => go('teams'),
      title: 'Teams save you repeating yourself',
      body: 'A named group of people. Attach a team to a project and everyone gets access in one move, and keeps it as people join or leave the team.',
    },
  ];

  // ── Manager and above ────────────────────────────────────────────────
  // Everything from here configures the module for everybody, so it is only
  // worth showing to someone who can open it.
  steps.push(
    {
      target: 'task-manage',
      before: () => go('mine'),
      when: () => canManage,
      title: 'Manage is the admin side',
      body: 'This button only appears for Managers and above. What is behind it changes the module for everyone, not just you.',
    },
    {
      target: 'task-manage-tabs',
      before: () => go('manage'),
      when: () => canManage,
      title: 'Where the module gets shaped',
      body: 'Custom Fields and Custom Statuses extend what a task can hold. Templates and Intake Forms decide how new work arrives. Automation Rules react to changes on their own. Reporting and Activity Log show what happened.',
    },
    {
      target: 'task-manage-tabs',
      before: () => go('manage'),
      when: () => canManage,
      title: 'One habit worth keeping',
      body: 'Scope custom fields and statuses to the projects that need them. Left unscoped they appear in every project in the company, which is how a board ends up with columns nobody on that project recognizes.',
    },
  );

  steps.push({
    target: 'task-tabs',
    before: () => go('home'),
    title: 'That is the tour',
    body: canManage
      ? 'Day to day you will be in My Tasks and Projects. Manage is there when the module itself needs changing. You can run this again any time from the tour button.'
      : 'Day to day you will be in My Tasks and Projects - the rest is there when you need it. You can run this again any time from the tour button.',
  });

  // `when` is ours, not GuidedTour's - strip it so the component only ever
  // receives the shape it documents.
  return steps
    .filter((s) => (typeof s.when === 'function' ? s.when() : true))
    // eslint-disable-next-line no-unused-vars
    .map(({ when, ...step }) => step);
}
