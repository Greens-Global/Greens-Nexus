// Passwords - the login's two-letter tile in its department's color. The stat
// strip that used to live here (KPI tiles, department bars, Rotates Next) left
// the screen with the one-list rebuild (Neil, 11/18/2026): its numbers are the
// sentence above the list and the audit export (auditExport.js).
export const DEPT_COLORS = ["#2b45e1", "#dc7a18", "#248f4b", "#8a31c9", "#b8860b", "#0e7490", "#be123c"];
export function deptColor(name, depts) {
  const i = Math.max(0, depts.indexOf(name));
  return DEPT_COLORS[i % DEPT_COLORS.length];
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
