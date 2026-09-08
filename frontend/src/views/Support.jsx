// Support - the end-user face of the Ticket module.
//
// This page used to be a mock: four cards whose "Open" buttons did nothing, and
// two invented tickets (SUP-204, SUP-198) that looked exactly like real ones.
// The whole point of a support page is that someone in trouble can raise a
// ticket and then see what happened to it, and neither worked.
//
// Deliberately NOT the Tickets module. That screen is the agent queue - every
// ticket in the company, with assignment, priority triage and status controls.
// This is the requester's view: raise one, then watch yours. The list comes from
// /task-tickets?mine=true, scoped server-side, so an employee's browser never
// receives anyone else's ticket.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
// Ticket is the Ticket module's own icon (Sidebar, TicketsView) - the card
// that opens its create form should wear it, not a generic document.
import { Ticket, Monitor, Users, BookOpen, ArrowUpRight, Shield, FileSignature, Bug, Search } from 'lucide-react';
import { api } from '../api';
import { ticketNoShort, normalizeCode } from '../tickets/ticketMeta';
import { formatDateTime } from '../lib/datetime';

// Report a Bug used to float as its own button, hovering bottom-right over
// every Tasks/Tickets screen. Folded into Support (Pranshu, Sep 3) since it's
// a help action like everything else on this page, not a persistent overlay.
// Same trick as TicketComposer below: mount the Tasks module's own modal
// (it needs TasksProvider for createTicket) instead of building a second form.
const BugComposer = lazy(async () => {
  const [{ TasksProvider }, { ReportBugModal }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tasks/ReportBug'),
  ]);
  return {
    default: ({ onClose }) => (
      <TasksProvider><ReportBugModal onClose={onClose} /></TasksProvider>
    ),
  };
});

// The Ticket module's OWN create form, mounted here instead of navigating to
// that module. A second form would be a second set of fields to keep in step
// with routing, SLA and per-type questions - and the first thing to drift.
// It reads createTicket from TasksProvider, which lives on the Tasks view, so
// the provider comes along just for the modal (same trick QuickActionModals
// uses for CreateTaskModal). Lazy so the tickets chunk only loads on click.
const TicketComposer = lazy(async () => {
  const [{ TasksProvider }, { CreateTicketModal }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tickets/TicketsView'),
  ]);
  return {
    default: ({ onClose }) => (
      <TasksProvider><CreateTicketModal onClose={onClose} /></TasksProvider>
    ),
  };
});

// The Ticket module's OWN detail drawer, mounted here instead of routing to
// that module - same trick as TicketComposer above. That module's own view is
// grant-gated to supervisor+ (App.jsx VIEW_MIN_ROLES: tickets is the agent
// queue), so a plain employee following a nexus:navigate('tickets') there
// would hit an Access Restricted wall instead of their own ticket. The
// drawer's own permission model already scopes what a non-desk person sees
// (isRequester/privileged checks inside TicketDrawer), and /task-tickets is
// auto-scoped server-side to "my tickets" for anyone without the desk grant -
// so mounting it directly here shows exactly what the Ticket module would,
// without needing the module's own access grant.
const TicketDetail = lazy(async () => {
  const [{ TasksProvider }, { TicketDrawer }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tickets/TicketsView'),
  ]);
  return {
    default: ({ ticketId, onClose }) => (
      <TasksProvider><TicketDrawer ticketId={ticketId} onClose={onClose} /></TasksProvider>
    ),
  };
});

const go = (view, sub) => window.dispatchEvent(
  new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));

// Status -> the pill classes this stylesheet already ships. Anything unmapped
// falls back rather than rendering an unstyled chip.
const STATUS_PILL = {
  new:         { cls: 'status-badge pill-info',      label: 'New' },
  open:        { cls: 'status-badge status-pending', label: 'Open' },
  in_progress: { cls: 'status-badge status-pending', label: 'In progress' },
  on_hold:     { cls: 'status-badge pill-info',      label: 'On hold' },
  resolved:    { cls: 'status-badge status-approved', label: 'Resolved' },
  closed:      { cls: 'status-badge',                label: 'Closed' },
};
const pill = (s) => STATUS_PILL[s] || { cls: 'status-badge', label: (s || 'new').replace(/_/g, ' ') };

