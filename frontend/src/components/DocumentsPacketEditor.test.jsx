import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The packet editor (Oct 14): a Details Form built for the packet - offered
// the variables its documents print that nothing fills - and Signs Once on a
// company step, with who must sign shown for the company.

const save = vi.fn((d) => Promise.resolve({ id: 's1', ...d }));
vi.mock('../api', () => ({
  api: {
    hiringOptions: () => Promise.resolve({ roles: [], departments: ['Administration', 'IT'] }),
    packetRoleHolders: () => Promise.resolve({ hr: { email: 'charmi@x.com', name: 'Charmi Shah' } }),
    getDocLetterheads: () => Promise.resolve([]),
    saveDocumentsPacket: (...a) => save(...a),
    packetReadiness: () => Promise.resolve({ readiness: [] }),
    getPeopleDirectory: () => Promise.resolve([]),
    signOnceStatus: () => Promise.resolve([{ key: 'company', roleLabel: 'HR', name: 'Charmi Shah', email: 'charmi@x.com', signed: false, isMe: true }]),
  },
}));
vi.mock('./ESign', () => ({ SignaturePad: () => null }));
const { DocumentsPacketEditor } = await import('./DocumentsPacketEditor');

const catalog = {
  docTemplates: [{ id: 't1', name: 'Contractor Agreement', publishedVersion: 1, signs: ['company', 'employee'],
                   variables: [{ token: 'pan_number', label: 'PAN Number', type: 'text' }] },
                 { id: 't-ca', name: 'Administration CA', publishedVersion: 1, signs: ['employee'], variables: [],
                   personQuestions: ['Bank Name'], hrQuestions: [] }],
  countries: ['US', 'IN'],
  flowRoles: [{ key: 'hr', label: 'HR' }, { key: 'employee', label: 'The Person' }],
  verifyRoles: [{ key: 'hr', label: 'HR' }],
  actions: [{ key: 'sign', label: 'Signs' }, { key: 'copy', label: 'Gets A Copy' }],
};
const packet = { id: 's1', engine: 'documents', name: 'Admin Associate - India', docTemplateIds: ['t1'],
  flow: [{ key: 'company', role: 'hr', action: 'sign', once: true }, { key: 'employee', role: 'employee', action: 'sign' }],
  verifyRole: 'hr', detailsForm: [],
  readiness: [{ key: 'payPrints', ok: false, severity: 'warn', label: 'Pay Shows In A Document', detail: 'Not printed anywhere.',
                fix: { kind: 'template', templateId: 't1' } }] };

describe('DocumentsPacketEditor', () => {
  it('builds the Details Form from what the documents need, and keeps Signs Once', async () => {
    render(<DocumentsPacketEditor packet={packet} event="hire" eventLabel="Hiring Packet" companyId="co" companyName="Greens India"
      catalog={catalog} onClose={() => {}} onSaved={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nothing fills them yet/)).toBeTruthy());
    expect(screen.getByText('Ready To Send')).toBeTruthy();                        // the checklist, first thing
    expect(screen.getByText('1 Warning')).toBeTruthy();
    expect(screen.getByText('Pay Shows In A Document')).toBeTruthy();
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

  it('adds the team document, and picks the packet by employee or contractor and country', async () => {
    save.mockClear();
    render(<DocumentsPacketEditor packet={packet} event="hire" eventLabel="Hiring Packet" companyId="co" companyName="Greens India"
      catalog={catalog} onClose={() => {}} onSaved={() => {}} toastErr={() => {}} />);
    fireEvent.change(screen.getByLabelText('Hired As'), { target: { value: 'contractor' } });
    fireEvent.change(screen.getByLabelText('Works In'), { target: { value: 'IN' } });
    fireEvent.click(screen.getByText('Add For A Team Or Role'));
    fireEvent.change(screen.getByLabelText('Which team'), { target: { value: 'Administration' } });
    fireEvent.change(screen.getByLabelText('Add a document for this team or role'), { target: { value: 't-ca' } });
    expect(screen.getAllByText('Administration CA').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Save Packet'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const body = save.mock.calls[0][0];
    expect(body).toMatchObject({ worker_type: 'contractor', country: 'IN',
      extra_docs: [{ match: 'department', value: 'Administration', templateIds: ['t-ca'] }] });
  });
});
