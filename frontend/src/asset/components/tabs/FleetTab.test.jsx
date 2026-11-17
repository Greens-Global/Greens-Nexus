import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ASSETS, STORE, TODAY } from './fixture.test-data.js';
import { FleetTab } from './FleetTab.jsx';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(TODAY); });
afterAll(() => { vi.useRealTimers(); });
afterEach(cleanup);

describe('FleetTab', () => {
  it('lists vehicles and equipment with the odometer, last service and dates', () => {
    const openAsset = vi.fn();
    render(<FleetTab store={STORE} assets={ASSETS} openAsset={openAsset} />);
    expect(screen.getByText('1 vehicle and 1 piece of equipment - 1 in service, 1 in repair.')).toBeTruthy();
    expect(screen.getByText('Ford · Expedition · White')).toBeTruthy();
    expect(screen.getByText('12,478 mi')).toBeTruthy();
    expect(screen.getByText('120 hrs')).toBeTruthy();
    expect(screen.getByText('07/04/2026')).toBeTruthy();
    expect(screen.getByText('12/14/2026')).toBeTruthy();
    expect(screen.getByText('01/02/2026').style.color).toContain('--color-red');
    expect(screen.getAllByText('No date').length).toBe(1);
    fireEvent.click(screen.getByText('Ford Expedition Tremor'));
    expect(openAsset).toHaveBeenCalledWith('v1');
  });

  it('searches and switches to the gallery', () => {
    render(<FleetTab store={STORE} assets={ASSETS} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '9abc' } });
    expect(screen.queryByText('Scissor Lift')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Gallery/ }));
    expect(screen.getByText('Ford Expedition Tremor')).toBeTruthy();
  });

  it('says so when there is no fleet', () => {
    render(<FleetTab store={STORE} assets={ASSETS.filter((a) => a.kind === 'property')} />);
    expect(screen.getByText(/No vehicles or heavy equipment yet/)).toBeTruthy();
  });
});
