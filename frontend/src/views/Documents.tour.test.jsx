import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Documents guided tour (Oct 1) - the Task module's pattern: it opens by itself
// on a person's first visit, never again on its own once closed (the "seen"
// mark is server-side, per person), and replays from the profile menu's Tour
// row, which fires nexus:documents-tour.

const seen = { value: {} };
const getToursSeen = vi.fn(() => Promise.resolve({ seen: seen.value }));
const markTourSeen = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: {
    getDocuments: () => Promise.resolve([]),
    mySignatures: () => Promise.resolve([]),
    getDocFolders: () => Promise.resolve([]),
    getDocTemplates: () => Promise.resolve([]),
    getDocLetterheads: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
    searchDocuments: () => Promise.resolve([]),
    updateDocument: () => Promise.resolve({}),
    getToursSeen: (...a) => getToursSeen(...a),
    markTourSeen: (...a) => markTourSeen(...a),
  },
}));
vi.mock('../lib/queries', () => ({ useEntities: () => ({ data: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('../components/ESign', () => ({ default: () => <div>esign tab</div> }));
vi.mock('./PdfEditorModule', () => ({ default: () => <div>pdf tools tab</div> }));
vi.mock('../components/DocumentBuilder', () => ({ default: () => <div>document builder</div> }));
vi.mock('../components/EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));

const Documents = (await import('./Documents')).default;
const { buildDocumentsTourSteps } = await import('./documentsTourSteps');

beforeEach(() => { seen.value = {}; getToursSeen.mockClear(); markTourSeen.mockClear(); });

describe('Documents tour', () => {
  it('opens by itself on the first visit, and closing it marks it seen', async () => {
    render(<Documents activeSub="documents-dashboard" onSubChange={() => {}} />);
    expect(await screen.findByText('Welcome to Documents')).toBeTruthy();
    fireEvent.click(screen.getByText('Skip'));
    await waitFor(() => expect(markTourSeen).toHaveBeenCalledWith('documents'));
    expect(screen.queryByText('Welcome to Documents')).toBeNull();
  });

  it('does not open again once seen', async () => {
    seen.value = { documents: '2026-10-01T00:00:00Z' };
    render(<Documents activeSub="documents-dashboard" onSubChange={() => {}} />);
    await waitFor(() => expect(getToursSeen).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Welcome to Documents')).toBeNull();
  });

  it('replays from the profile menu (nexus:documents-tour)', async () => {
    seen.value = { documents: '2026-10-01T00:00:00Z' };
    render(<Documents activeSub="documents-dashboard" onSubChange={() => {}} />);
    await act(async () => {});
    act(() => { window.dispatchEvent(new CustomEvent('nexus:documents-tour')); });
    expect(await screen.findByText('Welcome to Documents')).toBeTruthy();
  });

  it('never nags when "seen" cannot be read', async () => {
    getToursSeen.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    render(<Documents activeSub="documents-dashboard" onSubChange={() => {}} />);
    await act(async () => {});
    expect(screen.queryByText('Welcome to Documents')).toBeNull();
  });

  it('walks every tab in order, and Done marks it seen', async () => {
    const go = vi.fn();
    render(<Documents activeSub="documents-dashboard" onSubChange={go} />);
    await screen.findByText('Welcome to Documents');
    for (let i = 0; i < 20; i += 1) {
      const done = screen.queryByRole('button', { name: /Done/ });
      if (done) { fireEvent.click(done); break; }
      fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    }
    await waitFor(() => expect(markTourSeen).toHaveBeenCalledWith('documents'));
    expect(go.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(
      ['documents-dashboard', 'documents-browse', 'documents-templates', 'documents-esign', 'documents-pdf']));
  });
});

describe('Documents tour steps', () => {
  it('a phone gets no header-tabs step (its tabs are the bottom bar)', () => {
    const desk = buildDocumentsTourSteps({ go: () => {}, isMobile: false }).map((s) => s.target);
    const phone = buildDocumentsTourSteps({ go: () => {}, isMobile: true }).map((s) => s.target);
    expect(desk).toContain('module-tabs');
    expect(phone).not.toContain('module-tabs');
    expect(buildDocumentsTourSteps({ go: () => {}, isMobile: true }).some((s) => 'when' in s)).toBe(false);
  });

  it('every spotlight target exists in the code it points at', () => {
    const src = (f) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');
    const code = ['../components/TopHeader.jsx', '../components/DocumentsBrowser.jsx', '../components/DocumentTemplates.jsx',
      '../components/ESign.jsx', './Documents.jsx'].map(src).join('\n');
    const targets = buildDocumentsTourSteps({ go: () => {}, isMobile: false }).map((s) => s.target).filter(Boolean);
    for (const t of targets) {
      const screenHook = t.startsWith('documents-screen-') && code.includes('data-tour={`documents-screen-${sub}`}');
      expect(code.includes(`data-tour="${t}"`) || screenHook, t).toBe(true);
    }
  });
});
