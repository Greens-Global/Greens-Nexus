import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../api', () => ({
  api: {
    getContactDirectory: vi.fn(async () => ({ people: [
      { email: 'boss@x.com', name: 'Boss', jobTitle: 'Owner', managerEmail: '' },
      { email: 'b@x.com', name: 'Bea', managerEmail: 'boss@x.com' },
    ] })),
    getTaskProjects: vi.fn(async () => { const e = new Error('no'); e.status = 403; throw e; }),
  },
}));
import DiagramSheet from './DiagramSheet';

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

  it('draws the org chart from the directory', async () => {
    const onPlace = vi.fn();
    render(<DiagramSheet mode="org" onPlace={onPlace} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('2 boxes')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Place on Board' }));
    expect(onPlace.mock.calls[0][1]).toEqual({ dir: 'TB', source: 'org', ref: '' });
  });

  it('says so when a list is not open to this person', async () => {
    render(<DiagramSheet mode="tasks" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/do not have access/));
    expect(screen.getByRole('button', { name: 'Place on Board' }).disabled).toBe(true);
  });
});
