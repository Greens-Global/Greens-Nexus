// Teams in the Collaborators pickers (Neil, Oct 13 2026): the same batch of
// people gets added to task after task, and adding them one name at a time -
// then forgetting one - is the slow part. A team row adds its whole roster in
// one click; the people land as ordinary collaborators, so the one or two who
// do not belong on THIS task are x'd off the way any collaborator is.
//
// No new concept: these are the module's Teams (TaskTeam), the ones the Teams
// tab shows - approved teams for everyone, a personal team for whoever made
// it. The server already filters the list to what the caller may see
// (task_projects.list_teams), so a team here is one you are allowed to know
// the roster of. "Save as a Team" below makes a personal team from the people
// already on the task, which is how the batch gets built in the first place.
//
// A team is a snapshot at click time, not a live link: the task keeps the
// people, not the team, so removing someone later or the team changing has
// no hidden effect on tasks already made. The roster is also narrowed to the
// people the picker itself offers - someone who left the directory is never
// added by way of a stale team, and a picker that withholds externals keeps
// withholding them.
import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { NX, FONT, btn } from './theme';

const lower = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');

/** The members of `team` that `people` knows, spelled as `people` spells
 *  them (so a person row's own `includes(u.email)` keeps matching), in
 *  roster order, deduped. */
export function teamRoster(team, people) {
  const known = new Map();
  for (const p of people || []) { const k = lower(p.email); if (k && !known.has(k)) known.set(k, p.email); }
  const seen = new Set();
  const out = [];
  for (const raw of team?.memberIds || []) {
    const k = lower(raw);
    if (k && known.has(k) && !seen.has(k)) { seen.add(k); out.push(known.get(k)); }
  }
  return out;
}

/** Teams worth offering: at least one known member, A-Z, narrowed by `query`. */
export function pickableTeams(teams, people, query = '') {
  const needle = (query || '').trim().toLowerCase();
  return (teams || [])
    .map((team) => ({ team, roster: teamRoster(team, people) }))
    .filter(({ team, roster }) => roster.length > 0
      && (!needle || String(team.name || '').toLowerCase().includes(needle)))
    .sort((a, b) => String(a.team.name || '').localeCompare(String(b.team.name || ''), 'en', { sensitivity: 'base' }));
}

/** The team Enter should pick when the search matches a team but no person. */
export function firstTeamPick(teams, people, query = '') {
  return pickableTeams(teams, people, query)[0] || null;
}

/** 'all' when every roster member is selected, 'some' when a few are, else 'none'. */
export function rosterState(roster, selected) {
  const on = new Set((selected || []).map(lower));
  const hits = roster.filter((em) => on.has(lower(em))).length;
  if (!roster.length || hits === 0) return 'none';
  return hits === roster.length ? 'all' : 'some';
}

/** The selection after clicking a team row: fill in the missing members, or
 *  when they are all already on, take the whole roster off. */
export function toggleRoster(selected, roster) {
  const cur = Array.isArray(selected) ? selected : [];
  if (rosterState(roster, cur) === 'all') {
    const drop = new Set(roster.map(lower));
    return { next: cur.filter((em) => !drop.has(lower(em))), adding: false };
  }
  const have = new Set(cur.map(lower));
  return { next: [...cur, ...roster.filter((em) => !have.has(lower(em)))], adding: true };
}

/** True when some team's roster is exactly the selection - nothing to save. */
export function rosterExists(teams, people, selected) {
  const want = new Set((selected || []).map(lower).filter(Boolean));
  if (!want.size) return false;
  return (teams || []).some((team) => {
    const roster = teamRoster(team, people);
    return roster.length === want.size && roster.every((em) => want.has(lower(em)));
  });
}

// Same caption as components.jsx's MenuCaption, written out here so this file
// and components.jsx do not import each other.
function Caption({ children, inset }) {
  return (
    <div role="presentation" style={{
      padding: `9px ${inset}px 4px`, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em',
      textTransform: 'uppercase', color: NX.faint, cursor: 'default', userSelect: 'none',
    }}>{children}</div>
  );
}

