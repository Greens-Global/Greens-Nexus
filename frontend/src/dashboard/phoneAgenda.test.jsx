// The Calendar widget on a phone (Neil, 11/17/2026: "it should work like
// iPhone outlook calendar widget where it is tight and helpful") and the day
// rules it shares with the web's agenda.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PhoneAgenda from './PhoneAgenda.jsx';
import { eventsByDay, stillAhead, durationText, joinableNow, byStart } from './agendaModel';

const at = (hhmm, day = '2026-11-18') => `${day}T${hhmm}:00.0000000`;
const NOW = new Date('2026-11-18T10:35:00').getTime();   // local wall clock

describe('agenda rules', () => {
  it('puts an all-day event on every day it covers, a timed one on its start day', () => {
    const by = eventsByDay([
      { subject: 'Australia Trip', isAllDay: true, start: '2026-11-16T00:00:00.0000000', end: '2026-11-21T00:00:00.0000000' },
      { subject: 'Sync', start: at('10:30'), end: at('11:30') },
    ]);
    expect(Object.keys(by).sort()).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    expect(by['2026-11-18'].map((e) => e.subject)).toEqual(['Australia Trip', 'Sync']);
    expect(by['2026-11-21']).toBeUndefined();   // the end is exclusive
  });

  it('keeps all-day items and drops a meeting once it has ended', () => {
    const list = [
      { subject: 'Trip', isAllDay: true, start: '2026-11-18T00:00:00' },
      { subject: 'Done', start: at('09:00'), end: at('09:30') },
      { subject: 'Live', start: at('10:30'), end: at('11:30') },
    ];
    expect(stillAhead(list, NOW).map((e) => e.subject)).toEqual(['Trip', 'Live']);
  });

  it('says how long a meeting runs in Outlook\'s words', () => {
    expect(durationText(at('10:30'), at('11:30'))).toBe('1 hr');
    expect(durationText(at('10:30'), at('11:00'))).toBe('30 min');
    expect(durationText(at('09:00'), at('10:30'))).toBe('1 hr 30 min');
    expect(durationText(at('09:00'), at('11:00'))).toBe('2 hr');
    expect(durationText(at('09:00'), '')).toBe('');
  });

  it('offers Join from ten minutes before a Teams meeting until it ends', () => {
    const ev = { joinUrl: 'https://teams.example/x', start: at('10:40'), end: at('11:00') };
    expect(joinableNow(ev, new Date('2026-11-18T10:29:00').getTime())).toBe(false);
    expect(joinableNow(ev, new Date('2026-11-18T10:31:00').getTime())).toBe(true);
    expect(joinableNow(ev, new Date('2026-11-18T11:00:00').getTime())).toBe(false);
    expect(joinableNow({ ...ev, joinUrl: '' }, NOW)).toBe(false);
  });

  it('sorts all-day first, then by start', () => {
    const list = [{ subject: 'b', start: at('09:00') }, { subject: 'a', isAllDay: true, start: '2026-11-17T00:00:00' }];
    expect(list.sort(byStart).map((e) => e.subject)).toEqual(['a', 'b']);
  });
});

describe('PhoneAgenda', () => {
  const opened = [];
  afterEach(() => { opened.length = 0; vi.restoreAllMocks(); });
  const spyOpen = () => vi.spyOn(window, 'open').mockImplementation((u) => { opened.push(u); return null; });

  const today = [
    { subject: 'Australia Trip', isAllDay: true, start: '2026-11-16T00:00:00', webLink: 'https://outlook/trip' },
    { subject: 'Ended Standup', start: at('09:00'), end: at('09:30'), joinUrl: 'https://teams/a' },
    { subject: '[Greens Storage Team] - Weekly', start: at('10:30'), end: at('11:30'), joinUrl: 'https://teams/b', location: 'Microsoft Teams Meeting', webLink: 'https://outlook/sync' },
    { subject: 'Lender call', start: at('13:00'), end: at('13:30'), location: 'Conference Room B' },
  ];

  it('shows the date, what is still ahead with times and lengths, and Join on the live meeting', () => {
    spyOpen();
    render(<PhoneAgenda todayKey="2026-11-18" today={today} tomorrow={[]} nowMs={NOW} />);
    expect(screen.getByText('Wednesday')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.queryByText('Ended Standup')).toBeNull();
    expect(screen.getByText('All Day')).toBeTruthy();
    expect(screen.getByText('10:30 AM')).toBeTruthy();
    expect(screen.getByText('1 hr')).toBeTruthy();
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.getByText('Conference Room B')).toBeTruthy();
    // Join opens the meeting, not the event behind the row.
    fireEvent.click(screen.getByRole('button', { name: 'Join Now' }));
    expect(opened).toEqual(['https://teams/b']);
    // The row opens the event; the date opens the day in Outlook.
    fireEvent.click(screen.getByRole('link', { name: /Australia Trip, all day/ }));
    fireEvent.click(screen.getByRole('button', { name: /open the day in Outlook/ }));
    expect(opened.slice(1)).toEqual(['https://outlook/trip', 'https://outlook.office.com/calendar/view/day']);
  });

  it('fills the room under today with tomorrow, at least two of it, and counts the rest', () => {
    const tomorrow = ['A', 'B', 'C'].map((s, i) => ({ subject: s, start: at(`0${8 + i}:00`, '2026-11-19'), end: at(`0${8 + i}:30`, '2026-11-19') }));
    render(<PhoneAgenda todayKey="2026-11-18" today={today} tomorrow={tomorrow} nowMs={NOW} />);
    expect(screen.getByText('Tomorrow')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.queryByText('C')).toBeNull();
    expect(screen.getByText('1 more tomorrow')).toBeTruthy();
  });

  it('caps today at four and says how many more', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ subject: `M${i}`, start: at(`1${i + 1}:00`), end: at(`1${i + 1}:30`) }));
    render(<PhoneAgenda todayKey="2026-11-18" today={many} tomorrow={[{ subject: 'T', start: at('09:00', '2026-11-19') }]} nowMs={NOW} />);
    expect(screen.getByText('M3')).toBeTruthy();
    expect(screen.queryByText('M4')).toBeNull();
    expect(screen.getByRole('button', { name: '2 more today' })).toBeTruthy();
    expect(screen.queryByText('Tomorrow')).toBeNull();   // no room under a full today
  });

  it('says so when the day is done or empty', () => {
    const { rerender } = render(<PhoneAgenda todayKey="2026-11-18" today={[today[1]]} nowMs={NOW} />);
    expect(screen.getByText('Nothing else today.')).toBeTruthy();
    rerender(<PhoneAgenda todayKey="2026-11-18" today={[]} nowMs={NOW} />);
    expect(screen.getByText('Nothing scheduled today.')).toBeTruthy();
  });

  it('says the calendar did not load instead of looking empty', () => {
    const onRetry = vi.fn();
    render(<PhoneAgenda todayKey="2026-11-18" error onRetry={onRetry} nowMs={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByText('Nothing scheduled today.')).toBeNull();
  });
});
