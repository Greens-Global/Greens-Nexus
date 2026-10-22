import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Import Tasks wizard (Oct 22 2026): Upload -> Map Columns -> Preview -> Done.
// The file reader is stubbed (importing.js has its own tests); the server's
// dry run and real run are the store's importTasks.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 1, myEmail: 'ed@greensglobal.com' }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

let table;
vi.mock('./importing', async () => {
  const actual = await vi.importActual('./importing');
  return {
    ...actual,
    readWorkbook: vi.fn(async () => ({ SheetNames: ['Plan', 'Notes'], Sheets: {} })),
    sheetTable: vi.fn(async () => table),
    downloadText: vi.fn(),
  };
});

const dryReport = {
  dryRun: true, total: 2, valid: 1, skipped: 1, newSections: [], newOptions: [], droppedPeople: [],
  errors: [{ row: 3, title: '', errors: ['Title is required.'] }],
  rows: [
    { row: 2, title: 'Pour slab', parentRow: null, depth: 0, status: 'not_started', priority: 'high',
      dueOn: '2026-03-04', startOn: '', assignees: ['ana@greensglobal.com'], tags: [], section: '',
      newSection: false, errors: [], warnings: ['Assignee "Zed" is not in the Nexus directory - left off.'] },
    { row: 3, title: '', parentRow: null, depth: 0, status: 'not_started', priority: 'medium',
      dueOn: '', startOn: '', assignees: [], tags: [], section: '', newSection: false,
      errors: ['Title is required.'], warnings: [] },
  ],
};
const done = {
  dryRun: false, created: 1, skipped: 1, errors: dryReport.errors, droppedPeople: [],
  newSections: [], newOptions: [], taskIds: ['t1'], topLevelIds: ['t1'], projectId: 'p1',
};

const store = {
  myEmail: 'ed@greensglobal.com',
  nameOf: (e) => (e === 'ana@greensglobal.com' ? 'Ana Lopez' : e),
  projects: [
    { id: 'p1', name: 'Launch Plan', accessLevel: 'restricted', ownerId: 'olive@greensglobal.com', memberRoles: { 'ed@greensglobal.com': 'editor' } },
    { id: 'p2', name: 'Read Only', accessLevel: 'restricted', ownerId: 'olive@greensglobal.com', memberRoles: { 'ed@greensglobal.com': 'viewer' } },
  ],
  sections: [{ id: 's1', projectId: 'p1', name: 'Phase 1', custom: true, position: 1 }],
  customFields: [{ id: 'f-phase', name: 'Phase', type: 'select', projectIds: ['p1'], options: [] }],
  statusMeta: {},
  importTasks: vi.fn(async (body) => (body.dry_run ? dryReport : done)),
};
vi.mock('./TasksContext', () => ({ useTasks: () => store }));

import ImportTasksModal from './ImportTasksModal';
import { downloadText } from './importing';

const file = () => new File(['x'], 'plan.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

async function upload() {
  fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file()] } });
  await screen.findByText('plan.xlsx');
}

