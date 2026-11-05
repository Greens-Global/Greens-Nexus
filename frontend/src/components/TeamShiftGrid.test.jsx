import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TeamShiftGrid from './TeamShiftGrid';

// The live team strip (Homebase lifts, Neil 11/02/2026): on this week's
// group grid the header carries four soft chips - In, On Break, Late, Not In -
// counted over the rows shown, in StatusLabel tones (never a solid fill).
// Clicking a chip keeps only those people in the grid; clicking it again
// clears. Late comes from the server (`late`), never worked out here.

afterEach(cleanup);

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
const DAYS = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday()); d.setDate(d.getDate() + i); return { date: d, key: isoDate(d), shifts: [], usual: null, timeoff: [], holiday: null, note: '', isToday: isoDate(d) === isoDate(new Date()) }; });
const row = (email, name, isMe = false) => ({ email, name, isMe, photoUrl: '', shift: null, days: DAYS.map((d) => ({ key: d.key, isToday: d.isToday, shifts: [], usual: null, off: [] })) });
const ROWS = [row('me@x.com', 'Me Here', true), row('bob@x.com', 'Bob Brown'), row('cara@x.com', 'Cara Diaz'), row('dan@x.com', 'Dan Fox'), row('eve@x.com', 'Eve Gray')];
const TEAM = { id: 'g', name: 'Store', members: ROWS.map((r) => ({ email: r.email, name: r.name })) };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const LIVE = {
  'me@x.com': { state: 'working', label: 'Working', since: ago(90) },
  'bob@x.com': { state: 'break', label: 'On Break', since: ago(12) },
  'cara@x.com': { state: 'out', label: 'Clocked Out', since: ago(30) },
};
const draw = (extra = {}) => render(<TeamShiftGrid teams={[TEAM]} team={TEAM} days={DAYS} rows={ROWS} thisWeek live={LIVE} late={['dan@x.com']} {...extra} />);
const members = () => Array.from(document.querySelectorAll('[role="row"][data-member]')).map((r) => r.getAttribute('data-member')).filter((m) => m !== 'open');
const chip = (word) => screen.getByRole('button', { name: new RegExp(`^${word} \\d+$`) });

describe('TeamShiftGrid live strip', () => {
  it('counts In, On Break, Late and Not In over the rows in soft tones', () => {
    draw();
    const strip = document.querySelector('[data-live-summary]');
    expect(strip).toBeTruthy();
    const labels = Array.from(strip.querySelectorAll('.nx-label'));
    expect(labels.map((l) => l.textContent)).toEqual(['In 1', 'On Break 1', 'Late 1', 'Not In 2']);
    const tones = labels.map((l) => l.style.getPropertyValue('--c'));
    expect(tones[0]).toBe('hsl(var(--color-green))');     // In: green
    expect(tones[1]).toBe('#64748b');                      // On Break: slate
    expect(tones[2]).toBe('hsl(var(--color-orange))');    // Late: amber
    expect(tones[3]).toBe('var(--muted)');                 // Not In: muted
    // "Not In" is wider than "off": the chip says what it holds.
    expect(chip('Not In').getAttribute('title')).toBe('Not clocked in - off today, on leave, or shift not started. Show only Not In');
    labels.forEach((l) => expect(l.style.background).toBe(''));   // never a solid fill
    // The old roll call is gone.
    expect(screen.queryByText(/^On Break: /)).toBeNull();
    expect(screen.queryByText(/^Nobody clocked in/)).toBeNull();
  });

  it('a chip filters the grid to those people; clicking again clears', () => {
    draw();
    expect(members()).toEqual(['me@x.com', 'bob@x.com', 'cara@x.com', 'dan@x.com', 'eve@x.com']);
    fireEvent.click(chip('Late'));
    expect(chip('Late').getAttribute('aria-pressed')).toBe('true');
    expect(members()).toEqual(['dan@x.com']);
    fireEvent.click(chip('Not In'));              // switches, never stacks
    expect(members()).toEqual(['cara@x.com', 'eve@x.com']);
    expect(chip('Late').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip('In'));
    expect(members()).toEqual(['me@x.com']);
    fireEvent.click(chip('On Break'));
    expect(members()).toEqual(['bob@x.com']);
    fireEvent.click(chip('On Break'));            // the same chip again clears
    expect(chip('On Break').getAttribute('aria-pressed')).toBe('false');
    expect(members()).toEqual(['me@x.com', 'bob@x.com', 'cara@x.com', 'dan@x.com', 'eve@x.com']);
  });

  it('with nobody on the clock, everyone is Not In and the counts still read plainly', () => {
    draw({ live: {}, late: [] });
    expect(Array.from(document.querySelectorAll('[data-live-summary] .nx-label')).map((l) => l.textContent)).toEqual(['In 0', 'On Break 0', 'Late 0', 'Not In 5']);
  });

  it('a chip narrows the rows, never the day totals', () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    try {
      // Two shifts on the first day: Me (In, 8 h) and Dan (Late, 4 h).
      const shift = (email, start, end) => ({ id: `s-${email}-${start}`, email, date: DAYS[0].key, start, end, paidMin: null, unpaid: [] });
      const withShifts = ROWS.map((r) => (['me@x.com', 'dan@x.com'].includes(r.email)
        ? { ...r, days: r.days.map((d, i) => (i === 0 ? { ...d, shifts: [shift(r.email, r.email === 'me@x.com' ? '08:00' : '12:00', '16:00')] } : d)) }
        : r));
      draw({ rows: withShifts, days: DAYS.map((d, i) => (i === 0 ? { ...d, shifts: withShifts.flatMap((r) => r.days[0].shifts) } : d)) });
      const us = `${String(DAYS[0].date.getMonth() + 1).padStart(2, '0')}/${String(DAYS[0].date.getDate()).padStart(2, '0')}/${DAYS[0].date.getFullYear()}`;
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${us}`) }));
      const total = () => screen.getByText('2 · 12:00 Hrs');
      expect(total()).toBeTruthy();
      fireEvent.click(chip('Late'));
      expect(total()).toBeTruthy();              // Dan alone is shown; the day is still 2 shifts, 12 h
      fireEvent.click(chip('Not In'));
      expect(total()).toBeTruthy();
    } finally { mm.mockRestore(); }
  });

  it('shows no strip on another week or without the live map', () => {
    draw({ thisWeek: false });
    expect(document.querySelector('[data-live-summary]')).toBeNull();
    cleanup();
    draw({ live: null });
    expect(document.querySelector('[data-live-summary]')).toBeNull();
    expect(screen.getByText(/^(On shift now: |Nobody on shift right now)/)).toBeTruthy();
  });

  it('on a phone the strip stays and filters the day list', () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: /max-width/.test(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    try {
      draw();
      const strip = document.querySelector('[data-live-summary]');
      expect(strip.style.flexWrap).toBe('wrap');
      fireEvent.click(chip('Late'));
      const shown = Array.from(document.querySelectorAll('[data-member]')).map((r) => r.getAttribute('data-member')).filter((m) => m !== 'open');
      expect(shown).toEqual(['dan@x.com']);
    } finally { mm.mockRestore(); }
  });
});
