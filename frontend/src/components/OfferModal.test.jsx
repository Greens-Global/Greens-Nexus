import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Make An Offer on one screen (Hiring Setup, Oct 23): HR picks how they are
// hired (one pick - never guessed), and What They Get shows, live from the
// server, the offer letter, the packet that follows, the role's duties for
// that kind of hire and who signs. A missing piece is amber, Send stays off,
// and Set It Up opens the Hiring Setup over the offer. No Job Description pick.

const letter = { id: 's-offer', name: 'US Employee Offer Letter', documents: ['Offer Of Employment'], problems: [],
  prints: ['work_location'], printsPay: true,
  hrQuestions: [{ token: 'probation_period', label: 'Probation Period', type: 'text', required: true, pay: false, options: [] },
                { token: 'joining_bonus', label: 'Joining Bonus', type: 'text', required: false, pay: true, options: [] }] };
const packet = { id: 's-hire', name: 'California Employee Hiring Packet', documents: ['Employment Agreement'], problems: [], prints: [], hrQuestions: [] };
const line = (key, label, name, sourceLabel, tone = 'same', extra = {}) => ({ key, label, name, sourceLabel, tone, blocks: false, fix: null, ...extra });
// Greens Global CA: employee and contractor Accountants share the letter and packet but get different duties.
const gets = (p) => [
  line('offer', 'Offer Letter', 'US Employee Offer Letter', 'Same As All Companies - United States'),
  line('packet', 'Then The Hiring Packet', 'California Employee Hiring Packet', 'Starts by itself once Jane signs the offer'),
  p.hired_as === 'contractor' ? line('jd', 'Job Description', 'Accountant - Contractors Version', 'Only For Contractors', 'own')
    : line('jd', 'Job Description', 'Accountant - Standard', 'Same For Everyone'),
  line('signs', 'Signs', 'Offer: New Hire - Packet: New Hire, then Raj Patel', ''),
];
const head = { current: { email: 'ada@x.com', name: 'Ada Lee' } };
const standard = (cid, p) => Promise.resolve({
  offerFrom: { hr: { email: 'hana@x.com', name: 'Hana Lee' }, department_head: head.current, department: 'Accounting' },
  country: 'US', companyCountry: 'US', region: 'CA', choices: [{ id: 's-offer', name: 'US Employee Offer Letter', workerType: 'employee', country: 'US' }],
  offerLetter: p.hired_as ? letter : null, hiringPacket: p.hired_as ? packet : null,
  hiredAs: p.hired_as, whatTheyGet: p.hired_as ? gets(p) : [], blocked: '',
});
const offerOptions = vi.fn(standard);
const startOffer = vi.fn(() => Promise.resolve({ id: 'ev-offer', candidateId: 'c1', kind: 'offer', status: 'review' }));
const plainOptions = { roles: [{ id: 'jr-an', name: 'Accountant', department: 'Accounting', defaultManagerEmail: '' }], departments: ['Accounting'] };
const hiringOptions = vi.fn(() => Promise.resolve(plainOptions));
const people = { current: [] };
vi.mock('../api', () => ({ api: {
  offerOptions: (...a) => offerOptions(...a),
  startOffer: (...a) => startOffer(...a),
  hiringOptions: (...a) => hiringOptions(...a),
  getPackets: () => Promise.resolve({ settings: [{ id: 's-offer', docTemplateIds: ['@jd', 't-offer'] }] }),
  renderPacketPreview: (...a) => renderPacketPreview(...a),
} }));
const renderPacketPreview = vi.fn(() => Promise.resolve({ blob: new Blob(['%PDF']) }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: people.current }) }));
const packetsProps = vi.fn();
vi.mock('./HiringPacket', () => ({ PacketsModal: (props) => {
  packetsProps(props);
  return <div>Hiring Setup Open <button type="button" onClick={props.onClose}>Close Setup</button></div>;
} }));
const { default: OfferModal } = await import('./OfferModal');

