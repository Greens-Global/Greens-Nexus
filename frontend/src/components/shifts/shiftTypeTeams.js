// Shift types belong to teams (Neil, 11/04/2026: "it's weird to see IT
// Support Team available for operations"). A type's `groupIds` lists its
// teams; none = every team. The planner offers a row only its teams' types
// (plus the shared ones), the same rule everywhere a type is picked.
// backend/shift_type_teams.py filled the old types once from their use.

// The live teams a cell belongs to: the row's team when the grid is grouped
// by team or the cell is an open shift, else every team the person is on.
export function teamsForCell(groups, email, groupId) {
  if (groupId) return [groupId];
  const em = (email || '').toLowerCase();
  if (!em) return [];
  return (groups || []).filter((g) => !g.archived && (g.members || []).some((m) => (m || '').toLowerCase() === em)).map((g) => g.id);
}

// The types for those teams, in their order. `keep` ids always stay (the
// person's usual hours, the type of the shift being edited) so a picker
// never hides what is already chosen. No team at all = every type.
export function typesForTeams(presets, teamIds, keep = []) {
  const list = presets || [];
  if (!teamIds?.length) return list;
  const want = new Set(teamIds);
  const kept = new Set((keep || []).filter(Boolean));
  return list.filter((p) => kept.has(p.id) || !(p.groupIds || []).length || p.groupIds.some((g) => want.has(g)));
}
