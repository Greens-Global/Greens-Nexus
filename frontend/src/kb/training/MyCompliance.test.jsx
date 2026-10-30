// Training > Compliance (Oct 30 2026): your own requirements, worst first.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const asked = [];
vi.mock('../../api', () => {
  const api = {
    kbCompliance: (params) => {
      asked.push(params);
      return Promise.resolve({
        people: [{ email: 'lee@x.com', cells: {
          'course:c1': { status: 'Completed', color: 'green', expires: '2027-03-01' },
          'policy:p1': { status: 'Overdue', color: 'red', due: '2026-10-01', days_overdue: 29 },
        } }],
        columns: [{ key: 'course:c1', kind: 'course', id: 'c1', title: 'Forklift Basics' },
          { key: 'policy:p1', kind: 'policy', id: 'p1', title: 'Code of Conduct' }],
        stats: { compliant_pct: 50, overdue: 1, due_soon: 0 },
      });
    },
  };
  return { api, default: api };
});

const { default: MyCompliance } = await import('./MyCompliance');
afterEach(() => { cleanup(); asked.length = 0; });

describe('My Compliance', () => {
  it('asks for my own record and lists overdue items first', async () => {
    render(<MyCompliance me={{ can_manage: false }} />);
    expect(await screen.findByText('Code of Conduct')).toBeTruthy();
    expect(asked).toEqual([{ scope: 'me' }]);
    const titles = screen.getAllByText(/Forklift Basics|Code of Conduct/).map((n) => n.textContent);
    expect(titles).toEqual(['Code of Conduct', 'Forklift Basics']);
    expect(screen.getByText('29 days overdue (due 10/01/2026)')).toBeTruthy();
    expect(screen.queryByText(/Manage > Compliance/)).toBeNull();     // no team link for a non-manager
  });
});
