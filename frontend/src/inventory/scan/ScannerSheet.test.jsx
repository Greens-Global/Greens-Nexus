import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

// Items phase 4: the live camera scanner, with the camera, the decoder and
// the server mocked. A code that names an item opens it and the camera goes
// off; an unknown code says so with Scan Again; a denied camera explains how
// to allow it and offers Type a Serial; the camera stops on close, unmount
// and a hidden tab. iPhone Safari's path (no BarcodeDetector -> jsqr) is
// covered with the real createDecoder and a mocked jsqr.

vi.mock('../../api', () => ({ api: { getItemByCode: vi.fn(async () => { throw Object.assign(new Error('nf'), { status: 404 }); }) } }));
const { default: ScannerSheet } = await import('./ScannerSheet');
const { createDecoder } = await import('./decoder');

const ORIGIN = window.location.origin;
const ITEMS = [
  { id: 'it-a', name: 'Hammer Drill', serialNumber: 'GG-00042', location: 'Austin Yard' },
  { id: 'it-b', name: 'Laser Level', serialNumber: 'GG-00043' },
];

function fakeStream({ torch = false } = {}) {
  const track = { stop: vi.fn(), getCapabilities: () => (torch ? { torch: true } : {}), applyConstraints: vi.fn(async () => {}) };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}
const deniedErr = () => Object.assign(new Error('denied'), { name: 'NotAllowedError' });
const decoderReturning = (...codes) => async () => ({ kind: 'native', decode: vi.fn(async () => codes.shift() ?? '') });

