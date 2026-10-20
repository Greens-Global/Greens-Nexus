// Mark an Issue on the Map (Charmi, Oct 20 2026): the panel's button, the
// marking banner (Esc cancels), the hand-off of a finished mark to the screen,
// the spot tooltip, and the plain-data helpers. jsdom has no WebGL, so the
// viewer is mocked and its callbacks are called by hand.
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const viewers = [];
vi.mock('./siteModelViewer.js', async () => {
  const real = await vi.importActual('./siteModelViewer.js');
  return {
    ...real,
    createSiteModelViewer: (container, model, opts) => {
      const v = { opts, marking: [], spots: null, cleared: 0,
        selectUnit: () => false, clearSelection() {}, setMode() {}, setXray() {}, setLevel() {}, setPins() {}, setMarkers() {}, setPlacing() {}, setUnitColors() {},
        setBackground() {}, view() {}, flyToPin() {}, getState: () => ({}), destroy() {},
        setMarking(s) { v.marking.push(s); }, setSpots(s) { v.spots = s; }, clearMark() { v.cleared += 1; }, snapshot: () => 'data:image/jpeg;base64,AA==', focusSpot: vi.fn() };
      viewers.push(v); return v;
    },
  };
});

import { SiteModelPanel } from './SiteModelPanel.jsx';
import { finishStroke, isClosed } from './siteModelMarkup.js';
import { placeFor, spotFromMark } from './markSpot.js';
import { requestMapFocus, shapeWord } from './mapFocus.js';

const model = {
  property: { id: 'esc', name: 'Greens Storage Escondido' },
  frame: { lat0: 33.171, lon0: -117.1075, north: [-0.7705, 0.6374], mPerDegLat: 110900, mPerDegLon: 93200 },
  buildings: [{ id: 'C', name: 'Building C', u: [0, 100], v: [0, 20], height: 7, floors: 2 }],
  zones: [], gates: [{ id: 'main', name: 'Main Gate', uv: [50, 30] }],
  units: [{ n: 'C214', b: 'C', f: 2, u: 10, v: 2, wu: 3, dv: 4.5, k: 'cc', w: 10, d: 15, l: 1, r: 1 },
          { n: 'C001', b: 'C', f: 1, u: 0, v: 0, wu: 3, dv: 6, k: 'du', w: 10, d: 20, l: 0, r: 1 }],
  layout: {}, sources: [],
};
const last = () => viewers[viewers.length - 1];

