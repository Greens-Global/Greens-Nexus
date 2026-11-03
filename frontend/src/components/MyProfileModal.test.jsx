import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';

// Profile (Oct 28 2026): who you are on top, four sections on the left -
// Appearance first; a task email's "Email Settings" link opens Task Emails.
const apiSpies = vi.hoisted(() => ({}));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (apiSpies[k] ||= vi.fn(() => Promise.resolve({}))) }),
}));
vi.mock('../tasks/MyEmailSettings', () => ({ default: () => <div>Email settings form</div> }));
// The Security section asks before signing every other device out (ui/dialog).
const dialogSpies = vi.hoisted(() => ({ confirm: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../ui/dialog', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, dialog: { ...real.dialog, confirm: dialogSpies.confirm } };
});

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
  // jsdom has no push APIs: fake exactly the ones the rows read, like pwa.test.jsx.
  function fakePush(permission = 'default') {
    const reg = { pushManager: { getSubscription: vi.fn(() => Promise.resolve(null)), subscribe: vi.fn() }, scope: '/' };
    Object.defineProperty(navigator, 'serviceWorker', { value: { register: vi.fn(() => Promise.resolve(reg)), ready: Promise.resolve(reg) }, configurable: true });
    window.PushManager = function PushManager() {};
    window.Notification = { permission, requestPermission: vi.fn(() => Promise.resolve(permission)) };
    import.meta.env.VITE_PWA_DEV = '1';
  }
  afterEach(() => { delete navigator.serviceWorker; delete window.PushManager; delete window.Notification; });

  it('is the last section; with no push keys on the server it says to ask the administrator and keeps the switch off', async () => {
    fakePush();
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: false, publicKey: '' }));
    render(<MyProfileModal onClose={() => {}} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent.trim()).filter((t) => /Appearance|Date & Time|Email Signature|Task Emails|Phone Notifications/.test(t));
    expect(names.slice(0, 5)).toEqual(['Appearance', 'Date & Time', 'Email Signature', 'Task Emails', 'Phone Notifications']);
    fireEvent.click(screen.getByRole('button', { name: /Phone Notifications/ }));
    expect(screen.getByRole('heading', { name: 'Phone Notifications' })).toBeTruthy();
    expect(screen.getByText('Install Nexus')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Not set up for the company yet. Ask your administrator.')).toBeTruthy());
    expect(screen.queryByText(/push keys/)).toBeNull();
    const sw = screen.getByRole('switch', { name: /Push to This Device/ });
    expect(sw.checked).toBe(false);
    expect(sw.disabled).toBe(true);
  });

  it('a browser without push says so, and an installed iPhone on an old iOS says to update it', async () => {
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    const { unmount } = render(<MyProfileModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Phone Notifications/ }));
    expect(screen.getByText(/Not available in this browser/)).toBeTruthy();
    unmount();
    // Installed (standalone): display-mode matches; useIsMobile's media query does not.
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((q) => ({ matches: /standalone/.test(q), addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
    render(<MyProfileModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Phone Notifications/ }));
    expect(screen.getByText('Not available on this phone. Update it to iOS 16.4 or later.')).toBeTruthy();
    expect(screen.getByText('Installed')).toBeTruthy();
    window.matchMedia = realMatchMedia;
  });

  it('blocked notifications explain how to allow them and keep the switch off', async () => {
    fakePush('denied');
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([]));
    render(<MyProfileModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Phone Notifications/ }));
    await waitFor(() => expect(screen.getByText(/Notifications are blocked for Nexus in this browser/)).toBeTruthy());
    const sw = screen.getByRole('switch', { name: /Push to This Device/ });
    expect(sw.checked).toBe(false);
    expect(sw.disabled).toBe(true);
  });
});

