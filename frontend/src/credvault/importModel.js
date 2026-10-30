// Credentials - the import wizard's pure half (Oct 29 2026): which spreadsheet
// column is which field, the rows that come out, what is wrong with them, and
// which ones the vault already has. No React, no API; tested in
// importModel.test.js. The sheet people have is not our template - it is
// whatever Excel file they kept passwords in - so the mapping is guessed from
// the headers and the person corrects it.
import { TYPES, TIERS } from "./vaultShared";
import { siteOf } from "./vaultModel";

export const FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "username", label: "Username / Email" },
  { key: "secret", label: "Password", required: true },
  { key: "url", label: "Link" },
  { key: "dept", label: "Department" },
  { key: "note", label: "Notes" },
  { key: "type", label: "Type" },
  { key: "tier", label: "Tier" },
];
const SYNONYMS = {
  name: ["name", "title", "service", "system", "site name", "application", "app", "account name", "website name", "vendor", "portal", "tool", "software", "platform"],
  username: ["username", "user name", "user", "login", "login id", "email", "e-mail", "account", "user id", "userid", "id"],
  secret: ["password", "pass", "pwd", "secret", "passcode", "pin", "key", "api key", "token"],
  url: ["url", "link", "website", "web site", "site", "address", "web address", "login url", "login link"],
  dept: ["department", "dept", "team", "group", "division", "area", "owner team"],
  note: ["notes", "note", "comments", "comment", "remarks", "description", "info", "details", "security question", "recovery"],
  type: ["type", "kind", "category"],
  tier: ["tier", "sensitivity", "level", "priority", "criticality"],
};
const norm = (h) => String(h ?? "").trim().toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ");

/** {field: headerIndex} guessed from the header row: every exact synonym
 *  first (so "Login URL" is the link, not the username), then headers that
 *  contain one. Synonyms are normalized the same way as headers. */
export function guessMap(headers) {
  const hs = headers.map(norm);
  const syn = Object.fromEntries(FIELDS.map((f) => [f.key, SYNONYMS[f.key].map(norm)]));
  const map = {};
  const taken = new Set();
  for (const f of FIELDS) {
    const i = hs.findIndex((h, idx) => !taken.has(idx) && syn[f.key].includes(h));
    if (i >= 0) { map[f.key] = i; taken.add(i); }
  }
  for (const f of FIELDS) {
    if (map[f.key] != null) continue;
    const i = hs.findIndex((h, idx) => !taken.has(idx) && h && syn[f.key].some((x) => x.length > 2 && h.includes(x)));
    if (i >= 0) { map[f.key] = i; taken.add(i); }
  }
  return map;
}

/** Sheet rows (arrays) + a map -> credential rows; blank lines dropped. */
export function applyMap(rows, map) {
  const cell = (r, k) => (map[k] == null ? "" : String(r[map[k]] ?? "").trim());
  return rows.map((r, i) => ({
    line: i + 2,
    name: cell(r, "name"), username: cell(r, "username"), secret: cell(r, "secret"), url: cell(r, "url"),
    dept: cell(r, "dept"), note: cell(r, "note"),
    type: TYPES.find((t) => t.toLowerCase() === cell(r, "type").toLowerCase()) || "Password",
    tier: TIERS.find((t) => t.toLowerCase() === cell(r, "tier").toLowerCase()) || "Standard",
  })).filter((r) => r.name || r.username || r.secret || r.url);
}

const fixUrl = (u) => (!u ? "" : /^https?:\/\//i.test(u) ? u : /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u) ? `https://${u}` : "");

/** What is wrong with a row, given the department it falls back to. */
export function validateRows(rows, { defaultDept = "" } = {}) {
  return rows.map((r) => {
    const url = fixUrl(r.url);
    const dept = r.dept || defaultDept;
    const problems = [];
    if (!r.name) problems.push("no name");
    if (!r.secret) problems.push("no password");
    if (!dept) problems.push("no department");
    if (r.url && !url) problems.push("link is not a web address");
    return { ...r, url, dept, problems, ok: problems.length === 0 };
  });
}

/** Rows the vault already holds: same name and username, or same site and username. */
export function findDuplicates(rows, existing) {
  const live = existing.filter((c) => !c.deletedAt);
  const key1 = (name, user) => `${norm(name)}|${norm(user === "-" ? "" : user)}`;
  const key2 = (url, user) => (siteOf(url) ? `${siteOf(url)}|${norm(user === "-" ? "" : user)}` : null);
  const byName = new Map(live.map((c) => [key1(c.name, c.username), c]));
  const bySite = new Map(live.filter((c) => key2(c.url, c.username)).map((c) => [key2(c.url, c.username), c]));
  return rows.map((r) => {
    const hit = byName.get(key1(r.name, r.username)) || (key2(r.url, r.username) ? bySite.get(key2(r.url, r.username)) : null);
    return hit ? { ...r, duplicateOf: { id: hit.id, name: hit.name } } : r;
  });
}

/** The server's shape for one row. */
export function toPayload(r, { backupOwner = "", everyone = false, companyId = "" } = {}) {
  return {
    name: r.name, department: r.dept, type: r.type, username: r.username, secret: r.secret, tier: r.tier, url: r.url, note: r.note,
    backupOwner,
    audiences: everyone ? [{ kind: "company", value: companyId, level: "open" }] : (r.dept ? [{ kind: "department", value: r.dept, level: "open" }] : []),
  };
}
