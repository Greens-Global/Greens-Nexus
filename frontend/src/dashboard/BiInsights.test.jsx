import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the BI board (CLAUDE.md: high-risk views get one so a
// crash-on-render is caught before merge), plus the behaviors a manager
// relies on: attention first, a count opens its breakdown, filters narrow.

const dashInsights = vi.fn();
const dashInsightsDrilldown = vi.fn();
vi.mock('../api', () => ({ api: { dashInsights: (...a) => dashInsights(...a), dashInsightsDrilldown: (...a) => dashInsightsDrilldown(...a) } }));
vi.mock('./widgets.jsx', () => ({ navigate: vi.fn() }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="chart">{children}</div>,
  AreaChart: ({ children }) => <div>{children}</div>, Area: () => null, Tooltip: () => null,
}));

import BiInsights from './BiInsights';

const payload = {
  at: '2026-10-13T07:17:54Z',
  modules: [
    { id: 'tasks', label: 'Tasks', nav: 'tasks', stats: [
      { key: 'overdue', label: 'Overdue', value: 623, tone: 'critical', drill: true },
      { key: 'completed_7d', label: 'Completed (7d)', value: 4, tone: 'good', drill: true },
    ], breakdown: [{ label: 'On Track', value: 602, tone: 'neutral' }, { label: 'Overdue', value: 623, tone: 'critical' }] },
    { id: 'attendance', label: 'Time & Attendance', nav: 'employee-tracking', stats: [
      { key: 'clocked_in', label: 'Clocked In', value: 12, tone: 'good', drill: true },
    ], trend: [{ label: '10-07', value: 3 }, { label: '10-13', value: 12 }] },
    { id: 'accounting', label: 'Accounting', nav: 'accounting', stats: [
      { key: 'cash_on_hand', label: 'Cash on Hand', value: '$9,000', tone: 'good', drill: false },
    ] },
  ],
};

describe('BiInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    dashInsights.mockResolvedValue(payload);
    dashInsightsDrilldown.mockResolvedValue({ kind: 'by_person', title: 'Overdue Tasks by Employee', total: 623, rows: [{ label: 'Charmi Desai', value: 109 }, { label: 'Valinda Cranfill', value: 59 }] });
  });

  it('renders the attention strip first and one card per module', async () => {
    render(<BiInsights />);
    expect(await screen.findByText('Needs Attention')).toBeInTheDocument();
    expect(screen.getByText('1 critical and 0 warning signals across the company.')).toBeInTheDocument();
    // the attention tile and the Tasks card both carry Overdue
    expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument();
    expect(screen.getByLabelText('Time & Attendance')).toBeInTheDocument();
    expect(screen.getByLabelText('Accounting')).toBeInTheDocument();
    expect(screen.getByText('$9,000')).toBeInTheDocument();
    expect(screen.getByText('Clocked in, last 7 days')).toBeInTheDocument();
  });

  it('opens the breakdown when a count is clicked', async () => {
    render(<BiInsights />);
    await screen.findByText('Needs Attention');
    fireEvent.click(screen.getByTitle('See the breakdown of Completed (7d)'));
    await waitFor(() => expect(dashInsightsDrilldown).toHaveBeenCalledWith('tasks', 'completed_7d'));
    expect(await screen.findByText('Overdue Tasks by Employee')).toBeInTheDocument();
    expect(screen.getByText('Charmi Desai')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('Charmi Desai')).toBeNull();
  });

  it('does not offer a breakdown for a count the server marks drill: false', async () => {
    render(<BiInsights />);
    await screen.findByText('Needs Attention');
    expect(screen.queryByTitle('See the breakdown of Cash on Hand')).toBeNull();
  });

  it('narrows the cards by search and by alert level', async () => {
    render(<BiInsights />);
    await screen.findByText('Needs Attention');
    fireEvent.change(screen.getByLabelText('Find a metric'), { target: { value: 'clocked' } });
    expect(screen.queryByLabelText('Tasks')).toBeNull();
    expect(screen.getByLabelText('Time & Attendance')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Clear search'));
    fireEvent.click(screen.getByRole('radio', { name: 'Critical' }));
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument();
    expect(screen.queryByLabelText('Accounting')).toBeNull();
  });

  it('hides a module from the Modules menu and remembers it', async () => {
    render(<BiInsights />);
    await screen.findByText('Needs Attention');
    fireEvent.click(screen.getByRole('button', { name: /Modules/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Accounting' }));
    expect(screen.queryByLabelText('Accounting')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nexus:bi-hidden-modules'))).toEqual(['accounting']);
  });

  it('shows a calm state when nothing is past its alert level, and an error state instead of a blank screen', async () => {
    dashInsights.mockResolvedValueOnce({ at: '', modules: [payload.modules[2]] });
    const { unmount } = render(<BiInsights />);
    expect(await screen.findByText('All clear')).toBeInTheDocument();
    unmount();
    dashInsights.mockRejectedValueOnce(new Error('boom'));
    render(<BiInsights />);
    expect(await screen.findByText('The board could not load')).toBeInTheDocument();
    expect(screen.getByText('Try Again')).toBeInTheDocument();
  });
});
