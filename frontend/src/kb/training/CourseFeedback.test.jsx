// Course feedback (WP 5.7): pick stars, send once; the owner's summary shows comments.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const sent = [];
vi.mock('../../api', () => {
  const api = { kbCourseFeedback: (cid, rating, comment) => { sent.push([cid, rating, comment]); return Promise.resolve({}); } };
  return { api, default: api };
});

const { RateCourse, FeedbackSummary } = await import('./CourseFeedback');
afterEach(() => { cleanup(); sent.length = 0; });

describe('course feedback', () => {
  it('sends the stars and the comment', async () => {
    render(<RateCourse course={{ id: 'crs_1', my_feedback: null }} />);
    expect(screen.getByRole('button', { name: /Send Feedback/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Clear' } });
    fireEvent.click(screen.getByRole('button', { name: /Send Feedback/ }));
    await waitFor(() => expect(sent).toEqual([['crs_1', 4, 'Clear']]));
  });

  it('the summary shows the average and comments', () => {
    render(<FeedbackSummary feedback={{ count: 2, average: 4.5, counts: {}, comments: [{ rating: 5, comment: 'Loved it', at: '2026-10-28T10:00:00Z' }] }} />);
    expect(screen.getByText('4.5')).toBeTruthy();
    expect(screen.getByText('Loved it')).toBeTruthy();
  });
});
