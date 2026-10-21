import { describe, it, expect } from 'vitest';
import {
  bucketLabel, decodePoints, gridCluster, hexBin, hexClasses, hexColor, legendFor, summarize, summaryHtml,
  tradeBounds, weightedPercentile,
} from './tradeArea';

// Operations > Customer Map trade area helpers (Oct 22 2026).
const COLS = ['lat', 'lng', 'facility', 'zip', 'kind', 'tenure', 'band', 'count', 'rent', 'miles', 'closer'];
const greens = [{ id: 'esc' }, { id: 'tem', lat: 33.5, lng: -117.15 }];
const tem = { id: 'tem', lat: 33.5, lng: -117.15 };
const pt = (lat, lng, count, miles, extra = {}) => ({ lat, lng, fi: 1, zip: false, kind: 0, tenure: 2, band: 1, count, rent: 100 * count, miles, closer: null, ...extra });

describe('tradeArea', () => {
  it('decodes the compact rows', () => {
    const [p] = decodePoints({ pointCols: COLS, points: [[33.51, -117.15, 1, 1, 1, 0, 3, 2, 400, 0.7, 0]] });
    expect(p).toEqual({ lat: 33.51, lng: -117.15, fi: 1, zip: true, kind: 1, tenure: 0, band: 3, count: 2, rent: 400, miles: 0.7, closer: 0 });
    expect(decodePoints(null)).toEqual([]);
  });

  it('weighted percentile is nearest-rank over customers, not groups', () => {
    const items = [{ v: 1, w: 8 }, { v: 5, w: 1 }, { v: 300, w: 1 }];
    expect(weightedPercentile(items, 80)).toBe(1);
    expect(weightedPercentile(items, 90)).toBe(5);
    expect(weightedPercentile(items, 100)).toBe(300);
    expect(weightedPercentile([], 90)).toBeNull();
  });

  it('default bounds cover the trade area and ignore far-away outliers', () => {
    const points = [
      ...Array.from({ length: 18 }, (_, i) => pt(33.5 + (i - 9) * 0.004, -117.15 + (i - 9) * 0.004, 1, Math.abs(i - 9) * 0.35)),
      pt(33.56, -117.15, 1, 4.1),
      pt(40.7, -74.0, 1, 2400),                          // New York - an outlier
    ];
    const [[s, w], [n, e]] = tradeBounds(points, [tem], greens);
    expect(n).toBeLessThan(33.6);
    expect(e).toBeLessThan(-117.0);                    // nowhere near New York
    expect(s).toBeLessThan(33.5 - 0.02);               // at least the minimum pad around the store
    expect(w).toBeLessThan(-117.15);
    // With the outlier inside the 90% (a two-customer store), it still caps at 50 miles.
    const two = tradeBounds([pt(33.51, -117.15, 1, 0.7), pt(40.7, -74.0, 1, 2400)], [tem], greens);
    expect(two[1][0]).toBeLessThan(34);
    expect(tradeBounds([], [], greens)).toBeNull();
  });

  it('hex bins add up and every customer lands in one hexagon', () => {
    const points = [pt(0, 0, 3, 1), pt(0, 1, 2, 1), pt(0, 40, 5, 1)];
    const bins = hexBin(points, (p) => ({ x: p.lng, y: p.lat }), 20);
    expect(bins.reduce((t, b) => t + b.count, 0)).toBe(10);
    expect(bins.length).toBe(2);
    const classes = hexClasses(bins.map((b) => b.count));
    expect(classes[classes.length - 1].max).toBe(5);
    expect(hexColor(5, classes)).toBe(classes[classes.length - 1].color);
  });

  it('grid clusters merge near points and split when zoomed in', () => {
    const points = [pt(0, 0, 1, 1), pt(0, 1, 2, 1), pt(0, 100, 1, 1)];
    const proj = (p) => ({ x: p.lng, y: p.lat });
    const merged = gridCluster(points, proj, 44).sort((a, b) => b.count - a.count);
    expect(merged.map((c) => [c.count, c.single])).toEqual([[3, false], [1, true]]);
    expect(gridCluster(points, proj, 0).length).toBe(3);
  });

  it('summarizes a hover with no personal data', () => {
    const s = summarize([pt(1, 1, 2, 3), pt(1, 1, 1, 6, { tenure: 0, kind: 1, zip: true })]);
    expect(s).toEqual({ count: 3, avgRent: 100, avgMiles: 4, new90: 1, vehicle: 1, storage: 2, approx: 1 });
    // A group under 3 customers carries no rent: left out of the average, and alone it shows none.
    expect(summarize([{ count: 1, rent: null, miles: 2, tenure: 2, kind: 0, zip: 0 }]).avgRent).toBeNull();
    expect(summarize([{ count: 1, rent: null, miles: 2, tenure: 2, kind: 0, zip: 0 }, { count: 3, rent: 300, miles: 2, tenure: 2, kind: 0, zip: 0 }]).avgRent).toBe(100);
    const html = summaryHtml(s);
    expect(html).toMatch(/3 Customers/);
    expect(html).toMatch(/Average Rent<\/span><span>\$100\/mo/);
    expect(html).toMatch(/4\.0 mi/);
  });

  it('legend follows Color By', () => {
    const pts = [pt(1, 1, 2, 1, { tenure: 0 }), pt(1, 1, 1, 1, { kind: 1 })];
    expect(legendFor('kind', pts).map((x) => [x.label, x.count])).toEqual([['Self-Storage', 2], ['Vehicle/RV', 1]]);
    expect(legendFor('tenure', pts).map((x) => x.label)).toEqual(['New (Last 90 Days)', '90 Days - 1 Year', '1-3 Years', '3+ Years']);
    const bands = [{ band: 0, min: 20, max: 80 }, { band: 1, min: 80, max: 120 }, { band: 2, min: 120, max: 200 }, { band: 3, min: 200, max: 900 }];
    expect(legendFor('band', pts, bands).map((x) => x.label)).toEqual(['Up to $80', '$80-$120', '$120-$200', '$200+']);
  });

  it('labels the distance buckets', () => {
    expect(bucketLabel({ min: 0, max: 1 })).toBe('0-1 mi');
    expect(bucketLabel({ min: 50, max: null })).toBe('50+ mi');
  });
});
