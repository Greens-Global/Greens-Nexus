// Ticket module guided tour - same shape and purpose as the Task module's
// (tasks/taskTourSteps.js): a step list built from what the viewer can
// actually reach, filtered by a `when` predicate before GuidedTour ever sees
// it, so a step never spotlights chrome that doesn't exist on this layout.
//
// Rendered by GuidedTour (components/GuidedTour.jsx) via TicketsView, which
// spotlights [data-tour="<target>"]. This file only decides WHAT to say and
// in WHICH order.
//
// Step shape (GuidedTour's contract):
//   target - the data-tour value to spotlight; null centers the card
//   before - run before locating the element (switch scope/view, …)
//   when   - OUR addition, filtered out here so GuidedTour never sees it
//
// No Manage step: the module's admin surface moved to the Admin module in
// full (Pranshu, Sep 9 2026) - there is no Manage button left in Tickets to
// point at.

/**
 * @param {object} ctx
 * @param {(k: string) => void} ctx.setQueue   open a queue tab (needs_reply / unassigned / …)
 * @param {(k: string) => void} ctx.setView    switch the List/Board/Reports view
 * @param {boolean}             ctx.isMobile   phone layout (toolbar is hidden, Create is the floating +)
 */
export function buildTicketTourSteps({ setQueue, setView, isMobile }) {
  const steps = [
    {
      target: 'ticket-scope',
      before: () => { setQueue('needs_reply'); setView('list'); },
      title: 'Every tab is a queue',
      body: 'Needs Reply is where a day starts - tickets waiting on an answer from the desk. Unassigned has nobody on it yet; Mine is what you are working. The rest are the same tickets cut other ways, and a view you save becomes a tab too.',
    },
    {
      target: 'ticket-views',
      when: () => !isMobile,
      before: () => setView('list'),
      title: 'List, Board or Reports',
      body: 'List is the sortable table you land on. Board groups the same tickets into columns you drag between. Reports charts volume, SLA performance and where time is going - useful for a desk lead, not just an individual agent.',
    },
    {
      target: 'ticket-create',
      when: () => !isMobile,
      title: 'Raising a ticket',
      body: 'Create walks you through picking a type, then only the fields that type needs. Some types route to an approver before anyone can be assigned; Facility and IT requests can attach a screen recording of the problem right from the form.',
    },
    {
      target: 'ticket-toolbar',
      when: () => !isMobile,
      title: 'Search, filter, and save the combination',
      body: 'Search checks the title, description and even the app named on the ticket. Filters narrows by status, priority, type, SLA, department, service area or assignee. More (the three dots) holds grouping, the columns you see, export and your saved views - "+ View" in the bar saves what you have on screen as a tab of its own.',
    },
    {
      target: 'ticket-body',
      before: () => setView('list'),
      title: 'Working a ticket',
      body: isMobile
        ? 'Tap a card to open the full thread, attachments and history. Search sits under the tabs, and the filter button in the bar below narrows and sorts the list. Finished tickets live under Done, out of the way.'
        : 'Click a row - or press ↓ and Enter - to open the full thread, attachments and history; Previous and Next step through the queue from inside it. Click Status / Priority right in the list to change it without opening anything. The More menu can open tickets in a side pane beside the list instead of over it. Finished tickets live under Done, out of the way.',
    },
  ];

  steps.push({
    target: 'ticket-scope',
    before: () => { setQueue('needs_reply'); setView('list'); },
    title: 'That is the tour',
    body: 'Day to day you will be in Needs Reply, Unassigned or Mine, working tickets straight from the list. You can run this again any time from the profile menu\'s Tour row.',
  });

  // `when` is ours, not GuidedTour's - strip it so the component only ever
  // receives the shape it documents.
  return steps
    .filter((s) => (typeof s.when === 'function' ? s.when() : true))
    // eslint-disable-next-line no-unused-vars
    .map(({ when, ...step }) => step);
}
