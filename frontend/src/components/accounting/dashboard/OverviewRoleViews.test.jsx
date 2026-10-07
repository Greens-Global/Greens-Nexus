import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Overview role views (Oct 7, Priyanka: Bookkeeper missing from the picker).
// Principal, CFO, Controller and Bookkeeper always appear; a missing one is
// rebuilt from its default layout when opened; role views reset but never
// delete - only custom views do.

vi.mock('../../../api', () => ({
  api: {
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));
const dash = vi.hoisted(() => ({ view: 'principal', setView: () => {}, act: null, loading: false }));
vi.mock('./DashContext', () => ({ useDash: () => dash }));
vi.mock('./Filters', () => ({ Toolbar: ({ right }) => <div data-testid="toolbar">{right}</div> }));
const views = vi.hoisted(() => ({ current: null }));
const NONE = [];
vi.mock('./hooks', () => ({
  useViews: () => views.current,
  useAttention: () => NONE,
}));
vi.mock('./registry', () => ({
  SIZE_LABEL: {}, SIZES: ['md'], WIDGET_CATS: [], WIDGET_LIST: [], WIDGETS: {},
  WidgetPanel: ({ id }) => <div data-testid={`widget-${id}`} />, useDashNav: () => () => {},
}));

import OverviewTab from './OverviewTab';
import { resetAccountingPrefs } from '../prefs';

// Saved shared views WITHOUT the bookkeeper row (deleted, or never seeded).
const SAVED = {
  views: [
    { id: 'principal', name: 'Principal', role: 'Owner', widgets: [{ type: 'kpiCash', size: 'xs' }], sort: 1 },
    { id: 'cfo', name: 'CFO', role: 'CFO', widgets: [], sort: 2 },
    { id: 'controller', name: 'Controller', role: 'Controller', widgets: [], sort: 3 },
    { id: 'mine', name: 'My View', role: 'Custom', widgets: [], sort: 4 },
  ],
  isLoading: false,
};

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  resetAccountingPrefs();
  views.current = SAVED;
  dash.view = 'principal';
  dash.setView = vi.fn((v) => { dash.view = v; });
  dash.act = vi.fn(async () => ({}));
});

describe('Overview role views', () => {
  it('always lists Bookkeeper with the other role views', () => {
    render(<OverviewTab canEdit />);
    const select = screen.getByRole('combobox', { name: 'Overview view' });
    const roleGroup = select.querySelector('optgroup[label="Role views"]');
    const names = [...roleGroup.querySelectorAll('option')].map((o) => o.value);
    expect(names).toEqual(['principal', 'cfo', 'controller', 'bookkeeper']);
    expect(within(select).getByRole('option', { name: 'Bookkeeper' })).toBeTruthy();
  });

  it('rebuilds a missing role view from its default layout when opened', async () => {
    dash.view = 'bookkeeper';
    render(<OverviewTab canEdit />);
    await waitFor(() => expect(dash.act).toHaveBeenCalledWith('view-save', expect.objectContaining({ view: expect.objectContaining({ id: 'bookkeeper', name: 'Bookkeeper' }) })));
    const saved = dash.act.mock.calls.find((c) => c[0] === 'view-save')[1].view;
    expect(saved.widgets.map((w) => w.type)).toEqual(['kpiCash', 'kpiRecon', 'kpiNI', 'recon', 'uncat', 'close']);
    expect(saved.missing).toBeUndefined();
    // Its default widgets show straight away.
    expect(screen.getByTestId('widget-recon')).toBeTruthy();
    expect(dash.act).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a role view that exists', async () => {
    render(<OverviewTab canEdit />);
    await new Promise((r) => setTimeout(r, 20));
    expect(dash.act).not.toHaveBeenCalled();
  });

  it('offers Reset but not Delete View on a role view', () => {
    render(<OverviewTab canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByRole('button', { name: /Arrange Widgets/ }));
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete View' })).toBeNull();
  });

  it('lets a custom view be deleted', () => {
    dash.view = 'mine';
    render(<OverviewTab canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByRole('button', { name: /Arrange Widgets/ }));
    expect(screen.getByRole('button', { name: 'Delete View' })).toBeTruthy();
  });
});
