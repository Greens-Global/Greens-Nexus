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
      dueDate: '2026-10-30', overdue: true, signal: 'provisioned', signalLabel: 'A provisioning run finished', status: 'open', sortOrder: 1 },
    { id: 'it-2', checklistId: 'cl-1', key: 'ON-21', phase: 'Day 1', title: 'Team Intro, Buddy And First-Week Goals',
      hint: '', ownerRole: 'manager', ownerRoleLabel: 'Manager', ownerEmail: '', ownerName: '',
      dueDate: '2026-11-02', overdue: false, signal: '', signalLabel: '', status: 'open', sortOrder: 2 },
  ],
};
const META = {
  kinds: [{ value: 'onboarding', label: 'Onboarding' }, { value: 'offboarding', label: 'Offboarding' }, { value: 'inactive', label: 'Leave Or Suspension' }],
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
    getMyChecklistSteps: vi.fn(() => Promise.resolve({ steps: [] })),
    getChecklistOwners: vi.fn(() => Promise.resolve({ owners: { it: 'it@greensglobal.com' }, effective: { it: 'it@greensglobal.com' }, hrContact: '' })),
    getChecklistTemplates: vi.fn(() => Promise.resolve({ templates: [
      { id: 't1', kind: 'onboarding', kindLabel: 'Onboarding', name: 'Onboarding', entityId: '', inherited: false, updatedAt: '',
        items: [{ key: 'ON-01', phase: 'Offer Accepted', title: 'Profile Complete', owner: 'hr', anchor: 'created', offset: 0, bd: false, applies: {}, signal: '', hint: '' }] },
    ] })),
  },
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'it@greensglobal.com', name: 'Ivy Tech' }] }) }));

const { ChecklistSection, MyChecklistSteps, ChecklistSettings } = await import('./HrChecklists');
const { api } = await import('../api');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ChecklistSection', () => {
  it('renders the steps by phase with owners and US dates', async () => {
    render(<ChecklistSection employee={{ id: 'emp-1', firstName: 'Jane', startDate: '2026-11-02' }} canEdit toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Microsoft 365 Account Provisioned')).toBeInTheDocument();
    expect(screen.getByText('Account And Access')).toBeInTheDocument();
    expect(screen.getByText('Ivy Tech')).toBeInTheDocument();
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
    expect(await screen.findByText('Who Owns Each Role')).toBeInTheDocument();
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
