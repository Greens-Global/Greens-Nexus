// Leaving a sheet within the autosave wait (11/17/2026): the pending save
// used to be dropped with its timer on unmount - only Back flushed - so a
// change made just before another tab, a sidebar module or a bell row was
// lost with no warning. Unmount now fires the save the timer would have.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getDocument: vi.fn(), documentHead: vi.fn(), documentMergeValues: vi.fn(), getDocVariables: vi.fn(),
  getDocumentVersions: vi.fn(), getPeopleDirectory: vi.fn(),
}));
const live = vi.hoisted(() => ({
  status: 'live', ready: true, peers: [], restart: () => {}, fail: () => {}, setFlush: () => {},
  save: null, doc: { guid: 'g1' }, awareness: null,
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../lib/supabase', () => ({ supabase: null }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'editor@greensglobal.com' }) }));
vi.mock('../tasks/components', async (orig) => ({ ...(await orig()), usePeople: () => [] }));
vi.mock('./useLiveSession', () => ({ useLiveSession: () => live, useHeadPoll: () => false }));
// The grid is the engine's; here it only has to say "something changed".
vi.mock('../sheets', async (orig) => ({ ...(await orig()), SheetEditor: ({ onChange }) => <button type="button" onClick={onChange}>Change a Cell</button> }));

import SheetWorkspace from './SheetWorkspace';

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
  apiMock.documentMergeValues.mockResolvedValue({ values: {}, employeeId: '', entityId: '' });
  apiMock.getDocVariables.mockResolvedValue([]);
  apiMock.getDocument.mockResolvedValue({ id: 'd1', title: 'Budget', kind: 'sheet', status: 'draft', access: 'owner', currentVersion: 1, sharedWith: [], content: {} });
  live.save = vi.fn(() => Promise.resolve({}));
});

describe('SheetWorkspace leaving with a save pending', () => {
  it('unmounted inside the autosave wait: the pending save goes out, once', async () => {
    const { unmount } = render(<SheetWorkspace docId="d1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change a Cell' }));
    expect(live.save).not.toHaveBeenCalled();      // still waiting on the timer
    unmount();
    expect(live.save).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 1400)); // the old timer is gone: nothing a second time
    expect(live.save).toHaveBeenCalledTimes(1);
  });

  it('Back saves first, and the unmount after it sends nothing more', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<SheetWorkspace docId="d1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change a Cell' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Documents' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(live.save).toHaveBeenCalledTimes(1);
    unmount();
    expect(live.save).toHaveBeenCalledTimes(1);
  });

  it('nothing changed: leaving sends nothing', async () => {
    const { unmount } = render(<SheetWorkspace docId="d1" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Change a Cell' });
    unmount();
    expect(live.save).not.toHaveBeenCalled();
  });

  it('the tab hidden with a save pending: it goes out at once', async () => {
    render(<SheetWorkspace docId="d1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change a Cell' }));
    fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(live.save).toHaveBeenCalledTimes(1));
  });
});
