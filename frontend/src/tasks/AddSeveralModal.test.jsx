import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AddSeveralModal from './AddSeveralModal';
import { pastedTaskList } from './batchPaste';

const importTasks = vi.fn();
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    projects: [{ id: 'p1', name: 'Launch Plan' }, { id: 'p2', name: 'Austin Build' }], teams: [], myEmail: 'me@greensglobal.com',
    sections: [{ id: 's1', projectId: 'p1', name: 'Phase 1', custom: true, position: 1 }],
    customFields: [{ id: 'f-prop', name: 'Property', type: 'text', required: true, projectIds: ['p2'], appliesTo: 'task' }],
    importTasks: (...a) => importTasks(...a),
  }),
}));
vi.mock('../api', () => ({
  api: { getPeopleDirectory: () => Promise.resolve([{ email: 'me@greensglobal.com', name: 'Me' }]) },
}));

const ok = (created) => Promise.resolve({ dryRun: false, created, errors: [], taskIds: [] });

describe('AddSeveralModal', () => {
  beforeEach(() => { importTasks.mockReset(); });

  it('counts the lines live and names the button after the top-level ones', () => {
    render(<AddSeveralModal defaults={{ text: 'A\n\tB\nC', source: 'paste' }} onClose={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 tasks, 1 subtask');
    expect(screen.getByRole('button', { name: /Add 2 Tasks/ })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Tasks'), { target: { value: 'One\nTwo\nThree' } });
    expect(screen.getByRole('status')).toHaveTextContent('3 tasks');
    expect(screen.getByRole('button', { name: /Add 3 Tasks/ })).toBeTruthy();
  });

  it('dry-runs first, then adds - one import call shape, the shared fields on every row', async () => {
    importTasks.mockImplementation((body) => (body.dry_run ? Promise.resolve({ dryRun: true, errors: [] }) : ok(2)));
    const onDone = vi.fn(); const onClose = vi.fn();
    render(<AddSeveralModal defaults={{ text: 'Call the bank\n\tAsk for the statement', projectId: 'p1', dueOn: '2026-11-05', priority: 'high', source: 'typed' }}
      onClose={onClose} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /Add 1 Task/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(importTasks).toHaveBeenCalledTimes(2);
    const [dry, real] = importTasks.mock.calls.map((c) => c[0]);
    expect(dry.dry_run).toBe(true);
    expect(real.dry_run).toBe(false);
    expect(real.import_id).toBe(dry.import_id);
    expect(real).toMatchObject({ project_id: 'p1', section_id: '', source: 'typed', notify_assignees: true });
    expect(real.rows).toEqual([
      { row: 1, title: 'Call the bank', assignees: 'me@greensglobal.com', due: '2026-11-05', priority: 'high' },
      { row: 2, title: 'Ask for the statement', parent: '1', assignees: 'me@greensglobal.com', due: '2026-11-05', priority: 'high' },
    ]);
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('a dry-run error is shown by line and the real run never happens', async () => {
    importTasks.mockImplementation(() => Promise.resolve({ dryRun: true, errors: [{ row: 2, title: 'B', errors: ['Property is required in this project.'] }] }));
    const onDone = vi.fn();
    render(<AddSeveralModal defaults={{ text: 'A\nB', projectId: 'p1' }} onClose={() => {}} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /Add 2 Tasks/ }));
    await screen.findByTestId('add-several-problem');
    expect(screen.getByTestId('add-several-problem')).toHaveTextContent('Line 2 "B": Property is required in this project.');
    expect(importTasks).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a dry-run warning asks for a second click, and the second click adds', async () => {
    importTasks.mockImplementation((body) => (body.dry_run
      ? Promise.resolve({ dryRun: true, errors: [], rows: [{ row: 1, title: 'A', warnings: ['Assignee "zed" is not in the Nexus directory - left off.'] }, { row: 2, title: 'B', warnings: [] }] })
      : ok(2)));
    const onDone = vi.fn();
    render(<AddSeveralModal defaults={{ text: 'A\nB' }} onClose={() => {}} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /Add 2 Tasks/ }));
    await screen.findByTestId('add-several-warning');
    expect(screen.getByTestId('add-several-warning')).toHaveTextContent('Line 1 "A": Assignee "zed" is not in the Nexus directory - left off.');
    expect(importTasks).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    const again = screen.getByRole('button', { name: /Add 2 Tasks Anyway/ });
    fireEvent.click(again);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(importTasks).toHaveBeenCalledTimes(2);
    expect(importTasks.mock.calls[1][0].dry_run).toBe(false);
  });

  it('a failed request shows why and keeps the list for a retry under the same id', async () => {
    importTasks.mockImplementationOnce(() => Promise.reject(new Error('This list was already added.')));
    render(<AddSeveralModal defaults={{ text: 'A\nB' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add 2 Tasks/ }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('This list was already added.');
    expect(screen.getByLabelText('Tasks').value).toBe('A\nB');
    importTasks.mockImplementation((body) => (body.dry_run ? Promise.resolve({ dryRun: true, errors: [], rows: [] }) : ok(2)));
    fireEvent.click(screen.getByRole('button', { name: /Add 2 Tasks/ }));
    await waitFor(() => expect(importTasks).toHaveBeenCalledTimes(3));
    expect(importTasks.mock.calls[2][0].import_id).toBe(importTasks.mock.calls[0][0].import_id);
  });

  it('needs someone to hold the tasks: no assignee disables Add', async () => {
    render(<AddSeveralModal defaults={{ text: 'A\nB', assigneeIds: ['me@greensglobal.com'] }} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Add 2 Tasks/ })).toBeEnabled();
    // Take me off (the chip's remove button in PersonMultiSelect).
    const remove = await screen.findByRole('button', { name: /Remove Me|Remove me@/ });
    fireEvent.click(remove);
    expect(screen.getByRole('button', { name: /Add 2 Tasks/ })).toBeDisabled();
  });

  it('a project with a required field asks for it here, and sends it on top-level rows', async () => {
    importTasks.mockImplementation((body) => (body.dry_run ? Promise.resolve({ dryRun: true, errors: [], rows: [] }) : ok(1)));
    render(<AddSeveralModal defaults={{ text: 'A\n\tB', projectId: 'p2' }} onClose={() => {}} onDone={() => {}} />);
    const add = screen.getByRole('button', { name: /Add 1 Task/ });
    expect(add).toBeDisabled();
    const prop = screen.getByText('Property').closest('div').querySelector('input, select, textarea');
    fireEvent.change(prop, { target: { value: 'Austin' } });
    fireEvent.blur(prop);   // the text field hands its value over on blur
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(importTasks).toHaveBeenCalledTimes(2));
    const rows = importTasks.mock.calls[1][0].rows;
    expect(rows[0].custom).toEqual({ 'f-prop': 'Austin' });
    expect(rows[1].custom).toBeUndefined();
  });

  it('changing the project clears the section and the last answer', async () => {
    importTasks.mockImplementation(() => Promise.resolve({ dryRun: true, errors: [{ row: 1, title: 'A', errors: ['Property is required in this project.'] }], rows: [] }));
    render(<AddSeveralModal defaults={{ text: 'A\nB', projectId: 'p1', sectionId: 's1' }} onClose={() => {}} />);
    expect(screen.getByLabelText('Section').value).toBe('s1');
    fireEvent.click(screen.getByRole('button', { name: /Add 2 Tasks/ }));
    await screen.findByTestId('add-several-problem');
    // ProjectPicker: open it and pick "No project".
    fireEvent.click(screen.getByText('Launch Plan'));
    const none = await screen.findAllByText('No project');
    fireEvent.click(none[none.length - 1]);
    expect(screen.queryByTestId('add-several-problem')).toBeNull();
    expect(screen.queryByLabelText('Section')).toBeNull();
    expect(importTasks.mock.calls[0][0].section_id).toBe('s1');
  });

  it('a locked project is shown, not picked, and the form\'s labels, start and status travel', async () => {
    importTasks.mockImplementation((body) => (body.dry_run ? Promise.resolve({ dryRun: true, errors: [], rows: [] }) : ok(1)));
    render(<AddSeveralModal defaults={{ text: 'A', projectId: 'p1', lockedProjectId: 'p1', tags: ['Q4'], startOn: '2026-11-01', status: 'in_progress', source: 'typed' }} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByLabelText('Project')).toHaveTextContent('Launch Plan');
    expect(screen.getByText(/do not carry over to a list/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add 1 Task/ }));
    await waitFor(() => expect(importTasks).toHaveBeenCalledTimes(2));
    expect(importTasks.mock.calls[1][0]).toMatchObject({ project_id: 'p1', source: 'typed' });
    expect(importTasks.mock.calls[1][0].rows[0]).toMatchObject({ tags: 'Q4', start: '2026-11-01', status: 'in_progress' });
  });

  it('Shift+Tab on a line with no indent leaves the box; Ctrl+Enter adds', async () => {
    importTasks.mockImplementation((body) => (body.dry_run ? Promise.resolve({ dryRun: true, errors: [], rows: [] }) : ok(2)));
    const onDone = vi.fn();
    render(<AddSeveralModal defaults={{ text: 'A\n\tB' }} onClose={() => {}} onDone={onDone} />);
    const box = screen.getByLabelText('Tasks');
    box.setSelectionRange(0, 0);   // on "A", not indented
    const out = fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
    expect(out).toBe(true);        // not prevented: focus may move on
    expect(box.value).toBe('A\n\tB');
    box.setSelectionRange(3, 3);   // on "\tB"
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
    expect(box.value).toBe('A\nB');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('says when the list has no due date', () => {
    render(<AddSeveralModal defaults={{ text: 'A\nB' }} onClose={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 tasks, no due date');
  });

  it('Tab in the box indents the line instead of leaving it', () => {
    render(<AddSeveralModal defaults={{ text: 'A\nB' }} onClose={() => {}} />);
    const box = screen.getByLabelText('Tasks');
    box.setSelectionRange(3, 3);   // on "B"
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(box.value).toBe('A\n\tB');
    expect(screen.getByRole('status')).toHaveTextContent('1 task, 1 subtask');
  });

  it('pastedTaskList reads a list off the clipboard and ignores a one-liner', () => {
    const ev = (t) => ({ clipboardData: { getData: () => t } });
    expect(pastedTaskList(ev('One'))).toBe('');
    expect(pastedTaskList(ev('One\nTwo'))).toBe('One\nTwo');
  });
});
