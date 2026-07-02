// Field schema for the "Development Timeline" tab — a fixed set of columns (unlike Permits,
// which derives its columns dynamically from whatever keys exist on the rows; see
// SimpleRecordTable.jsx / permitColumns()).
//
// Shape: [key, label, options?] — matches the tuple format SimpleRecordTable and
// SimpleRowModal both expect for their `cols`/`fields` props.
//
// NOTE for App.jsx integration: App.jsx currently defines its OWN local TIMELINE_FIELDS (a
// simplified 4-column phase/status/statusDate/notes version) instead of importing this one. This
// file's TIMELINE_FIELDS is the ground-truth schema extracted from the original app (8 columns:
// phase, permit, agency, whenRequired, submittals, reviewTime, notes, status) — App.jsx's local
// copy should be replaced with an import from here to match original behavior.

export const TIMELINE_STATUS_OPTIONS = ['Complete', 'Pending', 'In Progress', 'N/A'];

export const TIMELINE_FIELDS = [
  ['phase', 'Phase'],
  ['permit', 'Permit / Approval'],
  ['agency', 'Issuing Agency'],
  ['whenRequired', 'When Required'],
  ['submittals', 'Key Submittals'],
  ['reviewTime', 'Review Time'],
  ['notes', 'Notes'],
  ['status', 'Status', TIMELINE_STATUS_OPTIONS],
];

/**
 * Columns for the Permit Matrix table: permits have no fixed schema, so the columns are derived
 * from the union of keys actually present across the current rows (falling back to a sensible
 * default set when there are no permits yet).
 */
export function permitColumns(permits) {
  const keys = [];
  (permits || []).forEach((row) => {
    Object.keys(row).forEach((k) => {
      if (k !== 'id' && k !== 'propertyId' && !keys.includes(k)) keys.push(k);
    });
  });
  if (keys.length) return keys.map((k) => [k, k]);
  return [
    ['Permit / Approval', 'Permit / Approval'],
    ['Jurisdiction / Agency', 'Jurisdiction / Agency'],
    ['Status', 'Status'],
    ['Notes', 'Notes'],
  ];
}
