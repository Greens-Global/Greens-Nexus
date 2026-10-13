import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MonthDayControls, YearDayControls, PeriodicDaysControl } from './RecurrenceParts';

// Recurrence options (Oct 13 2026): Periodically past 90 days with an "Other"
// for any number, and "the 4th Friday" style monthly / yearly rules.

function Holder({ Comp, initial, seedDate }) {
  const [v, setV] = useState(initial);
  return (<><Comp value={v} onChange={setV} seedDate={seedDate} /><output data-testid="v">{JSON.stringify(v)}</output></>);
}
const value = () => JSON.parse(screen.getByTestId('v').textContent);

describe('PeriodicDaysControl', () => {
  it('offers presets out to 240 days', () => {
    render(<Holder Comp={PeriodicDaysControl} initial={7} />);
    const sel = screen.getByLabelText('Days after completion');
    expect([...sel.options].map((o) => o.value)).toContain('240');
    fireEvent.change(sel, { target: { value: '240' } });
    expect(value()).toBe(240);
  });

  it('"Other..." takes any number of days', () => {
    render(<Holder Comp={PeriodicDaysControl} initial={7} />);
    fireEvent.change(screen.getByLabelText('Days after completion'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Number of days'), { target: { value: '100' } });
    expect(value()).toBe(100);
  });

  it('opens on Other for a saved count that is not a preset', () => {
    render(<Holder Comp={PeriodicDaysControl} initial={100} />);
    expect(screen.getByLabelText('Days after completion').value).toBe('other');
    expect(screen.getByLabelText('Number of days').value).toBe('100');
  });
});

describe('MonthDayControls', () => {
  it('switches to "Day of Week", starting from the due date', () => {
    render(<Holder Comp={MonthDayControls} initial={{ dayOfMonth: 1 }} seedDate="2026-10-23" />);
    fireEvent.change(screen.getByLabelText('Repeat on'), { target: { value: 'weekday' } });
    expect(value()).toEqual({ weekOfMonth: 4, weekday: 5 });   // the 4th Friday
    fireEvent.change(screen.getByLabelText('Which week'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Weekday'), { target: { value: '3' } });
    expect(value()).toEqual({ weekOfMonth: 3, weekday: 3 });   // the 3rd Wednesday
  });

  it('offers the last day of the month', () => {
    render(<Holder Comp={MonthDayControls} initial={{ dayOfMonth: 1 }} />);
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '-1' } });
    expect(value()).toEqual({ dayOfMonth: -1 });
  });
});

describe('YearDayControls', () => {
  it('sets "the Fourth Thursday of November"', () => {
    render(<Holder Comp={YearDayControls} initial={{}} seedDate="2026-11-26" />);
    fireEvent.change(screen.getByLabelText('Repeat on'), { target: { value: 'weekday' } });
    expect(value()).toEqual({ weekOfMonth: 4, weekday: 4, monthOfYear: 11 });
    fireEvent.change(screen.getByLabelText('Repeat on'), { target: { value: 'date' } });
    expect(value()).toEqual({});
  });
});
