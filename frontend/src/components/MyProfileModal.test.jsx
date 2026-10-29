import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Profile (Oct 28 2026): who you are on top, four sections on the left -
// Appearance first; a task email's "Email Settings" link opens Task Emails.
vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
}));
vi.mock('../tasks/MyEmailSettings', () => ({ default: () => <div>Email settings form</div> }));

const MyProfileModal = (await import('./MyProfileModal')).default;

describe('Profile - sections', () => {
  it('opens on Appearance and moves to Task Emails from the list', () => {
    render(<MyProfileModal onClose={() => {}} theme="light" onThemeToggle={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect(screen.getByText('Dark Mode')).toBeTruthy();
    expect(screen.queryByText('Email settings form')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Task Emails/ }));
    expect(screen.getByText('Email settings form')).toBeTruthy();
  });

  it('opens on Task Emails when a task email link brought the person here', () => {
    render(<MyProfileModal onClose={() => {}} focusEmail />);
    expect(screen.getByText('Email settings form')).toBeTruthy();
  });
});

describe('Profile - Date Format (Oct 20 2026)', () => {
  it('offers the four formats, each with today as its example, on the US default', () => {
    render(<MyProfileModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Date & Time/ }));
    const select = screen.getByLabelText(/Date Format/);
    expect(select.value).toBe('MM/DD/YYYY');
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels.map((l) => l.split(' - ')[0])).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY']);
    expect(labels[2]).toMatch(/^YYYY-MM-DD - \d{4}-\d{2}-\d{2}$/);
    expect(labels[0]).toMatch(/\(Default\)$/);   // the US format is marked as everyone's default
  });
});
