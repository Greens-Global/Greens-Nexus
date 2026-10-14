// The time clock engine's break prompts (Oct 14 2026): Start Break from the
// sidebar chip, the capsule or the phone sheet asks for the reason - the
// same "Going on break" prompt the Time Clock screen holds the punch behind -
// and End Break offers the resuming-work note; the punch records once the
// message is sent, the X cancels it. The sidebar chip had skipped both.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

const punchMock = vi.hoisted(() => ({ punchDurable: vi.fn(), replayPending: vi.fn(async () => null), readPending: vi.fn(() => null) }));
const timeStatus = vi.hoisted(() => ({ status: null }));
vi.mock('../lib/useTimeStatus', () => ({ useTimeStatus: () => ({ status: timeStatus.status, reload: vi.fn() }) }));
vi.mock('../lib/punchQueue', () => punchMock);
vi.mock('../lib/geoPosition', () => ({ punchPosition: vi.fn(async () => ({ lat: 1, lng: 2, accuracy_m: 5 })), keepPositionWarm: vi.fn() }));
vi.mock('../lib/bodQueue', () => ({ replayPendingBods: vi.fn(async () => {}) }));
vi.mock('../lib/pollWhileVisible', () => ({ pollWhileVisible: () => () => {} }));
vi.mock('../api', () => ({ api: { timeMySchedule: vi.fn(async () => ({ scheduled: [] })), timeShotUpload: vi.fn(async () => ({})) } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('./BodModal', () => ({
  default: ({ mode, onSent, onClose }) => (
    <div data-testid="bod-modal">{mode}<button onClick={onSent}>Send</button><button onClick={onClose}>Close</button></div>
  ),
}));

const { default: TimeclockWidget } = await import('./TimeclockWidget');
const { claimTimeclockSurface, useTimeclock } = await import('../lib/timeclockStore');

const stamp = (d) => d.toISOString().slice(0, 19);
const minsAgo = (m) => new Date(Date.now() - m * 60000);
const TODAY = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const clockedIn = (extra = {}) => ({
  lastPunch: { kind: 'in', at: stamp(minsAgo(90)), localDate: TODAY }, allowed: ['out', 'break_start'], staleOpenShift: false, days: {}, ...extra,
});
const onBreak = () => clockedIn({ lastPunch: { kind: 'break_start', at: stamp(minsAgo(10)), localDate: TODAY }, allowed: ['break_end', 'out'] });

// The phone / desktop capsule: the pill opens the chip.
const openChip = () => fireEvent.click(screen.getByTitle('Time clock - tap for controls'));

beforeEach(() => { punchMock.punchDurable.mockReset(); timeStatus.status = clockedIn(); delete window.__nexusCapture; });
afterEach(() => { cleanup(); delete window.__nexusCapture; });

describe('TimeclockWidget break prompts', () => {
  it('Start Break opens the reason prompt; the punch records once it is sent, with the moment the button was pressed', async () => {
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_start', at: stamp(new Date()) }, result: {} });
    render(<TimeclockWidget />);
    openChip();
    fireEvent.click(screen.getByRole('button', { name: 'Start Break' }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('break');
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(punchMock.punchDurable.mock.calls[0][0]).toMatchObject({ kind: 'break_start', pos: { lat: 1, lng: 2 } });
    expect(punchMock.punchDurable.mock.calls[0][0].clickedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(screen.queryByTestId('bod-modal')).toBeNull();
  });

  it('closing the prompt cancels the punch and frees the button for another try', async () => {
    render(<TimeclockWidget />);
    openChip();
    fireEvent.click(screen.getByRole('button', { name: 'Start Break' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('bod-modal')).toBeNull();
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
    openChip();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Break' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Start Break' }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('break');
  });

  it('Resume from a break gets the resuming-work prompt', async () => {
    timeStatus.status = onBreak();
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_end', at: stamp(new Date()) }, result: {} });
    render(<TimeclockWidget />);
    openChip();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByTestId('bod-modal')).toHaveTextContent('break_end');
    expect(punchMock.punchDurable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(punchMock.punchDurable.mock.calls[0][0].kind).toBe('break_end');
  });

  it('a role-flagged person (bodExempt) starts the break with no prompt', async () => {
    timeStatus.status = clockedIn({ bodExempt: true });
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_start', at: stamp(new Date()) }, result: {} });
    render(<TimeclockWidget />);
    openChip();
    fireEvent.click(screen.getByRole('button', { name: 'Start Break' }));
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('bod-modal')).toBeNull();
    expect(punchMock.punchDurable.mock.calls[0][0].clickedAt).toBeUndefined();
  });

  it('with the sidebar chip holding the shift, the engine draws nothing but still opens the prompt for its Start Break', async () => {
    const release = claimTimeclockSurface();
    // The sidebar chip: a subscriber that presses the engine's own action.
    function Chip() { const vm = useTimeclock(); return <button onClick={() => vm.actions?.toggleBreak()}>Chip Break</button>; }
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'break_start', at: stamp(new Date()) }, result: {} });
    try {
      const { container } = render(<><TimeclockWidget /><Chip /></>);
      expect(container.querySelector('.tc-capsule')).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Chip Break' })); });
      expect(await screen.findByTestId('bod-modal')).toHaveTextContent('break');
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    } finally { release(); }
  });
});
