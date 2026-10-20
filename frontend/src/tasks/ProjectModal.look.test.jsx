import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The icon and color picker on Edit Project (Neil, Oct 15 2026): what is
// picked reaches the save, an edit that never opens it saves the project's
// look unchanged, and Cancel discards a pick like any other edit.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 3, myEmail: 'sagar@greensglobal.com' }),
}));

const store = {
  projects: [], portfolios: [], teams: [], tasks: [], customFields: [],
  nameOf: (e) => e || '',
  createProject: vi.fn(async (d) => ({ id: 'new', ...d })),
  updateProject: vi.fn(async (id, d) => ({ id, ...d })),
  updateTeam: vi.fn(async () => ({})),
  createProjectFromTemplate: vi.fn(async () => ({ id: 'built' })),
};
vi.mock('./TasksContext', () => ({ useTasks: () => store }));
vi.mock('./components', async () => {
  const actual = await vi.importActual('./components');
  return { ...actual, usePeople: () => [] };
});
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

const { ProjectModal } = await import('./ProjectsView');
const { projectToForm } = await import('./lib');

function Harness({ project, onClose = () => {} }) {
  const [form, setForm] = useState(() => projectToForm(project));
  return <ProjectModal form={form} setForm={setForm} people={[]} portfolios={[]} onClose={onClose} onSaved={() => {}} />;
}

const project = (over) => ({ id: 'p1', name: 'Smith Street', color: null, icon: null, accessLevel: 'restricted', ...over });

beforeEach(() => { store.updateProject.mockClear(); });

describe('Edit Project: icon and color', () => {
  it('saves what was picked', async () => {
    render(<Harness project={project()} />);
    fireEvent.click(screen.getByTitle('Change Icon and Color'));
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hard Hat' }));
    fireEvent.click(screen.getByText('Done'));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(store.updateProject).toHaveBeenCalled());
    const [id, body] = store.updateProject.mock.calls[0];
    expect(id).toBe('p1');
    expect(body).toMatchObject({ color: '#0d9488', icon: 'hard-hat', name: 'Smith Street' });
  });

  it("an edit that never opens it keeps the project's look", async () => {
    render(<Harness project={project({ color: '#16a34a', icon: 'truck' })} />);
    fireEvent.change(screen.getByPlaceholderText('Project Name'), { target: { value: 'Smith St' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(store.updateProject).toHaveBeenCalled());
    expect(store.updateProject.mock.calls[0][1]).toMatchObject({ name: 'Smith St', color: '#16a34a', icon: 'truck' });
  });

  it('an unstyled project saves as unstyled', async () => {
    render(<Harness project={project()} />);
    fireEvent.change(screen.getByPlaceholderText('Project Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(store.updateProject).toHaveBeenCalled());
    expect(store.updateProject.mock.calls[0][1].icon).toBe('');
  });
});
