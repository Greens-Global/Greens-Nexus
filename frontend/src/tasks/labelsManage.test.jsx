import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Manage > Labels (Oct 22 2026): the company's labels with their task counts;
// recolor at once, rename / merge / delete only after saying what will change.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const calls = vi.hoisted(() => ({}));
const payload = (extra = {}) => ({
  companyId: '', companies: [], canManage: true, tones: [],
  labels: { urgent: { name: 'Urgent', color: 'red' }, stale: { name: 'Stale', color: 'blue' } },
  inUse: [{ key: 'urgent', name: 'Urgent', count: 4 }, { key: 'client', name: 'Client', count: 2 }],
  ...extra,
});
vi.mock('../api', () => ({
  api: {
    getTaskLabels: vi.fn((args) => { (calls.get ||= []).push(args); return Promise.resolve(payload()); }),
    setTaskLabelColor: vi.fn((...a) => { calls.color = a; return Promise.resolve(payload()); }),
    renameTaskLabel: vi.fn((...a) => { calls.rename = a; return Promise.resolve(payload({ changed: 2, merged: true, name: 'Urgent' })); }),
    deleteTaskLabel: vi.fn((...a) => { calls.del = a; return Promise.resolve(payload({ changed: 4 })); }),
  },
}));

const { default: LabelsManageTab } = await import('./LabelsManageTab');

beforeEach(() => { for (const k of Object.keys(calls)) delete calls[k]; });

const row = (name) => document.querySelector(`[data-label-row="${name.toLowerCase()}"]`);

describe('Manage > Labels', () => {
  it("lists every label in use with its count - and a colored one no task carries", async () => {
    render(<LabelsManageTab />);
    await waitFor(() => expect(row('Urgent')).not.toBeNull());
    // Manage's own read counts every task in the company (`all`); the pills'
    // shared colors are a separate, plain read.
    expect(calls.get).toContainEqual({ company: '', all: true });
    expect(within(row('Urgent')).getByText('4 tasks')).toBeInTheDocument();
    expect(within(row('Client')).getByText('2 tasks')).toBeInTheDocument();
    expect(within(row('Stale')).getByText('0 tasks')).toBeInTheDocument();
  });

  it('recolors at once', async () => {
    render(<LabelsManageTab />);
    await waitFor(() => expect(row('Client')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Change color of Client' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Purple' }));
    await waitFor(() => expect(calls.color).toEqual(['Client', 'purple', '']));
  });

  it('delete asks first, saying how many tasks it changes', async () => {
    render(<LabelsManageTab />);
    await waitFor(() => expect(row('Urgent')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Urgent' }));
    expect(await screen.findByText(/removes the label from 4 tasks/)).toBeInTheDocument();
    expect(calls.del).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Label' }));
    await waitFor(() => expect(calls.del).toEqual(['Urgent', '']));
    expect(await screen.findByText('Removed "Urgent" from 4 tasks.')).toBeInTheDocument();
  });

  it('renaming onto a label in use says it merges', async () => {
    render(<LabelsManageTab />);
    await waitFor(() => expect(row('Client')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Rename Client' }));
    const box = await screen.findByRole('textbox', { name: 'New name' });
    fireEvent.change(box, { target: { value: 'urgent' } });
    expect(screen.getByText(/merges into/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge Labels' }));
    await waitFor(() => expect(calls.rename).toEqual(['Client', 'urgent', '']));
    expect(await screen.findByText('Merged "Client" into "Urgent" on 2 tasks.')).toBeInTheDocument();
  });
});
