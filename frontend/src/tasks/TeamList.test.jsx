import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Avatar reaches through PersonHover into RoleContext; same stub the other task
// tests use so the row can be rendered on its own.
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 3, myEmail: '' }),
}));
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

import { TeamList } from './TeamsView';
import { __setTablePrefsCache } from './tableCols';

// The Teams list is the grid's sibling - same four facts, table shape - and it
// runs on the shared column kit, so its headers move, resize and sort like the
// Projects list's do. These pin the sorting and the header/cell correspondence,
// which is the part that silently breaks: once columns can be dragged, a row
// that renders its cells in a fixed sequence puts every value under the wrong
// heading and nothing throws.

const team = (over = {}) => ({
  id: 't1', name: 'Human Resources', color: '#2563eb', icon: 'building',
  memberIds: ['a@greensglobal.com', 'b@greensglobal.com'], ...over,
});

const PROJECTS = {
  t1: [{ id: 'p1', name: 'Onboarding' }],
  t2: [{ id: 'p2', name: 'Test Project' }, { id: 'p3', name: 'Duplicate of Test' }],
  t3: [],
};

const props = {
  isMobile: false,
  nameOf: (e) => e,
  projectsOf: (t) => PROJECTS[t.id] || [],
  taskCountByTeam: { t1: 0, t2: 14, t3: 3 },
  onOpen: () => {},
};

const THREE = [
  team(),                                                             // 2 members, 1 project, 0 tasks
  team({ id: 't2', name: 'IT', memberIds: ['a@x.com', 'b@x.com', 'c@x.com'] }), // 3 / 2 / 14
  team({ id: 't3', name: 'Marketing', memberIds: [] }),               // 0 / 0 / 3
];

// The header cell carries the label; the rows are its siblings in the same
// grid. Reading names in DOM order is what tells us the sort actually applied.
const teamNamesInOrder = () =>
  screen.getAllByText(/Human Resources|^IT$|Marketing/).map((el) => el.textContent);

const clickHeader = (label) => fireEvent.click(screen.getByText(label));

beforeEach(() => {
  localStorage.clear();
  act(() => __setTablePrefsCache({}));
});

describe('TeamList render-smoke', () => {
  it('renders a row per team with its counts', () => {
    render(<TeamList {...props} teams={THREE} />);

    expect(screen.getByText('Human Resources')).toBeInTheDocument();
    expect(screen.getByText('IT')).toBeInTheDocument();
    expect(screen.getByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();   // IT's task count
  });

  it('renders every column header', () => {
    render(<TeamList {...props} teams={THREE} />);

    for (const label of ['Team', 'Members', 'Projects', 'Tasks']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('opens the team when the row is clicked', () => {
    const onOpen = vi.fn();
    render(<TeamList {...props} onOpen={onOpen} teams={THREE} />);

    fireEvent.click(screen.getByText('Marketing'));

    expect(onOpen).toHaveBeenCalledWith('t3');
  });

  it('shows a dash rather than an empty cell for a team with no members or projects', () => {
    render(<TeamList {...props} teams={[team({ id: 't3', name: 'Marketing', memberIds: [] })]} />);

    expect(screen.getAllByText('-')).toHaveLength(2);   // members + projects
  });

  it('caps the projects it lists and counts the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
    render(<TeamList {...props} projectsOf={() => many} teams={[team()]} />);

    expect(screen.getByText('+3')).toBeInTheDocument();   // 6 projects, 3 shown
  });

  it('renders the mobile layout without throwing, and without headers', () => {
    render(<TeamList {...props} isMobile teams={THREE} />);

    expect(screen.getByText('Human Resources')).toBeInTheDocument();
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(screen.getByText(/2 members · 1 project · 0 tasks/)).toBeInTheDocument();
  });
});

describe('TeamList sorting', () => {
  it('starts A-Z by name', () => {
    render(<TeamList {...props} teams={THREE} />);
    expect(teamNamesInOrder()).toEqual(['Human Resources', 'IT', 'Marketing']);
  });

  it('cycles a header ascending -> descending -> back to the given order', () => {
    render(<TeamList {...props} teams={THREE} />);

    clickHeader('Team');   // already asc by default, so this flips to desc
    expect(teamNamesInOrder()).toEqual(['Marketing', 'IT', 'Human Resources']);

    clickHeader('Team');   // back to the order the parent handed us
    expect(teamNamesInOrder()).toEqual(['Human Resources', 'IT', 'Marketing']);
  });

  it('sorts by member count, not by the label next to it', () => {
    render(<TeamList {...props} teams={THREE} />);

    clickHeader('Members');
    expect(teamNamesInOrder()).toEqual(['Marketing', 'Human Resources', 'IT']);  // 0, 2, 3
  });

  it('sorts by project count', () => {
    render(<TeamList {...props} teams={THREE} />);

    clickHeader('Projects');
    expect(teamNamesInOrder()).toEqual(['Marketing', 'Human Resources', 'IT']);  // 0, 1, 2
  });

  it('sorts by task count numerically, not as text', () => {
    render(<TeamList {...props} teams={THREE} />);

    clickHeader('Tasks');
    // 0, 3, 14 - as strings "14" would sort before "3"
    expect(teamNamesInOrder()).toEqual(['Human Resources', 'Marketing', 'IT']);
  });

  it('remembers the sort in the shared table prefs, not in component state', () => {
    act(() => __setTablePrefsCache({ teams: { sort: { key: 'tasks', dir: 'desc' } } }));
    render(<TeamList {...props} teams={THREE} />);

    expect(teamNamesInOrder()).toEqual(['IT', 'Marketing', 'Human Resources']);  // 14, 3, 0
  });
});

describe('TeamList column order', () => {
  it('follows a saved column order', () => {
    act(() => __setTablePrefsCache({ teams: { order: ['tasks', 'team', 'projects', 'members'] } }));
    render(<TeamList {...props} teams={THREE} />);

    const headers = ['Tasks', 'Team', 'Projects', 'Members'].map((l) => screen.getByText(l));
    const positions = headers.map((h) => Array.from(h.parentElement.parentElement.children).indexOf(h.parentElement));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('keeps each value under its own heading when the columns move', () => {
    // The regression this guards: cells rendered in source order rather than in
    // the header's order put the task count under "Members" and nothing throws.
    act(() => __setTablePrefsCache({ teams: { order: ['tasks', 'members', 'projects', 'team'] } }));
    render(<TeamList {...props} teams={[THREE[1]]} />);   // IT: 3 members, 2 projects, 14 tasks

    const grid = screen.getByText('IT').closest('[style*="grid"]');
    const cells = Array.from(grid.children);
    // Tasks first now, name last.
    expect(within(cells[0]).getByText('14')).toBeInTheDocument();
    expect(within(cells[3]).getByText('IT')).toBeInTheDocument();
  });
});
