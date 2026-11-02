import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Workday deep link "form:<templateId>" / "form:pick" (Forms & Checklists,
// Neil 11/02/2026): the Overview opens the Fill a Form tile on that form -
// the way "sign:<party>" opens Documents to Sign - and the tile sits in the
// Overview's actions cell beside Ask HR.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), myEmail: 'max@x.com', canAccessModule: () => true }),
}));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../components/MyShifts', () => ({ default: () => <div>Shifts</div> }));
vi.mock('../components/DocumentsToSign', () => ({ default: () => null }));
vi.mock('../forms/FormsTile', () => ({ default: ({ autoOpen }) => <div>FormsTile {autoOpen ? `open:${autoOpen.id}` : 'closed'}</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'myHrProfile' ? { name: 'Max', email: 'max@x.com', startDate: '2024-01-01' }
        : key === 'timesheetReviewWaiting' ? { reviews: [] }
          : key === 'timeStatus' ? {} : key === 'getReimbursements' ? { mine: [], approve: [], hr: [] } : []),
  });
  return { api, default: api };
});

const SLOW = 20000;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

describe('Workday form deep link', () => {
  it('form:<id> opens the tile on that form', async () => {
    const TimeClock = (await import('./TimeClock')).default;
    render(<TimeClock initialTab="overview" activeSub="form:abc" onSubChange={() => {}} />);
    expect(await screen.findByText(/FormsTile open:abc/)).toBeTruthy();
  }, SLOW);

  it('form:pick opens the picker, and a plain Overview leaves it closed', async () => {
    const TimeClock = (await import('./TimeClock')).default;
    const { unmount } = render(<TimeClock initialTab="overview" activeSub="form:pick" onSubChange={() => {}} />);
    expect(await screen.findByText(/FormsTile open:pick/)).toBeTruthy();
    unmount();
    render(<TimeClock initialTab="overview" activeSub="overview" onSubChange={() => {}} />);
    expect(await screen.findByText(/FormsTile closed/)).toBeTruthy();
  }, SLOW);
});
