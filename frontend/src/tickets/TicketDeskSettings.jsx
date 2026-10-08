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
import { useEffect, useMemo, useState } from 'react';
import { LoadingState } from '../components/AsyncState';
import { Headset, Save, Building2, Siren, ChevronDown, ChevronRight } from 'lucide-react';
import DragList from './DragList';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, card } from '../tasks/theme';
import { PersonMultiSelect, PersonSelect, usePeople } from '../tasks/components';
import { useIsMobile } from '../lib/useIsMobile';

// The fallback chain, spelled out for whoever's reading it: a company's own
// agents, if any -> the Default Agents list, if any -> every administrator.
// Nothing here is silent - each card always shows which rung of that chain
// its tickets are actually resolving to right now, not just a warning when
// it's empty, so "why did this go to X" never requires reading the backend.
const TONE = { ok: NX.green, warn: NX.amber, danger: NX.red };

function DeskRoster({ title, hint, value, people, onChange, status, icon, children }) {
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
      {children}
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Departments for one company, each with a Department Head - who gets the
// escalation email when a requester or assignee raises one on a ticket filed
// against that department (routers/tickets.py:escalate_ticket). A separate
// concept from the agent roster above: agents WORK tickets in general, the
// department head owns the "this needs instant care" alert for tickets about
// their specific department.
//
// The departments themselves are the company's GLOBAL list (Neil, Oct 1 2026:
// "the departments should come from global... and then have the option of
// turning it off. Like, I don't want a construction ticket."). They are added,
// renamed and deleted in Settings > Company Settings only; here each one gets
// an on/off switch for Submit a Ticket, its head, and its place in the order.
const goToCompanySettings = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'company' } }));

