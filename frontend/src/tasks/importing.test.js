import { describe, it, expect } from 'vitest';
import {
  normHeader, autoMapHeaders, importableFields, parseDateCell, excelSerialToISO, tableFromArrays,
  buildImportRows, skippedWithParent, errorReportCsv, fileProblem, templateHeaders, CF,
} from './importing';
import { projectRoleWithTeams } from './lib';

// Import from CSV / Excel (Oct 22 2026): the browser-side half - header
// matching, date cells, and the rows sent to POST /tasks/import.

const phase = { id: 'f-phase', name: 'Phase', type: 'select', projectIds: ['p1'] };
const cost = { id: 'f-cost', name: 'Cost Code', type: 'text', projectIds: [] };
const when = { id: 'f-when', name: 'Inspection Date', type: 'date', projectIds: ['p1'] };
const ro = { id: 'f-ro', name: 'Formula', type: 'number', readOnly: true, projectIds: [] };
const elsewhere = { id: 'f-x', name: 'Other', type: 'text', projectIds: ['p2'] };

describe('header auto-mapping', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(normHeader('  Due_Date ')).toBe('due date');
    expect(normHeader('Assigned-To:')).toBe('assigned to');
  });

  it('maps the common synonyms', () => {
    const m = autoMapHeaders(['Task Name', 'Owner', 'Due', 'Start Date', 'PRIORITY', 'Status', 'Labels',
      'Section', 'Notes', 'Parent Task', 'Something Else']);
    expect(m).toEqual(['title', 'assignees', 'due', 'start', 'priority', 'status', 'tags', 'section',
      'description', 'parent', '']);
    expect(autoMapHeaders(['Title', 'Assigned To', 'Due Date'])).toEqual(['title', 'assignees', 'due']);
    expect(autoMapHeaders(['Name'])).toEqual(['title']);
  });

  it('maps a custom field by its name, and each target only once', () => {
    expect(autoMapHeaders(['Name', 'Title', 'phase', 'Phase', 'cost code'], [phase, cost]))
      .toEqual(['title', '', CF + 'f-phase', '', CF + 'f-cost']);
  });

  it('reads back the Export file columns', () => {
    expect(autoMapHeaders(['Task', 'Parent Task', 'Status', 'Priority', 'Assignee', 'Project', 'Team', 'Start', 'Due']))
      .toEqual(['title', 'parent', 'status', 'priority', 'assignees', '', '', 'start', 'due']);
  });

  it('offers only the fields a file can fill in this project', () => {
    expect(importableFields([phase, cost, when, ro, elsewhere], 'p1').map((f) => f.id))
      .toEqual(['f-phase', 'f-cost', 'f-when']);
    expect(templateHeaders([phase])).toContain('Phase');
    expect(templateHeaders([])[0]).toBe('Task Name');
  });
});

describe('date cells', () => {
  it('reads MM/DD/YYYY as US - 03/04 is March 4, never April 3', () => {
    expect(parseDateCell('03/04/2026')).toEqual({ iso: '2026-03-04', ok: true });
    expect(parseDateCell('3/4/26')).toEqual({ iso: '2026-03-04', ok: true });
    expect(parseDateCell('12-31-2026')).toEqual({ iso: '2026-12-31', ok: true });
    expect(parseDateCell('25/03/2026').ok).toBe(false);   // not swapped round
    expect(parseDateCell('02/30/2026').ok).toBe(false);   // not rolled into March
  });

  it('reads ISO, month names, Excel serials and Date objects', () => {
    expect(parseDateCell('2026-10-22')).toEqual({ iso: '2026-10-22', ok: true });
    expect(parseDateCell('2026-10-22T00:00:00Z')).toEqual({ iso: '2026-10-22', ok: true });
    expect(parseDateCell('Oct 22, 2026')).toEqual({ iso: '2026-10-22', ok: true });
    expect(parseDateCell(46115)).toEqual({ iso: '2026-04-03', ok: true });
    expect(parseDateCell(46115.9)).toEqual({ iso: '2026-04-03', ok: true });
    expect(parseDateCell('46115')).toEqual({ iso: '2026-04-03', ok: true });
    expect(parseDateCell(new Date(2026, 9, 22))).toEqual({ iso: '2026-10-22', ok: true });
    expect(excelSerialToISO(25569)).toBe('1970-01-01');
    expect(excelSerialToISO(45658)).toBe('2025-01-01');
  });

  it('blank is fine, nonsense is not', () => {
    expect(parseDateCell('')).toEqual({ iso: '', ok: true });
    expect(parseDateCell(null)).toEqual({ iso: '', ok: true });
    for (const bad of ['soon', '03/04', '20261022', 5, 'Smarch 3, 2026']) expect(parseDateCell(bad).ok).toBe(false);
  });
});

