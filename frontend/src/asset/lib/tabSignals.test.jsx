import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({ getMaintenancePortfolio: vi.fn() }));
vi.mock('../../api.js', () => ({ api, default: api }));

import { useTabSignals, resetMaintenancePortfolio, pipelineStepOf, stageKey } from './tabSignals.js';

const assets = [
  { id: 'p', kind: 'property', name: 'P', devStage: 'Stabilized – Renovation', taxDue: '01/01/2020' },
  { id: 'v', kind: 'vehicle', name: 'V' },
  { id: 'x', kind: 'property', name: 'X', taxDue: '12/32/3232' },
];
const store = { properties: assets };

beforeEach(() => { resetMaintenancePortfolio(); api.getMaintenancePortfolio.mockReset(); });
afterEach(cleanup);

describe('useTabSignals', () => {
  it('counts open tickets and passed dates; fleet and pipeline', async () => {
    api.getMaintenancePortfolio.mockResolvedValue({ properties: [], totals: { open: 12 } });
    const { result } = renderHook(() => useTabSignals({ store, assets }));
    expect(result.current).toMatchObject({ maintenanceOpen: null, maintenanceAllowed: false, datesPassed: 1, hasFleet: true, hasPipeline: true });
    await waitFor(() => expect(result.current.maintenanceOpen).toBe(12));
    expect(result.current.maintenanceAllowed).toBe(true);
  });

  it('a 403 hides Maintenance; a failure is null, never a false 0', async () => {
    api.getMaintenancePortfolio.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const a = renderHook(() => useTabSignals({ store, assets }));
    await waitFor(() => expect(a.result.current.maintenanceKnown).toBe(true));
    expect(a.result.current).toMatchObject({ maintenanceAllowed: false, maintenanceOpen: null });
    resetMaintenancePortfolio();
    api.getMaintenancePortfolio.mockRejectedValue(Object.assign(new Error('boom'), { status: 502 }));
    const b = renderHook(() => useTabSignals({ store, assets: assets.slice(2) }));
    await waitFor(() => expect(b.result.current.maintenanceKnown).toBe(true));
    expect(b.result.current).toMatchObject({ maintenanceAllowed: true, maintenanceOpen: null, hasFleet: false, hasPipeline: false, datesPassed: 0 });
  });

  it('reads the pipeline stage however it is dashed', () => {
    expect(stageKey('Stabilized — Renovation')).toBe('stabilized - renovation');
    expect(pipelineStepOf({ kind: 'property', devStage: 'construction' }).label).toBe('Under Construction');
    expect(pipelineStepOf({ kind: 'property', devStage: 'Stabilized' })).toBeNull();
    expect(pipelineStepOf({ kind: 'vehicle', devStage: 'Entitlement' })).toBeNull();
  });
});
