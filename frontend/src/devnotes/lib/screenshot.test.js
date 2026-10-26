import { describe, it, expect, vi, afterEach } from 'vitest';
import { frameScale, cropRect, burnMarkup, applyRedactions, paintBoxes, shiftItems, startTabCapture, stopTabCapture, captureStatus, wantsTabCapture, setWantsTabCapture, areaAround, areaRoot, pruneAbove, padCopy, makeShots } from './screenshot';

vi.mock('../store', () => ({ store: { set: () => {} } }));

// Crop math (DPR-aware) and the markup burn on a canvas mock.

const mockCtx = () => ({
  calls: [],
  save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
  stroke() { this.calls.push('stroke'); }, fill() { this.calls.push('fill'); },
  strokeRect(...a) { this.calls.push(['strokeRect', ...a]); }, fillRect(...a) { this.calls.push(['fillRect', ...a]); },
  fillText(t, x, y) { this.calls.push(['fillText', t, x, y]); }, strokeText() {}, clearRect() {}, drawImage(...a) { this.calls.push(['drawImage', a.length]); },
  lineWidth: 1, strokeStyle: '', fillStyle: '', globalAlpha: 1, font: '', textBaseline: '', imageSmoothingEnabled: true, lineCap: '', lineJoin: '',
});

afterEach(() => vi.restoreAllMocks());

