import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectList } from './ProjectsView';

// Avatar reaches through PersonHover into RoleContext; same stub the other task
// tests use so the row can be rendered on its own.
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 3, myEmail: '' }),
}));

// Render-smoke for the Projects list view (the grid's sibling - same rollups,
// different shape). Mounting it with the real `cards` shape catches a
// crash-on-render that build and lint miss, per CLAUDE.md's rule for new
// top-level surfaces.

const card = (over = {}) => ({
  project: {
    id: 'p1', name: 'General GGCorp', color: '#2563eb', ownerId: 'sagar@greensglobal.com',
    hrDepartmentName: 'Administration', portfolioId: '', archived: false, teams: [],
    ...(over.project || {}),
  },
  stats: { total: 6, completed: 6, inProgress: 0, overdue: 0, pct: 100, ...(over.stats || {}) },
});

const props = {
  isMobile: false,
  nameOf: (e) => (e === 'sagar@greensglobal.com' ? 'Sagar Kumar Shoundik' : ''),
  portfolioById: () => null,
  onOpen: () => {},
  onEdit: () => {},
  onDelete: () => {},
};

describe('ProjectList render-smoke', () => {
  it('renders a row per project with its rollup', () => {
    render(<ProjectList {...props} cards={[card(), card({ project: { id: 'p2', name: 'Riverside Drive' }, stats: { total: 1, completed: 0, pct: 0, overdue: 1 } })]} />);

    expect(screen.getByText('General GGCorp')).toBeInTheDocument();
    expect(screen.getByText('Riverside Drive')).toBeInTheDocument();
    expect(screen.getByText('6/6 done')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('derives status from the rollup, not a stored field', () => {
    render(<ProjectList {...props} cards={[
      card(),                                                                        // all done
      card({ project: { id: 'p2', name: 'Half' }, stats: { total: 4, completed: 2, pct: 50 } }),
      card({ project: { id: 'p3', name: 'Fresh' }, stats: { total: 3, completed: 0, inProgress: 0, pct: 0 } }),
    ]} />);

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Not Started')).toBeInTheDocument();
  });

  it('opens the project when the row is clicked', () => {
    const onOpen = vi.fn();
    render(<ProjectList {...props} onOpen={onOpen} cards={[card()]} />);

    fireEvent.click(screen.getByText('General GGCorp'));

    expect(onOpen).toHaveBeenCalledWith('p1');
  });

  it('does not open the project when an action button is clicked', () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    render(<ProjectList {...props} onOpen={onOpen} onEdit={onEdit} cards={[card()]} />);

    fireEvent.click(screen.getByTitle('Edit Project'));

    expect(onEdit).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows an overdue count only when there is one', () => {
    const { rerender } = render(<ProjectList {...props} cards={[card()]} />);
    expect(screen.queryByTitle('3 overdue')).not.toBeInTheDocument();

    rerender(<ProjectList {...props} cards={[card({ stats: { overdue: 3 } })]} />);
    expect(screen.getByTitle('3 overdue')).toBeInTheDocument();
  });

  it('renders teams, falling back to the department when there are none', () => {
    render(<ProjectList {...props} cards={[
      card({ project: { id: 'p1', name: 'With teams', teams: [{ id: 't1', name: 'IT', color: '#0d9488' }] } }),
      card({ project: { id: 'p2', name: 'No teams', teams: [], hrDepartmentName: 'Accounting' } }),
    ]} />);

    expect(screen.getByText('IT')).toBeInTheDocument();
    expect(screen.getByText('Accounting')).toBeInTheDocument();
  });

  it('renders the mobile layout without throwing', () => {
    render(<ProjectList {...props} isMobile cards={[card()]} />);

    expect(screen.getByText('General GGCorp')).toBeInTheDocument();
    expect(screen.getByText('6/6 done')).toBeInTheDocument();
  });

  it('marks an archived project', () => {
    render(<ProjectList {...props} cards={[card({ project: { archived: true } })]} />);

    expect(screen.getByText('Archived')).toBeInTheDocument();
  });
});
