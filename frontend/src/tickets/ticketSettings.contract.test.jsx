import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { renderInGroup, typedFields, editField, saveRows } from '../components/settings/settingsContract.testkit';

// The Settings save contract (Oct 23 2026, "Settings saves one way") for the
// Ticket Manager's panels: a panel with typed fields keeps a draft, reports
// it dirty to its Settings group the moment one changes, and has ONE Save row
// at its foot (disabled until something changed); a panel of switches and
// chip lists only (Routing, Desk Access) has no Save row and nothing to leave
// unsaved.

const NOTIFY = {
  fromMailbox: '', ticketAdminEmail: '', defaultCc: [], replyTo: '', logoUrl: '', autoCloseDays: 7,
  enabledEvents: { created: true }, commentsTrigger: false, inboundEnabled: false, inboundMailbox: '',
  agentEmails: [], agentEmailsByCompany: {},
};
const TAXONOMY = {
  slaTargetHours: { urgent: 4, high: 24, medium: 72, low: 168 },
  types: {}, typeOrder: null, companyField: { enabled: false, companyIds: [] },
  helpTopics: [{ label: 'IT', departments: ['it'], topics: [{ name: 'Nexus', area: 'tasks' }] }],
};
vi.mock('../api', () => ({
  api: {
    getTicketNotifySettings: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(NOTIFY)))),
    updateTicketNotifySettings: vi.fn((b) => Promise.resolve({ ...JSON.parse(JSON.stringify(NOTIFY)), ...b })),
    getTicketNotifyLog: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
    getTicketTaxonomySettings: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(TAXONOMY)))),
    updateTicketTaxonomySettings: vi.fn((b) => Promise.resolve({ ...JSON.parse(JSON.stringify(TAXONOMY)), ...b })),
    getTicketCompanies: vi.fn(() => Promise.resolve([{ id: 'c1', name: 'Greens' }])),
    getTicketDepartments: vi.fn(() => Promise.resolve([{ id: 'd1', name: 'IT', companyId: 'c1', enabled: true }])),
    getTicketDeskAccess: vi.fn(() => Promise.resolve({ deskAccess: 'legacy', explicitChanges: [] })),
    updateTicketDeskAccess: vi.fn((mode) => Promise.resolve({ deskAccess: mode, explicitChanges: [] })),
    getTicketDeskAgents: vi.fn(() => Promise.resolve([])),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myLevel: 4, can: () => true }) }));
vi.mock('../tasks/components', () => ({
  usePeople: () => [],
  PersonMultiSelect: ({ value, onChange }) => (
    <button type="button" onClick={() => onChange([...value, 'new@x.com'])}>Agents: {value.length}</button>
  ),
  PersonSelect: () => <span>Person picker</span>,
}));
vi.mock('./deskAgents', () => ({ useDeskAgents: () => ({}), agentOptions: () => [] }));

const { api } = await import('../api');
const TicketNotifySettings = (await import('./TicketNotifySettings')).default;
const TicketTaxonomySettings = (await import('./TicketTaxonomySettings')).default;
const TicketHelpTopicsSettings = (await import('./TicketHelpTopicsSettings')).default;
const TicketDeskSettings = (await import('./TicketDeskSettings')).default;
const TicketDeskAccessSettings = (await import('./TicketDeskAccessSettings')).default;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const saveButton = (root) => within(root.querySelector('[data-save-row]')).getByRole('button', { name: /^Save$/ });

describe.each([
  ['Notifications', TicketNotifySettings, 'Shared Mailbox (Sender)'],
  ['SLA & Ticket Types', TicketTaxonomySettings, 'SLA Target Hours'],
  ['Help Topics', TicketHelpTopicsSettings, 'What Do You Need Help With?'],
])('%s keeps the Settings save contract', (_name, Panel, loaded) => {
  it('has one Save row, reports a typed edit dirty, and saves only once changed', async () => {
    const { container, group } = renderInGroup(<Panel />);
    await screen.findByText(loaded);
    await waitFor(() => expect(typedFields(container).length).toBeGreaterThan(0));
    expect(saveRows(container)).toBe(1);
    expect(saveButton(container)).toBeDisabled();
    expect(group.dirty).toBe(false);
    editField(typedFields(container)[0]);
    await waitFor(() => expect(group.dirty).toBe(true));
    expect(saveButton(container)).toBeEnabled();
    // Every dirty form here can save itself, so the prompt offers Save and Leave.
    expect(group.saves.every((s) => typeof s === 'function')).toBe(true);
    await expect(group.saves[0]()).resolves.toBe(true);
    await waitFor(() => expect(group.dirty).toBe(false));
  });
});

describe('Notifications', () => {
  it('sends only the typed fields that changed, never the Routing tab\'s rosters', async () => {
    const { container } = renderInGroup(<TicketNotifySettings />);
    await screen.findByText('Shared Mailbox (Sender)');
    fireEvent.change(typedFields(container)[0], { target: { value: 'desk@x.com' } });
    fireEvent.click(saveButton(container));
    await waitFor(() => expect(api.updateTicketNotifySettings).toHaveBeenCalledWith({ fromMailbox: 'desk@x.com' }));
  });

  it('saves a notification switch at once, without touching a half-typed field', async () => {
    const { container, group } = renderInGroup(<TicketNotifySettings />);
    await screen.findByText('Shared Mailbox (Sender)');
    fireEvent.change(typedFields(container)[0], { target: { value: 'half@' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Ticket assigned' }));
    await waitFor(() => expect(api.updateTicketNotifySettings).toHaveBeenCalledWith({ enabledEvents: { assigned: true } }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Ticket assigned' })).toHaveAttribute('aria-checked', 'true'));
    expect(typedFields(container)[0]).toHaveValue('half@');
    expect(group.dirty).toBe(true);
  });
});

describe.each([
  ['Routing & Escalation', TicketDeskSettings, 'Default Agents'],
  ['Desk Access', TicketDeskAccessSettings, 'Roles Under Tickets Access Only'],
])('%s saves on change', (_name, Panel, loaded) => {
  it('has no typed fields, no Save row, and never reports unsaved work', async () => {
    const { container, group } = renderInGroup(<Panel />);
    await screen.findAllByText(loaded);
    expect(typedFields(container)).toHaveLength(0);
    expect(saveRows(container)).toBe(0);
    expect(group.dirty).toBe(false);
  });
});
