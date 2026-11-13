import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// The Documents library (Neil, 10/31/2026): views, one row per document, one
// search, a row opening beside the list, and the two organize surfaces.

const getDocFolders = vi.fn();
const getDocumentLibrary = vi.fn();
const listPacketDocuments = vi.fn();
const createDocFolder = vi.fn();
const updateDocument = vi.fn();
const createDocument = vi.fn();
const getFormEntries = vi.fn();
vi.mock('../api', () => ({
  api: {
    getFormEntries: (...a) => getFormEntries(...a),
    getDocFolders: (...a) => getDocFolders(...a),
    getDocumentLibrary: (...a) => getDocumentLibrary(...a),
    listPacketDocuments: (...a) => listPacketDocuments(...a),
    createDocFolder: (...a) => createDocFolder(...a),
    updateDocument: (...a) => updateDocument(...a),
    createDocument: (...a) => createDocument(...a),
    getDocTemplates: () => Promise.resolve([{ id: 't1', name: 'Offer Letter', state: 'published' }]),
    getDocTemplate: () => Promise.resolve({ id: 't1', fieldDefs: [], releasedFieldDefs: [] }),
    getDocumentVersions: () => Promise.resolve([]),
    exportDocumentPdf: () => new Promise(() => {}),
    duplicateDocument: () => Promise.resolve({}),
    archiveDocument: () => Promise.resolve({}),
    restoreDocument: () => Promise.resolve({}),
    deleteDocument: () => Promise.resolve({}),
  },
}));

// The editor is a ~2,000-line TipTap surface with its own upload/import deps -
// out of scope here, and it only mounts once you click Open.
vi.mock('./DocumentBuilder', () => ({ default: () => <div>document builder</div> }));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));
vi.mock('../tasks/components', () => ({
  PersonSelect: ({ people, onChange, ariaLabel }) => (
    <select aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
      <option value="">None</option>
      {people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
    </select>
  ),
}));

let isAdmin = true;
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => isAdmin }) }));

const DocumentsBrowser = (await import('./DocumentsBrowser')).default;

const FOLDERS = [
  { id: 'f-hr', name: 'HR', key: 'hr', isSystem: true, ownerEmail: '' },
  { id: 'f-me', name: 'Personal', key: 'personal', isSystem: true, ownerEmail: 'me@greensglobal.com' },
];
const doc = (over) => ({ kind: 'document', folderId: '', status: 'final', version: 1, tags: [], parties: [], mine: true, canManage: true,
  company: '', forName: '', signRequestId: '', signStatus: '', updatedAt: '2026-08-20T10:00:00Z', ...over });
const DOCS = [
  doc({ id: 'd1', title: 'Vendor Agreement', folderId: 'f-hr', status: 'draft', tags: ['legal', 'vendor'], company: 'Greens Global', updatedAt: '2026-09-01T10:00:00Z' }),
  doc({ id: 'd2', title: 'Employment Agreement', forName: 'Jordan Lee', signRequestId: 'r1', signStatus: 'pending', signed: 1, signers: 2, canManageEnvelope: true,
    parties: [{ name: 'Jordan Lee', role: 'signer', status: 'signed', signedAt: '2026-10-29T16:12:00Z' }, { name: 'Company Signatory', role: 'signer', status: 'viewed', viewedAt: '2026-10-29T16:13:00Z' }] }),
  doc({ id: 'd3', title: 'Employment Agreement', forName: 'Sam Rivera', signRequestId: 'r2', signStatus: 'completed', signed: 2, signers: 2, partyId: 'p9', updatedAt: '2026-08-21T10:00:00Z' }),
  doc({ id: 'sign:r3', kind: 'envelope', title: 'Lease', myTurn: true, signStatus: 'pending', signRequestId: 'r3', partyId: 'p3', canManage: false, signers: 1, signed: 0 }),
  doc({ id: 'd4', title: 'Old Note', status: 'archived' }),
];

const rail = () => screen.getByRole('navigation', { name: 'Document views' });
const openView = (name) => fireEvent.click(within(rail()).getByRole('button', { name: new RegExp(`^${name}`) }));

