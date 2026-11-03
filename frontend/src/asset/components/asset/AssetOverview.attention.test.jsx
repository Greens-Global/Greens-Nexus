import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { AssetOverview } from './AssetOverview.jsx';

// Needs Attention counts per subject (review 11/02/2026): an overdue or soon service is ONE
// item - its critical-date row - not that row plus a "Service: Overdue" health warning.
const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const loader = { id: 'e1', kind: 'equipment', assetType: 'Heavy Equipment', name: 'Bobcat S650', devStage: 'In Service' };
const van = { id: 'v1', kind: 'vehicle', assetType: 'Vehicle', name: 'Ford Transit 250', odometer: '12950' };
const panel = () => screen.getByRole('region', { name: 'Needs attention' });

describe('AssetOverview Needs Attention', () => {
  afterEach(cleanup);

  it('shows an overdue service once and counts it once', () => {
    const store = { properties: [loader], vservice: [{ propertyId: 'e1', date: iso(-200), nextDue: iso(-5), type: 'Inspection' }], logs: [] };
    render(<AssetOverview asset={loader} store={store} />);
    expect(within(panel()).getByText(/Next Service Due/)).toBeTruthy();
    expect(within(panel()).queryByText(/Service: Overdue/)).toBeNull();
  });

  it('keeps a mileage warning beside the service date row - a different target', () => {
    const store = { properties: [van], vservice: [{ propertyId: 'v1', date: iso(-60), mileage: '8000', nextMileage: '13000', nextDue: iso(40), type: 'Oil Change' }], logs: [] };
    render(<AssetOverview asset={van} store={store} />);
    expect(within(panel()).getByText(/Next Service Due/)).toBeTruthy();
    expect(within(panel()).getByText('Service: 50 mi left')).toBeTruthy();
  });
});
