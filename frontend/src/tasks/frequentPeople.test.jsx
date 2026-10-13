import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { frequentCollaborators, frequentRows } from './frequentPeople';
import { PersonMultiSelect } from './components';

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// "Frequent" in the Collaborators pickers (Neil, Oct 12 2026): who you share
// the most recent tasks with comes first, above the full A-Z list.

const NOW = Date.parse('2026-10-12T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const ME = 'neil@greensglobal.com';
let seq = 0;
const task = (people, ago, extra = {}) => ({
  id: `t${++seq}`, ownerId: ME, assigneeIds: [], followerIds: people, modifiedAt: daysAgo(ago), ...extra,
});

describe('frequentCollaborators', () => {
  it('ranks by shared recent tasks, recent ones counting double', () => {
    const tasks = [
      // Ana: 3 old tasks = 3 points. Ben: 2 recent tasks = 4 points.
      task(['ana@x.com'], 100), task(['ana@x.com'], 110), task(['ana@x.com'], 120),
      task(['ben@x.com'], 3), task(['ben@x.com'], 10),
    ];
    expect(frequentCollaborators(tasks, ME, { now: NOW })).toEqual(['ben@x.com', 'ana@x.com']);
  });

  it('needs two shared tasks, so a one-off never shows', () => {
    const tasks = [task(['once@x.com'], 2), task(['twice@x.com'], 2), task(['twice@x.com'], 5)];
    expect(frequentCollaborators(tasks, ME, { now: NOW })).toEqual(['twice@x.com']);
  });

  it('ignores tasks older than six months and tasks I am not on', () => {
    const tasks = [
      task(['old@x.com'], 200), task(['old@x.com'], 250),
      task(['other@x.com'], 2, { ownerId: 'someone@x.com' }), task(['other@x.com'], 3, { ownerId: 'someone@x.com' }),
    ];
    expect(frequentCollaborators(tasks, ME, { now: NOW })).toEqual([]);
  });

  it('counts me and them as owner, assignee or collaborator, case-insensitively', () => {
    const tasks = [
      { id: 'a', ownerId: 'Cara@X.com', assigneeIds: ['NEIL@greensglobal.com'], followerIds: [], modifiedAt: daysAgo(1) },
      { id: 'b', ownerId: 'x@x.com', assigneeId: 'cara@x.com', followerIds: [ME], createdAt: daysAgo(40) },
      { id: 's', type: 'section', ownerId: ME, followerIds: ['cara@x.com'], modifiedAt: daysAgo(1) },
    ];
    // x@x.com shares only one task with me.
    expect(frequentCollaborators(tasks, ME, { now: NOW })).toEqual(['cara@x.com']);
  });

  it('keeps the top five, ties alphabetical', () => {
    const names = ['f', 'e', 'd', 'c', 'b', 'a'].map((n) => `${n}@x.com`);
    const tasks = names.flatMap((em) => [task([em], 2), task([em], 3)]);
    expect(frequentCollaborators(tasks, ME, { now: NOW })).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  });

  it('drops frequent emails that are not in the picker list', () => {
    const people = [{ email: 'a@x.com', name: 'A' }];
    expect(frequentRows(people, ['gone@x.com', 'a@x.com'])).toEqual([{ email: 'a@x.com', name: 'A' }]);
  });

  it('fills to five past people who left the list', () => {
    const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ email: `${n}@x.com`, name: n }));
    const rows = frequentRows(people, ['gone@x.com', 'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com']);
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

const people = [
  { email: 'zoe@x.com', name: 'Zoe Zhang' },
  { email: 'amy@x.com', name: 'Amy Adams' },
  { email: 'max@x.com', name: 'Max Moore' },
];

function Harness({ frequent }) {
  const [value, setValue] = useState([]);
  return <PersonMultiSelect value={value} onChange={setValue} people={people} frequent={frequent} placeholder="Add collaborators…" />;
}

describe('PersonMultiSelect with a Frequent group', () => {
  beforeEach(() => {
    globalThis.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  });

  it('shows Frequent first, then All A-Z', () => {
    render(<Harness frequent={['zoe@x.com']} />);
    fireEvent.click(screen.getByText('Add collaborators…'));
    const text = document.body.textContent;
    expect(text.indexOf('Frequent')).toBeGreaterThan(-1);
    expect(text.indexOf('Frequent')).toBeLessThan(text.indexOf('All'));
    // Zoe is in both groups; All stays alphabetical.
    expect(screen.getAllByText('Zoe Zhang')).toHaveLength(2);
    expect(text.indexOf('Amy Adams')).toBeGreaterThan(text.indexOf('All'));
  });

  it('a search is one flat list with no group captions', () => {
    render(<Harness frequent={['zoe@x.com']} />);
    fireEvent.click(screen.getByText('Add collaborators…'));
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'zo' } });
    expect(screen.queryByText('Frequent')).toBeNull();
    expect(screen.getAllByText('Zoe Zhang')).toHaveLength(1);
  });

  it('picking from Frequent adds the person once', () => {
    render(<Harness frequent={['zoe@x.com']} />);
    fireEvent.click(screen.getByText('Add collaborators…'));
    fireEvent.click(screen.getAllByText('Zoe Zhang')[0]);
    expect(screen.getByTitle('Remove Zoe Zhang')).toBeInTheDocument();
  });

  it('no frequent list means no captions, as before', () => {
    render(<Harness frequent={[]} />);
    fireEvent.click(screen.getByText('Add collaborators…'));
    expect(screen.queryByText('Frequent')).toBeNull();
    expect(screen.queryByText('All')).toBeNull();
    expect(within(document.body).getAllByText(/Adams|Moore|Zhang/)).toHaveLength(3);
  });
});
