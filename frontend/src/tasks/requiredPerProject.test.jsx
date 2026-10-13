import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { isFieldRequiredIn, requiredFieldsFor } from './lib';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));
vi.mock('./TasksContext', () => ({ useTasks: () => ({ teams: [], projects: [], tasks: [] }) }));

const { FieldModal } = await import('./ManageView');

// A custom field required in some projects, not all (Neil, Oct 13 2026):
// "Property" must be filled in for IT Support tasks, not Construction ones.

const projects = [
  { id: 'p-it', name: '#General - IT Support' },
  { id: 'p-con', name: '#General - Construction' },
  { id: 'p-dev', name: '#General - Development' },
];
const property = {
  id: 'f-prop', name: 'Property', type: 'select', appliesTo: ['task'],
  options: [{ id: 'esc', label: 'GS Escondido' }],
  projectIds: ['p-it', 'p-con', 'p-dev'], required: false, requiredProjectIds: ['p-it'],
};

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
});

describe('isFieldRequiredIn', () => {
  it('is required only in the projects ticked', () => {
    expect(isFieldRequiredIn(property, 'p-it')).toBe(true);
    expect(isFieldRequiredIn(property, 'p-con')).toBe(false);
    expect(isFieldRequiredIn(property, '')).toBe(false);
  });

  it('keeps "required" meaning every project the field is on', () => {
    const everywhere = { ...property, required: true, requiredProjectIds: [] };
    expect(isFieldRequiredIn(everywhere, 'p-con')).toBe(true);
    expect(isFieldRequiredIn(everywhere, 'p-other')).toBe(false);   // not on that project at all
  });

  it('never requires a field nobody can fill in', () => {
    expect(isFieldRequiredIn({ ...property, readOnly: true }, 'p-it')).toBe(false);
    expect(requiredFieldsFor([property, { ...property, id: 'f2', appliesTo: ['project'] }], 'p-it').map((f) => f.id)).toEqual(['f-prop']);
  });
});

describe('Edit Custom Field - Required per project', () => {
  const open = (field) => {
    const onSave = vi.fn();
    render(<FieldModal projects={projects} field={field} onClose={() => {}} onSave={onSave} />);
    return onSave;
  };

  it('lists each picked project with its own Required tick', () => {
    open(property);
    expect(screen.getByLabelText('Required in #General - IT Support').checked).toBe(true);
    expect(screen.getByLabelText('Required in #General - Construction').checked).toBe(false);
  });

  it('saves just the projects ticked', () => {
    const onSave = open(property);
    fireEvent.click(screen.getByLabelText('Required in #General - Development'));
    fireEvent.click(screen.getByText('Save Field'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      required: false, required_project_ids: ['p-it', 'p-dev'],
    }));
  });

  it('opens a field that was required everywhere with all its projects ticked', () => {
    const onSave = open({ ...property, required: true, requiredProjectIds: [] });
    for (const p of projects) expect(screen.getByLabelText(`Required in ${p.name}`).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Required in #General - Construction'));
    fireEvent.click(screen.getByText('Save Field'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      required: false, required_project_ids: ['p-it', 'p-dev'],
    }));
  });

  it('a field in every project can be required everywhere', () => {
    const onSave = open({ ...property, projectIds: [], requiredProjectIds: [] });
    fireEvent.click(screen.getByLabelText('Required in every project'));
    fireEvent.click(screen.getByText('Save Field'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ required: true, required_project_ids: [] }));
  });
});
