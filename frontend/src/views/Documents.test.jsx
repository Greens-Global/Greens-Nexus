import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Render-smoke for the Documents module shell and each of its DMS tabs.
// The module is the app's largest view by far and had no test at all, so a
// crash-on-render (the white-screen class of bug ViewErrorBoundary exists to
// contain) could only be found by opening it. Every tab is mounted here.

const getDocumentLibrary = vi.fn(() => Promise.resolve([]));
const getDocFolders = vi.fn(() => Promise.resolve([]));
const getDocTemplates = vi.fn(() => Promise.resolve([]));
const getDocLetterheads = vi.fn(() => Promise.resolve([]));
const getEmployees = vi.fn(() => Promise.resolve([]));
// The HR Records probe (Oct 14): 403 for anyone who is not HR.
const listPacketDocuments = vi.fn(() => Promise.reject(new Error('403')));
vi.mock('../api', () => ({
  api: {
    getDocumentLibrary: (...a) => getDocumentLibrary(...a),
    getDocFolders: (...a) => getDocFolders(...a),
    getDocTemplates: (...a) => getDocTemplates(...a),
    getDocLetterheads: (...a) => getDocLetterheads(...a),
    getEmployees: (...a) => getEmployees(...a),
    listPacketDocuments: (...a) => listPacketDocuments(...a),
    searchDocuments: () => Promise.resolve([]),
    // The Documents tour (Oct 1) as already seen, so these tests see the module itself.
    getToursSeen: () => Promise.resolve({ seen: { documents: '2026-10-01' } }),
    markTourSeen: () => Promise.resolve({}),
    updateDocument: () => Promise.resolve({}),
  },
}));

vi.mock('../lib/queries', () => ({ useEntities: () => ({ data: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

// E-Sign and the PDF editor are separate subsystems (pdf.js worker, an
// iframed vanilla engine) - neither is renderable in jsdom, and neither is
// what this file is guarding. Their tabs are still mounted, via these stubs.
vi.mock('../components/ESign', () => ({ default: () => <div>esign tab</div> }));
vi.mock('./PdfEditorModule', () => ({ default: () => <div>pdf tools tab</div> }));
vi.mock('../components/DocumentBuilder', () => ({ default: () => <div>document builder</div> }));
vi.mock('../components/EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));

const Documents = (await import('./Documents')).default;
const { HeaderTabsProvider, useHeaderTabs } = await import('../components/ModuleTabs');

// The tab strip is published to the header (and, on phones, drawn by
// MobileNav's DOCUMENT_ACTIONS) rather than rendered in the page, so read it
// where TopHeader reads it.
function PublishedTabs() {
  const entry = useHeaderTabs();
  return <div data-testid="published-tabs">{(entry?.tabs || []).map(t => t.label).join('|')}</div>;
}
const renderDocs = (activeSub, onSubChange = () => {}) => render(
  <HeaderTabsProvider>
    <Documents activeSub={activeSub} onSubChange={onSubChange} />
    <PublishedTabs />
  </HeaderTabsProvider>,
);
const publishedTabs = () => screen.getByTestId('published-tabs').textContent;

beforeEach(() => {
  getDocumentLibrary.mockClear();
});

describe('Documents module', () => {
  it('opens on the library, with the four tabs (Neil, 10/31/2026)', async () => {
    renderDocs('');
    // The module title band was removed (Sep 17) - the tab strip is the proof
    // that the shell rendered.
    expect(publishedTabs()).toBe('Documents|Templates|Nexus Sign|PDF Tools');
    await waitFor(() => expect(getDocumentLibrary).toHaveBeenCalled());
  });

  it.each(['documents-not-a-real-tab', 'documents-dashboard', 'documents-hr-records'])('%s lands on the library', async (sub) => {
    render(<Documents activeSub={sub} onSubChange={() => {}} />);
    expect(await screen.findByText('New Document')).toBeTruthy();
    await waitFor(() => expect(getDocumentLibrary).toHaveBeenCalled());
  });

  it('renders the library', async () => {
    render(<Documents activeSub="documents-browse" onSubChange={() => {}} />);
    expect(await screen.findByText('No documents yet.')).toBeTruthy();
  });

  it('renders Templates', async () => {
    render(<Documents activeSub="documents-templates" onSubChange={() => {}} />);
    await waitFor(() => expect(getDocTemplates).toHaveBeenCalled());
  });

  it('renders Nexus Sign, including its deep-linked requests sub-tab', () => {
    const { unmount } = render(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    expect(screen.getByText('esign tab')).toBeTruthy();
    unmount();
    render(<Documents activeSub="documents-esign-requests" onSubChange={() => {}} />);
    expect(screen.getByText('esign tab')).toBeTruthy();
  });

  it('goes full-bleed on PDF Tools - no module title or tab strip', () => {
    renderDocs('documents-pdf');
    expect(screen.getByText('pdf tools tab')).toBeTruthy();
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.queryByText('New Document')).toBeNull();
    expect(publishedTabs()).toBe('');   // nothing published either
  });

  it('still renders when every API call fails (403 for a documents-only grant)', async () => {
    getEmployees.mockRejectedValueOnce(new Error('403'));
    getDocumentLibrary.mockRejectedValueOnce(new Error('500'));
    renderDocs('documents-browse');
    expect(publishedTabs()).toContain('Documents');
    await waitFor(() => expect(getDocumentLibrary).toHaveBeenCalled());
  });

  it('HR Records is a view in the library, only when the server answers, never a tab', async () => {
    const first = renderDocs('documents-browse');
    await waitFor(() => expect(listPacketDocuments).toHaveBeenCalled());
    await screen.findByText('No documents yet.');
    expect(screen.queryByRole('button', { name: /^HR Records/ })).toBeNull();
    first.unmount();
    listPacketDocuments.mockResolvedValueOnce([]);
    renderDocs('documents-hr-records');
    expect(await screen.findByRole('button', { name: /^HR Records/ })).toBeTruthy();
    expect(publishedTabs()).not.toContain('HR Records');
  });
});
