// Pure geography behind the realistic site model (siteModelGeo.js): the frame
// conversions must agree with the backend's build script, tiles must cover the
// right ground, Terrarium must decode to real heights, the lot must stay flat,
// and the status tints must keep their legend hue.
import { describe, expect, it } from 'vitest';
import { geoFrame, lonLatToTile, tileToLonLat, tileRange, tileMeters, decodeTerrarium, convexHull, distanceOutside, flattenWeight, mutedTint, sunDirection, enuToWorld, unitForm, nameBucket } from './siteModelGeo.js';

// Greens Storage Temecula's frame and one of its picture corners (backend/site_models).
const frame = { lat0: 33.44295, lon0: -117.13637, bearingDeg: 21.4, mPerDegLon: 92889, mPerDegLat: 110900, north: [0.9311, 0.3649] };

describe('geoFrame', () => {
  it('matches the build script: the picture corner lands where the model says', () => {
    const g = geoFrame(frame);
    const [u, v] = g.llToUv(-117.1376, 33.445516);   // image bbox west / north
    expect(u).toBeCloseTo(223.26, 1); expect(v).toBeCloseTo(210.21, 1);
  });
  it('round-trips and its north matches the model', () => {
    const g = geoFrame(frame); const [lon, lat] = g.uvToLl(120, -45); const [u, v] = g.llToUv(lon, lat);
    expect(u).toBeCloseTo(120, 6); expect(v).toBeCloseTo(-45, 6);
    // world north = (u, -v) of the model's north vector
    expect(g.north[0]).toBeCloseTo(frame.north[0], 3); expect(-g.north[1]).toBeCloseTo(frame.north[1], 3);
  });
});

describe('tiles', () => {
  it('finds the slippy-map tile of a point and back', () => {
    const [x, y] = lonLatToTile(-117.13637, 33.44295, 19);
    expect(Math.floor(x)).toBe(91551); expect(Math.floor(y)).toBe(210411);   // the Esri z19 tile over the lot
    const [lon, lat] = tileToLonLat(x, y, 19); expect(lon).toBeCloseTo(-117.13637, 6); expect(lat).toBeCloseTo(33.44295, 6);
  });
  it('covers a box with whole tiles', () => {
    const r = tileRange(-117.1376, 33.440384, -117.1342, 33.445516, 17);
    expect(r.x1).toBeGreaterThanOrEqual(r.x0); expect(r.y1).toBeGreaterThanOrEqual(r.y0);
    expect((r.x1 - r.x0 + 1) * tileMeters(33.44, 17)).toBeGreaterThan(316);   // the box is ~316 m wide
  });
});

describe('decodeTerrarium', () => {
  it('reads the AWS Terrain Tiles encoding', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);                 // sea level
    expect(decodeTerrarium(129, 194, 128)).toBeCloseTo(450.5, 3); // 256 + 194 + 0.5
    expect(decodeTerrarium(127, 255, 0)).toBe(-1);
  });
});

describe('keeping the lot flat', () => {
  const hull = convexHull([[0, 0], [100, 0], [100, 50], [0, 50], [50, 25], [20, 10]]);
  it('hulls the developed area', () => { expect(hull).toHaveLength(4); });
  it('measures distance outside, zero inside', () => {
    expect(distanceOutside(hull, 50, 25)).toBe(0);
    expect(distanceOutside(hull, 130, 25)).toBeCloseTo(30, 6);
  });
  it('is fully flat on the lot and real terrain far from it', () => {
    expect(flattenWeight(0)).toBe(1); expect(flattenWeight(10)).toBe(1);
    expect(flattenWeight(500)).toBe(0);
    const mid = flattenWeight(47); expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1);
  });
});

describe('mutedTint', () => {
  it('keeps the hue of the legend color, only calmer', () => {
    const green = mutedTint(0x5fae7d); const r = (green >> 16) & 255, g = (green >> 8) & 255, b = green & 255;
    expect(g).toBeGreaterThan(r); expect(g).toBeGreaterThan(b);   // still green
    expect(g - r).toBeLessThan(0xae - 0x5f);                       // less saturated
    expect(mutedTint(0x808080)).toBe(0x808080);                    // gray stays gray
    expect(mutedTint(0xd65a4c, 0)).toBe(0xd65a4c);
  });
});

describe('sun and globe axes', () => {
  it('puts a south-southeast late-morning sun up and to the south', () => {
    const [x, y, z] = sunDirection(frame, 152, 44); const g = geoFrame(frame);
    expect(y).toBeCloseTo(Math.sin((44 * Math.PI) / 180), 6);
    expect(x * g.north[0] + z * g.north[1]).toBeLessThan(0);      // from the south
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
  });
  it('turns east / north / up into the model axes as a proper rotation', () => {
    const m = enuToWorld(frame); const g = geoFrame(frame);
    // east (1, 0, 0) -> world east
    expect(m[0]).toBeCloseTo(g.east[0], 9); expect(m[6]).toBeCloseTo(g.east[1], 9);
    // up stays up
    expect(m[5]).toBe(1);
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    expect(det).toBeCloseTo(1, 9);
  });
});

describe('unitForm', () => {
  const buildings = { C: { id: 'C' } };
  it('draws stalls flat, containers as boxes and building units inside their building', () => {
    expect(unitForm({ k: 'park', b: 'A' }, buildings)).toBe('stall');
    expect(unitForm({ k: 'cc', b: 'C', wu: 3, dv: 3 }, buildings)).toBe('interior');
    expect(unitForm({ k: 'in', b: 'X', wu: 12.19, dv: 2.29 }, buildings)).toBe('container');
    expect(unitForm({ k: 'in', b: 'B', wu: 0.35, dv: 3.6 }, buildings)).toBe('stall');   // a sliver, not a box
  });
  it('hashes a name to a stable paint bucket', () => {
    expect(nameBucket('X002', 7)).toBe(nameBucket('X002', 7));
    expect(nameBucket('X002', 7)).toBeGreaterThanOrEqual(0); expect(nameBucket('X002', 7)).toBeLessThan(7);
  });
});
