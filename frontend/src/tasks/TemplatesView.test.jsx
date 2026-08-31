import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for the Templates screen and the dialogs the Projects grid
// reuses from it, per CLAUDE.md's rule that a new top-level surface gets one -
// a crash-on-render here would otherwise reach a user before build or lint saw
// it. Also pins the promise the feature makes: a TEMPLATE is a blueprint that
// carries no people and no settings, while a COPY carries both.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 3, myEmail: 'sagar@greensglobal.com' }),
}));

const store = {
  projectTemplates: [],
  projects: [],
  portfolios: [],
  teams: [],
  tasks: [],
  customFields: [],
  nameOf: (e) => (e === 'sagar@greensglobal.com' ? 'Sagar Shoundik' : e || ''),
  createProjectTemplate: vi.fn(async (d) => ({ id: 'new', ...d })),
  updateProjectTemplate: vi.fn(async () => ({})),
  deleteProjectTemplate: vi.fn(async () => {}),
  createProjectFromTemplate: vi.fn(async () => ({ id: 'built', name: 'Built' })),
  createProject: vi.fn(async () => ({ id: 'p', name: 'P' })),
  updateProject: vi.fn(async () => ({})),
  updateTeam: vi.fn(async () => ({})),
  duplicateProject: vi.fn(async () => ({ id: 'copy', name: 'Copy' })),
  previewProjectTemplate: vi.fn(async () => ({
    taskCount: 24, subtaskCount: 3, sectionCount: 4, assigneeCount: 2,
    fieldCount: 2, statusCount: 1, fieldNames: ['Phase', 'Cost'], statusLabels: ['Waiting'],
    hasDates: true, anchor: '2026-09-01',
  })),
};
vi.mock('./TasksContext', () => ({ useTasks: () => store }));

// usePeople hits the directory endpoint; nothing here needs a real roster.
vi.mock('./components', async () => {
  const actual = await vi.importActual('./components');
  return { ...actual, usePeople: () => [] };
});

// ProjectModal loads the department list, and Avatar reaches the people
// directory. Neither has anything to say about template behavior, so the whole
// api surface is stubbed as async no-ops rather than listing them one by one.
vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(async () => []) }),
}));

import { __setTablePrefsCache } from './tableCols';
import TemplatesView, { SaveTemplateModal, UseTemplateModal, DuplicateProjectModal } from './TemplatesView';
import { ProjectCreateModal } from './ProjectsView';

const template = (over = {}) => ({
  id: 't1', name: 'Unit Turnover', description: 'Standard turnover checklist',
  color: '#7c3aed', category: 'Property', sourceProjectId: 'p1', sourceProjectName: 'Turnover - Unit 12',
  accessLevel: 'org', ownerId: 'sagar@greensglobal.com', archived: false,
  useCount: 3, lastUsedAt: '2026-08-01T00:00:00Z', createdAt: '2026-07-01T00:00:00Z',
  taskCount: 24, sectionCount: 4, fieldCount: 2, statusCount: 1, hasDates: true,
  defaults: { name: 'Turnover - Unit 12', description: 'Standard turnover checklist', color: '#7c3aed' },
  payload: {}, ...over,
});

beforeEach(() => {
  store.projectTemplates = [];
  store.projects = [];
  // Grid/list lives in the table-prefs cache, which is module-level - without
  // this, a test that switches to the grid leaves every later one there.
  __setTablePrefsCache({});
  vi.clearAllMocks();
});

describe('TemplatesView render-smoke', () => {
  it('renders the empty state when there are no templates', () => {
    render(<TemplatesView />);
    expect(screen.getByText('No Templates Yet')).toBeInTheDocument();
  });

  it('renders a row per template with its rollup', () => {
    store.projectTemplates = [template(), template({ id: 't2', name: 'Onboarding', taskCount: 1, sectionCount: 0, category: 'HR', useCount: 0 })];
    render(<TemplatesView />);

    // The screen opens on the list, so this is what a first visit actually
    // gets. Counts ride as titles here - the row shows the bare number.
    expect(screen.getByText('Unit Turnover')).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByTitle('24 tasks')).toBeInTheDocument();
    expect(screen.getByTitle('4 sections')).toBeInTheDocument();
    expect(screen.getByTitle('1 task')).toBeInTheDocument();     // singular, not "1 tasks"
    expect(screen.getByTitle('Used 3 times')).toBeInTheDocument();
  });

  it('renders a card per template with its rollup in the grid view', () => {
    store.projectTemplates = [template(), template({ id: 't2', name: 'Onboarding', taskCount: 1, sectionCount: 0, category: 'HR', useCount: 0 })];
    render(<TemplatesView />);

    fireEvent.click(screen.getByTitle('Grid View'));

    expect(screen.getByText('Unit Turnover')).toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('24 tasks')).toBeInTheDocument();
    expect(screen.getByText('4 sections')).toBeInTheDocument();
    expect(screen.getByText('1 task')).toBeInTheDocument();      // singular, not "1 tasks"
    expect(screen.getByText('Used 3x')).toBeInTheDocument();
  });

  it('hides archived templates until the filter asks for them', () => {
    store.projectTemplates = [template(), template({ id: 't2', name: 'Retired', archived: true })];
    render(<TemplatesView />);
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTitle('Archive filter'), { target: { value: 'all' } });
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  it('filters by search', () => {
    store.projectTemplates = [template(), template({ id: 't2', name: 'Onboarding', category: 'HR' })];
    render(<TemplatesView />);

    fireEvent.change(screen.getByPlaceholderText('Search templates…'), { target: { value: 'onboard' } });

    expect(screen.queryByText('Unit Turnover')).not.toBeInTheDocument();
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
  });
});

