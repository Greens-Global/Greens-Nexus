// My Team (Essentials, Oct 7) - registered as 'my-team' in widgets.jsx with
// minRole 'supervisor', its own lazy chunk so it loads only when the tile is
// on the board. Scaffold: the body is a placeholder until the builder fills
// it in (api.getMyTeamToday / getMyTeamOverdue -> routers/my_team.py).
// DashCard / navigate come from widgets.jsx, Row / noteStyle from
// workdayWidgets.jsx.
import { DashCard } from '../widgets.jsx';

const placeholder = { fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 };

export default function MyTeam() {
  return (
    <DashCard title="My Team">
      <div style={placeholder}>Coming soon</div>
    </DashCard>
  );
}
