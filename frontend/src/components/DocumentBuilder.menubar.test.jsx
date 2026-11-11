import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';

// The editor's menu bar (Neil, 11/10/2026): every command by menu, the
// shortcuts it lists working inside the document, and Collapse Ribbon.

vi.mock('../api', () => ({
  api: {
    getDocument: () => Promise.resolve({
      id: 'd1', title: 'Loan Agreement', letterheadId: '', employeeId: '', entityId: '', mergeOverrides: {}, fieldDefs: [], status: 'draft', currentVersion: 1,
      content: { pages: [{ id: 'p1', json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] } }], header: null, footer: null },
    }),
    updateDocument: () => Promise.resolve({}),
    getDocLetterheads: () => Promise.resolve([]),
    getDocVariables: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
  },
}));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div /> }));

const DocumentBuilder = (await import('./DocumentBuilder')).default;

async function mount() {
  render(<DocumentBuilder docId="d1" kind="document" onClose={() => {}} toastErr={() => {}} toastOk={() => {}} />);
  await waitFor(() => expect(document.querySelector('.doc-page .ProseMirror')).toBeTruthy());
  await waitFor(() => expect(document.querySelector('.doc-mb')).toBeTruthy());
  return document.querySelector('.doc-page .ProseMirror');
}

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe('the document menu bar', () => {
  it('has File, Edit, View, Insert, Format, Tools and Help', async () => {
    await mount();
    const tops = [...document.querySelectorAll('.doc-mb > button.doc-mb-top')].map((b) => b.textContent);
    expect(tops).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Help']);
  });

  it('Format > Text > Bold bolds the selection', async () => {
    const pm = await mount();
    pm.editor.commands.selectAll();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Format' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Text/ }));
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Bold/ }));
    expect(pm.editor.isActive('bold')).toBe(true);
  });

  it('Ctrl+F1 folds the ribbon away and a tab brings it back; Ctrl+H opens Find', async () => {
    const pm = await mount();
    expect(document.querySelector('.doc-ribbon-bar')).toBeTruthy();
    fireEvent.keyDown(pm, { key: 'F1', ctrlKey: true });
    await waitFor(() => expect(document.querySelector('.doc-ribbon-bar')).toBeNull());
    fireEvent.click(document.querySelector('[data-tab="home"]'));
    await waitFor(() => expect(document.querySelector('.doc-ribbon-bar')).toBeTruthy());
    fireEvent.keyDown(pm, { key: 'h', ctrlKey: true });
    expect(await screen.findByPlaceholderText(/Find/)).toBeTruthy();
  });
});
