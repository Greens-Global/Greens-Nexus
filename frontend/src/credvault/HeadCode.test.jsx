// The department head's code card (11/13/2026): Send Code goes to the head,
// the code typed back opens the change; several departments are asked in turn.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ cvHeadCodeRequest: vi.fn(), cvHeadCodeVerify: vi.fn() }));
vi.mock('../api', () => ({ api }));
vi.mock('../tasks/components', () => ({ Modal: ({ title, children, footer }) => <div><h2>{title}</h2>{children}{footer}</div> }));

const { default: HeadCodeModal } = await import('./HeadCode');
const OPS = { companyId: 'gg', company: 'Greens Global', dept: 'Operations', heads: ['Valinda Head'], fallback: false };
const IT = { companyId: 'gg', company: 'Greens Global', dept: 'IT', heads: [], fallback: true };

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); });

describe('Department head code', () => {
  it('sends the code to the head, takes it back, and lets the change run', async () => {
    api.cvHeadCodeRequest.mockResolvedValue({ challengeId: 'ch1', sentTo: ['Valinda Head'] });
    api.cvHeadCodeVerify.mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    render(<HeadCodeModal scopes={[OPS]} action="add Gate" onDone={onDone} onCancel={() => {}} />);
    expect(screen.getByText('Valinda Head')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Send Code/ }));
    await waitFor(() => expect(api.cvHeadCodeRequest).toHaveBeenCalledWith({ companyId: 'gg', dept: 'Operations', action: 'add Gate' }));
    const box = await screen.findByLabelText('Code from the department head');
    fireEvent.change(box, { target: { value: '12a3456' } });
    expect(box.value).toBe('123456');                                           // digits only
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Code' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.cvHeadCodeVerify).toHaveBeenCalledWith({ challengeId: 'ch1', code: '123456', companyId: 'gg', dept: 'Operations' });
  });

  it('a wrong code says so and waits; several departments are asked one after another', async () => {
    api.cvHeadCodeRequest.mockResolvedValue({ challengeId: 'ch1', sentTo: ['Valinda Head'] });
    api.cvHeadCodeVerify.mockRejectedValueOnce(new Error('Incorrect code (4 attempts left).')).mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    render(<HeadCodeModal scopes={[OPS, IT]} action="import 2 logins" onDone={onDone} onCancel={() => {}} />);
    expect(screen.getByText('Department 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Send Code/ }));
    fireEvent.change(await screen.findByLabelText('Code from the department head'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Code' }));
    expect(await screen.findByText('Incorrect code (4 attempts left).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Code' }));
    expect(await screen.findByText('Department 2 of 2')).toBeTruthy();
    expect(screen.getByText(/no department head is set/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
