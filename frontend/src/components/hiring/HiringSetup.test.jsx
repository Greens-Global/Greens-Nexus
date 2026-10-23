import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Set Up Hiring (Oct 23): Screen 1 (the company list), Screen 2 (one company's
// grid), Popup A (Use The Same / Make A Different One) and Popup B (a role's
// Job Description versions). The API is mocked to the build contract.

const cell = (o) => ({ name: 'US Employee Offer Letter', sourceLabel: 'Same As All Companies - United States', tone: 'same', settingId: 's-us-offer',
  engine: 'documents', archivedOwnId: '', fallback: { settingId: 's-us-offer', name: 'US Employee Offer Letter', sourceLabel: 'Same As All Companies - United States', usedByText: 'used by 3 companies' },
  documents: [{ id: 't-offer', name: 'US Employee Offer Letter', marker: false, signedBy: 'The New Hire' }], ...o });
const missing = { name: 'Nothing Yet - Choose One', sourceLabel: 'A contractor hire here would be blocked', tone: 'missing', settingId: '', engine: '', archivedOwnId: '', fallback: null, documents: [] };
const jd = (o) => ({ name: "Each Role's Duties", sourceLabel: '7 Of 8 Roles Ready', tone: 'same', placementLabel: 'Its Own Page, After Employment Agreement', versionId: '', roleId: '', ...o });
const row = (wt, country, region, kind, o = {}) => ({ key: `${wt}:${country}:${region}`, kind, sub: wt === 'employee' ? 'Full-time and part-time' : 'Independent contractors',
  workerType: wt, country, region, home: true, removable: false, notHired: false, offer: cell(), packet: cell({ name: 'California Employee Hiring Packet', settingId: 's-ca-hire' }), jd: jd(), ...o });

function ggView(over = {}) {
  return {
    entity: { id: 'e-gg', name: 'Greens Global', shared: false, canEdit: true, country: 'US', region: 'CA' },
    status: 'left', chip: '2 Things Left',
    items: [
      { key: 'missing:contractor:US:CA', text: 'No offer letter or hiring packet for Contractors In California yet.', button: 'Set It Up', action: 'setUp', target: { rowKey: 'contractor:US:CA', column: 'offer' } },
      { key: 'duties:jr-admin', text: 'Admin Associate has no duties written, and the hiring packet prints them.', button: 'Add Duties', action: 'addDuties', target: { roleId: 'jr-admin' } },
      { key: 'check:s1:pay', text: 'Kim Lee checks hiring documents but can\'t see pay.', button: 'Give Pay & Benefits Access', action: 'navigate', target: { view: 'admin-console', sub: 'access' } },
      { key: 'check:s1:once', text: 'Raj has not signed once.', button: 'Open The Packet', action: 'advanced', target: { settingId: 's1' } },
      { key: 'check:s1:hr', text: 'Nobody handles hiring.', button: 'Pick Who Handles Hiring', action: 'editAbout', target: { field: 'handlesHiring' } },
    ],
    about: [
      { key: 'worksIn', label: 'Works In', value: 'California, United States', hint: 'From the company address.', empty: false, country: 'US', region: 'CA' },
      { key: 'handlesHiring', label: 'Handles Hiring', value: 'Kim Lee (HR Head)', hint: 'Checks documents before they go out.', empty: false, email: 'kim@x.com' },
    ],
    roles: [{ id: 'jr-acct', name: 'Accountant', department: 'Accounting', shared: true }, { id: 'jr-admin', name: 'Admin Associate', department: 'Admin', shared: false }],
    rows: [
      row('employee', 'US', 'CA', 'Employees In California'),
      row('contractor', 'US', 'CA', 'Contractors In California', { offer: missing, packet: missing }),
    ],
    jobDescriptions: {
      columns: [{ key: 'employee:US:CA', label: 'Employees In California' }, { key: 'contractor:US:CA', label: 'Contractors In California' }],
      rows: [{ roleId: 'jr-acct', name: 'Accountant', shared: true, cells: {
        'employee:US:CA': { label: 'Standard', tone: 'same', versionId: '' }, 'contractor:US:CA': { label: 'Own Version', tone: 'own', versionId: 'dv-1' } } }],
    },
    advanced: [{ label: 'Signing Order', value: 'The New Hire, then Raj Patel' }],
    uploadContext: { entityId: 'e-gg', companyName: 'Greens Global', roleNames: ['Accountant'] },
    ...over,
  };
}
const indiaView = () => ggView({
  entity: { id: 'e-in', name: 'GGCon India', shared: false, canEdit: true, country: 'IN', region: '' }, items: [], about: [],
  rows: [
    row('employee', 'IN', '', 'Employees In India', { offer: cell({ name: 'India Employee Offer', settingId: 's-in-emp', sourceLabel: 'Same As All Companies - India' }) }),
    row('contractor', 'IN', '', 'Contractors In India', { offer: cell({ name: 'India Contractor Offer', settingId: 's-in-con', sourceLabel: 'Same As All Companies - India' }) }),
  ],
});

let companyView = ggView();
const duties = {
  role: { id: 'jr-acct', name: 'Accountant', department: 'Accounting', shared: true, companyId: '' },
  versions: [
    { id: 'standard', label: 'Standard - Everyone', who: 'Employees and contractors, every place', hiredAs: '', text: 'Keep the books.', usedBy: ['Employees In California'] },
    { id: 'dv-1', label: 'Contractors - Anywhere', who: 'Only contractors', hiredAs: 'contractor', text: 'Deliver the close.', usedBy: ['Contractors In California'] },
  ],
  formattedJd: null,
  hiringDocs: [{ templateId: 't-cc', name: 'Construction Confidentiality', replaces: 't-std', replacesName: 'Standard Confidentiality' }],
};
const m = {
  getHiringSetup: vi.fn(() => Promise.resolve({
    shared: { summary: 'What every company uses unless it has its own: 2 offer letters, 3 hiring packets, duties for 8 roles.', canEdit: true },
    companies: [
      { id: 'e-gg', name: 'Greens Global', place: 'California', status: 'left', chip: '2 Things Left', summary: 'Uses the shared offer letter and hiring packet - no contractor documents yet',
        sections: [{ key: 'hiring', label: 'Hiring', status: 'left', chip: '2 Things Left' }, { key: 'promotion', label: 'Promotion', status: 'ready', chip: 'Ready To Promote' },
          { key: 'offboarding', label: 'Offboarding', status: 'left', chip: '1 Thing Left' }] },
      { id: 'e-new', name: 'New Company LLC', place: 'No place set', status: 'notStarted', chip: 'Not Started', summary: 'Pick where its people work and it starts with the shared documents',
        sections: ['hiring', 'promotion', 'offboarding'].map(k => ({ key: k, label: k[0].toUpperCase() + k.slice(1), status: 'notStarted', chip: 'Not Started' })) },
    ] })),
  getHiringSetupCompany: vi.fn(() => Promise.resolve(companyView)),
  hiringSetupUseSame: vi.fn(() => Promise.resolve({ ok: true })),
  hiringSetupRestore: vi.fn(() => Promise.resolve({})),
  hiringSetupMakeOwn: vi.fn(() => Promise.resolve({ settings: [], settingIds: ['s-new'] })),
  hiringSetupSetDocuments: vi.fn(() => Promise.resolve({})),
  hiringSetupOwnCopy: vi.fn(() => Promise.resolve({ templateId: 't-agree-gg', name: 'Employment Agreement - Greens Global', copied: true })),
  hiringSetupPlace: vi.fn(() => Promise.resolve({ places: [] })),
  setPacketHired: vi.fn(() => Promise.resolve({ notHired: ['contractor'] })),
  getRoleDuties: vi.fn(() => Promise.resolve(duties)),
  addRoleDuty: vi.fn(() => Promise.resolve({ ...duties, versions: [...duties.versions, { id: 'dv-2', label: 'Part-Time Employees - Anywhere', who: 'Only part-time employees', text: 'Keep the books.', usedBy: [] }], versionId: 'dv-2' })),
  updateRoleDuty: vi.fn((r, v, text) => Promise.resolve({ id: v, text })),
  removeRoleDuty: vi.fn(() => Promise.resolve({ ...duties, versions: [duties.versions[0]] })),
  setRoleHiringDocs: vi.fn(() => Promise.resolve({ hiringDocs: [] })),
  updateEntity: vi.fn(() => Promise.resolve({})),
  getPackets: vi.fn(() => Promise.resolve({ settings: [{ entityId: '', place: 'Employees in CA, US', docTemplateIds: ['t-agree'] }],
    docTemplates: [{ id: 't-agree', name: 'Employment Agreement', category: 'hr' }, { id: 't-jd', name: 'JD - Accountant', category: 'job_description' }] })),
  getEntities: vi.fn(() => Promise.resolve([{ id: 'e-gg', name: 'Greens Global' }])),
};
vi.mock('../../api', () => ({ api: new Proxy({}, { get: (_, k) => m[k] }) }));
vi.mock('../../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'kim@x.com', name: 'Kim Lee', title: 'HR Head' }] }) }));
const confirm = vi.fn(() => Promise.resolve(true));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));
// The Word upload belongs to the offer branch; its contract is onCreated({templateId, jdPlacement, ...}).
vi.mock('../WordTemplateWizard', () => ({
  default: (p) => <button type="button" onClick={() => p.onCreated({ templateId: 't-new', name: 'Contractor Packet', jdPlacement: 'page', signerKeys: ['employee'] })}>Mock Wizard {p.purpose}</button>,
}));

