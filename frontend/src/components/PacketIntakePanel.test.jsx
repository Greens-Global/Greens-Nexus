import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// What The New Hire Will Be Asked: the hire's whole form for a packet, from
// the server's own list - always-asked details, the documents' questions with
// the documents that print them, the packet's extras (editable, as children),
// and HR's offer questions. Preview Intake Form renders the real intake page.

const preview = vi.fn();
vi.mock('../api', () => ({ api: { packetIntakePreview: (...a) => preview(...a) } }));
const PacketIntakePanel = (await import('./PacketIntakePanel')).default;

const STANDARD = ['first_name', 'last_name', 'preferred_name', 'phone', 'address', 'permanent_address',
  'emergency_name', 'emergency_relationship', 'emergency_phone']
  .map(key => ({ key, required: ['first_name', 'last_name', 'phone', 'address'].includes(key) }));
const RESULT = {
  standard: STANDARD,
  form: [
    { key: 'nationality', label: 'Nationality', type: 'text', required: true, documents: [], packetOnly: true },
    { key: 'pan_number', label: 'PAN Number', type: 'text', required: true, sensitive: true, documents: ['NDA', 'Offer Letter'], packetOnly: false },
  ],
  // A hiring packet asks HR only for pay at the offer (Nov 3 2026).
  hrAtOffer: [{ token: 'joining_bonus', label: 'Joining Bonus', pay: true, documents: ['NDA'] }],
  // Every variable the documents print and who fills it (Pranshu, 11/03/2026).
  fields: [
    { token: 'address', label: 'Address', documents: ['NDA'], fill: 'standard', editable: false },
    { token: 'pan_number', label: 'PAN Number', documents: ['NDA', 'Offer Letter'], fill: 'person', required: true, sensitive: true, editable: true },
    { token: 'probation_period', label: 'Probation Period', documents: ['NDA'], fill: 'signing', editable: true },
    { token: 'client_name', label: 'Client Name', documents: ['NDA'], fill: 'signing', editable: true },
  ],
  problems: [],
};

