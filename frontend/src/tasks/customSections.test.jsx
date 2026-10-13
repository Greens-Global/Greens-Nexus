import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { groupTasks, groupAddDefaults } from './lib';

// The Custom grouping (Miranda, Oct 13 2026: "make my own categories and name
// them" - annual recurring tasks apart from the weekly ones).

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

let store;
vi.mock('./TasksContext', () => ({ useTasks: () => store }));
// The person's settings store, held in memory for the test.
vi.mock('./tableCols', async (orig) => {
  const real = await orig();
  return {
    ...real,
    useTableValue: (table, name, fallback) => {
      const [v, setV] = useState(fallback);
      return [v, (next) => setV((cur) => (typeof next === 'function' ? next(cur) : next))];
    },
  };
});

const { useCustomSections } = await import('./customSections');

const t = (id, extra = {}) => ({ id, title: id, sectionId: '', ...extra });

describe('grouping by Custom', () => {
  const sections = [{ id: 's-annual', name: 'Annual Recurring' }, { id: 's-general', name: 'General Recurring' }];

  it('No Section first, then every section in order - empty ones too', () => {
    const groups = groupTasks([t('a', { sectionId: 's-general' }), t('b')], 'section', { sections });
    expect(groups.map((g) => [g.label, g.tasks.map((x) => x.id)])).toEqual([
      ['No Section', ['b']], ['Annual Recurring', []], ['General Recurring', ['a']],
    ]);
  });

  it('reads where a task is filed through sectionOf (personal sections)', () => {
    const groups = groupTasks([t('a'), t('b')], 'section', { sections, sectionOf: (x) => (x.id === 'a' ? 's-annual' : '') });
    expect(groups[1].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('a section that no longer exists reads as No Section', () => {
    const groups = groupTasks([t('a', { sectionId: 'gone' })], 'section', { sections });
    expect(groups[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('a task added under a project section is filed there', () => {
    expect(groupAddDefaults('section', 's-annual')).toEqual({ sectionId: 's-annual' });
    expect(groupAddDefaults('section', '-')).toEqual({ sectionId: '' });
  });
});

function Probe({ projectId, onReady }) {
  const sec = useCustomSections(projectId);
  onReady(sec);
  return <div data-testid="names">{sec.sections.map((x) => x.name).join('|')}</div>;
}

describe('useCustomSections', () => {
  beforeEach(() => {
    store = {
      sections: [
        { id: 'p2', projectId: 'proj', name: 'Second', position: 2, custom: true },
        { id: 'old', projectId: 'proj', name: 'Not Started', position: 0 },
        { id: 'p1', projectId: 'proj', name: 'First', position: 1, custom: true },
        { id: 'x', projectId: 'other', name: 'Elsewhere', position: 1 },
      ],
      createSection: vi.fn(() => Promise.resolve({})), updateSection: vi.fn(() => Promise.resolve({})),
      deleteSection: vi.fn(() => Promise.resolve()), updateTask: vi.fn(() => Promise.resolve({})),
      bulkUpdate: vi.fn(() => Promise.resolve([])),
    };
  });

  it("a project's sections: its own, in order, and filing is a task field", async () => {
    let sec;
    render(<Probe projectId="proj" onReady={(s) => { sec = s; }} />);
    expect(screen.getByTestId('names').textContent).toBe('First|Second');
    expect(sec.sectionOf({ id: 'a', sectionId: 'p1' })).toBe('p1');
    await act(() => sec.move(['a', 'b'], 'p2'));
    expect(store.bulkUpdate).toHaveBeenCalledWith(['a', 'b'], { sectionId: 'p2' });
    await act(() => sec.move(['a'], '-'));
    expect(store.updateTask).toHaveBeenCalledWith('a', { sectionId: '' });
    await act(() => sec.add('Third'));
    expect(store.createSection).toHaveBeenCalledWith({ projectId: 'proj', name: 'Third', position: 3, custom: true });
  });

  it('My Tasks sections are personal - they never touch a task', async () => {
    let sec;
    render(<Probe projectId="" onReady={(s) => { sec = s; }} />);
    await act(() => sec.add('Annual Recurring'));
    expect(screen.getByTestId('names').textContent).toBe('Annual Recurring');
    const id = sec.sections[0].id;
    await act(() => sec.move(['task-1'], id));
    expect(sec.sectionOf({ id: 'task-1' })).toBe(id);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.bulkUpdate).not.toHaveBeenCalled();
    await act(() => sec.rename(id, 'Annual Inspections'));
    expect(screen.getByTestId('names').textContent).toBe('Annual Inspections');
    // Deleting a section un-files its tasks; nothing else is lost.
    await act(() => sec.remove(id));
    expect(screen.getByTestId('names').textContent).toBe('');
    expect(sec.sectionOf({ id: 'task-1' })).toBe('');
  });
});

describe('the project list under Custom', () => {
  it('shows empty sections, a section menu, and Add Section', async () => {
    const { default: RichListView } = await import('./views/richlist');
    globalThis.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
    const tasks = [{ ...t('a'), status: 'not_started', priority: 'medium', projectId: 'proj', followerIds: [], subtaskIds: [], commentIds: [], attachmentIds: [], tags: [], customFieldValues: {} }];
    const listStore = {
      tasks, taskById: { a: tasks[0] }, customFields: [], customStatuses: [], projects: [], teams: [],
      statusOrder: ['not_started'], statusMeta: { not_started: { label: 'Not Started', color: '#888' } },
      projectName: () => '', teamById: () => null, teamName: () => '', updateTask: () => Promise.resolve({}), createTask: () => Promise.resolve({}),
    };
    const move = vi.fn(() => Promise.resolve());
    const customSections = { sections: [{ id: 's1', name: 'Annual Recurring' }], sectionOf: (x) => x.sectionId, move, add: vi.fn(), rename: vi.fn(), remove: vi.fn(), personal: false };
    render(<RichListView visible={tasks} group="section" ctx={{ nameOf: () => '', projectName: () => '', teamName: () => '', customFields: [] }}
      store={listStore} people={[]} selected={new Set()} setSelected={() => {}} toggleSel={() => {}} onOpen={() => {}}
      lockedProjectId="proj" hidden={new Set()} setHidden={() => {}} customSections={customSections} />);
    expect(screen.getByText('No Section')).toBeTruthy();
    expect(screen.getByText('Annual Recurring')).toBeTruthy();   // empty, still shown
    expect(screen.getByLabelText('Section options for Annual Recurring')).toBeTruthy();
    expect(screen.queryByLabelText('Section options for No Section')).toBeNull();
    expect(screen.getByText('Add Section')).toBeTruthy();
    // Drag the task onto the section.
    const row = document.querySelector('[data-row-id="a"]');
    fireEvent.dragStart(row, { dataTransfer: { effectAllowed: '', setData() {} } });
    const block = screen.getByText('Annual Recurring').closest('[style*="margin-top"]');
    fireEvent.dragOver(block, { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(block, { dataTransfer: {} });
    expect(move).toHaveBeenCalledWith(['a'], 's1');
  });
});
