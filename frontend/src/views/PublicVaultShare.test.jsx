// A login shared outside Nexus (/vault-share/{token}, 11/13/2026): the link
// alone shows the login's name; the details come only after the code; an
// ended share says so and shows nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ fetchVaultShare: vi.fn(), sendVaultShareCode: vi.fn(), verifyVaultShare: vi.fn() }));
vi.mock('../api', () => api);
vi.mock('../components/AsyncState', () => ({ Spinner: () => <span>Loading</span> }));

const { default: PublicVaultShare } = await import('./PublicVaultShare');
const INFO = { state: 'active', name: 'Vendor Portal', company: 'Greens Global', sharedBy: 'Pranshu Pandey', until: Date.now() + 3600000, email: 'v•••@acme.com', sms: '' };

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });

describe('Shared login page', () => {
  it('shows only the name until the code, then the username, password and link', async () => {
    api.fetchVaultShare.mockResolvedValue(INFO);
    api.sendVaultShareCode.mockResolvedValue({ challengeId: 'ch1', target: 'v•••@acme.com' });
    api.verifyVaultShare.mockResolvedValue({ name: 'Vendor Portal', username: 'ops', url: 'https://portal.example.com', secret: 'Corr3ct-Horse!', until: INFO.until });
    render(<PublicVaultShare token="tok" />);
    expect(await screen.findByText('Vendor Portal')).toBeTruthy();
    expect(screen.queryByText('ops')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Get Code' }));
    await waitFor(() => expect(api.sendVaultShareCode).toHaveBeenCalledWith('tok', 'email'));
    fireEvent.change(await screen.findByLabelText('One-time code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    expect(await screen.findByText('ops')).toBeTruthy();
    expect(api.verifyVaultShare).toHaveBeenCalledWith('tok', 'ch1', '123456');
    expect(screen.queryByText('Corr3ct-Horse!')).toBeNull();                           // dots until Show
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('Corr3ct-Horse!')).toBeTruthy();
    expect(screen.getByText('https://portal.example.com')).toBeTruthy();
  });

  it('an ended share says so and offers no code', async () => {
    api.fetchVaultShare.mockResolvedValue({ ...INFO, state: 'ended' });
    render(<PublicVaultShare token="tok" />);
    expect(await screen.findByText(/This share has ended/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get Code' })).toBeNull();
  });

  it('SMS is offered only when the sharer gave a mobile, and waits for consent', async () => {
    api.fetchVaultShare.mockResolvedValue({ ...INFO, sms: '•••• 8853' });
    render(<PublicVaultShare token="tok" />);
    fireEvent.click(await screen.findByLabelText(/Text a code to/));
    expect(screen.getByRole('button', { name: 'Get Code' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Get Code' }).disabled).toBe(false);
  });
});
