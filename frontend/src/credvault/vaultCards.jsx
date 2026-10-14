// Credential Vault - the stat strip above the directory (People-screen
// grammar, Oct 14 2026): a solid brand KPI tile with white siblings, and two
// bordered stat cards (department breakdown, what rotates next). Pure
// presentation; the screen passes the numbers.
import { ArrowUpRight } from "lucide-react";
import { rotationDaysLeft, rotationDueDate } from "./vaultModel";

export function KpiTile({ label, value, sub, solid = false, tone, onGo, goTitle }) {
  const fg = solid ? "#fff" : tone === "bad" ? "var(--bad-fg)" : tone === "warn" ? "var(--warn-fg)" : "var(--ink)";
  return (
    <div className={`cv-kpi${solid ? " is-solid" : ""}`}>
      <span className="cv-kpi-label">{label}</span>
      <span className="cv-kpi-value" style={{ color: fg }}>{value}</span>
      {sub && <span className="cv-kpi-sub">{sub}</span>}
      {onGo && (
        <button type="button" className="cv-kpi-go" onClick={onGo} title={goTitle} aria-label={goTitle}><ArrowUpRight size={15} /></button>
      )}
    </div>
  );
}

export function StatCard({ Icon, title, meta, children }) {
  return (
    <div className="wkc">
      <div className="wkc-head">
        <span className="wkc-chip"><Icon size={14} /></span>
        <span className="wkc-title">{title}</span>
        {meta && <span className="wkc-meta">{meta}</span>}
      </div>
      <div className="wkc-body">{children}</div>
    </div>
  );
}

export const DEPT_COLORS = ["#2b45e1", "#dc7a18", "#248f4b", "#8a31c9", "#b8860b", "#0e7490", "#be123c"];
export function deptColor(name, depts) {
  const i = Math.max(0, depts.indexOf(name));
  return DEPT_COLORS[i % DEPT_COLORS.length];
}

/** Horizontal bars per department; a click filters the directory. */
export function DeptBars({ rows, depts, active, onPick }) {
  const counts = depts.map((d) => ({ name: d, n: rows.filter((c) => c.dept === d).length })).filter((d) => d.n > 0).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...counts.map((d) => d.n));
  if (!counts.length) return <p className="cv-hint">No departments yet.</p>;
  return (
    <div className="cv-bars">
      {counts.slice(0, 6).map((d) => (
        <button type="button" key={d.name} className={`cv-bar-row${active === d.name ? " is-active" : ""}`} onClick={() => onPick(d.name)} title={`Show ${d.name}`}>
          <span className="cv-bar-dot" style={{ background: deptColor(d.name, depts) }} />
          <span className="cv-bar-label">{d.name}</span>
          <span className="cv-bar-track"><span className="cv-bar-fill" style={{ width: `${Math.round((d.n / max) * 100)}%`, background: deptColor(d.name, depts) }} /></span>
          <span className="cv-bar-n">{d.n}</span>
        </button>
      ))}
    </div>
  );
}

/** The next credentials to rotate (or already overdue), soonest first. */
export function RotationList({ rows, onPick }) {
  const due = rows.filter((c) => c.canReveal && c.rotatedAt).map((c) => ({ c, left: rotationDaysLeft(c) })).sort((a, b) => a.left - b.left).slice(0, 5);
  if (!due.length) return <p className="cv-hint">Nothing to rotate yet.</p>;
  return (
    <div className="cv-due">
      {due.map(({ c, left }) => (
        <button type="button" key={c.id} className="cv-due-row" onClick={() => onPick(c.id)}>
          <span className={`cv-dot tone-${left < 0 ? "bad" : left <= 10 ? "warn" : "ok"}`} />
          <span className="cv-due-name">{c.name}</span>
          <span className={`cv-due-when${left < 0 ? " tone-bad" : left <= 10 ? " tone-warn" : ""}`}>
            {left < 0 ? `${Math.abs(left)}d overdue` : left === 0 ? "due today" : `due ${rotationDueDate(c)}`}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Two-letter tile in the department's color - the credential's "avatar". */
export function Monogram({ name, dept, depts, size = 36 }) {
  const words = (name || "?").trim().split(/\s+/);
  const text = ((words[0]?.[0] || "") + (words[1]?.[0] || words[0]?.[1] || "")).toUpperCase();
  const color = deptColor(dept, depts);
  return (
    <span className="cv-mono-tile" style={{ width: size, height: size, background: `${color}1a`, color, fontSize: Math.round(size * 0.36) }} aria-hidden="true">{text}</span>
  );
}
