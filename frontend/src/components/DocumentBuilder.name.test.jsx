import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen, within } from '@testing-library/react';

// A document or template is made with no name step (Neil, 11/11/2026: "Once
// you make it you should have to name it before closing it, with an auto
// saved name as a default"). Close asks "Name This Document" with the name
// filled in - the first line, else "Document - <today>" - Keep Editing stays,
// Save & Close renames and leaves. A named one closes at once, and a blank
// untitled draft of your own is not kept.

const getDocument = vi.fn();
const updateDocument = vi.fn();
const deleteDocument = vi.fn();
const getDocTemplate = vi.fn();
const updateDocTemplate = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDocument: (...a) => getDocument(...a),
    updateDocument: (...a) => updateDocument(...a),
    deleteDocument: (...a) => deleteDocument(...a),
    getDocTemplate: (...a) => getDocTemplate(...a),
    updateDocTemplate: (...a) => updateDocTemplate(...a),
    getDocLetterheads: () => Promise.resolve([]),
    getDocVariables: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
  },
}));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div /> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'pat@example.com', myLevel: 3, can: () => true }) }));
vi.mock('../ui/dialog', () => ({ dialog: { prompt: () => Promise.resolve(null), confirm: () => Promise.resolve(true), alert: () => Promise.resolve() } }));

const DocumentBuilder = (await import('./DocumentBuilder')).default;

const para = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const doc = (title, text = 'Master Services Agreement', extra = {}) => ({
  id: 'd1', title, letterheadId: '', employeeId: '', entityId: '', mergeOverrides: {}, fieldDefs: [], status: 'draft', currentVersion: 1,
  ownerEmail: 'pat@example.com', mine: true, sharedWith: [],
  content: { pages: [{ id: 'p1', json: { type: 'doc', content: [para(text)] } }], header: null, footer: null },
  ...extra,
});

async function mount(d, kind = 'document') {
  if (kind === 'template') getDocTemplate.mockResolvedValue({ ...d, name: d.title, category: 'hr' });
  else getDocument.mockResolvedValue(d);
  const onClose = vi.fn();
  render(<DocumentBuilder docId="d1" kind={kind} onClose={onClose} toastOk={() => {}} toastErr={() => {}} />);
  await waitFor(() => expect(document.querySelector('.doc-page .ProseMirror')).toBeTruthy());
  return onClose;
}
const card = () => screen.getByRole('dialog', { name: /Name This/ });

beforeEach(() => {
  getDocument.mockReset();
  getDocTemplate.mockReset();
  updateDocument.mockReset().mockResolvedValue({});
  updateDocTemplate.mockReset().mockResolvedValue({});
  deleteDocument.mockReset().mockResolvedValue({});
});

describe('naming a document on Close', () => {
  it('shows an empty name box saying Untitled Document', async () => {
    await mount(doc('Untitled Document'));
    const box = document.querySelector('input[placeholder="Untitled Document"]');
    expect(box.value).toBe('');
  });

  it('asks with the first line filled in; Keep Editing stays', async () => {
    const onClose = await mount(doc('Untitled Document'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByLabelText('Document name').value).toBe('Master Services Agreement');
    fireEvent.click(within(card()).getByRole('button', { name: 'Keep Editing' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Name This/ })).toBeNull();
    expect(updateDocument).not.toHaveBeenCalledWith('d1', expect.objectContaining({ title: expect.anything() }));
  });

  it('Save & Close renames it, then closes', async () => {
    const onClose = await mount(doc('Untitled Document'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(card()).toBeTruthy());
    fireEvent.change(within(card()).getByLabelText('Document name'), { target: { value: 'MSA - Acme' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Save & Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateDocument).toHaveBeenCalledWith('d1', { title: 'MSA - Acme' });
  });

  it('a named document closes without asking', async () => {
    const onClose = await mount(doc('Loan Agreement'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: /Name This/ })).toBeNull();
  });

  it('a blank untitled draft of your own is not kept', async () => {
    const onClose = await mount(doc('Untitled Document', ''));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(deleteDocument).toHaveBeenCalledWith('d1');
    expect(screen.queryByRole('dialog', { name: /Name This/ })).toBeNull();
  });

  it('a blank draft somebody else owns is never deleted', async () => {
    await mount(doc('Untitled Document', '', { ownerEmail: 'someone@example.com', mine: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(card()).toBeTruthy());
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(within(card()).getByLabelText('Document name').value).toMatch(/^Document - \d{2}\/\d{2}\/\d{4}$/);
  });
});

describe('naming a template on Close', () => {
  it('asks for the name and the category', async () => {
    const onClose = await mount(doc('Untitled Template', 'Offer Letter'), 'template');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByRole('heading').textContent).toBe('Name This Template');
    expect(within(card()).getByLabelText('Template category').value).toBe('hr');
    fireEvent.change(within(card()).getByLabelText('Template category'), { target: { value: 'legal' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Save & Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateDocTemplate).toHaveBeenCalledWith('d1', { name: 'Offer Letter', category: 'legal' });
  });
});
