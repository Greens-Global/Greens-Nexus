import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const roleState = { admin: true };
vi.mock('../../../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => (r === 'administrator' ? roleState.admin : true) }) }));
const aiState = { settings: { diagramAiEnabled: false, aiAvailable: false } };
vi.mock('../../../api', () => ({
  api: {
    getContactDirectory: vi.fn(async () => ({ people: [
      { email: 'boss@x.com', name: 'Boss', jobTitle: 'Owner', managerEmail: '', companyName: 'Greens Global' },
      { email: 'b@x.com', name: 'Bea', managerEmail: 'boss@x.com', companyName: 'Greens India' },
    ] })),
    getTaskProjects: vi.fn(async () => { const e = new Error('no'); e.status = 403; throw e; }),
    getPropertyWorkspace: vi.fn(async () => ({
      properties: [{ id: 'p1', name: 'Escondido' }, { id: 'e1', kind: 'equipment', name: 'Gate Operator', parentId: 'p1' }],
      utilities: [{ propertyId: 'p1', service: 'Electric', provider: 'SDG&E' }],
    })),
    getDiagramAiSettings: vi.fn(async () => aiState.settings),
    diagramFromSentence: vi.fn(async () => ({ text: 'Office -> Gate | lock' })),
  },
}));
import { api } from '../../../api';
import DiagramSheet from './DiagramSheet';
import { _clearSourceCache } from './sources';

afterEach(() => { roleState.admin = true; aiState.settings = { diagramAiEnabled: false, aiAvailable: false }; _clearSourceCache(); vi.clearAllMocks(); });

describe('DiagramSheet', () => {
  it('previews typed text and places the parsed graph', () => {
    const onPlace = vi.fn();
    render(<DiagramSheet mode="text" onPlace={onPlace} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Diagram Text'), { target: { value: 'A -> B?\nB? -yes-> C' } });
    expect(screen.getByText('3 boxes')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Diagram preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Left to Right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Place on Board' }));
    const [graph, opts] = onPlace.mock.calls[0];
    expect(graph.nodes.map((n) => n.label)).toEqual(['A', 'B?', 'C']);
    expect(opts).toEqual({ dir: 'LR', source: '', ref: '' });
  });

  it('previews groups, the three arrows and icons, and says when an icon is unknown', () => {
    render(<DiagramSheet mode="text" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Diagram Text'), { target: { value: 'Site:\n  Office | building => Gate | lock\nGate -.-> Cameras | nope\nGate -> Office' } });
    expect(document.body.querySelector('[data-group="Site"]')).toBeTruthy();
    expect([...document.body.querySelectorAll('[data-edge]')].map((e) => e.dataset.edge).sort()).toEqual(['dashed', 'main', 'normal']);
    expect(screen.getByText(/No icon is called "nope"/)).toBeTruthy();
  });

  it('draws the org chart from the directory, boxed by company when asked', async () => {
    const onPlace = vi.fn();
    render(<DiagramSheet mode="org" onPlace={onPlace} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('2 boxes')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Place on Board' }));
    expect(onPlace.mock.calls[0][1]).toEqual({ dir: 'TB', source: 'org', ref: '' });
    fireEvent.click(screen.getByLabelText('Group By Company'));
    await waitFor(() => expect(document.body.querySelector('[data-group="Greens India"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Place on Board' }));
    expect(onPlace.mock.calls[1][1]).toEqual({ dir: 'TB', source: 'org', ref: '', group: 'company' });
    expect(onPlace.mock.calls[1][0].groups.map((g) => g.label)).toEqual(['Greens Global', 'Greens India']);
  });

  it('says so when a list is not open to this person', async () => {
    render(<DiagramSheet mode="tasks" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/do not have access/));
    expect(screen.getByRole('button', { name: 'Place on Board' }).disabled).toBe(true);
  });

  it('draws a property from the server\'s workspace, and Nexus Connections for an administrator', async () => {
    const onPlace = vi.fn();
    render(<DiagramSheet mode="systems" onPlace={onPlace} onClose={() => {}} />);
    await waitFor(() => expect(document.body.querySelector('[data-group="Escondido"]')).toBeTruthy());
    expect(document.body.querySelector('[data-group="Utilities"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Place on Board' }));
    expect(onPlace.mock.calls[0][1]).toEqual({ dir: 'TB', source: 'systems', ref: 'property:p1' });
    fireEvent.click(screen.getByRole('radio', { name: 'Nexus Connections' }));
    await waitFor(() => expect(document.body.querySelector('[data-group="Business Systems"]')).toBeTruthy());
    expect(document.body.querySelectorAll('[data-edge="dashed"]').length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Place on Board' }));
    expect(onPlace.mock.calls[1][1]).toEqual({ dir: 'TB', source: 'systems', ref: 'nexus' });
  });

  it('never offers Nexus Connections to someone who is not an administrator', async () => {
    roleState.admin = false;
    render(<DiagramSheet mode="systems" onClose={() => {}} />);
    await waitFor(() => expect(document.body.querySelector('[data-group="Escondido"]')).toBeTruthy());
    expect(screen.queryByRole('radio', { name: 'Nexus Connections' })).toBeNull();
  });

  it('shows From a Sentence with its button off and the reason while AI is off', async () => {
    render(<DiagramSheet mode="text" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'From a Sentence' }));
    expect(screen.getByLabelText('Describe it in a sentence')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/A Super Administrator \(Neil or Visesh\) must enable AI for Nexus and connect an AI service first/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Describe it in a sentence'), { target: { value: 'An office opens a gate' } });
    const write = screen.getByRole('button', { name: 'Write the Diagram' });
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(api.diagramFromSentence).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Place on Board' }).disabled).toBe(true);
  });

  it('says the setting did not load (not that AI is off) and offers Retry', async () => {
    api.getDiagramAiSettings.mockImplementationOnce(async () => { throw new Error('offline'); });
    render(<DiagramSheet mode="text" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'From a Sentence' }));
    await waitFor(() => expect(screen.getByText(/did not load/)).toBeTruthy());
    expect(screen.queryByText(/must enable AI for Nexus/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Write the Diagram' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/must enable AI for Nexus/)).toBeTruthy());
    expect(screen.queryByText(/did not load/)).toBeNull();
    expect(api.getDiagramAiSettings).toHaveBeenCalledTimes(2);
  });

  it('when AI is on and switched on, writes the text into the box for review first', async () => {
    aiState.settings = { diagramAiEnabled: true, aiAvailable: true };
    render(<DiagramSheet mode="text" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'From a Sentence' }));
    fireEvent.change(screen.getByLabelText('Describe it in a sentence'), { target: { value: 'An office opens a gate' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Write the Diagram' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Write the Diagram' }));
    await waitFor(() => expect(screen.getByLabelText('Diagram Text').value).toBe('Office -> Gate | lock'));
    expect(api.diagramFromSentence).toHaveBeenCalledWith('An office opens a gate');
  });
});
