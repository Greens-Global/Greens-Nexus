import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Profile > Date & Time (11/13/2026): My Time Zone and Working Hours, kept on
// the person's own People record through the My HR self-service save. Both
// are selects, so each saves on change; working hours save as a pair.
const apiSpies = vi.hoisted(() => ({}));
const me = vi.hoisted(() => ({ profile: {} }));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (apiSpies[k] ||= vi.fn(() => Promise.resolve({}))) }),
}));
vi.mock('../tasks/MyEmailSettings', () => ({ default: () => <div>Email settings form</div> }));

const MyProfileModal = (await import('./MyProfileModal')).default;
const { canonicalTz } = await import('../lib/worldClockZones');

const PROFILE = { firstName: 'Priya', lastName: 'Patel', workEmail: 'priya@example.com', timeZone: '', workStart: '', workEnd: '',
  detectedTimeZone: 'Asia/Kolkata' };
const INDIA = canonicalTz('Asia/Kolkata');
const NEW_YORK = canonicalTz('America/New_York');

beforeEach(() => {
  me.profile = { ...PROFILE };
  apiSpies.myHrProfile = vi.fn(() => Promise.resolve(me.profile));
  apiSpies.myHrProfileSave = vi.fn((body) => {
    me.profile = { ...me.profile,
      ...(body.time_zone !== undefined ? { timeZone: body.time_zone } : {}),
      ...(body.work_start !== undefined ? { workStart: body.work_start, workEnd: body.work_end } : {}) };
    return Promise.resolve(me.profile);
  });
});
afterEach(() => cleanup());

const openTime = async () => {
  render(<MyProfileModal onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Date & Time/ }));
  return screen.findByLabelText('My Time Zone');
};

describe('Profile - My Time Zone', () => {
  it('shows the detected zone until one is picked, and a pick saves at once', async () => {
    const select = await openTime();
    expect(select.value).toBe('');
    expect(select.options[0].textContent).toMatch(/^Detected: /);
    expect(select.options[0].textContent).toMatch(/India/);
    expect([...select.options].some((o) => o.value === NEW_YORK)).toBe(true);
    fireEvent.change(select, { target: { value: NEW_YORK } });
    await waitFor(() => expect(apiSpies.myHrProfileSave).toHaveBeenCalledWith({ time_zone: NEW_YORK }));
    await waitFor(() => expect(screen.getByLabelText('My Time Zone').value).toBe(NEW_YORK));
    expect(screen.getByText('Saved.')).toBeTruthy();
    // Back to Detected clears it.
    fireEvent.change(screen.getByLabelText('My Time Zone'), { target: { value: '' } });
    await waitFor(() => expect(apiSpies.myHrProfileSave).toHaveBeenLastCalledWith({ time_zone: '' }));
  });

  it('shows the stored zone, in this browser\'s own spelling of it', async () => {
    me.profile = { ...PROFILE, timeZone: 'Asia/Kolkata' };
    const select = await openTime();
    expect(select.value).toBe(INDIA);
  });

  it('a refused save says why and keeps what was there', async () => {
    const select = await openTime();
    apiSpies.myHrProfileSave = vi.fn(() => Promise.reject(new Error('Pick a time zone from the list.')));
    fireEvent.change(select, { target: { value: NEW_YORK } });
    expect(await screen.findByText('Pick a time zone from the list.')).toBeTruthy();
    expect(screen.getByLabelText('My Time Zone').value).toBe('');
  });

  it('is not offered to someone with no People record', async () => {
    apiSpies.myHrProfile = vi.fn(() => Promise.reject(Object.assign(new Error('No HR record is linked to your account yet - ask HR to add you.'), { status: 404 })));
    render(<MyProfileModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Date & Time/ }));
    await waitFor(() => expect(apiSpies.myHrProfile).toHaveBeenCalled());
    expect(screen.queryByLabelText('My Time Zone')).toBeNull();
    expect(screen.getByText("This Device's Time Zone")).toBeTruthy();
  });
});

describe('Profile - Working Hours', () => {
  it('reads 12-hour times and saves once both ends are picked', async () => {
    await openTime();
    const start = screen.getByLabelText('Working Hours Start');
    const end = screen.getByLabelText('Working Hours End');
    expect(start.value).toBe('');
    expect([...start.options].map((o) => o.textContent).slice(0, 3)).toEqual(['Not Set', '12:00 AM', '12:30 AM']);
    fireEvent.change(start, { target: { value: '09:00' } });
    expect(screen.getByText('Pick the other time to save.')).toBeTruthy();
    expect(apiSpies.myHrProfileSave).not.toHaveBeenCalled();
    fireEvent.change(end, { target: { value: '18:00' } });
    await waitFor(() => expect(apiSpies.myHrProfileSave).toHaveBeenCalledWith({ work_start: '09:00', work_end: '18:00' }));
    await waitFor(() => expect(screen.getByLabelText('Working Hours End').value).toBe('18:00'));
    expect(screen.getByLabelText('Working Hours Start').selectedOptions[0].textContent).toBe('9:00 AM');
  });

  it('the same time twice is not a working day, and clearing both saves the pair empty', async () => {
    me.profile = { ...PROFILE, workStart: '09:00', workEnd: '18:00' };
    await openTime();
    fireEvent.change(screen.getByLabelText('Working Hours End'), { target: { value: '09:00' } });
    expect(screen.getByText('The start and end cannot be the same time.')).toBeTruthy();
    expect(apiSpies.myHrProfileSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Working Hours End'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Working Hours Start'), { target: { value: '' } });
    await waitFor(() => expect(apiSpies.myHrProfileSave).toHaveBeenCalledWith({ work_start: '', work_end: '' }));
  });
});

describe('Profile - Appearance follows the account', () => {
  it('Dark Mode says it follows the account, not "this device"', () => {
    render(<MyProfileModal onClose={() => {}} theme="light" onThemeToggle={() => {}} />);
    const desc = document.getElementById('profile-dark-desc');
    expect(desc.textContent).toMatch(/follows your account/);
    expect(desc.textContent).not.toMatch(/on this device/);
  });
});
