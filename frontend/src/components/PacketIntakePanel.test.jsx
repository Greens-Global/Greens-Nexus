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
  hrAtOffer: [{ token: 'probation_period', label: 'Probation Period', documents: ['NDA'] }],
  problems: [],
};

describe('PacketIntakePanel', () => {
  beforeEach(() => { preview.mockReset().mockResolvedValue(RESULT); });

  it('lists the always-asked details, the documents\u2019 questions, and HR\u2019s offer questions', async () => {
    render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[{ label: 'Nationality', type: 'text' }, { label: '' }]}
      companyName="Greens India"><div>EDITABLE EXTRAS</div></PacketIntakePanel>);
    await waitFor(() => expect(screen.getByTestId('asked-pan_number')).toBeTruthy());
    // what the browser sent: the editor's unsaved state, a label-less field left out
    expect(preview.mock.calls[0][0]).toMatchObject({ doc_template_ids: ['t1'], details_form: [{ label: 'Nationality' }] });
    expect(preview.mock.calls[0][0].details_form).toHaveLength(1);
    expect(screen.getByText('Always Asked')).toBeTruthy();
    expect(screen.getByText(/Legal First Name \*/)).toBeTruthy();
    const pan = screen.getByTestId('asked-pan_number');
    expect(pan.textContent).toContain('Private');
    expect(pan.textContent).toContain('NDA, Offer Letter');
    expect(screen.queryByTestId('asked-nationality')).toBeNull();           // packet-only: under Also Ask
    expect(screen.getByText('Also Ask (Saved To Their Record, Not Printed In A Document)')).toBeTruthy();
    expect(screen.getByText('EDITABLE EXTRAS')).toBeTruthy();
    expect(screen.getByText('Filled At The Offer By HR')).toBeTruthy();
    expect(screen.getByText('Probation Period')).toBeTruthy();
  });

  it('Preview Intake Form shows the real intake page, inert', async () => {
    render(<PacketIntakePanel docIds={['t1']} extraDocs={[]} detailsForm={[]} companyName="Greens India" />);
    await waitFor(() => expect(screen.getByTestId('asked-pan_number')).toBeTruthy());
    fireEvent.click(screen.getByText('Preview Intake Form'));
    const dialog = screen.getByRole('dialog', { name: 'Intake form preview' });
    expect(dialog.textContent).toContain('Your Onboarding Details');
    expect(dialog.textContent).toContain('For Your Documents');
    expect(dialog.querySelector('#f-first_name')).toBeTruthy();
    expect(dialog.querySelector('form').hasAttribute('inert')).toBe(true);
    expect(screen.getByText(/Preview Only - Nothing Is Sent/)).toBeTruthy();
  });

  it('a field that would not save says why', async () => {
    preview.mockRejectedValue(new Error('"Phone" would be {{phone}}, which Nexus already fills'));
    render(<PacketIntakePanel docIds={[]} extraDocs={[]} detailsForm={[{ label: 'Phone' }]} />);
    await waitFor(() => expect(screen.getByText(/which Nexus already fills/)).toBeTruthy());
  });
});
