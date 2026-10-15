import { describe, it, expect } from 'vitest';
import { missedText } from './PayrollTimecard';

// The fixed-salary Missed days line names each reason (Charmi, Oct 15 2026).
describe('missedText', () => {
  it('reads full days, half days, and both', () => {
    expect(missedText({ label: 'Sick', full: 2, half: 0 })).toBe('Sick ×2');
    expect(missedText({ label: 'Personal', full: 0, half: 1 })).toBe('Personal ×1 half');
    expect(missedText({ label: 'Personal', full: 2, half: 1 })).toBe('Personal ×2 + 1 half');
  });
});
