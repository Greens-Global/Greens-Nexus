import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

vi.mock('../api', () => ({
  api: {
    getTaskTablePrefs: vi.fn(() => Promise.resolve({ prefs: {} })),
    saveTaskTablePrefs: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

const { api } = await import('../api');
const { default: RichListView } = await import('./views/richlist');
const { __setTablePrefsCache } = await import('./tableCols');
const { computeTotal, formatTotal, totalKind, aggsFor } = await import('./totals');
const { createFormulaEngine } = await import('./formula');

// Column totals (Oct 22 2026): a footer under each group and one under the
// whole list, per column, chosen per person and project; off until chosen.

const budget = { id: 'f-bud', name: 'Budget', type: 'number', appliesTo: ['task'], projectIds: [] };
const spent = { id: 'f-sp', name: 'Spent', type: 'number', appliesTo: ['task'], projectIds: [] };
const left = { id: 'f-left', name: 'Left', type: 'formula', formula: '{Budget} - {Spent}', formulaFormat: { format: 'currency', decimals: 0 }, appliesTo: ['task'], projectIds: [], readOnly: true };
const ratio = { id: 'f-ratio', name: 'Ratio', type: 'formula', formula: '{Spent} / {Budget}', formulaFormat: { format: 'percent' }, appliesTo: ['task'], projectIds: [], readOnly: true };
const label = { id: 'f-lbl', name: 'Note', type: 'formula', formula: '"x"', formulaFormat: { format: 'text' }, appliesTo: ['task'], projectIds: [], readOnly: true };
const fields = [budget, spent, left, ratio, label];

const mk = (id, status, bud, sp, extra = {}) => ({
  id, title: `Task ${id}`, status, priority: 'medium', assigneeId: '', teamId: '', projectId: '', dueOn: '', startOn: '',
  estimateHours: null, followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false,
  code: id, customFieldValues: { ...(bud != null ? { 'f-bud': bud } : {}), ...(sp != null ? { 'f-sp': sp } : {}) }, ...extra,
});
const tasks = [
  mk('a', 'not_started', 100, 40, { estimateHours: 2 }),
  mk('b', 'not_started', 50, 0, { estimateHours: 1.5 }),
  mk('c', 'in_progress', 10, null),
  mk('d', 'in_progress', 0, 5),   // Ratio = 5 / 0 -> #Error
];

describe('totals math', () => {
  const engine = createFormulaEngine({ customFields: fields });
  it('sums, averages and bounds a number column, skipping blanks', () => {
    expect(computeTotal(tasks, 'f-sp', 'sum', { field: spent })).toBe(45);
    expect(computeTotal(tasks, 'f-sp', 'avg', { field: spent })).toBe(15);
    expect(computeTotal(tasks, 'f-sp', 'min', { field: spent })).toBe(0);
    expect(computeTotal(tasks, 'f-sp', 'max', { field: spent })).toBe(40);
    expect(computeTotal(tasks, 'f-sp', 'count', { field: spent })).toBe(3);
    expect(computeTotal([], 'f-sp', 'avg', { field: spent })).toBe(null);
  });
  it('totals a formula column by its computed value; errors are left out', () => {
    expect(computeTotal(tasks, 'f-left', 'sum', { field: left, engine })).toBe(60 + 50 + 10 - 5);
    expect(computeTotal(tasks, 'f-ratio', 'count', { field: ratio, engine })).toBe(3);
    expect(computeTotal(tasks, 'f-lbl', 'filled', { field: label, engine })).toBe(4);
  });
  it('hours columns and Count Filled on the others', () => {
    expect(computeTotal(tasks, 'estimate', 'sum')).toBe(3.5);
    expect(formatTotal(3.5, 'sum', 'estimate')).toBe('3h 30m');
    expect(computeTotal(tasks, 'due', 'filled')).toBe(0);
    expect(computeTotal(tasks, 'status', 'filled')).toBe(4);
  });
  it('formats like the column', () => {
    expect(formatTotal(1234.5, 'sum', 'f-left', left)).toBe('$1,235');
    expect(formatTotal(0.5, 'avg', 'f-ratio', ratio)).toBe('50%');
    expect(formatTotal(1234.567, 'sum', 'f-sp', spent)).toBe('1,234.57');
    expect(formatTotal(12, 'count', 'f-left', left)).toBe('12');
    expect(formatTotal(null, 'avg', 'f-sp', spent)).toBe('-');
  });
  it('offers the right choices per column', () => {
    expect(totalKind('task')).toBe(null);
    expect(totalKind('checkbox')).toBe(null);
    expect(totalKind('estimate')).toBe('number');
    expect(totalKind('f-left', left)).toBe('number');
    expect(totalKind('f-lbl', label)).toBe('other');
    expect(totalKind('status')).toBe('other');
    expect(aggsFor('other').map((a) => a.label)).toEqual(['Count Filled']);
    expect(aggsFor('number').map((a) => a.label)).toEqual(['Sum', 'Average', 'Min', 'Max', 'Count']);
  });
});

const store = {
  tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])), customFields: fields, customStatuses: [],
  projects: [], teams: [], loading: false,
  statusOrder: ['not_started', 'in_progress'],
  statusMeta: {
    not_started: { label: 'Not Started', color: '#888', tint: '#eee' },
    in_progress: { label: 'In Progress', color: '#4488ff', tint: '#e6f0ff' },
  },
  projectName: () => 'Project', teamById: () => null, teamName: () => '', nameOf: (e) => e,
  setStatus: () => {}, toggleComplete: () => {}, updateTask: () => Promise.resolve({}), createTask: () => Promise.resolve({}),
};
const ctx = { nameOf: () => '', projectName: () => 'Project', teamName: () => '', customFields: fields };
const renderList = (props = {}) => render(
  <RichListView visible={tasks} group="status" ctx={ctx} store={store} people={[]} selected={new Set()}
    toggleSel={() => {}} setSelected={() => {}} onOpen={() => {}} lockedProjectId="" hidden={new Set()} setHidden={() => {}} {...props} />,
);

describe('the totals footer', () => {
  beforeEach(() => {
    api.saveTaskTablePrefs.mockClear();
    globalThis.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  });

  it('is not there until the person turns it on', () => {
    act(() => __setTablePrefsCache({ richlist: {} }));
    const { container } = renderList();
    expect(container.querySelector('[data-totals-row]')).toBeNull();
  });

  it('shows per-group and overall totals that follow the rows on screen', () => {
    act(() => __setTablePrefsCache({ richlist: { totals: { _: { show: true, cols: { 'f-sp': 'sum', 'f-left': 'sum' } } } } }));
    const { container } = renderList();
    const groupRows = container.querySelectorAll('[data-totals-row="group"]');
    const all = container.querySelector('[data-totals-row="all"]');
    expect(groupRows).toHaveLength(2);
    // Not Started: Spent 40 + 0; Left $60 + $50. In Progress: Spent 5; Left $10 + -$5.
    expect(groupRows[0].textContent).toContain('40');
    expect(groupRows[0].textContent).toContain('$110');
    expect(groupRows[1].textContent).toContain('$5');
    expect(all.textContent).toContain('All Tasks (4)');
    expect(all.textContent).toContain('45');
    expect(all.textContent).toContain('$115');
    // Filtered down to one task: the totals follow.
    const { container: c2 } = renderList({ visible: [tasks[0]] });
    expect(c2.querySelector('[data-totals-row="all"]').textContent).toContain('$60');
  });

  it('picks a total from the footer menu and saves it for this project', () => {
    act(() => __setTablePrefsCache({ richlist: { totals: { 'p-1': { show: true, cols: {} } } } }));
    const { container } = renderList({ lockedProjectId: 'p-1' });
    const all = container.querySelector('[data-totals-row="all"]');
    const calc = within(all).getAllByText('Calculate');
    expect(calc.length).toBeGreaterThan(0);
    // Budget column's footer cell: open its menu and pick Average.
    fireEvent.click(calc[calc.length - 5]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Average/ }));
    expect(api.saveTaskTablePrefs).toHaveBeenCalledWith('richlist', {
      totals: { 'p-1': { show: true, cols: expect.objectContaining({}) } },
    });
    const saved = api.saveTaskTablePrefs.mock.calls.at(-1)[1].totals['p-1'].cols;
    expect(Object.values(saved)).toEqual(['avg']);
  });

  it('is hidden on a phone', () => {
    globalThis.matchMedia = (q) => ({ matches: q.includes('max-width: 640px'), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
    act(() => __setTablePrefsCache({ richlist: { totals: { _: { show: true, cols: { 'f-sp': 'sum' } } } } }));
    const { container } = renderList();
    expect(container.querySelector('[data-totals-row]')).toBeNull();
  });
});

describe('formula cells in the list', () => {
  it('shows computed values and a muted #Error with the reason', () => {
    act(() => __setTablePrefsCache({ richlist: {} }));
    renderList();
    expect(screen.getAllByText('$60').length).toBeGreaterThan(0);
    const errs = screen.getAllByText('#Error');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toHaveAttribute('title', 'Division by zero.');
  });
});