// A real checkbox, so a label click reaches it once and Space toggles it
// from the keyboard, the same as the person rows around it. `indeterminate`
// is a DOM property with no React prop, so it is set on the node.
function TeamCheckbox({ state, onToggle }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return <input ref={ref} type="checkbox" className="nx-check" checked={state === 'all'} onChange={onToggle} />;
}

/**
 * The "Teams" group for a collaborators picker. Renders nothing when there is
 * no team to offer (or none matches `query`), so a workspace without teams
 * sees the picker exactly as before.
 *
 *   teams       the module's teams (useTasks().teams)
 *   people      the rows this picker offers - the roster is narrowed to them
 *   selected    the current collaborator emails
 *   onChange    (nextEmails, adding) - `adding` is what the mobile pickers use
 *               to decide whether to close
 *   onSaveTeam  optional ({ name, memberIds }) => Promise; when given and the
 *               selection is two or more people that no team already matches,
 *               a "Save as a Team" row offers to keep them as a personal team
 *   query       what is typed in the picker's search box
 *   inset       caption inset, to line up with the host menu's rows
 *   rowPad      row padding, likewise
 */
export default function TeamPicks({ teams, people, selected, onChange, onSaveTeam = null, query = '', inset = 8, rowPad = '6px 8px' }) {
  const [saving, setSaving] = useState(false);     // the name box is open
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = pickableTeams(teams, people, query);
  const cur = Array.isArray(selected) ? selected : [];
  const canSave = !!onSaveTeam && !query.trim() && cur.length >= 2 && !rosterExists(teams, people, cur);
  if (!rows.length && !canSave) return null;

  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setError('');
    try {
      await onSaveTeam({ name: n, memberIds: cur });
      setSaving(false); setName('');
    } catch (e) {
      setError(e?.message || 'Could not save the team.');
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="team-picks">
      {rows.length > 0 && <Caption inset={inset}>Teams</Caption>}
      {rows.map(({ team, roster }) => {
        const state = rosterState(roster, cur);
        const title = state === 'all' ? `Remove ${team.name} (${roster.length})` : `Add ${team.name} (${roster.length})`;
        return (
          <label key={team.id} title={title}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: rowPad, fontSize: 13, cursor: 'pointer', color: NX.ink }}>
            <TeamCheckbox state={state} onToggle={() => { const r = toggleRoster(cur, roster); onChange(r.next, r.adding); }} />
            <span aria-hidden style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, background: team.color || NX.purple, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Users size={12} /></span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team.name}</span>
            {(team.approvalStatus || 'approved') !== 'approved' && <span style={{ fontSize: 10.5, color: NX.faint }}>Personal</span>}
            <span style={{ fontSize: 11.5, color: NX.faint, flexShrink: 0 }}>{roster.length}</span>
          </label>
        );
      })}
      {canSave && !saving && (
        <button type="button" onClick={() => { setSaving(true); setError(''); }}
          style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8, padding: rowPad, fontSize: 12.5, color: NX.blue, borderRadius: 0 }}>
          <Users size={13} /> Save These {cur.length} People as a Team
        </button>
      )}
      {canSave && saving && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: rowPad }} onClick={(e) => e.stopPropagation()}>
          <input className="nx-inline-edit" autoFocus data-own-escape value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" aria-label="Team name"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.stopPropagation(); setSaving(false); } }}
            style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${NX.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 13, fontFamily: FONT, color: NX.ink, background: NX.surface }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button type="button" onClick={save} disabled={busy || !name.trim()} style={{ ...btn('primary'), padding: '4px 10px', fontSize: 12 }}>{busy ? 'Saving…' : 'Save Team'}</button>
            <button type="button" onClick={() => setSaving(false)} style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12 }}>Cancel</button>
          </div>
          {/* A team saved here is yours: on your Teams tab, offered to you in
              these pickers, and sharable company-wide once a manager approves it. */}
          <div style={{ fontSize: 11, color: error ? NX.red : NX.faint }}>{error || 'Saves as your personal team - you will find it on the Teams tab.'}</div>
        </div>
      )}
    </div>
  );
}
