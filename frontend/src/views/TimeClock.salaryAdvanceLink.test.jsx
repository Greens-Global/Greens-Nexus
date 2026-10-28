import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Salary advances left Workday for the Time Sheet (Neil, Oct 29 2026). Bells
// and inbox rows stored before then still say myhr / "salary-advances": the
// person lands on their own Time Sheet, and HR with advances waiting on them
// goes on to Approvals > Money.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set() }),
}));
vi.mock('../components/PayrollTimecard', () => ({ default: () => <div>Timecard</div> }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => () => Promise.resolve(
      key === 'salaryAdvancesPending' ? (globalThis.__pending || [])
        : key === 'timesheetReviewWaiting' ? { reviews: [], toSign: [] }
          : key === 'timeStatus' ? {} : []),
  });
  return { api, default: api };
});

const SLOW = 20000;
let navigated;
const onNav = (e) => navigated.push(e.detail);
beforeEach(() => {
  globalThis.__pending = [];
  navigated = [];
  window.addEventListener('nexus:navigate', onNav);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => window.removeEventListener('nexus:navigate', onNav));

async function renderAt(sub, onSubChange = () => {}) {
  const TimeClock = (await import('./TimeClock')).default;
  return render(<TimeClock initialTab={sub} activeSub={sub} onSubChange={onSubChange} />);
}

describe('an old salary advance link', () => {
  it("opens the person's own Time Sheet", async () => {
    const onSubChange = vi.fn();
    await renderAt('salary-advances', onSubChange);
    expect(await screen.findByText('Timecard')).toBeTruthy();
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('timesheet'));
    await new Promise((r) => setTimeout(r, 0));
    expect(navigated).toEqual([]);
  }, SLOW);

  it('takes HR with advances waiting to Approvals > Money', async () => {
    globalThis.__pending = [{ id: 'a1' }];
    await renderAt('salary-advances');
    await waitFor(() => expect(navigated).toEqual([{ view: 'approvals', sub: 'money' }]));
  }, SLOW);
});
