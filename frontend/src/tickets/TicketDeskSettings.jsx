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
// it PATCHES only agentEmails/agentEmailsByCompany: both panels saving whole
// copies of the config would let whichever saved second overwrite the other's
// field with its own stale value.
//
// Multi-company desks (Aug 2026, per Pranshu): Nexus now runs 4 legal
// entities under one workspace, and a single flat agent list meant every
// company's tickets paged the same people regardless of which company they
// were even about. Each company (HrEntity, from /ticket-companies - the same
// source ticket intake uses, not the permission-gated /hr/entities) gets its
// own roster now. The flat list above becomes the DEFAULT: it's what a
// company with no roster of its own falls back to, before the backend's last
// resort of "every administrator" (see ticket_notify.ticket_agents).
import { useEffect, useState } from 'react';
import { Headset, Save, Building2 } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, card } from '../tasks/theme';
import { PersonMultiSelect, usePeople } from '../tasks/components';

// The fallback chain, spelled out for whoever's reading it: a company's own
// agents, if any -> the Default Agents list, if any -> every administrator.
// Nothing here is silent - each card always shows which rung of that chain
// its tickets are actually resolving to right now, not just a warning when
// it's empty, so "why did this go to X" never requires reading the backend.
const TONE = { ok: NX.green, warn: NX.amber, danger: NX.red };

function DeskRoster({ title, hint, value, people, onChange, status, icon }) {
  return (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {icon}
        <div style={{ fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{title}</div>
      </div>
      {hint && <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 10, lineHeight: 1.5 }}>{hint}</div>}
      <PersonMultiSelect value={value} people={people} onChange={onChange} placeholder="Select ticket agents" />
      {status && (
        <div style={{ fontSize: 11.5, color: TONE[status.tone], marginTop: 8, lineHeight: 1.5, fontWeight: status.tone === 'ok' ? 400 : 600 }}>
          {status.text}
        </div>
      )}
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// What THIS card resolves to right now - mirrors ticket_agents() in
// backend/ticket_notify.py rung for rung, so the copy can never drift from
// what actually gets emailed:
//   1. this list, if it has anyone in it
//   2. else Default Agents, if THAT has anyone in it
//   3. else every administrator (the backend's last resort, so a ticket is
//      never emailed to nobody)
function companyStatus(value, defaultAgents, companyName) {
  if (value.length > 0) {
    return { tone: 'ok', text: `${companyName}'s tickets go to these ${plural(value.length, 'agent')} directly.` };
  }
  if (defaultAgents.length > 0) {
    return { tone: 'warn', text: `No agents set for ${companyName} - its tickets fall back to Default Agents (${plural(defaultAgents.length, 'agent')}) below.` };
  }
  return { tone: 'danger', text: `No agents set for ${companyName}, and Default Agents is also empty - its tickets fall back to every administrator.` };
}

function defaultStatus(value, companiesCount) {
  if (value.length > 0) {
    return {
      tone: 'ok',
      text: companiesCount > 0
        ? `Used directly for tickets with no company on file, and as the fallback for any company above left empty.`
        : `Used for every ticket - ${plural(value.length, 'agent')} configured, no per-company lists set below.`,
    };
  }
  return {
    tone: 'danger',
    text: 'Empty - every administrator is being notified instead, both here and for any company below with no agents of its own. Pick people here so running the desk doesn\'t require admin access to the whole app.',
  };
}

export default function TicketDeskSettings() {
  const { myLevel } = useRole();
  const people = usePeople();
  const [agents, setAgents] = useState(null);            // default/fallback roster (agentEmails)
  const [byCompany, setByCompany] = useState(null);       // { companyId: [email, ...] }
  const [companies, setCompanies] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (myLevel < 3) return;
    Promise.all([api.getTicketNotifySettings(), api.getTicketCompanies()])
      .then(([c, comps]) => {
        setAgents(c.agentEmails || []);
        setByCompany(c.agentEmailsByCompany || {});
        setCompanies(comps || []);
      })
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
  if (agents === null || byCompany === null || companies === null) {
    return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;
  }

  const setCompanyRoster = (companyId, next) => setByCompany((b) => ({ ...b, [companyId]: next }));

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      // Whole-list replace, same contract as before - a company missing from
      // this patch would not be "left alone", it would be dropped, so every
      // known company's roster (even an emptied one) goes in the payload.
      const next = await api.updateTicketNotifySettings({ agentEmails: agents, agentEmailsByCompany: byCompany });
      setAgents(next.agentEmails || []);
      setByCompany(next.agentEmailsByCompany || {});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Headset size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Service Desk</div>
      </div>
      <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 14, maxWidth: 900 }}>
        Every new ticket goes to these people. They route requests for approval, assign the work,
        and see the To Route and To Assign queues. A ticket is routed by the company it belongs to
        (set from the requester's People record) - give each company its own agents so one company's
        tickets don't page another's.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Default Agents stands alone, full width - it's the one every other
            card can fall back to, so it reads as the anchor, not one tile
            among equals. The companies below flow into a grid: with 4 (and
            growing) legal entities, a stacked single column just left most of
            a wide monitor blank instead of showing more desks at once. */}
        <DeskRoster
          title="Default Agents" icon={<Headset size={15} style={{ color: NX.dim }} />}
          hint="Used for any company below with no agents of its own, and for tickets with no company on file."
          value={agents} people={people} onChange={setAgents}
          status={defaultStatus(agents, companies.length)}
        />

        {companies.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 14 }}>
            {companies.map((c) => (
              <DeskRoster key={c.id}
                title={c.name} icon={<Building2 size={15} style={{ color: NX.dim }} />}
                value={byCompany[c.id] || []} people={people}
                onChange={(next) => setCompanyRoster(c.id, next)}
                status={companyStatus(byCompany[c.id] || [], agents, c.name)}
              />
            ))}
          </div>
        )}

        {companies.length === 0 && (
          <div style={{ fontSize: 12, color: NX.faint }}>
            No companies are set up yet (People → Companies). Add one there to give it its own desk.
          </div>
        )}

        <div style={{ fontSize: 11.5, color: NX.faint, lineHeight: 1.5, maxWidth: 900 }}>
          An agent does not need administrator access. Administrators can always act on tickets
          regardless of these lists, so a mistake here can never lock you out.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