describe('New Project chooser', () => {
  it('offers the three Asana ways in', () => {
    render(<ProjectCreateModal onClose={() => {}} />);

    expect(screen.getByText('Blank Project')).toBeInTheDocument();
    expect(screen.getByText('Use a Template')).toBeInTheDocument();
    expect(screen.getByText('From an Existing Project')).toBeInTheDocument();
  });

  it('lists templates to pick from, with their counts', () => {
    store.projectTemplates = [template()];
    render(<ProjectCreateModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Use a Template'));

    expect(screen.getByText('Pick a template')).toBeInTheDocument();
    expect(screen.getByText('Unit Turnover')).toBeInTheDocument();
    expect(screen.getByText(/24 tasks · 4 sections · 2 fields · 1 status/)).toBeInTheDocument();
  });

  it('picking a template opens the full project form, seeded but editable', async () => {
    store.projectTemplates = [template()];
    render(<ProjectCreateModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('Use a Template'));
    fireEvent.click(screen.getByText('Unit Turnover'));

    // The ordinary create-a-project questions, because a blueprint answers none
    // of them for you.
    await waitFor(() => expect(screen.getByText('New Project from "Unit Turnover"')).toBeInTheDocument());
    expect(screen.getByText('Who can access')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();
    expect(screen.getByText('Start Date')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Turnover - Unit 12')).toBeInTheDocument();   // seeded default
    expect(screen.getByText(/carries no owner, members, teams or visibility/)).toBeInTheDocument();
  });

  it('lists projects to copy from', () => {
    store.projects = [{ id: 'p1', name: 'Turnover - Unit 12', archived: false }];
    render(<ProjectCreateModal onClose={() => {}} />);

    fireEvent.click(screen.getByText('From an Existing Project'));

    expect(screen.getByText('Pick a project to copy')).toBeInTheDocument();
    expect(screen.getByText('Turnover - Unit 12')).toBeInTheDocument();
  });

  it('goes back to the three choices from a picker', () => {
    render(<ProjectCreateModal onClose={() => {}} />);
    fireEvent.click(screen.getByText('Use a Template'));
    fireEvent.click(screen.getByText('Back'));

    expect(screen.getByText('Blank Project')).toBeInTheDocument();
  });
});

describe('UseTemplateModal', () => {
  it('builds the project through the project form, with the settings entered', async () => {
    const onCreated = vi.fn();
    render(<UseTemplateModal template={template()} onClose={() => {}} onCreated={onCreated} />);

    await waitFor(() => expect(screen.getByText('New Project from "Unit Turnover"')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Project Name'), { target: { value: 'Turnover - Unit 30' } });
    fireEvent.click(screen.getByText('Nexus Global'));       // access level: org
    fireEvent.click(screen.getByText('Create Project'));

    await waitFor(() => expect(store.createProjectFromTemplate).toHaveBeenCalled());
    const [id, body] = store.createProjectFromTemplate.mock.calls[0];
    expect(id).toBe('t1');
    expect(body.name).toBe('Turnover - Unit 30');
    expect(body.accessLevel).toBe('org');                    // asked for, not inherited
    expect(body.startOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);     // anchor defaults to today
    expect(body.resetStatus).toBe(true);
    expect(body.dueOn).toBeUndefined();                      // omitted so the blueprint's offset applies
    expect(onCreated).toHaveBeenCalled();
  });
});

describe('SaveTemplateModal', () => {
  it('captures structure only, and says so', async () => {
    render(<SaveTemplateModal projectId="p1" onClose={() => {}} />);

    expect(screen.getByText(/structure only/)).toBeInTheDocument();
    expect(screen.getByText(/tasks arrive unassigned/)).toBeInTheDocument();
    // No people options - there is nothing to decide, they are never captured.
    expect(screen.queryByText('Assignees and followers')).not.toBeInTheDocument();
    expect(screen.queryByText('Project members and their roles')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/Captures 24 tasks/)).toBeInTheDocument());
    expect(screen.getByText(/2 custom fields/)).toBeInTheDocument();
    expect(screen.getByText(/Fields: Phase, Cost/)).toBeInTheDocument();
    expect(screen.getByText(/Statuses: Waiting/)).toBeInTheDocument();
  });

  it('saves the capture with the chosen options', async () => {
    render(<SaveTemplateModal projectId="p1" onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Unit Turnover'), { target: { value: 'Unit Turnover' } });
    fireEvent.click(screen.getByText('Save Template'));

    await waitFor(() => expect(store.createProjectTemplate).toHaveBeenCalled());
    const body = store.createProjectTemplate.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Unit Turnover', projectId: 'p1', includeTasks: true, includeCompleted: false });
    expect(body.includeAssignees).toBeUndefined();
    expect(body.includeMembers).toBeUndefined();
  });
});

describe('DuplicateProjectModal', () => {
  it('is the opposite of a template: it offers to bring the people across', async () => {
    render(<DuplicateProjectModal project={{ id: 'p1', name: 'Turnover - Unit 12' }} onClose={() => {}} onCreated={() => {}} />);

    expect(screen.getByDisplayValue('Turnover - Unit 12 (copy)')).toBeInTheDocument();
    expect(screen.getByText('Assignees and followers')).toBeInTheDocument();
    expect(screen.getByText('Project members')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Duplicate Project'));

    await waitFor(() => expect(store.duplicateProject).toHaveBeenCalled());
    const [id, body] = store.duplicateProject.mock.calls[0];
    expect(id).toBe('p1');
    expect(body.startOn).toBe('');            // blank keeps the original's own plan
    expect(body.includeAssignees).toBe(true);
    expect(body.includeMembers).toBe(true);
  });
});
