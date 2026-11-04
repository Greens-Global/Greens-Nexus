import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';

// The Variables Used rail and the Make Variable bubble (Sagar, 11/04/2026):
// every variable placed in the document is listed beside the pages, one click
// places it again, and selecting text offers to make it a variable.

const CONTENT = {
  pages: [{
    id: 'p1',
    json: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Dear borrower, the amount is ' },
      { type: 'mergeField', attrs: { token: 'loan.amount' } },
      { type: 'text', text: ' today.' },
    ] }] },
  }],
  header: null,
  footer: null,
  pageSetup: { size: 'letter', orientation: 'portrait', margins: 'normal' },
};

const getDocument = vi.fn();
const updateDocument = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDocument: (...a) => getDocument(...a),
    updateDocument: (...a) => updateDocument(...a),
    getDocTemplate: (...a) => getDocument(...a),
    updateDocTemplate: (...a) => updateDocument(...a),
    exportDocumentPdf: () => Promise.resolve({ blob: new Blob(['%PDF']), filename: 'x.pdf' }),
    exportDocumentDocx: () => Promise.resolve({ blob: new Blob(['x']), filename: 'x.docx' }),
    getDocLetterheads: () => Promise.resolve([]),
    getDocVariables: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
  },
}));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div /> }));

const DocumentBuilder = (await import('./DocumentBuilder')).default;

const doc = () => ({
  id: 't1', title: 'Loan Agreement', content: structuredClone(CONTENT),
  letterheadId: '', employeeId: '', entityId: '', mergeOverrides: {}, fieldDefs: [],
  status: 'draft', currentVersion: 1,
});

async function mountTemplate() {
  render(<DocumentBuilder docId="t1" kind="template" onClose={() => {}} toastErr={() => {}} />);
  await waitFor(() => expect(document.querySelector('.doc-page .ProseMirror')).toBeTruthy());
  return document.querySelector('.doc-page .ProseMirror').editor;
}

const rail = () => screen.getByRole('complementary', { name: 'Variables used in this document' });
const countFields = (json) => JSON.stringify(json).split('"mergeField"').length - 1;

beforeEach(() => {
  getDocument.mockReset().mockResolvedValue(doc());
  updateDocument.mockReset().mockResolvedValue(doc());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('DocumentBuilder variables rail', () => {
  it('lists every variable placed in the document with how many places it is used', async () => {
    await mountTemplate();
    await vi.advanceTimersByTimeAsync(400);
    // waitFor only waits while the callback THROWS; a null return resolved at
    // once and the row happened to be there before the editor paginated.
    const row = await waitFor(() => { const r = rail().querySelector('.nx-docb-var'); expect(r).toBeTruthy(); return r; });
    expect(row.textContent).toContain('loan.amount');
    expect(row.textContent).toContain('1 place');
    expect(rail().textContent).toContain('1'); // the count in the head
  });

  it('places the variable again at the cursor on a click, and the count follows', async () => {
    const editor = await mountTemplate();
    await vi.advanceTimersByTimeAsync(400);
    const row = await waitFor(() => { const r = rail().querySelector('.nx-docb-var'); expect(r).toBeTruthy(); return r; });
    editor.commands.focus('end');
    fireEvent.click(row);
    await waitFor(() => expect(countFields(editor.getJSON())).toBe(2));
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(rail().querySelector('.nx-docb-var').textContent).toContain('2 places'));
  });

  it('offers Make Variable over selected text and opens the field with that text as its label', async () => {
    const editor = await mountTemplate();
    editor.commands.focus();
    editor.commands.setTextSelection({ from: 1, to: 5 });   // "Dear"
    const btn = await screen.findByRole('button', { name: /Make Variable/ });
    fireEvent.click(btn);
    const label = await waitFor(() => screen.getByDisplayValue('Dear'));
    expect(label).toBeTruthy();
  });
});