const { default: HiringSetup } = await import('./HiringSetup');
const { default: HiringSetupCompany } = await import('./HiringSetupCompany');
const { default: RoleDutiesModal } = await import('./RoleDutiesModal');
const noop = () => {};
const company = (props = {}) => render(<HiringSetupCompany entityId="e-gg" onBack={noop} onAdvanced={noop} toastOk={noop} toastErr={noop} {...props} />);

beforeEach(() => {
  Object.values(m).forEach(f => f.mockClear()); confirm.mockClear(); companyView = ggView();
  m.getHiringSetupCompany.mockImplementation(() => Promise.resolve(companyView));
});

describe('Screen 1: Hiring Setup', () => {
  it('lists All Companies and each company, opens one, and links to Advanced', async () => {
    const onAdvanced = vi.fn();
    render(<HiringSetup toastOk={noop} toastErr={noop} onAdvanced={onAdvanced} />);
    expect(await screen.findByText('All Companies (Shared)')).toBeTruthy();
    expect(screen.getByText(/2 offer letters, 3 hiring packets/)).toBeTruthy();
    expect(screen.getByText('2 Things Left')).toBeTruthy();
    expect(screen.getByText('Ready To Promote')).toBeTruthy();
    expect(screen.getByText('1 Thing Left')).toBeTruthy();
    expect(screen.getAllByText('Not Started')).toHaveLength(3);               // a chip per section
    fireEvent.click(screen.getByText('Advanced: All Packets And Signing Orders'));
    expect(onAdvanced).toHaveBeenCalled();
    expect(screen.queryByText('Set Up Hiring')).toBeNull();                   // the page covers all three sections
    fireEvent.click(screen.getByLabelText('Set Up - Greens Global'));
    expect(await screen.findByText('Set Up Hiring - Greens Global')).toBeTruthy();
    expect(m.getHiringSetupCompany).toHaveBeenCalledWith('e-gg', '', 'hiring');
    fireEvent.click(screen.getByText('< Hiring Setup'));
    expect(await screen.findByText('All Companies (Shared)')).toBeTruthy();
  });

  it('a focus from the offer opens the company and its popup, once', async () => {
    const onFocusUsed = vi.fn();
    render(<HiringSetup toastOk={noop} toastErr={noop} onAdvanced={noop} onFocusUsed={onFocusUsed} focus={{ entityId: 'e-gg', rowKey: 'contractor:US:CA', column: 'packet' }} />);
    expect(await screen.findByText('Hiring Packet - Contractors In California')).toBeTruthy();
    expect(onFocusUsed).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('< Hiring Setup'));
    fireEvent.click(await screen.findByLabelText('Set Up - Greens Global'));
    expect(await screen.findByText('Set Up Hiring - Greens Global')).toBeTruthy();
    expect(screen.queryByText('Hiring Packet - Contractors In California')).toBeNull();   // not popped again
  });
});

