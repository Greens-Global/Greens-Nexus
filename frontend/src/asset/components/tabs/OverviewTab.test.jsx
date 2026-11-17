import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ASSETS, STORE, MAINT, TODAY } from './fixture.test-data.js';

const api = vi.hoisted(() => ({
  getMaintenancePortfolio: vi.fn(),
  getTaskTablePrefs: vi.fn(() => Promise.resolve({ prefs: {} })),
  saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../../api.js', () => ({ api, default: api }));

import { OverviewTab, buildWorklist, myNames, managedBy, nextDateLine } from './OverviewTab.jsx';
import { resetMaintenancePortfolio } from '../../lib/tabSignals.js';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(TODAY); });
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => { resetMaintenancePortfolio(); api.getMaintenancePortfolio.mockReset(); try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(cleanup);

const NEIL = { name: 'Neil Kadakia', email: 'neil@greensglobal.com' };
const summary = (c) => c.querySelector('[data-summary]').textContent;
const section = (label) => screen.getByRole('region', { name: label });

describe('OverviewTab worklist rules', () => {
  it('matches the manager by name, case and spaces aside', () => {
    const names = myNames(NEIL);
    expect(managedBy({ manager: 'neil  kadakia' }, names)).toBe(true);
    expect(managedBy({ manager: 'Neil' }, myNames({ email: 'neil@x.com' }))).toBe(true);
    expect(managedBy({ manager: '' }, names)).toBe(false);
  });

  it('builds Overdue / Open Work / Next 30 Days / To Fix for everyone', () => {
    const groups = buildWorklist({ assets: ASSETS, store: STORE, maintenance: MAINT, everyone: true });
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Overdue', 5], ['Open Work', 3], ['Next 30 Days', 2], ['To Fix', 3]]);
    const overdue = groups[0].rows;
    expect(overdue[0]).toMatchObject({ what: 'Insurance expiration', when: '319 days overdue', where: 'Scissor Lift' });
    expect(overdue.map((r) => r.what)).toContain('Preventive maintenance overdue');
    expect(overdue.map((r) => r.what)).toContain('Permit expired');
    expect(groups[1].rows[0]).toMatchObject({ what: '6 open tickets', where: 'Greens Storage, Murrieta' });
    expect(groups[2].rows[0]).toMatchObject({ what: 'Property tax installment', where: '2 properties', when: 'In 23 days', action: 'Mark Paid' });
    expect(groups[3].rows.map((r) => r.kind)).toEqual(['fix', 'review', 'assign']);
  });

  it('Mine leaves out other managers and the no-manager row', () => {
    const mine = ASSETS.filter((a) => managedBy(a, myNames(NEIL)));
    const groups = buildWorklist({ assets: mine, store: STORE, maintenance: MAINT, everyone: false });
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Overdue', 1], ['Open Work', 1], ['Next 30 Days', 1], ['To Fix', 1]]);
  });

  it('names the next date when nothing is due', () => {
    expect(nextDateLine([ASSETS[0]], STORE)).toBe('Next: warranty expiration on 03/01/2027 at Greens Storage, Murrieta');
  });
});

describe('OverviewTab', () => {
  it('defaults to Mine for an asset manager, with the sentence and inline actions', async () => {
    api.getMaintenancePortfolio.mockResolvedValue(MAINT);
    const openAsset = vi.fn();
    const onPatchAsset = vi.fn();
    const { container } = render(<OverviewTab store={STORE} assets={ASSETS} session={NEIL} openAsset={openAsset} onPatchAsset={onPatchAsset} canEdit goTab={vi.fn()} />);
    expect(await screen.findByText('6 open tickets')).toBeTruthy();
    expect(summary(container)).toBe('4 things need you - 1 overdue');
    expect(screen.getByRole('radio', { name: 'Mine' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(section('Next 30 Days')).getByText('Mark Paid'));
    expect(onPatchAsset).toHaveBeenCalledWith('mur', { taxDue: '12/10/2027' }, expect.any(Array));
    fireEvent.click(within(section('Open Work')).getByText('Open'));
    expect(openAsset).toHaveBeenCalledWith('mur', 'maintenance', '');
    fireEvent.click(within(section('To Fix')).getByText('Fix'));
    expect(openAsset).toHaveBeenCalledWith('esc', 'property', '');
    expect(container.innerHTML).not.toMatch(/uppercase/i);
  });

  it('Everyone shows the no-manager row with Assign', async () => {
    api.getMaintenancePortfolio.mockResolvedValue(MAINT);
    const goTab = vi.fn();
    render(<OverviewTab store={STORE} assets={ASSETS} session={{ name: 'Someone Else' }} goTab={goTab} />);
    expect(await screen.findByText('1 property has no asset manager')).toBeTruthy();
    fireEvent.click(screen.getByText('Assign'));
    expect(goTab).toHaveBeenCalledWith('properties', { preset: 'no-manager' });
  });

  it('a failed ticket read never empties the list', async () => {
    api.getMaintenancePortfolio.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    render(<OverviewTab store={STORE} assets={ASSETS} session={NEIL} />);
    expect(await screen.findByText(/Couldn't load tickets/)).toBeTruthy();
    expect(screen.getAllByText('Property tax installment').length).toBeGreaterThan(0);
  });

  it('nothing to do: a green check and the next date', async () => {
    api.getMaintenancePortfolio.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const quiet = [{ id: 'q', kind: 'property', name: 'Quiet Place', manager: 'Neil Kadakia', taxDue: '06/01/2027', insExpiration: '06/01/2027' }];
    render(<OverviewTab store={{ properties: quiet }} assets={quiet} session={NEIL} />);
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    expect(screen.getByText(/^Next: /)).toBeTruthy();
  });
});
