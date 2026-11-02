// The three federal onboarding forms Nexus Sign sends (Neil, 11/02/2026).
// One edition of each is built into Nexus - backend/federal_forms/registry.py
// is the truth for the edition labels; these mirror it for the packet editor's
// checkboxes and as the fallback when the status route has not answered.
// Users see "Form W-4", "Form I-9", "Direct Deposit Authorization" - never a
// vendor or a file name.
export const FEDERAL_FORMS = [
  { kind: 'w4', title: 'Form W-4', editionLabel: '2026',
    hint: 'Federal tax withholding. The employee fills it in and signs.' },
  { kind: 'i9', title: 'Form I-9', editionLabel: '01/20/25',
    hint: 'Employment eligibility. The employee completes Section 1 and signs; HR completes Section 2 after them.' },
  { kind: 'direct_deposit', title: 'Direct Deposit Authorization', editionLabel: 'v1',
    hint: 'Bank details for pay. The employee signs; the account number is kept encrypted.' },
];

export const FEDERAL_FORM_KINDS = FEDERAL_FORMS.map(f => f.kind);

/** "Form W-4 (2026)" - the title with the edition Nexus holds. */
export const federalFormLabel = (f) => `${f.title}${f.editionLabel ? ` (${f.editionLabel})` : ''}`;

/** The kinds in form order, so a saved list never depends on click order. */
export const orderFederalForms = (kinds) => FEDERAL_FORM_KINDS.filter(k => (kinds || []).includes(k));