describe('Screen 2: Set Up Hiring', () => {
  it('Things To Finish runs each fix', async () => {
    const onAdvanced = vi.fn();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    company({ onAdvanced });
    fireEvent.click(await screen.findByText('Give Pay & Benefits Access'));
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'admin-console', sub: 'access' });
    window.removeEventListener('nexus:navigate', nav);
    fireEvent.click(screen.getByText('Open The Packet'));
    expect(onAdvanced).toHaveBeenCalledWith('s1');
    fireEvent.click(screen.getByText('Pick Who Handles Hiring'));
    expect(screen.getByText('Save')).toBeTruthy();                       // the About editor opened
    fireEvent.click(screen.getByText('Add Duties'));
    await waitFor(() => expect(m.getRoleDuties).toHaveBeenCalledWith('jr-admin', 'e-gg'));
  });

  it('Set It Up opens Popup A for the row', async () => {
    company();
    fireEvent.click(await screen.findByText('Set It Up'));
    expect(await screen.findByText('Offer Letter - Contractors In California')).toBeTruthy();
    expect(screen.getByText('Nothing shared for Contractors In California yet')).toBeTruthy();
  });

  it('an empty list says everything is set', async () => {
    companyView = ggView({ items: [], status: 'ready', chip: 'Ready To Hire' });
    company();
    expect(await screen.findByText('Everything is set. You can make an offer.')).toBeTruthy();
    expect(screen.getByText('Ready To Hire')).toBeTruthy();
  });

  it('a company with no place asks for Works In, not "Everything is set"', async () => {
    companyView = ggView({ items: [], status: 'notStarted', chip: 'Not Started', rows: [],
      about: [{ key: 'worksIn', label: 'Works In', value: '', hint: 'From the company address.', empty: true, country: '', region: '' }] });
    company();
    expect(await screen.findByText("Pick where this company's people work to start.")).toBeTruthy();
    expect(screen.queryByText('Everything is set. You can make an offer.')).toBeNull();
    expect(screen.queryByText('Make An Offer')).toBeNull();
    expect(screen.queryByText('What Each Hire Gets')).toBeNull();
    fireEvent.click(screen.getByText('Pick Where They Work'));
    expect(screen.getByText('Save')).toBeTruthy();                           // the Works In editor opened
  });

  it('Legal Name And Address waits for a value before it saves', async () => {
    companyView = ggView({ about: [{ key: 'legalAndAddress', label: 'Legal Name And Address', value: '', hint: 'Printed in the documents.', empty: true }] });
    company();
    fireEvent.click(await screen.findByLabelText('Edit Legal Name And Address'));
    expect(screen.getByText('Save').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '123 Main St' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(m.updateEntity).toHaveBeenCalledWith('e-gg', { physical_address: '123 Main St' }));
  });

  it('Legal Name And Address starts from what is on file', async () => {
    companyView = ggView({ about: [{ key: 'legalAndAddress', label: 'Legal Name And Address', value: 'Greens Global, LLC', hint: 'Printed in the documents.', empty: true,
      legalName: 'Greens Global, LLC', address: '' }] });
    company();
    fireEvent.click(await screen.findByLabelText('Edit Legal Name And Address'));
    expect(screen.getByLabelText('Legal Name').value).toBe('Greens Global, LLC');
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '1 Market St, San Francisco, CA 94105' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(m.updateEntity).toHaveBeenCalledWith('e-gg', { legal_name: 'Greens Global, LLC', physical_address: '1 Market St, San Francisco, CA 94105' }));
  });

  it('All Companies for HR without every company is read-only', async () => {
    companyView = ggView({ entity: { id: '', name: 'All Companies', shared: true, canEdit: false, country: '', region: '' }, about: [],
      rows: [row('employee', 'US', 'CA', 'Employees In California', { removable: true })] });
    company({ entityId: '' });
    expect(await screen.findByText(/Only HR with access to every company can change the shared documents/)).toBeTruthy();
    expect(screen.queryByText('+ Add A Place')).toBeNull();
    expect(screen.queryByLabelText('More for Employees In California')).toBeNull();
    fireEvent.click(screen.getByText('US Employee Offer Letter'));
    expect(await screen.findByText('Offer Letter - Employees In California')).toBeTruthy();
    expect(screen.queryByText('Use This')).toBeNull();
    expect(screen.queryByText('Start From A Copy')).toBeNull();
  });

  it('grid tones follow the server, and Show For Role refetches', async () => {
    company();
    expect(await screen.findAllByText('Nothing Yet - Choose One')).toHaveLength(2);
    expect(screen.getAllByText('Same As All Companies - United States').length).toBeGreaterThan(0);
    m.getHiringSetupCompany.mockImplementationOnce(() => Promise.resolve(ggView({ rows: [
      row('employee', 'US', 'CA', 'Employees In California', { jd: jd({ name: 'Accountant - Standard', sourceLabel: 'Same For Everyone', roleId: 'jr-acct' }) }),
      row('contractor', 'US', 'CA', 'Contractors In California', { jd: jd({ name: 'Accountant - Contractors Version', sourceLabel: 'Only For Contractors', tone: 'own', roleId: 'jr-acct' }) }),
    ] })));
    fireEvent.click(screen.getByRole('button', { name: 'Accountant' }));
    expect(await screen.findByText('Accountant - Contractors Version')).toBeTruthy();
    expect(screen.getByText('Accountant - Standard')).toBeTruthy();
    expect(m.getHiringSetupCompany).toHaveBeenLastCalledWith('e-gg', 'jr-acct', 'hiring');
  });

  it('GGCon India: two independent rows; making the contractor one own sends only its key', async () => {
    companyView = indiaView();
    company({ entityId: 'e-in' });
    fireEvent.click(await screen.findByText('India Contractor Offer'));
    expect(await screen.findByText('Offer Letter - Contractors In India')).toBeTruthy();
    fireEvent.click(screen.getByText(/Make A Different One For GGCon India/));
    fireEvent.click(screen.getByText('Start From A Copy'));
    await waitFor(() => expect(m.hiringSetupMakeOwn).toHaveBeenCalledWith({ entity_id: 'e-in', event: 'offer', worker_type: 'contractor', country: 'IN', region: '', start: 'copy', doc_template_ids: [], also: [] }));
    expect(screen.getByText('India Employee Offer')).toBeTruthy();       // the employee row is untouched
  });
});

