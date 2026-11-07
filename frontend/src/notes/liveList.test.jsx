// Live task lists in a note (Neil, 11/07/2026): the block reads its rows for
// the person looking, keeps only its choice in the saved HTML, and an editor
// can switch it to a project; a reader cannot.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  taskListEmbed: vi.fn(), getTaskProjects: vi.fn(), taskStates: vi.fn(async () => ({ tasks: {} })),
  getPeopleDirectory: vi.fn(async () => []), notesList: vi.fn(async () => ({ notes: [] })),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));

import NoteEditor from './NoteEditor';
import { normalizeHtml } from './noteSafeHtml';

const BLOCK = '<div data-type="liveList" data-source="mine" data-show="open"><p>Live task list</p></div>';

beforeEach(() => {
  apiMock.taskListEmbed.mockReset().mockResolvedValue({ tasks: [
    { id: 't1', title: 'Order the motor', done: false, dueOn: '2026-11-10' },
    { id: 't2', title: 'Call the vendor', done: true, dueOn: '' },
  ], total: 2, projectName: '', visible: true });
  apiMock.getTaskProjects.mockReset().mockResolvedValue([{ id: 'p1', name: 'Gate Repairs' }, { id: 'p2', name: 'Old', archived: true }]);
});

describe('a live task list', () => {
  it('shows the tasks as they are now, dates in US format', async () => {
    render(<NoteEditor value={BLOCK} onChange={vi.fn()} />);
    expect(await screen.findByText('Order the motor')).toBeTruthy();
    expect(screen.getByText('11/10/2026')).toBeTruthy();
    expect(apiMock.taskListEmbed).toHaveBeenCalledWith('mine', 'open');
  });

  it('lets an editor point it at a project, saved as the choice only', async () => {
    const onChange = vi.fn();
    render(<NoteEditor value={BLOCK} onChange={onChange} />);
    const pick = await screen.findByRole('combobox', { name: 'Which tasks' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Gate Repairs' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Old' })).toBeNull();
    fireEvent.change(pick, { target: { value: 'project:p1' } });
    await waitFor(() => expect(apiMock.taskListEmbed).toHaveBeenCalledWith('project:p1', 'open'));
    const html = onChange.mock.calls.at(-1)[0];
    expect(html).toContain('data-source="project:p1"');
    expect(html).not.toContain('Order the motor');
  });

  it('shows a reader the list without the controls', async () => {
    render(<NoteEditor value={BLOCK} onChange={vi.fn()} readOnly />);
    expect(await screen.findByText('Order the motor')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Which tasks' })).toBeNull();
    expect(screen.getByText('My Tasks')).toBeTruthy();
  });

  it('keeps only a safe choice', () => {
    expect(normalizeHtml('<div data-type="liveList" data-source="javascript:x" data-show="x"></div>')).toContain('data-source="mine"');
  });
});
