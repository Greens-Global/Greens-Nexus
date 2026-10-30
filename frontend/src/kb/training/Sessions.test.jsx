// In-person training (WP 5.1): the Sessions tab takes attendance and stays
// closed until the course is published In Person.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const calls = [];
const SESSION = { id: 'ses_1', when: '11/03/2026 9:30 AM', location: 'Temecula yard', trainer_name: 'Tom Test', trainer_email: 'tom@x.com',
  notes: '', status: 'scheduled', attendees: [{ email: 'lee@x.com', name: 'Lee Test', status: 'invited', signed_off_at: '' }] };
vi.mock('../../api', () => {
  const api = {
    kbSessions: () => Promise.resolve({ sessions: [SESSION], sign_offs: [] }),
    kbMarkAttendance: (sid, email, status) => { calls.push([sid, email, status]); return Promise.resolve({ ...SESSION, attendees: [{ ...SESSION.attendees[0], status }] }); },
    kbPeople: () => Promise.resolve([]),
  };
  return { api, default: api };
});

const { default: Sessions } = await import('./Sessions');
afterEach(() => { cleanup(); calls.length = 0; });

describe('Sessions tab', () => {
  it('marks a person attended', async () => {
    render(<Sessions course={{ id: 'crs_1', status: 'published', delivery: 'in_person' }} />);
    expect(await screen.findByText('11/03/2026 9:30 AM')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Attended/ }));
    await waitFor(() => expect(calls).toEqual([['ses_1', 'lee@x.com', 'attended']]));
    expect(await screen.findByText('Attended')).toBeTruthy();
  });

  it('cannot schedule until the course is published In Person', async () => {
    render(<Sessions course={{ id: 'crs_1', status: 'draft', delivery: 'online' }} />);
    expect((await screen.findByRole('button', { name: /New Session/ })).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Sign Off a Person/ }).disabled).toBe(true);
  });
});
