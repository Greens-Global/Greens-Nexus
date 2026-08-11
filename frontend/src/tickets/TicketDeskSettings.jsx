// Ticket Module - Service Desk: who owns incoming tickets (Aug 2026).
//
// Its own panel, deliberately not a field inside Ticket Email Notifications.
// The desk decides who a ticket GOES TO - who is notified, who may route it for
// approval, and who works the assignment queues. That it also changes who
// receives an email is a consequence, not what it is. Buried under mail
// settings it read as a notification preference, which is the one thing it
// isn't.
//
// Manager+ only, mirroring the backend's require_manager gate on these
// endpoints - this UI hides the control, the backend is the real boundary.
//
// Shares the ticket_notify_config settings blob with TicketNotifySettings, so
// it PATCHES only agentEmails: both panels saving whole copies of the config
// would let whichever saved second overwrite the other's field with its own
// stale value.
import { useEffect, useState } from 'react';
import { Headset, Save } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, card } from '../tasks/theme';
import { PersonMultiSelect, usePeople } from '../tasks/components';

export default function TicketDeskSettings() {
  const { myLevel } = useRole();
  const people = usePeople();
  const [agents, setAgents] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (myLevel < 3) return;
    api.getTicketNotifySettings()
      .then((c) => setAgents(c.agentEmails || []))
      .catch((e) => setErr(e.message || String(e)));
  }, [myLevel]);

  // Its own tab now, so this cannot return null - that would render the tab
  // blank with nothing explaining why (see CLAUDE.md: never let a screen render
  // blank). Same wording as the notifications tab.
  if (myLevel < 3) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Manager access or above is required to configure the service desk.
      </div>
    );
  }
  if (agents === null) {
    return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;
  }

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      const next = await api.updateTicketNotifySettings({ agentEmails: agents });
      setAgents(next.agentEmails || []);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Headset size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Service Desk</div>
      </div>
      <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 14 }}>
        Every new ticket goes to these people. They route requests for approval, assign the work,
        and see the To Route and To Assign queues.
      </div>

      <div style={{ ...card, padding: 18 }}>
        <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 }}>
          Ticket Agents
        </label>
        <PersonMultiSelect value={agents} people={people} onChange={setAgents}
          placeholder="Select ticket agents" />

        {agents.length === 0 ? (
          <div style={{ fontSize: 11.5, color: NX.amber, marginTop: 8, lineHeight: 1.5 }}>
            No desk configured, so every administrator is being notified instead. Pick people here -
            running the desk should not require admin access to the whole app.
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 8, lineHeight: 1.5 }}>
            An agent does not need administrator access. Administrators can always act on tickets
            regardless of this list, so a mistake here can never lock you out.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <button onClick={save} disabled={saving} style={btn('primary')}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
          {err && <span style={{ fontSize: 12.5, color: NX.red, fontWeight: 600 }}>{err}</span>}
        </div>
      </div>
    </div>
  );
}
