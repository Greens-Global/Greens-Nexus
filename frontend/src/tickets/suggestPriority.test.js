import { describe, it, expect } from 'vitest';
import { suggestPriority } from './ticketMeta';

// Impact x urgency (Neil, Oct 28 2026): who is affected plus whether they can
// keep working sets an incident's starting priority; the person may change it.
describe('suggestPriority', () => {
  it('reads who is affected and whether they can keep working', () => {
    expect(suggestPriority('incident', { impact: 'One User' })).toBe('medium');
    expect(suggestPriority('incident', { impact: 'One User', blocking: 'Yes, it is minor' })).toBe('low');
    expect(suggestPriority('incident', { impact: 'One User', blocking: 'No, I am stopped' })).toBe('high');
    expect(suggestPriority('incident', { impact: 'Multiple Users', blocking: 'No, I am stopped' })).toBe('high');
    expect(suggestPriority('incident', { impact: 'Department', blocking: 'No, I am stopped' })).toBe('urgent');
    expect(suggestPriority('incident', { impact: 'Entire Organization', blocking: 'Yes, but slowed down' })).toBe('urgent');
  });

  it('suggests nothing for other types or before the impact is known', () => {
    expect(suggestPriority('bug', { impact: 'Department' })).toBeNull();
    expect(suggestPriority('incident', {})).toBeNull();
  });
});
