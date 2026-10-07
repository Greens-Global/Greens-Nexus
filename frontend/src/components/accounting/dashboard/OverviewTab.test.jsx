import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Dashboard Overview (Oct 7, Neil comment 6): density lives in the module's
// one Customize, widget arranging is an item inside it, and nothing opens a
// browser alert.

vi.mock('../../../api', () => ({
  api: {
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));
const dash = { view: 'mine', setView: vi.fn(), act: vi.fn(async () => ({})), loading: false };
vi.mock('./DashContext', () => ({ useDash: () => dash }));
vi.mock('./Filters', () => ({ Toolbar: ({ right }) => <div data-testid="toolbar">{right}</div> }));
// Stable objects: the tab keys effects on them, like the real (cached) hooks.
const VIEWS = { views: [{ id: 'mine', name: 'Mine', role: 'Custom', widgets: [] }], isLoading: false };
const NONE = [];
vi.mock('./hooks', () => ({
  useViews: () => VIEWS,
  useAttention: () => NONE,
}));
vi.mock('./registry', () => ({
  SIZE_LABEL: {}, SIZES: ['md'], WIDGET_CATS: [], WIDGET_LIST: [], WIDGETS: {},
  WidgetPanel: () => null, useDashNav: () => () => {},
}));

import OverviewTab from './OverviewTab';
import { resetAccountingPrefs } from '../prefs';

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } resetAccountingPrefs(); });

describe('OverviewTab Customize', () => {
  it('has no separate Density button; density and Arrange Widgets sit in Customize', async () => {
    render(<OverviewTab canEdit />);
    expect(screen.queryByRole('button', { name: /Density:/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    const density = screen.getByRole('group', { name: 'Row Density' });
    fireEvent.click(density.querySelector('button[aria-pressed="false"]'));
    fireEvent.click(screen.getByRole('button', { name: /Arrange Widgets/ }));
    expect(screen.getByText(/Arranging Mine/)).toBeTruthy();
  });

  it('says inline that a custom view has no default layout, no browser alert', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<OverviewTab canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    fireEvent.click(screen.getByRole('button', { name: /Arrange Widgets/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Custom views have no default layout'));
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('gives a viewer the density but not widget arranging', () => {
    render(<OverviewTab canEdit={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Customize/ }));
    expect(screen.getByRole('group', { name: 'Row Density' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Arrange Widgets/ })).toBeNull();
  });
});
