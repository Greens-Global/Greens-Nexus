import { describe, it, expect } from 'vitest';
import { teamsForCell, typesForTeams } from './shiftTypeTeams';

const GROUPS = [
  { id: 'ops', members: ['amy@x.com', 'val@x.com'] },
  { id: 'it', members: ['ian@x.com'] },
  { id: 'old', archived: true, members: ['amy@x.com'] },
];
const TYPES = [
  { id: 'gsv', groupIds: ['ops'] },
  { id: 'its', groupIds: ['it'] },
  { id: 'any', groupIds: [] },
  { id: 'legacy' },
];

describe('shift types by team', () => {
  it('a cell belongs to its row team, else every live team the person is on', () => {
    expect(teamsForCell(GROUPS, 'amy@x.com', 'it')).toEqual(['it']);
    expect(teamsForCell(GROUPS, 'Amy@X.com', '')).toEqual(['ops']);
    expect(teamsForCell(GROUPS, 'nobody@x.com', '')).toEqual([]);
    expect(teamsForCell(GROUPS, '', '')).toEqual([]);
  });
  it('Operations sees its own types and the shared ones, never IT Support', () => {
    expect(typesForTeams(TYPES, ['ops']).map((t) => t.id)).toEqual(['gsv', 'any', 'legacy']);
  });
  it('keeps the type already chosen, and offers everything with no team', () => {
    expect(typesForTeams(TYPES, ['ops'], ['its']).map((t) => t.id)).toEqual(['gsv', 'its', 'any', 'legacy']);
    expect(typesForTeams(TYPES, []).length).toBe(4);
  });
});
