import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// The project dropdown on Create a Task. End-user report: "Assigning tasks to a
// project is super unorganized and difficult - either each member needs to be
// restricted to certain groups, this needs to be alphabetized, or you should be
// able to search."
//
// It orders rather than excludes: the projects you belong to come first, the
// rest follow, both alphabetical, with search over everything. Excluding the
// org-wide ones would trade an annoyance for "I cannot file my task at all",
// since the backend counts those as visible to everyone on purpose.

const { default: ProjectPicker, myProjectIds } = await import('./ProjectPicker');

const ME = 'sagar.shoundik@greensglobal.com';

const projects = [
  { id: 'p1', name: 'Menifee', ownerId: 'neil@x.com', memberIds: [] },
  { id: 'p2', name: '#General', ownerId: 'neil@x.com', memberIds: [] },
  { id: 'p3', name: 'GSE Development', ownerId: ME, memberIds: [] },
  { id: 'p4', name: 'GS Mammoth', ownerId: 'neil@x.com', memberIds: [ME] },
  { id: 'p5', name: 'Archived Site', ownerId: ME, memberIds: [], archived: true },
  { id: 'p6', name: 'GSVC Maintenance', ownerId: 'neil@x.com', memberIds: [] },
];
const teams = [
  { id: 't1', name: 'Ops', memberIds: [ME], projectIds: ['p6'] },
  { id: 't2', name: 'Finance', memberIds: ['someone@x.com'], projectIds: ['p1'] },
];

const setup = (props = {}) => render(
  <ProjectPicker projects={projects} teams={teams} myEmail={ME} value="" onChange={vi.fn()} {...props} />,
);

const openPanel = () => fireEvent.click(screen.getByRole('button'));

describe('myProjectIds', () => {
  it('counts ownership, explicit membership and team membership', () => {
    const mine = myProjectIds(projects, teams, ME);
    expect([...mine].sort()).toEqual(['p3', 'p4', 'p5', 'p6']);   // p6 via the Ops team
  });

  it('does not count a team someone else is on', () => {
    expect(myProjectIds(projects, teams, ME).has('p1')).toBe(false);
  });

  it('is empty for an unknown user rather than everything', () => {
    expect(myProjectIds(projects, teams, '').size).toBe(0);
  });
});

describe('ProjectPicker', () => {
  it('puts the projects you belong to first, under their own heading', () => {
    setup();
    openPanel();
    expect(screen.getByText('Your Projects')).toBeTruthy();
    const labels = screen.getAllByRole('button')
      .map((b) => b.textContent.trim())
      .filter((t) => projects.some((p) => p.name === t));
    // GS Mammoth, GSE Development, GSVC Maintenance are mine and sort together
    // ahead of the rest.
    expect(labels.slice(0, 3)).toEqual(['GS Mammoth', 'GSE Development', 'GSVC Maintenance']);
  });

  it('alphabetizes within each group', () => {
    setup();
    openPanel();
    const all = screen.getAllByRole('button').map((b) => b.textContent.trim());
    const others = all.filter((t) => ['#General', 'Menifee'].includes(t));
    expect(others).toEqual(['#General', 'Menifee']);
  });

  it('searches across both groups', () => {
    setup();
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('Search projects'), { target: { value: 'gs' } });
    const shown = screen.getAllByRole('button').map((b) => b.textContent.trim());
    expect(shown).toContain('GS Mammoth');
    expect(shown).toContain('GSVC Maintenance');
    expect(shown).not.toContain('Menifee');
  });

  it('says so when nothing matches instead of showing a blank panel', () => {
    setup();
    openPanel();
    fireEvent.change(screen.getByPlaceholderText('Search projects'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No project matches/)).toBeTruthy();
  });

  it('hides archived projects', () => {
    setup();
    openPanel();
    expect(screen.queryByText('Archived Site')).toBeNull();
  });

  it('selecting one reports it and closes', () => {
    const onChange = vi.fn();
    setup({ onChange });
    openPanel();
    fireEvent.click(screen.getByText('GS Mammoth'));
    expect(onChange).toHaveBeenCalledWith('p4');
    expect(screen.queryByPlaceholderText('Search projects')).toBeNull();
  });

  it('Enter picks the first match so search-and-go works without the mouse', () => {
    const onChange = vi.fn();
    setup({ onChange });
    openPanel();
    const box = screen.getByPlaceholderText('Search projects');
    fireEvent.change(box, { target: { value: 'menifee' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('p1');
  });

  it('shows the selected project on the closed control', () => {
    setup({ value: 'p1' });
    expect(screen.getByRole('button').textContent).toContain('Menifee');
  });

  it('offers Create New Project without it being mistakable for one', () => {
    const onCreateNew = vi.fn();
    setup({ onCreateNew });
    openPanel();
    fireEvent.click(screen.getByText('Create New Project'));
    expect(onCreateNew).toHaveBeenCalled();
  });

  it('offers No project only when editing', () => {
    // Creating a task requires one, so an escape hatch there would just be a way
    // to fail validation.
    setup();
    openPanel();
    expect(screen.queryByText('No project')).toBeNull();
  });

  it('offers No project when editing an existing task', () => {
    setup({ allowNone: true, noneLabel: 'No project' });
    openPanel();
    expect(screen.getByText('No project')).toBeTruthy();
  });
});
