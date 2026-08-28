import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import RichListView, { peopleStackLayout, taskProjectOptions } from './richlist';

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
