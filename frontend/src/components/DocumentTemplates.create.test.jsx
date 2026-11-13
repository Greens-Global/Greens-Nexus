import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// New Template opens a blank draft in the editor at once (Neil, 11/11/2026:
// "I don't like the step where it makes you name it before you make one") -
// the name and category are asked on Close. Its arrow holds the other ways in.
const calls = vi.hoisted(() => ({ getDocTemplates: vi.fn(), createDocTemplate: vi.fn() }));
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve([])) }) }));
vi.mock('./DocumentBuilder', () => ({ default: ({ docId, kind }) => <div>builder {kind} {docId}</div> }));
vi.mock('./EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));
vi.mock('./WordTemplateWizard', () => ({ default: () => <div>word wizard</div> }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const { default: DocumentTemplates } = await import('./DocumentTemplates');

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockReset());
  calls.getDocTemplates.mockResolvedValue([{ id: 't1', name: 'Offer Letter', category: 'hr', status: 'active', state: 'published', department: '' }]);
  calls.createDocTemplate.mockResolvedValue({ id: 't9', name: 'Untitled Template' });
});

describe('New Template', () => {
  it('makes an untitled draft and opens it, with no name step', async () => {
    render(<DocumentTemplates toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));      // "+ New" (Neil, 11/13/2026)
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Template/ }));
    expect(await screen.findByText('builder template t9')).toBeTruthy();
    expect(calls.createDocTemplate).toHaveBeenCalledWith({ name: 'Untitled Template', category: 'general', status: 'draft' });
    expect(screen.queryByLabelText(/Template name/i)).toBeNull();
  });

  it('keeps Word, the starters and Letterheads in its + New menu', async () => {
    render(<DocumentTemplates toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    for (const n of [/^Template/, /^From a Word File\.\.\./, /^Add Starter Templates/, /^Letterheads/]) {
      expect(await screen.findByRole('menuitem', { name: n })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'From Word File' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /^From a Word File/ }));
    await waitFor(() => expect(screen.getByText('word wizard')).toBeTruthy());
  });
});
