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
      before: () => go('documents-browse'),
      title: 'Welcome to Documents',
      body: 'This is where company paperwork gets made and signed - build a document from a template, send it for signature inside or outside the company, and fix up PDFs. Every signature keeps an audit trail.',
    },
    {
      target: 'module-tabs',
      before: () => go('documents-browse'),
      when: () => !isMobile,
      title: 'Four tabs',
      body: 'Documents is the one list of everything. Templates are what you make things from, Nexus Sign is for anything out for signature, and PDF Tools edits a PDF.',
    },
    {
      target: null,
      before: () => go('documents-browse'),
      when: () => isMobile,
      title: 'Four tabs, at the bottom',
      body: 'On your phone the tabs are the bar at the bottom of the screen: Documents, Templates, Sign and PDF Tools.',
    },
    {
      target: 'documents-screen-documents-browse',
      before: () => go('documents-browse'),
      title: 'One list, a row each',
      body: 'Every document says who it is for and where it stands. The views narrow it down: Needs Me, My Drafts, Out For Signature, Signed and your folders. Click a row and it opens beside the list with the page, who signed and who is next.',
    },
    {
      target: 'documents-new-document',
      before: () => go('documents-browse'),
      title: 'New Document',
      body: 'Start from a template - pick who it is for and its merge fields fill in for you - or from a blank page or a file you upload.',
    },
    {
      target: 'documents-new-template',
      before: () => go('documents-templates'),
      title: 'Templates',
      body: 'Reusable documents, so the same letter or agreement is never written twice. Write one as a Draft and Publish it when it is ready. Use Template makes a document from what is published; later edits wait until you publish them.',
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
      body: 'A full PDF editor in the browser - edit a PDF, merge another one in, rotate or split its pages, add a watermark, compress it, and read scanned pages with OCR. It takes the whole screen; switch tabs to leave it.',
    },
    {
      target: null,
      before: () => go('documents-browse'),
      title: 'That is the tour',
      body: 'You will not see it again on its own. To walk through it later, open your profile menu (top right) and choose Tour while you are in Documents.',
    },
  ];
  return steps.filter((s) => !s.when || s.when()).map(({ when, ...s }) => s);   // eslint-disable-line no-unused-vars
}
