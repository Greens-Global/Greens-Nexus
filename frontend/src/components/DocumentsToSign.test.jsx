import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { moduleCount, tabCount, withBadges } from '../lib/useActionCounts';

vi.mock('../api', () => ({
  api: {
    mySignatures: vi.fn().mockResolvedValue([
      { partyId: 'p1', title: 'Offer Letter', myTurn: true, linkKind: '', createdAt: '2026-10-17T10:00:00Z', from: 'hr@x.com' },
      { partyId: 'p2', title: 'Time Sheet', myTurn: true, linkKind: 'timesheet', createdAt: '2026-10-17T10:00:00Z' },
      { partyId: 'p3', title: 'Policy', myTurn: false, linkKind: '', createdAt: '2026-10-17T10:00:00Z' },
    ]),
  },
}));
vi.mock('./ESign', () => ({ SignModal: () => null }));

const DocumentsToSign = (await import('./DocumentsToSign')).default;

describe('action counts', () => {
  const counts = { myhr: { timesheet: 2, overview: 1 }, hr: { 'hr-time': 3 } };

  it('a module dot is the sum of its tabs; a missing one is zero', () => {
    expect(moduleCount(counts, 'myhr')).toBe(3);
    expect(moduleCount(counts, 'shifts')).toBe(0);
    expect(tabCount(counts, 'hr', 'hr-people')).toBe(0);
  });

  it('puts each count on its tab and leaves the rest untouched', () => {
    const tabs = withBadges([{ key: 'overview' }, { key: 'timeoff' }], counts, 'myhr');
    expect(tabs).toEqual([{ key: 'overview', badge: 1 }, { key: 'timeoff' }]);
  });
});

describe('Documents to Sign', () => {
  it('lists only my-turn documents, leaving Time Sheets to the Time Sheet tab', async () => {
    render(<DocumentsToSign />);
    expect(await screen.findByText('Offer Letter')).toBeTruthy();
    expect(screen.queryByText('Time Sheet')).toBeNull();
    expect(screen.queryByText('Policy')).toBeNull();
    expect(screen.getByText('1 waiting on your signature')).toBeTruthy();
  });
});
