// Passwords - Export for an Audit ("..." on the list; owners, heads and
// administrators). The company numbers Pranshu asked to keep (10/29/2026)
// live here since the one-list rebuild (Neil, 11/18/2026): who can open what,
// the health per department, and what rotates next - never a password.
import { auditRows, healthByDept, rotationRows } from "./vaultModel";

export async function exportAudit(rows, nameOf) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows(rows, nameOf)), "Who Can Open What");
  const health = healthByDept(rows).map((h) => ({ Department: h.dept, Logins: h.total, Critical: h.critical, Breached: h.breached, Weak: h.weak, Reused: h.reused,
    "Rotation Overdue": h.overdue, "Expiring or Expired": h.expiring, "No Backup Owner": h.noBackup }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(health), "Health by Department");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rotationRows(rows, nameOf)), "Rotates Next");
  const d = new Date();
  XLSX.writeFile(wb, `Passwords Audit ${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}.xlsx`);
}
