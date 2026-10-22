import fs from 'fs';
import path from 'path';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';

// Conditional row colors (Neil, Oct 22 2026) on screen: rows and cards wear
// the first matching rule's color as an accent (+ a faint tint on rows),
// selection still wins, the key and the per-person Show Row Colors switch,
// and the editor.

const saveTaskTablePrefs = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: {
    getTaskTablePrefs: () => Promise.resolve({ prefs: {} }),
    saveTaskTablePrefs: (...a) => saveTaskTablePrefs(...a),
    resetTaskTablePrefs: () => Promise.resolve({}),
    resetAllTaskTablePrefs: () => Promise.resolve({}),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
const dialogConfirm = vi.fn(() => Promise.resolve(true));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => dialogConfirm(...a), alert: () => Promise.resolve() } }));

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const LONG_AGO = '2020-01-15';
const base = { status: 'not_started', priority: 'medium', assigneeId: '', assigneeIds: [], teamId: '', projectId: 'p1', startOn: '', estimateHours: null, followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], completed: false, customFieldValues: {} };
const tasks = [
  { ...base, id: 't1', code: 'T-1', title: 'Late task', dueOn: LONG_AGO },
  { ...base, id: 't2', code: 'T-2', title: 'Urgent task', dueOn: '', priority: 'urgent' },
  { ...base, id: 't3', code: 'T-3', title: 'Plain task', dueOn: '' },
];
const RULES = [
  { id: 'r-over', name: 'Overdue', color: 'red', bold: true, enabled: true, match: 'all', conditions: [{ field: 'due', op: 'overdue' }] },
  { id: 'r-urg', name: 'Urgent', color: 'amber', bold: false, enabled: true, match: 'all', conditions: [{ field: 'priority', op: 'is', value: 'urgent' }] },
];
const statusMeta = {
  not_started: { label: 'Not Started', color: '#888', tint: '#eee' },
  in_progress: { label: 'In Progress', color: '#4488ff', tint: '#e6f0ff' },
  completed: { label: 'Completed', color: '#44aa44', tint: '#e8f5e8' },
};
const store = {
  tasks, taskById: Object.fromEntries(tasks.map((t) => [t.id, t])),
  customFields: [], customStatuses: [], projects: [], teams: [], loading: false,
  statusOrder: ['not_started', 'in_progress', 'completed'], statusMeta,
  statusOrderFor: () => ['not_started', 'in_progress', 'completed'],
  myEmail: 'me@greensglobal.com', nameOf: (e) => e,
  projectName: () => 'Project', teamById: () => null, teamName: () => '',
  setStatus: () => {}, toggleComplete: () => {}, updateTask: () => Promise.resolve({}), createTask: () => Promise.resolve({}),
  addComment: () => Promise.resolve(), createCustomStatus: () => Promise.resolve(), deleteCustomStatus: () => Promise.resolve(),
};
vi.mock('./TasksContext', async (importOriginal) => ({ ...(await importOriginal()), useTasks: () => store }));

const { default: RichListView } = await import('./views/richlist');
const { default: BoardView } = await import('./views/board');
const { CalendarView } = await import('./views/extras');
const { __setTablePrefsCache } = await import('./tableCols');
const { RowColorsProvider, useRowColorScope, useRuleContext, useToday } = await import('./rowColorState');
const { RowColorLegend } = await import('./RowColors');
const { colorMap } = await import('./colorRules');
const { default: ColorRulesEditor } = await import('./ColorRulesEditor');

const ctx = { nameOf: () => '', projectName: () => 'Project', teamName: () => '', customFields: [] };
const listProps = { group: 'none', ctx, store, people: [], toggleSel: () => {}, onOpen: () => {}, onSelectAll: () => {}, lockedProjectId: '', hidden: new Set(), setHidden: () => {} };
const mapFor = (rules = RULES) => colorMap(rules, tasks, { today: TODAY, me: 'me@greensglobal.com', statusMeta, fieldsById: new Map() });
const rowOf = (title) => screen.getByText(title).closest('[data-task-row]');

beforeEach(() => {
  __setTablePrefsCache({});
  saveTaskTablePrefs.mockClear();
  dialogConfirm.mockClear();
});

