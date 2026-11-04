import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

// The Egnyte Folder field on a property's Details (Neil, 11/03/2026): a
// property may pin its exact Egnyte folder instead of matching by name. Read
// mode shows the pin (or that it is matched by name); edit mode takes a pasted
// path, or Find Folder lists the server's candidates to pick from; the save
// hands the path on; Egnyte not set up is explained, never an error.

vi.mock('./PhotoGallery.jsx', () => ({ PhotoGallery: () => null }));
vi.mock('./SiteModelSection.jsx', () => ({ SiteModelSection: () => null }));
vi.mock('./PropertyMapLink.jsx', () => ({ PropertyMapLink: () => null }));
const find = vi.fn();
vi.mock('../../../api.js', () => ({ api: { findAssetEgnyteFolders: (...a) => find(...a) } }));

const { AssetDetailForm } = await import('./AssetDetailForm.jsx');
const { editGuard } = await import('../../lib/editGuard.js');

const PROPERTY = { id: 'a1', kind: 'property', name: 'Escondido', address: '1 Main St', city: 'Escondido', state: 'CA' };
const PIN = '/Shared/--Asset Management/GS Escondido';
const ROOTS = ['/Shared/#Entities', '/Shared/--Asset Management'];

afterEach(() => { cleanup(); find.mockReset(); });

const rowOf = (label) => document.querySelector(`[data-fl="${label.toLowerCase()}"]`);

describe('AssetDetailForm - Egnyte Folder', () => {
  it('shows the pinned folder, or that it is matched by name, in read mode', () => {
    const { unmount } = render(<AssetDetailForm p={{ ...PROPERTY, egnyteFolder: PIN }} />);
    expect(rowOf('Egnyte Folder').textContent).toContain(PIN);
    unmount();
    render(<AssetDetailForm p={PROPERTY} />);
    expect(rowOf('Egnyte Folder').textContent).toContain('Not pinned - matched by name');
  });

  it('lists the candidates Find Folder returns and saves the one picked', async () => {
    find.mockResolvedValue({
      configured: true, site: 'Escondido', roots: ROOTS, match: null, why: 'ambiguous',
      message: "More than one Egnyte folder could be this property's - pick the right one.",
      candidates: [
        { path: '/Shared/#Entities/Escondido North', name: 'Escondido North', root: '/Shared/#Entities', how: 'contains' },
        { path: '/Shared/#Entities/Escondido South', name: 'Escondido South', root: '/Shared/#Entities', how: 'contains' },
      ],
    });
    const onSaveDetail = vi.fn();
    render(<AssetDetailForm p={PROPERTY} onSaveDetail={onSaveDetail} />);
    act(() => { editGuard.startEdit(); });
    fireEvent.click(screen.getByRole('button', { name: /Find Folder/ }));
    expect(find).toHaveBeenCalledWith('a1', '');
    await screen.findByText(/pick the right one/);
    fireEvent.click(screen.getByRole('button', { name: 'Pin /Shared/#Entities/Escondido South' }));
    expect(screen.getByRole('textbox', { name: 'Egnyte Folder' }).value).toBe('/Shared/#Entities/Escondido South');
    act(() => { editGuard.save(); });
    expect(onSaveDetail.mock.calls[0][0]['Egnyte Folder']).toBe('/Shared/#Entities/Escondido South');
  });

  it('marks the best match and searches a typed name', async () => {
    find.mockResolvedValue({
      configured: true, site: 'GS Esc', roots: ROOTS, match: PIN, why: 'matched', message: '',
      candidates: [{ path: PIN, name: 'GS Escondido', root: '/Shared/--Asset Management', how: 'exact' }],
    });
    render(<AssetDetailForm p={PROPERTY} onSaveDetail={() => {}} />);
    act(() => { editGuard.startEdit(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Egnyte Folder' }), { target: { value: 'GS Esc' } });
    expect(screen.getByText(/a name alone is not a folder/)).toBeTruthy();
    // Moving to the button blurs the box first: a bare name must stay a name.
    fireEvent.blur(screen.getByRole('textbox', { name: 'Egnyte Folder' }));
    expect(screen.getByRole('textbox', { name: 'Egnyte Folder' }).value).toBe('GS Esc');
    fireEvent.click(screen.getByRole('button', { name: /Find Folder/ }));
    expect(find).toHaveBeenCalledWith('a1', 'GS Esc');
    expect(await screen.findByText('Best Match')).toBeTruthy();
    act(() => { editGuard.cancel(); });
  });

  it('explains when Egnyte is not set up, and a pasted path still saves', async () => {
    find.mockResolvedValue({ configured: false, roots: ROOTS, candidates: [],
      message: "Egnyte is not set up on this server - paste the folder's path instead." });
    const onSaveDetail = vi.fn();
    render(<AssetDetailForm p={PROPERTY} onSaveDetail={onSaveDetail} />);
    act(() => { editGuard.startEdit(); });
    fireEvent.click(screen.getByRole('button', { name: /Find Folder/ }));
    await screen.findByText(/Egnyte is not set up on this server/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Egnyte Folder' }), { target: { value: 'Shared//--Asset Management/GS Escondido/' } });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Egnyte Folder' }));
    expect(screen.getByRole('textbox', { name: 'Egnyte Folder' }).value).toBe(PIN);
    act(() => { editGuard.save(); });
    expect(onSaveDetail.mock.calls[0][0]['Egnyte Folder']).toBe(PIN);
  });

  it('warns about a path that will be refused', async () => {
    find.mockResolvedValue({ configured: true, site: 'Escondido', roots: ROOTS, match: null, why: 'no_match', message: 'No Egnyte folder matched this name - paste the folder\'s path, or search another name.', candidates: [] });
    render(<AssetDetailForm p={PROPERTY} onSaveDetail={() => {}} />);
    act(() => { editGuard.startEdit(); });
    const box = screen.getByRole('textbox', { name: 'Egnyte Folder' });
    fireEvent.change(box, { target: { value: '/Shared/#Entities/../HR' } });
    expect(screen.getByRole('alert').textContent).toContain("'..'");
    fireEvent.change(box, { target: { value: '/Private/HR' } });
    fireEvent.click(screen.getByRole('button', { name: /Find Folder/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('must be inside /Shared/#Entities or /Shared/--Asset Management'));
    act(() => { editGuard.cancel(); });
  });
});
