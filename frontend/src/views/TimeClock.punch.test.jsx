import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

// The Workday punch card, 11/17/2026:
// - A clock-in that is backed out of (Not Yet on Early Clock-In, the
//   beginning-of-day prompt closed, Cancel on the monitoring notice) stops
//   the screen share that was started for it inside the tap - the browser
//   kept saying "sharing your screen" while the person was clocked out.
// - A parked punch that another surface landed (the sidebar chip, the phone
//   capsule) clears "still hasn't recorded" without a reload, and Retry Now
//   never sends it a second time.

const punch = vi.hoisted(() => ({
  punchDurable: vi.fn(), replayPending: vi.fn(async () => null), readPending: vi.fn(() => null),
  utcStamp: () => '2026-11-17T17:00:00', holdPunch: vi.fn((_, run) => run()), signedIn: vi.fn(async () => true),
}));
const time = vi.hoisted(() => ({ status: null, reload: vi.fn() }));
const confirmAsk = vi.hoisted(() => vi.fn());

vi.mock('../lib/punchQueue', () => punch);
vi.mock('../lib/useTimeStatus', () => ({
  useTimeStatus: () => ({ status: time.status, error: null, errorAt: 0, reload: time.reload }), patchTimeStatus: vi.fn(),
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a), alert: vi.fn(), prompt: vi.fn(), undo: vi.fn() } }));
vi.mock('../lib/geoPosition', () => ({ getPosition: vi.fn(async () => null), punchPosition: vi.fn(async () => null) }));
vi.mock('../lib/punchLocation', () => ({ askPunchPosition: vi.fn(async () => ({ pos: null, locationOff: false })) }));
vi.mock('../lib/agentPair', () => ({ pairLocalAgent: vi.fn(async () => '') }));
vi.mock('../lib/bodQueue', () => ({ replayPendingBods: vi.fn(async () => {}), bodDurable: vi.fn(async () => ({})) }));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: new Set(), myEmail: 'max@x.com', canAccessModule: () => true }),
}));
vi.mock('./MyHR', () => ({ MyHROverview: ({ clock }) => <div>{clock().card}</div> }));
vi.mock('../components/PayrollTimecard', () => ({ default: () => null }));
vi.mock('../components/DocumentsToSign', () => ({ default: () => null }));
vi.mock('../construction/PunchCostCode', () => ({ default: () => null }));
vi.mock('../components/BodModal', () => ({
  default: ({ mode, onSent, onClose, toastErr }) => (
    <div data-testid="bod-modal">{mode}<button onClick={onSent}>Send Message</button><button onClick={onClose}>Close Prompt</button>
      <button onClick={() => toastErr('Add a short reason.')}>Send Empty</button></div>
  ),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, key) => () => Promise.resolve(key === 'timesheetReviewWaiting' ? { toSign: [] } : key === 'timeMonitoringConsent' ? {} : []) });
  return { api, default: api };
});

const SLOW = 20000;
const out = (extra = {}) => ({
  lastPunch: null, allowed: ['in'], staleOpenShift: false, days: {}, timeTrackingExempt: false, bodExempt: true, ...extra,
});
const stamp = (d) => d.toISOString().slice(0, 19);
const mount = async () => {
  const TimeClock = (await import('./TimeClock')).default;
  render(<TimeClock initialTab="overview" activeSub="overview" onSubChange={() => {}} />);
};
const punchIn = () => screen.getByRole('button', { name: /Punch In/ });

let capture;
beforeEach(() => {
  capture = { start: vi.fn(async () => true), stop: vi.fn() };
  window.__nexusCapture = capture;
  punch.punchDurable.mockReset();
  punch.replayPending.mockReset().mockResolvedValue(null);
  punch.readPending.mockReset().mockReturnValue(null);
  time.reload.mockReset();
  confirmAsk.mockReset().mockResolvedValue(true);
  time.status = out();
});
afterEach(() => { cleanup(); delete window.__nexusCapture; });

