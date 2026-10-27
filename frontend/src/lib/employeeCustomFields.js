// More Details: custom fields on employee records (Neil, Oct 27 2026).
// The definitions come from /hr/custom-fields, each person's values from
// /hr/employees/{id}/custom-fields or /myhr/custom-fields. The server owns
// who sees what and validates every save (hr_custom_fields.py); this file is
// the screens' side: labels, how a value reads, the same checks before a
// save so a mistake is named in place, and the People list filter.
import { formatDate } from './datetime';

export const FIELD_TYPES = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['date', 'Date'],
  ['dropdown', 'Dropdown'],
  ['checkbox', 'Checkbox'],
];
export const TYPE_LABEL = Object.fromEntries(FIELD_TYPES);

export const VISIBILITY = [
  ['hr_only', 'HR Only', 'Only People with HR access see it - never the employee or their manager.'],
  ['employee_view', 'Employee Can See', 'The employee sees it in My HR; HR changes it.'],
  ['employee_edit', 'Employee Can Edit', 'The employee sees and changes it in My HR.'],
];
export const VISIBILITY_LABEL = Object.fromEntries(VISIBILITY.map(([k, l]) => [k, l]));

const hasValue = (v) => v !== undefined && v !== null && v !== '';

// A value as a person reads it: US dates, Yes / No.
export function formatFieldValue(field, v) {
  if (!hasValue(v)) return '';
  switch (field?.fieldType) {
    case 'checkbox': return v === true || v === 'true' ? 'Yes' : 'No';
    case 'date': return formatDate(v, String(v));
    case 'number': return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
    default: return String(v);
  }
}

// The form's value for one field: what the box holds, never undefined.
export function formValue(field, v) {
  if (field?.fieldType === 'checkbox') return v === true || v === 'true';
  return hasValue(v) ? String(v) : '';
}

// The same rules the server applies. Returns '' when `raw` is fine.
export function fieldError(field, raw) {
  const empty = field.fieldType === 'checkbox' ? false : !String(raw ?? '').trim();
  if (empty) return field.required ? `${field.label} is required` : '';
  const s = String(raw).trim();
  if (field.fieldType === 'number') {
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? '' : `${field.label} must be a number`;
  }
  if (field.fieldType === 'date') {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());
    return ok ? '' : `${field.label} must be a date`;
  }
  if (field.fieldType === 'dropdown') {
    return (field.options || []).some((o) => o.toLowerCase() === s.toLowerCase()) ? '' : `${field.label} must be one of its options`;
  }
  if (field.fieldType === 'text' && s.length > 2000) return `${field.label} can be at most 2000 characters`;
  return '';
}

// What a save sends: only the editable fields whose value changed.
export function changedValues(fields, before, form) {
  const out = {};
  for (const f of fields) {
    if (!f.editable) continue;
    const was = formValue(f, before?.[f.fieldKey]);
    const now = form[f.fieldKey];
    if (now !== was) out[f.fieldKey] = f.fieldType === 'checkbox' ? !!now : now;
  }
  return out;
}

// The People list filter on one field: '' matches everyone; '__empty' the
// people with no value; otherwise contains (text, number), equals (dropdown,
// date) or Yes / No (checkbox).
export function matchesFieldFilter(field, v, filter) {
  if (!field || filter === '' || filter === undefined || filter === null) return true;
  if (filter === '__empty') return field.fieldType === 'checkbox' ? v !== true : !hasValue(v);
  if (field.fieldType === 'checkbox') return (filter === 'yes') === (v === true);
  if (!hasValue(v)) return false;
  if (field.fieldType === 'dropdown' || field.fieldType === 'date') return String(v).toLowerCase() === String(filter).toLowerCase();
  return formatFieldValue(field, v).toLowerCase().includes(String(filter).trim().toLowerCase())
    || String(v).toLowerCase().includes(String(filter).trim().toLowerCase());
}
