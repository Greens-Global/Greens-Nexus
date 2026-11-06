import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// Plans & Docs from the asset's connected Egnyte folder (Neil, 11/05/2026):
// a viewer browses and opens the files through the asset-scoped routes; an
// unconnected asset offers Connect to editors only; once connected only an
// Owner sees Change Folder, and the Details field is read only for the rest.

vi.mock('./PhotoGallery.jsx', () => ({ PhotoGallery: () => null }));
vi.mock('./SiteModelSection.jsx', () => ({ SiteModelSection: () => null }));
vi.mock('./PropertyMapLink.jsx', () => ({ PropertyMapLink: () => null }));
const folder = vi.fn();
const file = vi.fn();
vi.mock('../../../api.js', () => ({ api: {
  assetEgnyteFolder: (...a) => folder(...a),
  assetEgnyteFile: (...a) => file(...a),
  findAssetEgnyteFolders: vi.fn(),
} }));

const { AssetEgnyteDocs } = await import('./AssetEgnyteDocs.jsx');
const { AssetDetailForm } = await import('./AssetDetailForm.jsx');
const { editGuard } = await import('../../lib/editGuard.js');

const PIN = '/Shared/--Asset Management/GS Escondido';
const ASSET = { id: 'a1', kind: 'property', name: 'Escondido', egnyteFolder: PIN };
const LISTING = {
  connected: true, configured: true, folder: PIN, mayChange: false, path: PIN, webUrl: 'https://x/y',
  folders: [{ name: 'Plans', path: `${PIN}/Plans` }],
  files: [{ name: 'CO.pdf', path: `${PIN}/CO.pdf`, size: 10 }],
};

afterEach(() => { cleanup(); folder.mockReset(); file.mockReset(); });

describe('AssetEgnyteDocs', () => {
  it('lists the connected folder, opens a subfolder and previews through the asset route', async () => {
    folder.mockResolvedValue(LISTING);
    file.mockResolvedValue({ blob: new Blob(['%PDF']) });
    render(<AssetEgnyteDocs asset={ASSET} canConnect={false} onConnect={vi.fn()} />);
    expect(await screen.findByText('CO.pdf')).toBeTruthy();
    expect(folder).toHaveBeenCalledWith('a1', '');
    expect(screen.getByText(/only an Asset Management Owner can change it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Change Folder/ })).toBeNull();
    fireEvent.click(screen.getByText('Plans'));
    expect(folder).toHaveBeenLastCalledWith('a1', `${PIN}/Plans`);
    await act(async () => { fireEvent.click(await screen.findByText('CO.pdf')); });
    expect(file).toHaveBeenCalledWith('a1', `${PIN}/CO.pdf`, true);
  });

  it('shows Change Folder to an Owner', async () => {
    folder.mockResolvedValue({ ...LISTING, mayChange: true });
    render(<AssetEgnyteDocs asset={ASSET} canConnect onConnect={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /Change Folder/ })).toBeTruthy();
  });

  it('offers Connect to an editor of an unconnected asset, and nothing to a viewer', async () => {
    folder.mockResolvedValue({ connected: false, configured: true, folder: '', mayChange: false });
    const bare = { ...ASSET, egnyteFolder: '' };
    const { unmount } = render(<AssetEgnyteDocs asset={bare} canConnect onConnect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect Egnyte Folder/ }));
    expect(screen.getByText(/Once connected, only an Asset Management Owner can change this folder/)).toBeTruthy();
    unmount();
    render(<AssetEgnyteDocs asset={bare} canConnect={false} onConnect={vi.fn()} />);
    expect(await screen.findByText(/Someone who edits this asset can connect it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Connect Egnyte Folder/ })).toBeNull();
  });

  it('says so when Egnyte did not answer, with Try Again', async () => {
    folder.mockResolvedValue({ ...LISTING, folders: undefined, files: undefined, error: 'Egnyte did not answer - try again in a minute.' });
    render(<AssetEgnyteDocs asset={ASSET} canConnect={false} onConnect={vi.fn()} />);
    expect(await screen.findByText(/Egnyte did not answer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });
});

describe('AssetDetailForm - a connected Egnyte folder is locked below an Owner', () => {
  it('shows the folder read only in edit mode', () => {
    render(<AssetDetailForm p={ASSET} egnyteLocked onSaveDetail={vi.fn()} />);
    act(() => { editGuard.startEdit(); });
    expect(screen.queryByRole('textbox', { name: 'Egnyte Folder' })).toBeNull();
    expect(screen.getByText(/Connected - only an Asset Management Owner can change it/)).toBeTruthy();
  });
});
