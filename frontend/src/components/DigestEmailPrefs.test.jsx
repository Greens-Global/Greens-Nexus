import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const PREFS = {
  daily_briefing: { label: 'Daily Briefing', on: true },
  weekly_digest: { label: 'Weekly Digest', on: true },
  whats_new_digest: { label: "What's New Weekly Digest", on: false },
  ticket_weekly_report: { label: 'Weekly Ticket Report', on: true, unset: true },
};
const mockApi = vi.hoisted(() => ({ getMyEmailOptouts: vi.fn(), setMyEmailOptout: vi.fn() }));
vi.mock('../api', () => ({ api: mockApi }));

import DigestEmailPrefs from './DigestEmailPrefs';
import { readStopEmail, setPendingEmailStop } from '../lib/emailStop';

describe('DigestEmailPrefs', () => {
  beforeEach(() => {
    mockApi.getMyEmailOptouts.mockReset().mockResolvedValue(PREFS);
    mockApi.setMyEmailOptout.mockReset().mockImplementation((kind, on) =>
      Promise.resolve({ ...PREFS, [kind]: { ...PREFS[kind], on } }));
  });

  it('reads only the kinds it knows from the link', () => {
    expect(readStopEmail('?stopEmail=daily_briefing')).toBe('daily_briefing');
    expect(readStopEmail('?stopEmail=payroll')).toBe('');
    expect(readStopEmail('')).toBe('');
  });

  it('the email link turns the digest off in one step and offers Start It Again', async () => {
    setPendingEmailStop('weekly_digest');
    render(<DigestEmailPrefs />);
    await waitFor(() => expect(mockApi.setMyEmailOptout).toHaveBeenCalledWith('weekly_digest', false));
    expect(await screen.findByText('Done. You will no longer get the Weekly Digest.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start It Again' }));
    await waitFor(() => expect(mockApi.setMyEmailOptout).toHaveBeenLastCalledWith('weekly_digest', true));
  });

  it('without a link it changes nothing until a switch is used', async () => {
    render(<DigestEmailPrefs />);
    expect(await screen.findByText('Daily Briefing')).toBeTruthy();
    expect(screen.getByText("What's New Weekly Digest")).toBeTruthy();
    expect(mockApi.setMyEmailOptout).not.toHaveBeenCalled();
  });
});