export default function Support() {
  const [submitting, setSubmitting] = useState(false);
  const [reportingBug, setReportingBug] = useState(false);
  const [viewingTicketId, setViewingTicketId] = useState(null);
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // For the Dept column: ticket_to_dict carries departmentId, not the name.
  const [departments, setDepartments] = useState([]);

  useEffect(() => { api.getTicketDepartments().then((d) => setDepartments(d || [])).catch(() => {}); }, []);

  const load = useCallback(() => {
    api.getMyTickets()
      .then((rows) => setTickets(rows || []))
      .catch((e) => { setTickets([]); setError(e.message || 'Could not load your tickets.'); });
  }, []);

  useEffect(load, [load]);

  const OPTIONS = [
    { icon: Ticket, title: 'Submit a Ticket', desc: 'Report an issue or request help from any department.',
      onOpen: () => setSubmitting(true) },
    { icon: Bug, title: 'Report a Bug', desc: 'Flag something broken in Nexus, with screenshots if you have them.',
      onOpen: () => setReportingBug(true) },
    { icon: Monitor, title: 'IT Help Desk', desc: 'Hardware, access, software, and network support.',
      onOpen: () => go('it') },
    { icon: Users, title: 'Contact Directory', desc: 'Find the right person across your organization.',
      onOpen: () => go('people') },
    { icon: BookOpen, title: 'FAQ & Guides', desc: 'Common how-tos and Nexus walkthroughs.',
      onOpen: () => go('sop') },
    // Folded in from their own left-nav entries (Aug 31) to shrink the nav -
    // both still resolve as ordinary views (App.jsx), just opened from here.
    { icon: Shield, title: 'Privacy Policy', desc: 'What Nexus collects, why, and who can see it.',
      onOpen: () => go('privacy-policy') },
    { icon: FileSignature, title: 'Terms & Conditions', desc: 'The terms that govern your use of Nexus.',
      onOpen: () => go('terms-conditions') },
  ];

  // Closed tickets are not what "My Open Tickets" means, but a requester whose
  // ticket was just resolved should still see that it was - so resolved stays
  // until it is closed out.
  const open = (tickets || []).filter((t) => t.status !== 'closed');
  const deptName = (id) => (departments.find((d) => d.id === id) || {}).name || '';
  // Ticket number OR title - the two things someone actually remembers about
  // their own ticket. Matched against both the raw and normalized code so
  // "9", "000009" and "#000009" all find the same row.
  const q = search.trim().toLowerCase();
  const visible = !q ? open : open.filter((t) => {
    const code = ticketNoShort(t.code) || '';
    return code.toLowerCase().includes(q) || normalizeCode(t.code).includes(q)
      || (t.subject || '').toLowerCase().includes(q);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Support</h2>
          <p>Get help across Nexus</p>
        </div>
      </div>

      <div className="support-grid">
        {OPTIONS.map((o) => (
          // The whole tile is the button - the card already lifts on hover and
          // shows a pointer, so anything less than a full-tile hit area was
          // just a smaller target that looked the same (Sagar, Sept 2 2026).
          // "Open" stays as the affordance, but as a span: a button inside a
          // button is invalid, and it would swallow clicks meant for the tile.
          <button key={o.title} type="button" className="support-card" onClick={o.onOpen}>
            <div className="support-icon"><o.icon size={20} /></div>
            <div className="support-card-title">{o.title}</div>
            <p className="support-card-desc">{o.desc}</p>
            <span className="link-btn">Open <ArrowUpRight size={13} /></span>
          </button>
        ))}
      </div>

      <div className="dash-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <div className="dash-card-title" style={{ margin: 0 }}>My Open Tickets</div>
          {tickets !== null && open.length > 0 && (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open.length}</span>
          )}
          {tickets !== null && open.length > 0 && (
            <div style={{ position: 'relative', marginLeft: 'auto', width: 220, maxWidth: '100%' }}>
              <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
              <input type="text" className="form-input" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ticket # or title…" style={{ width: '100%', paddingLeft: 28, fontSize: 13 }} />
            </div>
          )}
        </div>

        {error && <div style={{ color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 10 }}>{error}</div>}

        {tickets === null ? (
          <div style={{ color: 'var(--muted)', fontSize: 13, padding: '18px 0' }}>Loading your tickets…</div>
        ) : open.length === 0 ? (
          // An empty state, not an empty table: a header row with nothing under
          // it reads as broken rather than as "nothing open".
          <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)' }}>
            <Ticket size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>Nothing open right now</div>
            <p style={{ fontSize: '0.85rem', margin: '0 0 14px' }}>Anything you submit shows up here with its status.</p>
            <button className="primary-btn" onClick={() => setSubmitting(true)}>
              <Ticket size={15} /> Submit a Ticket
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--muted)', fontSize: 13 }}>
            No open tickets match "{search.trim()}".
          </div>
        ) : (
          <table className="req-table stack-table">
            <thead><tr><th>Ticket</th><th>Subject</th><th>Dept</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {visible.map((t) => {
                const p = pill(t.status);
                return (
                  // The whole row opens the ticket's real detail drawer (Ticket
                  // module) - nothing here duplicates that view, it just links
                  // to it. role="button" + cursor:pointer since a <tr> isn't
                  // natively interactive.
                  <tr key={t.id} role="button" tabIndex={0} onClick={() => setViewingTicketId(t.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingTicketId(t.id); } }}
                    style={{ cursor: 'pointer' }}>
                    <td data-th="Ticket" className="mono" style={{ fontWeight: 700 }}>{ticketNoShort(t.code) || '-'}</td>
                    <td>{t.subject}</td>
                    <td data-th="Dept" style={{ color: 'var(--muted)' }}>{deptName(t.departmentId) || '-'}</td>
                    <td data-th="Status"><span className={p.cls}>{p.label}</span></td>
                    <td data-th="Updated" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {formatDateTime(t.modifiedAt || t.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {submitting && (
        <Suspense fallback={null}>
          {/* CreateTicketModal calls onClose after a successful create too, so
              reloading here covers both "submitted" and "cancelled". */}
          <TicketComposer onClose={() => { setSubmitting(false); load(); }} />
        </Suspense>
      )}

      {reportingBug && (
        <Suspense fallback={null}>
          <BugComposer onClose={() => setReportingBug(false)} />
        </Suspense>
      )}

      {viewingTicketId && (
        <Suspense fallback={null}>
          {/* Reload on close too - the drawer can change status/priority etc.
              (within the requester's own edit access), and the table above
              should reflect that without a manual refresh. */}
          <TicketDetail ticketId={viewingTicketId} onClose={() => { setViewingTicketId(null); load(); }} />
        </Suspense>
      )}
    </div>
  );
}
