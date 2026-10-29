import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The On This Page rail (Neil, 10/28/2026: no tinted box, no thick left bar).
// Its look lives in asset-styles.scoped.css (.gt-toc-item); the buttons carry
// no inline background or accent bar of their own, and a click still jumps.

vi.mock('./PhotoGallery.jsx', () => ({ PhotoGallery: () => null }));
vi.mock('./SiteModelSection.jsx', () => ({ SiteModelSection: () => null }));
vi.mock('./PropertyMapLink.jsx', () => ({ PropertyMapLink: () => null }));

const { AssetDetailForm } = await import('./AssetDetailForm.jsx');

const ASSET = {
  id: 'a1', assetClass: 'property', name: 'Greens Storage, Valley Center (South)',
  address: '28407 Lizard Rocks Road', city: 'Valley Center', state: 'CA', type: 'Self Storage',
};

afterEach(cleanup);

describe('AssetDetailForm - On This Page', () => {
  it('draws the rail as flat items with no inline box or accent bar', () => {
    render(<AssetDetailForm p={ASSET} />);
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
    const target = document.getElementById('gt-sec0');
    target.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('navigation', { name: 'On This Page' }).querySelector('button'));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