beforeEach(() => {
  isAdmin = true;
  getDocFolders.mockReset().mockResolvedValue(FOLDERS);
  getDocumentLibrary.mockReset().mockResolvedValue(DOCS);
  listPacketDocuments.mockReset().mockRejectedValue(new Error('403'));
  createDocFolder.mockReset().mockResolvedValue({ id: 'f-new', name: 'Board Minutes', key: '', ownerEmail: '' });
  updateDocument.mockReset().mockResolvedValue(DOCS[0]);
  createDocument.mockReset().mockResolvedValue(doc({ id: 'd9', title: 'Made', status: 'final' }));
  getFormEntries.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
});

describe('The library', () => {
  it('opens on Needs Me when something waits on you, otherwise on All Documents', async () => {
    render(<DocumentsBrowser />);
    expect(await screen.findByText('Lease')).toBeTruthy();
    expect(screen.queryByText('Vendor Agreement')).toBeNull();
    expect(screen.getByText('Your Signature Needed')).toBeTruthy();
  });

  it('starts on All Documents with nothing waiting, and archived rows stay out of it', async () => {
    getDocumentLibrary.mockResolvedValue(DOCS.filter((d) => !d.myTurn));
    render(<DocumentsBrowser />);
    expect(await screen.findByText('Vendor Agreement')).toBeTruthy();
    expect(screen.queryByText('Old Note')).toBeNull();
    // MM/DD/YYYY, never ISO - the app-wide date rule.
    expect(screen.getByText('09/01/2026')).toBeTruthy();
  });

  it('two rows with one title read differently: who for and where it stands', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    openView('All Documents');
    expect(screen.getByText('Jordan Lee')).toBeTruthy();
    expect(screen.getByText('Sam Rivera')).toBeTruthy();
    expect(screen.getByText('Out For Signature - 1 of 2')).toBeTruthy();
    expect(within(screen.getByText('Sam Rivera').closest('tr')).getByText('Signed')).toBeTruthy();
  });

  it('the views filter: drafts, out for signature, signed, archived, a folder', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    openView('My Drafts');
    expect(screen.getByText('Vendor Agreement')).toBeTruthy();
    expect(screen.queryByText('Lease')).toBeNull();
    openView('Archived');
    expect(screen.getByText('Old Note')).toBeTruthy();
    openView('Signed');
    expect(screen.getByText('Sam Rivera')).toBeTruthy();
    expect(screen.queryByText('Jordan Lee')).toBeNull();
    openView('HR');   // a folder named HR, not the HR Records view
    expect(screen.getByText('Vendor Agreement')).toBeTruthy();
  });

  it('one search reaches the person, the signer and the tag', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    openView('All Documents');
    const box = screen.getByLabelText('Search documents');
    fireEvent.change(box, { target: { value: 'company signatory' } });
    expect(screen.getByText('Jordan Lee')).toBeTruthy();
    expect(screen.queryByText('Sam Rivera')).toBeNull();
    fireEvent.change(box, { target: { value: 'vendor' } });
    expect(screen.getByText('Vendor Agreement')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'nothing like this' } });
    expect(screen.getByText('Nothing matches that search.')).toBeTruthy();
  });

  it('a row opens beside the list and says who signed and who is next', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    openView('All Documents');
    fireEvent.click(screen.getByText('Jordan Lee'));
    const panel = await screen.findByRole('complementary', { name: 'Employment Agreement' });
    expect(within(panel).getByText('Signatures - 1 of 2')).toBeTruthy();
    expect(within(panel).getByText('Jordan Lee signed')).toBeTruthy();
    expect(within(panel).getByText('Company Signatory - viewed, not signed')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Remind' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('Open starts the editor; someone who does not own a row sees no owner actions', async () => {
    getDocumentLibrary.mockResolvedValue([doc({ id: 'd7', title: 'Shared', canManage: false, mine: false })]);
    render(<DocumentsBrowser />);
    fireEvent.click(await screen.findByText('Shared'));
    const panel = await screen.findByRole('complementary', { name: 'Shared' });
    expect(within(panel).queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Folder And Tags' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('document builder')).toBeTruthy();
  });

  it('HR Records shows only for someone the server lets read them, and pay stays locked', async () => {
    listPacketDocuments.mockResolvedValue([{ documentId: 'h1', title: 'Offer Letter', person: 'Priya Shah', packet: 'Hire', status: 'In Review',
      locked: true, eventId: 'e1', signRequestId: '', signed: false, templateId: 't1', templateName: 'Offer', templateVersion: 2, updatedAt: '2026-10-24T10:00:00Z' }]);
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    openView('HR Records');
    fireEvent.click(screen.getByText('Priya Shah'));
    const panel = await screen.findByRole('complementary', { name: 'Offer Letter' });
    expect(within(panel).getByText(/Opening it needs Pay & Benefits access/)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Download' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Open Template' })).toBeTruthy();
  });

  it('Form Entries is a view only when the person has entries to see (Neil, 11/02/2026)', async () => {
    getFormEntries.mockResolvedValue({ items: [{ id: 'e1', templateId: 'f1', title: 'Vehicle Check', status: 'follow_up', submittedBy: 'sam@greensglobal.com',
      submittedByName: 'Sam Rivera', submittedAt: '2026-11-02T21:14:00Z', workSiteName: 'Austin', company: 'Greens Global', answers: {}, canReview: false }], total: 1, page: 1, pageSize: 50 });
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    openView('Form Entries');
    expect(screen.getByText('Vehicle Check')).toBeTruthy();
    expect(screen.getByText('Sam Rivera')).toBeTruthy();
    expect(screen.getByText('Needs Follow-Up')).toBeTruthy();
  });

  it('no Form Entries view when there are none', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    expect(within(rail()).queryByRole('button', { name: /^Form Entries/ })).toBeNull();
  });

  it('no HR Records view for anyone else', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    expect(within(rail()).queryByRole('button', { name: /^HR Records/ })).toBeNull();
  });
});