describe('Profile - Security (Neil, 11/02/2026)', () => {
  const SESSIONS = { sessions: [
    { id: 'h1', device: 'Windows 10/11 - Chrome', location: 'Laguna Niguel, CA, US', ip: '203.0.113.9',
      lastSeen: '2026-11-02T16:33:00+00:00', createdAt: '2026-11-01T10:00:00+00:00', current: true },
    { id: 'h2', device: 'iOS - Safari', location: '', ip: '198.51.100.7',
      lastSeen: '2026-11-01T12:00:00+00:00', createdAt: '2026-11-01T12:00:00+00:00', current: false },
  ] };
  const SIGN_INS = { signIns: [
    { id: 's1', at: '2026-11-02T16:33:00+00:00', device: 'iOS - Safari', location: 'Laguna Niguel, CA, US', ip: '198.51.100.7', isNew: true },
    { id: 's2', at: '2026-11-01T10:00:00+00:00', device: 'Windows 10/11 - Chrome', location: '', ip: '203.0.113.9', isNew: false },
  ] };
  function arm() {
    apiSpies.mySessions = vi.fn(() => Promise.resolve(SESSIONS));
    apiSpies.mySignIns = vi.fn(() => Promise.resolve(SIGN_INS));
    apiSpies.signOutOtherSessions = vi.fn(() => Promise.resolve({ signedOut: 1 }));
    apiSpies.signOutSession = vi.fn(() => Promise.resolve({ signedOut: 1, current: false }));
    dialogSpies.confirm.mockClear();
  }

  it('is a section of its own and opens straight from a bell or email link', async () => {
    arm();
    render(<MyProfileModal onClose={() => {}} initialSection="security" />);
    expect(screen.getByRole('heading', { name: 'Security' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Security/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Where You Are Signed In')).toBeTruthy();
    expect(screen.getByText('Recent Sign-Ins')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Windows 10/11 - Chrome')).toBeTruthy());
  });

  it('shows each device with its place and last seen, This Device on the current one, and New on a new sign-in', async () => {
    arm();
    render(<MyProfileModal onClose={() => {}} initialSection="security" />);
    await waitFor(() => expect(screen.getByText('This Device')).toBeTruthy());
    expect(screen.getByText(/Laguna Niguel, CA, US - 203\.0\.113\.9 - Last seen 11\/02\/2026/)).toBeTruthy();
    expect(screen.queryByText(/Unknown/)).toBeNull();                      // a blank location is simply left out
    // Only the other device gets a Sign Out of its own - this one is signed out from the menu.
    expect(screen.getAllByRole('button', { name: 'Sign Out' })).toHaveLength(1);
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
    expect(screen.getAllByText('iOS - Safari').length).toBeGreaterThan(0);
  });

  it('a device the browser did not name is "Unrecognized Device", and Sign Out says "Signing Out…" while it works', async () => {
    arm();
    apiSpies.mySessions = vi.fn(() => Promise.resolve({ sessions: [
      SESSIONS.sessions[0],
      { id: 'h3', device: '', location: '', ip: '198.51.100.9', lastSeen: '2026-11-01T12:00:00+00:00', createdAt: '2026-11-01T12:00:00+00:00', current: false },
    ] }));
    let release;
    apiSpies.signOutSession = vi.fn(() => new Promise((r) => { release = r; }));
    render(<MyProfileModal onClose={() => {}} initialSection="security" />);
    expect(await screen.findByText('Unrecognized Device')).toBeTruthy();   // Title Case, like every row title
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    expect(await screen.findByRole('button', { name: 'Signing Out…' })).toBeTruthy();   // the ellipsis character
    expect(screen.queryByText('Signing Out...')).toBeNull();
    await act(async () => { release({ signedOut: 1, current: false }); });
  });

  it('signs out one device without a dialog, and the others only after the confirm', async () => {
    arm();
    render(<MyProfileModal onClose={() => {}} initialSection="security" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign Out' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    await waitFor(() => expect(apiSpies.signOutSession).toHaveBeenCalledWith('h2'));
    expect(dialogSpies.confirm).not.toHaveBeenCalled();
    dialogSpies.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out Other Devices' }));
    await waitFor(() => expect(dialogSpies.confirm).toHaveBeenCalledTimes(1));
    expect(apiSpies.signOutOtherSessions).not.toHaveBeenCalled();
    dialogSpies.confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out Other Devices' }));
    await waitFor(() => expect(apiSpies.signOutOtherSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Signed out 1 other device\./)).toBeTruthy());
  });
});
