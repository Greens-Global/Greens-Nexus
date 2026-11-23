import { describe, it, expect } from 'vitest';
import { listedRecordViews, recordViewsFor } from './navigation.js';

describe('Records list', () => {
  const counts = { utilities: 6, ahj: 10, permit: 16 };
  const count = (k) => counts[k] || 0;
  const views = recordViewsFor('property');

  it('always lists Plans & Docs first, even with no rows', () => {
    expect(listedRecordViews(views, count, 'utilities')).toEqual(['documents', 'utilities', 'ahj', 'permit']);
  });
  it('leaves the other empty collections to the Add rows', () => {
    const listed = listedRecordViews(views, count, 'property');
    expect(views.filter((k) => !listed.includes(k))).toEqual(['warranties', 'inspections', 'vendors']);
  });
  it('keeps the open collection listed even when empty', () => {
    expect(listedRecordViews(views, count, 'vendors')).toEqual(['documents', 'utilities', 'ahj', 'vendors', 'permit']);
  });
  it('leaves vehicles alone', () => {
    expect(listedRecordViews(recordViewsFor('vehicle'), () => 0, 'property')).toEqual([]);
  });
});
