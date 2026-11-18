import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// The On This Page rail (Neil, 10/28/2026: no tinted box, no thick left bar).
// Its look lives in asset-styles.scoped.css (.gt-toc-item); the buttons carry
// no inline background or accent bar of their own, and a click still jumps.
// Since 11/17/2026 the rail is edit mode's: read mode is the overview's own
// sections, filled fields only, with one "Not filled" line each.

vi.mock('./PhotoGallery.jsx', () => ({ PhotoGallery: () => null }));
vi.mock('./SiteModelSection.jsx', () => ({ SiteModelSection: () => null }));
vi.mock('./PropertyMapLink.jsx', () => ({ PropertyMapLink: () => null }));

const { AssetDetailForm } = await import('./AssetDetailForm.jsx');
const { editGuard } = await import('../../lib/editGuard.js');

const ASSET = {
  id: 'a1', assetClass: 'property', name: 'Greens Storage, Valley Center (South)',
  address: '28407 Lizard Rocks Road', city: 'Valley Center', state: 'CA', type: 'Self Storage',
};

afterEach(() => { act(() => { editGuard.cancel?.(); }); cleanup(); });

describe('AssetDetailForm - On This Page', () => {
  it('draws the rail as flat items with no inline box or accent bar', () => {
    render(<AssetDetailForm p={ASSET} />);
    expect(screen.queryByRole('navigation', { name: 'On This Page' })).toBeNull();   // read mode has none
    act(() => { editGuard.startEdit(); });
    const nav = screen.getByRole('navigation', { name: 'On This Page' });
    const items = nav.querySelectorAll('button');
    expect(items.length).toBeGreaterThan(2);
    items.forEach((b) => {
      expect(b.className).toBe('gt-toc-item');
      expect(b.style.background).toBe('');
      expect(b.style.boxShadow).toBe('');
      expect(b.style.borderRadius).toBe('');
    });
  });

  it('jumps to the section a rail item names', () => {
    render(<AssetDetailForm p={ASSET} />);
    act(() => { editGuard.startEdit(); });
    const target = document.getElementById('gt-sec0');
    target.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('navigation', { name: 'On This Page' }).querySelector('button'));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});

describe('AssetDetailForm - read mode', () => {
  it('shows filled fields as pairs, names the rest once, and folds empty sections into one row', () => {
    const onFillIn = vi.fn();
    const op = { ...ASSET, devStage: 'Stabilized', entity: 'Greens Valley LLC', zip: '' };
    render(<AssetDetailForm p={op} onFillIn={onFillIn} />);
    // An operating property reads under Location / Site and Building / Ownership and Team.
    expect(screen.getByRole('heading', { name: 'Location' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ownership and Team' })).toBeTruthy();
    expect(document.querySelector('[data-fl="city"]').textContent).toContain('Valley Center');
    expect(document.querySelector('[data-fl="zip"]')).toBeNull();               // empty: not a row
    const location = screen.getByRole('region', { name: 'Location' });
    expect(location.textContent).toMatch(/Not filled: .*Zip/);
    fireEvent.click(screen.getByRole('button', { name: 'Fill in Location' }));
    expect(onFillIn).toHaveBeenCalledTimes(1);
    // Insurance, Property Tax... have nothing: one row, not a card each.
    const nothing = screen.getByRole('region', { name: 'Nothing Recorded Yet' });
    expect(nothing.textContent).toMatch(/Insurance/);
    expect(screen.queryByRole('heading', { name: 'Insurance' })).toBeNull();
    // The name and the stage are in the title band, never repeated here.
    expect(document.querySelector('[data-fl="project name"]')).toBeNull();
  });
});
