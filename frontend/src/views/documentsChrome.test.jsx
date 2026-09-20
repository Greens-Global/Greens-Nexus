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
const { HeaderTabsProvider, useHeaderTabs } = await import('../components/ModuleTabs');

// Desktop publishes the strip to the header; phones draw it as the bottom bar
// (MobileNav's DOCUMENT_ACTIONS). Either way it is no longer in the page, so
// read it from the header slot.
function PublishedTabs() {
  const entry = useHeaderTabs();
  return <div data-testid="published-tabs">{(entry?.tabs || []).map(t => t.label).join('|')}</div>;
}
const renderDocs = (activeSub) => render(
  <HeaderTabsProvider>
    <Documents activeSub={activeSub} onSubChange={() => {}} />
    <PublishedTabs />
  </HeaderTabsProvider>,
);
const publishedTabs = () => screen.getByTestId('published-tabs').textContent;

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
    renderDocs('documents-browse');
    await waitFor(() => expect(screen.getByText('my documents tab')).toBeTruthy());
    expect(publishedTabs()).toContain('Nexus Sign');
    expect(publishedTabs()).toContain('Templates');
  });

  it('the strip is not drawn in the page - the header has it, phones get the bottom bar', async () => {
    renderDocs('documents-browse');
    await waitFor(() => expect(screen.getByText('my documents tab')).toBeTruthy());
    expect(document.querySelector('.module-tabs-inline')).toBeNull();
  });

  it('PDF Tools still drops the tab strip for its full-bleed workspace', async () => {
    renderDocs('documents-pdf');
    await waitFor(() => expect(screen.getByText('pdf tools tab')).toBeTruthy());
    expect(screen.queryByText('My Documents')).toBeNull();
    expect(publishedTabs()).toBe('');
  });
});
