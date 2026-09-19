// Template Builder (Phase 13) - merge-field type registry, shared by the
// "Define Merge Field" authoring modal and the "Generate Document" fill form.
// Mirrors backend/routers/documents.py's _FIELD_TYPES/_RESERVED_FIELD_TYPES
// (not imported - different languages) so both sides agree on what a type
// means without a network round trip to find out.

export const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'multiline', label: 'Multi-line Text' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  // Requirement 5's minimum type list. Their own types rather than "text with
  // a regex somebody remembers to set", so picking the meaning gets the
  // checking for free (requirement 19).
  { value: 'email', label: 'Email' },
  { value: 'address', label: 'Address' },
  { value: 'person', label: 'Person / Name' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Button' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'signature', label: 'Signature' },
  { value: 'initials', label: 'Initials' },
  { value: 'image', label: 'Image' },
  { value: 'file', label: 'File Attachment' },
];

export const FIELD_TYPE_LABEL = Object.fromEntries(FIELD_TYPES.map((t) => [t.value, t.label]));

// Reserved: never gets a value from the Generate-Document fill form.
// Signature/Initials are placed later by the existing, separate E-Sign
// field-placement step; Image/File real upload-at-fill-time is a documented
// fast-follow (v1 shows a placeholder in the generated document instead).
export const RESERVED_TYPES = ['signature', 'initials', 'image', 'file'];
export const OPTION_TYPES = ['dropdown', 'radio'];

// Which validation keys apply to which type - drives which validation
// sub-fields the Define Merge Field modal shows.
export const VALIDATION_KEYS = {
  text: ['maxLength', 'regex'],
  multiline: ['maxLength', 'regex'],
  number: ['min', 'max'],
  currency: ['min', 'max'],
  date: ['minDate', 'maxDate'],
  time: ['minDate', 'maxDate'],
  email: ['maxLength'],
  address: ['maxLength'],
  person: ['maxLength'],
  dropdown: [], radio: [], checkbox: [],
  signature: [], initials: [], image: [], file: [],
};

// A variable name: lowercase, dotted groups, underscores inside a segment -
// `principal.amount`, `agreement.date`. The dotted taxonomy (requirement 5.1)
// is what keeps a library of 15-60 templates legible instead of a soup of
// `amount2`/`amt_final`, and the backend validator accepts exactly this shape.
export const TOKEN_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;
export const MAX_TOKEN_LEN = 80;

export const isValidToken = (token) => {
  const t = (token || '').trim();
  return !!t && t.length <= MAX_TOKEN_LEN && TOKEN_RE.test(t);
};

// The group a variable belongs to - the part before the first dot. Undotted
// built-ins (full_name, company, today) have no group of their own.
export const tokenGroup = (token) => (String(token || '').includes('.')
  ? String(token).split('.')[0] : 'general');

// The group as a person reads it: `party_a` -> "Party A".
export const groupLabel = (group) => String(group || '')
  .split('_').filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1))
  .join(' ') || 'Other';

// Variables about the TEMPLATE itself (template.version, template.last_updated,
// template.owner_department, template.name). The system knows all of them, so
// the wizard never asks for one - mirrors is_auto_token() in
// services/merge_fields.py, and the two must stay in step.
export const AUTO_TOKEN_PREFIX = 'template.';
export const isAutoToken = (token) => String(token || '').startsWith(AUTO_TOKEN_PREFIX);

// Free text -> a legal token. A dot the author typed is KEPT, because that is
// the taxonomy; everything else becomes an underscore. Separators are then
// tidied so "Principal Amount." cannot end up as "principal_amount.".
export function slugifyToken(label) {
  return (label || '').toLowerCase().trim()
    .replace(/[^a-z0-9.]+/g, '_')
    .replace(/_*\._*/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, MAX_TOKEN_LEN) || 'field';
}