function SwitchButton({ on, onClick, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={onClick}
      title={on ? 'Offered on Submit a Ticket' : 'Not offered on Submit a Ticket'} style={{
        position: 'relative', width: 34, height: 20, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: on ? NX.green : NX.border, transition: 'background 0.15s', flexShrink: 0, padding: 0,
      }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

function DepartmentHeads({ companyId, companyName, depts, people, onSetHead, onSetEnabled, onReorder, defaultOpen = false }) {
  // Collapsed by default - a company with a lot of departments (a real one
  // has 11) made its card towering over its grid neighbors, forcing scroll
  // through every card just to reach the Save button. Independent per card,
  // no need to persist across reloads.
  const [open, setOpen] = useState(defaultOpen);
  const hasDepts = depts.length > 0;
  const offCount = depts.filter((d) => d.enabled === false).length;
  const manageLink = (
    <button type="button" onClick={goToCompanySettings}
      style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: FONT, fontSize: 'inherit', color: 'var(--wk-brand)', fontWeight: 600 }}>
      Settings &gt; Company Settings
    </button>
  );
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${NX.border}` }}>
      {hasDepts ? (
        <button onClick={() => setOpen((o) => !o)} style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'transparent',
          border: 'none', padding: 0, marginBottom: open ? 6 : 0, cursor: 'pointer', fontFamily: FONT, textAlign: 'left',
        }}>
          <Siren size={13} style={{ color: NX.dim }} />
          <div style={{ fontSize: 12, fontWeight: 700, color: NX.ink, flex: 1 }}>
            Departments &amp; Escalation ({depts.length}{offCount ? `, ${offCount} Off` : ''})
          </div>
          {open ? <ChevronDown size={14} style={{ color: NX.dim }} /> : <ChevronRight size={14} style={{ color: NX.dim }} />}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Siren size={13} style={{ color: NX.dim }} />
          <div style={{ fontSize: 12, fontWeight: 700, color: NX.ink }}>Departments &amp; Escalation</div>
        </div>
      )}
      {!hasDepts && (
        <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 8, lineHeight: 1.5 }}>
          No departments yet for {companyName}. Add them in {manageLink} - they show up here automatically.
        </div>
      )}
      {(hasDepts && !open) ? null : hasDepts && (
        <>
          <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 8, lineHeight: 1.5 }}>
            Departments are managed in {manageLink}, the same list every module uses. Turn one off to stop
            offering it on Submit a Ticket.
          </div>
          {/* Drag the grip to set the order the Submit a Ticket dropdown lists
              them in (Neil, Sep 30: IT first, then Construction, Admin,
              Operations). Saved the moment it is dropped. */}
          <DragList items={depts} getKey={(d) => d.id} label="department" gap={6}
            onReorder={(next) => onReorder(companyId, next).catch((e) => alert(e.message || 'Could not reorder departments.'))}
            renderItem={(d, handle) => {
              const on = d.enabled !== false;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {handle}
                  <SwitchButton on={on} label={`Offer ${d.name} on Submit a Ticket`}
                    onClick={() => onSetEnabled(d.id, !on).catch((e) => alert(e.message || 'Could not update department.'))} />
                  <span style={{ width: 110, flexShrink: 0, fontSize: 12.5, color: on ? NX.ink : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={on ? d.name : `${d.name} - off for tickets`}>{d.name}</span>
                  <div style={{ flex: 1, opacity: on ? 1 : 0.6 }}>
                    <PersonSelect value={d.leadEmail || null} people={people}
                      onChange={(email) => onSetHead(d.id, email || '').catch((e) => alert(e.message || 'Could not set department head.'))}
                      placeholder="No department head set" />
                  </div>
                </div>
              );
            }} />
          <div style={{ fontSize: 11, color: NX.faint, marginTop: 6, lineHeight: 1.5 }}>
            A ticket filed against a department with no head falls back to this company's ticket agents when escalated.
            Tickets already filed against a department that is off keep it.
          </div>
        </>
      )}
    </div>
  );
}

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

// One line for the list on the left - the same rungs as companyStatus() and
// defaultStatus(), shortened to fit a row.
function rowStatus(value, defaultAgents, isDefault) {
  if (value.length > 0) return { tone: 'ok', text: plural(value.length, 'agent') };
  if (!isDefault && defaultAgents.length > 0) return { tone: 'warn', text: 'Uses Default Agents' };
  return { tone: 'danger', text: 'Falls back to admins' };
}

const DEFAULT_KEY = '__default';

export default function TicketDeskSettings() {
  const { myLevel } = useRole();
  const people = usePeople();
  const [agents, setAgents] = useState(null);            // default/fallback roster (agentEmails)
  const [byCompany, setByCompany] = useState(null);       // { companyId: [email, ...] }
  const [companies, setCompanies] = useState(null);
  const [depts, setDepts] = useState(null);               // flat list, every company - {id, name, companyId, leadEmail, backupEmail, enabled, removed}
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  // List on the left, one desk at a time on the right (Pranshu, Sep 26: a card
  // per company, each with its departments, made one very long page).
  const [selected, setSelected] = useState(DEFAULT_KEY);
  const [baseline, setBaseline] = useState('');   // last saved rosters, to flag unsaved edits
  const narrow = useIsMobile('(max-width: 900px)');

  useEffect(() => {
    if (myLevel < 3) return;
    Promise.all([api.getTicketNotifySettings(), api.getTicketCompanies(), api.getTicketDepartments()])
      .then(([c, comps, dep]) => {
        setAgents(c.agentEmails || []);
        setByCompany(c.agentEmailsByCompany || {});
        setBaseline(JSON.stringify([c.agentEmails || [], c.agentEmailsByCompany || {}]));
        setCompanies(comps || []);
        setDepts((dep || []).filter((d) => !d.removed));
      })
      .catch((e) => setErr(e.message || String(e)));
  }, [myLevel]);

  const dirty = useMemo(() => agents !== null && byCompany !== null
    && JSON.stringify([agents, byCompany]) !== baseline, [agents, byCompany, baseline]);

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
  if (agents === null || byCompany === null || companies === null || depts === null) {
    return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;
  }

  const setCompanyRoster = (companyId, next) => setByCompany((b) => ({ ...b, [companyId]: next }));

  // Both endpoints return the whole updated roster for one company - merge it
  // back into the flat list rather than refetching everyone else's.
  const mergeDepts = (companyId, rows) =>
    setDepts((d) => [...d.filter((x) => x.companyId !== companyId), ...rows]);
  const setDeptHead = (deptId, email) => {
    const companyId = (depts.find((d) => d.id === deptId) || {}).companyId;
    return api.setTicketDepartmentHead(deptId, email).then((rows) => mergeDepts(companyId, rows));
  };
  const setDeptEnabled = (deptId, enabled) => {
    const companyId = (depts.find((d) => d.id === deptId) || {}).companyId;
    return api.setTicketDepartmentEnabled(deptId, enabled).then((rows) => mergeDepts(companyId, rows));
  };
  // Shown in the new order at once; the server's list (same order) replaces it.
  const reorderDepts = (companyId, next) => {
    mergeDepts(companyId, next);
    return api.reorderTicketDepartments(companyId, next.map((d) => d.id)).then((rows) => mergeDepts(companyId, rows));
  };

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      // Whole-list replace, same contract as before - a company missing from
      // this patch would not be "left alone", it would be dropped, so every
      // known company's roster (even an emptied one) goes in the payload.
      const next = await api.updateTicketNotifySettings({ agentEmails: agents, agentEmailsByCompany: byCompany });
      setAgents(next.agentEmails || []);
      setByCompany(next.agentEmailsByCompany || {});
      setBaseline(JSON.stringify([next.agentEmails || [], next.agentEmailsByCompany || {}]));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  const company = companies.find((c) => c.id === selected) || null;
  const current = company ? company.id : DEFAULT_KEY;
  const entries = [
    { key: DEFAULT_KEY, name: 'Default Agents', Icon: Headset, value: agents },
    ...companies.map((c) => ({ key: c.id, name: c.name, Icon: Building2, value: byCompany[c.id] || [] })),
  ];

  const list = narrow ? (
    <select className="form-input" aria-label="Desk" value={current} onChange={(e) => setSelected(e.target.value)}
      style={{ width: '100%', marginBottom: 14 }}>
      {entries.map((e) => (
        <option key={e.key} value={e.key}>{e.name} - {rowStatus(e.value, agents, e.key === DEFAULT_KEY).text}</option>
      ))}
    </select>
  ) : (
    <nav aria-label="Ticket desks" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {entries.map((e, i) => {
        const st = rowStatus(e.value, agents, e.key === DEFAULT_KEY);
        const active = e.key === current;
        return (
          <div key={e.key}>
            {i === 1 && <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint, margin: '10px 10px 4px' }}>Companies</div>}
            <button type="button" onClick={() => setSelected(e.key)} aria-current={active ? 'true' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', borderRadius: 8,
                border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT,
                background: active ? 'var(--wk-brand-tint)' : 'transparent',
              }}>
              <e.Icon size={14} style={{ color: active ? 'var(--wk-brand)' : NX.dim, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: active ? 700 : 600, color: active ? 'var(--wk-brand)' : NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: TONE[st.tone] }}>{st.text}</span>
              </span>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: TONE[st.tone], flexShrink: 0 }} />
            </button>
          </div>
        );
      })}
    </nav>
  );

  const detail = company ? (
    <DeskRoster
      title={company.name} icon={<Building2 size={15} style={{ color: NX.dim }} />}
      hint="The agents who receive this company's tickets."
      value={byCompany[company.id] || []} people={people}
      onChange={(next) => setCompanyRoster(company.id, next)}
      status={companyStatus(byCompany[company.id] || [], agents, company.name)}
    >
      <DepartmentHeads key={company.id} defaultOpen companyId={company.id} companyName={company.name} people={people}
        depts={depts.filter((d) => d.companyId === company.id)}
        onSetHead={setDeptHead} onSetEnabled={setDeptEnabled} onReorder={reorderDepts} />
    </DeskRoster>
  ) : (
    <DeskRoster
      title="Default Agents" icon={<Headset size={15} style={{ color: NX.dim }} />}
      hint="Used for any company with no agents of its own, and for tickets with no company on file."
      value={agents} people={people} onChange={setAgents}
      status={defaultStatus(agents, companies.length)}
    />
  );

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 14, maxWidth: 900, lineHeight: 1.5 }}>
        New tickets go to the agents of the company they belong to. A company with no agents uses
        Default Agents, and if that is empty too, every administrator is notified.
      </div>

      <div style={narrow ? undefined : { display: 'grid', gridTemplateColumns: '250px minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
        {list}
        <div style={{ minWidth: 0 }}>
          {detail}
          {companies.length === 0 && (
            <div style={{ fontSize: 12, color: NX.faint, marginTop: 10 }}>
              No companies are set up yet. Add one in Settings &gt; Company Settings to give it its own agents.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
            <button onClick={save} disabled={saving || !dirty} style={{ ...btn('primary'), opacity: saving || !dirty ? 0.6 : 1 }}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save'}
            </button>
            {dirty && !saving && <span style={{ fontSize: 12.5, color: NX.amber, fontWeight: 600 }}>Unsaved changes</span>}
            {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
            {err && <span style={{ fontSize: 12.5, color: NX.red, fontWeight: 600 }}>{err}</span>}
          </div>
          <div style={{ fontSize: 11.5, color: NX.faint, lineHeight: 1.5, marginTop: 10 }}>
            Agents don't need administrator access. Administrators can always act on tickets, so a
            mistake here can never lock anyone out. Department heads save as soon as you pick them.
          </div>
        </div>
      </div>
    </div>
  );
}
