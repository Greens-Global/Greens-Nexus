import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';

// The Word-style ribbon (Pranshu, Nov 4 2026): all eight tabs mount with
// their groups, and the Word Count box opens from Review.

const CONTENT = {
  pages: [{
    id: 'p1',
    json: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Agreement' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Dear borrower, the amount is due today.' }] },
    ] },
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
  render(<DocumentBuilder docId="t1" kind="template" onClose={() => {}} toastErr={() => {}} toastOk={() => {}} />);
  await waitFor(() => expect(document.querySelector('.doc-page .ProseMirror')).toBeTruthy());
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Home' })).toBeTruthy());
}

const captions = () => Array.from(document.querySelectorAll('.doc-ribbon-caption')).map((el) => el.textContent);

beforeEach(() => {
  getDocument.mockReset().mockResolvedValue(doc());
  updateDocument.mockReset().mockResolvedValue(doc());
});

describe('DocumentBuilder ribbon', () => {
  it('has the eight Word tabs, each with its groups', async () => {
    await mountTemplate();
    const expected = {
      File: ['Document', 'Share', 'Info'],
      Home: ['Undo', 'Clipboard', 'Font', 'Paragraph', 'Styles', 'Editing'],
      Insert: ['Pages', 'Tables', 'Illustrations', 'Nexus', 'Links', 'Comments', 'Header & Footer', 'Symbols'],
      Layout: ['Page Setup', 'Paragraph', 'Page Background'],
      References: ['Table of Contents', 'Footnotes'],
      Review: ['Proofing', 'Comments', 'Tracking'],
      View: ['Views', 'Zoom', 'Show'],
      Help: ['Help'],
    };
    for (const [tab, groups] of Object.entries(expected)) {
      expect(document.querySelector(`[data-tab="${tab.toLowerCase()}"]`)).toBeTruthy();
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      await waitFor(() => expect(captions()).toEqual(expect.arrayContaining(groups)));
    }
  });

  it('keeps every command the old toolbars had (Pranshu: nothing may be dropped)', async () => {
    await mountTemplate();
    const onTab = {
      home: ['Cut', 'Copy', 'Paste', /^Format Painter/, 'Bold', 'Italic', 'Underline', 'Strikethrough', 'Subscript', 'Superscript', 'Font', 'Font Size',
        'Grow Font', 'Shrink Font', 'Change Case', 'Font Color', 'Text Highlight Color', /^Styles - /, 'Align Left', 'Center', 'Align Right', 'Justify',
        'Link', 'Bullets', 'Numbering', 'Decrease Indent', 'Increase Indent', 'Line and Paragraph Spacing', 'Shading', 'Borders',
        'Sort A to Z (list items)', 'Sort Z to A (list items)', 'Show/Hide ¶', 'Find & Replace', 'Select All', 'Undo', 'Redo'],
      insert: ['Table', 'Picture', 'Shapes', 'Text Box', 'Signature Block - where a signer signs', 'Select text, then click to convert it into a named merge field',
        /^Find \{\{variables\}\}/, /^Template Fields/, /^Variable Library/, 'Bookmarks', 'Table of Contents', 'Symbol / Emoji', 'Start the next line on a new page'],
      layout: ['Margins', 'Orientation', 'Size', 'Columns', 'Breaks', 'Line Numbers', 'Page Setup', 'Space before paragraph, in points', 'Space after paragraph, in points', 'Page Color', 'Watermark'],
    };
    for (const [tab, titles] of Object.entries(onTab)) {
      fireEvent.click(document.querySelector(`[data-tab="${tab}"]`));
      for (const t of titles) expect(screen.getAllByTitle(t).length, String(t)).toBeGreaterThan(0);
    }
    // The Nexus-only commands sit together, under one caption.
    fireEvent.click(document.querySelector('[data-tab="insert"]'));
    const nexus = Array.from(document.querySelectorAll('.doc-ribbon-group')).find((g) => g.querySelector('.doc-ribbon-caption')?.textContent === 'Nexus');
    expect(nexus.textContent).toMatch(/Signature/);
    expect(nexus.querySelector('select[aria-label="Insert a variable"]')).toBeTruthy();
  });

  it('shows the fields Word has: a styles gallery naming the current style, galleries and menus', async () => {
    await mountTemplate();
    fireEvent.click(screen.getByRole('tab', { name: 'Home' }));
    expect(screen.getByTitle(/^Styles - /)).toBeTruthy();
    for (const name of ['Paste', 'Bullets', 'Numbering', 'Text Highlight Color', 'Font Color', 'Shading', 'Borders', 'Line and Paragraph Spacing', 'Format Painter', 'Clear All Formatting']) {
      expect(screen.getAllByTitle(new RegExp(`^${name}`)).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByTitle('Bullets'));
    expect(await screen.findByRole('menuitem', { name: /Square/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Insert' }));
    fireEvent.click(screen.getByTitle('Table'));
    expect(await screen.findByLabelText('3 by 3 table')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Layout' }));
    fireEvent.click(screen.getByTitle('Margins'));
    expect(await screen.findByRole('menuitem', { name: /Moderate/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'View' }));
    fireEvent.click(screen.getByTitle('Zoom'));
    expect(await screen.findByRole('menuitem', { name: 'Page Width' })).toBeTruthy();
  });

  it('counts the words from Review > Word Count, and the status bar says the page', async () => {
    await mountTemplate();
    expect(document.querySelector('.doc-status').textContent).toMatch(/Page 1 of 1/);
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    fireEvent.click(screen.getAllByTitle('Word Count').find((el) => el.classList.contains('doc-ribbon-big')));
    const box = await screen.findByText('Characters (with spaces)');
    expect(box).toBeTruthy();
    // "Agreement" + "Dear borrower, the amount is due today." = 8 words.
    expect(box.closest('table').textContent).toMatch(/Words8/);
  });
});
