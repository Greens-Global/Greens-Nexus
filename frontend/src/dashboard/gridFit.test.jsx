// Dashboard grid pass (11/05/2026): list tiles size to their content (no
// inner scrollbar, no half-cut row, no big empty tile), every widget loads
// with a skeleton instead of a spinner, and Quick Actions is off the default
// board (Neil: it repeats the green + button).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getTaskTickets: vi.fn(), getMyTicketAccess: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', can: () => true, myGrantedModules: new Set() }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import DashboardGrid, { fitTops, FIT_MIN_PX } from './DashboardGrid';
import { defaultLayoutFor } from './useDashboards';
import { WIDGETS, widgetHidden } from './widgets.jsx';
import { TicketQueueWidget } from './teamWidgets.jsx';

const overlaps = (items) => items.some(a => items.some(b => a.i !== b.i
  && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

describe('default layout', () => {
  it('leaves Quick Actions off every tier and never overlaps; the tile is retired (Neil, 11/13/2026)', () => {
    for (const tier of ['employee', 'supervisor', 'manager']) {
      const board = defaultLayoutFor(tier);
      expect(board.some(it => it.type === 'quick-actions')).toBe(false);
      expect(overlaps(board)).toBe(false);
    }
    // Retired: hidden from every board and the gallery, the key kept for saved boards.
    expect(WIDGETS['quick-actions'].retired).toBe(true);
    expect(widgetHidden(WIDGETS['quick-actions'], {})).toBe(true);
  });
});

describe('fitTops', () => {
  const ROW = 72;
  const board = [
    { i: 'kpi', x: 0, y: 0, w: 12, h: 2 },
    { i: 'list', x: 0, y: 2, w: 8, h: 5 },   // fit tile, shows one row
    { i: 'side', x: 8, y: 2, w: 4, h: 5 },
    { i: 'cal', x: 0, y: 7, w: 8, h: 5 },    // under the list
    { i: 'gap', x: 8, y: 9, w: 4, h: 2 },    // two empty rows under 'side'
  ];
  const px = { list: 150 };
  const heightOf = (it) => px[it.i] ?? it.h * ROW;

  it('pulls a tile up under a short content-fit tile and keeps every other position', () => {
    const tops = fitTops(board, heightOf, ROW);
    expect(tops.kpi).toBe(0);
    expect(tops.list).toBe(2 * ROW);
    expect(tops.side).toBe(2 * ROW);
    expect(tops.cal).toBe(2 * ROW + 150);           // straight under the list, no empty band
    expect(tops.gap).toBe(7 * ROW + 2 * ROW);        // the gap the layout left is kept
  });

  it('pushes what is below down when a tile grows past its layout height', () => {
    px.list = 6 * ROW;
    const tops = fitTops(board, heightOf, ROW);
    expect(tops.cal).toBe(2 * ROW + 6 * ROW);
    px.list = 150;
  });
});

describe('DashboardGrid fit tiles', () => {
  const layout = [{ i: 'a', type: 'ticket-queue', x: 0, y: 0, w: 4, h: 4 }, { i: 'b', type: 'kpi', x: 4, y: 0, w: 3, h: 2 }];
  const renderWidget = (it) => <div data-testid={`w-${it.i}`} />;
  const cellOf = (id) => screen.getByTestId(`w-${id}`).parentElement.parentElement.parentElement;

  it('gives a fit tile no fixed height (a floor only) outside Customize; a box tile keeps its rows', () => {
    render(<DashboardGrid layout={layout} editing={false} onLayoutChange={() => {}} renderWidget={renderWidget} fitFor={(it) => it.type === 'ticket-queue'} />);
    expect(cellOf('a').style.height).toBe('');
    expect(cellOf('a').style.minHeight).toBe(`${FIT_MIN_PX}px`);
    expect(cellOf('a').className).toContain('dash-fit');
    expect(cellOf('b').style.height).toBe(`${2 * 72}px`);
  });

  it('keeps the row grid in Customize so drag and resize still snap', () => {
    render(<DashboardGrid layout={layout} editing onLayoutChange={() => {}} renderWidget={renderWidget} fitFor={(it) => it.type === 'ticket-queue'} />);
    expect(cellOf('a').style.height).toBe(`${4 * 72}px`);
  });

  it('marks the list tiles fit and leaves stat and tool tiles as boxes', () => {
    for (const k of ['ticket-queue', 'my-work', 'my-day', 'my-team', 'notifications', 'calendar']) expect(WIDGETS[k].fit).toBe(true);
    for (const k of ['kpi', 'quick-actions', 'weather', 'team-time', 'favorites']) expect(WIDGETS[k].fit).toBeFalsy();
  });
});

describe('widget loading', () => {
  beforeEach(() => {
    apiMock.getTaskTickets.mockReturnValue(new Promise(() => {}));
    apiMock.getMyTicketAccess.mockReturnValue(new Promise(() => {}));
  });

  it('shows a skeleton, never a spinner, while its list loads', () => {
    const { container } = render(<TicketQueueWidget />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.nx-skel')).toBeTruthy();
    expect(container.querySelector('.nxl')).toBeNull();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });
});