// Mirrors _EMAIL_RE in backend/routers/documents.py - the two have to agree,
// or the form accepts an address the generator then rejects.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export function isEmptyValue(type, value) {
  if (type === 'checkbox') return value !== true && value !== 'true' && value !== 'Yes';
  return value === undefined || value === null || String(value).trim() === '';
}

// The string that ends up in mergeOverrides/fillValues for a given type +
// raw fill-form value - currency/checkbox need formatting, everything else
// is already a plain string the backend's string-only resolver can use as-is.
export function formatFieldValue(def, raw) {
  if (def.type === 'currency') {
    const n = Number(raw);
    if (Number.isNaN(n)) return '';
    // Grouped, but with NO currency symbol. This used to hardcode USD, so on
    // an en-IN browser a 12,00,000 rupee salary was written into the offer
    // letter as "$12,00,000.00" - a dollar sign on a rupee figure, in a
    // document someone then signs. Which currency it is belongs to the
    // template (an offer letter carries its own compensation.currency field),
    // never to a formatting default nobody chose.
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (def.type === 'checkbox') return isEmptyValue('checkbox', raw) ? 'No' : 'Yes';
  return raw == null ? '' : String(raw);
}

// Client-side mirror of the backend's required-field guard, plus the
// character-limit/regex/min-max/date-range validation rules - used by both
// the Define Merge Field modal (validating a Default Value) and the Generate
// Document fill form.
export function validateFieldValue(def, raw) {
  const empty = isEmptyValue(def.type, raw);
  if (def.required && empty && !RESERVED_TYPES.includes(def.type)) return 'This field is required';
  if (empty) return '';
  const v = def.validation || {};
  if (def.type === 'text' || def.type === 'multiline') {
    if (v.maxLength && String(raw).length > Number(v.maxLength)) return `Max ${v.maxLength} characters`;
    if (v.regex) {
      try { if (!new RegExp(v.regex).test(String(raw))) return 'Does not match the required format'; }
      catch { /* invalid regex saved on the def - don't block the user for that */ }
    }
  }
  if (def.type === 'number' || def.type === 'currency') {
    const n = Number(raw);
    if (Number.isNaN(n)) return 'Must be a number';
    if (v.min !== undefined && v.min !== '' && n < Number(v.min)) return `Must be at least ${v.min}`;
    if (v.max !== undefined && v.max !== '' && n > Number(v.max)) return `Must be at most ${v.max}`;
  }
  if (def.type === 'email' && !EMAIL_RE.test(String(raw).trim())) return 'Enter a valid email address';
  if ((def.type === 'address' || def.type === 'person') && v.maxLength
      && String(raw).length > Number(v.maxLength)) return `Max ${v.maxLength} characters`;
  if (def.type === 'date' || def.type === 'time') {
    if (v.minDate && String(raw) < v.minDate) return `Must be on or after ${v.minDate}`;
    if (v.maxDate && String(raw) > v.maxDate) return `Must be on or before ${v.maxDate}`;
  }
  return '';
}

// What a reserved (or unfilled image/file) merge field renders as in the
// live editor's default-value preview - the actual export placeholder is
// rendered server-side (documents.py _export_prep), this is just for the
// authoring/fill UI to show the same idea.
export function placeholderLabel(def) {
  const label = def.label || def.token;
  const kind = { signature: 'Signature', initials: 'Initials', image: 'Image', file: 'Attachment' }[def.type];
  return kind ? `[${kind}: ${label}]` : '';
}

// ── Dragging a variable out of the library and onto the page ────────────────
// A private MIME type, so a drop only counts when it came from the library -
// a file, or text dragged in from another app, must be left to the editor's
// own paste/drop handling.
export const VARIABLE_DRAG_TYPE = 'application/x-nexus-variable';

export const variableFromDrop = (e) => {
  try { return e.dataTransfer?.getData(VARIABLE_DRAG_TYPE) || ''; } catch { return ''; }
};
