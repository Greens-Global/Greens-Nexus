import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// My Availability, Phase 3b (Oct 15): Dates (one-off days, future ones
// editable, past ones read-only) and Hours (preferred / most a week, 0 = no
// preference) under the weekly pattern, saved with the same Save as
// {days, dates, prefs}; dates show as MM/DD/YYYY.

const availabilityMine = vi.fn();
const availabilitySave = vi.fn();
vi.mock('../api', () => ({ api: { availabilityMine: (...a) => availabilityMine(...a), availabilitySave: (...a) => availabilitySave(...a) } }));

const MyAvailability = (await import('./MyAvailability')).default;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const us = (ymd) => { const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; };
const FUTURE = day(5);
const PAST = day(-3);
const loaded = {
  days: [{ weekday: 5, kind: 'unavailable', start: '', end: '', note: '' }],
  dates: [
    { id: 'd1', date: FUTURE, kind: 'available', start: '13:00', end: '17:00', note: 'Dentist in the morning' },
    { id: 'd0', date: PAST, kind: 'unavailable', start: '', end: '', note: '' },
  ],
  prefs: { preferredHoursWeek: 24, maxHoursWeek: 30 },
};

beforeEach(() => {
  availabilityMine.mockReset().mockResolvedValue(loaded);
  availabilitySave.mockReset().mockImplementation(async (b) => ({ days: b.days.filter((d) => d.kind !== 'any'), dates: b.dates, prefs: b.prefs }));
});

describe('My Availability - dates and hours', () => {
  it('shows the dates as MM/DD/YYYY and the hours line', async () => {
    render(<MyAvailability />);
    expect((await screen.findAllByText('Unavailable')).length).toBe(2);      // Saturday, and the past date
    const dates = document.querySelector('[data-availability-dates]');
    expect(dates.textContent).toContain(us(FUTURE));
    expect(dates.textContent).toContain('Available 1:00 PM - 5:00 PM');
    expect(dates.textContent).toContain(us(PAST));
    expect(dates.textContent).not.toContain(FUTURE);                         // never ISO
    expect(document.querySelector('[data-availability-hours]').textContent).toBe('Prefers 24 hrs a week · At most 30 hrs a week');
  });

  it('adds and removes dates, edits the hours, and saves all three with one Save', async () => {
    render(<MyAvailability />);
    fireEvent.click(await screen.findByText('Edit Availability'));
    // the past date is read-only text, the future one an editable row
    expect(document.querySelectorAll('[data-date-row]')).toHaveLength(1);
    expect(screen.getByLabelText('Date 1').value).toBe(FUTURE);
    expect(screen.getByLabelText('Date 1').getAttribute('type')).toBe('date');
    expect(screen.queryByDisplayValue(PAST)).toBeNull();
    expect(screen.getByText(new RegExp(us(PAST)))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add Date/ }));
    expect(document.querySelectorAll('[data-date-row]')).toHaveLength(2);
    const save = screen.getByRole('button', { name: 'Save Availability' });
    expect(save.disabled).toBe(true);                                        // the new row has no date yet
    fireEvent.change(screen.getByLabelText('Date 2'), { target: { value: day(9) } });
    fireEvent.change(screen.getByLabelText('Date 2 note'), { target: { value: 'Moving day' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove date 1' }));
    expect(document.querySelectorAll('[data-date-row]')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Preferred hours per week'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Most hours per week'), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Availability' }));
    await waitFor(() => expect(availabilitySave).toHaveBeenCalledTimes(1));
    const body = availabilitySave.mock.calls[0][0];
    expect(body.days).toHaveLength(7);
    expect(body.days[5]).toEqual(expect.objectContaining({ weekday: 5, kind: 'unavailable' }));
    expect(body.dates).toEqual([{ date: day(9), kind: 'unavailable', start: '', end: '', note: 'Moving day' }]);   // the past row is the server's to keep
    expect(body.prefs).toEqual({ preferredHoursWeek: 20, maxHoursWeek: 32 });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(document.querySelector('[data-availability-hours]').textContent).toBe('Prefers 20 hrs a week · At most 32 hrs a week');
    expect(document.querySelector('[data-availability-dates]').textContent).toContain('Moving day');
  });

  it('keeps Save off while preferred hours pass the most hours, and reads 0 as no preference', async () => {
    availabilityMine.mockResolvedValue({ days: [], dates: [], prefs: { preferredHoursWeek: 0, maxHoursWeek: 0 } });
    render(<MyAvailability />);
    expect((await screen.findByText('No preference'))).toBeTruthy();
    fireEvent.click(screen.getByText('Edit Availability'));
    fireEvent.change(screen.getByLabelText('Preferred hours per week'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Most hours per week'), { target: { value: '30' } });
    expect(screen.getByText('Preferred hours cannot be more than your most hours.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Availability' }).disabled).toBe(true);
  });

  it('still works against an API that sends only the week', async () => {
    availabilityMine.mockResolvedValue({ days: [] });
    availabilitySave.mockImplementation(async () => ({ days: [] }));
    render(<MyAvailability />);
    expect(await screen.findByText('No dates set. Edit to add a day you cannot work, or can only work part of.')).toBeTruthy();
    fireEvent.click(screen.getByText('Edit Availability'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Availability' }));
    await waitFor(() => expect(availabilitySave).toHaveBeenCalledWith(expect.objectContaining({ dates: [], prefs: { preferredHoursWeek: 0, maxHoursWeek: 0 } })));
    expect(await screen.findByText('Availability saved. Your manager sees it when scheduling.')).toBeTruthy();
  });
});
