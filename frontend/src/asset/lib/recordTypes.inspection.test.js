import { describe, it, expect } from 'vitest';
import { RECORD_TYPES } from './recordTypes.jsx';

const sub = RECORD_TYPES.inspections.cols[0].sub;

describe('inspection sub-line', () => {
  it('never prints undefined', () => {
    expect(sub({ type: 'Fire Sprinkler Annual' })).toBe('');
    expect(sub({ type: 'Fire Sprinkler Annual', frequency: 'Annual' })).toBe('Annual');
    expect(sub({ type: 'Fire Sprinkler Annual', frequency: 'Annual', ahjRequired: 'Yes' })).toBe('Annual · AHJ required');
    expect(sub({ type: 'Fire Sprinkler Annual', ahjRequired: 'Yes' })).toBe('AHJ required');
  });
});
