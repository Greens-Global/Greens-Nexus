import { describe, it, expect } from 'vitest';
import { pinFor, hasAddress, coordFromUrl } from './geo.js';

describe('pinFor', () => {
  it('prefers a coordinate in the Google Maps link, then the server point, else nothing', () => {
    expect(pinFor({ mapUrl: 'https://www.google.com/maps/@33.17,-117.09,16z', geo: { lat: 1, lng: 2 } })).toEqual([33.17, -117.09]);
    expect(pinFor({ geo: { lat: 33.17, lng: -117.09, for: 'x' } })).toEqual([33.17, -117.09]);
    expect(pinFor({ geo: { lat: null, lng: null, for: 'x' } })).toBeNull();
    expect(pinFor({ address: '1 Main St' })).toBeNull();
    expect(pinFor(null)).toBeNull();
  });
  it('knows whether there is anything to place', () => {
    expect(hasAddress({ city: 'Austin' })).toBe(true);
    expect(hasAddress({ name: 'X' })).toBe(false);
  });
  it('still reads a coordinate out of a pasted link', () => {
    expect(coordFromUrl('https://www.google.com/maps/place/x/@30.26,-97.74,17z')).toEqual([30.26, -97.74]);
  });
});
