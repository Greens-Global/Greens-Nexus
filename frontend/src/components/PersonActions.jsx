// Message and Call on every person (Frontline Reach, Neil 11/02/2026): two
// small icon links into Microsoft Teams, drawn wherever a person appears -
// the directory, the org chart, a ticket's requester and assignee, a task's
// assignees, the hover card. Nexus does not have chat of its own; this is the
// answer to it. Hidden entirely when the person cannot be reached on Teams
// (an external guest, no work email, yourself) - never a dead button.
import { MessageSquare, Phone } from 'lucide-react';
import { teamsChatUrl, teamsCallUrl, canReachOnTeams } from '../lib/teamsLinks';

const SIZES = { sm: { box: 28, icon: 14 }, md: { box: 34, icon: 17 } };

export default function PersonActions({ email, name = '', external = false, myEmail = '', size = 'sm', message = true, call = true, style }) {
  if (!canReachOnTeams({ email, external }, myEmail)) return null;
  const s = SIZES[size] || SIZES.sm;
  const who = name || email;
  const link = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: s.box, height: s.box,
    borderRadius: 8, color: 'var(--muted)', border: '1px solid var(--line)', background: 'var(--card)',
    textDecoration: 'none', flexShrink: 0,
  };
  const stop = (e) => e.stopPropagation();
  return (
    <span className="nx-person-actions" style={{ display: 'inline-flex', gap: 4, ...style }} onClick={stop}>
      {message && (
        <a href={teamsChatUrl(email)} target="_blank" rel="noopener noreferrer" style={link}
          title="Message on Teams" aria-label={`Message ${who} on Teams`} onClick={stop}>
          <MessageSquare size={s.icon} />
        </a>
      )}
      {call && (
        <a href={teamsCallUrl(email)} target="_blank" rel="noopener noreferrer" style={link}
          title="Call on Teams" aria-label={`Call ${who} on Teams`} onClick={stop}>
          <Phone size={s.icon} />
        </a>
      )}
    </span>
  );
}
