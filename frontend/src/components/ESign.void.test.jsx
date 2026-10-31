import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Void an envelope (Neil, Oct 30 2026 - hold to confirm): a dialog names the
// document and its signers, and its confirm is a hold of HOLD_MAJOR_MS.
const api = vi.hoisted(() => ({
  getSignRequest: vi.fn(),
  voidSign: vi.fn(),
}));
vi.mock('../api', () => ({ api }));

const { RequestDetailModal } = await import('./ESign');
const { DialogHost } = await import('../ui/dialog');
const { HOLD_MAJOR_MS } = await import('../ui/HoldButton');

const REQ = {
  id: 'r1', title: 'Offer Letter - Sam Lee', status: 'pending', routing: 'sequential', hasFinalPdf: false, events: [],
  parties: [
    { id: 'p1', name: 'Sam Lee', email: 'sam@x.com', partyRole: 'signer', status: 'signed', ordinal: 1 },
    { id: 'p2', name: 'Ana Cruz', email: 'ana@x.com', partyRole: 'signer', status: 'sent', ordinal: 2 },
    { id: 'p3', name: 'Copy Desk', email: 'cc@x.com', partyRole: 'cc', status: 'waiting', ordinal: 3 },
  ],
};

afterEach(() => { vi.useRealTimers(); });

describe('Void an envelope', () => {
  it('asks with the document and its signers, then voids once on a full hold', async () => {
    api.getSignRequest.mockResolvedValue(REQ);
    api.voidSign.mockResolvedValue({ ...REQ, status: 'voided' });
    const toastOk = vi.fn();
    const onChanged = vi.fn();
    render(<><DialogHost /><RequestDetailModal requestId="r1" onClose={vi.fn()} onChanged={onChanged} toastOk={toastOk} toastErr={vi.fn()} /></>);
    fireEvent.click(await screen.findByRole('button', { name: /Void/ }));
    expect(await screen.findByText('Void This Envelope?')).toBeTruthy();
    expect(screen.getByText(/Offer Letter - Sam Lee" will be voided for every recipient. Signers: Sam Lee, Ana Cruz\./)).toBeTruthy();
    expect(screen.getByText(/the 1 signature already collected will not count/)).toBeTruthy();
    expect(api.voidSign).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const hold = screen.getByRole('button', { name: 'Void Envelope, press and hold' });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS - 100); });
    expect(api.voidSign).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(api.voidSign).toHaveBeenCalledTimes(1);
    expect(api.voidSign).toHaveBeenCalledWith('r1');
    expect(toastOk).toHaveBeenCalledWith('Voided.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps the dialog open with the reason when the server refuses', async () => {
    api.getSignRequest.mockResolvedValue(REQ);
    api.voidSign.mockRejectedValue(new Error('Request is already completed'));
    render(<><DialogHost /><RequestDetailModal requestId="r1" onClose={vi.fn()} onChanged={vi.fn()} toastOk={vi.fn()} toastErr={vi.fn()} /></>);
    fireEvent.click(await screen.findByRole('button', { name: /Void/ }));
    await screen.findByText('Void This Envelope?');
    vi.useFakeTimers();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Void Envelope, press and hold' }), { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(screen.getByRole('alert').textContent).toBe('Request is already completed');
    expect(screen.getByText('Void This Envelope?')).toBeTruthy();
  });
});
