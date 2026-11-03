import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApi = vi.hoisted(() => ({ helpSearchLog: vi.fn(() => Promise.resolve()) }));
vi.mock('../api', () => ({ api: mockApi }));

import { logHelpSearch, __resetHelpLog } from './helpLog';

// Crisis support (11/02/2026): words that express suicidal intent or
// self-harm are never sent to the search log.
describe('logHelpSearch', () => {
  beforeEach(() => { __resetHelpLog(); mockApi.helpSearchLog.mockClear(); });

  it('logs an ordinary miss', () => {
    logHelpSearch('payroll calendar', 0, 'help');
    expect(mockApi.helpSearchLog).toHaveBeenCalledWith('payroll calendar', 0, 'help');
  });

  it('never logs crisis words', () => {
    logHelpSearch('i want to end my life', 0, 'help');
    logHelpSearch('self harm', 0, 'ask');
    expect(mockApi.helpSearchLog).not.toHaveBeenCalled();
  });
});
