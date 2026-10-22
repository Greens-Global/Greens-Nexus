import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

// Onboarding / offboarding checklists: the profile tab renders a checklist
// grouped by phase with owners and US dates, ticking a step calls the API, the
// My HR card hides itself when the person owns nothing, and the settings tab
// renders the owners and the template editor.

const CHECKLIST = {
  id: 'cl-1', employeeId: 'emp-1', kind: 'onboarding', kindLabel: 'Onboarding', company: 'co-a',
  anchorDate: '2026-11-02', exitType: '', status: 'open', total: 2, done: 0, overdue: 1,
  items: [
    { id: 'it-1', checklistId: 'cl-1', key: 'ON-12', phase: 'Account And Access', title: 'Microsoft 365 Account Provisioned',
      hint: 'Check the domain first.', ownerRole: 'it', ownerRoleLabel: 'IT', ownerEmail: 'it@greensglobal.com', ownerName: 'Ivy Tech',
      dueDate: '2026-10-30', overdue: true, signal: 'provisioned', signalLabel: 'A provisioning run finished', status: 'open', sortOrder: 1,
      comments: [{ id: 'c-1', author: 'it@greensglobal.com', authorName: 'Ivy Tech', body: 'Laptop ordered', at: '2026-10-29T16:00:00Z' }] },
    { id: 'it-2', checklistId: 'cl-1', key: 'ON-21', phase: 'Day 1', title: 'Team Intro, Buddy And First-Week Goals',
      hint: '', ownerRole: 'manager', ownerRoleLabel: 'Manager', ownerEmail: '', ownerName: '',
      dueDate: '2026-11-02', overdue: false, signal: '', signalLabel: '', status: 'open', sortOrder: 2 },
  ],
};
const BOARD = [
  { checklistId: 'cl-1', kind: 'onboarding', kindLabel: 'Onboarding', employeeId: 'emp-1', name: 'Jane Doe', jobTitle: 'Facility Manager', company: 'co-a', companyName: 'Greens',
    anchorDate: '2099-01-05', exitType: '', total: 30, done: 7, overdue: 2, dueThisWeek: 3, unassigned: 1, mine: 1,
    next: { title: 'Microsoft 365 Account Provisioned', dueDate: '2026-10-01', overdue: true, ownerEmail: 'it@greensglobal.com', ownerName: 'Ivy Tech', ownerRoleLabel: 'IT' } },
  { checklistId: 'cl-2', kind: 'offboarding', kindLabel: 'Offboarding', employeeId: 'emp-2', name: 'Tom Baker', jobTitle: 'Site Supervisor', company: 'co-a', companyName: 'Greens',
    anchorDate: '2099-01-10', exitType: 'resignation', total: 26, done: 5, overdue: 0, dueThisWeek: 1, unassigned: 0, mine: 0,
    next: { title: 'Knowledge Handover Plan', dueDate: '2099-01-01', overdue: false, ownerEmail: '', ownerName: '', ownerRoleLabel: 'Manager' } },
];
const META = {
  kinds: [{ value: 'onboarding', label: 'Onboarding' }, { value: 'promotion', label: 'Promotion' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave or Suspension' }],
  roles: [{ value: 'hr', label: 'HR' }, { value: 'it', label: 'IT' }, { value: 'manager', label: 'Manager' }],
  exitTypes: [{ value: 'resignation', label: 'Resignation' }],
  signals: [{ value: 'provisioned', label: 'A provisioning run finished' }],
};

vi.mock('../api', () => ({
  api: {
    getEmployeeChecklists: vi.fn(() => Promise.resolve({ checklists: [CHECKLIST] })),
    getChecklistMeta: vi.fn(() => Promise.resolve(META)),
    updateChecklistItem: vi.fn((id) => Promise.resolve({
      item: { ...CHECKLIST.items.find(i => i.id === id), status: 'done', overdue: false, doneBy: 'hr@greensglobal.com', doneAt: '2026-10-31T10:00:00Z' },
      checklistStatus: 'open',
    })),
    addChecklistComment: vi.fn((id, body) => Promise.resolve({
      item: { ...CHECKLIST.items.find(i => i.id === id), comments: [
        { id: 'c-1', author: 'it@greensglobal.com', authorName: 'Ivy Tech', body: 'Laptop ordered', at: '2026-10-29T16:00:00Z' },
        { id: 'c-2', author: 'hr@greensglobal.com', authorName: 'Hana Ross', body, at: '2026-10-30T17:30:00Z' }] },
      checklistStatus: 'open',
    })),
    getMyChecklistSteps: vi.fn(() => Promise.resolve({ steps: [] })),
    getChecklistBoard: vi.fn(() => Promise.resolve({ rows: BOARD })),
    getChecklistOwners: vi.fn(() => Promise.resolve({ owners: { it: 'it@greensglobal.com' }, effective: { it: 'it@greensglobal.com' }, hrContact: '' })),
    copyChecklistTemplates: vi.fn(() => Promise.resolve({ copied: 1, kinds: ['onboarding'], companies: ['co-a'] })),
    getRoleChecklistRoles: vi.fn(() => Promise.resolve({ isHr: false, roles: [
      { roleId: 'r-acct', roleName: 'Accounting Associate', department: 'Accounting', companyId: 'co-a', companyName: 'Greens',
        counts: { onboarding: 1, promotion: 0, offboarding: 0, inactive: 0 } }] })),
    getRoleChecklist: vi.fn(() => Promise.resolve({ roleId: 'r-acct', roleName: 'Accounting Associate', department: 'Accounting', templates: [
      { kind: 'onboarding', kindLabel: 'Onboarding', entityId: '', inherited: false, updatedAt: 'x',
        items: [{ key: 'ACC-1', phase: 'Accounting Associate Steps', title: 'Intacct Training', owner: 'manager', anchor: 'S', offset: 5, bd: false, applies: {}, signal: '', hint: '' }] },
      { kind: 'promotion', kindLabel: 'Promotion', entityId: '', inherited: false, updatedAt: '', items: [] },
    ] })),
    getChecklistTemplates: vi.fn((entityId) => Promise.resolve({ templates: [
      { id: 't1', kind: 'onboarding', kindLabel: 'Onboarding', name: 'Onboarding', entityId: '', inherited: !!entityId, updatedAt: '',
        items: [{ key: 'ON-01', phase: 'Offer Accepted', title: 'Profile Complete', owner: 'hr', anchor: 'created', offset: 0, bd: false, applies: {}, signal: '', hint: '' }] },
    ] })),
  },
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'it@greensglobal.com', name: 'Ivy Tech' }] }), useEntities: () => ({ data: [] }) }));