describe('table and rows', () => {
  const raw = [
    [],
    ['Task Name', 'Due', 'Phase', 'Inspection Date', 'Owner'],
    ['Pour slab', 46115, 'Build', 46120, 'ana@greensglobal.com'],
    ['', '', '', '', ''],
    ['Order steel', 'bad date', '', '10/01/2026', ''],
    ['Frame', '04/05/2026', '', '', ''],
  ];
  const text = raw.map((r) => r.map((c) => (typeof c === 'number' ? `formatted ${c}` : c)));

  it('finds the header row, keeps sheet row numbers and drops blank rows', () => {
    const t = tableFromArrays(raw, text, 0);
    expect(t.headers).toEqual(['Task Name', 'Due', 'Phase', 'Inspection Date', 'Owner']);
    expect(t.rows.map((r) => r.n)).toEqual([3, 5, 6]);
  });

  it('builds import rows: dates normalized, the typed text kept when unreadable, custom fields keyed by id', () => {
    const t = tableFromArrays(raw, text, 0);
    const mapping = autoMapHeaders(t.headers, [phase, when]);
    const rows = buildImportRows(t, mapping, { [phase.id]: phase, [when.id]: when });
    expect(rows[0]).toEqual({ row: 3, title: 'Pour slab', due: '2026-04-03', assignees: 'ana@greensglobal.com',
      custom: { 'f-phase': 'Build', 'f-when': '2026-04-08' } });
    expect(rows[1]).toEqual({ row: 5, title: 'Order steel', due: 'bad date', custom: { 'f-when': '2026-10-01' } });
    expect(rows[2]).toEqual({ row: 6, title: 'Frame', due: '2026-04-05' });
  });

  it('leaves out excluded rows and unmapped columns', () => {
    const t = tableFromArrays(raw, text, 0);
    const rows = buildImportRows(t, ['title', '', '', '', ''], {}, new Set([5]));
    expect(rows).toEqual([{ row: 3, title: 'Pour slab' }, { row: 6, title: 'Frame' }]);
  });
});

describe('who may import into a project', () => {
  const p = { id: 'p1', accessLevel: 'restricted', ownerId: 'o@x.com', memberRoles: { 'v@x.com': 'viewer' } };
  it('counts approved teams like the server, never a pending one', () => {
    const team = (over) => ({ id: 't', projectIds: ['p1'], memberIds: ['v@x.com', 'n@x.com'], accessRole: 'editor', ...over });
    expect(projectRoleWithTeams(p, 'v@x.com', false, [])).toBe('viewer');
    expect(projectRoleWithTeams(p, 'v@x.com', false, [team()])).toBe('editor');
    expect(projectRoleWithTeams(p, 'n@x.com', false, [team({ approvalStatus: 'pending' })])).toBe(null);
    expect(projectRoleWithTeams(p, 'n@x.com', false, [team({ accessRole: 'commenter' })])).toBe('commenter');
    expect(projectRoleWithTeams(p, 'z@x.com', true, [])).toBe('owner');
  });
});

describe('preview helpers', () => {
  it('a row under an excluded row is skipped with it, at any depth', () => {
    const rows = [{ row: 2, parentRow: null }, { row: 3, parentRow: 2 }, { row: 4, parentRow: 3 }, { row: 5, parentRow: null }];
    expect([...skippedWithParent(rows, new Set([2]))].sort()).toEqual([3, 4]);
    expect(skippedWithParent(rows, new Set()).size).toBe(0);
  });

  it('the error report quotes cells that need it', () => {
    const csv = errorReportCsv({
      errors: [{ row: 4, title: 'Steel, "rebar"', errors: ['Title is required.', 'Due date "x" is not a date - use MM/DD/YYYY.'] }],
      droppedPeople: [{ row: 6, email: 'gone@x.com', reason: 'has left' }],
    }, [{ row: 9, title: 'Skip me' }]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Row,Task Name,Problem');
    expect(lines[1]).toBe('4,"Steel, ""rebar""","Title is required. Due date ""x"" is not a date - use MM/DD/YYYY."');
    expect(lines).toContain('9,Skip me,Excluded before importing.');
    expect(lines).toContain('6,,gone@x.com has left - left off.');
  });

  it('refuses the wrong kind of file and anything over 5 MB', () => {
    expect(fileProblem({ name: 'plan.pdf', size: 10 })).toMatch(/csv/);
    expect(fileProblem({ name: 'plan.xlsx', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(fileProblem({ name: 'Plan.CSV', size: 10 })).toBe('');
  });
});
