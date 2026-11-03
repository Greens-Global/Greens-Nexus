// The Tasks Calendar's today marker (live accent, 11/02/2026): the numeral
// stays in normal ink inside an orange ring - small orange text would be
// under 4.5:1 at 11px.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CalendarView } from './views/extras';

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => false }) }));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

describe('CalendarView today', () => {
  it('rings today in the live accent with the numeral in ink', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 2, 12, 0));
    render(<CalendarView tasks={[]} onOpen={vi.fn()} />);
    const today = document.querySelector('[aria-current="date"]');
    expect(today).not.toBeNull();
    expect(today.textContent).toBe('2');
    expect(today.style.boxShadow).toContain('var(--wk-live)');
    expect(today.style.color).not.toContain('--wk-live');
    expect(today.style.background).toBe('transparent');
  });
});
