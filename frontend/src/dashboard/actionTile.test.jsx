// Single-action tiles and the grid changes around them (Oct 11): the Action
// Tile renders each choice and opens its composer / screen, the Punch tile
// shows the next punch and records it through the shared hook, a time-
// tracking-exempt person never gets a punch tile placed or offered, the phone
// stack pairs compact tiles two across, a duplicate lands in the nearest free
// spot, and the gallery's size words. A crash in any of these would blank a
// saved dashboard view, so the tiles are mounted for real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ timeStatus: vi.fn(), timeBodRecord: vi.fn() }));
const punchMock = vi.hoisted(() => ({ punchDurable: vi.fn(), holdPunch: vi.fn((_, run) => run()), signedIn: vi.fn(async () => true), replayPending: vi.fn(), readPending: vi.fn(() => null) }));
const roleMock = vi.hoisted(() => ({ timeTrackingExempt: false }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../lib/punchQueue', () => punchMock);
vi.mock('../lib/geoPosition', () => ({ punchPosition: vi.fn(async () => ({ lat: 1, lng: 2, accuracy_m: 5 })) }));
vi.mock('../lib/agentPair', () => ({ pairLocalAgent: vi.fn(async () => '') }));
vi.mock('../components/BodModal', () => ({ default: () => null }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', timeTrackingExempt: roleMock.timeTrackingExempt }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));
// The composers are a heavy lazy chunk; a stub proves the tile opened the right one.
vi.mock('./QuickActionModals.jsx', () => ({ default: ({ kind, onClose }) => <div data-testid="composer">{kind}<button onClick={() => onClose({ toast: 'Sent.' })}>Done</button></div> }));

import { WIDGETS, ACTION_CHOICES, QUICK_ACTIONS, SHORTCUT_TARGETS, widgetHidden, sizeLabel, clampToLimits } from './widgets.jsx';
import { stackRows } from './DashboardGrid.jsx';
import { firstFreeSpot } from './useDashboards.js';
import { nextPunch, deriveMyTime } from './essentials/usePunchClock.jsx';
import { configValid } from './WidgetGallery.jsx';
import { queryClient } from '../lib/queryClient';

const NOW = new Date(2026, 9, 11, 10, 30);
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const stamp = (d) => d.toISOString().slice(0, 19);
const TODAY = localKey(NOW);
const Action = WIDGETS.action.render;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();   // call counts start at zero in every test
  queryClient.clear();  // the punch tiles read the shared /timeclock/status query
  roleMock.timeTrackingExempt = false;
  punchMock.readPending.mockReturnValue(null);
  apiMock.timeStatus.mockResolvedValue({ lastPunch: { kind: 'out', at: stamp(new Date(NOW.getTime() - 60 * 60000)), localDate: TODAY }, allowed: ['in'], days: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Action Tile catalog', () => {
  it('is the smallest tile: one row tall, compact, offered to everyone, and lists the punch first then every quick action', () => {
    const def = WIDGETS.action;
    expect(def.limits).toEqual({ minW: 2, minH: 1, maxW: 4, maxH: 2 });
    expect(def.compact).toBe(true);
    expect(def.minRole).toBeUndefined();
    expect(ACTION_CHOICES[0].key).toBe('punch');
    expect(ACTION_CHOICES.slice(1)).toEqual(QUICK_ACTIONS);
    // A one-row layout item survives the clamp (the old grid floor was two rows).
    expect(clampToLimits({ type: 'action', x: 0, y: 0, w: 2, h: 1 }).h).toBe(1);
  });

  it('config needs an action; the gallery size words follow the iOS vocabulary', () => {
    expect(configValid('action', { action: 'task' })).toBe(true);
    expect(configValid('action', {})).toBe(false);
    expect(sizeLabel({ w: 2, h: 2 })).toBe('Small');
    expect(sizeLabel({ w: 4, h: 4 })).toBe('Medium');
    expect(sizeLabel({ w: 6, h: 5 })).toBe('Large');
    expect(sizeLabel({ w: 8, h: 5 })).toBe('Wide');
  });

  it('every shortcut destination carries its own icon', () => {
    for (const t of SHORTCUT_TARGETS) expect(t.Icon, t.label).toBeTruthy();
  });
});

describe('Action Tile render', () => {
  it('a composer action is one button that opens its composer and reports back', async () => {
    render(<Action config={{ action: 'ticket' }} size={{ w: 2, h: 2 }} />);
    const btn = screen.getByRole('button', { name: /New Ticket/ });
    expect(btn.className).toContain('dk-action');
    expect(btn.className).not.toContain('dk-action--row');
    fireEvent.click(btn);
    expect(await screen.findByTestId('composer')).toHaveTextContent('ticket');
    fireEvent.click(screen.getByText('Done'));
    expect(await screen.findByText('Sent.')).toBeTruthy();
  });

  it('one row tall it is a pill; a screen action navigates; an unknown action falls back to New Task', () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    render(<Action config={{ action: 'time-off' }} size={{ w: 2, h: 1 }} />);
    const btn = screen.getByRole('button', { name: /Request Time Off/ });
    expect(btn.className).toContain('dk-action--row');
    fireEvent.click(btn);
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'timeclock', sub: 'timeoff' });
    window.removeEventListener('nexus:navigate', nav);
    cleanup();
    render(<Action config={{ action: 'gone' }} size={{ w: 2, h: 2 }} />);
    expect(screen.getByRole('button', { name: /New Task/ })).toBeTruthy();
  });

  it('the punch tile shows the next punch with the day as its caption and records it for real', async () => {
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(NOW), geoStatus: 'in_fence', workSiteName: 'Main Office' } });
    render(<Action config={{ action: 'punch' }} size={{ w: 2, h: 2 }} />);
    const btn = await screen.findByRole('button', { name: /Punch In/ });
    expect(btn).toHaveTextContent('Last clocked out at 9:30 AM');
    fireEvent.click(btn);
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    expect(punchMock.punchDurable.mock.calls[0][0].kind).toBe('in');
    // Shown on the tile and announced from a live region outside the button.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Clocked in at 10:30 AM at Main Office/));
    expect(btn).toHaveTextContent(/Clocked in at 10:30 AM at Main Office/);
    expect(btn.contains(screen.getByRole('status'))).toBe(false);
  });

  it('a double tap records one punch, and the tile stays busy (focusable) until the fresh status is in', async () => {
    let releaseStatus;
    punchMock.punchDurable.mockResolvedValue({ ok: true, punch: { kind: 'in', at: stamp(NOW) } });
    render(<Action config={{ action: 'punch' }} size={{ w: 2, h: 2 }} />);
    const btn = await screen.findByRole('button', { name: /Punch In/ });
    // The reload after the punch hangs until released.
    apiMock.timeStatus.mockImplementation(() => new Promise(r => { releaseStatus = r; }));
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(punchMock.punchDurable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(releaseStatus).toBeTypeOf('function'));
    // Punch recorded, status not back yet: still busy, never disabled, focus kept.
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(punchMock.punchDurable).toHaveBeenCalledTimes(1);
    releaseStatus({ lastPunch: { kind: 'in', at: stamp(NOW) }, allowed: ['out', 'break_start'], days: {} });
    expect(await screen.findByRole('button', { name: /Punch Out/ })).not.toHaveAttribute('aria-disabled');
  });

  it('a failed punch is announced as an alert', async () => {
    punchMock.punchDurable.mockResolvedValue({ ok: false, error: { message: 'Punch failed.' } });
    render(<Action config={{ action: 'punch' }} size={{ w: 2, h: 2 }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Punch In/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Punch failed.'));
  });

  it('a known failure reads in a few words on the tile (no tooltip on a phone)', async () => {
    window.__nexusCapture = { start: async () => false, stop: vi.fn() };
    try {
      render(<Action config={{ action: 'punch' }} size={{ w: 2, h: 1 }} />);
      fireEvent.click(await screen.findByRole('button', { name: /Punch In/ }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Share a screen to clock in.'));
      expect(punchMock.punchDurable).not.toHaveBeenCalled();
    } finally { delete window.__nexusCapture; }
  });

  it('on a break the one punch is End Break; clocked in it is Punch Out with hours so far', () => {
    const at = stamp(new Date(NOW.getTime() - 20 * 60000));
    let vm = deriveMyTime({ status: { lastPunch: { kind: 'break_start', at }, allowed: ['break_end', 'out'], days: {} }, now: NOW });
    expect(nextPunch(vm).kind).toBe('break_end');
    vm = deriveMyTime({ status: { lastPunch: { kind: 'in', at }, allowed: ['out', 'break_start'], days: {} }, now: NOW });
    expect(nextPunch(vm).kind).toBe('out');
    expect(nextPunch(deriveMyTime({ status: null, now: NOW }))).toBeNull();
  });

  it('a time-tracking-exempt person: the punch tile is hidden from the board, the type itself is still offered', () => {
    const exempt = { timeTrackingExempt: true };
    expect(widgetHidden(WIDGETS.action, exempt, { action: 'punch' })).toBe(true);
    expect(widgetHidden(WIDGETS.action, exempt, { action: 'task' })).toBe(false);
    expect(widgetHidden(WIDGETS.action, exempt)).toBe(false);            // the gallery asks about the type
    expect(widgetHidden(WIDGETS['my-time'], exempt)).toBe(true);          // unchanged for the plain punch tiles
    expect(widgetHidden(WIDGETS.action, { timeTrackingExempt: false }, { action: 'punch' })).toBe(false);
  });
});

describe('phone stack pairing and duplicates', () => {
  const compact = new Set(['a', 'b', 'c', 'e']);
  const isCompact = (it) => compact.has(it.i);
  it('pairs consecutive compact tiles of one height two across and keeps everything else on its own row', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e'].map(i => ({ i, h: 2 }));
    const rows = stackRows(ordered, isCompact).map(r => r.map(it => it.i));
    expect(rows).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
    expect(stackRows([], isCompact)).toEqual([]);
    // A one-row pill never pairs with a two-row stat (it would leave a half-cell gap).
    const mixed = [{ i: 'a', h: 2 }, { i: 'b', h: 1 }, { i: 'c', h: 1 }];
    expect(stackRows(mixed, isCompact).map(r => r.map(it => it.i))).toEqual([['a'], ['b', 'c']]);
  });

  it('a duplicate lands in the first free spot from the original’s row', () => {
    const items = [
      { i: 'k1', x: 0, y: 0, w: 3, h: 2 }, { i: 'k2', x: 3, y: 0, w: 3, h: 2 }, { i: 'k3', x: 6, y: 0, w: 3, h: 2 },
      { i: 'big', x: 0, y: 2, w: 12, h: 4 },
    ];
    // Room left on row 0: the copy slides in beside the originals.
    expect(firstFreeSpot(items, { i: 'n', w: 3, h: 2 }, 0)).toMatchObject({ x: 9, y: 0 });
    // Row 0 full: the next row with room, below the wide card.
    const full = [...items, { i: 'k4', x: 9, y: 0, w: 3, h: 2 }];
    expect(firstFreeSpot(full, { i: 'n', w: 3, h: 2 }, 0)).toMatchObject({ x: 0, y: 6 });
    // Never overlapping, never off the right edge.
    const spot = firstFreeSpot(full, { i: 'n', w: 12, h: 1 }, 2);
    expect(spot.x + spot.w).toBeLessThanOrEqual(12);
    expect(spot.y).toBeGreaterThanOrEqual(6);
  });
});
