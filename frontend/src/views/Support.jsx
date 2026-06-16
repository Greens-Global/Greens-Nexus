import { FileText, Monitor, Users, BookOpen, ArrowUpRight } from "lucide-react";

const OPTIONS = [
  { icon: FileText, title: "Submit a ticket",    desc: "Report an issue or request help from any department." },
  { icon: Monitor,  title: "IT Help Desk",       desc: "Hardware, access, software, and network support." },
  { icon: Users,    title: "Contact Directory",  desc: "Find the right person across Greens Global." },
  { icon: BookOpen, title: "FAQ & Guides",       desc: "Common how-tos and Nexus walkthroughs." },
];

const TICKETS = [
  { id: "SUP-204", subject: "Gate keypad offline at Summit",     dept: "Operations", status: "status-pending",  statusLabel: "In progress", updated: "2h ago"  },
  { id: "SUP-198", subject: "New laptop for Lakeline manager",   dept: "IT",         status: "pill-info",       statusLabel: "Awaiting parts", updated: "1d ago" },
];

export default function Support() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Support</h2>
          <p>Get help across Nexus and Greens Global</p>
        </div>
      </div>

      <div className="support-grid">
        {OPTIONS.map(o => (
          <div key={o.title} className="support-card">
            <div className="support-icon"><o.icon size={20} /></div>
            <div className="support-card-title">{o.title}</div>
            <p className="support-card-desc">{o.desc}</p>
            <button className="link-btn">Open <ArrowUpRight size={13} /></button>
          </div>
        ))}
      </div>

      <div className="dash-card">
        <div className="dash-card-title" style={{ marginBottom: 14 }}>My open tickets</div>
        <table className="req-table stack-table">
          <thead><tr><th>Ticket</th><th>Subject</th><th>Dept</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {TICKETS.map(t => (
              <tr key={t.id}>
                <td data-th="Ticket" className="mono" style={{ fontWeight: 700 }}>{t.id}</td>
                <td>{t.subject}</td>
                <td data-th="Dept" style={{ color: "var(--muted)" }}>{t.dept}</td>
                <td data-th="Status"><span className={`status-badge ${t.status}`}>{t.statusLabel}</span></td>
                <td data-th="Updated" style={{ color: "var(--muted)", fontSize: 12 }}>{t.updated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
