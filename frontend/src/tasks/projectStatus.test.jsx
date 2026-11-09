import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectList } from './ProjectsView';
import { projectHealth, healthTitle } from './projectStatus';

// Project status (Neil, 11/08/2026): the Projects list shows the set status
// as a soft chip titled with who set it and why; a never-set project keeps
// the rollup's word; an editor's click opens the popover and Save calls the
// store with the status and the note.

vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, myGrantedModules: [], myLevel: 3, myEmail: '' }),
}));

const card = (over = {}) => ({
  project: {
    id: 'p1', name: 'Escondido Gate Rebuild', color: '#2563eb', ownerId: 'sam@x.com', hrDepartmentName: 'Operations',
    portfolioId: '', archived: false, teams: [], ...(over.project || {}),
  },
  stats: { total: 8, completed: 2, inProgress: 3, overdue: 0, pct: 25, ...(over.stats || {}) },
});
const props = { isMobile: false, nameOf: (e) => (e === 'sam@x.com' ? 'Sam Lee' : e), portfolioById: () => null, onOpen: () => {}, onEdit: () => {}, onDelete: () => {} };
const setOn = { status: 'at_risk', statusNote: 'Permits are late', statusSetBy: 'sam@x.com', statusSetAt: '2026-11-08T15:00:00+00:00' };

describe('projectHealth', () => {
  it('reads only a status somebody set, with a title saying who and why', () => {
    expect(projectHealth({ status: 'on_track' })).toBeNull();
    expect(projectHealth({ status: 'on_track', statusSetAt: '2026-11-08' }).label).toBe('On Track');
    expect(healthTitle({ ...setOn }, props.nameOf)).toBe('Set by Sam Lee on 11/08/2026: Permits are late');
  });
});

describe('ProjectList status chip', () => {
  it('shows the rollup word for a project nobody has set, and the set status otherwise', () => {
    render(<ProjectList {...props} cards={[card(), card({ project: { id: 'p2', name: 'Roof Job', ...setOn } })]} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('At Risk')).toBeInTheDocument();
    expect(screen.getByTitle('Set by Sam Lee on 11/08/2026: Permits are late')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Project status/ })).toBeNull();   // read only without an editor
  });

  it('an editor picks a status and a why, Save calls the store, and the row does not open', async () => {
    const onSetStatus = vi.fn(() => Promise.resolve({}));
    const onOpen = vi.fn();
    render(<ProjectList {...props} onOpen={onOpen} canSetStatus={() => true} onSetStatus={onSetStatus} cards={[card({ project: setOn })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project status: At Risk. Change it' }));
    const offTrack = await screen.findByRole('radio', { name: 'Off Track' });
    expect(screen.getByRole('radio', { name: 'At Risk' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(offTrack);
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Gate steel is three weeks out' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), { status: 'off_track', statusNote: 'Gate steel is three weeks out' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a never-set project is set through the rollup word', async () => {
    const onSetStatus = vi.fn(() => Promise.resolve({}));
    render(<ProjectList {...props} canSetStatus={() => true} onSetStatus={onSetStatus} cards={[card()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set the project status' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'On Track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith(expect.anything(), { status: 'on_track', statusNote: '' }));
  });
});
