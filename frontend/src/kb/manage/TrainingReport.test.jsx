// Training reports (WP 5.6): the Training Trends card's three tables.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../api', () => {
  const api = {
    kbTrainingReport: () => Promise.resolve({
      months: [{ month: '09/2026', completed: 2 }, { month: '10/2026', completed: 5 }],
      courses: [{ id: 'crs_1', title: 'Ladder Safety', delivery: 'online', assigned: 10, completed: 7, rate: 70, avg_score: 88, avg_rating: 4.2 }],
      teams: [{ department: 'Operations', assigned: 10, completed: 7, rate: 70 }],
    }),
  };
  return { api, default: api };
});

const { default: TrainingReport } = await import('./TrainingReport');
afterEach(cleanup);

describe('Training Trends', () => {
  it('shows months, courses and teams', async () => {
    render(<TrainingReport />);
    expect(await screen.findByText('Ladder Safety')).toBeTruthy();
    expect(screen.getByText('10/2026')).toBeTruthy();
    expect(screen.getByText('88%')).toBeTruthy();
    expect(screen.getByText('4.2')).toBeTruthy();
    expect(screen.getByText('Operations')).toBeTruthy();
  });
});
