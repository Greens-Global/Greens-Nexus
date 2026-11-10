import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';

// An unnamed document cannot be closed without a name (Neil, 11/10/2026):
// Close asks "Name This Document" (pre-filled with the first line), Keep
// Editing stays, Save & Close renames and leaves. A named one closes at once.

const getDocument = vi.fn();
const updateDocument = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDocument: (...a) => getDocument(...a),
    updateDocument: (...a) => updateDocument(...a),
    getDocLetterheads: () => Promise.resolve([]),
    getDocVariables: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
  },
}));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div /> }));
const prompt = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => prompt(...a), confirm: () => Promise.resolve(true), alert: () => Promise.resolve() } }));

const DocumentBuilder = (await import('./DocumentBuilder')).default;

const doc = (title) => ({
  id: 'd1', title, letterheadId: '', employeeId: '', entityId: '', mergeOverrides: {}, fieldDefs: [], status: 'draft', currentVersion: 1,
  content: { pages: [{ id: 'p1', json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Master Services Agreement' }] }] } }], header: null, footer: null },
});

async function mount(title) {
  getDocument.mockResolvedValue(doc(title));
  const onClose = vi.fn();
  render(<DocumentBuilder docId="d1" kind="document" onClose={onClose} toastErr={() => {}} />);
  await waitFor(() => expect(document.querySelector('.doc-page .ProseMirror')).toBeTruthy());
  return onClose;
}

beforeEach(() => {
  prompt.mockReset();
  getDocument.mockReset();
  updateDocument.mockReset().mockResolvedValue({});
});

describe('naming a document on Close', () => {
  it('shows an empty name box saying Untitled Document', async () => {
    await mount('Untitled Document');
    const box = screen.getByLabelText('Document name');
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('Untitled Document');
  });

  it('Keep Editing stays on the document', async () => {
    const onClose = await mount('Untitled Document');
    prompt.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(prompt.mock.calls[0][1]).toMatchObject({ title: 'Name This Document', defaultValue: 'Master Services Agreement', required: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(onClose).not.toHaveBeenCalled();
    expect(updateDocument).not.toHaveBeenCalledWith('d1', expect.objectContaining({ title: expect.anything() }));
  });

  it('Save & Close renames it, then closes', async () => {
    const onClose = await mount('Untitled Document');
    prompt.mockResolvedValue('MSA - Acme');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateDocument).toHaveBeenCalledWith('d1', { title: 'MSA - Acme' });
  });

  it('a named document closes without asking', async () => {
    const onClose = await mount('Loan Agreement');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(prompt).not.toHaveBeenCalled();
  });
});
