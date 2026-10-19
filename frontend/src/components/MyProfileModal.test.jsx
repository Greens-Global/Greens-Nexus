import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Profile (Oct 15 2026): Email Settings is a collapsible section - closed by
// default, open when a task email's "Email Settings" link opened Profile.
vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
}));
vi.mock('../tasks/MyEmailSettings', () => ({ default: () => <div>Email settings form</div> }));

const MyProfileModal = (await import('./MyProfileModal')).default;

describe('Profile - Email Settings', () => {
  it('starts collapsed and opens on Show', () => {
    render(<MyProfileModal onClose={() => {}} />);
    const toggle = screen.getByRole('button', { name: /Email Settings/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Email settings form')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Email settings form')).toBeTruthy();
  });

  it('opens straight away when a task email link brought the person here', () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<MyProfileModal onClose={() => {}} focusEmail />);
    expect(screen.getByText('Email settings form')).toBeTruthy();
  });
});

describe('Profile - Date Format (Oct 20 2026)', () => {
  it('offers the four formats, each with today as its example, on the US default', () => {
    render(<MyProfileModal onClose={() => {}} />);
    const select = screen.getByLabelText(/Date Format/);
    expect(select.value).toBe('MM/DD/YYYY');
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels.map((l) => l.split(' - ')[0])).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY']);
    expect(labels[2]).toMatch(/^YYYY-MM-DD - \d{4}-\d{2}-\d{2}$/);
  });
});
