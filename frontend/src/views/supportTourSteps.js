// Support page guided tour - same shape and purpose as the Task and Ticket
// modules' own (tasks/taskTourSteps.js, tickets/ticketTourSteps.js).
//
// Rendered by GuidedTour (components/GuidedTour.jsx) via Support.jsx, which
// spotlights [data-tour="<target>"]. This file only decides WHAT to say and
// in WHICH order.
//
// No access gating here, unlike the Task/Ticket tours: Support shows the
// same five cards and the same "my tickets" table to every signed-in person
// regardless of role, so there is nothing to filter by `when`.
//
// Step shape (GuidedTour's contract):
//   target - the data-tour value to spotlight; null centers the card
//   before - run before locating the element (not needed here - one screen)

export function buildSupportTourSteps() {
  return [
    {
      target: 'support-options',
      title: 'Five shortcuts, one page',
      body: 'Everything you might need help with starts from one of these cards. The two you will use most are Submit a Ticket and Report a Bug - the rest jump to the Contact Directory, Privacy Policy and Terms.',
    },
    {
      target: 'support-submit-ticket',
      title: 'Submit a Ticket',
      body: 'Raise an IT, HR, Facility or other request - the same form the Ticket module\'s own Create button opens, so you do not need that module\'s access to use it. Pick a type, answer only the questions that type needs, and it routes to the right person and gets a due date on its own.',
    },
    {
      target: 'support-report-bug',
      title: 'Report a Bug',
      body: 'For something broken IN Nexus itself, not a request. Describe what happened and attach a screenshot or two if you have them - it goes in as its own ticket type, so whoever picks it up knows it is a bug, not a request.',
    },
    {
      target: 'support-open-tickets',
      title: 'Track what you have raised',
      body: 'Everything you have submitted shows up here with its live status - click a row to open it and see the full thread. Resolved stays listed until it is actually closed, so you can see it landed before it disappears.',
    },
    {
      target: 'support-options',
      title: 'That is the tour',
      body: 'Submit a Ticket and Report a Bug cover almost everything - the rest of this page is there for the occasional Contact Directory lookup or a policy question. You can run this again any time from the profile menu\'s Tour row.',
    },
  ];
}
