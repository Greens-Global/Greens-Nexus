import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';

// The Document Builder's save path, as tests.
//
// A real Loan Agreement lost its entire body here: `onPageUpdate` was a
// useCallback with an empty dep array, so it froze the FIRST render's
// scheduleSave -> doSave -> currentContent - a closure whose `pages` was still
// the initial []. Every keystroke therefore scheduled a save that persisted
// `pages: []`, and once that landed, loading the document produced an empty
// editor which saved empty again. The damage was silent: the editor still
// showed the text until you reloaded, and "Saved" was displayed throughout.
//
// The second half of the same report - "blank on clicking Preview & Send" -
// is that every server-rendered output (preview, export, send) renders the
// SAVED row, without first flushing the debounced edit sitting in the editor.

const CONTENT = {
  pages: [{
    id: 'p1',
    json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'REAL BODY' }] }] },
  }],
  header: null,
  footer: null,
  pageSetup: { size: 'letter', orientation: 'portrait', margins: 'normal' },
};

const getDocument = vi.fn();
const updateDocument = vi.fn();
const exportDocumentPdf = vi.fn();
const calls = [];   // ordered log, to prove a save lands BEFORE a render
vi.mock('../api', () => ({
  api: {
    getDocument: (...a) => getDocument(...a),
    updateDocument: (...a) => { calls.push('save'); return updateDocument(...a); },
    exportDocumentPdf: (...a) => { calls.push('export'); return exportDocumentPdf(...a); },
    exportDocumentDocx: () => Promise.resolve({ blob: new Blob(['x']), filename: 'x.docx' }),
    getDocLetterheads: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
  },
}));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div /> }));

const DocumentBuilder = (await import('./DocumentBuilder')).default;

const doc = () => ({
  id: 'd1', title: 'Loan Agreement', content: structuredClone(CONTENT),
  letterheadId: '', employeeId: '', entityId: '', mergeOverrides: {}, fieldDefs: [],
  status: 'draft', currentVersion: 13,
});

/** Mount, wait for the document to hydrate, and hand back its live editor. */
async function mountBuilder() {
  render(<DocumentBuilder docId="d1" kind="document" onClose={() => {}} toastErr={() => {}} />);
  await waitFor(() => expect(getDocument).toHaveBeenCalled());
  await waitFor(() => expect(document.querySelector('.doc-page .ProseMirror')).toBeTruthy());
  // TipTap hangs its editor instance off the ProseMirror DOM node, which is
  // the only handle a test gets on a page's editor.
  return document.querySelector('.doc-page .ProseMirror').editor;
}

const lastSavedContent = () => updateDocument.mock.calls.at(-1)[1].content;
const savedText = (content) => JSON.stringify(content.pages ?? []);

beforeEach(() => {
  calls.length = 0;
  getDocument.mockReset().mockResolvedValue(doc());
  updateDocument.mockReset().mockResolvedValue(doc());
  exportDocumentPdf.mockReset().mockResolvedValue({ blob: new Blob(['%PDF']), filename: 'loan.pdf' });
  globalThis.URL.createObjectURL ??= () => 'blob:preview';
  globalThis.URL.revokeObjectURL ??= () => {};
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('DocumentBuilder autosave', () => {
  it('persists the real page content after an edit, never an empty page list', async () => {
    const editor = await mountBuilder();
    editor.commands.insertContent(' - amended');

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(updateDocument).toHaveBeenCalled());

    const content = lastSavedContent();
    expect(content.pages).toHaveLength(1);          // was [] - the wipe
    expect(savedText(content)).toContain('REAL BODY');
    expect(savedText(content)).toContain('amended');
  });

  it('keeps the page setup and title through an autosave', async () => {
    const editor = await mountBuilder();
    editor.commands.insertContent('x');
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(updateDocument).toHaveBeenCalled());
    expect(lastSavedContent().pageSetup).toMatchObject({ size: 'letter', orientation: 'portrait' });
  });

  it('never sends a save whose pages are empty, however it is triggered', async () => {
    const editor = await mountBuilder();
    for (let i = 0; i < 3; i++) {
      editor.commands.insertContent(`${i}`);
      await vi.advanceTimersByTimeAsync(2000);
    }
    await waitFor(() => expect(updateDocument).toHaveBeenCalled());
    for (const [, payload] of updateDocument.mock.calls) {
      if (!payload.content) continue;
      expect(payload.content.pages.length).toBeGreaterThan(0);
    }
  });
});

describe('DocumentBuilder server-rendered output', () => {
  it('flushes a pending edit before rendering the Preview & Send PDF', async () => {
    const editor = await mountBuilder();
    editor.commands.insertContent(' - amended');
    // Straight to Preview, inside the autosave debounce - the exact sequence
    // that used to render the previous (here: pre-edit) saved copy.
    fireEvent.click(screen.getByText(/Preview & Send/));

    await waitFor(() => expect(exportDocumentPdf).toHaveBeenCalled());
    expect(calls).toEqual(['save', 'export']);
    expect(savedText(lastSavedContent())).toContain('amended');
  });

  it('renders the preview from a saved copy that has the body in it', async () => {
    await mountBuilder();
    fireEvent.click(screen.getByText(/Preview & Send/));
    await waitFor(() => expect(exportDocumentPdf).toHaveBeenCalled());
    // Whatever saves happened first, the export is last and nothing empty was
    // written on the way (the wipe used to happen on this very sequence).
    expect(calls.at(-1)).toBe('export');
    for (const [, payload] of updateDocument.mock.calls) {
      if (payload.content) expect(savedText(payload.content)).toContain('REAL BODY');
    }
  });
});
