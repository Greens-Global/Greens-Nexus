// Documents module guided tour - same shape and purpose as the Task, Ticket and
// Support tours (tasks/taskTourSteps.js, tickets/ticketTourSteps.js,
// views/supportTourSteps.js).
//
// Rendered by GuidedTour (components/GuidedTour.jsx) via Documents.jsx, which
// spotlights [data-tour="<target>"] and shields every click outside its
// popover, so the tour never changes real data. This file only decides WHAT to
// say and in WHICH order; each step switches to its tab first (`before`).
//
// Step shape (GuidedTour's contract):
//   target - the data-tour value to spotlight; null centers the card
//   before - run before locating the element (switch tab)
//   when   - OUR addition, filtered out here so GuidedTour never sees it

/**
 * @param {object} ctx
 * @param {(sub: string) => void} ctx.go       switch Documents tab (documents-*)
 * @param {boolean}               ctx.isMobile phone layout - the tabs are the bottom bar, not the header
 */
export function buildDocumentsTourSteps({ go, isMobile }) {
  const steps = [
    {
      target: null,
      before: () => go('documents-dashboard'),
      title: 'Welcome to Documents',
      body: 'This is where company paperwork gets made and signed - build a document from a template, send it for signature inside or outside the company, and fix up PDFs. Every signature keeps an audit trail.',
    },
    {
      target: 'module-tabs',
      before: () => go('documents-dashboard'),
      when: () => !isMobile,
      title: 'Five tabs',
      body: 'Dashboard to start from, My Documents for what you have made, Templates to make things from, Nexus Sign for anything out for signature, and PDF Tools to edit a PDF.',
    },
    {
      target: null,
      before: () => go('documents-dashboard'),
      when: () => isMobile,
      title: 'Five tabs, at the bottom',
      body: 'On your phone the tabs are the bar at the bottom of the screen: Dashboard, My Documents, Templates, Nexus Sign and PDF Tools.',
    },
    {
      target: 'documents-screen-documents-dashboard',
      before: () => go('documents-dashboard'),
      title: 'Start from the Dashboard',
      body: 'Quick actions for the three things people do most - New Document, New Template and Send for Signature. Below them, your Recent Documents and the Pending Signatures waiting on you.',
    },
    {
      target: 'documents-new-document',
      before: () => go('documents-browse'),
      title: 'My Documents',
      body: 'Everything you have made, in folders with tags, filtered by Drafts, Final and Archived. New Document starts one from a template - its merge fields fill in for you - or from a file you upload.',
    },
    {
      target: 'documents-new-template',
      before: () => go('documents-templates'),
      title: 'Templates',
      body: 'Reusable documents with categories, an owning department and a default per type, so the same letter or agreement is never written twice. Letterheads, beside them, set the logo and header a document prints with.',
    },
    {
      target: 'documents-esign-tabs',
      before: () => go('documents-esign'),
      title: 'Nexus Sign',
      body: 'Inbox is what is waiting for YOUR signature - the count shows when it is your turn. Sent Requests is everything you sent, with where each one stands: Awaiting Signatures, Partially Executed, Fully Executed, Declined.',
    },
    {
      target: 'documents-send',
      before: () => go('documents-esign'),
      title: 'Send for Signature',
      body: 'Pick a template or upload a PDF, add the people who sign - colleagues or anyone outside by email - in the order they sign, and place their fields. Each one is notified when it is their turn.',
    },
    {
      target: 'documents-screen-documents-pdf',
      before: () => go('documents-pdf'),
      title: 'PDF Tools',
      body: 'A full PDF editor in the browser - edit and sign a PDF, merge another one in, rotate or split its pages, add a watermark, compress it, and read scanned pages with OCR. It takes the whole screen; switch tabs to leave it.',
    },
    {
      target: null,
      before: () => go('documents-dashboard'),
      title: 'That is the tour',
      body: 'You will not see it again on its own. To walk through it later, open your profile menu (top right) and choose Tour while you are in Documents.',
    },
  ];
  return steps.filter((s) => !s.when || s.when()).map(({ when, ...s }) => s);   // eslint-disable-line no-unused-vars
}
