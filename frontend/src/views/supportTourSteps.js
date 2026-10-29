// Help Center (was Support) page guided tour - same shape and purpose as the Task and Ticket
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
      title: 'Four Shortcuts, One Page',
      body: 'Everything you might need help with or want to learn starts from one of these cards. The one you will use most is Submit a Ticket - Ask Nexus answers a question from the guides, and the others open the Documentation guide and the Knowledge Base & Training.',
    },
    {
      target: 'support-submit-ticket',
      title: 'Submit a Ticket',
      body: 'Raise an IT, HR, Facility or other request - the same form the Ticket module\'s own Create button opens, so you do not need that module\'s access to use it. It starts as an Incident (switch the type to Bug Report for something broken in Nexus itself, or to a request), you can raise it on behalf of a colleague, and it routes to the right person and gets a due date on its own.',
    },
    {
      target: 'support-documentation',
      title: 'Documentation',
      body: 'A plain-English guide to every Nexus module - what it is for, how to use it step by step, and what managers get extra. Back to Help Center returns you to these cards.',
    },
    {
      target: 'support-open-tickets',
      title: 'Track What You Have Raised',
      body: 'Open Tickets holds the tickets that are for you, with their live status - click a row to open it and see the full thread. Resolved stays here until it is closed, so you can confirm it landed or reopen it. A ticket you raised for someone else, or were added to, is under Tickets I\'m Following, and Closed Tickets keeps the history.',
    },
    {
      target: 'support-options',
      title: 'That Is the Tour',
      body: 'Submit a Ticket covers almost everything - the rest of this page is there for the occasional how-to or policy question. You can run this tour again any time from the Help panel (the "?" at the top): Take the Tour.',
    },
  ];
}
