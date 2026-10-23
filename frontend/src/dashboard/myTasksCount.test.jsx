// My Open Tasks (Neil, Oct 23 2026): the number is the work that is live now
// and the line under it names what was left out - "+12 with no due date,
// +8 recurring" - on the grid's KPI tile and on Home's hero stat alike. The
// count itself is the server's (backend test_dashboard_task_focus.py).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ mySignatures: vi.fn(async () => []), dashKpis: vi.fn(async () => ({ kpis: {} })) }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Charmi Patel', username: 'charmi@greensglobal.com' }] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, actingAs: null, myEmail: 'charmi@greensglobal.com' }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));
vi.mock('../lib/useTimeStatus', () => ({ useTimeStatus: () => ({ status: null, reload: vi.fn() }) }));
vi.mock('./QuickActionModals.jsx', () => ({ default: () => null }));

import { myTasksFootnote, MY_TASKS_RULE } from './myTasksCount';
import { WIDGETS } from './widgets.jsx';
import DeskHome from './DeskHome';

afterEach(cleanup);

describe('myTasksFootnote', () => {
  it('names the tasks left out of the number', () => {
    expect(myTasksFootnote({ my_open_tasks_undated: 12, my_open_tasks_recurring: 8 })).toBe('+12 with no due date, +8 recurring');
    expect(myTasksFootnote({ my_open_tasks_undated: 3 })).toBe('+3 with no due date');
    expect(myTasksFootnote({ my_open_tasks_recurring: 1 })).toBe('+1 recurring');
  });
  it('is null when nothing was left out, or the server is older', () => {
    expect(myTasksFootnote({ my_open_tasks_undated: 0, my_open_tasks_recurring: 0 })).toBeNull();
    expect(myTasksFootnote({})).toBeNull();
    expect(myTasksFootnote(null)).toBeNull();
  });
});

describe('My Open Tasks on the grid', () => {
  const mount = (kpis, metric = 'my_open_tasks') => {
    const Comp = WIDGETS.kpi.render;
    return render(<Comp config={{ metric, hero: true }} updateConfig={vi.fn()} kpis={kpis} />);
  };

  it('shows the live number with the footnote, kept on a short tile', () => {
    mount({ my_open_tasks: 14, my_open_tasks_undated: 12, my_open_tasks_recurring: 8 });
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('+12 with no due date, +8 recurring')).toBeTruthy();
    const tile = document.querySelector('.dk-stat');
    expect(tile.classList.contains('dk-stat--noted')).toBe(true);
    expect(tile.getAttribute('title')).toBe(`My Open Tasks - ${MY_TASKS_RULE}. +12 with no due date, +8 recurring`);
  });

  it('keeps the plain hint when nothing was left out', () => {
    mount({ my_open_tasks: 2 });
    expect(screen.getByText('Due in the next 30 days')).toBeTruthy();
    expect(document.querySelector('.dk-stat').classList.contains('dk-stat--noted')).toBe(false);
  });

  it('leaves every other KPI alone', () => {
    mount({ open_tasks: 200, my_open_tasks_undated: 12 }, 'open_tasks');
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('Across your team')).toBeTruthy();
    expect(screen.queryByText(/with no due date/)).toBeNull();
  });
});

describe('Open Tasks on Home', () => {
  it('carries the footnote under the hero stat', async () => {
    render(<DeskHome kpis={{ my_open_tasks: 14, my_open_tasks_undated: 12, my_open_tasks_recurring: 8 }} notifications={[]} />);
    expect(await screen.findByText('+12 with no due date, +8 recurring')).toBeTruthy();
    expect(screen.getByTitle(`Open Tasks - ${MY_TASKS_RULE}. +12 with no due date, +8 recurring`)).toBeTruthy();
  });
  it('says what the number covers when nothing was left out', async () => {
    render(<DeskHome kpis={{ my_open_tasks: 3 }} notifications={[]} />);
    expect(await screen.findByText('Due in the next 30 days')).toBeTruthy();
  });
});

describe('Action Required tile', () => {
  it('is the old My Day widget under its new name, same key', () => {
    expect(WIDGETS['my-day'].title).toBe('Action Required');
  });
});
