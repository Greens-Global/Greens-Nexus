import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import RichListView, { peopleStackLayout, taskProjectOptions, ListColumnControls, addableFields } from './richlist';
import { __setTablePrefsCache } from '../tableCols';

// Render-smoke test for the task list. This is the exact guard that was missing
// on 2026-08-02: a merge left an orphaned `g.renderTasks.length` reference, the
// list threw "Cannot read properties of undefined (reading 'length')" at render,
// and the whole Tasks section died - yet build + lint passed. Rendering the
// component with real data shape catches that class of bug.

const mockTasks = [
  {
    id: 't1', title: 'First task', status: 'not_started', priority: 'medium',
    assigneeId: '', teamId: '', projectId: '', dueOn: '', startOn: '',
    estimateHours: null, followerIds: [], subtaskIds: [], commentIds: [],
    attachmentIds: [], tags: [], completed: false, code: 'T-1', customFieldValues: {},
  },
  {
    id: 't2', title: 'Second task', status: 'in_progress', priority: 'high',
    assigneeId: '', teamId: '', projectId: '', dueOn: '2026-09-01', startOn: '',
    estimateHours: 2, followerIds: [], subtaskIds: [], commentIds: [],
    attachmentIds: [], tags: [], completed: false, code: 'T-2', customFieldValues: {},
  },
];

const store = {
  tasks: mockTasks,
  taskById: Object.fromEntries(mockTasks.map((t) => [t.id, t])),
  customFields: [],
  customStatuses: [],
  projects: [],
  teams: [],
  loading: false,
  statusOrder: ['not_started', 'in_progress', 'done'],
  statusMeta: {
    not_started: { label: 'Not Started', color: '#888', tint: '#eee' },
    in_progress: { label: 'In Progress', color: '#4488ff', tint: '#e6f0ff' },
    done: { label: 'Done', color: '#44aa44', tint: '#e8f5e8' },
  },
  projectName: () => 'Project',
  teamById: () => null,
  teamName: () => '',
  setStatus: () => {},
  toggleComplete: () => {},
  updateTask: () => Promise.resolve({}),
  createTask: () => Promise.resolve({}),
};

const ctx = { nameOf: () => '', projectName: () => 'Project', teamName: () => '', customFields: [] };

function renderList(props = {}) {
  return render(
    <RichListView
      visible={mockTasks}
      group="status"
      ctx={ctx}
      store={store}
      people={[]}
      selected={new Set()}
      toggleSel={() => {}}
      onOpen={() => {}}
      onSelectAll={() => {}}
      lockedProjectId=""
      hidden={new Set()}
      setHidden={() => {}}
      {...props}
    />,
  );
}

describe('RichListView (task list) render-smoke', () => {
  it('renders task rows without throwing', () => {
    renderList();
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.getByText('Second task')).toBeInTheDocument();
  });

  it('renders an empty list without throwing', () => {
    const { container } = renderList({ visible: [] });
    expect(container).toBeTruthy();
  });
});

