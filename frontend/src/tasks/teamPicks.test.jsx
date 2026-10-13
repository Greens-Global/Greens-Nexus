import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TeamPicks, { teamRoster, pickableTeams, rosterState, toggleRoster, rosterExists } from './teamPicks';

// Teams in the Collaborators pickers (Neil, Oct 13 2026): one click adds a
// team's whole roster as ordinary collaborators, so the odd one out can be
// x'd off; the roster is narrowed to the people the picker offers.

const people = [
  { email: 'pragya@greensglobal.com', name: 'Pragya Nautiyal' },
  { email: 'pranshu@greensglobal.com', name: 'Pranshu Pandey' },
  { email: 'sahil@greensglobal.com', name: 'Sahil Sharma' },
];
const teams = [
  { id: 't-dev', name: 'Development', color: '#2563eb', approvalStatus: 'approved',
    memberIds: ['Pragya@greensglobal.com', 'pranshu@greensglobal.com', 'left@greensglobal.com'] },
  { id: 't-ops', name: 'Ops', approvalStatus: 'personal', memberIds: ['sahil@greensglobal.com'] },
  { id: 't-empty', name: 'Ghosts', memberIds: ['gone@greensglobal.com'] },
];

describe('team rosters', () => {
  it('keeps only members the picker knows, lowercased and deduped', () => {
    expect(teamRoster(teams[0], people)).toEqual(['pragya@greensglobal.com', 'pranshu@greensglobal.com']);
    expect(teamRoster(teams[2], people)).toEqual([]);
  });

  it('offers teams with at least one known member, A-Z, narrowed by the query', () => {
    expect(pickableTeams(teams, people).map((r) => r.team.id)).toEqual(['t-dev', 't-ops']);
    expect(pickableTeams(teams, people, 'dev').map((r) => r.team.id)).toEqual(['t-dev']);
    expect(pickableTeams(teams, people, 'zzz')).toEqual([]);
  });

  it('reports none / some / all against the selection', () => {
    const roster = teamRoster(teams[0], people);
    expect(rosterState(roster, [])).toBe('none');
    expect(rosterState(roster, ['pragya@greensglobal.com'])).toBe('some');
    expect(rosterState(roster, ['pragya@greensglobal.com', 'pranshu@greensglobal.com', 'sahil@greensglobal.com'])).toBe('all');
  });

  it('fills in the missing members, and takes the whole roster off once they are all on', () => {
    const roster = teamRoster(teams[0], people);
    expect(toggleRoster(['pragya@greensglobal.com'], roster))
      .toEqual({ next: ['pragya@greensglobal.com', 'pranshu@greensglobal.com'], adding: true });
    expect(toggleRoster(['sahil@greensglobal.com', 'pragya@greensglobal.com', 'pranshu@greensglobal.com'], roster))
      .toEqual({ next: ['sahil@greensglobal.com'], adding: false });
  });

  it('knows when the selection already is a team', () => {
    expect(rosterExists(teams, people, ['pranshu@greensglobal.com', 'pragya@greensglobal.com'])).toBe(true);
    expect(rosterExists(teams, people, ['pranshu@greensglobal.com'])).toBe(false);
  });
});

function Harness({ initial = [], onSaveTeam = null, query = '' }) {
  const [sel, setSel] = useState(initial);
  return (
    <>
      <TeamPicks teams={teams} people={people} selected={sel} query={query} onSaveTeam={onSaveTeam}
        onChange={(next) => setSel(next)} />
      <div data-testid="sel">{sel.join(',')}</div>
    </>
  );
}

describe('TeamPicks', () => {
  it('renders nothing when there is no team to offer', () => {
    render(<TeamPicks teams={[]} people={people} selected={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('team-picks')).toBeNull();
    render(<TeamPicks teams={[teams[2]]} people={people} selected={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('team-picks')).toBeNull();
  });

  it('adds the whole roster in one click, shows a partial team as mixed, and removes it on the next click', () => {
    render(<Harness />);
    const row = screen.getByTitle('Add Development (2)');
    fireEvent.click(row);
    expect(screen.getByTestId('sel')).toHaveTextContent('pragya@greensglobal.com,pranshu@greensglobal.com');
    // all on -> the row offers to remove
    const remove = screen.getByTitle('Remove Development (2)');
    expect(remove.querySelector('input')).toBeChecked();
    fireEvent.click(remove);
    expect(screen.getByTestId('sel')).toHaveTextContent('');
  });

  it('marks a half-added team as mixed, and a personal team as such', () => {
    render(<Harness initial={['pragya@greensglobal.com']} />);
    const box = screen.getByTitle('Add Development (2)').querySelector('input');
    expect(box.indeterminate).toBe(true);
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect(screen.getByText('Personal')).toBeInTheDocument();
  });

  it('hides teams that do not match the search, including the save row', () => {
    render(<Harness initial={['pragya@greensglobal.com', 'sahil@greensglobal.com']} onSaveTeam={vi.fn()} query="ops" />);
    expect(screen.getByText('Ops')).toBeInTheDocument();
    expect(screen.queryByText('Development')).toBeNull();
    expect(screen.queryByText(/Save These/)).toBeNull();
  });

  it('offers to save two or more people that are not already a team, and names it', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(<Harness initial={['pragya@greensglobal.com', 'sahil@greensglobal.com']} onSaveTeam={save} />);
    fireEvent.click(screen.getByText('Save These 2 People as a Team'));
    const name = screen.getByLabelText('Team name');
    fireEvent.change(name, { target: { value: 'Site Visits' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(save).toHaveBeenCalledWith({ name: 'Site Visits', memberIds: ['pragya@greensglobal.com', 'sahil@greensglobal.com'] }));
    await waitFor(() => expect(screen.queryByLabelText('Team name')).toBeNull());
  });

  it('does not offer to save a selection that already is a team, or a single person', () => {
    render(<Harness initial={['pragya@greensglobal.com', 'pranshu@greensglobal.com']} onSaveTeam={vi.fn()} />);
    expect(screen.queryByText(/Save These/)).toBeNull();
    render(<Harness initial={['sahil@greensglobal.com']} onSaveTeam={vi.fn()} />);
    expect(screen.queryByText(/Save These/)).toBeNull();
  });
});
