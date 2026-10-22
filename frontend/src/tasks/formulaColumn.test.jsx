import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FormulaFieldModal } from './FormulaColumn';
import { formulaHelpers, customFieldExportColumns, dateValue } from './formula';
import { sortTasks, matchesFilter, cfKey, EMPTY_FILTER, taskExportRows } from './lib';
import { exportPdf, exportExcel } from './exporting';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// The formula column editor, sorting/filtering by a computed value, and the
// exports writing computed values (Oct 22 2026).

const budget = { id: 'f-bud', name: 'Budget', type: 'number', appliesTo: ['task'], projectIds: [] };
const spent = { id: 'f-sp', name: 'Spent', type: 'number', appliesTo: ['task'], projectIds: [] };
const stage = { id: 'f-stage', name: 'Stage', type: 'select', appliesTo: ['task'], projectIds: [], options: [{ id: 'o1', label: 'Design', color: '#000' }] };
const left = { id: 'f-left', name: 'Left', type: 'formula', formula: '{Budget} - {Spent}', formulaFormat: { format: 'currency', decimals: 2 }, appliesTo: ['task'], projectIds: [], readOnly: true };
const bad = { id: 'f-bad', name: 'Bad', type: 'formula', formula: '{Budget} / {Spent}', formulaFormat: { format: 'number' }, appliesTo: ['task'], projectIds: [], readOnly: true };
const fields = [budget, spent, stage, left, bad];
const T = (id, bud, sp, extra = {}) => ({ id, title: `Task ${id}`, customFieldValues: { 'f-bud': bud, 'f-sp': sp, 'f-stage': 'o1' }, subtaskIds: [], ...extra });
const tasks = [T('a', 100, 30), T('b', 50, 0), T('c', 10, 9)];
const store = { tasks, customFields: fields, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), nameOf: (e) => e };

beforeEach(() => {
  globalThis.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
});

describe('sorting and filtering by a formula column', () => {
  const h = formulaHelpers(store);
  it('sorts by the computed value, errors last', () => {
    const asc = sortTasks(tasks, { key: cfKey('f-left'), dir: 'asc' }, fields, { formulaSortValue: h.formulaSortValue });
    expect(asc.map((t) => t.id)).toEqual(['c', 'b', 'a']);   // 1, 50, 70
    const byBad = sortTasks(tasks, { key: cfKey('f-bad'), dir: 'asc' }, fields, { formulaSortValue: h.formulaSortValue });
    expect(byBad.at(-1).id).toBe('b');                          // 50 / 0 = #Error goes last
  });
  it('filters on has a value / blank / error', () => {
    const f = { ...EMPTY_FILTER, customFields: { 'f-bad': ['__error'] } };
    expect(tasks.filter((t) => matchesFilter(t, f, null, h.formulaMatch)).map((t) => t.id)).toEqual(['b']);
    const filled = { ...EMPTY_FILTER, customFields: { 'f-bad': ['__filled'] } };
    expect(tasks.filter((t) => matchesFilter(t, filled, null, h.formulaMatch)).map((t) => t.id)).toEqual(['a', 'c']);
    // A select filter next to it still works the stored way.
    const both = { ...EMPTY_FILTER, customFields: { 'f-bad': ['__filled'], 'f-stage': ['o1'] } };
    expect(tasks.filter((t) => matchesFilter(t, both, null, h.formulaMatch))).toHaveLength(2);
  });
  it('applies the same filter to subtasks in an export', () => {
    const parent = { ...T('p', 1, 1), subtaskIds: ['k'] };
    const kid = { ...T('k', 5, 0), parentTaskId: 'p' };
    const s2 = { ...store, tasks: [parent, kid], taskById: { p: parent, k: kid } };
    const h2 = formulaHelpers(s2);
    const f = { ...EMPTY_FILTER, customFields: { 'f-bad': ['__filled'] } };
    expect(taskExportRows([parent], [parent, kid], f, s2.taskById, h2.formulaMatch).map((r) => r.task.id)).toEqual(['p']);
  });
});

describe('exports carry computed values', () => {
  const cols = customFieldExportColumns(fields, store);
  const byHeader = (h) => cols.find((c) => c.header === h);
  it('writes numbers as numbers, labels as labels, errors as #Error', () => {
    expect(byHeader('Left').get({ task: tasks[0] })).toBe(70);
    expect(byHeader('Left').display({ task: tasks[0] })).toBe('$70.00');
    expect(byHeader('Bad').get({ task: tasks[1] })).toBe('#Error');
    expect(byHeader('Stage').get({ task: tasks[0] })).toBe('Design');
    expect(byHeader('Budget').get({ task: tasks[0] })).toBe(100);
  });
  it('a date field exports as MM/DD/YYYY', () => {
    const due = { id: 'f-d', name: 'Install', type: 'date', appliesTo: ['task'] };
    const [c] = customFieldExportColumns([due], store);
    expect(c.get({ task: { customFieldValues: { 'f-d': '2026-10-04' } } })).toBe('10/04/2026');
    expect(dateValue('2026-02-30')).toBe(null);
  });
  it('the PDF uses the display text and Excel the raw value', async () => {
    const realBlob = globalThis.Blob;
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const col = { header: 'Left', get: vi.fn(() => 70), display: vi.fn(() => '$70.00') };
    await exportPdf({ title: 'T', columns: [col], rows: [{ task: tasks[0] }] });
    expect(col.display).toHaveBeenCalled();
    expect(col.get).not.toHaveBeenCalled();
    col.display.mockClear();
    await exportExcel({ title: 'T', columns: [col], rows: [{ task: tasks[0] }] });
    expect(col.get).toHaveBeenCalled();
    expect(col.display).not.toHaveBeenCalled();
    globalThis.Blob = realBlob;
  });
});