describe('Folders and tags', () => {
  it('creates a shared folder and adds it to the rail', async () => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByText('Lease');
    fireEvent.click(screen.getByTitle('New Folder'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Board Minutes'), { target: { value: 'Board Minutes' } });
    fireEvent.click(screen.getByText('Create Folder'));
    await waitFor(() => expect(createDocFolder).toHaveBeenCalledWith({ name: 'Board Minutes' }));
    await waitFor(() => expect(within(rail()).getByRole('button', { name: /^Board Minutes/ })).toBeTruthy());
  });

  it('hides New Folder from non-administrators (the endpoint would 403)', async () => {
    isAdmin = false;
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');
    expect(screen.queryByTitle('New Folder')).toBeNull();
  });

  const organize = async (title) => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByText('Lease');
    openView('All Documents');
    fireEvent.click(screen.getByText(title));
    const panel = await screen.findByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: 'Folder And Tags' }));
    return screen.findByLabelText('Add a tag');
  };

  it('saves folder and tags together, keeping the tags already on the document', async () => {
    const tagInput = await organize('Vendor Agreement');
    fireEvent.change(tagInput, { target: { value: 'Signed' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    fireEvent.change(screen.getByDisplayValue('HR'), { target: { value: 'f-me' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith('d1', {
      folderId: 'f-me', tags: ['legal', 'vendor', 'signed'],
    }));
  });

  it('does not drop a tag that was typed but never committed with Enter', async () => {
    const tagInput = await organize('Vendor Agreement');
    fireEvent.change(tagInput, { target: { value: 'draftonly' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith('d1', {
      folderId: 'f-hr', tags: ['legal', 'vendor', 'draftonly'],
    }));
  });

  it('removes a tag chip', async () => {
    await organize('Vendor Agreement');
    fireEvent.click(await screen.findByLabelText('Remove legal'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateDocument).toHaveBeenCalledWith('d1', {
      folderId: 'f-hr', tags: ['vendor'],
    }));
  });
});

describe('New Document', () => {
  const EMPLOYEES = [{ id: 'emp-1', firstName: 'Jordan', lastName: 'Lee', workEmail: 'jordan@greensglobal.com', company: 'ent-1' }];
  const ENTITIES = [{ id: 'ent-1', name: 'Greens Global' }];

  // New Document (Neil, 11/10/2026): a blank draft opens at once - no name,
  // no popup; the editor asks for a name on Close (lib/untitled.js).
  it('New Document opens a blank, unnamed draft straight away, and so does the + menu', async () => {
    createDocument.mockResolvedValue({ id: 'new-1', title: 'Untitled Document', status: 'draft' });
    const { unmount } = render(<DocumentsBrowser employees={EMPLOYEES} entities={ENTITIES} toastOk={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^New Document$/ }));
    await waitFor(() => expect(createDocument).toHaveBeenCalledWith({ title: 'Untitled Document' }));
    expect(await screen.findByText('document builder')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    unmount();
    createDocument.mockClear();
    render(<DocumentsBrowser openCreateSignal={1} employees={EMPLOYEES} entities={ENTITIES} toastOk={() => {}} />);
    await waitFor(() => expect(createDocument).toHaveBeenCalledWith({ title: 'Untitled Document' }));
  });

  it('the popup (From a Template) does not need a name either', async () => {
    createDocument.mockResolvedValue({ id: 'new-2', title: 'Untitled Document', status: 'draft' });
    render(<DocumentsBrowser employees={EMPLOYEES} entities={ENTITIES} toastOk={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More ways to start a document' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /From a Template/ }));
    expect(await screen.findByText('Untitled Document')).toBeTruthy();
    const create = await screen.findByRole('button', { name: 'Create Draft' });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ title: 'Untitled Document' })));
  });

  it('picking a template and a person names the document and tells it who it is for', async () => {
    render(<DocumentsBrowser employees={EMPLOYEES} entities={ENTITIES} toastOk={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More ways to start a document' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /From a Template/ }));
    const person = await screen.findByLabelText('Who this document is for');
    const option = await screen.findByRole('option', { name: 'Offer Letter' });
    fireEvent.change(option.closest('select'), { target: { value: 't1' } });
    fireEvent.change(person, { target: { value: 'jordan@greensglobal.com' } });
    // No name box: the name it is saved under is shown, and can change in the editor.
    expect(document.querySelector('.nx-newdoc-name strong').textContent).toBe('Offer Letter - Jordan Lee');
    expect(screen.queryByLabelText('Name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make Document' }));
    await waitFor(() => expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Offer Letter - Jordan Lee', templateId: 't1', employeeId: 'emp-1', entityId: 'ent-1',
    })));
  });
});

describe('The toolbar', () => {
  it('keeps one New Document button; Blank Sheet and Open a File are under its arrow', async () => {
    render(<DocumentsBrowser toastOk={() => {}} />);
    await screen.findByRole('button', { name: 'More ways to start a document' });
    expect(screen.queryByRole('button', { name: /^New Sheet/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Import$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More ways to start a document' }));
    for (const n of ['Blank Document', 'Blank Sheet', 'From a Template...', 'Open a File...']) {
      expect(await screen.findByRole('menuitem', { name: n })).toBeTruthy();
    }
  });
});

describe('Empty and failing', () => {
  it('renders an empty state instead of a blank screen', async () => {
    getDocumentLibrary.mockResolvedValue([]);
    render(<DocumentsBrowser />);
    expect(await screen.findByText('No documents yet.')).toBeTruthy();
  });

  it('says so when the list cannot load, and the folders failing does not matter', async () => {
    getDocFolders.mockRejectedValue(new Error('403'));
    getDocumentLibrary.mockRejectedValue(new Error('The server said no'));
    render(<DocumentsBrowser />);
    await waitFor(() => expect(document.body.textContent).toContain('The server said no'));
  });
});

describe('Opened from the header search (11/13/2026)', () => {
  it('a library already on screen opens the named row beside the list, an archived one too', async () => {
    render(<DocumentsBrowser />);
    await screen.findByText('Lease');                       // loaded, on Needs Me
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent(window, new CustomEvent('nexus:open-document', { detail: { id: 'd1' } }));
    expect(await screen.findByRole('complementary', { name: 'Vendor Agreement' })).toBeTruthy();
    fireEvent(window, new CustomEvent('nexus:open-document', { detail: { id: 'd4' } }));
    expect(await screen.findByRole('complementary', { name: 'Old Note' })).toBeTruthy();
  });
});
