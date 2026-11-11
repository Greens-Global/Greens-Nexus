// A template's categories (one list for the Templates screen and the
// Document Builder's "Name This Template"). Must match the server's
// _TEMPLATE_CATEGORIES in routers/documents.py.
export const TEMPLATE_CATEGORIES = [
  ['letterhead', 'Letterhead'], ['hr', 'HR'], ['legal', 'Legal'], ['finance', 'Finance'],
  ['operations', 'Operations'], ['sales', 'Sales'], ['engineering', 'Engineering'], ['general', 'General'],
  // One per role - the Job Description a hiring packet picks per hire (Oct 14).
  ['job_description', 'Job Description'],
  // The single document an offer is - one per kind of hire (Neil, Oct 14).
  ['offer_letter', 'Offer Letter'],
];