describe('Excel number formats on formula columns', () => {
  it('a percent column reads 25% and a currency one $70.00 in the sheet', async () => {
    const XLSX = await import('xlsx');
    const RealBlob = globalThis.Blob;
    const parts = [];
    globalThis.Blob = class extends RealBlob { constructor(p, o) { super(p, o); parts.push(p[0]); } };
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const pct = { id: 'f-pct', name: 'Used', type: 'formula', formula: '{Spent} / {Budget}', formulaFormat: { format: 'percent' } };
    const s2 = { ...store, customFields: [...fields, pct] };
    const cols = customFieldExportColumns([left, pct], s2);
    try {
      await exportExcel({ title: 'T', columns: cols, rows: [{ task: tasks[0] }] });
    } finally {
      globalThis.Blob = RealBlob;
    }
    const book = XLSX.read(new Uint8Array(parts.at(-1)), { type: 'array', cellNF: true });
    const sheet = book.Sheets[book.SheetNames[0]];
    expect(sheet.A2.v).toBe(70);
    expect(sheet.A2.z).toBe('"$"#,##0.00');
    expect(sheet.B2.v).toBe(0.3);
    expect(sheet.B2.z).toBe('0%');
  });
});

describe('the formula editor popup', () => {
  it('refuses a column name with braces or a built-in name', () => {
    render(<FormulaFieldModal store={store} previewTasks={tasks} onClose={() => {}} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '{Budget}' } });
    fireEvent.change(screen.getByLabelText('Column Name'), { target: { value: 'Progress' } });
    expect(screen.getByText(/is a built-in field name - pick another/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Column/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Column Name'), { target: { value: 'Left}' } });
    expect(screen.getByText(/cannot contain \{ or \}/)).toBeInTheDocument();
  });

  const openModal = (props = {}) => {
    const onSave = vi.fn(() => Promise.resolve({}));
    const onClose = vi.fn();
    render(<FormulaFieldModal store={store} previewTasks={tasks} onClose={onClose} onSave={onSave} {...props} />);
    return { onSave, onClose, box: screen.getByLabelText('Formula') };
  };

  it('autocompletes a field name after "{"', () => {
    const { box } = openModal();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '{Bud', selectionStart: 4 } });
    const opt = screen.getByRole('option', { name: '{Budget}' });
    fireEvent.mouseDown(opt);
    expect(box.value).toBe('{Budget}');
  });

  it('validates as you type and previews the first rows', () => {
    const { box } = openModal();
    fireEvent.change(box, { target: { value: '{Nope} + 1' } });
    expect(screen.getByRole('status')).toHaveTextContent('Unknown field {Nope}.');
    expect(screen.getByRole('button', { name: /Add Column/ })).toBeDisabled();
    fireEvent.change(box, { target: { value: '{Budget} - {Spent}' } });
    expect(screen.getByRole('status')).toHaveTextContent('Looks good.');
    expect(screen.getByText('Task a')).toBeInTheDocument();
    expect(screen.getByText('70')).toBeInTheDocument();   // Number format by default
  });

  it('shows a per-row error in the preview without failing the rest', () => {
    const { box } = openModal();
    fireEvent.change(box, { target: { value: '{Budget} / {Spent}' } });
    expect(screen.getByText(/#Error - Division by zero/)).toBeInTheDocument();
    expect(screen.getByText('3.33')).toBeInTheDocument();
  });

  it('saves the expression and its format', async () => {
    const { box, onSave, onClose } = openModal();
    fireEvent.change(screen.getByLabelText('Column Name'), { target: { value: 'Remaining' } });
    fireEvent.change(box, { target: { value: '{Budget} - {Spent}' } });
    fireEvent.change(screen.getByLabelText('Result Format'), { target: { value: 'currency' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Column/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: 'Remaining', description: '', type: 'formula', formula: '{Budget} - {Spent}',
      formula_format: { format: 'currency', decimals: 2 },
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says why when the server refuses', async () => {
    const { box } = openModal({ onSave: vi.fn(() => Promise.reject(Object.assign(new Error('Formula: Unknown field {X}.'), { status: 422 }))) });
    fireEvent.change(box, { target: { value: '{Budget}' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Column/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Formula: Unknown field {X}.');
  });

  it('is read-only for someone who cannot change it', () => {
    openModal({ field: left, readOnly: true });
    expect(screen.getByLabelText('Formula')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: /Save Formula/ })).toBeNull();
  });
});
