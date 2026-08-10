import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the person page - a new top-level surface, so per CLAUDE.md
// it gets a test that catches a crash-on-render before merge.

const profile = {
  person: {
    email: 'ashley@greensglobal.com', name: 'Ashley Vizcarra', displayName: '',
    jobTitle: 'Operations Manager', department: 'Operations', location: 'Redwood City, CA',
    photoUrl: '', identityType: 'internal', status: 'active', inDirectory: true,
  },
  stats: { open: 3, completed: 5, overdue: 1 },
  tasks: {
    assigned: [
      { id: 't1', code: 'TASK-1', title: 'Rebrand the footer', completed: false,
        status: 'not_started', dueOn: '2026-09-01', assigneeId: 'ashley@greensglobal.com',
        projectId: 'p1', projectName: 'Marketing Site' },
      { id: 't2', code: 'TASK-2', title: 'Old finished thing', completed: true,
        status: 'completed', dueOn: '', assigneeId: 'ashley@greensglobal.com',
        projectId: '', projectName: '' },
    ],
    created: [
      { id: 't3', code: 'TASK-3', title: 'Handed to someone else', completed: false,
        status: 'not_started', dueOn: '', assigneeId: 'other@greensglobal.com',
        projectId: '', projectName: '' },
    ],
    assignedByYou: [
      { id: 't4', code: 'TASK-4', title: 'Thing I gave them', completed: false,
        status: 'not_started', dueOn: '', assigneeId: 'ashley@greensglobal.com',
        projectId: '', projectName: '' },
    ],
    collaboratingWithYou: [
      { id: 't5', code: 'TASK-5', title: 'Shared with me', completed: false,
        status: 'not_started', dueOn: '', assigneeId: 'other@greensglobal.com',
        projectId: '', projectName: '' },
    ],
  },
  projects: [{ id: 'p1', name: 'Marketing Site', color: '#2563eb' }],
  teams: [{ id: 'tm1', name: 'Operations', color: '#0d9488' }],
};

const getPersonProfile = vi.fn(() => Promise.resolve(profile));
// Avatar resolves photos through the people directory, so the mock has to
// answer that too or every render throws inside the avatar.
vi.mock('../api', () => ({
  api: {
    getPersonProfile: (...a) => getPersonProfile(...a),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 3, myEmail: 'me@greensglobal.com' }),
}));
vi.mock('./CreateTaskModal', () => ({ default: () => <div data-testid="create-modal" /> }));
vi.mock('./TaskDetailDrawer', () => ({ default: ({ taskId }) => <div data-testid="drawer">{taskId}</div> }));

const PersonView = (await import('./PersonView')).default;

const props = { email: 'ashley@greensglobal.com', name: 'Ashley Vizcarra', onBack: () => {} };

describe('PersonView render-smoke', () => {
  beforeEach(() => { getPersonProfile.mockClear(); });

  it('shows who the person is, not just their tasks', async () => {
    render(<PersonView {...props} />);

    expect(await screen.findByText('Ashley Vizcarra')).toBeInTheDocument();
    expect(screen.getByText(/Operations Manager/)).toBeInTheDocument();
    expect(screen.getByText('ashley@greensglobal.com')).toBeInTheDocument();
  });

  it('rolls up open, overdue and completed', async () => {
    render(<PersonView {...props} />);
    await screen.findByText('Ashley Vizcarra');

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('lists their assigned work first, striking through what is done', async () => {
    render(<PersonView {...props} />);

    const done = await screen.findByText('Old finished thing');
    expect(screen.getByText('Rebrand the footer')).toBeInTheDocument();
    expect(done).toHaveStyle({ textDecoration: 'line-through' });
  });

  it('switches to what they handed out', async () => {
    render(<PersonView {...props} />);
    await screen.findByText('Rebrand the footer');

    fireEvent.click(screen.getByText('Assigned By Them'));

    expect(await screen.findByText('Handed to someone else')).toBeInTheDocument();
    expect(screen.queryByText('Rebrand the footer')).not.toBeInTheDocument();
  });

  it('separates what you gave them from what they hold', async () => {
    render(<PersonView {...props} />);
    await screen.findByText('Rebrand the footer');

    fireEvent.click(screen.getByText('Assigned By You'));

    expect(await screen.findByText('Thing I gave them')).toBeInTheDocument();
    expect(screen.queryByText('Handed to someone else')).not.toBeInTheDocument();
  });

  it('shows where the two of you overlap', async () => {
    render(<PersonView {...props} />);
    await screen.findByText('Rebrand the footer');

    fireEvent.click(screen.getByText('Collaborating With You'));

    expect(await screen.findByText('Shared with me')).toBeInTheDocument();
  });

  it('shows their projects and teams', async () => {
    render(<PersonView {...props} />);
    await screen.findByText('Ashley Vizcarra');

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();
    // Twice over: the task row's project chip and the Projects card.
    expect(screen.getAllByText('Marketing Site').length).toBeGreaterThan(0);
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });

  it('opens the drawer when a task row is clicked', async () => {
    render(<PersonView {...props} />);

    fireEvent.click(await screen.findByText('Rebrand the footer'));

    expect(await screen.findByTestId('drawer')).toHaveTextContent('t1');
  });

  it('renders somebody with no directory record without throwing', async () => {
    getPersonProfile.mockResolvedValueOnce({
      ...profile,
      person: { ...profile.person, name: 'guest@partner.com', email: 'guest@partner.com',
                jobTitle: '', department: '', identityType: 'external', inDirectory: false },
      tasks: { assigned: [], assignedByYou: [], created: [], collaboratingWithYou: [] },
      projects: [], teams: [],
    });

    render(<PersonView {...props} email="guest@partner.com" name="guest@partner.com" />);

    expect(await screen.findByText(/Not in the Nexus people directory/)).toBeInTheDocument();
    expect(screen.getByText('External')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of rendering an empty shell', async () => {
    getPersonProfile.mockRejectedValueOnce(new Error('nope'));

    render(<PersonView {...props} />);

    await waitFor(() => expect(screen.queryByText('Projects')).not.toBeInTheDocument());
  });
});