describe('PacketIntakePanel', () => {
  beforeEach(() => { preview.mockReset().mockResolvedValue(RESULT); });

  it('lists the always-asked details, the documents\u2019 questions, and HR\u2019s offer questions', async () => {
    render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[{ label: 'Nationality', type: 'text' }, { label: '' }]}
      companyName="Greens India"><div>EDITABLE EXTRAS</div></PacketIntakePanel>);
    await waitFor(() => expect(screen.getByTestId('field-pan_number')).toBeTruthy());
    // what the browser sent: the editor's unsaved state, a label-less field left out
    expect(preview.mock.calls[0][0]).toMatchObject({ doc_template_ids: ['t1'], details_form: [{ label: 'Nationality' }] });
    expect(preview.mock.calls[0][0].details_form).toHaveLength(1);
    expect(screen.getByText('Always Asked')).toBeTruthy();
    expect(screen.getByText(/Legal First Name \*/)).toBeTruthy();
    const pan = screen.getByTestId('field-pan_number');
    expect(screen.getByLabelText('PAN Number: Intake Form').checked).toBe(true);          // ticked = on the intake form
    expect(screen.getByLabelText('PAN Number: Required').checked).toBe(true);
    expect(screen.getByLabelText('PAN Number: Private').checked).toBe(true);
    expect(screen.getByLabelText('Probation Period: Intake Form').checked).toBe(false);   // not ticked = filled while signing
    expect(screen.getByTestId('field-probation_period').textContent).toContain('They fill it in the document while signing.')
    expect(pan.textContent).toContain('NDA, Offer Letter');
    expect(screen.getByTestId('field-address').textContent).toContain('The New Hire - Always Asked');   // locked
    expect(screen.queryByTestId('field-nationality')).toBeNull();          // packet-only: under Also Ask
    expect(screen.getByTestId('intake-summary').textContent).toMatch(
      /answers 11 questions on the intake form \(1 private\) and fills 2 in the documents while signing\. HR enters 1 pay field at the offer\./);
    expect(screen.getByText('Also Ask (Saved To Their Record, Not Printed In A Document)')).toBeTruthy();
    expect(screen.getByText('EDITABLE EXTRAS')).toBeTruthy();
    expect(screen.getByText('Pay, Entered At The Offer By HR')).toBeTruthy();
    expect(screen.queryByText(/HR At The Offer'?$/)).toBeNull();
  });

  it('Preview Intake Form shows the real intake page, inert', async () => {
    render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[]} companyName="Greens India" />);
    await waitFor(() => expect(screen.getByTestId('field-pan_number')).toBeTruthy());
    fireEvent.click(screen.getByText('Preview Intake Form'));
    const dialog = screen.getByRole('dialog', { name: 'Intake form preview' });
    expect(dialog.textContent).toContain('Your Onboarding Details');
    expect(dialog.textContent).toContain('For Your Documents');
    expect(dialog.querySelector('#f-first_name')).toBeTruthy();
    expect(dialog.querySelector('form').hasAttribute('inert')).toBe(true);
    expect(screen.getByText(/Preview Only - Nothing Is Sent/)).toBeTruthy();
  });

  it('lists what each role’s own documents add, and says so when no role has any', async () => {
    preview.mockResolvedValue({ ...RESULT, roles: [{ id: 'r1', name: 'Construction Associate', documents: ['Construction NDA'], replaces: ['NDA'], asks: ['Safety Card Number'] }] });
    const { unmount } = render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[]} companyId="co-ca" roleIds={[]} companyName="Oversite" />);
    await waitFor(() => expect(screen.getByTestId('role-r1')).toBeTruthy());
    expect(preview.mock.calls[0][0]).toMatchObject({ entity_id: 'co-ca', role_ids: [] });
    const r = screen.getByTestId('role-r1').textContent;
    expect(r).toContain('Construction NDA');
    expect(r).toContain('Replaces NDA');
    expect(r).toContain('Also asks: Safety Card Number');
    unmount();
    preview.mockResolvedValue({ ...RESULT, roles: [] });
    render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[]} companyId="co-ca" companyName="Oversite" />);
    await waitFor(() => expect(screen.getByText(/None of Oversite's roles has hiring documents/)).toBeTruthy());
  });

  it('the Intake Form tick decides intake or while signing, and the preview is asked again with the choice', async () => {
    const onFieldSources = vi.fn();
    const { rerender } = render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[]} fieldSources={{}} onFieldSources={onFieldSources} />);
    await waitFor(() => expect(screen.getByTestId('field-client_name')).toBeTruthy());
    expect(screen.queryByRole('combobox')).toBeNull();                                   // no "who fills" dropdown any more
    fireEvent.click(screen.getByLabelText('PAN Number: Intake Form'));                   // untick: they type it while signing
    expect(onFieldSources).toHaveBeenLastCalledWith({ pan_number: { source: 'signing', value: undefined, required: true, sensitive: true } });
    fireEvent.click(screen.getByLabelText('Client Name: Intake Form'));                  // tick: on the intake form
    expect(onFieldSources).toHaveBeenLastCalledWith({ client_name: expect.objectContaining({ source: 'person' }) });
    fireEvent.click(screen.getByLabelText('Client Name: Same For Everyone'));
    expect(onFieldSources).toHaveBeenLastCalledWith({ client_name: expect.objectContaining({ source: 'same' }) });
    const choice = { client_name: { source: 'same', value: '' } };
    rerender(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[]} fieldSources={choice} onFieldSources={onFieldSources} />);
    fireEvent.change(screen.getByLabelText('Client Name for everyone'), { target: { value: 'Acme' } });
    expect(onFieldSources).toHaveBeenLastCalledWith({ client_name: { source: 'same', value: 'Acme' } });
    await waitFor(() => expect(preview.mock.calls.at(-1)[0].field_sources).toEqual(choice));
  });

  it('a field that would not save says why', async () => {
    preview.mockRejectedValue(new Error('"Phone" would be {{phone}}, which Nexus already fills'));
    render(<PacketIntakePanel docIds={[]} extraDocs={[]} detailsForm={[{ label: 'Phone' }]} />);
    await waitFor(() => expect(screen.getByText(/which Nexus already fills/)).toBeTruthy());
  });
});
