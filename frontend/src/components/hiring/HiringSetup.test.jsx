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
      { id: 'e-gg', name: 'Greens Global', place: 'California', status: 'left', chip: '2 Things Left', summary: 'Uses the shared offer letter and hiring packet - no contractor documents yet' },
      { id: 'e-new', name: 'New Company LLC', place: 'No place set', status: 'notStarted', chip: 'Not Started', summary: 'Pick where its people work and it starts with the shared documents' },
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

beforeEach(() => { Object.values(m).forEach(f => f.mockClear()); confirm.mockClear(); companyView = ggView(); });

describe('Screen 1: Hiring Setup', () => {
  it('lists All Companies and each company, opens one, and links to Advanced', async () => {
    const onAdvanced = vi.fn();
    render(<HiringSetup toastOk={noop} toastErr={noop} onAdvanced={onAdvanced} />);
    expect(await screen.findByText('All Companies (Shared)')).toBeTruthy();
    expect(screen.getByText(/2 offer letters, 3 hiring packets/)).toBeTruthy();
    expect(screen.getByText('2 Things Left')).toBeTruthy();
    expect(screen.getByText('Not Started')).toBeTruthy();
    fireEvent.click(screen.getByText('Advanced: All Packets And Signing Orders'));
    expect(onAdvanced).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Set Up Hiring - Greens Global'));
    expect(await screen.findByText('Set Up Hiring - Greens Global')).toBeTruthy();
    expect(m.getHiringSetupCompany).toHaveBeenCalledWith('e-gg', '');
    fireEvent.click(screen.getByText('< Hiring Setup'));
    expect(await screen.findByText('All Companies (Shared)')).toBeTruthy();
  });

  it('a focus from the offer opens the company and its popup', async () => {
    render(<HiringSetup toastOk={noop} toastErr={noop} onAdvanced={noop} focus={{ entityId: 'e-gg', rowKey: 'contractor:US:CA', column: 'packet' }} />);
    expect(await screen.findByText('Hiring Packet - Contractors In California')).toBeTruthy();
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
    expect(m.getHiringSetupCompany).toHaveBeenLastCalledWith('e-gg', 'jr-acct');
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
    await waitFor(() => expect(m.hiringSetupOwnCopy).toHaveBeenCalledWith('s-gg-hire', 'A'));
    await waitFor(() => expect(toastOk.mock.calls[0][0]).toMatch(/Employment Agreement - Greens Global/));
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

  it('a version that already exists says so inside the popup', async () => {
    m.addRoleDuty.mockImplementationOnce(() => Promise.reject(new Error('This role already has a version for Contractors - Anywhere - change that one.')));
    render(<RoleDutiesModal roleId="jr-acct" entityId="e-gg" onClose={noop} toastErr={noop} />);
    fireEvent.click(await screen.findByText('Make A Different One For...'));
    fireEvent.click(screen.getByText('Make It'));
    expect(await screen.findByText(/already has a version for Contractors - Anywhere/)).toBeTruthy();
  });
});