describe('Workday punch - a clock-in backed out of stops the screen share', () => {
  it('Not Yet on Early Clock-In', async () => {
    time.status = out({ earlyWarning: { shiftStartUtc: new Date(Date.now() + 90 * 60000).toISOString(), shiftStart: '09:00', warnBeforeMin: 10 } });
    confirmAsk.mockResolvedValue(false);
    await mount();
    fireEvent.click(punchIn());
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(capture.stop).toHaveBeenCalledTimes(1));
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(punch.punchDurable).not.toHaveBeenCalled();
  }, SLOW);

  it('closing the beginning-of-day prompt', async () => {
    time.status = out({ bodExempt: false });
    await mount();
    fireEvent.click(punchIn());
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('bod');
    expect(capture.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Prompt' }));
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(punch.punchDurable).not.toHaveBeenCalled();
  }, SLOW);

  it('Cancel on the monitoring notice - and Acknowledge keeps the share', async () => {
    time.status = out({ monitoring: { consentRequired: true, text: 'This device is monitored.' } });
    punch.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(new Date()) } });
    await mount();
    fireEvent.click(punchIn());
    expect(await screen.findByText('This device is monitored.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(punch.punchDurable).not.toHaveBeenCalled();
    // Going through with it: the share stays for the shift.
    fireEvent.click(punchIn());
    await screen.findByText('This device is monitored.');
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand and agree/ }));
    fireEvent.click(screen.getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(punch.punchDurable).toHaveBeenCalledTimes(1));
    expect(capture.stop).toHaveBeenCalledTimes(1);
  }, SLOW);

  it('a refused clock-in stops it too; closing a break prompt does not (the shift is still open)', async () => {
    punch.punchDurable.mockResolvedValue({ ok: false, error: { status: 403, message: 'Punching is turned off for you.' } });
    await mount();
    fireEvent.click(punchIn());
    expect(await screen.findByText('Punching is turned off for you.')).toBeTruthy();
    expect(capture.stop).toHaveBeenCalledTimes(1);
    cleanup();
    capture.stop.mockClear();
    time.status = out({ bodExempt: false, allowed: ['break_end', 'out'], lastPunch: { kind: 'break_start', at: stamp(new Date(Date.now() - 600000)) } });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /End Break/ }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('break_end');
    fireEvent.click(screen.getByRole('button', { name: 'Close Prompt' }));
    expect(capture.stop).not.toHaveBeenCalled();
  }, SLOW);
});

// The prompt's own complaint used to be drawn in the page, under its scrim.
describe('Workday punch - a message while a prompt is open', () => {
  it('draws "Add a short reason." over the prompt\'s scrim, and back in the page once it closes', async () => {
    time.status = out({ bodExempt: false, allowed: ['out', 'break_start'], lastPunch: { kind: 'in', at: stamp(new Date(Date.now() - 3600000)) } });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Start Break/ }));
    await screen.findByTestId('bod-modal');
    fireEvent.click(screen.getByRole('button', { name: 'Send Empty' }));
    const line = screen.getByText('Add a short reason.');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.style.position).toBe('fixed');
    expect(Number(line.style.zIndex)).toBeGreaterThan(1440);   // the prompt's scrim is 1420, the notices 1440
    fireEvent.click(screen.getByRole('button', { name: 'Close Prompt' }));
    expect(screen.getByText('Add a short reason.').style.position).toBe('');
  }, SLOW);
});

describe('Workday punch - a parked punch another surface landed', () => {
  const parked = { kind: 'in', at: '2026-11-17T16:55:00' };

  it('clears "still hasn\'t recorded" once the punch is no longer pending, without a reload', async () => {
    punch.readPending.mockReturnValue(parked);        // saved on this device, the server still unreachable
    await mount();
    expect(await screen.findByText(/still\s+hasn.t recorded/)).toBeTruthy();
    await waitFor(() => expect(punch.replayPending).toHaveBeenCalled());
    // The sidebar chip lands it: nothing is pending any more, and it says a punch changed.
    punch.readPending.mockReturnValue(null);
    act(() => { window.dispatchEvent(new CustomEvent('nexus:timeclock-changed')); });
    await waitFor(() => expect(screen.queryByText(/still\s+hasn.t recorded/)).toBeNull(), { timeout: 4000 });
    expect(punch.punchDurable).not.toHaveBeenCalled();
  }, SLOW);

  it('Retry Now never sends a fresh punch for one that was saved and has since landed', async () => {
    punch.readPending.mockReturnValue(parked);
    await mount();
    const retry = await screen.findByRole('button', { name: 'Retry Now' });
    await waitFor(() => expect(punch.replayPending).toHaveBeenCalled());
    punch.readPending.mockReturnValue(null);
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry Now' })).toBeNull());
    expect(punch.punchDurable).not.toHaveBeenCalled();
    expect(time.reload).toHaveBeenCalled();
  }, SLOW);
});