// The Projects cell. It was a native <select> listing every project in whatever
// order the API returned - unusable at the ~90 a real workspace carries, since
// you cannot type into one (Sagar, Aug 27).
describe('RichListView project cell', () => {
  const projects = [
    { id: 'p3', name: 'Website Relaunch' },
    { id: 'p1', name: 'Handover - Arnav Kapoor' },
    { id: 'p2', name: 'Software Rollout - Q4' },
    { id: 'p9', name: 'Ankush Test Project', archived: true },
  ];
  const withProjects = (extra = {}) => ({
    ...store, projects, projectName: (id) => projects.find((p) => p.id === id)?.name || '', ...extra,
  });
  const openCell = () => {
    // The first row's project trigger - it reads as its current value.
    fireEvent.click(screen.getAllByText('No project')[0]);
    return screen.getByPlaceholderText('Search projects…');
  };

  it('offers a searchable, alphabetical list', () => {
    renderList({ store: withProjects() });
    const box = openCell();
    const menu = box.parentElement;
    const names = within(menu).getAllByText(/Website Relaunch|Handover - Arnav Kapoor|Software Rollout - Q4/)
      .map((n) => n.textContent);
    expect(names).toEqual(['Handover - Arnav Kapoor', 'Software Rollout - Q4', 'Website Relaunch']);
  });

  it('filters as you type instead of making you scroll', () => {
    renderList({ store: withProjects() });
    const box = openCell();
    fireEvent.change(box, { target: { value: 'rollout' } });
    const menu = box.parentElement;
    expect(within(menu).getByText('Software Rollout - Q4')).toBeInTheDocument();
    expect(within(menu).queryByText('Website Relaunch')).toBeNull();
  });

  it('does not offer archived projects - that is where work rests', () => {
    renderList({ store: withProjects() });
    const box = openCell();
    expect(within(box.parentElement).queryByText('Ankush Test Project')).toBeNull();
  });

  it('files the task into the project you pick', () => {
    const updateTask = vi.fn(() => Promise.resolve({}));
    renderList({ store: withProjects({ updateTask }) });
    const box = openCell();
    fireEvent.click(within(box.parentElement).getByText('Website Relaunch'));
    expect(updateTask).toHaveBeenCalledWith('t1', { projectId: 'p3' });
  });

  it('still names an archived project a task already sits in', () => {
    // Dropping it from the options would leave the cell reading "No project"
    // and quietly clear the link on the next pick.
    const tasks = [{ ...mockTasks[0], projectId: 'p9' }];
    renderList({
      visible: tasks,
      store: withProjects({ tasks, taskById: { t1: tasks[0] } }),
    });
    expect(screen.getByText('Ankush Test Project (archived)')).toBeInTheDocument();
  });
});