const { ChecklistSection, MyChecklistSteps, ChecklistSettings, ChecklistBoard, ChecklistChip, RoleChecklists } = await import('./HrChecklists');
const { api } = await import('../api');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ChecklistSection', () => {
  it('renders the steps by phase with owners and US dates', async () => {
    render(<ChecklistSection employee={{ id: 'emp-1', firstName: 'Jane', startDate: '2026-11-02' }} canEdit toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Microsoft 365 Account Provisioned')).toBeInTheDocument();
    expect(screen.getByText('Account And Access')).toBeInTheDocument();
    expect(screen.getAllByText('Ivy Tech').length).toBeGreaterThan(0);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Due 10/30/2026')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 Done')).toBeInTheDocument();
  });

  it('ticks a step through the API', async () => {
    render(<ChecklistSection employee={{ id: 'emp-1', firstName: 'Jane' }} canEdit toastOk={() => {}} toastErr={() => {}} />);
    await screen.findByText('Microsoft 365 Account Provisioned');
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark as done' })[0]);
    await waitFor(() => expect(api.updateChecklistItem).toHaveBeenCalledWith('it-1', { status: 'done' }));
    expect(await screen.findByText('1 of 2 Done')).toBeInTheDocument();
  });
});

describe('Step comments', () => {
  it('a step with comments opens on its thread, and a new comment posts through the API', async () => {
    render(<ChecklistSection employee={{ id: 'emp-1', firstName: 'Jane', startDate: '2026-11-02' }} canEdit toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Laptop ordered')).toBeInTheDocument();          // open without a click
    expect(screen.getAllByText('Ivy Tech').length).toBeGreaterThan(1);              // owner and comment author
    const boxes = screen.getAllByLabelText('Add a comment');
    fireEvent.change(boxes[0], { target: { value: 'Received, thanks' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Comment' })[0]);
    await waitFor(() => expect(api.addChecklistComment).toHaveBeenCalledWith('it-1', 'Received, thanks'));
    expect(await screen.findByText('Received, thanks')).toBeInTheDocument();
    expect(screen.queryByText(/Add Note|Edit Note/)).not.toBeInTheDocument();
  });
});

describe('MyChecklistSteps', () => {
  it('renders nothing when the person owns no steps', async () => {
    const { container } = render(<MyChecklistSteps />);
    await waitFor(() => expect(api.getMyChecklistSteps).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ChecklistSettings', () => {
  it('renders the owners and the template editor', async () => {
    render(<ChecklistSettings entities={[{ id: 'co-a', name: 'Greens' }]} toastOk={() => {}} toastErr={() => {}} />);
    // The library has no departments - it says where owners come from.
    expect(await screen.findByText('Who does each step')).toBeInTheDocument();
    expect(await screen.findByText('Profile Complete')).toBeInTheDocument();
    expect(screen.getByText('When the checklist starts')).toBeInTheDocument();
    // Read first, edit on click: the step opens its fields in place.
    fireEvent.click(screen.getByText('Profile Complete'));
    expect(await screen.findByDisplayValue('Profile Complete')).toBeInTheDocument();
  });

  it('groups steps under numbered phases and acts on ticked steps together', async () => {
    render(<ChecklistSettings entities={[]} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Phase 1')).toBeInTheDocument();
    expect(screen.getByText('Offer Accepted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every step in Offer Accepted' }));
    expect(screen.getByText('1 step selected')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Change owner of selected steps' }), { target: { value: 'it' } });
    // The owner tag now reads IT, the selection clears, and the change waits for Save.
    expect(await screen.findByText('Template changes not saved yet')).toBeInTheDocument();
    expect(screen.queryByText('1 step selected')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Phase 1: Offer Accepted' })).getByText('IT')).toBeInTheDocument();
  });
});

// Neil, Oct 19: a company uses the library or its own copy, and copies to
// other companies; a department head keeps a role's own steps.
describe('Who gets a step', () => {
  // Pranshu, Oct 20: dropdowns with every country, not US / India checkboxes.
  it('names any country, and the step editor offers worker type and country dropdowns', async () => {
    api.getChecklistTemplates.mockResolvedValueOnce({ templates: [
      { id: 't1', kind: 'onboarding', kindLabel: 'Onboarding', name: 'Onboarding', entityId: '', inherited: false, updatedAt: '',
        items: [{ key: 'DE-1', phase: 'Offer Accepted', title: 'Tax ID Collected', owner: 'hr', anchor: 'S', offset: 0, bd: false,
                  applies: { countries: ['DE'], types: ['part_time'] }, signal: '', hint: '' }] }] });
    render(<ChecklistSettings entities={[]} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Germany')).toBeInTheDocument();
    expect(screen.getByText('Part-Time')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tax ID Collected'));
    expect(await screen.findByText(/none = every country/)).toBeInTheDocument();
    expect(screen.getByText(/none = everyone/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'India' })).not.toBeInTheDocument();
  });
});

describe('Checklists by company and role', () => {
  // Pranshu, Oct 20: a company's checklists are its roles' - the company tab
  // audits which roles are built instead of holding steps of its own.
  it('a company shows which roles are built and what is missing, and builds one in place', async () => {
    render(<ChecklistSettings entityId="co-a" entities={[{ id: 'co-a', name: 'Greens' }]} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Role Checklists')).toBeInTheDocument();
    expect(await screen.findByText('Who Does Each Step')).toBeInTheDocument();
    expect(screen.getByText('0 of 1')).toBeInTheDocument();
    expect(screen.getByText('Accounting Associate')).toBeInTheDocument();
    expect(screen.getByText('1 step')).toBeInTheDocument();
    expect(screen.getAllByText('Missing')).toHaveLength(3);
    expect(screen.queryByText('Profile Complete')).not.toBeInTheDocument();     // no company steps here
    fireEvent.click(screen.getByText('Build'));
    expect(await screen.findByText('Accounting Associate - Checklist Steps')).toBeInTheDocument();
    expect(await screen.findByText(/steps yet. Until you add some/)).toBeInTheDocument();      // opens on the first one missing
  });

  it("the role editor lists the head's roles and the role's steps", async () => {
    render(<RoleChecklists toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Intacct Training')).toBeInTheDocument();
    expect(screen.getAllByText('Accounting Associate Steps').length).toBeGreaterThan(1);   // the heading and the phase
    fireEvent.click(screen.getByRole('tab', { name: /Promotion/ }));
    expect(await screen.findByText(/steps yet. Until you add some/)).toBeInTheDocument();
  });
});

describe('ChecklistBoard', () => {
  it('shows everyone in progress with counts and their next step, and opens a person', async () => {
    const onOpen = vi.fn();
    render(<ChecklistBoard entities={[{ id: 'co-a', name: 'Greens' }]} onOpen={onOpen} />);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Tom Baker')).toBeInTheDocument();
    expect(screen.getByText('Steps Overdue')).toBeInTheDocument();
    expect(screen.getByText('Knowledge Handover Plan')).toBeInTheDocument();
    expect(screen.getByText('7 of 30 Done')).toBeInTheDocument();
    // The Offboarding tile narrows the list to leavers.
    fireEvent.click(screen.getAllByRole('button', { name: /Offboarding/ })[0]);   // the tile, before the rows
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Tom Baker'));
    expect(onOpen).toHaveBeenCalledWith('emp-2');
  });
});

describe('ChecklistChip', () => {
  it('reads the progress and the late steps', () => {
    render(<ChecklistChip p={{ checklistId: 'x', kind: 'onboarding', kindLabel: 'Onboarding', done: 3, total: 30, overdue: 2 }} />);
    expect(screen.getByLabelText('Onboarding checklist: 3 of 30 done, 2 overdue')).toBeInTheDocument();
  });

  it('names the checklist, not the person - and reads Complete when every step is done', () => {
    const { unmount } = render(<ChecklistChip p={{ checklistId: 'y', kind: 'offboarding', kindLabel: 'Offboarding', status: 'open', done: 5, total: 26, overdue: 0 }} />);
    expect(screen.getByText('Offboarding Checklist')).toBeInTheDocument();
    expect(screen.getByText('5/26')).toBeInTheDocument();
    unmount();
    render(<ChecklistChip p={{ checklistId: 'z', kind: 'offboarding', kindLabel: 'Offboarding', status: 'done', done: 26, total: 26, overdue: 0 }} />);
    expect(screen.getByText('Offboarding Complete')).toBeInTheDocument();
    expect(screen.queryByText('26/26')).toBeNull();
  });
});

// Neil, Oct 22: HR / IT / Accounting steps belong to a department's head and
// backup, and the card says plainly who gets them when one is missing.
describe('Who does each step', () => {
  it('shows each department head and backup, and warns where nobody covers', async () => {
    api.getChecklistOwners.mockResolvedValueOnce({
      owners: {}, effective: { hr: ['head@greensglobal.com'] }, hrContact: '', legacy: {},
      globalAdmins: ['owner@greensglobal.com'],
      departmentChoices: [{ id: 'd-hr', name: 'Human Resources' }, { id: 'd-it', name: 'IT' }],
      departments: {
        hr: { id: 'd-hr', name: 'Human Resources', leadEmail: 'head@greensglobal.com', backupEmail: '', picked: false, active: ['head@greensglobal.com'] },
        it: { id: 'd-it', name: 'IT', leadEmail: '', backupEmail: '', picked: true, active: [] },
      },
    });
    render(<ChecklistSettings entityId="co-a" entities={[{ id: 'co-a', name: 'Greens' }]} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Who Does Each Step')).toBeInTheDocument();
    expect(screen.getByText('No backup.')).toBeInTheDocument();
    expect(screen.getByText('No department head.')).toBeInTheDocument();
    expect(screen.getByText('No Accounting department.')).toBeInTheDocument();
    expect(screen.getAllByText(/until it is set/).length).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: 'Department for HR steps' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Department for IT steps' })).toHaveValue('d-it');
  });
});

// Neil, Oct 22: "how it gets marked done should be a multi-select" - the owner
// can always tick it, and any one of several automatic conditions ticks it too.
describe('How a step gets marked done', () => {
  it('the editor offers every condition as a checkbox and the list names each one picked', async () => {
    api.getChecklistMeta.mockResolvedValue({ ...META, signals: [
      { value: 'provisioned', label: 'A provisioning run finished' },
      { value: 'id_on_file', label: 'An ID document is on file (Documents tab, not expired)' },
      { value: 'work_auth_verified', label: 'Work authorization is Verified on the Compliance tab (not expired)' }] });
    api.getChecklistTemplates.mockResolvedValueOnce({ templates: [
      { id: 't1', kind: 'onboarding', kindLabel: 'Onboarding', name: 'Onboarding', entityId: '', inherited: false, updatedAt: '',
        items: [{ key: 'ON-24', phase: 'First 90 Days', title: 'Right To Work Recorded', owner: 'hr', anchor: 'S', offset: 3, bd: true,
                  applies: {}, signal: 'id_on_file|work_auth_verified', hint: '' }] }] });
    render(<ChecklistSettings entities={[]} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText(/Auto-ticks when: an ID document is on file .* or work authorization/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Right To Work Recorded'));
    expect(await screen.findByRole('checkbox', { name: 'Done when the owner ticks it (always)' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /An ID document is on file/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Work authorization is Verified/ })).toBeChecked();
    const prov = screen.getByRole('checkbox', { name: 'A provisioning run finished' });
    expect(prov).not.toBeChecked();
    fireEvent.click(prov);
    expect(await screen.findByText(/\(3 picked\)/)).toBeInTheDocument();
    expect(screen.getByText('Template changes not saved yet')).toBeInTheDocument();
    api.getChecklistMeta.mockImplementation(() => Promise.resolve(META));
  });

  it('a step lists its conditions and says which one ticked it', async () => {
    api.getEmployeeChecklists.mockResolvedValueOnce({ checklists: [{ ...CHECKLIST, done: 1, items: [
      { ...CHECKLIST.items[0], comments: [], status: 'done', overdue: false, doneBy: 'Nexus', doneAt: '2026-10-23T10:00:00Z',
        doneReason: 'An ID document is on file (Documents tab, not expired)',
        signals: [{ value: 'id_on_file', label: 'An ID document is on file (Documents tab, not expired)' }] },
      { ...CHECKLIST.items[1], signal: 'provisioned|item_assigned',
        signals: [{ value: 'provisioned', label: 'A provisioning run finished' }, { value: 'item_assigned', label: 'An Item Management assignment exists' }] },
    ] }] });
    render(<ChecklistSection employee={{ id: 'emp-1', firstName: 'Jane', startDate: '2026-11-02' }} canEdit toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByText('Account And Access'));            // a finished phase starts folded
    fireEvent.click(await screen.findByText('Microsoft 365 Account Provisioned'));
    expect(await screen.findByText(/Marked done by Nexus: an ID document is on file .*, 10\/23\/2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Team Intro, Buddy And First-Week Goals'));
    expect(await screen.findByText('Nexus marks this done by itself when any one of these is true:')).toBeInTheDocument();
    expect(screen.getByText('a provisioning run finished')).toBeInTheDocument();
    expect(screen.getByText('an Item Management assignment exists')).toBeInTheDocument();
  });
});
