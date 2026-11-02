import { describe, it, expect } from 'vitest';
import { CREATE_ITEMS, groupCreates } from './quickCreate';

// The + menu's Fill a Form row (Forms & Checklists, Neil 11/02/2026): it
// lands on Workday's form picker, under its own Workday heading.
describe('CREATE_ITEMS', () => {
  it('offers Fill a Form landing on Workday form:pick', () => {
    const row = CREATE_ITEMS.find((it) => it.key === 'form');
    expect(row).toMatchObject({ group: 'Workday', label: 'Fill a Form', module: 'myhr', go: ['timeclock', 'form:pick'] });
    expect(groupCreates(CREATE_ITEMS).map((g) => g.label)).toContain('Workday');
  });
});
