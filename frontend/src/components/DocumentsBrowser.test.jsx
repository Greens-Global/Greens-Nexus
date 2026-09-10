import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke + behavior for My Documents (Documents module). Covers the
// list itself and the two organize surfaces that were backend-only for a long
// time: creating a shared folder, and setting a document's folder/tags.

const getDocFolders = vi.fn();
const getDocuments = vi.fn();
const createDocFolder = vi.fn();
const updateDocument = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDocFolders: (...a) => getDocFolders(...a),
    getDocuments: (...a) => getDocuments(...a),
    createDocFolder: (...a) => createDocFolder(...a),
    updateDocument: (...a) => updateDocument(...a),
    getDocTemplates: () => Promise.resolve([]),
    duplicateDocument: () => Promise.resolve({}),
    archiveDocument: () => Promise.resolve({}),
    restoreDocument: () => Promise.resolve({}),
    deleteDocument: () => Promise.resolve({}),
  },
}));

// The editor is a ~2,000-line TipTap surface with its own upload/import deps -
// out of scope here, and it only mounts once you click Edit.
vi.mock('./DocumentBuilder', () => ({ default: () => <div>document builder</div> }));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));

let isAdmin = true;
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => isAdmin }) }));

const DocumentsBrowser = (await import('./DocumentsBrowser')).default;

const FOLDERS = [
  { id: 'f-hr', name: 'HR', key: 'hr', isSystem: true, ownerEmail: '' },
  { id: 'f-me', name: 'Personal', key: 'personal', isSystem: true, ownerEmail: 'me@greensglobal.com' },
];
const DOCS = [
  { id: 'd1', title: 'Vendor Agreement', folderId: 'f-hr', status: 'draft', currentVersion: 3,
    updatedAt: '2026-09-01T10:00:00Z', tags: ['legal', 'vendor'], signRequestId: '', signStatus: '' },
  { id: 'd2', title: 'Untagged Note', folderId: '', status: 'final', currentVersion: 1,
    updatedAt: '2026-08-20T10:00:00Z', tags: [], signRequestId: '', signStatus: '' },
];

beforeEach(() => {
  isAdmin = true;
  getDocFolders.mockReset().mockResolvedValue(FOLDERS);
  getDocuments.mockReset().mockResolvedValue(DOCS);
  createDocFolder.mockReset().mockResolvedValue({ id: 'f-new', name: 'Board Minutes', key: '', ownerEmail: '' });
  updateDocument.mockReset().mockResolvedValue({ ...DOCS[0], tags: ['legal', 'vendor', 'signed'] });
});

describe('DocumentsBrowser', () => {
  it('renders the document list with its tags and a US-format updated date', async () => {
    render(<DocumentsBrowser />);
    expect(await screen.findByText('Vendor Agreement')).toBeTruthy();
    expect(screen.getByText('legal')).toBeTruthy();
    expect(screen.getByText('vendor')).toBeTruthy();
    // MM/DD/YYYY, never ISO - the app-wide date rule.
    expect(screen.getByText(/09\/01\/2026/)).toBeTruthy();
    expect(screen.queryByText(/2026-09-01/)).toBeNull();
  });

  it('creates a shared folder and adds it to the picker', async () => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByText('Vendor Agreement');
    fireEvent.click(screen.getByTitle('New Folder'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Board Minutes'), { target: { value: 'Board Minutes' } });
    fireEvent.click(screen.getByText('Create Folder'));
    await waitFor(() => expect(createDocFolder).toHaveBeenCalledWith({ name: 'Board Minutes' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Board Minutes' })).toBeTruthy());
  });

  it('hides New Folder from non-administrators (the endpoint would 403)', async () => {
    isAdmin = false;
    render(<DocumentsBrowser />);
    await screen.findByText('Vendor Agreement');
    expect(screen.queryByTitle('New Folder')).toBeNull();
  });

  it('saves folder and tags together, keeping the tags already on the document', async () => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByText('Vendor Agreement');
    fireEvent.click(screen.getAllByTitle('Folder & Tags')[0]);

    const tagInput = await screen.findByLabelText('Add a tag');
    fireEvent.change(tagInput, { target: { value: 'Signed' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.change(screen.getByDisplayValue('HR'), { target: { value: 'f-me' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith('d1', {
      folderId: 'f-me', tags: ['legal', 'vendor', 'signed'],
    }));
  });

  it('does not drop a tag that was typed but never committed with Enter', async () => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByText('Untagged Note');
    fireEvent.click(screen.getAllByTitle('Folder & Tags')[1]);

    const tagInput = await screen.findByLabelText('Add a tag');
    fireEvent.change(tagInput, { target: { value: 'draftonly' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith('d2', {
      folderId: '', tags: ['draftonly'],
    }));
  });

  it('removes a tag chip', async () => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByText('Vendor Agreement');
    fireEvent.click(screen.getAllByTitle('Folder & Tags')[0]);
    fireEvent.click(await screen.findByLabelText('Remove legal'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith('d1', {
      folderId: 'f-hr', tags: ['vendor'],
    }));
  });

  it('renders an empty state instead of a blank screen', async () => {
    getDocuments.mockResolvedValue([]);
    render(<DocumentsBrowser />);
    expect(await screen.findByText('No documents match here yet.')).toBeTruthy();
  });

  it('survives the folders and documents calls failing', async () => {
    getDocFolders.mockRejectedValue(new Error('403'));
    getDocuments.mockRejectedValue(new Error('500'));
    render(<DocumentsBrowser />);
    expect(await screen.findByText('No documents match here yet.')).toBeTruthy();
  });
});
