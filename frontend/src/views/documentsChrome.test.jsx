import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Sagar, Sep 17: "we don't need this on any page, anyway we're having a search
// bar in all pages already - why keep multiple."
//
// The module used to carry a "Documents / Send, sign and track..." band with a
// cross-module search box. My Documents, Templates and Nexus Sign each already
// search their own list, so it was a second way to do the same thing on top of
// ~90px of chrome. It is gone from EVERY tab - these tests are what stops it
// coming back one screen at a time.

vi.mock('../api', () => ({
  api: {
    getDocuments: () => Promise.resolve([]),
    mySignatures: () => Promise.resolve([]),
    getDocFolders: () => Promise.resolve([]),
    getDocTemplates: () => Promise.resolve([]),
    getDocLetterheads: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
    searchDocuments: () => Promise.resolve([]),
  },
}));
vi.mock('../lib/queries', () => ({ useEntities: () => ({ data: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('./PdfEditorModule', () => ({ default: () => <div>pdf tools tab</div> }));
vi.mock('../components/ESign', () => ({ default: () => <div>esign tab</div> }));
vi.mock('../components/DocumentsDashboard', () => ({ default: () => <div>dashboard tab</div> }));
vi.mock('../components/DocumentsBrowser', () => ({ default: () => <div>my documents tab</div> }));
vi.mock('../components/DocumentTemplates', () => ({ default: () => <div>templates tab</div> }));

const Documents = (await import('./Documents')).default;

const TABS = [
  ['documents-dashboard', 'dashboard tab'],
  ['documents-browse', 'my documents tab'],
  ['documents-templates', 'templates tab'],
  ['documents-esign', 'esign tab'],
  ['documents-pdf', 'pdf tools tab'],
];

describe('the Documents module header is gone', () => {
  it.each(TABS)('%s shows no title band and no module search box', async (sub, marker) => {
    render(<Documents activeSub={sub} onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(marker)).toBeTruthy());
    expect(screen.queryByText('Send, sign and track company documents - one place')).toBeNull();
    expect(screen.queryByPlaceholderText(/Search documents, templates/i)).toBeNull();
  });
});

describe('what stays', () => {
  it('the tab strip is still there - it is the module navigation now', async () => {
    render(<Documents activeSub="documents-browse" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('my documents tab')).toBeTruthy());
    expect(screen.getAllByText('Nexus Sign').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Templates').length).toBeGreaterThan(0);
  });

  it('PDF Tools still drops the tab strip for its full-bleed workspace', async () => {
    render(<Documents activeSub="documents-pdf" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('pdf tools tab')).toBeTruthy());
    expect(screen.queryByText('My Documents')).toBeNull();
  });
});