describe('screenshot', () => {
  it('frameScale is frame pixels per CSS pixel (a 2x tab = 2, 2)', () => {
    expect(frameScale(2560, 1440, 1280, 720)).toEqual({ sx: 2, sy: 2 });
    expect(frameScale(1280, 720, 0, 0)).toEqual({ sx: 1, sy: 1 });
  });

  it('cropRect pads the target, scales it and clamps to the frame', () => {
    const s = { sx: 2, sy: 2 };
    expect(cropRect({ x: 100, y: 50, w: 120, h: 32 }, s, { w: 2560, h: 1440 }, 24)).toEqual({ x: 152, y: 52, w: 336, h: 160 });
    // At the top-left corner the padding cannot go negative...
    expect(cropRect({ x: 4, y: 0, w: 50, h: 20 }, s, { w: 2560, h: 1440 }, 24)).toEqual({ x: 0, y: 0, w: 156, h: 88 });
    // ...and at the far edge it stops at the frame.
    expect(cropRect({ x: 1250, y: 700, w: 100, h: 100 }, s, { w: 2560, h: 1440 }, 24)).toEqual({ x: 2452, y: 1352, w: 108, h: 88 });
  });

  it('burnMarkup draws every item type at frame scale and skips redact', () => {
    const ctx = mockCtx();
    const n = burnMarkup(ctx, [
      { type: 'rect', x: 10, y: 20, w: 30, h: 40, color: '#ef4444', width: 3 },
      { type: 'arrow', x1: 0, y1: 0, x2: 50, y2: 50, color: '#ef4444' },
      { type: 'path', points: [[1, 1], [2, 2], [3, 3]], color: '#3b82f6' },
      { type: 'highlight', x: 0, y: 0, w: 10, h: 10, color: '#facc15' },
      { type: 'text', x: 5, y: 6, text: 'move this up', color: '#111827', size: 16 },
      { type: 'redact', x: 0, y: 0, w: 10, h: 10 },
    ], { sx: 2, sy: 2 });
    expect(n).toBe(5);
    expect(ctx.calls).toContainEqual(['strokeRect', 20, 40, 60, 80]);
    expect(ctx.calls).toContainEqual(['fillRect', 0, 0, 20, 20]);
    expect(ctx.calls).toContainEqual(['fillText', 'move this up', 10, 12]);
    expect(ctx.calls.filter((c) => c === 'stroke').length).toBe(2);     // arrow shaft + path
    expect(ctx.calls.filter((c) => c === 'fill').length).toBe(1);       // arrow head
  });

  it('burnMarkup shifts by the offset first (a pin re-drawn after layout moved)', () => {
    const ctx = mockCtx();
    burnMarkup(ctx, [{ type: 'rect', x: 10, y: 10, w: 10, h: 10 }], { sx: 1, sy: 1 }, { dx: 5, dy: -5 });
    expect(ctx.calls).toContainEqual(['strokeRect', 15, 5, 10, 10]);
  });

  it('paintBoxes covers every sensitive field in opaque black, slightly larger than the field', () => {
    const ctx = mockCtx();
    expect(paintBoxes(ctx, [{ x: 10, y: 10, w: 100, h: 20 }, { x: 0, y: 0, w: 0, h: 5 }], { sx: 1, sy: 1 })).toBe(1);
    expect(ctx.calls).toContainEqual(['fillRect', 9, 9, 102, 22]);
    expect(ctx.fillStyle).toBe('#000');
  });

  it('applyRedactions pixelates each redact box through a small canvas and never leaves it untouched', () => {
    const ctx = mockCtx();
    const small = { width: 0, height: 0, getContext: () => mockCtx() };
    vi.spyOn(document, 'createElement').mockImplementation(() => small);
    const canvas = { width: 1000, height: 800 };
    const n = applyRedactions(ctx, canvas, [{ type: 'redact', x: 100, y: 100, w: 120, h: 24 }, { type: 'rect', x: 0, y: 0, w: 5, h: 5 }], { sx: 1, sy: 1 });
    expect(n).toBe(1);
    expect(small.width).toBe(10);                                        // 120 / 12-px blocks
    expect(ctx.calls.filter((c) => c[0] === 'drawImage').length).toBe(1);
    expect(ctx.calls).toContainEqual(['fillRect', 100, 100, 120, 24]);  // the darkening wash on top
    expect(applyRedactions(ctx, canvas, [], { sx: 1, sy: 1 })).toBe(0);
  });

  it('shiftItems moves page-coordinate items to the viewport of the capture (every item type)', () => {
    const items = [
      { type: 'redact', x: 100, y: 1100, w: 50, h: 20 },
      { type: 'arrow', x1: 0, y1: 1000, x2: 10, y2: 1010 },
      { type: 'path', points: [[5, 1005], [6, 1006]] },
      { type: 'text', x: 1, y: 1001, text: 't' },
    ];
    const out = shiftItems(items, 0, -1000);   // the page was scrolled 1000px down when the shot was taken
    expect(out[0]).toMatchObject({ x: 100, y: 100, w: 50, h: 20 });
    expect(out[1]).toMatchObject({ x1: 0, y1: 0, x2: 10, y2: 10 });
    expect(out[2].points).toEqual([[5, 5], [6, 6]]);
    expect(out[3]).toMatchObject({ x: 1, y: 1 });
    expect(items[0].y).toBe(1100);               // never in place
    // Redaction then lands on the right pixels of the frame.
    const ctx = mockCtx();
    vi.spyOn(document, 'createElement').mockImplementation(() => ({ width: 0, height: 0, getContext: () => mockCtx() }));
    applyRedactions(ctx, { width: 1000, height: 800 }, out, { sx: 1, sy: 1 });
    expect(ctx.calls).toContainEqual(['fillRect', 100, 100, 50, 20]);
  });

  it('startTabCapture: a stop while the picker is open closes the stream that then lands; a second start joins the first', async () => {
    let resolve;
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const fakeStream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const gdm = vi.fn(() => new Promise((r) => { resolve = r; }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: gdm }, configurable: true });
    const p1 = startTabCapture();
    const p2 = startTabCapture();              // StrictMode's second run
    expect(gdm).toHaveBeenCalledTimes(1);
    expect(p2).toBe(p1);
    stopTabCapture();                          // the mode went off before the person answered the picker
    resolve(fakeStream);
    expect(await p1).toBe(false);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(captureStatus()).not.toBe('live');
    expect(document.querySelector('video')).toBeNull();
    delete navigator.mediaDevices;
  });
});

