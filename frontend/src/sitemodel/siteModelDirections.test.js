// Google Maps links for "How to Get There" (siteModelDirections.js): driving
// directions go to the entrance gate (Google only routes on public roads), the
// unit pin to the unit itself. The frame and gates are copied from the real
// Temecula model (backend/site_models/greens-storage-temecula.json).
import { describe, expect, it } from 'vitest';
import { directionsGate, googleMapsDirectionsUrl, googleMapsUnitPinUrl, uvToLatLng } from './siteModelDirections.js';

const temecula = {
  frame: { lat0: 33.44295, lon0: -117.13637, bearingDeg: 21.4, mPerDegLon: 92889, mPerDegLat: 110900 },
  gates: [
    { id: 'main', name: 'Main Entrance Gate', uv: [-171.5, -58.5] },
    { id: 'east', name: 'East Entrance', uv: [-60.5, -96.0] },
    { id: 'northeast', name: 'North-East Entrance', uv: [118.0, -91.0] },
  ],
  // The office, with the lat / lng its outline was traced from.
  buildings: [{ id: 'OFFICE', name: 'Office', u: [-162.34, -142.44], v: [-39.03, -31.23], height: 3.5, floors: 1,
    ll: [[-117.13661647685599, 33.44145866779045], [-117.13653830777237, 33.44162573731917], [-117.13661648963851, 33.44165140042934], [-117.13669465872213, 33.441484330900614]] }],
  zones: [], units: [],
};

describe('uvToLatLng', () => {
  it('lands on the corners the office outline was traced from', () => {
    const b = temecula.buildings[0];
    const corners = [[b.u[0], b.v[0]], [b.u[1], b.v[0]], [b.u[1], b.v[1]], [b.u[0], b.v[1]]];
    corners.forEach((c, i) => {
      const [lat, lng] = uvToLatLng(temecula, c);
      expect(lat).toBeCloseTo(b.ll[i][1], 6);
      expect(lng).toBeCloseTo(b.ll[i][0], 6);
    });
  });
  it('is null without a geo frame', () => {
    expect(uvToLatLng({ gates: temecula.gates }, [0, 0])).toBeNull();
  });
});

describe('googleMapsDirectionsUrl', () => {
  it('drives to the Temecula main gate by default', () => {
    expect(googleMapsDirectionsUrl(temecula)).toBe('https://www.google.com/maps/dir/?api=1&destination=33.441318,-117.136457&travelmode=driving');
  });
  it('takes a named gate', () => {
    expect(googleMapsDirectionsUrl(temecula, { gate: 'east' })).toBe('https://www.google.com/maps/dir/?api=1&destination=33.442126,-117.135645&travelmode=driving');
    expect(directionsGate(temecula, { gate: { id: 'northeast' } }).name).toBe('North-East Entrance');
  });
  it('always sends people to the main gate, even for a unit right inside a side entrance (Visesh, Oct 20)', () => {
    const unit = { n: 'B149', b: 'B', k: 'park', f: 1, u: -108, v: -94, wu: 3, dv: 6, door: 'ne' };
    const model = { ...temecula, pads: [[[-200, -110], [140, -110], [140, 40], [-200, 40]]], units: [unit] };
    expect(directionsGate(model, { unit }).id).toBe('main');
    expect(googleMapsDirectionsUrl(model, { unit })).toContain('destination=33.441318,-117.136457');
  });
  it('is null without gates or a frame', () => {
    expect(googleMapsDirectionsUrl({ ...temecula, gates: [] })).toBeNull();
    expect(googleMapsDirectionsUrl({ gates: temecula.gates })).toBeNull();
  });
});

describe('googleMapsUnitPinUrl', () => {
  it('pins the center of the unit', () => {
    const unit = { n: 'X', u: -162.34, v: -39.03, wu: 0, dv: 0 };
    expect(googleMapsUnitPinUrl(temecula, unit)).toBe('https://www.google.com/maps/search/?api=1&query=33.441459,-117.136616');
  });
});