beforeAll(() => {
  // jsdom never plays video: give the element a frame so the loop reads.
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return this._src || null; }, set(v) { this._src = v; } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the scanner', () => {
  it('opens the item a tag names and turns the camera off', async () => {
    const { stream, track } = fakeStream();
    const onFound = vi.fn();
    render(<ScannerSheet items={ITEMS} onFound={onFound} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => stream, createDecoder: decoderReturning('', `${ORIGIN}/itemmanagement/item/it-b`) }} />);
    await waitFor(() => expect(onFound).toHaveBeenCalledWith(ITEMS[1]));
    expect(track.stop).toHaveBeenCalled();
  });

  it('reads a serial barcode too', async () => {
    const { stream } = fakeStream();
    const onFound = vi.fn();
    render(<ScannerSheet items={ITEMS} onFound={onFound} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => stream, createDecoder: decoderReturning('gg-00042') }} />);
    await waitFor(() => expect(onFound).toHaveBeenCalledWith(ITEMS[0]));
  });

  it('an unknown code: a calm message and Scan Again', async () => {
    const { stream, track } = fakeStream();
    const start = vi.fn(async () => stream);
    render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={() => {}}
      deps={{ support: 'ok', startCamera: start, createDecoder: decoderReturning('NOPE-9'), fetchByCode: async () => { throw Object.assign(new Error('nf'), { status: 404 }); } }} />);
    expect(await screen.findByText('No Item Matches This Code')).toBeInTheDocument();
    expect(track.stop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Scan Again/ }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it('a tag from another company: "You Do Not Have Access to This Item"', async () => {
    const { stream } = fakeStream();
    render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => stream, createDecoder: decoderReturning(`${ORIGIN}/itemmanagement/item/walled`), fetchByCode: async () => { throw Object.assign(new Error('nf'), { status: 404 }); } }} />);
    expect(await screen.findByText('You Do Not Have Access to This Item')).toBeInTheDocument();
  });

  it('another site\'s QR code is not an item tag', async () => {
    const { stream } = fakeStream();
    const fetchByCode = vi.fn();
    render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => stream, createDecoder: decoderReturning('https://example.com/menu'), fetchByCode }} />);
    expect(await screen.findByText('Not a Nexus Item Tag')).toBeInTheDocument();
    expect(fetchByCode).not.toHaveBeenCalled();
  });

  it('camera denied: how to allow it, Try Again, and Type a Serial that searches', async () => {
    const onFound = vi.fn();
    render(<ScannerSheet items={ITEMS} onFound={onFound} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => { throw deniedErr(); }, createDecoder: decoderReturning() }} />);
    expect(await screen.findByText('Camera Access Is Off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Type a Serial/ })[0]);
    const box = screen.getByLabelText('Serial or Item Name');
    fireEvent.change(box, { target: { value: 'laser' } });
    fireEvent.click(screen.getByRole('listitem', { name: undefined }));
    expect(onFound).toHaveBeenCalledWith(ITEMS[1]);
  });

  it('Type a Serial asks the server for what the screen does not hold', async () => {
    const onFound = vi.fn();
    const fetchByCode = vi.fn(async () => ({ id: 'it-z', name: 'Generator' }));
    render(<ScannerSheet items={ITEMS} onFound={onFound} onClose={() => {}} deps={{ support: 'unsupported', fetchByCode }} />);
    expect(screen.getByText('This Browser Cannot Scan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Type a Serial/ })[0]);
    fireEvent.change(screen.getByLabelText('Serial or Item Name'), { target: { value: 'gg 99' } });
    fireEvent.click(screen.getByRole('button', { name: /Find/ }));
    await waitFor(() => expect(onFound).toHaveBeenCalledWith({ id: 'it-z', name: 'Generator' }));
    expect(fetchByCode).toHaveBeenCalledWith('gg 99');
  });

  it('turns the torch on where the camera has one', async () => {
    const { stream, track } = fakeStream({ torch: true });
    render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => stream, createDecoder: async () => ({ kind: 'native', decode: async () => '' }) }} />);
    const btn = await screen.findByRole('button', { name: /Light On/ });
    fireEvent.click(btn);
    await waitFor(() => expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }));
    expect(await screen.findByRole('button', { name: /Light Off/ })).toBeInTheDocument();
  });

  it('stops the camera on close, on unmount and when the tab is hidden', async () => {
    const a = fakeStream();
    const onClose = vi.fn();
    const idle = async () => ({ kind: 'native', decode: async () => '' });
    const first = render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={onClose} deps={{ support: 'ok', startCamera: async () => a.stream, createDecoder: idle }} />);
    await screen.findByText('Point the camera at the QR tag on the item');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1));
    expect(a.track.stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    first.unmount();

    const b = fakeStream();
    const second = render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={() => {}} deps={{ support: 'ok', startCamera: async () => b.stream, createDecoder: idle }} />);
    await screen.findByText('Point the camera at the QR tag on the item');
    second.unmount();
    expect(b.track.stop).toHaveBeenCalled();

    const c = fakeStream();
    const start = vi.fn(async () => c.stream);
    render(<ScannerSheet items={ITEMS} onFound={vi.fn()} onClose={() => {}} deps={{ support: 'ok', startCamera: start, createDecoder: idle }} />);
    await screen.findByText('Point the camera at the QR tag on the item');
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(c.track.stop).toHaveBeenCalled();
    expect(await screen.findByText('The camera is paused')).toBeInTheDocument();
    vis.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it('iPhone Safari: no BarcodeDetector, jsqr reads the frame', async () => {
    expect(window.BarcodeDetector).toBeUndefined();
    const jsQR = vi.fn(() => ({ data: `${ORIGIN}/itemmanagement/item/it-a` }));
    const ctx = { drawImage: vi.fn(), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
    const { stream } = fakeStream();
    const onFound = vi.fn();
    render(<ScannerSheet items={ITEMS} onFound={onFound} onClose={() => {}}
      deps={{ support: 'ok', startCamera: async () => stream, createDecoder: () => createDecoder({ loadJsQR: async () => jsQR }) }} />);
    await waitFor(() => expect(onFound).toHaveBeenCalledWith(ITEMS[0]));
    expect(jsQR).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 640, 480, { inversionAttempts: 'attemptBoth' });
  });
});
