import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Work sites are set by a searched, picked ADDRESS (Sep 30) - no pin placed
// by hand. The map only shows the site.

// jsdom has no SVG geometry, so Leaflet would find no renderer for the
// geofence circle; give it the one method its SVG check looks for, before
// Leaflet is first imported (the component is imported lazily below).
if (typeof SVGSVGElement !== 'undefined' && !SVGSVGElement.prototype.createSVGRect) {
  SVGSVGElement.prototype.createSVGRect = () => ({});
}

const nominatim = (items) => ({ ok: true, json: async () => items });
const hit = (display_name, lat, lon, extra = {}) => ({ display_name, lat: String(lat), lon: String(lon), ...extra });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('address search', () => {
  it('returns up to five matches and flags the ones that are not an exact address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(nominatim([
      hit('25260 North Centre City Parkway, Escondido, CA 92026', 33.17015, -117.106812, { address: { house_number: '25260' } }),
      hit('North Centre City Parkway, Escondido, CA', 33.16, -117.1, { addresstype: 'road', address: {} }),
    ]));
    const { searchAddresses } = await import('../lib/addressSearch');
    const out = await searchAddresses('25260 N Centre City Pkwy, Escondido');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ lat: 33.17015, lng: -117.106812, exact: true });
    expect(out[1].exact).toBe(false);
    expect(globalThis.fetch.mock.calls[0][0]).toContain('limit=5');
  });

  it('retries a miss with street suffixes spelled out', { timeout: 20000 }, async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(nominatim([]))
      .mockResolvedValueOnce(nominatim([hit('469 Bohemian Highway, Freestone, CA', 38.37, -122.91, { address: { house_number: '469' } })]));
    const { searchAddresses } = await import('../lib/addressSearch');
    const out = await searchAddresses('469 Bohemian Hwy, Sebastopol, CA');
    expect(out).toHaveLength(1);
    expect(decodeURIComponent(f.mock.calls[1][0])).toContain('Bohemian Highway');
  });
});

describe('metersBetween', () => {
  it('measures a fine-tuned pin against its address point', async () => {
    const { metersBetween } = await import('../lib/addressSearch');
    expect(Math.round(metersBetween([33.5186, -117.155], [33.5286, -117.155]))).toBe(1112);
    expect(metersBetween([33.5, -117.1], [33.5, -117.1])).toBe(0);
  });
});

describe('WorkSiteAddressMap', () => {
  it('sets the site from the picked address; the map cannot be clicked to move it', { timeout: 20000 }, async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(nominatim([
      hit('40940 County Center Drive, Temecula, CA 92591', 33.5186, -117.155, { address: { house_number: '40940' } }),
    ]));
    const WorkSiteAddressMap = (await import('./WorkSiteAddressMap')).default;
    const onPick = vi.fn();
    const { container } = render(<WorkSiteAddressMap lat="" lng="" radiusM={500} onPick={onPick} />);
    expect(screen.getByText('Search the address to place this location.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search the location's address"), { target: { value: '40940 County Center Dr, Temecula' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    const option = await waitFor(() => screen.getByRole('option'), { timeout: 8000 });
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith({ address: '40940 County Center Drive, Temecula, CA 92591', lat: 33.5186, lng: -117.155 });

    // Clicking the map picks nothing - there is no pin to place any more.
    onPick.mockClear();
    fireEvent.click(container.querySelector('[aria-label="Map of the location and its geofence"]'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('once an address is chosen, clicking the map moves the pin there', async () => {
    const WorkSiteAddressMap = (await import('./WorkSiteAddressMap')).default;
    const onAdjust = vi.fn();
    const { container, rerender } = render(<WorkSiteAddressMap lat="33.5186" lng="-117.155" radiusM={500} adjustable={false} onPick={() => {}} onAdjust={onAdjust} />);
    const mapEl = container.querySelector('[aria-label="Map of the location and its geofence"]');
    fireEvent.click(mapEl, { clientX: 120, clientY: 90 });
    expect(onAdjust).not.toHaveBeenCalled();          // an old map-pin site: search the address first
    expect(screen.getByText(/Search the address to confirm this location/)).toBeTruthy();

    rerender(<WorkSiteAddressMap lat="33.5186" lng="-117.155" radiusM={500} adjustable onPick={() => {}} onAdjust={onAdjust} />);
    fireEvent.click(mapEl, { clientX: 120, clientY: 90 });
    expect(onAdjust).toHaveBeenCalledTimes(1);
    const { lat, lng } = onAdjust.mock.calls[0][0];
    expect(Number.isFinite(lat) && Number.isFinite(lng)).toBe(true);
  });

  it('warns when the pin is far from the address point', async () => {
    const WorkSiteAddressMap = (await import('./WorkSiteAddressMap')).default;
    const { rerender } = render(<WorkSiteAddressMap lat="33.5186" lng="-117.155" radiusM={500} adjustable onPick={() => {}} onAdjust={() => {}} />);
    expect(screen.getByText(/Drag the pin \(or click the map\) onto the exact building/)).toBeTruthy();
    rerender(<WorkSiteAddressMap lat="33.5286" lng="-117.155" radiusM={500} adjustable onPick={() => {}} onAdjust={() => {}} />);
    expect(screen.getByText(/The pin is 0\.7 mi from the address/)).toBeTruthy();   // ~1.1 km, in US units
  });

  it('says so when nothing matches, and when the search is unreachable', { timeout: 30000 }, async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(nominatim([]));
    const WorkSiteAddressMap = (await import('./WorkSiteAddressMap')).default;
    render(<WorkSiteAddressMap lat="" lng="" radiusM={150} onPick={() => {}} />);
    const box = screen.getByLabelText("Search the location's address");
    fireEvent.change(box, { target: { value: 'nowhere at all' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => screen.getByText(/No address found/), { timeout: 8000 });

    f.mockRejectedValue(new Error('offline'));
    fireEvent.change(box, { target: { value: 'somewhere' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => screen.getByText(/Could not reach the address search/), { timeout: 8000 });
  });
});