const cand = { id: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@gmail.com', company: 'e-gg', roleId: 'jr-an', expectedStart: '2030-11-02' };
const hire = (name) => fireEvent.click(screen.getByRole('radio', { name }));
const sendBtn = () => screen.getByText('Send Offer Letter').closest('button');
const ready = () => waitFor(() => expect(sendBtn()).not.toBeDisabled());

beforeEach(() => { offerOptions.mockImplementation(standard); startOffer.mockClear(); });

describe('OfferModal', () => {
  it('Hired As is four pills, and what they get follows the pick', async () => {
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Full-Time Employee', 'Part-Time Employee', 'Contractor', 'Intern']);
    expect(screen.getByText(/Pick how they are hired/)).toBeTruthy();                 // nothing guessed
    expect(screen.queryByLabelText('Job Description')).toBeNull();                    // no JD dropdown
    hire('Full-Time Employee');
    await waitFor(() => expect(offerOptions).toHaveBeenLastCalledWith('c1', expect.objectContaining({ hired_as: 'full_time', worker_type: 'employee' })));
    expect(await screen.findByText('Accountant - Standard')).toBeTruthy();
    expect(screen.getByText('US Employee Offer Letter')).toBeTruthy();
    expect(screen.getByText('California Employee Hiring Packet')).toBeTruthy();
    hire('Contractor');
    await waitFor(() => expect(offerOptions).toHaveBeenLastCalledWith('c1', expect.objectContaining({ hired_as: 'contractor', worker_type: 'contractor' })));
    expect(await screen.findByText('Accountant - Contractors Version')).toBeTruthy();
    expect(screen.getByText('Only For Contractors')).toBeTruthy();
    expect(screen.getByText('US Employee Offer Letter')).toBeTruthy();                // same letter, different duties
    expect(screen.getByText('Fee')).toBeTruthy();
  });

  it('sends hired_as and never a job description id; pay never goes in merge', async () => {
    const onStarted = vi.fn();
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={onStarted} toastErr={() => {}} />);
    await ready();
    fireEvent.click(sendBtn());
    expect(screen.getByText('Choose how they are hired.')).toBeTruthy();
    hire('Part-Time Employee');
    await screen.findByText('Accountant - Standard');
    await ready();
    fireEvent.change(screen.getByLabelText('Primary Work Location'), { target: { value: 'Irvine, CA' } });   // the letter prints it
    fireEvent.change(screen.getByLabelText('Pay'), { target: { value: '85000' } });
    fireEvent.click(sendBtn());
    expect(screen.getByText('Answer Probation Period.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Probation Period *'), { target: { value: '90 days' } });
    fireEvent.change(screen.getByLabelText('Joining Bonus'), { target: { value: '$2,000' } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-offer' })));
    const [cid, body] = startOffer.mock.calls[0];
    expect(cid).toBe('c1');
    expect(body.inputs).toMatchObject({ hired_as: 'part_time', worker_type: 'employee', employment_type: 'part_time', country: 'US', region: 'CA',
      role_id: 'jr-an', work_location: 'Irvine, CA', merge: { probation_period: '90 days' } });
    expect(body.inputs).not.toHaveProperty('jd_template_id');
    expect(body.pay_values).toEqual({ joining_bonus: '$2,000' });
    expect(body.pay).toMatchObject({ base: 85000, payBasis: 'salary' });
  });

  it('an amber item blocks Send, and Set It Up opens the Hiring Setup over the offer, keeping the form', async () => {
    offerOptions.mockImplementation((cid, p) => standard(cid, p).then(o => (p.hired_as !== 'contractor' ? o : {
      ...o, offerLetter: null, hiringPacket: null, blocked: 'Fix the amber item before sending.',
      whatTheyGet: [line('offer', 'Offer Letter', 'Nothing Yet For Contractors In California', "A contractor can't be hired here yet", 'missing',
        { blocks: true, fix: { action: 'setUp', target: { entityId: 'e-gg', rowKey: 'contractor:US:CA', column: 'offer' } } }), ...gets(p).slice(1)],
    })));
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    hire('Contractor');
    expect(await screen.findByText('Nothing Yet For Contractors In California')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Fix the amber item before sending.')).toBeTruthy());
    expect(sendBtn()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Fee'), { target: { value: '6500' } });
    fireEvent.click(screen.getByText('Set It Up'));
    expect(await screen.findByText('Hiring Setup Open')).toBeTruthy();
    expect(packetsProps).toHaveBeenLastCalledWith(expect.objectContaining({ initialCompanyId: 'e-gg',
      focus: { entityId: 'e-gg', rowKey: 'contractor:US:CA', column: 'offer' } }));
    const calls = offerOptions.mock.calls.length;
    fireEvent.click(screen.getByText('Close Setup'));
    await waitFor(() => expect(offerOptions.mock.calls.length).toBeGreaterThan(calls));     // fetched again
    expect(screen.queryByText('Hiring Setup Open')).toBeNull();
    expect(screen.getByLabelText('Fee').value).toBe('6500');                              // the form kept its values
  });

  it('a role with no duties: Add Duties opens the role', async () => {
    offerOptions.mockImplementation((cid, p) => standard(cid, p).then(o => ({ ...o, blocked: 'Fix the amber item before sending.',
      whatTheyGet: p.hired_as ? [...gets(p).slice(0, 2), line('jd', 'Job Description', 'Accountant - no duties written', 'Add them before sending', 'missing',
        { blocks: true, fix: { action: 'addDuties', target: { entityId: 'e-gg', roleId: 'jr-an' } } })] : [] })));
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    hire('Full-Time Employee');
    fireEvent.click(await screen.findByText('Add Duties'));
    await screen.findByText('Hiring Setup Open');
    expect(packetsProps).toHaveBeenLastCalledWith(expect.objectContaining({ focus: { entityId: 'e-gg', roleId: 'jr-an' } }));
  });

  // Neil, Oct 22: Supervisor keeps its name with a Reports To tip; the offer
  // comes from the head of HR unless HR picks the department head.
  it('the offer comes from Head of HR or the department head, under More Options', async () => {
    render(<OfferModal candidate={cand} canSeePay={false} onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    hire('Full-Time Employee');
    await screen.findByText('Accountant - Standard');
    expect(screen.getByText(/Reports To - the person this hire reports to day to day/)).toBeTruthy();
    expect(screen.getByText('More Options')).toBeTruthy();
    const from = screen.getByLabelText('Offer Comes From');
    expect(from.value).toBe('hr');
    fireEvent.change(from, { target: { value: 'department_head' } });
    fireEvent.change(screen.getByLabelText('Probation Period *'), { target: { value: '90 days' } });
    await ready();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(startOffer).toHaveBeenCalled());
    expect(startOffer.mock.calls[0][1].inputs.offer_from).toBe('department_head');
  });

  it('hides pay from someone without Pay & Benefits', async () => {
    render(<OfferModal candidate={cand} canSeePay={false} onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    hire('Full-Time Employee');
    await screen.findByText('Accountant - Standard');
    expect(screen.queryByLabelText('Pay')).toBeNull();
    expect(screen.getByText('Pay is added by someone with Pay & Benefits access.')).toBeTruthy();
    expect(screen.getByLabelText('Joining Bonus').disabled).toBe(true);
  });

  it('Works In shows the place, and Change lets HR pick another state', async () => {
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('California, United States')).toBeTruthy());
    expect(screen.queryByLabelText('State')).toBeNull();
    fireEvent.click(screen.getByText('Change', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
    await waitFor(() => expect(offerOptions).toHaveBeenLastCalledWith('c1', expect.objectContaining({ region: 'TX' })));
  });
});

// Neil, Oct 22 (34:45): the supervisor default follows the role; HR's own pick stays.
describe('OfferModal - the supervisor follows the role', () => {
  const wired = {
    roles: [{ id: 'jr-an', name: 'Accountant', department: 'Accounting', defaultManagerEmail: 'amy@x.com' },
            { id: 'jr-ops', name: 'Coordinator', department: 'Operations', defaultManagerEmail: 'bo@x.com' }],
    departments: ['Accounting', 'Operations', 'Leasing'], departmentLeads: { ' leasing': ['dee@x.com'] },
  };
  const start = async () => {
    hiringOptions.mockResolvedValue(wired);
    people.current = [{ email: 'amy@x.com', name: 'Amy Fox' }, { email: 'bo@x.com', name: 'Bo Chen' },
                      { email: 'cy@x.com', name: 'Cy Park' }, { email: 'dee@x.com', name: 'Dee Wu' }];
    render(<OfferModal candidate={cand} canSeePay={false} onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText('Amy Fox')).toBeTruthy());
  };

  it('switching the role replaces the old role default supervisor', async () => {
    await start();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'jr-ops' } });
    expect(screen.getByText('Bo Chen')).toBeTruthy();
    expect(screen.queryByText('Amy Fox')).toBeNull();
  });

  it('keeps a supervisor HR picked by hand when the role changes', async () => {
    await start();
    fireEvent.click(screen.getAllByText('Change', { selector: 'button.secondary-btn' })[0]);
    fireEvent.change(screen.getByPlaceholderText('Type a name or email'), { target: { value: 'Cy' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Cy Park/ }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'jr-ops' } });
    expect(screen.getByText('Cy Park')).toBeTruthy();
  });

  it('a new role defaults to the department head', async () => {
    await start();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: '__other__' } });
    fireEvent.change(screen.getByLabelText('New Role Name'), { target: { value: 'Leasing Agent' } });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Leasing' } });
    expect(screen.getByText('Dee Wu')).toBeTruthy();
    people.current = [];
    hiringOptions.mockResolvedValue(plainOptions);
  });
  it('a missing line that does not block is not amber; a failed fetch says so; no first name reads What They Get', async () => {
    offerOptions.mockImplementation((cid, p) => standard(cid, p).then(o => ({ ...o,
      whatTheyGet: p.hired_as ? [...gets(p).slice(0, 2), line('jd', 'Job Description', 'Leasing Agent - no duties yet', 'The hiring packet prints them blank', 'missing')] : [] })));
    const { unmount } = render(<OfferModal candidate={{ ...cand, firstName: '' }} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    expect(screen.getByText('What They Get')).toBeTruthy();
    hire('Contractor');
    const jd = (await screen.findByText('Leasing Agent - no duties yet')).closest('[data-line]');
    expect(jd.style.background).not.toBe('rgb(255, 251, 235)');
    expect(screen.getByText('Send Offer Letter').closest('button').disabled).toBe(false);
    unmount();
    offerOptions.mockImplementation(() => Promise.reject(new Error('Could not reach Nexus.')));
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    hire('Contractor');
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach Nexus.');
  });
});

