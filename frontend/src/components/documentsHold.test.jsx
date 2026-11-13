import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Hold to confirm in Documents (Neil, Oct 30 2026): deleting a draft
// document and deleting a template are row holds of HOLD_RECORD_MS, with no
// window.confirm in front; a refusal rewinds the button with the reason.
const calls = vi.hoisted(() => ({
  getDocFolders: vi.fn(), getDocumentLibrary: vi.fn(), deleteDocument: vi.fn(),
  getDocTemplates: vi.fn(), getDocLetterheads: vi.fn(), deleteDocTemplate: vi.fn(),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve([])) }) }));
vi.mock('./DocumentBuilder', () => ({ default: () => <div>document builder</div> }));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));
vi.mock('./WordTemplateWizard', () => ({ default: () => <div>wizard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const { default: DocumentsBrowser } = await import('./DocumentsBrowser');
const { default: DocumentTemplates } = await import('./DocumentTemplates');
const { HOLD_RECORD_MS } = await import('../ui/HoldButton');

const press = (el) => fireEvent.pointerDown(el, { button: 0, pointerId: 1 });

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.getDocFolders.mockResolvedValue([]);
  calls.getDocumentLibrary.mockResolvedValue([{ id: 'd1', kind: 'document', title: 'Vendor Agreement', folderId: '', status: 'draft', canManage: true, mine: true,
    updatedAt: '2026-09-01T10:00:00Z', tags: [], parties: [], signRequestId: '', signStatus: '' }]);
  calls.getDocLetterheads.mockResolvedValue([]);
  calls.getDocTemplates.mockResolvedValue([{ id: 't1', name: 'Offer Letter', category: 'hr', status: 'active', state: 'published', department: '', requiresLetterhead: false }]);
});
afterEach(() => { vi.useRealTimers(); });

describe('Delete a draft document', () => {
  it('deletes once the hold completes, with the same toast and reload', async () => {
    calls.deleteDocument.mockResolvedValue({});
    const toastOk = vi.fn();
    render(<DocumentsBrowser toastOk={toastOk} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByText('Vendor Agreement'));
    const btn = await screen.findByRole('button', { name: 'Delete Vendor Agreement, press and hold' });
    vi.useFakeTimers();
    press(btn);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(calls.deleteDocument).toHaveBeenCalledTimes(1);
    expect(calls.deleteDocument).toHaveBeenCalledWith('d1');
    expect(toastOk).toHaveBeenCalledWith('Deleted');
    expect(calls.getDocumentLibrary.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('Delete a template', () => {
  it('a refusal (409) rewinds the button and says to archive instead', async () => {
    calls.deleteDocTemplate.mockRejectedValue(Object.assign(new Error('Conflict'), { status: 409 }));
    render(<DocumentTemplates toastOk={vi.fn()} toastErr={vi.fn()} />);
    // Templates opens on category cards (Pranshu, 11/13/2026): open HR, then the row.
    fireEvent.click(await screen.findByRole('button', { name: 'HR, 1 template' }));
    fireEvent.click(await screen.findByRole('cell', { name: 'Offer Letter' }));
    const btn = await screen.findByRole('button', { name: 'Delete template Offer Letter, press and hold' });
    vi.useFakeTimers();
    press(btn);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(calls.deleteDocTemplate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe('This template has generated documents - archive it instead.');
  });
});
