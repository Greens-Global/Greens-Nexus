// Ticket module guided tour - same shape and purpose as the Task module's
// (tasks/taskTourSteps.js): a step list built from what the viewer can
// actually reach, filtered by a `when` predicate before GuidedTour ever sees
// it, so someone below Manager isn't shown a Manage button that isn't there.
//
// Rendered by GuidedTour (components/GuidedTour.jsx) via TicketsView, which
// spotlights [data-tour="<target>"]. This file only decides WHAT to say and
// in WHICH order.
//
// Step shape (GuidedTour's contract):
//   target - the data-tour value to spotlight; null centers the card
//   before - run before locating the element (switch scope/view, …)
//   when   - OUR addition, filtered out here so GuidedTour never sees it

/**
 * @param {object} ctx
 * @param {(k: string) => void} ctx.setScope   switch the scope tab (all/mine/assigned/…)
 * @param {(k: string) => void} ctx.setView    switch the List/Board/Reports view
 * @param {boolean}             ctx.canManage  viewer holds Manager or above
 * @param {boolean}             ctx.isMobile   phone layout (toolbar/tiles are hidden)
 */
export function buildTicketTourSteps({ setScope, setView, canManage, isMobile }) {
  const steps = [
    {
      target: 'ticket-scope',
      before: () => { setScope('all'); setView('list'); },
      title: 'Every ticket starts from these tabs',
      body: 'All shows everything you have access to. My Requests is what you raised; Assigned to Me is what you are working. To Route and To Approve only appear when there is something waiting in them, and only for the people they belong to.',
    },
    {
      target: 'ticket-views',
      when: () => !isMobile,
      before: () => setView('list'),
      title: 'List, Board or Reports',
      body: 'List is the sortable table you land on. Board groups the same tickets into columns you drag between. Reports charts volume, SLA performance and where time is going - useful for a desk lead, not just an individual agent.',
    },
    {
      target: 'ticket-tiles',
      when: () => !isMobile,
      before: () => { setScope('all'); setView('list'); },
      title: 'Five tiles, five shortcuts',
      body: 'Each one is a live count of the WHOLE queue, and clicking it filters the list to match - Open, Unassigned, SLA breached, Resolved or Closed. Unassigned and SLA breached overlap with Open on purpose, so those numbers double-count by design.',
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
      body: 'Search checks the title, description and even the app named on the ticket. Filters narrows by status, priority, type, SLA, department or service area. More saves your current filters + view as a named view, and groups the list by any of those same fields.',
    },
    {
      target: 'ticket-body',
      before: () => setView('list'),
      title: 'Working a ticket',
      body: 'Click a row to open the full thread, attachments and history - or click State/Priority right in the list to change it without opening anything. Resolved and Closed tickets collapse into their own section below so they do not crowd what is still open.',
    },
  ];

  // ── Manager and above ────────────────────────────────────────────────
  steps.push({
    target: 'ticket-manage',
    when: () => canManage && !isMobile,
    title: 'Manage is the admin side',
    body: 'Only Managers and above see this button. It configures the module itself - notification rules and desk setup - not any one ticket.',
  });

  steps.push({
    target: 'ticket-scope',
    before: () => { setScope('all'); setView('list'); },
    title: 'That is the tour',
    body: canManage
      ? 'Day to day you will be in All, My Requests or Assigned to Me, working tickets straight from the list. Manage is there when the module itself needs changing. You can run this again any time from the profile menu\'s Tour row.'
      : 'Day to day you will be in All, My Requests or Assigned to Me, working tickets straight from the list. You can run this again any time from the profile menu\'s Tour row.',
  });

  // `when` is ours, not GuidedTour's - strip it so the component only ever
  // receives the shape it documents.
  return steps
    .filter((s) => (typeof s.when === 'function' ? s.when() : true))
    // eslint-disable-next-line no-unused-vars
    .map(({ when, ...step }) => step);
}
