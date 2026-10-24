import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Build Mode v2 thread (Oct 24 2026): a held pin shows "Waits For <Owner>"
// and only the owner (or a Global Admin) gets Release To Claude Code; a pin
// Ready To Check shows Open Preview, the host line and Accept / Reopen (Reopen
// needs a note); an accepted one is "PR Open - Checked"; a promoted bug shows
// Regression Test Added with a way into Testing.

vi.mock('../api', () => ({
  api: {
    devNotesRelease: vi.fn((id) => Promise.resolve({ id, number: 5, status: 'open', createdBy: 'neil@greensglobal.com', held: false })),
    devNotesPreviewVerdict: vi.fn((id, body) => Promise.resolve({ id, previewVerdict: body.accepted ? 'accepted' : 'reopened' })),
    devNotesThread: vi.fn(),
    devNotesVerify: vi.fn(),
    devNotesPatch: vi.fn(),
  },
  onApiRequest: vi.fn(() => () => {}),
  setApiBodyCapture: vi.fn(),
}));

const { PinThread } = await import('./Pins');
const { api } = await import('../api');
const { store } = await import('./store');
const { isLocalPreview, pinReopened } = await import('./meta');

const AUTHOR = 'neil@greensglobal.com';
const OWNER = 'visesh.lodha@greensglobal.com';
const OTHER = 'sagar@greensglobal.com';

const pin = (over = {}) => ({
  id: 'p2', number: 2, kind: 'bug', priority: 'normal', status: 'open', comment: 'Mark All Read does nothing', thread: [],
  route: 'inventory', sub: '', target: { selector: '#x', source: { file: 'src/components/NotificationBell.jsx', line: 40 } },
  createdBy: AUTHOR, createdAt: '2026-10-24T15:00:00Z', ...over,
});
// canRelease / canVerdict are the server's answer for the viewer.
const heldPin = (over = {}) => pin({ held: true, ownerEmail: OWNER, ownerName: 'Visesh', canRelease: false, canVerdict: true, ...over });
const readyPin = (over = {}) => pin({
  status: 'pr_open', prNumber: 812, prUrl: 'https://github.com/Greens-Global/Greens-Nexus/pull/812', branch: 'build/session-7',
  preview: { url: 'http://localhost:5180/inventory', branch: 'build/session-7', prNumber: 812, host: 'Neils-MacBook-Pro', startedAt: '2026-10-24T17:00:00Z' },
  previewVerdict: '', readyToCheck: true, canVerdict: true, ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PinThread - held for the owner', () => {
  it('shows Waits For <Owner> and no Release button when the server says canRelease false', () => {
    render(<PinThread pin={heldPin()} me={{ email: OTHER }} detached />);
    expect(screen.getByTestId('bm-thread').textContent).toContain('Waits For Visesh');
    expect(screen.getByTestId('bm-held').textContent).toContain("Visesh's area");
    expect(screen.queryByRole('button', { name: /Release To Claude Code/ })).toBeNull();
  });

  it('no flag from the server = no Release button, even for the owner', () => {
    const noFlag = { ...heldPin(), canRelease: undefined };
    render(<PinThread pin={noFlag} me={{ email: OWNER }} detached />);
    expect(screen.queryByRole('button', { name: /Release To Claude Code/ })).toBeNull();
  });

  it('canRelease: Release To Claude Code PATCHes release; the toast carries the new number and who sends it', async () => {
    const onChanged = vi.fn();
    render(<PinThread pin={heldPin({ canRelease: true })} me={{ email: OWNER }} detached onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Release To Claude Code/ }));
    await waitFor(() => expect(api.devNotesRelease).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(store.get().toast?.text).toBe('Pin #5 released - Neil sends it with their next Build Session'));
  });

  it('a release that went straight out (author on Send Instantly) says so', async () => {
    api.devNotesRelease.mockResolvedValueOnce({ id: 'p2', number: 6, status: 'dispatched', createdBy: AUTHOR, held: false });
    render(<PinThread pin={heldPin({ canRelease: true })} me={{ email: OWNER }} detached onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Release To Claude Code/ }));
    await waitFor(() => expect(store.get().toast?.text).toBe('Pin #6 released and sent to Claude Code'));
  });

  it('owner fields filled but not held (the author is the owner, or it was released): no line, no Release', () => {
    render(<PinThread pin={pin({ held: false, ownerEmail: AUTHOR, ownerName: 'Neil', canRelease: false })} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByTestId('bm-held')).toBeNull();
    expect(screen.getByTestId('bm-thread').textContent).toContain('Open');
    expect(screen.queryByRole('button', { name: /Release To Claude Code/ })).toBeNull();
  });


});

