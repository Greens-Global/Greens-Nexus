import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the review of an HR packet built from Documents (Oct 14):
// the verifier sees Verify And Send behind two confirmations; everyone else
// sees who they are waiting for, and pay stays hidden without access.

const base = {
  event: { id: 'ev1', kind: 'hire', status: 'review', title: 'Hiring Packet', subjectName: 'Jane Doe' },
  packetName: 'Analyst Hiring',
  offer: { jobTitle: 'Analyst', department: 'Accounting', startDate: '2026-11-02', offerExpires: '2026-10-28',
           managerName: 'Max Mgr', schedule: '9:00 AM - 5:00 PM, Monday - Friday', jdName: 'JD - Analyst' },
  details: { first_name: 'Jane', last_name: 'Doe', phone: '555-0100', address: '12 Pine St' },
  documents: [{ documentId: 'd1', title: 'Offer Letter - Jane Doe', templateName: 'Offer Letter', templateVersion: 3,
                version: 1, publishedAt: '2026-10-14T15:12:00Z', publishedBy: 'charmi@x.com', printsPay: true,
                canOpen: true, outdated: false, unresolved: [] }],
  recipients: [{ order: 1, name: 'Charmi Shah', email: 'charmi@x.com', roleLabel: 'HR', actionLabel: 'Signs', isSubject: false },
               { order: 2, name: 'Jane Doe', email: 'jane@gmail.com', roleLabel: 'The Person', actionLabel: 'Signs', isSubject: true }],
  verifier: { role: 'hr', roleLabel: 'HR', email: 'charmi@x.com', name: 'Charmi Shah' },
  problems: [], outdated: false, seen: { d1: 1 },
};
let review = base;
const verify = vi.fn(() => Promise.resolve({ id: 'ev1', status: 'awaiting_sender', senderPartyId: 'p1' }));
vi.mock('../api', () => ({
  api: {
    getPacketReview: () => Promise.resolve(review),
    regeneratePacket: () => Promise.resolve(review),
    verifyAndSendPacket: (...a) => verify(...a),
    voidLifeEvent: () => Promise.resolve({}),
    patchPacketValues: () => Promise.resolve(review),
    packetDocumentPdf: () => Promise.resolve({ blob: new Blob(['%PDF']) }),
  },
}));
vi.mock('./ESign', () => ({ SignaturePad: () => null }));
const { default: PacketReview } = await import('./PacketReview');
const noop = () => {};

describe('PacketReview', () => {
  it('the verifier checks, confirms and sends; then signs for the company', async () => {
    review = { ...base, canVerify: true, isVerifier: true, pay: { base: 85000 }, payText: '$85,000.00 per year' };
    const onSignNow = vi.fn();
    render(<PacketReview eventId="ev1" onClose={noop} onChanged={noop} onSignNow={onSignNow} toastOk={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('Offer Letter - Jane Doe')).toBeTruthy());
    expect(screen.getByText('$85,000.00 per year')).toBeTruthy();
    expect(screen.getByText('11/02/2026')).toBeTruthy();
    const send = screen.getByText('Verify And Send').closest('button');
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByText(/I checked every document/));
    fireEvent.click(screen.getByText(/not a record that cannot be signed/));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onSignNow).toHaveBeenCalledWith('p1'));
    expect(verify.mock.calls[0][1]).toEqual({ excluded_ack: true, seen: { d1: 1 } });
  });

  it("shows the Details Form answers (Sensitive locked) and asks the new HR to sign once", async () => {
    review = { ...base, canVerify: false, isVerifier: true, packetId: 's1', entityId: 'co', companyName: 'Greens India',
      answers: [{ key: '', label: 'Bank Details', type: 'heading' },
                { key: 'ifsc_code', label: 'IFSC Code', type: 'text', value: 'HDFC0001234', locked: false },
                { key: 'pan_number', label: 'PAN Number', type: 'text', sensitive: true, value: '', locked: true }],
      signOnce: [{ key: 'company', roleLabel: 'HR', name: 'Charmi Shah', email: 'charmi@x.com', signed: false, isMe: true }],
      problems: ['Charmi Shah (HR) signs this packet once before it can be sent.'] };
    render(<PacketReview eventId="ev1" onClose={noop} onChanged={noop} onSignNow={noop} toastOk={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('HDFC0001234')).toBeTruthy());
    expect(screen.getByText('Bank Details')).toBeTruthy();
    expect(screen.getAllByText('Pay & Benefits access needed').length).toBeGreaterThan(0);
    expect(screen.getByText('Company Signature')).toBeTruthy();
    fireEvent.click(screen.getByText('Sign Once', { selector: 'button' }));
    await waitFor(() => expect(screen.getByText('Sign Once - Analyst Hiring')).toBeTruthy());
  });

  it('anyone else sees who it is waiting for, and no pay', async () => {
    review = { ...base, canVerify: false, isVerifier: false };
    render(<PacketReview eventId="ev1" onClose={noop} onChanged={noop} onSignNow={noop} toastOk={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('Waiting For Charmi Shah (HR) To Verify')).toBeTruthy());
    expect(screen.queryByText('Verify And Send')).toBeNull();
    expect(screen.getByText('Pay & Benefits access needed')).toBeTruthy();
  });

  it('shows the problems that stop it', async () => {
    review = { ...base, canVerify: false, isVerifier: true, problems: ['Nobody holds HR to verify this packet.'] };
    render(<PacketReview eventId="ev1" onClose={noop} onChanged={noop} onSignNow={noop} toastOk={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('Nobody holds HR to verify this packet.')).toBeTruthy());
  });
});
