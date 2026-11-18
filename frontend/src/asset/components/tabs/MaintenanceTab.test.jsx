import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MAINT, ASSETS } from './fixture.test-data.js';

const api = vi.hoisted(() => ({ getMaintenancePortfolio: vi.fn(), getTaskTablePrefs: vi.fn(() => Promise.resolve({ prefs: {} })), saveTaskTablePrefs: vi.fn(() => Promise.resolve({})) }));
vi.mock('../../../api.js', () => ({ api, default: api }));

import { MaintenanceTab } from './MaintenanceTab.jsx';
import { resetMaintenancePortfolio } from '../../lib/tabSignals.js';

beforeEach(() => { resetMaintenancePortfolio(); api.getMaintenancePortfolio.mockReset(); });
afterEach(cleanup);

describe('MaintenanceTab', () => {
  it('shows the sentence and one row per property; a row opens its Maintenance', async () => {
    api.getMaintenancePortfolio.mockResolvedValue(MAINT);
    const openAsset = vi.fn();
    render(<MaintenanceTab assets={ASSETS} openAsset={openAsset} />);
    expect(await screen.findByText('7 open tickets at 2 properties')).toBeTruthy();
    expect(screen.getByText('14 tickets so far at 3 properties')).toBeTruthy();
    expect(screen.getAllByText('None set up').length).toBe(2);
    expect(screen.getByText('11/07/2026')).toBeTruthy();
    fireEvent.click(screen.getByText('Greens Storage, Murrieta'));
    expect(openAsset).toHaveBeenCalledWith('mur', 'maintenance');
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByText('Open These in Tickets'));
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'tickets' });
    window.removeEventListener('nexus:navigate', nav);
  });

  it('says who sees it on a 403', async () => {
    api.getMaintenancePortfolio.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    render(<MaintenanceTab assets={ASSETS} />);
    expect(await screen.findByText(/for the service desk and the Asset Management team/)).toBeTruthy();
  });

  it('offers Retry when the read fails', async () => {
    api.getMaintenancePortfolio.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    render(<MaintenanceTab assets={ASSETS} />);
    expect(await screen.findByText(/Couldn't load the tickets/)).toBeTruthy();
  });

  it('no preventive schedules: says so and offers Set Up the First', async () => {
    api.getMaintenancePortfolio.mockResolvedValue({ properties: [MAINT.properties[0]], totals: { open: 6, total: 9, properties: 1, openProperties: 1, preventiveSchedules: 0 } });
    const openAsset = vi.fn();
    render(<MaintenanceTab assets={ASSETS} openAsset={openAsset} />);
    expect(await screen.findByText('no preventive schedules yet')).toBeTruthy();
    fireEvent.click(screen.getByText('Set Up the First'));
    expect(openAsset).toHaveBeenCalledWith('mur', 'maintenance');
  });
});