describe('ImportTasksModal', () => {
  beforeEach(() => {
    store.importTasks.mockClear();
    downloadText.mockClear();
    table = {
      headers: ['Task Name', 'Owner', 'Due', 'Phase', 'Budget'],
      rows: [
        { n: 2, raw: ['Pour slab', 'Ana Lopez', 46115, 'Build', '12'], text: ['Pour slab', 'Ana Lopez', '4/3/26', 'Build', '12'] },
        { n: 3, raw: ['', 'Zed', '', '', ''], text: ['', 'Zed', '', '', ''] },
      ],
    };
  });

  it('walks Upload -> Map -> Preview -> Done and imports what the dry run showed', async () => {
    const onViewImported = vi.fn();
    render(<ImportTasksModal projectId="p1" onClose={() => {}} onViewImported={onViewImported} />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    // Only projects the person can add work to.
    const project = screen.getByLabelText('Project');
    expect([...project.options].map((o) => o.textContent)).toEqual(['Launch Plan']);
    await upload();
    expect(screen.getByText('2 rows found')).toBeInTheDocument();
    expect(screen.getByLabelText('Sheet')).toBeInTheDocument();   // two sheets -> a picker

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Import Task Name as')).toHaveValue('title');
    expect(screen.getByLabelText('Import Owner as')).toHaveValue('assignees');
    expect(screen.getByLabelText('Import Due as')).toHaveValue('due');
    expect(screen.getByLabelText('Import Phase as')).toHaveValue('cf:f-phase');
    expect(screen.getByLabelText('Import Budget as')).toHaveValue('');
    // A select field is mapped: only a manager may add options.
    expect(screen.getByLabelText(/Add Missing Options/)).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('preview-row-2');
    const dry = store.importTasks.mock.calls[0][0];
    expect(dry).toMatchObject({ project_id: 'p1', dry_run: true, file_name: 'plan.xlsx', add_missing_options: false });
    expect(dry.rows[0]).toEqual({ row: 2, title: 'Pour slab', assignees: 'Ana Lopez', due: '2026-04-03', custom: { 'f-phase': 'Build' } });
    // Errors and warnings per row; a row with an error cannot be ticked.
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(screen.getByText(/is not in the Nexus directory/)).toBeInTheDocument();
    expect(screen.getByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByText('03/04/2026')).toBeInTheDocument();
    expect(screen.getByLabelText('Import row 3')).toBeDisabled();
    expect(screen.getByLabelText('Notify Assignees', { exact: false })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 Task' }));
    await screen.findByText('Imported 1 Task');
    const real = store.importTasks.mock.calls[1][0];
    expect(real).toMatchObject({ dry_run: false, notify_assignees: false });

    fireEvent.click(screen.getByRole('button', { name: /Download Error Report/ }));
    expect(downloadText).toHaveBeenCalledTimes(1);
    expect(downloadText.mock.calls[0][0]).toContain('Title is required.');
    fireEvent.click(screen.getByRole('button', { name: 'View Imported Tasks' }));
    expect(onViewImported).toHaveBeenCalledWith(done);
  });

  it('cannot preview until a column is the task name', async () => {
    table = { headers: ['Thing', 'Owner'], rows: [{ n: 2, raw: ['a', 'b'], text: ['a', 'b'] }] };
    render(<ImportTasksModal projectId="p1" onClose={() => {}} />);
    await upload();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByText('Choose the column that holds the task name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Import Thing as'), { target: { value: 'title' } });
    expect(screen.getByRole('button', { name: 'Preview' })).not.toBeDisabled();
  });

  it('an excluded row is not sent, and Notify Assignees goes through when ticked', async () => {
    store.importTasks.mockImplementationOnce(async () => ({
      ...dryReport, valid: 2, skipped: 0, errors: [],
      rows: [dryReport.rows[0], { ...dryReport.rows[1], title: 'Second', errors: [] }],
    }));
    table.rows[1] = { n: 3, raw: ['Second', '', '', '', ''], text: ['Second', '', '', '', ''] };
    render(<ImportTasksModal projectId="p1" onClose={() => {}} />);
    await upload();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('preview-row-3');
    expect(screen.getByRole('button', { name: 'Import 2 Tasks' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Import row 3'));
    fireEvent.click(screen.getByLabelText('Notify Assignees', { exact: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 Task' }));
    await waitFor(() => expect(store.importTasks).toHaveBeenCalledTimes(2));
    const real = store.importTasks.mock.calls[1][0];
    expect(real.rows.map((r) => r.row)).toEqual([2]);
    expect(real.notify_assignees).toBe(true);
  });

  it('refuses more than 2,000 rows before anything is sent', async () => {
    table = { headers: ['Task Name'], rows: Array.from({ length: 2001 }, (_, i) => ({ n: i + 2, raw: [`T${i}`], text: [`T${i}`] })) };
    render(<ImportTasksModal projectId="p1" onClose={() => {}} />);
    await upload();
    expect(screen.getByText(/Split it into files of 2,000 rows or fewer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('says why a file was refused', async () => {
    render(<ImportTasksModal projectId="p1" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File(['x'], 'plan.pdf')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a .csv, .xlsx or .xls file.');
  });
});