describe('PinThread - Ready To Check', () => {
  it('shows Ready To Check, Open Preview in a new tab, the host line, the branch and the PR', () => {
    render(<PinThread pin={readyPin()} me={{ email: AUTHOR }} detached />);
    const thread = screen.getByTestId('bm-thread');
    expect(thread.textContent).toContain('Ready To Check');
    const open = screen.getByRole('link', { name: /Open Preview/ });
    expect(open.getAttribute('href')).toBe('http://localhost:5180/inventory');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('bm-preview').textContent).toContain('Runs on Neils-MacBook-Pro - open it on that computer.');
    expect(screen.getByText('build/session-7')).toBeTruthy();
    expect(screen.getByRole('link', { name: /PR #812/ })).toBeTruthy();
  });

  it('Reopen is disabled until a note is typed; Accept and Reopen post the preview verdict', async () => {
    render(<PinThread pin={readyPin()} me={{ email: AUTHOR }} detached />);
    const reopen = screen.getByRole('button', { name: /^Reopen/ });
    expect(reopen).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Verdict note'), { target: { value: 'The count is still 3' } });
    expect(reopen).not.toBeDisabled();
    fireEvent.click(reopen);
    await waitFor(() => expect(api.devNotesPreviewVerdict).toHaveBeenCalledWith('p2', { accepted: false, comment: 'The count is still 3' }));
  });

  it('Accept works without a note', async () => {
    render(<PinThread pin={readyPin()} me={{ email: AUTHOR }} detached />);
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    await waitFor(() => expect(api.devNotesPreviewVerdict).toHaveBeenCalledWith('p2', { accepted: true, comment: '' }));
  });

  it('canVerdict false (not the author): the preview but no verdict buttons', () => {
    render(<PinThread pin={readyPin({ canVerdict: false })} me={{ email: OTHER }} detached />);
    expect(screen.getByRole('link', { name: /Open Preview/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(screen.getByText(/Waiting for Neil to check it on the preview/)).toBeTruthy();
  });

  it('no canVerdict flag at all: no verdict buttons', () => {
    const noFlag = { ...readyPin(), canVerdict: undefined };
    render(<PinThread pin={noFlag} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
  });

  it('Ctrl+Enter in the verdict note never posts it as a reply (Ready To Check and Fixed)', () => {
    render(<PinThread pin={readyPin()} me={{ email: AUTHOR }} detached />);
    const box = screen.getByLabelText('Verdict note');
    fireEvent.change(box, { target: { value: 'Looks fine' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    cleanup();
    render(<PinThread pin={pin({ status: 'fixed' })} me={{ email: AUTHOR }} detached />);
    const box2 = screen.getByLabelText('Verdict note');
    fireEvent.change(box2, { target: { value: 'Still broken' } });
    fireEvent.keyDown(box2, { key: 'Enter', metaKey: true });
    expect(api.devNotesThread).not.toHaveBeenCalled();
  });

  it('isLocalPreview follows the server rule', () => {
    expect(isLocalPreview('http://localhost:5180/inventory')).toBe(true);
    expect(isLocalPreview('http://127.0.0.1:5180')).toBe(true);
    expect(isLocalPreview('http://localhost/inventory')).toBe(false);          // no port
    expect(isLocalPreview('https://localhost:5180')).toBe(false);
    expect(isLocalPreview('http://user:pw@localhost:5180')).toBe(false);
    expect(isLocalPreview('http://localhost.evil.com:5180')).toBe(false);
    expect(isLocalPreview('http://localhost:5180@evil.com/')).toBe(false);
    expect(isLocalPreview('not a url')).toBe(false);
  });

  it('an outside link is never offered as the preview', () => {
    render(<PinThread pin={readyPin({ preview: { url: 'https://evil.example.com', host: 'x' } })} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByRole('link', { name: /Open Preview/ })).toBeNull();
  });

  it('after Accept: PR Open - Checked and the Checked On The Preview marker', () => {
    render(<PinThread pin={readyPin({ previewVerdict: 'accepted', readyToCheck: false })} me={{ email: AUTHOR }} detached />);
    expect(screen.getByTestId('bm-thread').textContent).toContain('PR Open - Checked');
    expect(screen.getByTestId('bm-checked').textContent).toContain('Checked On The Preview');
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
  });

  it('reopened on the preview: waiting for Claude while the note is last, then "on it" once Claude picked it up', () => {
    const note = { kind: 'comment', by: AUTHOR, text: 'Still 3', at: '2026-10-24T17:10:00Z' };
    const picked = { kind: 'progress', by: 'claude', text: 'Picked up by Claude Code', at: '2026-10-24T17:11:00Z' };
    render(<PinThread pin={pin({ status: 'building', previewVerdict: 'reopened', thread: [note] })} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByTestId('bm-reopened')).toBeNull();
    expect(screen.getByText('Waiting for Claude Code to pick up your reply.')).toBeTruthy();
    cleanup();
    render(<PinThread pin={pin({ status: 'building', previewVerdict: 'reopened', thread: [note, picked] })} me={{ email: AUTHOR }} detached />);
    expect(screen.getByTestId('bm-reopened').textContent).toBe('Reopened - Claude Code is on it.');
  });

  it('reopened but Claude asked a question (needs_input): the needs-input text, never "on it"', () => {
    const p = pin({ status: 'needs_input', previewVerdict: 'reopened', thread: [{ kind: 'claude', by: 'claude', text: 'Which count?', at: '2026-10-24T17:12:00Z' }] });
    expect(pinReopened(p)).toBe(false);
    render(<PinThread pin={p} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByTestId('bm-reopened')).toBeNull();
    expect(screen.getByText(/Claude Code is waiting for your answer/)).toBeTruthy();
  });
});

describe('PinThread - regression link', () => {
  it('Regression Test Added opens the Testing module', () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    render(<PinThread pin={pin({ status: 'done', regressionCaseId: 'p2' })} me={{ email: AUTHOR, canTesting: true }} detached />);
    expect(screen.getByTestId('bm-regression').textContent).toContain('Regression Test Added');
    expect(screen.getByTestId('bm-regression').textContent).toContain('Pin #2 - Mark All Read does nothing');
    fireEvent.click(screen.getByRole('button', { name: 'Open In Testing' }));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'testing' }]);
  });

  it('no Open In Testing for someone who cannot open the Testing module - the line and case title still show', () => {
    render(<PinThread pin={pin({ status: 'done', regressionCaseId: 'p2' })} me={{ email: OTHER, canTesting: false }} detached />);
    expect(screen.getByTestId('bm-regression').textContent).toContain('Pin #2 - Mark All Read does nothing');
    expect(screen.queryByRole('button', { name: 'Open In Testing' })).toBeNull();
  });

  it('nothing when the pin has no regression case', () => {
    render(<PinThread pin={pin()} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByTestId('bm-regression')).toBeNull();
  });
});
