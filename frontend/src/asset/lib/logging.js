import { genId, currentUser } from './format.js';

/** Build one activity-log entry. Every mutation appends one of these via appendLog(). */
export function makeLogEntry(fields) {
  return { id: genId(), ts: new Date().toISOString(), user: currentUser(), ...fields };
}

/** Append a log entry to the store, if one was produced (mutations that are no-ops produce none). */
export function appendLog(store, entry) {
  return entry ? { ...store, logs: [entry, ...(store.logs || [])] } : store;
}

/**
 * Diff a record's OLD values against a NEW patch, for fields declared in `fieldDefs`
 * (either PT-style `{l,key}` or flat `{k,label}` - pass whichever schema applies).
 * Returns [{field, from, to}] for only the fields that actually changed.
 */
export function diffChanges(fieldDefs, oldRecord, patch) {
  const changes = [];
  fieldDefs.forEach((f) => {
    const key = f.k || f.key;
    const label = f.label || f.l;
    if (!key || !(key in patch)) return;
    const from = oldRecord?.[key] ?? '';
    const to = patch[key] ?? '';
    if (String(from) !== String(to)) changes.push({ field: label, from, to });
  });
  return changes;
}

/** Best-effort display name for a collection record, for log entries ("item"). */
export function recordDisplayName(recordType, record) {
  const NAME_FIELDS = { warranties: 'scope', inspections: 'type', vendors: 'company', ahj: 'authority', utilities: 'service', documents: 'title', vdocs: 'title', maintenance: 'system', vservice: 'type' };
  const key = NAME_FIELDS[recordType];
  return (key && record[key]) || record.date || recordType + ' record';
}
