import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The packet editor (Oct 14): a Details Form built for the packet - offered
// the variables its documents print that nothing fills - and Signs Once on a
// company step, with who must sign shown for the company.

const save = vi.fn((d) => Promise.resolve({ id: 's1', ...d }));
vi.mock('../api', () => ({
  api: {
    hiringOptions: () => Promise.resolve({ roles: [] }),
    packetRoleHolders: () => Promise.resolve({ hr: { email: 'charmi@x.com', name: 'Charmi Shah' } }),
    getDocLetterheads: () => Promise.resolve([]),
    saveDocumentsPacket: (...a) => save(...a),
    signOnceStatus: () => Promise.resolve([{ key: 'company', roleLabel: 'HR', name: 'Charmi Shah', email: 'charmi@x.com', signed: false, isMe: true }]),
  },
}));
vi.mock('./ESign', () => ({ SignaturePad: () => null }));
const { DocumentsPacketEditor } = await import('./DocumentsPacketEditor');

const catalog = {
  docTemplates: [{ id: 't1', name: 'Contractor Agreement', publishedVersion: 1, signs: ['company', 'employee'],
                   variables: [{ token: 'pan_number', label: 'PAN Number', type: 'text' }] }],
  flowRoles: [{ key: 'hr', label: 'HR' }, { key: 'employee', label: 'The Person' }],
  verifyRoles: [{ key: 'hr', label: 'HR' }],
  actions: [{ key: 'sign', label: 'Signs' }, { key: 'copy', label: 'Gets A Copy' }],
};
const packet = { id: 's1', engine: 'documents', name: 'Admin Associate - India', docTemplateIds: ['t1'],
  flow: [{ key: 'company', role: 'hr', action: 'sign', once: true }, { key: 'employee', role: 'employee', action: 'sign' }],
  verifyRole: 'hr', detailsForm: [] };

describe('DocumentsPacketEditor', () => {
  it('builds the Details Form from what the documents need, and keeps Signs Once', async () => {
    render(<DocumentsPacketEditor packet={packet} event="hire" eventLabel="Hiring Packet" companyId="co" companyName="Greens India"
      catalog={catalog} onClose={() => {}} onSaved={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nothing fills them yet/)).toBeTruthy());
    expect(screen.getAllByRole('checkbox').some(c => c.checked)).toBe(true);           // Signs Once ticked
    await waitFor(() => expect(screen.getByText('Sign Once', { selector: 'button' })).toBeTruthy());
    fireEvent.click(screen.getByText('PAN Number', { selector: 'button' }));
    expect(screen.getByText('{{pan_number}}')).toBeTruthy();
    expect(screen.queryByText(/nothing fills them yet/)).toBeNull();
    fireEvent.click(screen.getByText('Add Field'));
    fireEvent.change(screen.getAllByLabelText('Field label')[1], { target: { value: 'IFSC Code' } });
    expect(screen.getByText('{{ifsc_code}}')).toBeTruthy();
    fireEvent.click(screen.getByText('Save Packet'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const body = save.mock.calls[0][0];
    expect(body.flow[0]).toEqual({ key: 'company', role: 'hr', action: 'sign', once: true });
    expect(body.details_form.map(f => [f.key, f.label])).toEqual([['pan_number', 'PAN Number'], ['', 'IFSC Code']]);
  });
});
