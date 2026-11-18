import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Claude Code In The Cloud (Neil, 11/12/2026): the connect card. The trigger
// token goes to the server and never comes back; the card only ever shows
// "connected" and the tail of the scheduled task's id.

let cloud = { connected: false, task: '', savedAt: '', lastStartedAt: '', lastError: '', target: 'local' };
vi.mock('../api', () => ({
  api: {
    devNotesCloud: vi.fn(() => Promise.resolve(cloud)),
    devNotesCloudSave: vi.fn(() => Promise.resolve({ connected: true, task: '...KLMNOP', savedAt: '2026-11-12T15:00:00Z', lastStartedAt: '', lastError: '', target: 'cloud' })),
    devNotesCloudClear: vi.fn(() => Promise.resolve(null)),
    devNotesTokenCreate: vi.fn(() => Promise.resolve({ id: 't1', token: 'nxbn_abc123', label: 'x' })),
    devNotesClaudeConnection: vi.fn(() => Promise.resolve({ connected: true, terminal: false, cloud: true })),
  },
}));

const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOP/fire';
const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40);

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); cloud = { connected: false, task: '', savedAt: '', lastStartedAt: '', lastError: '', target: 'local' }; });

const mount = async () => {
  const ConnectCloud = (await import('./ConnectCloud')).default;
  return render(<ConnectCloud apiBase="https://nexus-api.example.com" />);
};

describe('ConnectCloud', () => {
  it('walks the three one-time steps and connects; the trigger token is not kept on the screen', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /Connect In The Cloud/ }));
    // Step 1 names the host the Build Token is for and shows the token once.
    expect(screen.getByText('nexus-api.example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Make A Build Token/ }));
    expect(await screen.findByText('nxbn_abc123')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy Instructions/ })).toBeTruthy();
    // Connect waits for both fields.
    const connect = screen.getByRole('button', { name: /^Connect$/ });
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fire URL'), { target: { value: ` ${FIRE} ` } });
    fireEvent.change(screen.getByLabelText('Trigger token'), { target: { value: TOKEN } });
    expect(screen.getByLabelText('Trigger token').type).toBe('password');
    fireEvent.click(connect);
    const { api } = await import('../api');
    await waitFor(() => expect(api.devNotesCloudSave).toHaveBeenCalledWith(FIRE, TOKEN));
    const card = await screen.findByTestId('bm-cloud-connected');
    expect(card.textContent).toMatch(/connected in the cloud \(scheduled task \.\.\.KLMNOP\)/);
    expect(document.body.innerHTML).not.toContain('sk-ant-oat01');
    // The rest of Build Mode learns it at once: connected, and pins go to the cloud.
    const { store } = await import('./store');
    await waitFor(() => expect(store.get().claude).toEqual({ connected: true, terminal: false, cloud: true }));
    expect(store.get().settings.dispatchTarget).toBe('cloud');
  });

  it('says why when the server refuses the trigger, and keeps the form', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /Connect In The Cloud/ }));
    const { api } = await import('../api');
    api.devNotesCloudSave.mockRejectedValueOnce(new Error('That is not a Claude Code Fire URL'));
    fireEvent.change(screen.getByLabelText('Fire URL'), { target: { value: 'https://evil.example/fire' } });
    fireEvent.change(screen.getByLabelText('Trigger token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not a Claude Code Fire URL/);
    expect(screen.getByLabelText('Fire URL').value).toBe('https://evil.example/fire');
  });

  it('connected: shows the last error from a session that did not start, and Disconnect', async () => {
    cloud = { connected: true, task: '...KLMNOP', savedAt: '2026-11-12T15:00:00Z', lastStartedAt: '', lastError: 'Claude Code did not accept your trigger token', target: 'cloud' };
    await mount();
    const card = await screen.findByTestId('bm-cloud-connected');
    expect(card.textContent).toMatch(/Last try did not start: Claude Code did not accept your trigger token/);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    const { api } = await import('../api');
    await waitFor(() => expect(api.devNotesCloudClear).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Connect In The Cloud/ })).toBeTruthy();
  });
});
