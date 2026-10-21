import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// C1 finish pass (Oct 2026): thumbnails are buttons, the lightbox is a dialog
// with a Close button that takes focus, Escape closes it and focus returns to
// the thumbnail that opened it. The Media header folds from a button.
vi.mock('../../lib/upload.js', () => ({ storeAssetImage: vi.fn() }));

const { PhotoGallery } = await import('./PhotoGallery.jsx');

afterEach(cleanup);

const ASSET = { id: 'a1', name: 'Lot 1', images: ['https://x.test/1.jpg', 'https://x.test/2.jpg'] };

describe('PhotoGallery lightbox', () => {
  it('opens from a thumbnail button, focuses Close, closes on Escape and hands focus back', () => {
    render(<PhotoGallery p={ASSET} onSave={vi.fn()} />);
    const thumb = screen.getByRole('button', { name: 'Open photo 2 of 2' });
    fireEvent.click(thumb);
    const dialog = screen.getByRole('dialog', { name: 'Photo' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it('closes from the Close button and on a click outside the picture', () => {
    render(<PhotoGallery p={ASSET} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open photo 1 of 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open photo 1 of 2' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('folds the Media section from a button with aria-expanded', () => {
    render(<PhotoGallery p={ASSET} onSave={vi.fn()} />);
    const fold = screen.getByRole('button', { name: /Media \(2\)/ });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Open photo 1 of 2' })).toBeNull();
  });
});
