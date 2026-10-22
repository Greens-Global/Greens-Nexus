// Task Module - Import from CSV / Excel (Neil, Oct 22 2026). The pure parts of
// ImportTasksModal: reading the file, matching its headers to task fields,
// turning cells into the rows POST /tasks/import takes, and the two files the
// wizard hands back (the template and the error report).
//
// The server decides everything that matters - people, statuses, options,
// required fields, parents (backend/task_import.py); its dry run IS the
// preview. What happens here is only what the server cannot do: read the file,
// and turn a date CELL (a number to Excel) into a date before it is lost.
//
// `xlsx` is imported dynamically, exactly as exporting.js does - it is ~400 KB
// and most sessions never import anything.

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const IMPORT_EXTENSIONS = ['.csv', '.xlsx', '.xls'];

// The built-in targets a column can be imported as, with the header words
// that mean each one. Custom fields are matched by their own name.
export const IMPORT_FIELDS = [
  { key: 'title', label: 'Task Name', synonyms: ['task name', 'name', 'title', 'task', 'task title', 'summary', 'subject'] },
  { key: 'description', label: 'Description', synonyms: ['description', 'notes', 'note', 'details'] },
  { key: 'assignees', label: 'Assignee', synonyms: ['assignee', 'assignees', 'owner', 'assigned to', 'assigned', 'responsible'] },
  { key: 'due', label: 'Due Date', synonyms: ['due', 'due date', 'due on', 'deadline', 'end date'] },
  { key: 'start', label: 'Start Date', synonyms: ['start', 'start date', 'start on', 'begin date'] },
  { key: 'priority', label: 'Priority', synonyms: ['priority'] },
  { key: 'status', label: 'Status', synonyms: ['status', 'state'] },
  { key: 'tags', label: 'Tags', synonyms: ['tags', 'tag', 'labels', 'label'] },
  { key: 'section', label: 'Section', synonyms: ['section', 'sections', 'group'] },
  { key: 'parent', label: 'Parent Task', synonyms: ['parent', 'parent task', 'parent name', 'subtask of'] },
];
export const DATE_KEYS = new Set(['due', 'start']);
export const CF = 'cf:';

