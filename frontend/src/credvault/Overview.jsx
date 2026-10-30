// Credentials - Overview (Oct 29 2026): the company numbers, kept for audits
// (Pranshu: "sometimes it is important to have those numbers"). Five KPI
// tiles, the department bars and what rotates next from the Oct 14 strip, plus
// a health table per department and an Excel export of who can open what -
// never a password. Admins see every company; a head or owner sees what the
// API already scoped to them.
import { Building2, RefreshCw, Download, ShieldCheck } from "lucide-react";
import { KpiTile, StatCard, DeptBars, RotationList } from "./vaultCards";
import { healthByDept, auditRows } from "./vaultModel";

export async function exportAudit(rows, nameOf) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows(rows, nameOf)), "Who Can Open What");
  const health = healthByDept(rows).map((h) => ({ Department: h.dept, Logins: h.total, Critical: h.critical, Weak: h.weak, Reused: h.reused,
    "Rotation Overdue": h.overdue, "Expiring or Expired": h.expiring, "No Backup Owner": h.noBackup }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(health), "Health by Department");
  const d = new Date();
  XLSX.writeFile(wb, `Credentials Audit ${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}.xlsx`);
}

const Num = ({ n, tone = "bad" }) => <td className={`num ${n ? `tone-${tone}` : "tone-zero"}`}>{n}</td>;

export default function Overview({ rows, depts, attention, sharedWithMe, requests, fDept, onPickDept, onPickCollection, onOpen, onApprovals, nameOf, canExport = true }) {
  const noBackup = rows.filter((c) => !c.backupOwner).length;
  const health = healthByDept(rows);
  return (
    <div className="cv-overview" data-overview="">
      <div className="cv-kpis is-five" style={{ marginBottom: 14 }}>
        <KpiTile solid label="Logins" value={rows.length} sub={`${depts.length} department${depts.length === 1 ? "" : "s"}`} onGo={() => onPickCollection("all")} goTitle="See every login" />
        <KpiTile label="Needs Attention" value={attention} tone={attention ? "warn" : undefined} sub={attention ? "weak, reused, overdue or expiring" : "nothing to fix"} onGo={() => onPickCollection("attention")} goTitle="Show what needs attention" />
        <KpiTile label="No Backup Owner" value={noBackup} tone={noBackup ? "warn" : undefined} sub={noBackup ? "stranded if the owner leaves" : "every login has a backup"} onGo={() => onPickCollection("nobackup")} goTitle="Show logins with no backup owner" />
        <KpiTile label="Shared With Me" value={sharedWithMe} sub={sharedWithMe ? "timed access, ends by itself" : "no shared access right now"} onGo={() => onPickCollection("shared")} goTitle="Show what was shared with me" />
        <KpiTile label="Awaiting Approval" value={requests} tone={requests ? "warn" : undefined} sub={requests ? "requests for you to decide" : "no requests waiting"} onGo={onApprovals} goTitle="Open Approvals" />
      </div>
      <div className="cv-stats" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr) minmax(280px, 1fr)" }}>
        <StatCard Icon={ShieldCheck} title="Health by Department" meta={canExport ? (
          <button type="button" className="cv-btn" style={{ padding: "3px 9px", fontSize: 12 }} onClick={() => exportAudit(rows, nameOf)} title="Who can open what, and the health per department - no passwords"><Download size={13} /> Export to Excel</button>
        ) : null}>
          {health.length === 0 ? <p className="cv-hint">No logins yet.</p> : (
            <div style={{ overflowX: "auto" }}>
              <table className="cv-health">
                <thead><tr><th>Department</th><th className="num">Logins</th><th className="num">Critical</th><th className="num">Weak</th><th className="num">Reused</th><th className="num">Overdue</th><th className="num">Expiring</th><th className="num">No Backup</th></tr></thead>
                <tbody>
                  {health.map((h) => (
                    <tr key={h.dept} className={`is-link${fDept === h.dept ? " is-active" : ""}`} onClick={() => onPickDept(h.dept)} title={`Show ${h.dept}`}>
                      <td style={{ fontWeight: 600 }}>{h.dept}</td><td className="num">{h.total}</td><Num n={h.critical} tone="warn" /><Num n={h.weak} /><Num n={h.reused} tone="warn" /><Num n={h.overdue} /><Num n={h.expiring} tone="warn" /><Num n={h.noBackup} tone="warn" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </StatCard>
        <StatCard Icon={Building2} title="By Department" meta={`${depts.length} total`}>
          <DeptBars rows={rows} depts={depts} active={fDept} onPick={onPickDept} />
        </StatCard>
        <StatCard Icon={RefreshCw} title="Rotates Next" meta="soonest first">
          <RotationList rows={rows} onPick={onOpen} />
        </StatCard>
      </div>
    </div>
  );
}
