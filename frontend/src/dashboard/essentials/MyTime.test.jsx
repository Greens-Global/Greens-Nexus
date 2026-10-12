// My Time tile (Essentials, Oct 8 - the simple punch tile): the pure view
// model against the real endpoint shapes, and a render smoke that pins the
// visible words, every punch (Punch In included - no hand-off), the
// beginning-of-day gate, the feedback line and the card click that opens
// Workday. A crash here would blank a saved dashboard view.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ timeStatus: vi.fn(), timeBodRecord: vi.fn() }));
const punchMock = vi.hoisted(() => ({ punchDurable: vi.fn(), replayPending: vi.fn(), readPending: vi.fn() }));
const pairMock = vi.hoisted(() => ({ pairLocalAgent: vi.fn(async () => '') }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../lib/punchQueue', () => punchMock);
vi.mock('../../lib/geoPosition', () => ({ punchPosition: vi.fn(async () => ({ lat: 1, lng: 2, accuracy_m: 5 })) }));
vi.mock('../../lib/agentPair', () => pairMock);
vi.mock('../../components/BodModal', () => ({
  default: ({ mode, onSent, onSkip, onClose }) => (
    <div data-testid="bod-modal">{mode}
      <button onClick={onSent}>Send</button><button onClick={onSkip}>Skip</button><button onClick={onClose}>Close</button>
    </div>
  ),
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyTime, { deriveMyTime } from './MyTime.jsx';

// Fixed "now": Thursday 10/08/2026 10:30 local.
const NOW = new Date(2026, 9, 8, 10, 30);
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Server stamps are UTC without a Z.
const stamp = (d) => d.toISOString().slice(0, 19);
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000);
const TODAY = localKey(NOW);

const clockedInStatus = (overrides = {}) => ({
  lastPunch: { kind: 'in', at: stamp(minsAgo(148)), localDate: TODAY },   // 8:02 AM
  allowed: ['out', 'break_start'], staleOpenShift: false,
  days: { [TODAY]: { workedMin: 0, flags: ['missing_out'], punches: [{ kind: 'in', at: stamp(minsAgo(148)), localDate: TODAY }] } },
  ...overrides,
});
const clockedOutStatus = (overrides = {}) => ({
  lastPunch: { kind: 'out', at: stamp(minsAgo(30)), localDate: TODAY }, allowed: ['in'],
  days: { [TODAY]: { workedMin: 95, punches: [] } }, bodRequired: false, ...overrides,
});

describe('deriveMyTime', () => {
  it('clocked in: label, since the clock-in, live minutes counted into today', () => {
    const vm = deriveMyTime({ status: clockedInStatus(), now: NOW });
    expect(vm.state).toBe('in');
    expect(vm.stateLabel).toBe('Clocked In');
    expect(vm.sinceLabel).toBe('since 8:02 AM');
    expect(vm.actions.map(a => a.label)).toEqual(['Punch Out', 'Start Break']);
    expect(vm.todayMin).toBe(148);
  });

  it('on break: since names the break, the live count pauses, End Break is offered', () => {
    const punches = [
      { kind: 'in', at: stamp(minsAgo(120)), localDate: TODAY },
      { kind: 'break_start', at: stamp(minsAgo(30)), localDate: TODAY },
    ];
    const status = clockedInStatus({ lastPunch: punches[1], allowed: ['break_end', 'out'], days: { [TODAY]: { workedMin: 0, flags: ['missing_out'], punches } } });
    const vm = deriveMyTime({ status, now: NOW });
    expect(vm.stateLabel).toBe('On Break');
    expect(vm.sinceLabel).toBe('since 10:00 AM');
    expect(vm.todayMin).toBe(90);
    expect(vm.actions.map(a => a.label)).toEqual(['End Break', 'Punch Out']);
  });

  it('a finished break is subtracted from the live session, and since still names the clock-in', () => {
    const punches = [
      { kind: 'in', at: stamp(minsAgo(180)), localDate: TODAY },
      { kind: 'break_start', at: stamp(minsAgo(90)), localDate: TODAY },
      { kind: 'break_end', at: stamp(minsAgo(60)), localDate: TODAY },
    ];
    const vm = deriveMyTime({ status: clockedInStatus({ lastPunch: punches[2], days: { [TODAY]: { workedMin: 0, punches } } }), now: NOW });
    expect(vm.todayMin).toBe(150);
    expect(vm.sinceLabel).toBe('since 7:30 AM');
  });

  it('clocked out: Punch In only, hours from closed segments, when the last shift ended', () => {
    const vm = deriveMyTime({ status: clockedOutStatus(), now: NOW });
    expect(vm.state).toBe('out');
    expect(vm.actions.map(a => a.label)).toEqual(['Punch In']);
    expect(vm.todayMin).toBe(95);
    expect(vm.sinceLabel).toBe('');
    expect(vm.lastOutLabel).toBe('Last clocked out at 10:00 AM');
  });

  it('a stale open shift reads as clocked out, with no misleading last-out line', () => {
    const vm = deriveMyTime({ status: clockedInStatus({ staleOpenShift: true, allowed: ['in'] }), now: NOW });
    expect(vm.state).toBe('out');
    expect(vm.stale).toBe(true);
    expect(vm.lastOutLabel).toBe('');
    expect(vm.actions.map(a => a.label)).toEqual(['Punch In']);
  });

  it('exempt: no state, no punches; no status: unknown', () => {
    expect(deriveMyTime({ status: { timeTrackingExempt: true }, now: NOW })).toMatchObject({ exempt: true, state: 'exempt', actions: [] });
    expect(deriveMyTime({ status: null, now: NOW })).toMatchObject({ state: 'unknown', actions: [], todayMin: 0 });
  });
});

describe('<MyTime /> render', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    punchMock.readPending.mockReturnValue(null);
    punchMock.replayPending.mockResolvedValue(null);
    punchMock.punchDurable.mockReset();
    apiMock.timeBodRecord.mockResolvedValue({});
    pairMock.pairLocalAgent.mockResolvedValue('');
    delete window.__nexusCapture;
  });
  afterEach(() => { vi.useRealTimers(); delete window.__nexusCapture; });

  it('clocked in: state, since, today\'s hours, the two punches - and nothing else', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    render(<MyTime />);
    expect(await screen.findByText('Clocked In')).toBeTruthy();
    expect(screen.getByText('Since 8:02 AM')).toBeTruthy();
    expect(screen.getByText('2h 28m')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Punch Out/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start Break/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open Time Clock/ })).toBeTruthy();
    // The full features stay on Workday.
    expect(screen.queryByText(/This Week|Pay Period|Next Shift|Request Time Off|Coming Up/)).toBeNull();
  });

  it('Start Break punches through the durable queue and says what it did', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_start', at: stamp(NOW), geoStatus: 'in_fence', workSiteName: 'Escondido North' }, result: {} });
    render(<MyTime />);
    const changed = vi.fn();
    window.addEventListener('nexus:timeclock-changed', changed);
    fireEvent.click(await screen.findByRole('button', { name: /Start Break/ }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(punchMock.punchDurable.mock.calls[0][0]).toMatchObject({ kind: 'break_start', pos: { lat: 1, lng: 2 } });
    expect(await screen.findByRole('status')).toHaveTextContent('Break started at 10:30 AM at Escondido North.');
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener('nexus:timeclock-changed', changed);
  });

  it('clocked out: Punch In punches right here, with the shared-PC pairing, when no message is owed', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedOutStatus());
    pairMock.pairLocalAgent.mockResolvedValue('nonce-1');
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(NOW) }, result: {} });
    render(<MyTime />);
    expect(await screen.findByText('Clocked Out')).toBeTruthy();
    expect(screen.getByText('Last clocked out at 10:00 AM')).toBeTruthy();
    expect(screen.getByText('1h 35m')).toBeTruthy();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByRole('button', { name: /Punch In/ }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(punchMock.punchDurable.mock.calls[0][0]).toMatchObject({ kind: 'in', pos: { lat: 1, lng: 2 }, extra: { pair_nonce: 'nonce-1' } });
    expect(punchMock.punchDurable.mock.calls[0][0].clickedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await screen.findByRole('status')).toHaveTextContent('Clocked in at 10:30 AM.');
    expect(nav).not.toHaveBeenCalled();          // the button is a punch, not a hand-off
    window.removeEventListener('nexus:navigate', nav);
  });

  it('Punch In with the beginning-of-day message owed: the gate first, the punch once it is sent', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedOutStatus({ bodRequired: true }));
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(NOW) }, result: {} });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch In/ }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('bod');
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('bod-modal')).toBeNull();
  });

  it('the gate\'s Skip records the already-sent marker and still punches; Close cancels the punch', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedOutStatus({ bodRequired: true }));
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(NOW) }, result: {} });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch In/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('bod-modal')).toBeNull();
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Punch In/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(apiMock.timeBodRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bod' }));
  });

  it('role-exempt from messages: Punch In skips the gate even when a message would be owed', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedOutStatus({ bodRequired: true, bodExempt: true }));
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(NOW) }, result: {} });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch In/ }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('bod-modal')).toBeNull();
  });

  it('a declined screen share holds the clock-in; the monitoring notice sends them to Time Clock', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedOutStatus());
    window.__nexusCapture = { start: async () => false };
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch In/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You need to share a screen to clock in.');
    expect(punchMock.punchDurable).not.toHaveBeenCalled();

    window.__nexusCapture = { start: async () => true };
    apiMock.timeStatus.mockResolvedValue(clockedOutStatus({ monitoring: { consentRequired: true } }));
    const calls = apiMock.timeStatus.mock.calls.length;
    window.dispatchEvent(new CustomEvent('nexus:timeclock-changed'));
    await waitFor(() => expect(apiMock.timeStatus.mock.calls.length).toBeGreaterThan(calls));
    await new Promise(r => setTimeout(r, 20));   // the re-read lands in state
    fireEvent.click(screen.getByRole('button', { name: /Punch In/ }));
    expect(await screen.findByText(/monitoring notice needs your acknowledgment/)).toBeTruthy();
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
  });

  it('Punch Out that the server asks to follow with an end-of-day message opens the EOD modal', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'out', at: stamp(NOW) }, result: { promptEod: true } });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch Out/ }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('eod');
    expect(punchMock.punchDurable.mock.calls[0][0].kind).toBe('out');
  });

  it('a refused punch shows the server\'s words inline; an unreachable one says it is parked', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValueOnce({ ok: false, error: { status: 409, message: 'Already on a break.' } });
    render(<MyTime />);
    fireEvent.click(await screen.findByRole('button', { name: /Start Break/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already on a break.');
    punchMock.punchDurable.mockResolvedValueOnce({ ok: false, unreachable: true, queued: true, error: {} });
    fireEvent.click(screen.getByRole('button', { name: /Start Break/ }));
    expect(await screen.findByText(/saved on this device/)).toBeTruthy();
  });

  it('the card opens Workday; its buttons do not', async () => {
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_start', at: stamp(NOW) }, result: {} });
    render(<MyTime />);
    await screen.findByText('Clocked In');
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByRole('button', { name: /Start Break/ }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(nav).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('2h 28m'));
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'timeclock', sub: 'overview' });
    fireEvent.click(screen.getByRole('button', { name: /Open Time Clock/ }));
    expect(nav).toHaveBeenCalledTimes(2);
    window.removeEventListener('nexus:navigate', nav);
  });

  it('a failed status call never blanks the tile, and Try Again reloads', async () => {
    apiMock.timeStatus.mockRejectedValueOnce(new Error('boom'));
    render(<MyTime />);
    expect(await screen.findByText(/Could not load your time right now/)).toBeTruthy();
    apiMock.timeStatus.mockResolvedValue(clockedInStatus());
    fireEvent.click(screen.getByRole('button', { name: /Try Again/ }));
    expect(await screen.findByText('Clocked In')).toBeTruthy();
  });
});