describe('list rows', () => {
  it('a matching row gets the accent and tint in its rule color; others stay plain', () => {
    render(<RowColorsProvider map={mapFor()}><RichListView visible={tasks} selected={new Set()} {...listProps} /></RowColorsProvider>);
    const late = rowOf('Late task');
    expect(late.className).toContain('nx-rc');
    expect(late.className).toContain('nx-rc-tint');
    expect(late.style.getPropertyValue('--rc')).toBe('#dc2626');
    expect(late.getAttribute('data-row-color')).toBe('r-over');
    expect(rowOf('Urgent task').style.getPropertyValue('--rc')).toBe('#d97706');
    expect(rowOf('Plain task').className).not.toContain('nx-rc');
    // Said in words for a screen reader, too.
    expect(within(late).getByText(', colored Overdue')).toBeInTheDocument();
  });

  it('Bold Title sets the name in bold; a rule without it leaves the name alone', () => {
    render(<RowColorsProvider map={mapFor()}><RichListView visible={tasks} selected={new Set()} {...listProps} /></RowColorsProvider>);
    expect(screen.getByText('Late task').style.fontWeight).toBe('700');
    expect(screen.getByText('Urgent task').style.fontWeight).toBe('600');
  });

  it('a selected colored row still reads as selected: its own selected background, the tint dropped by CSS', () => {
    render(<RowColorsProvider map={mapFor()}><RichListView visible={tasks} selected={new Set(['t1'])} {...listProps} /></RowColorsProvider>);
    const late = rowOf('Late task');
    expect(late.getAttribute('data-selected')).toBe('true');
    expect(late.style.background).toBe('rgba(37, 99, 235, 0.1)');
    const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
    // The tint is a background-image that skips selected rows, so the hover
    // rule (`background: ... !important`) and the selected fill both win.
    expect(css).toMatch(/\.nx-rc-tint:not\(\[data-selected="true"\]\) \{ background-image: linear-gradient\(/);
    expect(css).toMatch(/\[data-theme="dark"\] \.nx-rc-tint:not\(\[data-selected="true"\]\)/);
    expect(css).toMatch(/\.nx-row-hover:hover \{ background: [^;]+ !important; \}/);
    // Rows set their band with an inline `background` shorthand, so the tint
    // must be !important to show at all - and a hovered row drops it.
    expect(css).toMatch(/\.nx-rc-tint:not\(\[data-selected="true"\]\) \{ background-image: [^}]+!important; \}/);
    expect(css).toMatch(/\.nx-row-hover\.nx-rc-tint:hover \{ background-image: none !important; \}/);
    // Never a solid fill: the tint is a small share of the color.
    const tint = css.match(/\.nx-rc-tint:not\(\[data-selected="true"\]\) \{ background-image: linear-gradient\(color-mix\(in srgb, var\(--rc\) (\d+)%/);
    expect(Number(tint[1])).toBeLessThanOrEqual(12);
  });

  it('outside a provider (Home widgets and the like) nothing is colored', () => {
    render(<RichListView visible={tasks} selected={new Set()} {...listProps} />);
    expect(rowOf('Late task').className).not.toContain('nx-rc');
  });
});

describe('board, calendar', () => {
  it('a board card wears an inset accent and no tint, and says its color', () => {
    render(<RowColorsProvider map={mapFor()}><BoardView visible={tasks} ctx={ctx} store={store} onOpen={() => {}} lockedProjectId="p1" /></RowColorsProvider>);
    const card = rowOf('Late task');
    expect(card.className).toBe('nx-rc nx-rc-card');
    expect(card.getAttribute('aria-label')).toContain('Overdue');
    expect(rowOf('Plain task').className).toBe('');
  });

  it('a calendar chip gets a thin bar in the rule color', () => {
    const dueToday = { ...base, id: 'c1', title: 'Due today', dueOn: TODAY, priority: 'urgent' };
    const map = colorMap(RULES, [dueToday], { today: TODAY, statusMeta, fieldsById: new Map() });
    render(<RowColorsProvider map={map}><CalendarView tasks={[dueToday]} onOpen={() => {}} /></RowColorsProvider>);
    const chip = document.querySelector('[data-row-color="r-urg"]');
    expect(chip).not.toBeNull();
    expect(chip.style.boxShadow).toContain('inset 3px 0 0');
  });
});

function Screen({ rules = RULES, canEdit = true, onEdit = () => {} }) {
  const ruleCtx = useRuleContext({ projectId: 'p1' });
  const scope = useRowColorScope({ rules, tasks, ruleCtx });
  return (
    <>
      <RowColorLegend scope={scope} canEdit={canEdit} onEdit={onEdit} />
      <RowColorsProvider map={scope.map}><RichListView visible={tasks} selected={new Set()} {...listProps} /></RowColorsProvider>
    </>
  );
}

describe('legend and the Show Row Colors switch', () => {
  it('lists each rule in force with its count here; colors on by default', () => {
    render(<Screen />);
    const key = screen.getByRole('list', { name: 'Row color key' });
    expect(within(key).getByText('Overdue')).toBeInTheDocument();
    expect(within(key).getByText('Urgent')).toBeInTheDocument();
    expect(within(key).getAllByText('1')).toHaveLength(2);
    expect(screen.getByRole('switch', { name: 'Show Row Colors' })).toHaveAttribute('aria-checked', 'true');
    expect(rowOf('Late task').className).toContain('nx-rc');
  });

  it('turning colors off clears every row and is remembered in the profile', () => {
    render(<Screen />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show Row Colors' }));
    expect(rowOf('Late task').className).not.toContain('nx-rc');
    expect(saveTaskTablePrefs).toHaveBeenCalledWith('rowColors', { data: { hidden: true } });
  });

  it('starts off for someone who switched it off', () => {
    __setTablePrefsCache({ rowColors: { data: { hidden: true } } });
    render(<Screen />);
    expect(screen.getByRole('switch', { name: 'Show Row Colors' })).toHaveAttribute('aria-checked', 'false');
    expect(rowOf('Late task').className).not.toContain('nx-rc');
  });

  it('the key folds away and stays folded', () => {
    render(<Screen />);
    fireEvent.click(screen.getByRole('button', { name: /Colors/ }));
    expect(screen.queryByRole('list', { name: 'Row color key' })).toBeNull();
    expect(saveTaskTablePrefs).toHaveBeenCalledWith('rowColors', { data: { legendClosed: true } });
  });

  it('a viewer sees the key but no Edit Rules; an editor gets it', () => {
    const { unmount } = render(<Screen canEdit={false} />);
    expect(screen.getByTestId('row-color-legend')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit Rules/ })).toBeNull();
    unmount();
    const onEdit = vi.fn();
    render(<Screen onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit Rules/ }));
    expect(onEdit).toHaveBeenCalled();
  });

  it('on a phone the key starts folded to one line, and opens on a tap', () => {
    function Phone() {
      const ruleCtx = useRuleContext({ projectId: 'p1' });
      const scope = useRowColorScope({ rules: RULES, tasks, ruleCtx });
      return <RowColorLegend scope={scope} compact />;
    }
    render(<Phone />);
    expect(screen.queryByRole('list', { name: 'Row color key' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Colors/ }));
    expect(screen.getByRole('list', { name: 'Row color key' })).toBeInTheDocument();
    // The desktop's folded / open choice is left alone.
    expect(saveTaskTablePrefs).not.toHaveBeenCalled();
  });

  it('no key at all when nothing can color (no rules, all off, or all broken)', () => {
    const { container, rerender } = render(<Screen rules={[]} />);
    expect(container.querySelector('[data-testid="row-color-legend"]')).toBeNull();
    rerender(<Screen rules={RULES.map((r) => ({ ...r, enabled: false }))} />);
    expect(container.querySelector('[data-testid="row-color-legend"]')).toBeNull();
    rerender(<Screen rules={[{ ...RULES[0], conditions: [{ field: 'cf:deleted', op: 'is_empty' }] }]} />);
    expect(container.querySelector('[data-testid="row-color-legend"]')).toBeNull();
  });
});

describe('the editor', () => {
  const edCtx = { fieldsById: new Map(), statusMeta, statusOrder: store.statusOrder, statusOptions: store.statusOrder.map((id) => ({ id, label: statusMeta[id].label })), sections: [], me: 'me@greensglobal.com', nameOf: (e) => e, people: [] };
  const open = (props = {}) => {
    const onSave = props.onSave || vi.fn(() => Promise.resolve());
    render(<ColorRulesEditor rules={RULES} onSave={onSave} onClose={() => {}} ctx={edCtx} countTasks={tasks} statusOrder={store.statusOrder} {...props} />);
    return onSave;
  };
  const rows = () => screen.getAllByTestId('rule-row');

  it('lists rules in order with their sentence and how many tasks each colors', () => {
    open();
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]).getByText('Overdue')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('Due Date is overdue')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('Matches 1 task')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('Priority is Urgent')).toBeInTheDocument();
  });

  it('flags a rule on a deleted field as Needs Attention', () => {
    open({ rules: [{ ...RULES[0], conditions: [{ field: 'cf:gone', op: 'is_empty' }] }] });
    expect(within(rows()[0]).getByText('Needs Attention')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('A deleted field')).toBeInTheDocument();
  });

  it('a suggestion is added with one click - and only then', () => {
    const onSave = open();
    expect(onSave).not.toHaveBeenCalled();
    // "Overdue" is already a rule here, so it is not suggested again.
    expect(screen.queryByRole('button', { name: 'Add Overdue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Due In Next 7 Days' }));
    const saved = onSave.mock.calls[0][0];
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({ name: 'Due In Next 7 Days', color: 'amber', enabled: true });
    expect(saved[2].id).toBeTruthy();
  });

  it('switching a rule off saves it disabled, kept in place', () => {
    const onSave = open();
    fireEvent.click(screen.getByRole('switch', { name: 'Turn off Overdue' }));
    expect(onSave.mock.calls[0][0].map((r) => [r.id, r.enabled])).toEqual([['r-over', false], ['r-urg', true]]);
  });

  it('reorders from the keyboard on the drag handle', () => {
    const onSave = open();
    fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Overdue/ }), { key: 'ArrowDown' });
    expect(onSave.mock.calls[0][0].map((r) => r.id)).toEqual(['r-urg', 'r-over']);
  });

  it('on a touch screen the rows reorder with Move Up / Move Down instead of a drag', () => {
    const before = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 640px') || q.includes('pointer: coarse'), media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
    try {
      const onSave = open();
      expect(screen.queryByRole('button', { name: /Reorder Overdue/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Move Overdue Up' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Move Urgent Up' }));
      expect(onSave.mock.calls[0][0].map((r) => r.id)).toEqual(['r-urg', 'r-over']);
    } finally {
      window.matchMedia = before;
    }
  });

  it('duplicates and deletes (after asking)', async () => {
    const onSave = open();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Overdue' }));
    expect(onSave.mock.calls[0][0].map((r) => r.name)).toEqual(['Overdue', 'Overdue (copy)', 'Urgent']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Urgent' })).not.toBeDisabled());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete Urgent' })); });
    expect(dialogConfirm).toHaveBeenCalled();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  it('a new rule: name, live count, preview, save', async () => {
    const onSave = open({ rules: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));
    // Starts as "Due Date is overdue": one of the three tasks.
    expect(screen.getByText('Matches 1 task in this project')).toBeInTheDocument();
    expect(screen.getByTestId('rule-preview').textContent).toContain('Late task');
    expect(screen.getByRole('button', { name: 'Save Rule' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rule Name'), { target: { value: 'Late' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Purple' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Rule' })); });
    expect(onSave.mock.calls[0][0]).toEqual([expect.objectContaining({ name: 'Late', color: 'purple', conditions: [{ field: 'due', op: 'overdue' }] })]);
    // Back on the list.
    expect(screen.getByRole('button', { name: 'Add Rule' })).toBeInTheDocument();
  });

  it('changing the field resets the comparison and value to fit it', () => {
    open({ rules: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'priority' } });
    expect(screen.getByLabelText('Condition 1 comparison').value).toBe('is');
    // Priority options are soft chips; Urgent is the default pick.
    expect(screen.getByRole('radio', { name: 'Urgent' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Matches 1 task in this project')).toBeInTheDocument();
  });

  it('says what a rule actually colors when earlier rules take some of its matches', () => {
    const busy = { id: 'r-busy', name: 'Busy', color: 'teal', bold: false, enabled: true, match: 'all',
      conditions: [{ field: 'priority', op: 'is_any_of', value: ['urgent', 'medium'] }] };
    open({ rules: [...RULES, busy] });
    expect(within(rows()[2]).getByTestId('rule-count').textContent).toBe('Matches 3 tasks - colors 1, 2 go to an earlier rule');
    expect(within(rows()[0]).getByTestId('rule-count').textContent).toBe('Matches 1 task');
  });

  it('one condition reads "this is true"; two offer all / any', () => {
    open({ rules: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));
    expect(screen.getByText('Color a task when this is true')).toBeInTheDocument();
    expect(screen.queryByLabelText('Match')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add Condition/ }));
    expect(screen.getByLabelText('Match')).toBeInTheDocument();
  });

  it('the palette is one tab stop that the arrow keys move through', () => {
    open({ rules: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));
    const red = screen.getByRole('radio', { name: 'Red' });
    expect(red).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Amber' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(red, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Amber' })).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Amber' }));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Gray' })).toHaveAttribute('aria-checked', 'true');   // wraps around
  });

  it('a keyboard move is announced', () => {
    open();
    fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Overdue/ }), { key: 'ArrowDown' });
    expect(screen.getByRole('status').textContent).toBe('Moved Overdue to 2 of 2');
  });

  it('a conflict (409) swaps in the newer list and says so', async () => {
    const latest = [{ id: 'r-new', name: "Someone Else's", color: 'purple', bold: false, enabled: true, match: 'all', conditions: [{ field: 'completed', op: 'is_true' }] }];
    function Harness() {
      const [rules, setRules] = React.useState(RULES);
      const onSave = () => {
        // What store.saveColorRules does on a 409: take the project the server sent, then throw.
        setRules(latest);
        const e = new Error('Someone else changed these color rules. The latest version is shown now.');
        e.status = 409;
        return Promise.reject(e);
      };
      return <ColorRulesEditor rules={rules} onSave={onSave} onClose={() => {}} ctx={edCtx} countTasks={tasks} statusOrder={store.statusOrder} />;
    }
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Turn off Overdue' })); });
    expect(screen.getByRole('alert').textContent).toContain('Someone else changed these color rules');
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText("Someone Else's")).toBeInTheDocument();
  });

  it('on a phone: 40px controls, and Edit / Duplicate / Delete behind a "..." menu', async () => {
    const before = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 640px') || q.includes('pointer: coarse'), media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
    try {
      const onSave = open();
      expect(screen.queryByRole('button', { name: 'Edit Overdue' })).toBeNull();
      const up = screen.getByRole('button', { name: 'Move Urgent Up' });
      expect(up.style.minWidth).toBe('40px');
      expect(up.style.minHeight).toBe('40px');
      expect(screen.getByRole('switch', { name: 'Turn off Overdue' }).style.minHeight).toBe('40px');
      const more = screen.getByRole('button', { name: 'More actions for Urgent' });
      expect(more.style.minHeight).toBe('40px');
      fireEvent.click(more);
      await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ })); });
      expect(dialogConfirm).toHaveBeenCalled();
      expect(onSave.mock.calls.at(-1)[0].map((r) => r.id)).toEqual(['r-over']);
    } finally {
      window.matchMedia = before;
    }
  });

  it("the personal editor talks about your rules, not a project's", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...RULES[0], id: `p${i}`, name: `R${i}` }));
    open({ rules: many, personal: true });
    expect(screen.getByText('You can have up to 20 rules.')).toBeInTheDocument();
    expect(screen.queryByText(/A project can have/)).toBeNull();
  });

  it('a failed save says why and leaves the list as it was', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('You need at least editor access to "Ops".')));
    open({ onSave });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Turn off Overdue' })); });
    expect(screen.getByRole('alert').textContent).toContain('editor access');
    expect(screen.getByRole('switch', { name: 'Turn off Overdue' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('today moves on by itself', () => {
  it('re-reads the date at local midnight and when the tab comes back', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 22, 23, 59, 0));
      function Show() { return <span data-testid="today">{useToday()}</span>; }
      render(<Show />);
      expect(screen.getByTestId('today').textContent).toBe('2026-10-22');
      act(() => { vi.advanceTimersByTime(2 * 60 * 1000); });   // past midnight: the timer fires
      expect(screen.getByTestId('today').textContent).toBe('2026-10-23');
      vi.setSystemTime(new Date(2026, 9, 25, 9, 0, 0));        // a laptop that slept for two days
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(screen.getByTestId('today').textContent).toBe('2026-10-25');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the key on a phone', () => {
  it('keeps a word beside the switch', () => {
    function Phone() {
      const ruleCtx = useRuleContext({ projectId: 'p1' });
      const scope = useRowColorScope({ rules: RULES, tasks, ruleCtx });
      return <RowColorLegend scope={scope} compact />;
    }
    render(<Phone />);
    expect(screen.getByText('Show Colors')).toBeInTheDocument();
  });
});