describe('Popup A: Choose What They Get', () => {
  it('Use The Same on an own cell confirms, and a 409 shows inline', async () => {
    companyView = ggView({ rows: [row('employee', 'US', 'CA', 'Employees In California', {
      offer: cell({ name: 'GG Offer', sourceLabel: 'Only Here', tone: 'own', settingId: 's-gg-offer' }),
      packet: cell({ name: 'GG Packet', sourceLabel: 'Only Here', tone: 'own', settingId: 's-gg-offer' }) })] });
    company();
    fireEvent.click(await screen.findByText('GG Offer'));
    fireEvent.click(screen.getByText('Use The Same As All Companies'));
    expect(screen.getByText(/This also changes: Employees In California - Hiring Packet/)).toBeTruthy();
    m.hiringSetupUseSame.mockImplementationOnce(() => Promise.reject(new Error('1 hire is using this one right now. Try again once they finish.')));
    fireEvent.click(screen.getByText('Use This'));
    expect(await screen.findByText('1 hire is using this one right now. Try again once they finish.')).toBeTruthy();
    expect(confirm.mock.calls[0][0]).toMatch(/Greens Global's own offer letter will stop being used/);
    expect(m.hiringSetupUseSame).toHaveBeenCalledWith('s-gg-offer');
  });

  it('under Show For Role a role-only row is shown, never archived', async () => {
    companyView = ggView({ rows: [row('employee', 'US', 'CA', 'Employees In California', {
      packet: cell({ name: 'Accountant Packet', sourceLabel: 'Only For Accountant', tone: 'own', settingId: 's-acct' }), jd: jd({ roleId: 'jr-acct' }) })] });
    company();
    fireEvent.click(await screen.findByText('Accountant Packet'));
    expect(await screen.findByText(/Showing what one role gets/)).toBeTruthy();
    expect(screen.queryByText('Use The Same As All Companies')).toBeNull();
    expect(screen.queryByText('Use This')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByText('US Employee Offer Letter')).toBeTruthy();   // the documents, read-only
    expect(m.hiringSetupUseSame).not.toHaveBeenCalled();
  });

  it('Use The Same with nothing shared warns that hires will be blocked', async () => {
    companyView = ggView({ rows: [row('contractor', 'IN', '', 'Contractors In India', {
      offer: cell({ name: 'GG Con Offer', sourceLabel: 'Only Here', tone: 'own', settingId: 's-own', fallback: null }) })] });
    company();
    fireEvent.click(await screen.findByText('GG Con Offer'));
    fireEvent.click(screen.getByText('Use The Same As All Companies'));
    fireEvent.click(screen.getByText('Use This'));
    await waitFor(() => expect(confirm.mock.calls[0][0]).toMatch(/Nothing is shared for Contractors In India - a hire here would be blocked/));
  });

  it('Start From A Copy is offered only when there is a shared one to copy', async () => {
    companyView = ggView({ rows: [row('employee', 'US', 'CA', 'Employees In California', {
      packet: cell({ name: 'Old PDF Packet', sourceLabel: 'Only Here', tone: 'own', settingId: 's-pdf', engine: 'pdf' }) })] });
    company();
    fireEvent.click(await screen.findByText('Old PDF Packet'));
    expect(await screen.findByText('Upload A Word File')).toBeTruthy();
    expect(screen.queryByText('Start From A Copy')).toBeNull();
  });

  it("Use Greens Global's Own Again restores the archived row", async () => {
    companyView = ggView({ rows: [row('employee', 'US', 'CA', 'Employees In California', { offer: cell({ archivedOwnId: 's-old' }) })] });
    company();
    fireEvent.click(await screen.findByText('US Employee Offer Letter'));
    fireEvent.click(await screen.findByText("Use Greens Global's Own Again"));
    await waitFor(() => expect(m.hiringSetupRestore).toHaveBeenCalledWith('s-old'));
  });

  it('Also Use It For is sent, and an upload makes the row own with the job description page after it', async () => {
    company();
    fireEvent.click((await screen.findAllByText('Nothing Yet - Choose One'))[1]);    // contractor packet
    expect(await screen.findByText('Hiring Packet - Contractors In California')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Employees In California'));
    fireEvent.click(screen.getByText('Upload A Word File'));
    fireEvent.click(await screen.findByText('Mock Wizard hire'));
    await waitFor(() => expect(m.hiringSetupMakeOwn).toHaveBeenCalledWith({ entity_id: 'e-gg', event: 'hire', worker_type: 'contractor', country: 'US', region: 'CA',
      start: 'templates', doc_template_ids: ['t-new', '@jd'], also: [{ worker_type: 'employee', country: 'US', region: 'CA' }] }));
  });

  it('Pick One You Already Have lists templates with where they are used', async () => {
    company();
    fireEvent.click((await screen.findAllByText('Nothing Yet - Choose One'))[0]);
    fireEvent.click(screen.getByText('Pick One You Already Have'));
    expect(await screen.findByText('Used By: All Companies - Employees in CA, US')).toBeTruthy();
    expect(screen.queryByText('JD - Accountant')).toBeNull();                   // job descriptions are not letters
    fireEvent.click(screen.getByText('Employment Agreement'));
    await waitFor(() => expect(m.hiringSetupMakeOwn.mock.calls[0][0]).toMatchObject({ start: 'templates', doc_template_ids: ['t-agree'] }));
  });
});

describe('Packet documents', () => {
  const ownPacket = (o) => ggView({ rows: [row('employee', 'US', 'CA', 'Employees In California', { packet: cell({ name: 'GG Packet', sourceLabel: 'Only Here', tone: 'own', settingId: 's-gg-hire', ...o }) })] });

  it('the job description page dragged between two documents saves that order', async () => {
    companyView = ownPacket({ placement: 'page', documents: [
      { id: 'A', name: 'Employment Agreement', marker: false, signedBy: 'The New Hire, then Raj Patel' },
      { id: 'B', name: 'I-9 Acknowledgment', marker: false, signedBy: 'The New Hire' },
      { id: '@jd', name: 'Job Description - Goes Here', marker: true, signedBy: '' }] });
    company();
    fireEvent.click(await screen.findByText('GG Packet'));
    const rows = await screen.findAllByTestId('doc-row');
    expect(screen.getByText('Signed By: The New Hire, then Raj Patel')).toBeTruthy();
    fireEvent.dragStart(rows[2]);
    fireEvent.drop(rows[1]);
    await waitFor(() => expect(m.hiringSetupSetDocuments).toHaveBeenCalledWith('s-gg-hire', ['A', '@jd', 'B']));
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('a document dragged down lands after the target; a drop that changes nothing saves nothing', async () => {
    companyView = ownPacket({ placement: 'page', documents: [
      { id: 'A', name: 'Employment Agreement', marker: false, signedBy: '' },
      { id: 'B', name: 'I-9 Acknowledgment', marker: false, signedBy: '' },
      { id: '@jd', name: 'Job Description - Goes Here', marker: true, signedBy: '' }] });
    company();
    fireEvent.click(await screen.findByText('GG Packet'));
    const rows = await screen.findAllByTestId('doc-row');
    fireEvent.dragStart(rows[0]);
    fireEvent.drop(rows[2]);
    await waitFor(() => expect(m.hiringSetupSetDocuments).toHaveBeenCalledWith('s-gg-hire', ['B', '@jd', 'A']));
    m.hiringSetupSetDocuments.mockClear();
    fireEvent.dragStart(rows[0]);
    fireEvent.drop(rows[1]);
    await waitFor(() => expect(m.hiringSetupSetDocuments).toHaveBeenCalledWith('s-gg-hire', ['B', 'A', '@jd']));
  });

  it('printed inside a document: a fixed line and no draggable row; Edit Wording makes a copy', async () => {
    companyView = ownPacket({ placement: 'inside', placementLabel: 'Printed Inside Employment Agreement',
      documents: [{ id: 'A', name: 'Employment Agreement', marker: false, signedBy: 'The New Hire' }] });
    const toastOk = vi.fn();
    company({ toastOk });
    fireEvent.click(await screen.findByText('GG Packet'));
    expect(await screen.findByText('Job Description - Printed Inside Employment Agreement')).toBeTruthy();
    expect(screen.queryByText('Job Description - Goes Here')).toBeNull();
    expect(screen.queryByText('+ Add The Job Description Page')).toBeNull();
    fireEvent.click(screen.getByText('Edit Wording'));
    await waitFor(() => expect(m.hiringSetupOwnCopy).toHaveBeenCalledWith('s-gg-hire', 'A', 'e-gg'));
    await waitFor(() => expect(toastOk.mock.calls[0][0]).toMatch(/Employment Agreement - Greens Global/));
  });
});

// Round 2: the Promotion and Offboarding sections of the same screen.
const SECTIONS = [{ key: 'hiring', label: 'Hiring', status: 'left', chip: '2 Things Left' }, { key: 'promotion', label: 'Promotion', status: 'left', chip: '1 Thing Left' },
  { key: 'offboarding', label: 'Offboarding', status: 'ready', chip: 'Ready To Offboard' }];
const letter = (o) => cell({ name: 'California Promotion Letter', sourceLabel: 'Same As All Companies - California', settingId: 's-ca-promo', placement: 'page',
  placementLabel: 'Its Own Page, After Promotion Letter', countersign: 'Their Manager',
  documents: [{ id: 't-promo', name: 'Promotion Letter', marker: false, signedBy: 'The Employee, then Their Manager' }, { id: '@jd', name: 'Job Description - Goes Here', marker: true, signedBy: '' }], ...o });
const pkg = (o) => cell({ name: 'California Separation Package', sourceLabel: 'Same As All Companies - California', settingId: 's-ca-sep',
  documents: [{ id: 't-sep', name: 'Separation Agreement', marker: false, signedBy: 'The Employee' }], ...o });
const promoRow = (wt, country, region, kind, o = {}) => {
  const { offer, packet, ...r } = row(wt, country, region, kind);   // eslint-disable-line no-unused-vars
  return { ...r, letter: letter(), jd: jd({ placementLabel: 'Its Own Page, After Promotion Letter' }), ...o };
};
const offRow = (wt, country, region, kind, o = {}) => {
  const { offer, packet, jd: _j, ...r } = row(wt, country, region, kind);   // eslint-disable-line no-unused-vars
  return { ...r, package: pkg(), ...o };
};
const promotionView = (over = {}) => ggView({
  section: 'promotion', sections: SECTIONS, status: 'left', chip: '1 Thing Left',
  columns: [{ key: 'letter', event: 'promotion', label: 'Promotion Letter' }, { key: 'jd', event: '', label: "New Role's Job Description" }],
  items: [{ key: 'missing:contractor:US:CA', text: 'No promotion letter for Contractors In California yet - Promote is off there, Change Role Now still works.',
    button: 'Set It Up', action: 'setUp', target: { section: 'promotion', rowKey: 'contractor:US:CA', column: 'letter' } }],
  rows: [promoRow('employee', 'US', 'CA', 'Employees In California'), promoRow('contractor', 'US', 'CA', 'Contractors In California', { letter: missing })],
  ...over,
});
const offboardingView = (over = {}) => ggView({
  section: 'offboarding', sections: SECTIONS, status: 'ready', chip: 'Ready To Offboard', items: [], jobDescriptions: null,
  columns: [{ key: 'package', event: 'separation', label: 'Separation Package' }],
  rows: [offRow('employee', 'US', 'CA', 'Employees In California'), offRow('contractor', 'US', 'CA', 'Contractors In California')],
  ...over,
});
const bySection = (s) => (s === 'promotion' ? promotionView() : s === 'offboarding' ? offboardingView() : ggView({ section: 'hiring', sections: SECTIONS }));

describe('Promotion and Offboarding sections', () => {
  it('the About line and its Things To Finish button name the section, Hiring unchanged', async () => {
    const hr = ggView().items.find(i => i.key === 'check:s1:hr');
    m.getHiringSetupCompany.mockImplementation((e, r, s) => { const v = bySection(s); return Promise.resolve({ ...v, items: [...v.items.filter(i => i.key !== hr.key), hr] }); });
    company();
    expect(await screen.findByText('Handles Hiring')).toBeTruthy();
    expect(screen.getByText('Pick Who Handles Hiring')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Promotion/ }));
    expect(await screen.findByText('Handles Promotions')).toBeTruthy();
    expect(screen.getByLabelText('Edit Handles Promotions')).toBeTruthy();
    expect(screen.queryByText('Pick Who Handles Hiring')).toBeNull();
    expect(screen.getByText('Pick Who Handles Promotions')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Offboarding/ }));
    expect(await screen.findByText('Handles Offboarding')).toBeTruthy();
    expect(screen.getByText('Pick Who Handles Offboarding')).toBeTruthy();
    expect(screen.queryByText('Handles Hiring')).toBeNull();
  });

  it('the section control refetches with the section and swaps the grid', async () => {
    m.getHiringSetupCompany.mockImplementation((e, r, s) => Promise.resolve(bySection(s)));
    company();
    expect(await screen.findByText('Set Up Hiring - Greens Global')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Promotion/ }));
    expect(await screen.findByText('Set Up Promotions - Greens Global')).toBeTruthy();
    expect(m.getHiringSetupCompany).toHaveBeenLastCalledWith('e-gg', '', 'promotion');
    expect(screen.getByText('What Each Promotion Gets')).toBeTruthy();
    expect(screen.getByText("New Role's Job Description")).toBeTruthy();
    expect(screen.queryByText('Make An Offer')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Offboarding/ }));
    expect(await screen.findByText('Set Up Offboarding - Greens Global')).toBeTruthy();
    expect(m.getHiringSetupCompany).toHaveBeenLastCalledWith('e-gg', '', 'offboarding');
    expect(screen.getByText('Everything is set. Offboarding sends the separation package.')).toBeTruthy();
  });

  it('a promotion focus opens that section and Popup A on the letter', async () => {
    companyView = promotionView();
    render(<HiringSetup toastOk={noop} toastErr={noop} onAdvanced={noop} focus={{ entityId: 'e-gg', rowKey: 'employee:US:CA', column: 'letter' }} />);
    expect(await screen.findByText('Promotion Letter - Employees In California')).toBeTruthy();
    expect(m.getHiringSetupCompany).toHaveBeenCalledWith('e-gg', '', 'promotion');     // section inferred from the column
    expect(screen.getByText('Promotions already in progress keep the documents they started with.')).toBeTruthy();
  });

  it('the promotion grid shows who countersigns, amber when nobody does', async () => {
    companyView = promotionView({ rows: [promoRow('employee', 'US', 'CA', 'Employees In California'),
      promoRow('contractor', 'US', 'CA', 'Contractors In California', { letter: letter({ name: 'Contractor Promotion', countersign: '' }) })] });
    company({ focus: { entityId: 'e-gg', section: 'promotion' } });
    expect(await screen.findByText('Countersigned By Their Manager')).toBeTruthy();
    expect(screen.getByText('Nobody countersigns yet')).toBeTruthy();
    expect(screen.getByText('Job Descriptions')).toBeTruthy();                        // the duties table stays for promotion
    fireEvent.click(screen.getByText('Set It Up'));
    expect(await screen.findByText('Promotion Letter - Contractors In California')).toBeTruthy();
  });

  it('offboarding: one column, the per-row note, no Job Descriptions table', async () => {
    companyView = offboardingView();
    company({ focus: { entityId: 'e-gg', section: 'offboarding' } });
    expect(await screen.findByText('What Each Offboarding Gets')).toBeTruthy();
    expect(screen.getAllByText('California Separation Package')).toHaveLength(2);
    expect(screen.getByText('One separation package per row - the same for every reason they leave.')).toBeTruthy();
    expect(screen.queryByText('Job Descriptions')).toBeNull();
    expect(screen.queryByText('Promotion And Separation Letters')).toBeNull();
    fireEvent.click(screen.getAllByText('California Separation Package')[0]);
    expect(await screen.findByText('Separation Package - Employees In California')).toBeTruthy();
    expect(screen.queryByText('+ Add The Job Description Page')).toBeNull();
  });

  it('an upload from the letter column makes a promotion row with the job description page after it', async () => {
    companyView = promotionView();
    company({ focus: { entityId: 'e-gg', section: 'promotion' } });
    fireEvent.click(await screen.findByText('Nothing Yet - Choose One'));
    expect(await screen.findByText('Promotion Letter - Contractors In California')).toBeTruthy();
    fireEvent.click(screen.getByText('Upload A Word File'));
    fireEvent.click(await screen.findByText('Mock Wizard promotion'));
    await waitFor(() => expect(m.hiringSetupMakeOwn).toHaveBeenCalledWith({ entity_id: 'e-gg', event: 'promotion', worker_type: 'contractor', country: 'US', region: 'CA',
      start: 'templates', doc_template_ids: ['t-new', '@jd'], also: [] }));
  });

  it('GGCon India: making the contractor promotion letter own sends only its key', async () => {
    companyView = promotionView({ entity: { id: 'e-in', name: 'GGCon India', shared: false, canEdit: true, country: 'IN', region: '' }, items: [], about: [],
      rows: [promoRow('employee', 'IN', '', 'Employees In India', { letter: letter({ name: 'India Employee Promotion', settingId: 's-in-promo', sourceLabel: 'Same As All Companies' }) }),
        promoRow('contractor', 'IN', '', 'Contractors In India', { letter: letter({ name: 'India Contractor Promotion', settingId: 's-in-promo', sourceLabel: 'Same As All Companies' }) })] });
    company({ entityId: 'e-in', focus: { entityId: 'e-in', section: 'promotion' } });
    fireEvent.click(await screen.findByText('India Contractor Promotion'));
    fireEvent.click(await screen.findByText(/Make A Different One For GGCon India/));
    fireEvent.click(screen.getByText('Start From A Copy'));
    await waitFor(() => expect(m.hiringSetupMakeOwn).toHaveBeenCalledWith({ entity_id: 'e-in', event: 'promotion', worker_type: 'contractor', country: 'IN', region: '', start: 'copy', doc_template_ids: [], also: [] }));
    expect(screen.getByText('India Employee Promotion')).toBeTruthy();
  });

  it('Edit Wording of a shared row shows the server asking for Make A Different One first', async () => {
    companyView = promotionView({ rows: [promoRow('employee', 'US', 'CA', 'Employees In California', { letter: letter({ tone: 'own', sourceLabel: 'Only Here', settingId: 's-gg-promo' }) })] });
    m.hiringSetupOwnCopy.mockImplementationOnce(() => Promise.reject(new Error("Every company uses this one - click Make A Different One first, then change the wording in this company's own copy.")));
    company({ focus: { entityId: 'e-gg', section: 'promotion' } });
    fireEvent.click(await screen.findByText('California Promotion Letter'));
    fireEvent.click(await screen.findByText('Edit Wording'));
    expect(await screen.findByText(/click Make A Different One first/)).toBeTruthy();
    expect(m.hiringSetupOwnCopy).toHaveBeenCalledWith('s-gg-promo', 't-promo', 'e-gg');
  });
});

