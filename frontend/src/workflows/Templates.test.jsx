import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Render-smoke for Workflows > Templates: the gallery groups by module with
// the trigger sentence and the blanks, Use Template asks for a name and a
// company (Every Company for a Global Admin, Your Company - the owner's own
// scope - for anyone else) and then opens the new draft with its blanks
// stashed for the builder, and an empty list says so.

const wfTemplates = vi.fn();
const wfUseTemplate = vi.fn();
const getEntities = vi.fn();
vi.mock('../api', () => ({
  api: {
    wfTemplates: (...a) => wfTemplates(...a),
    wfUseTemplate: (...a) => wfUseTemplate(...a),
    getEntities: (...a) => getEntities(...a),
  },
}));
const roleState = { myRole: 'owner' };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => roleState }));
vi.mock('./lib/useCatalog', () => ({ useCatalog: () => ({ catalog: { entities: [], events: [] }, loading: false, error: null, isNew: () => false }) }));
vi.mock('./lib/text', () => ({ describeTrigger: (t) => (t ? `When ${t.event}` : 'No trigger yet') }));

const { default: Templates } = await import('./Templates');

const TEMPLATES = [
  { key: 'probation', name: 'Probation Ending Reminder', module: 'hr', description: 'Tells the manager two weeks before.',
    blanks: ['steps.0.params.to', 'steps.1.params.letter_template'], definition: { trigger: { kind: 'date', event: 'probation ends' } } },
  { key: 'overdue', name: 'Overdue Task Escalation', module: 'tasks', description: '', blanks: [],
    definition: { trigger: { kind: 'event', event: 'a task is overdue' } } },
];

beforeEach(() => {
  [wfTemplates, wfUseTemplate, getEntities].forEach((f) => f.mockReset());
  roleState.myRole = 'owner';
  window.sessionStorage.clear();
  getEntities.mockResolvedValue([{ id: 'c1', name: 'Greens Global' }, { id: 'c2', name: 'Greens India' }]);
});

describe('Workflows Templates', () => {
  it('groups the cards by module with the trigger sentence and the blanks', async () => {
    wfTemplates.mockResolvedValue(TEMPLATES);
    render(<Templates go={vi.fn()} />);
    expect(await screen.findByText('Probation Ending Reminder')).toBeTruthy();
    const hr = screen.getByRole('region', { name: 'HR' });
    expect(within(hr).getByText('When probation ends')).toBeTruthy();
    expect(within(hr).getByText('Fill in:')).toBeTruthy();
    expect(within(hr).getByText('To')).toBeTruthy();
    expect(within(hr).getByText('Letter Template')).toBeTruthy();
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    expect(within(tasks).getByText('Overdue Task Escalation')).toBeTruthy();
    expect(within(tasks).queryByText('Fill in:')).toBeNull();
    // HR lists before Tasks, the app's order.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['HR', 'Tasks']);
  });

  it('uses a template through the name-and-company popup and opens the draft', async () => {
    wfTemplates.mockResolvedValue(TEMPLATES);
    wfUseTemplate.mockResolvedValue({ id: 'w9', name: 'My Probation Reminder', blanks: ['steps[0].params.to', 'steps[1].params.letter_template'], templateKey: 'probation' });
    // the blanks are stashed BEFORE the navigation, so the builder finds them on mount
    const go = vi.fn(() => { expect(window.sessionStorage.getItem('wf:blanks:w9')).toBe(JSON.stringify(['steps[0].params.to', 'steps[1].params.letter_template'])); });
    render(<Templates go={go} />);
    await screen.findByText('Probation Ending Reminder');
    fireEvent.click(screen.getAllByRole('button', { name: 'Use Template' })[0]);
    const name = await screen.findByLabelText('Name');
    expect(name.value).toBe('Probation Ending Reminder');
    fireEvent.change(name, { target: { value: 'My Probation Reminder' } });
    const company = await screen.findByLabelText('Company');
    // A Global Admin may pick Every Company; a company is listed by name.
    expect(within(company).getByRole('option', { name: 'Every Company' })).toBeTruthy();
    fireEvent.change(company, { target: { value: 'c2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));
    await vi.waitFor(() => expect(wfUseTemplate).toHaveBeenCalledWith('probation', { name: 'My Probation Reminder', companyId: 'c2' }));
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith('wf:w9'));
    expect(window.sessionStorage.getItem('wf:blanks:w9')).toBe(JSON.stringify(['steps[0].params.to', 'steps[1].params.letter_template']));
  });

  it('stashes nothing when the template has no blanks', async () => {
    wfTemplates.mockResolvedValue(TEMPLATES);
    wfUseTemplate.mockResolvedValue({ id: 'w10', blanks: [] });
    const go = vi.fn();
    render(<Templates go={go} />);
    await screen.findByText('Overdue Task Escalation');
    fireEvent.click(screen.getAllByRole('button', { name: 'Use Template' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Draft' }));
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith('wf:w10'));
    expect(window.sessionStorage.getItem('wf:blanks:w10')).toBeNull();
  });

  it('starts someone who is not a Global Admin on Your Company, never the first company listed', async () => {
    roleState.myRole = 'manager';
    wfTemplates.mockResolvedValue(TEMPLATES);
    wfUseTemplate.mockResolvedValue({ id: 'w9' });
    render(<Templates go={vi.fn()} />);
    await screen.findByText('Probation Ending Reminder');
    fireEvent.click(screen.getAllByRole('button', { name: 'Use Template' })[0]);
    const company = await screen.findByLabelText('Company');
    await vi.waitFor(() => expect(within(company).getByRole('option', { name: 'Greens Global' })).toBeTruthy());
    expect(within(company).queryByRole('option', { name: 'Every Company' })).toBeNull();
    expect(within(company).getByRole('option', { name: 'Your Company' })).toBeTruthy();
    expect(company.value).toBe('');
    // Create Draft sends '' - the server resolves the owner's own scope.
    fireEvent.click(screen.getByRole('button', { name: 'Create Draft' }));
    await vi.waitFor(() => expect(wfUseTemplate).toHaveBeenCalledWith('probation', { name: 'Probation Ending Reminder', companyId: '' }));
  });

  it('shows an empty state when there are no templates', async () => {
    wfTemplates.mockResolvedValue([]);
    render(<Templates go={vi.fn()} />);
    expect(await screen.findByText('No Templates Yet')).toBeTruthy();
  });

  it('offers a retry when the templates could not load', async () => {
    wfTemplates.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(TEMPLATES);
    render(<Templates go={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Overdue Task Escalation')).toBeTruthy();
  });
});