/** Header text -> a comparable key: case, spacing and punctuation ignored. */
export const normHeader = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/[\s_\-./]+/g, ' ').replace(/[^a-z0-9# ]/g, '').replace(/\s+/g, ' ').trim();

/** The custom fields a file can fill in a project: the project's own task
 * fields, minus read-only ones (nothing can be written to those). */
export function importableFields(customFields, projectId) {
  return (customFields || []).filter((f) => !f.readOnly
    && (f.appliesTo || ['task']).includes('task')
    && (!(f.projectIds || []).length || (f.projectIds || []).includes(projectId)));
}

/**
 * One target per column ('' = Don't Import): built-in synonyms first, then a
 * custom field by its exact name. A target is used once - the first column
 * that claims it keeps it.
 */
export function autoMapHeaders(headers, fields = []) {
  const used = new Set();
  return (headers || []).map((h) => {
    const key = normHeader(h);
    if (!key) return '';
    const builtin = IMPORT_FIELDS.find((f) => !used.has(f.key) && f.synonyms.includes(key));
    if (builtin) { used.add(builtin.key); return builtin.key; }
    const field = fields.find((f) => !used.has(CF + f.id) && normHeader(f.name) === key);
    if (field) { used.add(CF + field.id); return CF + field.id; }
    return '';
  });
}

// ── Dates ──────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoOf(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  // Round-trip through UTC so 02/30 is refused rather than rolled into March.
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Excel serial -> YYYY-MM-DD. Day 25569 is 01/01/1970; arithmetic in UTC
 * so no time zone can move the day. The time of day (the fraction) is dropped. */
export function excelSerialToISO(serial) {
  const n = Math.floor(Number(serial));
  if (!Number.isFinite(n) || n < 10000 || n > 100000) return '';
  const t = new Date((n - 25569) * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * A date cell -> { iso, ok, twoDigitYear }. Blank is ok and empty. US order
 * only: 03/04/2026 is March 4 and never April 3 - a first number over 12 is
 * not a date. Also YYYY-MM-DD, M/D/YY (00-69 -> 20YY, 70-99 -> 19YY),
 * "Oct 22, 2026", Excel serials and Date objects. The server applies the
 * same rules and the same pivot (task_import.parse_import_date).
 */
export function parseDateCell(value) {
  if (value === null || value === undefined) return { iso: '', ok: true };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { iso: '', ok: false };
    return { iso: isoOf(value.getFullYear(), value.getMonth() + 1, value.getDate()), ok: true };
  }
  if (typeof value === 'number') {
    const iso = excelSerialToISO(value);
    return { iso, ok: !!iso };
  }
  const s = String(value).trim();
  if (!s) return { iso: '', ok: true };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) { const iso = isoOf(+m[1], +m[2], +m[3]); return { iso, ok: !!iso }; }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/);
  if (m) {
    const two = m[3].length === 2;
    const y = two ? (+m[3] < 70 ? 2000 : 1900) + +m[3] : +m[3];
    const iso = isoOf(y, +m[1], +m[2]);
    return two ? { iso, ok: !!iso, twoDigitYear: true } : { iso, ok: !!iso };
  }
  if (/^\d+(\.\d+)?$/.test(s)) { const iso = excelSerialToISO(+s); return { iso, ok: !!iso }; }
  m = s.replace(/\./g, '').match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const iso = mi >= 0 ? isoOf(+m[3], mi + 1, +m[2]) : '';
    return { iso, ok: !!iso };
  }
  return { iso: '', ok: false };
}

// ── Reading the file ───────────────────────────────────────────────────────
export function fileProblem(file) {
  if (!file) return 'Choose a file.';
  const name = String(file.name || '').toLowerCase();
  if (!IMPORT_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'Choose a .csv, .xlsx or .xls file.';
  if (file.size > MAX_IMPORT_BYTES) return 'This file is larger than 5 MB. Split it into smaller files.';
  return '';
}

/** File -> a SheetJS workbook. CSV is read as plain text (`raw`), so SheetJS
 * does not guess at "03/04" in some other date order - the server reads it. */
export async function readWorkbook(file) {
  const XLSX = await import('xlsx');
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.csv')) {
    const text = await file.text();
    return XLSX.read(text, { type: 'string', raw: true });
  }
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: 'array' });
}

const blankCell = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * One sheet -> { headers, rows }. The first row with anything in it is the
 * header row; each data row keeps its sheet row number (what a person sees
 * in Excel, and what a Parent column may name), the raw cell values (numbers
 * stay numbers, so a date cell is its serial) and the cells as displayed.
 * Blank rows are dropped.
 */
export async function sheetTable(workbook, sheetName) {
  const XLSX = await import('xlsx');
  const ws = workbook?.Sheets?.[sheetName];
  if (!ws || !ws['!ref']) return { headers: [], rows: [] };
  const top = XLSX.utils.decode_range(ws['!ref']).s.r;
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
  const text = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
  // A workbook saved in Excel's 1904 date system (old Mac Excel) counts its
  // serials from 01/01/1904 - 1,462 days later than the 1900 system.
  return tableFromArrays(raw, text, top, { date1904: !!workbook?.Workbook?.WBProps?.date1904 });
}

/** The pure half of sheetTable (tested without a workbook). */
export function tableFromArrays(raw, text = raw, top = 0, { date1904 = false } = {}) {
  const headerAt = raw.findIndex((r) => (r || []).some((c) => !blankCell(c)));
  if (headerAt < 0) return { headers: [], rows: [], date1904 };
  const headers = (text[headerAt] || raw[headerAt]).map((h) => String(h ?? '').trim());
  const rows = [];
  for (let i = headerAt + 1; i < raw.length; i++) {
    const r = raw[i] || [];
    if (!r.some((c) => !blankCell(c))) continue;
    rows.push({ n: top + i + 1, raw: r, text: text[i] || r });
  }
  return { headers, rows, date1904 };
}

