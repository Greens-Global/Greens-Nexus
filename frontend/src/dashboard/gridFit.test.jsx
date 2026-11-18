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

import DashboardGrid, { fitTops, FIT_MIN_PX, PHONE_FIT_FLOOR_PX } from './DashboardGrid';
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

// Phone stack sizing (11/17/2026): a list that scrolls in its box shrinks to
// what it shows, never past its board height; the Weather tile is as tall as
// its phone layout. The desktop board is untouched by either.
describe('DashboardGrid phone stack sizing', () => {
  const layout = [
    { i: 'fav', type: 'favorites', x: 0, y: 0, w: 4, h: 5 },
    { i: 'wx', type: 'weather', x: 0, y: 5, w: 4, h: 6 },
    { i: 'kpi', type: 'kpi', x: 0, y: 11, w: 3, h: 2 },
  ];
  const renderWidget = (it) => <div data-testid={`w-${it.i}`} />;
  const cellOf = (id) => screen.getByTestId(`w-${id}`).parentElement.parentElement.parentElement;
  const phoneFitFor = (it) => WIDGETS[it.type]?.phoneFit || null;

  it('caps a shrink tile at its board height and lets a content tile take its own', () => {
    render(<DashboardGrid layout={layout} editing={false} stacked onLayoutChange={() => {}} renderWidget={renderWidget} phoneFitFor={phoneFitFor} compactFor={(it) => it.type === 'kpi'} />);
    const fav = cellOf('fav').style;
    expect(fav.height).toBe('');
    expect(fav.maxHeight).toBe(`${5 * 72}px`);
    expect(fav.minHeight).toBe(`${PHONE_FIT_FLOOR_PX}px`);
    expect(fav.gridTemplateRows).toBe('minmax(0, 1fr)');
    const wx = cellOf('wx').style;
    expect(wx.height).toBe('');
    expect(wx.maxHeight).toBe('');
    expect(wx.minHeight).toBe(`${PHONE_FIT_FLOOR_PX}px`);
    expect(cellOf('kpi').style.height).toBe(`${2 * 72}px`);   // a stat tile keeps its box
  });

  it('leaves the desktop board as it was', () => {
    render(<DashboardGrid layout={layout} editing={false} onLayoutChange={() => {}} renderWidget={renderWidget} phoneFitFor={phoneFitFor} />);
    expect(cellOf('fav').style.height).toBe(`${5 * 72}px`);
    expect(cellOf('wx').style.height).toBe(`${6 * 72}px`);
  });

  it('makes a compact tile with no partner one row; a pair keeps its boxes; the hero stays the hero', () => {
    const board = [
      { i: 'lone', type: 'kpi', x: 0, y: 0, w: 3, h: 2, config: { metric: 'my_open_tasks' } },
      { i: 'list', type: 'favorites', x: 0, y: 2, w: 4, h: 5 },
      { i: 'p1', type: 'team-attendance', x: 0, y: 7, w: 3, h: 2 },
      { i: 'p2', type: 'time-off', x: 3, y: 7, w: 3, h: 2 },
      { i: 'hero', type: 'kpi', x: 0, y: 9, w: 8, h: 2, config: { metric: 'my_open_tasks', hero: true } },
    ];
    const seen = {};
    render(<DashboardGrid layout={board} editing={false} stacked onLayoutChange={() => {}}
      renderWidget={(it, ctx) => { seen[it.i] = ctx; return <div data-testid={`w-${it.i}`} />; }}
      compactFor={(it) => !!WIDGETS[it.type]?.compact} phoneFitFor={phoneFitFor}
      rowsFor={(it, ctx) => WIDGETS[it.type]?.phoneRowsWhen?.(it.config, ctx)} />);
    expect(cellOf('lone').style.height).toBe('72px');
    expect(cellOf('lone').className).toContain('dash-lone');
    expect(seen.lone).toEqual({ phone: true, lone: true });
    for (const id of ['p1', 'p2']) {
      expect(cellOf(id).style.height).toBe(`${2 * 72}px`);
      expect(cellOf(id).className).not.toContain('dash-lone');
      expect(seen[id].lone).toBe(false);
    }
    expect(cellOf('hero').style.height).toBe(`${2 * 72}px`);
  });

  it('marks the tiles that scroll inside their box, and Weather as content', () => {
    for (const k of ['favorites', 'approvals', 'who-has-what', 'team-time', 'notes']) expect(WIDGETS[k].phoneFit).toBe('shrink');
    expect(WIDGETS.weather.phoneFit).toBe('content');
    for (const k of ['my-time', 'find-transaction']) expect(WIDGETS[k].phoneFit).toBe('shrink');
    // Size-contained tiles (container-type: size) cannot measure their content.
    for (const k of ['kpi', 'action', 'shortcut', 'clock', 'time-clock']) expect(WIDGETS[k].phoneFit).toBeFalsy();
    expect(WIDGETS.clock.phoneRowsWhen()).toBe(2);
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
