import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

// Profile (Oct 28 2026): who you are on top, four sections on the left -
// Appearance first; a task email's "Email Settings" link opens Task Emails.
const apiSpies = vi.hoisted(() => ({}));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (apiSpies[k] ||= vi.fn(() => Promise.resolve({}))) }),
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

describe('Profile - Navigation Motion (Neil, 11/01/2026)', () => {
  it('offers Company Default (with the company value), Off, Subtle, Lively and Bold under Appearance, and a pick saves at once', async () => {
    render(<MyProfileModal onClose={() => {}} theme="light" onThemeToggle={() => {}} wkTheme="cobalt" setWkTheme={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Navigation Motion' });
    // Nothing saved for the company: its default reads Lively.
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Company Default (Lively)', 'Off', 'Subtle', 'Lively', 'Bold']);
    expect(within(group).getByRole('radio', { name: 'Company Default (Lively)' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Subtle' }));
    await waitFor(() => expect(apiSpies.saveTaskTablePrefs).toHaveBeenCalledWith('nav', { motion: 'subtle' }));
    expect(within(group).getByRole('radio', { name: 'Subtle' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Profile - Phone Notifications (Frontline Reach, 11/02/2026)', () => {
  it('lists the section and, with no push keys on the server, says so and keeps the switch off', async () => {
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: false, publicKey: '' }));
    render(<MyProfileModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Phone Notifications/ }));
    expect(screen.getByRole('heading', { name: 'Phone Notifications' })).toBeTruthy();
    expect(screen.getByText('Install Nexus')).toBeTruthy();
    await waitFor(() => expect(apiSpies.pushConfig).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Not set up yet|Not available in this browser/)).toBeTruthy());
    const sw = screen.getByRole('switch', { name: /Push to This Device/ });
    expect(sw.checked).toBe(false);
    expect(sw.disabled).toBe(true);
  });
});
