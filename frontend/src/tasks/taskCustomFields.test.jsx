import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { fieldsForTask, requiredByProjectsOf } from './lib';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));

const { TaskCustomFieldRows } = await import('./TaskDetailDrawer');

// A project's custom columns on the task itself (Oct 13 2026): Property is a
// column on IT Support, so an IT Support task offers it - required there -
// and a task moved out of IT Support no longer needs it.

const property = {
  id: 'f-prop', name: 'Property', type: 'select', appliesTo: ['task'],
  options: [{ id: 'esc', label: 'GS Escondido' }, { id: 'men', label: 'Menifee' }],
  projectIds: ['p-it', 'p-con'], requiredProjectIds: ['p-it'],
};
const points = { id: 'f-pts', name: 'Points', type: 'number', appliesTo: ['task'], projectIds: [] };
const elsewhere = { id: 'f-x', name: 'Permit No.', type: 'text', appliesTo: ['task'], projectIds: ['p-permits'] };
const fields = [property, points, elsewhere];
const names = { 'p-it': '#General - IT Support', 'p-con': '#General - Construction' };

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

describe('fieldsForTask', () => {
  it("offers the project's columns and the ones used everywhere, not other projects'", () => {
    expect(fieldsForTask(fields, { projectId: 'p-it' }).map((f) => f.name)).toEqual(['Property', 'Points']);
  });

  it('counts a project the task is also in', () => {
    expect(fieldsForTask(fields, { projectId: 'p-other', projectIds: ['p-permits'] }).map((f) => f.name))
      .toEqual(['Points', 'Permit No.']);
  });

  it('a task with no project gets only the everywhere fields', () => {
    expect(fieldsForTask(fields, { projectId: '' }).map((f) => f.name)).toEqual(['Points']);
  });
});

describe('requiredByProjectsOf', () => {
  it('is required while the task is in a project that requires it', () => {
    expect(requiredByProjectsOf(property, { projectId: 'p-it' })).toEqual(['p-it']);
    expect(requiredByProjectsOf(property, { projectId: 'p-con', projectIds: ['p-it'] })).toEqual(['p-it']);
  });

  it('is not once the task moves out', () => {
    expect(requiredByProjectsOf(property, { projectId: 'p-con' })).toEqual([]);
  });
});

describe('the task drawer rows', () => {
  const renderRows = (task, patch = vi.fn()) => {
    const utils = render(<TaskCustomFieldRows task={task} customFields={fields} projectName={(id) => names[id] || ''} patch={patch} />);
    return { ...utils, patch };
  };

  it('shows Property on an IT Support task, starred and flagged while empty', () => {
    renderRows({ id: 't', projectId: 'p-it', customFieldValues: {} });
    expect(screen.getByText('Property')).toBeTruthy();
    expect(screen.getByText('*')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Required in #General - IT Support');
  });

  it('picking a value saves it alongside the others', () => {
    const { patch } = renderRows({ id: 't', projectId: 'p-it', customFieldValues: { 'f-pts': 3 } });
    fireEvent.change(screen.getByText('GS Escondido').closest('select'), { target: { value: 'esc' } });
    expect(patch).toHaveBeenCalledWith({ customFieldValues: { 'f-pts': 3, 'f-prop': 'esc' } });
  });

  it('no flag once it is filled in', () => {
    renderRows({ id: 't', projectId: 'p-it', customFieldValues: { 'f-prop': 'esc' } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('moved to Construction: still offered, no longer required', () => {
    renderRows({ id: 't', projectId: 'p-con', customFieldValues: {} });
    expect(screen.getByText('Property')).toBeTruthy();
    expect(screen.queryByText('*')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// A multi-select field is one dropdown, not every option laid out as a chip
// (Neil, Oct 15 2026: the Trade list filled the task card). Closed, only the
// chosen options show in the trigger; open, the rest are a checkbox menu.
describe('a multi-select field', () => {
  const trade = {
    id: 'f-trade', name: 'Trade', type: 'multiselect', appliesTo: ['task'], projectIds: [],
    options: [{ id: 'gl', label: 'General Labor', color: '' }, { id: 'el', label: 'Electrician', color: '' }, { id: 'pl', label: 'Plumber', color: '' }],
  };
  const renderRows = (values, patch = vi.fn()) => {
    render(<TaskCustomFieldRows task={{ id: 't', projectId: 'p-x', customFieldValues: values }} customFields={[trade]} projectName={() => ''} patch={patch} />);
    return patch;
  };

  it('shows only the picked trades until it is opened', () => {
    renderRows({ 'f-trade': ['el'] });
    expect(screen.getByText('Electrician')).toBeTruthy();
    expect(screen.queryByText('General Labor')).toBeNull();
    expect(screen.queryByText('Plumber')).toBeNull();
  });

  it('reads "-" when nothing is picked', () => {
    renderRows({});
    expect(screen.getByText('-')).toBeTruthy();
  });

  it('opening it lists every option and a pick adds to the list', () => {
    const patch = renderRows({ 'f-trade': ['el'] });
    fireEvent.click(screen.getByText('Electrician').closest('button'));
    fireEvent.click(screen.getByText('Plumber'));
    expect(patch).toHaveBeenCalledWith({ customFieldValues: { 'f-trade': ['el', 'pl'] } });
  });
});
