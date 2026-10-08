// My Work (Essentials, Oct 7) - registered as 'my-work' in widgets.jsx, its
// own lazy chunk so it loads only when the tile is on the board. Scaffold:
// the body is a placeholder until the builder fills it in (api.getMyWork ->
// GET /me/work). DashCard / navigate come from widgets.jsx, Row / noteStyle
// from workdayWidgets.jsx, so this tile reads like every other one.
import { DashCard } from '../widgets.jsx';

const placeholder = { fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 };

export default function MyWork() {
  return (
    <DashCard title="My Work">
      <div style={placeholder}>Coming soon</div>
    </DashCard>
  );
}
