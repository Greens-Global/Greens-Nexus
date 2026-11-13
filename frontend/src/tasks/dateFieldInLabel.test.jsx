import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { DateField } from './components';

// A date box inside a <label> (Credentials' Expires On, 11/13/2026: "the
// calendar is coming up and going, it is flickering"). The calendar icon sat
// outside the date button, so a click on it opened the calendar and the label
// then forwarded the click to the button, which closed it again. The icon is
// part of the button now: one click, one calendar.
const days = () => screen.queryAllByRole('button', { name: /^\d{2}\/\d{2}\/\d{4}$/ });

describe('DateField inside a label', () => {
  it('a click on the calendar icon opens the calendar and it stays open', () => {
    const { container } = render(<label>Expires On <DateField value="2026-12-01" onChange={() => {}} /></label>);
    fireEvent.click(container.querySelector('svg'));
    expect(days().length).toBeGreaterThan(0);
  });

  it('a click on the date opens it, a second click closes it', () => {
    render(<label>Expires On <DateField value="2026-12-01" onChange={() => {}} /></label>);
    fireEvent.click(screen.getByText('12/01/2026'));
    expect(days().length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('12/01/2026'));
    expect(days()).toHaveLength(0);
  });
});