// ── Rows for the server ────────────────────────────────────────────────────
/**
 * Mapped table rows -> POST /tasks/import rows. Date columns (built-in or a
 * date custom field) send YYYY-MM-DD when the cell reads as a date and the
 * cell's own text when it does not, so the server's error quotes what the
 * person typed. Number fields send the raw number; everything else the cell
 * as displayed.
 */
export function buildImportRows(table, mapping, fieldsById = {}, excluded = new Set()) {
  const out = [];
  for (const row of table?.rows || []) {
    if (excluded.has(row.n)) continue;
    const rec = { row: row.n };
    mapping.forEach((target, col) => {
      if (!target) return;
      const raw = row.raw[col];
      const shown = row.text[col] ?? raw;
      let value;
      const field = target.startsWith(CF) ? fieldsById[target.slice(CF.length)] : null;
      if (DATE_KEYS.has(target) || field?.type === 'date') {
        const cell = typeof raw === 'number' && table.date1904 ? raw + EXCEL_1904_OFFSET : raw;
        const { iso, ok } = parseDateCell(cell);
        value = ok ? iso : String(shown ?? '').trim();
      } else if (field?.type === 'number' && typeof raw === 'number') {
        value = raw;
      } else {
        value = String(shown ?? '').trim();
      }
      if (value === '') return;
      if (field) rec.custom = { ...(rec.custom || {}), [field.id]: value };
      else rec[target] = value;
    });
    out.push(rec);
  }
  return out;
}

export const EXCEL_1904_OFFSET = 1462;

/** Rows hidden behind an excluded row: its subtasks, at any depth. */
export function skippedWithParent(reportRows, excluded) {
  const byRow = new Map((reportRows || []).map((r) => [r.row, r]));
  const out = new Set();
  for (const r of reportRows || []) {
    let cur = r;
    const seen = new Set();
    while (cur && cur.parentRow != null && !seen.has(cur.row)) {
      seen.add(cur.row);
      if (excluded.has(cur.parentRow)) { out.add(r.row); break; }
      cur = byRow.get(cur.parentRow);
    }
  }
  return out;
}

// ── Files handed back ──────────────────────────────────────────────────────
// A cell that starts like a formula (= + - @, a tab or a carriage return) is
// prefixed with ' so a spreadsheet shows it as text instead of running it -
// task names and messages come from the uploaded file.
const csvCell = (v) => {
  let s = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The skipped rows as CSV: row number, task name and why. */
export function errorReportCsv(result, excludedRows = []) {
  const lines = [['Row', 'Task Name', 'Problem']];
  for (const e of result?.errors || []) lines.push([e.row, e.title || '', (e.errors || []).join(' ')]);
  for (const r of excludedRows) lines.push([r.row, r.title || '', 'Excluded before importing.']);
  for (const d of result?.droppedPeople || []) lines.push([d.row, '', `${d.email} ${d.reason} - left off.`]);
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

export function downloadText(text, filename, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The headers a file for this project can use: the built-ins, then the
 * project's own fields. */
export function templateHeaders(fields = []) {
  return [...IMPORT_FIELDS.map((f) => f.label), ...fields.map((f) => f.name)];
}

export async function downloadTemplate(project, fields) {
  const { exportExcel } = await import('./exporting');
  const headers = templateHeaders(fields);
  const slug = String(project?.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await exportExcel({
    filename: `import-template-${slug || 'project'}.xlsx`,
    title: 'Tasks',
    columns: headers.map((h) => ({ header: h, get: () => '', width: Math.max(14, h.length + 2) })),
    rows: [],
  });
}
