// The phone New Task composer's helpers (11/15/2026): the Due Date picker's
// quick choices, how a due date reads on a chip, what Add Another keeps, and
// how a seeded description shows in "Add a note".
import { describe, it, expect } from 'vitest';
import { duePresets, dueLabel, carryDefaults, noteFromHtml } from './composerLib';

describe('duePresets', () => {
  it('Sunday: Today, Tomorrow, This Friday, Next Monday is tomorrow so it is not said twice', () => {
    expect(duePresets('2026-11-15')).toEqual([
      { label: 'Today', iso: '2026-11-15' },
      { label: 'Tomorrow', iso: '2026-11-16' },
      { label: 'This Friday', iso: '2026-11-20' },
    ]);
  });
  it('Wednesday: this week\'s Friday and next week\'s Monday', () => {
    expect(duePresets('2026-11-18').map((p) => [p.label, p.iso])).toEqual([
      ['Today', '2026-11-18'], ['Tomorrow', '2026-11-19'], ['This Friday', '2026-11-20'], ['Next Monday', '2026-11-23'],
    ]);
  });
  it('Thursday: Friday is tomorrow, so it shows once', () => {
    expect(duePresets('2026-11-19').map((p) => p.label)).toEqual(['Today', 'Tomorrow', 'Next Monday']);
  });
  it('Friday and Saturday: the next week\'s Friday', () => {
    expect(duePresets('2026-11-20').find((p) => p.label === 'Next Friday').iso).toBe('2026-11-27');
    expect(duePresets('2026-11-21').find((p) => p.label === 'Next Friday').iso).toBe('2026-11-27');
  });
  it('never offers a day twice, across a month and a year end', () => {
    for (const d of ['2026-12-31', '2026-02-27', '2027-01-01']) {
      const isos = duePresets(d).map((p) => p.iso);
      expect(new Set(isos).size).toBe(isos.length);
    }
  });
});

describe('dueLabel', () => {
  it('reads Today and Tomorrow, else the weekday and MM/DD/YYYY', () => {
    expect(dueLabel('2026-11-15', '2026-11-15')).toBe('Today');
    expect(dueLabel('2026-11-16', '2026-11-15')).toBe('Tomorrow');
    expect(dueLabel('2026-11-20', '2026-11-15')).toBe('Fri 11/20/2026');
    expect(dueLabel('', '2026-11-15')).toBe('');
  });
});

describe('carryDefaults (Add Another)', () => {
  const carry = { dueOn: '2026-11-16', assigneeIds: ['bob@x.com'], projectId: 'p2', priority: 'high' };
  it('keeps the date, the people and the project, never the priority, name, note or files', () => {
    const next = carryDefaults({ title: 'Old', description: '<p>x</p>', files: [1], status: 'in_progress', priority: 'urgent' }, carry);
    expect(next).toMatchObject({ dueOn: '2026-11-16', assigneeIds: ['bob@x.com'], status: 'in_progress', suggestedProjectId: 'p2' });
    expect(next).not.toHaveProperty('priority');
    expect(next).not.toHaveProperty('title');
    expect(next).not.toHaveProperty('description');
    expect(next).not.toHaveProperty('files');
    expect(next).not.toHaveProperty('projectId');
  });
  it('a screen\'s own project stays locked', () => {
    expect(carryDefaults({ projectId: 'p1' }, carry)).toMatchObject({ projectId: 'p1' });
    expect(carryDefaults({}, carry, 'p9')).toMatchObject({ projectId: 'p9' });
    expect(carryDefaults({ projectId: 'p1' }, carry)).not.toHaveProperty('suggestedProjectId');
  });
});

describe('noteFromHtml', () => {
  it('shows a description\'s words one paragraph per line', () => {
    expect(noteFromHtml('<p>Gate 2 is stuck</p><p>Code 4411 &amp; up</p>')).toBe('Gate 2 is stuck\nCode 4411 & up');
    expect(noteFromHtml('<ul><li>One</li><li>Two</li></ul>')).toBe('One\nTwo');
    expect(noteFromHtml('plain words')).toBe('plain words');
    expect(noteFromHtml('')).toBe('');
  });
});
