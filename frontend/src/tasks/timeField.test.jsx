import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// TimeField (Oct 21 2026): a 12-hour time box that reads "9:00 AM" whatever
// the computer's region - the replacement for native time / datetime-local
// boxes, which show 21:00 on an Indian laptop. Values stay 'HH:MM' (24-hour).

vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
const { TimeField } = await import('./components');

describe('TimeField', () => {
  it('shows 12-hour times and hands back 24-hour HH:MM', () => {
    const onChange = vi.fn();
    render(<TimeField value="21:00" onChange={onChange} ariaLabel="When" />);
    const box = screen.getByLabelText('When');
    expect(box.selectedOptions[0].textContent).toBe('9:00 PM');
    expect([...box.options].some((o) => o.textContent === '12:00 AM')).toBe(true);
    fireEvent.change(box, { target: { value: '09:15' } });
    expect(onChange).toHaveBeenCalledWith('09:15');
  });

  it('keeps a saved time that is off the quarter-hour grid', () => {
    render(<TimeField value="10:07" onChange={() => {}} ariaLabel="When" />);
    expect(screen.getByLabelText('When').selectedOptions[0].textContent).toBe('10:07 AM');
  });

  it('asks for a time when there is none', () => {
    render(<TimeField value="" onChange={() => {}} ariaLabel="When" />);
    expect(screen.getByLabelText('When').selectedOptions[0].textContent).toBe('Pick a time');
  });
});
