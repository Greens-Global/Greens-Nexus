// Page view reports (WP 5.4): the Reading card shows most read, never opened and teams.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../api', () => {
  const api = {
    kbReadingReport: () => Promise.resolve({
      days: 30, totals: { pages: 3, views: 12, readers: 4, never_opened: 1 },
      most_read: [{ id: 'kb_1', title: 'Opening Checklist', views: 9, readers: 3, last_day: '2026-10-28' }],
      never_opened: [{ id: 'kb_2', title: 'Closing Checklist', published_at: '2026-09-01T00:00:00Z' }],
      by_team: [{ department: 'Operations', views: 12, readers: 4 }],
    }),
  };
  return { api, default: api };
});

const { default: ReadingReport } = await import('./ReadingReport');
afterEach(cleanup);

describe('Reading card', () => {
  it('shows the most read, the unread and the teams', async () => {
    render(<ReadingReport />);
    expect(await screen.findByText('Opening Checklist')).toBeTruthy();
    expect(screen.getByText(/9 views · 3 readers/)).toBeTruthy();
    expect(screen.getByText('Closing Checklist')).toBeTruthy();
    expect(screen.getByText('Never Opened (1)')).toBeTruthy();
    expect(screen.getByText('Operations')).toBeTruthy();
  });
});
