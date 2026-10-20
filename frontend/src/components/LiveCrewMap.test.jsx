import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render smoke for the Location Trail map (Workforce Analytics > Location
// Trail): Leaflet is mocked, the screen must render the live list and a
// person's day trail without crashing.
vi.mock('leaflet', () => {
  const chain = () => { const o = { addTo: () => o, bindTooltip: () => o, on: () => o, clearLayers: () => {}, setView: () => o, fitBounds: () => o, invalidateSize: () => {}, remove: () => {} }; return o; };
  const L = { map: chain, tileLayer: chain, layerGroup: chain, circleMarker: chain, polyline: chain, marker: chain, divIcon: () => ({}) };
  return { default: L };
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('./EnrolPhone', () => ({ default: () => null }));

const locationTrailLive = vi.fn();
const locationTrailDay = vi.fn();
vi.mock('../api.js', () => ({ api: { locationTrailLive: (...a) => locationTrailLive(...a), locationTrailDay: (...a) => locationTrailDay(...a) } }));

const LiveCrewMap = (await import('./LiveCrewMap')).default;

const NOW = new Date().toISOString().slice(0, 19);
const DAY = {
  email: 'amy@greensglobal.com', name: 'Amy Field', date: '2026-10-20',
  points: [{ at: NOW, lat: '33.5', lng: '-117.1', accuracyM: 10, geoStatus: 'in_fence', workSiteName: 'Yard', source: 'web' }],
  punches: [{ at: NOW, kind: 'in', lat: '33.5', lng: '-117.1', geoStatus: 'in_fence', workSiteName: 'Yard' }],
};

describe('LiveCrewMap', () => {
  beforeEach(() => {
    locationTrailLive.mockReset();
    locationTrailDay.mockReset().mockResolvedValue(DAY);
  });

  it('lists who is live and opens their trail', async () => {
    locationTrailLive.mockResolvedValue({ crew: [{ email: 'amy@greensglobal.com', name: 'Amy Field', lat: '33.5', lng: '-117.1', at: NOW, geoStatus: 'in_fence', workSiteName: 'Yard', batteryPct: -1, source: 'web' }] });
    render(<LiveCrewMap toastErr={() => {}} people={[{ email: 'bob@greensglobal.com', name: 'Bob Desk' }]} />);
    const row = await screen.findByRole('button', { name: /Amy Field/ });
    fireEvent.click(row);
    await waitFor(() => expect(locationTrailDay).toHaveBeenCalledWith('amy@greensglobal.com', expect.any(String)));
    expect(await screen.findByText(/1 location point/)).toBeTruthy();
    expect(screen.getByText('Clock In')).toBeTruthy();
  });

  it('renders an empty team without crashing', async () => {
    locationTrailLive.mockResolvedValue({ crew: [] });
    render(<LiveCrewMap toastErr={() => {}} />);
    expect(await screen.findByText(/No one on your team is clocked in/)).toBeTruthy();
  });

});
