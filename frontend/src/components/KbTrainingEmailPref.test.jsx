// Profile > Email Settings > Training (WP 2.4): the due-soon switch loads,
// saves on click, and says when the organization has emails off.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const calls = [];
let mine = { dueSoonEmail: true, orgEmailOn: true };
vi.mock('../api', () => {
  const api = {
    getKbMyEmailPref: () => Promise.resolve(mine),
    updateKbMyEmailPref: (data) => { calls.push(data); return Promise.resolve({ ...mine, ...data }); },
  };
  return { api, default: api };
});

const { default: KbTrainingEmailPref } = await import('./KbTrainingEmailPref');
afterEach(() => { cleanup(); calls.length = 0; });

describe('training email switch', () => {
  it('turns due-soon emails off with one click', async () => {
    render(<KbTrainingEmailPref />);
    const sw = await screen.findByRole('switch', { name: 'Email Me When Training Is Due Soon' });
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(calls).toEqual([{ dueSoonEmail: false }]));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByText(/Overdue training and policies to sign always email you/)).toBeTruthy();
  });

  it('is locked when the organization has training emails off', async () => {
    mine = { dueSoonEmail: true, orgEmailOn: false };
    render(<KbTrainingEmailPref />);
    const sw = await screen.findByRole('switch');
    expect(sw.disabled).toBe(true);
    expect(screen.getByText(/turned off for everyone/)).toBeTruthy();
    mine = { dueSoonEmail: true, orgEmailOn: true };
  });
});
