// Credential Vault - pure helpers behind the rebuilt screen (Oct 14 2026).
// No React, no API: what a row means (health, access, rotation), which rows a
// collection holds, how the list is filtered and sorted, and how a deep link
// (`sub`) is read. Tested in vaultModel.test.js.
import { formatDate, formatTime } from "../lib/datetime";

export const ACCESS_LABEL = {
  admin: "Admin", owner: "Owner", backup: "Backup Owner", head: "Department Head", shared: "Shared With You",
  department: "Your Department", company: "Your Company", group: "Your Group", person: "Shared With You",
  view: "View Only", request: "Request Access",
};
export const ACCESS_TONE = { admin: "info", owner: "info", backup: "info", head: "info", shared: "ok", department: "ok", company: "ok", group: "ok", person: "ok", view: "muted", request: "muted" };
// Who may open a credential (vault_access.py): the form's rows and the drawer's list.
export const AUDIENCE_LEVELS = [["open", "Can open the password"], ["view", "View only - sees the login, never the password"]];
export const audienceKey = (a) => `${a.kind}:${(a.value || "").toLowerCase()}`;

export const DURATIONS = [
  { key: "1h", label: "1 Hour", ms: 3600000 }, { key: "4h", label: "4 Hours", ms: 14400000 },
  { key: "8h", label: "8 Hours", ms: 28800000 }, { key: "24h", label: "24 Hours", ms: 86400000 },
  { key: "7d", label: "7 Days", ms: 7 * 86400000 },
];
export const ROTATION_CHOICES = [60, 90, 180, 365];
export const WARN_DAYS = 10;        // rotation due within this many days = "due soon"
export const EXPIRY_WARN_DAYS = 30;

export const rotationDaysLeft = (c) => (c.rotationMax || 90) - (c.rotatedDays || 0);

/** The dated things wrong with a credential, worst first. */
export function healthFlags(c) {
  const f = [];
  if (c.expiresInDays != null && c.expiresInDays < 0) f.push({ key: "expired", label: "Expired", tone: "bad" });
  if (c.strength === "weak") f.push({ key: "weak", label: "Weak Password", tone: "bad" });
  const left = rotationDaysLeft(c);
  if (left < 0) f.push({ key: "overdue", label: `Rotation Overdue ${Math.abs(left)}d`, tone: "bad" });
  if (c.reused) f.push({ key: "reused", label: "Reused Password", tone: "warn" });
  if (left >= 0 && left <= WARN_DAYS) f.push({ key: "dueSoon", label: left === 0 ? "Rotation Due Today" : `Rotation Due in ${left}d`, tone: "warn" });
  if (c.expiresInDays != null && c.expiresInDays >= 0 && c.expiresInDays <= EXPIRY_WARN_DAYS) {
    f.push({ key: "expiring", label: c.expiresInDays === 0 ? "Expires Today" : `Expires in ${c.expiresInDays}d`, tone: "warn" });
  }
  return f;
}
export function healthTone(c) {
  const f = healthFlags(c);
  if (f.some((x) => x.tone === "bad")) return "bad";
  if (f.length) return "warn";
  return "ok";
}
export function rotationDueDate(c) {
  return formatDate(new Date(Date.now() + rotationDaysLeft(c) * 86400000));
}

/** Rows that are live (not in the trash). */
export const live = (creds) => creds.filter((c) => !c.deletedAt);
export const trashed = (creds) => creds.filter((c) => c.deletedAt);

/** Which collection a row belongs to - used by the rail counts and the filter. */
export function inCollection(c, key, { favorites = new Set(), myEmail = "" } = {}) {
  if (key === "trash") return !!c.deletedAt;
  if (c.deletedAt) return false;
  if (key === "all") return true;
  if (key === "mine") return c.owner === myEmail || c.backupOwner === myEmail;
  if (key === "shared") return c.access === "shared";
  if (key === "favorites") return favorites.has(c.id);
  if (key === "attention") return c.canReveal && healthFlags(c).length > 0;
  if (key === "nobackup") return c.canEdit && !c.backupOwner;
  if (key.startsWith("dept:")) return (c.dept || "") === key.slice(5);
  return true;
}

