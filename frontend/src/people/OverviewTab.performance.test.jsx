import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// A person's Performance on their Overview (Neil, Oct 29 2026) is handed the
// record's camelCase fields (11/11/2026: it read work_email / first_name,
// which the payload never has, so the section never showed).

vi.mock('../performance/PersonPerformanceSection', () => ({
  default: ({ email, name }) => <div data-testid="perf">{email}|{name}</div>,
}));
vi.mock('../components/EmployeeCustomFields', () => ({ EmployeeMoreDetails: () => null }));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: () => () => Promise.resolve([]) });
  return { api, default: api };
});

afterEach(cleanup);

const LEO = { id: 'e2', firstName: 'Leo', lastName: 'Low', workEmail: 'leo@x.com', personal: {}, compliance: {}, contractor: {} };

describe('Overview - Performance section', () => {
  it('shows for a person, with their work email and name', async () => {
    const { default: OverviewTab } = await import('./OverviewTab');
    render(<OverviewTab e={LEO} toastOk={() => {}} toastErr={() => {}} />);
    expect((await screen.findByTestId('perf')).textContent).toBe('leo@x.com|Leo Low');
  });

  it('stays off a removed person', async () => {
    const { default: OverviewTab } = await import('./OverviewTab');
    render(<OverviewTab e={LEO} isRemoved toastOk={() => {}} toastErr={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('perf')).toBeNull();
  });
});
