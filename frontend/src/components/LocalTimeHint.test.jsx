import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

// "It is 9:40 PM for Priya" - under an assignee field and on a contact card,
// only when it is outside the person's hours (lib/localTime.js is the rule;
// this is the lookup and the line).
const directory = vi.hoisted(() => ({ rows: [], calls: 0 }));
vi.mock('../api', () => ({
  api: { getPeopleDirectory: vi.fn(() => { directory.calls += 1; return Promise.resolve(directory.rows); }) },
}));
// The viewer sits in California whatever machine runs the test.
vi.mock('../lib/worldClockZones', async (importOriginal) => ({ ...(await importOriginal()), LOCAL_TZ: 'America/Los_Angeles' }));

const LocalTimeHint = (await import('./LocalTimeHint')).default;

const NOW = new Date('2026-11-13T16:10:00Z');   // 9:40 PM in India, 8:10 AM in California
const PRIYA = { email: 'priya@example.com', name: 'Priya Patel', timeZone: 'Asia/Kolkata', workStart: '09:00', workEnd: '18:00' };
const RAVI = { email: 'ravi@example.com', name: 'Ravi K', timeZone: 'Asia/Kolkata', workStart: '', workEnd: '' };
const SAM = { email: 'sam@example.com', name: 'Sam Staff', timeZone: 'America/Los_Angeles', workStart: '08:00', workEnd: '17:00' };
const hint = () => document.querySelector('[data-local-time-hint]');
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => { cleanup(); directory.rows = []; directory.calls = 0; });

describe('LocalTimeHint', () => {
  it('outside their working hours: one quiet line with their first name and their time', async () => {
    directory.rows = [PRIYA, SAM];
    render(<LocalTimeHint emails={['Priya@Example.com']} me="sam@example.com" now={NOW} />);
    await waitFor(() => expect(hint()).toBeTruthy());
    expect(hint().textContent).toMatch(/^It is 9:40\sPM for Priya$/);
    // Muted label text - never the live orange, never a warning color.
    expect(hint().style.color).toBe('var(--muted)');
    expect(hint().style.fontSize).toBe('12px');
  });

  it('inside their hours it renders nothing', async () => {
    directory.rows = [{ ...PRIYA, workStart: '13:00', workEnd: '22:00' }, SAM];
    render(<LocalTimeHint emails={['priya@example.com', 'sam@example.com']} me="neil@example.com" now={NOW} />);
    await settle();
    expect(directory.calls).toBe(1);
    expect(hint()).toBeNull();
  });

  it('with no hours set, the night rule (9:00 PM to 7:00 AM on their clock)', async () => {
    directory.rows = [RAVI];
    const { rerender } = render(<LocalTimeHint emails="ravi@example.com" me="sam@example.com" now={NOW} />);
    await waitFor(() => expect(hint()?.textContent).toMatch(/^It is 9:40\sPM for Ravi$/));
    rerender(<LocalTimeHint emails="ravi@example.com" me="sam@example.com" now={new Date('2026-11-13T12:00:00Z')} />);   // 5:30 PM there
    expect(hint()).toBeNull();
  });

  it('never a line about yourself', async () => {
    directory.rows = [PRIYA];
    render(<LocalTimeHint emails={['priya@example.com']} me="priya@example.com" now={NOW} />);
    await settle();
    expect(hint()).toBeNull();
  });

  it('several people outside their hours: one counted line', async () => {
    directory.rows = [PRIYA, RAVI, SAM];
    render(<LocalTimeHint emails={['priya@example.com', 'ravi@example.com', 'sam@example.com']} me="neil@example.com" now={NOW} />);
    await waitFor(() => expect(hint()?.textContent).toBe('It is after hours for 2 of these people'));
    expect(document.querySelectorAll('[data-local-time-hint]').length).toBe(1);
  });

  it('rows in hand skip the lookup; brief leaves the clock out (the contact card)', async () => {
    render(<LocalTimeHint rows={[PRIYA]} me="sam@example.com" brief now={NOW} />);
    expect(hint().textContent).toBe('Outside working hours');
    await settle();
    expect(directory.calls).toBe(0);
  });

  it('nobody picked, someone not in the list, or a list that fails: nothing, and no crash', async () => {
    const { rerender } = render(<LocalTimeHint emails={[]} me="sam@example.com" now={NOW} />);
    expect(hint()).toBeNull();
    expect(directory.calls).toBe(0);                       // nothing to look up
    directory.rows = [SAM];
    rerender(<LocalTimeHint emails={['guest@partner.example']} me="sam@example.com" now={NOW} />);
    await settle();
    expect(hint()).toBeNull();
    expect(screen.queryByText(/It is/)).toBeNull();
  });
});