describe('Mark an Issue on the map', () => {
  it('is offered only to a staff screen that can file the ticket', () => {
    const { unmount } = render(<SiteModelPanel model={model} mode="owner" images={{}} />);
    expect(screen.queryByRole('button', { name: /Mark an Issue/ })).toBeNull();
    unmount();
    render(<SiteModelPanel model={model} mode="customer" images={{}} onMarkIssue={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Mark an Issue/ })).toBeNull();
  });

  it('marks a spot and hands it to the screen with a picture of the map', () => {
    const onMarkIssue = vi.fn();
    render(<SiteModelPanel model={model} mode="owner" images={{}} modelId="greens-storage-escondido" onMarkIssue={onMarkIssue} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark an Issue/ }));
    expect(screen.getByText(/Draw on the map like a pen/)).toBeTruthy();   // the pen is the default tool
    expect(last().marking.at(-1)).toBe('pen');
    fireEvent.change(screen.getByLabelText('Marking Tool'), { target: { value: 'circle' } });
    expect(last().marking.at(-1)).toBe('circle');
    expect(screen.getByText(/Drag across the spot to circle it/)).toBeTruthy();
    act(() => { last().opts.onMark({ u: 5, v: 8, y: 0, r: 4, outline: [], unit: '', building: '' }); });
    expect(onMarkIssue).toHaveBeenCalledTimes(1);
    const [spot, snap] = onMarkIssue.mock.calls[0];
    expect(snap).toBe('data:image/jpeg;base64,AA==');
    expect(spot).toMatchObject({ modelId: 'greens-storage-escondido', u: 5, v: 8, r: 4, place: 'Near C001, Building C', ticketUnit: 'Common Area' });
    expect(spot.lat).toBeCloseTo(33.171, 2);
    expect(screen.queryByLabelText('Marking Tool')).toBeNull();   // marking ends with the mark
  });

  it('Esc cancels marking and clears the drawn shape', () => {
    render(<SiteModelPanel model={model} mode="owner" images={{}} onMarkIssue={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark an Issue/ }));
    const before = last().cleared;
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('Marking Tool')).toBeNull();
    expect(last().cleared).toBeGreaterThan(before);
    expect(last().marking.at(-1)).toBe(null);
  });

  it('draws open tickets\' spots, shows one on hover and opens it on click', () => {
    const onOpenSpot = vi.fn();
    const spots = [{ id: 'm1', ticketId: 'tk1', code: '000006', title: 'Pole light out', status: 'open', priority: 'high', place: 'Near C179, Building C', u: 1, v: 1, r: 5, photo: '' }];
    render(<SiteModelPanel model={model} mode="owner" images={{}} spots={spots} onOpenSpot={onOpenSpot} />);
    expect(last().spots).toEqual(spots);
    act(() => { last().opts.onHoverSpot(spots[0], { x: 40, y: 60 }); });
    expect(screen.getByRole('tooltip').textContent).toMatch(/#6 · Pole light out/);
    expect(screen.getByRole('tooltip').textContent).toMatch(/Open · High · Near C179/);
    act(() => { last().opts.onPickSpot(spots[0]); });
    expect(onOpenSpot).toHaveBeenCalledWith(spots[0]);
  });

  it('flies to a spot a ticket asked for (Open on Map)', () => {
    vi.useFakeTimers();
    requestMapFocus({ modelId: 'greens-storage-escondido', u: 5, v: 5, r: 3 });
    render(<SiteModelPanel model={model} mode="owner" images={{}} modelId="greens-storage-escondido" />);
    act(() => { vi.advanceTimersByTime(400); });
    expect(last().focusSpot).toHaveBeenCalledWith(expect.objectContaining({ u: 5, v: 5 }));
    vi.useRealTimers();
  });
});

describe('mark helpers', () => {
  it('names the place', () => {
    expect(placeFor(model, { unit: 'C214', u: 11, v: 3 })).toBe('Unit C214 · Building C, Level 2');
    expect(placeFor(model, { building: 'C', u: 50, v: 10 })).toBe('Building C');
    expect(placeFor(model, { u: 4, v: 9 })).toBe('Near C001, Building C');
    expect(placeFor(model, { u: 400, v: 400 })).toBe('On the site');
  });
  it('turns a stroke into a point, a circle or an outline', () => {
    const s = { u: 0, v: 0 };
    expect(finishStroke(s, [[0, 0], [0.3, 0.2]], 'circle')).toEqual({ u: 0, v: 0, r: 0, outline: [] });
    // Circle: the press and the cursor are the ends of the diameter, so its edge stays under the cursor.
    expect(finishStroke(s, [[0, 0], [6, 8]], 'circle')).toEqual({ u: 3, v: 4, r: 5, outline: [] });
    // Pen: every point kept (thinned to 200), closed when the ends meet, open otherwise.
    const ring = Array.from({ length: 500 }, (_, i) => [10 * Math.cos(i / 79.4), 10 * Math.sin(i / 79.4)]);
    const o = finishStroke(s, ring, 'pen');
    expect(o.outline.length).toBeLessThanOrEqual(200);
    expect(o.r).toBeGreaterThan(9);
    expect(isClosed(o.outline)).toBe(true);
    expect(isClosed([[0, 0], [5, 0], [10, 0], [15, 0]])).toBe(false);
    expect(finishStroke(s, [[0, 0], [0.2, 0], [0.3, 0.1]], 'pen').r).toBe(0);   // a dab is a pin
  });
  it('spotFromMark carries the unit it was marked on', () => {
    expect(spotFromMark(model, 'm', { u: 11, v: 3, unit: 'C214', building: 'C' })).toMatchObject({ unit: 'C214', ticketUnit: 'C214', building: 'C' });
    expect(shapeWord({ r: 0 })).toBe('Pin');
    expect(shapeWord({ outline: [[0, 0], [1, 0], [1, 1]] })).toBe('Drawn with the pen');
  });
});
