import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BulkActionBar from './BulkActionBar';
import { bulkFieldsFor } from './lib';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));

// Batch-setting Property (Sagar, Oct 13 2026): the bar could set status,
// priority, assignee and project, but none of a project's custom columns.

const property = {
  id: 'f-prop', name: 'Property', type: 'select', projectIds: ['p-it'],
  options: [{ id: 'esc', label: 'GS Escondido' }, { id: 'men', label: 'Menifee' }],
};
const points = { id: 'f-pts', name: 'Points', type: 'number', projectIds: [] };
const formula = { id: 'f-calc', name: 'Calculated', type: 'text', projectIds: [], readOnly: true };
const tasks = [
  { id: 'a', title: 'A', projectId: 'p-it' },
  { id: 'b', title: 'B', projectId: 'p-it' },
  { id: 'c', title: 'C', projectId: 'p-other' },
];

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

describe('bulkFieldsFor', () => {
  it("offers a project's field only when every selected task is in that project", () => {
    const all = [property, points, formula];
    expect(bulkFieldsFor(all, tasks, new Set(['a', 'b'])).map((f) => f.name)).toEqual(['Points', 'Property']);
    expect(bulkFieldsFor(all, tasks, new Set(['a', 'c'])).map((f) => f.name)).toEqual(['Points']);
  });

  it('never offers a read-only field', () => {
    expect(bulkFieldsFor([formula], tasks, new Set(['a']))).toEqual([]);
  });
});

describe('BulkActionBar - Set Field', () => {
  const renderBar = (bulkUpdate = vi.fn(() => Promise.resolve([]))) => {
    const clearSel = vi.fn();
    const store = {
      tasks, customFields: [property, points], bulkUpdate, deleteTask: vi.fn(),
      statusOrder: ['not_started'], statusMeta: { not_started: { label: 'Not Started' } }, projects: [],
    };
    render(<BulkActionBar selected={new Set(['a', 'b'])} clearSel={clearSel} store={store} people={[]} lockedProjectId="p-it" />);
    return { bulkUpdate, clearSel };
  };

  it("sets Property on every selected task, as a merge of just that field", () => {
    const { bulkUpdate, clearSel } = renderBar();
    fireEvent.click(screen.getByText('Set Field…'));
    fireEvent.click(screen.getByText('Property'));
    expect(screen.getByText('Set Property on 2 Tasks')).toBeTruthy();
    fireEvent.change(screen.getByText('GS Escondido').closest('select'), { target: { value: 'esc' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(bulkUpdate).toHaveBeenCalledWith(['a', 'b'], { customFieldValues: { 'f-prop': 'esc' } });
    expect(clearSel).toHaveBeenCalled();
  });

  it('Clear Value empties just that field', () => {
    const { bulkUpdate } = renderBar();
    fireEvent.click(screen.getByText('Set Field…'));
    fireEvent.click(screen.getByText('Property'));
    fireEvent.click(screen.getByText('Clear Value'));
    expect(bulkUpdate).toHaveBeenCalledWith(['a', 'b'], { customFieldValues: { 'f-prop': '' } });
  });

  it('will not apply an empty value', () => {
    renderBar();
    fireEvent.click(screen.getByText('Set Field…'));
    fireEvent.click(screen.getByText('Property'));
    expect(screen.getByText('Apply').disabled).toBe(true);
  });
});

// Phone, Oct 13 2026: in the one-row bar the pickers' minWidth:0 wrappers
// shrank to nothing and Assign / Move To / Duplicate painted over each other.
describe('BulkActionBar - one row on a phone', () => {
  it('keeps every picker from shrinking, and sits fixed above the module nav', () => {
    const store = {
      tasks, customFields: [property], bulkUpdate: vi.fn(), deleteTask: vi.fn(),
      statusOrder: ['not_started'], statusMeta: { not_started: { label: 'Not Started' } }, projects: [],
    };
    const sections = { sections: [{ id: 's1', name: 'Annual' }], move: vi.fn(() => Promise.resolve()) };
    const { container } = render(<BulkActionBar selected={new Set(['a'])} clearSel={vi.fn()} store={store}
      people={[]} lockedProjectId="p-it" isMobile sections={sections} />);
    const bar = container.firstChild;
    expect(bar.style.position).toBe('fixed');
    expect(bar.style.flexWrap).toBe('nowrap');
    for (const label of ['Assign…', 'Move To…', 'Set Field…', 'Move to Section…']) {
      const item = screen.getByText(label).closest('button').parentElement.parentElement;
      expect(item.parentElement).toBe(bar);
      expect(item.style.flexShrink).toBe('0');
    }
  });
});
