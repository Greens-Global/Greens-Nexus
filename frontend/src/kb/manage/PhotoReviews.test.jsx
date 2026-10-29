// Photo proof reviews (WP 5.5): approve a photo, or send it back with a note.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const calls = [];
vi.mock('../../api', () => {
  const api = {
    kbPhotoReviews: () => Promise.resolve([{ id: 'phr_1', course_id: 'crs_1', course_title: 'Gate Safety', question: 'Photo of the locked gate',
      photo_url: 'https://x/kb-media/proof/a.jpg', user_email: 'lee@x.com', user_name: 'Lee Test', created_at: '2026-10-29T10:00:00Z' }]),
    kbDecidePhoto: (id, decision, note) => { calls.push([id, decision, note]); return Promise.resolve({}); },
  };
  return { api, default: api };
});

const { default: PhotoReviews } = await import('./PhotoReviews');
afterEach(() => { cleanup(); calls.length = 0; });

describe('Photo Reviews', () => {
  it('approves a photo', async () => {
    render(<PhotoReviews />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(calls).toEqual([['phr_1', 'approve', undefined]]));
  });

  it('sends a photo back only with a note', async () => {
    render(<PhotoReviews />);
    fireEvent.click(await screen.findByRole('button', { name: /Send Back/ }));
    const send = screen.getAllByRole('button', { name: /Send Back/ }).at(-1);
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What To Fix'), { target: { value: 'Padlock not visible' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls).toEqual([['phr_1', 'reject', 'Padlock not visible']]));
  });
});
