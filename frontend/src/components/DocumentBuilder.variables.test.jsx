import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import { VARIABLE_DRAG_TYPE } from '../lib/mergeFieldTypes';

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

// The list that was the always-on column (Sagar, 11/04/2026) is Variables >
// Variables Used since the redesign (Neil, 11/11/2026).
const rail = () => screen.getByRole('group', { name: 'Variables used in this document' });
function openUsed() {
  fireEvent.click(document.querySelector('[data-tab="variables"]'));
  fireEvent.click(screen.getByTitle('Variables Used - every variable placed in this document'));
}
const countFields = (json) => JSON.stringify(json).split('"mergeField"').length - 1;

beforeEach(() => {
  getDocument.mockReset().mockResolvedValue(doc());
  updateDocument.mockReset().mockResolvedValue(doc());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('DocumentBuilder variables used', () => {
  it('lists every variable placed in the document with how many places it is used', async () => {
    await mountTemplate();
    await vi.advanceTimersByTimeAsync(400);
    openUsed();
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
    openUsed();
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

  it('places a dragged variable once, never a second chip from the plain-text fallback', async () => {
    const editor = await mountTemplate();
    const dom = document.querySelector('.doc-page .ProseMirror');
    // jsdom lays nothing out, so ProseMirror cannot map the pointer to a
    // position and would ignore the drop before asking handleDrop. Answer
    // for it: the drop lands at the end of the paragraph.
    editor.view.posAtCoords = () => ({ pos: editor.state.doc.content.size - 1, inside: 0 });
    const data = { [VARIABLE_DRAG_TYPE]: 'loan.amount', 'text/plain': '{{loan.amount}}' };
    const dataTransfer = { getData: (k) => data[k] || '', types: Object.keys(data), dropEffect: 'copy', effectAllowed: 'copy' };
    fireEvent.drop(dom, { dataTransfer, clientX: 10, clientY: 10 });
    await waitFor(() => expect(countFields(editor.getJSON())).toBe(2));
    await vi.advanceTimersByTimeAsync(1500);   // past the {{token}} detector's delay
    expect(countFields(editor.getJSON())).toBe(2);
    expect(JSON.stringify(editor.getJSON())).not.toContain('{{loan.amount}}');
  });
});
