import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Build Mode v2 thread (Oct 24 2026): a held pin shows "Waits For <Owner>"
// and only the owner (or a Global Admin) gets Release To Claude Code; a pin
// Ready To Check shows Open Preview, the host line and Accept / Reopen (Reopen
// needs a note); an accepted one is "PR Open - Checked"; a promoted bug shows
// Regression Test Added with a way into Testing.

vi.mock('../api', () => ({
  api: {
    devNotesRelease: vi.fn((id) => Promise.resolve({ id, held: false })),
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

const AUTHOR = 'neil@greensglobal.com';
const OWNER = 'visesh.lodha@greensglobal.com';
const OTHER = 'sagar@greensglobal.com';

const pin = (over = {}) => ({
  id: 'p2', number: 2, kind: 'bug', priority: 'normal', status: 'open', comment: 'Mark All Read does nothing', thread: [],
  route: 'inventory', sub: '', target: { selector: '#x', source: { file: 'src/components/NotificationBell.jsx', line: 40 } },
  createdBy: AUTHOR, createdAt: '2026-10-24T15:00:00Z', ...over,
});
const heldPin = (over = {}) => pin({ held: true, ownerEmail: OWNER, ownerName: 'Visesh', ...over });
const readyPin = (over = {}) => pin({
  status: 'pr_open', prNumber: 812, prUrl: 'https://github.com/Greens-Global/Greens-Nexus/pull/812', branch: 'build/session-7',
  preview: { url: 'http://localhost:5180/inventory', branch: 'build/session-7', prNumber: 812, host: 'Neils-MacBook-Pro', startedAt: '2026-10-24T17:00:00Z' },
  previewVerdict: '', readyToCheck: true, ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PinThread - held for the owner', () => {
  it('shows Waits For <Owner> and no Release button to someone who is not the owner', () => {
    render(<PinThread pin={heldPin()} me={{ email: OTHER, isAdmin: false }} detached />);
    expect(screen.getByTestId('bm-thread').textContent).toContain('Waits For Visesh');
    expect(screen.getByTestId('bm-held').textContent).toContain("Visesh's area");
    expect(screen.queryByRole('button', { name: /Release To Claude Code/ })).toBeNull();
  });

  it('the author is not the owner either - no Release button', () => {
    render(<PinThread pin={heldPin()} me={{ email: AUTHOR, isAdmin: false }} detached />);
    expect(screen.queryByRole('button', { name: /Release To Claude Code/ })).toBeNull();
  });

  it('the owner gets Release To Claude Code, which PATCHes release', async () => {
    const onChanged = vi.fn();
    render(<PinThread pin={heldPin()} me={{ email: OWNER, isAdmin: false }} detached onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Release To Claude Code/ }));
    await waitFor(() => expect(api.devNotesRelease).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('owner fields filled but not held (the author is the owner, or it was released): no line, no Release', () => {
    render(<PinThread pin={pin({ held: false, ownerEmail: AUTHOR, ownerName: 'Neil' })} me={{ email: AUTHOR, isAdmin: true }} detached />);
    expect(screen.queryByTestId('bm-held')).toBeNull();
    expect(screen.getByTestId('bm-thread').textContent).toContain('Open');
    expect(screen.queryByRole('button', { name: /Release To Claude Code/ })).toBeNull();
  });

  it('a Global Admin gets Release To Claude Code too', () => {
    render(<PinThread pin={heldPin()} me={{ email: OTHER, isAdmin: true }} detached />);
    expect(screen.getByRole('button', { name: /Release To Claude Code/ })).toBeTruthy();
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

  it('someone who is not the author sees the preview but no verdict buttons', () => {
    render(<PinThread pin={readyPin()} me={{ email: OTHER }} detached />);
    expect(screen.getByRole('link', { name: /Open Preview/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(screen.getByText(/Waiting for Neil to check it on the preview/)).toBeTruthy();
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

  it('a pin reopened on the preview says Claude Code is on it', () => {
    render(<PinThread pin={pin({ status: 'building', previewVerdict: 'reopened', thread: [{ kind: 'comment', by: AUTHOR, text: 'Still 3', at: '2026-10-24T17:10:00Z' }] })} me={{ email: AUTHOR }} detached />);
    expect(screen.getByTestId('bm-reopened').textContent).toBe('Reopened - Claude Code is on it.');
  });
});

describe('PinThread - regression link', () => {
  it('Regression Test Added opens the Testing module', () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    render(<PinThread pin={pin({ status: 'done', regressionCaseId: 'p2' })} me={{ email: AUTHOR }} detached />);
    expect(screen.getByTestId('bm-regression').textContent).toContain('Regression Test Added');
    fireEvent.click(screen.getByRole('button', { name: 'Open In Testing' }));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'testing' }]);
  });

  it('nothing when the pin has no regression case', () => {
    render(<PinThread pin={pin()} me={{ email: AUTHOR }} detached />);
    expect(screen.queryByTestId('bm-regression')).toBeNull();
  });
});
