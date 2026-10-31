// The phone New Task sheet (Oct 31 2026): a list pasted into the name opens
// Add Several over the sheet with the sheet's project and fields; a one-line
// paste types in; Escape over the modal leaves the sheet standing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const createTask = vi.fn();
vi.mock('./TasksContext', () => ({
  useTasks: () => ({ createTask, myEmail: 'me@greensglobal.com', projects: [{ id: 'p1', name: 'Launch Plan' }], customFields: [] }),
}));
vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn(async () => [{ email: 'me@greensglobal.com', name: 'Me' }]) } }));
vi.mock('./AddSeveralModal', () => ({ default: ({ defaults, onClose }) => (
  <div data-testid="add-several" data-defaults={JSON.stringify(defaults)}>
    <button type="button" onClick={() => onClose?.(false)}>Close Several</button>
    <button type="button" onClick={() => onClose?.(true)}>Finish Several</button>
  </div>
) }));

import QuickCreateTask from './QuickCreateTask';

afterEach(() => { cleanup(); createTask.mockReset(); });

describe('QuickCreateTask paste', () => {
  it('a pasted list opens Add Several with the sheet\'s locked project and typed name first', async () => {
    const onClose = vi.fn();
    render(<QuickCreateTask defaults={{ projectId: 'p1', teamId: 'tm1' }} onClose={onClose} onFullDetails={() => {}} />);
    const box = screen.getByLabelText('Task name');
    fireEvent.change(box, { target: { value: 'Typed' } });
    fireEvent.paste(box, { clipboardData: { getData: () => 'One\nTwo' } });
    const modal = await screen.findByTestId('add-several');
    expect(JSON.parse(modal.dataset.defaults)).toMatchObject({
      text: 'Typed\nOne\nTwo', projectId: 'p1', lockedProjectId: 'p1', teamId: 'tm1', assigneeIds: ['me@greensglobal.com'], source: 'paste',
    });
    expect(createTask).not.toHaveBeenCalled();
    // Closing the modal without adding leaves the sheet and its name.
    fireEvent.click(screen.getByRole('button', { name: 'Close Several' }));
    expect(screen.queryByTestId('add-several')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Task name').value).toBe('Typed');
    // Adding closes the sheet too - the tasks are made.
    fireEvent.paste(screen.getByLabelText('Task name'), { clipboardData: { getData: () => 'A\nB' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Finish Several' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a one-line paste types in as before', () => {
    render(<QuickCreateTask defaults={{}} onClose={() => {}} onFullDetails={() => {}} />);
    const out = fireEvent.paste(screen.getByLabelText('Task name'), { clipboardData: { getData: () => 'Just one' } });
    expect(out).toBe(true);
    expect(screen.queryByTestId('add-several')).toBeNull();
  });
});
