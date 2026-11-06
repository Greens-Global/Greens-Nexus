// The Sheet page never sits on a skeleton: a saved copy that cannot be shown
// says so and offers Version History; a good one renders the grid read only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getDocument: vi.fn(), documentHead: vi.fn(), documentMergeValues: vi.fn(), getDocVariables: vi.fn(),
  getDocumentVersions: vi.fn(), getPeopleDirectory: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../lib/supabase', () => ({ supabase: null }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'viewer@greensglobal.com' }) }));
vi.mock('../tasks/components', async (orig) => ({ ...(await orig()), usePeople: () => [] }));

import SheetWorkspace from './SheetWorkspace';
import { newSheetContent } from '../sheets';

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
  apiMock.documentMergeValues.mockResolvedValue({ values: {}, employeeId: '', entityId: '' });
  apiMock.getDocVariables.mockResolvedValue([]);
  apiMock.documentHead.mockResolvedValue({ rev: 1 });
});

const row = (content) => ({ id: 'd1', title: 'Budget', kind: 'sheet', status: 'draft', access: 'view', currentVersion: 1, sharedWith: [], content });

describe('SheetWorkspace', () => {
  it('shows a viewer the grid, read only', async () => {
    apiMock.getDocument.mockResolvedValue(row(newSheetContent()));
    render(<SheetWorkspace docId="d1" onClose={() => {}} />);
    expect(await screen.findByRole('grid')).toBeTruthy();
    expect(screen.getAllByText('View Only').length).toBeGreaterThan(0);
  });

  it('says so, with Version History, when the saved copy cannot be opened', async () => {
    apiMock.getDocument.mockResolvedValue(row({ type: 'nexus-sheet', v: 1, tabs: [{ id: 't1', name: 'x', rows: 'bad', cols: [], cells: {} }] }));
    render(<SheetWorkspace docId="d1" onClose={() => {}} />);
    expect(await screen.findByText(/could not be opened/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Version History' }).length).toBeGreaterThan(0);
  });
});
