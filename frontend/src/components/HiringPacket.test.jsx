import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the hiring packet (Oct 2026): Hiring > Packets, the send
// form at Offer (review -> confirm -> send), and the packet's status on a
// candidate (HR signs first, then the new hire; filing in Egnyte).

const preview = {
  title: 'Hiring Packet - Jane Doe', company: 'Greens Test Co', templateId: 't1', templateName: 'Offer Packet',
  documents: ['Offer Packet', 'NDA.pdf'], unresolved: ['signing_bonus'], emailMessage: 'Welcome!',
  egnyteSubfolder: 'Hiring Documents', startDate: '2026-11-02', salaryText: '$96,000.00 per year',
  recipients: [{ order: 1, role: 'company', name: 'Hana', email: 'hana@x.com', isSubject: false },
               { order: 2, role: 'employee', name: 'Jane Doe', email: 'jane@gmail.com', isSubject: true }],
};
const sendPacket = vi.fn(() => Promise.resolve({ id: 'ev1', senderPartyId: 'p1', subjectEmail: 'jane@gmail.com' }));
const previewPacket = vi.fn(() => Promise.resolve(preview));
const events = [{
  id: 'ev1', kind: 'hire', status: 'awaiting_sender', createdAt: '2026-10-08T16:00:00Z', senderPartyId: 'p1',
  filingStatus: '', parties: [{ id: 'p1', order: 1, name: 'Hana', status: 'waiting', isSubject: false },
                              { id: 'p2', order: 2, name: 'Jane Doe', status: 'waiting', isSubject: true }],
}];
vi.mock('../api', () => ({
  api: {
    getPackets: () => Promise.resolve({
      settings: [], workerTypes: ['any', 'employee', 'contractor'],
      templates: [{ id: 't1', name: 'Offer Packet', entityId: '', documents: 2,
                    roles: [{ key: 'company', label: 'Company', order: 1 }, { key: 'employee', label: 'Employee', order: 2 }] }],
      events: [{ key: 'hire', label: 'Hiring Packet', defaultSubfolder: 'Hiring Documents' },
               { key: 'promotion', label: 'Promotion Letter', defaultSubfolder: 'Promotion Documents' }],
    }),
    getEntities: () => Promise.resolve([{ id: 'e1', name: 'Greens Test Co' }]),
    previewHiringPacket: (...a) => previewPacket(...a),
    sendHiringPacket: (...a) => sendPacket(...a),
    getLifeEvents: () => Promise.resolve(events),
    getPeopleDirectory: () => Promise.resolve([{ email: 'max@x.com', name: 'Max' }]),
    hiringOptions: () => Promise.resolve({ roles: [{ id: 'jr-an', name: 'Analyst', department: 'Accounting' }], departments: ['Accounting', 'IT'] }),
  },
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'max@x.com', name: 'Max' }] }) }));
vi.mock('./ESign', () => ({ SignModal: ({ partyId }) => <div data-testid="sign-modal">{partyId}</div> }));

const { PacketsModal, SendHiringPacketModal, HiringPacketStatus } = await import('./HiringPacket');
const noop = () => {};

describe('PacketsModal', () => {
  it('sets up the hiring packet and the promotion letter, starting empty', async () => {
    render(<PacketsModal onClose={noop} toastOk={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('Hiring Packet')).toBeTruthy());
    expect(screen.getByText('Promotion Letter')).toBeTruthy();
    expect(screen.getAllByText('No default packet yet.')).toHaveLength(2);
    fireEvent.click(screen.getAllByText('Packet For Everyone')[0]);
    expect(screen.getByText('Nexus Sign Template')).toBeTruthy();
  });
});

describe('SendHiringPacketModal', () => {
  const cand = { id: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@gmail.com', roleTitle: 'Analyst', roleId: 'jr-an', company: 'e1', expectedStart: '2026-11-02' };

  it('the job title is a company role; Other asks for the new role and warns it has no access yet', async () => {
    render(<SendHiringPacketModal candidate={cand} canSeePay onClose={noop} onSent={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('Analyst - Accounting')).toBeTruthy());
    expect(screen.getByText('Accounting')).toBeTruthy();                       // department follows the role
    fireEvent.change(screen.getByDisplayValue('Analyst - Accounting'), { target: { value: '__other__' } });
    expect(screen.getByPlaceholderText('e.g. Leasing Coordinator')).toBeTruthy();
    expect(screen.getByText(/NO access/)).toBeTruthy();
    expect(screen.getByText('Review Packet').closest('button')).toBeDisabled();  // name + department first
  });

  it('reviews, asks for what the template still needs, and sends only once confirmed', async () => {
    const onSent = vi.fn();
    render(<SendHiringPacketModal candidate={cand} canSeePay onClose={noop} onSent={onSent} toastErr={noop} />);
    fireEvent.click(screen.getByText('Review Packet'));
    await waitFor(() => expect(screen.getByText('Hiring Packet - Jane Doe')).toBeTruthy());
    expect(screen.getByText(/11\/02\/2026/)).toBeTruthy();                       // US date, no timezone shift
    expect(screen.getByText(/Human Resources > Employees > Jane Doe > Hiring Documents/)).toBeTruthy();
    const send = screen.getByText('Send And Sign').closest('button');
    expect(send).toBeDisabled();                                                  // missing field + no confirmation
    fireEvent.change(screen.getByText('signing bonus').parentElement.querySelector('input'), { target: { value: '$2,000' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(sendPacket.mock.calls[0][1].inputs.merge).toEqual({ signing_bonus: '$2,000' });
  });

  it('asks for pay as text without Pay & Benefits access', () => {
    render(<SendHiringPacketModal candidate={cand} canSeePay={false} onClose={noop} onSent={noop} toastErr={noop} />);
    expect(screen.getByPlaceholderText('e.g. $85,000 per year')).toBeTruthy();
  });
});

describe('HiringPacketStatus', () => {
  it('offers HR their signature first', async () => {
    const onSignNow = vi.fn();
    render(<HiringPacketStatus candidateId="c1" onSignNow={onSignNow} toastOk={noop} toastErr={noop} />);
    await waitFor(() => expect(screen.getByText('Awaiting Your Signature')).toBeTruthy());
    fireEvent.click(screen.getByText('Sign Now'));
    expect(onSignNow).toHaveBeenCalledWith('p1');
  });
});
