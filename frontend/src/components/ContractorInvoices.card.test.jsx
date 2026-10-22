import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// The Invoice card under a contractor's Time Sheet (Oct 23): HR sends the
// draft right there (canSend from the server); everyone else sees Preview only.

const send = vi.fn(() => Promise.resolve({ sent: true, emailed: true }));
const confirm = vi.fn(() => Promise.resolve(true));
vi.mock('../api', () => ({ api: { contractorInvoiceSend: (...a) => send(...a) } }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));

import { InvoiceCard } from './ContractorInvoices';

const draft = { id: 'i1', number: 1, status: 'draft', amount: 10000, currency: 'INR' };
afterEach(() => { cleanup(); send.mockClear(); confirm.mockClear(); });

describe('InvoiceCard', () => {
  it('lets HR approve and send the draft from the card', async () => {
    const onSent = vi.fn();
    const toastOk = vi.fn();
    render(<InvoiceCard invoice={{ ...draft, canSend: true, recipients: ['ap@ggcon.in'], employeeName: 'Aarav Mehta' }}
      toastOk={toastOk} onSent={onSent} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve & Send/ }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toMatch(/to ap@ggcon\.in, with Aarav Mehta in cc/);
    expect(send).toHaveBeenCalledWith('i1');
    expect(toastOk).toHaveBeenCalledWith('Invoice 1 sent to ap@ggcon.in');
  });

  it('is disabled with the reason when the company has no recipients', () => {
    render(<InvoiceCard invoice={{ ...draft, canSend: true, recipients: [], companyName: 'GGCon' }} />);
    const btn = screen.getByRole('button', { name: /Approve & Send/ });
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/No recipients set for GGCon/);
  });

  it('offers only Preview to anyone else, and nothing to send once sent', () => {
    render(<InvoiceCard invoice={draft} />);
    expect(screen.getByRole('button', { name: 'Preview PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve & Send/ })).toBeNull();
    cleanup();
    render(<InvoiceCard invoice={{ ...draft, status: 'sent', sentAt: '2026-10-23T01:16:00Z', canSend: true }} />);
    expect(screen.queryByRole('button', { name: /Approve & Send/ })).toBeNull();
  });
});
