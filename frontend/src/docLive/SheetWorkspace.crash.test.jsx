// The grid crashing never leaves a blank page: the sheet offers the saved copy
// and Version History, and Reload drops the live state for an editor.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getDocument: vi.fn(), documentHead: vi.fn(), documentMergeValues: vi.fn(), getDocVariables: vi.fn(),
  documentCollabReset: vi.fn(), getDocumentVersions: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../lib/supabase', () => ({ supabase: null }));
vi.mock('../lib/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'viewer@greensglobal.com' }) }));
vi.mock('../tasks/components', async (orig) => ({ ...(await orig()), usePeople: () => [] }));
vi.mock('../sheets', async (orig) => ({ ...(await orig()), SheetEditor: () => { throw new Error('boom'); } }));

import SheetWorkspace from './SheetWorkspace';
import { newSheetContent } from '../sheets';

describe('SheetWorkspace crash', () => {
  it('shows the recovery card and reloads the saved copy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMock.getDocument.mockResolvedValue({ id: 'd1', title: 'Budget', kind: 'sheet', status: 'draft', access: 'view', currentVersion: 1, sharedWith: [], content: newSheetContent() });
    apiMock.documentMergeValues.mockResolvedValue({ values: {} });
    apiMock.getDocVariables.mockResolvedValue([]);
    apiMock.documentHead.mockResolvedValue({ rev: 1 });
    render(<SheetWorkspace docId="d1" onClose={() => {}} />);
    const reload = await screen.findByRole('button', { name: 'Reload From the Saved Copy' });
    expect(screen.getAllByRole('button', { name: 'Version History' }).length).toBeGreaterThan(0);
    fireEvent.click(reload);
    await waitFor(() => expect(apiMock.getDocument).toHaveBeenCalledTimes(2));
  });
});
