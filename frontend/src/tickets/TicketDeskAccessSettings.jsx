// Ticket Manager > Desk Access (Oct 2026): which Access Group grants put a
// person on the service desk, and as an agent or a supervisor.
//
// One company-wide switch, `deskAccess` (backend/ticket_roles.py):
//   legacy   - the rule Nexus always had: any Tasks OR Tickets access puts a
//              person on the desk with every desk power.
//   explicit - only Tickets access counts; its level picks the role.
// Administrators only - the backend refuses everyone else (this panel just
// says so instead of rendering blank).
import { useEffect, useState } from 'react';
import { ShieldCheck, Save, Users } from 'lucide-react';
import { LoadingState } from '../components/AsyncState';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, card } from '../tasks/theme';

const ROLE_LABEL = { requester: 'Requester', agent: 'Agent', supervisor: 'Supervisor' };

const OPTIONS = [
  {
    key: 'legacy',
    title: 'Any Tasks or Tickets Access',
    body: 'Anyone with Tasks or Tickets access, at any level, works the desk with every desk power: '
      + 'the whole queue, internal notes, deleting, and the desk settings. This is how Nexus has always worked.',
  },
  {
    key: 'explicit',
    title: 'Tickets Access Only, by Level',
    body: 'Only Tickets access counts, and its level decides what a person can do. Tasks access alone no longer opens the desk.',
  },
];

const MAPPING = [
  ['No Tickets access', 'Requester', 'Raises tickets and follows the ones they are part of.'],
  ['Tickets - Viewer or Editor', 'Agent', 'Works the whole queue: assigns, replies, changes status and priority, reads and writes internal notes.'],
  ['Tickets - Full or Owner', 'Supervisor', 'Everything an agent does, plus deleting tickets, comments and attachments, components, approval routing and the desk settings.'],
];

export default function TicketDeskAccessSettings() {
  const { can } = useRole();
  const isAdmin = can('administrator');
  const [data, setData] = useState(null);
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    api.getTicketDeskAccess()
      .then((d) => { setData(d); setChoice(d.deskAccess); })
      .catch((e) => setErr(e.message || String(e)));
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Administrator access is required to change who works the service desk.
      </div>
    );
  }
  if (!data) {
    return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;
  }

  const dirty = choice !== data.deskAccess;
  const changes = data.explicitChanges || [];

  const save = async () => {
    if (choice === 'explicit' && changes.length > 0
      && !window.confirm(`${changes.length} ${changes.length === 1 ? 'person' : 'people'} will lose desk access or desk powers. Switch anyway?`)) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      const next = await api.updateTicketDeskAccess(choice);
      setData(next); setChoice(next.deskAccess);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, maxWidth: 900 }}>
      <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 14, lineHeight: 1.5 }}>
        Choose which access puts someone on the service desk. Access itself is still given in Access Groups;
        this only decides which of those grants count here.
      </div>

      <div role="radiogroup" aria-label="Desk access rule" style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
        {OPTIONS.map((o) => {
          const on = choice === o.key;
          return (
            <button key={o.key} type="button" role="radio" aria-checked={on} onClick={() => setChoice(o.key)}
              style={{
                ...card, padding: 14, textAlign: 'left', cursor: 'pointer', fontFamily: FONT,
                border: `1.5px solid ${on ? 'var(--wk-brand)' : NX.border}`,
                background: on ? 'var(--wk-brand-tint)' : undefined,
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span aria-hidden style={{
                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                  border: `2px solid ${on ? 'var(--wk-brand)' : NX.faint}`,
                  boxShadow: on ? 'inset 0 0 0 3px var(--surface, #fff)' : 'none',
                  background: on ? 'var(--wk-brand)' : 'transparent',
                }} />
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{o.title}</span>
                {data.deskAccess === o.key && <span style={{ fontSize: 11, color: NX.faint, fontWeight: 600 }}>Current</span>}
              </div>
              <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.5, paddingLeft: 22 }}>{o.body}</div>
            </button>
          );
        })}
      </div>

      <div style={{ ...card, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <ShieldCheck size={15} style={{ color: NX.dim }} />
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Roles Under Tickets Access Only</div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {MAPPING.map(([grant, role, what]) => (
            <div key={role} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 190px) 90px minmax(0, 1fr)', gap: 10, fontSize: 12.5, alignItems: 'baseline' }}>
              <span style={{ color: NX.dim }}>{grant}</span>
              <span style={{ fontWeight: 700 }}>{role}</span>
              <span style={{ color: NX.dim, lineHeight: 1.5 }}>{what}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 10, lineHeight: 1.5 }}>
          Administrators are always supervisors, so the desk can never be locked away from the people who fix it.
          Guests are always requesters.
        </div>
      </div>

      {data.deskAccess !== 'explicit' && (
        <div style={{ ...card, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Users size={15} style={{ color: NX.dim }} />
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Who Changes If You Switch</div>
          </div>
          {changes.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.dim }}>Nobody - everyone on the desk keeps what they have.</div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {changes.map((c) => (
                <div key={c.email} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name || c.email}</span>
                  {c.name && <span style={{ color: NX.faint }}>{c.email}</span>}
                  <span style={{ color: c.to === 'requester' ? NX.red : NX.amber, fontWeight: 600 }}>
                    {ROLE_LABEL[c.from] || c.from} to {ROLE_LABEL[c.to] || c.to}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4, lineHeight: 1.5 }}>
                Give them Tickets access in Access Groups before switching to keep them on the desk.
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={save} disabled={saving || !dirty} style={{ ...btn('primary'), opacity: saving || !dirty ? 0.6 : 1 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && !saving && <span style={{ fontSize: 12.5, color: NX.amber, fontWeight: 600 }}>Unsaved changes</span>}
        {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
        {err && <span style={{ fontSize: 12.5, color: NX.red, fontWeight: 600 }}>{err}</span>}
      </div>
    </div>
  );
}