// Round 1 leftover (mockup screen 4): Preview Offer Letter prints the letter's document with a sample person.
describe('OfferModal - Preview Offer Letter', () => {
  it('renders the offer letter\'s document with a sample person, in the app', async () => {
    URL.createObjectURL = URL.createObjectURL || (() => 'blob:x');
    URL.revokeObjectURL = URL.revokeObjectURL || (() => {});
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    const btn = () => screen.getByText('Preview Offer Letter').closest('button');
    expect(btn()).toBeDisabled();                                   // no letter until Hired As is picked
    hire('Full-Time Employee');
    await waitFor(() => expect(btn()).not.toBeDisabled());
    fireEvent.click(btn());
    await waitFor(() => expect(renderPacketPreview).toHaveBeenCalledWith(expect.objectContaining({ template_id: 't-offer', entity_id: 'e-gg', setting_id: 's-offer' })));
    expect(await screen.findByText(/Preview With Sample Person/)).toBeTruthy();
  });

  it('a letter with no document (the PDF engine) cannot be previewed', async () => {
    offerOptions.mockImplementation((cid, p) => standard(cid, p).then(o => ({ ...o, offerLetter: o.offerLetter && { ...o.offerLetter, documents: [] } })));
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    hire('Full-Time Employee');
    await ready();
    expect(screen.getByText('Preview Offer Letter').closest('button')).toBeDisabled();
  });
});
