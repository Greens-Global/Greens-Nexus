import { useEffect, useMemo, useState } from "react";
import { FileText, Monitor, Users, BookOpen, ArrowUpRight } from "lucide-react";
import { api } from "../api";
import { useTasks } from "../tasks/TasksContext";
import { CreateTicketModal, TicketDrawer } from "../tickets/TicketsView";
import { TicketStatusChip } from "../tickets/TicketAtoms";
import { PriorityChip, EmptyState } from "../tasks/components";
import { fmtDate } from "../tickets/ticketMeta";
import { SkeletonBlocks } from "../components/AsyncState";

const OPTIONS = [
  { icon: FileText, title: "Submit a Ticket",    desc: "Report an issue or request help from any department." },
  { icon: Monitor,  title: "IT Help Desk",       desc: "Hardware, access, software, and network support." },
  { icon: Users,    title: "Contact Directory",  desc: "Find the right person across your organization." },
  { icon: BookOpen, title: "FAQ & Guides",       desc: "Common how-tos and Nexus walkthroughs." },
];

export default function Support() {
  const { tickets, loading, myEmail, nameOf } = useTasks();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [hrDepts, setHrDepts] = useState([]);
  useEffect(() => { api.getTicketDepartments().then(setHrDepts).catch(() => setHrDepts([])); }, []);
  // Ticket module dept-lead access - relevant if this person happens to lead a
  // department, mirrors TicketsView's myDeptIds so TicketDrawer behaves the same.
  const myDeptIds = useMemo(() => {
    const me = (myEmail || "").toLowerCase();
    if (!me) return new Set();
    return new Set(hrDepts.filter((d) => (d.leadEmail || "").toLowerCase() === me
      || (d.backupEmail || "").toLowerCase() === me).map((d) => d.id));
  }, [hrDepts, myEmail]);

  const myTickets = useMemo(() => {
    const me = (myEmail || "").toLowerCase();
    return tickets
      .filter((t) => (t.requesterId || "").toLowerCase() === me)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [tickets, myEmail]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Support</h2>
          <p>Get help across Nexus</p>
        </div>
      </div>

      <div className="support-grid">
        {OPTIONS.map(o => {
          const openTicket = o.title === "Submit a Ticket";
          return (
            <div key={o.title} className="support-card" onClick={openTicket ? () => setCreating(true) : undefined}
              style={openTicket ? { cursor: "pointer" } : undefined}>
              <div className="support-icon"><o.icon size={20} /></div>
              <div className="support-card-title">{o.title}</div>
              <p className="support-card-desc">{o.desc}</p>
              <button className="link-btn" onClick={openTicket ? (e) => { e.stopPropagation(); setCreating(true); } : undefined}>
                Open <ArrowUpRight size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="dash-card">
        <div className="dash-card-title" style={{ marginBottom: 14 }}>My Open Tickets</div>
        {loading ? (
          <SkeletonBlocks count={3} height={40} />
        ) : myTickets.length === 0 ? (
          <EmptyState icon={FileText} title="No tickets yet" hint="Submit a ticket above to get help from a department." />
        ) : (
          <table className="req-table stack-table">
            <thead><tr><th>Title</th><th>Assigned To</th><th>State</th><th>Priority</th><th>Due Date</th><th>Created Date</th></tr></thead>
            <tbody>
              {myTickets.map(t => (
                <tr key={t.id} onClick={() => setOpenId(t.id)} style={{ cursor: "pointer" }}>
                  <td data-th="Title" style={{ fontWeight: 700 }}>{t.subject}</td>
                  <td data-th="Assigned To" style={{ color: "var(--muted)" }}>{t.assigneeId ? (nameOf(t.assigneeId) || t.assigneeId) : "-"}</td>
                  <td data-th="State"><TicketStatusChip status={t.status} /></td>
                  <td data-th="Priority"><PriorityChip priority={t.priority} /></td>
                  <td data-th="Due Date" style={{ color: "var(--muted)", fontSize: 12 }}>{t.slaDueOn ? fmtDate(t.slaDueOn) : "-"}</td>
                  <td data-th="Created Date" style={{ color: "var(--muted)", fontSize: 12 }}>{t.createdAt ? fmtDate(t.createdAt) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateTicketModal onClose={() => setCreating(false)} />}
      {openId && <TicketDrawer ticketId={openId} onClose={() => setOpenId(null)} myDeptIds={myDeptIds} />}
    </div>
  );
}
