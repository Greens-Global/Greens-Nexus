// Message and Call on every person (Frontline Reach, Neil 11/02/2026): two
// small icon links into Microsoft Teams, drawn wherever a person appears -
// the directory, the org chart, a ticket's requester and assignee, a task's
// assignees, the hover card. Nexus does not have chat of its own; this is the
// answer to it. Hidden entirely when the person cannot be reached on Teams
// (an external guest, no work email, yourself, or `known={false}` - an
// address that is not in Nexus People, e.g. a ticket mailed in from outside)
// - never a dead button.
//
// Two looks: `variant="icon"` (default) is two bordered squares for a row or
// a field; `variant="pill"` is the hover card's labeled pill ("Message",
// "Call") so it sits level with its Email and Profile pills.
import { MessageSquare, Phone } from 'lucide-react';
import { teamsChatUrl, teamsCallUrl, canReachOnTeams } from '../lib/teamsLinks';

const SIZES = { sm: { box: 28, icon: 14 }, md: { box: 34, icon: 17 } };

export const PILL = {
  display: 'inline-flex', alignItems: 'center', gap: 5, flex: 1, justifyContent: 'center',
  padding: '5px 8px', borderRadius: 7, background: 'var(--mist)', color: 'var(--ink)',
  fontSize: 12, fontWeight: 600, textDecoration: 'none', font: 'inherit',
};

export default function PersonActions({ email, name = '', external = false, known = true, myEmail = '', size = 'sm', variant = 'icon', message = true, call = true, style }) {
  if (!known || !canReachOnTeams({ email, external }, myEmail)) return null;
  const s = SIZES[size] || SIZES.sm;
  const who = name || email;
  const pill = variant === 'pill';
  const link = pill ? PILL : {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: s.box, height: s.box,
    borderRadius: 8, color: 'var(--muted)', border: '1px solid var(--line)', background: 'var(--card)',
    textDecoration: 'none', flexShrink: 0,
  };
  const icon = pill ? 13 : s.icon;
  const stop = (e) => e.stopPropagation();
  const wrap = pill ? { display: 'contents' } : { display: 'inline-flex', gap: 4, ...style };
  return (
    <span className="nx-person-actions" style={wrap} onClick={stop}>
      {message && (
        <a href={teamsChatUrl(email)} target="_blank" rel="noopener noreferrer" style={link}
          title="Message on Teams" aria-label={`Message ${who} on Teams`} onClick={stop}>
          <MessageSquare size={icon} />{pill && ' Message'}
        </a>
      )}
      {call && (
        <a href={teamsCallUrl(email)} target="_blank" rel="noopener noreferrer" style={link}
          title="Call on Teams" aria-label={`Call ${who} on Teams`} onClick={stop}>
          <Phone size={icon} />{pill && ' Call'}
        </a>
      )}
    </span>
  );
}
