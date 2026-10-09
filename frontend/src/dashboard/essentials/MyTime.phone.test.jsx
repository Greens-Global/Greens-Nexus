// My Time on a phone (Oct 8): every tap target - the punch buttons and the
// Open Time Clock link - is at least 44px tall, and the punch buttons
// stretch across the row so a thumb cannot miss.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ timeStatus: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../lib/punchQueue', () => ({ punchDurable: vi.fn(), replayPending: vi.fn(), readPending: vi.fn(() => null) }));
vi.mock('../../lib/geoPosition', () => ({ punchPosition: vi.fn(async () => null) }));
vi.mock('../../lib/agentPair', () => ({ pairLocalAgent: vi.fn(async () => '') }));
vi.mock('../../components/BodModal', () => ({ default: () => null }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyTime from './MyTime.jsx';

const realMatchMedia = window.matchMedia;
function screenWidth(w) {
  window.matchMedia = (q) => {
    const maxW = /max-width:\s*(\d+)px/.exec(q);
    return { matches: !!(maxW && w <= Number(maxW[1])), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  };
}

const NOW = new Date(2026, 9, 8, 10, 30);
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TODAY = localKey(NOW);
const yesterday = localKey(new Date(NOW.getTime() - 86400000));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  apiMock.timeStatus.mockResolvedValue({
    lastPunch: { kind: 'in', at: new Date(NOW.getTime() - 60 * 60000).toISOString().slice(0, 19), localDate: TODAY },
    allowed: ['out', 'break_start'], staleOpenShift: false,
    days: { [TODAY]: { workedMin: 0, flags: ['missing_out'] }, [yesterday]: { workedMin: 480, flags: ['missing_out'] } },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.matchMedia = realMatchMedia; });

const minH = (el) => parseFloat(el.style.minHeight);

describe('My Time on a phone', () => {
  it('gives every tap target 44px and lets the punch buttons fill the row', async () => {
    screenWidth(390);
    render(<MyTime />);
    const out = await screen.findByRole('button', { name: /Punch Out/ });
    const brk = screen.getByRole('button', { name: /Start Break/ });
    expect(minH(out)).toBe(44);
    expect(minH(brk)).toBe(44);
    expect(out.style.flex).toMatch(/^1\b/);   // jsdom expands the shorthand to '1 1 0%'
    expect(minH(screen.getByRole('button', { name: /Open Time Clock/ }))).toBe(44);
  });

  it('keeps the compact desktop targets on a wide screen', async () => {
    screenWidth(1400);
    render(<MyTime />);
    const out = await screen.findByRole('button', { name: /Punch Out/ });
    expect(minH(out)).toBe(34);
    expect(out.style.flex).toMatch(/^1 /);   // the buttons share the row on every width
    expect(screen.getByRole('button', { name: /Open Time Clock/ }).style.minHeight).toBe('');
  });
});