describe('taskProjectOptions', () => {
  it('leads with No project, then live projects in name order', () => {
    const opts = taskProjectOptions([
      { id: 'b', name: 'beta' }, { id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zulu', archived: true },
    ]);
    expect(opts.map((o) => o.id)).toEqual(['', 'a', 'b']);
    expect(opts[0].label).toBe('No project');
  });

  it('survives a store that has not loaded its projects yet', () => {
    expect(taskProjectOptions(undefined)).toEqual([{ id: '', label: 'No project' }]);
  });
});

// Widening the Person column has to actually reveal people - a fixed overlap
// meant a 300px column showed exactly what a 120px one did (Sagar, Aug 26).
describe('peopleStackLayout', () => {
  const AVATAR = 24, TIGHT = 16, LOOSE = 28;

  it('keeps a lone face un-stacked whatever the width', () => {
    expect(peopleStackLayout(120, 1)).toEqual({ shown: 1, step: TIGHT, hidden: 0 });
    expect(peopleStackLayout(400, 1)).toEqual({ shown: 1, step: TIGHT, hidden: 0 });
    expect(peopleStackLayout(120, 0)).toEqual({ shown: 0, step: TIGHT, hidden: 0 });
  });

  it('overlaps tightly when the column is narrow', () => {
    expect(peopleStackLayout(120, 6).step).toBe(TIGHT);
  });

  it('spreads the faces apart as the column grows', () => {
    // Six faces exactly fill a default 120px column, so it is the case where
    // extra width has somewhere to go. (Three already fit spread at 120.)
    const narrow = peopleStackLayout(120, 6).step;
    const wide = peopleStackLayout(260, 6).step;
    expect(narrow).toBe(TIGHT);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('keeps a small group STACKED at the default width, not scattered', () => {
    // The narrowest column has to look the most collapsed. Dividing the spare
    // room among the gaps used to fan three faces fully apart at any width.
    expect(peopleStackLayout(120, 3).step).toBe(TIGHT);
    expect(peopleStackLayout(60, 3).step).toBe(TIGHT);
  });

  it('widens the gap monotonically as the column grows', () => {
    const steps = [60, 120, 160, 200, 240, 280, 400].map((w) => peopleStackLayout(w, 3).step);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    expect(steps[0]).toBe(TIGHT);
    expect(steps[steps.length - 1]).toBe(LOOSE);
  });

  it('does not fan wider than the room actually there', () => {
    // A wide-looking ramp value must still yield faces that fit the cell.
    const { shown, step } = peopleStackLayout(200, 8);
    expect(AVATAR + (shown - 1) * step).toBeLessThanOrEqual(200 - 16 + 1);
  });

  it('stops spreading once the faces are fully separated', () => {
    // Past this point extra width is just empty cell - faces must not drift
    // apart into an unreadable scatter.
    expect(peopleStackLayout(2000, 3).step).toBe(LOOSE);
  });

  it('shows everyone once there is room, with no overflow chip', () => {
    const fit = peopleStackLayout(400, 5);
    expect(fit.shown).toBe(5);
    expect(fit.hidden).toBe(0);
  });

  it('reserves a slot for the +N chip when they do not all fit', () => {
    const fit = peopleStackLayout(120, 12);
    expect(fit.hidden).toBeGreaterThan(0);
    expect(fit.shown + fit.hidden).toBe(12);
    // The chip occupies one of the slots that fit, so faces + chip still fit.
    const used = AVATAR + fit.shown * TIGHT;
    expect(used).toBeLessThanOrEqual(120 - 16 + TIGHT);
  });

  it('always shows at least one face, even in a column dragged to its minimum', () => {
    expect(peopleStackLayout(60, 8).shown).toBeGreaterThanOrEqual(1);
    expect(peopleStackLayout(0, 8).shown).toBeGreaterThanOrEqual(1);
  });

  it('reveals more faces as the column widens', () => {
    const a = peopleStackLayout(120, 10).shown;
    const b = peopleStackLayout(260, 10).shown;
    expect(b).toBeGreaterThan(a);
  });
});


// ── Range selection ─────────────────────────────────────────────────────────
// rowSelection.test.js pins the algebra; these pin the wiring - that a modified
// click reaches it instead of opening the task, that the row order the range
// walks is the GROUPED order the person is looking at, and that the arrow keys
// stay out of the way of typing.
describe('RichListView range selection', () => {
  const three = [
    { ...mockTasks[0], id: 'a', title: 'Alpha', status: 'not_started' },
    { ...mockTasks[0], id: 'b', title: 'Bravo', status: 'not_started' },
    { ...mockTasks[0], id: 'c', title: 'Charlie', status: 'not_started' },
  ];
  const threeStore = { ...store, tasks: three, taskById: Object.fromEntries(three.map((t) => [t.id, t])) };

  // The list does not own the selection - the workspace does - so the test has
  // to hold it too, or nothing would come back after a click.
  function Harness({ onOpen = () => {}, onSelected }) {
    const [selected, setSelected] = useState(new Set());
    onSelected?.(selected);
    return (
      <RichListView
        visible={three} group="status" ctx={ctx} store={threeStore} people={[]}
        selected={selected} setSelected={setSelected} toggleSel={() => {}}
        onOpen={onOpen} onSelectAll={() => {}} lockedProjectId=""
        hidden={new Set()} setHidden={() => {}}
      />
    );
  }

  let latest;
  const renderSel = (onOpen) => {
    latest = new Set();
    render(<Harness onOpen={onOpen} onSelected={(s) => { latest = s; }} />);
  };
  const row = (title) => screen.getByText(title).closest('[data-row-id]');
  const ids = () => [...latest].sort();

  it('opens the task on a plain click, and selects nothing', () => {
    const onOpen = vi.fn();
    renderSel(onOpen);

    fireEvent.click(row('Bravo'));

    expect(onOpen).toHaveBeenCalledWith('b');
    expect(ids()).toEqual([]);
  });

  it('ctrl+click selects instead of opening', () => {
    const onOpen = vi.fn();
    renderSel(onOpen);

    fireEvent.click(row('Bravo'), { ctrlKey: true });

    expect(onOpen).not.toHaveBeenCalled();
    expect(ids()).toEqual(['b']);
  });

  it('cmd+click does the same, for the Mac half of the office', () => {
    renderSel();
    fireEvent.click(row('Charlie'), { metaKey: true });
    expect(ids()).toEqual(['c']);
  });

  it('ctrl+click adds a second row without dropping the first', () => {
    renderSel();

    fireEvent.click(row('Alpha'), { ctrlKey: true });
    fireEvent.click(row('Charlie'), { ctrlKey: true });

    expect(ids()).toEqual(['a', 'c']);
  });

  it('ctrl+click a selected row takes it back out', () => {
    renderSel();

    fireEvent.click(row('Alpha'), { ctrlKey: true });
    fireEvent.click(row('Alpha'), { ctrlKey: true });

    expect(ids()).toEqual([]);
  });

  it('shift+click takes everything between the two rows', () => {
    const onOpen = vi.fn();
    renderSel(onOpen);

    fireEvent.click(row('Alpha'), { ctrlKey: true });
    fireEvent.click(row('Charlie'), { shiftKey: true });

    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shift+arrow walks the far end of the range', () => {
    renderSel();

    fireEvent.click(row('Alpha'), { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    expect(ids()).toEqual(['a', 'b']);

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    expect(ids()).toEqual(['a', 'b', 'c']);

    fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true });
    expect(ids()).toEqual(['a', 'b']);
  });

  it('ignores shift+arrow until a click has said where to measure from', () => {
    renderSel();

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });

    expect(ids()).toEqual([]);
  });

  // Oct 13 2026: Ctrl+click did nothing in the real list. The tests above
  // click the row element itself, but a real click lands in a cell, and every
  // editable cell (Person, Due Date, Priority, a custom field) stops its own
  // click - so only the title ever reached the row.
  it('ctrl+click on an editable cell picks the row too', () => {
    const onOpen = vi.fn();
    renderSel(onOpen);
    const cell = row('Bravo').querySelector('.rl-cell');
    expect(cell).toBeTruthy();

    fireEvent.click(cell, { ctrlKey: true });
    fireEvent.click(row('Charlie').querySelector('.rl-cell'), { ctrlKey: true });

    expect(ids()).toEqual(['b', 'c']);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shift+click on an editable cell takes the range', () => {
    renderSel();
    fireEvent.click(row('Alpha').querySelector('.rl-cell'), { ctrlKey: true });
    fireEvent.click(row('Charlie').querySelector('.rl-cell'), { shiftKey: true });
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it("a Mac's ctrl+click - which arrives as a right-click - picks the row", () => {
    renderSel();
    fireEvent.contextMenu(row('Alpha').querySelector('.rl-cell'), { ctrlKey: true });
    expect(ids()).toEqual(['a']);
  });

  it('a plain right-click is left to the browser', () => {
    renderSel();
    fireEvent.contextMenu(row('Alpha'));
    expect(ids()).toEqual([]);
  });

  it('the checkbox still picks exactly once with a modifier held', () => {
    renderSel();
    const box = row('Alpha').querySelector('button');
    fireEvent.click(box, { ctrlKey: true });
    expect(ids()).toEqual(['a']);
  });

  it('leaves a plain arrow key alone, so the page still scrolls', () => {
    renderSel();

    fireEvent.click(row('Alpha'), { ctrlKey: true });
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(ids()).toEqual(['a']);
  });

  it('does not hijack shift+arrow while someone is typing', () => {
    renderSel();
    fireEvent.click(row('Alpha'), { ctrlKey: true });

    // Shift+Arrow in a text field is select-a-character - taking it would make
    // every inline editor in the list unusable.
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });

    expect(ids()).toEqual(['a']);
    input.remove();
  });
});

// The Team column inside a project. Every row in a single-team project showed
// the same team name - one team is stamped on new tasks automatically - so the
// column sorted, filtered and grouped into one bucket and told you nothing
// (Sagar, Sept 7). It now follows the Project column's rule, but derived from
// the data rather than stored, so a second team brings it straight back.
describe('RichListView team column', () => {
  const teams = (projectIds) => projectIds.map((ids, i) => ({
    id: `tm${i}`, name: `Team ${i}`, color: '#888', projectIds: ids,
  }));
  const inProject = (teamList) => ({
    ...store, teams: teamList, teamName: (id) => teamList.find((t) => t.id === id)?.name || '',
  });

  it('is hidden in a project with only one team', () => {
    renderList({ store: inProject(teams([['p1']])), lockedProjectId: 'p1' });
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
  });

  it('is hidden in a project with no teams at all', () => {
    renderList({ store: inProject([]), lockedProjectId: 'p1' });
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
  });

  it('comes back as soon as the project has two teams', () => {
    renderList({ store: inProject(teams([['p1'], ['p1', 'p2']])), lockedProjectId: 'p1' });
    expect(screen.getAllByText('Team').length).toBeGreaterThan(0);
  });

  it('counts only teams attached to THIS project', () => {
    // Two teams exist, but the second one lives in another project entirely.
    renderList({ store: inProject(teams([['p1'], ['p2']])), lockedProjectId: 'p1' });
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
  });

  it('always shows outside a project, where rows come from many teams', () => {
    renderList({ store: inProject(teams([['p1']])), lockedProjectId: '' });
    expect(screen.getAllByText('Team').length).toBeGreaterThan(0);
  });
});

// The Hide menu has to agree with the table: a toggle for a column that is not
// rendered is a switch that does nothing.
describe('Hide-columns menu', () => {
  const openMenu = (props) => {
    render(<ListColumnControls hidden={new Set()} setHidden={() => {}} customFields={[]}
      createCustomField={() => {}} {...props} />);
    fireEvent.click(screen.getByTitle('Hide columns'));
  };

  it('drops the Team toggle where the column cannot vary', () => {
    openMenu({ lockedProjectId: 'p1', teams: [{ id: 'tm0', name: 'Team 0', projectIds: ['p1'] }] });
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();   // the rest still there
  });

  it('keeps the Team toggle when the project has two teams', () => {
    openMenu({ lockedProjectId: 'p1', teams: [
      { id: 'tm0', name: 'Team 0', projectIds: ['p1'] },
      { id: 'tm1', name: 'Team 1', projectIds: ['p1'] },
    ] });
    expect(screen.getByText('Team')).toBeInTheDocument();
  });
});

// Completed is collapsed every time the list opens (Neil, Oct 12 2026). Its
// state used to be part of the stored collapsed list, so one click in one
// project left it open everywhere, for good. The stored list below is the
// shape such a profile has: an empty list, meaning "nothing collapsed".
describe('RichListView Completed group', () => {
  const done = {
    id: 't3', title: 'Finished task', status: 'completed', priority: 'low',
    assigneeId: '', teamId: '', projectId: '', dueOn: '', startOn: '',
    estimateHours: null, followerIds: [], subtaskIds: [], commentIds: [],
    attachmentIds: [], tags: [], completed: true, code: 'T-3', customFieldValues: {},
  };
  const doneStore = {
    ...store,
    tasks: [...mockTasks, done],
    taskById: { ...store.taskById, [done.id]: done },
    statusOrder: ['not_started', 'in_progress', 'completed'],
    statusMeta: { ...store.statusMeta, completed: { label: 'Completed', color: '#44aa44', tint: '#e8f5e8' } },
  };
  const open = (props = {}) => renderList({ visible: [...mockTasks, done], store: doneStore, ...props });

  it('starts collapsed even when the profile says it was left open', () => {
    __setTablePrefsCache({ richlist: { collapsed: [] } });
    open();
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.queryByText('Finished task')).not.toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('opens on a header click, without touching the stored list', () => {
    __setTablePrefsCache({ richlist: { collapsed: ['in_progress'] } });
    open();
    expect(screen.queryByText('Second task')).not.toBeInTheDocument();   // stored collapse still honored
    fireEvent.click(screen.getByText('Completed'));
    expect(screen.getByText('Finished task')).toBeInTheDocument();
    // Open, the row's own status cell also reads "Completed" - the header is first.
    fireEvent.click(screen.getAllByText('Completed')[0]);
    expect(screen.queryByText('Finished task')).not.toBeInTheDocument();
  });

  it('collapses again when the list moves to another project', () => {
    __setTablePrefsCache({ richlist: {} });
    const { rerender } = open({ lockedProjectId: 'p1' });
    fireEvent.click(screen.getByText('Completed'));
    expect(screen.getByText('Finished task')).toBeInTheDocument();
    rerender(
      <RichListView visible={[...mockTasks, done]} group="status" ctx={ctx} store={doneStore} people={[]}
        selected={new Set()} toggleSel={() => {}} onOpen={() => {}} onSelectAll={() => {}}
        lockedProjectId="p2" hidden={new Set()} setHidden={() => {}} />,
    );
    expect(screen.queryByText('Finished task')).not.toBeInTheDocument();
  });
});

// + Column > Existing Fields: a field another project uses can be put on this
// list from the menu (Neil, Oct 12 2026). Its own step, so the type grid
// never grows with the workspace's field count.
describe('+ Column > Existing Fields', () => {
  const fields = [
    { id: 'f1', name: 'Vendor', type: 'text', projectIds: ['p2'] },
    { id: 'f2', name: 'Budget', type: 'number', projectIds: ['p2', 'p3'] },
    { id: 'f3', name: 'Global', type: 'text', projectIds: [] },            // on every list already
    { id: 'f4', name: 'Here', type: 'text', projectIds: ['p1'] },          // on this list already
    { id: 'f5', name: 'Site', type: 'text', projectIds: ['p2'], appliesTo: ['project'] },   // not a task field
  ];

  it('offers only task fields scoped elsewhere, A-Z', () => {
    expect(addableFields(fields, 'p1').map((f) => f.name)).toEqual(['Budget', 'Vendor']);
    expect(addableFields(fields, '')).toEqual([]);   // outside a project there is nothing to add to
  });

  it('shows the row only when there is something to add', () => {
    const { unmount } = render(<ListColumnControls hidden={new Set()} setHidden={() => {}} customFields={[]}
      createCustomField={() => {}} lockedProjectId="p1" allCustomFields={[fields[3]]} />);
    fireEvent.click(screen.getByText('Column'));
    expect(screen.queryByText('Existing Fields')).not.toBeInTheDocument();
    unmount();
    render(<ListColumnControls hidden={new Set()} setHidden={() => {}} customFields={[]}
      createCustomField={() => {}} lockedProjectId="p1" allCustomFields={fields} />);
    fireEvent.click(screen.getByText('Column'));
    expect(screen.getByText('Existing Fields')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();   // the type grid is still there
  });

  it('adds the picked field to this project and nothing else', () => {
    const update = vi.fn(() => Promise.resolve({}));
    render(<ListColumnControls hidden={new Set()} setHidden={() => {}} customFields={[]}
      createCustomField={() => {}} lockedProjectId="p1" allCustomFields={fields} updateCustomField={update} />);
    fireEvent.click(screen.getByText('Column'));
    fireEvent.click(screen.getByText('Existing Fields'));
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
    expect(screen.queryByText('Global')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Budget'));
    expect(update).toHaveBeenCalledWith('f2', { projectIds: ['p2', 'p3', 'p1'] });
  });

  it('says so and stays open when the add fails', async () => {
    const update = vi.fn(() => Promise.reject(Object.assign(new Error('API error 500'), { status: 500 })));
    render(<ListColumnControls hidden={new Set()} setHidden={() => {}} customFields={[]}
      createCustomField={() => {}} lockedProjectId="p1" allCustomFields={fields} updateCustomField={update} />);
    fireEvent.click(screen.getByText('Column'));
    fireEvent.click(screen.getByText('Existing Fields'));
    fireEvent.click(screen.getByText('Budget'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Budget could not be added. Try again.');
    expect(screen.getByText('Vendor')).toBeInTheDocument();          // still open, so it can be retried
    expect(screen.getByText('Budget').closest('button')).not.toBeDisabled();
  });
});


// A project with a required custom field (Oct 13 2026): the "Add task…" row
// cannot make a title-only task there - the server refuses it - so it opens
// the full Create form with the title in, and only creates directly elsewhere.
describe('Add task row in a project with a required field', () => {
  const prop = { id: 'f-prop', name: 'Property', type: 'select', appliesTo: ['task'], options: [],
    projectIds: ['p-it'], requiredProjectIds: ['p-it'] };
  const addRow = (lockedProjectId, createTask, onFullCreate) => {
    render(
      <RichListView visible={mockTasks} group="status" ctx={ctx}
        store={{ ...store, customFields: [prop], createTask }} people={[]} selected={new Set()}
        toggleSel={() => {}} onOpen={() => {}} onSelectAll={() => {}} lockedProjectId={lockedProjectId}
        hidden={new Set()} setHidden={() => {}} onFullCreate={onFullCreate} />,
    );
    const box = screen.getAllByPlaceholderText('Add task…')[0];
    fireEvent.change(box, { target: { value: 'Replace badge reader' } });
    fireEvent.keyDown(box, { key: 'Enter' });
  };

  it('opens the full Create form instead of creating', () => {
    const createTask = vi.fn(() => Promise.resolve({}));
    const onFullCreate = vi.fn();
    addRow('p-it', createTask, onFullCreate);
    expect(createTask).not.toHaveBeenCalled();
    expect(onFullCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Replace badge reader', projectId: 'p-it' }));
  });

  it('still creates straight away where nothing is required', () => {
    const createTask = vi.fn(() => Promise.resolve({}));
    const onFullCreate = vi.fn();
    addRow('p-other', createTask, onFullCreate);
    expect(createTask).toHaveBeenCalled();
    expect(onFullCreate).not.toHaveBeenCalled();
  });
});

// Oct 13 2026: the header checkbox of one section (Recurring) also ticked
// every task in the next (Missed) - one header was shared by all sections.
describe('a section header checkbox', () => {
  const two = [
    { ...mockTasks[0], id: 'r1', title: 'Add K1s', status: 'not_started' },
    { ...mockTasks[0], id: 'r2', title: 'Tax Return - RJK', status: 'not_started' },
    { ...mockTasks[0], id: 'm1', title: 'Tax Return', status: 'in_progress' },
  ];
  const twoStore = { ...store, tasks: two, taskById: Object.fromEntries(two.map((t) => [t.id, t])) };
  let latest;
  function Harness() {
    const [selected, setSelected] = useState(new Set(['m1']));
    latest = selected;
    return (
      <RichListView visible={two} group="status" ctx={ctx} store={twoStore} people={[]}
        selected={selected} setSelected={setSelected} toggleSel={() => {}} onOpen={() => {}}
        lockedProjectId="" hidden={new Set()} setHidden={() => {}} />
    );
  }

  it('selects only its own section, keeping what else was picked', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Select all in Not Started'));
    expect([...latest].sort()).toEqual(['m1', 'r1', 'r2']);
    fireEvent.click(screen.getByLabelText('Deselect all in Not Started'));
    expect([...latest]).toEqual(['m1']);
  });

  it("does not touch another section's tasks", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Deselect all in In Progress'));
    expect([...latest]).toEqual([]);
    fireEvent.click(screen.getByLabelText('Select all in Not Started'));
    expect([...latest].sort()).toEqual(['r1', 'r2']);
  });
});