/** The left rail: fixed groups, then every department that has a credential. */
export function collectionsFor(creds, ctx) {
  const fixed = [
    { key: "all", label: "All Credentials" }, { key: "mine", label: "Owned by Me" },
    { key: "shared", label: "Shared With Me" }, { key: "favorites", label: "Favorites" },
    { key: "attention", label: "Needs Attention" }, { key: "nobackup", label: "No Backup Owner" },
  ];
  const depts = [...new Set(live(creds).map((c) => c.dept).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const rows = [...fixed, ...depts.map((d) => ({ key: `dept:${d}`, label: d, dept: true })), { key: "trash", label: "Trash" }];
  return rows.map((r) => ({ ...r, count: creds.filter((c) => inCollection(c, r.key, ctx)).length }));
}

export function filterCredentials(creds, { collection = "all", query = "", type = "All", tier = "All", favorites, myEmail }) {
  const q = query.trim().toLowerCase();
  return creds.filter((c) => {
    if (!inCollection(c, collection, { favorites, myEmail })) return false;
    if (type !== "All" && c.type !== type) return false;
    if (tier !== "All" && c.tier !== tier) return false;
    if (q && !`${c.name} ${c.username} ${c.dept} ${c.url} ${c.note} ${c.owner}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function sortCredentials(rows, sort = { col: "name", dir: "asc" }) {
  const rank = { bad: 0, warn: 1, ok: 2 };
  const cmp = {
    name: (a, b) => (a.name || "").localeCompare(b.name || ""),
    dept: (a, b) => (a.dept || "").localeCompare(b.dept || "") || (a.name || "").localeCompare(b.name || ""),
    owner: (a, b) => (a.owner || "").localeCompare(b.owner || ""),
    rotated: (a, b) => (b.rotatedDays || 0) - (a.rotatedDays || 0),
    health: (a, b) => rank[healthTone(a)] - rank[healthTone(b)],
  }[sort.col] || (() => 0);
  const out = [...rows].sort(cmp);
  return sort.dir === "desc" ? out.reverse() : out;
}

/** A deep link: "approvals" | "personal" | "activity" | "trash" | "cred-<id>" | a collection key. */
export function parseSub(sub) {
  const s = (sub || "").trim();
  if (!s) return { tab: null, credId: null, collection: null };
  if (s.startsWith("cred-")) return { tab: "vault", credId: s.slice(5), collection: null };
  // The header's Create menu (Oct 29 2026): the vault with New Credential open.
  if (s === "new") return { tab: "vault", credId: null, collection: null, create: true };
  if (["approvals", "personal", "activity"].includes(s)) return { tab: s, credId: null, collection: null };
  if (["trash", "mine", "shared", "attention", "favorites", "nobackup"].includes(s)) return { tab: "vault", credId: null, collection: s };
  return { tab: "vault", credId: null, collection: null };
}

export function verifiedLabel(untilMs, now = Date.now()) {
  if (!untilMs || untilMs <= now) return "";
  return `Verified until ${formatTime(new Date(untilMs))}`;
}

/** "1h 05m" above an hour, "04:32" below. */
export function timeLeft(ms) {
  const left = Math.max(0, ms);
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000), s = Math.floor((left % 60000) / 1000);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** A date input's "YYYY-MM-DD" as a LOCAL day (new Date(iso) would read it as UTC midnight). */
export function localDay(iso, endOfDay = false) {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
}

export function logMatches(e, { query = "", action = "All", from = "", to = "" }) {
  if (action !== "All" && e.action !== action) return false;
  const lo = localDay(from), hi = localDay(to, true);
  if (lo && e.ts && e.ts < lo) return false;
  if (hi && e.ts && e.ts > hi) return false;
  const q = query.trim().toLowerCase();
  if (q && !`${e.actor} ${e.cred} ${e.dept} ${e.action}`.toLowerCase().includes(q)) return false;
  return true;
}

export const FAVORITES_KEY = "nexus:vault-favorites";
export function readFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")); } catch { return new Set(); }
}
export function writeFavorites(set) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

// ── My Logins (Oct 29 2026) ─────────────────────────────────────────────────
export const RECENT_KEY = "nexus:vault-recent";
export const RECENT_MAX = 8;
export function readRecents() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function noteRecent(id, list = readRecents()) {
  const next = [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
/** "dcc.godaddy.com" from a link; "" when there is none. */
export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
/** The My Logins list: what I can open, favorites first, then what I used
 *  lately, then everything else by department; `locked` = rows I can see but
 *  not open (Request Access / View Only). A row appears in one group only. */
export function groupLogins(rows, { favorites = new Set(), recents = [], query = "" } = {}) {
  const q = query.trim().toLowerCase();
  const hit = (c) => !q || `${c.name} ${c.username} ${c.dept} ${c.url} ${c.note}`.toLowerCase().includes(q);
  const liveRows = rows.filter((c) => !c.deletedAt && hit(c));
  const open = liveRows.filter((c) => c.canReveal);
  const seen = new Set();
  const take = (c) => { seen.add(c.id); return c; };
  const favs = open.filter((c) => favorites.has(c.id)).map(take);
  const recent = recents.map((id) => open.find((c) => c.id === id && !seen.has(c.id))).filter(Boolean).map(take);
  const rest = open.filter((c) => !seen.has(c.id));
  const depts = [...new Set(rest.map((c) => c.dept || "Other"))].sort((a, b) => a.localeCompare(b));
  return {
    favorites: favs, recent,
    byDept: depts.map((d) => ({ dept: d, rows: rest.filter((c) => (c.dept || "Other") === d).sort((a, b) => a.name.localeCompare(b.name)) })),
    locked: liveRows.filter((c) => !c.canReveal).sort((a, b) => a.name.localeCompare(b.name)),
    total: open.length,
  };
}
/** Overview: the audit table, one row per department over the rows I can read the health of. */
export function healthByDept(rows) {
  const liveRows = rows.filter((c) => !c.deletedAt);
  const depts = [...new Set(liveRows.map((c) => c.dept || "Other"))].sort((a, b) => a.localeCompare(b));
  return depts.map((d) => {
    const mine = liveRows.filter((c) => (c.dept || "Other") === d);
    const known = mine.filter((c) => c.canReveal);
    const has = (key) => known.filter((c) => healthFlags(c).some((f) => f.key === key)).length;
    return { dept: d, total: mine.length, weak: has("weak"), reused: has("reused"), overdue: has("overdue"),
      expiring: has("expiring") + has("expired"), noBackup: mine.filter((c) => !c.backupOwner).length,
      critical: mine.filter((c) => c.tier === "Critical").length };
  });
}
/** Overview export: who can open what, one row per credential - never a password. */
export function auditRows(rows, nameOf = (e) => e) {
  return rows.filter((c) => !c.deletedAt).map((c) => ({
    Name: c.name, Department: c.dept || "", Type: c.type, Tier: c.tier,
    Owner: nameOf(c.owner), "Backup Owner": c.backupOwner ? nameOf(c.backupOwner) : "",
    "Who Can Open": (c.audiences || []).map((a) => `${a.kind === "person" ? nameOf(a.value) : a.label}${a.level === "view" ? " (view only)" : ""}`).join("; ") || (c.tier === "Critical" ? "Owners and admins" : `Everyone in ${c.dept || "its department"}`),
    "Shared Right Now": Math.max(0, (c.sharedWith || 1) - 1),
    "Last Rotated": c.rotatedAt ? formatDate(c.rotatedAt) : "", "Rotate Every (days)": c.rotationMax || 90,
    Expires: c.expiresAt ? formatDate(c.expiresAt) : "",
    Health: c.canReveal ? (healthFlags(c).map((f) => f.label).join(", ") || "Healthy") : "",
  }));
}
