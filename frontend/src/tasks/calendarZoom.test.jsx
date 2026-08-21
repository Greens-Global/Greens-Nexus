// The date picker's iOS-style zoom: days -> months -> years and back, so a
// date years away is reachable without paging a month at a time.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateField } from './components';

const openPicker = (value = '2026-08-21') => {
  const onChange = vi.fn();
  render(<DateField value={value} onChange={onChange} />);
  fireEvent.click(screen.getByTitle('Set date'));
  return onChange;
};

describe('DateField calendar zoom', () => {
  it('opens on the day grid showing the selected month and year', () => {
    openPicker();
    expect(screen.getByText('August')).toBeTruthy();
    expect(screen.getByText('2026')).toBeTruthy();
    expect(screen.getByText('21')).toBeTruthy();
  });

  it('clicking the month zooms out to that year’s months', () => {
    openPicker();
    fireEvent.click(screen.getByText('August'));
    // Twelve short month names, and the day grid is gone.
    expect(screen.getByText('Jan')).toBeTruthy();
    expect(screen.getByText('Dec')).toBeTruthy();
    expect(screen.queryByText('Mo')).toBeNull();
  });

  it('picking a month zooms back in to that month’s days', () => {
    openPicker();
    fireEvent.click(screen.getByText('August'));
    fireEvent.click(screen.getByText('Mar'));
    expect(screen.getByText('March')).toBeTruthy();
    expect(screen.getByText('Mo')).toBeTruthy();   // day grid is back
  });

  it('clicking the year zooms out to a page of years', () => {
    openPicker();
    fireEvent.click(screen.getByText('2026'));
    // Pages are aligned to fixed 12-year blocks: 2026 sits in 2016-2027.
    expect(screen.getByText('2016 - 2027')).toBeTruthy();
    expect(screen.getByText('2016')).toBeTruthy();
    expect(screen.getByText('2027')).toBeTruthy();
  });

  it('picking a year drops into that year’s months, not straight to days', () => {
    openPicker();
    fireEvent.click(screen.getByText('2026'));
    fireEvent.click(screen.getByText('2019'));
    expect(screen.getByText('2019')).toBeTruthy();
    expect(screen.getByText('Jan')).toBeTruthy();  // month grid
    expect(screen.queryByText('Mo')).toBeNull();   // not the day grid yet
  });

  it('crosses years in three clicks and commits a real date', () => {
    const onChange = openPicker();
    fireEvent.click(screen.getByText('2026'));     // zoom to years
    fireEvent.click(screen.getByText('2019'));     // pick year -> months
    fireEvent.click(screen.getByText('Mar'));      // pick month -> days
    fireEvent.click(screen.getByText('14'));       // pick day
    expect(onChange).toHaveBeenCalledWith('2019-03-14');
  });

  it('arrows step by the unit currently on screen', () => {
    openPicker();
    // Days: steps a month.
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('September')).toBeTruthy();

    // Months: steps a year.
    fireEvent.click(screen.getByText('September'));
    fireEvent.click(screen.getByLabelText('Next year'));
    expect(screen.getByText('2027')).toBeTruthy();

    // Years: steps a whole page.
    fireEvent.click(screen.getByText('2027'));
    fireEvent.click(screen.getByLabelText('Next years'));
    expect(screen.getByText('2028 - 2039')).toBeTruthy();
  });

  it('clicking the year range zooms back out to days', () => {
    openPicker();
    fireEvent.click(screen.getByText('2026'));
    fireEvent.click(screen.getByText('2016 - 2027'));
    expect(screen.getByText('Mo')).toBeTruthy();
  });
});
