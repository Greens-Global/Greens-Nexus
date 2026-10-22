import { describe, it, expect } from 'vitest';
import { historyValueParts, historyFieldName, joinFieldNames, groupFieldChanges } from './fieldHistory';

// Field history values are stored raw (ids, emails, ISO dates) with the names
// they had at the time; these helpers make them readable (Oct 22 2026).

const ctx = {
  nameOf: (e) => ({ 'sam@x.com': 'Sam Lee', 'ana@x.com': 'Ana Ruiz' }[e] || ''),
  statusMeta: { in_progress: { label: 'In Progress', color: '#fdab3d' }, review: { label: 'In Review', color: '#123456' } },
  projectName: (id) => ({ p1: 'Plant' }[id] || ''),
  customFields: [
    { id: 'cf-site', name: 'Site', type: 'select', options: [{ id: 'o1', label: 'Austin', color: '#f00' }] },
    { id: 'cf-tags', name: 'Colors', type: 'multiselect', options: [{ id: 'm1', label: 'Red', color: '#e00' }] },
  ],
};
const texts = (parts) => parts.map((p) => p.text);

describe('historyValueParts', () => {
  it('reads a blank side as Empty', () => {
    for (const v of [null, undefined, '', []]) {
      expect(historyValueParts({ field: 'title', from: v }, 'from', ctx)).toEqual([{ text: 'Empty', empty: true }]);
    }
  });

  it('statuses: the live name and color, else the stored one, else Removed Status', () => {
    const e = { field: 'status', from: 'in_progress', to: 'gone', labels: { gone: { label: 'Waiting', color: '#abc' } } };
    expect(historyValueParts(e, 'from', ctx)).toEqual([{ text: 'In Progress', color: '#fdab3d' }]);
    expect(historyValueParts(e, 'to', ctx)).toEqual([{ text: 'Waiting', color: '#abc' }]);
    expect(texts(historyValueParts({ field: 'status', to: 'x' }, 'to', ctx))).toEqual(['Removed Status']);
  });

  it('priority, dates, people, flags and hours read the way the drawer shows them', () => {
    expect(historyValueParts({ field: 'priority', to: 'urgent' }, 'to', ctx)[0].text).toBe('Urgent');
    expect(texts(historyValueParts({ field: 'dueOn', to: '2026-10-04' }, 'to', ctx))).toEqual(['10/04/2026']);
    expect(texts(historyValueParts({ field: 'startOn', from: '2026-01-31' }, 'from', ctx))).toEqual(['01/31/2026']);
    expect(texts(historyValueParts({ field: 'assigneeIds', to: ['sam@x.com', 'ana@x.com'] }, 'to', ctx)))
      .toEqual(['Sam Lee', 'Ana Ruiz']);
    expect(texts(historyValueParts({ field: 'isMilestone', to: true }, 'to', ctx))).toEqual(['Yes']);
    expect(texts(historyValueParts({ field: 'estimateHours', to: 1.5 }, 'to', ctx))).toEqual(['1h 30m']);
    expect(texts(historyValueParts({ field: 'approvalStatus', to: 'changes_requested' }, 'to', ctx)))
      .toEqual(['Changes Requested']);
    expect(texts(historyValueParts({ field: 'tags', to: ['leak', 'roof'] }, 'to', ctx))).toEqual(['leak', 'roof']);
  });

  it('projects and sections: the live name, the stored one, or a placeholder', () => {
    const e = { field: 'projectIds', to: ['p1', 'p9', 'p8'], labels: { p9: { label: 'Old Board' } } };
    expect(texts(historyValueParts(e, 'to', ctx))).toEqual(['Plant', 'Old Board', 'Private Project']);
    expect(texts(historyValueParts({ field: 'sectionId', from: 's1', labels: { s1: { label: 'Backlog' } } }, 'from', ctx)))
      .toEqual(['Backlog']);
    expect(texts(historyValueParts({ field: 'sectionId', from: 's2' }, 'from', ctx))).toEqual(['Removed Section']);
  });

  it('custom fields by kind, a deleted option falling back to its stored label or Removed Option', () => {
    const sel = { field: 'customField', fieldId: 'cf-site', kind: 'select', from: 'o1', to: 'o2',
      labels: { o2: { label: 'Dallas', color: '#0f0' } } };
    expect(historyValueParts(sel, 'from', ctx)).toEqual([{ text: 'Austin', color: '#f00' }]);
    expect(historyValueParts(sel, 'to', ctx)).toEqual([{ text: 'Dallas', color: '#0f0' }]);
    expect(texts(historyValueParts({ ...sel, to: 'o3', labels: {} }, 'to', ctx))).toEqual(['Removed Option']);
    // An activity row's change carries the kind as `type`.
    const multi = { field: 'customField', fieldId: 'cf-tags', type: 'multiselect', to: ['m1', 'mx'] };
    expect(texts(historyValueParts(multi, 'to', ctx))).toEqual(['Red', 'Removed Option']);
    expect(texts(historyValueParts({ field: 'customField', kind: 'checkbox', to: false }, 'to', ctx))).toEqual(['Unchecked']);
    expect(texts(historyValueParts({ field: 'customField', kind: 'date', to: '2026-12-25' }, 'to', ctx))).toEqual(['12/25/2026']);
    expect(texts(historyValueParts({ field: 'customField', kind: 'people', to: ['sam@x.com'] }, 'to', ctx))).toEqual(['Sam Lee']);
    expect(texts(historyValueParts({ field: 'customField', kind: 'number', to: 3 }, 'to', ctx))).toEqual(['3']);
  });
});

describe('field names and the feed fold', () => {
  it('names a field by its current name, else the stored one', () => {
    expect(historyFieldName({ field: 'dueOn' })).toBe('Due Date');
    expect(historyFieldName({ field: 'customField', fieldId: 'cf-site', label: 'Old' }, ctx.customFields)).toBe('Site');
    expect(historyFieldName({ field: 'customField', fieldId: 'gone', label: 'Old' }, ctx.customFields)).toBe('Old');
    expect(historyFieldName({ field: 'customField', fieldId: 'gone' }, [])).toBe('Removed Field');
    expect(joinFieldNames(['Priority'])).toBe('Priority');
    expect(joinFieldNames(['Priority', 'Status', 'Tags'])).toBe('Priority, Status and Tags');
    expect(joinFieldNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more');
  });

  it('folds one save into one line and leaves everything else alone', () => {
    const at = (s) => `2026-10-22T15:00:${String(s).padStart(2, '0')}+00:00`;
    const row = (id, s, field, actorId = 'sam@x.com', type = 'field_changed') => ({
      id, at: at(s), type, actorId, entityId: 't1', detail: 'x', change: field ? { field } : null,
    });
    const rows = [   // newest first, as the server sends them
      row('a', 30, 'priority'), row('b', 30, 'startOn'), row('c', 29, 'tags'),
      row('d', 20, null, 'sam@x.com', 'commented'),
      row('e', 10, 'title', 'ana@x.com'), row('f', 9, 'priority'),
    ];
    const out = groupFieldChanges(rows);
    expect(out.map((r) => r.id)).toEqual(['a', 'd', 'e', 'f']);
    expect(out[0].detail).toBe('changed Priority, Start Date and Labels');
    expect(out[0].changes).toHaveLength(3);
    expect(out[1].detail).toBe('x');
    expect(out[2].detail).toBe('changed Title');
    expect(out[3].detail).toBe('changed Priority');
  });
});
