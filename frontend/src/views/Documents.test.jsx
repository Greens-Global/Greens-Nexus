import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Render-smoke for the Documents module shell and each of its DMS tabs.
// The module is the app's largest view by far and had no test at all, so a
// crash-on-render (the white-screen class of bug ViewErrorBoundary exists to
// contain) could only be found by opening it. Every tab is mounted here.

const getDocuments = vi.fn(() => Promise.resolve([]));
const mySignatures = vi.fn(() => Promise.resolve([]));
const getDocFolders = vi.fn(() => Promise.resolve([]));
const getDocTemplates = vi.fn(() => Promise.resolve([]));
const getDocLetterheads = vi.fn(() => Promise.resolve([]));
const getEmployees = vi.fn(() => Promise.resolve([]));
vi.mock('../api', () => ({
  api: {
    getDocuments: (...a) => getDocuments(...a),
    mySignatures: (...a) => mySignatures(...a),
    getDocFolders: (...a) => getDocFolders(...a),
    getDocTemplates: (...a) => getDocTemplates(...a),
    getDocLetterheads: (...a) => getDocLetterheads(...a),
    getEmployees: (...a) => getEmployees(...a),
    searchDocuments: () => Promise.resolve([]),
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

beforeEach(() => {
  getDocuments.mockClear();
  mySignatures.mockClear();
});

describe('Documents module', () => {
  it('renders the dashboard tab by default, with the full tab strip', async () => {
    render(<Documents activeSub="" onSubChange={() => {}} />);
    expect(screen.getByText('Documents')).toBeTruthy();
    for (const label of ['Dashboard', 'My Documents', 'Templates', 'E-Sign', 'PDF Tools']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    await waitFor(() => expect(mySignatures).toHaveBeenCalled());
  });

  it('falls back to the dashboard for an unknown sub-tab', () => {
    render(<Documents activeSub="documents-not-a-real-tab" onSubChange={() => {}} />);
    expect(screen.getByText('New Document')).toBeTruthy();   // dashboard quick action
  });

  it('renders My Documents', async () => {
    render(<Documents activeSub="documents-browse" onSubChange={() => {}} />);
    expect(await screen.findByText('No documents match here yet.')).toBeTruthy();
  });

  it('renders Templates', async () => {
    render(<Documents activeSub="documents-templates" onSubChange={() => {}} />);
    await waitFor(() => expect(getDocTemplates).toHaveBeenCalled());
  });

  it('renders E-Sign, including its deep-linked requests sub-tab', () => {
    const { unmount } = render(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    expect(screen.getByText('esign tab')).toBeTruthy();
    unmount();
    render(<Documents activeSub="documents-esign-requests" onSubChange={() => {}} />);
    expect(screen.getByText('esign tab')).toBeTruthy();
  });

  it('goes full-bleed on PDF Tools - no module title or tab strip', () => {
    render(<Documents activeSub="documents-pdf" onSubChange={() => {}} />);
    expect(screen.getByText('pdf tools tab')).toBeTruthy();
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.queryByText('My Documents')).toBeNull();
  });

  it('still renders when every API call fails (403 for a documents-only grant)', async () => {
    getEmployees.mockRejectedValueOnce(new Error('403'));
    getDocuments.mockRejectedValueOnce(new Error('500'));
    mySignatures.mockRejectedValueOnce(new Error('403'));
    render(<Documents activeSub="documents-dashboard" onSubChange={() => {}} />);
    expect(screen.getByText('Documents')).toBeTruthy();
    await waitFor(() => expect(mySignatures).toHaveBeenCalled());
  });
});
