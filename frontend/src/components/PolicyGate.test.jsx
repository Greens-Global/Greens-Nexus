import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The sign-in policy gate shows the text and version the server sends
// (edited in Settings), never raw HTML, and fails open so a backend problem
// can never lock people out.

const mockApi = { policyStatus: vi.fn(), policyAccept: vi.fn() };
vi.mock('../api', () => ({ api: mockApi }));

// A local .env may run the app in E2E mode, which skips the gate entirely.
vi.stubEnv('VITE_E2E', 'false');
const PolicyGate = (await import('./PolicyGate')).default;
const App = () => <div>The app</div>;

beforeEach(() => { mockApi.policyStatus.mockReset(); mockApi.policyAccept.mockReset(); });
afterEach(cleanup);

describe('PolicyGate', () => {
  it('shows the fetched text and version, and records acceptance of that version', async () => {
    mockApi.policyStatus.mockResolvedValue({
      accepted: false, version: '2026-09-26.2', title: 'House Rules',
      body: '## Employee monitoring\nScreenshots while clocked in.\n\n- No keystrokes\n- Stops at clock-out\n\n<b>not bold</b>',
    });
    mockApi.policyAccept.mockResolvedValue({ ok: true });
    const { container } = render(<PolicyGate><App /></PolicyGate>);
    expect(await screen.findByRole('heading', { name: 'House Rules' })).toBeInTheDocument();
    expect(screen.getByText('Employee monitoring')).toBeInTheDocument();
    expect(screen.getByText('No keystrokes').tagName).toBe('LI');
    expect(screen.getByText(/Version 09\/26\/2026 \(revision 2\)/)).toBeInTheDocument();
    // Typed markup stays text.
    expect(screen.getByText('<b>not bold</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.queryByText('The app')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Accept & Continue/ }));
    await waitFor(() => expect(screen.getByText('The app')).toBeInTheDocument());
    expect(mockApi.policyAccept).toHaveBeenCalledWith('2026-09-26.2');
  });

  it('shows a skeleton, not a blank screen, while loading', () => {
    mockApi.policyStatus.mockReturnValue(new Promise(() => {}));
    render(<PolicyGate><App /></PolicyGate>);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('lets people in when already accepted', async () => {
    mockApi.policyStatus.mockResolvedValue({ accepted: true, version: '2026-07-21', title: 'x', body: 'y' });
    render(<PolicyGate><App /></PolicyGate>);
    expect(await screen.findByText('The app')).toBeInTheDocument();
  });

  it('fails open when the status call fails', async () => {
    mockApi.policyStatus.mockRejectedValue(new Error('down'));
    render(<PolicyGate><App /></PolicyGate>);
    expect(await screen.findByText('The app')).toBeInTheDocument();
  });

  it('fails open when the server sends no text to show', async () => {
    mockApi.policyStatus.mockResolvedValue({ accepted: false, version: '2026-07-21' });
    render(<PolicyGate><App /></PolicyGate>);
    expect(await screen.findByText('The app')).toBeInTheDocument();
  });

  it('reloads the new text when a newer version was published meanwhile', async () => {
    mockApi.policyStatus
      .mockResolvedValueOnce({ accepted: false, version: 'v1', title: 'Old', body: 'Old text' })
      .mockResolvedValueOnce({ accepted: false, version: 'v2', title: 'New', body: 'New text' });
    mockApi.policyAccept.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    render(<PolicyGate><App /></PolicyGate>);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Accept & Continue/ }));
    expect(await screen.findByText('New text')).toBeInTheDocument();
    expect(screen.getByText(/policy was just updated/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});
