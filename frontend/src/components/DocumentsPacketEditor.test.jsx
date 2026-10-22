import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The packet editor as four short steps (Oct 15): Who It's For -> Documents
// -> Who Signs -> Ready To Send. Problems show only when Continue is pressed,
// on the step they belong to; a saved packet opens on its checklist.

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
  flowRoles: [{ key: 'hr', label: 'HR' }, { key: 'employee', label: 'The Person' }],
  verifyRoles: [{ key: 'hr', label: 'HR' }],
  actions: [{ key: 'sign', label: 'Signs' }, { key: 'copy', label: 'Gets A Copy' }],
  countries: ['US', 'IN'],
};
const packet = { id: 's1', engine: 'documents', name: 'Admin Associate - India', docTemplateIds: ['t1'], country: 'IN', workerType: 'contractor',
  flow: [{ key: 'company', role: 'hr', action: 'sign', once: true }, { key: 'employee', role: 'employee', action: 'sign' }],
  verifyRole: 'hr', detailsForm: [],
  readiness: [{ key: 'payPrints', ok: false, severity: 'warn', label: 'Pay Shows In A Document', detail: 'Not printed anywhere.',
                fix: { kind: 'template', templateId: 't1' } }] };
const props = { event: 'hire', eventLabel: 'Hiring Packet', companyId: 'co', companyName: 'Greens India', catalog, onClose: () => {}, onSaved: () => {}, toastErr: () => {} };

describe('DocumentsPacketEditor', () => {
  it('a saved packet opens on Ready To Send; the form builds from what the documents need; Signs Once stays', async () => {
    render(<DocumentsPacketEditor {...props} packet={packet} />);
    expect(screen.getByText('Ready To Send?')).toBeTruthy();                   // the checklist, first thing
    expect(screen.getByText('1 Warning')).toBeTruthy();
    expect(screen.getByText('Pay Shows In A Document')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Documents/ }));
    await waitFor(() => expect(screen.getByText(/nothing fills them yet/)).toBeTruthy());
    fireEvent.click(screen.getByText('PAN Number', { selector: 'button' }));
    expect(screen.getByText('{{pan_number}}')).toBeTruthy();
    expect(screen.queryByText(/nothing fills them yet/)).toBeNull();
    fireEvent.click(screen.getByText('Add Field'));
    fireEvent.change(screen.getAllByLabelText('Field label')[1], { target: { value: 'IFSC Code' } });
    expect(screen.getByText('{{ifsc_code}}')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Who Signs/ }));
    expect(screen.getAllByRole('checkbox').some(c => c.checked)).toBe(true);           // Signs Once ticked
    await waitFor(() => expect(screen.getByText('Sign Once', { selector: 'button' })).toBeTruthy());
    fireEvent.click(screen.getByText('Save Packet'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const body = save.mock.calls[0][0];
    expect(body.flow[0]).toEqual({ key: 'company', role: 'hr', action: 'sign', once: true });
    expect(body.details_form.map(f => [f.key, f.label])).toEqual([['pan_number', 'PAN Number'], ['', 'IFSC Code']]);
    expect(screen.getByText('Ready To Send?')).toBeTruthy();                   // back on the checklist after saving
  });

  it('a new packet walks the steps, says what is missing only on Continue, and saves the team document', async () => {
    save.mockClear();
    render(<DocumentsPacketEditor {...props} packet={null} />);
    expect(screen.queryByText('Give the packet a name.')).toBeNull();          // nothing nags before you type
    expect(screen.queryByText('Ready To Send?')).toBeNull();
    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByText('Give the packet a name.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'India Contractor Hire' } });
    fireEvent.change(screen.getByLabelText('Hired As'), { target: { value: 'contractor' } });
    fireEvent.change(screen.getByLabelText('Works In'), { target: { value: 'IN' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByText('Which documents go out?')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Pick a template to add'), { target: { value: 't1' } });
    fireEvent.click(screen.getByText('Add Document'));
    fireEvent.click(screen.getByText('Add For A Team Or Role'));
    fireEvent.change(screen.getByLabelText('Which team'), { target: { value: 'Administration' } });
    fireEvent.change(screen.getByLabelText('Add a document for this team or role'), { target: { value: 't-ca' } });
    expect(screen.getAllByText('Administration CA').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByText('Who signs, and who checks?')).toBeTruthy();
    expect(screen.getByText('Company')).toBeTruthy();                           // a step per signature spot
    fireEvent.click(screen.getByText('Save Packet'));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ name: 'India Contractor Hire', worker_type: 'contractor', country: 'IN',
      doc_template_ids: ['t1'], extra_docs: [{ match: 'department', value: 'Administration', templateIds: ['t-ca'] }] });
  });
});

// Neil, Oct 22: a hiring packet is a place's paperwork, never "any country",
// and its name says the place until HR types one.
describe('DocumentsPacketEditor - place first', () => {
  it('a new hiring packet asks where and who before anything, and names itself from that', async () => {
    render(<DocumentsPacketEditor {...props} packet={null} />);
    fireEvent.click(screen.getByText(/Continue/));
    expect(await screen.findByText(/Pick where these hires work/)).toBeTruthy();
    expect(screen.getByText('Pick employees or contractors.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Works In'), { target: { value: 'US' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'CA' } });
    fireEvent.change(screen.getByLabelText('Hired As'), { target: { value: 'employee' } });
    expect(screen.getByLabelText('Name').value).toBe('California Employee Hiring Packet');
    // The role is tucked away and off by default.
    expect(screen.getByLabelText('Only for this role').value).toBe('');
  });
});

