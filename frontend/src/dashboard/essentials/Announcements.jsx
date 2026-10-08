// Announcements (Essentials, Oct 7) - registered as 'announcements' in
// widgets.jsx, its own lazy chunk so it loads only when the tile is on the
// board. Scaffold: the body is a placeholder until the builder fills it in
// (api.getAnnouncements / markAnnouncementRead / ackAnnouncement ->
// routers/announcements.py). DashCard / navigate come from widgets.jsx,
// Row / noteStyle from workdayWidgets.jsx.
import { DashCard } from '../widgets.jsx';

const placeholder = { fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 };

export default function Announcements() {
  return (
    <DashCard title="Announcements">
      <div style={placeholder}>Coming soon</div>
    </DashCard>
  );
}
