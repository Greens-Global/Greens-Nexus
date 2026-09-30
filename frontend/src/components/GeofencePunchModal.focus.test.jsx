import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Opened from a timecard Loc chip (Sep 30), the Geofence Punch map is framed
// on that one shift and, for a manager, offers the work-site reassignment.

// jsdom has no SVG geometry; give Leaflet's SVG check the one method it needs.
if (typeof SVGSVGElement !== 'undefined' && !SVGSVGElement.prototype.createSVGRect) {
  SVGSVGElement.prototype.createSVGRect = () => ({});
}

const punches = [
  { id: 'p1', at: '2026-09-22T15:00:00', localDate: '2026-09-22', kind: 'in', lat: '33.49', lng: '-117.14', accuracyM: 12, geoStatus: 'in_fence', workSiteId: 's1', workSiteName: 'GS Temecula', distanceM: 0 },
  { id: 'p2', at: '2026-09-22T23:00:00', localDate: '2026-09-22', kind: 'out', lat: '33.70', lng: '-117.20', accuracyM: 12, geoStatus: 'out_of_fence', workSiteId: 's1', workSiteName: 'GS Temecula', distanceM: 21000 },
  { id: 'p3', at: '2026-09-23T15:00:00', localDate: '2026-09-23', kind: 'in', lat: '33.49', lng: '-117.14', accuracyM: 12, geoStatus: 'in_fence', workSiteId: 's1', workSiteName: 'GS Temecula', distanceM: 0 },
];
vi.mock('../api', () => ({
  api: { timeGeofencePunches: vi.fn(async () => ({ email: 'a@x.com', name: 'Ashley', sites: [{ id: 's1', name: 'GS Temecula', lat: 33.49, lng: -117.14, radiusM: 150 }], punches })) },
}));
vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: async () => ({}) });

const { default: GeofencePunchModal } = await import('./GeofencePunchModal');

describe('GeofencePunchModal focused on a shift', () => {
  it('selects only that shift and hands off to the site editor', async () => {
    const onEditSite = vi.fn();
    const { container } = render(<GeofencePunchModal email="a@x.com" name="Ashley" start="2026-09-21" end="2026-10-04" onClose={() => {}}
      focusIds={['p1', 'p2']} focusLabel="the Mon 9/22 shift" onEditSite={onEditSite} />);
    await waitFor(() => expect(screen.getByText(/Showing the Mon 9\/22 shift/)).toBeTruthy());
    const boxes = [...container.querySelectorAll('tbody input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
    expect(container.querySelectorAll('tr[data-focus]').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Change Work Site' }));
    expect(onEditSite).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show All Punches' }));
    expect([...container.querySelectorAll('tbody input[type="checkbox"]')].every((b) => b.checked)).toBe(true);
  });

  it('opened without a focus shows every punch and no site editor', async () => {
    const { container } = render(<GeofencePunchModal email="a@x.com" name="Ashley" start="2026-09-21" end="2026-10-04" onClose={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('tbody input[type="checkbox"]').length).toBe(3));
    expect(screen.queryByRole('button', { name: 'Change Work Site' })).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});
