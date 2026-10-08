import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings > Ticket Manager > Help Topics (Sep 30): each department's
// "What do you need help with?" choices are edited here and saved as the
// taxonomy config's helpTopics, one group per department name.

const CONFIG = {
  helpTopics: [
    { label: 'IT Support', departments: ['it', 'it support', 'information technology'],
      topics: [{ name: 'Nexus', area: 'tasks' }, { name: 'Printer or Scanner', area: 'hardware' }] },
    { label: 'Construction', departments: ['construction'], topics: [{ name: 'Plumbing or Water Leak', area: 'facilities' }] },
    { label: 'Admin', departments: ['admin'], topics: [{ name: 'Microsoft', area: 'email', options: ['Outlook', 'Teams'] }] },
  ],
};
const DEPTS = [
  { id: 'd1', name: 'IT', companyId: 'c1' },
  { id: 'd2', name: 'Construction', companyId: 'c1' },
  { id: 'd3', name: 'HR', companyId: 'c1' },
  { id: 'd4', name: 'IT', companyId: 'c2' },
  { id: 'd5', name: 'Admin', companyId: 'c1' },
  // Deleted from the global list - no tab for it.
  { id: 'd6', name: 'Ghost', companyId: 'c1', removed: true },
];

vi.mock('../api', () => ({
  api: {
    getTicketTaxonomySettings: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(CONFIG)))),
    getTicketDepartments: vi.fn(() => Promise.resolve(DEPTS)),
    updateTicketTaxonomySettings: vi.fn((b) => Promise.resolve(b)),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myLevel: 4 }) }));
vi.mock('./ticketConfig', () => ({ refreshTicketConfig: vi.fn(() => Promise.resolve()) }));

const { api } = await import('../api');
const Panel = (await import('./TicketHelpTopicsSettings')).default;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('TicketHelpTopicsSettings', () => {
  it('lists each department name once, with its topic count', async () => {
    render(<Panel />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['IT2', 'Construction1', 'HRTyped', 'Admin1']);
  });

  it('shows the picked department\'s topics and edits them', async () => {
    render(<Panel />);
    await screen.findAllByRole('tab');
    expect(screen.getAllByLabelText('Topic name').map((i) => i.value)).toEqual(['Nexus', 'Printer or Scanner']);
    // The service area is kept on each topic but no longer picked here.
    expect(screen.queryByLabelText(/^Area for/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /HR/ }));
    expect(screen.queryAllByLabelText('Topic name')).toHaveLength(0);
    fireEvent.change(screen.getByPlaceholderText('Add a topic for HR…'), { target: { value: 'Payroll' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Topic/ }));
    expect(screen.getAllByLabelText('Topic name').map((i) => i.value)).toEqual(['Payroll']);
  });

  it('refuses a duplicate topic in the same department', async () => {
    render(<Panel />);
    await screen.findAllByRole('tab');
    fireEvent.change(screen.getByPlaceholderText('Add a topic for IT…'), { target: { value: 'nexus' } });
    expect(screen.getByText('IT already has that topic.')).toBeTruthy();
  });

  it('saves one group per department and keeps lists no department uses yet', async () => {
    render(<Panel />);
    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('tab', { name: /HR/ }));
    fireEvent.change(screen.getByPlaceholderText('Add a topic for HR…'), { target: { value: 'Payroll' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Topic/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateTicketTaxonomySettings).toHaveBeenCalled());
    const { helpTopics } = api.updateTicketTaxonomySettings.mock.calls[0][0];
    expect(helpTopics).toEqual([
      { label: 'IT', departments: ['it'], topics: [{ name: 'Nexus', area: 'tasks' }, { name: 'Printer or Scanner', area: 'hardware' }] },
      { label: 'Construction', departments: ['construction'], topics: [{ name: 'Plumbing or Water Leak', area: 'facilities' }] },
      { label: 'HR', departments: ['hr'], topics: [{ name: 'Payroll', area: 'general' }] },
      { label: 'Admin', departments: ['admin'], topics: [{ name: 'Microsoft', area: 'email', options: ['Outlook', 'Teams'] }] },
      // "IT Support" / "Information Technology" match no department today -
      // kept, so renaming IT back to one of them does not lose its list.
      { label: 'IT Support', departments: ['it support', 'information technology'],
        topics: [{ name: 'Nexus', area: 'tasks' }, { name: 'Printer or Scanner', area: 'hardware' }] },
    ]);
  });

  // Oct 1 2026 (Neil): Microsoft -> Outlook, Teams... an optional second level.
  it("edits a topic's Which One? options and saves them with the topic", async () => {
    render(<Panel />);
    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('tab', { name: /Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sub-options for Microsoft' }));
    const region = screen.getByRole('region', { name: 'Which One? options for Microsoft' });
    expect(screen.getAllByLabelText('Option name').map((i) => i.value)).toEqual(['Outlook', 'Teams']);
    expect(region).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Add an option for Microsoft…'), { target: { value: 'OneDrive' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Option/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Teams' }));
    fireEvent.change(screen.getByPlaceholderText('Add an option for Microsoft…'), { target: { value: 'outlook' } });
    expect(screen.getByText('That option is already listed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.updateTicketTaxonomySettings).toHaveBeenCalled());
    const admin = api.updateTicketTaxonomySettings.mock.calls[0][0].helpTopics.find((g) => g.label === 'Admin');
    expect(admin.topics).toEqual([{ name: 'Microsoft', area: 'email', options: ['Outlook', 'OneDrive'] }]);
  });

  it('a topic with no options saves without an options list', async () => {
    render(<Panel />);
    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('button', { name: 'Sub-options for Nexus' }));
    fireEvent.change(screen.getByPlaceholderText('Add an option for Nexus…'), { target: { value: 'Tasks' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Option/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.updateTicketTaxonomySettings).toHaveBeenCalled());
    const it_ = api.updateTicketTaxonomySettings.mock.calls[0][0].helpTopics[0];
    expect(it_.topics).toEqual([{ name: 'Nexus', area: 'tasks', options: ['Tasks'] }, { name: 'Printer or Scanner', area: 'hardware' }]);
  });
});
