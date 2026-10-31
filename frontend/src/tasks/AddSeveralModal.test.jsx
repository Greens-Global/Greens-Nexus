import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AddSeveralModal from './AddSeveralModal';
import { pastedTaskList } from './batchPaste';

const importTasks = vi.fn();
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    projects: [{ id: 'p1', name: 'Launch Plan' }], teams: [], myEmail: 'me@greensglobal.com',
    sections: [{ id: 's1', projectId: 'p1', name: 'Phase 1', custom: true, position: 1 }],
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