describe('page picture without a prompt', () => {
  const box = (el, top, h, left = 0, w = 800) => {
    el.getBoundingClientRect = () => ({ top, bottom: top + h, left, right: left + w, x: left, y: top, width: w, height: h });
    el.getClientRects = () => (h || w ? [1] : []);
  };

  it('areaAround grows the element by the pad and stays inside the viewport', () => {
    expect(areaAround({ x: 300, y: 200, w: 100, h: 40 }, 1000, 800, 96)).toEqual({ x: 204, y: 104, w: 292, h: 232 });
    expect(areaAround({ x: 10, y: 750, w: 100, h: 40 }, 1000, 800, 96)).toEqual({ x: 0, y: 654, w: 206, h: 146 });
  });

  it('areaRoot climbs to the smallest ancestor that holds the area', () => {
    document.body.innerHTML = '<div id="page"><div id="card"><span id="cell">x</span></div></div>';
    box(document.getElementById('cell'), 300, 20, 300, 60);
    box(document.getElementById('card'), 250, 120, 200, 400);
    box(document.getElementById('page'), 0, 1000, 0, 1200);
    expect(areaRoot(document.getElementById('cell'), { x: 250, y: 280, w: 200, h: 60 }).id).toBe('card');
    expect(areaRoot(document.getElementById('cell'), { x: 100, y: 200, w: 900, h: 200 }).id).toBe('page');
  });

  it('pruneAbove cuts the leading rows of a one-column list that end above the area and tags their height; the undo clears it', () => {
    document.body.innerHTML = '<div id="list"><div id="r1"></div><div id="r2"></div><div id="r3"></div><div id="r4"></div></div>';
    const list = document.getElementById('list');
    box(list, -100, 400);
    ['r1', 'r2', 'r3', 'r4'].forEach((id, i) => box(document.getElementById(id), -100 + i * 100, 100));
    const { cut, undo } = pruneAbove(list, { x: 0, y: 150, w: 800, h: 100 });
    expect([...cut].map((n) => n.id)).toEqual(['r1', 'r2']);
    expect(list.getAttribute('data-bm-pad')).toBe('200');
    undo();
    expect(list.hasAttribute('data-bm-pad')).toBe(false);
  });

  it('pruneAbove leaves multi-column grids and fully-visible lists alone', () => {
    document.body.innerHTML = '<div id="grid" style="display:grid;grid-template-columns:1fr 1fr"><div id="a"></div><div id="b"></div><div id="c"></div></div>';
    const grid = document.getElementById('grid');
    box(grid, -100, 300); box(document.getElementById('a'), -100, 100); box(document.getElementById('b'), -100, 100); box(document.getElementById('c'), 0, 100);
    expect(pruneAbove(grid, { x: 0, y: 50, w: 800, h: 100 }).cut.size).toBe(0);
    document.body.innerHTML = '<div id="list"><div id="r1"></div><div id="r2"></div></div>';
    box(document.getElementById('list'), 100, 200); box(document.getElementById('r1'), 100, 100); box(document.getElementById('r2'), 200, 100);
    expect(pruneAbove(document.getElementById('list'), { x: 0, y: 50, w: 800, h: 100 }).cut.size).toBe(0);
  });

  it('padCopy turns the tag into top padding on the copy and removes it', () => {
    const n = document.createElement('div');
    n.setAttribute('data-bm-pad', '200');
    n.style.paddingTop = '8px';
    padCopy(n);
    expect(n.style.paddingTop).toMatch(/^calc\((8px \+ 200px|208px)\)$/);   // jsdom folds the sum
    expect(n.hasAttribute('data-bm-pad')).toBe(false);
  });

  it('makeShots gives no page shot from an area picture', async () => {
    const ctx = { drawImage() {}, save() {}, restore() {}, fillRect() {}, clearRect() {} };
    const proto = HTMLCanvasElement.prototype;
    const saved = [proto.getContext, proto.toBlob];
    proto.getContext = () => ctx;
    proto.toBlob = function (cb) { cb(new Blob(['x'], { type: 'image/png' })); };
    try {
      const frame = document.createElement('canvas'); frame.width = 1000; frame.height = 800;
      const area = await makeShots({ frame, rect: { x: 100, y: 100, w: 50, h: 20 }, vp: { w: 1000, h: 800 }, whole: false, pad: 96 });
      expect(area.page).toBeNull();
      expect(area.element).toBeTruthy();
      const tab = await makeShots({ frame, rect: { x: 100, y: 100, w: 50, h: 20 }, vp: { w: 1000, h: 800 } });
      expect(tab.page).toBeTruthy();
    } finally { [proto.getContext, proto.toBlob] = saved; }
  });

  it('tab capture is off unless the person turned it on in this browser', () => {
    localStorage.removeItem('nexus:build-mode:tab-capture');
    expect(wantsTabCapture()).toBe(false);
    setWantsTabCapture(true);
    expect(wantsTabCapture()).toBe(true);
    setWantsTabCapture(false);
    expect(wantsTabCapture()).toBe(false);
  });
});