describe('Sections: stale answers and edge cases', () => {
  const deferred = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };

  it('a hiring box clicked while Promotion loads never crashes the popup', async () => {
    const promo = deferred();
    m.getHiringSetupCompany.mockImplementation((e, r, s) => (s === 'promotion' ? promo.p : Promise.resolve(bySection(s))));
    company();
    expect(await screen.findByText('Set Up Hiring - Greens Global')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Promotion/ }));
    fireEvent.click(screen.getAllByText('US Employee Offer Letter')[0]);           // the old grid is still on screen
    expect(await screen.findByText('Offer Letter - Employees In California')).toBeTruthy();
    promo.res(promotionView());
    expect(await screen.findByText('Set Up Promotions - Greens Global')).toBeTruthy();
    expect(screen.queryByText('Offer Letter - Employees In California')).toBeNull();
  });

  it('an older section answer landing last is dropped, and the tab follows what is shown', async () => {
    const promo = deferred();
    const off = deferred();
    m.getHiringSetupCompany.mockImplementation((e, r, s) => (s === 'promotion' ? promo.p : s === 'offboarding' ? off.p : Promise.resolve(bySection(s))));
    company();
    expect(await screen.findByText('Set Up Hiring - Greens Global')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Promotion/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Offboarding/ }));
    expect(screen.getByRole('tab', { name: /Hiring/ }).getAttribute('aria-selected')).toBe('true');   // nothing new is shown yet
    off.res(offboardingView());
    expect(await screen.findByText('Set Up Offboarding - Greens Global')).toBeTruthy();
    promo.res(promotionView());
    await new Promise(r => setTimeout(r, 0));
    expect(screen.getByText('Set Up Offboarding - Greens Global')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Offboarding/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('offboarding under Show For Role is read-only, so a role-level package is never archived', async () => {
    companyView = offboardingView({ rows: [offRow('employee', 'US', 'CA', 'Employees In California', {
      package: pkg({ name: 'Accountant Separation', sourceLabel: 'Only For Accountant', tone: 'own', settingId: 's-acct-sep' }) })] });
    company({ focus: { entityId: 'e-gg', section: 'offboarding' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Accountant' }));
    await waitFor(() => expect(m.getHiringSetupCompany).toHaveBeenLastCalledWith('e-gg', 'jr-acct', 'offboarding'));
    fireEvent.click(await screen.findByText('Accountant Separation'));
    expect(await screen.findByText(/Showing what one role gets/)).toBeTruthy();
    expect(screen.queryByText(/Use The Same/)).toBeNull();
    expect(m.hiringSetupUseSame).not.toHaveBeenCalled();
  });

  it('a Set It Up target for a place not in the grid starts Add A Place for it', async () => {
    companyView = promotionView();
    company({ focus: { entityId: 'e-gg', section: 'promotion', rowKey: 'employee:IN:', column: 'letter' } });
    expect(await screen.findByText(/That place is not in the grid yet/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(m.hiringSetupPlace).toHaveBeenCalledWith('e-gg', 'IN', ''));
  });

  it('promotion copy says people, not employees, for contractor rows', async () => {
    companyView = promotionView();
    company({ focus: { entityId: 'e-gg', section: 'promotion' } });
    expect(await screen.findByText('Kind Of Person')).toBeTruthy();
    fireEvent.click(screen.getByText('Nothing Yet - Choose One'));
    expect(await screen.findByText('Only these people get it. Everyone else keeps the shared one.')).toBeTruthy();
  });
});

describe('Popup B: Job Description', () => {
  it('shows the versions with who uses them, adds, saves as you type and removes', async () => {
    render(<RoleDutiesModal roleId="jr-acct" entityId="e-gg" rowKey="contractor:US:CA" companyName="Greens Global" onClose={noop} toastErr={noop} />);
    expect(await screen.findByText('Standard - Everyone')).toBeTruthy();
    expect(screen.getByText('Showing what Contractors In California get - using: Contractors - Anywhere')).toBeTruthy();
    expect(screen.getByText('Used By: Contractors In California')).toBeTruthy();
    const box = screen.getByLabelText(/Duties - Contractors - Anywhere/);
    expect(box.value).toBe('Deliver the close.');
    expect(box.closest('.nx-fill')).toBeTruthy();
    expect(screen.getByRole('dialog').style.width).toMatch(/60vw/);
    fireEvent.change(box, { target: { value: 'Deliver the monthly close.' } });
    expect(m.updateRoleDuty).not.toHaveBeenCalled();                          // waits for typing to stop
    await waitFor(() => expect(m.updateRoleDuty).toHaveBeenCalledWith('jr-acct', 'dv-1', 'Deliver the monthly close.'), { timeout: 2000 });
    fireEvent.click(screen.getByText('Standard - Everyone'));
    expect(await screen.findByText('Used By: Employees In California')).toBeTruthy();
    fireEvent.click(screen.getByText('Make A Different One For...'));
    const dlg = within(screen.getByRole('dialog'));
    fireEvent.change(dlg.getByDisplayValue('Contractors'), { target: { value: 'part_time' } });
    fireEvent.change(dlg.getByDisplayValue('All Companies'), { target: { value: 'e-gg' } });
    fireEvent.click(screen.getByText('Make It'));
    await waitFor(() => expect(m.addRoleDuty).toHaveBeenCalledWith('jr-acct', { hired_as: 'part_time', country: '', region: '', entity_id: 'e-gg' }));
    expect(await screen.findByText(/Duties - Part-Time Employees - Anywhere/)).toBeTruthy();
    fireEvent.click(screen.getByText('Use The Standard Instead'));
    await waitFor(() => expect(m.removeRoleDuty).toHaveBeenCalledWith('jr-acct', 'dv-2'));
  });

  it('saves run one after another, so an older text never lands last', async () => {
    let release;
    m.updateRoleDuty.mockImplementationOnce(() => new Promise(r => { release = r; }));
    render(<RoleDutiesModal roleId="jr-acct" entityId="e-gg" onClose={noop} toastErr={noop} />);
    const box = await screen.findByLabelText(/Duties - Standard - Everyone/);
    fireEvent.change(box, { target: { value: 'one' } });
    await waitFor(() => expect(m.updateRoleDuty).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.change(box, { target: { value: 'two' } });
    await new Promise(r => setTimeout(r, 1000));
    expect(m.updateRoleDuty).toHaveBeenCalledTimes(1);                       // waits for the first
    release({});
    await waitFor(() => expect(m.updateRoleDuty).toHaveBeenLastCalledWith('jr-acct', 'standard', 'two'));
  });

  it('a 403 on a shared Standard makes it read-only instead of toasting each pause', async () => {
    const toastErr = vi.fn();
    const e = Object.assign(new Error('Only HR with access to every company can change the standard duties - make a version for this company instead.'), { status: 403 });
    m.updateRoleDuty.mockImplementationOnce(() => Promise.reject(e));
    render(<RoleDutiesModal roleId="jr-acct" entityId="e-gg" onClose={noop} toastErr={toastErr} />);
    const box = await screen.findByLabelText(/Duties - Standard - Everyone/);
    fireEvent.change(box, { target: { value: 'changed' } });
    expect(await screen.findByText(/make a version for this company instead/, {}, { timeout: 2000 })).toBeTruthy();
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe('Keep the books.');
    expect(toastErr).not.toHaveBeenCalled();
  });

  it('read-only when this HR cannot change the shared screen', async () => {
    render(<RoleDutiesModal roleId="jr-acct" entityId="" canEdit={false} onClose={noop} toastErr={noop} />);
    const box = await screen.findByLabelText(/Duties - Standard - Everyone/);
    expect(box.readOnly).toBe(true);
    expect(screen.queryByText('Make A Different One For...')).toBeNull();
  });

  it('a version that already exists says so inside the popup', async () => {
    m.addRoleDuty.mockImplementationOnce(() => Promise.reject(new Error('This role already has a version for Contractors - Anywhere - change that one.')));
    render(<RoleDutiesModal roleId="jr-acct" entityId="e-gg" onClose={noop} toastErr={noop} />);
    fireEvent.click(await screen.findByText('Make A Different One For...'));
    fireEvent.click(screen.getByText('Make It'));
    expect(await screen.findByText(/already has a version for Contractors - Anywhere/)).toBeTruthy();
  });
});
